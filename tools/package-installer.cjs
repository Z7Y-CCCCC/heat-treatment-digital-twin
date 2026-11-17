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
  return { compression: level === '0' ? 'store' : 'normal', env };
}

function buildInstaller(root, unpacked, output, level) {
  const options = compressionOptions(level);
  execFileSync(process.execPath, [path.join(root, 'desktop/node_modules/electron-builder/out/cli/cli.js'),
    '--projectDir', path.join(root, 'desktop'), '--prepackaged', unpacked, '--win', 'nsis', '--x64',
    `--config.directories.output=${output}`, `--config.compression=${options.compression}`],
    { windowsHide: true, stdio: 'inherit', env: options.env });
}
if (require.main === module) {
  const [unpacked, output, level] = process.argv.slice(2);
  if (!unpacked || !output || level === undefined) throw Error('Expected unpacked directory, output directory and compression level');
  buildInstaller(path.resolve(__dirname, '..'), path.resolve(unpacked), path.resolve(output), level);
}
module.exports = { compressionOptions, buildInstaller };
