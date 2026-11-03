const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { collectRelease } = require('./collect-release.cjs');
const { verifyRelease } = require('./verify-release.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '安装包', 'release-test');
  fs.mkdirSync(directory, { recursive: true });
  const installer = path.join(directory, 'test.exe');
  const data = Buffer.from('installer fixture');
  fs.writeFileSync(installer, data);
  const manifest = { installer, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), smokeTest: 'passed', starterTemplate: true, mysqlBundled: true };
  const save = () => fs.writeFileSync(path.join(directory, 'release-manifest.json'), '\uFEFF' + JSON.stringify(manifest));
  save();
  fs.writeFileSync(path.join(directory, 'build-timings.json'), '\uFEFF' + JSON.stringify({ success: true }));
  return { root, directory, installer, manifest, save };
}
test('collects only verified files with portable metadata and regenerated checksum', t => {
  const f = fixture(t); const out = collectRelease(f.root);
  assert.equal(fs.readdirSync(out).length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'release-manifest.json'))).installer, 'test.exe');
  assert.equal(verifyRelease(out, '').installer, 'test.exe');
});

test('download verification rejects wrong commit, extra files and changed checksum or installer', t => {
  const f = fixture(t); const out = collectRelease(f.root);
  assert.throws(() => verifyRelease(out, 'unrelated-commit'), /another commit/);
  fs.writeFileSync(path.join(out, 'unexpected.txt'), 'not a release asset');
  assert.throws(() => verifyRelease(out, ''), /Unexpected/);
  fs.unlinkSync(path.join(out, 'unexpected.txt'));
  fs.appendFileSync(path.join(out, 'test.exe.sha256.txt'), 'wrong');
  assert.throws(() => verifyRelease(out, ''), /Checksum/);
  fs.appendFileSync(path.join(out, 'test.exe'), 'changed');
  assert.throws(() => verifyRelease(out, ''), /SHA-256/);
});
test('rejects corruption, skipped smoke, customer config and stale release directories', t => {
  const f = fixture(t);
  f.manifest.smokeTest = 'skipped'; f.save(); assert.throws(() => collectRelease(f.root), /smoke/);
  f.manifest.smokeTest = 'passed'; f.manifest.starterTemplate = false; f.save(); assert.throws(() => collectRelease(f.root), /starter/);
  f.manifest.starterTemplate = true; f.save(); fs.appendFileSync(f.installer, 'corrupt'); assert.throws(() => collectRelease(f.root), /mismatch/);
  fs.mkdirSync(path.join(f.root, '安装包', 'release-stale')); assert.throws(() => collectRelease(f.root), /exactly one/);
});
