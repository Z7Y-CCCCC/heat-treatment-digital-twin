const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// No test in this suite is allowed to reach even a local broker.
let networkAttempts = 0;
net.Socket.prototype.connect = function() {
    networkAttempts += 1;
    throw new Error('MQTT test isolation forbids all TCP connections');
};
const { readConfig, startSimulator } = require('../mqtt-simulator');
const outputRoot = path.resolve(__dirname, '..', '..', 'output');
fs.mkdirSync(outputRoot, { recursive: true });
const runDirectory = fs.mkdtempSync(path.join(outputRoot, 'mqtt-simulator-'));
const results = [];

class FakeClock {
    time = 0;
    sequence = 0;
    pending = new Map();
    maxPending = 0;
    now() { return this.time; }
    setTimeout(callback, delay) {
        const id = ++this.sequence;
        this.pending.set(id, { callback, at: this.time + Number(delay) });
        this.maxPending = Math.max(this.maxPending, this.pending.size);
        return id;
    }
    clearTimeout(id) { this.pending.delete(id); }
    advance(milliseconds) {
        const end = this.time + milliseconds;
        let iterations = 0;
        while (true) {
            const next = [...this.pending.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next || next[1].at > end) break;
            if (++iterations > 100000) throw new Error('unbounded timer loop');
            this.time = next[1].at;
            this.pending.delete(next[0]);
            next[1].callback();
        }
        this.time = end;
    }
}

class FakeClient extends EventEmitter {
    connected = false;
    messages = [];
    endCalls = 0;
    destroyCalls = 0;
    deferEnd = false;
    throwPublish = false;
    publishError = false;
    throwEnd = false;
    stream = { destroy: () => { this.destroyCalls += 1; } };
    publish(topic, message, options, callback) {
        assert.equal(this.connected, true, 'offline publish must never reach MQTT');
        if (this.throwPublish) throw new Error('injected synchronous publish failure');
        this.messages.push({ topic, payload: JSON.parse(message), options });
        callback(this.publishError ? new Error('injected publish failure') : null);
    }
    end(force, callback) {
        assert.equal(force, true);
        this.endCalls += 1;
        if (this.throwEnd) throw new Error('injected end failure');
        this.connected = false;
        this.emit('close');
        if (this.deferEnd) this.finishEnd = callback;
        else callback();
    }
}

function harness(options = {}, environment = {}) {
    const client = new FakeClient();
    const clock = new FakeClock();
    const signals = new EventEmitter();
    const logs = [];
    const connections = [];
    const simulator = startSimulator(options, {
        mqtt: { connect: (url, config) => { connections.push({ url, config }); return client; } },
        clock, signals, environment,
        logger: { log: message => logs.push(message), error: message => logs.push(message) },
        random: () => 0.5
    });
    return {
        client, clock, signals, logs, connections, simulator,
        connect() { client.connected = true; client.emit('connect'); },
        disconnect(event = 'close') { client.connected = false; client.emit(event); }
    };
}

async function check(name, callback) {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

async function main() {
    await check('import is side-effect free and default broker is local', async () => {
        assert.equal(networkAttempts, 0);
        assert.equal(readConfig({}, {}).brokerUrl, 'mqtt://localhost:1883');
        const h = harness();
        assert.equal(h.connections[0].url, 'mqtt://localhost:1883');
        assert.equal(h.connections[0].config.queueQoSZero, false);
        assert.equal(h.connections[0].config.clean, true);
        assert.ok(h.connections[0].config.connectTimeout <= 10000);
        assert.equal(h.clock.pending.size, 0);
        await h.simulator.stop();
    });

    await check('broker and topic are explicit configuration and logs redact URL secrets', async () => {
        const h = harness({}, {
            MQTT_BROKER_URL: 'mqtts://synthetic-user:synthetic-password@localhost:8883?token=synthetic-token',
            MQTT_TOPIC: 'isolated/custom/topic', MQTT_INTERVAL_MS: '1000'
        });
        try {
            h.connect();
            assert.equal(h.client.messages[0].topic, 'isolated/custom/topic');
            assert.equal(h.client.messages[0].options.qos, 0);
            assert.equal(h.client.messages[0].options.retain, false);
            assert.equal(h.logs.join('\n').includes('synthetic-'), false);
        } finally { await h.simulator.stop(); }
    });

    await check('invalid broker, wildcard topic and unsafe intervals fail before connecting', async () => {
        for (const options of [
            { brokerUrl: 'http://localhost' }, { brokerUrl: 'not-a-url' },
            { topic: '' }, { topic: 'factory/#' }, { topic: 'factory/+' },
            { intervalMs: 0 }, { intervalMs: -1 }, { intervalMs: 1000000 }
        ]) assert.throws(() => harness(options), /MQTT_/);
        assert.throws(() => harness({ furnaces: [] }), /设备列表/);
        assert.equal(networkAttempts, 0);
    });

    await check('repeated connect events and long runs retain exactly one scheduler', async () => {
        const h = harness();
        try {
            h.connect();
            h.connect();
            h.connect();
            assert.equal(h.client.messages.length, 1);
            h.clock.advance(2000);
            assert.equal(h.client.messages.length, 21);
            assert.equal(new Set(h.client.messages.slice(0, 20).map(message => message.payload.furnace_id)).size, 20);
            h.clock.advance(20000);
            assert.equal(h.clock.pending.size, 1);
            assert.equal(h.clock.maxPending, 1);
        } finally { await h.simulator.stop(); }
    });

    for (const event of ['offline', 'close', 'disconnect', 'reconnect']) {
        await check(`${event} cancels pending sends and reconnect starts a single fresh scheduler`, async () => {
            const h = harness();
            try {
                h.connect();
                h.clock.advance(450);
                const count = h.client.messages.length;
                h.disconnect(event);
                assert.equal(h.clock.pending.size, 0);
                h.clock.advance(60000);
                assert.equal(h.client.messages.length, count);
                h.connect();
                assert.equal(h.client.messages.length, count + 1);
                assert.equal(h.clock.pending.size, 1);
            } finally { await h.simulator.stop(); }
        });
    }

    await check('late callbacks from an old connection cannot publish or clear its replacement timer', async () => {
        const h = harness();
        try {
            h.connect();
            const oldCallback = [...h.clock.pending.values()][0].callback;
            h.disconnect();
            h.connect();
            const count = h.client.messages.length;
            oldCallback();
            assert.equal(h.client.messages.length, count);
            assert.equal(h.clock.pending.size, 1);
            assert.equal(h.simulator.getStatus().scheduled, true);
        } finally { await h.simulator.stop(); }
    });

    await check('connected flag loss without an event still prevents sending and allows recovery', async () => {
        const h = harness();
        try {
            h.connect();
            h.client.connected = false;
            h.clock.advance(1000);
            assert.equal(h.client.messages.length, 1);
            assert.equal(h.clock.pending.size, 0);
            assert.equal(h.simulator.getStatus().scheduled, false);
            h.connect();
            assert.equal(h.clock.pending.size, 1);
        } finally { await h.simulator.stop(); }
    });

    await check('publish failures are contained without duplicating schedulers', async () => {
        const h = harness();
        try {
            h.client.throwPublish = true;
            h.connect();
            h.clock.advance(200);
            h.client.throwPublish = false;
            h.client.publishError = true;
            h.clock.advance(100);
            assert.ok(h.logs.some(log => log.includes('发布失败')));
            assert.equal(h.clock.pending.size, 1);
            assert.equal(h.clock.maxPending, 1);
        } finally { await h.simulator.stop(); }
    });

    await check('SIGINT and SIGTERM share one shutdown and remove timers/listeners', async () => {
        const h = harness();
        h.client.deferEnd = true;
        h.connect();
        h.signals.emit('SIGINT');
        const firstStop = h.simulator.stop();
        h.signals.emit('SIGTERM');
        assert.equal(firstStop, h.simulator.stop());
        assert.equal(h.client.endCalls, 1);
        h.connect();
        assert.equal(h.client.messages.length, 1);
        h.client.finishEnd();
        await firstStop;
        assert.equal(h.clock.pending.size, 0);
        assert.deepEqual(h.signals.eventNames(), []);
        assert.deepEqual(h.client.eventNames(), []);
        assert.equal(h.simulator.getStatus().closed, true);
    });

    await check('a stalled MQTT end callback has bounded force-close cleanup', async () => {
        const h = harness();
        h.client.deferEnd = true;
        h.connect();
        const closing = h.simulator.stop();
        h.clock.advance(2000);
        await closing;
        assert.equal(h.client.destroyCalls, 1);
        assert.equal(h.clock.pending.size, 0);
        assert.equal(h.simulator.getStatus().closed, true);
        h.client.finishEnd();
        assert.equal(h.client.endCalls, 1);
    });

    await check('synchronous shutdown and stream-destroy errors still complete cleanup', async () => {
        const h = harness();
        h.client.throwEnd = true;
        h.client.stream.destroy = () => { throw new Error('injected stream destroy failure'); };
        h.connect();
        await h.simulator.stop();
        assert.equal(h.simulator.getStatus().closed, true);
        assert.equal(h.clock.pending.size, 0);
        assert.deepEqual(h.signals.eventNames(), []);
    });

    assert.equal(networkAttempts, 0, 'no test may attempt TCP');
    const failed = results.filter(result => !result.passed).length;
    fs.writeFileSync(path.join(runDirectory, 'result.json'), JSON.stringify({ runDirectory, networkAttempts, results }, null, 2));
    console.log(JSON.stringify({ tests: results.length, passed: results.length - failed, failed, networkAttempts, runDirectory }));
    process.exitCode = failed ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
