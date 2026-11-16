'use strict';
// Isolated backend + real existing Windows player. Never uses the site service,
// accounts, database or PLC. Optional development player stays in output;
// no installer/release build or replacement of the live player is performed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { startDisplayGateway } = require('../desktop/displayGateway.cjs');
const root = path.resolve(__dirname, '..');
let sandbox, backend, unity, gateway;
(async () => {
    sandbox = await createSmokeSandbox('native-reconnect');
    let exe = process.env.DIGITAL_TWIN_TEST_UNITY_EXE || path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
    if (process.argv.includes('--build-test-player')) {
        const buildDir = path.join(sandbox.directory, 'test-player');
        const editor = process.env.UNITY_EDITOR_PATH || 'C:/Program Files/Unity 2022.3.34f1c1/Editor/Unity.exe';
        const built = spawnSync(editor, ['-batchmode', '-nographics', '-quit', '-projectPath', path.join(root, 'unity-client'),
            '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.NativeRealtimeAuthValidation.BuildTestPlayer',
            '-logFile', path.join(sandbox.directory, 'test-player-build.log')], {
            cwd: root, windowsHide: true, timeout: 600000,
            env: { ...sandbox.env, NATIVE_RECONNECT_TEST_BUILD_DIR: buildDir }
        });
        if (built.error) throw built.error;
        assert.equal(built.status, 0, `Isolated development player build failed: ${sandbox.directory}`);
        exe = path.join(buildDir, 'HeatTreatmentDigitalTwin.exe');
    }
    const diagnostic = path.join(sandbox.directory, 'peer-diagnostic.cjs');
    fs.writeFileSync(diagnostic, `const Hub=require(${JSON.stringify(path.join(root, 'backend/services/wsServer.js'))});
const attach=Hub.prototype.attach; Hub.prototype.attach=function(server,options){const verify=options.verifyClient; return attach.call(this,server,{...options,verifyClient:(info,done)=>{console.log('[IsolatedCookieNames] '+String(info.req.headers.cookie||'').split(';').map(item=>item.trim().split('=')[0]).join(','));return verify(info,done);}});};
const original=Hub.prototype.nativeSessionConnectionHealth; let last='';
Hub.prototype.nativeSessionConnectionHealth=function(key,now){
 const state=JSON.stringify([...this.clients].map(peer=>({role:peer.clientRole,keyPresent:!!peer.adminSessionKey,keyMatched:peer.adminSessionKey===key})));
 if(state!==last){console.log('[IsolatedPeerDiagnostic] '+state);last=state;}
 return original.call(this,key,now);
};`);
    const backendOrigin = `http://127.0.0.1:${await findFreePort(3990)}`;
    backend = startLoggedProcess(process.execPath, ['--require', diagnostic, 'server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: new URL(backendOrigin).port, HOST: '127.0.0.1' },
        logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(backendOrigin + '/api/health');
    gateway = await startDisplayGateway({ backendOrigin, frontendDir: path.join(root, 'frontend/dist') });
    const origin = gateway.origin, session = await createSmokeSession(origin, sandbox);
    const logfile = path.join(sandbox.directory, 'unity.log');
    unity = spawn(exe, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '960', '-screen-height', '540', '-logFile', logfile], {
        cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore',
        env: { ...sandbox.env, DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws', DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false' }
    });
    const log = () => fs.existsSync(logfile) ? fs.readFileSync(logfile, 'utf8') : '';
    // Development players can spend time loading Mono before Start creates the
    // pipe. This is startup, not reconnect: never spend a 30s ticket on it.
    await waitUntil(() => {
        assert.equal(unity.exitCode, null, 'owned player exited during startup');
        return log().includes('等待后台账户授权');
    }, 90000, 'isolated development player startup');
    async function request(route, body) {
        const response = await fetch(`${origin}/api/admin-auth/${route}`, { method: 'POST', headers: {
            'Content-Type': 'application/json', Origin: origin, 'X-Admin-Request': '1',
            Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken
        }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
        const data = await response.json();
        assert.equal(response.status, 200, `${route}: ${response.status} ${data.code || ''}`);
        return data;
    }
    const checks = [];
    for (let index = 0; index < 3; index++) {
        const { ticket } = await request('native-ticket', {});
        let status = await request('native-confirm', { ticket });
        assert.equal(status.connected, false, 'the old online Unity cannot satisfy a new ticket');
        await waitUntil(async () => {
            assert.equal(unity.exitCode, null, 'owned player exited');
            try {
                await new Promise((resolve, reject) => {
                    const socket = net.createConnection(`\\\\.\\pipe\\HeatTreatmentUnityAuth_${unity.pid}`);
                    socket.setTimeout(2000, () => socket.destroy(new Error('Pipe timeout')));
                    socket.once('error', reject);
                    socket.once('connect', () => socket.end(JSON.stringify({ action: 'sync_unity_session', ticket }) + '\n'));
                    socket.once('close', hadError => { if (!hadError) resolve(); });
                });
                return true;
            } catch (error) { if (['ENOENT', 'EBUSY'].includes(error.code)) return false; throw error; }
        }, 15000, 'owned player pipe');
        const started = Date.now();
        try {
            await waitUntil(async () => {
                status = await request('native-confirm', { ticket });
                return status.connected === true;
            }, 24000, `new Unity child-session handshake ${index + 1}`);
        } catch (error) {
            console.error(JSON.stringify({ cycle: index + 1, status, directory: sandbox.directory }));
            throw error;
        }
        await waitUntil(() => log().includes('[FactoryRuntime] Native factory ready'), 150000, 'isolated native scene');
        checks.push({ cycle: index + 1, connected: status.connected, exchanged: status.exchanged, elapsedMs: Date.now() - started });
    }
    assert.equal((log().match(/\[FactoryRuntime\] Native factory ready/g) || []).length, 1, 'reconnect must preserve the scene');
    const result = { success: true, directory: sandbox.directory, executable: exe,
        checks, sceneBuildCount: 1, isolated: true };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await stopOwnedSmokeProcess(unity); await gateway?.close(); await stopOwnedSmokeProcess(backend); });
