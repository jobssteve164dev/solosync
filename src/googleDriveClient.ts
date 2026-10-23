import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GoogleDriveApi, GoogleDriveItem } from './googleDriveProvider';

interface AccessTokens {
  accessToken(forceRefresh?: boolean, signal?: AbortSignal): Promise<string>;
}

interface UploadSessions {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface GoogleDriveClientOptions {
  tokens: AccessTokens;
  sessions: UploadSessions;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const driveApi = 'https://www.googleapis.com/drive/v3';
const driveUploadApi = 'https://www.googleapis.com/upload/drive/v3';
const folderMimeType = 'application/vnd.google-apps.folder';
const itemFields = 'id,name,mimeType,parents,appProperties,createdTime,size,trashed';
const chunkSize = 256 * 1024;
const metadataLimit = 1024 * 1024;

function escapeQuery(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
}

function sessionKey(item: { id: string; appProperties?: Record<string, string> }): string {
  return `google-drive-upload:${item.appProperties?.projectId ?? 'unknown'}:${item.id}`;
}

export class GoogleDriveClient implements GoogleDriveApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GoogleDriveClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep) return this.options.sleep(milliseconds, signal);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('The operation was canceled.'));
        return;
      }
      const timer = setTimeout(resolve, milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('The operation was canceled.'));
      }, { once: true });
    });
  }

  private async transient(response: Response): Promise<boolean> {
    if (response.status === 429 || response.status >= 500) return true;
    if (response.status !== 403) return false;
    try {
      const body = await response.clone().json() as { error?: { errors?: Array<{ reason?: string }> } };
      return body.error?.errors?.some((item) => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(item.reason ?? '')) ?? false;
    } catch {
      return false;
    }
  }

  private async fetchRetry(input: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(input, init);
      } catch (error) {
        if (attempt === 2) throw error;
        await this.sleep(250 * (2 ** attempt) + Math.floor(Math.random() * 100), init.signal as AbortSignal | undefined);
        continue;
      }
      if (!await this.transient(response) || attempt === 2) return response;
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1_000 : 250 * (2 ** attempt);
      await this.sleep(delay, init.signal as AbortSignal | undefined);
    }
    throw new Error('Google Drive request failed.');
  }

  private async request(input: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const token = await this.options.tokens.accessToken(!retry, init.signal as AbortSignal | undefined);
    const response = await this.fetchRetry(input, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
    if (response.status === 401 && retry) return this.request(input, init, false);
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json() as { error?: { message?: string } };
        detail = body.error?.message ? `: ${body.error.message}` : '';
      } catch {
        // Some Drive failures have no JSON response body.
      }
      throw new Error(`Google Drive request failed (${response.status})${detail}`);
    }
    return response;
  }

  async about(signal?: AbortSignal): Promise<{ user: { permissionId?: string; displayName?: string; emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }> {
    const response = await this.request(`${driveApi}/about?fields=user(permissionId,displayName,emailAddress),storageQuota(limit,usage)`, { signal });
    return response.json() as Promise<{ user: { permissionId?: string; displayName?: string; emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }>;
  }

  async generateId(signal?: AbortSignal): Promise<string> {
    const response = await this.request(`${driveApi}/files/generateIds?count=1&space=drive&type=files`, { signal });
    const body = await response.json() as { ids?: string[] };
    if (!body.ids?.[0]) throw new Error('Google Drive did not reserve a file ID.');
    return body.ids[0];
  }

  async listChildren(parentId: string, properties: Record<string, string> = {}, signal?: AbortSignal): Promise<GoogleDriveItem[]> {
    const query = [`'${escapeQuery(parentId)}' in parents`, 'trashed = false'];
    for (const [key, value] of Object.entries(properties)) {
      query.push(`appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`);
    }
    const files: GoogleDriveItem[] = [];
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({
        q: query.join(' and '),
        spaces: 'drive',
        fields: `nextPageToken,files(${itemFields})`,
        pageSize: '1000',
      });
      if (pageToken) parameters.set('pageToken', pageToken);
      const response = await this.request(`${driveApi}/files?${parameters}`, { signal });
      const body = await response.json() as { files?: GoogleDriveItem[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async listFolders(properties: Record<string, string> = {}, signal?: AbortSignal): Promise<GoogleDriveItem[]> {
    const query = [`mimeType = '${folderMimeType}'`, 'trashed = false'];
    for (const [key, value] of Object.entries(properties)) {
      query.push(`appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`);
    }
    const files: GoogleDriveItem[] = [];
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({
        q: query.join(' and '),
        spaces: 'drive',
        fields: `nextPageToken,files(${itemFields})`,
        pageSize: '1000',
      });
      if (pageToken) parameters.set('pageToken', pageToken);
      const response = await this.request(`${driveApi}/files?${parameters}`, { signal });
      const body = await response.json() as { files?: GoogleDriveItem[]; nextPageToken?: string };
      files.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return files;
  }

  async createFolder(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, signal?: AbortSignal): Promise<GoogleDriveItem> {
    const response = await this.request(`${driveApi}/files?fields=${encodeURIComponent(itemFields)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...item, mimeType: folderMimeType }),
      signal,
    });
    return response.json() as Promise<GoogleDriveItem>;
  }

  async uploadFile(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, source: string | Buffer, signal?: AbortSignal): Promise<GoogleDriveItem> {
    return this.uploadFileAttempt(item, source, signal, false);
  }

  private async uploadFileAttempt(
    item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> },
    source: string | Buffer,
    signal: AbortSignal | undefined,
    rebuiltSession: boolean,
  ): Promise<GoogleDriveItem> {
    const key = sessionKey(item);
    let uploadUri = await this.options.sessions.get(key);
    const resumed = Boolean(uploadUri);
    const size = Buffer.isBuffer(source) ? source.length : (await stat(source)).size;
    if (!uploadUri) {
      const response = await this.request(`${driveUploadApi}/files?uploadType=resumable&fields=${encodeURIComponent(itemFields)}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/octet-stream',
          'x-upload-content-length': String(size),
        },
        body: JSON.stringify(item),
        signal,
      });
      uploadUri = response.headers.get('location') ?? undefined;
      if (!uploadUri) throw new Error('Google Drive did not start the resumable upload.');
      await this.options.sessions.store(key, uploadUri);
    }

    const finish = async (response: Response): Promise<GoogleDriveItem> => {
      const result = await response.json() as GoogleDriveItem;
      if (result.id !== item.id || result.size !== String(size)) {
        throw new Error('Google Drive returned a different file after upload.');
      }
      await this.options.sessions.delete(key);
      return result;
    };
    const reconcileCompletedFile = async (): Promise<GoogleDriveItem | undefined> => {
      const existing = await this.get(item.id, signal);
      if (!existing) return undefined;
      const expectedParents = [...item.parents].sort();
      const actualParents = [...existing.parents].sort();
      const expectedProperties = Object.entries(item.appProperties).sort(([left], [right]) => left.localeCompare(right));
      const actualProperties = Object.entries(existing.appProperties).sort(([left], [right]) => left.localeCompare(right));
      const matches = existing.trashed !== true
        && existing.id === item.id
        && existing.name === item.name
        && existing.size === String(size)
        && expectedParents.length === actualParents.length
        && expectedParents.every((parent, index) => actualParents[index] === parent)
        && expectedProperties.length === actualProperties.length
        && expectedProperties.every(([name, value], index) => actualProperties[index]?.[0] === name && actualProperties[index]?.[1] === value);
      if (!matches) throw new Error('Google Drive contains a different file for the reserved backup ID.');
      await this.options.sessions.delete(key);
      return existing;
    };
    let offset = 0;
    if (resumed || size === 0) {
      const status = await this.fetchRetry(uploadUri, {
        method: 'PUT',
        headers: { 'content-length': '0', 'content-range': `bytes */${size}` },
        signal,
      });
      if (status.ok) return finish(status);
      if (resumed && [404, 410].includes(status.status)) {
        const completed = await reconcileCompletedFile();
        if (completed) return completed;
        if (rebuiltSession) throw new Error('Google Drive upload sessions expired repeatedly. Continue the pending backup to try again.');
        await this.options.sessions.delete(key);
        return this.uploadFileAttempt(item, source, signal, true);
      }
      if (status.status !== 308) throw new Error(`Google Drive upload status check failed (${status.status}).`);
      const acknowledged = status.headers.get('range')?.match(/bytes=0-(\d+)/)?.[1];
      offset = acknowledged ? Number(acknowledged) + 1 : 0;
      if (size === 0) throw new Error('Google Drive did not finish the empty file upload.');
    }

    const handle = Buffer.isBuffer(source) ? undefined : await open(source, 'r');
    try {
      while (offset < size) {
        const length = Math.min(chunkSize, size - offset);
        const chunk = Buffer.isBuffer(source) ? source.subarray(offset, offset + length) : Buffer.allocUnsafe(length);
        if (handle) await handle.read(chunk, 0, length, offset);
        const response = await this.fetchRetry(uploadUri, {
          method: 'PUT',
          headers: {
            'content-length': String(length),
            'content-range': `bytes ${offset}-${offset + length - 1}/${size}`,
          },
          body: chunk,
          signal,
        });
        if (response.status === 308) {
          const acknowledged = response.headers.get('range')?.match(/bytes=0-(\d+)/)?.[1];
          offset = acknowledged ? Number(acknowledged) + 1 : offset + length;
          continue;
        }
        if ([404, 410].includes(response.status)) {
          const completed = await reconcileCompletedFile();
          if (completed) return completed;
          if (rebuiltSession) throw new Error('Google Drive upload sessions expired repeatedly. Continue the pending backup to try again.');
          await this.options.sessions.delete(key);
          return this.uploadFileAttempt(item, source, signal, true);
        }
        if (!response.ok) throw new Error(`Google Drive upload failed (${response.status}).`);
        return finish(response);
      }
      throw new Error('Google Drive did not finish the resumable upload.');
    } finally {
      await handle?.close();
    }
  }

  async get(id: string, signal?: AbortSignal, retry = true): Promise<GoogleDriveItem | undefined> {
    const response = await this.fetchRetry(`${driveApi}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(itemFields)}`, {
      headers: { authorization: `Bearer ${await this.options.tokens.accessToken(!retry, signal)}` },
      signal,
    });
    if (response.status === 401 && retry) return this.get(id, signal, false);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Google Drive request failed (${response.status}).`);
    return response.json() as Promise<GoogleDriveItem>;
  }

  async update(id: string, patch: { name?: string; appProperties?: Record<string, string>; addParent?: string; removeParent?: string }, signal?: AbortSignal): Promise<GoogleDriveItem> {
    const parameters = new URLSearchParams({ fields: itemFields });
    if (patch.addParent) parameters.set('addParents', patch.addParent);
    if (patch.removeParent) parameters.set('removeParents', patch.removeParent);
    const response = await this.request(`${driveApi}/files/${encodeURIComponent(id)}?${parameters}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: patch.name, appProperties: patch.appProperties }),
      signal,
    });
    return response.json() as Promise<GoogleDriveItem>;
  }

  async readFile(id: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.request(`${driveApi}/files/${encodeURIComponent(id)}?alt=media`, { signal });
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > metadataLimit) throw new Error('Google Drive metadata exceeds the 1 MiB limit.');
    if (!response.body) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const buffer = Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > metadataLimit) throw new Error('Google Drive metadata exceeds the 1 MiB limit.');
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  }

  async hashFile(id: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request(`${driveApi}/files/${encodeURIComponent(id)}?alt=media`, { signal });
    if (!response.body) throw new Error('Google Drive returned an empty download.');
    const hash = createHash('sha256');
    for await (const chunk of Readable.fromWeb(response.body as never)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  async forgetUpload(id: string, projectId: string): Promise<void> {
    await this.options.sessions.delete(sessionKey({ id, appProperties: { projectId } }));
  }

  async downloadFile(id: string, destination: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`${driveApi}/files/${encodeURIComponent(id)}?alt=media`, { signal });
    if (!response.body) throw new Error('Google Drive returned an empty download.');
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination), { signal });
  }

  async trash(id: string, signal?: AbortSignal): Promise<void> {
    await this.request(`${driveApi}/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
      signal,
    });
  }
}
