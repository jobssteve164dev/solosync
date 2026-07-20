import * as vscode from 'vscode';
import { SnapshotManifest } from './types';

export class SnapshotItem extends vscode.TreeItem {
  constructor(public readonly manifest: SnapshotManifest) {
    super(new Date(manifest.createdAt).toLocaleString(), vscode.TreeItemCollapsibleState.None);
    this.description = manifest.git.message || manifest.reason;
    this.tooltip = `${manifest.files.length} files · ${formatBytes(manifest.totalBytes)}${manifest.git.head ? `\n${manifest.git.branch ?? 'detached'} · ${manifest.git.head.slice(0, 8)}` : ''}`;
    this.contextValue = 'solosync.snapshot';
    this.iconPath = new vscode.ThemeIcon(manifest.git.dirty ? 'archive' : 'verified-filled');
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export class HistoryTreeProvider implements vscode.TreeDataProvider<SnapshotItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private snapshots: SnapshotManifest[] = [];

  setSnapshots(snapshots: SnapshotManifest[]): void {
    this.snapshots = snapshots;
    this.emitter.fire();
  }

  getTreeItem(element: SnapshotItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SnapshotItem[] {
    return this.snapshots.map((snapshot) => new SnapshotItem(snapshot));
  }
}
