import path from 'node:path';
import * as vscode from 'vscode';
import { BackupLocationKind, backupLocationLabels, isPathInsideDirectory, validateBackupDirectory } from './backupLocation';
import { isBackupWorthyGitOperation, readGitState } from './git';
import { HistoryTreeProvider, SnapshotItem } from './historyTree';
import { projectIdFor, SnapshotRepository } from './snapshotRepository';
import { SnapshotManifest, WorkspaceRoot } from './types';

const repository = new SnapshotRepository();

function workspaceRoots(): WorkspaceRoot[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((folder) => folder.uri.scheme === 'file')
    .map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
}

function projectName(roots: WorkspaceRoot[]): string {
  return vscode.workspace.name || roots.map((root) => root.name).join(' + ') || 'Workspace';
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
  let idleTimer: NodeJS.Timeout | undefined;
  let lastHead = context.workspaceState.get<string>('lastObservedHead');

  const refresh = async (): Promise<void> => {
    const roots = workspaceRoots();
    const directory = backupDirectory();
    await vscode.commands.executeCommand('setContext', 'solosync.hasBackupLocation', Boolean(directory));
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
      treeView.message = `${kind ? backupLocationLabels[kind] : 'Backup folder'} · ${path.basename(directory) || directory}`;
      status.command = 'solosync.backupNow';
      if (status.text === '$(gear) SoloSync: Set up' || status.text === '$(warning) SoloSync: Location unavailable') {
        status.text = '$(archive) SoloSync';
        status.tooltip = 'Create a workspace snapshot';
      }
      if (roots.length === 0) {
        tree.setSnapshots([]);
        return;
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
      const roots = workspaceRoots();
      if (roots.length === 0) {
        void vscode.window.showInformationMessage('Open a local folder before creating a SoloSync backup.');
        return undefined;
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
          title: 'SoloSync is protecting this workspace',
          cancellable: false,
        }, () => repository.create({
          backupDirectory: directory!,
          projectId: projectIdFor(roots),
          projectName: projectName(roots),
          roots,
          excludes: config().get<string[]>('exclude', []),
          reason,
          git,
        }));
        await context.workspaceState.update('lastObservedHead', git.head);
        lastHead = git.head;
        status.text = '$(verified-filled) SoloSync: Protected';
        status.tooltip = `Last backup ${new Date(manifest.createdAt).toLocaleString()}`;
        await refresh();
        return manifest;
      } catch (error) {
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
    const git = await readGitState(workspaceRoots());
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
    vscode.commands.registerCommand('solosync.configure', async () => {
      const selected = await chooseBackupDirectory(context, workspaceRoots());
      if (!selected) return;
      await refresh();
      const action = await vscode.window.showInformationMessage('Backup location is ready.', 'Back Up Now');
      if (action === 'Back Up Now') await backup('Manual backup');
    }),
    vscode.commands.registerCommand('solosync.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:SZLK.solosync')),
    vscode.commands.registerCommand('solosync.backupNow', () => backup('Manual backup')),
    vscode.commands.registerCommand('solosync.refresh', refresh),
    vscode.commands.registerCommand('solosync.restoreSnapshot', async (item?: SnapshotItem) => restoreSnapshot(await pickSnapshot(item, tree), backupDirectory())),
    vscode.commands.registerCommand('solosync.restoreFile', async (item?: SnapshotItem) => restoreFile(await pickSnapshot(item, tree), backupDirectory())),
    vscode.commands.registerCommand('solosync.verifySnapshot', async (item?: SnapshotItem) => verifySnapshot(await pickSnapshot(item, tree), backupDirectory())),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('solosync.backupDirectory')) void refresh();
    }),
  );

  await refresh();
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
  const roots = workspaceRoots();
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
