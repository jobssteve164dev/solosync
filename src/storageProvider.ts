import { createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WebDAVClient, WebDAVClientError } from 'webdav' with { 'resolution-mode': 'import' };

export interface StorageEntry {
  name: string;
  type: 'file' | 'directory';
}

export interface StorageProvider {
  readonly displayName: string;
  readonly localRoot?: string;
  validate(signal?: AbortSignal): Promise<void>;
  testConnection(signal?: AbortSignal): Promise<void>;
  exists(key: string, signal?: AbortSignal): Promise<boolean>;
  list(key: string, signal?: AbortSignal): Promise<StorageEntry[]>;
  createDirectory(key: string, signal?: AbortSignal): Promise<void>;
  writeFile(key: string, source: string | Buffer, signal?: AbortSignal): Promise<void>;
  readFile(key: string, signal?: AbortSignal): Promise<Buffer>;
  hashFile(key: string, signal?: AbortSignal): Promise<string>;
  downloadFile(key: string, destination: string, signal?: AbortSignal): Promise<void>;
  move(source: string, destination: string, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

class StorageProviderError extends Error {}

function webDavStatus(error: unknown): number | undefined {
  const clientError = error as (WebDAVClientError & { cause?: NodeJS.ErrnoException }) | undefined;
  return clientError?.status ?? clientError?.response?.status;
}

function webDavCode(error: unknown): string | undefined {
  const clientError = error as (WebDAVClientError & { cause?: NodeJS.ErrnoException }) | undefined;
  return (error as NodeJS.ErrnoException | undefined)?.code ?? clientError?.cause?.code;
}

function isRetryableWebDavError(error: unknown): boolean {
  const status = webDavStatus(error);
  if (status && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = webDavCode(error);
  return Boolean(code && ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code));
}

async function retryWebDav<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfCancelled(signal);
    try {
      return await operation();
    } catch (error) {
      if (attempt === 2 || !isRetryableWebDavError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (2 ** attempt)));
    }
  }
  throw new Error('The QNAP request failed.');
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The operation was canceled.');
}

function storageSegments(key: string): string[] {
  if (key === '' || key === '/') return [];
  if (key.includes('\\') || key.startsWith('/')) throw new Error('The backup path is invalid.');
  const segments = key.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('The backup path is invalid.');
  }
  return segments;
}

export function normalizeStorageKey(key: string): string {
  return storageSegments(key).join('/');
}

function localPath(root: string, key: string): string {
  return path.join(root, ...storageSegments(key));
}

export class LocalFileSystemProvider implements StorageProvider {
  readonly displayName: string;

  constructor(readonly localRoot: string) {
    this.displayName = path.basename(localRoot) || localRoot;
  }

  async validate(signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const metadata = await stat(this.localRoot);
    if (!metadata.isDirectory()) throw new Error('Choose a folder for SoloSync backups.');
    await access(this.localRoot);
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.validate(signal);
    const testKey = `.solosync-connection-test-${randomUUID()}`;
    try {
      await this.createDirectory(testKey, signal);
      await this.writeFile(`${testKey}/source.txt`, Buffer.from('SoloSync connection test\n'), signal);
      await this.move(`${testKey}/source.txt`, `${testKey}/published.txt`, signal);
      if ((await this.readFile(`${testKey}/published.txt`, signal)).toString('utf8') !== 'SoloSync connection test\n') {
        throw new Error('The backup location returned different data after upload.');
      }
    } finally {
      await this.delete(testKey);
    }
  }

  async exists(key: string, signal?: AbortSignal): Promise<boolean> {
    throwIfCancelled(signal);
    try {
      await stat(localPath(this.localRoot, key));
      return true;
    } catch {
      return false;
    }
  }

  async list(key: string, signal?: AbortSignal): Promise<StorageEntry[]> {
    throwIfCancelled(signal);
    const entries = await readdir(localPath(this.localRoot, key), { withFileTypes: true });
    const result: StorageEntry[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) result.push({ name: entry.name, type: 'directory' });
      if (entry.isFile()) result.push({ name: entry.name, type: 'file' });
    }
    return result;
  }

  async createDirectory(key: string, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    await mkdir(localPath(this.localRoot, key), { recursive: true });
  }

  async writeFile(key: string, source: string | Buffer, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const destination = localPath(this.localRoot, key);
    await mkdir(path.dirname(destination), { recursive: true });
    if (typeof source === 'string') {
      await copyFile(source, destination);
    } else {
      await writeFile(destination, source);
    }
    throwIfCancelled(signal);
  }

  async readFile(key: string, signal?: AbortSignal): Promise<Buffer> {
    throwIfCancelled(signal);
    return readFile(localPath(this.localRoot, key));
  }

  async hashFile(key: string, signal?: AbortSignal): Promise<string> {
    throwIfCancelled(signal);
    const hash = createHash('sha256');
    const stream = createReadStream(localPath(this.localRoot, key));
    const cancel = (): void => {
      stream.destroy(new Error('The operation was canceled.'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for await (const chunk of stream) hash.update(chunk as Buffer);
      return hash.digest('hex');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  async downloadFile(key: string, destination: string, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(localPath(this.localRoot, key), destination);
    throwIfCancelled(signal);
  }

  async move(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const target = localPath(this.localRoot, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await rename(localPath(this.localRoot, source), target);
    throwIfCancelled(signal);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const segments = storageSegments(key);
    if (segments.length === 0) throw new Error('SoloSync will not delete the backup location root.');
    await rm(localPath(this.localRoot, key), { recursive: true, force: true });
  }
}

export interface QnapWebDavConnection {
  baseUrl: string;
  username: string;
}

interface WebDavProviderOptions {
  allowInsecureHttp?: boolean;
}

export function normalizeQnapWebDavUrl(value: string, allowInsecureHttp = false): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter the full HTTPS address of the QNAP backup folder.');
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error('The QNAP address must use HTTPS.');
  }
  if (url.username || url.password) throw new Error('Enter the NAS username and password separately.');
  if (url.search || url.hash) throw new Error('The QNAP address cannot contain a query or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function webDavPath(key: string): string {
  const segments = storageSegments(key);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function asBuffer(value: Buffer | ArrayBuffer | string | object): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new Error('The QNAP returned an unsupported file response.');
}

function friendlyWebDavError(error: unknown): Error {
  if (error instanceof StorageProviderError) return error;
  const status = webDavStatus(error);
  if (status === 401) return new StorageProviderError('QNAP sign-in failed. Check the NAS username and password.');
  if (status === 403) return new StorageProviderError('The NAS account cannot write to this QNAP backup folder.');
  if (status === 404) return new StorageProviderError('The QNAP backup folder was not found. Check its address.');
  if (status === 405 || status === 501) return new StorageProviderError('This QNAP endpoint does not support the file operations SoloSync needs.');
  if (status === 507) return new StorageProviderError('The QNAP backup volume does not have enough free space.');
  const code = webDavCode(error);
  if (code && ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code)) {
    return new StorageProviderError('The QNAP HTTPS certificate is not trusted or does not match the NAS address.');
  }
  if (error instanceof Error && error.name === 'AbortError') return new StorageProviderError('The operation was canceled.');
  return new StorageProviderError('SoloSync could not reach the QNAP backup folder. Check the address, certificate, and network connection.');
}

export class QnapWebDavProvider implements StorageProvider {
  readonly displayName: string;

  private constructor(
    private readonly client: WebDAVClient,
    private readonly baseUrl: string,
  ) {
    this.displayName = new URL(baseUrl).hostname;
  }

  static async create(connection: QnapWebDavConnection, password: string, options: WebDavProviderOptions = {}): Promise<QnapWebDavProvider> {
    const baseUrl = normalizeQnapWebDavUrl(connection.baseUrl, options.allowInsecureHttp);
    const { AuthType, createClient } = await import('webdav');
    const client = createClient(baseUrl, {
      authType: AuthType.Auto,
      username: connection.username,
      password,
      entityDecoder: { limit: { maxTotalExpansions: 100, maxExpandedLength: 100_000 } },
    });
    return new QnapWebDavProvider(client, baseUrl);
  }

  private async request<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    try {
      return await retryWebDav(operation, signal);
    } catch (error) {
      throw friendlyWebDavError(error);
    }
  }

  private async requestOnce<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw friendlyWebDavError(error);
    }
  }

  async validate(signal?: AbortSignal): Promise<void> {
    await this.request(() => this.client.getDirectoryContents('/', { includeSelf: false, signal }), signal);
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    await this.validate(signal);
    await this.createDirectory('SoloSync', signal);
    const root = `SoloSync/.connection-test-${randomUUID()}`;
    const source = `${root}/staging`;
    const published = `${root}/published`;
    const marker = Buffer.from('SoloSync QNAP connection test\n');
    try {
      await this.createDirectory(source, signal);
      await this.writeFile(`${source}/marker.txt`, marker, signal);
      if (!(await this.readFile(`${source}/marker.txt`, signal)).equals(marker)) {
        throw new Error('The QNAP returned different data after upload.');
      }
      await this.move(source, published, signal);
      const entries = await this.list(published, signal);
      if (!entries.some((entry) => entry.name === 'marker.txt' && entry.type === 'file')) {
        throw new Error('The QNAP did not publish the connection test correctly.');
      }
    } finally {
      await this.delete(root);
    }
  }

  async exists(key: string, signal?: AbortSignal): Promise<boolean> {
    return this.request(() => this.client.exists(webDavPath(key), { signal }), signal);
  }

  async list(key: string, signal?: AbortSignal): Promise<StorageEntry[]> {
    const entries = await this.request(() => this.client.getDirectoryContents(webDavPath(key), { includeSelf: false, signal }), signal);
    return entries.map((entry) => ({ name: entry.basename, type: entry.type }));
  }

  async createDirectory(key: string, signal?: AbortSignal): Promise<void> {
    await this.request(() => this.client.createDirectory(webDavPath(key), { recursive: true, signal }), signal);
  }

  async writeFile(key: string, source: string | Buffer, signal?: AbortSignal): Promise<void> {
    const remotePath = webDavPath(key);
    const parent = normalizeStorageKey(key).split('/').slice(0, -1).join('/');
    if (parent) await this.createDirectory(parent, signal);
    if (typeof source === 'string') {
      const metadata = await stat(source);
      await this.request(() => this.client.putFileContents(remotePath, createReadStream(source), { contentLength: metadata.size, overwrite: true, signal }), signal);
    } else {
      await this.request(() => this.client.putFileContents(remotePath, source, { contentLength: source.length, overwrite: true, signal }), signal);
    }
  }

  async readFile(key: string, signal?: AbortSignal): Promise<Buffer> {
    return asBuffer(await this.request(() => this.client.getFileContents(webDavPath(key), { format: 'binary', signal }), signal));
  }

  async hashFile(key: string, signal?: AbortSignal): Promise<string> {
    return this.request(async () => {
      const hash = createHash('sha256');
      const stream = this.client.createReadStream(webDavPath(key), { signal });
      for await (const chunk of stream) hash.update(chunk as Buffer);
      return hash.digest('hex');
    }, signal);
  }

  async downloadFile(key: string, destination: string, signal?: AbortSignal): Promise<void> {
    const contents = await this.readFile(key, signal);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
    throwIfCancelled(signal);
  }

  async move(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    const parent = normalizeStorageKey(destination).split('/').slice(0, -1).join('/');
    if (parent) await this.createDirectory(parent, signal);
    await this.requestOnce(() => this.client.moveFile(webDavPath(source), webDavPath(destination), { overwrite: false, signal }));
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    storageSegments(key);
    if (normalizeStorageKey(key) === '') throw new Error('SoloSync will not delete the QNAP backup folder root.');
    if (await this.exists(key, signal)) {
      await this.requestOnce(() => this.client.deleteFile(webDavPath(key), { signal }));
    }
  }
}
