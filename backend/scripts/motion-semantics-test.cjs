'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const { deriveMotionSemantics, hasDeclaredMotionBoundary, semanticState, validSnapshot } = require('../../shared/motionSemanticPolicy.cjs');
const { MotionSemanticResolver } = require('../services/motionSemantics');
const { WsOutboundQueue } = require('../utils/wsOutboundQueue');
const directory = createRunDirectory('motion-semantics');
const results = [];
const check = (name, run) => { run(); results.push(name); console.log('PASS ' + name); };
class HeldSocket {
    constructor() { this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.callbacks = []; }
    send(text, callback) { this.sent.push(JSON.parse(text)); this.callbacks.push(callback); }
    close(code) { this.readyState = 2; this.closeCode = code; }
    terminate() { this.readyState = 3; }
    flush() { this.callbacks.shift()?.(); }
}
const instance = {
    movement: { enabled: true, currentPositionPointId: '1245', startActionPointId: '603', valueMode: 'range' },
    animationBindings: { bindings: [{ actionId: 'feed', enabled: true, mode: 'position', pointId: '1242', sourceGroup: 'mechanisms', sourceKey: 'feed',
        trigger: { mode: 'condition', operator: 'gt', value: 50, hysteresis: 5 }, inputMin: 0, inputMax: 100, invert: false }] }
};
const rawFrame = (gate, feed = 20, stamp = 1000) => ({ furnace_id: 'semantic_cart', factoryId: 'factory_default', timestamp: stamp,
    analog: { start_word: gate, position: 10 }, mechanisms: { feed }, status: { online: true },
    quality: { analog: { start_word: 'good', position: 'good' }, mechanisms: { feed: 'good' } },
    pointMeta: { 'analog.start_word': { id: '603', timestamp: stamp, category: 'analog', field_name: 'start_word' },
        'analog.position': { id: '1245', timestamp: stamp, category: 'analog', field_name: 'position' },
        'mechanisms.feed': { id: '1242', timestamp: stamp, category: 'mechanisms', field_name: 'feed' } } });
const snapshot = bindings => ({ version: 1, ready: true, generation: 1, revision: 'r1', factoryId: 'factory_default', bindings });
const declaration = deriveMotionSemantics(instance).bindings.find(row => row.kind === 'condition');
const conditionFrame = value => ({ timestamp: 1000, motionInputs: { feed: { dataItemId: 'point:feed', value, timestamp: 1000, quality: 'good' } } });
const catalogDeclaration = { ...declaration, source: { actionId: 'feed', dataItemId: 'point:feed' } };
const speedRow = { actionId: 'part:fan', kind: 'part', enabled: true, mode: 'running', pointId: '1242', sourceGroup: 'mechanisms', sourceKey: 'feed',
    trigger: { mode: 'range' }, inputMin: 0, inputMax: 1000, speed: 2, invert: true };
const speedInstance = { animationBindings: { bindings: [speedRow] } };
const speedMetadata = { partBindings: [{ id: 'fan', action: 'rotate_speed', speed_factor: -.25 }] };
function evaluate(value, policy, previous) {
    const h = previous ? ['gt', 'gte'].includes(policy.operator) ? -policy.hysteresis : policy.hysteresis : 0;
    const t = policy.value + h;
    return policy.operator === 'gt' ? value > t : policy.operator === 'gte' ? value >= t : policy.operator === 'lt' ? value < t : value <= t;
}
check('only saved active motion sources declare numeric semantics', () => {
    assert.deepEqual(deriveMotionSemantics(instance).bindings.map(row => row.kind), ['running_gate', 'condition']);
    assert.deepEqual(deriveMotionSemantics({ animationBindings: { bindings: [{ ...instance.animationBindings.bindings[0], trigger: { mode: 'range' } }] } }).bindings, []);
    assert.deepEqual(deriveMotionSemantics({ movement: { enabled: false, startActionPointId: '603' }, animationBindings: { bindings: [{ ...instance.animationBindings.bindings[0], enabled: false }] } }).bindings, []);
    const alias = deriveMotionSemantics({ movement: { enabled: true, start_action_point_id: '603' } });
    assert.equal(alias.bindings[0].source.pointId, '603');
    assert.deepEqual(deriveMotionSemantics({ movement: { enabled: true, startActionPointId: '', start_action_point_id: '603' } }).bindings, [], 'canonical empty ID does not reactivate a historical alias');
});
check('running gate exactly retains negative/nonzero and .0001 stop semantics', () => {
    const gate = deriveMotionSemantics(instance).bindings[0];
    for (const [value, expected] of [[0, 'stopped'], [.0001, 'stopped'], [-.0001, 'stopped'], [-.00011, 'running'], [1, 'running'], [-3, 'running'], ['1', 'running'], ['OFF', 'stopped'], [' true ', 'invalid']])
        assert.equal(semanticState(rawFrame(value), gate), expected, String(value));
});
check('both hysteresis outcomes preserve consumer transitions without retaining same-state noise', () => {
    for (const operator of ['gt', 'gte', 'lt', 'lte']) for (const hysteresis of [0, 5, 25]) {
        const policy = { ...catalogDeclaration, operator, hysteresis };
        const values = [0, 50, 51, 49, 48, 47, 46, 45, 44, 60, 55, 54, 53, 52, 51, 50, 40, 20, 0];
        const kept = [];
        for (const value of values) {
            const prior = kept.at(-1);
            if (prior !== undefined && semanticState(conditionFrame(prior), policy) === semanticState(conditionFrame(value), policy)) kept[kept.length - 1] = value;
            else kept.push(value);
        }
        assert.ok(kept.length < values.length);
        for (const initial of [false, true]) {
            const history = list => { let state = initial; const output = []; for (const value of list) { state = evaluate(value, policy, state); if (output.at(-1) !== state) output.push(state); } return output; };
            assert.deepEqual(history(kept), history(values), operator + '/' + hysteresis + '/' + initial);
        }
    }
});
check('malformed and duplicate declarations fail closed; equality never coerces numeric text', () => {
    const valid = snapshot([catalogDeclaration]); assert.equal(validSnapshot(valid), true);
    assert.equal(semanticState(conditionFrame('50'), catalogDeclaration), 'invalid');
    for (const bad of [{ ...valid, bindings: [catalogDeclaration, catalogDeclaration] }, { ...valid, ready: false },
        { ...valid, bindings: [{ ...catalogDeclaration, hysteresis: '5' }] }, { ...valid, bindings: [{ ...catalogDeclaration, source: { pointId: 603 } }] },
        { ...valid, bindings: [{ ...catalogDeclaration, kind: 'guessed_numeric_bool' }] }]) {
        assert.equal(validSnapshot(bad), false); assert.equal(hasDeclaredMotionBoundary({ motionSemantics: bad }, { motionSemantics: bad }), true);
    }
    assert.equal(deriveMotionSemantics({ animationBindings: { bindings: [instance.animationBindings.bindings[0], instance.animationBindings.bindings[0]] } }).valid, false);
});
check('part RPM follows actual float32 scale/inversion/zero instead of the clip midpoint', () => {
    const derive = metadata => deriveMotionSemantics(speedInstance, metadata).bindings[0];
    const speed = derive(speedMetadata);
    assert.equal(speed.kind, 'signed_speed'); assert.equal(speed.speedFactor, -.25);
    for (const [value, expected] of [[0, 'stopped'], [1, 'positive'], [100, 'positive'], [-1, 'negative'], [-100, 'negative']])
        assert.equal(semanticState(rawFrame(0, value), speed), expected);
    const zero = derive({ partBindings: [{ id: 'fan', action: 'rotate_speed', speed_factor: 0 }] });
    assert.equal(semanticState(rawFrame(0, 1000), zero), 'stopped');
    const tiny = derive({ partBindings: [{ id: 'fan', action: 'rotate_speed', speed_factor: 1e-46 }] });
    assert.equal(semanticState(rawFrame(0, 1000), tiny), 'stopped', 'DTO float32 factor underflow is not a running motor');
    assert.equal(deriveMotionSemantics(speedInstance, {}).valid, false, 'missing part metadata cannot guess its speed factor');
    const clip = { key: 'action:feed', kind: 'running', source: catalogDeclaration.source, inputMin: 0, inputMax: 100, invert: false };
    assert.equal(semanticState(conditionFrame(49), clip), 'stopped'); assert.equal(semanticState(conditionFrame(51), clip), 'running');
});
let closeDb, hub, resolver, cold, fallback, restoreInstallPolicy;
(async () => {
    const file = path.join(directory, 'factory.db'); await createTestDatabase(file);
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: file });
    for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) delete process.env[key];
    const database = require('../db/database'); closeDb = database.closeDb; const db = await database.getDb();
    const line = await db.get('SELECT l.id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1', ['factory_default']);
    await db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)', ['semantic_cart', 'Semantic fixture', line.id, '', JSON.stringify(instance)]);
    await db.run('INSERT INTO models (id,name,file_path,metadata,asset_type,placement_level) VALUES (?,?,?,?,?,?)', ['semantic_rpm_model', 'RPM metadata fixture', '', JSON.stringify(speedMetadata), 'model', 'device']);
    await db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)', ['semantic_rpm', 'RPM fixture', line.id, 'semantic_rpm_model', JSON.stringify(speedInstance)]);
    await db.run('INSERT INTO factories (id,name) VALUES (?,?)', ['semantic_foreign', 'Other fixture factory']);
    await db.run('INSERT INTO workshops (id,name,factory_id) VALUES (?,?,?)', ['semantic_foreign_ws', 'Other fixture workshop', 'semantic_foreign']);
    await db.run('INSERT INTO `lines` (id,name,workshop_id) VALUES (?,?,?)', ['semantic_foreign_line', 'Other fixture line', 'semantic_foreign_ws']);
    for (const [id, primary, extra] of [['semantic_rail_only', '', { railLineId: line.id, workshop_id: 'semantic_foreign_ws' }],
        ['semantic_lane_only', '', { laneLineId: line.id, workshop_id: 'semantic_foreign_ws' }],
        ['semantic_rail_precedence', '', { railLineId: line.id, laneLineId: 'semantic_foreign_line', workshop_id: 'semantic_foreign_ws' }],
        ['semantic_primary_precedence', 'semantic_foreign_line', { railLineId: line.id }]])
        await db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)', [id, id, primary, '', JSON.stringify({ ...instance, ...extra })]);
    resolver = new MotionSemanticResolver({ getDb: async () => db, reloadMs: 60000 });
    const untouched = rawFrame(0, 20, 1000), before = JSON.stringify(untouched), pending = resolver.decorate([untouched])[0];
    check('cold metadata never authorizes numeric coalescing or changes source observations', () => {
        assert.equal(pending.motionSemantics.ready, false); assert.equal(JSON.stringify(untouched), before);
        const peer = new HeldSocket(), queue = new WsOutboundQueue(peer); queue.enqueue({ type: 'welcome' });
        for (const value of [0, 1, 0]) queue.enqueue({ type: 'realtime_frame', payload: { devices: resolver.decorate([rawFrame(value)]) } });
        assert.equal(queue.queue.length, 3); queue.dispose();
    });
    await resolver.refresh();
    check('actual SQL rail/lane association ownership matches site/native primary-line precedence', () => {
        for (const id of ['semantic_rail_only', 'semantic_lane_only', 'semantic_rail_precedence']) {
            const frame = resolver.decorate([{ ...untouched, furnace_id: id }])[0]; assert.equal(frame.motionSemantics.ready, true, id);
            assert.equal(frame.motionSemantics.factoryId, 'factory_default', id);
        }
        const primary = resolver.decorate([{ ...untouched, furnace_id: 'semantic_primary_precedence', factoryId: 'semantic_foreign' }])[0];
        assert.equal(primary.motionSemantics.ready, true); assert.equal(primary.motionSemantics.factoryId, 'semantic_foreign');
    });
    check('owned SQL configuration resolves to a complete immutable source declaration snapshot', () => {
        const decorated = resolver.decorate([untouched])[0];
        assert.equal(decorated.motionSemantics.ready, true); assert.equal(validSnapshot(decorated.motionSemantics), true);
        assert.deepEqual(decorated.pointMeta, untouched.pointMeta); assert.equal(decorated.timestamp, 1000);
        assert.equal(decorated.motionSemantics.bindings[0].source.pointId, '603');
        const foreign = resolver.decorate([{ ...untouched, factoryId: 'foreign' }])[0];
        assert.equal(foreign.motionSemantics.ready, false); assert.deepEqual(foreign.motionSemantics.bindings, []);
    });
    const queue = new WsOutboundQueue(new HeldSocket()); queue.enqueue({ type: 'welcome' });
    const reads = resolver.stats.databaseRefreshes, merges = resolver.stats.modelMetadataMerges, started = performance.now();
    for (let index = 0; index < 5000; index++) {
        const source = resolver.decorate([rawFrame(0, index % 20, 2000 + index)])[0];
        assert.ok(queue.enqueue({ type: 'realtime_frame', payload: { timestamp: source.timestamp, devices: [source] } }));
    }
    const pressureMs = performance.now() - started;
    check('5000 same-condition numeric frames retain latest only with no per-frame database reads', () => {
        assert.equal(queue.queue.length, 1); assert.equal(resolver.stats.databaseRefreshes, reads);
        assert.equal(resolver.stats.modelMetadataMerges, merges, 'builtin/SQL metadata is never re-merged per sample');
        assert.equal(queue.queue[0].message.payload.devices[0].pointMeta['mechanisms.feed'].timestamp, 6999);
        assert.equal(queue.queue[0].message.payload.devices[0].mechanisms.feed, 19);
    }); queue.dispose();
    const rpmQueue = new WsOutboundQueue(new HeldSocket()); rpmQueue.enqueue({ type: 'welcome' });
    for (let index = 0; index < 5000; index++) {
        const frame = resolver.decorate([{ ...rawFrame(0, index + 1, 10000 + index), furnace_id: 'semantic_rpm' }])[0];
        assert.ok(rpmQueue.enqueue({ type: 'realtime_frame', payload: { devices: [frame] } }));
    }
    check('5000 same-direction part RPM samples stay exact latest with zero extra SQL or builtin merges', () => {
        assert.equal(rpmQueue.queue.length, 1); assert.equal(resolver.stats.databaseRefreshes, reads); assert.equal(resolver.stats.modelMetadataMerges, merges);
        const latest = rpmQueue.queue[0].message.payload.devices[0]; assert.equal(latest.mechanisms.feed, 5000); assert.equal(latest.pointMeta['mechanisms.feed'].timestamp, 14999);
        assert.equal(latest.motionSemantics.bindings[0].kind, 'signed_speed');
    }); rpmQueue.dispose();
    // Exercise the ACTUAL legacy builtin merge, not a lookalike fixture merger.
    // This is a module override in this isolated test process, not a policy-file edit.
    const installPolicy = require('../services/installContentPolicy'), oldPolicy = installPolicy.emptyInstallation;
    restoreInstallPolicy = () => { installPolicy.emptyInstallation = oldPolicy; }; installPolicy.emptyInstallation = () => false;
    const builtin = require('../services/builtinModels').mergeBuiltinModels([]).find(model => model.id === 'photo_multipurpose_furnace_v6');
    const builtinMetadata = typeof builtin.metadata === 'string' ? JSON.parse(builtin.metadata) : builtin.metadata;
    const fan = builtinMetadata.partBindings.find(part => part.action === 'rotate_speed' && part.id);
    const builtinRow = { ...speedRow, actionId: 'part:' + fan.id, invert: false, speed: 1 };
    await db.run('DELETE FROM models WHERE id=?', [builtin.id]);
    await db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)', ['semantic_builtin', 'Builtin fallback fixture', line.id, builtin.id, JSON.stringify({ animationBindings: { bindings: [builtinRow] } })]);
    fallback = new MotionSemanticResolver({ getDb: async () => db }); await fallback.refresh();
    const builtinFrame = () => fallback.decorate([{ ...rawFrame(0, 60, 16000), furnace_id: 'semantic_builtin' }])[0];
    check('effective builtin metadata works without a SQL model row and does not remain pending', () => {
        assert.equal(builtinFrame().motionSemantics.ready, true); assert.equal(builtinFrame().motionSemantics.bindings[0].speedFactor, Math.fround(fan.speed_factor));
    });
    const overrideMetadata = { partBindings: [{ ...fan, speed_factor: -.25 }] };
    await db.run('INSERT INTO models (id,name,file_path,metadata,asset_type,placement_level) VALUES (?,?,?,?,?,?)', [builtin.id, 'SQL override fixture', builtin.file_path, JSON.stringify(overrideMetadata), 'model', 'device']);
    fallback.invalidate('model_metadata_changed'); await fallback.refresh();
    check('SQL metadata overrides builtin factors and is not unioned with the old definition', () => {
        const frame = builtinFrame(); assert.equal(frame.motionSemantics.ready, true); assert.equal(frame.motionSemantics.bindings[0].speedFactor, -.25);
        assert.equal(semanticState(frame, frame.motionSemantics.bindings[0]), 'negative');
    });
    await db.run('UPDATE models SET factory_id=? WHERE id=?', ['semantic_foreign', builtin.id]); fallback.invalidate('model_metadata_changed'); await fallback.refresh();
    check('a foreign SQL model override cannot replace another factory builtin metadata', () => assert.equal(builtinFrame().motionSemantics.bindings[0].speedFactor, Math.fround(fan.speed_factor)));
    await db.run('UPDATE models SET factory_id=NULL,metadata=? WHERE id=?', ['{invalid fixture metadata', builtin.id]); fallback.invalidate('model_metadata_changed'); await fallback.refresh();
    check('bad explicit SQL part metadata fails closed instead of guessing a builtin factor', () => assert.equal(builtinFrame().motionSemantics.ready, false));
    fallback.dispose(); fallback = null; restoreInstallPolicy(); restoreInstallPolicy = null;
    const previous = resolver.decorate([rawFrame(0, 20, 8000)])[0];
    await db.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify({ movement: { ...instance.movement, enabled: false }, animationBindings: { bindings: [] } }), 'semantic_cart']);
    resolver.invalidate('device_configuration_changed', { deviceId: 'semantic_cart' });
    const reloading = resolver.decorate([rawFrame(0, 20, 8001)])[0];
    await resolver.refresh(); const after = resolver.decorate([rawFrame(0, 20, 8002)])[0];
    check('configuration generations and unload/reload form barriers and never resurrect declarations', () => {
        assert.equal(reloading.motionSemantics.ready, false); assert.deepEqual(after.motionSemantics.bindings, []);
        assert.ok(hasDeclaredMotionBoundary(previous, reloading)); assert.ok(hasDeclaredMotionBoundary(previous, after));
        const peer = new HeldSocket(), pendingQueue = new WsOutboundQueue(peer); pendingQueue.enqueue({ type: 'welcome' });
        for (const stamp of [9000, 9001, 9002]) pendingQueue.enqueue({ type: 'realtime_frame', payload: { devices: resolver.decorate([rawFrame(0, stamp % 100, stamp)]) } });
        assert.equal(pendingQueue.queue.length, 1); assert.deepEqual(pendingQueue.queue[0].message.payload.devices[0].motionSemantics.bindings, []); pendingQueue.dispose();
    });
    await db.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(instance), 'semantic_cart']);
    const { MotionInputResolver } = require('../services/motionInputs'), WsServer = require('../services/wsServer');
    const motion = new MotionInputResolver({ getDb: async () => db, reloadMs: 60000 });
    await motion.semanticResolver.refresh(); hub = new WsServer(); hub.setMotionInputResolver(motion);
    const peer = new HeldSocket(); hub.clients.add(peer); hub.send(peer, { type: 'welcome' });
    for (const [gate, feed] of [[0, 20], [-1, 60], [0, 20]]) hub.broadcastDeviceData([rawFrame(gate, feed, 10000 + peer.sent.length + peer.callbacks.length)]);
    while (peer.callbacks.length) peer.flush();
    check('actual MotionInputResolver → WsServer → outbound queue preserves WORD and condition edges', () => {
        const frames = peer.sent.filter(message => message.type === 'realtime_frame').map(message => message.payload.devices[0]);
        assert.deepEqual(frames.map(frame => frame.analog.start_word), [0, -1, 0]);
        assert.deepEqual(frames.map(frame => frame.mechanisms.feed), [20, 60, 20]);
        assert.ok(frames.every(frame => frame.motionSemantics.ready));
        assert.ok(frames.every(frame => frame.pointMeta['analog.start_word'].timestamp === frame.timestamp));
    });
    let release; const wait = new Promise(resolve => { release = resolve; });
    cold = new MotionSemanticResolver({ getDb: async () => { await wait; return db; } });
    const oldLoad = cold.refresh(); cold.invalidate('configuration_changed'); release(); await oldLoad;
    check('late old metadata loads cannot overwrite a newer configuration generation', () => assert.equal(cold.records.size, 0));
    const report = { success: true, checks: results, pressure: { frames: 5000, processingMs: pressureMs, extraDatabaseRefreshes: 0,
        latestSourceClock: 6999, measuredPlcOrGpuLatency: false }, browserOperations: 0, liveConfigurationWrites: 0, productionPath: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ success: true, checks: results.length, directory, pressureMs }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => { fallback?.dispose(); restoreInstallPolicy?.(); cold?.dispose(); hub?.close(); resolver?.dispose(); await closeDb?.(); });
