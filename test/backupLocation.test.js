const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { isDirectoryInsideWorkspace, validateBackupDirectory, validateSourceDirectory } = require('../out/backupLocation.js');

test('accepts a writable backup folder outside the workspace', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(temp, 'backup');
  await mkdir(workspace);
  await mkdir(backup);

  assert.equal(isDirectoryInsideWorkspace(backup, [{ name: 'workspace', path: workspace }]), false);
  await validateBackupDirectory(backup, [{ name: 'workspace', path: workspace }]);
});

test('allows a dedicated backup folder inside a broader workspace', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));
  const workspace = path.join(temp, 'workspace');
  const backup = path.join(workspace, 'backup');
  await mkdir(backup, { recursive: true });

  assert.equal(isDirectoryInsideWorkspace(backup, [{ name: 'workspace', path: workspace }]), true);
  await validateBackupDirectory(backup, [{ name: 'workspace', path: workspace }]);
});

test('rejects using the open workspace itself as the backup folder', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));

  await assert.rejects(validateBackupDirectory(workspace, [{ name: 'workspace', path: workspace }]), /workspace itself/);
});

test('rejects missing locations and files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'solosync-location-'));
  const file = path.join(temp, 'backup.txt');
  await writeFile(file, 'not a directory');

  await assert.rejects(validateBackupDirectory(path.join(temp, 'missing'), []), /unavailable/);
  await assert.rejects(validateBackupDirectory(file, []), /Choose a folder/);
  await assert.rejects(validateSourceDirectory(path.join(temp, 'missing')), /project folder is unavailable/);
  await assert.rejects(validateSourceDirectory(file), /Choose a project folder/);
});

test('sidebar exposes setup, settings, and recovery entry points', () => {
  const manifest = require('../package.json');
  const titleCommands = manifest.contributes.menus['view/title'].map((item) => item.command);
  assert.ok(titleCommands.includes('solosync.setup'));
  assert.ok(manifest.contributes.commands.some((item) => item.command === 'solosync.configureSource'));
  assert.ok(manifest.contributes.commands.some((item) => item.command === 'solosync.cancelBackup'));
  assert.ok(manifest.contributes.commands.some((item) => item.command === 'solosync.browseBackups'));
  assert.ok(manifest.contributes.menus['view/title'].some((item) => item.command === 'solosync.cancelBackup' && item.when.includes('solosync.backupRunning')));
  assert.ok(manifest.contributes.configuration.properties['solosync.sourceDirectory']);
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.when.includes('!solosync.hasSourceDirectory')));
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.when.includes('!solosync.hasBackupLocation')));
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.when.includes('!solosync.backupLocationAvailable')));
  assert.ok(manifest.contributes.viewsWelcome.some((item) => item.contents.includes('command:solosync.browseBackups')));
});
