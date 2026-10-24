const assert = require('node:assert/strict');
const test = require('node:test');
const { createBackupFilesTreeView } = require('../out/viewRegistration.js');

test('does not register Backup Files while the host still has the previous view manifest', async () => {
  const createdView = { dispose() {} };
  const provider = { getChildren: async () => [], getTreeItem: (item) => item };
  const result = await createBackupFilesTreeView({
    getCommands: async () => ['solosync.history.focus'],
    createTreeView: () => createdView,
  }, provider);

  assert.equal(result, undefined);
});

test('registers Backup Files when the host exposes its contributed focus command', async () => {
  const createdView = { dispose() {} };
  const provider = { getChildren: async () => [], getTreeItem: (item) => item };
  const result = await createBackupFilesTreeView({
    getCommands: async () => ['solosync.history.focus', 'solosync.files.focus'],
    createTreeView: (viewId, options) => {
      assert.equal(viewId, 'solosync.files');
      assert.equal(options.treeDataProvider, provider);
      return createdView;
    },
  }, provider);

  assert.equal(result, createdView);
});
