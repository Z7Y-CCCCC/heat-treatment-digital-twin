const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runtimeReady(electronDirectory) {
    try {
        const version = JSON.parse(fs.readFileSync(path.join(electronDirectory, 'package.json'), 'utf8')).version;
        const installed = fs.readFileSync(path.join(electronDirectory, 'dist', 'version'), 'utf8').trim().replace(/^v/, '');
        const executable = fs.readFileSync(path.join(electronDirectory, 'path.txt'), 'utf8').trim();
        return installed === version && executable === 'electron.exe'
            && ['electron.exe', 'icudtl.dat', 'resources.pak'].every(name => fs.existsSync(path.join(electronDirectory, 'dist', name)));
    } catch { return false; }
}

function ensureElectronRuntime(electronDirectory, install = directory => {
    const result = spawnSync(process.execPath, [path.join(directory, 'install.js')], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Electron runtime installation failed: ${result.status}`);
}) {
    if (!runtimeReady(electronDirectory)) {
        // Recent Electron packages no longer install the executable during npm
        // ci. Explicitly restore it before a successful dependency refresh can
        // leave the existing development launcher unusable.
        const marker = path.join(electronDirectory, 'path.txt');
        if (fs.existsSync(marker)) fs.unlinkSync(marker);
        install(electronDirectory);
    }
    if (!runtimeReady(electronDirectory)) throw new Error('Electron runtime is incomplete; development launcher would fail.');
    return path.join(electronDirectory, 'dist', 'electron.exe');
}

if (require.main === module) {
    const directory = path.resolve(__dirname, '../node_modules/electron');
    console.log(`Development launcher runtime verified: ${ensureElectronRuntime(directory)}`);
}
module.exports = { runtimeReady, ensureElectronRuntime };
