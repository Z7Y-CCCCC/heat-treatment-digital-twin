const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');
const { POLICY_VERSION, dependencyRuntimePlan } = require('./dependency-runtime-policy.cjs');
const { prepareResourceDirectory } = require('./resource-preparation.cjs');
const { sha256 } = require('./runtime-cache.cjs');

function dependencyFingerprint(source) {
    const hash = crypto.createHash('sha256');
    hash.update('dependency-content-v2:' + POLICY_VERSION + ':' + process.platform + ':' + process.arch + ':' + process.versions.modules + '\0');
    // Cache inputs include the packing implementation, not only its policy.
    hash.update(fs.readFileSync(__filename));
    hash.update(fs.readFileSync(path.join(__dirname, 'dependency-runtime-policy.cjs')));
    for (const name of ['package.json', 'package-lock.json']) {
        const filename = path.join(path.dirname(source), name);
        hash.update(fs.existsSync(filename) ? fs.readFileSync(filename) : 'missing:' + name);
    }
    // NTFS may retain identical mtime/ctime values for rapid same-size writes.
    // Hash actual bytes. Fixed tar mtimes make timestamp/inode-only changes
    // irrelevant, so clean hosted checkouts can reuse identical content.
    const buffer = Buffer.allocUnsafe(128 * 1024);
    function hashFile(filename, stat) {
        const descriptor = fs.openSync(filename, 'r');
        try {
            const opened = fs.fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || opened.size !== stat.size || opened.ino !== stat.ino) {
                throw new Error('Dependency source changed while opening its content');
            }
            let total = 0n;
            for (;;) {
                const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
                if (!count) break;
                total += BigInt(count);
                if (total > stat.size) throw new Error('Dependency source grew while hashing its content');
                hash.update(buffer.subarray(0, count));
            }
            const after = fs.fstatSync(descriptor, { bigint: true });
            if (total !== stat.size || after.size !== stat.size) throw new Error('Dependency source size changed while hashing its content');
        } finally { fs.closeSync(descriptor); }
    }
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const filename = path.join(directory, entry.name);
            const stat = fs.lstatSync(filename, { bigint: true });
            hash.update(path.relative(source, filename) + '\0' + stat.mode + ':' + stat.size + '\0');
            if (entry.isDirectory()) walk(filename);
            else if (entry.isSymbolicLink()) hash.update(fs.readlinkSync(filename));
            else if (entry.isFile()) hashFile(filename, stat);
            else throw new Error('Unsupported dependency entry in archive source');
        }
    }
    walk(source);
    return hash.digest('hex');
}

async function prepareDependencyArchive(source, cache, destination, build = (output) => {
    // Windows bsdtar can spend minutes traversing a large synced dependency
    // tree before writing a byte. Node tar streams entries with bounded jobs.
    // This is a build-only dependency; customer runtime requirements do not change.
    const plan = dependencyRuntimePlan(source);
    // Keep all runtime code, binaries, JSON/certificates and license notices.
    // Only non-runtime types, source maps and documentation are omitted.
    // A fixed tar mtime avoids re-extraction solely because CI checkout times changed.
    console.log(`后端运行依赖：${plan.retainedFiles}/${plan.sourceFiles} 个文件；省去 ${plan.omittedFiles} 个非运行文件。`);
    return tar.c({ file: output, cwd: source, portable: true, mtime: new Date(0), jobs: 32, filter: plan.filter }, ['.']);
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
