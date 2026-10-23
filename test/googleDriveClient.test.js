const assert = require('node:assert/strict');
const test = require('node:test');
const { GoogleDriveClient } = require('../out/googleDriveClient.js');

test('requests the stable Google permission ID for account identity', async () => {
  let requested;
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (input) => {
      requested = new URL(String(input));
      return Response.json({ user: { permissionId: 'permission-user-a' } });
    },
  });

  assert.equal((await client.about()).user.permissionId, 'permission-user-a');
  assert.match(requested.searchParams.get('fields'), /permissionId/);
  assert.doesNotMatch(requested.searchParams.get('fields'), /storageQuota/);
});

test('lists all Drive pages with an authenticated app-property query', async () => {
  const requests = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, authorization: init.headers.authorization });
      const page = url.searchParams.get('pageToken');
      return new Response(JSON.stringify(page ? {
        files: [{ id: 'two', name: 'Two', mimeType: 'application/octet-stream', parents: ['parent'], appProperties: { product: 'solosync' } }],
      } : {
        nextPageToken: 'next',
        files: [{ id: 'one', name: 'One', mimeType: 'application/octet-stream', parents: ['parent'], appProperties: { product: 'solosync' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  const files = await client.listChildren('parent', { product: 'solosync', projectId: "project'1" });
  assert.deepEqual(files.map((file) => file.id), ['one', 'two']);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].authorization, 'Bearer access-token');
  assert.match(requests[0].url.searchParams.get('q'), /'parent' in parents/);
  assert.match(requests[0].url.searchParams.get('q'), /project\\'1/);
  assert.match(requests[0].url.searchParams.get('fields'), /sha256Checksum/);
});

test('reserves Drive IDs in one batch for consecutive creates', async () => {
  const requests = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (input) => {
      requests.push(new URL(String(input)));
      return Response.json({ ids: Array.from({ length: 100 }, (_, index) => `id-${index + 1}`) });
    },
  });

  assert.deepEqual(await Promise.all([client.generateId(), client.generateId(), client.generateId()]), ['id-1', 'id-2', 'id-3']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get('count'), '100');
});

test('continues with another Drive ID batch when concurrent creates exhaust the first one', async () => {
  let requestCount = 0;
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async () => {
      requestCount += 1;
      return Response.json({ ids: Array.from({ length: 100 }, (_, index) => `batch-${requestCount}-id-${index + 1}`) });
    },
  });

  const ids = await Promise.all(Array.from({ length: 101 }, () => client.generateId()));

  assert.equal(new Set(ids).size, 101);
  assert.equal(requestCount, 2);
});

test('uploads a small file and its metadata in one multipart request', async () => {
  const requests = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: init.headers, body: Buffer.from(init.body) });
      return Response.json({
        id: 'small-file', name: 'small.txt', mimeType: 'application/octet-stream', parents: ['parent'],
        appProperties: { product: 'solosync', projectId: 'project-1' }, size: '5',
      });
    },
  });

  const uploaded = await client.uploadFile({
    id: 'small-file', name: 'small.txt', parents: ['parent'], appProperties: { product: 'solosync', projectId: 'project-1' },
  }, Buffer.from('small'));

  assert.equal(uploaded.id, 'small-file');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /uploadType=multipart/);
  assert.match(requests[0].headers['content-type'], /^multipart\/related; boundary=/);
  assert.match(requests[0].body.toString('utf8'), /"parents":\["parent"\]/);
  assert.ok(requests[0].body.includes(Buffer.from('small')));
});

test('uploads resumable chunks and removes the credential-bearing session URI', async () => {
  const sessions = new Map();
  const storedSessionKeys = [];
  const puts = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: {
      get: async (key) => sessions.get(key),
      store: async (key, value) => { storedSessionKeys.push(key); sessions.set(key, value); },
      delete: async (key) => sessions.delete(key),
    },
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes('uploadType=resumable')) {
        return new Response(null, { status: 200, headers: { location: 'https://upload.example/session-1' } });
      }
      if (url === 'https://upload.example/session-1') {
        puts.push({ range: init.headers['content-range'], length: Buffer.from(await new Response(init.body).arrayBuffer()).length });
        const acknowledged = puts.reduce((total, put) => total + put.length, 0);
        if (acknowledged < 18 * 1024 * 1024) return new Response(null, { status: 308, headers: { range: `bytes=0-${acknowledged - 1}` } });
        return new Response(JSON.stringify({ id: 'file-1', name: 'large.bin', mimeType: 'application/octet-stream', parents: ['parent'], appProperties: { product: 'solosync' }, size: String(18 * 1024 * 1024) }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const content = Buffer.alloc(18 * 1024 * 1024, 7);

  const result = await client.uploadFile({ id: 'file-1', name: 'large.bin', parents: ['parent'], appProperties: { product: 'solosync', projectId: 'project-1' } }, content);

  assert.equal(result.id, 'file-1');
  assert.equal(puts.length, 3);
  assert.deepEqual(puts[0], { range: 'bytes 0-8388607/18874368', length: 8388608 });
  assert.deepEqual(puts.at(-1), { range: 'bytes 16777216-18874367/18874368', length: 2097152 });
  assert.equal(sessions.size, 0);
  assert.deepEqual(storedSessionKeys, ['google-drive-upload:project-1:file-1']);
});

test('asks Drive for the acknowledged offset before resuming a saved upload session', async () => {
  const sessions = new Map([['google-drive-upload:project-1:file-1', 'https://upload.example/session-saved']]);
  const ranges = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: {
      get: async (key) => sessions.get(key),
      store: async (key, value) => sessions.set(key, value),
      delete: async (key) => sessions.delete(key),
    },
    fetch: async (input, init) => {
      assert.equal(String(input), 'https://upload.example/session-saved');
      ranges.push(init.headers['content-range']);
      if (ranges.length === 1) return new Response(null, { status: 308, headers: { range: 'bytes=0-262143' } });
      return new Response(JSON.stringify({ id: 'file-1', name: 'large.bin', mimeType: 'application/octet-stream', parents: ['parent'], appProperties: {}, size: '524288' }), { status: 200 });
    },
  });

  await client.uploadFile({ id: 'file-1', name: 'large.bin', parents: ['parent'], appProperties: { projectId: 'project-1' } }, Buffer.alloc(512 * 1024));

  assert.deepEqual(ranges, ['bytes */524288', 'bytes 262144-524287/524288']);
  assert.equal(sessions.size, 0);
});

test('recovers a completed file after its resumable session expires', async () => {
  const sessions = new Map([['google-drive-upload:project-1:file-1', 'https://upload.example/expired']]);
  let uploadStarts = 0;
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async (key) => sessions.get(key), store: async (key, value) => sessions.set(key, value), delete: async (key) => sessions.delete(key) },
    fetch: async (input) => {
      const url = String(input);
      if (url === 'https://upload.example/expired') return new Response(null, { status: 410 });
      if (url.includes('/drive/v3/files/file-1')) return Response.json({ id: 'file-1', name: 'file.bin', mimeType: 'application/octet-stream', parents: ['parent'], appProperties: { projectId: 'project-1' }, size: '4' });
      if (url.includes('uploadType=resumable')) uploadStarts += 1;
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const result = await client.uploadFile({ id: 'file-1', name: 'file.bin', parents: ['parent'], appProperties: { projectId: 'project-1' } }, Buffer.from('data'));
  assert.equal(result.id, 'file-1');
  assert.equal(uploadStarts, 0);
  assert.equal(sessions.size, 0);
});

test('does not reconcile an expired upload session with a non-identical Drive file', async () => {
  const mismatches = [
    { parents: ['parent', 'unexpected-parent'], appProperties: { projectId: 'project-1' }, trashed: false },
    { parents: ['parent'], appProperties: { projectId: 'project-1', unexpected: 'value' }, trashed: false },
    { parents: ['parent'], appProperties: { projectId: 'project-1' }, trashed: true },
  ];
  for (const mismatch of mismatches) {
    const sessions = new Map([['google-drive-upload:project-1:file-1', 'https://upload.example/expired']]);
    const client = new GoogleDriveClient({
      tokens: { accessToken: async () => 'access-token' },
      sessions: { get: async (key) => sessions.get(key), store: async (key, value) => sessions.set(key, value), delete: async (key) => sessions.delete(key) },
      fetch: async (input) => {
        const url = String(input);
        if (url === 'https://upload.example/expired') return new Response(null, { status: 410 });
        if (url.includes('/drive/v3/files/file-1')) return Response.json({
          id: 'file-1', name: 'file.bin', mimeType: 'application/octet-stream', size: '4', ...mismatch,
        });
        throw new Error(`Unexpected request: ${url}`);
      },
    });

    await assert.rejects(
      client.uploadFile({ id: 'file-1', name: 'file.bin', parents: ['parent'], appProperties: { projectId: 'project-1' } }, Buffer.from('data')),
      /different file/,
    );
    assert.equal(sessions.size, 1);
  }
});

test('stops after one resumable-session rebuild and preserves the latest session', async () => {
  const sessions = new Map([['google-drive-upload:project-1:file-1', 'https://upload.example/expired-1']]);
  let uploadStarts = 0;
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async (key) => sessions.get(key), store: async (key, value) => sessions.set(key, value), delete: async (key) => sessions.delete(key) },
    fetch: async (input) => {
      const url = String(input);
      if (url.includes('/drive/v3/files/file-1')) return new Response(null, { status: 404 });
      if (url.includes('uploadType=resumable')) {
        uploadStarts += 1;
        return new Response(null, { status: 200, headers: { location: 'https://upload.example/expired-2' } });
      }
      if (url.startsWith('https://upload.example/expired-')) return new Response(null, { status: 410 });
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  await assert.rejects(
    client.uploadFile({ id: 'file-1', name: 'file.bin', parents: ['parent'], appProperties: { projectId: 'project-1' } }, Buffer.from('data')),
    /expired repeatedly.*Continue the pending backup/,
  );
  assert.equal(uploadStarts, 1);
  assert.equal(sessions.get('google-drive-upload:project-1:file-1'), 'https://upload.example/expired-2');
});

test('rejects oversized metadata before buffering it', async () => {
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async () => new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 }),
  });
  await assert.rejects(client.readFile('manifest-id'), /1 MiB limit/);
});

test('uploads an empty file and validates the returned stable file identity', async () => {
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (input, init) => {
      assert.match(String(input), /uploadType=multipart/);
      assert.match(init.headers['content-type'], /^multipart\/related/);
      return new Response(JSON.stringify({ id: 'file-1', name: 'empty', mimeType: 'application/octet-stream', parents: ['parent'], appProperties: {}, size: '0' }), { status: 200 });
    },
  });

  const result = await client.uploadFile({ id: 'file-1', name: 'empty', parents: ['parent'], appProperties: {} }, Buffer.alloc(0));
  assert.equal(result.id, 'file-1');
});

test('trashes a Drive item with one metadata update', async () => {
  const requests = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init.method, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: 'file-1', trashed: true }), { status: 200 });
    },
  });

  await client.trash('file-1');

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { trashed: true });
});

test('retries Drive rate limits using Retry-After', async () => {
  let calls = 0;
  const delays = [];
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '2' } });
      return Response.json({ files: [] });
    },
  });

  assert.deepEqual(await client.listChildren('parent'), []);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test('passes cancellation to rate-limit waits', async () => {
  const controller = new AbortController();
  let observedSignal;
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    sleep: async (_milliseconds, signal) => { observedSignal = signal; throw new Error('canceled wait'); },
    fetch: async () => new Response('{}', { status: 429 }),
  });
  await assert.rejects(client.hashFile('file-1', controller.signal), /canceled wait/);
  assert.equal(observedSignal, controller.signal);
});

test('passes cancellation to metadata rate-limit waits', async () => {
  const controller = new AbortController();
  let observedSignal;
  const client = new GoogleDriveClient({
    tokens: { accessToken: async () => 'access-token' },
    sessions: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    sleep: async (_milliseconds, signal) => { observedSignal = signal; throw new Error('canceled metadata wait'); },
    fetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '60' } }),
  });

  await assert.rejects(client.listChildren('parent', {}, controller.signal), /canceled metadata wait/);
  assert.equal(observedSignal, controller.signal);
});
