const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_ARCHIVES = 60;
const DEFAULT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
let archiveSequence = 0;
const cleanupTasks = new Map();

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function timestampToken(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

function archiveFilename(filename) {
    const extension = path.extname(filename);
    const stem = path.basename(filename, extension);
    archiveSequence += 1;
    return path.join(
        path.dirname(filename),
        `${stem}-${timestampToken()}-${process.pid}-${archiveSequence}.log.gz`
    );
}

function archiveOptions(options = {}) {
    return {
        retentionDays: positiveInteger(options.retentionDays ?? process.env.LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS),
        maxArchives: positiveInteger(options.maxArchives ?? process.env.LOG_MAX_ARCHIVES, DEFAULT_MAX_ARCHIVES),
        maxTotalBytes: positiveInteger(options.maxTotalBytes ?? process.env.LOG_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES)
    };
}

async function cleanupArchives(directory, options) {
    await fs.promises.mkdir(directory, { recursive: true });
    const { retentionDays, maxArchives, maxTotalBytes } = archiveOptions(options);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const archives = [];
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.log.gz')) {
            const filename = path.join(directory, entry.name);
            try {
                const stat = await fs.promises.stat(filename);
                if (stat.mtimeMs < cutoff) await fs.promises.rm(filename, { force: true });
                else archives.push({ filename, stat });
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
    }
    archives.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.filename.localeCompare(a.filename));
    let retainedCount = 0;
    let totalBytes = 0;
    for (const archive of archives) {
        // Preserve the historical newest-archive exception to the byte quota.
        if (retainedCount === 0 || (retainedCount < maxArchives && totalBytes + archive.stat.size <= maxTotalBytes)) {
            retainedCount += 1;
            totalBytes += archive.stat.size;
        } else await fs.promises.rm(archive.filename, { force: true });
    }
}

function cleanupLogArchives(directory, options = {}) {
    const key = path.resolve(directory);
    const previous = cleanupTasks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => cleanupArchives(key, options));
    cleanupTasks.set(key, task);
    // Existing timer callers intentionally do not await this optional maintenance.
    // Attach a rejection handler without hiding errors from callers that DO await.
    task.then(() => { if (cleanupTasks.get(key) === task) cleanupTasks.delete(key); }, () => {
        if (cleanupTasks.get(key) === task) cleanupTasks.delete(key);
    });
    return task;
}

async function archiveExistingLog(filename) {
    let stat;
    try { stat = await fs.promises.stat(filename); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.size === 0) {
        await fs.promises.rm(filename, { force: true });
        return null;
    }

    const destination = archiveFilename(filename);
    const temporary = `${destination}.tmp`;
    try {
        await pipeline(
            fs.createReadStream(filename),
            zlib.createGzip({ level: 6 }),
            fs.createWriteStream(temporary, { flags: 'wx' })
        );
        await fs.promises.rename(temporary, destination);
        await fs.promises.rm(filename, { force: true });
        return destination;
    } finally {
        await fs.promises.rm(temporary, { force: true });
    }
}

class RotatingLogWriter extends Writable {
    constructor(directory, filename, options = {}) {
        super({ highWaterMark: positiveInteger(options.highWaterMark, 64 * 1024) });
        this.directory = directory;
        this.filename = path.join(directory, filename);
        this.maxBytes = positiveInteger(options.maxBytes ?? process.env.LOG_MAX_BYTES, DEFAULT_MAX_BYTES);
        this.retentionDays = positiveInteger(options.retentionDays ?? process.env.LOG_RETENTION_DAYS, DEFAULT_RETENTION_DAYS);
        this.maxArchives = positiveInteger(options.maxArchives ?? process.env.LOG_MAX_ARCHIVES, DEFAULT_MAX_ARCHIVES);
        this.maxTotalBytes = positiveInteger(options.maxTotalBytes ?? process.env.LOG_MAX_TOTAL_BYTES, DEFAULT_MAX_TOTAL_BYTES);
        this.handle = null;
        this.bytes = 0;
        this.operation = Promise.resolve();
    }

    async open() {
        this.handle = await fs.promises.open(this.filename, 'a');
        this.bytes = (await this.handle.stat()).size;
    }

    async close() {
        const handle = this.handle;
        this.handle = null;
        if (handle) await handle.close();
    }

    async rotate() {
        await this.close();
        await archiveExistingLog(this.filename);
        await cleanupLogArchives(this.directory, this);
        await this.open();
    }

    async writeBuffer(buffer) {
        let offset = 0;
        if (this.bytes > 0 && buffer.length <= this.maxBytes && this.bytes + buffer.length > this.maxBytes) {
            await this.rotate();
        }
        while (offset < buffer.length && !this.destroyed) {
            if (this.bytes >= this.maxBytes) await this.rotate();
            const length = Math.min(buffer.length - offset, this.maxBytes - this.bytes);
            const { bytesWritten } = await this.handle.write(buffer, offset, length);
            if (bytesWritten === 0) throw new Error('Log write made no progress');
            offset += bytesWritten;
            this.bytes += bytesWritten;
        }
    }

    _write(chunk, encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        this.operation = this.writeBuffer(buffer);
        this.operation.then(() => callback(), callback);
    }

    _final(callback) {
        this.operation = this.close();
        this.operation.then(() => callback(), callback);
    }

    _destroy(error, callback) {
        // Never close a file handle underneath an in-flight asynchronous write.
        this.operation.catch(() => {}).then(() => this.close()).then(
            () => callback(error), closeError => callback(error || closeError));
    }
}

async function createRotatingLogWriter(directory, filename, options = {}) {
    await fs.promises.mkdir(directory, { recursive: true });
    await archiveExistingLog(path.join(directory, filename));
    await cleanupLogArchives(directory, options);
    const writer = new RotatingLogWriter(directory, filename, options);
    try { await writer.open(); }
    catch (error) { await writer.close(); throw error; }
    return writer;
}

module.exports = {
    DEFAULT_MAX_BYTES,
    DEFAULT_RETENTION_DAYS,
    DEFAULT_MAX_ARCHIVES,
    DEFAULT_MAX_TOTAL_BYTES,
    cleanupLogArchives,
    createRotatingLogWriter
};
