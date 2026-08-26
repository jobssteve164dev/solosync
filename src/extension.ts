import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { BackupLocationKind, backupLocationLabels, isPathInsideDirectory, validateBackupDirectory, validateSourceDirectory } from './backupLocation';
import { BackupSettingsOption, buildBackupSettingsOptions } from './backupSettings';
import { isBackupWorthyGitOperation, readGitState } from './git';
import { HistoryTreeProvider, SnapshotItem } from './historyTree';
import { projectIdFor, SnapshotCancelledError, SnapshotRepository } from './snapshotRepository';
import { LocalFileSystemProvider, normalizeQnapWebDavUrl, QnapWebDavConnection, QnapWebDavProvider, StorageProvider } from './storageProvider';
import { SnapshotManifest, WorkspaceRoot } from './types';

const repository = new SnapshotRepository();
const qnapConnectionKey = 'qnapWebDavConnection';
const qnapPasswordKey = 'solosync.qnapWebDav.password';
const projectAssociationsKey = 'projectAssociations';

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
  return backupLocationKind(context) === 'qnap' ? Boolean(qnapConnection(context)) : Boolean(backupDirectory());
}

async function configuredProvider(context: vscode.ExtensionContext): Promise<StorageProvider | undefined> {
  if (backupLocationKind(context) === 'qnap') {
    const connection = qnapConnection(context);
    const password = await context.secrets.get(qnapPasswordKey);
    if (!connection || !password) return undefined;
    return QnapWebDavProvider.create(connection, password);
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

async function validateProvider(provider: StorageProvider, roots: WorkspaceRoot[]): Promise<void> {
  if (provider.localRoot) {
    await validateBackupDirectory(provider.localRoot, roots);
  } else {
    await provider.validate();
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
      try {
        provider = await configuredProvider(context);
        if (!provider) provider = await chooseBackupLocation(context, roots);
        if (!provider) return undefined;
        await validateProvider(provider, roots);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message, 'Set Backup Location').then((action) => {
          if (action === 'Set Backup Location') void vscode.commands.executeCommand('solosync.configure');
        });
        return undefined;
      }
      if (!provider) return undefined;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('Trust this workspace before creating a SoloSync backup.');
        return undefined;
      }

      status.text = '$(sync~spin) SoloSync: Backing up';
      try {
        const git = await readGitState(roots);
        const projectId = await resolveProjectId(context, provider, roots);
        const manifest = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: `SoloSync is protecting ${projectName(roots)}`,
          cancellable: true,
        }, async (progress, token) => {
          const controller = new AbortController();
          activeBackupController = controller;
          status.command = 'solosync.cancelBackup';
          status.tooltip = 'Click to cancel this backup';
          await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', true);
          const cancellation = token.onCancellationRequested(() => controller.abort());
          let lastCompleted = 0;
          try {
            return await repository.create({
              provider,
              projectId,
              projectName: projectName(roots),
              roots,
              excludes: config().get<string[]>('exclude', []),
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
          } finally {
            cancellation.dispose();
            activeBackupController = undefined;
            status.command = 'solosync.backupNow';
            await vscode.commands.executeCommand('setContext', 'solosync.backupRunning', false);
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
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`SoloSync could not create the backup: ${message}`);
        return undefined;
      }
    })();
    try {
      return await running;
    } finally {
      running = undefined;
    }
  };

  const scheduleIdleBackup = (changed?: vscode.Uri): void => {
    const directory = backupLocationKind(context) === 'qnap' ? undefined : backupDirectory();
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
      description: 'Desktop sync folder',
      detail: 'Choose a folder already synced by Google Drive for desktop.',
      pickerTitle: 'Choose a folder synced by Google Drive for desktop',
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
  if (backupLocationKind(context) === 'qnap') {
    const connection = qnapConnection(context);
    return connection ? new URL(connection.baseUrl).hostname : 'Not connected';
  }
  const directory = backupDirectory();
  return directory ? path.basename(directory) || directory : 'Not selected';
}

async function openBackupSettings(context: vscode.ExtensionContext, refresh: () => Promise<void>): Promise<void> {
  const kind = backupLocationKind(context);
  const connection = kind === 'qnap' ? qnapConnection(context) : undefined;
  const hasQnapPassword = connection ? Boolean(await context.secrets.get(qnapPasswordKey)) : false;
  const destination = connection?.baseUrl ?? backupDirectory();
  const options = buildBackupSettingsOptions({
    kind,
    kindLabel: kind ? backupLocationLabels[kind] : undefined,
    destination,
    qnapUsername: connection?.username,
    qnapPasswordSaved: hasQnapPassword,
    backupAfterCommit: config().get<boolean>('autoBackupAfterCommit', true),
    idleBackupMinutes: config().get<number>('idleBackupMinutes', 10),
    exclusionCount: config().get<string[]>('exclude', []).length,
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
  const setting = {
    commitTiming: 'solosync.autoBackupAfterCommit',
    idleTiming: 'solosync.idleBackupMinutes',
    exclusions: 'solosync.exclude',
  }[selected.action];
  await vscode.commands.executeCommand('workbench.action.openSettings', setting);
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
  if (!provider) provider = await chooseBackupLocation(context, []);
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
