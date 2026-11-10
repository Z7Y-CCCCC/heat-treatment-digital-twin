const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const WsServer = require('../services/wsServer');
const { waitUntil } = require('./integration-test-utils.cjs');

(async () => {
    const server = http.createServer(), hub = new WsServer(); hub.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    let native, web, late;
    const checks = [];
    try {
        native = new WebSocket(url); web = new WebSocket(url);
        const events = []; web.on('message', raw => events.push(JSON.parse(String(raw))));
        await Promise.all([once(native, 'open'), once(web, 'open')]);
        native.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
        web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
        const origin = { factoryId: 'factory-test', sceneId: 'scene-test', viewId: 'workshop_overview', viewMode: 'workshop',
            viewName: '车间总览', workshopId: 'workshop-1', lineId: '' };
        const context = { factoryId: origin.factoryId, sceneId: origin.sceneId, viewId: 'device_detail', viewMode: 'device',
            sceneReady: true, deviceId: 'device-1', inspectionStage: 'solid', returnOrigin: origin };
        async function publish(payload) {
            const count = events.filter(e => e.type === 'dashboard_context_changed').length;
            native.send(JSON.stringify({ type: 'dashboard_context', payload }));
            await waitUntil(() => events.filter(e => e.type === 'dashboard_context_changed').length > count, 3000, 'native return-origin relay');
            return events.findLast(e => e.type === 'dashboard_context_changed').payload;
        }
        let result = await publish({ ...context, returnOrigin: { ...origin, camera: { secret: 'native-only' }, untrusted: true } });
        assert.deepEqual(result.returnOrigin, origin); checks.push('public entry is relayed without camera/unknown properties');
        for (const stage of ['part', 'exploded', 'xray', 'solid']) {
            result = await publish({ ...context, deviceId: 'device-2', inspectionStage: stage });
            assert.deepEqual(result.returnOrigin, origin);
        }
        checks.push('device switches and inspection stages preserve the native entry');
        late = new WebSocket(url); const replay = [];
        late.on('message', raw => replay.push(JSON.parse(String(raw))));
        await once(late, 'open'); late.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
        await waitUntil(() => replay.some(e => e.type === 'dashboard_context_changed'), 3000, 'reconnect entry snapshot');
        assert.deepEqual(replay.find(e => e.type === 'dashboard_context_changed').payload.returnOrigin, origin);
        checks.push('reconnecting overlay receives the current native-owned entry');
        const previous = events.filter(e => e.type === 'dashboard_context_changed').length;
        web.send(JSON.stringify({ type: 'dashboard_context', payload: { ...context, returnOrigin: { ...origin, viewId: 'forged' } } }));
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(events.filter(e => e.type === 'dashboard_context_changed').length, previous);
        assert.deepEqual(hub.dashboardContext.returnOrigin, origin); checks.push('web clients cannot replace the native entry');
        for (const changed of [
            { viewMode: 'workshop' }, { sceneReady: false }, { factoryId: 'another-factory' }, { sceneId: 'another-scene' },
            { returnOrigin: undefined }, { returnOrigin: [] }, { returnOrigin: { ...origin, viewMode: 'device' } },
            { returnOrigin: { ...origin, viewId: '' } }
        ]) assert.equal((await publish({ ...context, ...changed })).returnOrigin, null);
        checks.push('overview exit/loading/scope changes/missing or malformed origins explicitly clear history');
        const bounded = await publish({ ...context, returnOrigin: { ...origin, viewName: '名'.repeat(500), workshopId: 'w'.repeat(500) } });
        assert.equal(bounded.returnOrigin.viewName.length, 180); assert.equal(bounded.returnOrigin.workshopId.length, 128);
        checks.push('origin text stays bounded');
        for (const check of checks) console.log(`PASS ${check}`);
        console.log(`PASS device return relay ${checks.length}/${checks.length}`);
    } finally { native?.terminate(); web?.terminate(); late?.terminate(); hub.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
