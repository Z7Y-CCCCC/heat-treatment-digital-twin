'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { fileDigest } = require('./file-digest.cjs');
const { execFileSync } = require('node:child_process');
function archivePlugin(directory, output) {
    if (fs.existsSync(output)) throw new Error('Plugin archive output already exists');
    execFileSync(require('7zip-bin').path7za, ['a', '-tzip', path.resolve(output), '.', '-mx=1', '-mmt=2'], { cwd: directory, windowsHide: true, stdio: 'inherit' });
    return { file: path.basename(output), ...fileDigest(output) };
}
if (require.main === module) console.log(JSON.stringify(archivePlugin(path.resolve(process.argv[2]), path.resolve(process.argv[3]))));
module.exports = { archivePlugin };
