const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile, execFileSync } = require('node:child_process');
const { createContinuityClock } = require('./endurance-continuity.cjs');
const { EnduranceMysql, ownedMemorySample } = require('./endurance-mysql.cjs');
const { createRunDirectory } = require('./integration-test-utils.cjs');

const base = Date.parse('2026-10-03T00:00:00.000Z');
const generation = () => ({ pid: 100, launchedAt: base, startedAt: new Date(base + 1000).toISOString() });
const rows = () => [
    { pid: 100, parentPid: 50, createdAt: new Date(base).toISOString(), executable: 'C:\\private-runtime\\bin\\mysqld.exe', commandLine: 'mysqld.exe --no-defaults --datadir=C:\\private-data --console', rss: 10 * 1048576, privateBytes: 8 * 1048576 },
    { pid: 101, parentPid: 100, createdAt: new Date(base + 100).toISOString(), executable: 'C:\\private-runtime\\bin\\mysqld.exe', commandLine: 'mysqld.exe --datadir="C:\\private-data"', rss: 80 * 1048576, privateBytes: 75 * 1048576 },
    { pid: 200, parentPid: 1, createdAt: new Date(base).toISOString(), executable: 'C:\\business\\bin\\mysqld.exe', commandLine: 'mysqld.exe --datadir=C:\\business-data', rss: 1000 * 1048576, privateBytes: 1000 * 1048576 },
];
function sample(input, gen = generation()) {
    return ownedMemorySample(input, gen, 'C:\\private-runtime', 'C:\\actual-runtime', 'C:\\private-data', base + 2000);
}
function fixture(t, sampling = {}) {
    const directory = createRunDirectory('endurance-memory-unit');
    const runtime = path.join(directory, 'runtime');
    fs.mkdirSync(path.join(runtime, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'bin', 'mysqld.exe'), 'test fixture only; never executed');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const writes = [];
    const instance = new EnduranceMysql(directory, runtime, { now: () => base + 2000, appendFile: async (filename, data) => writes.push({ filename, data }), ...sampling });
    instance.runtimeAlias = 'C:\\private-runtime';
    instance.runtimeDir = 'C:\\actual-runtime';
    instance.dataAlias = 'C:\\private-data';
    instance.child = { pid: 100, exitCode: null, signalCode: null };
    instance.generations.push(generation());
    return { instance, writes };
}
test('counts supervisor and actual child, excludes unrelated business MySQL', () => {
    const result = sample(rows());
    assert.equal(result.rss, 90 * 1048576);
    assert.equal(result.privateBytes, 83 * 1048576);
    assert.deepEqual(result.processes.map(row => row.pid), [100, 101]);
});
test('rejects PID reuse, wrong executable, wrong datadir and missing root', () => {
    for (const alter of [
        input => { input[0].createdAt = new Date(base - 60000).toISOString(); },
        input => { input[0].executable = 'C:\\business\\bin\\mysqld.exe'; },
        input => { input[1].commandLine = 'mysqld.exe --datadir=C:\\business-data'; },
        input => { input.shift(); },
    ]) {
        const input = rows(); alter(input);
        assert.throws(() => sample(input));
    }
    const gen = generation(); sample(rows(), gen);
    const reused = rows(); reused[0].createdAt = new Date(base + 1).toISOString();
    assert.throws(() => sample(reused, gen), /PID was reused/);
});
test('slow sample permits timers, deduplicates concurrent calls, summary performs no I/O', async t => {
    let calls = 0, complete;
    const { instance, writes } = fixture(t, { execFile: async () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
    const first = instance.sampleMemory(true);
    assert.strictEqual(instance.sampleMemory(true), first);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await new Promise(resolve => setTimeout(resolve, 35));
    clearInterval(timer);
    assert.ok(ticks >= 2, 'in-flight sampling must not block the event loop');
    assert.equal(instance.summary().memory.samples, 0);
    assert.equal(calls, 1);
    assert.equal(writes.length, 0);
    complete({ stdout: JSON.stringify(rows()) });
    await first;
    await instance.sampleMemory();
    assert.equal(calls, 1, 'normal samples are throttled');
    assert.equal(writes.length, 1);
    assert.equal(instance.summary().memory.peakRssMb, 90);
    assert.equal(instance.summary().generations[0].processes.length, 2);
});
test('subprocess, identity and append errors are retained instead of becoming successful samples', async t => {
    for (const sampling of [
        { execFile: async () => { throw new Error('sampling timeout'); } },
        { execFile: async () => ({ stdout: '{}' }) },
        { execFile: async () => ({ stdout: JSON.stringify(rows()) }), appendFile: async () => { throw new Error('disk full'); } },
    ]) {
        const { instance } = fixture(t, sampling);
        await instance.sampleMemory(true);
        assert.equal(instance.summary().memory.errors.length, 1);
        assert.equal(instance.summary().memory.samples, 0);
        assert.equal(instance.memoryPending, null);
    }
});
test('real asynchronous subprocess timeout records failure while timers keep running', async t => {
    const run = promisify(execFile);
    const { instance } = fixture(t, { timeoutMs: 100, execFile: (_file, _args, options) => run(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], options) });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    try { await instance.sampleMemory(true); } finally { clearInterval(timer); }
    assert.ok(ticks >= 2);
    assert.equal(instance.summary().memory.errors.length, 1);
    assert.equal(instance.summary().memory.samples, 0);
});
test('old synchronous sampler breaks continuity; same delayed async subprocess preserves it', async t => {
    // Only this regression uses a 200 ms observation limit; production remains
    // 15 seconds. The 350 ms child delay deliberately exceeds the test limit.
    const childScript = `setTimeout(() => process.stdout.write(${JSON.stringify(JSON.stringify(rows()))}), 350)`;
    const oldClock = createContinuityClock({ maxGapMs: 200 });
    let oldTicks = 0;
    const oldTimer = setInterval(() => { oldTicks++; oldClock.sample(); }, 20);
    try {
        execFileSync(process.execPath, ['-e', childScript], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
        oldClock.sample();
    } finally { clearInterval(oldTimer); }
    assert.equal(oldTicks, 0, 'synchronous collection starves the observation timer');
    assert.equal(oldClock.summary().continuous, false);
    assert.ok(oldClock.summary().largestGapMs >= 350);

    const run = promisify(execFile);
    const { instance } = fixture(t, { execFile: (_file, _args, options) => run(process.execPath, ['-e', childScript], options) });
    const newClock = createContinuityClock({ maxGapMs: 200 });
    let newTicks = 0;
    const newTimer = setInterval(() => { newTicks++; newClock.sample(); }, 20);
    try { await instance.sampleMemory(true); newClock.sample(); }
    finally { clearInterval(newTimer); }
    assert.ok(newTicks >= 3, 'asynchronous collection must permit observations while waiting');
    assert.equal(newClock.summary().continuous, true);
    assert.equal(instance.summary().memory.samples, 1);
    assert.deepEqual(instance.summary().memory.errors, []);
    t.diagnostic(`Identical 350 ms child: old largest gap ${oldClock.summary().largestGapMs.toFixed(1)} ms (${oldTicks} timer ticks), async largest gap ${newClock.summary().largestGapMs.toFixed(1)} ms (${newTicks} timer ticks).`);
});
test('uses incremental warmup statistics and distinguishes repeated PID generations', async t => {
    let now = base + 2000;
    let input = rows();
    const { instance } = fixture(t, { now: () => now, execFile: async () => ({ stdout: JSON.stringify(input) }) });
    await instance.sampleMemory(true);
    now = base + 62000;
    input[1].rss = 100 * 1048576;
    await instance.sampleMemory(true);
    now += 60000;
    input[1].rss = 103 * 1048576;
    await instance.sampleMemory(true);
    assert.equal(instance.summary().memory.samples, 3);
    assert.equal(instance.summary().memory.peakRssMb, 113);
    assert.equal(instance.summary().memory.maxRssGrowthMb, 3);
    assert.equal(instance.summary().generations[0].baselineAfterWarmup, true);
    assert.equal(instance.memorySamples, undefined, 'raw history is kept on disk only');
    instance.generations.push({ pid: 100, launchedAt: now, startedAt: new Date(now).toISOString() });
    input = [ { ...rows()[0], createdAt: new Date(now).toISOString() } ];
    await instance.sampleMemory(true);
    assert.deepEqual(instance.summary().generations.map(gen => gen.samples), [3, 1]);
});
test('rejects sample if generation exits during async collection', async t => {
    let complete;
    const { instance } = fixture(t, { execFile: () => new Promise(resolve => { complete = resolve; }) });
    const pending = instance.sampleMemory(true);
    instance.child.exitCode = 0;
    complete({ stdout: JSON.stringify(rows()) });
    await pending;
    assert.equal(instance.summary().memory.errors.length, 1);
    assert.equal(instance.summary().memory.samples, 0);
});
