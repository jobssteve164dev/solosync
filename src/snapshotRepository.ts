import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPathInsideDirectory } from './backupLocation';
import { normalizeStorageKey, StorageProvider } from './storageProvider';
import { SnapshotFile, SnapshotManifest, WorkspaceRoot } from './types';

export interface CreateSnapshotOptions {
  provider: StorageProvider;
  projectId: string;
  projectName: string;
  roots: WorkspaceRoot[];
  excludes: string[];
  reason: string;
  git: SnapshotManifest['git'];
  signal?: AbortSignal;
  onProgress?: (progress: SnapshotProgress) => void;
}

export interface BackupProject {
  formatVersion: 1;
  projectId: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
}

export type SnapshotProgress =
  | { phase: 'scanning'; discovered: number }
  | { phase: 'copying'; completed: number; total: number; current: string }
  | { phase: 'finalizing'; total: number };

export class SnapshotCancelledError extends Error {
  constructor() {
    super('Backup canceled.');
    this.name = 'SnapshotCancelledError';
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SnapshotCancelledError();
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, 'root').slice(0, 80) || 'root';
}

function shouldExclude(relativePath: string, name: string, excludes: string[]): boolean {
  const segments = relativePath.split(path.sep);
  return excludes.some((rule) => {
    if (rule.startsWith('*.')) {
      return name.toLowerCase().endsWith(rule.slice(1).toLowerCase());
    }
    return name === rule || segments.includes(rule);
  });
}

async function sha256(filePath: string, signal?: AbortSignal): Promise<string> {
  throwIfCancelled(signal);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    const cancel = (): void => {
      stream.destroy(new SnapshotCancelledError());
    };
    signal?.addEventListener('abort', cancel, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    });
  });
  return hash.digest('hex');
}

async function collectFiles(root: WorkspaceRoot, options: CreateSnapshotOptions): Promise<Array<{ absolute: string; relative: string }>> {
  const files: Array<{ absolute: string; relative: string }> = [];
  const nestedBackupDirectory = options.provider.localRoot && isPathInsideDirectory(options.provider.localRoot, root.path) ? options.provider.localRoot : undefined;
  async function walk(current: string): Promise<void> {
    throwIfCancelled(options.signal);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      throwIfCancelled(options.signal);
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root.path, absolute);
      if ((nestedBackupDirectory && isPathInsideDirectory(absolute, nestedBackupDirectory)) || shouldExclude(relative, entry.name, options.excludes) || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative });
        if (files.length === 1 || files.length % 100 === 0) {
          options.onProgress?.({ phase: 'scanning', discovered: files.length });
        }
      }
    }
  }
  await walk(root.path);
  return files;
}

function storageKey(...segments: string[]): string {
  return segments.filter(Boolean).join('/');
}

function sha256Buffer(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function parseManifest(contents: Buffer): SnapshotManifest {
  const value = JSON.parse(contents.toString('utf8')) as Partial<SnapshotManifest>;
  if (value.formatVersion !== 1 || typeof value.snapshotId !== 'string' || typeof value.projectId !== 'string' || typeof value.projectName !== 'string' || typeof value.createdAt !== 'string' || !Array.isArray(value.files)) {
    throw new Error('The snapshot manifest is invalid.');
  }
  for (const file of value.files as Array<Partial<SnapshotFile>>) {
    if (typeof file.root !== 'string' || typeof file.path !== 'string' || typeof file.size !== 'number' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('The snapshot manifest contains an invalid file entry.');
    }
    normalizeStorageKey(`${file.root}/${file.path}`);
  }
  return value as SnapshotManifest;
}

async function uploadDirectory(provider: StorageProvider, localDirectory: string, remoteDirectory: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  await provider.createDirectory(remoteDirectory, signal);
  const entries = await readdir(localDirectory, { withFileTypes: true });
  for (const entry of entries) {
    throwIfCancelled(signal);
    const local = path.join(localDirectory, entry.name);
    const remote = storageKey(remoteDirectory, entry.name);
    if (entry.isDirectory()) {
      await uploadDirectory(provider, local, remote, signal);
    } else if (entry.isFile()) {
      await provider.writeFile(remote, local, signal);
    }
  }
}

async function readProject(provider: StorageProvider, projectId: string): Promise<BackupProject | undefined> {
  const key = storageKey('SoloSync', projectId, 'project.json');
  if (!(await provider.exists(key))) return undefined;
  try {
    const value = JSON.parse((await provider.readFile(key)).toString('utf8')) as Partial<BackupProject>;
    if (value.formatVersion !== 1 || value.projectId !== projectId || typeof value.projectName !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return undefined;
    return value as BackupProject;
  } catch {
    return undefined;
  }
}

async function copyConsistent(source: string, destination: string, signal?: AbortSignal): Promise<{ size: number; modifiedAt: number; sha256: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfCancelled(signal);
    const before = await stat(source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    throwIfCancelled(signal);
    const after = await stat(source);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { size: after.size, modifiedAt: after.mtimeMs, sha256: await sha256(destination, signal) };
    }
  }
  throw new Error(`File kept changing while it was being backed up: ${path.basename(source)}`);
}

export function projectIdFor(roots: WorkspaceRoot[]): string {
  return createHash('sha256').update(roots.map((root) => path.resolve(root.path)).sort().join('\n')).digest('hex').slice(0, 16);
}

export class SnapshotRepository {
  async create(options: CreateSnapshotOptions): Promise<SnapshotManifest> {
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
    const projectDirectory = storageKey('SoloSync', options.projectId);
    const stagingDirectory = storageKey(projectDirectory, 'staging', snapshotId);
    const finalDirectory = storageKey(projectDirectory, 'snapshots', snapshotId);
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'solosync-staging-'));
    const localSnapshotDirectory = path.join(temporaryRoot, snapshotId);
    const manifestFiles: SnapshotFile[] = [];
    let totalBytes = 0;
    let published = false;

    await mkdir(localSnapshotDirectory, { recursive: true });
    try {
      for (const root of options.roots) {
        throwIfCancelled(options.signal);
        const rootName = safeSegment(root.name);
        const files = await collectFiles(root, options);
        const progressInterval = Math.max(1, Math.floor(files.length / 100));
        for (const [index, file] of files.entries()) {
          throwIfCancelled(options.signal);
          const destination = path.join(localSnapshotDirectory, 'files', rootName, file.relative);
          const copied = await copyConsistent(file.absolute, destination, options.signal);
          totalBytes += copied.size;
          manifestFiles.push({ root: rootName, path: file.relative.split(path.sep).join('/'), ...copied });
          const completed = index + 1;
          if (completed === files.length || completed % progressInterval === 0) {
            options.onProgress?.({ phase: 'copying', completed, total: files.length, current: file.relative });
          }
        }
      }
      throwIfCancelled(options.signal);
      options.onProgress?.({ phase: 'finalizing', total: manifestFiles.length });
      const manifest: SnapshotManifest = {
        formatVersion: 1,
        snapshotId,
        projectId: options.projectId,
        projectName: options.projectName,
        createdAt: new Date().toISOString(),
        reason: options.reason,
        git: options.git,
        roots: options.roots.map((root) => safeSegment(root.name)),
        files: manifestFiles,
        totalBytes,
      };
      await writeFile(path.join(localSnapshotDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await options.provider.createDirectory(storageKey(projectDirectory, 'staging'), options.signal);
      await options.provider.createDirectory(storageKey(projectDirectory, 'snapshots'), options.signal);
      await uploadDirectory(options.provider, localSnapshotDirectory, stagingDirectory, options.signal);
      const uploadedManifest = parseManifest(await options.provider.readFile(storageKey(stagingDirectory, 'manifest.json'), options.signal));
      if (uploadedManifest.snapshotId !== manifest.snapshotId || uploadedManifest.projectId !== manifest.projectId || uploadedManifest.files.length !== manifest.files.length) {
        throw new Error('The backup location returned an incomplete snapshot manifest.');
      }
      for (const file of manifest.files) {
        throwIfCancelled(options.signal);
        const remote = storageKey(stagingDirectory, 'files', file.root, ...file.path.split('/'));
        if (sha256Buffer(await options.provider.readFile(remote, options.signal)) !== file.sha256) {
          throw new Error(`The uploaded copy of ${file.path} failed verification.`);
        }
      }
      throwIfCancelled(options.signal);
      await options.provider.move(stagingDirectory, finalDirectory);
      published = true;
      const previousProject = await readProject(options.provider, options.projectId);
      const project: BackupProject = {
        formatVersion: 1,
        projectId: options.projectId,
        projectName: options.projectName,
        createdAt: previousProject?.createdAt ?? manifest.createdAt,
        updatedAt: manifest.createdAt,
      };
      await options.provider.writeFile(storageKey(projectDirectory, 'project.json'), Buffer.from(`${JSON.stringify(project, null, 2)}\n`));
      const confirmed = await this.list(options.provider, options.projectId);
      if (!confirmed.some((item) => item.snapshotId === manifest.snapshotId)) {
        throw new Error('The snapshot was written but could not be confirmed in backup history.');
      }
      return manifest;
    } catch (error) {
      if (!published) await options.provider.delete(stagingDirectory).catch(() => undefined);
      if (options.signal?.aborted) throw new SnapshotCancelledError();
      throw error;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  async projectExists(provider: StorageProvider, projectId: string): Promise<boolean> {
    if (await provider.exists(storageKey('SoloSync', projectId, 'project.json'))) return true;
    return provider.exists(storageKey('SoloSync', projectId, 'snapshots'));
  }

  async listProjects(provider: StorageProvider): Promise<BackupProject[]> {
    if (!(await provider.exists('SoloSync'))) return [];
    const entries = (await provider.list('SoloSync')).filter((entry) => entry.type === 'directory');
    const projects: BackupProject[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const project = await readProject(provider, entry.name);
      if (project) {
        projects.push(project);
        continue;
      }
      const snapshots = await this.list(provider, entry.name);
      const latest = snapshots[0];
      if (latest) {
        projects.push({ formatVersion: 1, projectId: entry.name, projectName: latest.projectName, createdAt: snapshots[snapshots.length - 1].createdAt, updatedAt: latest.createdAt });
      }
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async list(provider: StorageProvider, projectId: string): Promise<SnapshotManifest[]> {
    const directory = storageKey('SoloSync', projectId, 'snapshots');
    if (!(await provider.exists(directory))) return [];
    const entries = (await provider.list(directory)).filter((entry) => entry.type === 'directory');
    const manifests: SnapshotManifest[] = [];
    for (const entry of entries) {
      try {
        const manifest = parseManifest(await provider.readFile(storageKey(directory, entry.name, 'manifest.json')));
        if (manifest.projectId === projectId && manifest.snapshotId === entry.name) manifests.push(manifest);
      } catch {
        // An invalid folder is never presented as a restorable snapshot.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(provider: StorageProvider, manifest: SnapshotManifest): Promise<{ valid: boolean; checked: number; errors: string[] }> {
    const base = storageKey('SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files');
    const errors: string[] = [];
    for (const file of manifest.files) {
      const source = storageKey(base, file.root, ...file.path.split('/'));
      try {
        if (sha256Buffer(await provider.readFile(source)) !== file.sha256) {
          errors.push(file.path);
        }
      } catch {
        errors.push(file.path);
      }
    }
    return { valid: errors.length === 0, checked: manifest.files.length, errors };
  }

  async restoreAll(provider: StorageProvider, manifest: SnapshotManifest, destination: string): Promise<void> {
    const base = storageKey('SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files');
    await mkdir(destination, { recursive: true });
    for (const file of manifest.files) {
      const source = storageKey(base, file.root, ...file.path.split('/'));
      const target = path.join(destination, file.root, ...file.path.split('/'));
      await provider.downloadFile(source, target);
      if (await sha256(target) !== file.sha256) {
        await rm(target, { force: true });
        throw new Error(`The restored copy of ${file.path} failed verification.`);
      }
    }
  }

  async restoreFile(provider: StorageProvider, manifest: SnapshotManifest, file: SnapshotFile, destination: string): Promise<void> {
    const source = storageKey('SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files', file.root, ...file.path.split('/'));
    const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.solosync-${randomUUID()}`);
    try {
      await provider.downloadFile(source, temporary);
      if (await sha256(temporary) !== file.sha256) throw new Error(`The restored copy of ${file.path} failed verification.`);
      await copyFile(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
