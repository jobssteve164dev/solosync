import { createHash, randomUUID } from 'node:crypto';
import { readFile as readLocalFile } from 'node:fs/promises';
import { normalizeStorageKey, StorageEntry, StorageProvider } from './storageProvider';

export interface GoogleDriveItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  createdTime?: string;
  size?: string;
  trashed?: boolean;
}

export interface GoogleDriveApi {
  about(signal?: AbortSignal): Promise<{ user: { permissionId?: string; displayName?: string; emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }>;
  generateId(signal?: AbortSignal): Promise<string>;
  listFolders(properties?: Record<string, string>, signal?: AbortSignal): Promise<GoogleDriveItem[]>;
  listChildren(parentId: string, properties?: Record<string, string>, signal?: AbortSignal): Promise<GoogleDriveItem[]>;
  createFolder(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, signal?: AbortSignal): Promise<GoogleDriveItem>;
  uploadFile(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, source: string | Buffer, signal?: AbortSignal): Promise<GoogleDriveItem>;
  get(id: string, signal?: AbortSignal): Promise<GoogleDriveItem | undefined>;
  update(id: string, patch: { name?: string; appProperties?: Record<string, string>; addParent?: string; removeParent?: string }, signal?: AbortSignal): Promise<GoogleDriveItem>;
  readFile(id: string, signal?: AbortSignal): Promise<Buffer>;
  hashFile(id: string, signal?: AbortSignal): Promise<string>;
  forgetUpload(id: string, projectId: string): Promise<void>;
  downloadFile(id: string, destination: string, signal?: AbortSignal): Promise<void>;
  trash(id: string, signal?: AbortSignal): Promise<void>;
}

export interface GoogleDriveStableIds {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const folderMimeType = 'application/vnd.google-apps.folder';

function logicalHash(key: string): string {
  const segments = normalizeStorageKey(key).split('/');
  if (segments.length >= 4 && (segments[2] === 'staging' || segments[2] === 'snapshots')) segments[2] = 'snapshot';
  return createHash('sha256').update(segments.join('/'), 'utf8').digest('hex');
}

function properties(role: string, key: string, projectId = '', snapshotId = '', lifecycle = ''): Record<string, string> {
  return Object.fromEntries(Object.entries({
    product: 'solosync', role, format: '1', projectId, snapshotId, logicalKeyHash: logicalHash(key), lifecycle,
  }).filter(([, value]) => value));
}

function canonical(items: GoogleDriveItem[]): GoogleDriveItem | undefined {
  return [...items].sort((left, right) => (left.createdTime ?? '').localeCompare(right.createdTime ?? '') || left.id.localeCompare(right.id))[0];
}

function accountRootKey(account: { permissionId: string }): string {
  return `google-drive-root-id:${createHash('sha256').update(account.permissionId).digest('hex')}`;
}

async function createFolderReconciled(
  api: GoogleDriveApi,
  item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> },
  signal?: AbortSignal,
): Promise<GoogleDriveItem> {
  try {
    return await api.createFolder(item, signal);
  } catch (error) {
    const existing = await api.get(item.id, signal).catch(() => undefined);
    const matches = existing?.mimeType === folderMimeType
      && existing.name === item.name
      && item.parents.every((parent) => existing.parents.includes(parent))
      && Object.entries(item.appProperties).every(([key, value]) => existing.appProperties[key] === value);
    if (matches) return existing;
    throw error;
  }
}

async function archiveMergedFolder(api: GoogleDriveApi, duplicate: GoogleDriveItem, role: string, signal?: AbortSignal): Promise<void> {
  await api.update(duplicate.id, {
    name: 'Recovered from duplicate SoloSync setup',
    appProperties: { ...duplicate.appProperties, role },
  }, signal);
}

function parseKey(key: string): string[] {
  const normalized = normalizeStorageKey(key);
  const segments = normalized ? normalized.split('/') : [];
  if (segments[0] !== 'SoloSync') throw new Error('Google Drive paths must stay inside SoloSync.');
  return segments;
}

export class GoogleDriveProvider implements StorageProvider {
  readonly displayName: string;
  readonly destinationIdentity: string;

  private constructor(
    private readonly api: GoogleDriveApi,
    readonly rootId: string,
    readonly account: { permissionId: string; displayName?: string; emailAddress?: string },
    private readonly stableIds?: GoogleDriveStableIds,
  ) {
    this.displayName = account.emailAddress || account.displayName || 'Google Drive';
    this.destinationIdentity = `${accountRootKey(account)}:${rootId}`;
  }

  static async connect(api: GoogleDriveApi, stableIds?: GoogleDriveStableIds, signal?: AbortSignal): Promise<GoogleDriveProvider> {
    const about = await api.about(signal);
    const permissionId = about.user.permissionId?.trim();
    if (!permissionId) throw new Error('Google Drive did not provide a stable account identity. Sign in with a Google account that allows Drive identity access.');
    const account = { ...about.user, permissionId };
    const rootStableKey = accountRootKey(account);
    let roots = await api.listFolders({ product: 'solosync', role: 'root', format: '1' }, signal);
    const savedRootId = await stableIds?.get(rootStableKey);
    const savedRoot = savedRootId ? await api.get(savedRootId, signal) : undefined;
    const validSavedRoot = savedRoot?.appProperties.product === 'solosync' && savedRoot.appProperties.role === 'root' && savedRoot.appProperties.format === '1' && !savedRoot.trashed
      ? savedRoot
      : undefined;
    if (validSavedRoot && !roots.some((item) => item.id === validSavedRoot.id)) {
      roots.push(validSavedRoot);
    }
    if (roots.length === 0) {
      const stableKey = `google-drive-folder-id:${logicalHash('SoloSync')}`;
      let id = await stableIds?.get(stableKey);
      if (!id) {
        id = await api.generateId(signal);
        await stableIds?.store(stableKey, id);
      }
      await createFolderReconciled(api, { id, name: 'SoloSync Backups', parents: ['root'], appProperties: properties('root', 'SoloSync') }, signal);
      roots = await api.listFolders({ product: 'solosync', role: 'root', format: '1' }, signal);
    }
    const root = canonical(roots);
    if (!root) throw new Error('SoloSync could not create its Google Drive folder.');
    await stableIds?.store(rootStableKey, root.id);
    await stableIds?.delete(`google-drive-folder-id:${logicalHash('SoloSync')}`);
    const allProjects = (await Promise.all(roots.map((candidate) => api.listChildren(candidate.id, { product: 'solosync', role: 'project', format: '1' }, signal)))).flat();
    const projectIds = [...new Set(allProjects.map((item) => item.appProperties.projectId).filter(Boolean))];
    for (const projectId of projectIds) {
      const matches = allProjects.filter((item) => item.appProperties.projectId === projectId);
      let primary = canonical(matches.filter((item) => item.parents.includes(root.id)));
      if (!primary) {
        const key = `SoloSync/${projectId}`;
        const stableKey = `google-drive-folder-id:${projectId}:${logicalHash(key)}`;
        let id = await stableIds?.get(stableKey);
        if (!id) {
          id = await api.generateId(signal);
          await stableIds?.store(stableKey, id);
        }
        primary = await createFolderReconciled(api, {
          id,
          name: canonical(matches)?.name ?? projectId,
          parents: [root.id],
          appProperties: properties('project', key, projectId),
        }, signal);
        await stableIds?.delete(stableKey);
      }
      const knownSnapshots = await api.listChildren(primary.id, { product: 'solosync', role: 'snapshot', projectId, format: '1' }, signal);
      for (const duplicate of matches.filter((item) => item.id !== primary.id)) {
        const snapshots = await api.listChildren(duplicate.id, { product: 'solosync', role: 'snapshot', projectId, format: '1' }, signal);
        for (const snapshot of snapshots) {
          if (knownSnapshots.some((item) => item.appProperties.snapshotId === snapshot.appProperties.snapshotId && item.id !== snapshot.id)) {
            throw new Error(`Google Drive contains conflicting copies of snapshot ${snapshot.appProperties.snapshotId}.`);
          }
          await api.update(snapshot.id, { addParent: primary.id, removeParent: duplicate.id }, signal);
          knownSnapshots.push(snapshot);
        }
        await archiveMergedFolder(api, duplicate, 'merged-project', signal);
      }
    }
    for (const duplicate of roots.filter((item) => item.id !== root.id)) {
      await archiveMergedFolder(api, duplicate, 'merged-root', signal);
    }
    return new GoogleDriveProvider(api, root.id, account, stableIds);
  }

  private async project(projectId: string, create: boolean, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const key = `SoloSync/${projectId}`;
    const stableKey = `google-drive-folder-id:${projectId}:${logicalHash(key)}`;
    let projects = await this.api.listChildren(this.rootId, { product: 'solosync', role: 'project', projectId, format: '1' }, signal);
    if (projects.length === 0 && create) {
      let id = await this.stableIds?.get(stableKey);
      if (!id) {
        id = await this.api.generateId(signal);
        await this.stableIds?.store(stableKey, id);
      }
      await createFolderReconciled(this.api, { id, name: projectId, parents: [this.rootId], appProperties: properties('project', key, projectId) }, signal);
      projects = await this.api.listChildren(this.rootId, { product: 'solosync', role: 'project', projectId, format: '1' }, signal);
    }
    if (projects.length > 0) await this.stableIds?.delete(stableKey);
    return canonical(projects);
  }

  private async snapshots(projectId: string, lifecycle?: string, signal?: AbortSignal): Promise<GoogleDriveItem[]> {
    const project = await this.project(projectId, false, signal);
    if (!project) return [];
    const filter: Record<string, string> = { product: 'solosync', role: 'snapshot', projectId, format: '1' };
    if (lifecycle) filter.lifecycle = lifecycle;
    return this.api.listChildren(project.id, filter, signal);
  }

  private async snapshot(projectId: string, snapshotId: string, create = false, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    let snapshots = (await this.snapshots(projectId, undefined, signal)).filter((item) => item.appProperties.snapshotId === snapshotId);
    if (snapshots.length > 1) throw new Error(`Google Drive contains conflicting copies of snapshot ${snapshotId}.`);
    if (snapshots.length === 0 && create) {
      const project = await this.project(projectId, true, signal);
      if (!project) throw new Error('SoloSync could not create the Google Drive project folder.');
      const key = `SoloSync/${projectId}/staging/${snapshotId}`;
      const stableKey = `google-drive-folder-id:${projectId}:${logicalHash(key)}`;
      let id = await this.stableIds?.get(stableKey);
      if (!id) {
        id = await this.api.generateId(signal);
        await this.stableIds?.store(stableKey, id);
      }
      await createFolderReconciled(this.api, { id, name: snapshotId, parents: [project.id], appProperties: properties('snapshot', key, projectId, snapshotId, 'staging') }, signal);
      snapshots = (await this.snapshots(projectId, undefined, signal)).filter((item) => item.appProperties.snapshotId === snapshotId);
      if (snapshots.length > 0) await this.stableIds?.delete(stableKey);
    }
    return canonical(snapshots);
  }

  private async resolve(key: string, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const segments = parseKey(key);
    if (segments.length === 1) return this.api.get(this.rootId, signal);
    const project = await this.project(segments[1], false, signal);
    if (segments.length === 2) return project;
    if (!project) return undefined;
    if (segments.length === 3 && (segments[2] === 'staging' || segments[2] === 'snapshots')) return project;
    if (!['staging', 'snapshots'].includes(segments[2]) || !segments[3]) return undefined;
    let current = await this.snapshot(segments[1], segments[3], false, signal);
    if (!current || (segments[2] === 'staging' ? current.appProperties.lifecycle !== 'staging' : current.appProperties.lifecycle !== 'committed')) return undefined;
    for (let index = 4; index < segments.length; index += 1) {
      const currentKey = segments.slice(0, index + 1).join('/');
      const matches = await this.api.listChildren(current.id, { product: 'solosync', logicalKeyHash: logicalHash(currentKey) }, signal);
      if (matches.length > 1) throw new Error(`Google Drive contains conflicting copies of ${segments[index]}.`);
      current = canonical(matches);
      if (!current) return undefined;
    }
    return current;
  }

  async validate(signal?: AbortSignal): Promise<void> {
    await this.api.about(signal);
    if (!(await this.api.get(this.rootId, signal))) throw new Error('The SoloSync Backups folder is no longer available.');
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    const projectId = `.connection-test-${randomUUID()}`;
    const snapshotId = randomUUID();
    try {
      await this.createDirectory(`SoloSync/${projectId}/staging/${snapshotId}`, signal);
      await this.writeFile(`SoloSync/${projectId}/staging/${snapshotId}/marker.txt`, Buffer.from('SoloSync Google Drive connection test\n'), signal);
      await this.move(`SoloSync/${projectId}/staging/${snapshotId}`, `SoloSync/${projectId}/snapshots/${snapshotId}`, signal);
      if ((await this.readFile(`SoloSync/${projectId}/snapshots/${snapshotId}/marker.txt`, signal)).toString() !== 'SoloSync Google Drive connection test\n') {
        throw new Error('Google Drive returned different data after upload.');
      }
    } finally {
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), 10_000);
      try {
        const project = await this.project(projectId, false, cleanupController.signal);
        if (project) await this.api.trash(project.id, cleanupController.signal);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  }

  async exists(key: string, signal?: AbortSignal): Promise<boolean> {
    const segments = parseKey(key);
    if (segments.length === 3 && ['staging', 'snapshots'].includes(segments[2])) return Boolean(await this.project(segments[1], false, signal));
    return Boolean(await this.resolve(key, signal));
  }

  async list(key: string, signal?: AbortSignal): Promise<StorageEntry[]> {
    const segments = parseKey(key);
    if (segments.length === 1) {
      const projects = await this.api.listChildren(this.rootId, { product: 'solosync', role: 'project', format: '1' }, signal);
      const ids = [...new Set(projects.map((item) => item.appProperties.projectId))].sort();
      return ids.map((name) => ({ name, type: 'directory' }));
    }
    if (segments.length === 3 && ['staging', 'snapshots'].includes(segments[2])) {
      const lifecycle = segments[2] === 'staging' ? 'staging' : 'committed';
      const items = await this.snapshots(segments[1], lifecycle, signal);
      return items.map((item): StorageEntry => ({ name: item.appProperties.snapshotId, type: 'directory' })).sort((a, b) => a.name.localeCompare(b.name));
    }
    const parent = await this.resolve(key, signal);
    if (!parent) throw new Error('The Google Drive backup folder was not found.');
    const items = await this.api.listChildren(parent.id, { product: 'solosync' }, signal);
    return items.map((item): StorageEntry => ({ name: item.name, type: item.mimeType === folderMimeType ? 'directory' : 'file' }));
  }

  async createDirectory(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('The operation was canceled.');
    const segments = parseKey(key);
    if (segments.length === 1) return;
    await this.project(segments[1], true, signal);
    if (segments.length <= 3) return;
    const snapshot = await this.snapshot(segments[1], segments[3], true, signal);
    if (!snapshot) throw new Error('SoloSync could not create the Google Drive snapshot folder.');
    if (segments.length === 4) return;
    let parent = snapshot;
    for (let index = 4; index < segments.length; index += 1) {
      const currentKey = segments.slice(0, index + 1).join('/');
      const stableKey = `google-drive-folder-id:${segments[1]}:${logicalHash(currentKey)}`;
      const matches = await this.api.listChildren(parent.id, { product: 'solosync', logicalKeyHash: logicalHash(currentKey) }, signal);
      let directory = canonical(matches);
      if (!directory) {
        let id = await this.stableIds?.get(stableKey);
        if (!id) {
          id = await this.api.generateId(signal);
          await this.stableIds?.store(stableKey, id);
        }
        directory = await createFolderReconciled(this.api, {
          id,
          name: segments[index],
          parents: [parent.id],
          appProperties: properties('directory', currentKey, segments[1], segments[3], snapshot.appProperties.lifecycle),
        }, signal);
      }
      await this.stableIds?.delete(stableKey);
      parent = directory;
    }
  }

  async writeFile(key: string, source: string | Buffer, signal?: AbortSignal): Promise<void> {
    const segments = parseKey(key);
    if (segments.length === 3 && segments[2] === 'project.json') return;
    const parentKey = segments.slice(0, -1).join('/');
    await this.createDirectory(parentKey, signal);
    const parent = await this.resolve(parentKey, signal);
    if (!parent) throw new Error('SoloSync could not resolve the Google Drive parent folder.');
    const existing = await this.resolve(key, signal);
    if (existing) throw new Error('A Google Drive snapshot file already exists for this backup path.');
    const stableKey = `google-drive-file-id:${segments[1]}:${logicalHash(key)}`;
    let id = await this.stableIds?.get(stableKey);
    if (!id) {
      id = await this.api.generateId(signal);
      await this.stableIds?.store(stableKey, id);
    }
    const snapshotId = segments[3] ?? '';
    const projectId = segments[1] ?? '';
    const snapshot = snapshotId ? await this.snapshot(projectId, snapshotId, false, signal) : undefined;
    await this.api.uploadFile({
      id,
      name: segments.at(-1)!,
      parents: [parent.id],
      appProperties: properties('file', key, projectId, snapshotId, snapshot?.appProperties.lifecycle ?? ''),
    }, source, signal);
    await this.stableIds?.delete(stableKey);
    if (segments.at(-1) === 'manifest.json') {
      try {
        const contents = Buffer.isBuffer(source) ? source : await readLocalFile(source);
        const manifest = JSON.parse(contents.toString('utf8')) as { projectName?: string };
        const project = await this.project(projectId, false, signal);
        if (project && manifest.projectName) await this.api.update(project.id, { name: manifest.projectName }, signal);
      } catch {
        // Manifest validation remains the repository's responsibility.
      }
    }
  }

  async readFile(key: string, signal?: AbortSignal): Promise<Buffer> {
    const item = await this.resolve(key, signal);
    if (!item || item.mimeType === folderMimeType) throw new Error('The Google Drive backup file was not found.');
    return this.api.readFile(item.id, signal);
  }

  async hashFile(key: string, signal?: AbortSignal): Promise<string> {
    const item = await this.resolve(key, signal);
    if (!item || item.mimeType === folderMimeType) throw new Error('The Google Drive backup file was not found.');
    const digest = await this.api.hashFile(item.id, signal);
    await this.api.forgetUpload(item.id, item.appProperties.projectId);
    await this.stableIds?.delete(`google-drive-file-id:${item.appProperties.projectId}:${logicalHash(key)}`);
    return digest;
  }

  async downloadFile(key: string, destination: string, signal?: AbortSignal): Promise<void> {
    const item = await this.resolve(key, signal);
    if (!item || item.mimeType === folderMimeType) throw new Error('The Google Drive backup file was not found.');
    await this.api.downloadFile(item.id, destination, signal);
  }

  async move(source: string, destination: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('The operation was canceled.');
    const sourceSegments = parseKey(source);
    const destinationSegments = parseKey(destination);
    if (sourceSegments.length !== 4 || destinationSegments.length !== 4 || sourceSegments[2] !== 'staging' || destinationSegments[2] !== 'snapshots' || sourceSegments[1] !== destinationSegments[1] || sourceSegments[3] !== destinationSegments[3]) {
      throw new Error('Google Drive only publishes complete SoloSync snapshot folders.');
    }
    const snapshot = await this.snapshot(sourceSegments[1], sourceSegments[3], false, signal);
    if (!snapshot) throw new Error('The Google Drive staging snapshot was not found.');
    await this.api.update(snapshot.id, {
      name: destinationSegments[3],
      appProperties: { ...snapshot.appProperties, lifecycle: 'committed', logicalKeyHash: logicalHash(destination) },
    }, signal);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('The operation was canceled.');
    const segments = parseKey(key);
    if (segments.length === 1) throw new Error('SoloSync will not delete the Google Drive backup root.');
    const item = await this.resolve(key, signal);
    if (item && item.id !== this.rootId) await this.api.trash(item.id, signal);
  }
}
