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
  assert.ok(emptyRemoteCalls <= 21, `expected a new empty snapshot to use at most 21 Drive requests, received ${emptyRemoteCalls}: ${JSON.stringify(api.calls)}`);

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
  assert.ok(remoteCalls <= 8, `expected a changed small-file snapshot to use at most 8 Drive requests, received ${remoteCalls}: ${JSON.stringify(api.calls)}`);

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
  assert.equal(api.calls.filter((call) => call === 'uploadFile').length, 1, 'an unchanged snapshot should upload only its manifest');
  const repeatedRemoteCalls = api.calls.filter((call) => call !== 'forgetUpload').length;
  assert.ok(repeatedRemoteCalls <= 6, `expected an unchanged snapshot to use at most 6 Drive requests, received ${repeatedRemoteCalls}: ${JSON.stringify(api.calls)}`);
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

test('keeps the original file name and extension for visible Drive objects', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-drive-visible-name-'));
  const source = path.join(temp, 'project-notes.md');
  const contents = Buffer.from('# Notes\n');
  const sha256 = createHash('sha256').update(contents).digest('hex');
  await writeFile(source, contents);
  t.after(async () => {
    await unlink(source);
    await rmdir(temp);
  });
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);

  await provider.writeFile(`SoloSync/visible-name/objects/${sha256}`, source);

  const object = [...api.items.values()].find((item) => item.appProperties.role === 'object');
  assert.equal(object.name, 'project-notes.md');
  assert.equal(object.appProperties.contentSha256, sha256);
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

  assert.equal(legacy.name, 'release-notes.txt');
  assert.equal(api.calls.filter((call) => call === 'uploadFile').length, 1, 'only the manifest should be uploaded');
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
  assert.ok(remoteCalls <= 14, `expected reconnect plus one object listing and a fixed publish path to use at most 14 Drive requests, received ${remoteCalls}: ${JSON.stringify(api.calls)}`);
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
    if (item.appProperties.role === 'object' && item.name === 'new.txt') {
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
  const originalListChildren = api.listChildren.bind(api);
  let objectLists = 0;
  api.listChildren = async (parentId, properties = {}) => {
    const result = await originalListChildren(parentId, properties);
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
  assert.equal(objects[0].name, 'repair.txt');
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
