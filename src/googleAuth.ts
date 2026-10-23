import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export interface GoogleAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}

export interface GoogleSecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

interface GoogleTokenManagerOptions {
  clientId: string;
  secrets: GoogleSecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  onAuthenticationRequired?: () => Thenable<void> | Promise<void>;
}

interface GoogleTokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

const refreshTokenKey = 'solosync.google.refreshToken';
const hostedCredentialKey = 'solosync.google.hostedCredential';

export async function clearGoogleUploadSessions(keys: string[], secrets: GoogleSecretStore): Promise<void> {
  await Promise.all(keys.map((key) => secrets.delete(`solosync.${key}`)));
}

export class GoogleAuthenticationError extends Error {}

function canceledAuthentication(): GoogleAuthenticationError {
  return new GoogleAuthenticationError('Google sign-in was canceled.');
}

function abortable<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(canceledAuthentication());
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(canceledAuthentication());
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

interface HostedGoogleTokenManagerOptions {
  brokerUrl: string;
  secrets: GoogleSecretStore;
  fetch?: typeof fetch;
  now?: () => number;
  onAuthenticationRequired?: () => Thenable<void> | Promise<void>;
}

interface HostedTokenResponse {
  accessToken?: string;
  expiresIn?: number;
  credential?: string;
  error?: string;
  code?: string;
}

export class GoogleTokenManagerCache {
  private readonly owners = new WeakMap<object, Map<string, unknown>>();

  get<T>(owner: object, mode: string, create: () => T): T {
    let modes = this.owners.get(owner);
    if (!modes) {
      modes = new Map();
      this.owners.set(owner, modes);
    }
    if (!modes.has(mode)) modes.set(mode, create());
    return modes.get(mode) as T;
  }
}

export class HostedGoogleTokenManager {
  private access?: { value: string; expiresAt: number };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: HostedGoogleTokenManagerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async post(path: string, body: Record<string, string>, signal?: AbortSignal): Promise<HostedTokenResponse> {
    const response = await this.fetchImpl(`${this.options.brokerUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const result = response.status === 204 ? {} : await response.json() as HostedTokenResponse;
    if (!response.ok) {
      if (result.code === 'invalid_grant') {
        this.access = undefined;
        await this.options.secrets.delete(hostedCredentialKey);
        await this.options.onAuthenticationRequired?.();
      }
      throw new GoogleAuthenticationError(result.error || `SoloSync sign-in failed (${response.status}).`);
    }
    return result;
  }

  private async acceptTokens(result: HostedTokenResponse): Promise<string> {
    if (!result.accessToken || !result.credential) throw new GoogleAuthenticationError('SoloSync did not receive a complete Google Drive connection.');
    await this.options.secrets.store(hostedCredentialKey, result.credential);
    this.access = {
      value: result.accessToken,
      expiresAt: this.now() + Math.max(0, (result.expiresIn ?? 3600) - 60) * 1_000,
    };
    return result.accessToken;
  }

  async connect(actions: {
    openExternal(url: string): Thenable<boolean> | Promise<boolean>;
    requestCallbackCode(): Thenable<string | undefined> | Promise<string | undefined>;
  }, signal?: AbortSignal): Promise<string> {
    const codeVerifier = randomBytes(64).toString('base64url');
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier, 'ascii').digest());
    const started = await this.post('/v1/auth/start', { codeChallenge }, signal);
    const authorizationUrl = (started as HostedTokenResponse & { authorizationUrl?: string }).authorizationUrl;
    if (!authorizationUrl) throw new GoogleAuthenticationError('SoloSync could not start Google sign-in.');
    if (!await abortable(actions.openExternal(authorizationUrl), signal)) throw new GoogleAuthenticationError('SoloSync could not open the Google sign-in page.');
    const callbackCode = (await abortable(actions.requestCallbackCode(), signal))?.trim();
    if (!callbackCode) throw new GoogleAuthenticationError('Google sign-in was canceled.');
    return this.acceptTokens(await this.post('/v1/auth/exchange', { callbackCode, codeVerifier }, signal));
  }

  async accessToken(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && this.access && this.access.expiresAt > this.now()) return this.access.value;
    const credential = await this.options.secrets.get(hostedCredentialKey);
    if (!credential) {
      await this.options.onAuthenticationRequired?.();
      throw new GoogleAuthenticationError('Google Drive needs you to sign in again.');
    }
    return this.acceptTokens(await this.post('/v1/auth/token', { credential }, signal));
  }

  async disconnect(): Promise<void> {
    this.access = undefined;
    await this.options.secrets.delete(hostedCredentialKey);
  }

  async revoke(): Promise<void> {
    const credential = await this.options.secrets.get(hostedCredentialKey);
    if (credential) await this.post('/v1/auth/revoke', { credential });
    await this.disconnect();
  }
}

export class GoogleTokenManager {
  private access?: { value: string; expiresAt: number };
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleTokenManagerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async tokenRequest(parameters: Record<string, string>, signal?: AbortSignal): Promise<GoogleTokenResponse> {
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId, ...parameters }),
      signal,
    });
    const body = await response.json() as GoogleTokenResponse;
    if (!response.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        await this.options.secrets.delete(refreshTokenKey);
        this.access = undefined;
        await this.options.onAuthenticationRequired?.();
      }
      throw new GoogleAuthenticationError(body.error_description || body.error || `Google sign-in failed (${response.status}).`);
    }
    this.access = { value: body.access_token, expiresAt: this.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1_000 };
    if (body.refresh_token) await this.options.secrets.store(refreshTokenKey, body.refresh_token);
    return body;
  }

  async exchangeAuthorizationCode(request: { code: string; codeVerifier: string; redirectUri: string }, signal?: AbortSignal): Promise<string> {
    const result = await this.tokenRequest({
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: request.redirectUri,
      grant_type: 'authorization_code',
    }, signal);
    return result.access_token!;
  }

  async accessToken(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (!forceRefresh && this.access && this.access.expiresAt > this.now()) return this.access.value;
    const refreshToken = await this.options.secrets.get(refreshTokenKey);
    if (!refreshToken) {
      await this.options.onAuthenticationRequired?.();
      throw new GoogleAuthenticationError('Google Drive needs you to sign in again.');
    }
    const result = await this.tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' }, signal);
    return result.access_token!;
  }

  async disconnect(): Promise<void> {
    this.access = undefined;
    await this.options.secrets.delete(refreshTokenKey);
  }

  async revoke(): Promise<void> {
    const token = await this.options.secrets.get(refreshTokenKey) ?? this.access?.value;
    if (token) {
      const response = await this.fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (!response.ok) throw new GoogleAuthenticationError(`Google could not revoke this connection (${response.status}).`);
    }
    await this.disconnect();
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64url');
}

export function buildGoogleAuthorizationUrl(request: GoogleAuthorizationRequest): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive.file',
    state: request.state,
    code_challenge: base64Url(createHash('sha256').update(request.codeVerifier, 'ascii').digest()),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

interface AuthorizeGoogleDesktopOptions {
  clientId: string;
  tokens: GoogleTokenManager;
  openExternal(url: string): Thenable<boolean> | Promise<boolean>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function authorizeGoogleDesktop(options: AuthorizeGoogleDesktopOptions): Promise<string> {
  if (options.signal?.aborted) throw new GoogleAuthenticationError('Google sign-in was canceled.');
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(64).toString('base64url');
  let settle!: (value: string) => void;
  let reject!: (error: Error) => void;
  const code = new Promise<string>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/oauth/callback' || requestUrl.searchParams.get('state') !== state) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('This Google sign-in response is not valid. Return to SoloSync and try again.');
      return;
    }
    const error = requestUrl.searchParams.get('error');
    const authorizationCode = requestUrl.searchParams.get('code');
    if (error || !authorizationCode) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Google sign-in was not completed. You can close this page.');
      reject(new GoogleAuthenticationError(error === 'access_denied' ? 'Google sign-in was canceled.' : 'Google sign-in did not return an authorization code.'));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>SoloSync connected</title><p>Google Drive is connected. You can close this page and return to VS Code.</p>');
    settle(authorizationCode);
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new GoogleAuthenticationError('SoloSync could not start the local Google sign-in callback.');
  }
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const timer = setTimeout(() => reject(new GoogleAuthenticationError('Google sign-in timed out.')), options.timeoutMs ?? 300_000);
  const cancel = (): void => reject(new GoogleAuthenticationError('Google sign-in was canceled.'));
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const opened = await abortable(options.openExternal(buildGoogleAuthorizationUrl({ clientId: options.clientId, redirectUri, state, codeVerifier })), options.signal);
    if (!opened) throw new GoogleAuthenticationError('SoloSync could not open the Google sign-in page.');
    const authorizationCode = await code;
    return options.tokens.exchangeAuthorizationCode({ code: authorizationCode, codeVerifier, redirectUri }, options.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

