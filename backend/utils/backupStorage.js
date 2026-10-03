const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const GiB = 1024 ** 3;

// Persist the selected budget before rotation. Explicit operator settings survive
// upgrades; installations still using the old default adopt the bounded default.
function resolveBackupBudget({ dataDir, directory, kind, envValue, defaultBytes, matches }) {
    const explicit = Number(envValue);
    const policyFile = path.join(dataDir, `backup-storage-${kind}.json`);
    let stored;
    try {
        stored = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
        if (!Number.isSafeInteger(stored.maxTotalBytes) || stored.maxTotalBytes <= 0) throw new Error('invalid budget');
    } catch (error) {
        if (error.code !== 'ENOENT') {
            // Corrupt/unreadable policy must not cause a destructive downgrade.
            if (!(Number.isFinite(explicit) && explicit > 0)) {
                return { maxTotalBytes: 20 * GiB, source: 'policy-error-preserved', warning: error.message };
            }
        }
    }
    if (Number.isFinite(explicit) && explicit > 0) {
        stored = { maxTotalBytes: Math.round(explicit), source: 'environment', configuredAt: new Date().toISOString() };
    } else if (stored && !['legacy-preserved', 'new-install', 'default-migrated'].includes(stored.source)) {
        return stored;
    } else {
        let existing = false;
        try {
            existing = fs.readdirSync(directory, { withFileTypes: true }).some(entry => entry.isFile() && matches(entry.name));
        } catch (error) {
            if (error.code !== 'ENOENT') return { maxTotalBytes: 20 * GiB, source: 'inspection-error-preserved', warning: error.message };
        }
        stored = {
            maxTotalBytes: defaultBytes,
            source: existing ? 'default-migrated' : 'new-install',
            configuredAt: new Date().toISOString(),
            note: '未显式配置的部署采用有界默认预算；轮转保留最后恢复点'
        };
    }
    const temporary = `${policyFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify(stored, null, 2), { flag: 'wx' });
        fs.renameSync(temporary, policyFile);
    } catch (error) {
        if (stored.source !== 'environment') return { maxTotalBytes: 20 * GiB, source: 'persistence-error-preserved', warning: error.message };
        stored.warning = error.message;
    } finally {
        try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the reported policy error. */ }
    }
    return stored;
}

async function exists(filename) {
    try { await fs.promises.access(filename); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function listFiles(directory) {
    const files = [];
    async function visit(current) {
        let entries;
        try { entries = await fs.promises.readdir(current, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
            const filename = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await visit(filename);
            if (entry.isFile()) files.push({ filename, size: (await fs.promises.stat(filename)).size });
        }
    }
    await visit(directory);
    return files.sort((a, b) => a.filename.localeCompare(b.filename));
}

function hashingTransform() {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = new Transform({ transform(chunk, encoding, callback) {
        hash.update(chunk); bytes += chunk.length; callback(null, chunk);
    } });
    return { stream, result: () => ({ size: bytes, sha256: hash.digest('hex') }) };
}

// One source read creates the staging snapshot AND its manifest hash.
async function copyAndHash(source, destination, expectedSize) {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const hasher = hashingTransform();
    let input;
    let output;
    let ownsDestination = false;
    try {
        input = await fs.promises.open(source, 'r');
        const before = await input.stat();
        if (!before.isFile() || (expectedSize !== undefined && before.size !== expectedSize)) {
            throw new Error('备份源文件在快照期间发生变化，请重试');
        }
        output = await fs.promises.open(destination, 'wx');
        ownsDestination = true;
        await pipeline(
            fs.createReadStream(source, { fd: input.fd, autoClose: false }),
            hasher.stream,
            fs.createWriteStream(destination, { fd: output.fd, autoClose: false })
        );
        const result = hasher.result();
        const after = await input.stat();
        const current = await fs.promises.stat(source);
        // Windows path stat can report dev=0 while fstat reports the real device.
        const sameFile = stat => ['ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => stat[key] === before[key]);
        if (result.size !== before.size || !sameFile(after) || !sameFile(current)) {
            throw new Error('备份源文件在快照期间发生变化，请重试');
        }
        return result;
    } catch (error) {
        if (output) { await output.close(); output = null; }
        if (ownsDestination) await fs.promises.rm(destination, { force: true });
        throw error;
    } finally {
        await input?.close();
        await output?.close();
    }
}

async function diskIdentity(directory, io) {
    let current = path.resolve(directory);
    for (;;) {
        try {
            const real = await io.realpath(current);
            const [stat, space] = await Promise.all([io.stat(real), io.statfs(real)]);
            // stat.dev identifies a mounted filesystem, including junction targets.
            const key = stat.dev ? String(stat.dev) : path.parse(real).root.toLowerCase();
            return { key, available: Number(space.bavail) * Number(space.bsize), directory: real };
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error(`无法确认备份磁盘可用空间：${error.message}`);
            const parent = path.dirname(current);
            if (parent === current) throw error;
            current = parent;
        }
    }
}

// Sum simultaneously-live DB dump, staging, archive .tmp and mirror .tmp on
// the SAME volume; existing files are already reflected in available space.
async function ensureDiskSpace(requests, minFreeBytes, io = fs.promises) {
    if (!Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) throw new Error('备份预留空间配置无效');
    const volumes = new Map();
    for (const request of requests) {
        if (!Number.isFinite(request.bytes) || request.bytes < 0 || !Number.isSafeInteger(Math.ceil(request.bytes))) {
            throw new Error('备份预计空间无效');
        }
        const disk = await diskIdentity(request.directory, io);
        if (!Number.isFinite(disk.available) || disk.available < 0) throw new Error('无法确认备份磁盘可用空间');
        const volume = volumes.get(disk.key) || { ...disk, bytes: 0 };
        volume.bytes += Math.ceil(request.bytes);
        volume.available = Math.min(volume.available, disk.available);
        volumes.set(disk.key, volume);
    }
    for (const volume of volumes.values()) {
        if (volume.available < volume.bytes + minFreeBytes) {
            throw new Error(`备份磁盘可用空间不足：${volume.directory}，包含临时快照至少需要 ${Math.ceil((volume.bytes + minFreeBytes) / 1024 / 1024)} MB`);
        }
    }
}

// GLB can contain uncompressed geometry: do not indiscriminately STORE it.
const STORE_EXTENSIONS = new Set(['.gz', '.zip', '.7z', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.ktx2', '.mp3', '.aac', '.ogg', '.mp4', '.webm', '.woff2']);
function shouldStore(filename) { return STORE_EXTENSIONS.has(path.extname(filename).toLowerCase()); }

module.exports = { GiB, resolveBackupBudget, exists, listFiles, hashingTransform, copyAndHash, ensureDiskSpace, shouldStore };
