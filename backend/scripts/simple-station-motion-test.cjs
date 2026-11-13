'use strict';
const assert = require('node:assert/strict');
const { validateMovementConfig, validateMovementSources } = require('../services/movementConfig');
const { deriveMotionSemantics } = require('../../shared/motionSemanticPolicy.cjs');
const base = { enabled: true, displayMode: 'simple', valueMode: 'station', stationInputMeaning: 'target',
    currentPositionPointId: '1', arrivalSignalPointId: '2', arrivalSmoothing: true,
    start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 },
    stations: [{ value: 1, position: { x: 0, y: 0, z: 0 } }, { value: 2, position: { x: 10, y: 0, z: 0 } }] };
(async () => {
    assert.deepEqual(validateMovementConfig(base), base, 'no speed, acceleration, metres or moving bit required');
    for (const patch of [{ arrivalSignalPointId: '' }, { arrivalSmoothing: 'true' }, { displayMode: 'guess' },
        { stationInputMeaning: 'current' }, { valueMode: 'range' }, { startActionPointId: '3' }, { arrivalPositionPointId: '3' }])
        assert.throws(() => validateMovementConfig({ ...base, ...patch }));
    const points = new Map([['1', { device_id: 'cart', data_type: 'WORD', access_type: 'READ' }], ['2', { device_id: 'cart', data_type: 'BOOL', access_type: 'READ' }]]);
    const db = { get: async (sql, values) => { const point = points.get(String(values[0])); return point?.device_id === values[1] ? point : null; } };
    await validateMovementSources(db, { id: 'cart' }, base, 'factory', () => false);
    for (const patch of [{ data_type: 'WORD' }, { access_type: 'WRITE' }, { device_id: 'other' }]) {
        const before = points.get('2'); points.set('2', { ...before, ...patch });
        await assert.rejects(() => validateMovementSources(db, { id: 'cart' }, base, 'factory', () => false));
        points.set('2', before);
    }
    const semantics = deriveMotionSemantics({ movement: base, animationBindings: { bindings: [] } });
    assert.equal(semantics.valid, true);
    assert.deepEqual(semantics.bindings.map(row => [row.key, row.kind, row.source.pointId]),
        [['movement:station', 'station', '1'], ['movement:arrival-signal', 'condition', '2']]);
    const fixture = await require('./realtime-linkage-fixture.cjs').createLinkageFixture('simple-station-motion');
    try {
        const { sql, points: p, cartId } = fixture;
        sql.prepare('UPDATE data_points SET data_type=? WHERE id=?').run('BOOL', p.start);
        const movement = { ...base, currentPositionPointId: p.position, arrivalSignalPointId: p.start };
        const route = `/api/devices/${cartId}/movement`, selected = [p.position, p.start];
        const read = () => JSON.parse(sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(cartId).instance_config);
        const before = read();
        await fixture.ok(route, 'PUT', { movement, pointIds: selected, expectedMovement: null });
        assert.deepEqual(read(), { ...before, movement });
        for (const id of selected) assert.equal(sql.prepare('SELECT sample_interval_ms FROM data_points WHERE id=?').get(id).sample_interval_ms, 100);
        const invalid = await fixture.request(route, 'PUT', { movement: { ...movement, arrivalSignalPointId: p.position }, expectedMovement: movement });
        assert.equal(invalid.status, 400); assert.deepEqual(read().movement, movement);
        const immediate = { ...movement, arrivalSmoothing: false };
        await fixture.ok(route, 'PUT', { movement: immediate, pointIds: selected, expectedMovement: movement });
        assert.deepEqual(read().movement, immediate);
        const stale = await fixture.request(route, 'PUT', { movement, expectedMovement: movement });
        assert.equal(stale.status, 409); assert.deepEqual(read().movement, immediate);
        console.log(JSON.stringify({ success: true, twoSignalsOnly: true, noPhysicalParameters: true, arrivalBoolScoped: true,
            arrivalEdgesDeclared: true, smoothingChoicePersisted: true, casPreserved: true }));
    } finally { await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
