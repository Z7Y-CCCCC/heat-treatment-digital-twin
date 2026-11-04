'use strict';
// Two owned display-only backends, no browser, collector or operator profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRunDirectory, startLoggedProcess, waitUntil, waitForOwnedBackend } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeEnvironment, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('ui-fixture-isolation');
const children = [];
(async () => {
    const fixtures = await Promise.all([0, 1].map(async index => {
        const ownDirectory = path.join(directory, String(index));
        fs.mkdirSync(ownDirectory);
        const infoFile = path.join(ownDirectory, 'server.json');
        const child = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
            cwd: path.resolve(__dirname, '..'),
            env: createSmokeEnvironment(ownDirectory, { MANUAL_LAYOUT_DISPLAY_ONLY: 'true', MANUAL_LAYOUT_UI_INFO_FILE: infoFile }),
            logFile: path.join(ownDirectory, 'server.log')
        });
        children.push(child);
        await waitUntil(() => { assert.equal(child.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned fixture ready');
        const info = JSON.parse(fs.readFileSync(infoFile));
        await waitForOwnedBackend(info.origin, { pid: info.backendPid, exitCode: null, signalCode: null });
        return info;
    }));
    for (const field of ['origin', 'directory', 'database', 'backendPid', 'password']) assert.notEqual(fixtures[0][field], fixtures[1][field], field + ' must be independent');
    const evidence = { success: true, checks: 7, collector: false,
        fixtures: fixtures.map(({ origin, directory, backendPid }) => ({ origin, directory, backendPid })) };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ success: true, checks: 7, evidence: path.join(directory, 'result.json') }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    const results = await Promise.allSettled(children.map(child => stopOwnedSmokeProcess(child)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned fixture cleanup failed');
});
