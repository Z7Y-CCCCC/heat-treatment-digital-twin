const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function collectRelease(root, sourceDirectory) {
  const releases = path.join(root, '安装包');
  const directories = sourceDirectory ? [sourceDirectory] : fs.readdirSync(releases)
    .filter(name => name.startsWith('release-') && fs.statSync(path.join(releases, name)).isDirectory())
    .map(name => path.join(releases, name));
  // Clean checkout must leave exactly this run's output. Never silently upload
  // an older successful installer when the current build failed.
  if (directories.length !== 1) throw new Error('Expected exactly one release directory from the current clean build');
  const directory = path.resolve(directories[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const timings = JSON.parse(fs.readFileSync(path.join(directory, 'build-timings.json'), 'utf8').replace(/^\uFEFF/, ''));
  if (!timings.success || manifest.smokeTest !== 'passed' || manifest.starterTemplate !== true || manifest.mysqlBundled !== true) {
    throw new Error('Release must pass the full build and smoke test using starter configuration');
  }
  const installer = path.resolve(manifest.installer);
  if (path.dirname(installer) !== directory || path.extname(installer).toLowerCase() !== '.exe') throw new Error('Installer is outside the release directory');
  const bytes = fs.readFileSync(installer);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!bytes.length || bytes.length !== manifest.size || sha256 !== manifest.sha256) throw new Error('Installer size or SHA-256 mismatch');
  const output = path.join(root, 'output', 'ci-release');
  if (fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('CI release output must be empty');
  fs.mkdirSync(output, { recursive: true });
  const name = path.basename(installer);
  fs.copyFileSync(installer, path.join(output, name));
  fs.writeFileSync(path.join(output, `${name}.sha256.txt`), `${sha256}  ${name}\n`);
  // Strip machine-specific paths from downloadable metadata.
  const { installer: _installer, buildLog: _log, ...portable } = manifest;
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify({ ...portable, installer: name, commit: process.env.GITHUB_SHA || '', run: process.env.GITHUB_RUN_ID || '' }, null, 2));
  fs.copyFileSync(path.join(directory, 'build-timings.json'), path.join(output, 'build-timings.json'));
  return output;
}
if (require.main === module) console.log(collectRelease(path.resolve(__dirname, '../..')));
module.exports = { collectRelease };
