'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { execFile } = require('node:child_process');
const { createRunDirectory } = require('../../backend/scripts/integration-test-utils.cjs');
const { writeUiOriginRecoveryMarker } = require('../../desktop/uiOriginRecovery.cjs');
const root = path.resolve(__dirname, '../..'), directory = createRunDirectory('ui-origin-automatic');
const env = { ...process.env };delete env.ELECTRON_RUN_AS_NODE;
const run = (exe, args, name) => new Promise((resolve, reject) => {
    execFile(exe, args, { cwd: root, env, windowsHide: true, timeout: 240000, maxBuffer: 5e6 }, (error, stdout, stderr) => {
        fs.writeFileSync(path.join(directory, name + '.log'), (stdout || '') + (stderr || ''));
        if (error) reject(error);else resolve();
    });
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = server => `http://127.0.0.1:${server.address().port}`;
const close = server => new Promise(resolve => server.close(resolve));
(async () => {
    const stage = path.join(directory, 'AdminHost');
    // Debug only, never publish/install/update the field runtime.
    await run('dotnet', ['build', path.join(root, 'native-admin-host/HeatTreatmentAdminHost.csproj'),
        '--configuration', 'Debug', '-p:SelfContained=false', '--output', stage], 'build-native');
    writeUiOriginRecoveryMarker(stage);
    let oldRequests = 0, backendRequests = 0;
    const owner = http.createServer((req, res) => { oldRequests++;res.end('UNRELATED OWNER'); });
    const backend = http.createServer((req, res) => { backendRequests++;res.setHeader('content-type', 'application/json');res.end('{"fixture":true}'); });
    await listen(owner);await listen(backend);
    try {
        const frontend = path.join(directory, 'frontend');fs.mkdirSync(frontend);fs.writeFileSync(path.join(frontend, 'index.html'), 'FIXTURE DISPLAY');
        const nativeHost = path.join(stage, 'HeatTreatmentAdminHost.exe');
        const electron = path.join(root, 'desktop/node_modules/electron/dist/electron.exe');
        // First verify EADDRINUSE against a real unrelated listener. If the
        // historical Windows excluded port remains excluded, verify real EACCES too.
        const scenarios = [{ name: 'occupied', oldOrigin: origin(owner) }];
        const probe = http.createServer();
        const denied = await new Promise(resolve => {
            probe.once('error', e => resolve(e.code === 'EACCES'));
            probe.listen(64974, '127.0.0.1', () => probe.close(() => resolve(false)));
        });
        if (denied) scenarios.push({ name: 'windows-reserved', oldOrigin: 'http://127.0.0.1:64974' });
        const checks = [];
        for (const scenario of scenarios) {
            const sandbox = path.join(directory, scenario.name), profile = path.join(sandbox, 'profile');fs.mkdirSync(profile, { recursive: true });
            for (const engine of ['WebView2', 'Electron']) {
                const seed = { Profile: engine === 'WebView2' ? path.join(profile, 'webview2') : profile,
                    OldOrigin: scenario.oldOrigin, NewOrigin: 'http://127.0.0.1:19082', Output: sandbox, SelfTest: true };
                assert.notEqual(seed.OldOrigin, seed.NewOrigin);
                const request = path.join(sandbox, engine + '.seed.json');fs.writeFileSync(request, JSON.stringify(seed));
                await run(engine === 'WebView2' ? nativeHost : electron, engine === 'WebView2'
                    ? ['--migrate-ui-origin', request] : [path.join(__dirname, 'electron.cjs'), '--request', request], scenario.name + '-seed-' + engine);
                assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox, 'result.json'))).sourceCount, 2);
            }
            fs.writeFileSync(path.join(profile, 'ui-gateway.json'), JSON.stringify({ version: 1, port: Number(new URL(scenario.oldOrigin).port) }));
            let pendingOrigin;
            for (let round = 0; round < 2; round++) {
                const result = path.join(sandbox, 'automatic-' + round + '.result.json');
                const request = path.join(sandbox, 'automatic-' + round + '.json');
                fs.writeFileSync(request, JSON.stringify({ directory, profile, oldOrigin: scenario.oldOrigin,
                    frontend, backend: origin(backend), nativeHost, interruptBeforeAck: round === 0, result }));
                await run(electron, [path.join(__dirname, 'automatic-electron.cjs'), '--request', request], scenario.name + '-automatic-' + round);
                const data = JSON.parse(fs.readFileSync(result));assert.equal(data.success, true);
                if (round === 0) pendingOrigin = data.origin;else assert.equal(data.origin, pendingOrigin, 'restart resumes saved pending origin');
                checks.push({ scenario: scenario.name, round, origin: data.origin, sourceCount: data.receipt.native.sourceCount,
                    electronCount: data.receipt.electron.sourceCount, interrupted: data.interrupted });
            }
            assert.equal(fs.existsSync(path.join(profile, 'data')), false);
            assert.equal(fs.existsSync(path.join(profile, 'mysql')), false);
        }
        assert.equal(oldRequests, 0, 'occupied original port NEVER receives a migration request');
        assert.equal(backendRequests, scenarios.length, 'only explicit post-recovery health tests reach backend');
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, oldRequests, backendRequests, denied }, null, 2));
        console.log(JSON.stringify({ success: true, directory, checks, oldRequests, backendRequests, denied }, null, 2));
    } finally { await close(owner);await close(backend); }
})().catch(error => { console.error(error);process.exitCode = 1; });
