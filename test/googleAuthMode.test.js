const assert = require('node:assert/strict');
const test = require('node:test');
const { googleAuthMode, shouldRequestGoogleSignIn } = require('../out/googleAuthMode.js');

test('uses loopback only when the extension and browser share the local desktop', () => {
  assert.equal(googleAuthMode({ uiKind: 'desktop' }), 'desktop');
  assert.equal(googleAuthMode({ uiKind: 'desktop', remoteName: 'ssh-remote' }), 'hosted');
  assert.equal(googleAuthMode({ uiKind: 'web' }), 'hosted');
  assert.equal(googleAuthMode({ uiKind: 'web', remoteName: 'coder' }), 'hosted');
});

test('only an explicit user backup may open Google sign-in', () => {
  assert.equal(shouldRequestGoogleSignIn('Manual backup'), true);
  assert.equal(shouldRequestGoogleSignIn('Workspace idle'), false);
  assert.equal(shouldRequestGoogleSignIn('Git commit'), false);
  assert.equal(shouldRequestGoogleSignIn('Resume interrupted backup'), false);
});
