const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { PNG } = require('pngjs');

test('marketplace icon contains the intended color background and white mark', () => {
  const image = PNG.sync.read(readFileSync(path.join(__dirname, '..', 'resources', 'icon.png')));
  assert.equal(image.width, 256);
  assert.equal(image.height, 256);

  let coloredBackground = 0;
  let whiteMark = 0;
  let opaqueBlack = 0;
  const uniqueOpaqueColors = new Set();

  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index];
    const green = image.data[index + 1];
    const blue = image.data[index + 2];
    const alpha = image.data[index + 3];
    if (alpha < 220) continue;

    uniqueOpaqueColors.add(`${red},${green},${blue}`);
    if (blue > 180 && red > 50 && red < 150 && green > 50 && green < 160) coloredBackground += 1;
    if (red > 235 && green > 235 && blue > 235) whiteMark += 1;
    if (red < 20 && green < 20 && blue < 20) opaqueBlack += 1;
  }

  assert.ok(coloredBackground > 30_000, `expected a substantial blue-purple background, found ${coloredBackground} pixels`);
  assert.ok(whiteMark > 2_000, `expected a visible white cloud/download mark, found ${whiteMark} pixels`);
  assert.ok(opaqueBlack < 100, `expected no opaque black fill, found ${opaqueBlack} pixels`);
  assert.ok(uniqueOpaqueColors.size > 100, `expected a gradient icon, found ${uniqueOpaqueColors.size} opaque colors`);
});
