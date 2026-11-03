const fs = require('node:fs');
const path = require('node:path');
const { verifyRelease } = require('./verify-release.cjs');
function portableRelease(directory, commit, run) {
  const proof = verifyRelease(directory, commit, run);
  const file = path.join(directory, 'release-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid portable release version');
  const name = `HeatTreatmentDigitalTwin-Setup-${manifest.version}-x64.exe`;
  if (name !== proof.installer) {
    // Both names are verified basenames, and this is the owned artifact folder.
    fs.renameSync(path.join(directory, proof.installer), path.join(directory, name));
    fs.unlinkSync(path.join(directory, `${proof.installer}.sha256.txt`));
    manifest.installer = name;
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(directory, `${name}.sha256.txt`), `${proof.sha256}  ${name}\n`);
  }
  return verifyRelease(directory, commit, run);
}
function verifyUploadedAssets(directory, assets) {
  verifyRelease(directory, '');
  const names = fs.readdirSync(directory).sort();
  if (JSON.stringify(assets.map(asset => asset.name).sort()) !== JSON.stringify(names)) throw new Error('GitHub renamed or omitted release assets');
  for (const asset of assets) if (asset.size !== fs.statSync(path.join(directory, asset.name)).size) throw new Error('GitHub asset size mismatch');
}
if (require.main === module) {
  if (process.argv[2] === '--uploaded') verifyUploadedAssets(process.argv[3], JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).assets);
  else console.log(JSON.stringify(portableRelease(path.resolve(process.argv[2]), process.argv[3], process.argv[4]), null, 2));
}
module.exports = { portableRelease, verifyUploadedAssets };
