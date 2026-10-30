const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil, testFetch } = require('./integration-test-utils.cjs');

async function main() {
    const sandbox = await createSmokeSandbox('configuration-sync');
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const events = [], checks = [];
    let backend, socket;
    async function api(url, method = 'GET', body, factoryId = '') {
        const response = await testFetch(origin + url, { method,
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN,
                ...(factoryId ? { 'X-Factory-ID': factoryId } : {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const payload = await response.json();
        assert.ok(response.ok, `${method} ${url}: ${response.status} ${payload.error || ''}`);
        return payload;
    }
    async function changed(action, predicate, label) {
        const offset = events.length;
        const result = await action();
        const event = await waitUntil(() => events.slice(offset).find(predicate), 5000, label);
        checks.push(label);
        return { result, event };
    }
    const configChange = (resource, id) => event => event.type === 'configuration_changed'
        && event.payload.resource === resource && event.payload.factoryId === id && event.payload.reloadRequired === true;
    try {
        backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
            env: { ...sandbox.env, PORT: String(port), HOST: '127.0.0.1' }, logFile: path.join(sandbox.directory, 'backend.log') });
        await waitForHttp(`${origin}/api/health`);
        socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
        socket.on('message', raw => events.push(JSON.parse(String(raw))));
        await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
        socket.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
        const created = await api('/api/factories', 'POST', { name: '自动同步测试厂' });
        const id = created.factory.id;
        await waitUntil(() => events.find(configChange('factories', id)), 5000, 'factory creation');
        await changed(() => api(`/api/factories/${id}`, 'PUT', { location: { country: 'CHN', regionName: '陕西省', city: '西安市' } }), configChange('factories', id), 'location save immediately broadcasts directory invalidation');
        await changed(() => api('/api/workshops', 'POST', { id: 'ws_sync', name: '同步车间' }, id), configChange('workshops', id), 'workshop creation invalidates its own factory');
        await changed(() => api('/api/lines', 'POST', { id: 'line_sync', name: '同步线', workshop_id: 'ws_sync' }, id), configChange('lines', id), 'line creation invalidates its own factory');
        await changed(() => api('/api/devices', 'POST', { id: 'sync_device', name: '同步设备', line_id: 'line_sync' }, id), configChange('devices', id), 'device creation invalidates geometry, not just motion');
        await changed(() => api('/api/workshops/ws_sync', 'PUT', { name: '同步后车间' }, id), configChange('workshops', id), 'workshop rename broadcasts without refresh');
        await changed(() => api('/api/devices/sync_device', 'PUT', { name: '同步设备', line_id: 'line_sync', pos_x: 12 }, id), configChange('devices', id), 'saved layout position broadcasts without refresh');
        const settingsOffset = events.length;
        await api('/api/settings', 'PUT', { native_quality_profile: 'balanced', group_portal_config: {} }, id);
        await waitUntil(() => events.slice(settingsOffset).find(e => e.type === 'configuration_changed' && e.payload.factoryId === id && e.payload.settings?.native_quality_profile), 5000, 'scoped settings event');
        await waitUntil(() => events.slice(settingsOffset).find(e => e.type === 'configuration_changed' && !e.payload.factoryId && e.payload.settings?.group_portal_config), 5000, 'shared settings event');
        checks.push('mixed settings save separates factory-local settings from shared appearance');
        await changed(() => api(`/api/factories/${id}/activate`, 'POST', {}), e => e.type === 'configuration_changed' && e.payload.activeFactoryId === id, 'activation notifies native factory switch without settings payload');
        const config = await api('/api/config');
        assert.equal(config.factoryId, id);
        assert.equal(config.workshops[0].name, '同步后车间');
        assert.equal(config.workshops[0].lines[0].devices[0].pos_x, 12);
        await changed(() => api('/api/native-preview/navigate', 'POST', { action: 'view', viewId: 'factory_overview' }, id), e => e.type === 'native_scene_preview' && e.payload.factoryId === id, 'navigation carries the actual target factory');
        socket.send(JSON.stringify({ type: 'dashboard_context', payload: { factoryId: id, viewId: 'factory_overview', sceneReady: true } }));
        const web = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
        try {
            await new Promise((resolve, reject) => { web.once('open', resolve); web.once('error', reject); });
            const confirmation = new Promise(resolve => web.on('message', raw => { const e = JSON.parse(String(raw)); if (e.type === 'dashboard_context_changed') resolve(e); }));
            web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
            assert.equal((await Promise.race([confirmation, new Promise((_, reject) => setTimeout(() => reject(new Error('context timeout')), 5000).unref())])).payload.factoryId, id);
            checks.push('native ready acknowledgement retains factory identity through websocket relay');
        } finally { web.terminate(); }
        const offset = events.length;
        await api('/api/config', 'GET', undefined, id);
        const failed = await testFetch(`${origin}/api/workshops/missing`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Factory-ID': id }, body: '{}' });
        assert.equal(failed.status, 404);
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(events.slice(offset).filter(configChange('workshops', id)).length, 0);
        checks.push('reads and rejected writes do not invalidate scene');
        const report = { success: true, checks, isolatedDirectory: sandbox.directory };
        fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { socket?.terminate(); await stopOwnedSmokeProcess(backend); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
