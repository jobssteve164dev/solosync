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

test('shows the connected Google account without exposing OAuth implementation choices', () => {
  const options = buildBackupSettingsOptions({
    kind: 'googleDrive',
    kindLabel: 'Google Drive',
    destination: 'SoloSync Backups',
    googleAccount: 'person@example.com',
    googleConnected: true,
    qnapPasswordSaved: false,
    backupAfterCommit: true,
    idleBackupMinutes: 10,
    exclusionCount: 9,
    sensitiveDecisionCount: 3,
    pendingBackup: { state: 'uploading', occupiedBytes: 1536, createdAt: '2026-10-23T00:00:00.000Z' },
  });

  assert.equal(options[0].description, 'Google Drive · SoloSync Backups');
  const connection = options.find((option) => option.action === 'googleConnection');
  assert.equal(connection.description, 'person@example.com');
  assert.match(connection.detail, /Connected/);
  assert.doesNotMatch(connection.detail, /OAuth|loopback|callback|client/i);
  const sensitiveFiles = options.find((option) => option.action === 'sensitiveFiles');
  assert.equal(sensitiveFiles.description, '3 remembered choices');
  assert.match(sensitiveFiles.detail, /review .* again/i);
  const pending = options.find((option) => option.action === 'pendingBackup');
  assert.match(pending.description, /1\.5 KB/);
  assert.match(pending.detail, /continue or abandon/i);
});

test('offers a clear sign-in action when a saved Google Drive connection expires', () => {
  const options = buildBackupSettingsOptions({
    kind: 'googleDrive',
    kindLabel: 'Google Drive',
    destination: 'SoloSync Backups',
    googleAccount: 'person@example.com',
    googleConnected: false,
    qnapPasswordSaved: false,
    backupAfterCommit: true,
    idleBackupMinutes: 10,
    exclusionCount: 9,
  });

  const connection = options.find((option) => option.action === 'googleConnection');
  assert.equal(connection.description, 'Sign in again');
  assert.match(connection.detail, /sign in again/i);
  assert.doesNotMatch(connection.detail, /OAuth|token|credential|grant/i);
});

test('keeps an unfinished Google Drive backup visible after switching locations', () => {
  const options = buildBackupSettingsOptions({
    kind: 'nas', kindLabel: 'NAS', destination: '/mnt/backups', qnapPasswordSaved: false,
    backupAfterCommit: true, idleBackupMinutes: 10, exclusionCount: 9,
    pendingBackup: { state: 'uploading', occupiedBytes: 2048, createdAt: '2026-10-23T00:00:00.000Z' },
  });

  const pending = options.find((option) => option.action === 'pendingBackup');
  assert.ok(pending);
  assert.match(pending.label, /Google Drive/);
  assert.match(pending.detail, /reconnect/i);
});
