import * as vscode from 'vscode';
import { BackedUpFileTreeNode, BackedUpProject, buildBackedUpFileTree, formatBackedUpFileCount } from './storageProvider';

function formatBytes(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function fileCount(node: BackedUpFileTreeNode): number {
  return node.kind === 'file' ? 1 : node.children.reduce((total, child) => total + fileCount(child), 0);
}

export class BackedUpFileItem extends vscode.TreeItem {
  constructor(public readonly node: BackedUpFileTreeNode) {
    super(node.name, node.kind === 'file' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = node.kind === 'file' ? 'solosync.backedUpFile' : `solosync.backedUp${node.kind[0].toUpperCase()}${node.kind.slice(1)}`;
    this.iconPath = new vscode.ThemeIcon(node.kind === 'project' ? 'root-folder' : node.kind === 'folder' ? 'folder' : 'file');
    this.description = node.kind === 'project' ? formatBackedUpFileCount(fileCount(node)) : node.kind === 'file' ? formatBytes(node.file?.size) : undefined;
    this.tooltip = node.kind === 'file' ? node.path : node.name;
    this.accessibilityInformation = { label: node.kind === 'file' ? `${node.name}, backed-up file` : `${node.name}, ${node.kind}` };
  }
}

export class BackupFilesTreeProvider implements vscode.TreeDataProvider<BackedUpFileItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots?: BackedUpFileTreeNode[];
  private loading?: Promise<BackedUpFileTreeNode[]>;
  private generation = 0;

  constructor(private readonly loadProjects: () => Promise<BackedUpProject[]>) {}

  refresh(): void {
    this.generation += 1;
    this.roots = undefined;
    this.loading = undefined;
    this.emitter.fire();
  }

  getTreeItem(element: BackedUpFileItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BackedUpFileItem): Promise<BackedUpFileItem[]> {
    if (element) return element.node.children.map((node) => new BackedUpFileItem(node));
    if (!this.roots) {
      const generation = this.generation;
      this.loading ??= this.loadProjects().then((projects) => buildBackedUpFileTree(projects));
      const loaded = await this.loading;
      if (generation === this.generation) this.roots = loaded;
      if (generation !== this.generation) return this.getChildren();
    }
    return (this.roots ?? []).map((node) => new BackedUpFileItem(node));
  }
}
