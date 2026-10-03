const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { writeReportFile } = require('./endurance-report-io.cjs');

test('slow publication leaves the previous JSON readable and timers active', async () => {
    const file = path.join(createRunDirectory('report-io'), 'report.json');
    await fs.writeFile(file, '{"version":1}');
    let writing, release;
    const entered = new Promise(resolve => { writing = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const pending = writeReportFile(file, '{"version":2}', { ...fs, writeFile: async (...args) => { writing(); await blocked; return fs.writeFile(...args); } });
    await entered;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
        await delay(50);
        assert.ok(ticks >= 2);
        assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 1);
    } finally { clearInterval(timer); release(); await pending; }
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
});
test('failed write preserves previous report and surfaces the failure', async () => {
    const file = path.join(createRunDirectory('report-write-failure'), 'report.json');
    await fs.writeFile(file, '{"version":1}');
    await assert.rejects(writeReportFile(file, '{}', { ...fs, writeFile: async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } }), /disk full/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 1);
});
test('Windows transient rename lock retries without blocking, permanent lock fails', async () => {
    const file = path.join(createRunDirectory('report-rename'), 'report.json');
    let attempts = 0;
    await writeReportFile(file, '{"version":1}', { ...fs, rename: async (...args) => { if (attempts++ < 2) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); return fs.rename(...args); } });
    assert.equal(attempts, 3);
    await assert.rejects(writeReportFile(file, '{"version":2}', { ...fs, rename: async () => { throw Object.assign(new Error('permanent lock'), { code: 'EPERM' }); } }), /permanent lock/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 1);
});
