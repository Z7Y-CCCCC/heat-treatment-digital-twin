// Creates its own SQLite/output/ backend; never touches commissioned assets/data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const loading = require('../../shared/loadingPorts.cjs');
const { apiPermission } = require('../../shared/apiPermissions.cjs');
const { normalizePagePermissions, allowsRequirement } = require('../../shared/pagePermissions.cjs');
const { stringifyModelMetadata } = require('../services/modelAssetMetadata');
const { normalizeInstanceLoadingPorts } = require('../services/loadingPorts');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess,
    forceStop, waitForHttp, testFetch } = require('./integration-test-utils.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const none = () => ({ version: 1, inlet: null, outlet: null });
const port = () => ({ position: [1, 2, 3], direction: [2, 0, 3], nodeName: 'feed_node' });
const ports = () => ({ version: 1, inlet: port(), outlet: { position: [-2, 4, -3], direction: [0, 0, -1], nodeName: '' } });
const overrides = () => ({ version: 1, inlet: { offset: [.2, .3, -.4], yawDegrees: 30 }, outlet: null });
const checks = [];
function check(name, fn = () => {}) { fn(); checks.push(name); console.log(`PASS ${name}`); }
const cookieHeader = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
let backend, socket;

async function main() {
    check('shared schema strictly rejects coercion, missing/unknown fields and sparse vectors', () => {
        for (const bad of ['', '{}', [], false, { ...ports(), version: '1' }, { ...ports(), unknown: true }, { version: 1, inlet: null },
            ...[NaN, Infinity, null, '', '1'].map(value => ({ ...ports(), inlet: { ...port(), position: [value, 0, 0] } })),
            { ...ports(), inlet: { ...port(), position: Array(3) } }, { ...ports(), inlet: { ...port(), direction: [0, 1, 1] } },
            { ...ports(), inlet: { ...port(), direction: [0, 0, 0] } }, { ...ports(), inlet: { ...port(), height: 2 } }]) {
            assert.equal(loading.validateLoadingPorts(bad).valid, false);
            assert.throws(() => loading.normalizeLoadingPorts(bad));
        }
        for (const bad of ['', {}, { ...overrides(), version: '1' }, { ...overrides(), outlet: {} },
            ...[NaN, Infinity, null, '', '1'].map(value => ({ ...overrides(), inlet: { offset: [0, 0, 0], yawDegrees: value } })),
            { ...overrides(), inlet: { offset: ['', 0, 0], yawDegrees: 1 } }]) assert.equal(loading.validateLoadingPortOverrides(bad).valid, false);
        assert.equal(loading.validateLoadingPorts(ports()).valid, true);
        for (const direction of [[Number.MAX_VALUE, 0, Number.MAX_VALUE], [Number.MIN_VALUE, 0, Number.MIN_VALUE]]) {
            const normalized = loading.normalizeLoadingPorts({ ...ports(), inlet: { ...port(), direction } });
            assert.ok(Math.abs(Math.hypot(...normalized.inlet.direction) - 1) < 1e-12);
        }
        assert.deepEqual(loading.normalizeLoadingPorts(null), none());
        assert.deepEqual(loading.normalizeLoadingPortOverrides(JSON.stringify(none())), none());
        const model = { metadata: JSON.stringify({ loadingPorts: { ...ports(), inlet: { ...port(), direction: [0, 0, 3] } } }) };
        const device = { instance_config: JSON.stringify({ loadingPortOverrides: { ...overrides(), inlet: { offset: [4, 5, 6], yawDegrees: 90 } } }) };
        const resolved = loading.resolveLoadingPort(model, device);
        assert.deepEqual(resolved.position, [5, 7, 9]);
        assert.ok(Math.abs(resolved.direction[0] - 1) < 1e-12 && Math.abs(resolved.direction[2]) < 1e-12);
        assert.equal(loading.resolveLoadingPort({ metadata: { loadingPorts: none() } }, device), null);
        assert.equal(loading.resolveLoadingPort({ metadata: { loadingPorts: null, transferDatum: { height: 5 } } }, device), null);
        assert.throws(() => loading.resolveLoadingPort({ metadata: { loadingPorts: {} } }, device));
        assert.throws(() => stringifyModelMetadata({ loadingPorts: { ...ports(), inlet: { ...port(), position: ['1', 0, 0] } } }));
        assert.throws(() => normalizeInstanceLoadingPorts({ loadingPortOverrides: { ...overrides(), inlet: { offset: [0, 0, 0], yawDegrees: '' } } }));
    });
    check('model/device writes remain isolated from line and animation editor grants', () => {
        const context = page => ({ active: true, owner: false, permissions: { view: false }, pagePermissions: normalizePagePermissions({ [page]: { view: true, edit: true } }) });
        for (const page of ['models', 'devices', 'lines', 'composer', 'model-animations']) {
            assert.equal(allowsRequirement(apiPermission('/api/models/m/loading-ports', 'PUT'), context(page)), page === 'models');
            assert.equal(allowsRequirement(apiPermission('/api/devices/d/loading-ports', 'PUT'), context(page)), page === 'devices');
            assert.equal(allowsRequirement(apiPermission('/api/devices/loading-alignment', 'PUT'), context(page)), ['lines', 'composer'].includes(page));
        }
    });

    const directory = createRunDirectory('loading-ports');
    const dataDirectory = path.join(directory, 'data');
    await createTestDatabase(path.join(dataDirectory, 'factory.db'));
    const portNumber = await findFreePort();
    const origin = `http://127.0.0.1:${portNumber}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...process.env, APP_DATA_DIR: dataDirectory, PORT: String(portNumber), HOST: '127.0.0.1' }, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(`${origin}/api/health`);
    async function response(route, method = 'GET', body, factoryId) {
        const result = await testFetch(origin + route, { method, headers: { 'Content-Type': 'application/json', ...(factoryId ? { 'X-Factory-ID': factoryId } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: result.status, payload: await result.json() };
    }
    async function api(route, method = 'GET', body, factoryId) {
        const result = await response(route, method, body, factoryId);
        assert.ok(result.status >= 200 && result.status < 300, `${method} ${route}: ${result.status} ${JSON.stringify(result.payload)}`);
        return result.payload;
    }
    const factoryId = (await api('/api/factories', 'POST', { name: '加载口隔离回归厂' })).factory.id;
    await api('/api/workshops', 'POST', { id: 'loading_ws', name: '加载口车间' }, factoryId);
    await api('/api/lines', 'POST', { id: 'loading_line', name: '加载口产线', workshop_id: 'loading_ws' }, factoryId);
    const wrongFactory = (await api('/api/factories', 'POST', { name: '加载口跨厂拒绝测试' })).factory.id;
    const models = await api('/api/models', 'GET', undefined, factoryId);
    const baseModel = models.find(model => model.placement_level === 'device' && model.file_path);
    assert.ok(baseModel, 'packaged fixture model is required');
    const modelId = baseModel.id;
    const metadata = typeof baseModel.metadata === 'string' ? JSON.parse(baseModel.metadata) : clone(baseModel.metadata);
    metadata.loading_port_test_extension = { nested: { Case: 'ABC' }, array: ['retain', 1] };
    await api(`/api/models/${modelId}`, 'PUT', { metadata }, factoryId);
    const modelRoute = `/api/models/${modelId}/loading-ports`;
    const modelBefore = await api(modelRoute, 'GET', undefined, factoryId);
    const modelSaved = await api(modelRoute, 'PUT', { revision: modelBefore.revision, ports: ports() }, factoryId);
    const storedMetadata = JSON.parse(modelSaved.model.metadata);
    const originalMetadata = JSON.parse(modelBefore.model.metadata);
    for (const key of Object.keys(originalMetadata)) if (key !== 'loadingPorts') assert.deepEqual(storedMetadata[key], originalMetadata[key], key);
    assert.deepEqual(await api(modelRoute, 'GET', undefined, factoryId), modelSaved);
    assert.equal((await response(modelRoute, 'PUT', { revision: modelBefore.revision, ports: ports() }, factoryId)).status, 409);
    assert.equal((await response(modelRoute, 'PUT', { ports: ports() }, factoryId)).status, 428);
    assert.equal((await response(modelRoute, 'PUT', { revision: modelSaved.revision, ports: ports(), name: 'not allowed' }, factoryId)).status, 400);
    assert.equal((await response(`/api/models/${modelId}`, 'PUT', { metadata: { ...storedMetadata, loadingPorts: { ...ports(), inlet: { ...port(), position: ['', 0, 0] } } } }, factoryId)).status, 400);
    check('model loading-port CAS preserves all unrelated metadata and broad PUT cannot bypass validation');

    const instance = { loading_test_extension: { Case: 'ABC' }, movement: { path: [[1, 2, 3], [4, 5, 6]] }, workshop_id: 'loading_ws' };
    for (const id of ['loading_a', 'loading_b']) await api('/api/devices', 'POST', { id, name: id, model_type: modelId, line_id: 'loading_line',
        instance_config: instance, coordinate_space: 'line_local', pos_x: 7, pos_y: 8, pos_z: 9, rotation_y: 31, scale: 1.5,
        plc_enabled: false, plc_protocol: 'S7', plc_ip: '192.0.2.1', plc_port: 1102 }, factoryId);
    await api('/api/devices', 'POST', { id: 'loading_rail', name: '轨道小车', model_type: modelId, instance_config: { ...instance, role: 'auxiliary', railLineId: 'loading_line' },
        coordinate_space: 'line_local', pos_x: 1, pos_y: 3, pos_z: 4, scale: 1, plc_enabled: false }, factoryId);
    const route = '/api/devices/loading_a/loading-ports';
    const deviceBefore = await api('/api/devices/loading_a', 'GET', undefined, factoryId);
    const peerBefore = await api('/api/devices/loading_b', 'GET', undefined, factoryId);
    const before = await api(route, 'GET', undefined, factoryId);
    const events = [];
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    socket.on('message', raw => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const saved = await api(route, 'PUT', { revision: before.revision, overrides: overrides() }, factoryId);
    const deviceAfter = await api('/api/devices/loading_a', 'GET', undefined, factoryId);
    for (const key of Object.keys(deviceBefore)) if (key !== 'instance_config') assert.deepEqual(deviceAfter[key], deviceBefore[key], key);
    assert.deepEqual(JSON.parse(deviceAfter.instance_config), { ...instance, loadingPortOverrides: overrides() });
    assert.deepEqual(await api('/api/devices/loading_b', 'GET', undefined, factoryId), peerBefore);
    assert.deepEqual(await api(route, 'GET', undefined, factoryId), saved);
    assert.deepEqual(saved.ports.inlet, loading.resolveLoadingPort(saved.model, saved.device));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(events.some(event => event.type === 'device_configuration_changed'));
    assert.ok(events.some(event => event.type === 'configuration_changed'));
    assert.equal((await response(route, 'PUT', { revision: before.revision, overrides: overrides() }, factoryId)).status, 409);
    assert.equal((await response(route, 'PUT', { overrides: overrides() }, factoryId)).status, 428);
    assert.equal((await response(route, 'GET', undefined, wrongFactory)).status, 404);
    assert.equal((await response(route, 'PUT', { revision: saved.revision, overrides: none() }, wrongFactory)).status, 404);
    assert.equal((await response(route, 'PUT', { revision: saved.revision, overrides: overrides(), plc_ip: '192.0.2.2' }, factoryId)).status, 400);
    assert.equal((await response('/api/devices/loading_a', 'PUT', { ...deviceAfter, instance_config: { ...instance, loadingPortOverrides: { ...overrides(), inlet: { offset: [0, 0, 0], yawDegrees: '' } } } }, factoryId)).status, 400);
    assert.equal((await response('/api/devices', 'POST', { id: 'invalid_loading', name: 'invalid', model_type: modelId, line_id: 'loading_line',
        instance_config: { loadingPortOverrides: { ...overrides(), inlet: { offset: ['1', 0, 0], yawDegrees: 0 } } } }, factoryId)).status, 400);
    check('instance-only CAS preserves placement, PLC, movement, peer and model while broadcasting committed config');

    const raceStart = await api(route, 'GET', undefined, factoryId);
    const races = await Promise.all([10, 20].map(yawDegrees => response(route, 'PUT', { revision: raceStart.revision,
        overrides: { ...overrides(), inlet: { offset: [0, 0, 0], yawDegrees } } }, factoryId)));
    assert.deepEqual(races.map(row => row.status).sort(), [200, 409]);
    const scaleStart = await api(route, 'GET', undefined, factoryId);
    await api(`/api/models/${modelId}`, 'PUT', { default_scale: 1.2 }, factoryId);
    assert.equal((await response(route, 'PUT', { revision: scaleStart.revision, overrides: none() }, factoryId)).status, 409);
    const changeStart = await api(route, 'GET', undefined, factoryId);
    const changedModel = (await api('/api/models', 'GET', undefined, factoryId)).find(model => model.id === modelId);
    const changedMetadata = JSON.parse(changedModel.metadata); changedMetadata.loading_port_test_extension.nested.Case = 'abc';
    await api(`/api/models/${modelId}`, 'PUT', { metadata: changedMetadata }, factoryId);
    assert.equal((await response(route, 'PUT', { revision: changeStart.revision, overrides: none() }, factoryId)).status, 409);
    check('concurrent editors cannot overwrite and model scale/case-only metadata changes invalidate instance revisions');

    async function alignment(mode, ids, positions) {
        const line = (await api('/api/lines', 'GET', undefined, factoryId)).find(line => line.id === 'loading_line');
        const model = (await api('/api/models', 'GET', undefined, factoryId)).find(model => model.id === modelId);
        const devices = [];
        for (const [index, id] of ids.entries()) {
            const device = await api(`/api/devices/${id}`, 'GET', undefined, factoryId);
            devices.push({ id, position: positions[index], expected: Object.fromEntries(['pos_x', 'pos_y', 'pos_z', 'rotation_y', 'scale', 'model_type', 'model_file', 'line_id', 'coordinate_space', 'instance_config'].map(key => [key, device[key]])),
                expectedModel: Object.fromEntries(['id', 'file_path', 'default_scale', 'metadata'].map(key => [key, model[key]])) });
        }
        return { mode, devices, expectedLine: { id: line.id, workshop_id: line.workshop_id, layout_json: line.layout_json } };
    }
    const faceBody = await alignment('faces', ['loading_a', 'loading_b'], [19, 29]);
    const alignedFaces = await api('/api/devices/loading-alignment', 'PUT', faceBody, factoryId);
    assert.deepEqual(alignedFaces.devices.map(device => device.pos_z), [19, 29]);
    for (const [index, device] of alignedFaces.devices.entries()) for (const key of Object.keys(faceBody.devices[index].expected)) {
        if (key !== 'pos_z') assert.deepEqual(device[key], faceBody.devices[index].expected[key]);
    }
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', faceBody, factoryId)).status, 409);
    const heightBody = await alignment('heights', ['loading_a', 'loading_rail'], [12, 22]);
    const alignedHeights = await api('/api/devices/loading-alignment', 'PUT', heightBody, factoryId);
    assert.deepEqual(alignedHeights.devices.map(device => device.pos_y), [12, 22]);
    const rollbackBody = await alignment('faces', ['loading_a', 'loading_b'], [101, 202]);
    const staleDevice = await api('/api/devices/loading_b', 'GET', undefined, factoryId);
    await api('/api/devices/loading_b/transform', 'PUT', { pos_z: staleDevice.pos_z + 1 }, factoryId);
    const aBeforeRollback = await api('/api/devices/loading_a', 'GET', undefined, factoryId);
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', rollbackBody, factoryId)).status, 409);
    assert.deepEqual(await api('/api/devices/loading_a', 'GET', undefined, factoryId), aBeforeRollback);
    const lineBody = await alignment('heights', ['loading_a'], [13]);
    await api('/api/lines/loading_line/placement', 'PUT', { transform: { x: 10, y: 0, z: 0, rotationY: 0 }, placementPending: false }, factoryId);
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', lineBody, factoryId)).status, 409);
    const latestBody = await alignment('heights', ['loading_a'], [14]);
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', { ...latestBody, mode: 'invalid' }, factoryId)).status, 400);
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', { ...latestBody, devices: [{ ...latestBody.devices[0], position: '1' }] }, factoryId)).status, 400);
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', { ...latestBody, devices: [{ ...latestBody.devices[0], plc_ip: '192.0.2.2' }] }, factoryId)).status, 400);
    assert.equal((await response('/api/devices/loading-alignment', 'PUT', latestBody, wrongFactory)).status, 404);
    check('alignment is axis-only, supports line-bound rail carts, guards line/device/model snapshots and rolls back the batch');

    async function browser(route, method = 'GET', body, credentials = {}) {
        const result = await fetch(origin + route, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1', ...credentials },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: result.status, payload: await result.json(), response: result };
    }
    const password = crypto.randomBytes(24).toString('base64url');
    const setup = await browser('/api/admin-auth/setup', 'POST', { password });
    assert.equal(setup.status, 200, JSON.stringify(setup.payload));
    const owner = { Cookie: cookieHeader(setup.response), 'X-CSRF-Token': setup.payload.csrfToken, 'X-Factory-ID': factoryId };
    const current = await api(route, 'GET', undefined, factoryId);
    const update = { revision: current.revision, overrides: none() };
    assert.equal((await browser(route, 'PUT', update)).status, 401);
    assert.equal((await browser(route, 'PUT', update, { Cookie: owner.Cookie, 'X-Factory-ID': factoryId })).status, 403);
    assert.equal((await browser(route, 'PUT', update, { ...owner, 'X-CSRF-Token': 'bad' })).status, 403);
    for (const page of ['models', 'devices', 'lines', 'model-animations']) {
        const username = `loading_${page.replace('-', '_')}`;
        const created = await browser('/api/admin-auth/users', 'POST', { username, role: 'viewer', password, permissions: { view: false }, pagePermissions: { [page]: { view: true, edit: true } } }, owner);
        assert.equal(created.status, 201, JSON.stringify(created.payload));
        const login = await browser('/api/admin-auth/login', 'POST', { username, password });
        assert.equal(login.status, 200);
        const credentials = { Cookie: cookieHeader(login.response), 'X-CSRF-Token': login.payload.csrfToken, 'X-Factory-ID': factoryId };
        const modelLatest = await api(modelRoute, 'GET', undefined, factoryId);
        const deviceLatest = await api(route, 'GET', undefined, factoryId);
        assert.equal((await browser(modelRoute, 'PUT', { revision: modelLatest.revision, ports: modelLatest.ports }, credentials)).status, page === 'models' ? 200 : 403);
        const refreshedDevice = await api(route, 'GET', undefined, factoryId);
        assert.equal((await browser(route, 'PUT', { revision: refreshedDevice.revision, overrides: deviceLatest.overrides }, credentials)).status, page === 'devices' ? 200 : 403);
        const alignLatest = await alignment('heights', ['loading_a'], [15]);
        assert.equal((await browser('/api/devices/loading-alignment', 'PUT', alignLatest, credentials)).status, page === 'lines' ? 200 : 403);
    }
    check('real HTTP sessions and CSRF enforce separate models/devices/lines authoring capabilities');
    const rectangle = { version: 1, corners: [[-1,1,3],[1,1,3],[1,4,3],[-1,4,3]], surfaceNormal: [0,0,1], nodeName: 'real_mouth' };
    const regionPorts = { ...none(), inlet: { position: [0,1,3], direction: [0,0,1], nodeName: 'real_mouth', region: rectangle } };
    const regionModelBefore = await api(modelRoute, 'GET', undefined, factoryId);
    const regionDeviceBefore = await api('/api/devices/loading_a', 'GET', undefined, factoryId), regionPeerBefore = await api('/api/devices/loading_b', 'GET', undefined, factoryId);
    const regionModel = await api(modelRoute, 'PUT', { revision: regionModelBefore.revision, ports: regionPorts }, factoryId);
    assert.deepEqual((await api(modelRoute, 'GET', undefined, factoryId)).ports, regionPorts);
    const regionLoaded = await api(route, 'GET', undefined, factoryId);
    const regionOverride = { ...none(), inlet: { offset: [1,2,3], yawDegrees: 90, region: rectangle } };
    const regionSaved = await api(route, 'PUT', { revision: regionLoaded.revision, overrides: regionOverride }, factoryId);
    assert.deepEqual(regionSaved.overrides, regionOverride);
    assert.deepEqual(regionSaved.ports.inlet.position, [1,3,6]);
    assert.deepEqual(loading.loadingPortRegionDatum(regionSaved.ports.inlet.region), [1,3,6]);
    assert.deepEqual((await api(route, 'GET', undefined, factoryId)).overrides, regionOverride);
    assert.deepEqual(await api('/api/devices/loading_b', 'GET', undefined, factoryId), regionPeerBefore);
    const regionDeviceAfter = await api('/api/devices/loading_a', 'GET', undefined, factoryId);
    for (const key of Object.keys(regionDeviceBefore)) if (key !== 'instance_config') assert.deepEqual(regionDeviceAfter[key], regionDeviceBefore[key], key);
    for (const key of Object.keys(JSON.parse(regionModelBefore.model.metadata))) if (key !== 'loadingPorts') assert.deepEqual(JSON.parse(regionModel.model.metadata)[key], JSON.parse(regionModelBefore.model.metadata)[key], key);
    check('authored region model and relative instance roundtrip preserve placement, PLC, peers and unrelated metadata');
    const blankModel = await api(modelRoute, 'GET', undefined, factoryId);
    await api(modelRoute, 'PUT', { revision: blankModel.revision, ports: none() }, factoryId);
    const blankDevice = await api(route, 'GET', undefined, factoryId), unchanged = await api('/api/devices/loading_a', 'GET', undefined, factoryId);
    assert.equal((await response(route, 'PUT', { revision: blankDevice.revision, overrides: regionOverride }, factoryId)).status, 400);
    assert.deepEqual(await api('/api/devices/loading_a', 'GET', undefined, factoryId), unchanged);
    // Explicit old offsets remain compatible; no automatic rewrite on read/start.
    const legacy = await api(route, 'PUT', { revision: blankDevice.revision, overrides: overrides() }, factoryId);
    assert.equal(legacy.ports.inlet, null);
    check('new instance regions reject missing model defaults without writes while old offset-only documents remain compatible');
    const evidence = { success: true, checks, directory, origin };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
    .finally(async () => { socket?.terminate(); await forceStop(backend); });
