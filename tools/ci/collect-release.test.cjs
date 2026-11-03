const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { collectRelease } = require('./collect-release.cjs');
const { verifyRelease } = require('./verify-release.cjs');
const { reusableRelease } = require('./reusable-release.cjs');
const { portableRelease, verifyUploadedAssets } = require('./portable-release.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, '安装包', 'release-test');
  fs.mkdirSync(directory, { recursive: true });
  const installer = path.join(directory, 'test.exe');
  const data = Buffer.from('installer fixture');
  fs.writeFileSync(installer, data);
  const manifest = { version: '2.3.1', installer, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), smokeTest: 'passed', starterTemplate: true, mysqlBundled: true };
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
  assert.throws(() => verifyRelease(out, '', 'unrelated-run'), /another run/);
  fs.writeFileSync(path.join(out, 'unexpected.txt'), 'not a release asset');
  assert.throws(() => verifyRelease(out, ''), /Unexpected/);
  fs.unlinkSync(path.join(out, 'unexpected.txt'));
  fs.appendFileSync(path.join(out, 'test.exe.sha256.txt'), 'wrong');
  assert.throws(() => verifyRelease(out, ''), /Checksum/);
  fs.appendFileSync(path.join(out, 'test.exe'), 'changed');
  assert.throws(() => verifyRelease(out, ''), /SHA-256/);
});

function reusableFixture() {
  const run = { id: 123, run_number: 5, head_sha: 'c'.repeat(40), head_branch: 'main', status: 'completed', event: 'workflow_dispatch', path: '.github/workflows/release.yml', conclusion: 'failure' };
  const jobs = { jobs: ['preflight', 'package', 'quality / Frontend production build', 'quality / Backend contract and integration tests', 'quality / Windows desktop and native runtime regressions', 'quality / Isolated MQTT simulator regressions'].map(name => ({ name, conclusion: 'success', status: 'completed' })) };
  return { run, jobs, git: () => '' };
}
test('publish retry reuses only fully verified main builds, never an overall failure with a failed build', () => {
  const f = reusableFixture();
  assert.deepEqual(reusableRelease(f.run, f.jobs, 123, f.git), { commit: 'c'.repeat(40), run: '123', artifact: 'windows-installer-5' });
  for (const job of f.jobs.jobs) {
    job.conclusion = 'failure'; assert.throws(() => reusableRelease(f.run, f.jobs, 123, f.git), /did not pass/); job.conclusion = 'success';
  }
  assert.throws(() => reusableRelease(f.run, f.jobs, '123;evil', f.git), /Invalid/);
  for (const patch of [{ head_branch: 'feature' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { status: 'in_progress' }]) {
    assert.throws(() => reusableRelease({ ...f.run, ...patch }, f.jobs, 123, f.git), /Only completed main/);
  }
});
test('publish retry refuses product changes and non-ancestor builds, but permits publication-only repairs', () => {
  const f = reusableFixture();
  assert.throws(() => reusableRelease(f.run, f.jobs, 123, () => { throw new Error('not an ancestor') }), /not an ancestor/);
  for (const file of ['frontend/src/RootApp.vue', 'desktop/main.cjs', 'backend/server.js', 'desktop/package.json']) {
    assert.throws(() => reusableRelease(f.run, f.jobs, 123, args => args[0] === 'diff' ? file : ''), /Product source changed/);
  }
  assert.equal(reusableRelease(f.run, f.jobs, 123, args => args[0] === 'diff' ? '.github/workflows/release.yml\ntools/ci/verify-release.cjs\ndocs/CI-CD-runner.md' : '').run, '123');
});
test('publication checks out code before downloading and keeps verified artifacts outside checkout cleanup', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8').split('  publish-release:')[1];
  assert.ok(workflow.indexOf('actions/checkout@v4') < workflow.indexOf('actions/download-artifact@v4'));
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/verified-release/);
  assert.match(workflow, /"\$BUILD_COMMIT" "\$BUILD_RUN"/);
  assert.match(workflow, /-f sha="\$BUILD_COMMIT"/);
});
test('rejects corruption, skipped smoke, customer config and stale release directories', t => {
  const f = fixture(t);
  f.manifest.smokeTest = 'skipped'; f.save(); assert.throws(() => collectRelease(f.root), /smoke/);
  f.manifest.smokeTest = 'passed'; f.manifest.starterTemplate = false; f.save(); assert.throws(() => collectRelease(f.root), /starter/);
  f.manifest.starterTemplate = true; f.save(); fs.appendFileSync(f.installer, 'corrupt'); assert.throws(() => collectRelease(f.root), /mismatch/);
  fs.mkdirSync(path.join(f.root, '安装包', 'release-stale')); assert.throws(() => collectRelease(f.root), /exactly one/);
});

test('portable publication keeps installer bytes and provenance, with consistent ASCII names and checksum', t => {
  const f = fixture(t), out = collectRelease(f.root), original = verifyRelease(out, '');
  const normalized = portableRelease(out, '');
  assert.equal(normalized.installer, 'HeatTreatmentDigitalTwin-Setup-2.3.1-x64.exe');
  assert.equal(normalized.sha256, original.sha256);
  assert.equal(normalized.commit, original.commit);
  assert.deepEqual(portableRelease(out, ''), normalized);
  const assets = fs.readdirSync(out).map(name => ({ name, size: fs.statSync(path.join(out, name)).size }));
  assert.doesNotThrow(() => verifyUploadedAssets(out, assets));
  assert.throws(() => verifyUploadedAssets(out, assets.map((asset, i) => i ? asset : { ...asset, name: 'renamed-by-host.exe' })), /renamed or omitted/);
  assert.throws(() => verifyUploadedAssets(out, assets.map((asset, i) => i ? asset : { ...asset, size: asset.size + 1 })), /size mismatch/);
});
