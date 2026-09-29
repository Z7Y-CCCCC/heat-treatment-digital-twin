const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');
const { sha256 } = require('./runtime-cache.cjs');

function dependencyFingerprint(source) {
    const hash = crypto.createHash('sha256');
    hash.update(`backend-dependencies-v1:${process.platform}:${process.arch}:${process.versions.modules}\0`);
    for (const name of ['package.json', 'package-lock.json']) {
        const filename = path.join(path.dirname(source), name);
        hash.update(fs.existsSync(filename) ? fs.readFileSync(filename) : `missing:${name}`);
    }
    // Do not rely only on the lockfile: local rebuilds and deleted/modified
    // dependencies must invalidate the archive too. ctime catches edits whose
    // original mtime was restored, without reading 14,000 files every build.
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            const stat = fs.lstatSync(filename, { bigint: true });
            hash.update(`${path.relative(source, filename)}\0${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}\0`);
            if (entry.isDirectory()) walk(filename);
            else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(filename));
        }
    }
    walk(source);
    return hash.digest('hex');
}

async function prepareDependencyArchive(source, cache, destination, build = (output) => {
    execFileSync('tar', ['-cf', output, '-C', source, '.'], { windowsHide: true });
}) {
    const fingerprint = dependencyFingerprint(source);
    const archive = path.join(cache, 'backend-dependencies.tar');
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(path.join(cache, 'manifest.json'), 'utf8')); } catch { }
    let reused = false;
    try { reused = metadata?.fingerprint === fingerprint && metadata.sha256 === sha256(archive); } catch { }
    if (!reused) {
        await prepareResourceDirectory(cache, async staging => {
            const output = path.join(staging, 'backend-dependencies.tar');
            await build(output);
            if (dependencyFingerprint(source) !== fingerprint) throw new Error('后端依赖在归档过程中发生变化，请等待依赖安装结束后重新打包');
            fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ fingerprint, sha256: sha256(output) }));
        });
    }
    fs.copyFileSync(archive, destination);
    console.log(reused ? '后端依赖未变化且归档校验通过，复用 tar 缓存。' : '后端依赖已重新归档并建立缓存。');
    return { reused };
}

module.exports = { dependencyFingerprint, prepareDependencyArchive };
