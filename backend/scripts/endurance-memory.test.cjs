const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMemorySummaryReader } = require('./endurance-memory.cjs');

async function fixture(t, options) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'endurance-memory-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'memory.jsonl');
    return { filename, reader: createMemorySummaryReader(filename, options) };
}
function line(pid, uptime, rss, extra = {}) { return JSON.stringify({ pid, uptime, rss, ...extra }) + '\n'; }
function reference(rows) {
    const byPid = new Map();
    for (const row of rows) { if (!byPid.has(row.pid)) byPid.set(row.pid, []); byPid.get(row.pid).push(row); }
    const generations = [...byPid].map(([pid, values]) => {
        const warm = values.filter(row => row.uptime >= 60);
        return { pid, samples: values.length, peakRssMb: Math.max(...values.map(row => row.rss)) / 1048576, rssGrowthMb: (values.at(-1).rss - (warm[0] || values[0]).rss) / 1048576, baselineAfterWarmup: warm.length > 0 };
    });
    return { samples: rows.length, generations, peakRssMb: Math.max(0, ...generations.map(row => row.peakRssMb)), maxRssGrowthMb: Math.max(0, ...generations.map(row => row.rssGrowthMb)) };
}

test('historical replay and incremental refresh match original per-PID warmup semantics', async t => {
    const { filename, reader } = await fixture(t);
    assert.deepEqual(await reader.refresh(), reference([]));
    const rows = Array.from({ length: 12000 }, (_, i) => ({ pid: i < 6000 ? 10 : 20, uptime: i % 6000, rss: (80 + Math.sin(i / 30) * 15) * 1048576 }));
    await fs.writeFile(filename, rows.slice(0, 8000).map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.deepEqual(await reader.refresh(), reference(rows.slice(0, 8000)));
    await fs.appendFile(filename, rows.slice(8000).map(row => JSON.stringify(row)).join('\n') + '\n');
    const results = await Promise.all([reader.refresh(), reader.refresh(), reader.refresh()]);
    for (const result of results) assert.deepEqual(result, reference(rows));
    assert.deepEqual(await reader.refresh(), reference(rows));
    assert.deepEqual(reader.summary(), reference(rows));
});

test('partial lines and split UTF-8 sequences are deferred without duplicate samples', async t => {
    const { filename, reader } = await fixture(t, { chunkBytes: 3 });
    const bytes = Buffer.from(line(99, 1, 1024, { note: '金色表单' }));
    const split = bytes.indexOf(Buffer.from('金')) + 1;
    await fs.writeFile(filename, bytes.subarray(0, split));
    assert.equal((await reader.refresh()).samples, 0);
    await fs.appendFile(filename, bytes.subarray(split, bytes.length - 1));
    assert.equal((await reader.refresh()).samples, 0);
    await fs.appendFile(filename, '\n\r\n');
    assert.equal((await reader.refresh()).samples, 1);
    assert.equal((await reader.refresh()).samples, 1);
});

test('bad JSON, invalid samples and invalid UTF-8 are visible sticky failures', async t => {
    for (const bad of ['{broken}\n', line(4, 1, -1), Buffer.from([0xff, 10])]) {
        const { filename, reader } = await fixture(t);
        await fs.writeFile(filename, bad);
        await assert.rejects(reader.refresh(), /Cannot read memory telemetry/);
        await fs.writeFile(filename, line(4, 1, 10));
        await assert.rejects(reader.refresh(), /Cannot read memory telemetry/);
    }
});

test('final refresh rejects an incomplete tail even when queued with a normal refresh', async t => {
    for (const finalFirst of [false, true]) {
        const { filename, reader } = await fixture(t, { chunkBytes: 3 });
        await fs.writeFile(filename, line(8, 60, 100) + '{"pid":8');
        const results = await Promise.allSettled(finalFirst
            ? [reader.refresh({ final: true }), reader.refresh()]
            : [reader.refresh(), reader.refresh({ final: true })]);
        assert.equal(results[finalFirst ? 0 : 1].status, 'rejected');
        assert.match(results[finalFirst ? 0 : 1].reason.message, /Incomplete memory telemetry record/);
        assert.equal(reader.summary().samples, 1);
        await assert.rejects(reader.refresh(), /Incomplete memory telemetry record/);
    }
});

test('final refresh accepts completed lines and whitespace without counting twice', async t => {
    const { filename, reader } = await fixture(t);
    await fs.writeFile(filename, line(8, 60, 100) + '  \r');
    for (const result of await Promise.all([reader.refresh(), reader.refresh({ final: true }), reader.refresh()])) assert.equal(result.samples, 1);
});

test('disappearance, truncation and replacement never silently reset history', async t => {
    for (const action of ['missing', 'truncate', 'replace']) {
        const { filename, reader } = await fixture(t);
        await fs.writeFile(filename, line(7, 1, 100));
        await reader.refresh();
        if (action === 'truncate') await fs.truncate(filename, 0);
        else { await fs.rename(filename, filename + '.old'); if (action === 'replace') await fs.writeFile(filename, line(7, 1, 100)); }
        await assert.rejects(reader.refresh(), /Cannot read memory telemetry/);
        assert.equal(reader.summary().samples, 1);
    }
});

test('oversized incomplete records have a bounded buffer and fail visibly', async t => {
    const { filename, reader } = await fixture(t, { chunkBytes: 8, maxLineBytes: 16 });
    await fs.writeFile(filename, ' '.repeat(17));
    await assert.rejects(reader.refresh(), /size limit/);
});

test('large historical logs leave timers live and retain constant per-PID aggregates', async t => {
    const { filename, reader } = await fixture(t);
    const block = line(25, 80, 100 * 1048576).repeat(10000);
    const handle = await fs.open(filename, 'w');
    try { for (let i = 0; i < 30; i++) await handle.write(block); } finally { await handle.close(); }
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let result;
    try { result = await reader.refresh(); } finally { clearInterval(timer); }
    assert.ok(ticks > 2, `timers must advance during replay, received ${ticks} ticks`);
    assert.equal(result.samples, 300000);
    assert.equal(result.generations.length, 1);
    assert.equal(result.peakRssMb, 100);
    assert.equal(result.maxRssGrowthMb, 0);
    assert.equal((await reader.refresh()).samples, 300000);
});
