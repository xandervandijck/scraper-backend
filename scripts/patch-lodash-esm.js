#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const lodashDir = path.join(__dirname, '../node_modules/lodash');
const lodashPkg = path.join(lodashDir, 'package.json');

if (!fs.existsSync(lodashPkg)) {
  console.log('patch-lodash-esm: lodash not found, skipping');
  process.exit(0);
}

// Generate browser-safe ESM wrappers for lodash and lodash/fp
function makeWrapper(requirePath, outputFile) {
  const mod = require(path.join(lodashDir, requirePath));
  const names = Object.keys(mod).filter(n => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(n));
  let content = `import _mod from './${requirePath}';\n`;
  content += `export default _mod;\n`;
  for (const name of names) {
    content += `export const ${name} = _mod.${name};\n`;
  }
  fs.writeFileSync(path.join(lodashDir, outputFile), content);
  return names.length;
}

const fpCount = makeWrapper('fp.js', 'fp-esm.mjs');
const mainCount = makeWrapper('lodash.js', 'lodash-esm.mjs');

const pkg = JSON.parse(fs.readFileSync(lodashPkg, 'utf8'));
pkg.exports = {
  '.': { import: './lodash-esm.mjs', require: './lodash.js', default: './lodash.js' },
  './lodash.js': { import: './lodash-esm.mjs', require: './lodash.js', default: './lodash.js' },
  './fp': { import: './fp-esm.mjs', require: './fp.js', default: './fp.js' },
  './fp.js': { import: './fp-esm.mjs', require: './fp.js', default: './fp.js' },
  './*.js': './*.js',
  './*': './*.js',
};
fs.writeFileSync(lodashPkg, JSON.stringify(pkg, null, 2) + '\n');
console.log(`patch-lodash-esm: lodash-esm.mjs (${mainCount} exports), fp-esm.mjs (${fpCount} exports)`);

// Patch @strapi/utils/dist/import-default.mjs to be browser-safe.
// Vite transforms bare require() in .mjs files into createRequire, which
// breaks the browser build. Using node:module explicitly lets Vite externalize
// it cleanly, and the typeof guard makes the function a no-op in the browser.
const importDefaultMjs = path.join(
  __dirname,
  '../node_modules/@strapi/utils/dist/import-default.mjs'
);
if (fs.existsSync(importDefaultMjs)) {
  const patched = `import { createRequire } from 'node:module';
const _require = typeof createRequire === 'function' ? createRequire(import.meta.url) : null;

function importDefault(modName) {
    if (!_require) return null;
    const mod = _require(modName);
    return mod && mod.__esModule ? mod.default : mod;
}

export { importDefault as default };
`;
  fs.writeFileSync(importDefaultMjs, patched);
  console.log('patch-lodash-esm: patched import-default.mjs for browser safety');
}
