// Isolated records and receivers only: never scans the operator's LAN or sends TV commands.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { CastHistory, stableCastId } = require('../services/castHistory');
const Discovery = require('../services/castDiscovery');
const ScreenCast = require('../services/screenCast');
const createCastRouter = require('../routes/cast');
const directory = createRunDirectory('cast-history');
const file = path.join(directory, 'cast-history.json');
const id = 'uuid:11112222-3333-4444-5555-666677778888';
const tv = (address = '192.0.2.10', key = id) => ({ id: key, name: '车间电视', brand: '海信电视', modelName: 'TV',
    address, location: `http://${address}:1234/device.xml`, avTransportUrl: `http://${address}:1234/control` });
let checks = 0;
function pass(name) { checks++; console.log('PASS ' + name); }

(async () => {
    const history = new CastHistory({ file });
    assert.deepEqual(history.list(), []);
    assert.equal(history.remember(tv()), true);
    assert.equal(history.remember(tv('192.0.2.20')), true);
    assert.equal(history.list().length, 1);
    assert.equal(new CastHistory({ file }).list()[0].id, id);
    const saved = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(saved, /192\.0\.2|http:|control|location/);
    assert.equal(stableCastId('UUID:1111'), 'uuid:1111');
    assert.equal(history.remember(tv('192.0.2.10', 'http://192.0.2.10/device.xml')), false);
    pass('atomic restart-persistent history uses UDN, never persists old IP/control endpoints or remembers URL-only identities');

    let discovery = new Discovery({ history: new CastHistory({ file }) });
    assert.equal(discovery.list()[0].available, false);
    assert.equal(discovery.list()[0].address, '');
    assert.equal(discovery.list()[0].remembered, true);
    discovery._search = async () => new Set(['http://192.0.2.20:1234/device.xml']);
    discovery._describe = async () => tv('192.0.2.20');
    const found = await discovery.resolve(id);
    assert.equal(found.address, '192.0.2.20');
    assert.equal(discovery.list().length, 1);
    assert.equal(discovery.list()[0].remembered, true);
    pass('after restart and DHCP changes, remembered receivers remain visible and resolve to their new address without duplicates');

    const other = tv('192.0.2.20', 'uuid:another-television');
    discovery._describe = async location => location.includes('192.0.2.30') ? tv('192.0.2.30') : other;
    discovery._search = async () => new Set(['http://192.0.2.30:1234/device.xml', other.location]);
    assert.equal((await discovery.resolve(id)).address, '192.0.2.30');
    assert.equal(discovery.list().find(row => row.id === other.id).remembered, false);
    pass('a recycled IP or duplicate friendly name cannot impersonate the remembered TV; rediscovery follows the original UDN');

    const app = express(); app.use(express.json());
    const starts = [];
    app.use('/cast', createCastRouter({ discovery, screenCast: {
        resolveFfmpeg: async () => {}, status: () => ({}), start: async device => starts.push(device), stop: async () => {}
    } }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        discovery._search = async () => new Set([other.location]);
        discovery._describe = async () => other;
        const response = await fetch(`http://127.0.0.1:${server.address().port}/cast/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: id }) });
        assert.equal(response.status, 404); assert.equal(starts.length, 0);
        const result = await response.json();
        assert.equal(result.devices.find(row => row.id === id).available, false);
        assert.equal(result.devices.find(row => row.id === id).remembered, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
    pass('API refuses to cast to a stale/reassigned address, leaves unavailable history selectable and never sends a playback command');

    const callbacks = [];
    const service = new ScreenCast({ onConnected: device => callbacks.push(device.id) });
    service.streamToken = 'isolated-token';
    service.session = { device: tv(), viewers: 0, streamRequests: 0 };
    const encoder = new EventEmitter(); encoder.stdout = new PassThrough(); encoder.kill = () => {};
    service.spawnEncoder = () => encoder;
    const response = new PassThrough(); response.setHeader = () => {}; response.flushHeaders = () => {};
    service.handleStreamRequest({ method: 'HEAD', url: service.streamPath() }, response);
    assert.equal(callbacks.length, 0);
    const stream = new PassThrough(); stream.setHeader = () => {}; stream.flushHeaders = () => {};
    service.handleStreamRequest({ method: 'GET', url: service.streamPath() }, stream);
    assert.equal(callbacks.length, 0);
    encoder.stdout.write(Buffer.from('first video frame')); encoder.stdout.write(Buffer.from('next frame'));
    assert.deepEqual(callbacks, [id]);
    service.session = null; stream.destroy(); service.stopEncoders();
    pass('history records only after actual video output to a receiver, not on SOAP success, HEAD probes or failed/empty encoding; once per session');

    const invalidFile = path.join(directory, 'invalid.json'); fs.writeFileSync(invalidFile, '{broken');
    const invalid = new CastHistory({ file: invalidFile });
    assert.match(invalid.error, /读取投屏记录失败/); assert.deepEqual(invalid.list(), []);
    assert.equal(invalid.remember(tv()), true); assert.equal(invalid.error, '');
    const blocked = new CastHistory({ file: path.join(file, 'child.json') });
    assert.equal(blocked.remember(tv()), false); assert.match(blocked.error, /保存投屏记录失败/); assert.deepEqual(blocked.list(), []);
    for (let i = 0; i < 40; i++) history.remember(tv('192.0.2.10', `uuid:bounded-${i}`), new Date(1800000000000 + i).toISOString());
    assert.equal(history.list().length, 32); assert.equal(new CastHistory({ file }).list().length, 32);
    pass('corrupt/failed history storage degrades without crashing cast; failed writes do not pretend success; record count stays bounded');
    console.log(`Cast history: ${checks} groups passed; isolated evidence: ${directory}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
