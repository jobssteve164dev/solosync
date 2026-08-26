const assert = require('node:assert/strict');
const test = require('node:test');
const { buildBackupSettingsOptions } = require('../out/backupSettings.js');

test('shows the complete QNAP transfer and authentication chain in backup settings', () => {
  const options = buildBackupSettingsOptions({
    kind: 'qnap',
    kindLabel: 'QNAP NAS',
    destination: 'https://backup.example.com/Backups',
    qnapUsername: 'solosync-backup',
    qnapPasswordSaved: true,
    backupAfterCommit: true,
    idleBackupMinutes: 10,
    exclusionCount: 9,
  });

  assert.equal(options[0].description, 'QNAP NAS · https://backup.example.com/Backups');
  const connection = options.find((option) => option.action === 'qnapConnection');
  assert.equal(connection.description, 'https://backup.example.com/Backups');
  assert.match(connection.detail, /Account: solosync-backup/);
  assert.match(connection.detail, /Password saved in VS Code secure storage/);
  assert.match(connection.detail, /Basic or Digest selected automatically/);
});

test('explains who manages transfer and authentication for a mounted NAS', () => {
  const options = buildBackupSettingsOptions({
    kind: 'nas',
    kindLabel: 'NAS',
    destination: '/mnt/team-backups',
    qnapPasswordSaved: false,
    backupAfterCommit: false,
    idleBackupMinutes: 0,
    exclusionCount: 2,
  });

  assert.equal(options[0].description, 'NAS · /mnt/team-backups');
  assert.match(options[0].detail, /operating system manages the NAS connection and sign-in/);
  assert.equal(options.find((option) => option.action === 'commitTiming').description, 'Off');
  assert.equal(options.find((option) => option.action === 'idleTiming').description, 'Off');
});
