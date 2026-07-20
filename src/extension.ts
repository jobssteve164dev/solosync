import path from 'node:path';
import * as vscode from 'vscode';
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

export function isDirectoryInsideWorkspace(directory: string, roots: WorkspaceRoot[]): boolean {
  const resolvedDirectory = path.resolve(directory);
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root.path), resolvedDirectory);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tree = new HistoryTreeProvider();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.command = 'solosync.backupNow';
  status.text = '$(archive) SoloSync';
  status.tooltip = 'Create a workspace snapshot';
  status.show();
  context.subscriptions.push(status, vscode.window.registerTreeDataProvider('solosync.history', tree));

  let running: Promise<SnapshotManifest | undefined> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let lastHead = context.workspaceState.get<string>('lastObservedHead');

  const refresh = async (): Promise<void> => {
    const roots = workspaceRoots();
    const directory = backupDirectory();
    if (!directory || roots.length === 0) {
      tree.setSnapshots([]);
      return;
    }
    tree.setSnapshots(await repository.list(directory, projectIdFor(roots)));
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
        directory = await chooseBackupDirectory();
      }
      if (!directory) return undefined;
      if (isDirectoryInsideWorkspace(directory, roots)) {
        void vscode.window.showErrorMessage('Choose a backup location outside the open workspace to prevent recursive snapshots.');
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

  const scheduleIdleBackup = (): void => {
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
      if (await chooseBackupDirectory()) await refresh();
    }),
    vscode.commands.registerCommand('solosync.backupNow', () => backup('Manual backup')),
    vscode.commands.registerCommand('solosync.refresh', refresh),
    vscode.commands.registerCommand('solosync.restoreSnapshot', async (item?: SnapshotItem) => restoreSnapshot(await pickSnapshot(item, tree), backupDirectory())),
    vscode.commands.registerCommand('solosync.restoreFile', async (item?: SnapshotItem) => restoreFile(await pickSnapshot(item, tree), backupDirectory())),
    vscode.commands.registerCommand('solosync.verifySnapshot', async (item?: SnapshotItem) => verifySnapshot(await pickSnapshot(item, tree), backupDirectory())),
  );

  await refresh();
}

async function chooseBackupDirectory(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, title: 'Choose a local or mounted NAS folder for SoloSync backups' });
  const selected = picked?.[0]?.fsPath;
  if (selected) await config().update('backupDirectory', selected, vscode.ConfigurationTarget.Global);
  return selected;
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
