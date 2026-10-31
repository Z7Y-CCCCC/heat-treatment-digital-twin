// Real Unity player, HTTP/WS and two instances of one real GLB. All writes and
// processes belong to an isolated output/ fixture, never the commissioned site.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('../backend/node_modules/better-sqlite3');
const WebSocket = require('../backend/node_modules/ws');
const { createSmokeSandbox, createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, testFetch, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');

let backend, unity, web;
(async () => {
    const root = path.resolve(__dirname, '..');
    const executable = path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
    assert.ok(fs.existsSync(executable), 'Build the current Unity client before running this test');
    const sandbox = await createSmokeSandbox('native-manual-disassembly');
    const db = new Database(sandbox.filename);
    const devices = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 2').all();
    assert.equal(devices.length, 2);
    for (const [index, device] of devices.entries()) db.prepare("UPDATE devices SET model_type='pit_furnace_2_v1',model_file=NULL,rotation_y=?,scale=?,instance_config='{}',plc_enabled=0 WHERE id=?")
        .run(index ? -65 : 35, index ? .8 : 1.2, device.id);
    db.close();
    const origin = `http://127.0.0.1:${await findFreePort()}`, logFile = path.join(sandbox.directory, 'unity.log');
    const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const builds = () => (log().match(/\[FactoryRuntime\] Native factory ready:/g) || []).length;
    const api = async (route, method = 'GET', body) => {
        const response = await testFetch(origin + route, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const result = await response.json(); assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`); return result;
    };
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...sandbox.env,
        PORT: new URL(origin).port, HOST: '127.0.0.1' }, logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(origin + '/api/health', 120000);
    const session = await createSmokeSession(origin, sandbox), contexts = [];
    web = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: session.cookie } });
    web.on('message', raw => { const value = JSON.parse(String(raw)); if (value.type === 'dashboard_context_changed') contexts.push(value.payload); });
    await new Promise((resolve, reject) => { web.once('open', resolve); web.once('error', reject); });
    web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
    unity = spawn(executable, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1200', '-screen-height', '800', '-logFile', logFile], {
        cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore', env: { ...sandbox.env,
            DIGITAL_TWIN_BACKEND_HTTP_URL: origin, DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws',
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
    await authorizeSmokeUnity(origin, unity, session);
    await waitUntil(() => { assert.equal(unity.exitCode, null); return builds() > 0; }, 120000, 'real Unity scene');
    const target = 'pf2_hood';
    const send = (deviceId, stage) => api('/api/native-preview/navigate', 'POST', { action: 'inspection', focus: { mode: 'device', deviceId }, inspection: { command: 'stage', stage } });
    async function anchor(deviceId) {
        let fence = contexts.length;
        await send(deviceId, 'solid');
        await waitUntil(() => contexts.slice(fence).find(c => c.deviceId === deviceId && c.inspectionProgress === 0 && !c.inspectionAnimating), 20000, 'assembled before repeatable explosion');
        fence = contexts.length; await send(deviceId, 'exploded');
        await waitUntil(() => contexts.slice(fence).find(c => c.deviceId === deviceId && c.inspectionProgress > .999 && !c.inspectionAnimating
            && c.inspectionParts?.some(p => p.id === target && p.anchor?.visible)), 25000, 'exploded spatial anchor');
        await new Promise(resolve => setTimeout(resolve, 1000));
        const frame = contexts.slice(fence).filter(c => c.deviceId === deviceId && c.inspectionProgress > .999 && !c.inspectionAnimating).at(-1);
        assert.deepEqual(frame.inspectionIssues.filter(i => i.severity === 'error'), []);
        const result = frame.inspectionParts.find(p => p.id === target).anchor;
        assert.ok(Number.isFinite(result.x) && Number.isFinite(result.y)); return result;
    }
    const [a, b] = devices.map(d => d.id), route = `/api/devices/${encodeURIComponent(a)}/inspection`;
    const before = await api(route), peer = await api(`/api/devices/${encodeURIComponent(b)}/inspection`);
    const beforeA = await anchor(a), beforeB = await anchor(b), count = builds();
    const part = before.inspection.parts.find(p => p.id === target); assert.ok(part);
    const offset = part.explode_offset.map((value, i) => value + [1.25, .4, -.75][i]);
    const saved = await api(route, 'PUT', { revision: before.revision, enabled: true, parts: [{ id: target, explode_offset: offset }] });
    await waitUntil(() => builds() > count, 90000, 'device-only layout automatically reaches running Unity');
    assert.deepEqual((await api(route)).inspection, saved.inspection);
    assert.deepEqual(await api(`/api/devices/${encodeURIComponent(b)}/inspection`), peer);
    const afterA = await anchor(a), afterB = await anchor(b);
    const distance = (x, y) => Math.hypot(x.x - y.x, x.y - y.y);
    assert.ok(distance(beforeA, afterA) > .002, 'saved manual position must alter the real Unity spatial projection');
    assert.ok(distance(beforeB, afterB) < .015, 'same-model peer must keep its independent explosion');
    assert.equal(unity.exitCode, null);
    assert.doesNotMatch(log(), /(?:NullReferenceException|MissingReferenceException|Unhandled Exception|InvalidOperationException):/);
    const result = { success: true, samePlayerPid: unity.pid, target, offset, beforeA, afterA, beforeB, afterB,
        backendSaveReload: true, automaticUnityReload: true, peerDeviceUnchanged: true, directory: sandbox.directory };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(sandbox.directory, 'contexts.json'), JSON.stringify(contexts, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    web?.terminate(); await stopOwnedSmokeProcess(unity); await stopOwnedSmokeProcess(backend);
});
