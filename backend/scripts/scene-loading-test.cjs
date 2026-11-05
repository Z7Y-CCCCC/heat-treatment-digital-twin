const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const WsServer = require('../services/wsServer');
const { normalizeSceneLoading } = require('../../shared/sceneLoading.cjs');
const { waitUntil } = require('./integration-test-utils.cjs');
const frame = { factoryId: 'factory-test', viewId: 'factory_overview', viewMode: 'factory', sceneReady: false,
    sceneLoading: { loadId: 'attempt-a', stage: 'models', completed: 2, total: 8, modelName: '井式炉' } };
(async () => {
    assert.equal(normalizeSceneLoading(frame.sceneLoading, true), null);
    assert.equal(normalizeSceneLoading({ ...frame.sceneLoading, completed: Infinity }, false).completed, 0);
    const server = http.createServer(), hub = new WsServer(); hub.attach(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    let native, web, late;
    try {
        native = new WebSocket(url); web = new WebSocket(url);
        await Promise.all([once(native, 'open'), once(web, 'open')]);
        const events = []; web.on('message', raw => events.push(JSON.parse(String(raw))));
        native.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
        web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
        native.send(JSON.stringify({ type: 'dashboard_context', payload: frame }));
        await waitUntil(() => events.some(e => e.payload?.sceneLoading?.loadId === 'attempt-a'), 3000, 'native loading progress');
        assert.equal(events.at(-1).payload.sceneLoading.progress, .25);
        const previous = events.length;
        web.send(JSON.stringify({ type: 'dashboard_context', payload: { ...frame, sceneReady: true } }));
        await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(events.length, previous);
        late = new WebSocket(url); const replay = []; late.on('message', raw => replay.push(JSON.parse(String(raw))));
        await once(late, 'open'); late.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
        await waitUntil(() => replay.some(e => e.payload?.sceneLoading?.progress === .25), 3000, 'reconnect loading snapshot');
        native.send(JSON.stringify({ type: 'dashboard_context', payload: { ...frame, sceneReady: true } }));
        await waitUntil(() => events.some(e => e.payload?.sceneReady === true), 3000, 'scene readiness');
        assert.equal(events.at(-1).payload.sceneLoading, null);
        native.send(JSON.stringify({ type: 'dashboard_context', payload: { ...frame, sceneReady: undefined } }));
        await waitUntil(() => events.length > previous + 1, 3000, 'legacy context');
        assert.equal(events.at(-1).payload.sceneLoading, null);
        console.log('PASS real native progress relay, bounded model counts, late-join/reconnect replay, web-source rejection and ready/legacy cleanup');
    } finally { native?.terminate(); web?.terminate(); late?.terminate(); hub.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
