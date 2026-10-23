const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { projectIdFor, SnapshotCancelledError, SnapshotRepository } = require('../out/snapshotRepository.js');
const { LocalFileSystemProvider } = require('../out/storageProvider.js');

async function removeTreePrecisely(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeTreePrecisely(target);
    else await unlink(target);
  }
  await rmdir(directory);
}

test('reuses one stable content object across unchanged snapshots', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-incremental-'));
  t.after(() => removeTreePrecisely(temp));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'tiny.txt'), 'same content');
  const repository = new SnapshotRepository();
  const provider = new LocalFileSystemProvider(backup);
  const options = {
    provider, projectId: 'incremental-project', projectName: 'Incremental Project',
    roots: [{ name: 'workspace', path: workspace }], excludes: [], reason: 'Test', git: { dirty: true },
  };

  const first = await repository.create(options);
  const second = await repository.create(options);

  assert.equal(first.formatVersion, 2);
  assert.equal(second.formatVersion, 2);
  assert.deepEqual(await readdir(path.join(backup, 'SoloSync', 'incremental-project', 'objects')), [first.files[0].sha256]);
  assert.deepEqual(await readdir(path.join(backup, 'SoloSync', 'incremental-project', 'snapshots', first.snapshotId)), ['manifest.json']);
  assert.deepEqual(await readdir(path.join(backup, 'SoloSync', 'incremental-project', 'snapshots', second.snapshotId)), ['manifest.json']);
});

test('adds one content object when a file changes and restores either version', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-incremental-change-'));
  t.after(() => removeTreePrecisely(temp));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  const restoredFirst = path.join(temp, 'restored-first');
  const restoredSecond = path.join(temp, 'restored-second');
  await mkdir(workspace);
  const source = path.join(workspace, 'tiny.txt');
  await writeFile(source, 'first');
  const repository = new SnapshotRepository();
  const provider = new LocalFileSystemProvider(backup);
  const options = {
    provider, projectId: 'incremental-change', projectName: 'Incremental Change',
    roots: [{ name: 'workspace', path: workspace }], excludes: [], reason: 'Test', git: { dirty: true },
  };

  const first = await repository.create(options);
  await writeFile(source, 'second');
  const second = await repository.create(options);
  await repository.restoreAll(provider, first, restoredFirst);
  await repository.restoreAll(provider, second, restoredSecond);

  assert.equal((await readdir(path.join(backup, 'SoloSync', 'incremental-change', 'objects'))).length, 2);
  assert.equal(await readFile(path.join(restoredFirst, 'workspace', 'tiny.txt'), 'utf8'), 'first');
  assert.equal(await readFile(path.join(restoredSecond, 'workspace', 'tiny.txt'), 'utf8'), 'second');
});

test('repairs an existing corrupt content object before publishing another snapshot', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-incremental-repair-'));
  t.after(() => removeTreePrecisely(temp));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'tiny.txt'), 'original');
  const repository = new SnapshotRepository();
  const provider = new LocalFileSystemProvider(backup);
  const options = {
    provider, projectId: 'incremental-repair', projectName: 'Incremental Repair',
    roots: [{ name: 'workspace', path: workspace }], excludes: [], reason: 'Test', git: { dirty: true },
  };
  const first = await repository.create(options);
  const objectKey = `SoloSync/incremental-repair/objects/${first.files[0].sha256}`;
  await provider.writeFile(objectKey, Buffer.from('corrupt'));

  const second = await repository.create(options);

  assert.deepEqual(await repository.verify(provider, first), { valid: true, checked: 1, errors: [] });
  assert.deepEqual(await repository.verify(provider, second), { valid: true, checked: 1, errors: [] });
});

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
  const provider = new LocalFileSystemProvider(backup);
  const progress = [];
  const manifest = await repository.create({
    provider,
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
  assert.equal((await repository.list(provider, projectId)).length, 1);
  assert.deepEqual(await repository.verify(provider, manifest), { valid: true, checked: 1, errors: [] });
  assert.deepEqual((await repository.listProjects(provider)).map((project) => project.projectName), ['Sample']);
  await provider.delete(`SoloSync/${projectId}/project.json`);
  assert.deepEqual((await repository.listProjects(provider)).map((project) => project.projectName), ['Sample']);
  assert.ok(progress.some((event) => event.phase === 'scanning'));
  assert.deepEqual(progress.find((event) => event.phase === 'scanning'), { phase: 'scanning', discovered: 0 });
  assert.ok(progress.some((event) => event.phase === 'copying' && event.completed === 0));
  assert.ok(progress.some((event) => event.phase === 'copying' && event.completed === event.total));
  assert.ok(progress.some((event) => event.phase === 'finalizing'));
  assert.deepEqual([...new Set(progress.map((event) => event.phase))], ['scanning', 'copying', 'finalizing', 'uploading', 'verifying', 'publishing', 'complete']);

  await repository.restoreAll(provider, manifest, restored);
  assert.equal(await readFile(path.join(restored, 'sample', 'src', 'index.js'), 'utf8'), 'export const answer = 42;\n');
});

test('project identifiers are stable regardless of root order', () => {
  const roots = [{ name: 'b', path: '/tmp/b' }, { name: 'a', path: '/tmp/a' }];
  assert.equal(projectIdFor(roots), projectIdFor([...roots].reverse()));
});

test('a corrupt single-file restore does not overwrite the selected destination', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-restore-file-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  const destination = path.join(temp, 'important.txt');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  await writeFile(destination, 'keep me');
  const roots = [{ name: 'sample', path: workspace }];
  const provider = new LocalFileSystemProvider(backup);
  const repository = new SnapshotRepository();
  const manifest = await repository.create({
    provider,
    projectId: 'restore-file-project',
    projectName: 'Restore File Project',
    roots,
    excludes: [],
    reason: 'Test',
    git: { dirty: true },
  });
  const file = manifest.files[0];
  await provider.writeFile(`SoloSync/${manifest.projectId}/objects/${file.sha256}`, Buffer.from('corrupt'));

  await assert.rejects(repository.restoreFile(provider, manifest, file, destination), /failed verification/);
  assert.equal(await readFile(destination, 'utf8'), 'keep me');
});

test('excludes a nested backup location from snapshot contents', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-nested-backup-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(workspace, 'backups');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');

  const roots = [{ name: 'sample', path: workspace }];
  const repository = new SnapshotRepository();
  const provider = new LocalFileSystemProvider(backup);
  const manifest = await repository.create({
    provider,
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
  const provider = new LocalFileSystemProvider(backup);
  const manifest = await repository.create({
    provider,
    projectId: projectIdFor(roots),
    projectName: 'Sample',
    roots,
    excludes: [],
    reason: 'Test',
    git: { dirty: true },
  });

  assert.deepEqual(manifest.files.map((file) => file.path), ['source.txt']);
});

test('applies project-relative exclusion rules to snapshot contents', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-path-exclude-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(path.join(workspace, 'config'), { recursive: true });
  await writeFile(path.join(workspace, 'config', '.env'), 'SECRET=value');
  await writeFile(path.join(workspace, 'config', 'app.js'), 'safe');

  const manifest = await new SnapshotRepository().create({
    provider: new LocalFileSystemProvider(backup), projectId: 'path-exclude', projectName: 'Path Exclude',
    roots: [{ name: 'project', path: workspace }], excludes: ['config/.env'], reason: 'Test', git: { dirty: true },
  });

  assert.deepEqual(manifest.files.map((file) => file.path), ['config/app.js']);
});

test('creates nested restore folders before asking the provider to download', async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'solosync-restore-folders-'));
  const content = Buffer.from('restored');
  const manifest = {
    formatVersion: 1, snapshotId: 'snapshot', projectId: 'project', projectName: 'Project', createdAt: new Date().toISOString(),
    reason: 'Test', git: { dirty: true }, roots: ['root'], totalBytes: content.length,
    files: [{ root: 'root', path: 'nested/file.txt', size: content.length, modifiedAt: Date.now(), sha256: require('node:crypto').createHash('sha256').update(content).digest('hex') }],
  };
  const provider = {
    downloadFile: async (key, target) => {
      assert.equal(key, 'SoloSync/project/snapshots/snapshot/files/root/nested/file.txt');
      assert.equal((await stat(path.dirname(target))).isDirectory(), true);
      await writeFile(target, content);
    },
  };

  await new SnapshotRepository().restoreAll(provider, manifest, destination);
  assert.equal(await readFile(path.join(destination, 'root', 'nested', 'file.txt'), 'utf8'), 'restored');
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
  const provider = new LocalFileSystemProvider(backup);
  await assert.rejects(repository.create({
    provider,
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

  assert.equal(await provider.exists(path.posix.join('SoloSync', projectId, 'staging')), false);
  assert.deepEqual(await repository.list(provider, projectId), []);
});

test('excludes only the exact sensitive paths approved for this project', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-sensitive-decision-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(path.join(workspace, 'config'), { recursive: true });
  await writeFile(path.join(workspace, '.env'), 'exclude');
  await writeFile(path.join(workspace, 'config', '.env'), 'include');
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  const roots = [{ name: 'sample', path: workspace }];
  const repository = new SnapshotRepository();

  const manifest = await repository.create({
    provider: new LocalFileSystemProvider(backup),
    projectId: projectIdFor(roots),
    projectName: 'Sample',
    roots,
    excludes: [],
    excludedSensitivePaths: ['sample/.env'],
    reason: 'Test',
    git: { dirty: true },
  });

  assert.deepEqual(manifest.files.map((file) => file.path).sort(), ['config/.env', 'source.txt']);
});

test('rejects a sensitive file that appeared after the cloud review', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-sensitive-race-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'new.env.key'), 'secret');
  const roots = [{ name: 'sample', path: workspace }];

  await assert.rejects(new SnapshotRepository().create({
    provider: new LocalFileSystemProvider(backup),
    projectId: projectIdFor(roots),
    projectName: 'Sample',
    roots,
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Test',
    git: { dirty: true },
  }), /review sensitive files again/i);
});

test('verifies uploaded file contents without loading backup files through metadata reads', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-stream-verify-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'large.bin'), Buffer.alloc(1024 * 1024, 3));
  class StreamingProvider extends LocalFileSystemProvider {
    async readFile(key, signal) {
      if (key.includes('/files/')) throw new Error('backup data was loaded as metadata');
      return super.readFile(key, signal);
    }
  }
  const roots = [{ name: 'sample', path: workspace }];

  const manifest = await new SnapshotRepository().create({
    provider: new StreamingProvider(backup),
    projectId: projectIdFor(roots),
    projectName: 'Sample',
    roots,
    excludes: [],
    reason: 'Test',
    git: { dirty: true },
  });

  assert.equal(manifest.files.length, 1);
});

test('resumes the same frozen snapshot after a transient upload failure', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-pending-resume-'));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'source.txt'), 'frozen');
  class FlakyProvider extends LocalFileSystemProvider {
    failed = false;
    async writeFile(key, source, signal) {
      if (!this.failed && key.includes('/objects/')) {
        this.failed = true;
        throw new Error('temporary network failure');
      }
      return super.writeFile(key, source, signal);
    }
  }
  const provider = new FlakyProvider(backup);
  const repository = new SnapshotRepository();
  const options = {
    provider, projectId: 'resume-project', projectName: 'Resume Project',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true }, pendingDirectory: pending,
    pendingDestinationIdentity: `google-drive-root-id:${'a'.repeat(64)}:root-a`,
  };

  await assert.rejects(repository.create(options), /temporary network failure/);
  const pendingManifest = JSON.parse(await readFile(path.join(pending, 'manifest.json'), 'utf8'));
  const pendingJob = JSON.parse(await readFile(path.join(pending, 'job.json'), 'utf8'));
  assert.equal(pendingJob.state, 'uploading');
  assert.equal(pendingJob.snapshotId, pendingManifest.snapshotId);
  assert.equal(pendingJob.destinationIdentity, `google-drive-root-id:${'a'.repeat(64)}:root-a`);
  await assert.rejects(repository.create({ ...options, pendingDestinationIdentity: `google-drive-root-id:${'b'.repeat(64)}:root-b` }), /different Google Drive account/);
  await writeFile(path.join(workspace, 'source.txt'), 'changed later');
  provider.failed = false;
  await assert.rejects(repository.create({ ...options, pendingDestinationIdentity: `google-drive-root-id:${'a'.repeat(64)}:root-b` }), /temporary network failure/);
  assert.equal(JSON.parse(await readFile(path.join(pending, 'job.json'), 'utf8')).destinationIdentity, `google-drive-root-id:${'a'.repeat(64)}:root-b`);
  const completed = await repository.create({ ...options, pendingDestinationIdentity: `google-drive-root-id:${'a'.repeat(64)}:root-b` });

  assert.equal(completed.snapshotId, pendingManifest.snapshotId);
  assert.equal((await provider.readFile(`SoloSync/resume-project/objects/${completed.files[0].sha256}`)).toString(), 'frozen');
  assert.equal(await provider.exists(`SoloSync/resume-project/snapshots/${completed.snapshotId}/job.json`), false);
  await assert.rejects(readFile(path.join(pending, 'manifest.json')), /ENOENT/);
});

test('recognizes a committed snapshot when the publish response was lost', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-publish-resume-'));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'source.txt'), 'content');
  class LostResponseProvider extends LocalFileSystemProvider {
    lost = false;
    async move(source, destination, signal) {
      await super.move(source, destination, signal);
      if (!this.lost) {
        this.lost = true;
        throw new Error('publish response lost');
      }
    }
  }
  const provider = new LostResponseProvider(backup);
  const repository = new SnapshotRepository();
  const options = {
    provider, projectId: 'publish-project', projectName: 'Publish Project',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true }, pendingDirectory: pending,
  };

  await assert.rejects(repository.create(options), /publish response lost/);
  const resumed = await repository.create(options);

  assert.equal((await repository.list(provider, 'publish-project')).some((item) => item.snapshotId === resumed.snapshotId), true);
  await assert.rejects(readFile(path.join(pending, 'manifest.json')), /ENOENT/);
});

test('rejects a different committed manifest when reconciling a lost publish response', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-publish-mismatch-'));
  t.after(() => removeTreePrecisely(temp));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'source.txt'), 'content');
  class LostResponseProvider extends LocalFileSystemProvider {
    lost = false;
    async move(source, destination, signal) {
      await super.move(source, destination, signal);
      if (!this.lost) {
        this.lost = true;
        throw new Error('publish response lost');
      }
    }
  }
  const provider = new LostResponseProvider(backup);
  const repository = new SnapshotRepository();
  const options = {
    provider, projectId: 'publish-mismatch', projectName: 'Publish Mismatch',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true }, pendingDirectory: pending,
  };
  await assert.rejects(repository.create(options), /publish response lost/);
  const frozen = JSON.parse(await readFile(path.join(pending, 'manifest.json'), 'utf8'));
  const committedPath = path.join(backup, 'SoloSync', 'publish-mismatch', 'snapshots', frozen.snapshotId, 'manifest.json');
  const different = { ...frozen, files: frozen.files.map((file) => ({ ...file, path: `different-${file.path}` })) };
  await writeFile(committedPath, `${JSON.stringify(different, null, 2)}\n`);

  await assert.rejects(repository.create(options), /does not match the pending backup/);
  assert.equal(await readFile(path.join(pending, 'manifest.json'), 'utf8').then(Boolean), true);
});

test('rejects damaged content when reconciling an otherwise matching committed snapshot', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-publish-corrupt-'));
  t.after(() => removeTreePrecisely(temp));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'source.txt'), 'content');
  class LostResponseProvider extends LocalFileSystemProvider {
    lost = false;
    async move(source, destination, signal) {
      await super.move(source, destination, signal);
      if (!this.lost) {
        this.lost = true;
        throw new Error('publish response lost');
      }
    }
  }
  const provider = new LostResponseProvider(backup);
  const repository = new SnapshotRepository();
  const options = {
    provider, projectId: 'publish-corrupt', projectName: 'Publish Corrupt',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true }, pendingDirectory: pending,
  };
  await assert.rejects(repository.create(options), /publish response lost/);
  const frozen = JSON.parse(await readFile(path.join(pending, 'manifest.json'), 'utf8'));
  await provider.writeFile(`SoloSync/publish-corrupt/objects/${frozen.files[0].sha256}`, Buffer.from('corrupt'));

  await assert.rejects(repository.create(options), /failed verification/);
  assert.equal(await readFile(path.join(pending, 'manifest.json'), 'utf8').then(Boolean), true);
});

test('preserves a pending backup when cancellation arrives after publication', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-publish-cancel-'));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'source.txt'), 'content');
  const controller = new AbortController();
  let credentialsCleared = 0;
  class CancelAfterMoveProvider extends LocalFileSystemProvider {
    canceled = false;
    async move(source, destination, signal) {
      await super.move(source, destination, signal);
      if (!this.canceled) {
        this.canceled = true;
        controller.abort();
      }
    }
  }
  const provider = new CancelAfterMoveProvider(backup);
  const repository = new SnapshotRepository();
  const options = {
    provider, projectId: 'publish-cancel-project', projectName: 'Publish Cancel Project',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true }, pendingDirectory: pending,
    signal: controller.signal,
    discardPendingCredentials: async () => { credentialsCleared += 1; },
  };

  await assert.rejects(repository.create(options), /Continue the pending backup/);
  const pendingManifest = JSON.parse(await readFile(path.join(pending, 'manifest.json'), 'utf8'));
  assert.equal(await provider.exists(`SoloSync/publish-cancel-project/snapshots/${pendingManifest.snapshotId}`), true);
  assert.equal(credentialsCleared, 0);

  const resumed = await repository.create({ ...options, signal: undefined });
  assert.equal(resumed.snapshotId, pendingManifest.snapshotId);
  await assert.rejects(stat(pending), /ENOENT/);
});

test('checks pending disk capacity before creating a frozen copy', async () => {
  const { PendingBackupSpaceError } = require('../out/pendingBackup.js');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-capacity-'));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'large.bin'), Buffer.alloc(100));

  await assert.rejects(new SnapshotRepository().create({
    provider: new LocalFileSystemProvider(backup), projectId: 'capacity-project', projectName: 'Capacity Project',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true },
    pendingDirectory: pending,
    pendingAvailableBytes: async () => 64 * 1024 * 1024 + 99,
  }), PendingBackupSpaceError);
  await assert.rejects(readFile(path.join(pending, 'manifest.json')), /ENOENT/);
  await assert.rejects(stat(pending), /ENOENT/);
});

test('clears pending upload credentials when the user cancels a frozen backup', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-pending-cancel-'));
  const workspace = path.join(temp, 'project');
  const backup = path.join(temp, 'backup');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await mkdir(backup);
  await writeFile(path.join(workspace, 'source.txt'), 'content');
  const controller = new AbortController();
  let credentialsCleared = 0;

  await assert.rejects(new SnapshotRepository().create({
    provider: new LocalFileSystemProvider(backup), projectId: 'cancel-project', projectName: 'Cancel Project',
    roots: [{ name: 'project', path: workspace }], excludes: [], reason: 'Manual', git: { dirty: true },
    pendingDirectory: pending,
    signal: controller.signal,
    discardPendingCredentials: async () => { credentialsCleared += 1; },
    onProgress: (event) => { if (event.phase === 'copying') controller.abort(); },
  }), SnapshotCancelledError);

  assert.equal(credentialsCleared, 1);
  await assert.rejects(stat(pending), /ENOENT/);
});
