'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { snapshotTree } = require('./package-resource-integrity.cjs');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
const helperName = 'resources/elevate.exe';
const treeHash = entries => crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
async function trustedHelper(root) {
  const config = require(path.join(root, 'desktop/package.json')).build;
  const { getNsisElevatePath } = require(path.join(root, 'desktop/node_modules/app-builder-lib/out/toolsets/windows.js'));
  const filename = await getNsisElevatePath(config.toolsets?.nsis, config.nsis?.customNsisBinary);
  return { filename, ...fileDigest(filename) };
}
function comparePackagedSnapshots(before, after, helper) {
  assert.equal(before.version, 1); assert.equal(after.version, 1);
  assert.equal(after.root.toLowerCase(), before.root.toLowerCase(), 'Installation baseline belongs to another directory');
  assert.equal(before.sha256, treeHash(before.entries), 'Invalid original resource baseline');
  const installed = after.entries.find(entry => entry.path === helperName);
  assert.ok(installed && installed.type === 'file', 'Missing NSIS elevation helper');
  assert.equal(installed.size, helper.size, 'Unexpected NSIS elevation helper size');
  assert.equal(installed.sha256, helper.sha256, 'NSIS elevation helper differs from the configured builder toolset');
  const wasIncluded = before.entries.some(entry => entry.path === helperName);
  const compared = wasIncluded ? after.entries : after.entries.filter(entry => entry.path !== helperName);
  // Older full builds took their baseline BEFORE NSIS inserted this one
  // toolset-owned helper. Nothing else may be added, removed or changed.
  assert.equal(treeHash(compared), before.sha256, 'Installation resources changed beyond the verified NSIS helper');
  return { success: true, originalSha256: before.sha256, packagedSha256: after.sha256,
    legacyHelperAddition: !wasIncluded, helperSha256: installed.sha256,
    filesVerified: after.entries.filter(entry => entry.type === 'file').length };
}
async function verifyNsisTree(root, directory, baseline) {
  const helper = await trustedHelper(root), snapshot = await snapshotTree(directory);
  return { snapshot, proof: comparePackagedSnapshots(baseline, snapshot, helper) };
}
async function prepareNsisHelper(root, directory) {
  const helper = await trustedHelper(root), destination = path.join(directory, helperName);
  if (fs.existsSync(destination)) {
    assert.deepEqual(fileDigest(destination), { size: helper.size, sha256: helper.sha256 }, 'Existing NSIS helper differs from toolset');
  } else fs.copyFileSync(helper.filename, destination, fs.constants.COPYFILE_EXCL);
  return { success: true, sha256: helper.sha256 };
}
if (require.main === module) {
  if (process.argv[2] !== '--prepare' || !process.argv[3]) throw Error('Usage: node package-nsis-integrity.cjs --prepare <win-unpacked>');
  prepareNsisHelper(path.resolve(__dirname, '..'), path.resolve(process.argv[3]))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
module.exports = { comparePackagedSnapshots, verifyNsisTree, prepareNsisHelper };
