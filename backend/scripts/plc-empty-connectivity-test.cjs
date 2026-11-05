const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRunDirectory, createTestDatabase, waitUntil } = require('./integration-test-utils.cjs');
(async () => {
    const directory = createRunDirectory('plc-empty-connectivity');
    await createTestDatabase(path.join(directory, 'data/factory.db'));
    process.env.APP_DATA_DIR = path.join(directory, 'data'); process.env.UPLOADS_DIR = path.join(directory, 'uploads');
    const database = require('../db/database'); assert.equal(database.loadDatabaseConfig().type, 'sqlite');
    const failing = new Set([4102, 4203]), hung = new Set([4201]), connections = new Map(); let s7Reads = 0, registrations = 0, drops = 0;
    class FakeS7 {
        initiateConnection(endpoint, callback) { connections.set(endpoint.port, (connections.get(endpoint.port) || 0) + 1); queueMicrotask(() => callback(failing.has(endpoint.port) ? new Error('fixture refused') : null)); }
        setTranslationCB() { registrations++; } addItems() { registrations++; }
        readAllItems() { s7Reads++; throw new Error('No-point probe must never read PLC memory'); }
        dropConnection() { drops++; }
    }
    const s7Path = require.resolve('nodes7'), originalS7 = require(s7Path); require.cache[s7Path].exports = FakeS7;
    const PlcReader = require('../services/plcReader'); let reader;
    try {
        const db = await database.getDb(), line = await db.get('SELECT id FROM lines ORDER BY id LIMIT 1');
        await db.run('UPDATE devices SET plc_enabled=0');
        const devices = [
            ['s7_good', 'S7', 4101, 1, '127.0.0.1'], ['s7_peer', 'S7', 4101, 1, '127.0.0.1'],
            ['s7_bad', 'S7', 4102, 1, '127.0.0.1'], ['mb_hung', 'MODBUS_TCP', 4201, 1, '127.0.0.1'],
            ['mb_empty', 'MODBUS_TCP', 4202, 1, '127.0.0.1'], ['mb_read', 'MODBUS_TCP', 4202, 1, '127.0.0.1'],
            ['mb_invalid', 'MODBUS_TCP', 4203, 1, '127.0.0.1'], ['mb_write', 'MODBUS_TCP', 4202, 1, '127.0.0.1'],
            ['disabled', 'S7', 4104, 0, '127.0.0.1'], ['unconfigured', 'S7', 4105, 1, '']
        ];
        for (const [id, protocol, port, enabled, ip] of devices) await db.run('INSERT INTO devices (id,name,line_id,model_type,plc_enabled,plc_protocol,plc_ip,plc_port,plc_timeout,plc_retry_interval) VALUES (?,?,?,?,?,?,?,?,?,?)', [id, id, line.id, 'builtin_furnace', enabled, protocol, ip, port, 1000, 1000]);
        let pointIndex = 0;
        const addPoint = (id, address, access = 'READ') => db.run('INSERT INTO data_points (device_id,name,label,category,data_type,plc_tag,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?)', [id, 'test_' + ++pointIndex, '测试点位', 'analog', 'WORD', address, access, 100]);
        await addPoint('mb_read', 'HR40001'); await addPoint('mb_invalid', 'invalid'); await addPoint('mb_write', 'HR40001', 'WRITE');
        const frames = [];
        reader = new PlcReader({ driverFactory(endpoint) { return {
            async connect() { connections.set(endpoint.port, (connections.get(endpoint.port) || 0) + 1); if (hung.has(endpoint.port)) await new Promise(() => {}); if (failing.has(endpoint.port)) throw new Error('fixture refused'); },
            async read(points) { assert.ok(points.length > 0); return Object.fromEntries(points.map(p => [p.tagName, 10])); },
            async disconnect() { drops++; }
        } } });
        await reader.start(batch => frames.push(...batch));
        await waitUntil(() => reader.deviceStatus.get('mb_read').status === 'connected' && reader.deviceStatus.get('s7_good').status === 'no_points', 2000, 'healthy read and no-point handshake');
        assert.equal(reader.deviceStatus.get('mb_hung').status, 'connecting', 'hung endpoint must not block healthy endpoint');
        await waitUntil(() => reader.deviceStatus.get('mb_hung').status === 'offline', 3000, 'bounded failed connection');
        for (const id of ['s7_bad', 'mb_hung', 'mb_invalid']) assert.equal(reader.deviceStatus.get(id).status, 'offline', id);
        for (const id of ['s7_good', 's7_peer', 'mb_empty', 'mb_write']) {
            const status = reader.deviceStatus.get(id); assert.equal(status.status, 'no_points', id); assert.ok(status.lastConnectedAt); assert.equal(status.lastReadAt, null); assert.equal(reader.latestSnapshots.has(id), false);
        }
        assert.equal(reader.deviceStatus.get('disabled').status, 'disabled'); assert.equal(reader.deviceStatus.get('unconfigured').status, 'unconfigured');
        assert.equal(reader.tasks.size, 5); assert.equal(connections.get(4101), 1, 'same empty PLC shares one probe'); assert.equal(connections.get(4202), 1, 'empty device shares existing polling connection');
        assert.equal(s7Reads, 0); assert.equal(registrations, 0); assert.ok(frames.every(f => f.furnace_id === 'mb_read'));
        failing.delete(4102); const badTask = [...reader.tasks.values()].find(t => t.endpoint.port === 4102); reader._connectTask(badTask);
        await waitUntil(() => reader.deviceStatus.get('s7_bad').status === 'no_points', 1000, 'no-point connection recovers');
        failing.add(4101); reader._connectTask([...reader.tasks.values()].find(t => t.endpoint.port === 4101));
        await waitUntil(() => reader.deviceStatus.get('s7_good').status === 'offline', 1000, 'previously reachable empty PLC goes offline');
        assert.equal(reader.deviceStatus.get('mb_read').status, 'connected');
        failing.delete(4203); await addPoint('mb_invalid', 'HR40001'); await reader.reloadConfiguration();
        await waitUntil(() => reader.deviceStatus.get('mb_invalid').status === 'connected', 1000, 'adding valid points replaces connection-only probe');
        await db.run('DELETE FROM data_points WHERE device_id=?', ['mb_invalid']); await reader.reloadConfiguration();
        await waitUntil(() => reader.deviceStatus.get('mb_invalid').status === 'no_points', 1000, 'removing all points returns to connection checks');
        assert.equal(reader.deviceStatus.get('mb_invalid').lastReadAt, null); assert.equal(reader.latestSnapshots.has('mb_invalid'), false);
        reader.stop(); assert.ok([...reader.tasks.values()].every(t => !t.timer && !t.connectTimer && !t.retryTimer && !t.conn && !t.driver));
        const result = { success: true, checks: ['S7/Modbus no-point offline detection', 'no dummy tags/reads or empty data frames', 'connection sharing', 'hung-device isolation', 'disconnect and recovery', 'point add/remove reload', 'all timers and connections stop'], directory, realSitePlcValidated: false };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
    } finally { reader?.stop(); require.cache[s7Path].exports = originalS7; await database.closeDb(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
