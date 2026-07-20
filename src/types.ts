export interface SnapshotFile {
  root: string;
  path: string;
  size: number;
  modifiedAt: number;
  sha256: string;
}

export interface GitState {
  head?: string;
  branch?: string;
  message?: string;
  operation?: string;
  dirty: boolean;
}

export interface SnapshotManifest {
  formatVersion: 1;
  snapshotId: string;
  projectId: string;
  projectName: string;
  createdAt: string;
  reason: string;
  git: GitState;
  roots: string[];
  files: SnapshotFile[];
  totalBytes: number;
}

export interface WorkspaceRoot {
  name: string;
  path: string;
}
