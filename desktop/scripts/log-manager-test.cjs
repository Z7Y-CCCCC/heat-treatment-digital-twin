const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert/strict');
const crypto = require('crypto');
const { finished } = require('stream/promises');
const { once } = require('events');
const {
    cleanupLogArchives,
    createRotatingLogWriter
} = require('../logManager.cjs');

async function main() {
    const root = path.resolve(__dirname, '..', '..', 'output', `log-manager-${Date.now()}-${process.pid}`);
    fs.mkdirSync(root, { recursive: true });
    const current = path.join(root, 'backend.log');
    fs.writeFileSync(current, 'previous-session\n');

    const writer = await createRotatingLogWriter(root, 'backend.log', {
        maxBytes: 32,
        retentionDays: 30,
        maxArchives: 10
    });
    writer.write('12345678901234567890\n');
    writer.write('abcdefghijklmnopqrst\n');
    writer.end();
    await once(writer, 'finish');

    const initialArchives = fs.readdirSync(root).filter(name => name.endsWith('.log.gz'));
    const archivedText = initialArchives
        .map(name => zlib.gunzipSync(fs.readFileSync(path.join(root, name))).toString('utf8'))
        .join('\n');
    const currentText = fs.readFileSync(current, 'utf8');

    const agedArchive = path.join(root, 'backend-aged.log.gz');
    fs.writeFileSync(agedArchive, zlib.gzipSync('aged'));
    const agedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(agedArchive, agedAt, agedAt);
    await cleanupLogArchives(root, { retentionDays: 30, maxArchives: 10 });

    for (let index = 0; index < 5; index += 1) {
        const filename = path.join(root, `backend-extra-${index}.log.gz`);
        fs.writeFileSync(filename, zlib.gzipSync(`extra-${index}`));
        const modified = new Date(Date.now() + index * 1000);
        fs.utimesSync(filename, modified, modified);
    }
    await cleanupLogArchives(root, { retentionDays: 30, maxArchives: 2 });
    const finalArchives = fs.readdirSync(root).filter(name => name.endsWith('.log.gz'));

    for (let index = 0; index < 4; index += 1) {
        const filename = path.join(root, `backend-quota-${index}.log.gz`);
        fs.writeFileSync(filename, zlib.gzipSync(Buffer.alloc(512, index + 1)));
        const modified = new Date(Date.now() + 10000 + index * 1000);
        fs.utimesSync(filename, modified, modified);
    }
    await cleanupLogArchives(root, { retentionDays: 30, maxArchives: 20, maxTotalBytes: 70 });
    const quotaArchives = fs.readdirSync(root)
        .filter(name => name.endsWith('.log.gz'))
        .map(name => ({ name, size: fs.statSync(path.join(root, name)).size }));
    const quotaBytes = quotaArchives.reduce((sum, item) => sum + item.size, 0);

    const checks = {
        previousSessionCompressed: archivedText.includes('previous-session'),
        sizeRotationCompressed: archivedText.includes('12345678901234567890'),
        activeLogContinuesAfterRotation: currentText.includes('abcdefghijklmnopqrst'),
        expiredArchiveDeleted: !fs.existsSync(agedArchive),
        archiveCountCapped: finalArchives.length === 2,
        archiveDirectorySizeCapped: quotaArchives.length === 1 || quotaBytes <= 70
    };
    const asyncDirectory = path.join(root, 'async');
    const payload = crypto.randomBytes(2 * 1024 * 1024 + 113);
    const syncNames = ['mkdirSync', 'openSync', 'fstatSync', 'statSync', 'readFileSync', 'writeFileSync',
        'writeSync', 'renameSync', 'rmSync', 'closeSync', 'readdirSync', 'existsSync'];
    const originals = new Map(syncNames.map(name => [name, fs[name]]));
    const originalGzip = zlib.gzipSync;
    let ticks = 0;
    let drainSeen = false;
    let callbackCount = 0;
    let stream;
    const timer = setInterval(() => ticks++, 1);
    try {
        for (const name of syncNames) fs[name] = () => { throw new Error(`Blocking filesystem operation: ${name}`); };
        zlib.gzipSync = () => { throw new Error('Blocking gzip'); };
        stream = await createRotatingLogWriter(asyncDirectory, 'large.log', {
            maxBytes: 256 * 1024, maxArchives: 100, maxTotalBytes: 5 * 1024 * 1024,
            highWaterMark: 1024
        });
        const draining = once(stream, 'drain').then(() => { drainSeen = true; });
        assert.equal(stream.write(payload, error => { assert.ifError(error); callbackCount++; }), false);
        await draining;
        const completion = finished(stream);
        stream.end('tail', () => callbackCount++);
        await completion;
    } finally {
        clearInterval(timer);
        for (const [name, fn] of originals) fs[name] = fn;
        zlib.gzipSync = originalGzip;
    }
    const oversizedArchives = fs.readdirSync(asyncDirectory).filter(name => name.endsWith('.log.gz'))
        .sort((a, b) => Number(a.match(/-(\d+)\.log\.gz$/)[1]) - Number(b.match(/-(\d+)\.log\.gz$/)[1]));
    const segments = oversizedArchives.map(name => zlib.gunzipSync(fs.readFileSync(path.join(asyncDirectory, name))));
    segments.push(fs.readFileSync(path.join(asyncDirectory, 'large.log')));
    checks.noBlockingFilesystemOrGzip = true;
    checks.oversizedChunkHasNoOversizedSegment = segments.every(chunk => chunk.length <= 256 * 1024);
    checks.oversizedChunkPreservesEveryByteAndOrder = Buffer.concat(segments).equals(Buffer.concat([payload, Buffer.from('tail')]));
    checks.backpressureDrainAndCallbacks = drainSeen && callbackCount === 2;
    checks.eventLoopRunsDuringCompression = ticks > 2;
    checks.finishLeavesNoTemporaryArchives = !fs.readdirSync(asyncDirectory).some(name => name.endsWith('.tmp'));

    const invalidDirectory = path.join(root, 'not-a-directory');
    fs.writeFileSync(invalidDirectory, 'file');
    await assert.rejects(createRotatingLogWriter(invalidDirectory, 'error.log'));
    checks.openFailureRejects = true;
    const failing = await createRotatingLogWriter(path.join(root, 'failure'), 'error.log');
    const originalWrite = failing.handle.write.bind(failing.handle);
    failing.handle.write = async () => { throw new Error('injected write failure'); };
    const failure = finished(failing);
    let callbackError;
    failing.write('must fail', error => { callbackError = error; });
    await assert.rejects(failure, /injected write failure/);
    checks.writeFailureReachesCallbackAndError = callbackError?.message === 'injected write failure' && failing.handle === null;
    // Partial writes are legal; no data may silently disappear.
    const partial = await createRotatingLogWriter(path.join(root, 'partial'), 'partial.log');
    const partialWrite = partial.handle.write.bind(partial.handle);
    partial.handle.write = (buffer, offset, length) => partialWrite(buffer, offset, Math.min(length, 3));
    const partialFinish = finished(partial);
    partial.end('partial-write-payload');
    await partialFinish;
    checks.partialWritesRetry = fs.readFileSync(partial.filename, 'utf8') === 'partial-write-payload';
    // Destroy while IO is pending must wait before closing, with a single callback.
    const destroyed = await createRotatingLogWriter(path.join(root, 'destroy'), 'destroy.log');
    const pendingWrite = destroyed.handle.write.bind(destroyed.handle);
    let releaseWrite;
    destroyed.handle.write = async (...args) => {
        await new Promise(resolve => { releaseWrite = resolve; });
        return pendingWrite(...args);
    };
    let destroyCallbackCount = 0;
    destroyed.write('pending', () => destroyCallbackCount++);
    const closed = once(destroyed, 'close');
    destroyed.destroy();
    releaseWrite();
    await closed;
    checks.destroyWaitsForInflightWrite = destroyed.handle === null && destroyCallbackCount === 1;
    const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    const result = { success: failed.length === 0, checks, directory: root };
    console.log(JSON.stringify(result, null, 2));
    if (failed.length) throw new Error(`Log manager checks failed: ${failed.join(', ')}`);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
