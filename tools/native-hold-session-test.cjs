'use strict';
// Real tiny Node children with an intentionally open stdin pipe. No Unity,
// backend, scene data, old result files or installed application is started.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const directory = createRunDirectory('native-hold-session-regression');
const helper = path.join(__dirname, 'native-hold-session.cjs');
const childSource = `
const {waitForOwnedHold}=require(process.env.HOLD_TEST_HELPER);
(async()=>{
 const waiting=waitForOwnedHold({finishFile:process.env.HOLD_TEST_FINISH,timeoutMs:Number(process.env.HOLD_TEST_TIMEOUT),pollMs:10});
 console.log('READY');
 const reason=await waiting;
 console.log(JSON.stringify({reason,dataListeners:process.stdin.listenerCount('data'),paused:process.stdin.isPaused()}));
})().catch(error=>{console.error(error);process.exitCode=1});
`;

async function check(name, expected, setup, timeoutMs = 5000, existing = false) {
    const finishFile = path.join(directory, name + '.request');
    if (existing) fs.writeFileSync(finishFile, 'owned test finish');
    const child = spawn(process.execPath, ['-e', childSource], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOLD_TEST_HELPER: helper, HOLD_TEST_FINISH: finishFile, HOLD_TEST_TIMEOUT: String(timeoutMs) }
    });
    let stdout = '', stderr = '', setupStarted = false, forceStopped = false;
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { stderr += data; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
        stdout += data;
        if (!setupStarted && stdout.includes('READY')) {
            setupStarted = true;
            setup?.(child, finishFile);
        }
    });
    // Deliberately never call child.stdin.end(): resumed stdin used to leave the
    // runner alive even after its hold promise and owned cleanup had completed.
    const code = await new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => { forceStopped = true; child.kill(); reject(new Error(name + ': runner did not naturally exit\n' + stdout + stderr)); }, 4000);
        child.once('error', error => { clearTimeout(watchdog); reject(error); });
        child.once('close', code => { clearTimeout(watchdog); resolve(code); });
    });
    assert.equal(forceStopped, false);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '');
    const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(result.reason, expected);
    assert.equal(result.dataListeners, 0, 'owned stdin listener leaked');
    assert.equal(result.paused, true, 'stdin reader remained active');
    console.log('PASS ' + name + ': natural exit 0; listener removed and stdin paused');
}

(async () => {
    await check('fragmented-finish-command', 'finish', child => {
        child.stdin.write('continue\nfi');
        setTimeout(() => child.stdin.write('nish\n'), 20);
    });
    await check('finish-request-file', 'finish.request', (_, file) => fs.writeFileSync(file, 'owned test finish'));
    await check('timeout', 'timeout', undefined, 80);
    await check('preexisting-finish-request', 'finish.request', undefined, 5000, true);
    console.log('Passed 4/4 owned hold natural-exit checks: ' + directory);
})().catch(error => { console.error(error); process.exitCode = 1; });
