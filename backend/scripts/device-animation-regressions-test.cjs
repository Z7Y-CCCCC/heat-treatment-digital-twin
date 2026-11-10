'use strict';
// Deterministic production-module/route fixtures; no backend process or live DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const directory = createRunDirectory('device-animation-regressions');
Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: path.join(directory, 'unused.db'),
    UPLOADS_DIR: path.join(directory, 'uploads'), DB_BACKUP_DIR: path.join(directory, 'backups'),
    DB_RECOVERY_DIR: path.join(directory, 'recovery'), SITE_BACKUP_DIR: path.join(directory, 'site-backups'),
    SITE_IMPORT_DIR: path.join(directory, 'site-imports'), SITE_BACKUP_MIRROR_DIR: '',
    DATA_SOURCE_BACKUP_DIR: path.join(directory, 'data-source-backups') });
for (const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
const { actionsForModel, validateDeviceAnimations, publicDeviceAnimations, isRetiredMotionAction } = require('../services/deviceAnimations');
const { canonicalJson, exactJsonEquals } = require('../services/deviceInspection');
const packageRecord = require('../../shared/motionPackages.json').models.cad_multipurpose_furnace_082000;
const clone = value => JSON.parse(JSON.stringify(value));
const actions = actionsForModel({ metadata: {}, motion_package: packageRecord });
const point = name => ({ id: `p-${name}`, device_id: 'fixture', access_type: 'READ', category: 'doors', value_role: name, data_type: 'BOOL' });
const row = (name, patch = {}) => ({ actionId: `clip:${name}`, enabled: true, pointId: `p-${name}`, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 0, ...patch });
function loaded(bindings = [], customActions = actions) {
    return { revision: 'fixture', actions: clone(customActions), config: { version: 1, staleMs: 5000, bindings: clone(bindings) },
        points: ['door','gate','heating','circulation','process_cycle'].map(point), device: { id: 'fixture' },
        model: { id: 'cad_multipurpose_furnace_082000' }, motionPackage: clone(packageRecord), catalog: { items: [] }, datasets: [] };
}
const save = (snapshot, bindings) => validateDeviceAnimations(snapshot, { revision: snapshot.revision, config: { version: 1, staleMs: 5000, bindings } });

test('the complete process is retired from part authoring while its package/history stays intact', () => {
    const before = clone(packageRecord), cycle = actions.find(action => action.id === 'clip:process_cycle');
    assert.equal(isRetiredMotionAction(cycle), true);
    for (const action of [actions.find(action => action.id === 'clip:door'), { id: 'part:process_cycle', kind: 'part' },
        { id: 'clip:process_cycle_extra', kind: 'clip' }, { id: 'clip:process_cycle', kind: 'part' }]) assert.equal(isRetiredMotionAction(action), false);
    assert.ok(publicDeviceAnimations(loaded()).actions.some(action => action.id === 'clip:process_cycle'), 'archived rig/action metadata remains readable');
    assert.deepEqual(packageRecord, before);
});

test('the complete process cannot be activated as a new part-action binding', () => {
    assert.throws(() => save(loaded(), [row('process_cycle')]), /完整工艺循环.*不能再启用/);
});

test('an authored complete-cycle archive can only be explicitly disabled without resolving removed data', () => {
    const stored = { ...row('process_cycle'), pointId: 'removed-point', kind: 'clip', clipId: 'process_cycle',
        sourceFingerprint: 'archived-fingerprint', extension: { retain: 'original archive' } };
    const snapshot = loaded([stored]), body = publicDeviceAnimations(snapshot).config.bindings.map(binding => ({ ...binding, enabled: false }));
    Object.defineProperty(snapshot, 'points', { get() { throw new Error('retired sources must not be resolved'); } });
    const result = save(snapshot, body);
    assert.deepEqual(result.bindings, [{ ...stored, enabled: false }]);
    result.bindings[0].extension.retain = 'returned copy';
    assert.equal(snapshot.config.bindings[0].extension.retain, 'original archive');
});

test('enabled complete-cycle history cannot be omitted, reactivated, or retargeted', () => {
    const snapshot = loaded([row('process_cycle', { kind: 'clip', clipId: 'process_cycle' })]);
    assert.throws(() => save(snapshot, []), /仍有已启用.*显式停用/);
    const disabled = { ...publicDeviceAnimations(snapshot).config.bindings[0], enabled: false };
    assert.throws(() => save(snapshot, [{ ...disabled, pointId: 'p-door' }]), /只允许停用.*历史绑定字段/);
    snapshot.config.bindings[0].enabled = false;
    assert.throws(() => save(snapshot, [{ ...disabled, enabled: true }]), /完整工艺循环.*不能再启用/);
    assert.deepEqual(save(snapshot, []).bindings, snapshot.config.bindings);
});

test('front chamber door and middle isolation door may share tint while moving independent actuators', () => {
    const door = actions.find(action => action.id === 'clip:door'), gate = actions.find(action => action.id === 'clip:gate');
    const shared = door.channels.filter(channel => gate.channels.includes(channel));
    assert.deepEqual(shared.sort(), ['motion_node_361:c0', 'motion_node_362:c0', 'motion_node_363:c0']);
    const result = save(loaded(), [row('door'), row('gate')]);
    assert.deepEqual(result.bindings.map(binding => [binding.actionId, binding.pointId]), [['clip:door','p-door'], ['clip:gate','p-gate']]);
});

test('shared unindexed tint is also decorative, but duplicate transform/actuator channels stay exclusive', () => {
    const unrelated = [{ id: 'clip:door', kind: 'clip', label: '门 A', mode: 'position', channels: ['door:p','housing:c'] },
        { id: 'clip:gate', kind: 'clip', label: '门 B', mode: 'position', channels: ['gate:p','housing:c7'] }];
    assert.equal(save(loaded([], unrelated), [row('door'),row('gate')]).bindings.length, 2);
    unrelated[1].channels.push('door:p');
    assert.throws(() => save(loaded([], unrelated), [row('door'),row('gate')]), /控制同一部件/);
    assert.throws(() => save(loaded(), [row('heating'),row('circulation')]), /控制同一部件/, 'real shared rotating actuator still conflicts');
});

test('absent numeric feedback smoothing saves as zero without rewriting the original snapshot', () => {
    const snapshot = loaded([row('door')]), original = clone(snapshot.config);
    const result = save(snapshot, publicDeviceAnimations(snapshot).config.bindings);
    assert.equal(result.bindings[0].feedbackSmoothingMs, 0);
    assert.equal(publicDeviceAnimations({ ...snapshot, config: result }).config.bindings[0].feedbackSmoothingMs, 0);
    assert.deepEqual(snapshot.config, original);
    assert.equal(Object.hasOwn(snapshot.config.bindings[0], 'feedbackSmoothingMs'), false);
});

test('numeric feedback smoothing survives public source and binding roundtrips with the old transition preserved', () => {
    const snapshot = loaded();
    snapshot.points.find(point => point.id === 'p-door').data_type = 'REAL';
    snapshot.catalog.items = [{ id: 'fixture-stroke', type: 'number', enabled: true, objectScope: 'device', sourceType: 'plc',
        binding: { mode: 'plc', deviceId: 'fixture', pointId: 'p-door', pointKey: 'doors.door' } }];
    const requested = row('door', { pointId: '', dataItemId: 'fixture-stroke', trigger: { mode: 'range' },
        inputMax: 100, transitionSeconds: 2, feedbackSmoothingMs: 200 });
    const result = save(snapshot, [requested]), binding = result.bindings[0];
    assert.equal(binding.feedbackSmoothingMs, 200);
    assert.equal(binding.transitionSeconds, 2);
    assert.equal(binding.dataItemId, 'fixture-stroke');
    assert.equal(binding.pointId, 'p-door');
    assert.equal(binding.mode, 'position');
    assert.equal(binding.sourceGroup, 'doors');
    assert.equal(binding.sourceKey, 'door');
    assert.match(binding.sourceFingerprint, /^[a-f0-9]{64}$/);
    const reloaded = { ...snapshot, config: result }, published = publicDeviceAnimations(reloaded);
    assert.equal(published.config.bindings[0].feedbackSmoothingMs, 200);
    assert.equal(published.dataItems[0].id, 'fixture-stroke');
    assert.equal(published.dataItems[0].motionReady, true);
    assert.deepEqual(save(reloaded, published.config.bindings), result);
    assert.deepEqual(requested, row('door', { pointId: '', dataItemId: 'fixture-stroke', trigger: { mode: 'range' },
        inputMax: 100, transitionSeconds: 2, feedbackSmoothingMs: 200 }), 'validation never mutates the requested source');
});

test('numeric feedback smoothing accepts finite bounds including fractional milliseconds', () => {
    for (const feedbackSmoothingMs of [0, .5, 200, 1000]) {
        const result = save(loaded(), [row('door', { feedbackSmoothingMs })]);
        assert.equal(result.bindings[0].feedbackSmoothingMs, feedbackSmoothingMs);
    }
});

test('numeric feedback smoothing rejects coerced, nonfinite and out-of-range values even on disabled bindings', () => {
    for (const feedbackSmoothingMs of [null, true, false, '200', '', NaN, Infinity, -Infinity, -1, 1000.001, {}, []]) {
        for (const enabled of [false, true]) {
            assert.throws(() => save(loaded(), [row('door', { enabled, feedbackSmoothingMs })]), /数值反馈平滑.*有效数值/);
        }
    }
});

test('adding numeric feedback smoothing never adds a default to retired history or loosens disable-only validation', () => {
    for (const settings of [{}, { feedbackSmoothingMs: 200 }]) {
        const stored = row('process_cycle', { pointId: 'removed-point', kind: 'clip', clipId: 'process_cycle', ...settings });
        const snapshot = loaded([stored]), published = publicDeviceAnimations(snapshot).config.bindings[0];
        assert.equal(Object.hasOwn(published, 'feedbackSmoothingMs'), Object.hasOwn(settings, 'feedbackSmoothingMs'));
        const disabled = { ...published, enabled: false };
        const result = save(snapshot, [disabled]);
        assert.deepEqual(result.bindings, [{ ...stored, enabled: false }]);
        assert.throws(() => save(snapshot, [{ ...disabled, feedbackSmoothingMs: 0 }]), /只允许停用.*历史绑定字段/);
    }
});

const routeFile = path.resolve(__dirname, '../routes/devices.js');
const routeSource = fs.readFileSync(routeFile, 'utf8'), routeRequire = createRequire(routeFile);
function animationHandler(database, animations) {
    const handlers = new Map(), router = {};
    for (const method of ['get','put','post','delete']) router[method] = (url, callback) => handlers.set(`${method} ${url}`, callback);
    const sandbox = { module: { exports: {} }, console, Buffer, process, setTimeout, clearTimeout,
        require(name) {
            if (name === 'express') return { Router: () => router };
            if (name === '../db/database') return database;
            if (name === '../services/deviceAnimations') return animations;
            return routeRequire(name);
        } };
    vm.runInNewContext(routeSource, sandbox, { filename: routeFile });
    return handlers.get('put /:id/animations');
}
async function invoke(handler, body = { config: { bindings: [] }, revision: 'fixture' }) {
    const response = { statusCode: 200, locals: {}, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await handler({ params: { id: 'fixture' }, body, factoryId: 'fixture' }, response);
    return response;
}
async function routeCas(dialect, raw, affected = 1) {
    let savedInstance, captured;
    const initial = raw == null || raw === '' ? {} : typeof raw === 'string' ? JSON.parse(raw) : clone(raw);
    const snapshot = { device: { id: 'fixture', instance_config: raw }, instance: initial, config: { bindings: [] } };
    const db = { async transaction(callback) { return callback(this); }, async run(sql, params) {
        captured = { sql, params: Array.from(params) };
        assert.ok(sql.includes(exactJsonEquals('instance_config', dialect)), 'route must use dialect-aware exact JSON CAS, not native JSON COALESCE with an empty string');
        assert.equal(typeof params[0], 'string'); assert.equal(params[1], 'fixture');
        assert.equal(params[2], ['mysql','postgres'].includes(dialect) ? canonicalJson(raw) : raw ?? '');
        assert.equal(typeof params[2], 'string', 'native JSON object must reach the MySQL adapter as a JSON string');
        savedInstance = JSON.parse(params[0]);
        return { changes: affected, affectedRows: affected };
    } };
    const handler = animationHandler({ getDb: async () => db, getDbStatus: () => ({ type: dialect }) }, {
        loadDeviceAnimations: async () => snapshot, validateDeviceAnimations: (_snapshot, body) => body.config,
        publicDeviceAnimations: value => ({ config: value.config })
    });
    return { response: await invoke(handler), captured, savedInstance, initial };
}

test('actual animation route canonicalizes MySQL native JSON objects and preserves unrelated config', async () => {
    const raw = { marker: 'CaseSensitive', plc: { address: 'retain' }, values: [2,1], nested: { z: 1, a: 2 } }, before = clone(raw);
    const outcome = await routeCas('mysql', raw);
    assert.equal(outcome.response.statusCode, 200, JSON.stringify(outcome.response.body));
    assert.deepEqual(outcome.savedInstance, { ...raw, animationBindings: { bindings: [] } });
    assert.deepEqual(raw, before);
    assert.equal(outcome.response.locals.configurationResource, 'device-animations');
});

test('actual animation route handles MySQL null/empty native JSON without submitting an invalid empty JSON parameter', async () => {
    for (const raw of [null, '', {}, '{ "z":1.0, "a":"Case" }']) {
        const outcome = await routeCas('mysql', raw);
        assert.equal(outcome.response.statusCode, 200, JSON.stringify(outcome.response.body));
        assert.doesNotThrow(() => JSON.parse(outcome.captured.params[2]));
    }
});

test('actual animation route still rejects a concurrent CAS miss and emits no committed resource marker', async () => {
    const outcome = await routeCas('mysql', { marker: 'old' }, 0);
    assert.equal(outcome.response.statusCode, 409);
    assert.match(outcome.response.body.error, /设备配置已更新/);
    assert.equal(outcome.response.locals.configurationResource, undefined);
});

test('SQLite and SQL Server keep exact textual snapshots while PostgreSQL uses canonical native JSON', async () => {
    const raw = '{ "Marker":"Case", "array":[2,1] }';
    for (const dialect of ['sqlite','sqlserver','postgres']) {
        const outcome = await routeCas(dialect, raw);
        assert.equal(outcome.response.statusCode, 200, `${dialect}: ${JSON.stringify(outcome.response.body)}`);
        assert.equal(outcome.captured.params[2], dialect === 'postgres' ? canonicalJson(raw) : raw);
    }
});
