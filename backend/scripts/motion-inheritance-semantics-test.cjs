'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const { deriveMotionSemantics, semanticState, validSnapshot, hasDeclaredMotionBoundary } = require('../../shared/motionSemanticPolicy.cjs');
const { MotionSemanticResolver } = require('../services/motionSemantics');
const { WsOutboundQueue } = require('../utils/wsOutboundQueue');
const directory = createRunDirectory('motion-inheritance-semantics'), checks = [], fixtures = [];
const check = (name, fn) => { fn(); checks.push(name); console.log('PASS ' + name); };
const ownPoint = { id: 41, device_id: 'owned', category: 'motors', value_role: 'rpm', name: 'rpm', access_type: 'READ' };
const part = { id: 'fan', action: 'rotate_speed', source_group: 'motors', source_key: 'rpm', point_id: '41', speed_factor: -.25, invert: true };
const derive = (instance, binding = part, points = [ownPoint]) => deriveMotionSemantics(instance, { partBindings: [binding] }, { deviceId: 'owned', points });
const raw = (id, point, value, timestamp) => ({ furnace_id: id, factoryId: 'factory_default', timestamp,
    motors: { rpm: value }, status: { online: true }, quality: { motors: { rpm: 'good' } },
    pointMeta: { 'motors.rpm': { id: String(point), category: 'motors', field_name: 'rpm', timestamp } } });
check('missing instance token inherits exact model PointId, raw RPM and legacy non-inverted factor', () => {
    const definition = derive({}); assert.equal(definition.valid, true); assert.equal(definition.bindings.length, 1);
    const binding = definition.bindings[0];
    assert.deepEqual(binding, { key: 'action:part:fan', kind: 'signed_speed', source: { pointId: '41', pointKey: 'motors.rpm' }, speedFactor: -.25, speed: 1, invert: false });
    assert.equal(semanticState(raw('owned', 41, 10, 1000), binding), 'negative');
    assert.equal(semanticState(raw('owned', 41, -10, 1001), binding), 'positive');
});
check('model group/key inheritance resolves only one owned READ point with DTO defaults', () => {
    const definition = derive({}, { source_key: 'rpm' }, [{ ...ownPoint, category: 'analog' }]);
    assert.equal(definition.valid, true); assert.equal(definition.bindings[0].key, 'action:part:0');
    assert.equal(definition.bindings[0].source.pointKey, 'analog.rpm');
    assert.equal(definition.bindings[0].speedFactor, Math.fround(.10472));
});
check('foreign explicit ID, foreign owner, WRITE source and ambiguous or mismatched address cannot be guessed', () => {
    for (const definition of [derive({}, { ...part, point_id: '42' }), derive({}, part, [{ ...ownPoint, device_id: 'foreign' }]),
        derive({}, part, [{ ...ownPoint, access_type: 'WRITE' }]), derive({}, part, [ownPoint, { ...ownPoint, id: 42 }]),
        derive({}, { ...part, source_group: 'analog' }), derive({}, { ...part, source_key: 'other' })]) {
        assert.equal(definition.valid, false); assert.deepEqual(definition.bindings, []);
    }
});
check('explicit empty, missing bindings array and disabled configurations suppress all model inheritance', () => {
    for (const config of [{}, { bindings: [] }, { bindings: [{ actionId: 'part:fan', enabled: false }] }]) {
        const definition = derive({ animationBindings: config }, { ...part, point_id: 'foreign' });
        assert.equal(definition.valid, true); assert.deepEqual(definition.bindings, []);
    }
});
check('active instance source overrides the inherited source and uses explicit runtime speed/inversion', () => {
    const definition = derive({ animationBindings: { bindings: [{ actionId: 'part:fan', enabled: true, mode: 'running',
        pointId: '42', sourceGroup: 'mechanisms', sourceKey: 'feed', speed: 2, invert: true }] } }, { ...part, point_id: 'foreign' });
    assert.equal(definition.valid, true);
    assert.deepEqual(definition.bindings[0].source, { pointId: '42', pointKey: 'mechanisms.feed' });
    assert.equal(definition.bindings[0].speed, 2); assert.equal(definition.bindings[0].invert, true);
});
check('explicit JSON null and malformed non-object tokens are barriers, matching actual Native JValue access', () => {
    for (const config of [null, false, '', []]) assert.equal(derive({ animationBindings: config }).valid, false);
});
class HeldSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.callbacks = []; }
    send(text, callback) { this.sent.push(JSON.parse(text)); this.callbacks.push(callback); }
    close(code) { this.readyState = 2; this.closeCode = code; }
    terminate() { this.readyState = 3; }
    flush() { this.callbacks.shift()?.(); }
}
let closeDb, resolver, hub;
(async () => {
    const file = path.join(directory, 'factory.db'); await createTestDatabase(file);
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: file });
    for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) delete process.env[key];
    const database = require('../db/database'); closeDb = database.closeDb; const db = await database.getDb();
    const line = await db.get('SELECT l.id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1', ['factory_default']);
    const device = async (id, model, config) => db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)', [id, id, line.id, model, JSON.stringify(config)]);
    const point = async (id, access = 'READ') => {
        await db.run('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type) VALUES (?,?,?,?,?,?,?,?)', [id, 'rpm', 'RPM', 'DB1.DBD0', 'REAL', 'motors', 'rpm', access]);
        return String((await db.get('SELECT id FROM data_points WHERE device_id=? ORDER BY id DESC LIMIT 1', [id])).id);
    };
    for (const [id, model, config] of [['inherit_owned', 'inherit_explicit_model', {}], ['inherit_keyed', 'inherit_keyed_model', {}],
        ['inherit_empty', 'inherit_explicit_model', { animationBindings: { bindings: [] } }],
        ['inherit_disabled', 'inherit_explicit_model', { animationBindings: { bindings: [{ actionId: 'part:fan', enabled: false }] } }],
        ['inherit_foreign', 'inherit_explicit_model', {}], ['inherit_ambiguous', 'inherit_keyed_model', {}], ['inherit_write', 'inherit_keyed_model', {}]])
        await device(id, model, config);
    const ids = { owned: await point('inherit_owned'), keyed: await point('inherit_keyed'), foreign: await point('inherit_foreign'),
        ambiguous: await point('inherit_ambiguous'), write: await point('inherit_write', 'WRITE') };
    await point('inherit_ambiguous');
    const model = async (id, binding) => db.run('INSERT INTO models (id,name,file_path,metadata,asset_type,placement_level) VALUES (?,?,?,?,?,?)',
        [id, id, '', JSON.stringify({ partBindings: [binding] }), 'model', 'device']);
    await model('inherit_explicit_model', { ...part, point_id: ids.owned, speed_factor: .10472 });
    const keyed = { ...part, speed_factor: .10472 }; delete keyed.point_id; await model('inherit_keyed_model', keyed);
    const reads = { all: 0, get: 0, points: 0, writes: 0 };
    const readonly = {
        all: async (sql, args) => { reads.all++; if (/FROM data_points\b/.test(sql)) reads.points++; return db.all(sql, args); },
        get: async (sql, args) => { reads.get++; return db.get(sql, args); },
        run: async () => { reads.writes++; throw Error('Resolver must be readonly'); }
    };
    resolver = new MotionSemanticResolver({ getDb: async () => readonly, reloadMs: 60000 }); assert.equal(await resolver.refresh(), true);
    const decorated = (id, pid, value, timestamp = 1000) => resolver.decorate([raw(id, pid, value, timestamp)])[0];
    check('actual SQL snapshot batch resolves owned explicit and group/key inherited speed once', () => {
        for (const [id, pid] of [['inherit_owned', ids.owned], ['inherit_keyed', ids.keyed]]) {
            const frame = decorated(id, pid, 10); assert.equal(frame.motionSemantics.ready, true); assert.equal(validSnapshot(frame.motionSemantics), true);
            assert.equal(frame.motionSemantics.bindings[0].source.pointId, pid); assert.equal(frame.motionSemantics.bindings[0].kind, 'signed_speed');
            assert.equal(semanticState(frame, frame.motionSemantics.bindings[0]), 'positive');
        }
        assert.equal(reads.all, 5); assert.equal(reads.points, 1); assert.equal(reads.writes, 0);
    });
    check('actual SQL foreign model PointId, duplicate path and WRITE point fail closed', () => {
        for (const [id, pid] of [['inherit_foreign', ids.foreign], ['inherit_ambiguous', ids.ambiguous], ['inherit_write', ids.write]]) {
            const frame = decorated(id, pid, 10); assert.equal(frame.motionSemantics.ready, false); assert.deepEqual(frame.motionSemantics.bindings, []);
        }
    });
    const peer = new HeldSocket(), pressure = new WsOutboundQueue(peer); pressure.enqueue({ type: 'welcome' });
    const beforeReads = { ...reads }, started = performance.now();
    for (let index = 0; index < 5000; index++) assert.ok(pressure.enqueue({ type: 'realtime_frame', payload: { devices: [decorated('inherit_owned', ids.owned, index + 1, 2000 + index)] } }));
    const processingMs = performance.now() - started;
    check('5000 inherited same-direction RPM samples keep exact latest without another DB read or metadata merge', () => {
        assert.equal(pressure.queue.length, 1); assert.deepEqual(reads, beforeReads);
        const latest = pressure.queue[0].message.payload.devices[0]; assert.equal(latest.motors.rpm, 5000); assert.equal(latest.pointMeta['motors.rpm'].timestamp, 6999);
        assert.equal(resolver.stats.pointCatalogReads, 1);
    }); pressure.dispose();
    const { MotionInputResolver } = require('../services/motionInputs'), WsServer = require('../services/wsServer');
    const motion = new MotionInputResolver({ getDb: async () => readonly, semanticResolver: resolver, reloadMs: 60000 });
    hub = new WsServer(); hub.setMotionInputResolver(motion);
    let captured = []; const send = hub.send.bind(hub);
    hub.send = (socket, message, serialized) => { if (message.type === 'realtime_frame') captured.push(structuredClone(message)); return send(socket, message, serialized); };
    let timestamp = 10000;
    const transport = (name, id, pid, values, expected) => {
        const socket = new HeldSocket(); captured = []; hub.clients.add(socket); hub.send(socket, { type: 'welcome' });
        for (const value of values) hub.broadcastDeviceData([raw(id, pid, value, timestamp++)]);
        while (socket.callbacks.length) socket.flush();
        const messages = socket.sent.filter(message => message.type === 'realtime_frame');
        check(name, () => { assert.deepEqual(messages.map(message => message.payload.devices[0].motors.rpm), expected);
            for (const message of messages) { const frame = message.payload.devices[0]; assert.equal(frame.pointMeta['motors.rpm'].timestamp, frame.timestamp); assert.equal(frame.quality.motors.rpm, 'good'); } });
        fixtures.push({ name, messages: captured, expected: messages }); hub.clients.delete(socket); hub.outbound.get(socket)?.dispose(); hub.outbound.delete(socket);
    };
    transport('actual resolver to WsServer preserves inherited stop/run/stop', 'inherit_owned', ids.owned, [0, 10, 0], [0, 10, 0]);
    transport('actual resolver to WsServer preserves inherited positive/reverse/stop', 'inherit_owned', ids.owned, [10, -10, 0], [10, -10, 0]);
    transport('actual resolver to WsServer keeps inherited same-direction exact latest', 'inherit_owned', ids.owned, [1, 2, 30], [30]);
    transport('actual resolver to WsServer preserves unique group/key inherited gate', 'inherit_keyed', ids.keyed, [0, 10, 0], [0, 10, 0]);
    transport('explicit empty config never revives model RPM actions', 'inherit_empty', ids.owned, [0, 10, 0], [0]);
    transport('explicit disabled config never revives model RPM actions', 'inherit_disabled', ids.owned, [0, 10, 0], [0]);
    transport('unresolved foreign inherited ownership remains a bounded barrier', 'inherit_foreign', ids.foreign, [0, 10, 0], [0, 10, 0]);
    const old = decorated('inherit_owned', ids.owned, 10, timestamp++);
    await db.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify({ animationBindings: { bindings: [] } }), 'inherit_owned']);
    resolver.invalidate('device_configuration_changed', { deviceId: 'inherit_owned' });
    const pending = decorated('inherit_owned', ids.owned, 10, timestamp++); await resolver.refresh();
    const unloaded = decorated('inherit_owned', ids.owned, 10, timestamp++);
    check('saved empty config unloads inherited RPM without stale declaration union after refresh', () => {
        assert.equal(pending.motionSemantics.ready, false); assert.equal(unloaded.motionSemantics.ready, true); assert.deepEqual(unloaded.motionSemantics.bindings, []);
        assert.ok(hasDeclaredMotionBoundary(old, pending)); assert.ok(hasDeclaredMotionBoundary(old, unloaded));
        assert.equal(reads.writes, 0); assert.equal(reads.points, 2);
    });
    fs.writeFileSync(path.join(directory, 'native-inherited-fixtures.json'), JSON.stringify({ cases: fixtures }, null, 2));
    const report = { success: true, checks, nativeFixtures: fixtures.length, pressure: { frames: 5000, processingMs, queueSnapshots: 1,
        latestSourceTimestamp: 6999, measuredPlcOrGpuLatency: false }, reads, browserOperations: 0, liveConfigurationWrites: 0,
        realSqlSnapshot: true, realMotionInputResolverWsServerQueue: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ success: true, checks: checks.length, nativeFixtures: fixtures.length, directory, processingMs }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => { hub?.close(); resolver?.dispose(); await closeDb?.(); });
