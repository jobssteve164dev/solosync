const assert = require('node:assert/strict');
const { mkdtemp, readFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { GoogleDriveProvider } = require('../out/googleDriveProvider.js');

class MemoryDriveApi {
  constructor() {
    this.sequence = 0;
    this.items = new Map();
  }

  async about() {
    return { user: { permissionId: 'permission-user-a', displayName: 'Solo User', emailAddress: 'solo@example.com' }, storageQuota: { limit: '1000000', usage: '100' } };
  }

  async generateId() { return `id-${++this.sequence}`; }

  async listChildren(parentId, properties = {}) {
    return [...this.items.values()].filter((item) => !item.trashed && item.parents.includes(parentId)
      && Object.entries(properties).every(([key, value]) => item.appProperties[key] === value));
  }

  async listFolders(properties = {}) {
    return [...this.items.values()].filter((item) => !item.trashed && item.mimeType === 'application/vnd.google-apps.folder'
      && Object.entries(properties).every(([key, value]) => item.appProperties[key] === value));
  }

  async createFolder(item) {
    if (this.items.has(item.id)) throw new Error('already exists');
    const created = { ...item, mimeType: 'application/vnd.google-apps.folder', size: undefined, content: undefined, createdTime: new Date(this.sequence * 1000).toISOString(), trashed: false };
    this.items.set(item.id, created);
    return created;
  }

  async uploadFile(item, source) {
    const content = Buffer.isBuffer(source) ? source : await readFile(source);
    const created = { ...item, mimeType: 'application/octet-stream', size: String(content.length), content, createdTime: new Date(this.sequence * 1000).toISOString(), trashed: false };
    this.items.set(item.id, created);
    return created;
  }

  async get(id) { return this.items.get(id); }

  async update(id, patch) {
    const item = this.items.get(id);
    if (!item) throw new Error('not found');
    Object.assign(item, patch);
    if (patch.addParent) item.parents = [patch.addParent];
    return item;
  }

  async readFile(id) { return Buffer.from(this.items.get(id).content); }

  async hashFile(id) { return createHash('sha256').update(this.items.get(id).content).digest('hex'); }

  async forgetUpload() {}

  async downloadFile(id, destination) {
    const { mkdir, writeFile } = require('node:fs/promises');
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, this.items.get(id).content);
  }

  async trash(id) { this.items.get(id).trashed = true; }
}

test('projects filesystem keys onto Drive without physical staging or snapshots folders', async () => {
  const api = new MemoryDriveApi();
  const provider = await GoogleDriveProvider.connect(api);
  const project = 'project-1';
  const snapshot = 'snapshot-1';
  await provider.createDirectory(`SoloSync/${project}/staging`);
  await provider.createDirectory(`SoloSync/${project}/snapshots`);
  await provider.createDirectory(`SoloSync/${project}/staging/${snapshot}/files/project/src`);
  await provider.writeFile(`SoloSync/${project}/staging/${snapshot}/manifest.json`, Buffer.from(JSON.stringify({ projectName: 'Example Project' })));
  await provider.writeFile(`SoloSync/${project}/staging/${snapshot}/files/project/src/index.js`, Buffer.from('export {}\n'));

  assert.deepEqual(await provider.list(`SoloSync/${project}/staging`), [{ name: snapshot, type: 'directory' }]);
  assert.deepEqual([...api.items.values()].filter((item) => ['staging', 'snapshots'].includes(item.name)), []);
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

  const provider = await GoogleDriveProvider.connect(api);
  const canonicalProject = [...api.items.values()].find((item) => item.parents.includes(rootA.id) && item.appProperties.role === 'project');

  assert.ok(canonicalProject);
  assert.deepEqual(projectB.parents, [rootB.id]);
  assert.equal(projectB.appProperties.role, 'merged-project');
  assert.deepEqual(snapshot.parents, [canonicalProject.id]);
  assert.deepEqual((await provider.list('SoloSync/shared/snapshots')).map((item) => item.name), ['snapshot-b']);
});
