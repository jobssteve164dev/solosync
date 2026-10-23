import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pendingSafetyReserve = 64 * 1024 * 1024;
const incompleteLockStaleMs = 30_000;
const ownerLockStaleMs = 60_000;
const ownerHeartbeatMs = 10_000;

export class PendingBackupSpaceError extends Error {
  constructor(readonly requiredBytes: number, readonly availableBytes: number) {
    super(`SoloSync needs ${requiredBytes.toLocaleString()} free bytes to prepare this backup, but only ${availableBytes.toLocaleString()} are available.`);
  }
}

export class PendingBackupLockedError extends Error {
  constructor() {
    super('Another SoloSync window is already working on this project backup.');
  }
}

export interface PendingBackupJob {
  formatVersion: 1;
  snapshotId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  state: 'uploading' | 'verified' | 'publishing' | 'committed';
  totalBytes: number;
  destinationIdentity?: string;
}

function googleDriveAccountIdentity(destinationIdentity: string): string | undefined {
  const match = /^(google-drive-root-id:[a-f0-9]{64}):[^:]+$/.exec(destinationIdentity);
  return match?.[1];
}

export function isCompatiblePendingDestination(savedIdentity: string, currentIdentity: string): boolean {
  const savedAccount = googleDriveAccountIdentity(savedIdentity);
  const currentAccount = googleDriveAccountIdentity(currentIdentity);
  return savedAccount !== undefined && currentAccount !== undefined && savedAccount === currentAccount;
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

export async function writePendingBackup(directory: string, job: PendingBackupJob): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = path.join(directory, 'job.json.tmp');
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path.join(directory, 'job.json'));
}

export async function readPendingBackup(directory: string): Promise<{ job: PendingBackupJob; occupiedBytes: number }> {
  const job = JSON.parse(await readFile(path.join(directory, 'job.json'), 'utf8')) as PendingBackupJob;
  if (job.formatVersion !== 1 || typeof job.snapshotId !== 'string' || typeof job.projectId !== 'string' || typeof job.createdAt !== 'string' || !['uploading', 'verified', 'publishing', 'committed'].includes(job.state) || (job.destinationIdentity !== undefined && typeof job.destinationIdentity !== 'string')) {
    throw new Error('The pending SoloSync backup record is invalid.');
  }
  return { job, occupiedBytes: await directoryBytes(directory) };
}

export async function abandonPendingBackup(
  directory: string,
  cleanup: { deleteRemoteStaging(): Promise<void>; clearCredentials(): Promise<void> },
): Promise<void> {
  await cleanup.deleteRemoteStaging();
  await cleanup.clearCredentials();
  await rm(directory, { recursive: true, force: true });
}

export function requirePendingCapacity(snapshotBytes: number, availableBytes: number): void {
  const required = snapshotBytes + pendingSafetyReserve;
  if (availableBytes < required) throw new PendingBackupSpaceError(required, availableBytes);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function withPendingBackupLock<T>(pendingDirectory: string, operation: () => Promise<T>): Promise<T> {
  const lockDirectory = `${pendingDirectory}.lock`;
  const ownerId = randomUUID();
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const legacyOwner = path.join(lockDirectory, 'owner.json');
  try {
    const owner = JSON.parse(await readFile(legacyOwner, 'utf8')) as { pid?: number };
    const age = Date.now() - (await stat(legacyOwner)).mtimeMs;
    if (typeof owner.pid === 'number' && processExists(owner.pid) && age < ownerLockStaleMs) throw new PendingBackupLockedError();
    await unlink(legacyOwner);
  } catch (error) {
    if (error instanceof PendingBackupLockedError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const age = Date.now() - (await stat(legacyOwner)).mtimeMs;
      if (age < incompleteLockStaleMs) throw new PendingBackupLockedError();
      await unlink(legacyOwner).catch(() => undefined);
    }
  }

  const ownerFile = path.join(lockDirectory, `owner-${ownerId}.json`);
  const createdAt = performance.timeOrigin + performance.now();
  await writeFile(ownerFile, JSON.stringify({ pid: process.pid, ownerId, createdAt }), { mode: 0o600, flag: 'wx' });
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(ownerFile, now, now).catch(() => undefined);
  }, ownerHeartbeatMs);
  heartbeat.unref();
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const contenders: Array<{ file: string; createdAt: number; ownerId: string }> = [];
    for (const entry of await readdir(lockDirectory)) {
      if (!entry.startsWith('owner-') || !entry.endsWith('.json')) continue;
      const file = path.join(lockDirectory, entry);
      try {
        const owner = JSON.parse(await readFile(file, 'utf8')) as { pid?: number; ownerId?: string; createdAt?: number };
        const age = Date.now() - (await stat(file)).mtimeMs;
        if (typeof owner.pid === 'number' && processExists(owner.pid) && age < ownerLockStaleMs && typeof owner.ownerId === 'string' && typeof owner.createdAt === 'number') {
          contenders.push({ file, createdAt: owner.createdAt, ownerId: owner.ownerId });
        } else {
          await unlink(file).catch(() => undefined);
        }
      } catch {
        let modifiedAt: number;
        try {
          modifiedAt = (await stat(file)).mtimeMs;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        const age = Date.now() - modifiedAt;
        if (age < incompleteLockStaleMs) throw new PendingBackupLockedError();
        await unlink(file).catch(() => undefined);
      }
    }
    contenders.sort((left, right) => left.createdAt - right.createdAt || left.ownerId.localeCompare(right.ownerId));
    if (contenders[0]?.ownerId !== ownerId) throw new PendingBackupLockedError();
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await unlink(ownerFile).catch(() => undefined);
  }
}
