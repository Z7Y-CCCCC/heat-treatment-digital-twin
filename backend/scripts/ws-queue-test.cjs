'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once, EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const WsServer = require('../services/wsServer');
const { WsOutboundQueue } = require('../utils/wsOutboundQueue');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 5000) {
    const end = Date.now() + ms;
    while (!predicate()) { assert.ok(Date.now() < end, 'Timed out'); await sleep(10); }
}
const device = (id, analog = {}, quality = {}) => ({ furnace_id: id, analog, quality: { analog: quality } });
const frame = (...devices) => ({ type: 'realtime_frame', payload: { devices, timestamp: Date.now() } });
class HeldSocket extends EventEmitter {
    constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.callbacks = []; }
    send(text, callback) { this.sent.push(JSON.parse(text)); this.callbacks.push(callback); }
    close(code, reason) { this.readyState = 2; this.closeCode = code; this.reason = reason; }
    terminate() { this.readyState = 3; }
    flush() { this.callbacks.shift()?.(); }
}
async function main() {
    const sharedHub = new WsServer();
    let serializations = 0;
    const sharedPayload = { toJSON() { serializations++; return { version: 1 }; } };
    for (let i = 0; i < 4; i++) sharedHub.clients.add(new HeldSocket());
    sharedHub.broadcast('configuration_changed', sharedPayload);
    assert.equal(serializations, 1, 'Healthy peers must share one serialized broadcast');
    for (const peer of sharedHub.clients) assert.deepEqual(peer.sent[0].payload, { version: 1 });
    sharedHub.close();
    console.log('PASS healthy broadcast peers share one immutable JSON snapshot');
    const ws = new HeldSocket(); const queue = new WsOutboundQueue(ws);
    queue.enqueue({ type: 'welcome' });
    queue.enqueue(frame(device('a', { x: 1 }, { x: 'good' })));
    queue.enqueue(frame(device('b', { y: 2 }, { y: 'good' })));
    queue.enqueue(frame(device('a', { z: 3 }, { z: 'good' })));
    assert.equal(queue.queue.length, 1);
    assert.equal(queue.queue[0].message.payload.devices.length, 2);
    assert.deepEqual(queue.queue[0].message.payload.devices[0].analog, { x: 1, z: 3 });
    queue.enqueue({ type: 'configuration_changed', payload: { version: 1 } });
    queue.enqueue(frame(device('a', {}, { x: 'bad' })));
    queue.enqueue(frame(device('a', { z: 4 }, {})));
    queue.enqueue(frame(device('b', { y: 5 }, {})));
    queue.enqueue(frame(device('a', { x: 6 }, { x: 'good' })));
    while (ws.callbacks.length) ws.flush();
    assert.deepEqual(ws.sent.map(m => m.type), ['welcome', 'realtime_frame', 'configuration_changed', 'realtime_frame', 'realtime_frame']);
    assert.equal(ws.sent[3].payload.devices[0].quality.analog.x, 'bad');
    assert.equal(ws.sent[4].payload.devices.find(d => d.furnace_id === 'b').analog.y, 5);
    assert.equal(queue.bytes, 0); queue.dispose();
    console.log('PASS multi-PLC/device patch union, quality fault barrier, control ordering');

    for (const mode of ['throw', 'callback', 'bytes', 'count', 'timeout']) {
        const socket = new HeldSocket();
        const q = new WsOutboundQueue(socket, { maxMessages: 3, maxBytes: 500, maxMessageBytes: 400, stallMs: 30, pollMs: 5 });
        if (mode === 'throw') socket.send = () => { throw new Error('fixture'); };
        q.enqueue({ type: 'welcome' });
        if (mode === 'callback') socket.callbacks.shift()(new Error('fixture'));
        if (mode === 'bytes') q.enqueue({ type: 'control', payload: 'x'.repeat(401) });
        if (mode === 'count') for (let i = 0; i < 4; i++) q.enqueue({ type: 'control', i });
        if (mode === 'timeout') await sleep(65);
        assert.equal(q.closed, true, mode); assert.equal(q.bytes, 0); assert.equal(q.queue.length, 0);
        assert.equal(socket.closeCode, 1013); assert.match(socket.reason, /reconnect and resync/);
        // Late callbacks cannot restart a closed queue.
        socket.flush(); assert.equal(q.inflightBytes, 0);
    }
    console.log('PASS exceptions, callback errors, byte/count ceilings, stalled sends and late callbacks');

    const server = http.createServer(); const hub = new WsServer({ stallMs: 5000 });
    hub.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `ws://127.0.0.1:${server.address().port}/ws`;
    let client;
    try {
        client = new WebSocket(url); const received = [];
        client.on('message', raw => received.push(JSON.parse(raw)));
        await once(client, 'open'); await until(() => received.some(m => m.type === 'welcome'));
        const peer = [...hub.clients][0];
        client._socket.pause(); // Real TCP receiver stops consuming, not a mocked send callback.
        const padding = 'x'.repeat(3 * 1024 * 1024);
        for (let i = 0; i < 30; i++) hub.broadcast('scene_projection', { padding, i });
        const q = hub.outbound.get(peer);
        assert.ok(q.inflight || q.queue.length > 0);
        hub.broadcastDeviceData([device('a', { x: 10 }, { x: 'good' })]);
        hub.broadcastDeviceData([device('b', { y: 20 }, { y: 'good' })]);
        hub.broadcastDeviceData([device('a', { z: 30 }, { z: 'good' })]);
        hub.broadcast('configuration_changed', { order: 1 });
        hub.broadcastDeviceData([device('a', {}, { x: 'bad' })]);
        hub.broadcastDeviceData([device('b', { y: 21 }, {})]);
        hub.broadcast('device_configuration_changed', { order: 2 });
        assert.ok(q.bytes + q.inflightBytes <= q.options.maxBytes);
        assert.ok(q.stats.merged >= 25);
        client._socket.resume();
        await until(() => received.some(m => m.type === 'device_configuration_changed'));
        const relevant = received.filter(m => !['welcome', 'scene_projection'].includes(m.type));
        assert.deepEqual(relevant.map(m => m.type), ['realtime_frame', 'configuration_changed', 'realtime_frame', 'realtime_frame', 'device_configuration_changed']);
        assert.deepEqual(relevant[0].payload.devices.find(d => d.furnace_id === 'a').analog, { x: 10, z: 30 });
        assert.equal(relevant[0].payload.devices.find(d => d.furnace_id === 'b').analog.y, 20);
        assert.equal(relevant[2].payload.devices[0].quality.analog.x, 'bad');
        client.close(); await once(client, 'close'); await until(() => !hub.clients.size);
        assert.equal(q.closed, true); assert.equal(hub.outbound.size, 0);
        client = new WebSocket(url); const fresh = [];
        client.on('message', raw => fresh.push(JSON.parse(raw))); await once(client, 'open');
        hub.broadcast('control', { order: 3 }); await until(() => fresh.some(m => m.type === 'control'));
        assert.deepEqual(fresh.map(m => m.type), ['welcome', 'control']);
        // Every direct welcome/pong/role/subscription path goes through the same accounting.
        client.send(JSON.stringify({ type: 'ping' }));
        client.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
        await until(() => fresh.some(m => m.type === 'scene_projection_subscription'));
        assert.ok(hub.outbound.get([...hub.clients][0]).stats.sent >= 4);
        console.log('PASS real paused TCP consumer, bounded patch merging, fault/control order, reconnect cleanup and direct sends');
    } finally {
        client?.terminate(); hub.close(); await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
