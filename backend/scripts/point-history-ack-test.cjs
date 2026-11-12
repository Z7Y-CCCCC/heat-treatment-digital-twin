'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const directory = createRunDirectory('point-history-ack');
Object.assign(process.env, { APP_DATA_DIR: path.join(directory, 'data'), DB_TYPE: 'sqlite',
    SQLITE_FILE: path.join(directory, 'data', 'unused-business.db'), LICENSE_ENFORCE: 'false' });
const { AlarmOutbox } = require('../services/alarmOutbox');
const journals = [];
after(() => { for (const journal of journals) if (journal.database.open) journal.close(); });

function journal(name) {
    const value = new AlarmOutbox(path.join(directory, `${name}.db`));
    journals.push(value);
    return value;
}
function samples(factoryId, count) {
    return Array.from({ length: count }, (_, index) => ({ factoryId, deviceId: 'device', pointId: String(index),
        pointKey: `analog.value${index}`, pointName: `Point ${index}`, unit: '', sourceMode: 'integrated_plc',
        sampledAt: 1700000000000, valueJson: String(index), valueNumber: index, quality: 'good', retentionUntil: null,
        sampleKey: createHash('sha256').update(`${factoryId}:${index}`).digest('hex') }));
}
function engineWithDatabase(handle, outbox) {
    const target = require.resolve('../services/dataEngine');
    const isolated = new Module(target, module);
    isolated.filename = target;
    isolated.paths = Module._nodeModulePaths(path.dirname(target));
    const originalRequire = isolated.require.bind(isolated);
    isolated.require = request => request === '../db/database' ? { getDb: async () => handle } : originalRequire(request);
    isolated._compile(fs.readFileSync(target, 'utf8'), target);
    const engine = new isolated.exports({}, { alarmOutbox: () => outbox, factoryId: 'factory-a' });
    engine.activeFactoryId = 'factory-a';
    return engine;
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('128 sample removals share one FULL-durability transaction and survive reopening', () => {
    const outbox = journal('atomic');
    outbox.recordSamples('factory-a', samples('factory-a', 128));
    outbox.recordSamples('factory-b', samples('factory-b', 2));
    const records = outbox.sampleBatch('factory-a', 128), statement = outbox.removeSample;
    let removals = 0, transactions = 0;
    const removeBatch = outbox.removeSampleBatch;
    outbox.removeSampleBatch = records => { transactions++; return removeBatch(records); };
    outbox.removeSample = { run(...args) {
        assert.equal(outbox.database.inTransaction, true, 'each deletion must be inside the shared transaction');
        removals++;
        return statement.run(...args);
    } };
    assert.equal(outbox.database.pragma('synchronous', { simple: true }), 2);
    assert.equal(outbox.database.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(outbox.acknowledgeSamples(records), 128);
    assert.equal(transactions, 1);
    assert.equal(removals, 128);
    assert.equal(outbox.database.inTransaction, false);
    assert.equal(outbox.pendingSamples('factory-a'), 0);
    assert.equal(outbox.pendingSamples('factory-b'), 2);
    outbox.close();
    const reopened = journal('atomic');
    assert.equal(reopened.pendingSamples('factory-a'), 0);
    assert.equal(reopened.pendingSamples('factory-b'), 2);
});

test('a mid-batch deletion failure rolls back all rows and leaves cached counts unchanged', () => {
    const outbox = journal('rollback');
    outbox.recordSamples('factory-a', samples('factory-a', 3));
    const records = outbox.sampleBatch('factory-a');
    outbox.database.exec(`CREATE TRIGGER fail_second_ack BEFORE DELETE ON pending_point_sample
        WHEN OLD.id=${records[1].journalId} BEGIN SELECT RAISE(ABORT, 'injected acknowledgement failure'); END`);
    assert.throws(() => outbox.acknowledgeSamples(records), /injected acknowledgement failure/);
    assert.equal(outbox.pendingSamples('factory-a'), 3, 'failed transaction must not decrement the cache');
    assert.deepEqual(outbox.sampleBatch('factory-a'), records, 'the first deletion must roll back too');
    assert.equal(outbox.database.inTransaction, false);
    outbox.database.exec('DROP TRIGGER fail_second_ack');
    assert.equal(outbox.acknowledgeSamples(records), 3);
    assert.equal(outbox.pendingSamples('factory-a'), 0);
});

test('duplicate/stale acknowledgements and wrong factory scopes cannot corrupt queue counts', () => {
    const outbox = journal('scope');
    outbox.recordSamples('factory-a', samples('factory-a', 2));
    outbox.recordSamples('factory-b', samples('factory-b', 1));
    const a = outbox.sampleBatch('factory-a'), b = outbox.sampleBatch('factory-b');
    assert.equal(outbox.acknowledgeSamples([{ ...a[0], factoryId: 'factory-b' }, { ...a[1], sampleKey: 'wrong' }]), 0);
    assert.equal(outbox.pendingSamples('factory-a'), 2);
    assert.equal(outbox.pendingSamples('factory-b'), 1);
    outbox.sampleCountCache.delete('factory-b'); // Also exercise uncached factory counts.
    assert.equal(outbox.acknowledgeSamples([a[0], b[0], a[0], b[0]]), 2);
    assert.equal(outbox.pendingSamples('factory-a'), 1);
    assert.equal(outbox.pendingSamples('factory-b'), 0);
    assert.equal(outbox.acknowledgeSamples([a[0], b[0]]), 0);
    assert.equal(outbox.acknowledgeSample(a[1]), 1, 'single-record callers retain the same safe implementation');
    assert.equal(outbox.acknowledgeSamples([]), 0);
    assert.equal(outbox.pendingSamples('factory-a'), 0);
});

test('DataEngine acknowledges only after business commit, retries failures, and keeps batches bounded', async t => {
    const outbox = journal('commit-order');
    outbox.recordSamples('factory-a', samples('factory-a', 130));
    const entered = deferred(), release = deferred(), committed = new Set(), batches = [];
    let failCommit = true;
    const handle = { async transaction(work) {
        const staged = [];
        await work({
            all: async (sql, keys) => keys.filter(key => committed.has(key)).map(sample_key => ({ sample_key })),
            run: async (sql, values) => { for (let index = 0; index < values.length; index += 13) staged.push(values[index]); }
        });
        if (failCommit) throw new Error('injected business commit failure');
        entered.resolve();
        await release.promise;
        for (const key of staged) committed.add(key);
    } };
    const acknowledge = outbox.acknowledgeSamples.bind(outbox);
    outbox.acknowledgeSamples = records => {
        for (const record of records) assert.ok(committed.has(record.sampleKey), 'queue removal cannot precede commit');
        batches.push(records.length);
        return acknowledge(records);
    };
    const engine = engineWithDatabase(handle, outbox);
    t.after(async () => { release.resolve(); await engine.stop(); });
    await engine._flushPointSamples();
    assert.equal(engine.historyStorageStatus.status, 'error');
    assert.equal(outbox.pendingSamples('factory-a'), 130);
    assert.equal(committed.size, 0);
    assert.deepEqual(batches, []);
    failCommit = false;
    const writing = engine._flushPointSamples();
    await entered.promise;
    assert.equal(outbox.pendingSamples('factory-a'), 130, 'a still-pending commit cannot clear any queue rows');
    assert.deepEqual(batches, []);
    release.resolve();
    await writing;
    assert.deepEqual(batches, [128, 2]);
    assert.equal(outbox.pendingSamples('factory-a'), 0);
    assert.equal(committed.size, 130);
    assert.equal(engine.historyStorageStatus.status, 'healthy');
});
