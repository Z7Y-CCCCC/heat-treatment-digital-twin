const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function verifyRelease(directory, expectedCommit = process.env.GITHUB_SHA, expectedRun = '') {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8').replace(/^\uFEFF/, ''));
  const manifest = read('release-manifest.json'), timings = read('build-timings.json');
  if (!timings.success || manifest.smokeTest !== 'passed' || manifest.starterTemplate !== true || manifest.mysqlBundled !== true)
    throw new Error('Release build and isolated launch checks must have passed');
  if (expectedCommit && manifest.commit !== expectedCommit) throw new Error('Artifact belongs to another commit');
  if (expectedRun && manifest.run !== String(expectedRun)) throw new Error('Artifact belongs to another run');
  const name = manifest.installer;
  if (typeof name !== 'string' || path.basename(name) !== name || /[\\/]/.test(name) || !/\.exe$/i.test(name)) throw new Error('Invalid installer name');
  const allowed = [name, `${name}.sha256.txt`, 'release-manifest.json', 'build-timings.json'].sort();
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(allowed)) throw new Error('Unexpected or missing release files');
  const bytes = fs.readFileSync(path.join(directory, name));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!bytes.length || bytes.length !== manifest.size || sha256 !== manifest.sha256) throw new Error('Installer size or SHA-256 mismatch');
  const checksum = fs.readFileSync(path.join(directory, `${name}.sha256.txt`), 'utf8').trim();
  if (checksum !== `${sha256}  ${name}`) throw new Error('Checksum file mismatch');
  return { installer: name, size: bytes.length, sha256, commit: manifest.commit };
}
if (require.main === module) console.log(JSON.stringify(verifyRelease(path.resolve(process.argv[2] || 'output/ci-release'), process.argv[3] || process.env.GITHUB_SHA, process.argv[4] || ''), null, 2));
module.exports = { verifyRelease };
