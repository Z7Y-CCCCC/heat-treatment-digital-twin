const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');

const outputRoot = path.resolve(__dirname, '..', '..', 'output');
fs.mkdirSync(outputRoot, { recursive: true });
const runDirectory = fs.mkdtempSync(path.join(outputRoot, 'backend-concurrency-'));
process.env.NODE_ENV = 'test';
process.env.APP_DATA_DIR = path.join(runDirectory, 'data');
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_FILE = path.join(process.env.APP_DATA_DIR, 'factory.db');
process.env.DB_BACKUP_DIR = path.join(runDirectory, 'backups');
process.env.DB_RECOVERY_DIR = path.join(runDirectory, 'recovery');
delete process.env.SQLITE_RECOVERY_TEMPLATE;
delete process.env.SQLITE_UPGRADE_TEMPLATE;

const databasePath = require.resolve('../db/database');
const database = require(databasePath);
const results = [];

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function requireWithStubs(filename, stubs) {
    const target = require.resolve(filename);
    const originals = new Map();
    for (const [dependency, exports] of Object.entries(stubs)) {
        const id = require.resolve(dependency);
        originals.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const originalTarget = require.cache[target];
    delete require.cache[target];
    try {
        return require(target);
    } finally {
        if (originalTarget) require.cache[target] = originalTarget;
        else delete require.cache[target];
        for (const [id, original] of originals) {
            if (original) require.cache[id] = original;
            else delete require.cache[id];
        }
    }
}

async function check(name, callback) {
    try {
        await callback();
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.stack });
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

async function main() {
    const db = await database.getDb();
    await db.run('CREATE TABLE audit_transactions (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');

    await check('ordinary write survives an unrelated transaction rollback', async () => {
        const entered = deferred();
        const release = deferred();
        const transactionResult = db.transaction(async tx => {
            await tx.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['rollback', 1]);
            entered.resolve();
            await release.promise;
            throw new Error('expected rollback');
        }).catch(error => error);
        await entered.promise;
        const outsideWrite = db.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['outside', 2]);
        await nextTurn();
        release.resolve();
        assert.match((await transactionResult).message, /expected rollback/);
        await outsideWrite;
        assert.equal((await db.get('SELECT value FROM audit_transactions WHERE id = ?', ['outside']))?.value, 2);
        assert.equal(await db.get('SELECT * FROM audit_transactions WHERE id = ?', ['rollback']), null);
    });

    await check('concurrent SQLite transactions are serialized', async () => {
        const entered = deferred();
        const release = deferred();
        const first = db.transaction(async tx => {
            await tx.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['first', 3]);
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const second = db.transaction(tx => tx.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['second', 4]))
            .then(value => ({ value }), error => ({ error }));
        await nextTurn();
        release.resolve();
        await first;
        assert.ifError((await second).error);
        assert.equal((await db.get('SELECT value FROM audit_transactions WHERE id = ?', ['second']))?.value, 4);
    });

    await check('ordinary reads never observe another transaction uncommitted rows', async () => {
        const entered = deferred();
        const release = deferred();
        const transactionResult = db.transaction(async tx => {
            await tx.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['uncommitted', 5]);
            entered.resolve();
            await release.promise;
            throw new Error('expected rollback');
        }).catch(error => error);
        await entered.promise;
        const outsideRead = db.get('SELECT * FROM audit_transactions WHERE id = ?', ['uncommitted']);
        await nextTurn();
        release.resolve();
        await transactionResult;
        assert.equal(await outsideRead, null);
    });

    await check('parallel upserts of a new key do not violate uniqueness', async () => {
        await Promise.all(Array.from({ length: 8 }, (_, value) => db.upsert('audit_transactions', { id: 'upsert', value }, 'id')));
        assert.equal((await db.get('SELECT COUNT(*) AS count FROM audit_transactions WHERE id = ?', ['upsert'])).count, 1);
    });

    await check('a completed transaction client cannot perform late writes', async () => {
        let transactionClient;
        await db.transaction(async tx => { transactionClient = tx; });
        await assert.rejects(transactionClient.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['too-late', 6]), /事务已经结束/);
        assert.equal(await db.get('SELECT * FROM audit_transactions WHERE id = ?', ['too-late']), null);
    });

    await check('invalid settings batch leaves every original setting unchanged', async () => {
        const express = require('express');
        const app = express();
        app.use(express.json());
        app.use('/settings', require('../routes/settings')());
        const server = await new Promise(resolve => {
            const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        });
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/settings`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ audit_setting_partial: 'must-not-be-saved', native_quality_profile: 'invalid' })
            });
            assert.equal(response.status, 400);
            assert.equal(await db.get('SELECT * FROM settings WHERE `key` = ?', ['audit_setting_partial']), null);
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    });

    await check('Simulator stop cancels a pending asynchronous start', async () => {
        const entered = deferred();
        const release = deferred();
        const Simulator = requireWithStubs('../services/simulator', {
            '../db/database': { getDb: async () => ({ all: async sql => {
                if (sql.includes('devices')) { entered.resolve(); return release.promise; }
                return [];
            } }) }
        });
        const simulator = new Simulator();
        let frames = 0;
        simulator._tick = () => { frames += 1; };
        try {
            const starting = simulator.start(() => {});
            await entered.promise;
            simulator.stop();
            release.resolve([]);
            await starting;
            assert.equal(simulator.pollTimer, null);
            assert.equal(frames, 0);
        } finally {
            simulator.stop();
        }
    });

    await check('DataEngine stop supersedes startup waiting for settings', async () => {
        const entered = deferred();
        const release = deferred();
        let starts = 0;
        class FakeSimulator {
            async start() { starts += 1; }
            stop() {}
        }
        const DataEngine = requireWithStubs('../services/dataEngine', {
            '../db/database': { getDb: async () => ({
                get: async () => ({ value: 'factory_default' }),
                all: async () => { entered.resolve(); return release.promise; }
            }) },
            '../services/simulator': FakeSimulator
        });
        const engine = new DataEngine({ broadcastStatus() {} });
        try {
            const starting = engine.start();
            await entered.promise;
            engine.stop();
            release.resolve([{ key: 'data_mode', value: 'simulation' }]);
            await starting;
            assert.equal(starts, 0);
            assert.equal(engine.currentMode, null);
            assert.equal(engine.simulator, null);
        } finally {
            engine.stop();
        }
    });

    await check('overlapping DataEngine restarts leave only one live source', async () => {
        let activeSources = 0;
        class FakeSimulator {
            async start() { this.active = true; activeSources += 1; }
            stop() { if (this.active) { this.active = false; activeSources -= 1; } }
        }
        const DataEngine = requireWithStubs('../services/dataEngine', {
            '../db/database': { getDb: async () => ({
                get: async () => ({ value: 'factory_default' }),
                all: async () => [{ key: 'data_mode', value: 'simulation' }]
            }) },
            '../services/simulator': FakeSimulator
        });
        const engine = new DataEngine({ broadcastStatus() {} });
        try {
            await Promise.all([engine.start(), engine.start()]);
            assert.equal(activeSources, 1);
            await Promise.all([engine.restart(), engine.restart()]);
            assert.equal(activeSources, 1);
            const restarting = engine.restart();
            engine.stop();
            await restarting;
            assert.equal(activeSources, 0);
        } finally {
            engine.stop();
        }
    });

    await check('alarm writes preserve transitions without duplicate concurrent events', async () => {
        const events = [];
        const DataEngine = requireWithStubs('../services/dataEngine', {
            '../db/database': {
                getDb: async () => ({
                    get: async () => ({ value: 'factory_default' }),
                    run: async (sql, values) => { await nextTurn(); events.push(values); }
                })
            }
        });
        const engine = new DataEngine({});
        const alarm = value => [{ furnace_id: 'alarm-device', status: { alarm: value }, quality: { status: { alarm: 'good' } } }];
        await Promise.all([engine._recordAlarmEvents(alarm(true)), engine._recordAlarmEvents(alarm(true)), engine._recordAlarmEvents(alarm(false))]);
        assert.deepEqual(events.map(event => event[6]), ['true', 'false']);
        engine.alarmState.set('alarm-device', true);
        await engine._recordAlarmEvents([{ furnace_id: 'alarm-device', status: { alarm: null }, quality: { status: { alarm: 'bad' } } }]);
        assert.equal(events.length, 2);
        assert.equal(engine.alarmState.get('alarm-device'), true);
        engine.stop();
    });

    await check('partial PLC frames aggregate metrics across every known device', async () => {
        const DataEngine = require('../services/dataEngine');
        const engine = new DataEngine({ broadcastDeviceData() {} });
        const samples = [];
        engine._recordMetrics = async devices => { samples.push(devices); };
        engine._recordAlarmEvents = async () => {};
        engine._publishRealtimeData([{ furnace_id: 'A', analog: { actual_temp: 100 } }]);
        engine._publishRealtimeData([{ furnace_id: 'B', analog: { actual_temp: 200 } }]);
        assert.equal(engine.collectorStatus.devices, 2);
        assert.deepEqual(samples[1].map(device => device.furnace_id), ['A', 'B']);
        engine.stop();
    });

    const PlcReader = require('../services/plcReader');
    const endpoint = { protocol: 'MODBUS_TCP', ip: '127.0.0.1', port: 1, timeout: 5000, retryInterval: 1000, maxRetries: 0, options: {} };

    await check('PlcReader stop cancels a pending configuration load', async () => {
        const release = deferred();
        const reader = new PlcReader();
        reader._loadDataPoints = async () => {
            await release.promise;
            reader._getOrCreateTask('pending-load', endpoint, 1000);
        };
        try {
            const starting = reader.start(() => {});
            reader.stop();
            release.resolve();
            await starting;
            assert.equal(reader.statusHeartbeatTimer, null);
        } finally {
            reader.stop();
        }
    });

    await check('late PLC driver connect is disconnected after stop', async () => {
        const entered = deferred();
        const release = deferred();
        let connected = false;
        const driver = {
            async connect() { entered.resolve(); await release.promise; connected = true; },
            async disconnect() { connected = false; },
            async read() { return {}; }
        };
        const reader = new PlcReader({ driverFactory: () => driver });
        reader.stopped = false;
        const task = reader._getOrCreateTask('late-connect', endpoint, 1000);
        try {
            reader._connectTask(task);
            await entered.promise;
            reader.stop();
            release.resolve();
            await nextTurn();
            assert.equal(connected, false);
        } finally {
            reader.stop();
        }
    });

    await check('stale PLC read callback cannot unlock a newer read', async () => {
        const release = deferred();
        const reader = new PlcReader();
        reader.stopped = false;
        const task = reader._getOrCreateTask('stale-read', endpoint, 1000);
        task.status = 'connected';
        task.driver = { read: () => release.promise, disconnect() {} };
        try {
            reader._readTask(task);
            await nextTurn();
            task.connectionGeneration += 1;
            task.reading = true;
            release.resolve({});
            await nextTurn();
            assert.equal(task.reading, true);
        } finally {
            reader.stop();
        }
    });

    await check('non-finite PLC numeric values are null with bad quality', async () => {
        const reader = new PlcReader();
        const point = { id: 'invalid-real', name: 'actual_temp', tagName: 'temp', data_type: 'REAL', category: 'analog' };
        for (const raw of [Infinity, -Infinity, NaN, 'not-a-number']) {
            const data = reader._assembleDeviceData('unit', { deviceName: 'Unit', points: [point] }, { temp: raw });
            assert.equal(data.analog.actual_temp, null);
            assert.equal(data.quality.analog.actual_temp, 'bad');
        }
    });

    await check('truncated Modbus BOOL register response is rejected', async () => {
        const { decodeModbusRegisters } = require('../services/plcProtocolDrivers');
        assert.throws(() => decodeModbusRegisters([], { type: 'BOOL', bit: null, registerCount: 1 }, { byteOrder: 'BE', wordOrder: 'BE' }), /Modbus|寄存器|数量/);
    });

    await check('Modbus disconnect cancels a connection that completes later', async () => {
        const { ModbusTcpDriver } = require('../services/plcProtocolDrivers');
        const entered = deferred();
        const release = deferred();
        let connected = false;
        class FakeModbus {
            setID() {}
            setTimeout() {}
            async connectTCP() { entered.resolve(); await release.promise; connected = true; }
            async close() { connected = false; }
        }
        const driver = new ModbusTcpDriver(endpoint, { modbusModule: FakeModbus });
        const starting = driver.connect().catch(error => error);
        await entered.promise;
        await driver.disconnect();
        release.resolve();
        assert.match((await starting).message, /取消/);
        assert.equal(connected, false);
    });

    await check('OPC UA disconnect cancels a late session and closes its client', async () => {
        const { OpcUaDriver } = require('../services/plcProtocolDrivers');
        const entered = deferred();
        const release = deferred();
        let openSession = false;
        let clientCloses = 0;
        const client = {
            async connect() {},
            async createSession() {
                entered.resolve();
                await release.promise;
                openSession = true;
                return { async close() { openSession = false; } };
            },
            async disconnect() { clientCloses += 1; }
        };
        const driver = new OpcUaDriver({ ...endpoint, protocol: 'OPC_UA', port: 4840 }, {
            opcuaModule: { OPCUAClient: { create: () => client }, MessageSecurityMode: { None: 1 }, SecurityPolicy: { None: 'none' }, UserTokenType: { Anonymous: 0 } }
        });
        const starting = driver.connect().catch(error => error);
        await entered.promise;
        await driver.disconnect();
        release.resolve();
        assert.match((await starting).message, /取消/);
        assert.equal(openSession, false);
        assert.equal(driver.session, null);
        assert.ok(clientCloses >= 2);
    });

    await check('PLC bounds and password normalization do not silently change valid secrets', async () => {
        const { parseModbusAddress, normalizePlcOptions } = require('../services/plcProtocolConfig');
        assert.throws(() => parseModbusAddress('HR105536', 'REAL', { addressBase: 1 }), /范围/);
        assert.equal(parseModbusAddress('HR105536', 'CHAR', { addressBase: 1 }).registerCount, 1);
        assert.equal(normalizePlcOptions('OPC_UA', { password: '  significant secret  ' }).password, '  significant secret  ');
    });

    const documents = require('../services/dashboardDocuments');
    await check('an explicit missing scene never falls back to or overwrites the active scene', async () => {
        const state = await documents.loadDesignerState(db);
        const before = await db.get('SELECT draft_revision FROM scenes WHERE id = ?', [state.scene.id]);
        assert.deepEqual(await documents.getProjectAndScene(db, 'scene-that-does-not-exist'), { project: null, scene: null });
        await assert.rejects(documents.saveDraft(db, { sceneId: 'scene-that-does-not-exist', document: state.document, expectedRevision: state.revision }), /场景不存在/);
        await assert.rejects(documents.publishDraft(db, { sceneId: 'scene-that-does-not-exist' }), /场景不存在/);
        assert.deepEqual(await db.get('SELECT draft_revision FROM scenes WHERE id = ?', [state.scene.id]), before);
    });

    await check('concurrent same-revision draft saves reject one writer instead of losing updates', async () => {
        const state = await documents.loadDesignerState(db);
        const release = deferred();
        let entered = 0;
        const racingDb = {
            ...db,
            async transaction(callback) {
                if (++entered === 2) release.resolve();
                await release.promise;
                return db.transaction(callback);
            }
        };
        const variants = ['first edit', 'second edit'].map(name => ({ ...structuredClone(state.document), name }));
        const attempts = await Promise.allSettled(variants.map(document => documents.saveDraft(racingDb, {
            sceneId: state.scene.id, document, expectedRevision: state.revision
        })));
        assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
        const rejected = attempts.find(attempt => attempt.status === 'rejected');
        assert.equal(rejected.reason.code, 'DRAFT_CONFLICT');
        assert.equal(rejected.reason.status, 409);
        assert.equal((await db.get('SELECT draft_revision FROM scenes WHERE id = ?', [state.scene.id])).draft_revision, state.revision + 1);
    });

    await check('saving a draft cannot steal a widget owned by a different scene', async () => {
        const state = await documents.loadDesignerState(db);
        const foreignScene = 'audit_foreign_scene';
        const foreignWidget = 'audit_foreign_widget';
        await db.run('INSERT INTO scenes (id, project_id, name, is_active) VALUES (?, ?, ?, ?)', [foreignScene, state.project.id, 'Foreign scene', 0]);
        await db.run('INSERT INTO widgets (id, scene_id, widget_type, title) VALUES (?, ?, ?, ?)', [foreignWidget, foreignScene, 'text', 'Foreign widget']);
        const document = structuredClone(state.document);
        assert.ok(document.widgets.length, 'seed dashboard has widgets');
        document.widgets.push({ ...structuredClone(document.widgets[0]), id: foreignWidget });
        await assert.rejects(documents.saveDraft(db, { sceneId: state.scene.id, document, expectedRevision: state.revision }), /其他场景/);
        assert.equal((await db.get('SELECT scene_id FROM widgets WHERE id = ?', [foreignWidget])).scene_id, foreignScene);
        assert.equal((await db.get('SELECT draft_revision FROM scenes WHERE id = ?', [state.scene.id])).draft_revision, state.revision);
    });

    async function inactiveRelease(id) {
        const state = await documents.loadDesignerState(db);
        await db.run(`INSERT INTO releases (id, project_id, scene_id, version, snapshot_json, is_current, schema_version, draft_revision)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, state.project.id, state.scene.id, id === 'audit_release_delete' ? '98.0.0' : '98.0.1', JSON.stringify(state.document), 0, 1, state.revision]);
        return state;
    }

    await check('release deletion cannot remove a release activated after its initial read', async () => {
        const id = 'audit_release_delete';
        const state = await inactiveRelease(id);
        const racingDb = {
            ...db,
            async run(sql, params) {
                if (/^DELETE FROM releases/.test(sql)) {
                    await db.run('UPDATE releases SET is_current = 0 WHERE project_id = ?', [state.project.id]);
                    await db.run('UPDATE releases SET is_current = 1 WHERE id = ?', [id]);
                }
                return db.run(sql, params);
            }
        };
        await assert.rejects(documents.deleteRelease(racingDb, id), /当前版本/);
        assert.equal((await db.get('SELECT is_current FROM releases WHERE id = ?', [id])).is_current, 1);
    });

    await check('release activation rolls back if its target was concurrently deleted', async () => {
        const id = 'audit_release_activate';
        const state = await inactiveRelease(id);
        const current = await db.get('SELECT id FROM releases WHERE project_id = ? AND is_current = 1', [state.project.id]);
        const racingDb = {
            ...db,
            async transaction(callback) {
                await db.run('DELETE FROM releases WHERE id = ?', [id]);
                return db.transaction(callback);
            }
        };
        await assert.rejects(documents.activateRelease(racingDb, id), /已被删除/);
        assert.deepEqual(await db.get('SELECT id FROM releases WHERE project_id = ? AND is_current = 1', [state.project.id]), current);
    });

    await check('database close waits for an active transaction and preserves its commit', async () => {
        const entered = deferred();
        const release = deferred();
        const transaction = db.transaction(async tx => {
            await tx.run('INSERT INTO audit_transactions (id, value) VALUES (?, ?)', ['closing', 7]);
            entered.resolve();
            await release.promise;
        });
        await entered.promise;
        const closing = database.closeDb();
        await nextTurn();
        assert.equal(database.getDbStatus().connected, true);
        release.resolve();
        await transaction;
        await closing;
        const reopened = await database.getDb();
        assert.equal((await reopened.get('SELECT value FROM audit_transactions WHERE id = ?', ['closing'])).value, 7);
    });

    await database.closeDb();
    const failures = results.filter(result => !result.passed);
    fs.writeFileSync(path.join(runDirectory, 'result.json'), JSON.stringify({ runDirectory, results }, null, 2));
    console.log(JSON.stringify({ tests: results.length, passed: results.length - failures.length, failed: failures.length, runDirectory }));
    process.exitCode = failures.length ? 1 : 0;
}

main().catch(async error => {
    console.error(error);
    try { await database.closeDb(); } catch (_) { /* keep original test failure */ }
    process.exitCode = 1;
});
