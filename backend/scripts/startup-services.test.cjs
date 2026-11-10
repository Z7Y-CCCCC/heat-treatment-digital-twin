'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { startRuntimeServices } = require('../services/startupServices');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('collection starts without waiting for slow archive/retention maintenance', async () => {
    const blocked = deferred(), started = deferred(); let maintenance = false;
    const run = startRuntimeServices({ prepare: async () => {}, collector: async () => { started.resolve(); }, maintenance: async () => { maintenance = true; await blocked.promise; } });
    await started.promise; assert.equal(maintenance, true); blocked.resolve(); await run;
});
test('recovery preparation remains a hard barrier for both services', async () => {
    const barrier = deferred(); let starts = 0;
    const run = startRuntimeServices({ prepare: () => barrier.promise, collector: () => { starts++; }, maintenance: () => { starts++; } });
    await Promise.resolve(); assert.equal(starts, 0); barrier.resolve(); await run; assert.equal(starts, 2);
    await assert.rejects(startRuntimeServices({ prepare: () => { throw Error('pending recovery'); }, collector: () => { starts++; }, maintenance: () => { starts++; } }), /pending recovery/);
    assert.equal(starts, 2);
});
test('collector and maintenance failures are isolated and observed', async () => {
    for (const failing of ['collector', 'maintenance']) {
        const events = [];
        await startRuntimeServices({ prepare: async () => {}, collector: async () => { events.push('collector'); if (failing === 'collector') throw Error('failure'); }, maintenance: async () => { events.push('maintenance'); if (failing === 'maintenance') throw Error('failure'); }, onError: (name, error) => { assert.equal(error.message, 'failure'); events.push('error:' + name); } });
        assert.ok(events.includes('collector') && events.includes('maintenance') && events.includes('error:' + failing));
    }
});
test('shutdown during preparation prevents both starts', async () => {
    let starts = 0;
    await startRuntimeServices({ prepare: async () => {}, isStopping: () => true, collector: () => { starts++; }, maintenance: () => { starts++; } });
    assert.equal(starts, 0);
});
