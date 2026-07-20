import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitState, WorkspaceRoot } from './types';

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return result.stdout.trim();
}

export async function readGitState(roots: WorkspaceRoot[]): Promise<GitState> {
  const root = roots[0];
  if (!root) {
    return { dirty: false };
  }
  try {
    const [head, branch, message, operation, status] = await Promise.all([
      git(root.path, ['rev-parse', 'HEAD']),
      git(root.path, ['branch', '--show-current']),
      git(root.path, ['log', '-1', '--pretty=%s']),
      git(root.path, ['reflog', '-1', '--format=%gs']),
      git(root.path, ['status', '--porcelain']),
    ]);
    return { head, branch: branch || undefined, message: message || undefined, operation: operation || undefined, dirty: status.length > 0 };
  } catch {
    return { dirty: false };
  }
}

export function isBackupWorthyGitOperation(operation: string | undefined): boolean {
  if (!operation) return true;
  return /^(commit|merge|rebase|cherry-pick|revert)(\s|:|\()/i.test(operation);
}
