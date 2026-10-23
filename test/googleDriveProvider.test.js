const assert = require('node:assert/strict');
const { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { GoogleDriveProvider } = require('../out/googleDriveProvider.js');
const { SnapshotRepository } = require('../out/snapshotRepository.js');

async function removeTreePrecisely(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeTreePrecisely(target);
    else await unlink(target);
  }
  await rmdir(directory);
}

class MemoryDriveApi {
  constructor() {
    this.sequence = 0;
    this.items = new Map();
    this.calls = [];
    this.generatedIds = [];
  }

  async about() {
    this.calls.push('about');
    return { user: { permissionId: 'permission-user-a', displayName: 'Solo User', emailAddress: 'solo@example.com' }, storageQuota: { limit: '1000000', usage: '100' } };
  }

  async generateId() {
    if (this.generatedIds.length === 0) {
      this.calls.push('generateIds');
      for (let index = 0; index < 10; index += 1) this.generatedIds.push(`id-${++this.sequence}`);
    }
    return this.generatedIds.shift();
  }

  async listChildren(parentId, properties = {}) {
    this.calls.push('listChildren');
    return [...this.items.values()].filter((item) => !item.trashed && item.parents.includes(parentId)
      && Object.entries(properties).every(([key, value]) => item.appProperties[key] === value));
  }

  async listFolders(properties = {}) {
    this.calls.push('listFolders');
    return [...this.items.values()].filter((item) => !item.trashed && item.mimeType === 'application/vnd.google-apps.folder'
      && Object.entries(properties).every(([key, value]) => item.appProperties[key] === value));
  }

  async listFiles(properties = {}) {
    this.calls.push('listFiles');
    return [...this.items.values()].filter((item) => !item.trashed && item.mimeType !== 'application/vnd.google-apps.folder'
      && Object.entries(properties).every(([key, value]) => item.appProperties[key] === value));
  }

  async createFolder(item) {
    this.calls.push('createFolder');
    if (this.items.has(item.id)) throw new Error('already exists');
    const created = { ...item, mimeType: 'application/vnd.google-apps.folder', size: undefined, content: undefined, createdTime: new Date(this.sequence * 1000).toISOString(), trashed: false };
    this.items.set(item.id, created);
    return created;
  }

  async uploadFile(item, source) {
    this.calls.push('uploadFile');
    const content = Buffer.isBuffer(source) ? source : await readFile(source);
    const created = { ...item, mimeType: 'application/octet-stream', size: String(content.length), sha256Checksum: createHash('sha256').update(content).digest('hex'), content, createdTime: new Date(this.sequence * 1000).toISOString(), trashed: false };
    this.items.set(item.id, created);
    return created;
  }

  async replaceFile(item, source) {
    this.calls.push('replaceFile');
    const existing = this.items.get(item.id);
    if (!existing || existing.trashed) throw new Error('not found');
    const content = Buffer.isBuffer(source) ? source : await readFile(source);
    const replaced = {
      ...existing,
      ...item,
      mimeType: 'application/octet-stream',
      size: String(content.length),
      sha256Checksum: createHash('sha256').update(content).digest('hex'),
      content,
    };
    this.items.set(item.id, replaced);
    return replaced;
  }

  async get(id) { this.calls.push('get'); return this.items.get(id); }

  async update(id, patch) {
    this.calls.push('update');
    const item = this.items.get(id);
    if (!item) throw new Error('not found');
    Object.assign(item, patch);
    if (patch.addParent) item.parents = [patch.addParent];
    return item;
  }

  async readFile(id) { this.calls.push('readFile'); return Buffer.from(this.items.get(id).content); }

  async hashFile(id) { this.calls.push('hashFile'); return createHash('sha256').update(this.items.get(id).content).digest('hex'); }

  async forgetUpload() { this.calls.push('forgetUpload'); }

  async downloadFile(id, destination) {
    this.calls.push('downloadFile');
    const { mkdir, writeFile } = require('node:fs/promises');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, this.items.get(id).content);
  }

  async trash(id) { this.calls.push('trash'); this.items.get(id).trashed = true; }
}

test('completes empty and small snapshots within a 30-second one-second-RTT budget', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-budget-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  const source = path.join(workspace, 'tiny.txt');
  await mkdir(workspace);
  t.after(async () => {
    await unlink(source).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(workspace);
    await rmdir(temp);
  });
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  await provider.validate();
  const repository = new SnapshotRepository();
  assert.equal(await repository.projectExists(provider, 'latency-budget'), false);

  const empty = await repository.create({
    provider,
    projectId: 'latency-budget',
    projectName: 'Latency Budget',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Performance test',
    git: { dirty: true },
  });

  assert.equal(empty.files.length, 0);
  const emptyRemoteCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(emptyRemoteCalls <= 26, `expected a new empty snapshot to use at most 26 Drive requests, received ${emptyRemoteCalls}: ${JSON.stringify(api.calls)}`);

  await writeFile(source, 'x');
  api.calls = [];
  const manifest = await repository.create({
    provider,
    projectId: 'latency-budget',
    projectName: 'Latency Budget',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Small performance test',
    git: { dirty: true },
  });
  assert.equal(manifest.files.length, 1);
  const remoteCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(remoteCalls <= 23, `expected a changed small-file snapshot to use at most 23 Drive requests, received ${remoteCalls}: ${JSON.stringify(api.calls)}`);

  api.calls = [];
  const repeated = await repository.create({
    provider,
    projectId: 'latency-budget',
    projectName: 'Latency Budget',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Repeated performance test',
    git: { dirty: true },
  });
  assert.equal(repeated.files[0].sha256, manifest.files[0].sha256);
  const repeatedCurrent = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(repeatedCurrent.appProperties.snapshotId, repeated.snapshotId, 'an unchanged current file should still converge to the latest committed snapshot');
  assert.equal(api.calls.filter((call) => call === 'uploadFile').length, 1, 'an unchanged snapshot should upload only its manifest');
  const repeatedRemoteCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(repeatedRemoteCalls <= 12, `expected an unchanged snapshot to use at most 12 Drive requests, received ${repeatedRemoteCalls}: ${JSON.stringify(api.calls)}`);
  assert.equal(api.calls.filter((call) => call === 'hashFile').length, 0, 'Drive SHA-256 metadata should avoid downloading unchanged objects');
});

test('stores automatic backup history as records in one stable folder instead of snapshot folders', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-compact-history-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'compact-history',
    projectName: 'Compact History',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Compact history',
    git: { dirty: true },
  };

  await repository.create(options);
  await repository.create(options);

  const historyFolders = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'history');
  const snapshotFolders = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'snapshot' && item.mimeType === 'application/vnd.google-apps.folder');
  const records = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'snapshot' && item.appProperties.format === '2');
  assert.equal(historyFolders.length, 1);
  assert.equal(snapshotFolders.length, 0);
  assert.equal(records.length, 2);
  assert.ok(records.every((item) => item.parents.includes(historyFolders[0].id)));
  assert.ok(records.every((item) => item.name.endsWith('.json') && item.name !== 'manifest.json'));
  assert.deepEqual((await repository.list(provider, 'compact-history')).map((item) => item.snapshotId), records.map((item) => item.appProperties.snapshotId).sort().reverse());
});

test('an already connected window sees history first created by another window', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-cross-window-history-'));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const writer = await GoogleDriveProvider.connect(api);
  const reader = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  assert.deepEqual(await repository.list(reader, 'cross-window-history'), []);
  const manifest = await repository.create({
    provider: writer,
    projectId: 'cross-window-history',
    projectName: 'Cross Window History',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Cross-window history',
    git: { dirty: true },
  });

  assert.deepEqual((await repository.list(reader, 'cross-window-history')).map((item) => item.snapshotId), [manifest.snapshotId]);
});

test('reuses a recent root validation during the same connection', async () => {
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  api.calls = [];

  await provider.validate();
  await provider.validate();

  assert.deepEqual(api.calls, []);
});

test('keeps the original file name and extension for the visible current Drive file', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-visible-name-'));
  const source = path.join(temp, 'project-notes.md');
  const contents = Buffer.from('# Notes\n');
  await writeFile(source, contents);
  t.after(async () => {
    await unlink(source);
    await rmdir(temp);
  });
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  await new SnapshotRepository().create({
    provider,
    projectId: 'visible-name',
    projectName: 'Visible Name',
    roots: [{ name: 'workspace', path: temp }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Visible name',
    git: { dirty: true },
  });

  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(current.name, 'project-notes.md');
  assert.equal(current.content.toString(), contents.toString());
});

test('does not repeat the workspace root folder inside a single-root project folder', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-single-root-layout-'));
  const workspace = path.join(temp, 'BACKUP');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);

  await new SnapshotRepository().create({
    provider,
    projectId: 'single-root-layout',
    projectName: 'BACKUP',
    roots: [{ name: 'BACKUP', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Single-root layout',
    git: { dirty: true },
  });

  const project = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'single-root-layout');
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  const repeatedRoot = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current-directory' && item.name === 'BACKUP');
  assert.deepEqual(current.parents, [project.id]);
  assert.equal(repeatedRoot.length, 0);
});

test('keeps a legitimate top-level folder that has the same name as the single workspace root', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-same-name-child-'));
  const workspace = path.join(temp, 'BACKUP');
  const sameNameChild = path.join(workspace, 'BACKUP');
  await mkdir(workspace);
  await mkdir(sameNameChild);
  await writeFile(path.join(sameNameChild, 'nested.txt'), 'nested');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);

  await new SnapshotRepository().create({
    provider,
    projectId: 'same-name-child',
    projectName: 'BACKUP',
    roots: [{ name: 'BACKUP', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Same-name child layout',
    git: { dirty: true },
  });

  const project = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'same-name-child');
  const directory = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current-directory' && item.name === 'BACKUP');
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  assert.deepEqual(directory.parents, [project.id]);
  assert.deepEqual(current.parents, [directory.id]);
  assert.equal(current.name, 'nested.txt');
});

test('moves current files out of the redundant v0.0.13 root folder and safely archives the old folder', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-single-root-migration-'));
  const workspace = path.join(temp, 'BACKUP');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'single-root-migration',
    projectName: 'BACKUP',
    roots: [{ name: 'BACKUP', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Single-root migration',
    git: { dirty: true },
  };
  await repository.create(options);
  const project = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'single-root-migration');
  delete project.appProperties.currentLayout;
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  const redundantRoot = await api.createFolder({
    id: 'redundant-workspace-root',
    name: 'BACKUP',
    parents: [project.id],
    appProperties: {
      product: 'solosync',
      role: 'current-directory',
      format: '1',
      projectId: 'single-root-migration',
      sourcePathHash: createHash('sha256').update('BACKUP').digest('hex'),
    },
  });
  await api.update(current.id, { addParent: redundantRoot.id, removeParent: project.id });
  const userFile = await api.uploadFile({
    id: 'user-file-inside-old-layout',
    name: 'keep-me.txt',
    parents: [redundantRoot.id],
    appProperties: {},
  }, Buffer.from('user content'));

  await repository.create(options);

  const migrated = api.items.get(current.id);
  const archivedRoot = api.items.get(redundantRoot.id);
  const history = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'history');
  assert.deepEqual(migrated.parents, [project.id]);
  assert.equal(archivedRoot.trashed, false);
  assert.deepEqual(archivedRoot.parents, [history.id]);
  assert.equal(archivedRoot.name, 'Previous Folder Layout - BACKUP');
  assert.equal(archivedRoot.appProperties.role, 'archived-current-directory');
  assert.equal(api.items.get(userFile.id).trashed, false);
  assert.deepEqual(api.items.get(userFile.id).parents, [archivedRoot.id]);
});

test('archives the redundant v0.0.13 root folder after all current files were deleted', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-empty-single-root-migration-'));
  const workspace = path.join(temp, 'BACKUP');
  const source = path.join(workspace, 'source.txt');
  await mkdir(workspace);
  await writeFile(source, 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'empty-single-root-migration',
    projectName: 'BACKUP',
    roots: [{ name: 'BACKUP', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Empty single-root migration',
    git: { dirty: true },
  };
  await repository.create(options);
  const project = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'empty-single-root-migration');
  delete project.appProperties.currentLayout;
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  const redundantRoot = await api.createFolder({
    id: 'empty-redundant-workspace-root',
    name: 'BACKUP',
    parents: [project.id],
    appProperties: {
      product: 'solosync',
      role: 'current-directory',
      format: '1',
      projectId: 'empty-single-root-migration',
      sourcePathHash: createHash('sha256').update('BACKUP').digest('hex'),
    },
  });
  await api.update(current.id, { addParent: redundantRoot.id, removeParent: project.id });
  await unlink(source);

  await repository.create(options);

  const archivedRoot = api.items.get(redundantRoot.id);
  const history = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'history');
  assert.equal(api.items.get(current.id).trashed, true);
  assert.equal(archivedRoot.trashed, false);
  assert.deepEqual(archivedRoot.parents, [history.id]);
  assert.equal(archivedRoot.appProperties.role, 'archived-current-directory');
});

test('migrates a real v0.0.13 same-name nested path without archiving the new layout folder', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-same-name-migration-'));
  const workspace = path.join(temp, 'BACKUP');
  const source = path.join(workspace, 'source.txt');
  const nestedDirectory = path.join(workspace, 'BACKUP');
  const nestedSource = path.join(nestedDirectory, 'nested.txt');
  await mkdir(workspace);
  await writeFile(source, 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const repository = new SnapshotRepository();
  const options = {
    projectId: 'same-name-migration',
    projectName: 'BACKUP',
    roots: [{ name: 'BACKUP', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Same-name migration',
    git: { dirty: true },
  };
  const initialProvider = await GoogleDriveProvider.connect(api);
  await repository.create({ ...options, provider: initialProvider });
  const project = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'same-name-migration');
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  delete project.appProperties.currentLayout;
  const legacyRoot = await api.createFolder({
    id: 'same-name-legacy-root',
    name: 'BACKUP',
    parents: [project.id],
    appProperties: {
      product: 'solosync', role: 'current-directory', format: '1', projectId: 'same-name-migration',
      sourcePathHash: createHash('sha256').update('BACKUP').digest('hex'),
    },
  });
  const legacyRelativeDirectory = await api.createFolder({
    id: 'same-name-legacy-relative-directory',
    name: 'BACKUP',
    parents: [legacyRoot.id],
    appProperties: {
      product: 'solosync', role: 'current-directory', format: '1', projectId: 'same-name-migration',
      sourcePathHash: createHash('sha256').update('BACKUP/BACKUP').digest('hex'),
    },
  });
  await api.update(current.id, {
    name: 'nested.txt',
    appProperties: {
      ...current.appProperties,
      sourcePathHash: createHash('sha256').update('BACKUP/BACKUP/nested.txt').digest('hex'),
    },
    addParent: legacyRelativeDirectory.id,
    removeParent: project.id,
  });
  await unlink(source);
  await mkdir(nestedDirectory);
  await writeFile(nestedSource, 'source');

  const upgradedProvider = await GoogleDriveProvider.connect(api);
  await repository.create({ ...options, provider: upgradedProvider });

  const migrated = api.items.get(current.id);
  const currentDirectory = [...api.items.values()].find((item) => !item.trashed
    && item.appProperties.role === 'current-directory'
    && item.name === 'BACKUP'
    && item.parents.includes(project.id));
  const archivedLegacyRoot = api.items.get(legacyRoot.id);
  const history = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'history');
  assert.deepEqual(currentDirectory.parents, [project.id]);
  assert.deepEqual(migrated.parents, [currentDirectory.id]);
  assert.equal(migrated.id, current.id);
  assert.deepEqual(archivedLegacyRoot.parents, [history.id]);
  assert.equal(archivedLegacyRoot.appProperties.role, 'archived-current-directory');
});

test('keeps workspace root folders when a project contains multiple roots', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-multi-root-layout-'));
  const frontend = path.join(temp, 'frontend');
  const backend = path.join(temp, 'backend');
  await mkdir(frontend);
  await mkdir(backend);
  await writeFile(path.join(frontend, 'config.json'), 'frontend');
  await writeFile(path.join(backend, 'config.json'), 'backend');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);

  await new SnapshotRepository().create({
    provider,
    projectId: 'multi-root-layout',
    projectName: 'Multi Root',
    roots: [{ name: 'frontend', path: frontend }, { name: 'backend', path: backend }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Multi-root layout',
    git: { dirty: true },
  });

  const current = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(current.length, 2);
  assert.deepEqual(current.map((item) => api.items.get(item.parents[0]).name).sort(), ['backend', 'frontend']);
  assert.equal(new Set(current.map((item) => item.appProperties.sourcePathHash)).size, 2);
});

test('replaces the visible Drive file when the same source path changes and keeps both snapshots restorable', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-visible-replacement-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  const restoredFirst = path.join(temp, 'restored-first');
  const restoredSecond = path.join(temp, 'restored-second');
  const restoredThird = path.join(temp, 'restored-third');
  await mkdir(workspace);
  const source = path.join(workspace, 'source.txt');
  await writeFile(source, 'first');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'visible-replacement',
    projectName: 'Visible Replacement',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Visible replacement',
    git: { dirty: true },
  };

  const first = await repository.create(options);
  const firstVisible = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  const stableVisibleId = firstVisible.id;
  await writeFile(source, 'second');
  api.calls = [];
  const second = await repository.create(options);
  const replacementCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(replacementCalls <= 15, `expected a first visible replacement to use at most 15 Drive requests, received ${replacementCalls}: ${JSON.stringify(api.calls)}`);

  const project = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'visible-replacement');
  const visible = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current' && item.name === 'source.txt');
  const versionFolder = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'version-history');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, stableVisibleId);
  assert.equal(visible[0].content.toString(), 'second');
  assert.ok(versionFolder);
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.parents.includes(versionFolder.id) && item.appProperties.role === 'object').length, 2);

  await writeFile(source, 'first');
  api.calls = [];
  const third = await repository.create(options);
  const reusedVersionCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(reusedVersionCalls <= 12, `expected reusing a previous version to use at most 12 Drive requests, received ${reusedVersionCalls}: ${JSON.stringify(api.calls)}`);
  const visibleAfterReuse = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current' && item.name === 'source.txt');
  assert.equal(visibleAfterReuse.length, 1);
  assert.equal(visibleAfterReuse[0].id, stableVisibleId);
  assert.equal(visibleAfterReuse[0].content.toString(), 'first');
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.parents.includes(versionFolder.id) && item.appProperties.role === 'object').length, 2);

  await repository.restoreAll(provider, first, restoredFirst);
  await repository.restoreAll(provider, second, restoredSecond);
  await repository.restoreAll(provider, third, restoredThird);
  assert.equal(await readFile(path.join(restoredFirst, 'workspace', 'source.txt'), 'utf8'), 'first');
  assert.equal(await readFile(path.join(restoredSecond, 'workspace', 'source.txt'), 'utf8'), 'second');
  assert.equal(await readFile(path.join(restoredThird, 'workspace', 'source.txt'), 'utf8'), 'first');
});

test('keeps one visible current file per source path when different paths have identical contents', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-same-content-paths-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  await mkdir(path.join(workspace, 'a'), { recursive: true });
  await mkdir(path.join(workspace, 'b'), { recursive: true });
  await writeFile(path.join(workspace, 'a', 'config.json'), 'A');
  await writeFile(path.join(workspace, 'b', 'config.json'), 'B');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'same-content-paths',
    projectName: 'Same Content Paths',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Same content paths',
    git: { dirty: true },
  };

  await repository.create(options);
  await writeFile(path.join(workspace, 'a', 'config.json'), 'B');
  await repository.create(options);

  const current = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.deepEqual(current.map((item) => item.name).sort(), ['config.json', 'config.json']);
  assert.equal(new Set(current.map((item) => item.appProperties.sourcePathHash)).size, 2);
  assert.equal(new Set(current.map((item) => item.parents[0])).size, 2);
  assert.deepEqual(current.map((item) => api.items.get(item.parents[0]).name).sort(), ['a', 'b']);
  assert.ok(current.every((item) => item.content.toString() === 'B'));
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'object').length, 2);
});

test('removes the visible current file when its source path is deleted without removing restore history', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-deleted-current-'));
  const workspace = path.join(temp, 'workspace');
  const source = path.join(workspace, 'deleted.txt');
  await mkdir(workspace);
  await writeFile(source, 'keep in history');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'deleted-current',
    projectName: 'Deleted Current',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Deleted current',
    git: { dirty: true },
  };

  const first = await repository.create(options);
  await unlink(source);
  await repository.create(options);

  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current').length, 0);
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'object').length, 1);
  const restored = path.join(temp, 'restored');
  await repository.restoreAll(provider, first, restored);
  assert.equal(await readFile(path.join(restored, 'workspace', 'deleted.txt'), 'utf8'), 'keep in history');
});

test('keeps the previous visible file when an in-place Drive replacement fails', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-replace-failure-'));
  const workspace = path.join(temp, 'workspace');
  const source = path.join(workspace, 'source.txt');
  await mkdir(workspace);
  await writeFile(source, 'before');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'replace-failure',
    projectName: 'Replace Failure',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Replace failure',
    git: { dirty: true },
  };
  await repository.create(options);
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  const stableId = current.id;
  await writeFile(source, 'after');
  api.replaceFile = async () => { throw new Error('replacement failed'); };

  await assert.rejects(repository.create(options), /replacement failed/);

  const visible = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, stableId);
  assert.equal(visible[0].content.toString(), 'before');
  assert.equal((await repository.list(provider, 'replace-failure')).length, 2, 'the snapshot is committed before the optional current-file view is updated');
});

test('does not change the visible current file when publishing the new snapshot fails', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-publish-failure-'));
  const workspace = path.join(temp, 'workspace');
  const source = path.join(workspace, 'source.txt');
  await mkdir(workspace);
  await writeFile(source, 'published');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'publish-failure',
    projectName: 'Publish Failure',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    reason: 'Publish failure',
    git: { dirty: true },
  };
  await repository.create(options);
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  const stableId = current.id;
  await writeFile(source, 'not published');
  provider.move = async () => { throw new Error('publish failed'); };

  await assert.rejects(repository.create(options), /publish failed/);

  const visible = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, stableId);
  assert.equal(visible[0].content.toString(), 'published');
  assert.equal((await repository.list(provider, 'publish-failure')).length, 1);
});

test('does not let an older committed snapshot overwrite a newer current file', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-current-order-'));
  const olderSource = path.join(temp, 'older.txt');
  const newerSource = path.join(temp, 'newer.txt');
  await writeFile(olderSource, 'older');
  await writeFile(newerSource, 'newer');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const olderProvider = await GoogleDriveProvider.connect(api);
  const newerProvider = await GoogleDriveProvider.connect(api);
  const projectId = 'current-order';
  const olderSnapshot = '2026-01-01T00-00-00-000Z_old';
  const newerSnapshot = '2026-01-01T00-00-01-000Z_new';
  for (const [provider, snapshotId] of [[olderProvider, olderSnapshot], [newerProvider, newerSnapshot]]) {
    const staging = `SoloSync/${projectId}/staging/${snapshotId}`;
    await provider.createDirectory(staging);
    await provider.writeFile(`${staging}/manifest.json`, Buffer.from(JSON.stringify({ snapshotId })));
    await provider.move(staging, `SoloSync/${projectId}/snapshots/${snapshotId}`);
  }
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  const olderFile = [{ key: `SoloSync/${projectId}/objects/${sha('older')}`, sha256: sha('older'), displayName: 'source.txt', displayPath: 'workspace/source.txt', source: olderSource }];
  const newerFile = [{ key: `SoloSync/${projectId}/objects/${sha('newer')}`, sha256: sha('newer'), displayName: 'source.txt', displayPath: 'workspace/source.txt', source: newerSource }];

  await newerProvider.syncVisibleFiles(newerFile, projectId, newerSnapshot);
  await olderProvider.syncVisibleFiles(olderFile, projectId, olderSnapshot);

  const current = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(current.length, 1);
  assert.equal(current[0].content.toString(), 'newer');
  assert.equal(current[0].appProperties.snapshotId, newerSnapshot);
});

test('converges to the newest committed file when an older replacement finishes last', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-current-race-'));
  const olderSource = path.join(temp, 'older.txt');
  const newerSource = path.join(temp, 'newer.txt');
  await writeFile(olderSource, 'older');
  await writeFile(newerSource, 'newer');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const olderProvider = await GoogleDriveProvider.connect(api);
  const newerProvider = await GoogleDriveProvider.connect(api);
  const projectId = 'current-race';
  const olderSnapshot = '2026-01-01T00-00-00-000Z_old';
  const newerSnapshot = '2026-01-01T00-00-01-000Z_new';
  const sha = (value) => createHash('sha256').update(value).digest('hex');

  async function commit(provider, snapshotId, value, source) {
    const digest = sha(value);
    const objectKey = `SoloSync/${projectId}/objects/${digest}`;
    await provider.writeFile(objectKey, source);
    const staging = `SoloSync/${projectId}/staging/${snapshotId}`;
    await provider.createDirectory(staging);
    await provider.writeFile(`${staging}/manifest.json`, Buffer.from(JSON.stringify({
      formatVersion: 2,
      snapshotId,
      projectId,
      projectName: 'Current Race',
      createdAt: new Date().toISOString(),
      reason: 'Concurrency regression',
      git: { dirty: true },
      roots: ['workspace'],
      files: [{ root: 'workspace', path: 'source.txt', size: Buffer.byteLength(value), sha256: digest }],
      totalBytes: Buffer.byteLength(value),
    })));
    await provider.move(staging, `SoloSync/${projectId}/snapshots/${snapshotId}`);
    return [{ key: objectKey, sha256: digest, displayName: 'source.txt', displayPath: 'workspace/source.txt', source }];
  }

  const olderFiles = await commit(olderProvider, olderSnapshot, 'older', olderSource);
  await olderProvider.syncVisibleFiles(olderFiles, projectId, olderSnapshot);

  const originalReplace = api.replaceFile.bind(api);
  let releaseOlderReplacement;
  let olderReplacementStarted;
  const olderReplacementGate = new Promise((resolve) => { releaseOlderReplacement = resolve; });
  const olderReplacementEntered = new Promise((resolve) => { olderReplacementStarted = resolve; });
  let intercepted = false;
  api.replaceFile = async (item, source) => {
    const content = Buffer.isBuffer(source) ? source : await readFile(source);
    if (!intercepted && content.toString() === 'older-again') {
      intercepted = true;
      olderReplacementStarted();
      await olderReplacementGate;
    }
    return originalReplace(item, source);
  };

  await writeFile(olderSource, 'older-again');
  const lateOlderSnapshot = '2026-01-01T00-00-02-000Z_old';
  const lateOlderFiles = await commit(olderProvider, lateOlderSnapshot, 'older-again', olderSource);
  const lateOlderSync = olderProvider.syncVisibleFiles(lateOlderFiles, projectId, lateOlderSnapshot);
  await olderReplacementEntered;

  const newestSnapshot = '2026-01-01T00-00-03-000Z_new';
  const newerFiles = await commit(newerProvider, newestSnapshot, 'newer', newerSource);
  await newerProvider.syncVisibleFiles(newerFiles, projectId, newestSnapshot);
  releaseOlderReplacement();
  await lateOlderSync;

  const current = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(current.length, 1);
  assert.equal(current[0].content.toString(), 'newer');
  assert.equal(current[0].appProperties.snapshotId, newestSnapshot);
});

test('keeps the stable current file ID when an older deletion finishes after a newer replacement', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-delete-race-'));
  const source = path.join(temp, 'source.txt');
  await writeFile(source, 'initial');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const deletingProvider = await GoogleDriveProvider.connect(api);
  const updatingProvider = await GoogleDriveProvider.connect(api);
  const projectId = 'delete-race';
  const sha = (value) => createHash('sha256').update(value).digest('hex');

  async function commit(provider, snapshotId, value) {
    const files = [];
    if (value !== undefined) {
      const digest = sha(value);
      const objectKey = `SoloSync/${projectId}/objects/${digest}`;
      await provider.writeFile(objectKey, source);
      files.push({ root: 'workspace', path: 'source.txt', size: Buffer.byteLength(value), sha256: digest });
    }
    const staging = `SoloSync/${projectId}/staging/${snapshotId}`;
    await provider.createDirectory(staging);
    await provider.writeFile(`${staging}/manifest.json`, Buffer.from(JSON.stringify({
      formatVersion: 2,
      snapshotId,
      projectId,
      projectName: 'Delete Race',
      createdAt: new Date().toISOString(),
      reason: 'Concurrency regression',
      git: { dirty: true },
      roots: ['workspace'],
      files,
      totalBytes: value === undefined ? 0 : Buffer.byteLength(value),
    })));
    await provider.move(staging, `SoloSync/${projectId}/snapshots/${snapshotId}`);
    return files.map((file) => ({
      key: `SoloSync/${projectId}/objects/${file.sha256}`,
      sha256: file.sha256,
      displayName: file.path,
      displayPath: `${file.root}/${file.path}`,
      source,
    }));
  }

  const initialSnapshot = '2026-01-01T00-00-00-000Z_initial';
  await deletingProvider.syncVisibleFiles(await commit(deletingProvider, initialSnapshot, 'initial'), projectId, initialSnapshot);
  const stableId = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current').id;

  const originalTrash = api.trash.bind(api);
  let releaseDeletion;
  let deletionStarted;
  const deletionGate = new Promise((resolve) => { releaseDeletion = resolve; });
  const deletionEntered = new Promise((resolve) => { deletionStarted = resolve; });
  api.trash = async (id) => {
    if (id === stableId) {
      deletionStarted();
      await deletionGate;
    }
    return originalTrash(id);
  };

  const deletionSnapshot = '2026-01-01T00-00-01-000Z_delete';
  await commit(deletingProvider, deletionSnapshot, undefined);
  const deletion = deletingProvider.syncVisibleFiles([], projectId, deletionSnapshot);
  await deletionEntered;

  await writeFile(source, 'newer');
  const newerSnapshot = '2026-01-01T00-00-02-000Z_newer';
  await updatingProvider.syncVisibleFiles(await commit(updatingProvider, newerSnapshot, 'newer'), projectId, newerSnapshot);
  releaseDeletion();
  await deletion;

  const current = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(current.length, 1);
  assert.equal(current[0].id, stableId);
  assert.equal(current[0].content.toString(), 'newer');
  assert.equal(current[0].appProperties.snapshotId, newerSnapshot);
});

test('cleans up duplicate visible names created by version 0.0.12 without reuploading retained content', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-visible-migration-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'new');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  await provider.createDirectory('SoloSync/visible-migration/objects');
  const project = [...api.items.values()].find((item) => item.appProperties.role === 'project' && item.appProperties.projectId === 'visible-migration');
  for (const [id, content] of [['legacy-old', 'old'], ['legacy-new', 'new']]) {
    const digest = createHash('sha256').update(content).digest('hex');
    const key = `SoloSync/visible-migration/objects/${digest}`;
    await api.uploadFile({
      id,
      name: 'source.txt',
      parents: [project.id],
      appProperties: {
        product: 'solosync', role: 'object', format: '1', projectId: 'visible-migration',
        logicalKeyHash: createHash('sha256').update(key).digest('hex'), contentSha256: digest,
      },
    }, Buffer.from(content));
  }
  api.calls = [];

  await new SnapshotRepository().create({
    provider,
    projectId: 'visible-migration',
    projectName: 'Visible Migration',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Migrate duplicate names',
    git: { dirty: true },
  });

  const visible = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'current' && item.name === 'source.txt');
  const versions = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'version-history');
  assert.equal(visible.length, 1);
  assert.equal(visible[0].content.toString(), 'new');
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.parents.includes(versions.id) && item.appProperties.role === 'object').length, 2);
  assert.equal(api.calls.filter((call) => call === 'uploadFile').length, 2, 'migration should create one current file and one compact snapshot record');
});

test('explicit file verification reads current Drive content instead of trusting cached checksum metadata', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-fresh-verification-'));
  const source = path.join(temp, 'current.txt');
  const original = Buffer.from('original');
  const changed = Buffer.from('changed');
  const sha256 = createHash('sha256').update(original).digest('hex');
  await writeFile(source, original);
  t.after(async () => {
    await unlink(source);
    await rmdir(temp);
  });
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const key = `SoloSync/fresh-verification/objects/${sha256}`;
  await provider.writeFile(key, source);
  const object = [...api.items.values()].find((item) => item.appProperties.role === 'object');
  object.content = changed;
  api.calls = [];

  assert.equal(await provider.hashFile(key), createHash('sha256').update(changed).digest('hex'));
  assert.equal(api.calls.filter((call) => call === 'hashFile').length, 1);
});

test('renames legacy hash-named objects without uploading their contents again', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-visible-migration-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  const source = path.join(workspace, 'release-notes.txt');
  const contents = Buffer.from('Release notes\n');
  const sha256 = createHash('sha256').update(contents).digest('hex');
  await mkdir(workspace);
  await writeFile(source, contents);
  t.after(async () => {
    await unlink(source);
    await rmdir(workspace);
    await rmdir(temp);
  });
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  await provider.createDirectory('SoloSync/visible-migration/objects');
  const project = [...api.items.values()].find((item) => item.appProperties.role === 'project' && item.appProperties.projectId === 'visible-migration');
  const logicalKey = `SoloSync/visible-migration/objects/${sha256}`;
  const logicalKeyHash = createHash('sha256').update(logicalKey).digest('hex');
  const legacy = await api.uploadFile({
    id: 'legacy-object',
    name: sha256,
    parents: [project.id],
    appProperties: { product: 'solosync', role: 'object', format: '1', projectId: 'visible-migration', logicalKeyHash },
  }, contents);
  api.calls = [];

  await new SnapshotRepository().create({
    provider,
    projectId: 'visible-migration',
    projectName: 'Visible Migration',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Migrate visible names',
    git: { dirty: true },
  });

  assert.equal(legacy.name, `release-notes.${sha256.slice(0, 8)}.txt`);
  const current = [...api.items.values()].find((item) => !item.trashed && item.appProperties.role === 'current');
  assert.equal(current.name, 'release-notes.txt');
  assert.equal(api.calls.filter((call) => call === 'uploadFile').length, 2, 'migration should create the current file and compact snapshot record');
});

test('checks all unchanged objects with one Drive listing after reconnecting', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-object-index-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  const sources = ['one.txt', 'two.txt', 'three.txt'];
  for (const source of sources) await writeFile(path.join(workspace, source), source);
  t.after(async () => {
    for (const source of sources) await unlink(path.join(workspace, source));
    await rmdir(workspace);
    await rmdir(temp);
  });
  const api = new MemoryDriveApi();
  const repository = new SnapshotRepository();
  const firstProvider = await GoogleDriveProvider.connect(api);
  await repository.create({
    provider: firstProvider,
    projectId: 'object-index',
    projectName: 'Object Index',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: firstProvider.destinationIdentity,
    reason: 'Initial snapshot',
    git: { dirty: true },
  });

  api.calls = [];
  api.generatedIds = [];
  const reconnected = await GoogleDriveProvider.connect(api);
  await repository.create({
    provider: reconnected,
    projectId: 'object-index',
    projectName: 'Object Index',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: reconnected.destinationIdentity,
    reason: 'Unchanged snapshot',
    git: { dirty: true },
  });

  const remoteCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(remoteCalls <= 22, `expected reconnect plus one object listing and a fixed publish path to use at most 22 Drive requests, received ${remoteCalls}: ${JSON.stringify(api.calls)}`);
  assert.equal(api.calls.filter((call) => call === 'hashFile').length, 0);
});

test('does not publish when a reused object changes while another object is uploading', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-upload-race-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'existing.txt'), 'existing');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const repository = new SnapshotRepository();
  const options = {
    provider,
    projectId: 'upload-race',
    projectName: 'Upload Race',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Race test',
    git: { dirty: true },
  };
  await repository.create(options);
  const existing = [...api.items.values()].find((item) => item.appProperties.role === 'object');
  await writeFile(path.join(workspace, 'new.txt'), 'new');
  const originalUpload = api.uploadFile.bind(api);
  api.uploadFile = async (item, source) => {
    const uploaded = await originalUpload(item, source);
    if (item.appProperties.role === 'object' && item.appProperties.contentSha256 === createHash('sha256').update('new').digest('hex')) {
      existing.content = Buffer.from('changed remotely');
      existing.sha256Checksum = createHash('sha256').update(existing.content).digest('hex');
    }
    return uploaded;
  };

  await assert.rejects(repository.create(options), /failed verification/);
  assert.equal((await repository.list(provider, 'upload-race')).length, 1);
});

test('verifies a newly uploaded Drive object by stable ID when the next object listing is stale', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-stale-object-list-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'source.txt'), 'source');
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const originalListFiles = api.listFiles.bind(api);
  let objectLists = 0;
  api.listFiles = async (properties = {}) => {
    const result = await originalListFiles(properties);
    if (properties.role !== 'object') return result;
    objectLists += 1;
    return objectLists === 2 ? [] : result;
  };
  const provider = await GoogleDriveProvider.connect(api);

  const manifest = await new SnapshotRepository().create({
    provider,
    projectId: 'stale-drive-list',
    projectName: 'Stale Drive List',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Stale list regression',
    git: { dirty: true },
  });

  assert.equal(manifest.files.length, 1);
  assert.equal(api.calls.filter((call) => call === 'hashFile').length, 1);
  assert.deepEqual((await provider.list('SoloSync/stale-drive-list/snapshots')).map((item) => item.name), [manifest.snapshotId]);
});

test('repairs identical corrupt duplicate objects before publishing', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-duplicate-repair-'));
  const workspace = path.join(temp, 'workspace');
  const pending = path.join(temp, 'pending');
  const source = path.join(workspace, 'repair.txt');
  const contents = Buffer.from('correct contents');
  const sha256 = createHash('sha256').update(contents).digest('hex');
  await mkdir(workspace);
  await writeFile(source, contents);
  t.after(() => removeTreePrecisely(temp));
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  await provider.createDirectory('SoloSync/duplicate-repair/objects');
  const project = [...api.items.values()].find((item) => item.appProperties.role === 'project' && item.appProperties.projectId === 'duplicate-repair');
  const key = `SoloSync/duplicate-repair/objects/${sha256}`;
  const logicalKeyHash = createHash('sha256').update(key).digest('hex');
  const metadata = { product: 'solosync', role: 'object', format: '1', projectId: 'duplicate-repair', logicalKeyHash };
  await api.uploadFile({ id: 'corrupt-a', name: sha256, parents: [project.id], appProperties: metadata }, Buffer.from('same corruption'));
  await api.uploadFile({ id: 'corrupt-b', name: sha256, parents: [project.id], appProperties: metadata }, Buffer.from('same corruption'));

  const manifest = await new SnapshotRepository().create({
    provider,
    projectId: 'duplicate-repair',
    projectName: 'Duplicate Repair',
    roots: [{ name: 'workspace', path: workspace }],
    excludes: [],
    reviewedSensitivePaths: [],
    pendingDirectory: pending,
    pendingDestinationIdentity: provider.destinationIdentity,
    reason: 'Repair duplicates',
    git: { dirty: true },
  });

  const objects = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'object');
  assert.equal(objects.length, 1);
  assert.equal(objects[0].sha256Checksum, manifest.files[0].sha256);
  assert.equal(objects[0].name, `repair.${sha256.slice(0, 8)}.txt`);
});

test('keeps legacy snapshot folders readable without physical staging or snapshots containers', async () => {
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const project = 'project-1';
  const snapshot = 'snapshot-1';
  await provider.createDirectory(`SoloSync/${project}/staging`);
  await provider.createDirectory(`SoloSync/${project}/snapshots`);
  const projectFolder = [...api.items.values()].find((item) => item.appProperties.role === 'project' && item.appProperties.projectId === project);
  await api.createFolder({
    id: 'legacy-snapshot',
    name: snapshot,
    parents: [projectFolder.id],
    appProperties: { product: 'solosync', role: 'snapshot', format: '1', projectId: project, snapshotId: snapshot, lifecycle: 'staging' },
  });
  await provider.createDirectory(`SoloSync/${project}/staging/${snapshot}/files/project/src`);
  await provider.writeFile(`SoloSync/${project}/staging/${snapshot}/manifest.json`, Buffer.from(JSON.stringify({ projectName: 'Example Project' })));
  await provider.writeFile(`SoloSync/${project}/staging/${snapshot}/files/project/src/index.js`, Buffer.from('export {}\n'));

  assert.deepEqual(await provider.list(`SoloSync/${project}/staging`), [{ name: snapshot, type: 'directory' }]);
  assert.deepEqual([...api.items.values()].filter((item) => ['staging', 'snapshots'].includes(item.name)), []);
  assert.deepEqual([...api.items.values()].filter((item) => item.mimeType !== 'application/vnd.google-apps.folder' && item.parents.includes('root')), []);
  await provider.move(`SoloSync/${project}/staging/${snapshot}`, `SoloSync/${project}/snapshots/${snapshot}`);
  assert.deepEqual(await provider.list(`SoloSync/${project}/staging`), []);
  assert.deepEqual(await provider.list(`SoloSync/${project}/snapshots`), [{ name: snapshot, type: 'directory' }]);
  assert.equal((await provider.readFile(`SoloSync/${project}/snapshots/${snapshot}/files/project/src/index.js`)).toString(), 'export {}\n');

  const destination = path.join(await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-restore-')), 'index.js');
  await provider.downloadFile(`SoloSync/${project}/snapshots/${snapshot}/files/project/src/index.js`, destination);
  assert.equal(await readFile(destination, 'utf8'), 'export {}\n');
  assert.deepEqual((await provider.list('SoloSync')).map((entry) => entry.name), [project]);
});

test('reconciles projects and snapshots created concurrently under duplicate roots', async () => {
  const api = new MemoryDriveApi();
  const rootA = await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const rootB = await api.createFolder({ id: 'root-b', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const projectA = await api.createFolder({ id: 'project-a', name: 'Project', parents: [rootA.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  const projectB = await api.createFolder({ id: 'project-b', name: 'Project', parents: [rootB.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  await api.createFolder({ id: 'snapshot-a', name: 'snapshot-a', parents: [projectA.id], appProperties: { product: 'solosync', role: 'snapshot', format: '1', projectId: 'shared', snapshotId: 'snapshot-a', lifecycle: 'committed' } });
  await api.createFolder({ id: 'snapshot-b', name: 'snapshot-b', parents: [projectB.id], appProperties: { product: 'solosync', role: 'snapshot', format: '1', projectId: 'shared', snapshotId: 'snapshot-b', lifecycle: 'committed' } });

  const provider = await GoogleDriveProvider.connect(api);

  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['snapshot-a', 'snapshot-b']);
  assert.equal(api.items.get('project-b').trashed, false);
  assert.deepEqual(api.items.get('project-b').parents, ['root-b']);
  assert.equal(api.items.get('project-b').appProperties.role, 'merged-project');
  assert.equal(api.items.get('root-b').trashed, false);
  assert.deepEqual(api.items.get('root-b').parents, ['root']);
  assert.equal(api.items.get('root-b').appProperties.role, 'merged-root');
});

test('moves compact history records out of a duplicate backup root before archiving it', async () => {
  const api = new MemoryDriveApi();
  const rootA = await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const rootB = await api.createFolder({ id: 'root-b', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  await api.createFolder({ id: 'project-b', name: 'Shared', parents: [rootB.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  const historyB = await api.createFolder({ id: 'history-b', name: 'Backup History', parents: [rootB.id], appProperties: { product: 'solosync', role: 'history', format: '2' } });
  const record = await api.uploadFile({
    id: 'record-b',
    name: 'snapshot-b.json',
    parents: [historyB.id],
    appProperties: { product: 'solosync', role: 'snapshot', format: '2', projectId: 'shared', snapshotId: 'snapshot-b', lifecycle: 'committed' },
  }, Buffer.from('{}'));

  const provider = await GoogleDriveProvider.connect(api);

  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['snapshot-b']);
  assert.deepEqual(api.items.get('history-b').parents, [rootA.id]);
  assert.deepEqual(record.parents, ['history-b']);
  assert.equal(api.items.get('root-b').appProperties.role, 'merged-root');
});

test('recovers a late history record written into folders that were already merged', async () => {
  const api = new MemoryDriveApi();
  const rootA = await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const rootB = await api.createFolder({ id: 'root-b', name: 'Recovered from duplicate SoloSync setup', parents: ['root'], appProperties: { product: 'solosync', role: 'merged-root', format: '1' } });
  await api.createFolder({ id: 'project-a', name: 'Shared', parents: [rootA.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  await api.createFolder({ id: 'history-a', name: 'Backup History', parents: [rootA.id], appProperties: { product: 'solosync', role: 'history', format: '2' } });
  const historyB = await api.createFolder({ id: 'history-b', name: 'Recovered from duplicate SoloSync setup', parents: [rootB.id], appProperties: { product: 'solosync', role: 'merged-history', format: '2' } });
  const record = await api.uploadFile({
    id: 'late-record',
    name: 'late-snapshot.json',
    parents: [historyB.id],
    appProperties: { product: 'solosync', role: 'snapshot', format: '2', projectId: 'shared', snapshotId: 'late-snapshot', lifecycle: 'committed' },
  }, Buffer.from('{}'));

  const provider = await GoogleDriveProvider.connect(api);

  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['late-snapshot']);
  assert.deepEqual(record.parents, ['history-a']);
  assert.equal(historyB.appProperties.role, 'merged-history');
});

test('recovers a late legacy snapshot written into a project that was already merged', async () => {
  const api = new MemoryDriveApi();
  const root = await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const projectA = await api.createFolder({ id: 'project-a', name: 'Shared', parents: [root.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  const projectB = await api.createFolder({ id: 'project-b', name: 'Recovered from duplicate SoloSync setup', parents: [root.id], appProperties: { product: 'solosync', role: 'merged-project', format: '1', projectId: 'shared' } });
  const snapshot = await api.createFolder({ id: 'late-snapshot', name: 'late-snapshot', parents: [projectB.id], appProperties: { product: 'solosync', role: 'snapshot', format: '1', projectId: 'shared', snapshotId: 'late-snapshot', lifecycle: 'committed' } });

  const provider = await GoogleDriveProvider.connect(api);

  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['late-snapshot']);
  assert.deepEqual(snapshot.parents, [projectA.id]);
  assert.equal(projectB.appProperties.role, 'merged-project');
});

test('keeps the committed compact record when duplicate histories contain the same staged contents', async () => {
  const api = new MemoryDriveApi();
  const rootA = await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const rootB = await api.createFolder({ id: 'root-b', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  await api.createFolder({ id: 'project-a', name: 'Shared', parents: [rootA.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  const historyA = await api.createFolder({ id: 'history-a', name: 'Backup History', parents: [rootA.id], appProperties: { product: 'solosync', role: 'history', format: '2' } });
  const historyB = await api.createFolder({ id: 'history-b', name: 'Backup History', parents: [rootB.id], appProperties: { product: 'solosync', role: 'history', format: '2' } });
  const metadata = { product: 'solosync', role: 'snapshot', format: '2', projectId: 'shared', snapshotId: 'same-snapshot' };
  const staged = await api.uploadFile({ id: 'record-staged', name: 'same-snapshot.json', parents: [historyA.id], appProperties: { ...metadata, lifecycle: 'staging' } }, Buffer.from('{}'));
  const committed = await api.uploadFile({ id: 'record-committed', name: 'same-snapshot.json', parents: [historyB.id], appProperties: { ...metadata, lifecycle: 'committed' } }, Buffer.from('{}'));

  const provider = await GoogleDriveProvider.connect(api);

  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['same-snapshot']);
  assert.equal(staged.trashed, true);
  assert.equal(committed.trashed, false);
  assert.deepEqual(committed.parents, ['history-a']);
});

test('reuses the reserved Drive file ID after an interrupted upload', async () => {
  const api = new MemoryDriveApi();
  const originalUpload = api.uploadFile.bind(api);
  const attemptedIds = [];
  let fail = true;
  api.uploadFile = async (item, source) => {
    attemptedIds.push(item.id);
    if (fail) {
      fail = false;
      throw new Error('connection lost');
    }
    return originalUpload(item, source);
  };
  const ids = new Map();
  const provider = await GoogleDriveProvider.connect(api, {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  });
  const key = 'SoloSync/project/staging/snapshot/files/project/file.txt';

  await assert.rejects(provider.writeFile(key, Buffer.from('data')), /connection lost/);
  await provider.writeFile(key, Buffer.from('data'));

  assert.equal(attemptedIds.length, 2);
  assert.equal(attemptedIds[0], attemptedIds[1]);
  assert.equal([...ids.keys()].filter((key) => key.startsWith('google-drive-root-id:')).length, 1);
});

test('reuses and clears the compact snapshot record ID across a lost upload response', async () => {
  const api = new MemoryDriveApi();
  const ids = new Map();
  const stableIds = {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  };
  const provider = await GoogleDriveProvider.connect(api, stableIds);
  const staging = 'SoloSync/compact-resume/staging/snapshot';
  const committed = 'SoloSync/compact-resume/snapshots/snapshot';
  const key = `${staging}/manifest.json`;
  await provider.createDirectory(staging);
  const originalUpload = api.uploadFile.bind(api);
  const attemptedIds = [];
  let loseResponse = true;
  api.uploadFile = async (item, source) => {
    attemptedIds.push(item.id);
    const uploaded = await originalUpload(item, source);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('upload response lost');
    }
    return uploaded;
  };

  await assert.rejects(provider.writeFile(key, Buffer.from('{}')), /upload response lost/);
  await provider.writeFile(key, Buffer.from('{}'));
  await provider.move(staging, committed);

  assert.deepEqual(attemptedIds.length, 2);
  assert.equal(attemptedIds[0], attemptedIds[1]);
  assert.equal([...ids.keys()].filter((stored) => stored.startsWith('google-drive-file-id:compact-resume:')).length, 0);
  assert.equal((await provider.readFile(`${committed}/manifest.json`)).toString(), '{}');
});

test('canceling a compact snapshot removes its record and reserved ID', async () => {
  const api = new MemoryDriveApi();
  const ids = new Map();
  const provider = await GoogleDriveProvider.connect(api, {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  });
  const staging = 'SoloSync/compact-cancel/staging/snapshot';
  await provider.createDirectory(staging);
  await provider.writeFile(`${staging}/manifest.json`, Buffer.from('{}'));

  await provider.delete(staging);

  assert.equal([...ids.keys()].filter((stored) => stored.startsWith('google-drive-file-id:compact-cancel:')).length, 0);
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.appProperties.projectId === 'compact-cancel' && item.appProperties.role === 'snapshot').length, 0);
});

test('reuses an already uploaded logical file after reconnecting', async () => {
  const api = new MemoryDriveApi();
  const key = 'SoloSync/project/staging/snapshot/manifest.json';
  const first = await GoogleDriveProvider.connect(api);
  await first.writeFile(key, Buffer.from('{"same":true}'));

  const second = await GoogleDriveProvider.connect(api);
  await second.writeFile(key, Buffer.from('{"same":true}'));

  const logicalFiles = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'snapshot' && item.appProperties.snapshotId === 'snapshot');
  assert.equal(logicalFiles.length, 1);
});

test('reconciles a committed snapshot when the move response is lost in the cached provider', async () => {
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const staging = 'SoloSync/project/staging/snapshot';
  const committed = 'SoloSync/project/snapshots/snapshot';
  await provider.createDirectory(staging);
  await provider.writeFile(`${staging}/manifest.json`, Buffer.from('{}'));
  const originalUpdate = api.update.bind(api);
  let loseMoveResponse = true;
  api.update = async (id, patch) => {
    const updated = await originalUpdate(id, patch);
    if (loseMoveResponse && patch.appProperties?.lifecycle === 'committed') {
      loseMoveResponse = false;
      throw new Error('move response lost');
    }
    return updated;
  };

  await provider.move(staging, committed);

  assert.equal(await provider.exists(committed), true);
  assert.equal(await provider.exists(staging), false);
  assert.equal((await provider.readFile(`${committed}/manifest.json`)).toString(), '{}');
});

test('concurrent first backups converge on one project and one history folder', async () => {
  const api = new MemoryDriveApi();
  const first = await GoogleDriveProvider.connect(api);
  const second = await GoogleDriveProvider.connect(api);
  const originalListChildren = api.listChildren.bind(api);
  let projectLists = 0;
  let releaseLists;
  const bothListed = new Promise((resolve) => { releaseLists = resolve; });
  api.listChildren = async (parentId, properties = {}) => {
    if (properties.role === 'project' && properties.projectId === 'shared' && projectLists < 2) {
      projectLists += 1;
      const result = await originalListChildren(parentId, properties);
      if (projectLists === 2) releaseLists();
      await bothListed;
      return result;
    }
    return originalListChildren(parentId, properties);
  };

  await Promise.all([
    first.writeFile('SoloSync/shared/staging/snapshot-a/manifest.json', Buffer.from('{"snapshot":"a"}')),
    second.writeFile('SoloSync/shared/staging/snapshot-b/manifest.json', Buffer.from('{"snapshot":"b"}')),
  ]);

  const projects = [...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'project' && item.appProperties.projectId === 'shared');
  assert.equal(projects.length, 1);
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'history').length, 1);
  const snapshots = await first.list('SoloSync/shared/staging');
  assert.deepEqual(snapshots.map((item) => item.name), ['snapshot-a', 'snapshot-b']);
});

test('concurrent first connections converge on one backup root', async () => {
  const api = new MemoryDriveApi();
  const originalListFolders = api.listFolders.bind(api);
  let rootLists = 0;
  let releaseLists;
  const bothListed = new Promise((resolve) => { releaseLists = resolve; });
  api.listFolders = async (properties = {}) => {
    if (properties.role === 'root' && rootLists < 2) {
      rootLists += 1;
      const result = await originalListFolders(properties);
      if (rootLists === 2) releaseLists();
      await bothListed;
      return result;
    }
    return originalListFolders(properties);
  };

  const [first, second] = await Promise.all([
    GoogleDriveProvider.connect(api),
    GoogleDriveProvider.connect(api),
  ]);

  assert.equal(first.rootId, second.rootId);
  assert.equal([...api.items.values()].filter((item) => !item.trashed && item.appProperties.role === 'root').length, 1);
});

test('reconnects to the same visible backup root after the user moves it', async () => {
  const api = new MemoryDriveApi();
  const ids = new Map();
  const stableIds = {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  };
  const first = await GoogleDriveProvider.connect(api, stableIds);
  api.items.get(first.rootId).parents = ['another-folder'];

  const second = await GoogleDriveProvider.connect(api, stableIds);

  assert.equal(second.rootId, first.rootId);
  assert.equal([...api.items.values()].filter((item) => item.appProperties.role === 'root').length, 1);
});

test('chooses the same canonical root even when this installation saved a duplicate root', async () => {
  const api = new MemoryDriveApi();
  await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  await api.createFolder({ id: 'root-b', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const ids = new Map();
  const accountHash = createHash('sha256').update('permission-user-a').digest('hex');
  ids.set(`google-drive-root-id:${accountHash}`, 'root-b');

  const provider = await GoogleDriveProvider.connect(api, {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  });

  assert.equal(provider.rootId, 'root-a');
  assert.equal(api.items.get('root-a').appProperties.role, 'root');
  assert.equal(api.items.get('root-b').appProperties.role, 'merged-root');
});

test('uploads a project file named project.json instead of mistaking it for internal metadata', async () => {
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const key = 'SoloSync/project/staging/snapshot/files/project/project.json';
  await provider.writeFile(key, Buffer.from('{"user":true}'));
  assert.equal((await provider.readFile(key)).toString(), '{"user":true}');
});

test('reconciles a folder creation whose success response was lost', async () => {
  const api = new MemoryDriveApi();
  const originalCreate = api.createFolder.bind(api);
  let loseResponse = true;
  api.createFolder = async (item) => {
    const created = await originalCreate(item);
    if (loseResponse) {
      loseResponse = false;
      throw new Error('connection lost after commit');
    }
    return created;
  };

  const provider = await GoogleDriveProvider.connect(api, {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  });

  assert.equal((await api.get(provider.rootId)).name, 'SoloSync Backups');
});

test('keeps a separate moved backup root for each Google account', async () => {
  const ids = new Map();
  const stableIds = {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  };
  const accountA = new MemoryDriveApi();
  const accountB = new MemoryDriveApi();
  accountB.sequence = 100;
  accountB.about = async () => ({ user: { permissionId: 'permission-user-b', emailAddress: 'other@example.com' } });
  const firstA = await GoogleDriveProvider.connect(accountA, stableIds);
  accountA.items.get(firstA.rootId).parents = ['moved'];
  const firstB = await GoogleDriveProvider.connect(accountB, stableIds);
  const secondA = await GoogleDriveProvider.connect(accountA, stableIds);

  assert.equal(secondA.rootId, firstA.rootId);
  assert.notEqual(firstB.rootId, firstA.rootId);
  assert.equal([...ids.keys()].filter((key) => key.startsWith('google-drive-root-id:')).length, 2);
});

test('refuses to identify a Google account by a non-unique display name', async () => {
  const api = new MemoryDriveApi();
  api.about = async () => ({ user: { displayName: 'Shared Name' } });
  await assert.rejects(GoogleDriveProvider.connect(api), /stable account identity/);
});

test('passes cancellation through the Google Drive connection metadata calls', async () => {
  const api = new MemoryDriveApi();
  const controller = new AbortController();
  let observedSignal;
  api.listFolders = async (_properties, signal) => {
    observedSignal = signal;
    throw new Error('canceled connection');
  };
  await assert.rejects(GoogleDriveProvider.connect(api, undefined, controller.signal), /canceled connection/);
  assert.equal(observedSignal, controller.signal);
});

test('finds a moved backup root without relying on this installation local index', async () => {
  const api = new MemoryDriveApi();
  const ids = new Map();
  const stableIds = {
    get: async (key) => ids.get(key),
    store: async (key, value) => ids.set(key, value),
    delete: async (key) => ids.delete(key),
  };
  const first = await GoogleDriveProvider.connect(api, stableIds);
  const outer = await api.createFolder({ id: 'outer-root', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  api.items.get(first.rootId).parents = [outer.id];

  const connected = await GoogleDriveProvider.connect(api, {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
  });

  assert.equal(connected.rootId, first.rootId);
  assert.deepEqual(api.items.get(outer.id).parents, ['root']);
  assert.equal(api.items.get(outer.id).appProperties.role, 'merged-root');
  assert.deepEqual(api.items.get(first.rootId).parents, [outer.id]);
});

test('moves only known snapshots when a duplicate root contains the only project copy', async () => {
  const api = new MemoryDriveApi();
  const rootA = await api.createFolder({ id: 'root-a', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const rootB = await api.createFolder({ id: 'root-b', name: 'SoloSync Backups', parents: ['root'], appProperties: { product: 'solosync', role: 'root', format: '1' } });
  const projectB = await api.createFolder({ id: 'project-b', name: 'Project', parents: [rootB.id], appProperties: { product: 'solosync', role: 'project', format: '1', projectId: 'shared' } });
  const snapshot = await api.createFolder({ id: 'snapshot-b', name: 'snapshot-b', parents: [projectB.id], appProperties: { product: 'solosync', role: 'snapshot', format: '1', projectId: 'shared', snapshotId: 'snapshot-b', lifecycle: 'committed' } });
  const objectContent = Buffer.from('shared content');
  const objectHash = createHash('sha256').update(objectContent).digest('hex');
  const object = await api.uploadFile({ id: 'object-b', name: objectHash, parents: [projectB.id], appProperties: { product: 'solosync', role: 'object', format: '1', projectId: 'shared', logicalKeyHash: 'object-key' } }, objectContent);

  const provider = await GoogleDriveProvider.connect(api);
  const canonicalProject = [...api.items.values()].find((item) => item.parents.includes(rootA.id) && item.appProperties.role === 'project');

  assert.ok(canonicalProject);
  assert.deepEqual(projectB.parents, [rootB.id]);
  assert.equal(projectB.appProperties.role, 'merged-project');
  assert.deepEqual(snapshot.parents, [canonicalProject.id]);
  assert.deepEqual(object.parents, [canonicalProject.id]);
  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['snapshot-b']);
});
