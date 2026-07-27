const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isDirectoryInsideWorkspace, validateBackupDirectory } = require('../out/backupLocation.js');

test('accepts a writable backup folder outside the workspace', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await mkdir(backup);

  assert.equal(isDirectoryInsideWorkspace(backup, [{ name: 'workspace', path: workspace }]), false);
  await validateBackupDirectory(backup, [{ name: 'workspace', path: workspace }]);
});

test('rejects folders inside the open workspace', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(workspace, 'backup');
  await mkdir(backup, { recursive: true });

  await assert.rejects(
    validateBackupDirectory(backup, [{ name: 'workspace', path: workspace }]),
    /outside the open workspace/,
  );
});

test('rejects missing locations and files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));
  const file = path.join(temp, 'backup.txt');
  await writeFile(file, 'not a directory');

  await assert.rejects(validateBackupDirectory(path.join(temp, 'missing'), []), /unavailable/);
  await assert.rejects(validateBackupDirectory(file, []), /Choose a folder/);
});

test('sidebar exposes setup, settings, and recovery entry points', () => {
  const manifest = require('../package.json');
  const titleCommands = manifest.contributes.menus['view/title'].map((item) => item.command);
  assert.ok(titleCommands.includes('solosync.configure'));
  assert.ok(titleCommands.includes('solosync.openSettings'));
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.when.includes('!solosync.hasBackupLocation')));
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.when.includes('!solosync.backupLocationAvailable')));
});
