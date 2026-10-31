// Real Unity player + real HTTP/WebSocket, with an isolated database. Never
// changes the commissioned factory, its settings, account or uploaded assets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('../backend/node_modules/ws');
const { createSmokeSandbox, createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil, testFetch } = require('../backend/scripts/integration-test-utils.cjs');

async function main() {
    const root = path.resolve(__dirname, '..');
    const sandbox = await createSmokeSandbox('native-configuration-sync');
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
    const player = path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
    const logFile = path.join(sandbox.directory, 'unity.log'), contexts = [], checks = [];
    let backend, unity, web;
    const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const builds = () => (log().match(/\[FactoryRuntime\] Native factory ready:/g) || []).length;
    async function api(route, method = 'GET', body, factoryId) {
        const response = await testFetch(origin + route, { method, headers: {
            'Content-Type': 'application/json', 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN,
            ...(factoryId ? { 'X-Factory-ID': factoryId } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const payload = await response.json();
        assert.ok(response.ok, `${method} ${route}: ${response.status} ${payload.error || ''}`);
        return payload;
    }
    async function waitForFactory(id, after = 0) {
        return waitUntil(() => contexts.slice(after).find(context => context.sceneReady === true && context.factoryId === id), 90000, `native scene ${id}`, 100);
    }
    async function saveAndConfirm(route, body, id, label) {
        const before = builds(), offset = contexts.length;
        await api(route, 'PUT', body, id);
        await waitUntil(() => builds() > before, 90000, label, 100);
        await waitForFactory(id, offset);
        checks.push(label);
    }
    try {
        backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
            env: { ...sandbox.env, HOST: '127.0.0.1', PORT: String(port) }, logFile: path.join(sandbox.directory, 'backend.log') });
        await waitForHttp(origin + '/api/health');
        const factory = (await api('/api/factories', 'POST', { name: '井式炉同步验收厂' })).factory.id;
        await api('/api/workshops', 'POST', { id: 'ws_pit_sync', name: '井式炉同步验收车间' }, factory);
        await api('/api/lines', 'POST', { id: 'line_pit_sync', name: '井式炉', workshop_id: 'ws_pit_sync' }, factory);
        for (let index = 1; index <= 5; index++) {
            await api('/api/devices', 'POST', { id: `pit_sync_${index}`, name: `井式炉${index}`,
                line_id: 'line_pit_sync', model_type: `pit_furnace_${index}_v1`, pos_x: (index - 3) * 10, plc_enabled: 0 }, factory);
        }
        const session = await createSmokeSession(origin, sandbox);
        web = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
        web.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'dashboard_context_changed') contexts.push(message.payload); });
        await new Promise((resolve, reject) => { web.once('open', resolve); web.once('error', reject); });
        web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
        unity = spawn(player, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '960', '-screen-height', '540', '-logFile', logFile], {
            cwd: path.dirname(player), windowsHide: true, stdio: 'ignore', env: { ...sandbox.env,
                DIGITAL_TWIN_BACKEND_HTTP_URL: origin, DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws',
                HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
        await authorizeSmokeUnity(origin, unity, session);
        await waitForFactory('factory_default');
        checks.push('initial default factory built and identified');
        for (const id of [factory, 'factory_default', factory]) {
            const offset = contexts.length;
            await api(`/api/factories/${id}/activate`, 'POST', {});
            await api('/api/native-preview/navigate', 'POST', { action: 'view', viewId: 'factory_overview', focus: { mode: 'factory' } }, id);
            await waitForFactory(id, offset);
            checks.push(`same player switches to ${id} without refresh`);
        }
        assert.match(log(), /Native factory ready: devices=5, fallback=0/);
        await saveAndConfirm('/api/workshops/ws_pit_sync', { name: '保存后自动同步车间' }, factory, 'workshop save rebuilds the running scene automatically');
        await saveAndConfirm('/api/devices/pit_sync_1', { name: '井式炉1已同步', line_id: 'line_pit_sync', model_type: 'pit_furnace_1_v1', pos_x: -24 }, factory, 'device layout save rebuilds the running scene automatically');
        const groundWorkshop = (await api('/api/workshops', 'GET', undefined, factory)).find(w => w.id === 'ws_pit_sync');
        await saveAndConfirm('/api/workshops/ws_pit_sync/ground', { expectedRevision: groundWorkshop.groundRevision, ground: { version: 1, elevation: 0, areas: [{ id: 'native_pit', name: '验收基坑', x: 0, z: 0, width: 12, depth: 8, elevation: -3 }] } }, factory, 'industrial ground save rebuilds the real Unity scene');
        assert.match(log(), /\[IndustrialGround\] Built workshop=ws_pit_sync, areas=1/);
        assert.match(log(), /\[IndustrialGround\] Hall floor replaced for ws_pit_sync: surfaces=[1-9]/);
        await saveAndConfirm('/api/devices/pit_sync_1/transform', { pos_y: -3, ground: { enabled: true, width: 8, depth: 8, clearance: .5 } }, factory, 'underground device placement and its following pit rebuild in Unity together');
        assert.match(log(), /\[IndustrialGround\] Built workshop=ws_pit_sync, areas=2/);
        const count = builds();
        const original = await api('/api/config', 'GET', undefined, 'factory_default');
        await api(`/api/workshops/${original.workshops[0].id}`, 'PUT', { name: '其他工厂隔离修改' }, 'factory_default');
        await new Promise(resolve => setTimeout(resolve, 1200));
        assert.equal(builds(), count, 'other factory save must not rebuild the displayed factory');
        checks.push('other factory writes do not overwrite or rebuild the active scene');
        assert.equal(unity.exitCode, null);
        assert.doesNotMatch(log(), /(?:NullReferenceException|MissingReferenceException|Unhandled Exception|InvalidOperationException):/);
        const report = { success: true, unityPid: unity.pid, samePlayerThroughout: true, factory,
            sceneBuilds: builds(), checks, contexts: contexts.map(({ factoryId, viewId, sceneReady }) => ({ factoryId, viewId, sceneReady })), logFile };
        fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ ...report, contexts: undefined }, null, 2));
    } finally { web?.terminate(); await stopOwnedSmokeProcess(unity); await stopOwnedSmokeProcess(backend); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
