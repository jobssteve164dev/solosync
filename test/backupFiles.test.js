const assert = require('node:assert/strict');
const test = require('node:test');
const storage = require('../out/storageProvider.js');

test('builds a project-folder-file hierarchy from backed-up files without flattening equal names', () => {
  assert.equal(typeof storage.buildBackedUpFileTree, 'function');
  const tree = storage.buildBackedUpFileTree([
    {
      projectId: 'project-b',
      name: 'Website',
      files: [
        { id: 'file-2', path: 'src/index.ts', size: 20, sourcePathHash: 'hash-2', externalUri: 'https://drive.google.com/open?id=file-2' },
        { id: 'file-1', path: 'README.md', size: 10, sourcePathHash: 'hash-1', externalUri: 'https://drive.google.com/open?id=file-1' },
        { id: 'file-3', path: 'test/index.ts', size: 30, sourcePathHash: 'hash-3', externalUri: 'https://drive.google.com/open?id=file-3' },
      ],
    },
    { projectId: 'project-a', name: 'API', files: [] },
  ]);

  assert.deepEqual(tree.map((item) => [item.kind, item.name]), [['project', 'API'], ['project', 'Website']]);
  assert.deepEqual(tree[1].children.map((item) => [item.kind, item.name]), [
    ['folder', 'src'],
    ['folder', 'test'],
    ['file', 'README.md'],
  ]);
  assert.equal(tree[1].children[0].children[0].file.id, 'file-2');
  assert.equal(tree[1].children[1].children[0].file.id, 'file-3');
});

test('formats project file counts with the correct singular and plural labels', () => {
  assert.equal(typeof storage.formatBackedUpFileCount, 'function');
  assert.equal(storage.formatBackedUpFileCount(0), '0 files');
  assert.equal(storage.formatBackedUpFileCount(1), '1 file');
  assert.equal(storage.formatBackedUpFileCount(2), '2 files');
});
