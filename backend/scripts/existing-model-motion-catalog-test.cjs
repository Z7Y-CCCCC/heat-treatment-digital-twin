'use strict';
// Empty distribution policy may hide sample seeding, never existing CAD actions.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
let fixture;
(async () => {
    fixture = await createLinkageFixture('existing-model-motion-catalog', { emptyInstallation: true });
    const { targetId, targetModel, sql, ok, request } = fixture;
    const modelsBefore = sql.prepare('SELECT * FROM models ORDER BY id').all();
    const linesBefore = sql.prepare('SELECT * FROM `lines` ORDER BY id').all();
    const devicesBefore = sql.prepare('SELECT * FROM devices ORDER BY id').all();
    const route = '/api/devices/' + targetId + '/animations';
    let loaded = await ok(route);
    const expected = targetModel.motion_package.actions.map(action => 'clip:' + action.id).sort();
    assert.deepEqual(loaded.actions.filter(action => action.kind === 'clip').map(action => action.id).sort(), expected);
    assert.ok(loaded.actions.some(action => action.id === 'clip:door'));
    assert.ok(loaded.actions.some(action => action.id === 'clip:basket_down'));
    assert.ok(loaded.actions.some(action => action.id === 'clip:circulation'));
    assert.deepEqual(sql.prepare('SELECT * FROM models ORDER BY id').all(), modelsBefore);
    assert.deepEqual(sql.prepare('SELECT * FROM devices ORDER BY id').all(), devicesBefore);
    console.log('PASS empty-install HTTP exposes every existing verified CAD action without seeding or rewriting models/devices');

    const { getBuiltinModels, mergeBuiltinModels } = require('../services/builtinModels');
    const oldEmpty = process.env.APP_EMPTY_INSTALL;
    try {
        process.env.APP_EMPTY_INSTALL = '1';
        assert.deepEqual(getBuiltinModels(), []);
        assert.deepEqual(mergeBuiltinModels([]), []);
        const replacement = mergeBuiltinModels([{ ...targetModel, file_path: '/uploads/models/not-the-original.glb' }])[0];
        assert.equal(replacement.motion_package, null, 'A reused model ID cannot attach an unrelated rig');
        const authoredPart = { id: 'saved_door', name: '已配置炉门', node_name: 'door', action: 'translate' };
        const custom = mergeBuiltinModels([{ id: 'owned-upload', file_path: '/uploads/models/owned.glb', metadata: { partBindings: [authoredPart] } }])[0];
        assert.deepEqual(require('../services/deviceAnimations').actionsForModel(custom).map(action => action.id), ['part:saved_door']);
    } finally {
        if (oldEmpty === undefined) delete process.env.APP_EMPTY_INSTALL; else process.env.APP_EMPTY_INSTALL = oldEmpty;
    }
    console.log('PASS clean installs remain empty; replacement sources receive no mismatched rig; owned part actions remain bindable');

    const point = String(sql.prepare('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(targetId, 'door', '门到位', 'DB1.DBX0.0', 'BOOL', 'doors', 'door', 'READ', 1000).lastInsertRowid);
    const pointsBefore = sql.prepare('SELECT * FROM data_points ORDER BY id').all();
    loaded = await ok(route);
    const binding = { actionId: 'clip:door', enabled: true, pointId: point, dataItemId: '', trigger: { mode: 'condition', operator: 'eq', value: true, hysteresis: 0 },
        inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: .5 };
    loaded = await ok(route, 'PUT', { revision: loaded.revision, config: { version: 1, staleMs: 5000, bindings: [binding] } });
    const reopened = await ok(route);
    assert.equal(reopened.config.bindings[0].actionId, 'clip:door');
    assert.equal(reopened.config.bindings[0].pointId, point);
    assert.equal(reopened.config.bindings[0].enabled, true);
    assert.deepEqual(sql.prepare('SELECT * FROM models ORDER BY id').all(), modelsBefore);
    assert.deepEqual(sql.prepare('SELECT * FROM `lines` ORDER BY id').all(), linesBefore);
    assert.deepEqual(sql.prepare('SELECT * FROM data_points ORDER BY id').all(), pointsBefore);
    const foreign = await request(route, 'GET', undefined, 'linkage_foreign_factory');
    assert.equal(foreign.status, 404);
    fs.writeFileSync(path.join(fixture.directory, 'result.json'), JSON.stringify({ success: true, actions: expected, realBindingSave: true, emptyInstall: true, liveConfigurationWrites: 0 }, null, 2));
    console.log('PASS existing CAD door can bind, save and reopen its owned point; layout/PLC/model rows and factory isolation remain unchanged');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await fixture?.close(); });
