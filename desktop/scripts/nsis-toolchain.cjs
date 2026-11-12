'use strict';
const path = require('node:path');
const { getMakeNsisPath } = require('../node_modules/app-builder-lib/out/toolsets/windows.js');
// Use the same verified tool bundle as electron-builder. Cache layouts differ
// between builder versions; guessing LOCALAPPDATA paths breaks clean machines.
async function nsisToolchain() {
  const tool = await getMakeNsisPath();
  const dir = path.dirname(tool.path);
  const root = path.basename(dir).toLowerCase() === 'bin' ? path.dirname(dir) : dir;
  return { ...tool, seed: path.join(root, 'Contrib/UIs/modern.exe') };
}
module.exports = { nsisToolchain };
