'use strict';
// Real isolated HTTP saves. Historical animation selections must not turn the
// movement form into an editor for fields it does not expose.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
let fixture;
const checks = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
    fixture = await createLinkageFixture('movement-validation-boundary');
    const { ok, request, sql, cartId, targetId, points } = fixture;
    const deviceRoute = '/api/devices/' + cartId, animationRoute = deviceRoute + '/animations';
    const instance = () => JSON.parse(sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(cartId).instance_config);
    const replaceInstance = value => sql.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(value), cartId);
    const state = () => ({ devices: sql.prepare('SELECT * FROM devices ORDER BY id').all(),
        points: sql.prepare('SELECT * FROM data_points ORDER BY id').all(), lines: sql.prepare('SELECT * FROM `lines` ORDER BY id').all() });
    let movement = { enabled: true, currentPositionPointId: points.position, startActionPointId: points.start,
        valueMode: 'range', valueMin: 0, valueMax: 100, sceneUnitsPerMeter: 1, maxSpeed: 2, acceleration: 1,
        start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 },
        stations: [{ value: 1, position: { x: 0, y: 0, z: 0 }, anchorDeviceId: targetId }] };
    await ok(deviceRoute + '/movement', 'PUT', { movement, expectedMovement: null });
    let loaded = await ok(animationRoute);
    const feed = loaded.transferCapabilities.actions.find(action => action.id === 'clip:feed');
    assert.ok(feed?.driveNodes.length);
    const item = id => loaded.dataItems.find(row => String(row.binding?.pointId) === String(id)).id;
    const { defaultTransferLink } = require('../../shared/transferLinkConfig.mjs');
    const transfer = { ...defaultTransferLink(), enabled: true, actionId: feed.id, driveNodeName: feed.driveNodes[0],
        targetDeviceId: targetId, presenceDataItemId: item(points.presence) };
    const binding = { actionId: feed.id, enabled: true, pointId: '', dataItemId: item(points.feed),
        trigger: { mode: 'range' }, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: .1 };
    await ok(animationRoute, 'PUT', { revision: loaded.revision, config: { version: 1, staleMs: 5000, bindings: [binding], transferLink: transfer } });
    const validAnimation = clone(instance().animationBindings);

    for (const [name, mutate, expectedError] of [
        ['retired action', value => { value.transferLink.actionId = 'clip:removed-after-model-update'; }, /承料移动节点/],
        ['removed carriage node', value => { value.transferLink.driveNodeName = 'removed_carriage_node'; }, /承料移动节点/],
        ['unavailable material input', value => { value.transferLink.presenceDataItemId = 'point_removed'; }, /数据项|数据源|反馈|选择|只读/],
        ['disabled feed binding', value => { value.bindings[0].enabled = false; }, /启用所选送料动作/]
    ]) {
        const beforeInstance = instance();
        beforeInstance.animationBindings = clone(validAnimation); mutate(beforeInstance.animationBindings);
        replaceInstance(beforeInstance); // Only this isolated imported/model-refresh fixture.
        const before = state(), next = { ...movement, maxSpeed: movement.maxSpeed + .25, acceleration: 1.2 };
        const saved = await request(deviceRoute + '/movement', 'PUT', { movement: next, expectedMovement: movement });
        assert.equal(saved.status, 200, name + ': ' + JSON.stringify(saved));
        assert.deepEqual(instance(), { ...beforeInstance, movement: next }, 'Only authored movement fields may change');
        const after = state();
        assert.deepEqual(after.lines, before.lines); assert.deepEqual(after.points, before.points);
        assert.deepEqual(after.devices.filter(row => row.id !== cartId), before.devices.filter(row => row.id !== cartId));
        movement = next;
        loaded = await ok(animationRoute);
        const unchanged = state();
        const rejected = await request(animationRoute, 'PUT', { revision: loaded.revision, config: loaded.config });
        assert.equal(rejected.status, 400, 'The animation editor must still reject ' + name);
        assert.match(rejected.data.error, expectedError);
        assert.deepEqual(state(), unchanged);
        const basic = clone(loaded.config); delete basic.transferLink;
        const legacy = clone(instance().animationBindings.transferLink);
        await ok(animationRoute, 'PUT', { revision: loaded.revision, config: basic });
        assert.deepEqual(instance().animationBindings.transferLink, legacy, 'Basic action save preserves legacy inter-device records without validating the removed form');
        check(name + ' does not block movement save; animation validation still rejects it without partial writes');
    }

    replaceInstance({ ...instance(), animationBindings: clone(validAnimation) });
    const stationMovement = { ...movement, valueMode: 'station', stationInputMeaning: 'current' };
    await ok(deviceRoute + '/movement', 'PUT', { movement: stationMovement, expectedMovement: movement });
    movement = stationMovement;
    loaded = await ok(animationRoute);
    await ok(animationRoute, 'PUT', { revision: loaded.revision, config: { ...loaded.config, transferLink: { ...transfer, targetMode: 'station', targetDeviceId: '' } } });
    const staleStation = instance(); staleStation.animationBindings.transferLink.driveNodeName = 'removed_carriage_node'; replaceInstance(staleStation);
    const faster = { ...movement, maxSpeed: 3.5 };
    await ok(deviceRoute + '/movement', 'PUT', { movement: faster, expectedMovement: movement }); movement = faster;
    for (const patch of [{ enabled: false }, { valueMode: 'range' }, { stations: [{ ...movement.stations[0], anchorDeviceId: '' }] }]) {
        const before = state();
        const next = { ...movement, ...patch }, previousInstance = instance();
        const accepted = await request(deviceRoute + '/movement', 'PUT', { movement: next, expectedMovement: movement });
        assert.equal(accepted.status, 200, JSON.stringify(accepted));
        assert.deepEqual(instance(), { ...previousInstance, movement: next });
        assert.deepEqual(state().lines, before.lines); assert.deepEqual(state().points, before.points);
        await ok(deviceRoute + '/movement', 'PUT', { movement, expectedMovement: next });
    }
    check('removed inter-device settings cannot lock movement enable, position mode or station editing; legacy data is preserved');
    fs.writeFileSync(path.join(fixture.directory, 'result.json'), JSON.stringify({ success: true, checks, isolatedHttp: true, liveConfigurationWrites: 0 }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await fixture?.close(); });
