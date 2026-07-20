const assert = require('node:assert/strict');
const test = require('node:test');
const { isBackupWorthyGitOperation } = require('../out/git.js');

test('backs up commit-producing Git operations', () => {
  for (const operation of ['commit: add feature', 'commit (amend): revise', 'merge feature', 'rebase (finish): refs/heads/main', 'cherry-pick: fix', 'revert: bad change']) {
    assert.equal(isBackupWorthyGitOperation(operation), true, operation);
  }
});

test('does not treat branch switches and resets as commits', () => {
  assert.equal(isBackupWorthyGitOperation('checkout: moving from main to feature'), false);
  assert.equal(isBackupWorthyGitOperation('reset: moving to HEAD~1'), false);
});
