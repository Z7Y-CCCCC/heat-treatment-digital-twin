'use strict';
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function compressionOptions(level, inherited = process.env) {
  level = String(level);
  if (!/^[0-9]$/.test(level)) throw Error('Compression level must be a digit 0-9');
  const env = { ...inherited };
  // Builder 26's level env override always selects Deflate, even at level 0.
  // A genuine Copy/Store ZIP needs BOTH store config and no env override.
  // Windows preserves inherited key casing while resolving it case-insensitively.
  // Remove every spelling before optionally adding one canonical nonzero value.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_BUILDER_COMPRESSION_LEVEL') delete env[key];
  }
  if (level !== '0') env.ELECTRON_BUILDER_COMPRESSION_LEVEL = level;
  // BCJ2 improves Windows PE compression in the native 7z app container.
  // Keep fast mode genuinely stored; do not apply a binary filter to it.
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_BUILDER_7Z_FILTER') delete env[key];
  if (Number(level) >= 3) env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ2';
  return { compression: level === '0' ? 'store' : 'normal', env };
}

function buildInstaller(root, unpacked, output, level, collectorArchive) {
  require('../desktop/scripts/build-installer-window-chrome.cjs').buildInstallerChrome();
  const options = compressionOptions(level);
  const commit = require('node:child_process').execFileSync('git', ['rev-parse','HEAD'], {cwd:root,encoding:'utf8',windowsHide:true}).trim();
  if(process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit) throw Error('Release checkout does not match the requested source commit');
  const payload = require('./collector-installer-payload.cjs').preparePayload(collectorArchive, output, {version:require(path.join(root,'desktop/package.json')).version,commit});
  options.env.DIGITAL_TWIN_COLLECTOR_PAYLOAD_INCLUDE = payload.include;
  execFileSync(process.execPath, [path.join(root, 'desktop/node_modules/electron-builder/out/cli/cli.js'),
    '--projectDir', path.join(root, 'desktop'), '--prepackaged', unpacked, '--win', 'nsis', '--x64',
    `--config.directories.output=${output}`, `--config.compression=${options.compression}`],
    { windowsHide: true, stdio: 'inherit', env: options.env });
  const installer = path.join(output, `热处理数字孪生大屏-安装包-${require(path.join(root,'desktop/package.json')).version}-x64.exe`);
  const proof = require('./installer-startup-smoke.cjs').verifyInstallerStartup(installer, path.join(output, 'installer-startup-verification.json'));
  console.log('Actual final installer settings page verified:', JSON.stringify(proof));
}
if (require.main === module) {
  const [unpacked, output, level, collectorArchive] = process.argv.slice(2);
  if (!unpacked || !output || level === undefined || !collectorArchive) throw Error('Expected unpacked directory, output directory, compression level and same-build collector ZIP');
  buildInstaller(path.resolve(__dirname, '..'), path.resolve(unpacked), path.resolve(output), level, path.resolve(collectorArchive));
}
module.exports = { compressionOptions, buildInstaller };
