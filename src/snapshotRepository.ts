import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isPathInsideDirectory } from './backupLocation';
import { SnapshotFile, SnapshotManifest, WorkspaceRoot } from './types';

export interface CreateSnapshotOptions {
  backupDirectory: string;
  projectId: string;
  projectName: string;
  roots: WorkspaceRoot[];
  excludes: string[];
  reason: string;
  git: SnapshotManifest['git'];
  signal?: AbortSignal;
  onProgress?: (progress: SnapshotProgress) => void;
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
  const nestedBackupDirectory = isPathInsideDirectory(options.backupDirectory, root.path) ? options.backupDirectory : undefined;
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
    const projectDirectory = path.join(options.backupDirectory, 'SoloSync', options.projectId);
    const stagingDirectory = path.join(projectDirectory, 'staging', snapshotId);
    const finalDirectory = path.join(projectDirectory, 'snapshots', snapshotId);
    const manifestFiles: SnapshotFile[] = [];
    let totalBytes = 0;
    let published = false;

    await mkdir(stagingDirectory, { recursive: true });
    try {
      for (const root of options.roots) {
        throwIfCancelled(options.signal);
        const rootName = safeSegment(root.name);
        const files = await collectFiles(root, options);
        const progressInterval = Math.max(1, Math.floor(files.length / 100));
        for (const [index, file] of files.entries()) {
          throwIfCancelled(options.signal);
          const destination = path.join(stagingDirectory, 'files', rootName, file.relative);
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
      await writeFile(path.join(stagingDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await mkdir(path.dirname(finalDirectory), { recursive: true });
      throwIfCancelled(options.signal);
      await rename(stagingDirectory, finalDirectory);
      published = true;
      throwIfCancelled(options.signal);
      return manifest;
    } catch (error) {
      await rm(published ? finalDirectory : stagingDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async list(backupDirectory: string, projectId: string): Promise<SnapshotManifest[]> {
    const directory = path.join(backupDirectory, 'SoloSync', projectId, 'snapshots');
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }
    const manifests: SnapshotManifest[] = [];
    for (const entry of entries) {
      try {
        manifests.push(JSON.parse(await readFile(path.join(directory, entry, 'manifest.json'), 'utf8')) as SnapshotManifest);
      } catch {
        // An invalid folder is never presented as a restorable snapshot.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(backupDirectory: string, manifest: SnapshotManifest): Promise<{ valid: boolean; checked: number; errors: string[] }> {
    const base = path.join(backupDirectory, 'SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files');
    const errors: string[] = [];
    for (const file of manifest.files) {
      const source = path.join(base, file.root, ...file.path.split('/'));
      try {
        if (await sha256(source) !== file.sha256) {
          errors.push(file.path);
        }
      } catch {
        errors.push(file.path);
      }
    }
    return { valid: errors.length === 0, checked: manifest.files.length, errors };
  }

  async restoreAll(backupDirectory: string, manifest: SnapshotManifest, destination: string): Promise<void> {
    const base = path.join(backupDirectory, 'SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files');
    for (const file of manifest.files) {
      const source = path.join(base, file.root, ...file.path.split('/'));
      const target = path.join(destination, file.root, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  async restoreFile(backupDirectory: string, manifest: SnapshotManifest, file: SnapshotFile, destination: string): Promise<void> {
    const source = path.join(backupDirectory, 'SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files', file.root, ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}
