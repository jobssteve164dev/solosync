const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const projectRoot = path.resolve(__dirname, '..');
const source = path.join(projectRoot, 'resources', 'icon.svg');
const destination = path.join(projectRoot, 'resources', 'icon.png');
const svg = readFileSync(source, 'utf8');
const rendered = new Resvg(svg, {
  fitTo: { mode: 'width', value: 256 },
  background: 'rgba(0, 0, 0, 0)',
});

writeFileSync(destination, rendered.render().asPng());
console.log(`Rendered ${path.relative(projectRoot, destination)}`);
