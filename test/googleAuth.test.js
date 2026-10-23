const assert = require('node:assert/strict');
const test = require('node:test');
const { buildGoogleAuthorizationUrl } = require('../out/googleAuth.js');

test('builds a desktop OAuth request with drive.file, PKCE S256, and state', () => {
  const url = new URL(buildGoogleAuthorizationUrl({
    clientId: 'client.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:43123/oauth/callback',
    state: 'state-123',
    codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  }));

  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'client.apps.googleusercontent.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:43123/oauth/callback');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('exchanges an authorization code and refreshes without a client secret', async () => {
  const stored = new Map();
  const requests = [];
  const responses = [
    { access_token: 'access-1', expires_in: 1, refresh_token: 'refresh-1', token_type: 'Bearer' },
    { access_token: 'access-2', expires_in: 3600, token_type: 'Bearer' },
  ];
  const { GoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new GoogleTokenManager({
    clientId: 'client.apps.googleusercontent.com',
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => stored.set(key, value),
      delete: async (key) => stored.delete(key),
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: String(init.body) });
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    now: () => 1_000,
  });

  assert.equal(await manager.exchangeAuthorizationCode({ code: 'auth-code', codeVerifier: 'verifier', redirectUri: 'http://127.0.0.1/callback' }), 'access-1');
  assert.equal(stored.get('solosync.google.refreshToken'), 'refresh-1');
  assert.equal(await manager.accessToken(true), 'access-2');
  assert.match(requests[0].body, /grant_type=authorization_code/);
  assert.match(requests[0].body, /code_verifier=verifier/);
  assert.match(requests[1].body, /grant_type=refresh_token/);
  assert.doesNotMatch(requests.map((request) => request.body).join('\n'), /client_secret/);
});

test('completes desktop sign-in through a validated loopback callback', async () => {
  const stored = new Map();
  const { authorizeGoogleDesktop, GoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new GoogleTokenManager({
    clientId: 'client.apps.googleusercontent.com',
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => stored.set(key, value),
      delete: async (key) => stored.delete(key),
    },
    fetch: async () => new Response(JSON.stringify({ access_token: 'desktop-access', refresh_token: 'desktop-refresh', expires_in: 3600 }), { status: 200 }),
  });

  const accessToken = await authorizeGoogleDesktop({
    clientId: 'client.apps.googleusercontent.com',
    tokens: manager,
    timeoutMs: 2_000,
    openExternal: async (authorizationUrl) => {
      const url = new URL(authorizationUrl);
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      const state = url.searchParams.get('state');
      const rejected = await fetch(`${redirect}?code=wrong&state=not-${state}`);
      assert.equal(rejected.status, 400);
      const accepted = await fetch(`${redirect}?code=auth-code&state=${encodeURIComponent(state)}`);
      assert.equal(accepted.status, 200);
      return true;
    },
  });

  assert.equal(accessToken, 'desktop-access');
  assert.equal(stored.get('solosync.google.refreshToken'), 'desktop-refresh');
});

test('connects a browser workspace with a broker callback code and stores only the opaque credential', async () => {
  const stored = new Map();
  const requests = [];
  const { HostedGoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new HostedGoogleTokenManager({
    brokerUrl: 'https://solosync.szlk.uk',
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => stored.set(key, value),
      delete: async (key) => stored.delete(key),
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith('/start')) return Response.json({ authorizationUrl: 'https://accounts.google.com/auth', expiresAt: Date.now() + 60_000 });
      if (String(url).endsWith('/exchange')) return Response.json({ accessToken: 'hosted-access-1', expiresIn: 1, credential: 'opaque-credential-1' });
      if (String(url).endsWith('/token')) return Response.json({ accessToken: 'hosted-access-2', expiresIn: 3600, credential: 'opaque-credential-2' });
      if (String(url).endsWith('/revoke')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${url}`);
    },
    now: () => 1_000,
  });

  const accessToken = await manager.connect({
    openExternal: async (url) => url === 'https://accounts.google.com/auth',
    requestCallbackCode: async () => 'callback-code',
  });
  assert.equal(accessToken, 'hosted-access-1');
  assert.equal(stored.get('solosync.google.hostedCredential'), 'opaque-credential-1');
  assert.equal([...stored.values()].includes('refresh-token'), false);
  assert.match(requests[0].body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests[1].body.callbackCode, 'callback-code');
  assert.ok(requests[1].body.codeVerifier.length >= 43);

  assert.equal(await manager.accessToken(true), 'hosted-access-2');
  assert.equal(stored.get('solosync.google.hostedCredential'), 'opaque-credential-2');
  await manager.revoke();
  assert.equal(stored.has('solosync.google.hostedCredential'), false);
  assert.equal(requests.at(-1).body.credential, 'opaque-credential-2');
});

test('cancels hosted sign-in while waiting for the callback code', async () => {
  const controller = new AbortController();
  let exchangeCalled = false;
  const { HostedGoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new HostedGoogleTokenManager({
    brokerUrl: 'https://solosync.szlk.uk',
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (url, init) => {
      assert.equal(init.signal, controller.signal);
      if (String(url).endsWith('/start')) return Response.json({ authorizationUrl: 'https://accounts.google.com/auth' });
      exchangeCalled = true;
      return Response.json({});
    },
  });

  await assert.rejects(manager.connect({
    openExternal: async () => true,
    requestCallbackCode: async () => {
      setImmediate(() => controller.abort());
      return new Promise(() => {});
    },
  }, controller.signal), /canceled/);
  assert.equal(exchangeCalled, false);
});

test('passes cancellation to desktop token exchange', async () => {
  const controller = new AbortController();
  const { authorizeGoogleDesktop, GoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new GoogleTokenManager({
    clientId: 'client.apps.googleusercontent.com',
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    fetch: async (_url, init) => {
      assert.equal(init.signal, controller.signal);
      return Response.json({ access_token: 'desktop-access', refresh_token: 'desktop-refresh', expires_in: 3600 });
    },
  });

  assert.equal(await authorizeGoogleDesktop({
    clientId: 'client.apps.googleusercontent.com',
    tokens: manager,
    signal: controller.signal,
    timeoutMs: 2_000,
    openExternal: async (authorizationUrl) => {
      const url = new URL(authorizationUrl);
      const redirect = new URL(url.searchParams.get('redirect_uri'));
      const response = await fetch(`${redirect}?code=auth-code&state=${encodeURIComponent(url.searchParams.get('state'))}`);
      assert.equal(response.status, 200);
      return true;
    },
  }), 'desktop-access');
});

test('keeps the desktop credential when Google does not confirm revocation', async () => {
  const stored = new Map([['solosync.google.refreshToken', 'refresh-token']]);
  const { GoogleAuthenticationError, GoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new GoogleTokenManager({
    clientId: 'client.apps.googleusercontent.com',
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => stored.set(key, value),
      delete: async (key) => stored.delete(key),
    },
    fetch: async () => new Response(null, { status: 503 }),
  });

  await assert.rejects(manager.revoke(), GoogleAuthenticationError);
  assert.equal(stored.get('solosync.google.refreshToken'), 'refresh-token');
});

test('clears every credential-bearing upload session on disconnect', async () => {
  const deleted = [];
  const { clearGoogleUploadSessions } = require('../out/googleAuth.js');
  await clearGoogleUploadSessions(['google-drive-upload:a:1', 'google-drive-upload:b:2'], {
    get: async () => undefined,
    store: async () => {},
    delete: async (key) => deleted.push(key),
  });
  assert.deepEqual(deleted, ['solosync.google-drive-upload:a:1', 'solosync.google-drive-upload:b:2']);
});

test('marks hosted Google Drive authorization as needing sign-in when Google invalidates it', async () => {
  const stored = new Map([['solosync.google.hostedCredential', 'expired-credential']]);
  let authenticationRequired = 0;
  const { HostedGoogleTokenManager } = require('../out/googleAuth.js');
  const manager = new HostedGoogleTokenManager({
    brokerUrl: 'https://solosync.szlk.uk',
    secrets: {
      get: async (key) => stored.get(key),
      store: async (key, value) => stored.set(key, value),
      delete: async (key) => stored.delete(key),
    },
    fetch: async () => Response.json({ error: 'Sign in again.', code: 'invalid_grant' }, { status: 401 }),
    onAuthenticationRequired: async () => { authenticationRequired += 1; },
  });

  await assert.rejects(manager.accessToken(), /Sign in again/);
  assert.equal(stored.has('solosync.google.hostedCredential'), false);
  assert.equal(authenticationRequired, 1);
});

test('reuses one token manager for each extension context and authorization mode', () => {
  const { GoogleTokenManagerCache } = require('../out/googleAuth.js');
  const cache = new GoogleTokenManagerCache();
  const context = {};
  const desktop = cache.get(context, 'desktop', () => ({ id: 'desktop' }));

  assert.equal(cache.get(context, 'desktop', () => ({ id: 'replacement' })), desktop);
  assert.notEqual(cache.get(context, 'hosted', () => ({ id: 'hosted' })), desktop);
  assert.notEqual(cache.get({}, 'desktop', () => ({ id: 'other-context' })), desktop);
});
