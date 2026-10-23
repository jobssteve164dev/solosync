const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, utimes, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('rejects a frozen backup before copying when free space lacks the safety reserve', async () => {
  const { requirePendingCapacity, PendingBackupSpaceError } = require('../out/pendingBackup.js');
  assert.throws(() => requirePendingCapacity(100, 100 + 64 * 1024 * 1024 - 1), PendingBackupSpaceError);
  assert.doesNotThrow(() => requirePendingCapacity(100, 100 + 64 * 1024 * 1024));
});

test('allows only one window to operate on a project pending backup', async () => {
  const { withPendingBackupLock, PendingBackupLockedError } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-lock-'));
  let release;
  const held = withPendingBackupLock(root, () => new Promise((resolve) => { release = resolve; }));
  for (let attempt = 0; attempt < 100 && !release; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function');
  await assert.rejects(withPendingBackupLock(root, async () => undefined), PendingBackupLockedError);
  release();
  await held;
  await assert.doesNotReject(withPendingBackupLock(root, async () => undefined));
});

test('reclaims a lock left by a process that no longer exists', async () => {
  const { withPendingBackupLock } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-stale-lock-'));
  const lock = `${root}.lock`;
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
  await assert.doesNotReject(withPendingBackupLock(root, async () => undefined));
});

test('reclaims an old incomplete lock left before its owner record was written', async () => {
  const { withPendingBackupLock } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-incomplete-lock-'));
  const lock = `${root}.lock`;
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await assert.doesNotReject(withPendingBackupLock(root, async () => undefined));
});

test('reclaims a stale owner record even when its PID has been reused', async () => {
  const { withPendingBackupLock } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-reused-pid-lock-'));
  const lock = `${root}.lock`;
  await mkdir(lock);
  await writeFile(path.join(lock, 'owner-stale.json'), JSON.stringify({
    pid: process.pid,
    ownerId: 'stale-owner',
    createdAt: Date.now() - 120_000,
  }));
  const old = new Date(Date.now() - 120_000);
  await utimes(path.join(lock, 'owner-stale.json'), old, old);

  await assert.doesNotReject(withPendingBackupLock(root, async () => undefined));
});

test('persists and measures the user-visible pending backup state', async () => {
  const { readPendingBackup, writePendingBackup } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-pending-state-'));
  await writeFile(path.join(root, 'payload.bin'), Buffer.alloc(17));
  await writePendingBackup(root, {
    formatVersion: 1, snapshotId: 'snapshot-1', projectId: 'project-1', projectName: 'Project',
    createdAt: '2026-10-23T00:00:00.000Z', state: 'uploading', totalBytes: 17,
  });

  const pending = await readPendingBackup(root);
  assert.equal(pending.job.state, 'uploading');
  assert.equal(pending.job.snapshotId, 'snapshot-1');
  assert.ok(pending.occupiedBytes >= 17);
});

test('accepts a reconciled Google Drive root only for the same account', () => {
  const { isCompatiblePendingDestination } = require('../out/pendingBackup.js');
  assert.equal(isCompatiblePendingDestination(`google-drive-root-id:${'a'.repeat(64)}:root-a`, `google-drive-root-id:${'a'.repeat(64)}:root-b`), true);
  assert.equal(isCompatiblePendingDestination(`google-drive-root-id:${'a'.repeat(64)}:root-a`, `google-drive-root-id:${'b'.repeat(64)}:root-b`), false);
  assert.equal(isCompatiblePendingDestination('local:same', 'local:same'), false);
  assert.equal(isCompatiblePendingDestination(`google-drive-root-id:${'a'.repeat(63)}:root-a`, `google-drive-root-id:${'a'.repeat(63)}:root-a`), false);
  assert.equal(isCompatiblePendingDestination('local:path-a', 'local:path-b'), false);
});

test('abandons only after remote staging and saved credentials are cleared', async () => {
  const { abandonPendingBackup } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-abandon-'));
  await writeFile(path.join(root, 'manifest.json'), '{}');
  const order = [];
  await abandonPendingBackup(root, {
    deleteRemoteStaging: async () => order.push('remote'),
    clearCredentials: async () => order.push('credentials'),
  });
  assert.deepEqual(order, ['remote', 'credentials']);
  await assert.rejects(readFile(path.join(root, 'manifest.json')), /ENOENT/);
});

test('keeps the frozen copy when remote cleanup fails', async () => {
  const { abandonPendingBackup } = require('../out/pendingBackup.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-abandon-failed-'));
  await writeFile(path.join(root, 'manifest.json'), 'keep');
  await assert.rejects(abandonPendingBackup(root, {
    deleteRemoteStaging: async () => { throw new Error('offline'); },
    clearCredentials: async () => undefined,
  }), /offline/);
  assert.equal(await readFile(path.join(root, 'manifest.json'), 'utf8'), 'keep');
});
