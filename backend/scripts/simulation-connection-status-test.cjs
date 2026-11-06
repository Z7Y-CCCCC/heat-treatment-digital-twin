'use strict';
// Pure status/state fixtures and the actual Simulator with a stub database.
// Never opens a commissioned database or starts a PLC/socket/child process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('simulation-connection-status');
process.env.NODE_ENV = 'test';
process.env.APP_DATA_DIR = path.join(directory, 'data');
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_FILE = path.join(process.env.APP_DATA_DIR, 'factory.db');
delete process.env.SQLITE_RECOVERY_TEMPLATE;
delete process.env.SQLITE_UPGRADE_TEMPLATE;
const DataEngine = require('../services/dataEngine');
const CollectorProcess = require('../services/collectorProcess');
const checks = [];
const now = Date.now();
function fixture(ids = ['a', 'b']) {
    const engine = new DataEngine({ broadcastDeviceData() {}, broadcastStatus() {} });
    engine.currentMode = 'simulation'; engine.activeFactoryId = 'factory_a';
    engine.simulator = { devices: ids.map(id => ({ id, name: `设备 ${id}`, plc_ip: 'PRIVATE', password: 'SECRET' })), stopped: false, pollIntervalMs: 2000, stop() { this.stopped = true; } };
    engine.plcStatus = { status: 'simulating' }; engine.collectorStatus = { status: 'connected', devices: ids.length };
    return engine;
}
function frame(id, patch = {}) {
    return { furnace_id: id, timestamp: now, status: { running: false, alarm: true }, quality: { analog: { temp: 'good' }, status: { running: 'good', alarm: 'good' } }, ...patch };
}
async function check(name, callback) { await callback(); checks.push(name); console.log('PASS ' + name); }
function stubRequire(filename, stubs) {
    const originals = new Map(), target = require.resolve(filename), previous = require.cache[target];
    for (const [dependency, exports] of Object.entries(stubs)) {
        const id = require.resolve(dependency); originals.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    delete require.cache[target];
    try { return require(target); }
    finally {
        if (previous) require.cache[target] = previous; else delete require.cache[target];
        for (const [id, previous] of originals) { if (previous) require.cache[id] = previous; else delete require.cache[id]; }
    }
}
(async () => {
    await check('fresh configured simulator frames identify devices, not process count or equipment running/alarm', () => {
        const engine = fixture(); engine.deviceSnapshots = new Map([['a', frame('a')], ['b', frame('b')]]);
        const status = engine.getStatus();
        assert.equal(status.configuredDevices, 2);
        assert.deepEqual(status.plcStatus.devices.map(row => [row.deviceId, row.deviceName, row.status, row.quality]), [['a', '设备 a', 'connected', 'good'], ['b', '设备 b', 'connected', 'good']]);
        assert.ok(status.plcStatus.devices.every(row => row.freshnessMs === 6000 && row.lastReadAt === now));
        assert.equal(engine.plcStatus.devices, undefined, 'query must not mutate broadcast status');
        assert.doesNotMatch(JSON.stringify(status), /PRIVATE|SECRET|plc_ip|password/);
    });
    await check('missing frames never infer which configured device is online from the aggregate count', () => {
        const engine = fixture(); engine.deviceSnapshots.set('a', frame('a')); engine.collectorStatus.devices = 2;
        assert.deepEqual(engine.getStatus().plcStatus.devices.map(row => row.status), ['connected', 'starting']);
        engine.deviceSnapshots.clear(); assert.ok(engine.getStatus().plcStatus.devices.every(row => row.status !== 'connected'));
    });
    await check('wrong-device snapshots and unconfigured snapshots cannot mark configured devices online', () => {
        const engine = fixture(); engine.deviceSnapshots.set('a', frame('foreign')); engine.deviceSnapshots.set('foreign', frame('foreign'));
        assert.deepEqual(engine.getStatus().plcStatus.devices.map(row => row.deviceId), ['a', 'b']);
        assert.ok(engine.getStatus().plcStatus.devices.every(row => row.lastReadAt === null && row.status === 'starting'));
    });
    await check('stale, future, malformed and explicit stale quality frames are never connected', () => {
        for (const patch of [{ timestamp: now - 10000 }, { timestamp: now + 60000 }, { timestamp: 'invalid' }, { quality: { analog: { temp: 'stale' } } }]) {
            const engine = fixture(['a']); engine.deviceSnapshots.set('a', frame('a', patch));
            assert.notEqual(engine.getStatus().plcStatus.devices[0].status, 'connected');
        }
    });
    await check('bad and unknown quality are not hidden by otherwise good process status', () => {
        const engine = fixture(['a']);
        for (const [patch, expected] of [[{ quality: { analog: { temp: 'bad', other: 'unknown' } } }, 'error'], [{ status: { online: false } }, 'error'], [{ quality: {} }, 'starting'], [{ quality: { analog: { temp: 'unknown' } } }, 'starting']]) {
            engine.deviceSnapshots.set('a', frame('a', patch)); assert.equal(engine.getStatus().plcStatus.devices[0].status, expected);
        }
    });
    await check('configured slow simulation interval determines the freshness window, not a fixed six seconds', () => {
        const engine = fixture(['a']); engine.simulator.pollIntervalMs = 60000; engine.deviceSnapshots.set('a', frame('a', { timestamp: now - 90000 }));
        assert.equal(engine.getStatus().plcStatus.devices[0].status, 'connected'); assert.equal(engine.getStatus().plcStatus.devices[0].freshnessMs, 180000);
        engine.deviceSnapshots.get('a').timestamp = now - 200000; assert.equal(engine.getStatus().plcStatus.devices[0].status, 'stale');
    });
    await check('stop, collector failure and simulator stop override stored fresh frames', async () => {
        const engine = fixture(['a']); engine.deviceSnapshots.set('a', frame('a')); engine.plcStatus.status = 'error';
        assert.equal(engine.getStatus().plcStatus.devices[0].status, 'error'); engine.plcStatus.status = 'simulating'; engine.collectorStatus.status = 'error';
        assert.equal(engine.getStatus().plcStatus.devices[0].status, 'error'); engine.collectorStatus.status = 'connected'; engine.simulator.stopped = true;
        assert.equal(engine.getStatus().plcStatus.devices[0].status, 'stopped'); await engine.stop();
        assert.equal(engine.getStatus().mode, null); assert.equal(engine.getStatus().plcStatus.status, 'stopped'); assert.equal(engine.deviceSnapshots.size, 0);
    });
    await check('zero configured devices and duplicate/blank identifiers produce no invented or duplicated rows', () => {
        const engine = fixture([]); assert.equal(engine.getStatus().configuredDevices, 0); assert.deepEqual(engine.getStatus().plcStatus.devices, []);
        engine.simulator.devices = [{ id: 'a', name: 'A' }, { id: 'a', name: 'duplicate' }, { id: '' }];
        assert.equal(engine.getStatus().configuredDevices, 1); assert.deepEqual(engine.getStatus().plcStatus.devices.map(row => row.deviceName), ['A']);
    });
    await check('real PLC and external modes retain their existing status source', () => {
        const engine = fixture(); engine.currentMode = 'integrated_plc'; engine.plcReader = { deviceStatus: new Map([['real', {}]]) };
        engine.plcStatus = { status: 'connected', devices: [{ deviceId: 'real', status: 'connected' }] };
        assert.equal(engine.getStatus().plcStatus, engine.plcStatus); assert.equal(engine.getStatus().configuredDevices, 1);
        engine.currentMode = 'external'; engine.plcReader = null; assert.equal(engine.getStatus().plcStatus, engine.plcStatus);
    });
    await check('factory statuses and CollectorProcess facade preserve scoped rows and invalidate them when worker goes offline', () => {
        const engine = fixture(['a']), secondary = fixture(['b']); secondary.activeFactoryId = 'factory_b';
        engine.deviceSnapshots.set('a', frame('a')); secondary.deviceSnapshots.set('b', frame('b')); engine.factoryEngines.set('factory_b', secondary);
        const states = engine.getFactoryStatuses(); assert.deepEqual(states.factory_a.plcStatus.devices.map(row => row.deviceId), ['a']); assert.deepEqual(states.factory_b.plcStatus.devices.map(row => row.deviceId), ['b']);
        const facade = new CollectorProcess({ broadcastDeviceData() {}, broadcastStatus() {} }); facade.state = engine.getStatus(); facade.factories = states;
        assert.equal(facade.getStatus().plcStatus.devices[0].status, 'connected'); assert.equal(facade.getFactoryStatuses().factory_b.plcStatus.devices[0].status, 'connected');
        facade._offline('recovering', 'fixture'); assert.equal(facade.getStatus().plcStatus.status, 'error'); assert.equal(facade.getFactoryStatuses().factory_b.plcStatus.devices, undefined);
    });
    await check('actual Simulator start retains its per-factory interval and produces identifiable fresh rows without DB access', async () => {
        const Simulator = stubRequire('../services/simulator', { '../db/database': { getDb: async () => ({ all: async sql => {
            if (sql.startsWith('SELECT id FROM workshops')) return [{ id: 'w' }];
            if (sql.startsWith('SELECT l.id')) return [{ id: 'l' }];
            if (sql === 'SELECT * FROM devices') return [{ id: 'a', name: 'A', line_id: 'l' }];
            if (sql === 'SELECT * FROM settings') return [{ key: 'simulation_interval_ms', value: '60000' }];
            return [{ key: 'simulation_interval_ms', value: '10000' }];
        } }) } });
        const engine = fixture(['a']), simulator = new Simulator({ factoryId: 'factory_a' }); engine.simulator = simulator;
        try {
            await simulator.start(rows => rows.forEach(row => engine.deviceSnapshots.set(row.furnace_id, row)), status => engine.plcStatus = status);
            assert.equal(simulator.pollIntervalMs, 10000); assert.equal(engine.getStatus().plcStatus.devices[0].status, 'connected');
            assert.equal(engine.getStatus().plcStatus.devices[0].freshnessMs, 30000);
        } finally { simulator.stop(); }
        assert.equal(engine.getStatus().plcStatus.devices[0].status, 'stopped');
    });
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, checks }, null, 2));
    console.log(`PASS ${checks.length}/${checks.length} checks; REPORT ${directory}`);
})().catch(error => { fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: false, checks, failure: error.stack }, null, 2)); console.error(error); process.exitCode = 1; });
