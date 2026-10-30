const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { BoundedTtlCache } = require('../utils/boundedTtlCache');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function requireWithStubs(filename, stubs) {
    const target = require.resolve(filename);
    const dependencies = new Map(Object.entries(stubs).map(([dependency, value]) => [require.resolve(dependency), value]));
    const isolated = new Module(target, module);
    isolated.filename = target;
    isolated.paths = Module._nodeModulePaths(path.dirname(target));
    const originalRequire = isolated.require.bind(isolated);
    isolated.require = request => {
        const resolved = Module._resolveFilename(request, isolated);
        return dependencies.has(resolved) ? dependencies.get(resolved) : originalRequire(request);
    };
    isolated._compile(fs.readFileSync(target, 'utf8'), target);
    return isolated.exports;
}

const results = [];
async function check(name, callback) {
    try { await callback(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, passed: false, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
}

async function main() {
    await check('context churn is bounded by cache entry and byte budgets', async () => {
        const cache = new BoundedTtlCache({ maxEntries: 4, maxBytes: 100 });
        for (let id = 0; id < 10000; id++) {
            cache.set(String(id), { value: 'x'.repeat(20) }, Date.now() + 60000);
            const status = cache.status();
            assert.ok(status.entries <= 4 && status.bytes <= 100);
        }
        assert.equal(cache.get('0'), undefined);
        assert.deepEqual(cache.get('9999'), { value: 'x'.repeat(20) });
        assert.equal(cache.set('huge', { value: 'x'.repeat(1000) }, Date.now() + 60000), false);
        assert.equal(cache.get('huge'), undefined);
    });
    await check('expired results are removed and active entries follow least recent use', async () => {
        let now = 0;
        const cache = new BoundedTtlCache({ maxEntries: 2, clock: () => now });
        cache.set('a', 1, 100);
        cache.set('b', 2, 100);
        assert.equal(cache.get('a'), 1);
        cache.set('c', 3, 100);
        assert.equal(cache.get('b'), undefined);
        now = 101;
        assert.equal(cache.get('a'), undefined);
        assert.equal(cache.status().entries, 0);
        assert.equal(cache.status().bytes, 0);
    });
    await check('config invalidation prevents stale pending queries repopulating the cache', async () => {
        const cache = new BoundedTtlCache();
        const version = cache.version;
        cache.clear();
        assert.equal(cache.set('stale', 1, Date.now() + 60000, version), false);
        assert.equal(cache.get('stale'), undefined);
    });
    await check('stop during factory settings lookup cannot revive DataEngine sources', async () => {
        const entered = deferred(), release = deferred();
        let starts = 0;
        class FakeSimulator { async start() { starts += 1; } stop() {} }
        const DataEngine = requireWithStubs('../services/dataEngine', {
            '../db/database': { getDb: async () => ({
                get: async () => ({ value: 'factory_default' }),
                all: async sql => {
                    if (sql.includes('factory_settings')) { entered.resolve(); return release.promise; }
                    return [{ key: 'data_mode', value: 'simulation' }];
                }
            }) },
            '../services/simulator': FakeSimulator
        });
        const engine = new DataEngine({});
        const starting = engine.start();
        await entered.promise;
        engine.stop();
        release.resolve([]);
        await starting;
        assert.equal(starts, 0);
        assert.equal(engine.currentMode, null);
    });
    await check('stop during factory settings lookup cannot publish Simulator state', async () => {
        const entered = deferred(), release = deferred();
        const Simulator = requireWithStubs('../services/simulator', {
            '../db/database': { getDb: async () => ({ all: async sql => {
                if (sql.includes('factory_settings')) { entered.resolve(); return release.promise; }
                return [];
            } }) }
        });
        const simulator = new Simulator();
        let statuses = 0;
        const starting = simulator.start(() => {}, () => { statuses += 1; });
        await entered.promise;
        simulator.stop();
        const statusesAfterStop = statuses;
        release.resolve([]);
        await starting;
        assert.equal(statuses, statusesAfterStop);
        assert.equal(simulator.pollTimer, null);
    });
    await check('late active factory lookup cannot overwrite a newer factory startup', async () => {
        const entered = deferred(), release = deferred();
        let lookups = 0;
        const factoryLookups = [];
        class FakeSimulator { async start() {} stop() {} }
        const DataEngine = requireWithStubs('../services/dataEngine', {
            '../db/database': { getDb: async () => ({
                get: async () => { if (++lookups === 1) { entered.resolve(); return release.promise; } return { value: 'new_factory' }; },
                all: async (sql, values) => {
                    if (sql.includes('factory_settings')) { factoryLookups.push(values[0]); return []; }
                    if (sql.includes('FROM factories')) return [];
                    return [{ key: 'data_mode', value: 'simulation' }];
                }
            }) },
            '../services/simulator': FakeSimulator
        });
        const engine = new DataEngine({}, { alarmOutbox: () => ({ batch: () => [], pending: () => 0 }) });
        const oldStarting = engine.start();
        await entered.promise;
        engine.stop();
        await engine.start();
        release.resolve({ value: 'old_factory' });
        await oldStarting;
        assert.equal(engine.activeFactoryId, 'new_factory');
        assert.deepEqual(factoryLookups, ['new_factory']);
        await engine.stop();
    });
    await check('slow metric persistence has one active write and recovers after failure', async () => {
        let calls = 0;
        const release = deferred();
        const DataEngine = requireWithStubs('../services/dataEngine', {
            '../db/database': { getDb: async () => ({ run: async () => {
                calls += 1;
                if (calls === 1) await release.promise;
            } }) }
        });
        const engine = new DataEngine({});
        engine.metricSnapshotIntervalMs = 0;
        const first = engine._recordMetrics([]).catch(error => error);
        await nextTurn();
        for (let count = 0; count < 10000; count++) await engine._recordMetrics([]);
        assert.equal(calls, 1);
        release.reject(new Error('injected database outage'));
        assert.match((await first).message, /outage/);
        await engine._recordMetrics([]);
        assert.equal(calls, 2);
        assert.equal(engine.metricWritePending, null);
        engine.stop();
    });
    console.log(JSON.stringify({ success: results.every(result => result.passed), passed: results.filter(result => result.passed).length, total: results.length }));
    if (results.some(result => !result.passed)) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
