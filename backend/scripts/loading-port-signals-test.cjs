'use strict';
const assert = require('node:assert/strict');
const { normalizeLoadingPortSignals } = require('../../shared/loadingPortSignals.mjs');
const { deriveMotionSemantics, hasDeclaredMotionBoundary } = require('../../shared/motionSemanticPolicy.cjs');
const { waitUntil } = require('./integration-test-utils.cjs');
const none = { version: 1, inletPointId: null, outletPointId: null };
(async () => {
    assert.deepEqual(normalizeLoadingPortSignals(null), none);
    for (const value of [{}, [], '', { ...none, version: '1' }, { ...none, inletPointId: 1 }, { ...none, outletPointId: '' },
        { ...none, inletPointId: 'a', outletPointId: 'a' }, { ...none, host: 'hardcoded' }, { version: 1, inletPointId: null }])
        assert.throws(() => normalizeLoadingPortSignals(value));
    const fixture = await require('./realtime-linkage-fixture.cjs').createLinkageFixture('loading-port-signals');
    try {
        const { sql, points, cartId, targetId, foreignId } = fixture;
        const add = (id, role) => String(sql.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES(?,?,?,?,?,?,?,?,?)').run(id, role, role, 'fixture-only', 'BOOL', 'status', role, 'READ', 1000).lastInsertRowid);
        const cartIn = add(cartId, 'take'), cartOut = add(cartId, 'feed'), fixedIn = add(targetId, 'receiving'), fixedOut = add(targetId, 'sending');
        for (const [id, inlet, outlet] of [[cartId, cartIn, cartOut], [targetId, fixedIn, fixedOut]]) {
            await waitUntil(async()=> (await fixture.ok('/api/health')).engine?.process?.status==='running',10000,'isolated collector startup');
            const beforeEngine=(await fixture.ok('/api/health')).engine;
            const route = '/api/devices/' + id + '/loading-ports';
            const before = JSON.parse(sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(id).instance_config);
            const loaded = await fixture.ok(route);
            assert.deepEqual(loaded.signals, none);
            assert.ok(loaded.signalPoints.every(point => ![points.foreign, points.write, points.position].includes(String(point.id))));
            const signals = { version: 1, inletPointId: inlet, outletPointId: outlet };
            const saved = await fixture.ok(route, 'PUT', { revision: loaded.revision, overrides: loaded.overrides, signals });
            assert.deepEqual(saved.signals, signals); assert.deepEqual(saved.ports, loaded.ports, 'no second set of port positions');
            await waitUntil(async()=>Number((await fixture.ok('/api/health')).engine.configLoadedAt)>Number(beforeEngine.configLoadedAt||0),10000,'saved port signals hot-reload the running collector');
            assert.equal((await fixture.ok('/api/health')).engine.process.pid,beforeEngine.process.pid,'signal binding must not restart the worker');
            assert.deepEqual(JSON.parse(sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(id).instance_config), { ...before, loadingPortOverrides: loaded.overrides, loadingPortSignals: signals });
            for (const point of [inlet, outlet]) assert.equal(sql.prepare('SELECT sample_interval_ms FROM data_points WHERE id=?').get(point).sample_interval_ms, 100);
            for (const invalid of [points.foreign, points.write, points.position, 'missing']) {
                const bad = await fixture.request(route, 'PUT', { revision: saved.revision, overrides: saved.overrides, signals: { ...signals, inletPointId: invalid } });
                assert.equal(bad.status, 400, JSON.stringify(bad));
            }
            assert.equal((await fixture.request(route, 'PUT', { revision: loaded.revision, overrides: loaded.overrides, signals: none })).status, 409);
            assert.equal((await fixture.request(route, 'GET', undefined, 'linkage_foreign_factory')).status, 404);
            // Old coordinate-only callers retain the new bindings.
            const compatible = await fixture.ok(route, 'PUT', { revision: saved.revision, overrides: saved.overrides });
            assert.deepEqual(compatible.signals, signals);
            const semantic = deriveMotionSemantics({ loadingPortSignals: signals, animationBindings: { bindings: [] } });
            assert.equal(semantic.valid, true); assert.deepEqual(semantic.bindings.map(row => row.source.pointId), [inlet, outlet]);
        }
        const modelRoute = '/api/models/' + fixture.cartModel.id + '/loading-ports';
        const model = await fixture.ok(modelRoute);
        assert.equal((await fixture.request(modelRoute, 'PUT', { revision: model.revision, ports: model.ports, signals: none })).status, 400, 'PLC bindings cannot enter shared model definitions');
        const other = await fixture.ok('/api/devices/' + foreignId + '/loading-ports', 'GET', undefined, 'linkage_foreign_factory');
        assert.deepEqual(other.signals, none);
        console.log(JSON.stringify({ success: true, cartAndFixedDevice: true, ownedReadBoolOnly: true, positionReused: true, cas: true, modelHasNoSiteBindings: true, sampleIntervalMs: 100, collectorHotReload: true, workerRetained: true }));
    } finally { await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
