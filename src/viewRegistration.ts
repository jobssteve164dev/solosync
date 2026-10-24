import type * as vscode from 'vscode';

export interface TreeViewRegistrationApi {
  getCommands(filterInternal?: boolean): Thenable<string[]>;
  createTreeView<T>(viewId: string, options: vscode.TreeViewOptions<T>): vscode.TreeView<T>;
}

export async function createBackupFilesTreeView<T>(
  api: TreeViewRegistrationApi,
  treeDataProvider: vscode.TreeDataProvider<T>,
): Promise<vscode.TreeView<T> | undefined> {
  const commands = await api.getCommands(true);
  if (!commands.includes('solosync.files.focus')) return undefined;
  return api.createTreeView('solosync.files', { treeDataProvider });
}
