const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createServer } = require('node:http');
const { createWriteStream } = require('node:fs');
const { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const test = require('node:test');
const { SnapshotCancelledError, SnapshotRepository } = require('../out/snapshotRepository.js');
const { normalizeQnapWebDavUrl, normalizeStorageKey, QnapWebDavProvider } = require('../out/storageProvider.js');

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function hrefFor(segments, directory) {
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `/dav${encoded ? `/${encoded}` : ''}${directory && encoded ? '/' : ''}`;
}

function md5(value) {
  return createHash('md5').update(value).digest('hex');
}

function digestFields(header) {
  return Object.fromEntries([...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map((match) => [match[1], match[2] ?? match[3]]));
}

async function startWebDavServer(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-webdav-'));
  const methods = [];
  const expectedAuthorization = `Basic ${Buffer.from('backup-user:secret').toString('base64')}`;
  const digestRealm = 'SoloSync Test';
  const digestNonce = 'solosync-test-nonce';

  function isAuthorized(request) {
    if (options.auth === 'digest') {
      if (!request.headers.authorization?.startsWith('Digest ')) return false;
      const fields = digestFields(request.headers.authorization);
      const expected = md5(`${md5(`backup-user:${digestRealm}:secret`)}:${digestNonce}:${fields.nc}:${fields.cnonce}:${fields.qop}:${md5(`${request.method}:${fields.uri}`)}`);
      return fields.username === 'backup-user' && fields.realm === digestRealm && fields.nonce === digestNonce && fields.response === expected;
    }
    return request.headers.authorization === expectedAuthorization;
  }

  function resolveRequestPath(rawUrl) {
    const url = new URL(rawUrl, 'http://127.0.0.1');
    if (url.pathname !== '/dav' && !url.pathname.startsWith('/dav/')) return undefined;
    const segments = url.pathname.slice('/dav'.length).split('/').filter(Boolean).map(decodeURIComponent);
    if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'))) return undefined;
    return { segments, target: path.join(root, ...segments) };
  }

  function send(response, statusCode, body = '') {
    response.statusCode = statusCode;
    response.end(body);
  }

  async function propResponse(segments, target) {
    const metadata = await stat(target);
    const directory = metadata.isDirectory();
    const displayName = segments.at(-1) ?? 'dav';
    return `<d:response><d:href>${escapeXml(hrefFor(segments, directory))}</d:href><d:propstat><d:prop><d:displayname>${escapeXml(displayName)}</d:displayname><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${directory ? 0 : metadata.size}</d:getcontentlength><d:getlastmodified>${metadata.mtime.toUTCString()}</d:getlastmodified><d:getetag>"${metadata.size}-${Math.trunc(metadata.mtimeMs)}"</d:getetag><d:getcontenttype>${directory ? 'httpd/unix-directory' : 'application/octet-stream'}</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  }

  const server = createServer(async (request, response) => {
    methods.push(request.method);
    if (!isAuthorized(request)) {
      response.setHeader('WWW-Authenticate', options.auth === 'digest'
        ? `Digest realm="${digestRealm}", nonce="${digestNonce}", algorithm=MD5, qop="auth"`
        : `Basic realm="${digestRealm}"`);
      send(response, 401);
      return;
    }
    const resolved = resolveRequestPath(request.url ?? '/');
    if (!resolved) {
      send(response, 400);
      return;
    }
    try {
      if (request.method === 'PROPFIND') {
        const metadata = await stat(resolved.target).catch(() => undefined);
        if (!metadata) {
          send(response, 404);
          return;
        }
        const resources = [{ segments: resolved.segments, target: resolved.target }];
        if (request.headers.depth !== '0' && metadata.isDirectory()) {
          for (const entry of await readdir(resolved.target)) {
            resources.push({ segments: [...resolved.segments, entry], target: path.join(resolved.target, entry) });
          }
        }
        const body = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${(await Promise.all(resources.map((resource) => propResponse(resource.segments, resource.target)))).join('')}</d:multistatus>`;
        response.setHeader('Content-Type', 'application/xml; charset=utf-8');
        send(response, 207, body);
        return;
      }
      if (request.method === 'MKCOL') {
        if (await stat(resolved.target).catch(() => undefined)) {
          send(response, 405);
          return;
        }
        await mkdir(resolved.target);
        send(response, 201);
        return;
      }
      if (request.method === 'PUT') {
        if (!(await stat(path.dirname(resolved.target)).catch(() => undefined))) {
          send(response, 409);
          return;
        }
        await pipeline(request, createWriteStream(resolved.target));
        send(response, 201);
        return;
      }
      if (request.method === 'GET') {
        const contents = await readFile(resolved.target).catch(() => undefined);
        if (!contents) {
          send(response, 404);
          return;
        }
        response.statusCode = 200;
        response.end(contents);
        return;
      }
      if (request.method === 'MOVE') {
        if (options.disableMove) {
          send(response, 405);
          return;
        }
        const destinationHeader = request.headers.destination;
        if (typeof destinationHeader !== 'string') {
          send(response, 400);
          return;
        }
        const destination = resolveRequestPath(destinationHeader);
        if (!destination) {
          send(response, 400);
          return;
        }
        if (request.headers.overwrite === 'F' && await stat(destination.target).catch(() => undefined)) {
          send(response, 412);
          return;
        }
        await rename(resolved.target, destination.target);
        send(response, 201);
        return;
      }
      if (request.method === 'DELETE') {
        if (resolved.segments.length === 0) {
          send(response, 403);
          return;
        }
        await rm(resolved.target, { recursive: true, force: true });
        send(response, 204);
        return;
      }
      send(response, 405);
    } catch (error) {
      response.statusCode = error && error.code === 'ENOENT' ? 404 : 500;
      response.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/dav`;
  return {
    baseUrl,
    methods,
    root,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createProvider(server, password = 'secret') {
  return QnapWebDavProvider.create({ baseUrl: server.baseUrl, username: 'backup-user' }, password, { allowInsecureHttp: true });
}

test('validates QNAP addresses and rejects storage path traversal', () => {
  assert.equal(normalizeQnapWebDavUrl('https://backup.example.com/Backups/'), 'https://backup.example.com/Backups');
  assert.throws(() => normalizeQnapWebDavUrl('http://backup.example.com/Backups'), /must use HTTPS/);
  assert.throws(() => normalizeQnapWebDavUrl('https://user:secret@backup.example.com/Backups'), /separately/);
  assert.throws(() => normalizeStorageKey('../outside'), /invalid/);
  assert.throws(() => normalizeStorageKey('safe/../../outside'), /invalid/);
  assert.throws(() => normalizeStorageKey('/absolute'), /invalid/);
});

test('tests every required WebDAV capability and removes its temporary directory', async () => {
  const server = await startWebDavServer();
  try {
    const provider = await createProvider(server);
    await provider.testConnection();
    assert.deepEqual(await provider.list('SoloSync'), []);
    for (const method of ['PROPFIND', 'MKCOL', 'PUT', 'GET', 'MOVE', 'DELETE']) assert.ok(server.methods.includes(method), method);
  } finally {
    await server.close();
  }
});

test('negotiates Digest authentication before uploading files', async () => {
  const server = await startWebDavServer({ auth: 'digest' });
  try {
    const provider = await createProvider(server);
    await provider.testConnection();
    assert.deepEqual(await provider.list('SoloSync'), []);
    assert.ok(server.methods.includes('PUT'));
  } finally {
    await server.close();
  }
});

test('rejects an endpoint without MOVE and cleans the connection test directory', async () => {
  const server = await startWebDavServer({ disableMove: true });
  try {
    const provider = await createProvider(server);
    await assert.rejects(provider.testConnection(), /does not support/);
    assert.deepEqual(await provider.list('SoloSync'), []);
  } finally {
    await server.close();
  }
});

test('reports QNAP authentication failure without exposing credentials', async () => {
  const server = await startWebDavServer();
  try {
    const provider = await createProvider(server, 'wrong-password');
    await assert.rejects(provider.validate(), (error) => {
      assert.match(error.message, /sign-in failed/);
      assert.doesNotMatch(error.message, /wrong-password|backup-user/);
      return true;
    });
  } finally {
    await server.close();
  }
});

test('creates, discovers, verifies, and restores a complete snapshot over WebDAV', async () => {
  const server = await startWebDavServer();
  const workspaceParent = await mkdtemp(path.join(os.tmpdir(), 'solosync-webdav-workspace-'));
  try {
    const workspace = path.join(workspaceParent, 'project');
    const restored = path.join(workspaceParent, 'restored');
    await mkdir(path.join(workspace, 'src'), { recursive: true });
    await writeFile(path.join(workspace, 'src', '你好.txt'), 'remote backup\n');
    await writeFile(path.join(workspace, 'empty.txt'), '');
    const provider = await createProvider(server);
    await provider.testConnection();
    const repository = new SnapshotRepository();
    const manifest = await repository.create({
      provider,
      projectId: 'remote-project-1',
      projectName: 'Remote Project',
      roots: [{ name: 'project', path: workspace }],
      excludes: [],
      reason: 'WebDAV test',
      git: { dirty: true },
    });

    assert.equal((await repository.list(provider, manifest.projectId)).length, 1);
    assert.deepEqual((await repository.listProjects(provider)).map((project) => project.projectName), ['Remote Project']);
    assert.deepEqual(await repository.verify(provider, manifest), { valid: true, checked: 2, errors: [] });
    assert.deepEqual(await provider.list(`SoloSync/${manifest.projectId}/staging`), []);

    await repository.restoreAll(provider, manifest, restored);
    assert.equal(await readFile(path.join(restored, 'project', 'src', '你好.txt'), 'utf8'), 'remote backup\n');
    assert.equal((await stat(path.join(restored, 'project', 'empty.txt'))).size, 0);
  } finally {
    await server.close();
    await rm(workspaceParent, { recursive: true, force: true });
  }
});

test('cancellation during WebDAV upload removes only the incomplete remote staging snapshot', async () => {
  const server = await startWebDavServer();
  const workspaceParent = await mkdtemp(path.join(os.tmpdir(), 'solosync-webdav-cancel-'));
  try {
    const workspace = path.join(workspaceParent, 'project');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'first.txt'), 'first');
    await writeFile(path.join(workspace, 'second.txt'), 'second');
    const provider = await createProvider(server);
    const originalWriteFile = provider.writeFile.bind(provider);
    const controller = new AbortController();
    provider.writeFile = async (key, source, signal) => {
      await originalWriteFile(key, source, signal);
      if (key.includes('/staging/')) controller.abort();
    };
    const repository = new SnapshotRepository();
    await assert.rejects(repository.create({
      provider,
      projectId: 'cancel-project',
      projectName: 'Cancel Project',
      roots: [{ name: 'project', path: workspace }],
      excludes: [],
      reason: 'Cancel test',
      git: { dirty: true },
      signal: controller.signal,
    }), SnapshotCancelledError);

    assert.deepEqual(await repository.list(provider, 'cancel-project'), []);
    assert.deepEqual(await provider.list('SoloSync/cancel-project/staging'), []);
  } finally {
    await server.close();
    await rm(workspaceParent, { recursive: true, force: true });
  }
});

test('remote verification failure never publishes a corrupt WebDAV snapshot', async () => {
  const server = await startWebDavServer();
  const workspaceParent = await mkdtemp(path.join(os.tmpdir(), 'solosync-webdav-corrupt-'));
  try {
    const workspace = path.join(workspaceParent, 'project');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'source.txt'), 'original');
    const provider = await createProvider(server);
    const originalReadFile = provider.readFile.bind(provider);
    provider.readFile = async (key, signal) => {
      const contents = await originalReadFile(key, signal);
      return key.endsWith('/files/project/source.txt') ? Buffer.from('corrupt') : contents;
    };
    const repository = new SnapshotRepository();
    await assert.rejects(repository.create({
      provider,
      projectId: 'corrupt-project',
      projectName: 'Corrupt Project',
      roots: [{ name: 'project', path: workspace }],
      excludes: [],
      reason: 'Corruption test',
      git: { dirty: true },
    }), /failed verification/);

    assert.deepEqual(await repository.list(provider, 'corrupt-project'), []);
    assert.deepEqual(await provider.list('SoloSync/corrupt-project/staging'), []);
  } finally {
    await server.close();
    await rm(workspaceParent, { recursive: true, force: true });
  }
});
