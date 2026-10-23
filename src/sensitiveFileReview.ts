import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceRoot } from './types';
import { isExcludedPath } from './exclusions';

export interface SensitiveFile {
  key: string;
  root: string;
  path: string;
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, 'root').slice(0, 80) || 'root';
}

export function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.env'
    || lower.startsWith('.env.')
    || lower.endsWith('.pem')
    || lower.endsWith('.key')
    || lower.startsWith('id_rsa');
}

export async function scanSensitiveFiles(roots: WorkspaceRoot[], excludes: string[], signal?: AbortSignal): Promise<SensitiveFile[]> {
  const found: SensitiveFile[] = [];
  for (const root of roots) {
    const rootName = safeSegment(root.name);
    const walk = async (directory: string): Promise<void> => {
      if (signal?.aborted) throw new Error('The operation was canceled.');
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (signal?.aborted) throw new Error('The operation was canceled.');
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root.path, absolute);
        if (entry.isSymbolicLink() || isExcludedPath(relative, entry.name, excludes)) continue;
        if (entry.isDirectory()) await walk(absolute);
        if (entry.isFile() && isSensitiveFileName(entry.name)) {
          const portablePath = relative.split(path.sep).join('/');
          found.push({ key: `${rootName}/${portablePath}`, root: rootName, path: portablePath });
        }
      }
    };
    await walk(root.path);
  }
  return found.sort((left, right) => left.key.localeCompare(right.key));
}
