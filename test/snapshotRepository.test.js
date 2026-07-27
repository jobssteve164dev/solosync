const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, readdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectIdFor, SnapshotCancelledError, SnapshotRepository } = require('../out/snapshotRepository.js');

test('creates, lists, verifies, and restores a workspace snapshot', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-test-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  const restored = path.join(temp, 'restored');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await mkdir(path.join(workspace, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'index.js'), 'export const answer = 42;\n');
  await writeFile(path.join(workspace, 'node_modules', 'ignored', 'index.js'), 'ignored');

  const roots = [{ name: 'sample', path: workspace }];
  const projectId = projectIdFor(roots);
  const repository = new SnapshotRepository();
  const progress = [];
  const manifest = await repository.create({
    backupDirectory: backup,
    projectId,
    projectName: 'Sample',
    roots,
    excludes: ['node_modules', '.git'],
    reason: 'Test',
    git: { head: 'abc123', branch: 'main', dirty: true },
    onProgress: (event) => progress.push(event),
  });

  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, 'src/index.js');
  assert.equal((await repository.list(backup, projectId)).length, 1);
  assert.deepEqual(await repository.verify(backup, manifest), { valid: true, checked: 1, errors: [] });
  assert.ok(progress.some((event) => event.phase === 'scanning'));
  assert.ok(progress.some((event) => event.phase === 'copying' && event.completed === event.total));
  assert.ok(progress.some((event) => event.phase === 'finalizing'));

  await repository.restoreAll(backup, manifest, restored);
  assert.equal(await readFile(path.join(restored, 'sample', 'src', 'index.js'), 'utf8'), 'export const answer = 42;\n');
});

test('project identifiers are stable regardless of root order', () => {
  const roots = [{ name: 'b', path: '/tmp/b' }, { name: 'a', path: '/tmp/a' }];
  assert.equal(projectIdFor(roots), projectIdFor([...roots].reverse()));
});

test('excludes a nested backup location from snapshot contents', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-nested-backup-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(workspace, 'backups');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');

  const roots = [{ name: 'sample', path: workspace }];
  const repository = new SnapshotRepository();
  const manifest = await repository.create({
    backupDirectory: backup,
    projectId: projectIdFor(roots),
    projectName: 'Sample',
    roots,
    excludes: [],
    reason: 'Test',
    git: { dirty: true },
  });

  assert.deepEqual(manifest.files.map((file) => file.path), ['source.txt']);
});

test('does not exclude source files when the backup location is an ancestor', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-parent-backup-'));
  const workspace = path.join(temp, 'projects', 'workspace');
  const backup = path.join(temp, 'projects');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'source.txt'), 'source');

  const roots = [{ name: 'sample', path: workspace }];
  const repository = new SnapshotRepository();
  const manifest = await repository.create({
    backupDirectory: backup,
    projectId: projectIdFor(roots),
    projectName: 'Sample',
    roots,
    excludes: [],
    reason: 'Test',
    git: { dirty: true },
  });

  assert.deepEqual(manifest.files.map((file) => file.path), ['source.txt']);
});

test('cancellation removes only the current staging snapshot and publishes nothing', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-cancel-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'first.txt'), 'first');
  await writeFile(path.join(workspace, 'second.txt'), 'second');

  const roots = [{ name: 'sample', path: workspace }];
  const projectId = projectIdFor(roots);
  const controller = new AbortController();
  const repository = new SnapshotRepository();
  await assert.rejects(repository.create({
    backupDirectory: backup,
    projectId,
    projectName: 'Sample',
    roots,
    excludes: [],
    reason: 'Test',
    git: { dirty: true },
    signal: controller.signal,
    onProgress: (event) => {
      if (event.phase === 'copying' && event.completed === 1) controller.abort();
    },
  }), SnapshotCancelledError);

  assert.deepEqual(await readdir(path.join(backup, 'SoloSync', projectId, 'staging')), []);
  assert.deepEqual(await repository.list(backup, projectId), []);
});
