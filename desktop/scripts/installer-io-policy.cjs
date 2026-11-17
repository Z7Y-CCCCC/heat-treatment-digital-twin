'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileDigest } = require('./file-digest.cjs');
function nsisPath(value) {
    value = path.resolve(value);
    if (/["\r\n$]/.test(value)) throw Error('Unsafe generated installer path');
    return value;
}
function programManifest(unpacked) {
    const entries = [], directories = [];
    function walk(directory) {
        for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            const file = path.join(directory, item.name);
            if (item.isSymbolicLink()) throw Error('Program payload contains a link');
            if (item.isDirectory()) { directories.push(path.relative(unpacked,file).split(path.sep).join('/')); walk(file); }
            else if (item.isFile()) {
                const size = fs.statSync(file).size, relative = path.relative(unpacked,file).split(path.sep).join('/');
                const entry = { path:relative, size };
                // Include exact hashes for all configuration, scripts, templates
                // and small files. Large binaries retain the decoder CRC and
                // final-EXE whole-tree integrity gate; do not reread gigabytes.
                if (size <= 1024*1024 || /\.(?:json|db|mjs|cjs|js|ps1|pem)$/i.test(relative)) entry.sha256=fileDigest(file).sha256;
                entries.push(entry);
            } else throw Error('Unsupported program payload entry');
        }
    }
    walk(unpacked);
    for (const required of ['resources/runtime/node.exe','resources/backend/server.js','resources/backend/distribution.json',
        'resources/backend/defaults/factory-dashboard.v1.json','resources/shared/motionPackages.json','resources/templates/factory-template.db']) {
        if (!entries.some(entry=>entry.path===required)) throw Error('Missing verified program file: '+required);
    }
    return { schema:1, product:'display', directories, entries };
}
function validateStockInstallerTemplates(main, section, archive, uninstaller, common) {
    const includes = section.indexOf('!include installer.nsh');
    const guard = section.indexOf('!insertmacro CHECK_APP_RUNNING');
    const install = section.indexOf('!insertmacro installApplicationFiles');
    if (!common?.includes('!define UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"') || main.split('!include "installSection.nsh"').length !== 2 || includes < 0 || guard <= includes || install <= guard ||
        !archive.includes('!macro extractUsing7za FILE') || !uninstaller.includes('!ifmacrodef customRemoveFiles'))
        throw Error('Unsupported stock NSIS templates: review the I/O hooks rather than fall back');
}
function createInstallerIoPolicy(root, unpacked, output) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
    const mainSource = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
    if (packageJson.dependencies?.['electron-updater'] || packageJson.devDependencies?.['electron-updater'] || /\bautoUpdater\b/.test(mainSource))
        throw Error('Automatic updater detected: review installer cache policy before building');
    // Setting nsis.script makes electron-builder skip creation/signing of its
    // uninstaller AND the embedded-archive size gate. Keep the stock main script;
    // load overrides in customCheckAppRunning, after installer.nsh is included.
    if (packageJson.build?.nsis?.script) throw Error('Custom NSIS main scripts bypass the verified uninstaller pipeline');
    const template = path.join(root, 'desktop/node_modules/app-builder-lib/templates/nsis');
    const load = name => fs.readFileSync(path.join(template, name), 'utf8');
    validateStockInstallerTemplates(load('installer.nsi'), load('installSection.nsh'), load('include/extractAppPackage.nsh'), load('uninstaller.nsh'), load('common.nsh'));
    fs.mkdirSync(output, { recursive: true });
    const manifest = path.join(output, 'program-files.json'), include = path.join(output, 'installer-io-policy.nsh');
    const content = JSON.stringify(programManifest(unpacked));
    fs.writeFileSync(manifest, content, { flag: 'wx' });
    const definitions = {
        FAST_PROGRAM_MANIFEST: nsisPath(manifest),
        FAST_PROGRAM_MANIFEST_SHA256: crypto.createHash('sha256').update(content).digest('hex'),
        FAST_PROGRAM_DIRECTORY_SOURCE: nsisPath(path.join(root, 'desktop/program-directory.ps1')),
        FAST_INSTALLER_PROCESS_SOURCE: nsisPath(path.join(root, 'desktop/installer-process.ps1')),
        FAST_PROGRAM_IO_OVERRIDE_SOURCE: nsisPath(path.join(root, 'desktop/fast-program-directory.nsh'))
    };
    fs.writeFileSync(include, Object.entries(definitions).map(([name, value]) => '!define ' + name + ' "' + value + '"').join('\n') + '\n', { flag: 'wx' });
    return { include, manifest };
}
module.exports = { programManifest, validateStockInstallerTemplates, createInstallerIoPolicy };
