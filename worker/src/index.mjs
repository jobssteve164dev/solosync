import { publicSiteResponse } from './site.mjs';

const googleAuthorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';
const googleRevokeEndpoint = 'https://oauth2.googleapis.com/revoke';
const driveFileScope = 'https://www.googleapis.com/auth/drive.file';
const shortLifetimeMs = 10 * 60 * 1_000;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function encryptionKey(env) {
  const raw = base64ToBytes(env.OAUTH_SEALING_KEY ?? '');
  if (raw.byteLength !== 32) throw new RequestError('SoloSync authorization encryption is not configured yet.', 503);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(env, purpose, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: new TextEncoder().encode(`solosync:${purpose}:v1`),
  }, await encryptionKey(env), plaintext);
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function unseal(env, purpose, value) {
  try {
    const [ivValue, ciphertextValue, extra] = String(value ?? '').split('.');
    if (!ivValue || !ciphertextValue || extra) throw new Error('invalid envelope');
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64UrlToBytes(ivValue),
      additionalData: new TextEncoder().encode(`solosync:${purpose}:v1`),
    }, await encryptionKey(env), base64UrlToBytes(ciphertextValue));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new RequestError('This SoloSync authorization code is invalid or expired.');
  }
}

class RequestError extends Error {
  constructor(message, status = 400, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicOrigin(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use HTTPS.');
  return origin.origin;
}

function callbackUri(env) {
  return `${publicOrigin(env)}/oauth/google/callback`;
}

function requireOAuthConfiguration(env) {
  if (!env.GOOGLE_WEB_CLIENT_ID || !env.GOOGLE_WEB_CLIENT_SECRET) {
    throw new RequestError('Google Drive sign-in is not configured yet.', 503);
  }
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'cache-control': 'no-store',
    },
  });
}

async function requestJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new RequestError('Send a JSON request.');
  }
  try {
    return await request.json();
  } catch {
    throw new RequestError('The request body is not valid JSON.');
  }
}

function validChallenge(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function start(request, env) {
  requireOAuthConfiguration(env);
  const body = await requestJson(request);
  if (!validChallenge(body.codeChallenge)) throw new RequestError('The PKCE code challenge is invalid.');
  const expiresAt = Date.now() + shortLifetimeMs;
  const state = await seal(env, 'state', { codeChallenge: body.codeChallenge, expiresAt });
  const authorization = new URL(googleAuthorizationEndpoint);
  authorization.search = new URLSearchParams({
    client_id: env.GOOGLE_WEB_CLIENT_ID,
    redirect_uri: callbackUri(env),
    response_type: 'code',
    scope: driveFileScope,
    state,
    code_challenge: body.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return json({ authorizationUrl: authorization.toString(), expiresAt });
}

function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function callbackPage(code) {
  const safeCode = escapeHtml(code);
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Connect SoloSync</title>
<style>body{font:16px system-ui;max-width:640px;margin:8vh auto;padding:24px}code{display:block;overflow-wrap:anywhere;padding:16px;border:1px solid #888;border-radius:8px}button{margin-top:16px;padding:10px 16px}</style></head>
<body><h1>Google Drive is ready</h1><p>Copy this one-time code and paste it into SoloSync.</p>
<code id="code" data-callback-code="${safeCode}">${safeCode}</code><button id="copy">Copy code</button>
<p id="status" role="status"></p><script nonce="solosync">document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(document.getElementById('code').textContent);document.getElementById('status').textContent='Copied. Return to SoloSync to finish connecting.'}</script></body></html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'nonce-solosync'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function callback(request, env) {
  const url = new URL(request.url);
  const googleError = url.searchParams.get('error');
  if (googleError) throw new RequestError(googleError === 'access_denied' ? 'Google Drive access was canceled.' : 'Google did not complete authorization.');
  const code = url.searchParams.get('code');
  const stateValue = url.searchParams.get('state');
  if (!code || !stateValue) throw new RequestError('Google did not return a complete authorization response.');
  const state = await unseal(env, 'state', stateValue);
  if (!validChallenge(state.codeChallenge) || state.expiresAt < Date.now()) throw new RequestError('This SoloSync authorization request has expired.');
  const callbackCode = await seal(env, 'callback', {
    code,
    codeChallenge: state.codeChallenge,
    expiresAt: Date.now() + shortLifetimeMs,
  });
  return callbackPage(callbackCode);
}

async function googleToken(execution, env, parameters) {
  requireOAuthConfiguration(env);
  const response = await execution.fetch(googleTokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_WEB_CLIENT_ID,
      client_secret: env.GOOGLE_WEB_CLIENT_SECRET,
      ...parameters,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    const invalidGrant = body.error === 'invalid_grant';
    throw new RequestError(
      body.error_description || body.error || 'Google rejected the authorization request.',
      invalidGrant ? 401 : 502,
      invalidGrant ? 'invalid_grant' : undefined,
    );
  }
  return body;
}

async function exchange(request, env, execution) {
  const body = await requestJson(request);
  const callbackValue = await unseal(env, 'callback', body.callbackCode);
  if (callbackValue.expiresAt < Date.now()) throw new RequestError('This SoloSync authorization code has expired.');
  if (typeof body.codeVerifier !== 'string' || await sha256Base64Url(body.codeVerifier) !== callbackValue.codeChallenge) {
    throw new RequestError('This code belongs to a different SoloSync sign-in request.');
  }
  const tokens = await googleToken(execution, env, {
    code: callbackValue.code,
    code_verifier: body.codeVerifier,
    redirect_uri: callbackUri(env),
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) throw new RequestError('Google did not return long-term access. Remove SoloSync from your Google account and connect again.', 502);
  const credential = await seal(env, 'credential', { refreshToken: tokens.refresh_token });
  return json({ accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600, credential });
}

async function refresh(request, env, execution) {
  const body = await requestJson(request);
  const saved = await unseal(env, 'credential', body.credential);
  if (typeof saved.refreshToken !== 'string') throw new RequestError('The saved Google Drive connection is invalid.');
  const tokens = await googleToken(execution, env, { refresh_token: saved.refreshToken, grant_type: 'refresh_token' });
  const credential = await seal(env, 'credential', { refreshToken: tokens.refresh_token ?? saved.refreshToken });
  return json({ accessToken: tokens.access_token, expiresIn: tokens.expires_in ?? 3600, credential });
}

async function revoke(request, env, execution) {
  const body = await requestJson(request);
  const saved = await unseal(env, 'credential', body.credential);
  const response = await execution.fetch(googleRevokeEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: saved.refreshToken }),
  });
  if (!response.ok) throw new RequestError('Google could not revoke this connection.', 502);
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
}

export default {
  async fetch(request, env, context = {}) {
    const execution = { fetch: context.fetch ?? fetch };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: json({}).headers });
    const url = new URL(request.url);
    try {
      const siteResponse = await publicSiteResponse(request, url.pathname, env);
      if (siteResponse) return siteResponse;
      if (request.method === 'GET' && url.pathname === '/health') {
        requireOAuthConfiguration(env);
        publicOrigin(env);
        await encryptionKey(env);
        return json({ status: 'ok' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/start') return await start(request, env);
      if (request.method === 'GET' && url.pathname === '/oauth/google/callback') return await callback(request, env);
      if (request.method === 'POST' && url.pathname === '/v1/auth/exchange') return await exchange(request, env, execution);
      if (request.method === 'POST' && url.pathname === '/v1/auth/token') return await refresh(request, env, execution);
      if (request.method === 'POST' && url.pathname === '/v1/auth/revoke') return await revoke(request, env, execution);
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const status = error instanceof RequestError ? error.status : 500;
      const message = error instanceof RequestError ? error.message : 'SoloSync authorization is temporarily unavailable.';
      return json({ error: message, ...(error instanceof RequestError && error.code ? { code: error.code } : {}) }, status);
    }
  },
};
