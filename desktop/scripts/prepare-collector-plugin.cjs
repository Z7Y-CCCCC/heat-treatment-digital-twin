'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileDigest } = require('./file-digest.cjs');
const { COLLECTOR_FILES } = require('./prepare-display-distribution.cjs');
const project = path.resolve(__dirname, '../..');
// Independent service distribution, no Unity, Electron or WebView binary.
const RESOURCE_NAMES = ['backend', 'backend-dependencies.tar', 'runtime', 'mysql', 'frontend', 'shared', 'licensing', 'templates', 'ffmpeg'];
function inventory(root) {
    const files = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Plugin resources must not contain links');
            if (entry.isDirectory()) walk(file);
            else files.push({ path: path.relative(root, file).split(path.sep).join('/'), ...fileDigest(file) });
        }
    }
    walk(root); return files.sort((a,b) => a.path.localeCompare(b.path));
}
function prepareCollectorPlugin(displayResources, destination, source = project) {
    if (fs.existsSync(destination)) throw new Error('Plugin staging destination must be new');
    const resources = path.join(destination, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    for (const name of RESOURCE_NAMES) fs.cpSync(path.join(displayResources, name), path.join(resources, name), { recursive: true });
    for (const name of ['collector-center', 'collector-service']) fs.cpSync(path.join(source, 'desktop', '.cache', name), path.join(resources, name), { recursive: true });
    for (const file of COLLECTOR_FILES) fs.copyFileSync(path.join(source, 'backend', 'services', file), path.join(resources, 'backend', 'services', file));
    fs.writeFileSync(path.join(resources, 'backend', 'distribution.json'), JSON.stringify({ product: 'collector-plugin', collector: true }));
    for (const name of ['安装采集服务.ps1', '采集运行中心.cmd', 'collector-operations.ps1']) fs.copyFileSync(path.join(source, 'desktop', name), path.join(destination, name));
    for (const name of ['Install-CollectorPlugin.ps1', '安装采集插件.cmd', 'README.md']) fs.copyFileSync(path.join(source, 'desktop', 'collector-plugin', name), path.join(destination, name));
    fs.writeFileSync(path.join(destination, 'plugin-manifest.json'), JSON.stringify({ product: 'collector-plugin', version: require(path.join(source, 'desktop', 'package.json')).version,
        files: inventory(destination) }, null, 2));
    return destination;
}
if (require.main === module) console.log(prepareCollectorPlugin(path.resolve(process.argv[2]), path.resolve(process.argv[3])));
module.exports = { prepareCollectorPlugin, inventory, RESOURCE_NAMES };
