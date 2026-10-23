import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker from '../src/index.mjs';

const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');

function environment() {
  return {
    GOOGLE_WEB_CLIENT_ID: 'web-client.apps.googleusercontent.com',
    GOOGLE_WEB_CLIENT_SECRET: 'server-only-secret',
    OAUTH_SEALING_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: 'https://solosync.szlk.uk',
    ASSETS: {
      async fetch(request) {
        if (new URL(request.url).pathname !== '/icon.png') return new Response('Not found', { status: 404 });
        return new Response(await readFile(new URL('../../resources/icon.png', import.meta.url)), {
          headers: { 'content-type': 'image/png' },
        });
      },
    },
  };
}

function callbackCode(html) {
  const match = html.match(/data-callback-code="([^"]+)"/);
  assert.ok(match, 'callback page must contain the SoloSync callback code');
  return match[1];
}

test('deployment preserves dashboard-managed public OAuth variables', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(config.keep_vars, true);
});

test('serves the public SoloSync site and Google-ready legal pages', async () => {
  const pages = await Promise.all([
    worker.fetch(new Request('https://solosync.szlk.uk/'), environment()),
    worker.fetch(new Request('https://solosync.szlk.uk/privacy'), environment()),
    worker.fetch(new Request('https://solosync.szlk.uk/terms'), environment()),
  ]);

  for (const response of pages) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  }

  const home = await pages[0].text();
  assert.match(home, /SoloSync/);
  assert.match(home, /Back up what Git hasn.t protected yet/i);
  assert.match(home, /href="\/privacy"/);
  assert.match(home, /href="\/terms"/);
  assert.match(home, /href="\/icon\.png"/);
  assert.match(home, /Full snapshots restore into a new folder/);
  assert.match(home, /individual files go to the save location you choose/);
  assert.match(home, /A full restore never targets your current folder/);
  assert.match(home, /SoloSync is a VS Code extension for backing up and restoring project folders/);
  assert.match(home, /You do not need to sign in to view this website or learn how SoloSync works/);
  assert.match(home, /SoloSync requests sign-in only after you choose Google Drive in the extension/);
  assert.match(home, /Google sign-in is requested only when you choose Google Drive/);
  assert.match(home, /does not generate, edit, host, publish, or distribute AI-generated content or non-consensual intimate imagery/);

  const privacy = await pages[1].text();
  assert.match(privacy, /Google Drive/i);
  assert.match(privacy, /drive\.file/);
  assert.match(privacy, /accesses, uses, stores, and shares Google user data/i);
  assert.match(privacy, /Google API Services User Data Policy/i);
  assert.match(privacy, /Limited Use/i);
  assert.match(privacy, /complete sign-in, refresh access, and revoke the connection/i);
  assert.match(privacy, /does not retain a server-side database copy of OAuth credentials/i);
  assert.match(privacy, /Desktop VS Code stores the Google refresh token in VS Code Secret Storage/i);
  assert.match(privacy, /Browser-hosted and remote VS Code store only the encrypted opaque credential/i);
  assert.match(privacy, /standard network request data such as IP address, user agent, requested URL, and request time/i);
  assert.match(privacy, /does not use Google user data to train or improve generalized artificial intelligence or machine learning models/i);
  assert.match(privacy, /does not generate, edit, host, publish, or distribute AI-generated content or non-consensual intimate imagery/i);
  assert.match(privacy, /Google Drive backup files remain until you delete them/i);
  assert.match(privacy, /one-time authorization state and callback codes expire after 10 minutes/i);
  assert.match(privacy, /saved connection remains in VS Code Secret Storage until you disconnect it/i);
  assert.match(privacy, /Access tokens remain in memory only until they expire or the extension session ends/i);
  assert.match(privacy, /permission-restricted local frozen copy of the project files and snapshot manifest/i);
  assert.match(privacy, /retained after an interrupted upload until you resume or abandon that pending backup/i);
  assert.match(privacy, /pseudonymous account-to-root mapping/i);
  assert.match(privacy, /survives disconnect and revocation/i);

  const terms = await pages[2].text();
  assert.match(terms, /Terms of Service/i);
  assert.match(terms, /readable files/i);
});

test('serves the official icon and crawl instructions from the public origin', async () => {
  const icon = await worker.fetch(new Request('https://solosync.szlk.uk/icon.svg'), environment());
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(await icon.text(), /<svg/);

  const uploadLogo = await worker.fetch(new Request('https://solosync.szlk.uk/icon.png'), environment());
  assert.equal(uploadLogo.status, 200);
  assert.equal(uploadLogo.headers.get('content-type'), 'image/png');
  assert.equal(uploadLogo.headers.get('content-disposition'), 'inline; filename="solosync-icon.png"');
  const uploadLogoBytes = Buffer.from(await uploadLogo.arrayBuffer());
  assert.equal(uploadLogoBytes.length, 28_796);
  assert.equal(createHash('sha256').update(uploadLogoBytes).digest('hex'), '236059fa43462ebb1271220cf363cc3836ca0be12699ad36cc7be7557f8f87cb');

  const robots = await worker.fetch(new Request('https://solosync.szlk.uk/robots.txt'), environment());
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), 'User-agent: *\nAllow: /\n');
});

test('exchanges a PKCE-bound callback code without exposing the refresh token', async () => {
  const env = environment();
  const tokenRequests = [];
  const fetch = async (input, init) => {
    tokenRequests.push({ url: String(input), body: String(init.body) });
    return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
  };

  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeChallenge: challenge }),
  }), env, { fetch });
  assert.equal(start.status, 200);
  const { authorizationUrl } = await start.json();
  const authorization = new URL(authorizationUrl);
  assert.equal(authorization.searchParams.get('client_id'), env.GOOGLE_WEB_CLIENT_ID);
  assert.equal(authorization.searchParams.get('redirect_uri'), 'https://solosync.szlk.uk/oauth/google/callback');
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(authorization.searchParams.get('code_challenge'), challenge);

  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(authorization.searchParams.get('state'))}`), env, { fetch });
  assert.equal(callback.status, 200);
  const code = callbackCode(await callback.text());

  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callbackCode: code, codeVerifier: verifier }),
  }), env, { fetch });
  assert.equal(exchange.status, 200);
  const result = await exchange.json();
  assert.equal(result.accessToken, 'access-1');
  assert.equal(result.expiresIn, 3600);
  assert.equal(typeof result.credential, 'string');
  assert.equal(JSON.stringify(result).includes('refresh-1'), false);
  assert.equal(tokenRequests.length, 1);
  const tokenBody = new URLSearchParams(tokenRequests[0].body);
  assert.equal(tokenBody.get('code_verifier'), verifier);
  assert.equal(tokenBody.get('client_secret'), env.GOOGLE_WEB_CLIENT_SECRET);
});

test('reports an unreadable Google token response without falling back to a generic 500', async () => {
  const env = environment();
  const fetch = async () => new Response('<html>upstream error</html>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });
  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeChallenge: challenge }),
  }), env, { fetch });
  const { authorizationUrl } = await start.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env, { fetch });
  const code = callbackCode(await callback.text());
  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callbackCode: code, codeVerifier: verifier }),
  }), env, { fetch });

  assert.equal(exchange.status, 502);
  assert.deepEqual(await exchange.json(), { error: 'Google authorization returned an unreadable response (403).' });
});

test('reports a Google token response body read failure without a generic 500', async () => {
  const env = environment();
  const fetch = async () => ({
    status: 502,
    async text() { throw new Error('response stream ended early'); },
  });
  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codeChallenge: challenge }),
  }), env, { fetch });
  const { authorizationUrl } = await start.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env, { fetch });
  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackCode: callbackCode(await callback.text()), codeVerifier: verifier }),
  }), env, { fetch });

  assert.equal(exchange.status, 502);
  assert.deepEqual(await exchange.json(), { error: 'Google authorization returned an unreadable response (502).' });
});

test('reports when the Worker cannot reach the Google token service', async () => {
  const env = environment();
  const fetch = async () => { throw new Error('diagnostic network failure'); };
  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeChallenge: challenge }),
  }), env, { fetch });
  const { authorizationUrl } = await start.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env, { fetch });
  const code = callbackCode(await callback.text());
  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callbackCode: code, codeVerifier: verifier }),
  }), env, { fetch });

  assert.equal(exchange.status, 502);
  assert.deepEqual(await exchange.json(), { error: 'SoloSync could not reach the Google authorization service.' });
});

test('calls the Worker global fetch without an object receiver during token exchange', async () => {
  const env = environment();
  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ codeChallenge: challenge }),
  }), env);
  const { authorizationUrl } = await start.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env);
  const code = callbackCode(await callback.text());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function () {
    assert.equal(this, undefined);
    return Promise.resolve(Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 }));
  };
  try {
    const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callbackCode: code, codeVerifier: verifier }),
    }), env);
    assert.equal(exchange.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects a callback code presented without its original PKCE verifier', async () => {
  const env = environment();
  let tokenRequests = 0;
  const execution = { fetch: async () => { tokenRequests += 1; return Response.json({}); } };
  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codeChallenge: challenge }),
  }), env, execution);
  const { authorizationUrl } = await start.json();
  const state = new URL(authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env, execution);
  const code = callbackCode(await callback.text());

  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackCode: code, codeVerifier: `${verifier}wrong` }),
  }), env, execution);

  assert.equal(exchange.status, 400);
  assert.equal(tokenRequests, 0);
});

test('refreshes and revokes through an opaque credential', async () => {
  const env = environment();
  const requests = [];
  const execution = {
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: String(init.body) });
      if (String(input).includes('/revoke')) return new Response(null, { status: 200 });
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') === 'authorization_code') return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 });
      return Response.json({ access_token: 'access-2', expires_in: 1800 });
    },
  };
  const start = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codeChallenge: challenge }),
  }), env, execution);
  const state = new URL((await start.json()).authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env, execution);
  const code = callbackCode(await callback.text());
  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackCode: code, codeVerifier: verifier }),
  }), env, execution);
  const initial = await exchange.json();

  const refresh = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: initial.credential }),
  }), env, execution);
  assert.equal(refresh.status, 200);
  const refreshed = await refresh.json();
  assert.equal(refreshed.accessToken, 'access-2');
  assert.equal(JSON.stringify(refreshed).includes('refresh-1'), false);

  const revoke = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/revoke', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: refreshed.credential }),
  }), env, execution);
  assert.equal(revoke.status, 204);
  assert.match(requests.at(-1).body, /token=refresh-1/);
});

test('keeps sign-in unavailable until the Web OAuth credentials are configured', async () => {
  const env = { OAUTH_SEALING_KEY: randomBytes(32).toString('base64'), PUBLIC_ORIGIN: 'https://solosync.szlk.uk' };
  const response = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codeChallenge: challenge }),
  }), env, { fetch });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/i);
});

test('health verifies OAuth credentials and the sealing key', async () => {
  const unavailable = await worker.fetch(new Request('https://solosync.szlk.uk/health'), {
    PUBLIC_ORIGIN: 'https://solosync.szlk.uk',
  });
  assert.equal(unavailable.status, 503);

  const healthy = await worker.fetch(new Request('https://solosync.szlk.uk/health'), environment());
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { status: 'ok' });
});

test('reports an invalid Google grant so clients can request sign-in again', async () => {
  const env = environment();
  const credentialResponse = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/start', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codeChallenge: challenge }),
  }), env);
  const state = new URL((await credentialResponse.json()).authorizationUrl).searchParams.get('state');
  const callback = await worker.fetch(new Request(`https://solosync.szlk.uk/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`), env);
  const code = callbackCode(await callback.text());
  const exchange = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callbackCode: code, codeVerifier: verifier }),
  }), env, { fetch: async () => Response.json({ access_token: 'access', refresh_token: 'refresh' }) });
  const { credential } = await exchange.json();

  const refresh = await worker.fetch(new Request('https://solosync.szlk.uk/v1/auth/token', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
  }), env, { fetch: async () => Response.json({ error: 'invalid_grant', error_description: 'Expired.' }, { status: 400 }) });

  assert.equal(refresh.status, 401);
  assert.deepEqual(await refresh.json(), { error: 'Expired.', code: 'invalid_grant' });
});
