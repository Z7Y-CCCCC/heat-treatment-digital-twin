const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const directory = createRunDirectory('alarm-outbox');
Object.assign(process.env, {
    NODE_ENV: 'test', APP_DATA_DIR: path.join(directory, 'data'), DB_TYPE: 'sqlite',
    SQLITE_FILE: path.join(directory, 'data', 'business.db'),
    DB_BACKUP_DIR: path.join(directory, 'backups'), DB_RECOVERY_DIR: path.join(directory, 'recovery')
});
delete process.env.SQLITE_RECOVERY_TEMPLATE;
delete process.env.SQLITE_UPGRADE_TEMPLATE;
const database = require('../db/database');
const { AlarmOutbox, getAlarmOutbox, closeAlarmOutbox, snapshotAlarmOutbox } = require('../services/alarmOutbox');
const results = [];
const engines = [];
const journals = [];
let db;

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function engineWithDatabase(handle, outbox, factoryId = 'factory_default') {
    const target = require.resolve('../services/dataEngine');
    const isolated = new Module(target, module);
    isolated.filename = target;
    isolated.paths = Module._nodeModulePaths(path.dirname(target));
    const originalRequire = isolated.require.bind(isolated);
    isolated.require = request => request === '../db/database' ? { getDb: async () => handle } : originalRequire(request);
    isolated._compile(fs.readFileSync(target, 'utf8'), target);
    const engine = new isolated.exports({}, { alarmOutbox: () => outbox, factoryId });
    engine.activeFactoryId = factoryId;
    engines.push(engine);
    return engine;
}

function journal(name) {
    const outbox = new AlarmOutbox(path.join(directory, `${name}.db`));
    journals.push(outbox);
    return outbox;
}
function alarm(deviceId, value, quality = 'good') {
    return [{ furnace_id: deviceId, status: { alarm: value }, quality: { status: { alarm: quality } } }];
}
async function retryNow(engine) {
    clearTimeout(engine.alarmRetryTimer);
    engine.alarmRetryTimer = null;
    return engine._drainAlarmEvents();
}
async function check(name, callback) {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
}

async function main() {
    db = await database.getDb();
    await check('10,000 unchanged PLC frames retain one durable transition and one delivery worker', async () => {
        const outbox = journal('unchanged');
        const entered = deferred(), release = deferred();
        let writes = 0;
        const engine = engineWithDatabase({ ...db, async get(sql, values) {
            entered.resolve(); await release.promise; return db.get(sql, values);
        }, async run(sql, values) { writes += 1; return db.run(sql, values); } }, outbox);
        const first = engine._recordAlarmEvents(alarm('unchanged-device', true));
        await entered.promise;
        const worker = engine.alarmWritePending;
        try {
            for (let count = 0; count < 10000; count++) await engine._recordAlarmEvents(alarm('unchanged-device', true));
            assert.equal(outbox.pending('factory_default'), 1);
            assert.equal(engine.alarmWritePending, worker);
        } finally { release.resolve(); }
        await first;
        assert.equal(writes, 1);
        assert.equal(outbox.pending('factory_default'), 0);
        await engine.stop();
    });
    await check('database outage preserves ordered trigger/recovery transitions and exposes failed storage', async () => {
        const outbox = journal('outage');
        let failing = true;
        const engine = engineWithDatabase({ ...db, get: async (sql, values) => {
            if (failing) throw new Error('injected database outage');
            return db.get(sql, values);
        } }, outbox);
        const first = engine._recordAlarmEvents(alarm('outage-device', true)).catch(error => error);
        await engine._recordAlarmEvents(alarm('outage-device', false));
        await engine._recordAlarmEvents(alarm('outage-device', true));
        await first;
        assert.equal(outbox.pending('factory_default'), 3);
        assert.equal(engine.getStatus().eventStorageStatus.status, 'error');
        await engine._recordAlarmEvents(alarm('outage-device', false, 'bad'));
        assert.equal(outbox.pending('factory_default'), 3);
        failing = false;
        await retryNow(engine);
        assert.deepEqual((await db.all('SELECT value FROM event_logs WHERE source_id = ? ORDER BY id', ['outage-device'])).map(row => row.value), ['true', 'false', 'true']);
        assert.equal(engine.getStatus().eventStorageStatus.status, 'healthy');
        assert.equal(outbox.pending('factory_default'), 0);
        await engine.stop();
    });
    await check('a business commit followed by lost acknowledgement is replayed without duplicate events', async () => {
        const outbox = journal('ack-failure');
        const acknowledge = outbox.acknowledge.bind(outbox);
        outbox.acknowledge = () => { throw new Error('injected failure after business commit'); };
        const engine = engineWithDatabase(db, outbox);
        await assert.rejects(engine._recordAlarmEvents(alarm('ack-device', true)), /business commit/);
        await engine.stop();
        assert.equal(outbox.pending('factory_default'), 1);
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE source_id = ?', ['ack-device'])).count, 1);
        outbox.acknowledge = acknowledge;
        const recovered = engineWithDatabase(db, outbox);
        await recovered._drainAlarmEvents();
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE source_id = ?', ['ack-device'])).count, 1);
        assert.equal(outbox.pending('factory_default'), 0);
        await recovered._recordAlarmEvents(alarm('ack-device', true));
        assert.equal(outbox.pending('factory_default'), 0, 'persisted observed state survives a collector restart');
        await recovered.stop();
    });
    await check('abrupt process exit preserves unacknowledged events and observed alarm state', async () => {
        const filename = path.join(directory, 'crash.db');
        const child = spawnSync(process.execPath, ['-e', `
            const { AlarmOutbox } = require(process.argv[1]);
            const outbox = new AlarmOutbox(process.argv[2]);
            outbox.record('factory_default', [
                { deviceId: 'crash-device', deviceName: 'Crash', alarm: true, quality: 'good', occurredAt: Date.now() },
                { deviceId: 'crash-device', deviceName: 'Crash', alarm: false, quality: 'good', occurredAt: Date.now() }
            ]);
            process.exit(91);
        `, require.resolve('../services/alarmOutbox'), filename], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        assert.equal(child.status, 91, child.stderr);
        const outbox = new AlarmOutbox(filename);
        journals.push(outbox);
        assert.equal(outbox.pending('factory_default'), 2);
        const engine = engineWithDatabase(db, outbox);
        await engine._drainAlarmEvents();
        assert.deepEqual((await db.all('SELECT value FROM event_logs WHERE source_id = ? ORDER BY id', ['crash-device'])).map(row => row.value), ['true', 'false']);
        await engine.stop();
    });
    await check('local journal write failure is explicit and cannot acknowledge an unpersisted transition', async () => {
        const outbox = journal('disk-failure');
        const engine = engineWithDatabase(db, outbox);
        outbox.database.pragma('query_only = ON');
        await assert.rejects(engine._recordAlarmEvents(alarm('disk-device', true)), /readonly/);
        assert.equal(outbox.pending('factory_default'), 0);
        assert.match(engine.getStatus().eventStorageStatus.lastError, /^journal:/);
        assert.equal(engine.alarmState.has('disk-device'), false);
        outbox.database.pragma('query_only = OFF');
        await engine._recordAlarmEvents(alarm('disk-device', true));
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE source_id = ?', ['disk-device'])).count, 1);
        await engine.stop();
    });
    await check('stop rejects stale delivery after a pending database read and restart drains the retained event', async () => {
        const outbox = journal('stop');
        const entered = deferred(), release = deferred();
        let writes = 0;
        const engine = engineWithDatabase({ ...db, get: async () => { entered.resolve(); await release.promise; return null; },
            run: async () => { writes += 1; } }, outbox);
        const first = engine._recordAlarmEvents(alarm('stop-device', true));
        await entered.promise;
        const stopping = engine.stop();
        release.resolve();
        await first;
        await stopping;
        assert.equal(writes, 0);
        assert.equal(outbox.pending('factory_default'), 1);
        const recovered = engineWithDatabase(db, outbox);
        await recovered._drainAlarmEvents();
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE source_id = ?', ['stop-device'])).count, 1);
        await recovered.stop();
    });
    await check('large durable backlogs load at most 32 records per delivery batch and keep event loop active', async () => {
        const outbox = journal('batch');
        outbox.record('factory_default', Array.from({ length: 2000 }, (_, index) => ({ deviceId: 'batch-device', deviceName: 'Batch',
            alarm: index % 2 === 0, quality: 'good', occurredAt: Date.now() })));
        assert.equal(outbox.pending('factory_default'), 2000);
        let largestBatch = 0, ticks = 0;
        const batch = outbox.batch.bind(outbox);
        outbox.batch = (...args) => { const rows = batch(...args); largestBatch = Math.max(largestBatch, rows.length); return rows; };
        const timer = setInterval(() => { ticks += 1; }, 1);
        const engine = engineWithDatabase(db, outbox);
        try { await engine._drainAlarmEvents(); } finally { clearInterval(timer); }
        assert.equal(largestBatch, 32);
        assert.ok(ticks > 0);
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE source_id = ?', ['batch-device'])).count, 2000);
        await engine.stop();
    });
    await check('ordinary existing events remain valid with nullable collector identifiers', async () => {
        await db.run('INSERT INTO event_logs (title) VALUES (?)', ['ordinary event 1']);
        await db.run('INSERT INTO event_logs (title) VALUES (?)', ['ordinary event 2']);
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE collector_event_id IS NULL')).count, 2);
    });
    await check('backlog status uses a cached counter rather than rescanning the durable queue for each frame', async () => {
        const outbox = journal('counter');
        let scans = 0;
        const countPending = outbox.countPending;
        outbox.countPending = { get(...args) { scans += 1; return countPending.get(...args); } };
        outbox.record('factory_default', [{ deviceId: 'counter-device', deviceName: 'Counter', alarm: true, quality: 'good', occurredAt: Date.now() }]);
        for (let count = 0; count < 10000; count++) assert.equal(outbox.pending('factory_default'), 1);
        assert.equal(scans, 1);
        const event = outbox.batch('factory_default')[0];
        outbox.acknowledge(event);
        outbox.acknowledge(event);
        assert.equal(outbox.pending('factory_default'), 0);
        assert.equal(scans, 1);
    });
    await check('portable outbox snapshot merges pending events without reverting live observed state', async () => {
        const source = journal('portable-source');
        source.record('factory_default', [{ deviceId: 'portable-device', deviceName: 'Portable', alarm: true, quality: 'good', occurredAt: Date.now() }]);
        const snapshot = path.join(directory, 'portable-snapshot.db');
        await snapshotAlarmOutbox(path.join(directory, 'portable-source.db'), snapshot);
        const target = journal('portable-target');
        target.record('factory_default', [
            { deviceId: 'portable-device', deviceName: 'Portable', alarm: true, quality: 'good', occurredAt: Date.now() },
            { deviceId: 'portable-device', deviceName: 'Portable', alarm: false, quality: 'good', occurredAt: Date.now() }
        ]);
        const restore = target.beginImportSnapshot(snapshot);
        restore.commit();
        assert.equal(target.observed.get('factory_default', 'portable-device').alarm, 0);
        assert.equal(target.pending('factory_default'), 3);
        const engine = engineWithDatabase(db, target);
        await engine._drainAlarmEvents();
        assert.equal(target.pending('factory_default'), 0);
        const repeat = target.beginImportSnapshot(snapshot);
        repeat.commit();
        await engine._drainAlarmEvents();
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM event_logs WHERE source_id = ?', ['portable-device'])).count, 3);
        await engine.stop();
    });
    await check('failed business restore rolls back imported pending events and observed state together', async () => {
        const source = journal('rollback-source');
        source.record('factory_default', [{ deviceId: 'rollback-device', deviceName: 'Rollback', alarm: true, quality: 'good', occurredAt: Date.now() }]);
        const snapshot = path.join(directory, 'rollback-snapshot.db');
        await snapshotAlarmOutbox(path.join(directory, 'rollback-source.db'), snapshot);
        const target = journal('rollback-target');
        const importing = target.beginImportSnapshot(snapshot);
        importing.rollback();
        assert.equal(target.pending('factory_default'), 0);
        assert.equal(target.observed.get('factory_default', 'rollback-device'), undefined);
    });
    await check('actual site ZIP includes a valid outbox snapshot and restore retains current pending transitions', async () => {
        const outbox = getAlarmOutbox();
        outbox.record('factory_default', [{ deviceId: 'site-device', deviceName: 'Site', alarm: true, quality: 'good', occurredAt: Date.now() }]);
        const siteBackup = require('../services/siteBackup');
        const uploads = path.join(directory, 'uploads');
        fs.mkdirSync(uploads, { recursive: true });
        const backup = await siteBackup.createSiteBackup(uploads);
        const archiveFilename = siteBackup.resolveSiteBackupPath(backup.filename);
        const archive = await require('unzipper').Open.file(archiveFilename);
        assert.ok(archive.files.some(file => file.path === 'runtime/alarm-outbox.db'));
        outbox.record('factory_default', [{ deviceId: 'site-device', deviceName: 'Site', alarm: false, quality: 'good', occurredAt: Date.now() }]);
        const restored = await siteBackup.restoreSiteBackup(archiveFilename, uploads);
        assert.equal(restored.success, true);
        assert.equal(outbox.pending('factory_default'), 2);
        assert.equal(outbox.observed.get('factory_default', 'site-device').alarm, 0);
        const engine = engineWithDatabase(db, outbox);
        await engine._drainAlarmEvents();
        assert.deepEqual((await db.all('SELECT value FROM event_logs WHERE source_id = ? ORDER BY id', ['site-device'])).map(row => row.value), ['true', 'false']);
        await engine.stop();

        const target = require.resolve('../services/siteBackup');
        const isolated = new Module(target, module);
        isolated.filename = target;
        isolated.paths = Module._nodeModulePaths(path.dirname(target));
        const originalRequire = isolated.require.bind(isolated);
        isolated.require = request => request === '../db/database'
            ? { ...database, restoreDatabaseBackup: async () => { const error = new Error('injected business restore failure'); error.databaseRollbackCompleted = true; throw error; } }
            : originalRequire(request);
        isolated._compile(fs.readFileSync(target, 'utf8'), target);
        await assert.rejects(isolated.exports.restoreSiteBackup(archiveFilename, uploads), /injected business restore failure/);
        assert.equal(outbox.pending('factory_default'), 0);
        assert.equal(outbox.observed.get('factory_default', 'site-device').alarm, 0);
    });
}

(async () => {
    try { await main(); }
    finally {
        await Promise.allSettled(engines.map(engine => engine.stop()));
        for (const outbox of journals) outbox.close();
        closeAlarmOutbox();
        await database.closeDb();
    }
    const result = { success: results.every(result => result.passed), passed: results.filter(result => result.passed).length, total: results.length, directory, results };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, results: undefined }));
    if (!result.success) process.exitCode = 1;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
