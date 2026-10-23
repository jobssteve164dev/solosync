import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPathInsideDirectory } from './backupLocation';
import { normalizeStorageKey, StorageFileExpectation, StorageFileStatus, StorageProvider, StorageVisibleFileExpectation } from './storageProvider';
import { SnapshotFile, SnapshotManifest, WorkspaceRoot } from './types';
import { isCompatiblePendingDestination, PendingBackupJob, readPendingBackup, requirePendingCapacity, writePendingBackup } from './pendingBackup';
import { isExcludedPath } from './exclusions';
import { isSensitiveFileName } from './sensitiveFileReview';

export interface CreateSnapshotOptions {
  provider: StorageProvider;
  projectId: string;
  projectName: string;
  roots: WorkspaceRoot[];
  excludes: string[];
  excludedSensitivePaths?: string[];
  reviewedSensitivePaths?: string[];
  pendingDirectory?: string;
  pendingAvailableBytes?: () => Promise<number>;
  discardPendingCredentials?: () => Promise<void>;
  pendingDestinationIdentity?: string;
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
  | { phase: 'finalizing'; total: number }
  | { phase: 'uploading'; completed: number; total: number; reused: number; current?: string }
  | { phase: 'verifying'; completed: number; total: number }
  | { phase: 'publishing' }
  | { phase: 'complete'; total: number; durationMs: number };

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
  const sensitiveExcludes = new Set(options.excludedSensitivePaths ?? []);
  const reviewedSensitivePaths = options.reviewedSensitivePaths ? new Set(options.reviewedSensitivePaths) : undefined;
  const rootName = safeSegment(root.name);
  const nestedBackupDirectory = options.provider.localRoot && isPathInsideDirectory(options.provider.localRoot, root.path) ? options.provider.localRoot : undefined;
  async function walk(current: string): Promise<void> {
    throwIfCancelled(options.signal);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      throwIfCancelled(options.signal);
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root.path, absolute);
      const sensitiveKey = `${rootName}/${relative.split(path.sep).join('/')}`;
      if ((nestedBackupDirectory && isPathInsideDirectory(absolute, nestedBackupDirectory)) || isExcludedPath(relative, entry.name, options.excludes) || sensitiveExcludes.has(sensitiveKey) || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        if (reviewedSensitivePaths && isSensitiveFileName(entry.name) && !reviewedSensitivePaths.has(sensitiveKey)) {
          throw new Error(`SoloSync found a new sensitive file (${sensitiveKey}). Review sensitive files again before backing up to Google Drive.`);
        }
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

function parseManifest(contents: Buffer): SnapshotManifest {
  const value = JSON.parse(contents.toString('utf8')) as Partial<SnapshotManifest>;
  if (![1, 2].includes(value.formatVersion ?? 0) || typeof value.snapshotId !== 'string' || typeof value.projectId !== 'string' || typeof value.projectName !== 'string' || typeof value.createdAt !== 'string' || !Array.isArray(value.files)) {
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

function storedFileKey(manifest: SnapshotManifest, file: SnapshotFile, lifecycle: 'staging' | 'snapshots' = 'snapshots'): string {
  return manifest.formatVersion === 2
    ? storageKey('SoloSync', manifest.projectId, 'objects', file.sha256)
    : storageKey('SoloSync', manifest.projectId, lifecycle, manifest.snapshotId, 'files', file.root, ...file.path.split('/'));
}

async function uploadContentObjects(provider: StorageProvider, localSnapshotDirectory: string, manifest: SnapshotManifest, options: CreateSnapshotOptions): Promise<void> {
  const objectsDirectory = storageKey('SoloSync', manifest.projectId, 'objects');
  await provider.createDirectory(objectsDirectory, options.signal);
  const uniqueFiles = [...new Map(manifest.files.map((file) => [file.sha256, file])).values()];
  const expectations = uniqueFiles.map((file): StorageFileExpectation => ({
    key: storageKey(objectsDirectory, file.sha256),
    sha256: file.sha256,
    displayName: path.posix.basename(file.path),
    displayPath: storageKey(file.root, file.path),
  }));
  const reconcile = async (items: StorageFileExpectation[]): Promise<Map<string, StorageFileStatus>> => {
    if (provider.reconcileFiles) return provider.reconcileFiles(items, options.signal);
    const statuses = new Map<string, StorageFileStatus>();
    for (const item of items) {
      statuses.set(item.key, !(await provider.exists(item.key, options.signal))
        ? 'missing'
        : await provider.hashFile(item.key, options.signal) === item.sha256 ? 'valid' : 'invalid');
    }
    return statuses;
  };
  const initial = await reconcile(expectations);
  let uploaded = 0;
  let reused = 0;
  const uploadedKeys = new Set<string>();
  options.onProgress?.({ phase: 'uploading', completed: 0, total: uniqueFiles.length, reused });
  for (const [index, file] of uniqueFiles.entries()) {
    throwIfCancelled(options.signal);
    const expectation = expectations[index];
    const remote = expectation.key;
    const local = path.join(localSnapshotDirectory, 'files', file.root, ...file.path.split('/'));
    const status = initial.get(remote) ?? 'missing';
    if (status === 'valid') {
      reused += 1;
    } else {
      if (status === 'invalid') await provider.delete(remote, options.signal);
      await provider.writeFile(remote, local, options.signal);
      uploadedKeys.add(remote);
      uploaded += 1;
    }
    options.onProgress?.({ phase: 'uploading', completed: index + 1, total: uniqueFiles.length, reused, current: file.path });
  }
  options.onProgress?.({ phase: 'verifying', completed: 0, total: uniqueFiles.length });
  const verified = uploaded > 0 ? await reconcile(expectations) : initial;
  await Promise.all(expectations.map(async (expectation) => {
    if (verified.get(expectation.key) !== 'missing' || !uploadedKeys.has(expectation.key)) return;
    try {
      verified.set(expectation.key, await provider.hashFile(expectation.key, options.signal) === expectation.sha256 ? 'valid' : 'invalid');
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
  }));
  for (const [index, file] of uniqueFiles.entries()) {
    const expectation = expectations[index];
    if (verified.get(expectation.key) !== 'valid') {
      await provider.delete(expectation.key).catch(() => undefined);
      throw new Error(`The uploaded copy of ${file.path} failed verification.`);
    }
    options.onProgress?.({ phase: 'verifying', completed: index + 1, total: uniqueFiles.length });
  }
}

async function syncVisibleFiles(provider: StorageProvider, localSnapshotDirectory: string, manifest: SnapshotManifest, signal?: AbortSignal): Promise<void> {
  if (!provider.syncVisibleFiles) return;
  await provider.syncVisibleFiles(manifest.files.map((file): StorageVisibleFileExpectation => ({
    key: storageKey('SoloSync', manifest.projectId, 'objects', file.sha256),
    sha256: file.sha256,
    displayName: path.posix.basename(file.path),
    displayPath: storageKey(file.root, file.path),
    source: path.join(localSnapshotDirectory, 'files', file.root, ...file.path.split('/')),
  })), manifest.projectId, manifest.snapshotId, signal);
}

async function uploadDirectory(provider: StorageProvider, localDirectory: string, remoteDirectory: string, signal?: AbortSignal, root = true): Promise<void> {
  throwIfCancelled(signal);
  await provider.createDirectory(remoteDirectory, signal);
  const entries = await readdir(localDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (root && (entry.name === 'job.json' || entry.name === 'job.json.tmp')) continue;
    throwIfCancelled(signal);
    const local = path.join(localDirectory, entry.name);
    const remote = storageKey(remoteDirectory, entry.name);
    if (entry.isDirectory()) {
      await uploadDirectory(provider, local, remote, signal, false);
    } else if (entry.isFile()) {
      if (await provider.exists(remote, signal)) {
        if (await provider.hashFile(remote, signal) !== await sha256(local, signal)) {
          throw new Error(`The existing uploaded copy of ${entry.name} does not match this backup.`);
        }
      } else {
        await provider.writeFile(remote, local, signal);
      }
    }
  }
}

async function readProject(provider: StorageProvider, projectId: string, signal?: AbortSignal): Promise<BackupProject | undefined> {
  const key = storageKey('SoloSync', projectId, 'project.json');
  if (!(await provider.exists(key, signal))) return undefined;
  try {
    const value = JSON.parse((await provider.readFile(key, signal)).toString('utf8')) as Partial<BackupProject>;
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
    const startedAt = Date.now();
    let resumedManifest: SnapshotManifest | undefined;
    let resumedJob: PendingBackupJob | undefined;
    if (options.pendingDirectory) {
      try {
        resumedManifest = parseManifest(await readFile(path.join(options.pendingDirectory, 'manifest.json')));
        if (resumedManifest.projectId !== options.projectId) throw new Error('The pending backup belongs to a different project.');
        resumedJob = (await readPendingBackup(options.pendingDirectory)).job;
        if (options.pendingDestinationIdentity && (!resumedJob.destinationIdentity || !isCompatiblePendingDestination(resumedJob.destinationIdentity, options.pendingDestinationIdentity))) {
          throw new Error('This pending backup belongs to a different Google Drive account. Reconnect the account that created it.');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await rm(options.pendingDirectory, { recursive: true, force: true });
      }
    }
    const snapshotId = resumedManifest?.snapshotId ?? `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
    const createdAt = resumedManifest?.createdAt ?? new Date().toISOString();
    const projectDirectory = storageKey('SoloSync', options.projectId);
    const stagingDirectory = storageKey(projectDirectory, 'staging', snapshotId);
    const finalDirectory = storageKey(projectDirectory, 'snapshots', snapshotId);
    const temporaryRoot = options.pendingDirectory ?? await mkdtemp(path.join(os.tmpdir(), 'solosync-staging-'));
    const localSnapshotDirectory = options.pendingDirectory ?? path.join(temporaryRoot, snapshotId);
    const manifestFiles: SnapshotFile[] = resumedManifest?.files ?? [];
    let totalBytes = resumedManifest?.totalBytes ?? 0;
    let published = false;
    let remoteCommitted = false;
    let manifest = resumedManifest;
    let frozen = Boolean(resumedManifest);
    let discarded = false;

    await mkdir(localSnapshotDirectory, { recursive: true, mode: 0o700 });
    try {
      if (resumedManifest) {
        for (const file of resumedManifest.files) {
          const local = path.join(localSnapshotDirectory, 'files', file.root, ...file.path.split('/'));
          if (await sha256(local, options.signal) !== file.sha256) throw new Error(`The pending copy of ${file.path} failed verification.`);
        }
      } else {
      const plannedRoots: Array<{ root: WorkspaceRoot; rootName: string; files: Array<{ absolute: string; relative: string }> }> = [];
      let estimatedBytes = 0;
      options.onProgress?.({ phase: 'scanning', discovered: 0 });
      for (const root of options.roots) {
        const files = await collectFiles(root, options);
        for (const file of files) estimatedBytes += (await stat(file.absolute)).size;
        plannedRoots.push({ root, rootName: safeSegment(root.name), files });
      }
      if (options.pendingDirectory) {
        const availableBytes = options.pendingAvailableBytes
          ? await options.pendingAvailableBytes()
          : await statfs(localSnapshotDirectory).then((value) => value.bavail * value.bsize);
        requirePendingCapacity(estimatedBytes, availableBytes);
        await writePendingBackup(options.pendingDirectory, {
          formatVersion: 1,
          snapshotId,
          projectId: options.projectId,
          projectName: options.projectName,
          createdAt,
          state: 'uploading',
          totalBytes: 0,
          destinationIdentity: options.pendingDestinationIdentity,
        });
      }
      const totalPlannedFiles = plannedRoots.reduce((total, item) => total + item.files.length, 0);
      let copiedFiles = 0;
      options.onProgress?.({ phase: 'copying', completed: 0, total: totalPlannedFiles, current: '' });
      for (const { rootName, files } of plannedRoots) {
        throwIfCancelled(options.signal);
        const progressInterval = Math.max(1, Math.floor(totalPlannedFiles / 100));
        for (const file of files) {
          throwIfCancelled(options.signal);
          const destination = path.join(localSnapshotDirectory, 'files', rootName, file.relative);
          if (options.pendingDirectory) await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          const copied = await copyConsistent(file.absolute, destination, options.signal);
          if (options.pendingDirectory) await chmod(destination, 0o600);
          totalBytes += copied.size;
          manifestFiles.push({ root: rootName, path: file.relative.split(path.sep).join('/'), ...copied });
          copiedFiles += 1;
          if (copiedFiles === totalPlannedFiles || copiedFiles % progressInterval === 0) {
            options.onProgress?.({ phase: 'copying', completed: copiedFiles, total: totalPlannedFiles, current: file.relative });
          }
        }
      }
      throwIfCancelled(options.signal);
      options.onProgress?.({ phase: 'finalizing', total: manifestFiles.length });
      manifest = {
        formatVersion: 2,
        snapshotId,
        projectId: options.projectId,
        projectName: options.projectName,
        createdAt,
        reason: options.reason,
        git: options.git,
        roots: options.roots.map((root) => safeSegment(root.name)),
        files: manifestFiles,
        totalBytes,
      };
      await writeFile(path.join(localSnapshotDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      frozen = true;
      }
      const readyManifest = manifest;
      if (!readyManifest) throw new Error('SoloSync could not prepare the backup manifest.');
      const updatePendingState = async (state: PendingBackupJob['state']): Promise<void> => {
        if (!options.pendingDirectory) return;
        await writePendingBackup(options.pendingDirectory, {
          formatVersion: 1,
          snapshotId: readyManifest.snapshotId,
          projectId: readyManifest.projectId,
          projectName: readyManifest.projectName,
          createdAt: readyManifest.createdAt,
          state,
          totalBytes: readyManifest.totalBytes,
          destinationIdentity: options.pendingDestinationIdentity ?? resumedJob?.destinationIdentity,
        });
      };
      await updatePendingState('uploading');
      if (resumedManifest && options.pendingDirectory && await options.provider.exists(finalDirectory, options.signal)) {
        const committedManifest = parseManifest(await options.provider.readFile(storageKey(finalDirectory, 'manifest.json'), options.signal));
        if (JSON.stringify(committedManifest) !== JSON.stringify(readyManifest)) {
          throw new Error('The published Google Drive snapshot does not match the pending backup.');
        }
        for (const file of readyManifest.files) {
          const remote = storedFileKey(readyManifest, file);
          if (await options.provider.hashFile(remote, options.signal) !== file.sha256) throw new Error(`The published copy of ${file.path} failed verification.`);
        }
        await syncVisibleFiles(options.provider, localSnapshotDirectory, readyManifest, options.signal);
        published = true;
        await updatePendingState('committed');
        options.onProgress?.({ phase: 'complete', total: readyManifest.files.length, durationMs: Date.now() - startedAt });
        return readyManifest;
      }
      await options.provider.createDirectory(storageKey(projectDirectory, 'staging'), options.signal);
      await options.provider.createDirectory(storageKey(projectDirectory, 'snapshots'), options.signal);
      if (readyManifest.formatVersion === 2) {
        await uploadContentObjects(options.provider, localSnapshotDirectory, readyManifest, options);
        await options.provider.createDirectory(stagingDirectory, options.signal);
        await options.provider.writeFile(storageKey(stagingDirectory, 'manifest.json'), path.join(localSnapshotDirectory, 'manifest.json'), options.signal);
      } else {
        options.onProgress?.({ phase: 'uploading', completed: 0, total: readyManifest.files.length, reused: 0 });
        await uploadDirectory(options.provider, localSnapshotDirectory, stagingDirectory, options.signal);
        options.onProgress?.({ phase: 'uploading', completed: readyManifest.files.length, total: readyManifest.files.length, reused: 0 });
      }
      const uploadedManifest = parseManifest(await options.provider.readFile(storageKey(stagingDirectory, 'manifest.json'), options.signal));
      if (JSON.stringify(uploadedManifest) !== JSON.stringify(readyManifest)) {
        throw new Error('The backup location returned an incomplete snapshot manifest.');
      }
      if (readyManifest.formatVersion === 1) {
        options.onProgress?.({ phase: 'verifying', completed: 0, total: readyManifest.files.length });
        for (const file of readyManifest.files) {
          throwIfCancelled(options.signal);
          const remote = storedFileKey(readyManifest, file, 'staging');
          if (await options.provider.hashFile(remote, options.signal) !== file.sha256) {
            throw new Error(`The uploaded copy of ${file.path} failed verification.`);
          }
          options.onProgress?.({ phase: 'verifying', completed: readyManifest.files.indexOf(file) + 1, total: readyManifest.files.length });
        }
      }
      await updatePendingState('verified');
      throwIfCancelled(options.signal);
      await updatePendingState('publishing');
      options.onProgress?.({ phase: 'publishing' });
      await options.provider.move(stagingDirectory, finalDirectory, options.signal);
      remoteCommitted = true;
      await syncVisibleFiles(options.provider, localSnapshotDirectory, readyManifest, options.signal);
      await updatePendingState('committed');
      const previousProject = await readProject(options.provider, options.projectId, options.signal);
      const project: BackupProject = {
        formatVersion: 1,
        projectId: options.projectId,
        projectName: options.projectName,
        createdAt: previousProject?.createdAt ?? readyManifest.createdAt,
        updatedAt: readyManifest.createdAt,
      };
      await options.provider.writeFile(storageKey(projectDirectory, 'project.json'), Buffer.from(`${JSON.stringify(project, null, 2)}\n`), options.signal);
      if (!options.provider.commitResponseIsAuthoritative) {
        const confirmed = await this.list(options.provider, options.projectId, options.signal);
        if (!confirmed.some((item) => item.snapshotId === readyManifest.snapshotId)) {
          throw new Error('The snapshot was written but could not be confirmed in backup history.');
        }
      }
      published = true;
      options.onProgress?.({ phase: 'complete', total: readyManifest.files.length, durationMs: Date.now() - startedAt });
      return readyManifest;
    } catch (error) {
      if (options.pendingDirectory && !frozen) await rm(options.pendingDirectory, { recursive: true, force: true });
      if (options.signal?.aborted) {
        const reconciliationController = new AbortController();
        const reconciliationTimer = setTimeout(() => reconciliationController.abort(), 10_000);
        try {
          if (!published && (remoteCommitted || await options.provider.exists(finalDirectory, reconciliationController.signal))) {
            throw new Error('Google Drive may have completed publication while the cancellation was arriving. Continue the pending backup so SoloSync can verify it.');
          }
          if (!remoteCommitted) await options.provider.delete(stagingDirectory, reconciliationController.signal);
          await options.discardPendingCredentials?.();
          discarded = true;
        } catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new Error(`SoloSync could not safely cancel this pending backup: ${message}`);
        } finally {
          clearTimeout(reconciliationTimer);
        }
        throw new SnapshotCancelledError();
      }
      if (!options.pendingDirectory && !remoteCommitted) await options.provider.delete(stagingDirectory).catch(() => undefined);
      throw error;
    } finally {
      if (!options.pendingDirectory || published || discarded) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
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

  async list(provider: StorageProvider, projectId: string, signal?: AbortSignal): Promise<SnapshotManifest[]> {
    const directory = storageKey('SoloSync', projectId, 'snapshots');
    if (!(await provider.exists(directory, signal))) return [];
    const entries = (await provider.list(directory, signal)).filter((entry) => entry.type === 'directory');
    const manifests: SnapshotManifest[] = [];
    for (const entry of entries) {
      try {
        const manifest = parseManifest(await provider.readFile(storageKey(directory, entry.name, 'manifest.json'), signal));
        if (manifest.projectId === projectId && manifest.snapshotId === entry.name) manifests.push(manifest);
      } catch {
        // An invalid folder is never presented as a restorable snapshot.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(provider: StorageProvider, manifest: SnapshotManifest): Promise<{ valid: boolean; checked: number; errors: string[] }> {
    const errors: string[] = [];
    for (const file of manifest.files) {
      const source = storedFileKey(manifest, file);
      try {
        if (await provider.hashFile(source) !== file.sha256) {
          errors.push(file.path);
        }
      } catch {
        errors.push(file.path);
      }
    }
    return { valid: errors.length === 0, checked: manifest.files.length, errors };
  }

  async restoreAll(provider: StorageProvider, manifest: SnapshotManifest, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    for (const file of manifest.files) {
      const source = storedFileKey(manifest, file);
      const target = path.join(destination, file.root, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await provider.downloadFile(source, target);
      if (await sha256(target) !== file.sha256) {
        await rm(target, { force: true });
        throw new Error(`The restored copy of ${file.path} failed verification.`);
      }
    }
  }

  async restoreFile(provider: StorageProvider, manifest: SnapshotManifest, file: SnapshotFile, destination: string): Promise<void> {
    const source = storedFileKey(manifest, file);
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
