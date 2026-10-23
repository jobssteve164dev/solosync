const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('runs a lockfile-pinned Wrangler during release', () => {
  const packageJson = require('../package.json');
  const workflow = require('node:fs').readFileSync(path.resolve(__dirname, '../.github/workflows/publish.yml'), 'utf8');
  assert.match(packageJson.devDependencies.wrangler, /^\d+\.\d+\.\d+$/);
  assert.match(workflow, /npx --no-install wrangler deploy/);
  assert.doesNotMatch(workflow, /wrangler@/);
  assert.equal(packageJson.displayName, 'SoloSync');
});

test('waits for the deployed authorization service to become reachable', () => {
  const workflow = require('node:fs').readFileSync(path.resolve(__dirname, '../.github/workflows/publish.yml'), 'utf8');
  assert.match(workflow, /for \(let attempt = 0; attempt < 6; attempt \+= 1\)/);
  assert.match(workflow, /if \(attempt < 5\) await delay\(5_000\)/);
  assert.doesNotMatch(workflow, /onlyEdgeBlocks/);
  assert.match(workflow, /236059fa43462ebb1271220cf363cc3836ca0be12699ad36cc7be7557f8f87cb/);
  assert.match(workflow, /\/v1\/auth\/exchange/);
  assert.match(workflow, /invalid_grant/);
});

const script = path.resolve(__dirname, '../scripts/release-plan.mjs');
const projects = [];

test.afterEach(() => {
  for (const directory of projects.splice(0)) {
    unlinkSync(path.join(directory, 'package.json'));
    rmdirSync(directory);
  }
});

function createProject(version) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'solosync-release-plan-'));
  projects.push(directory);
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }));
  return directory;
}

test('plans publication for an untagged package version', () => {
  const project = createProject('0.0.6');
  const result = execFileSync(process.execPath, [script, '--project', project], { encoding: 'utf8' });

  assert.deepEqual(JSON.parse(result), {
    version: '0.0.6',
    tag: 'v0.0.6',
    shouldPublish: true,
  });
});

test('skips publication when the package version already has a GitHub release', () => {
  const project = createProject('0.0.6');
  const result = execFileSync(process.execPath, [
    script,
    '--project', project,
    '--released-tags', 'v0.0.5\nv0.0.6',
    '--released-assets', 'solosync-0.0.6.vsix',
  ], { encoding: 'utf8' });

  assert.equal(JSON.parse(result).shouldPublish, false);
});

test('resumes publication when the GitHub release is missing its VSIX', () => {
  const project = createProject('0.0.6');
  const result = execFileSync(process.execPath, [
    script,
    '--project', project,
    '--released-tags', 'v0.0.6',
    '--released-assets', 'solosync-0.0.5.vsix',
  ], { encoding: 'utf8' });

  assert.equal(JSON.parse(result).shouldPublish, true);
});

test('rejects a package version that cannot form a release tag', () => {
  const project = createProject('next release');
  const result = spawnSync(process.execPath, [script, '--project', project], { encoding: 'utf8' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /valid semantic version/);
});
