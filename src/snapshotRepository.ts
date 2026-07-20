import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SnapshotFile, SnapshotManifest, WorkspaceRoot } from './types';

export interface CreateSnapshotOptions {
  backupDirectory: string;
  projectId: string;
  projectName: string;
  roots: WorkspaceRoot[];
  excludes: string[];
  reason: string;
  git: SnapshotManifest['git'];
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, 'root').slice(0, 80) || 'root';
}

function shouldExclude(relativePath: string, name: string, excludes: string[]): boolean {
  const segments = relativePath.split(path.sep);
  return excludes.some((rule) => {
    if (rule.startsWith('*.')) {
      return name.toLowerCase().endsWith(rule.slice(1).toLowerCase());
    }
    return name === rule || segments.includes(rule);
  });
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function collectFiles(root: WorkspaceRoot, excludes: string[]): Promise<Array<{ absolute: string; relative: string }>> {
  const files: Array<{ absolute: string; relative: string }> = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root.path, absolute);
      if (shouldExclude(relative, entry.name, excludes) || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({ absolute, relative });
      }
    }
  }
  await walk(root.path);
  return files;
}

async function copyConsistent(source: string, destination: string): Promise<{ size: number; modifiedAt: number; sha256: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await stat(source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    const after = await stat(source);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) {
      return { size: after.size, modifiedAt: after.mtimeMs, sha256: await sha256(destination) };
    }
  }
  throw new Error(`File kept changing while it was being backed up: ${path.basename(source)}`);
}

export function projectIdFor(roots: WorkspaceRoot[]): string {
  return createHash('sha256').update(roots.map((root) => path.resolve(root.path)).sort().join('\n')).digest('hex').slice(0, 16);
}

export class SnapshotRepository {
  async create(options: CreateSnapshotOptions): Promise<SnapshotManifest> {
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
    const projectDirectory = path.join(options.backupDirectory, 'SoloSync', options.projectId);
    const stagingDirectory = path.join(projectDirectory, 'staging', snapshotId);
    const finalDirectory = path.join(projectDirectory, 'snapshots', snapshotId);
    const manifestFiles: SnapshotFile[] = [];
    let totalBytes = 0;

    await mkdir(stagingDirectory, { recursive: true });
    try {
      for (const root of options.roots) {
        const rootName = safeSegment(root.name);
        for (const file of await collectFiles(root, options.excludes)) {
          const destination = path.join(stagingDirectory, 'files', rootName, file.relative);
          const copied = await copyConsistent(file.absolute, destination);
          totalBytes += copied.size;
          manifestFiles.push({ root: rootName, path: file.relative.split(path.sep).join('/'), ...copied });
        }
      }
      const manifest: SnapshotManifest = {
        formatVersion: 1,
        snapshotId,
        projectId: options.projectId,
        projectName: options.projectName,
        createdAt: new Date().toISOString(),
        reason: options.reason,
        git: options.git,
        roots: options.roots.map((root) => safeSegment(root.name)),
        files: manifestFiles,
        totalBytes,
      };
      await writeFile(path.join(stagingDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await mkdir(path.dirname(finalDirectory), { recursive: true });
      await rename(stagingDirectory, finalDirectory);
      return manifest;
    } catch (error) {
      throw error;
    }
  }

  async list(backupDirectory: string, projectId: string): Promise<SnapshotManifest[]> {
    const directory = path.join(backupDirectory, 'SoloSync', projectId, 'snapshots');
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return [];
    }
    const manifests: SnapshotManifest[] = [];
    for (const entry of entries) {
      try {
        manifests.push(JSON.parse(await readFile(path.join(directory, entry, 'manifest.json'), 'utf8')) as SnapshotManifest);
      } catch {
        // An invalid folder is never presented as a restorable snapshot.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async verify(backupDirectory: string, manifest: SnapshotManifest): Promise<{ valid: boolean; checked: number; errors: string[] }> {
    const base = path.join(backupDirectory, 'SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files');
    const errors: string[] = [];
    for (const file of manifest.files) {
      const source = path.join(base, file.root, ...file.path.split('/'));
      try {
        if (await sha256(source) !== file.sha256) {
          errors.push(file.path);
        }
      } catch {
        errors.push(file.path);
      }
    }
    return { valid: errors.length === 0, checked: manifest.files.length, errors };
  }

  async restoreAll(backupDirectory: string, manifest: SnapshotManifest, destination: string): Promise<void> {
    const base = path.join(backupDirectory, 'SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files');
    for (const file of manifest.files) {
      const source = path.join(base, file.root, ...file.path.split('/'));
      const target = path.join(destination, file.root, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }

  async restoreFile(backupDirectory: string, manifest: SnapshotManifest, file: SnapshotFile, destination: string): Promise<void> {
    const source = path.join(backupDirectory, 'SoloSync', manifest.projectId, 'snapshots', manifest.snapshotId, 'files', file.root, ...file.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}
