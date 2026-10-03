// Refresh generated release metadata after repacking the same verified runtime
// (e.g. an installer-only fix). Does not change or rerun the smoke-test verdict.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = path.resolve(process.argv[2]);
const manifestFile = path.join(directory, 'release-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
const installer = path.resolve(manifest.installer);
if (path.dirname(installer) !== directory || !installer.endsWith('.exe')) throw new Error('Installer outside release directory');
const hash = crypto.createHash('sha256');
const input = fs.createReadStream(installer);
input.on('error', error => { console.error(error); process.exitCode = 1; });
input.on('data', chunk => hash.update(chunk));
input.on('end', () => {
    manifest.sha256 = hash.digest('hex');
    manifest.size = fs.statSync(installer).size;
    manifest.installerRepackedAt = new Date().toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(`${installer}.sha256.txt`, `${manifest.sha256}  ${path.basename(installer)}\n`);
    console.log(JSON.stringify({ installer, size: manifest.size, sha256: manifest.sha256 }));
});
