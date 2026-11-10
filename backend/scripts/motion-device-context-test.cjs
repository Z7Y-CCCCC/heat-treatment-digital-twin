'use strict';
// Actual isolated management reads use the same device scope as the scene and
// semantic queue. No commissioned database, PLC, browser or profile is touched.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
let fixture;
const checks = [];
(async () => {
    fixture = await createLinkageFixture('motion-device-context');
    const { sql, request, cartId, line, foreignLine } = fixture;
    const animationRoute = '/api/devices/' + cartId + '/animations';
    const catalogRoute = '/api/data-center/catalog?device_id=' + encodeURIComponent(cartId);
    const cases = [
        ['primary association wins over foreign alternatives', line.id, { railLineId: foreignLine.id, laneLineId: foreignLine.id, workshopId: foreignLine.workshop_id }, true, line.id],
        ['rail association supplies owned catalog and animation context', null, { railLineId: line.id, workshopId: foreignLine.workshop_id }, true, line.id],
        ['lane association supplies owned catalog and animation context', null, { laneLineId: line.id, workshopId: foreignLine.workshop_id }, true, line.id],
        ['workshop placement remains supported without a line', null, { workshopId: line.workshop_id }, true, ''],
        ['foreign primary cannot be rescued by local alternatives', foreignLine.id, { railLineId: line.id, laneLineId: line.id, workshopId: line.workshop_id }, false, ''],
        ['foreign rail cannot be rescued by local lane or workshop', null, { railLineId: foreignLine.id, laneLineId: line.id, workshopId: line.workshop_id }, false, ''],
        ['foreign lane cannot be rescued by local workshop', null, { laneLineId: foreignLine.id, workshopId: line.workshop_id }, false, ''],
        ['missing declared association cannot fall back to a workshop', null, { railLineId: 'missing_fixture_line', workshopId: line.workshop_id }, false, '']
    ];
    for (const [name, primary, instance, accepted, expectedLine] of cases) {
        sql.prepare('UPDATE devices SET line_id=?,instance_config=? WHERE id=?').run(primary, JSON.stringify(instance), cartId);
        const before = { devices: sql.prepare('SELECT * FROM devices ORDER BY id').all(), points: sql.prepare('SELECT * FROM data_points ORDER BY id').all(),
            lines: sql.prepare('SELECT * FROM `lines` ORDER BY id').all(), settings: sql.prepare('SELECT * FROM factory_settings ORDER BY factory_id,`key`').all() };
        const animation = await request(animationRoute), catalog = await request(catalogRoute);
        assert.equal(animation.status, accepted ? 200 : 404, name + ' animation');
        assert.equal(catalog.status, accepted ? 200 : 404, name + ' catalog');
        if (accepted) {
            const information = catalog.data.items.find(item => item.id === 'internal_device_line');
            assert.ok(information, 'The normal existing device-info source must remain discoverable');
            const device = catalog.data.devices.find(device => device.id === cartId);
            assert.equal(device?.lineName, expectedLine ? line.name : '', name + ' line context');
            assert.equal(information.previewValue, expectedLine ? line.name : null, name + ' authored line name');
            assert.ok(animation.data.dataItems.some(item => String(item.binding?.deviceId) === cartId), name + ' owned points absent');
        }
        assert.deepEqual({ devices: sql.prepare('SELECT * FROM devices ORDER BY id').all(), points: sql.prepare('SELECT * FROM data_points ORDER BY id').all(),
            lines: sql.prepare('SELECT * FROM `lines` ORDER BY id').all(), settings: sql.prepare('SELECT * FROM factory_settings ORDER BY factory_id,`key`').all() }, before,
            name + ' GET must not normalize or save an association');
        checks.push(name); console.log('PASS ' + name);
    }
    fs.writeFileSync(path.join(fixture.directory, 'result.json'), JSON.stringify({ success: true, checks, isolatedHttp: true,
        browserOperations: 0, liveConfigurationWrites: 0 }, null, 2));
    console.log('PASS motion device context ' + fixture.directory);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await fixture?.close(); });
