'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CollectorTelemetry } = require('../utils/collectorTelemetry');
const CollectorProcess = require('../services/collectorProcess');
const { createRunDirectory, sleep, waitUntil } = require('./integration-test-utils.cjs');

(async () => {
    const directory = createRunDirectory('collector-process-unit');
    const sends = [], callbacks = [];
    const queue = new CollectorTelemetry((devices, done) => { sends.push(devices); callbacks.push(done); }, { maxBytes: 1024, maxDevices: 2 });
    queue.add([{ furnace_id: 'a', value: 1 }]);
    for (let i = 2; i < 1000; i++) queue.add([{ furnace_id: 'a', value: i }]);
    assert.equal(sends.length, 1, 'only one telemetry send in flight');
    queue.add([{ furnace_id: 'b', value: 4 }, { furnace_id: 'c', value: 5 }]);
    assert.equal(queue.pending.size, 2);
    assert.ok(queue.bytes <= 1024);
    assert.equal(queue.dropped, 1);
    callbacks.shift()();
    assert.equal(sends[1].find(device => device.furnace_id === 'a').value, 999);
    callbacks.shift()();
    queue.add([{ furnace_id: 'large', value: 'x'.repeat(2048) }]);
    assert.ok(queue.dropped >= 2);
    queue.close();
    assert.equal(queue.bytes, 0);
    assert.equal(queue.pending.size, 0);

    const worker = path.join(directory, 'fixture-worker.cjs');
    const startLog = path.join(directory, 'worker-starts.txt');
    fs.writeFileSync(worker, `
        const heartbeat = setInterval(() => process.send?.({type:'telemetry', status:{mode:'simulation', plcStatus:{status:'simulating'}, collectorStatus:{status:'simulating',lastFrameAt:Date.now()}}, factories:{}, devices:[{furnace_id:'a', analog:{temperature:12.345}, quality:{analog:{temperature:'good'}}}]}), 100);
        process.on('message', m => {
            if(m.method==='start') { require('node:fs').appendFileSync(process.env.FIXTURE_START_LOG, process.pid+'\\n'); process.send({type:'response',id:m.id,result:{started:true}}); }
            if(m.method==='points') process.send({type:'response',id:m.id,result:{points:m.payload.points, snapshotTimestamp:Date.now()}});
            if(m.method==='env') process.send({type:'response',id:m.id,result:{credentialsAbsent: !process.env.ADMIN_API_TOKEN && !process.env.MCP_API_TOKEN && !process.env.DESKTOP_SHUTDOWN_TOKEN && !process.env.NODE_OPTIONS}});
            if(m.method==='hang') { while(true) {} }
            if(m.method==='stop') {clearInterval(heartbeat); process.exit(0)}
        });
        process.once('disconnect',()=>process.exit(0));
    `);
    const invalidated = [];
    const supervisor = new CollectorProcess({
        broadcastDeviceData(devices) { if (devices[0]?.quality?.analog?.temperature === 'bad') invalidated.push(devices); },
        broadcastStatus() {}
    }, { workerFile: worker, retryDelayMs: 80, heartbeatTimeoutMs: 1500, startTimeoutMs: 3000,
        env: { ...process.env, FIXTURE_START_LOG: startLog, ADMIN_API_TOKEN: 'fixture-admin', MCP_API_TOKEN: 'fixture-mcp', DESKTOP_SHUTDOWN_TOKEN: 'fixture-shutdown', NODE_OPTIONS: '--inspect' } });
    try {
        await supervisor.start();
        assert.equal((await supervisor._rpc('env')).credentialsAbsent, true);
        const firstPid = supervisor.child.pid;
        await waitUntil(() => supervisor.snapshots.size, 3000, 'first telemetry');
        supervisor.child.kill('SIGKILL');
        await waitUntil(() => supervisor.child?.pid !== firstPid && supervisor.processStatus.status === 'running', 5000, 'crash recovery');
        assert.ok(invalidated.length);
        const beforeHang = supervisor.child.pid;
        supervisor.child.send({ type: 'request', method: 'hang' });
        await waitUntil(() => supervisor.child?.pid !== beforeHang && supervisor.processStatus.status === 'running', 7000, 'heartbeat recovery');
        const countStarts = () => fs.readFileSync(startLog, 'utf8').trim().split('\n').length;
        const beforeBatch = countStarts();
        await Promise.all([supervisor.restart(), supervisor.restart(), supervisor.restart()]);
        assert.equal(countStarts(), beforeBatch + 1, 'simultaneous restart requests share one latest-state pass');
        assert.equal(supervisor.processStatus.status, 'running');
        assert.equal(supervisor.pending.size, 0);
        assert.equal(supervisor.pendingBytes, 0);
        assert.ok(supervisor.snapshotBytes <= 8 * 1024 * 1024);
        await supervisor.stop();
        const count = supervisor.restartCount;
        await sleep(400);
        assert.equal(supervisor.child, null);
        assert.equal(supervisor.restartCount, count, 'explicit stop must not resurrect collector');
        assert.equal(supervisor.snapshots.size, 0);
        assert.equal(supervisor.processStatus.status, 'stopped');
        await supervisor.dispose();
        await assert.rejects(supervisor.start(), /shut down/);
        await assert.rejects(supervisor.restart(), /shut down/);
    } finally { await supervisor.stop(); }
    const missingData = path.join(directory, 'missing-data');
    fs.mkdirSync(missingData);
    const missingDb = path.join(missingData, 'must-not-be-created.db');
    fs.writeFileSync(path.join(missingData, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename: missingDb }));
    const missing = new CollectorProcess({ broadcastDeviceData() {}, broadcastStatus() {} }, {
        env: { ...process.env, APP_DATA_DIR: missingData, DB_TYPE: 'sqlite', SQLITE_FILE: missingDb }
    });
    try { await assert.rejects(missing.start()); }
    finally { await missing.stop(); }
    assert.equal(fs.existsSync(missingDb), false, 'collector cannot initialize or recover a missing database');
    // Importing the facade must not pull acquisition drivers into the API.
    assert.ok(!Object.keys(require.cache).some(name => /[\\/]services[\\/](plcReader|dataEngine|simulator)\.js$/.test(name)));
    console.log(JSON.stringify({ success: true, boundedTelemetry: true, crashRecovery: true,
        heartbeatRecovery: true, serializedRestart: true, noResurrection: true, credentialsIsolated: true,
        cannotCreateDatabase: true, isolatedDriverImports: true, directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
