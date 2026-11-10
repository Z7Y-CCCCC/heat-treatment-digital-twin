'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
let fixture;
const checks = [], details = [], check = name => { checks.push(name); console.log('PASS ' + name); };
const clone = value => JSON.parse(JSON.stringify(value));
(async () => {
    fixture = await createLinkageFixture('line-spacing-precision');
    const { ok, request, sql, cartId, targetId, line, points } = fixture;
    const route = '/api/lines/' + line.id;
    const raw = () => ({ lines: sql.prepare('SELECT * FROM `lines` ORDER BY id').all(),
        devices: sql.prepare('SELECT * FROM devices ORDER BY id').all(), points: sql.prepare('SELECT * FROM data_points ORDER BY id').all() });
    const getLine = async () => (await ok('/api/lines')).find(row => row.id === line.id);
    const cart = () => sql.prepare('SELECT * FROM devices WHERE id=?').get(cartId);
    const movement = z => ({ enabled: true, currentPositionPointId: points.position, startActionPointId: points.start,
        valueMode: 'station', stationInputMeaning: 'current', smoothingMs: 100, staleMs: 5000,
        start: { x: 0, y: 0, z }, end: { x: 10, y: 0, z },
        stations: [{ value: 1, label: 'fixture station', anchorDeviceId: targetId, position: { x: 5, y: 0, z } }] });
    const initial = await getLine();
    await ok(route, 'PUT', { name: initial.name, workshop_id: initial.workshop_id, expectedLayout: initial.layout,
        layout: { ...initial.layout, sceneUnitsPerMeter: .0001,
            lanes: [{ id: 'precision-lane', name: 'precision lane', offsetZ: 0, length: 60, sort_order: 0 }],
            rails: [{ id: 'precision-rail', name: 'precision rail', offsetZ: 0, length: 60, sort_order: 0 }] } });
    const authoredConfig = { ...JSON.parse(cart().instance_config), workshop_id: line.workshop_id, railLineId: line.id,
        railId: 'precision-rail', movement: movement(0), animationBindings: { bindings: [{ actionId: 'clip:feed', pointId: points.feed, enabled: true }] } };
    // All fixture setup SQL is confined to the test helper's new isolated DB.
    sql.prepare('UPDATE devices SET pos_x=0,pos_z=0,coordinate_space=?,instance_config=? WHERE id=?')
        .run('line_local', JSON.stringify(authoredConfig), cartId);
    const originalPoints = raw().points;
    for (const [distanceMeters, side, expectedOffset] of [[.001, 'positive', 1e-7], [.002, 'negative', -2e-7]]) {
        const current = await getLine(), layout = clone(current.layout);
        layout.rails[0].spacing = { laneId: 'precision-lane', distanceMeters, side };
        const saved = await ok(route, 'PUT', { name: current.name, workshop_id: current.workshop_id, layout, expectedLayout: current.layout });
        const reopened = await getLine(), persisted = JSON.parse(sql.prepare('SELECT layout_json FROM `lines` WHERE id=?').get(line.id).layout_json);
        const source = cart(), config = JSON.parse(source.instance_config);
        assert.equal(reopened.layout.rails[0].offsetZ, expectedOffset);
        assert.equal(persisted.rails[0].offsetZ, expectedOffset);
        assert.equal(persisted.rails[0].spacing.distanceMeters, distanceMeters);
        assert.equal(source.pos_z, expectedOffset);
        for (const point of [config.movement.start, config.movement.end, config.movement.stations[0].position]) assert.equal(point.z, expectedOffset);
        assert.equal(Object.hasOwn(config.movement, 'sceneUnitsPerMeter'), false);
        assert.equal(Object.hasOwn(config.movement, 'scene_units_per_meter'), false);
        assert.equal(config.movement.currentPositionPointId, points.position);
        assert.deepEqual(config.animationBindings, authoredConfig.animationBindings);
        assert.equal(config.marker, authoredConfig.marker); assert.deepEqual(config.plcMarker, authoredConfig.plcMarker);
        assert.deepEqual(raw().points, originalPoints);
        details.push({ distanceMeters, side, sceneUnitsPerMeter: .0001, offsetZ: source.pos_z, updatedDevices: saved.devices });
        check(`real API/SQL/GET ${distanceMeters}m ${side} spacing preserves ${expectedOffset} scene coordinates and every rigid path point`);
    }
    let current = await getLine(), snapshot = raw();
    const stale = await request(route, 'PUT', { name: 'must not save', layout: current.layout, expectedLayout: initial.layout });
    assert.equal(stale.status, 409); assert.deepEqual(raw(), snapshot);
    check('small-spacing saved values remain stable in the original layout CAS and stale writes remain atomic');

    const inheritedConfig = JSON.parse(cart().instance_config);
    for (const [units, accepted] of [['\u00a0\ufeff1e-4\u2029', true], ['0x1', false], ['0b1', false], ['0o1', false], ['1e-320', false], ['5e-324', false]]) {
        const imported = clone(inheritedConfig); imported.movement.scene_units_per_meter = units;
        sql.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(imported), cartId);
        snapshot = raw(); current = await getLine();
        const result = await request(route, 'PUT', { name: current.name, layout: current.layout, expectedLayout: current.layout });
        assert.equal(result.status, accepted ? 200 : 400, JSON.stringify(result));
        if (!accepted) assert.match(result.data.error, /现有移动设置中校准/);
        assert.deepEqual(raw(), snapshot, 'Legacy validation must not rewrite a source field or PLC definition');
    }
    sql.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(inheritedConfig), cartId);
    check('actual line-save API accepts ECMA-trimmed legacy decimal units, rejects nondecimal/float-underflow strings, and never repairs imported fields');

    current = await getLine();
    for (const sceneUnitsPerMeter of [Number.MIN_VALUE, 1e-320, 1e-46]) {
        snapshot = raw(); const result = await request(route, 'PUT', { name: 'must not save', layout: { ...current.layout, sceneUnitsPerMeter }, expectedLayout: current.layout });
        assert.equal(result.status, 400); assert.match(result.data.error, /场景单位/); assert.deepEqual(raw(), snapshot);
    }
    check('actual numeric line unit authoring rejects native-float underflow without line/device/point writes');

    for (const [sceneUnitsPerMeter, distanceMeters, rawEqual] of [[1e-20, .001, true], [1e-9, .0001, false]]) {
        const impossible = clone(current.layout); impossible.sceneUnitsPerMeter = sceneUnitsPerMeter;
        impossible.lanes[0].offsetZ = 1000;
        impossible.rails[0].spacing = { laneId: 'precision-lane', distanceMeters, side: 'positive' };
        assert.equal(1000 + distanceMeters * sceneUnitsPerMeter === 1000, rawEqual);
        snapshot = raw(); const result = await request(route, 'PUT', { name: 'must not save', layout: impossible, expectedLayout: current.layout });
        assert.equal(result.status, 400); assert.match(result.data.error, /已配置.*精度不足/); assert.deepEqual(raw(), snapshot);
    }
    check('actual API rejects both unrepresentable large lane origins and gaps lost only by significant-digit rounding with no SQL change');

    for (const side of ['positive', 'negative']) {
        const nativeOverlap = clone(current.layout); nativeOverlap.lanes[0].offsetZ = 10;
        nativeOverlap.rails[0].spacing = { laneId: 'precision-lane', distanceMeters: .001, side };
        const rawOffset = 10 + (side === 'positive' ? 1 : -1) * 1e-7;
        assert.notEqual(rawOffset, 10); assert.equal(Math.fround(rawOffset), Math.fround(10));
        snapshot = raw(); const result = await request(route, 'PUT', { name: 'must not save', layout: nativeOverlap, expectedLayout: current.layout });
        assert.equal(result.status, 400); assert.match(result.data.error, /精度不足.*Unity/); assert.deepEqual(raw(), snapshot);
    }
    check('actual API rejects .0001 units/m and .001m spacing at lane origin 10 when Unity float32 would collapse either side to overlap');

    // Reset only this isolated fixture to a valid zero-offset legacy track, then
    // place the large-origin source later in insertion order. A prior valid
    // carrier update must roll back together with the line on every rejection.
    const zero = clone(current.layout); zero.sceneUnitsPerMeter = 1e-10; delete zero.rails[0].spacing; zero.rails[0].offsetZ = 0;
    await ok(route, 'PUT', { name: current.name, layout: zero, expectedLayout: current.layout });
    current = await getLine();
    const laterId = 'precision_later_cart';
    sql.prepare('INSERT INTO devices (id,name,line_id,model_type,pos_x,pos_y,pos_z,rotation_y,scale,plc_enabled,coordinate_space,instance_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(laterId, laterId, line.id, fixture.cartModel.id, 2, 0, 100000, 0, 1, 0, 'line_local', '{}');
    const laterPositionPoint = String(sql.prepare('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(laterId, 'actual_position', 'actual_position', 'DB1.DBD100', 'REAL', 'mechanisms', 'actual_position', 'READ', 200).lastInsertRowid);
    const laterConfig = { ...clone(authoredConfig), movement: { ...movement(100000), currentPositionPointId: laterPositionPoint } };
    delete laterConfig.movement.startActionPointId;
    sql.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(laterConfig), laterId);
    const tiny = clone(current.layout); tiny.rails[0].spacing = { laneId: 'precision-lane', distanceMeters: .001, side: 'positive' };
    assert.equal(100000 + .001 * 1e-10, 100000);
    const candidateOrder = sql.prepare("SELECT id FROM devices WHERE line_id=? OR line_id IS NULL OR line_id='' ").all(line.id).map(row => row.id);
    assert.ok(candidateOrder.indexOf(cartId) < candidateOrder.indexOf(laterId));
    for (const explicitRows of [false, true]) {
        snapshot = raw();
        const body = { name: 'must not save', layout: tiny, expectedLayout: current.layout };
        if (explicitRows) body.devicePositions = [{ id: cartId, pos_x: cart().pos_x, pos_z: 1e-13, expected: { pos_x: cart().pos_x, pos_z: cart().pos_z } },
            { id: laterId, pos_x: 2, pos_z: 100000, expected: { pos_x: 2, pos_z: 100000 } }];
        const result = await request(route, 'PUT', body);
        assert.equal(result.status, 400); assert.match(result.data.error, /设备坐标精度不足/); assert.deepEqual(raw(), snapshot);
    }
    check('automatic and explicit-row device translations cannot swallow a nonzero rail delta; whole SQL transaction rolls back an earlier valid carrier update');

    for (const stationOnly of [false, true]) {
        const source = clone(laterConfig); source.movement = { ...movement(stationOnly ? 0 : 100000), currentPositionPointId: laterPositionPoint };
        delete source.movement.startActionPointId;
        if (stationOnly) source.movement.stations[0].position.z = 100000;
        sql.prepare('UPDATE devices SET pos_z=0,instance_config=? WHERE id=?').run(JSON.stringify(source), laterId);
        snapshot = raw(); const result = await request(route, 'PUT', { name: 'must not save', layout: tiny, expectedLayout: current.layout });
        assert.equal(result.status, 400); assert.match(result.data.error, /移动坐标精度不足/); assert.deepEqual(raw(), snapshot);
    }
    check('large-origin path endpoints and station coordinates reject lost rigid displacement with the same atomic rollback');

    const nativeTiny = clone(tiny); nativeTiny.sceneUnitsPerMeter = .0001;
    const floatOnlySource = { ...clone(laterConfig), movement: { ...movement(10), currentPositionPointId: laterPositionPoint } };
    delete floatOnlySource.movement.startActionPointId;
    sql.prepare('UPDATE devices SET pos_z=10,instance_config=? WHERE id=?').run(JSON.stringify(floatOnlySource), laterId);
    assert.notEqual(10 + 1e-7, 10); assert.equal(Math.fround(10 + 1e-7), Math.fround(10));
    for (const explicitRows of [false, true]) {
        snapshot = raw();
        const body = { name: 'must not save', layout: nativeTiny, expectedLayout: current.layout };
        if (explicitRows) body.devicePositions = [{ id: cartId, pos_x: cart().pos_x, pos_z: 1e-7, expected: { pos_x: cart().pos_x, pos_z: cart().pos_z } },
            { id: laterId, pos_x: 2, pos_z: 10 + 1e-7, expected: { pos_x: 2, pos_z: 10 } }];
        const result = await request(route, 'PUT', body);
        assert.equal(result.status, 400); assert.match(result.data.error, /设备坐标精度不足/); assert.deepEqual(raw(), snapshot);
    }
    check('automatic and explicit-row origins at 10 reject double-only 1e-7 translation with complete rollback of an earlier float32-representable carrier update');

    for (const stationOnly of [false, true]) {
        const source = clone(floatOnlySource); source.movement = { ...movement(stationOnly ? 0 : 10), currentPositionPointId: laterPositionPoint };
        delete source.movement.startActionPointId;
        if (stationOnly) source.movement.stations[0].position.z = 10;
        sql.prepare('UPDATE devices SET pos_z=0,instance_config=? WHERE id=?').run(JSON.stringify(source), laterId);
        snapshot = raw(); const result = await request(route, 'PUT', { name: 'must not save', layout: nativeTiny, expectedLayout: current.layout });
        assert.equal(result.status, 400); assert.match(result.data.error, /移动坐标精度不足.*Unity/); assert.deepEqual(raw(), snapshot);
    }
    check('float32-only path endpoint/station collapse at 10 rejects a double-representable displacement without path/line/device/point writes');

    const resetSource = clone(floatOnlySource); resetSource.movement = { ...movement(0), currentPositionPointId: laterPositionPoint };
    delete resetSource.movement.startActionPointId;
    sql.prepare('UPDATE devices SET pos_z=0,instance_config=? WHERE id=?').run(JSON.stringify(resetSource), laterId);
    const legacyTen = clone(current.layout); legacyTen.sceneUnitsPerMeter = .0001; legacyTen.rails[0].offsetZ = 10;
    await ok(route, 'PUT', { name: current.name, layout: legacyTen, expectedLayout: current.layout });
    current = await getLine(); const rawRailEdit = clone(current.layout); rawRailEdit.rails[0].offsetZ = 10 + 1e-7;
    snapshot = raw(); const nativeDeltaRejected = await request(route, 'PUT', { name: 'must not save', layout: rawRailEdit, expectedLayout: current.layout });
    assert.equal(nativeDeltaRejected.status, 400); assert.match(nativeDeltaRejected.data.error, /导轨坐标精度不足.*Unity/); assert.deepEqual(raw(), snapshot);
    check('legacy unassociated raw rail offsets also reject float32-indistinguishable nonzero deltas through the real atomic save API');

    fs.writeFileSync(path.join(fixture.directory, 'result.json'), JSON.stringify({ success: true, checks, details, isolatedHttp: true,
        browserOperations: 0, liveConfigurationWrites: 0, originalSourceClocksModified: false }, null, 2));
    console.log('PASS line spacing precision ' + fixture.directory);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await fixture?.close(); });
