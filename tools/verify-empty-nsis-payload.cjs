'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const { verifyNsisTree } = require('./package-nsis-integrity.cjs');
const { fileDigest } = require('../desktop/scripts/file-digest.cjs');
const Database = require('../backend/node_modules/better-sqlite3');
const root = path.resolve(__dirname, '..'), sevenZip = path.join(root, 'desktop/node_modules/7zip-bin/win/x64/7za.exe');
const sha = file => fileDigest(file).sha256;
async function main() {
const installer = path.resolve(process.argv[2]), release = path.dirname(installer), directory = createRunDirectory('empty-nsis-payload');
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
assert.equal(manifest.sha256, sha(installer)); assert.equal(manifest.size, fs.statSync(installer).size);
// Installer-only repacks retain the immutable, fully tested application in
// its original staging directory. Verify that whole tree before comparing
// extracted payload bytes; never trust a path in the manifest by itself.
const candidate = path.join(manifest.stagingDirectory || release, 'win-unpacked');
assert.equal(manifest.smokeTest, 'passed');
assert.equal(manifest.emptySystem, true);
assert.equal(manifest.contentPolicy, 'empty-v1');
const baselineFile = manifest.packagingResourceBaseline || manifest.resourceBaseline || path.join(release, 'installation-resource-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8').replace(/^\uFEFF/, ''));
const { proof: resourceProof } = await verifyNsisTree(root, candidate, baseline);
const listing = execFileSync(sevenZip, ['l', '-slt', installer], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const blocks = listing.split(/\r?\n\r?\n/).filter(b => /^Path = /m.test(b) && /^Size = /m.test(b));
const names = blocks.map(b => b.match(/^Path = (.+)$/m)[1].trim().replace(/\\/g, '/'));
assert.ok(names.length > 500, 'Cannot read the actual compressed installation payload');
assert.deepEqual(names.filter(n => /\.(?:glb|gltf|blend\d*)$/i.test(n)), [], 'Installer contains a model/source asset');
assert.deepEqual(names.filter(n => /^(?:resources\/)?(?:backend\/data\/|templates\/(?:uploads|data)\/|backend\/assets\/(?:models|motions)\/).+/i.test(n)), []);
const selected = ['resources/templates/factory-template.db', 'resources/shared/motionPackages.json', 'resources/backend/distribution.json', 'resources/elevate.exe'];
for (const name of selected) assert.ok(names.includes(name), 'Missing packaged payload file: ' + name);
execFileSync(sevenZip, ['x', installer, '-y', '-o' + directory, ...selected], { windowsHide: true, stdio: 'pipe' });
for (const name of selected) assert.equal(sha(path.join(directory, name)), sha(path.join(candidate, name)), name + ' differs from verified candidate');
const db = new Database(path.join(directory, selected[0]), { readonly: true, fileMustExist: true }), counts = {};
try {
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='settings'").all()) {
        counts[name] = db.prepare('SELECT COUNT(*) AS n FROM `' + name + '`').get().n; assert.equal(counts[name], 0, name);
    }
    assert.equal(db.prepare("SELECT value FROM settings WHERE `key`='install_content_policy'").get().value, 'empty-v1');
} finally { db.close(); }
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, selected[1]))).models, {});
assert.equal(JSON.parse(fs.readFileSync(path.join(directory, selected[2]))).contentPolicy, 'empty-v1');
const report = { success: true, installer, sha256: manifest.sha256, payloadEntries: names.length, modelFiles: 0, sourceFiles: 0,
    counts, extractedPayloadMatchesVerifiedCandidate: true, resourceProof, directory };
fs.writeFileSync(path.join(release, 'empty-nsis-payload-verification.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
