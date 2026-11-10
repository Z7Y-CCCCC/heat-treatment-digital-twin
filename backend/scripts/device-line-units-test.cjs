'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
let fixture;
const checks = [], check = name => { checks.push(name); console.log('PASS ' + name); };
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
    fixture = await createLinkageFixture('device-line-units');
    const { ok, request, sql, cartId, targetId, line, points } = fixture;
    const cartRoute = '/api/devices/' + cartId;
    const raw = () => ({ devices: sql.prepare('SELECT * FROM devices ORDER BY id').all(), points: sql.prepare('SELECT * FROM data_points ORDER BY id').all(),
        lines: sql.prepare('SELECT * FROM `lines` ORDER BY id').all() });
    const current = (await ok('/api/lines')).find(row => row.id === line.id);
    await ok('/api/lines/' + line.id, 'PUT', { name: current.name, workshop_id: current.workshop_id,
        layout: { ...current.layout, sceneUnitsPerMeter: .8 }, expectedLayout: current.layout });
    const movement = { enabled: true, currentPositionPointId: points.position, startActionPointId: points.start,
        valueMode: 'range', valueMin: 0, valueMax: 100, start: { x: 0, y: 0, z: .5 }, end: { x: 10, y: 0, z: .5 }, sceneUnitsPerMeter: .8 };
    await ok(cartRoute + '/movement', 'PUT', { movement, expectedMovement: null });
    const saved = await ok(cartRoute);
    assert.equal(saved.lineLayout.sceneUnitsPerMeter, .8);
    assert.deepEqual(JSON.parse(saved.instance_config).movement, movement);
    check('real device GET exposes authored parent calibration and matching movement PUT persists without conversion');

    let before = raw();
    for (const units of [1, 1.25, 2]) {
        const rejected = await request(cartRoute + '/movement', 'PUT', { movement: { ...movement, sceneUnitsPerMeter: units }, expectedMovement: movement });
        assert.equal(rejected.status, 400); assert.match(rejected.data.error, /不一致.*现有产线结构与移动设置/); assert.deepEqual(raw(), before);
    }
    check('movement editor rejects conflicting calibration atomically, including original point sampling settings');
    const unitsLine = (await ok('/api/lines')).find(row => row.id === line.id);
    const rejectedLine = await request('/api/lines/' + line.id, 'PUT', { name: unitsLine.name, workshop_id: unitsLine.workshop_id,
        layout: { ...unitsLine.layout, sceneUnitsPerMeter: 2 }, expectedLayout: unitsLine.layout });
    assert.equal(rejectedLine.status, 400); assert.match(rejectedLine.data.error, /不一致/); assert.deepEqual(raw(), before);
    check('line edit cannot invalidate an active primary-line source even before a specific rail is bound');

    const inherited = clone(movement); delete inherited.sceneUnitsPerMeter;
    await ok(cartRoute + '/movement', 'PUT', { movement: inherited, expectedMovement: movement });
    const inheriting = await ok(cartRoute), instance = JSON.parse(inheriting.instance_config);
    assert.equal(inheriting.lineLayout.sceneUnitsPerMeter, .8); assert.equal(Object.hasOwn(instance.movement, 'sceneUnitsPerMeter'), false);
    assert.equal(Object.hasOwn(instance.movement, 'scene_units_per_meter'), false);
    check('source calibration inheritance never writes a hidden movement field or changes PLC definitions');

    // A second owned line exercises transform and full-device authoring paths.
    const second = 'unit-second-line';
    sql.prepare('INSERT INTO `lines` (id,name,workshop_id,layout_json) VALUES (?,?,?,?)')
        .run(second, second, line.workshop_id, JSON.stringify({ ...unitsLine.layout, sceneUnitsPerMeter: 1.25 }));
    await ok(cartRoute + '/movement', 'PUT', { movement, expectedMovement: inherited }); before = raw();
    const transform = await request(cartRoute + '/transform', 'PUT', { line_id: second });
    assert.equal(transform.status, 400); assert.match(transform.data.error, /不一致/); assert.deepEqual(raw(), before);
    const batch = await request('/api/devices/transforms', 'PUT', { devices: [{ id: targetId, pos_x: 99 }, { id: cartId, line_id: second }] });
    assert.equal(batch.status, 400); assert.deepEqual(raw(), before, 'An earlier valid batch entry must also roll back');
    check('single and batch transform rebinds enforce calibration with whole-batch rollback');
    const invalidInstance = { ...JSON.parse((await ok(cartRoute)).instance_config), movement: { ...movement, sceneUnitsPerMeter: 2 } };
    const full = await request(cartRoute, 'PUT', { name: cartId, line_id: line.id, instance_config: invalidInstance });
    assert.equal(full.status, 400); assert.match(full.data.error, /不一致/); assert.deepEqual(raw(), before);
    const create = await request('/api/devices', 'POST', { id: 'invalid-unit-create', name: 'invalid-unit-create', line_id: line.id,
        model_type: fixture.cartModel.id, instance_config: invalidInstance });
    assert.equal(create.status, 400); assert.match(create.data.error, /不一致/); assert.deepEqual(raw(), before);
    check('full device create/update cannot bypass the normal calibration contract');

    const route = cartRoute + '/animations'; let animation = await ok(route);
    const feed = animation.transferCapabilities.actions.find(row => row.id === 'clip:feed');
    const data = animation.dataItems.find(row => String(row.binding?.pointId) === points.feed);
    const presence = animation.dataItems.find(row => String(row.binding?.pointId) === points.presence);
    const { defaultTransferLink } = require('../../shared/transferLinkConfig.mjs');
    const binding = { actionId: 'clip:feed', enabled: true, pointId: '', dataItemId: data.id, trigger: { mode: 'range' },
        inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: .1 };
    const transfer = { ...defaultTransferLink(), enabled: true, actionId: feed.id, driveNodeName: feed.driveNodes[0],
        targetDeviceId: targetId, presenceDataItemId: presence.id };
    animation = await ok(route, 'PUT', { revision: animation.revision, config: { version: 1, staleMs: 5000, bindings: [binding], transferLink: transfer } });
    assert.equal(animation.transferCapabilities.sourceTransform.line.layout.sceneUnitsPerMeter, .8);
    const corrupt = JSON.parse((await ok(cartRoute)).instance_config); corrupt.movement.sceneUnitsPerMeter = 2;
    // Imported/legacy corruption is only in this isolated SQL fixture. It must
    // still be rejected rather than silently normalized on the next normal save.
    sql.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(corrupt), cartId); before = raw();
    animation = await ok(route);
    const animate = await request(route, 'PUT', { revision: animation.revision, config: animation.config });
    assert.equal(animate.status, 400); assert.match(animate.data.error, /不一致/); assert.deepEqual(raw(), before);
    check('animation save also validates actual parent calibration, without rewriting malformed imported source settings');

    fs.writeFileSync(path.join(fixture.directory, 'result.json'), JSON.stringify({ success: true, checks, isolatedHttp: true,
        browserOperations: 0, liveConfigurationWrites: 0, originalSourceClocksModified: false }, null, 2));
    console.log('PASS device line unit authoring ' + fixture.directory);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await fixture?.close(); });
