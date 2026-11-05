'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { comparePackagedSnapshots } = require('./package-nsis-integrity.cjs');
const digest = entries => crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
const tree = entries => ({ version: 1, root: 'C:/test', entries, sha256: digest(entries) });
test('only the exact configured NSIS helper may extend a legacy full-build baseline', () => {
  const app = { path: 'app.exe', type: 'file', size: 10, sha256: 'app' };
  const helper = { path: 'resources/elevate.exe', type: 'file', size: 20, sha256: 'trusted' };
  const before = tree([app]), after = tree([app, helper]);
  assert.equal(comparePackagedSnapshots(before, after, helper).legacyHelperAddition, true);
  assert.equal(comparePackagedSnapshots(after, after, helper).legacyHelperAddition, false);
  for (const entries of [[{ ...app, sha256: 'tampered' }, helper], [app, { ...helper, sha256: 'wrong' }], [app, helper, { ...app, path: 'extra' }], [helper], [app]])
    assert.throws(() => comparePackagedSnapshots(before, tree(entries), helper));
  assert.throws(() => comparePackagedSnapshots({ ...before, sha256: 'fake' }, after, helper));
  assert.throws(() => comparePackagedSnapshots(before, { ...after, root: 'C:/other' }, helper));
});
