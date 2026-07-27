import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceRoot } from './types';

export type BackupLocationKind = 'googleDrive' | 'nas' | 'local';

export const backupLocationLabels: Record<BackupLocationKind, string> = {
  googleDrive: 'Google Drive',
  nas: 'NAS',
  local: 'Local or external drive',
};

export function isPathInsideDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function isDirectoryInsideWorkspace(directory: string, roots: WorkspaceRoot[]): boolean {
  return roots.some((root) => isPathInsideDirectory(directory, root.path));
}

export async function validateBackupDirectory(directory: string, roots: WorkspaceRoot[]): Promise<void> {
  let metadata;
  try {
    metadata = await stat(directory);
  } catch {
    throw new Error('The backup location is unavailable. Reconnect the drive or NAS and try again.');
  }
  if (!metadata.isDirectory()) {
    throw new Error('Choose a folder for SoloSync backups.');
  }
  if (roots.some((root) => path.resolve(root.path) === path.resolve(directory))) {
    throw new Error('Choose a backup folder instead of the open workspace itself.');
  }
  try {
    await access(directory, constants.R_OK);
  } catch {
    throw new Error('SoloSync cannot read this location. Check its permissions and try again.');
  }
  try {
    await access(directory, constants.W_OK);
  } catch {
    throw new Error('SoloSync cannot write to this location. Check its permissions and try again.');
  }
}
