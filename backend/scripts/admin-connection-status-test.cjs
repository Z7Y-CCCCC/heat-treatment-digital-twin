'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('admin-connections');
process.env.APP_DATA_DIR = path.join(directory, 'data');
process.env.LICENSE_FILE = path.join(directory, 'license.json');
process.env.LICENSE_ENFORCE = 'false';
process.env.ADMIN_API_TOKEN = crypto.randomBytes(32).toString('hex');
process.env.MCP_API_TOKEN = '';
const { getAdminAuth } = require('../services/adminAuth');
const { protectManagementWrites, adminSessionCookieName } = require('../middleware/security');
const { adminConnectionStatus } = require('../services/adminConnectionStatus');
const createRouter = require('../routes/adminConnections');
const { apiPermission } = require('../../shared/apiPermissions.cjs');
const { allowsRequirement, normalizePagePermissions } = require('../../shared/pagePermissions.cjs');
const now = 1700000000000;
const engine = { process: { status: 'running', lastHeartbeatAt: now - 100, pid: 789, secret: 'DO_NOT_EXPOSE' },
    collectorStatus: { lastFrameAt: now - 10 }, mode: 'integrated_plc' };
function factory(mode = 'integrated_plc', quality = 'good') {
    return { mode, collectorStatus: { status: 'connected', lastFrameAt: now - 300 }, configuredDevices: 1,
        plcStatus: { devices: [{ deviceId: 'A', deviceName: 'A 炉', status: 'connected', quality,
            lastReadAt: now - 300, intervals: [1000], message: 'DO_NOT_EXPOSE password=SECRET HOST/IP' }] } };
}
const summary = overrides => adminConnectionStatus({ now, factoryId: 'f-a', factory: factory(), engine,
    configuredMode: 'integrated_plc', databaseConnected: true, pluginInstalled: true,
    unityHealth: { status: 'online', connectedClients: 1, sceneReadyClients: 1, lastCommunicationAt: now - 100 },
    sessionStatus: { authenticated: true, expiresAt: now + 10000, csrfToken: 'DO_NOT_EXPOSE' },
    runtime: { role: 'collector', owner: 'windows-service', serviceName: 'DO_NOT_EXPOSE' }, ...overrides });
let owner, password;
before(async () => {
    password = crypto.randomBytes(24).toString('base64url');
    owner = await getAdminAuth().setup(password, 'isolated-connection-status-owner');
});

test('four white-listed summaries distinguish API/database, PLC quality, process and Unity scene readiness', () => {
    const healthy = summary();
    assert.deepEqual(healthy.services.map(service => service.key), ['unity', 'devices', 'data', 'session']);
    assert.equal(healthy.unity.state, 'ready'); assert.equal(healthy.collection.state, 'healthy');
    assert.equal(healthy.data.state, 'online'); assert.equal(healthy.session.state, 'authenticated');
    assert.equal(healthy.collection.processRunning, true); assert.equal(healthy.collection.counts.normal, 1);
    assert.equal(JSON.stringify(healthy).includes('DO_NOT_EXPOSE'), false);
    const plcBad = summary({ factory: factory('integrated_plc', 'bad') });
    assert.equal(plcBad.collection.processRunning, true); assert.equal(plcBad.collection.state, 'degraded');
    assert.equal(plcBad.services[1].connected, false); assert.equal(plcBad.data.state, 'online');
    const partialFactory = factory(); partialFactory.plcStatus.devices.push({ ...partialFactory.plcStatus.devices[0], deviceId: 'B', quality: 'bad' });
    const partial = summary({ factory: partialFactory }); assert.equal(partial.collection.state, 'degraded');
    assert.equal(partial.services[1].tone, 'is-partial'); assert.equal(partial.services[1].rows[0].connected, true);
    assert.equal(partial.services[1].rows[1].connected, false);
    const dbBad = summary({ databaseConnected: false });
    assert.equal(dbBad.data.apiReachable, true); assert.equal(dbBad.data.databaseConnected, false);
    assert.equal(dbBad.data.state, 'degraded'); assert.equal(dbBad.collection.state, 'degraded');
    assert.equal(summary({ unityHealth: { status: 'online', connectedClients: 1, sceneReadyClients: 0 } }).unity.state, 'syncing');
    assert.equal(summary({ unityHealth: { status: 'stale', connectedClients: 0 } }).unity.state, 'stale');
});
test('simulation, stale data, missing factory runtime, empty install and denied details are never green real PLC', () => {
    const simulation = summary({ factory: factory('simulation'), configuredMode: 'simulation' });
    assert.equal(simulation.collection.state, 'simulation'); assert.match(simulation.collection.label, /模拟/);
    assert.equal(simulation.services[1].tone, 'is-partial'); assert.equal(simulation.services[1].rows[0].connected, false);
    const stale = factory(); stale.plcStatus.devices[0].lastReadAt = now - 16000;
    assert.equal(summary({ factory: stale }).collection.counts.abnormal, 1);
    const missing = summary({ factory: null });
    assert.equal(missing.collection.state, 'unknown'); assert.equal(missing.collection.lastCommunicationAt, null);
    assert.deepEqual(missing.collection.devices, []);
    assert.equal(summary({ factoryId: '', factory: null }).collection.state, 'idle');
    const denied = summary({ collectionAllowed: false });
    assert.equal(denied.collection.state, 'forbidden'); assert.deepEqual(denied.services[1].rows, []);
    assert.equal(denied.services[1].restricted, true); assert.equal(denied.collection.devices, undefined);
    assert.equal(summary({ sessionStatus: { displayAuthenticated: true, authenticated: false } }).session.state, 'locked');
    assert.equal(summary({ sessionStatus: {} }).session.state, 'login_required');
    assert.equal(summary({ recoveryPending: true }).data.state, 'degraded');
    const missingHeartbeat = summary({ engine: { ...engine, process: { status: 'running' } } });
    assert.equal(missingHeartbeat.collection.processRunning, false); assert.equal(missingHeartbeat.collection.state, 'starting');
    const future = factory(); future.plcStatus.devices[0].lastReadAt = now + 1000;
    assert.equal(summary({ factory: future }).collection.counts.abnormal, 1, 'future timestamps do not count as observed reads');
});

async function fixture(t, overrides = {}) {
    const state = { connected: true, dataMode: 'integrated_plc', selected: 'f-a', engineReads: 0, dbReads: 0, ...overrides };
    const express = require('express'), app = express();
    app.use(protectManagementWrites);
    app.use('/api/system/connections', createRouter({
        getDbStatus: () => ({ connected: state.connected, config: { password: 'DO_NOT_EXPOSE' }, error: 'DO_NOT_EXPOSE' }),
        getDb: async () => { assert.equal(state.connected, true, 'a diagnostic may not reconnect a failed DB'); state.dbReads++;
            return { get: async () => ({ value: state.dataMode }) }; },
        resolveFactoryId: async (db, requested) => {
            if (requested === 'missing') throw Object.assign(Error('DO_NOT_EXPOSE'), { code: 'FACTORY_CONTEXT_NOT_FOUND' });
            if (requested === 'empty') throw Object.assign(Error('DO_NOT_EXPOSE'), { code: 'FACTORY_CONTEXT_MISSING' });
            return requested || state.selected;
        },
        getEngine: () => ({ getStatus: () => { state.engineReads++; return engine; },
            getFactoryStatuses: () => ({ 'f-a': factory(), 'f-b': { ...factory(), plcStatus: { devices: [{
                deviceId: 'B', deviceName: 'B 炉', status: 'connected', quality: 'good', lastReadAt: now - 20 }] } } }) }),
        collectorAvailable: () => true, runtimeIdentity: () => ({ role: 'collector', owner: 'standalone' }),
        siteRecoveryStatus: () => ({ pending: false }), now: () => now,
        getWsServer: () => ({ connectionHealth: () => ({ status: 'online', connectedClients: 1, sceneReadyClients: 0 }) })
    }));
    const server = app.listen(0, '127.0.0.1'); await require('node:events').once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = async ({ token = owner.token, factoryId = 'f-a', automation = false } = {}) => {
        const response = await fetch(`${origin}/api/system/connections/status`, { headers: {
            ...(token ? { Cookie: `${adminSessionCookieName()}=${token}` } : {}),
            ...(automation ? { 'X-Admin-Token': process.env.ADMIN_API_TOKEN } : {}), 'X-Factory-ID': factoryId
        } });
        return { response, data: await response.json() };
    };
    return { state, request };
}
test('actual secured HTTP route refuses anonymous readers and isolates requested factories without raw health', async t => {
    const f = await fixture(t);
    assert.equal((await f.request({ token: '' })).response.status, 401);
    let result = await f.request(); assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(result.data.collection.devices.map(device => device.deviceId), ['A']);
    result = await f.request({ factoryId: 'f-b' }); assert.equal(result.data.factoryId, 'f-b');
    assert.deepEqual(result.data.collection.devices.map(device => device.deviceId), ['B']);
    result = await f.request({ factoryId: 'f-unstarted' }); assert.equal(result.data.collection.state, 'unknown');
    assert.equal(result.data.collection.lastCommunicationAt, null); assert.deepEqual(result.data.collection.devices, []);
    assert.equal((await f.request({ factoryId: 'missing' })).response.status, 404);
    result = await f.request({ factoryId: 'empty' }); assert.equal(result.response.status, 200); assert.equal(result.data.factoryId, '');
    assert.equal(JSON.stringify(result.data).includes('DO_NOT_EXPOSE'), false);
    const dbReads = f.state.dbReads; f.state.connected = false;
    result = await f.request(); assert.equal(result.response.status, 200); assert.equal(result.data.data.state, 'degraded');
    assert.equal(result.data.data.apiReachable, true); assert.equal(f.state.dbReads, dbReads);
    assert.equal(result.data.factoryId, 'f-a', 'failed DB diagnostics preserve the explicitly requested page scope');
    assert.equal(result.data.data.databaseConnected, false);
    result = await f.request({ factoryId: 'f-unstarted' });
    assert.equal(result.response.status, 200); assert.equal(result.data.factoryId, 'f-unstarted');
    assert.equal(result.data.data.apiReachable, true); assert.equal(result.data.data.databaseConnected, false);
    assert.equal(f.state.dbReads, dbReads, 'failed DB status must never call getDb or resolve factory through the DB');
    assert.deepEqual(result.data.collection.devices, [], 'requested factory without runtime must not borrow f-a or f-b readings while DB is down');
    assert.equal(result.data.collection.lastCommunicationAt, null);
});
test('page-only users see connection summary but no unauthorized collection details, and expired/locked sessions remain rejected', async t => {
    const auth = getAdminAuth();
    const user = await auth.createUser(owner.token, owner.status.csrfToken, { username: 'connection_model_viewer', role: 'viewer',
        permissions: { view: false }, pagePermissions: { models: { view: true } }, password });
    const viewer = await auth.login(password, 'isolated-status-viewer', '', user.username);
    const f = await fixture(t);
    const result = await f.request({ token: viewer.token }); assert.equal(result.response.status, 200);
    assert.equal(result.data.collection.state, 'forbidden'); assert.deepEqual(result.data.services[1].rows, []);
    assert.equal(f.state.engineReads, 0, 'denied collection field must not even collect engine data');
    const context = { active: true, pagePermissions: normalizePagePermissions({ models: { view: true } }) };
    assert.equal(allowsRequirement(apiPermission('/api/system/connections/status'), context), true);
    assert.equal(allowsRequirement(apiPermission('/api/system/connections/status/private'), context), false);
    assert.equal(allowsRequirement(apiPermission('/api/system/connections/status', 'POST'), context), false);
    auth.lock(viewer.token, viewer.status.csrfToken);
    assert.equal((await f.request({ token: viewer.token })).response.status, 401);
    assert.equal((await f.request({ token: 'expired-or-fake' })).response.status, 401);
    const automation = await f.request({ token: '', automation: true }); assert.equal(automation.response.status, 200);
    assert.equal(automation.data.session.state, 'login_required', 'automation credentials must not imply browser login');
});
