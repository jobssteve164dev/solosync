import { readFileSync } from 'node:fs';
import path from 'node:path';

function option(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const project = path.resolve(option('--project', process.cwd()));
const releasedTags = new Set(option('--released-tags').split(/\r?\n/).filter(Boolean));
const releasedAssets = new Set(option('--released-assets').split(/\r?\n/).filter(Boolean));
const manifest = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
const version = manifest.version;

if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new Error('package.json must contain a valid semantic version.');
}

const plan = {
  version,
  tag: `v${version}`,
  shouldPublish: !(
    releasedTags.has(`v${version}`)
    && releasedAssets.has(`solosync-${version}.vsix`)
  ),
};

process.stdout.write(`${JSON.stringify(plan)}\n`);
