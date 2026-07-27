import path from 'node:path';
import * as vscode from 'vscode';
import { BackupLocationKind, backupLocationLabels, isPathInsideDirectory, validateBackupDirectory, validateSourceDirectory } from './backupLocation';
import { isBackupWorthyGitOperation, readGitState } from './git';
import { HistoryTreeProvider, SnapshotItem } from './historyTree';
import { projectIdFor, SnapshotCancelledError, SnapshotRepository } from './snapshotRepository';
import { SnapshotManifest, WorkspaceRoot } from './types';

const repository = new SnapshotRepository();

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
    const directory = backupDirectory();
    await vscode.commands.executeCommand('setContext', 'solosync.hasSourceDirectory', Boolean(source));
    await vscode.commands.executeCommand('setContext', 'solosync.hasBackupLocation', Boolean(directory));
    if (!source) {
      tree.setSnapshots([]);
      treeView.message = undefined;
      status.command = 'solosync.configureSource';
      status.text = '$(root-folder) SoloSync: Choose project';
      status.tooltip = 'Choose the project folder SoloSync should protect';
      await vscode.commands.executeCommand('setContext', 'solosync.sourceDirectoryAvailable', false);
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', false);
      return;
    }
    try {
      await validateSourceDirectory(source);
      await vscode.commands.executeCommand('setContext', 'solosync.sourceDirectoryAvailable', true);
    } catch {
      tree.setSnapshots([]);
      treeView.message = undefined;
      status.command = 'solosync.configureSource';
      status.text = '$(warning) SoloSync: Project unavailable';
      status.tooltip = 'Reconnect the project folder or choose another one';
      await vscode.commands.executeCommand('setContext', 'solosync.sourceDirectoryAvailable', false);
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', false);
      return;
    }
    if (!directory) {
      tree.setSnapshots([]);
      treeView.message = undefined;
      status.command = 'solosync.configure';
      status.text = '$(gear) SoloSync: Set up';
      status.tooltip = 'Choose where SoloSync stores backups';
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', false);
      return;
    }
    try {
      await validateBackupDirectory(directory, roots);
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', true);
      const kind = backupLocationKind(context);
      treeView.message = `${roots[0].name} → ${kind ? backupLocationLabels[kind] : 'Backup folder'} · ${path.basename(directory) || directory}`;
      status.command = 'solosync.backupNow';
      if (status.text === '$(root-folder) SoloSync: Choose project' || status.text === '$(gear) SoloSync: Set up' || status.text === '$(warning) SoloSync: Project unavailable' || status.text === '$(warning) SoloSync: Location unavailable') {
        status.text = '$(archive) SoloSync';
        status.tooltip = `Back up ${roots[0].name}`;
      }
      tree.setSnapshots(await repository.list(directory, projectIdFor(roots)));
    } catch {
      tree.setSnapshots([]);
      treeView.message = undefined;
      status.command = 'solosync.configure';
      status.text = '$(warning) SoloSync: Location unavailable';
      status.tooltip = 'Reconnect the backup location or choose another folder';
      await vscode.commands.executeCommand('setContext', 'solosync.backupLocationAvailable', false);
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
      let directory = backupDirectory();
      if (!directory) {
        directory = await chooseBackupDirectory(context, roots);
      }
      if (!directory) return undefined;
      try {
        await validateBackupDirectory(directory, roots);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(message, 'Set Backup Location').then((action) => {
          if (action === 'Set Backup Location') void vscode.commands.executeCommand('solosync.configure');
        });
        return undefined;
      }
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('Trust this workspace before creating a SoloSync backup.');
        return undefined;
      }

      status.text = '$(sync~spin) SoloSync: Backing up';
      try {
        const git = await readGitState(roots);
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
              backupDirectory: directory!,
              projectId: projectIdFor(roots),
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
    const directory = backupDirectory();
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
        { label: '$(folder-opened) Backup location', description: backupDirectory() ? path.basename(backupDirectory()!) : 'Not selected', command: 'solosync.configure' },
        { label: '$(gear) Backup options', description: 'Timing and exclusions', command: 'solosync.openSettings' },
      ], { title: 'SoloSync Setup', placeHolder: 'What would you like to configure?' });
      if (action) await vscode.commands.executeCommand(action.command);
    }),
    vscode.commands.registerCommand('solosync.configureSource', async () => {
      const selected = await chooseSourceDirectory();
      if (!selected) return;
      lastHead = undefined;
      await context.workspaceState.update('lastObservedHead', undefined);
      await refresh();
      if (!backupDirectory()) await vscode.commands.executeCommand('solosync.configure');
    }),
    vscode.commands.registerCommand('solosync.configure', async () => {
      let roots = protectedRoots();
      if (roots.length === 0) {
        const source = await chooseSourceDirectory();
        if (!source) return;
        roots = protectedRoots();
      }
      const selected = await chooseBackupDirectory(context, roots);
      if (!selected) return;
      await refresh();
      const action = await vscode.window.showInformationMessage('Backup location is ready.', 'Back Up Now');
      if (action === 'Back Up Now') await backup('Manual backup');
    }),
    vscode.commands.registerCommand('solosync.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:SZLK.solosync')),
    vscode.commands.registerCommand('solosync.backupNow', () => backup('Manual backup')),
    vscode.commands.registerCommand('solosync.cancelBackup', () => activeBackupController?.abort()),
    vscode.commands.registerCommand('solosync.refresh', refresh),
    vscode.commands.registerCommand('solosync.restoreSnapshot', async (item?: SnapshotItem) => restoreSnapshot(await pickSnapshot(item, tree), backupDirectory())),
    vscode.commands.registerCommand('solosync.restoreFile', async (item?: SnapshotItem) => restoreFile(await pickSnapshot(item, tree), backupDirectory())),
    vscode.commands.registerCommand('solosync.verifySnapshot', async (item?: SnapshotItem) => verifySnapshot(await pickSnapshot(item, tree), backupDirectory())),
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
  pickerTitle: string;
}

async function chooseBackupDirectory(context: vscode.ExtensionContext, roots: WorkspaceRoot[]): Promise<string | undefined> {
  const option = await vscode.window.showQuickPick<BackupLocationOption>([
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
  const currentDirectory = backupDirectory();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: currentDirectory ? vscode.Uri.file(currentDirectory) : undefined,
    openLabel: 'Use This Folder',
    title: option.pickerTitle,
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
  return selected;
}

function backupLocationKind(context: vscode.ExtensionContext): BackupLocationKind | undefined {
  const value = context.globalState.get<string>('backupLocationKind');
  return value === 'googleDrive' || value === 'nas' || value === 'local' ? value : undefined;
}

async function pickSnapshot(item: SnapshotItem | undefined, _tree: HistoryTreeProvider): Promise<SnapshotManifest | undefined> {
  if (item?.manifest) return item.manifest;
  const directory = backupDirectory();
  const roots = protectedRoots();
  if (!directory || roots.length === 0) return undefined;
  const snapshots = await repository.list(directory, projectIdFor(roots));
  const picked = await vscode.window.showQuickPick(snapshots.map((manifest) => ({
    label: new Date(manifest.createdAt).toLocaleString(),
    description: manifest.git.message || manifest.reason,
    manifest,
  })), { placeHolder: 'Choose a SoloSync snapshot' });
  return picked?.manifest;
}

async function restoreSnapshot(manifest: SnapshotManifest | undefined, directory: string | undefined): Promise<void> {
  if (!manifest || !directory) return;
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Choose an empty parent folder for the restored workspace' });
  if (!picked?.[0]) return;
  const destination = path.join(picked[0].fsPath, `${manifest.projectName}-restored-${manifest.snapshotId.slice(0, 19)}`);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SoloSync is restoring the snapshot', cancellable: false }, () => repository.restoreAll(directory, manifest, destination));
  const action = await vscode.window.showInformationMessage(`Snapshot restored to ${destination}`, 'Open Folder');
  if (action === 'Open Folder') await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), { forceNewWindow: true });
}

async function restoreFile(manifest: SnapshotManifest | undefined, directory: string | undefined): Promise<void> {
  if (!manifest || !directory) return;
  const pickedFile = await vscode.window.showQuickPick(manifest.files.map((file) => ({ label: file.path, description: file.root, file })), { placeHolder: 'Choose a file to restore' });
  if (!pickedFile) return;
  const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.basename(pickedFile.file.path)), title: 'Restore file as' });
  if (!destination) return;
  await repository.restoreFile(directory, manifest, pickedFile.file, destination.fsPath);
  void vscode.window.showInformationMessage(`Restored ${pickedFile.file.path}`);
}

async function verifySnapshot(manifest: SnapshotManifest | undefined, directory: string | undefined): Promise<void> {
  if (!manifest || !directory) return;
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'SoloSync is checking the snapshot', cancellable: false }, () => repository.verify(directory, manifest));
  if (result.valid) {
    void vscode.window.showInformationMessage(`Snapshot verified: ${result.checked} files are intact.`);
  } else {
    void vscode.window.showErrorMessage(`Snapshot verification failed for ${result.errors.length} files.`);
  }
}

export function deactivate(): void {}
