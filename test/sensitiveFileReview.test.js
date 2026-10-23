const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanSensitiveFiles } = require('../out/sensitiveFileReview.js');

test('finds high-risk files by exact project-relative path without following symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-sensitive-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, '.env'), 'TOKEN=secret');
  await writeFile(path.join(root, '.env.production'), 'TOKEN=secret');
  await writeFile(path.join(root, 'config', 'server.pem'), 'certificate');
  await writeFile(path.join(root, 'config', 'signing.key'), 'key');
  await writeFile(path.join(root, 'id_rsa_backup'), 'private key');
  await writeFile(path.join(root, 'README.md'), 'safe');

  const found = await scanSensitiveFiles([{ name: 'Project', path: root }], []);

  assert.deepEqual(found.map((item) => item.key), [
    'Project/.env',
    'Project/.env.production',
    'Project/config/server.pem',
    'Project/config/signing.key',
    'Project/id_rsa_backup',
  ]);
});

test('does not prompt for files already removed by ordinary exclusion rules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'solosync-sensitive-'));
  await mkdir(path.join(root, 'secrets'), { recursive: true });
  await writeFile(path.join(root, 'secrets', '.env'), 'TOKEN=secret');
  await writeFile(path.join(root, 'visible.key'), 'key');

  const found = await scanSensitiveFiles([{ name: 'Project', path: root }], ['secrets']);

  assert.deepEqual(found.map((item) => item.key), ['Project/visible.key']);
});
