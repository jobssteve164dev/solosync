import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { BackupLocationKind, backupLocationLabels, isPathInsideDirectory, validateBackupDirectory, validateSourceDirectory } from './backupLocation';
import { BackupSettingsOption, buildBackupSettingsOptions } from './backupSettings';
import { isBackupWorthyGitOperation, readGitState } from './git';
import { authorizeGoogleDesktop, clearGoogleUploadSessions, GoogleTokenManager, GoogleTokenManagerCache, HostedGoogleTokenManager } from './googleAuth';
import { googleAuthMode, GoogleAuthMode, shouldRequestGoogleSignIn } from './googleAuthMode';
import { GoogleDriveClient } from './googleDriveClient';
import { GoogleDriveProvider } from './googleDriveProvider';
import { HistoryTreeProvider, SnapshotItem } from './historyTree';
import { projectIdFor, SnapshotCancelledError, SnapshotRepository } from './snapshotRepository';
import { abandonPendingBackup, isCompatiblePendingDestination, readPendingBackup, withPendingBackupLock } from './pendingBackup';
import { scanSensitiveFiles } from './sensitiveFileReview';
import { LocalFileSystemProvider, normalizeQnapWebDavUrl, QnapWebDavConnection, QnapWebDavProvider, StorageProvider } from './storageProvider';
import { SnapshotManifest, WorkspaceRoot } from './types';

const repository = new SnapshotRepository();
const qnapConnectionKey = 'qnapWebDavConnection';
const qnapPasswordKey = 'solosync.qnapWebDav.password';
const projectAssociationsKey = 'projectAssociations';
const googleDriveConnectedKey = 'googleDriveConnected';
const googleDriveAccountKey = 'googleDriveAccount';
const googleDriveAuthModeKey = 'googleDriveAuthMode';
const sensitiveFileDecisionsKey = 'sensitiveFileDecisions';
const googleDriveStableIdsKey = 'googleDriveStableIds';
const googleDriveUploadSessionKeys = 'googleDriveUploadSessionKeys';
const googleDesktopClientId = '336337797433-2kq8097ud0820baii6m26k53gv2pm95t.apps.googleusercontent.com';
const googleBrokerUrl = 'https://solosync.szlk.uk';
const googleTokenManagers = new GoogleTokenManagerCache();

function sourceDirectory(): string | undefined {
  const value = config().get<string>('sourceDirectory', '').trim();
  return value || undefined;
}

function protectedRoots(): WorkspaceRoot[] {
  const directory = sourceDirectory();
  return directory ? [{ name: path.basename(directory) || 'Project', path: directory }] : [];
}

function projectName(roots: WorkspaceRoot[]): string {
  return roots.map((root) => root.name).join(' + ') || 'Project';
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('solosync');
}

function backupDirectory(): string | undefined {
  const value = config().get<string>('backupDirectory', '').trim();
  return value || undefined;
}

function qnapConnection(context: vscode.ExtensionContext): QnapWebDavConnection | undefined {
  const value = context.globalState.get<Partial<QnapWebDavConnection>>(qnapConnectionKey);
  return value && typeof value.baseUrl === 'string' && typeof value.username === 'string'
    ? { baseUrl: value.baseUrl, username: value.username }
    : undefined;
}

function hasConfiguredBackupLocation(context: vscode.ExtensionContext): boolean {
  const kind = backupLocationKind(context);
  if (kind === 'qnap') return Boolean(qnapConnection(context));
  if (kind === 'googleDrive') return context.globalState.get<boolean>(googleDriveConnectedKey, false);
  return Boolean(backupDirectory());
}

type GoogleTokens = Pick<GoogleTokenManager, 'accessToken' | 'disconnect' | 'revoke'>;

function currentGoogleAuthMode(): GoogleAuthMode {
  return googleAuthMode({
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
    remoteName: vscode.env.remoteName,
  });
}

function savedGoogleAuthMode(context: vscode.ExtensionContext): GoogleAuthMode {
  const saved = context.globalState.get<string>(googleDriveAuthModeKey);
  return saved === 'desktop' || saved === 'hosted' ? saved : currentGoogleAuthMode();
}

function googleTokens(context: vscode.ExtensionContext, mode = savedGoogleAuthMode(context)): GoogleTokens {
  return googleTokenManagers.get(context, mode, () => {
    const onAuthenticationRequired = () => context.globalState.update(googleDriveConnectedKey, false);
    return mode === 'hosted'
      ? new HostedGoogleTokenManager({ brokerUrl: googleBrokerUrl, secrets: context.secrets, onAuthenticationRequired })
      : new GoogleTokenManager({ clientId: googleDesktopClientId, secrets: context.secrets, onAuthenticationRequired });
  });
}

async function withGoogleUploadSessionRegistry<T>(context: vscode.ExtensionContext, operation: () => Promise<T>): Promise<T> {
  await mkdir(context.globalStorageUri.fsPath, { recursive: true });
  return withPendingBackupLock(path.join(context.globalStorageUri.fsPath, 'google-drive-upload-session-registry'), operation);
}

async function readGoogleUploadSessionKeys(context: vscode.ExtensionContext): Promise<string[]> {
  try {
    const value = JSON.parse(await readFile(path.join(context.globalStorageUri.fsPath, 'google-drive-upload-session-keys.json'), 'utf8'));
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return context.globalState.get<string[]>(googleDriveUploadSessionKeys, []);
  }
}

async function writeGoogleUploadSessionKeys(context: vscode.ExtensionContext, keys: string[]): Promise<void> {
  const target = path.join(context.globalStorageUri.fsPath, 'google-drive-upload-session-keys.json');
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  await context.globalState.update(googleDriveUploadSessionKeys, keys);
}

async function clearGoogleUploadSessionRegistry(context: vscode.ExtensionContext, predicate: (key: string) => boolean): Promise<void> {
  await withGoogleUploadSessionRegistry(context, async () => {
    const keys = await readGoogleUploadSessionKeys(context);
    const matching = keys.filter(predicate);
    await clearGoogleUploadSessions(matching, context.secrets);
    await writeGoogleUploadSessionKeys(context, keys.filter((key) => !matching.includes(key)));
  });
}

function googleDriveClient(context: vscode.ExtensionContext, tokens = googleTokens(context)): GoogleDriveClient {
  return new GoogleDriveClient({
    tokens,
    sessions: {
      get: async (key) => context.secrets.get(`solosync.${key}`),
      store: (key, value) => withGoogleUploadSessionRegistry(context, async () => {
        const keys = await readGoogleUploadSessionKeys(context);
        if (!keys.includes(key)) await writeGoogleUploadSessionKeys(context, [...keys, key]);
        await context.secrets.store(`solosync.${key}`, value);
      }),
      delete: (key) => withGoogleUploadSessionRegistry(context, async () => {
        await context.secrets.delete(`solosync.${key}`);
        const keys = await readGoogleUploadSessionKeys(context);
        await writeGoogleUploadSessionKeys(context, keys.filter((item) => item !== key));
      }),
    },
  });
}

function googleDriveStableIds(context: vscode.ExtensionContext) {
  return {
    get: async (key: string) => context.globalState.get<Record<string, string>>(googleDriveStableIdsKey, {})[key],
    store: async (key: string, value: string) => context.globalState.update(googleDriveStableIdsKey, {
      ...context.globalState.get<Record<string, string>>(googleDriveStableIdsKey, {}), [key]: value,
    }),
    delete: async (key: string) => {
      const values = context.globalState.get<Record<string, string>>(googleDriveStableIdsKey, {});
      delete values[key];
      await context.globalState.update(googleDriveStableIdsKey, values);
    },
  };
}

async function clearGooglePendingCredentials(context: vscode.ExtensionContext, projectId: string): Promise<void> {
  await clearGoogleUploadSessionRegistry(context, (key) => key.startsWith(`google-drive-upload:${projectId}:`));
  const ids = context.globalState.get<Record<string, string>>(googleDriveStableIdsKey, {});
  for (const key of Object.keys(ids)) if (key.includes(`:${projectId}:`)) delete ids[key];
  await context.globalState.update(googleDriveStableIdsKey, ids);
}

interface SensitiveFileDecision {
  excluded: string[];
  included: string[];
}

async function reviewSensitiveFiles(
  context: vscode.ExtensionContext,
  projectId: string,
  roots: WorkspaceRoot[],
  excludes: string[],
  signal?: AbortSignal,
): Promise<SensitiveFileDecision | undefined> {
  const found = await scanSensitiveFiles(roots, excludes, signal);
  const allDecisions = context.globalState.get<Record<string, SensitiveFileDecision>>(sensitiveFileDecisionsKey, {});
  const saved = allDecisions[projectId] ?? { excluded: [], included: [] };
  const decided = new Set([...saved.excluded, ...saved.included]);
  const undecided = found.filter((file) => !decided.has(file.key));
  if (undecided.length > 0) {
    const shown = undecided.slice(0, 12).map((file) => file.key);
    const more = undecided.length > shown.length ? `\n…and ${undecided.length - shown.length} more` : '';
    const choice = await vscode.window.showWarningMessage(
      `SoloSync found ${undecided.length} file${undecided.length === 1 ? '' : 's'} that may contain secrets.`,
      { modal: true, detail: `${shown.join('\n')}${more}\n\nGoogle Drive stores readable backup files.` },
      'Exclude These Files',
      'Always Include',
    );
    if (!choice) return undefined;
    const additions = undecided.map((file) => file.key);
    const next = choice === 'Exclude These Files'
      ? { excluded: [...new Set([...saved.excluded, ...additions])], included: saved.included }
      : { excluded: saved.excluded, included: [...new Set([...saved.included, ...additions])] };
    allDecisions[projectId] = next;
    await context.globalState.update(sensitiveFileDecisionsKey, allDecisions);
    return next;
  }
  return saved;
}

async function configuredProvider(context: vscode.ExtensionContext, signal?: AbortSignal): Promise<StorageProvider | undefined> {
  const kind = backupLocationKind(context);
  if (kind === 'qnap') {
    const connection = qnapConnection(context);
    const password = await context.secrets.get(qnapPasswordKey);
    if (!connection || !password) return undefined;
    return QnapWebDavProvider.create(connection, password);
  }
  if (kind === 'googleDrive') {
    if (!context.globalState.get<boolean>(googleDriveConnectedKey, false)) return undefined;
    return GoogleDriveProvider.connect(googleDriveClient(context), googleDriveStableIds(context), signal);
  }
  const directory = backupDirectory();
  return directory ? new LocalFileSystemProvider(directory) : undefined;
}

function associationPath(directory: string): string {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function associateProject(context: vscode.ExtensionContext, directory: string, projectId: string): Promise<void> {
  const associations = context.globalState.get<Record<string, string>>(projectAssociationsKey, {});
  await context.globalState.update(projectAssociationsKey, { ...associations, [associationPath(directory)]: projectId });
}

async function resolveProjectId(context: vscode.ExtensionContext, provider: StorageProvider, roots: WorkspaceRoot[]): Promise<string> {
  const directory = roots[0]?.path;
  if (!directory) throw new Error('Choose the project folder SoloSync should protect.');
  const associations = context.globalState.get<Record<string, string>>(projectAssociationsKey, {});
  const existing = associations[associationPath(directory)];
  if (existing) return existing;
  const legacy = projectIdFor(roots);
  const projectId = await repository.projectExists(provider, legacy) ? legacy : randomUUID().replace(/-/g, '').slice(0, 16);
  await associateProject(context, directory, projectId);
  return projectId;
}

async function validateProvider(provider: StorageProvider, roots: WorkspaceRoot[], signal?: AbortSignal): Promise<void> {
  if (provider.localRoot) {
    await validateBackupDirectory(provider.localRoot, roots);
  } else {
    await provider.validate(signal);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tree = new HistoryTreeProvider();
  const treeView = vscode.window.createTreeView('solosync.history', { treeDataProvider: tree });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'solosync.backupNow';
  status.text = '$(archive) SoloSync';
  status.tooltip = 'Create a workspace snapshot';
  status.show();
  context.subscriptions.push(status, treeView);

  let running: Promise<SnapshotManifest | undefined> | undefined;
  let activeBackupController: AbortController | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let lastHead = context.workspaceState.get<string>('lastObservedHead');

  const refresh = async (): Promise<void> => {
    const roots = protectedRoots();
    const source = sourceDirectory();
    const hasLocation = hasConfiguredBackupLocation(context);
    await vscode.commands.executeCommand('setContext', 'solosync.hasSourceDirectory', Boolean(source));
    await vscode.commands.executeCommand('setContext', 'solosync.hasBackupLocation', hasLocation);

    let sourceAvailable = false;
    if (source) {
      try {
        await validateSourceDirectory(source);
        sourceAvailable = true;
      } catch {
        sourceAvailable = false;
      }
    }
    await vscode.commands.executeCommand('setContext', 'solosync.sourceDirectoryAvailable', sourceAvailable);

    let provider: StorageProvider | undefined;
    try {
      provider = await configuredProvider(context);
      if (!provider) throw new Error('Choose where SoloSync stores backups.');
      await validateProvider(provider, sourceAvailable ? roots : []);
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', true);
    } catch {
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', false);
      provider = undefined;
    }

    tree.setSnapshots([]);
    treeView.message = undefined;
    if (!sourceAvailable) {
      if (provider) {
        treeView.message = `Backups available on ${provider.displayName}`;
        status.command = 'solosync.browseBackups';
        status.text = '$(history) SoloSync: Browse backups';
        status.tooltip = 'Browse and restore an existing backup';
      } else if (source) {
        status.command = 'solosync.configureSource';
        status.text = '$(warning) SoloSync: Project unavailable';
        status.tooltip = 'Reconnect the project folder or browse an existing backup';
      } else {
        status.command = 'solosync.configureSource';
        status.text = '$(root-folder) SoloSync: Choose project';
        status.tooltip = 'Choose a project or browse an existing backup';
      }
      return;
    }
    if (!provider) {
      status.command = 'solosync.configure';
      status.text = hasLocation ? '$(warning) SoloSync: Location unavailable' : '$(gear) SoloSync: Set up';
      status.tooltip = hasLocation ? 'Reconnect the backup location or choose another one' : 'Choose where SoloSync stores backups';
      return;
    }
    try {
      const projectId = await resolveProjectId(context, provider, roots);
      const snapshots = await repository.list(provider, projectId);
      const kind = backupLocationKind(context);
      treeView.message = `${roots[0].name} → ${kind ? backupLocationLabels[kind] : 'Backup folder'} · ${provider.displayName}`;
      status.command = 'solosync.backupNow';
      status.text = '$(archive) SoloSync';
      status.tooltip = `Back up ${roots[0].name}`;
      tree.setSnapshots(snapshots);
    } catch {
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', false);
      status.command = 'solosync.configure';
      status.text = '$(warning) SoloSync: Location unavailable';
      status.tooltip = 'Reconnect the backup location or choose another one';
    }
  };

  const backup = async (reason: string): Promise<SnapshotManifest | undefined> => {
    if (running) {
      return running;
    }
    running = (async () => {
      let roots = protectedRoots();
      if (roots.length === 0) {
        const selected = await chooseSourceDirectory();
        if (!selected) return undefined;
        roots = protectedRoots();
      }
      let provider: StorageProvider | undefined;
      const connectionController = new AbortController();
      let connectionReady = false;
      activeBackupController = connectionController;
      status.text = '$(sync~spin) SoloSync: Connecting';
      status.command = 'solosync.cancelBackup';
      status.tooltip = 'Click to cancel this backup';
      await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', true);
      try {
        provider = await configuredProvider(context, connectionController.signal);
        if (!provider) {
          if (backupLocationKind(context) === 'googleDrive') {
            if (!shouldRequestGoogleSignIn(reason)) return undefined;
            provider = await configureGoogleDrive(context, connectionController.signal);
          } else {
            provider = await chooseBackupLocation(context, roots);
          }
        }
        if (!provider) return undefined;
        await validateProvider(provider, roots, connectionController.signal);
        connectionReady = true;
      } catch (error) {
        if (connectionController.signal.aborted) {
          status.text = '$(circle-slash) SoloSync: Backup canceled';
          status.tooltip = 'No snapshot was created';
          void vscode.window.showInformationMessage('SoloSync backup canceled. No snapshot was created.');
          return undefined;
        }
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message, 'Set Backup Location').then((action) => {
          if (action === 'Set Backup Location') void vscode.commands.executeCommand('solosync.configure');
        });
        return undefined;
      } finally {
        if (!connectionReady) {
          activeBackupController = undefined;
          status.command = 'solosync.backupNow';
          await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', false);
        }
      }
      if (!provider) return undefined;
      if (!vscode.workspace.isTrusted) {
        activeBackupController = undefined;
        status.command = 'solosync.backupNow';
        await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', false);
        void vscode.window.showWarningMessage('Trust this workspace before creating a SoloSync backup.');
        return undefined;
      }

      status.text = '$(sync~spin) SoloSync: Backing up';
      try {
        const projectId = await resolveProjectId(context, provider, roots);
        const pendingDirectory = backupLocationKind(context) === 'googleDrive'
          ? path.join(context.globalStorageUri.fsPath, 'pending', projectId)
          : undefined;
        const resuming = pendingDirectory
          ? await stat(path.join(pendingDirectory, 'manifest.json')).then(() => true, () => false)
          : false;
        const git = resuming ? { dirty: true } : await readGitState(roots);
        const exclusions = config().get<string[]>('exclude', []);
        let sensitiveDecision: SensitiveFileDecision | undefined;
        try {
          sensitiveDecision = backupLocationKind(context) === 'googleDrive' && !resuming
            ? await reviewSensitiveFiles(context, projectId, roots, exclusions, connectionController.signal)
            : undefined;
        } catch (error) {
          if (connectionController.signal.aborted) throw new SnapshotCancelledError();
          throw error;
        }
        if (backupLocationKind(context) === 'googleDrive' && !resuming && !sensitiveDecision) {
          await refresh();
          return undefined;
        }
        const manifest = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `SoloSync is protecting ${projectName(roots)}`,
          cancellable: true,
        }, async (progress, token) => {
          const controller = connectionController;
          status.command = 'solosync.cancelBackup';
          status.tooltip = 'Click to cancel this backup';
          await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', true);
          const cancellation = token.onCancellationRequested(() => controller.abort());
          let lastCompleted = 0;
          try {
            const createSnapshot = () => repository.create({
              provider,
              projectId,
              projectName: projectName(roots),
              roots,
              excludes: exclusions,
              excludedSensitivePaths: sensitiveDecision?.excluded ?? [],
              reviewedSensitivePaths: sensitiveDecision ? [...sensitiveDecision.excluded, ...sensitiveDecision.included] : undefined,
              pendingDirectory,
              pendingDestinationIdentity: provider instanceof GoogleDriveProvider ? provider.destinationIdentity : undefined,
              discardPendingCredentials: pendingDirectory ? () => clearGooglePendingCredentials(context, projectId) : undefined,
              reason,
              git,
              signal: controller.signal,
              onProgress: (event) => {
                if (event.phase === 'scanning') {
                  progress.report({ message: `Scanning · ${event.discovered.toLocaleString()} files found` });
                } else if (event.phase === 'copying') {
                  const increment = event.total > 0 ? ((event.completed - lastCompleted) / event.total) * 100 : 100;
                  lastCompleted = event.completed;
                  progress.report({ increment, message: `Copying · ${event.completed.toLocaleString()} of ${event.total.toLocaleString()}` });
                } else {
                  progress.report({ message: `Finalizing · ${event.total.toLocaleString()} files` });
                }
              },
            });
            return pendingDirectory
              ? withPendingBackupLock(pendingDirectory, createSnapshot)
              : createSnapshot();
          } finally {
            cancellation.dispose();
          }
        });
        await context.workspaceState.update('lastObservedHead', git.head);
        lastHead = git.head;
        status.text = '$(verified-filled) SoloSync: Protected';
        status.tooltip = `Last backup ${new Date(manifest.createdAt).toLocaleString()}`;
        await refresh();
        return manifest;
      } catch (error) {
        if (error instanceof SnapshotCancelledError) {
          status.text = '$(circle-slash) SoloSync: Backup canceled';
          status.tooltip = 'No snapshot was created';
          void vscode.window.showInformationMessage('SoloSync backup canceled. No snapshot was created.');
          await refresh();
          return undefined;
        }
        status.text = '$(error) SoloSync: Backup failed';
        status.tooltip = 'Backup failed. Click to try again.';
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`SoloSync could not create the backup: ${message}`);
        return undefined;
      } finally {
        activeBackupController = undefined;
        status.command = 'solosync.backupNow';
        await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', false);
      }
    })();
    try {
      return await running;
    } finally {
      running = undefined;
    }
  };

  const scheduleIdleBackup = (changed?: vscode.Uri): void => {
    const kind = backupLocationKind(context);
    const directory = kind === 'qnap' || kind === 'googleDrive' ? undefined : backupDirectory();
    if (changed?.scheme === 'file' && directory && isPathInsideDirectory(changed.fsPath, directory)) return;
    const roots = protectedRoots();
    if (changed?.scheme === 'file' && !roots.some((root) => isPathInsideDirectory(changed.fsPath, root.path))) return;
    if (idleTimer) clearTimeout(idleTimer);
    const minutes = config().get<number>('idleBackupMinutes', 10);
    if (minutes <= 0) return;
    idleTimer = setTimeout(() => void backup('Workspace idle'), minutes * 60_000);
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate(scheduleIdleBackup);
  watcher.onDidChange(scheduleIdleBackup);
  watcher.onDidDelete(scheduleIdleBackup);
  context.subscriptions.push(watcher, { dispose: () => idleTimer && clearTimeout(idleTimer) });

  const gitPoller = setInterval(async () => {
    if (!config().get<boolean>('autoBackupAfterCommit', true) || running) return;
    const roots = protectedRoots();
    if (roots.length === 0) return;
    const git = await readGitState(roots);
    if (git.head && lastHead && git.head !== lastHead) {
      if (isBackupWorthyGitOperation(git.operation)) {
        await backup('Git commit');
      } else {
        lastHead = git.head;
        await context.workspaceState.update('lastObservedHead', git.head);
      }
    } else if (git.head && !lastHead) {
      lastHead = git.head;
      await context.workspaceState.update('lastObservedHead', git.head);
    }
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(gitPoller) });

  context.subscriptions.push(
    vscode.commands.registerCommand('solosync.setup', async () => {
      const action = await vscode.window.showQuickPick([
        { label: '$(root-folder) Project folder', description: sourceDirectory() ? path.basename(sourceDirectory()!) : 'Not selected', command: 'solosync.configureSource' },
        { label: '$(folder-opened) Backup location', description: backupLocationDescription(context), command: 'solosync.configure' },
        { label: '$(history) Browse backups', description: 'Restore without the original project', command: 'solosync.browseBackups' },
        { label: '$(gear) Backup settings', description: 'Connection, timing, and exclusions', command: 'solosync.openSettings' },
      ], { title: 'SoloSync Setup', placeHolder: 'What would you like to configure?' });
      if (action) await vscode.commands.executeCommand(action.command);
    }),
    vscode.commands.registerCommand('solosync.configureSource', async () => {
      const selected = await chooseSourceDirectory();
      if (!selected) return;
      lastHead = undefined;
      await context.workspaceState.update('lastObservedHead', undefined);
      await refresh();
      if (!hasConfiguredBackupLocation(context)) await vscode.commands.executeCommand('solosync.configure');
    }),
    vscode.commands.registerCommand('solosync.configure', async () => {
      const provider = await chooseBackupLocation(context, protectedRoots());
      if (!provider) return;
      await refresh();
      const actions = protectedRoots().length > 0 ? ['Back Up Now', 'Browse Backups'] : ['Browse Backups'];
      const action = await vscode.window.showInformationMessage('Backup location is ready.', ...actions);
      if (action === 'Back Up Now') await backup('Manual backup');
      if (action === 'Browse Backups') await browseBackups(context);
    }),
    vscode.commands.registerCommand('solosync.openSettings', () => openBackupSettings(context, refresh)),
    vscode.commands.registerCommand('solosync.connectGoogleDrive', async () => {
      if (await configureGoogleDrive(context)) await refresh();
    }),
    vscode.commands.registerCommand('solosync.disconnectGoogleDrive', async () => {
      await disconnectGoogleDrive(context, false);
      await refresh();
    }),
    vscode.commands.registerCommand('solosync.revokeGoogleDrive', async () => {
      await disconnectGoogleDrive(context, true);
      await refresh();
    }),
    vscode.commands.registerCommand('solosync.backupNow', () => backup('Manual backup')),
    vscode.commands.registerCommand('solosync.cancelBackup', () => activeBackupController?.abort()),
    vscode.commands.registerCommand('solosync.refresh', refresh),
    vscode.commands.registerCommand('solosync.browseBackups', () => browseBackups(context)),
    vscode.commands.registerCommand('solosync.restoreSnapshot', async (item?: SnapshotItem) => {
      const provider = await configuredProvider(context);
      if (provider) await restoreSnapshot(await pickSnapshot(item, tree, context, provider), provider, context);
    }),
    vscode.commands.registerCommand('solosync.restoreFile', async (item?: SnapshotItem) => {
      const provider = await configuredProvider(context);
      if (provider) await restoreFile(await pickSnapshot(item, tree, context, provider), provider);
    }),
    vscode.commands.registerCommand('solosync.verifySnapshot', async (item?: SnapshotItem) => {
      const provider = await configuredProvider(context);
      if (provider) await verifySnapshot(await pickSnapshot(item, tree, context, provider), provider);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('solosync.sourceDirectory')) {
        lastHead = undefined;
        void context.workspaceState.update('lastObservedHead', undefined);
      }
      if (event.affectsConfiguration('solosync.sourceDirectory') || event.affectsConfiguration('solosync.backupDirectory')) void refresh();
    }),
  );

  await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', false);
  await refresh();
  if (backupLocationKind(context) === 'googleDrive' && context.globalState.get<boolean>(googleDriveConnectedKey, false)) {
    const root = protectedRoots()[0];
    const associations = context.globalState.get<Record<string, string>>(projectAssociationsKey, {});
    const projectId = root ? associations[associationPath(root.path)] : undefined;
    if (projectId) {
      const pendingManifest = path.join(context.globalStorageUri.fsPath, 'pending', projectId, 'manifest.json');
      if (await stat(pendingManifest).then(() => true, () => false)) setTimeout(() => void backup('Resume interrupted backup'), 0);
    }
  }
}

async function chooseSourceDirectory(): Promise<string | undefined> {
  const currentSource = sourceDirectory();
  const defaultWorkspace = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file')?.uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: currentSource ? vscode.Uri.file(currentSource) : defaultWorkspace,
    openLabel: 'Protect This Folder',
    title: 'Choose the project folder SoloSync should protect',
  });
  const selected = picked?.[0]?.fsPath;
  if (!selected) return undefined;
  try {
    await validateSourceDirectory(selected);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
  await config().update('sourceDirectory', selected, vscode.ConfigurationTarget.Workspace);
  return selected;
}

interface BackupLocationOption extends vscode.QuickPickItem {
  locationKind: BackupLocationKind;
  pickerTitle?: string;
}

async function chooseBackupLocation(context: vscode.ExtensionContext, roots: WorkspaceRoot[]): Promise<StorageProvider | undefined> {
  const option = await vscode.window.showQuickPick<BackupLocationOption>([
    {
      locationKind: 'qnap',
      label: '$(server) QNAP NAS',
      description: 'Connect with your NAS address',
      detail: 'Back up directly to a QNAP shared folder over HTTPS.',
    },
    {
      locationKind: 'googleDrive',
      label: '$(cloud) Google Drive',
      description: 'Sign in with Google',
      detail: 'SoloSync creates and uses a dedicated SoloSync Backups folder.',
    },
    {
      locationKind: 'nas',
      label: '$(server) NAS',
      description: 'Mounted network folder',
      detail: 'Choose a NAS share already mounted by your operating system.',
      pickerTitle: 'Choose a mounted NAS folder',
    },
    {
      locationKind: 'local',
      label: '$(folder) Local or external drive',
      description: 'Folder on this computer',
      detail: 'Choose a local folder, external disk, or USB drive.',
      pickerTitle: 'Choose a local or external drive folder',
    },
  ], {
    title: 'Set Backup Location',
    placeHolder: 'Where should SoloSync store backups?',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!option) return undefined;
  if (option.locationKind === 'qnap') return configureQnap(context);
  if (option.locationKind === 'googleDrive') return configureGoogleDrive(context);
  const currentDirectory = backupDirectory();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: currentDirectory ? vscode.Uri.file(currentDirectory) : undefined,
    openLabel: 'Use This Folder',
    title: option.pickerTitle ?? 'Choose a backup folder',
  });
  const selected = picked?.[0]?.fsPath;
  if (!selected) return undefined;
  try {
    await validateBackupDirectory(selected, roots);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
    return undefined;
  }
  await context.globalState.update('backupLocationKind', option.locationKind);
  await config().update('backupDirectory', selected, vscode.ConfigurationTarget.Global);
  return new LocalFileSystemProvider(selected);
}

async function configureGoogleDrive(context: vscode.ExtensionContext, signal?: AbortSignal): Promise<StorageProvider | undefined> {
  const mode = currentGoogleAuthMode();
  try {
    let tokens: GoogleTokens;
    if (mode === 'hosted') {
      const hosted = googleTokens(context, mode) as HostedGoogleTokenManager;
      await hosted.connect({
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        requestCallbackCode: async () => {
          const cancellation = new vscode.CancellationTokenSource();
          const cancel = (): void => cancellation.cancel();
          if (signal?.aborted) cancellation.cancel();
          else signal?.addEventListener('abort', cancel, { once: true });
          try {
            return await vscode.window.showInputBox({
              title: 'Connect Google Drive',
              prompt: 'Paste the one-time code shown after Google approves access.',
              placeHolder: 'Paste the SoloSync connection code',
              ignoreFocusOut: true,
              validateInput: (value) => value.trim() ? undefined : 'Paste the connection code from the browser.',
            }, cancellation.token);
          } finally {
            signal?.removeEventListener('abort', cancel);
            cancellation.dispose();
          }
        },
      }, signal);
      tokens = hosted;
    } else {
      const desktop = googleTokens(context, mode) as GoogleTokenManager;
      await authorizeGoogleDesktop({
        clientId: googleDesktopClientId,
        tokens: desktop,
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        signal,
      });
      tokens = desktop;
    }
    const provider = await GoogleDriveProvider.connect(googleDriveClient(context, tokens), googleDriveStableIds(context), signal);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SoloSync is checking Google Drive',
      cancellable: false,
    }, () => provider.testConnection(signal));
    await context.globalState.update(googleDriveAuthModeKey, mode);
    await context.globalState.update(googleDriveAccountKey, provider.account.emailAddress ?? provider.account.displayName ?? 'Google account');
    await context.globalState.update(googleDriveConnectedKey, true);
    await context.globalState.update('backupLocationKind', 'googleDrive');
    return provider;
  } catch (error) {
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`SoloSync could not connect to Google Drive: ${message}`);
    return undefined;
  }
}

async function disconnectGoogleDrive(context: vscode.ExtensionContext, revoke: boolean): Promise<void> {
  if (revoke) {
    const confirmation = await vscode.window.showWarningMessage(
      'Revoke SoloSync access to Google Drive? Existing backups will stay in Google Drive, but every SoloSync installation using this authorization may need to sign in again.',
      { modal: true },
      'Revoke Access',
    );
    if (confirmation !== 'Revoke Access') return;
  }
  const mode = savedGoogleAuthMode(context);
  try {
    const tokens = googleTokens(context, mode);
    if (revoke) await tokens.revoke();
    else await tokens.disconnect();
    await clearGoogleUploadSessionRegistry(context, () => true);
    const stableIds = context.globalState.get<Record<string, string>>(googleDriveStableIdsKey, {});
    await context.globalState.update(googleDriveStableIdsKey, Object.fromEntries(
      Object.entries(stableIds).filter(([key]) => key.startsWith('google-drive-root-id:')),
    ));
    await context.globalState.update(googleDriveConnectedKey, false);
    await context.globalState.update(googleDriveAccountKey, undefined);
    if (backupLocationKind(context) === 'googleDrive') await context.globalState.update('backupLocationKind', undefined);
    void vscode.window.showInformationMessage(revoke ? 'Google Drive access was revoked. Your existing backups were not deleted.' : 'Google Drive was disconnected. Your existing backups were not deleted.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`SoloSync could not ${revoke ? 'revoke' : 'disconnect'} Google Drive: ${message}`);
  }
}

async function configureQnap(context: vscode.ExtensionContext): Promise<StorageProvider | undefined> {
  const current = qnapConnection(context);
  const acknowledgement = await vscode.window.showWarningMessage(
    'SoloSync uses HTTPS for transfer, but this version stores readable files on the NAS. Review whether secrets such as .env files should be excluded.',
    { modal: true },
    'Continue',
  );
  if (acknowledgement !== 'Continue') return undefined;
  const baseUrl = await vscode.window.showInputBox({
    title: 'Connect QNAP NAS',
    prompt: 'Enter the HTTPS address of the shared folder where SoloSync should store backups.',
    placeHolder: 'https://backup.example.com/Backups',
    value: current?.baseUrl,
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        normalizeQnapWebDavUrl(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  if (!baseUrl) return undefined;
  const username = await vscode.window.showInputBox({
    title: 'Connect QNAP NAS',
    prompt: 'Enter the dedicated NAS account that can read and write this backup folder.',
    placeHolder: 'solosync-backup',
    value: current?.username,
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'Enter the NAS username.',
  });
  if (!username) return undefined;
  const password = await vscode.window.showInputBox({
    title: 'Connect QNAP NAS',
    prompt: 'Enter the NAS password. SoloSync stores it in VS Code secure storage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => value ? undefined : 'Enter the NAS password.',
  });
  if (!password) return undefined;
  const connection = { baseUrl: normalizeQnapWebDavUrl(baseUrl), username: username.trim() };
  try {
    const provider = await QnapWebDavProvider.create(connection, password);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'SoloSync is checking the QNAP backup folder',
      cancellable: false,
    }, () => provider.testConnection());
    await context.globalState.update(qnapConnectionKey, connection);
    await context.secrets.store(qnapPasswordKey, password);
    await context.globalState.update('backupLocationKind', 'qnap');
    return provider;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`SoloSync could not connect to QNAP: ${message}`);
    return undefined;
  }
}

function backupLocationKind(context: vscode.ExtensionContext): BackupLocationKind | undefined {
  const value = context.globalState.get<string>('backupLocationKind');
  return value === 'googleDrive' || value === 'nas' || value === 'local' || value === 'qnap' ? value : undefined;
}

function backupLocationDescription(context: vscode.ExtensionContext): string {
  const kind = backupLocationKind(context);
  if (kind === 'qnap') {
    const connection = qnapConnection(context);
    return connection ? new URL(connection.baseUrl).hostname : 'Not connected';
  }
  if (kind === 'googleDrive') return context.globalState.get<string>(googleDriveAccountKey, 'Google Drive');
  const directory = backupDirectory();
  return directory ? path.basename(directory) || directory : 'Not selected';
}

async function openBackupSettings(context: vscode.ExtensionContext, refresh: () => Promise<void>): Promise<void> {
  const kind = backupLocationKind(context);
  const connection = kind === 'qnap' ? qnapConnection(context) : undefined;
  const hasQnapPassword = connection ? Boolean(await context.secrets.get(qnapPasswordKey)) : false;
  const destination = kind === 'googleDrive' ? 'SoloSync Backups' : connection?.baseUrl ?? backupDirectory();
  const roots = protectedRoots();
  const associations = context.globalState.get<Record<string, string>>(projectAssociationsKey, {});
  const currentProjectId = roots[0] ? associations[associationPath(roots[0].path)] : undefined;
  const sensitiveDecisions = context.globalState.get<Record<string, SensitiveFileDecision>>(sensitiveFileDecisionsKey, {});
  const currentSensitiveDecision = currentProjectId ? sensitiveDecisions[currentProjectId] : undefined;
  const pendingDirectory = currentProjectId ? path.join(context.globalStorageUri.fsPath, 'pending', currentProjectId) : undefined;
  const pendingBackup = pendingDirectory ? await readPendingBackup(pendingDirectory).catch(() => undefined) : undefined;
  const options = buildBackupSettingsOptions({
    kind,
    kindLabel: kind ? backupLocationLabels[kind] : undefined,
    destination,
    qnapUsername: connection?.username,
    googleAccount: context.globalState.get<string>(googleDriveAccountKey),
    googleConnected: context.globalState.get<boolean>(googleDriveConnectedKey, false),
    qnapPasswordSaved: hasQnapPassword,
    backupAfterCommit: config().get<boolean>('autoBackupAfterCommit', true),
    idleBackupMinutes: config().get<number>('idleBackupMinutes', 10),
    exclusionCount: config().get<string[]>('exclude', []).length,
    sensitiveDecisionCount: (currentSensitiveDecision?.excluded.length ?? 0) + (currentSensitiveDecision?.included.length ?? 0),
    pendingBackup: pendingBackup ? {
      state: pendingBackup.job.state,
      occupiedBytes: pendingBackup.occupiedBytes,
      createdAt: pendingBackup.job.createdAt,
    } : undefined,
  });
  const selected = await vscode.window.showQuickPick(options, {
    title: 'SoloSync Backup Settings',
    placeHolder: 'Choose what you want to change',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!selected) return;
  if (selected.action === 'location') {
    await vscode.commands.executeCommand('solosync.configure');
    return;
  }
  if (selected.action === 'qnapConnection') {
    const provider = await configureQnap(context);
    if (!provider) return;
    await refresh();
    void vscode.window.showInformationMessage('QNAP connection is ready.');
    return;
  }
  if (selected.action === 'googleConnection') {
    const connected = context.globalState.get<boolean>(googleDriveConnectedKey, false);
    const actions = connected
      ? [
        { label: '$(sign-out) Disconnect', description: 'Keep backups and Google authorization', command: 'solosync.disconnectGoogleDrive' },
        { label: '$(shield) Revoke access', description: 'Remove SoloSync authorization without deleting backups', command: 'solosync.revokeGoogleDrive' },
      ]
      : [{ label: '$(sign-in) Sign in again', description: 'Reconnect the SoloSync Backups folder', command: 'solosync.connectGoogleDrive' }];
    const action = await vscode.window.showQuickPick(actions, { title: 'Google Drive connection', placeHolder: 'What would you like to do?' });
    if (action) await vscode.commands.executeCommand(action.command);
    return;
  }
  if (selected.action === 'pendingBackup' && currentProjectId && pendingDirectory && pendingBackup) {
    const action = await vscode.window.showQuickPick([
      { label: '$(debug-continue) Continue backup', description: 'Resume from the saved upload progress', value: 'continue' },
      { label: '$(trash) Abandon backup', description: 'Remove this unfinished copy without deleting completed backups', value: 'abandon' },
    ], { title: 'Pending Google Drive backup', placeHolder: 'What would you like to do?' });
    if (action?.value === 'continue') {
      let provider = backupLocationKind(context) === 'googleDrive' ? await configuredProvider(context) : undefined;
      if (!(provider instanceof GoogleDriveProvider)) provider = await configureGoogleDrive(context);
      if (!(provider instanceof GoogleDriveProvider)) return;
      if (!pendingBackup.job.destinationIdentity || !isCompatiblePendingDestination(pendingBackup.job.destinationIdentity, provider.destinationIdentity)) {
        void vscode.window.showErrorMessage('This pending backup belongs to a different Google account. Sign in with the account that created it.');
        return;
      }
      await vscode.commands.executeCommand('solosync.backupNow');
    } else if (action?.value === 'abandon') {
      const confirmation = await vscode.window.showWarningMessage(
        'Abandon this unfinished backup?',
        { modal: true, detail: 'SoloSync will remove only this frozen local copy and its unfinished Google Drive upload. Completed backups will stay untouched.' },
        'Abandon Backup',
      );
      if (confirmation === 'Abandon Backup') {
        try {
          let provider = backupLocationKind(context) === 'googleDrive' ? await configuredProvider(context) : undefined;
          if (!(provider instanceof GoogleDriveProvider)) provider = await configureGoogleDrive(context);
          if (!(provider instanceof GoogleDriveProvider)) throw new Error('Reconnect Google Drive before abandoning this pending backup.');
          if (!pendingBackup.job.destinationIdentity || !isCompatiblePendingDestination(pendingBackup.job.destinationIdentity, provider.destinationIdentity)) {
            throw new Error('Sign in with the Google account that created this pending backup.');
          }
          await withPendingBackupLock(pendingDirectory, () => abandonPendingBackup(pendingDirectory, {
            deleteRemoteStaging: () => provider.delete(`SoloSync/${currentProjectId}/staging/${pendingBackup.job.snapshotId}`),
            clearCredentials: () => clearGooglePendingCredentials(context, currentProjectId),
          }));
          void vscode.window.showInformationMessage('The unfinished backup was removed. Completed backups were not changed.');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void vscode.window.showErrorMessage(`SoloSync could not abandon the unfinished backup: ${message}`);
        }
      }
    }
    return;
  }
  if (selected.action === 'sensitiveFiles' && currentProjectId) {
    const choice = await vscode.window.showWarningMessage(
      'Review sensitive files again before the next Google Drive backup?',
      { modal: true, detail: 'SoloSync will forget the include and exclude choices saved for this project. No files or backups will be deleted.' },
      'Review Again',
    );
    if (choice === 'Review Again') {
      delete sensitiveDecisions[currentProjectId];
      await context.globalState.update(sensitiveFileDecisionsKey, sensitiveDecisions);
      void vscode.window.showInformationMessage('SoloSync will review sensitive files before the next Google Drive backup.');
    }
    return;
  }
  const setting = ({
    commitTiming: 'solosync.autoBackupAfterCommit',
    idleTiming: 'solosync.idleBackupMinutes',
    exclusions: 'solosync.exclude',
  } as Partial<Record<BackupSettingsOption['action'], string>>)[selected.action];
  if (setting) await vscode.commands.executeCommand('workbench.action.openSettings', setting);
}

async function pickSnapshot(item: SnapshotItem | undefined, _tree: HistoryTreeProvider, context: vscode.ExtensionContext, provider: StorageProvider): Promise<SnapshotManifest | undefined> {
  if (item?.manifest) return item.manifest;
  const roots = protectedRoots();
  if (roots.length === 0) return undefined;
  const snapshots = await repository.list(provider, await resolveProjectId(context, provider, roots));
  const picked = await vscode.window.showQuickPick(snapshots.map((manifest) => ({
    label: new Date(manifest.createdAt).toLocaleString(),
    description: manifest.git.message || manifest.reason,
    manifest,
  })), { placeHolder: 'Choose a SoloSync snapshot' });
  return picked?.manifest;
}

async function browseBackups(context: vscode.ExtensionContext): Promise<void> {
  let provider = await configuredProvider(context);
  if (!provider) provider = backupLocationKind(context) === 'googleDrive'
    ? await configureGoogleDrive(context)
    : await chooseBackupLocation(context, []);
  if (!provider) return;
  try {
    await provider.validate();
    const projects = await repository.listProjects(provider);
    if (projects.length === 0) {
      void vscode.window.showInformationMessage('No SoloSync backups were found in this location.');
      return;
    }
    const project = await vscode.window.showQuickPick(projects.map((item) => ({
      label: item.projectName,
      description: `Latest backup ${new Date(item.updatedAt).toLocaleString()}`,
      item,
    })), { title: 'Browse SoloSync Backups', placeHolder: 'Choose a project to recover' });
    if (!project) return;
    const snapshots = await repository.list(provider, project.item.projectId);
    const snapshot = await vscode.window.showQuickPick(snapshots.map((manifest) => ({
      label: new Date(manifest.createdAt).toLocaleString(),
      description: manifest.git.message || manifest.reason,
      detail: `${manifest.files.length.toLocaleString()} files`,
      manifest,
    })), { title: project.item.projectName, placeHolder: 'Choose a backup' });
    if (!snapshot) return;
    const action = await vscode.window.showQuickPick([
      { label: '$(folder-opened) Restore Project', description: 'Restore into a new folder', action: 'restore' },
      { label: '$(file) Restore One File', description: 'Choose one file from this backup', action: 'file' },
      { label: '$(verified-filled) Check Integrity', description: 'Verify every backed-up file', action: 'verify' },
    ], { title: new Date(snapshot.manifest.createdAt).toLocaleString(), placeHolder: 'What would you like to do?' });
    if (action?.action === 'restore') await restoreSnapshot(snapshot.manifest, provider, context);
    if (action?.action === 'file') await restoreFile(snapshot.manifest, provider);
    if (action?.action === 'verify') await verifySnapshot(snapshot.manifest, provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`SoloSync could not browse the backups: ${message}`);
  }
}

async function availableRestoreDirectory(parent: string, name: string): Promise<string> {
  for (let suffix = 1; suffix < 1_000; suffix += 1) {
    const candidate = path.join(parent, suffix === 1 ? name : `${name}-${suffix}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('Choose another restore location.');
}

function safeRestoreName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, 'project').slice(0, 80) || 'project';
}

async function restoreSnapshot(manifest: SnapshotManifest | undefined, provider: StorageProvider, context: vscode.ExtensionContext): Promise<void> {
  if (!manifest) return;
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Choose an empty parent folder for the restored workspace' });
  if (!picked?.[0]) return;
  const destination = await availableRestoreDirectory(picked[0].fsPath, `${safeRestoreName(manifest.projectName)}-restored-${manifest.snapshotId.slice(0, 19)}`);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SoloSync is restoring and checking the snapshot', cancellable: false }, () => repository.restoreAll(provider, manifest, destination));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    void vscode.window.showErrorMessage(`SoloSync could not restore this backup: ${message}`);
    return;
  }
  for (const root of manifest.roots) await associateProject(context, path.join(destination, root), manifest.projectId);
  const folderToOpen = manifest.roots.length === 1 ? path.join(destination, manifest.roots[0]) : destination;
  const action = await vscode.window.showInformationMessage(`Snapshot restored to ${destination}`, 'Open Folder');
  if (action === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderToOpen), { forceNewWindow: true });
}

async function restoreFile(manifest: SnapshotManifest | undefined, provider: StorageProvider): Promise<void> {
  if (!manifest) return;
  const pickedFile = await vscode.window.showQuickPick(manifest.files.map((file) => ({ label: file.path, description: file.root, file })), { placeHolder: 'Choose a file to restore' });
  if (!pickedFile) return;
  const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.basename(pickedFile.file.path)), title: 'Restore file as' });
  if (!destination) return;
  try {
    await repository.restoreFile(provider, manifest, pickedFile.file, destination.fsPath);
    void vscode.window.showInformationMessage(`Restored ${pickedFile.file.path}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`SoloSync could not restore this file: ${message}`);
  }
}

async function verifySnapshot(manifest: SnapshotManifest | undefined, provider: StorageProvider): Promise<void> {
  if (!manifest) return;
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SoloSync is checking the snapshot', cancellable: false }, () => repository.verify(provider, manifest));
  if (result.valid) {
    void vscode.window.showInformationMessage(`Snapshot verified: ${result.checked} files are intact.`);
  } else {
    void vscode.window.showErrorMessage(`Snapshot verification failed for ${result.errors.length} files.`);
  }
}

export function deactivate(): void {}
