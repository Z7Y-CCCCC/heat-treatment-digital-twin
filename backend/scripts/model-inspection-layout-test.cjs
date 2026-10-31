const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, waitUntil, forceStop } = require('./integration-test-utils.cjs');
const { getBuiltinModels } = require('../services/builtinModels');
let backend, socket;
(async () => {
    const directory = createRunDirectory('model-inspection-layout'), dataDir = path.join(directory, 'data');
    await createTestDatabase(path.join(dataDir, 'factory.db'));
    const origin = `http://127.0.0.1:${await findFreePort()}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...process.env, APP_DATA_DIR: dataDir, PORT: new URL(origin).port, HOST: '127.0.0.1' }, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(origin + '/api/health');
    const request = async (route, method = 'GET', body, factory) => {
        const response = await testFetch(origin + route, { method, headers: { 'Content-Type': 'application/json', ...(factory ? { 'X-Factory-ID': factory } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, payload: await response.json() };
    };
    const api = async (...args) => { const result = await request(...args); assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result)); return result.payload; };
    const checks = [], check = name => { checks.push(name); console.log('PASS ' + name); };
    const modelId = 'pit_furnace_2_v1', peerId = 'pit_furnace_1_v1', route = `/api/models/${modelId}/inspection`;
    const before = await api(route), peerInitial = await api(`/api/models/${peerId}/inspection`);
    await api(`/api/models/${peerId}/inspection`, 'PUT', { revision: peerInitial.revision, parts: [] });
    const peer = await api(`/api/models/${peerId}/inspection`);
    assert.equal(before.source, 'model'); assert.equal(before.modelId, modelId); assert.ok(before.inspection.parts.length);
    check('library models can be read without selecting or creating a site device');
    const config = await api('/api/config'), line = config.workshops.flatMap(w => w.lines)[0]; assert.ok(line);
    const metadata = JSON.parse(getBuiltinModels().find(m => m.id === modelId).metadata);
    metadata.customer_note = { Case: 'ABC' }; metadata.inspection.parts[0].duration = '1.7';
    await api(`/api/models/${modelId}`, 'PUT', { metadata });
    const baseline = await api(route), target = baseline.inspection.parts[0].id;
    for (const id of ['model_layout_a', 'model_layout_b', 'model_layout_override']) {
        await api('/api/devices', 'POST', { id, name: id, line_id: line.id, model_type: modelId, plc_enabled: false,
            instance_config: id.endsWith('override') ? { inspection: { parts: [{ ...baseline.inspection.parts[0], explode_offset: [90, 91, 92] }] }, marker: id } : { marker: id } });
    }
    const devices = await api('/api/devices'), modelBefore = (await api('/api/models')).find(m => m.id === modelId);
    const events = [];
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws'); socket.on('message', raw => events.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
    await waitUntil(async () => (await api('/api/native-preview/status')).unityClients === 1, 5000, 'native subscriber');
    const saved = await api(route, 'PUT', { revision: baseline.revision, enabled: true, parts: [{ id: target, explode_offset: [-5.25, 2.6, -8.95] }] });
    assert.equal(saved.revision, (await api(route)).revision);
    for (const id of ['model_layout_a', 'model_layout_b']) {
        const inherited = await api(`/api/devices/${id}/inspection`); assert.equal(inherited.source, 'model');
        assert.deepEqual(inherited.inspection.parts[0].explode_offset, [-5.25, 2.6, -8.95]);
    }
    assert.deepEqual((await api('/api/devices/model_layout_override/inspection')).inspection.parts[0].explode_offset, [90, 91, 92]);
    assert.deepEqual(await api('/api/devices'), devices, 'saving model defaults never writes an instance or PLC column');
    assert.deepEqual(await api(`/api/models/${peerId}/inspection`), peer);
    const modelAfter = (await api('/api/models')).find(m => m.id === modelId), stored = typeof modelAfter.metadata === 'string' ? JSON.parse(modelAfter.metadata) : modelAfter.metadata;
    assert.deepEqual(stored.customer_note, { Case: 'ABC' });
    assert.equal(stored.inspection.parts[0].duration, JSON.parse(modelBefore.metadata).inspection.parts[0].duration);
    assert.deepEqual(saved.inspection.parts.slice(1), baseline.inspection.parts.slice(1));
    for (const key of Object.keys(modelBefore)) if (key !== 'metadata') assert.deepEqual(modelAfter[key], modelBefore[key]);
    check('one model save updates all inheriting instances; explicit overrides, peer models and all device rows remain untouched');
    await waitUntil(() => events.some(e => e.type === 'model_metadata_changed' && e.payload.modelId === modelId), 5000, 'running Unity refresh');
    check('model metadata changes notify the running native client');
    assert.equal((await request(route, 'PUT', { revision: baseline.revision, parts: [] })).status, 409);
    for (const body of [{ revision: saved.revision, metadata: {} }, { revision: saved.revision, parts: [{ id: target, explode_offset: [null, 0, 0] }] },
        { revision: saved.revision, parts: [{ id: 'unknown', explode_offset: [1, 2, 3] }] }]) assert.equal((await request(route, 'PUT', body)).status, 400);
    const race = await Promise.all([[1, 2, 3], [4, 5, 6]].map(explode_offset => request(route, 'PUT', { revision: saved.revision, parts: [{ id: target, explode_offset }] })));
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    check('invalid edits and stale or concurrent versions cannot overwrite model metadata');
    const factory = await api('/api/factories', 'POST', { name: 'isolated private-model factory' });
    const privateModel = { ...modelAfter, id: 'private_layout_model', factory_id: factory.factory.id };
    const Database = require('better-sqlite3'), database = new Database(path.join(dataDir, 'factory.db'));
    database.prepare('INSERT INTO models (id,name,file_path,metadata,factory_id,placement_level,asset_type) VALUES (?,?,?,?,?,?,?)')
        .run(privateModel.id, 'private', privateModel.file_path, JSON.stringify(stored), privateModel.factory_id, 'device', 'model');
    database.close();
    assert.equal((await request(`/api/models/${privateModel.id}/inspection`)).status, 404);
    assert.equal((await request(`/api/models/${privateModel.id}/inspection`, 'PUT', { revision: saved.revision, parts: [] })).status, 404);
    assert.equal((await request('/api/models/factory_hall_lowpoly/inspection')).status, 404);
    check('factory-private and non-device assets cannot be edited through the model layout endpoint');
    const browser = async (url, method = 'GET', body, credentials = {}) => {
        const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Admin-Request': '1', ...credentials }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json(), response };
    };
    const password = 'Model-layout-isolated-session-20261031!';
    const owner = await browser('/api/admin-auth/setup', 'POST', { username: 'admin', password });
    const cookie = owner.response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const credentials = { Cookie: cookie, 'X-CSRF-Token': owner.body.csrfToken };
    await browser('/api/admin-auth/users', 'POST', { username: 'layout_editor', password, role: 'viewer', permissions: { view: false }, pagePermissions: { 'disassembly-layout': { view: true, edit: true } } }, credentials);
    await browser('/api/admin-auth/users', 'POST', { username: 'layout_reader', password, role: 'viewer', permissions: { view: false }, pagePermissions: { 'disassembly-layout': { view: true } } }, credentials);
    for (const name of ['layout_editor', 'layout_reader']) {
        const login = await browser('/api/admin-auth/login', 'POST', { username: name, password });
        assert.equal(login.status, 200);
        const Cookie = login.response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
        const auth = { Cookie, 'X-CSRF-Token': login.body.csrfToken };
        const current = await browser(route, 'GET', undefined, auth); assert.equal(current.status, 200);
        const payload = { revision: current.body.revision, parts: [{ id: target, explode_offset: [7, 8, 9] }] };
        assert.equal((await browser(route, 'PUT', payload, { Cookie })).status, 403);
        assert.equal((await browser(route, 'PUT', payload, auth)).status, name === 'layout_editor' ? 200 : 403);
        assert.equal((await browser(`/api/models/${modelId}`, 'PUT', { name: 'must not rename' }, auth)).status, 403);
    }
    check('layout-only editors can save positions but cannot rename/import models; readers and missing CSRF cannot write');
    const result = { success: true, checks, directory }; fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { socket?.terminate(); await forceStop(backend); });
