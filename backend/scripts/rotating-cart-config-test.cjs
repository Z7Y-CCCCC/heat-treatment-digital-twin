const assert = require('node:assert/strict');
const { normalizeCartTransfer } = require('../../shared/cartTransferConfig.mjs');
const simple = { version: 1, kind: 'rotating', presentation: 'simple', turntableNodeName: '' };
(async () => {
    assert.deepEqual(normalizeCartTransfer(null), { version: 1, kind: 'single', presentation: 'model', turntableNodeName: '' });
    for (const bad of [{}, [], '', { ...simple, version: '1' }, { ...simple, kind: 'guess' }, { ...simple, presentation: 'any' },
        { ...simple, turntableNodeName: 'fake' }, { ...simple, speed: 1 }, { ...simple, presentation: 'model' }]) assert.throws(() => normalizeCartTransfer(bad));
    const fixture = await require('./realtime-linkage-fixture.cjs').createLinkageFixture('rotating-cart-config');
    try {
        assert.equal((await fixture.ok('/api/devices/' + fixture.cartId + '/loading-ports')).cartSupported, true, 'existing imported cart capability must be recognized before movement points are bound');
        const before = JSON.parse(fixture.sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(fixture.cartId).instance_config);
        before.role = 'transfer_cart'; before.movement = { enabled: false, stations: [{ value: 12, anchorDeviceId: fixture.targetId, position: { x: 0, y: 0, z: 0 } }] };
        fixture.sql.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(before), fixture.cartId);
        const route = '/api/devices/' + fixture.cartId + '/loading-ports';
        const loaded = await fixture.ok(route); assert.equal(loaded.cartSupported, true); assert.equal(loaded.cartTransfer.kind, 'single');
        assert.deepEqual(JSON.parse(fixture.sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(fixture.cartId).instance_config), before, 'read does not migrate any site configuration');
        const saved = await fixture.ok(route, 'PUT', { revision: loaded.revision, overrides: loaded.overrides, cartTransfer: simple });
        assert.deepEqual(saved.cartTransfer, simple); assert.deepEqual(saved.ports, loaded.ports);
        const instance = JSON.parse(fixture.sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(fixture.cartId).instance_config);
        assert.deepEqual(instance, { ...before, loadingPortOverrides: loaded.overrides, cartTransfer: simple });
        assert.deepEqual(instance.movement, before.movement, 'both-side target map is retained, no duplicate station configuration');
        assert.equal((await fixture.request(route, 'PUT', { revision: loaded.revision, overrides: loaded.overrides, cartTransfer: normalizeCartTransfer(null) })).status, 409);
        const legacy = await fixture.ok(route, 'PUT', { revision: saved.revision, overrides: saved.overrides }); assert.deepEqual(legacy.cartTransfer, simple);
        const fixedRoute = '/api/devices/' + fixture.targetId + '/loading-ports'; const fixed = await fixture.ok(fixedRoute); assert.equal(fixed.cartSupported, false);
        assert.equal((await fixture.request(fixedRoute, 'PUT', { revision: fixed.revision, overrides: fixed.overrides, cartTransfer: simple })).status, 400);
        const modelRoute = '/api/models/' + fixture.cartModel.id + '/loading-ports'; const model = await fixture.ok(modelRoute);
        assert.equal((await fixture.request(modelRoute, 'PUT', { revision: model.revision, ports: model.ports, cartTransfer: simple })).status, 400);
        console.log(JSON.stringify({ success: true, optInOnly: true, simpleModelNeedsNoNewPlcPoints: true, stationAndPortDefinitionsReused: true, cas: true, notAModelSeed: true }));
    } finally { await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
