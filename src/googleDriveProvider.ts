import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile as readLocalFile, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeStorageKey, StorageEntry, StorageFileExpectation, StorageFileStatus, StorageProvider, StorageVisibleFileExpectation } from './storageProvider';

export interface GoogleDriveItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  createdTime?: string;
  size?: string;
  sha256Checksum?: string;
  trashed?: boolean;
}

export interface GoogleDriveApi {
  about(signal?: AbortSignal): Promise<{ user: { permissionId?: string; displayName?: string; emailAddress?: string } }>;
  generateId(signal?: AbortSignal): Promise<string>;
  listFiles(properties?: Record<string, string>, signal?: AbortSignal): Promise<GoogleDriveItem[]>;
  listFolders(properties?: Record<string, string>, signal?: AbortSignal): Promise<GoogleDriveItem[]>;
  listChildren(parentId: string, properties?: Record<string, string>, signal?: AbortSignal): Promise<GoogleDriveItem[]>;
  createFolder(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, signal?: AbortSignal): Promise<GoogleDriveItem>;
  uploadFile(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, source: string | Buffer, signal?: AbortSignal): Promise<GoogleDriveItem>;
  replaceFile(item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> }, source: string | Buffer, signal?: AbortSignal): Promise<GoogleDriveItem>;
  get(id: string, signal?: AbortSignal): Promise<GoogleDriveItem | undefined>;
  update(id: string, patch: { name?: string; appProperties?: Record<string, string>; addParent?: string; removeParent?: string; trashed?: boolean }, signal?: AbortSignal): Promise<GoogleDriveItem>;
  readFile(id: string, signal?: AbortSignal): Promise<Buffer>;
  hashFile(id: string, signal?: AbortSignal): Promise<string>;
  forgetUpload(id: string, projectId: string, contentSha256?: string): Promise<void>;
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

function visiblePathHash(displayPath: string): string {
  return createHash('sha256').update(normalizeStorageKey(displayPath), 'utf8').digest('hex');
}

function archivedObjectName(item: GoogleDriveItem): string {
  const parsed = path.parse(item.name);
  const hash = item.appProperties.contentSha256 ?? item.sha256Checksum ?? item.id;
  return `${parsed.name}.${hash.slice(0, 8)}${parsed.ext}`;
}

async function createFolderReconciled(
  api: GoogleDriveApi,
  item: { id: string; name: string; parents: string[]; appProperties: Record<string, string> },
  signal?: AbortSignal,
): Promise<{ item: GoogleDriveItem; created: boolean }> {
  try {
    return { item: await api.createFolder(item, signal), created: true };
  } catch (error) {
    const existing = await api.get(item.id, signal).catch(() => undefined);
    const matches = existing?.mimeType === folderMimeType
      && existing.name === item.name
      && item.parents.every((parent) => existing.parents.includes(parent))
      && Object.entries(item.appProperties).every(([key, value]) => existing.appProperties[key] === value);
    if (matches) return { item: existing, created: false };
    throw error;
  }
}

async function archiveMergedFolder(api: GoogleDriveApi, duplicate: GoogleDriveItem, role: string, signal?: AbortSignal): Promise<void> {
  await api.update(duplicate.id, {
    name: 'Recovered from duplicate SoloSync setup',
    appProperties: { ...duplicate.appProperties, role },
  }, signal);
}

async function reconcileHistoryCopies(
  api: GoogleDriveApi,
  root: GoogleDriveItem,
  histories: GoogleDriveItem[],
  signal?: AbortSignal,
): Promise<GoogleDriveItem | undefined> {
  let primary = canonical(histories.filter((item) => item.parents.includes(root.id) && item.appProperties.role === 'history'))
    ?? canonical(histories.filter((item) => item.appProperties.role === 'history'))
    ?? canonical(histories);
  if (!primary) return undefined;
  if (primary.appProperties.role !== 'history') {
    primary = await api.update(primary.id, {
      name: 'Backup History',
      appProperties: { ...primary.appProperties, role: 'history' },
    }, signal);
  }
  if (histories.length === 1 && primary.parents.includes(root.id)) return primary;
  if (!primary.parents.includes(root.id)) {
    primary = await api.update(primary.id, { addParent: root.id, removeParent: primary.parents[0] }, signal);
  }
  const knownRecords = await api.listChildren(primary.id, { product: 'solosync', role: 'snapshot', format: '2' }, signal);
  for (const duplicate of histories.filter((item) => item.id !== primary.id)) {
    const records = await api.listChildren(duplicate.id, { product: 'solosync', role: 'snapshot', format: '2' }, signal);
    for (const record of records) {
      const existing = knownRecords.find((item) => item.appProperties.projectId === record.appProperties.projectId
        && item.appProperties.snapshotId === record.appProperties.snapshotId);
      if (existing) {
        const [existingHash, duplicateHash] = await Promise.all([api.hashFile(existing.id, signal), api.hashFile(record.id, signal)]);
        if (existingHash !== duplicateHash) throw new Error(`Google Drive contains conflicting copies of snapshot ${record.appProperties.snapshotId}.`);
        if (![existing.appProperties.lifecycle, record.appProperties.lifecycle].every((value) => ['staging', 'committed'].includes(value))) {
          throw new Error(`Google Drive contains an invalid copy of snapshot ${record.appProperties.snapshotId}.`);
        }
        const existingCommitted = existing.appProperties.lifecycle === 'committed';
        const duplicateCommitted = record.appProperties.lifecycle === 'committed';
        if (existingCommitted === duplicateCommitted) {
          await api.trash(record.id, signal);
        } else if (duplicateCommitted) {
          await api.update(record.id, { addParent: primary.id, removeParent: duplicate.id }, signal);
          await api.trash(existing.id, signal);
          knownRecords.splice(knownRecords.indexOf(existing), 1, record);
        } else {
          await api.trash(record.id, signal);
        }
      } else {
        await api.update(record.id, { addParent: primary.id, removeParent: duplicate.id }, signal);
        knownRecords.push(record);
      }
    }
    await archiveMergedFolder(api, duplicate, 'merged-history', signal);
  }
  return primary;
}

async function sourceHash(source: string | Buffer): Promise<string> {
  const hash = createHash('sha256');
  if (Buffer.isBuffer(source)) return hash.update(source).digest('hex');
  for await (const chunk of createReadStream(source)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function reconcileProjectCopies(api: GoogleDriveApi, projectId: string, projects: GoogleDriveItem[], signal?: AbortSignal, preferredPrimary?: GoogleDriveItem): Promise<GoogleDriveItem | undefined> {
  let primary = preferredPrimary ?? canonical(projects);
  if (!primary) return undefined;
  if (primary.appProperties.role !== 'project') {
    primary = await api.update(primary.id, {
      appProperties: { ...primary.appProperties, role: 'project' },
    }, signal);
  }
  const knownSnapshots = await api.listChildren(primary.id, { product: 'solosync', role: 'snapshot', projectId, format: '1' }, signal);
  const knownObjects = await api.listChildren(primary.id, { product: 'solosync', role: 'object', projectId, format: '1' }, signal);
  for (const duplicate of projects.filter((item) => item.id !== primary.id)) {
    const snapshots = await api.listChildren(duplicate.id, { product: 'solosync', role: 'snapshot', projectId, format: '1' }, signal);
    for (const snapshot of snapshots) {
      if (knownSnapshots.some((item) => item.appProperties.snapshotId === snapshot.appProperties.snapshotId && item.id !== snapshot.id)) {
        throw new Error(`Google Drive contains conflicting copies of snapshot ${snapshot.appProperties.snapshotId}.`);
      }
      await api.update(snapshot.id, { addParent: primary.id, removeParent: duplicate.id }, signal);
      knownSnapshots.push(snapshot);
    }
    const objects = await api.listChildren(duplicate.id, { product: 'solosync', role: 'object', projectId, format: '1' }, signal);
    for (const object of objects) {
      const existing = knownObjects.find((item) => item.appProperties.logicalKeyHash === object.appProperties.logicalKeyHash);
      if (existing) {
        const [existingHash, duplicateHash] = await Promise.all([api.hashFile(existing.id, signal), api.hashFile(object.id, signal)]);
        if (existingHash !== duplicateHash) {
          throw new Error(`Google Drive contains conflicting copies of content object ${object.name}.`);
        }
      } else {
        await api.update(object.id, { addParent: primary.id, removeParent: duplicate.id }, signal);
        knownObjects.push(object);
      }
    }
    await archiveMergedFolder(api, duplicate, 'merged-project', signal);
  }
  return primary;
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
  readonly rootId: string;
  readonly commitResponseIsAuthoritative = true;
  private readonly resolved = new Map<string, GoogleDriveItem | null>();
  private readonly knownEmptyDirectories = new Set<string>();
  private readonly preparedCompactSnapshots = new Set<string>();
  private validatedAt = Date.now();

  private constructor(
    private readonly api: GoogleDriveApi,
    root: GoogleDriveItem,
    readonly account: { permissionId: string; displayName?: string; emailAddress?: string },
    private readonly stableIds?: GoogleDriveStableIds,
    history?: GoogleDriveItem,
  ) {
    this.rootId = root.id;
    this.displayName = account.emailAddress || account.displayName || 'Google Drive';
    this.destinationIdentity = `${accountRootKey(account)}:${root.id}`;
    this.resolved.set('SoloSync', root);
    this.resolved.set('SoloSync/.history', history ?? null);
  }

  static async connect(api: GoogleDriveApi, stableIds?: GoogleDriveStableIds, signal?: AbortSignal): Promise<GoogleDriveProvider> {
    const about = await api.about(signal);
    const permissionId = about.user.permissionId?.trim();
    if (!permissionId) throw new Error('Google Drive did not provide a stable account identity. Sign in with a Google account that allows Drive identity access.');
    const account = { ...about.user, permissionId };
    const rootStableKey = accountRootKey(account);
    let roots = await api.listFolders({ product: 'solosync', role: 'root', format: '1' }, signal);
    const previouslyMergedRoots = await api.listFolders({ product: 'solosync', role: 'merged-root', format: '1' }, signal);
    const savedRootId = await stableIds?.get(rootStableKey);
    const savedRoot = savedRootId
      ? roots.find((candidate) => candidate.id === savedRootId) ?? await api.get(savedRootId, signal)
      : undefined;
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
      const { item: created } = await createFolderReconciled(api, { id, name: 'SoloSync Backups', parents: ['root'], appProperties: properties('root', 'SoloSync') }, signal);
      roots = await api.listFolders({ product: 'solosync', role: 'root', format: '1' }, signal);
      if (!roots.some((item) => item.id === created.id)) roots.push(created);
    }
    const root = canonical(roots);
    if (!root) throw new Error('SoloSync could not create its Google Drive folder.');
    const allRoots = [...new Map([...roots, ...previouslyMergedRoots].map((item) => [item.id, item])).values()];
    const histories = (await Promise.all(allRoots.flatMap((candidate) => [
      api.listChildren(candidate.id, { product: 'solosync', role: 'history', format: '2' }, signal),
      api.listChildren(candidate.id, { product: 'solosync', role: 'merged-history', format: '2' }, signal),
    ]))).flat();
    const history = await reconcileHistoryCopies(api, root, histories, signal);
    await stableIds?.store(rootStableKey, root.id);
    await stableIds?.delete(`google-drive-folder-id:${logicalHash('SoloSync')}`);
    if (allRoots.length > 1) {
      const allProjects = (await Promise.all(allRoots.flatMap((candidate) => [
        api.listChildren(candidate.id, { product: 'solosync', role: 'project', format: '1' }, signal),
        api.listChildren(candidate.id, { product: 'solosync', role: 'merged-project', format: '1' }, signal),
      ]))).flat();
      const projectIds = [...new Set(allProjects.map((item) => item.appProperties.projectId).filter(Boolean))];
      for (const projectId of projectIds) {
        let matches = allProjects.filter((item) => item.appProperties.projectId === projectId);
        let primary = canonical(matches.filter((item) => item.parents.includes(root.id) && item.appProperties.role === 'project'));
        if (!primary) {
          const key = `SoloSync/${projectId}`;
          const stableKey = `google-drive-folder-id:${projectId}:${logicalHash(key)}`;
          let id = await stableIds?.get(stableKey);
          if (!id) {
            id = await api.generateId(signal);
            await stableIds?.store(stableKey, id);
          }
          primary = (await createFolderReconciled(api, {
            id,
            name: canonical(matches)?.name ?? projectId,
            parents: [root.id],
            appProperties: properties('project', key, projectId),
          }, signal)).item;
          await stableIds?.delete(stableKey);
          matches = [primary, ...matches];
        }
        primary = await reconcileProjectCopies(api, projectId, matches, signal, primary) ?? primary;
      }
      for (const duplicate of roots.filter((item) => item.id !== root.id)) {
        await archiveMergedFolder(api, duplicate, 'merged-root', signal);
      }
    }
    return new GoogleDriveProvider(api, root, account, stableIds, history);
  }

  private async project(projectId: string, create: boolean, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const key = `SoloSync/${projectId}`;
    const stableKey = `google-drive-folder-id:${projectId}:${logicalHash(key)}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let projects = create && this.resolved.has(key)
      ? []
      : (await Promise.all([
        this.api.listChildren(this.rootId, { product: 'solosync', role: 'project', projectId, format: '1' }, signal),
        this.api.listChildren(this.rootId, { product: 'solosync', role: 'merged-project', projectId, format: '1' }, signal),
      ])).flat();
    if (!projects.some((item) => item.appProperties.role === 'project') && create) {
      let id = await this.stableIds?.get(stableKey);
      if (!id) {
        id = await this.api.generateId(signal);
        await this.stableIds?.store(stableKey, id);
      }
      const { item: created } = await createFolderReconciled(this.api, {
        id,
        name: projectId,
        parents: [this.rootId],
        appProperties: properties('project', key, projectId),
      }, signal);
      projects = await this.api.listChildren(this.rootId, { product: 'solosync', role: 'project', projectId, format: '1' }, signal);
      if (!projects.some((item) => item.id === created.id)) projects.push(created);
    }
    if (projects.length > 0) await this.stableIds?.delete(stableKey);
    const active = canonical(projects.filter((item) => item.appProperties.role === 'project'));
    const project = projects.length > 1 ? await reconcileProjectCopies(this.api, projectId, projects, signal, active) : active;
    this.resolved.set(key, project ?? null);
    return project;
  }

  private async history(create: boolean, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const key = 'SoloSync/.history';
    const cached = this.resolved.get(key);
    if (cached) return cached;
    let histories = create && this.resolved.has(key)
      ? []
      : (await Promise.all([
        this.api.listChildren(this.rootId, { product: 'solosync', role: 'history', format: '2' }, signal),
        this.api.listChildren(this.rootId, { product: 'solosync', role: 'merged-history', format: '2' }, signal),
      ])).flat();
    const stableKey = `google-drive-folder-id:${logicalHash(key)}`;
    if (histories.length === 0 && create) {
      let id = await this.stableIds?.get(stableKey);
      if (!id) {
        id = await this.api.generateId(signal);
        await this.stableIds?.store(stableKey, id);
      }
      const { item: created } = await createFolderReconciled(this.api, {
        id,
        name: 'Backup History',
        parents: [this.rootId],
        appProperties: { ...properties('history', key), format: '2' },
      }, signal);
      histories = (await Promise.all([
        this.api.listChildren(this.rootId, { product: 'solosync', role: 'history', format: '2' }, signal),
        this.api.listChildren(this.rootId, { product: 'solosync', role: 'merged-history', format: '2' }, signal),
      ])).flat();
      if (!histories.some((item) => item.id === created.id)) histories.push(created);
    }
    const root = this.resolved.get('SoloSync');
    if (!root) throw new Error('The SoloSync Backups folder is no longer available.');
    const primary = await reconcileHistoryCopies(this.api, root, histories, signal);
    if (primary) await this.stableIds?.delete(stableKey);
    this.resolved.set(key, primary ?? null);
    return primary;
  }

  private async versionHistory(create: boolean, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const key = 'SoloSync/.history/versions';
    const cached = this.resolved.get(key);
    if (cached) return cached;
    const history = await this.history(create, signal);
    if (!history) return undefined;
    let folders = create && this.resolved.has(key)
      ? []
      : (await Promise.all([
        this.api.listChildren(history.id, { product: 'solosync', role: 'version-history', format: '2' }, signal),
        this.api.listChildren(history.id, { product: 'solosync', role: 'merged-version-history', format: '2' }, signal),
      ])).flat();
    const stableKey = `google-drive-folder-id:${logicalHash(key)}`;
    if (!folders.some((item) => item.appProperties.role === 'version-history') && create) {
      let id = await this.stableIds?.get(stableKey);
      if (!id) {
        id = await this.api.generateId(signal);
        await this.stableIds?.store(stableKey, id);
      }
      const { item: created } = await createFolderReconciled(this.api, {
        id,
        name: 'Previous File Versions',
        parents: [history.id],
        appProperties: { ...properties('version-history', key), format: '2' },
      }, signal);
      folders = (await Promise.all([
        this.api.listChildren(history.id, { product: 'solosync', role: 'version-history', format: '2' }, signal),
        this.api.listChildren(history.id, { product: 'solosync', role: 'merged-version-history', format: '2' }, signal),
      ])).flat();
      if (!folders.some((item) => item.id === created.id)) folders.push(created);
    }
    let primary = canonical(folders.filter((item) => item.appProperties.role === 'version-history')) ?? canonical(folders);
    if (!primary) return undefined;
    if (primary.appProperties.role !== 'version-history') {
      primary = await this.api.update(primary.id, { name: 'Previous File Versions', appProperties: { ...primary.appProperties, role: 'version-history' } }, signal);
    }
    for (const duplicate of folders.filter((item) => item.id !== primary.id)) {
      const items = await this.api.listChildren(duplicate.id, { product: 'solosync', role: 'object', format: '1' }, signal);
      for (const item of items) await this.api.update(item.id, { addParent: primary.id, removeParent: duplicate.id }, signal);
      await archiveMergedFolder(this.api, duplicate, 'merged-version-history', signal);
    }
    await this.stableIds?.delete(stableKey);
    this.resolved.set(key, primary);
    return primary;
  }

  private async snapshots(projectId: string, lifecycle?: string, signal?: AbortSignal): Promise<GoogleDriveItem[]> {
    const project = await this.project(projectId, false, signal);
    if (!project) return [];
    const legacyFilter: Record<string, string> = { product: 'solosync', role: 'snapshot', projectId, format: '1' };
    if (lifecycle) legacyFilter.lifecycle = lifecycle;
    const legacy = await this.api.listChildren(project.id, legacyFilter, signal);
    const history = await this.history(false, signal);
    if (!history) return legacy;
    const recordFilter: Record<string, string> = { product: 'solosync', role: 'snapshot', projectId, format: '2' };
    if (lifecycle) recordFilter.lifecycle = lifecycle;
    const records = await this.api.listChildren(history.id, recordFilter, signal);
    const seen = new Set<string>();
    for (const item of [...legacy, ...records]) {
      const snapshotId = item.appProperties.snapshotId;
      if (seen.has(snapshotId)) throw new Error(`Google Drive contains conflicting copies of snapshot ${snapshotId}.`);
      seen.add(snapshotId);
    }
    return [...legacy, ...records];
  }

  private async latestCommittedRecord(projectId: string, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const records = await this.api.listFiles({ product: 'solosync', role: 'snapshot', projectId, format: '2', lifecycle: 'committed' }, signal);
    const seen = new Set<string>();
    for (const item of records) {
      const snapshotId = item.appProperties.snapshotId;
      if (seen.has(snapshotId)) throw new Error(`Google Drive contains conflicting copies of snapshot ${snapshotId}.`);
      seen.add(snapshotId);
    }
    return records.sort((left, right) => (right.appProperties.snapshotId ?? '').localeCompare(left.appProperties.snapshotId ?? ''))[0];
  }

  private async snapshot(projectId: string, snapshotId: string, create = false, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const stagingKey = `SoloSync/${projectId}/staging/${snapshotId}`;
    const committedKey = `SoloSync/${projectId}/snapshots/${snapshotId}`;
    const cached = this.resolved.get(stagingKey) ?? this.resolved.get(committedKey);
    if (cached) return cached;
    const project = await this.project(projectId, create, signal);
    if (!project) return undefined;
    const history = await this.history(create, signal);
    const [legacy, records] = await Promise.all([
      this.api.listChildren(project.id, { product: 'solosync', role: 'snapshot', projectId, snapshotId, format: '1' }, signal),
      history ? this.api.listChildren(history.id, { product: 'solosync', role: 'snapshot', projectId, snapshotId, format: '2' }, signal) : Promise.resolve([]),
    ]);
    const snapshots = [...legacy, ...records];
    if (snapshots.length > 1) throw new Error(`Google Drive contains conflicting copies of snapshot ${snapshotId}.`);
    const snapshot = canonical(snapshots);
    if (snapshot) this.resolved.set(snapshot.appProperties.lifecycle === 'committed' ? committedKey : stagingKey, snapshot);
    return snapshot;
  }

  private async resolve(key: string, signal?: AbortSignal): Promise<GoogleDriveItem | undefined> {
    const segments = parseKey(key);
    const normalized = segments.join('/');
    const cached = this.resolved.get(normalized);
    if (cached || this.resolved.has(normalized)) return cached ?? undefined;
    if (segments.length === 1) return this.resolved.get('SoloSync') ?? undefined;
    const project = await this.project(segments[1], false, signal);
    if (segments.length === 2) return project;
    if (!project) return undefined;
    if (segments.length === 3 && ['objects', 'staging', 'snapshots'].includes(segments[2])) return project;
    if (segments[2] === 'objects' && segments.length === 4) {
      const matches = await this.api.listFiles({ product: 'solosync', role: 'object', projectId: segments[1], logicalKeyHash: logicalHash(normalized) }, signal);
      if (matches.length > 1) {
        const hashes = await Promise.all(matches.map((item) => this.api.hashFile(item.id, signal)));
        if (hashes.some((hash) => hash !== segments[3])) throw new Error(`Google Drive contains conflicting copies of content object ${segments[3]}.`);
        const primary = canonical(matches)!;
        await Promise.all(matches.filter((item) => item.id !== primary.id).map((item) => this.api.trash(item.id, signal)));
      }
      const object = canonical(matches);
      this.resolved.set(normalized, object ?? null);
      return object;
    }
    if (!['staging', 'snapshots'].includes(segments[2]) || !segments[3]) return undefined;
    let current = await this.snapshot(segments[1], segments[3], false, signal);
    if (!current || (segments[2] === 'staging' ? current.appProperties.lifecycle !== 'staging' : current.appProperties.lifecycle !== 'committed')) return undefined;
    if (current.mimeType !== folderMimeType) {
      if (segments.length === 4 || (segments.length === 5 && segments[4] === 'manifest.json')) {
        this.resolved.set(normalized, current);
        return current;
      }
      return undefined;
    }
    for (let index = 4; index < segments.length; index += 1) {
      const currentKey = segments.slice(0, index + 1).join('/');
      const matches = this.knownEmptyDirectories.has(current.id)
        ? []
        : await this.api.listChildren(current.id, { product: 'solosync', logicalKeyHash: logicalHash(currentKey) }, signal);
      if (matches.length > 1) throw new Error(`Google Drive contains conflicting copies of ${segments[index]}.`);
      current = canonical(matches);
      this.resolved.set(currentKey, current ?? null);
      if (!current) return undefined;
    }
    return current;
  }

  async reconcileFiles(files: StorageFileExpectation[], signal?: AbortSignal): Promise<Map<string, StorageFileStatus>> {
    const result = new Map<string, StorageFileStatus>();
    if (files.length === 0) return result;
    const parsed = files.map((file) => ({ file, segments: parseKey(file.key) }));
    const projectId = parsed[0].segments[1];
    if (parsed.some(({ file, segments }) => segments.length !== 4 || segments[1] !== projectId || segments[2] !== 'objects' || segments[3] !== file.sha256)) {
      throw new Error('Google Drive can reconcile only content objects from one project.');
    }
    const project = await this.project(projectId, false, signal);
    if (!project) {
      for (const { file } of parsed) result.set(file.key, 'missing');
      return result;
    }
    const objects = await this.api.listFiles({ product: 'solosync', role: 'object', projectId, format: '1' }, signal);
    const byLogicalKey = new Map<string, GoogleDriveItem[]>();
    for (const object of objects) {
      const hash = object.appProperties.logicalKeyHash;
      if (!hash) continue;
      const matches = byLogicalKey.get(hash) ?? [];
      matches.push(object);
      byLogicalKey.set(hash, matches);
    }
    for (const { file } of parsed) {
      const matches = byLogicalKey.get(logicalHash(file.key)) ?? [];
      if (matches.length === 0) {
        if (!this.resolved.get(file.key)) this.resolved.set(file.key, null);
        result.set(file.key, 'missing');
        continue;
      }
      const hashes = await Promise.all(matches.map((item) => item.sha256Checksum ? Promise.resolve(item.sha256Checksum) : this.api.hashFile(item.id, signal)));
      if (matches.length > 1 && hashes.some((hash) => hash !== hashes[0])) {
        throw new Error(`Google Drive contains conflicting copies of content object ${file.sha256}.`);
      }
      let primary = canonical(matches)!;
      await Promise.all(matches.filter((item) => item.id !== primary.id).map((item) => this.api.trash(item.id, signal)));
      if (hashes[matches.indexOf(primary)] !== file.sha256) {
        this.resolved.set(file.key, primary);
        result.set(file.key, 'invalid');
        continue;
      }
      if (file.displayName && primary.name === file.sha256 && primary.name !== file.displayName) {
        primary = await this.api.update(primary.id, {
          name: file.displayName,
          appProperties: { ...primary.appProperties, contentSha256: file.sha256 },
        }, signal);
      }
      this.resolved.set(file.key, primary);
      result.set(file.key, 'valid');
    }
    return result;
  }

  private async currentParent(project: GoogleDriveItem, projectId: string, displayPath: string, signal?: AbortSignal): Promise<GoogleDriveItem> {
    const directories = normalizeStorageKey(displayPath).split('/').slice(0, -1);
    let parent = project;
    for (let index = 0; index < directories.length; index += 1) {
      const relativePath = directories.slice(0, index + 1).join('/');
      const cacheKey = `SoloSync/${projectId}/current-directories/${visiblePathHash(relativePath)}`;
      const cached = this.resolved.get(cacheKey);
      if (cached) {
        parent = cached;
        continue;
      }
      const pathHash = visiblePathHash(relativePath);
      let matches = await this.api.listChildren(parent.id, { product: 'solosync', role: 'current-directory', projectId, sourcePathHash: pathHash, format: '1' }, signal);
      if (matches.length === 0) {
        const stableKey = `google-drive-current-directory-id:${projectId}:${pathHash}`;
        let id = await this.stableIds?.get(stableKey);
        if (!id) {
          id = await this.api.generateId(signal);
          await this.stableIds?.store(stableKey, id);
        }
        const created = await createFolderReconciled(this.api, {
          id,
          name: directories[index],
          parents: [parent.id],
          appProperties: { ...properties('current-directory', cacheKey, projectId), sourcePathHash: pathHash },
        }, signal);
        matches = await this.api.listChildren(parent.id, { product: 'solosync', role: 'current-directory', projectId, sourcePathHash: pathHash, format: '1' }, signal);
        if (!matches.some((item) => item.id === created.item.id)) matches.push(created.item);
        await this.stableIds?.delete(stableKey);
      }
      const directory = canonical(matches)!;
      for (const duplicate of matches.filter((item) => item.id !== directory.id)) {
        const children = await this.api.listChildren(duplicate.id, { product: 'solosync' }, signal);
        for (const child of children) await this.api.update(child.id, { addParent: directory.id, removeParent: duplicate.id }, signal);
        await this.api.trash(duplicate.id, signal);
      }
      this.resolved.set(cacheKey, directory);
      parent = directory;
    }
    return parent;
  }

  private async archiveLegacySingleRootDirectory(project: GoogleDriveItem, projectId: string, rootName: string, signal?: AbortSignal): Promise<void> {
    const pathHash = visiblePathHash(rootName);
    const directories = (await this.api.listFolders({ product: 'solosync', role: 'current-directory', projectId, sourcePathHash: pathHash, format: '1' }, signal))
      .filter((item) => item.parents.includes(project.id));
    if (directories.length === 0) return;
    const history = await this.history(true, signal);
    if (!history) throw new Error('SoloSync could not prepare the Google Drive backup history.');
    for (const directory of directories) {
      const archived = await this.api.update(directory.id, {
        name: `Previous Folder Layout - ${directory.name}`,
        appProperties: { ...directory.appProperties, role: 'archived-current-directory', archived: '1' },
        addParent: history.id,
        removeParent: project.id,
      }, signal);
      for (const [key, cached] of this.resolved.entries()) {
        if (cached?.id === archived.id) this.resolved.delete(key);
      }
    }
  }

  private async reconcileCurrentLayout(project: GoogleDriveItem, projectId: string, rootNames: string[], signal?: AbortSignal): Promise<void> {
    const layout = rootNames.length === 1
      ? `single-root-direct:${visiblePathHash(rootNames[0])}`
      : 'multi-root-named:1';
    if (project.appProperties.currentLayout === layout) return;
    if (rootNames.length === 1) await this.archiveLegacySingleRootDirectory(project, projectId, rootNames[0], signal);
    const updated = await this.api.update(project.id, {
      appProperties: { ...project.appProperties, currentLayout: layout },
    }, signal);
    Object.assign(project, updated);
    for (const [key, cached] of this.resolved.entries()) {
      if (cached?.id === updated.id) this.resolved.set(key, updated);
    }
  }

  async syncVisibleFiles(files: StorageVisibleFileExpectation[], projectId: string, snapshotId: string, signal?: AbortSignal, rootNames?: string[], reconciliationDepth = 0): Promise<void> {
    const project = await this.project(projectId, true, signal);
    if (!project) throw new Error('SoloSync could not prepare the Google Drive current-file view.');
    const latestCommitted = await this.latestCommittedRecord(projectId, signal);
    if (latestCommitted && latestCommitted.appProperties.snapshotId !== snapshotId) return;
    let current = await this.api.listFiles({ product: 'solosync', role: 'current', projectId, format: '1' }, signal);
    if (rootNames && rootNames.length > 0) await this.reconcileCurrentLayout(project, projectId, rootNames, signal);
    let requiresConvergenceCheck = false;
    const removedCurrent = new Map<string, GoogleDriveItem>();
    const expectedPaths = new Set(files.map((file) => visiblePathHash(file.sourcePath ?? file.displayPath)));
    for (const file of [...files].sort((left, right) => left.displayPath.localeCompare(right.displayPath))) {
      const pathHash = visiblePathHash(file.sourcePath ?? file.displayPath);
      const parent = await this.currentParent(project, projectId, file.displayPath, signal);
      let matches = current.filter((item) => item.appProperties.sourcePathHash === pathHash);
      let visible = [...matches].sort((left, right) => (right.appProperties.snapshotId ?? '').localeCompare(left.appProperties.snapshotId ?? '') || left.id.localeCompare(right.id))[0];
      if (!visible) {
        const stableKey = `google-drive-current-id:${projectId}:${pathHash}`;
        let id = await this.stableIds?.get(stableKey);
        if (!id) {
          id = await this.api.generateId(signal);
          await this.stableIds?.store(stableKey, id);
        }
        visible = await this.api.uploadFile({
          id,
          name: file.displayName,
          parents: [parent.id],
          appProperties: { ...properties('current', `SoloSync/${projectId}/current/${pathHash}`, projectId, snapshotId), sourcePathHash: pathHash, contentSha256: file.sha256 },
        }, file.source, signal);
        await this.stableIds?.delete(stableKey);
        current.push(visible);
        const concurrent = await this.api.listFiles({ product: 'solosync', role: 'current', projectId, format: '1', sourcePathHash: pathHash }, signal);
        if (!concurrent.some((item) => item.id === visible!.id)) concurrent.push(visible);
        current = current.filter((item) => item.appProperties.sourcePathHash !== pathHash).concat(concurrent);
        matches = concurrent;
        visible = [...matches].sort((left, right) => (right.appProperties.snapshotId ?? '').localeCompare(left.appProperties.snapshotId ?? '') || left.id.localeCompare(right.id))[0];
      } else if ((visible.appProperties.snapshotId ?? '') <= snapshotId && (visible.appProperties.contentSha256 !== file.sha256 || visible.name !== file.displayName)) {
        const fresh = await this.api.get(visible.id, signal);
        if (fresh && (fresh.appProperties.snapshotId ?? '') > snapshotId) {
          visible = fresh;
        } else {
          await this.api.forgetUpload(visible.id, projectId, visible.appProperties.contentSha256);
          visible = await this.api.replaceFile({
            id: visible.id,
            name: file.displayName,
            parents: visible.parents,
            appProperties: { ...visible.appProperties, role: 'current', sourcePathHash: pathHash, contentSha256: file.sha256, snapshotId },
          }, file.source, signal);
          requiresConvergenceCheck = true;
          current.splice(current.findIndex((item) => item.id === visible!.id), 1, visible);
        }
      } else if ((visible.appProperties.snapshotId ?? '') < snapshotId) {
        visible = await this.api.update(visible.id, { appProperties: { ...visible.appProperties, snapshotId } }, signal);
        requiresConvergenceCheck = true;
        current.splice(current.findIndex((item) => item.id === visible!.id), 1, visible);
      }
      if (!visible.parents.includes(parent.id)) {
        visible = await this.api.update(visible.id, { addParent: parent.id, removeParent: visible.parents[0] }, signal);
        current.splice(current.findIndex((item) => item.id === visible!.id), 1, visible);
      }
      if ((visible.appProperties.snapshotId ?? '') <= snapshotId && (visible.sha256Checksum ?? await this.api.hashFile(visible.id, signal)) !== file.sha256) {
        throw new Error(`The Google Drive current copy of ${file.displayPath} failed verification.`);
      }
      for (const duplicate of matches.filter((item) => item.id !== visible!.id && (item.appProperties.snapshotId ?? '') <= (visible!.appProperties.snapshotId ?? ''))) {
        await this.api.trash(duplicate.id, signal);
        current = current.filter((item) => item.id !== duplicate.id);
      }
    }
    for (const obsolete of current.filter((item) => !expectedPaths.has(item.appProperties.sourcePathHash) && (item.appProperties.snapshotId ?? '') <= snapshotId)) {
      const fresh = await this.api.get(obsolete.id, signal);
      if (fresh && (fresh.appProperties.snapshotId ?? '') <= snapshotId) {
        await this.api.trash(obsolete.id, signal);
        requiresConvergenceCheck = true;
        removedCurrent.set(obsolete.appProperties.sourcePathHash, obsolete);
      }
    }
    const legacyObjects = await this.api.listChildren(project.id, { product: 'solosync', role: 'object', projectId, format: '1' }, signal);
    const versions = legacyObjects.length > 0 ? await this.versionHistory(true, signal) : undefined;
    if (legacyObjects.length > 0 && !versions) throw new Error('SoloSync could not prepare the Google Drive file history.');
    await Promise.all(legacyObjects.map(async (item) => {
      const moved = await this.api.update(item.id, {
        name: archivedObjectName(item),
        appProperties: { ...item.appProperties, archived: '1' },
        addParent: versions!.id,
        removeParent: project.id,
      }, signal);
      for (const [key, cached] of this.resolved.entries()) {
        if (cached?.id === moved.id) this.resolved.set(key, moved);
      }
    }));
    if (!requiresConvergenceCheck) return;
    const newestCommitted = await this.latestCommittedRecord(projectId, signal);
    if (!newestCommitted || newestCommitted.appProperties.snapshotId === snapshotId) return;
    if (reconciliationDepth >= 2) throw new Error('Google Drive kept receiving newer snapshots while SoloSync was updating the current-file view. Continue the latest backup to finish reconciliation.');
    if (newestCommitted.appProperties.format !== '2') return;
    const manifest = JSON.parse((await this.api.readFile(newestCommitted.id, signal)).toString('utf8')) as {
      roots?: string[];
      files?: Array<{ root?: string; path?: string; sha256?: string }>;
    };
    if (!Array.isArray(manifest.files)) throw new Error('The newest Google Drive snapshot manifest is invalid.');
    const latestPathHashes = new Set(manifest.files.map((file) => (
      typeof file.root === 'string' && typeof file.path === 'string'
        ? visiblePathHash(`${file.root}/${file.path}`)
        : ''
    )));
    if (removedCurrent.size > 0) {
      const stillVisible = await this.api.listFiles({ product: 'solosync', role: 'current', projectId, format: '1' }, signal);
      const visiblePaths = new Set(stillVisible.map((item) => item.appProperties.sourcePathHash));
      for (const [pathHash, item] of removedCurrent) {
        if (latestPathHashes.has(pathHash) && !visiblePaths.has(pathHash)) {
          await this.api.update(item.id, { trashed: false }, signal);
        }
      }
    }
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'solosync-current-reconcile-'));
    const temporaryFiles: string[] = [];
    try {
      const latestFiles: StorageVisibleFileExpectation[] = [];
      const showRoot = (manifest.roots?.length ?? 0) > 1;
      for (const [index, file] of manifest.files.entries()) {
        if (typeof file.root !== 'string' || typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
          throw new Error('The newest Google Drive snapshot contains an invalid file entry.');
        }
        const objectKey = `SoloSync/${projectId}/objects/${file.sha256}`;
        const object = await this.resolve(objectKey, signal);
        if (!object) throw new Error(`The newest Google Drive snapshot is missing ${file.path}.`);
        const source = path.join(temporaryDirectory, `${index}-${file.sha256}`);
        temporaryFiles.push(source);
        await this.api.downloadFile(object.id, source, signal);
        latestFiles.push({
          key: objectKey,
          sha256: file.sha256,
          displayName: path.posix.basename(file.path),
          displayPath: showRoot ? `${file.root}/${file.path}` : file.path,
          sourcePath: `${file.root}/${file.path}`,
          source,
        });
      }
      await this.syncVisibleFiles(latestFiles, projectId, newestCommitted.appProperties.snapshotId, signal, manifest.roots, reconciliationDepth + 1);
    } finally {
      let cleanupError: unknown;
      for (const file of temporaryFiles) {
        try {
          await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError ??= error;
        }
      }
      try {
        await rmdir(temporaryDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cleanupError ??= error;
      }
      if (cleanupError) throw cleanupError;
    }
  }

  async validate(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('The operation was canceled.');
    if (Date.now() - this.validatedAt < 60_000) return;
    const root = await this.api.get(this.rootId, signal);
    if (!root || root.trashed || root.appProperties.product !== 'solosync' || root.appProperties.role !== 'root') {
      throw new Error('The SoloSync Backups folder is no longer available.');
    }
    this.resolved.set('SoloSync', root);
    this.validatedAt = Date.now();
  }

  async testConnection(signal?: AbortSignal): Promise<void> {
    const projectId = `.connection-test-${randomUUID()}`;
    const snapshotId = randomUUID();
    try {
      await this.createDirectory(`SoloSync/${projectId}/staging/${snapshotId}`, signal);
      await this.writeFile(`SoloSync/${projectId}/staging/${snapshotId}/manifest.json`, Buffer.from(JSON.stringify({
        projectName: 'SoloSync connection test',
        createdAt: new Date().toISOString(),
        marker: 'SoloSync Google Drive connection test',
      })), signal);
      await this.move(`SoloSync/${projectId}/staging/${snapshotId}`, `SoloSync/${projectId}/snapshots/${snapshotId}`, signal);
      if (!JSON.parse((await this.readFile(`SoloSync/${projectId}/snapshots/${snapshotId}/manifest.json`, signal)).toString()).marker) {
        throw new Error('Google Drive returned different data after upload.');
      }
    } finally {
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), 10_000);
      try {
        await this.delete(`SoloSync/${projectId}/snapshots/${snapshotId}`, cleanupController.signal).catch(() => undefined);
        const project = await this.project(projectId, false, cleanupController.signal);
        if (project) await this.api.trash(project.id, cleanupController.signal);
      } finally {
        clearTimeout(cleanupTimer);
      }
    }
  }

  async exists(key: string, signal?: AbortSignal): Promise<boolean> {
    const segments = parseKey(key);
    if (segments.length === 3 && segments[2] === 'project.json') return false;
    if (segments.length === 3 && ['objects', 'staging', 'snapshots'].includes(segments[2])) return Boolean(await this.project(segments[1], false, signal));
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
    const project = await this.project(segments[1], true, signal);
    if (segments.length <= 3) return;
    if (segments.length === 4) {
      await this.history(true, signal);
      const stagingKey = segments.join('/');
      await this.snapshot(segments[1], segments[3], false, signal);
      const compact = this.resolved.get(stagingKey);
      if (!compact || compact.mimeType !== folderMimeType) {
        const stableKey = `google-drive-file-id:${segments[1]}:${logicalHash(`${stagingKey}/manifest.json`)}`;
        if (!await this.stableIds?.get(stableKey)) {
          const id = await this.api.generateId(signal);
          await this.stableIds?.store(stableKey, id);
        }
        this.preparedCompactSnapshots.add(stagingKey);
      }
      return;
    }
    const stagingKey = segments.slice(0, 4).join('/');
    let snapshot = await this.snapshot(segments[1], segments[3], false, signal);
    if (!snapshot) {
      if (!project) throw new Error('SoloSync could not resolve the Google Drive project folder.');
      const stableKey = `google-drive-folder-id:${segments[1]}:${logicalHash(stagingKey)}`;
      let id = await this.stableIds?.get(stableKey);
      if (!id) {
        id = await this.api.generateId(signal);
        await this.stableIds?.store(stableKey, id);
      }
      const reconciled = await createFolderReconciled(this.api, {
        id,
        name: segments[3],
        parents: [project.id],
        appProperties: properties('snapshot', stagingKey, segments[1], segments[3], 'staging'),
      }, signal);
      snapshot = reconciled.item;
      if (reconciled.created) this.knownEmptyDirectories.add(snapshot.id);
      this.resolved.set(stagingKey, snapshot);
      await this.stableIds?.delete(stableKey);
    }
    if (snapshot.mimeType !== folderMimeType) throw new Error('SoloSync could not resolve the legacy Google Drive snapshot folder.');
    let parent = snapshot;
    for (let index = 4; index < segments.length; index += 1) {
      const currentKey = segments.slice(0, index + 1).join('/');
      const stableKey = `google-drive-folder-id:${segments[1]}:${logicalHash(currentKey)}`;
      const cached = this.resolved.get(currentKey);
      let directory = cached ?? undefined;
      if (!directory && !this.resolved.has(currentKey)) {
        directory = canonical(await this.api.listChildren(parent.id, { product: 'solosync', logicalKeyHash: logicalHash(currentKey) }, signal));
      }
      if (!directory) {
        let id = await this.stableIds?.get(stableKey);
        if (!id) {
          id = await this.api.generateId(signal);
          await this.stableIds?.store(stableKey, id);
        }
        const reconciled = await createFolderReconciled(this.api, {
          id,
          name: segments[index],
          parents: [parent.id],
          appProperties: properties('directory', currentKey, segments[1], segments[3], snapshot.appProperties.lifecycle),
        }, signal);
        directory = reconciled.item;
        this.knownEmptyDirectories.delete(parent.id);
        if (reconciled.created) this.knownEmptyDirectories.add(directory.id);
      }
      await this.stableIds?.delete(stableKey);
      this.resolved.set(currentKey, directory);
      parent = directory;
    }
  }

  async writeFile(key: string, source: string | Buffer, signal?: AbortSignal): Promise<void> {
    const segments = parseKey(key);
    if (segments.length === 3 && segments[2] === 'project.json') return;
    const isSnapshotManifest = segments.length === 5 && segments[2] === 'staging' && segments[4] === 'manifest.json';
    if (isSnapshotManifest) {
      await this.project(segments[1], true, signal);
      const stagingKey = segments.slice(0, 4).join('/');
      const existingSnapshot = this.preparedCompactSnapshots.has(stagingKey)
        ? this.resolved.get(stagingKey) ?? undefined
        : await this.snapshot(segments[1], segments[3], false, signal);
      if (!existingSnapshot || existingSnapshot.mimeType !== folderMimeType) {
        const expectedHash = await sourceHash(source);
        if (existingSnapshot) {
          if (await this.api.hashFile(existingSnapshot.id, signal) !== expectedHash) {
            throw new Error('Google Drive contains different data for this backup path.');
          }
          this.resolved.set(segments.join('/'), existingSnapshot);
          this.preparedCompactSnapshots.delete(stagingKey);
          return;
        }
        const history = await this.history(true, signal);
        if (!history) throw new Error('SoloSync could not create the Google Drive backup history folder.');
        const stableKey = `google-drive-file-id:${segments[1]}:${logicalHash(key)}`;
        let id = await this.stableIds?.get(stableKey);
        if (!id) {
          id = await this.api.generateId(signal);
          await this.stableIds?.store(stableKey, id);
        }
        const projectId = segments[1];
        const snapshotId = segments[3];
        const record = await this.api.uploadFile({
          id,
          name: `${snapshotId}.json`,
          parents: [history.id],
          appProperties: { ...properties('snapshot', segments.slice(0, 4).join('/'), projectId, snapshotId, 'staging'), format: '2' },
        }, source, signal);
        this.resolved.set(stagingKey, record);
        this.resolved.set(segments.join('/'), record);
        try {
          const contents = Buffer.isBuffer(source) ? source : await readLocalFile(source);
          const manifest = JSON.parse(contents.toString('utf8')) as { projectName?: string };
          const project = await this.project(projectId, false, signal);
          if (project && manifest.projectName && project.name !== manifest.projectName) {
            const updated = await this.api.update(project.id, { name: manifest.projectName }, signal);
            this.resolved.set(`SoloSync/${projectId}`, updated);
          }
        } catch {
          // Manifest validation remains the repository's responsibility.
        }
        this.preparedCompactSnapshots.delete(stagingKey);
        return;
      }
    }
    const projectId = segments[1] ?? '';
    const snapshotId = segments[3] ?? '';
    const isObject = segments[2] === 'objects' && segments.length === 4;
    const parentKey = segments.slice(0, -1).join('/');
    await this.createDirectory(parentKey, signal);
    const parent = isObject ? await this.versionHistory(true, signal) : await this.resolve(parentKey, signal);
    if (!parent) throw new Error('SoloSync could not resolve the Google Drive parent folder.');
    const existing = await this.resolve(key, signal);
    if (existing) {
      if (await this.api.hashFile(existing.id, signal) !== await sourceHash(source)) {
        throw new Error('Google Drive contains different data for this backup path.');
      }
      this.resolved.set(segments.join('/'), existing);
      return;
    }
    const stableKey = `google-drive-file-id:${segments[1]}:${logicalHash(key)}`;
    let id = await this.stableIds?.get(stableKey);
    if (!id) {
      id = await this.api.generateId(signal);
      await this.stableIds?.store(stableKey, id);
    }
    const snapshot = !isObject && snapshotId ? await this.snapshot(projectId, snapshotId, false, signal) : undefined;
    const itemProperties = properties(isObject ? 'object' : 'file', key, projectId, isObject ? '' : snapshotId, snapshot?.appProperties.lifecycle ?? '');
    if (isObject) {
      itemProperties.contentSha256 = segments[3];
    }
    const uploaded = await this.api.uploadFile({
      id,
      name: isObject && typeof source === 'string'
        ? archivedObjectName({ id, name: path.basename(source), parents: [parent.id], appProperties: itemProperties, mimeType: 'application/octet-stream' })
        : segments.at(-1)!,
      parents: [parent.id],
      appProperties: itemProperties,
    }, source, signal);
    this.knownEmptyDirectories.delete(parent.id);
    this.resolved.set(segments.join('/'), uploaded);
    await this.stableIds?.delete(stableKey);
    if (segments.at(-1) === 'manifest.json') {
      try {
        const contents = Buffer.isBuffer(source) ? source : await readLocalFile(source);
        const manifest = JSON.parse(contents.toString('utf8')) as { projectName?: string };
        const project = await this.project(projectId, false, signal);
        if (project && manifest.projectName && project.name !== manifest.projectName) {
          const updated = await this.api.update(project.id, { name: manifest.projectName }, signal);
          this.resolved.set(`SoloSync/${projectId}`, updated);
        }
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
    const expectedProperties = { ...snapshot.appProperties, lifecycle: 'committed', logicalKeyHash: logicalHash(destination) };
    const expectedName = snapshot.mimeType === folderMimeType ? destinationSegments[3] : `${destinationSegments[3]}.json`;
    let moved: GoogleDriveItem;
    try {
      moved = await this.api.update(snapshot.id, { name: expectedName, appProperties: expectedProperties }, signal);
    } catch (error) {
      this.resolved.delete(source);
      this.resolved.delete(destination);
      const reconciled = await this.api.get(snapshot.id, signal).catch(() => undefined);
      const matches = reconciled?.name === expectedName
        && reconciled.parents.includes(snapshot.parents[0])
        && Object.entries(expectedProperties).every(([key, value]) => reconciled.appProperties[key] === value);
      if (!reconciled || !matches) throw error;
      moved = reconciled;
    }
    if (snapshot.mimeType !== folderMimeType) {
      await this.stableIds?.delete(`google-drive-file-id:${sourceSegments[1]}:${logicalHash(`${source}/manifest.json`)}`);
    }
    const sourcePrefix = `${source}/`;
    for (const [key, item] of [...this.resolved.entries()]) {
      if (key !== source && !key.startsWith(sourcePrefix)) continue;
      this.resolved.delete(key);
      this.resolved.set(`${destination}${key.slice(source.length)}`, key === source ? moved : item);
    }
    this.preparedCompactSnapshots.delete(source);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('The operation was canceled.');
    const segments = parseKey(key);
    if (segments.length === 1) throw new Error('SoloSync will not delete the Google Drive backup root.');
    const item = await this.resolve(key, signal);
    if (item && item.id !== this.rootId) await this.api.trash(item.id, signal);
    const normalized = segments.join('/');
    if (segments.length === 4 && ['staging', 'snapshots'].includes(segments[2]) && item?.mimeType !== folderMimeType) {
      if (item) await this.api.forgetUpload(item.id, segments[1]);
      await this.stableIds?.delete(`google-drive-file-id:${segments[1]}:${logicalHash(`${normalized}/manifest.json`)}`);
    }
    this.preparedCompactSnapshots.delete(normalized);
    for (const cached of [...this.resolved.keys()]) {
      if (cached === normalized || cached.startsWith(`${normalized}/`)) this.resolved.delete(cached);
    }
  }
}
