// HTTP/WS against a new output/ SQLite only; never the commissioned backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { getInspectionPresets, presetMetadata } = require('../services/inspectionPresets');
const { effectiveInspection, patchDeviceInspectionLayout, exactTextEquals, exactJsonEquals, loadDeviceInspection, saveDeviceInspectionLayout } = require('../services/deviceInspection');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess,
    forceStop, waitForHttp, testFetch, waitUntil } = require('./integration-test-utils.cjs');

const checks = [];
const check = (name, fn = () => {}) => { fn(); checks.push(name); console.log(`PASS ${name}`); };
const cookieHeader = response => response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
let backend, socket;

async function main() {
    const original = getInspectionPresets()[0].inspection;
    const input = { inspection: { ...original, offset_space: 'parent', extension: { keep: true } } };
    const instance = { inspection: { playback_speed: 2, shell: { opacity: null } } };
    const resolved = effectiveInspection(input, instance);
    check('effective merge matches Unity array-replace/null-ignore and retains extension metadata', () => {
        assert.equal(resolved.inspection.offset_space, 'parent');
        assert.equal(resolved.inspection.playback_speed, 2);
        assert.equal(resolved.inspection.shell.opacity, original.shell.opacity);
        assert.deepEqual(resolved.inspection.extension, { keep: true });
        assert.deepEqual(effectiveInspection(input, { inspection: { parts: [] } }).inspection.parts, []);
    });
    const loaded = { ...resolved, revision: 'a'.repeat(64), instance: {} };
    for (const vector of [[NaN, 0, 0], [Infinity, 0, 0], [null, 0, 0], ['1', 0, 0], [0, 0], [100001, 0, 0]]) {
        assert.throws(() => patchDeviceInspectionLayout(loaded, { revision: loaded.revision,
            parts: [{ id: original.parts[0].id, explode_offset: vector }] }));
    }
    check('finite layout vectors are validated strictly, never coerced or clamped');
    check('optimistic JSON comparison uses byte equality on case-insensitive databases', () => {
        assert.match(exactTextEquals('instance_config', 'mysql'), /AS BINARY/);
        assert.match(exactTextEquals('instance_config', 'sqlserver'), /varbinary/);
        assert.match(exactTextEquals('instance_config', 'sqlite'), /COLLATE BINARY/);
        assert.match(exactJsonEquals('instance_config', 'mysql'), /JSON_EXTRACT.*= JSON_EXTRACT/);
    });

    const fixtureModel = { id: getInspectionPresets()[0].modelId, file_path: '/fixture.glb', placement_level: 'device',
        metadata: presetMetadata(getInspectionPresets()[0].modelId) };
    const fixtureDevice = { id: 'json-driver', line_id: 'line', model_type: fixtureModel.id, model_file: null, instance_config: { z: 1, a: { Case: 'ABC' } } };
    const fake = metadata => ({ all: async () => [{ ...fixtureModel, metadata }] });
    const objectRead = await loadDeviceInspection(fake(fixtureModel.metadata), fixtureDevice, 'factory');
    const stringRead = await loadDeviceInspection(fake(JSON.stringify(fixtureModel.metadata)), { ...fixtureDevice, instance_config: '{ "a": {"Case":"ABC"}, "z":1 }' }, 'factory');
    assert.equal(objectRead.revision, stringRead.revision);
    const changedCase = await loadDeviceInspection(fake(fixtureModel.metadata), { ...fixtureDevice, instance_config: { z: 1, a: { Case: 'abc' } } }, 'factory');
    assert.notEqual(objectRead.revision, changedCase.revision);
    assert.doesNotThrow(() => patchDeviceInspectionLayout(objectRead, { revision: objectRead.legacyRevision, parts: [] }));
    const nextJson = patchDeviceInspectionLayout(objectRead, { revision: objectRead.revision, parts: [] });
    const fakeSaved = await saveDeviceInspectionLayout({ run: async () => ({ affectedRows: 1 }) }, fixtureDevice, objectRead, nextJson, 'factory', 'mysql');
    const reread = await loadDeviceInspection(fake(fixtureModel.metadata), { ...fixtureDevice, instance_config: nextJson }, 'factory');
    assert.equal(fakeSaved.revision, reread.revision);
    check('JSON object/text/key order produce one revision; save-read revisions agree and case-only changes conflict');

    const directory = createRunDirectory('device-inspection-layout');
    const dataDirectory = path.join(directory, 'data');
    await createTestDatabase(path.join(dataDirectory, 'factory.db'));
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...process.env, APP_DATA_DIR: dataDirectory, PORT: String(port), HOST: '127.0.0.1' },
        logFile: path.join(directory, 'backend.log') });
    await waitForHttp(`${origin}/api/health`);
    async function response(route, method = 'GET', body, factoryId) {
        const result = await testFetch(origin + route, { method,
            headers: { 'Content-Type': 'application/json', ...(factoryId ? { 'X-Factory-ID': factoryId } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: result.status, payload: await result.json(), headers: result.headers };
    }
    async function api(route, method = 'GET', body, factoryId) {
        const result = await response(route, method, body, factoryId);
        assert.ok(result.status >= 200 && result.status < 300, `${method} ${route}: ${result.status} ${JSON.stringify(result.payload)}`);
        return result.payload;
    }
    async function browser(route, method = 'GET', body, credentials = {}) {
        const result = await fetch(origin + route, { method, headers: {
            'Content-Type': 'application/json', 'X-Admin-Request': '1', ...credentials
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: result.status, payload: await result.json(), response: result };
    }
    const factory = await api('/api/factories', 'POST', { name: '设备独立拆解布局测试厂' });
    const factoryId = factory.factory.id;
    await api('/api/workshops', 'POST', { id: 'layout_ws', name: '布局测试车间' }, factoryId);
    await api('/api/lines', 'POST', { id: 'layout_line', name: '布局测试线', workshop_id: 'layout_ws' }, factoryId);
    const modelId = getInspectionPresets()[0].modelId;
    const metadata = presetMetadata(modelId);
    metadata.author_extension = { customer: 'do-not-replace', caseSensitive: 'ABC' };
    metadata.inspection.offset_space = 'parent';
    metadata.inspection.parts[0].explode_rotation = [13, -22, 45];
    metadata.inspection.parts[0].customer_part_note = { text: 'preserve authored note' };
    const modelSaved = await api(`/api/models/${modelId}`, 'PUT', { metadata });
    const instanceConfig = { workshop_id: 'layout_ws', movement: { path: [[1, 2, 3], [4, 5, 6]] },
        customer_metadata: { nested: ['retained', { Case: 'ABC' }] }, role: 'equipment',
        inspection: { playback_speed: 2, extension: { keep: 'instance authoring' },
            parts: metadata.inspection.parts } };
    instanceConfig.inspection.parts[0].duration = String(instanceConfig.inspection.parts[0].duration);
    for (const id of ['layout_a', 'layout_b']) await api('/api/devices', 'POST', {
        id, name: id, line_id: 'layout_line', model_type: modelId,
        instance_config: id === 'layout_a' ? instanceConfig : { peer: true },
        pos_x: 17, pos_y: 3, pos_z: -9, rotation_y: 31, scale: 1.7,
        plc_protocol: 'S7', plc_enabled: false, plc_ip: '192.0.2.1', plc_port: 1102
    }, factoryId);

    const events = [];
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    socket.on('message', raw => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
    await waitUntil(async () => (await api('/api/native-preview/status')).unityClients === 1, 5000, 'Unity test listener');
    const route = '/api/devices/layout_a/inspection';
    const beforeDevice = await api('/api/devices/layout_a', 'GET', undefined, factoryId);
    const before = await api(route, 'GET', undefined, factoryId);
    const peer = await api('/api/devices/layout_b/inspection', 'GET', undefined, factoryId);
    check('GET returns effective instance overrides, model identity and uncacheable revision', () => {
        assert.equal(before.source, 'device');
        assert.equal(before.modelId, modelId);
        assert.equal(before.inspection.playback_speed, 2);
        assert.match(before.revision, /^[a-f0-9]{64}$/);
        assert.equal(peer.source, 'model');
    });
    assert.equal((await response(route, 'GET', undefined, factoryId)).headers.get('cache-control'), 'no-store');
    const partId = before.inspection.parts[0].id;
    const update = { revision: before.revision, parts: [{ id: partId, explode_offset: [2.125, 3.25, -4.5] }] };
    const offset = events.length;
    const saved = await api(route, 'PUT', update, factoryId);
    await waitUntil(() => events.slice(offset).some(event => event.type === 'device_configuration_changed'
        && event.payload.deviceId === 'layout_a'), 5000, 'targeted device update');
    await waitUntil(() => events.slice(offset).some(event => event.type === 'configuration_changed'
        && event.payload.factoryId === factoryId && event.payload.resource === 'devices'), 5000, 'factory-scoped invalidation');
    const storedDevice = await api('/api/devices/layout_a', 'GET', undefined, factoryId);
    const stored = JSON.parse(storedDevice.instance_config);
    check('one dragged part persists all parts and preserves rotations, timings and coordinate space', () => {
        assert.equal(saved.inspection.parts.length, before.inspection.parts.length);
        assert.deepEqual(saved.inspection.parts[0].explode_offset, update.parts[0].explode_offset);
        assert.deepEqual(saved.inspection.parts[0].explode_rotation, [13, -22, 45]);
        assert.equal(saved.inspection.parts[0].duration, before.inspection.parts[0].duration);
        assert.equal(saved.inspection.offset_space, 'parent');
        assert.deepEqual(saved.inspection.parts.slice(1), before.inspection.parts.slice(1));
        assert.notEqual(saved.revision, before.revision);
        assert.equal(stored.inspection.parts.length, before.inspection.parts.length);
        assert.equal(stored.inspection.parts[0].duration, instanceConfig.inspection.parts[0].duration,
            'dragging must not rewrite a source-authored timing scalar');
        assert.deepEqual(stored.inspection.parts[0].customer_part_note, metadata.inspection.parts[0].customer_part_note);
    });
    check('layout-only save preserves movement, instance metadata, placement and PLC columns', () => {
        for (const [key, value] of Object.entries(instanceConfig)) {
            if (key !== 'inspection') assert.deepEqual(stored[key], value);
        }
        assert.deepEqual(stored.inspection.extension, { keep: 'instance authoring' });
        for (const [key, value] of Object.entries(beforeDevice)) {
            if (key !== 'instance_config') assert.deepEqual(storedDevice[key], value, key);
        }
    });
    check('the peer device and shared model metadata remain byte-for-byte unchanged', () => {});
    assert.deepEqual(await api('/api/devices/layout_b/inspection', 'GET', undefined, factoryId), peer);
    assert.equal((await api('/api/models')).find(model => model.id === modelId).metadata, modelSaved.model.metadata);
    assert.deepEqual((await api(route, 'GET', undefined, factoryId)).inspection, saved.inspection);

    const rejectedOffset = events.length;
    for (const [body, status] of [
        [{ parts: update.parts }, 428], [update, 409],
        [{ revision: saved.revision, parts: [{ id: 'new-illegal-part', explode_offset: [1, 2, 3] }] }, 400],
        [{ revision: saved.revision, parts: [{ id: partId, explode_offset: [1, 2, 3] }, { id: partId, explode_offset: [4, 5, 6] }] }, 400],
        [{ revision: saved.revision, parts: [{ id: partId, explode_offset: [null, 2, 3] }] }, 400],
        [{ revision: saved.revision, parts: update.parts, offset_space: 'model' }, 400],
        [{ revision: saved.revision, parts: [{ id: partId, explode_offset: [1, 2, 3], node_name: 'new node' }] }, 400],
        [{ revision: saved.revision, parts: update.parts, enabled: 'true' }, 400]
    ]) assert.equal((await response(route, 'PUT', body, factoryId)).status, status);
    const wrongFactory = (await api('/api/factories', 'POST', { name: '不可跨厂保存测试厂' })).factory.id;
    assert.equal((await response(route, 'GET', undefined, wrongFactory)).status, 404);
    assert.equal((await response(route, 'PUT', { ...update, revision: saved.revision }, wrongFactory)).status, 404);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(events.slice(rejectedOffset).filter(event => event.type === 'device_configuration_changed').length, 0);
    assert.deepEqual(await api(route, 'GET', undefined, factoryId), { inspection: saved.inspection,
        revision: saved.revision, assetRevision: saved.assetRevision, source: 'device', modelId });
    check('invalid, stale and cross-factory writes neither persist nor broadcast');

    const current = await api(route, 'GET', undefined, factoryId);
    const race = await Promise.all([[7, 8, 9], [-7, -8, -9]].map(vector => response(route, 'PUT', {
        revision: current.revision, parts: [{ id: partId, explode_offset: vector }]
    }, factoryId)));
    assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
    const winner = race.find(result => result.status === 200).payload;
    assert.deepEqual((await api(route, 'GET', undefined, factoryId)).inspection, winner.inspection);
    check('concurrent layout editors using one revision cannot overwrite each other');
    const beforeExternal = await api(route, 'GET', undefined, factoryId);
    const externalDevice = await api('/api/devices/layout_a', 'GET', undefined, factoryId);
    const externallyUpdated = JSON.parse(externalDevice.instance_config);
    externallyUpdated.customer_metadata.newNote = 'external change';
    await api('/api/devices/layout_a', 'PUT', { ...externalDevice, instance_config: externallyUpdated }, factoryId);
    assert.equal((await response(route, 'PUT', { revision: beforeExternal.revision, parts: update.parts }, factoryId)).status, 409);
    assert.equal(JSON.parse((await api('/api/devices/layout_a', 'GET', undefined, factoryId)).instance_config).customer_metadata.newNote, 'external change');
    const beforeModel = await api(route, 'GET', undefined, factoryId);
    const changedMetadata = JSON.parse(modelSaved.model.metadata);
    changedMetadata.author_extension.caseSensitive = 'abc';
    await api(`/api/models/${modelId}`, 'PUT', { metadata: changedMetadata });
    assert.equal((await response(route, 'PUT', { revision: beforeModel.revision, parts: update.parts }, factoryId)).status, 409);
    check('other instance edits and case-only model metadata edits invalidate stale revisions');

    assert.equal((await browser(route, 'PUT', update)).status, 401);
    const password = crypto.randomBytes(24).toString('base64url');
    const setup = await browser('/api/admin-auth/setup', 'POST', { password });
    assert.equal(setup.status, 200, JSON.stringify(setup.payload));
    const owner = { Cookie: cookieHeader(setup.response), 'X-CSRF-Token': setup.payload.csrfToken, 'X-Factory-ID': factoryId };
    const latest = await api(route, 'GET', undefined, factoryId);
    const ownerUpdate = { revision: latest.revision, parts: [{ id: partId, explode_offset: [10, 20, 30] }] };
    assert.equal((await browser(route, 'PUT', ownerUpdate, { Cookie: owner.Cookie, 'X-Factory-ID': factoryId })).status, 403);
    assert.equal((await browser(route, 'PUT', ownerUpdate, { ...owner, 'X-CSRF-Token': 'invalid' })).status, 403);
    const ownerSaved = await browser(route, 'PUT', ownerUpdate, owner);
    assert.equal(ownerSaved.status, 200, JSON.stringify(ownerSaved.payload));
    await browser('/api/admin-auth/users', 'POST', { username: 'layout_viewer', displayName: '布局只读查看者', role: 'viewer', password }, owner).then(result => assert.equal(result.status, 201));
    const login = await browser('/api/admin-auth/login', 'POST', { username: 'layout_viewer', password });
    assert.equal(login.status, 200);
    const viewer = { Cookie: cookieHeader(login.response), 'X-CSRF-Token': login.payload.csrfToken, 'X-Factory-ID': factoryId };
    assert.equal((await browser(route, 'GET', undefined, viewer)).status, 200);
    assert.equal((await browser(route, 'PUT', { revision: ownerSaved.payload.revision, parts: update.parts }, viewer)).status, 403);
    check('real session permissions and CSRF protect layout writes while viewers can read');

    const evidence = { success: true, checks, directory, origin };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
    .finally(async () => { socket?.terminate(); await forceStop(backend); });
