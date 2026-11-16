// Cold-start regression: the actual OpenView Process.Start path, but a private
// off-screen fixture mutex/pipe. Never starts/queries/stops the installed service.
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output', 'service-actions-anchor-regression', 'cold-start-regression', `${Date.now()}-${process.pid}`);
const fixture = path.join(output, 'fixture'), gui = path.join(output, 'gui');
fs.mkdirSync(output, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = name => JSON.parse(fs.readFileSync(path.join(fixture, name), 'utf8').replace(/^\uFEFF/, ''));
const wait = async (condition, timeout = 10000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (condition()) return; await sleep(50); } throw Error('Cold-start fixture timed out'); };
const expectBug = process.argv.includes('--expect-inherited-stdio-bug');
let executable, child, completed = false;
(async () => {
    const build = spawnSync(process.execPath, [path.join(root, 'desktop/scripts/build-collector-center.cjs')], { cwd: root,
        env: { ...process.env, DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR: gui }, windowsHide: true, encoding: 'utf8', timeout: 120000 });
    fs.writeFileSync(path.join(output, 'build.log'), (build.stdout || '') + (build.stderr || ''));
    if (build.error) throw build.error; assert.equal(build.status, 0, build.stdout + build.stderr);
    executable = path.join(gui, 'HeatTreatmentCollectorCenter.exe');
    const began = Date.now(), events = [];
    let stdout = '', closed = false;
    child = spawn(executable, ['--navigation-smoke-open', fixture, 'points'], { windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { stdout += data; events.push({ event: 'data', milliseconds: Date.now() - began, text: String(data).trim() }); });
    child.on('exit', code => events.push({ event: 'exit', milliseconds: Date.now() - began, code }));
    child.on('close', code => { closed = true; events.push({ event: 'close', milliseconds: Date.now() - began, code }); });
    await wait(() => child.exitCode !== null && fs.existsSync(path.join(fixture, 'navigation-ready.json')));
    assert.equal(child.exitCode, 0); assert.equal(stdout.trim(), 'COLLECTOR_CENTER_VIEW:points');
    const ready = read('navigation-ready.json'); assert.notEqual(ready.processId, child.pid);
    if (expectBug) { await sleep(Math.max(0, 12500 - (Date.now() - began))); assert.equal(closed, false, 'baseline should reproduce a GUI-held stdout handle'); }
    else { await wait(() => closed, 5000); const receipt = events.find(value => value.event === 'close'); assert.equal(receipt.code, 0); assert.ok(receipt.milliseconds < 12000, 'strict desktop receipt must finish before its 12-second deadline'); }
    const atConfirmation = { elapsed: Date.now() - began, helperExited: child.exitCode === 0, stdout, closed, guiPid: ready.processId };
    for (const view of ['overview', 'points']) {
        const select = spawnSync(executable, ['--navigation-smoke-open', fixture, view], { windowsHide: true, encoding: 'utf8', timeout: 12000 });
        if (select.error) throw select.error; assert.equal(select.status, 0, select.stderr); assert.equal(select.stdout.trim(), `COLLECTOR_CENTER_VIEW:${view}`);
    }
    await wait(() => fs.existsSync(path.join(fixture, 'navigation-result.json')));
    const result = read('navigation-result.json'); assert.equal(result.success, true, result.error); assert.equal(result.processId, ready.processId);
    assert.deepEqual(result.views, ['points', 'overview', 'points']); assert.equal(result.serviceOperations, 0);
    await wait(() => closed); child.unref(); completed = true;
    const report = path.join(output, 'report.json');
    fs.writeFileSync(report, JSON.stringify({ success: true, reproducedBaselineBug: expectBug, fixtureOnly: true, realServiceOperations: 0,
        installerBuilt: false, executable, events, atConfirmation, gui: result }, null, 2));
    console.log(JSON.stringify({ success: true, report, events, atConfirmation }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    if (!completed && executable) {
        // The exact owned fixture also self-closes after 25 seconds if startup
        // failed. These selections never address the installed mutex or pipe.
        for (const view of ['overview', 'points']) spawnSync(executable, ['--navigation-smoke-select', fixture, view], { windowsHide: true, timeout: 10000 });
        await sleep(500);
    }
    if (child) child.unref();
});
