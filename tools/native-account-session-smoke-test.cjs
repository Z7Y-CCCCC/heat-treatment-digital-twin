const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSmokeSandbox, createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..');
let sandbox, backend, unity;
(async () => {
    sandbox = await createSmokeSandbox('native-account-session');
    sandbox.password = 'NativeSession-Isolated-Test-20261031!';
    const origin = `http://127.0.0.1:${await findFreePort(3989)}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: path.join(root, 'frontend/dist') },
        logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(origin + '/api/health');
    const owner = await createSmokeSession(origin, sandbox);
    const users = [];
    for (const username of ['现场客户一', '现场客户二']) {
        const created = await fetch(origin + '/api/admin-auth/users', { method: 'POST',
            headers: { Cookie: owner.cookie, 'X-CSRF-Token': owner.csrfToken, 'X-Admin-Request': '1', Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, role: 'customer', password: '246813' }) });
        assert.equal(created.status, 201);
        const response = await fetch(origin + '/api/admin-auth/login', { method: 'POST',
            headers: { 'X-Admin-Request': '1', Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password: '246813' }) });
        const data = await response.json(); assert.equal(response.status, 200);
        users.push({ cookie: response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), csrfToken: data.csrfToken });
    }
    const executable = path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
    const logfile = path.join(sandbox.directory, 'unity.log');
    unity = spawn(executable, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1280', '-screen-height', '720', '-logFile', logfile], {
        cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
        env: { ...process.env, APP_USER_DATA_DIR: sandbox.directory, DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws', DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false' }
    });
    const log = () => fs.existsSync(logfile) ? fs.readFileSync(logfile, 'utf8') : '';
    await authorizeSmokeUnity(origin, unity, owner);
    await waitUntil(() => {
        assert.equal(unity.exitCode, null);
        return log().includes('[FactoryRuntime] Native factory ready');
    }, 150000, 'real Unity scene ready');
    for (const session of [users[0], users[1], owner, users[1], users[0], owner]) {
        const before = (log().match(/existing scene preserved/g) || []).length;
        await authorizeSmokeUnity(origin, unity, session);
        await waitUntil(() => (log().match(/existing scene preserved/g) || []).length > before, 15000, 'native account switch');
    }
    await Promise.all([authorizeSmokeUnity(origin, unity, users[0]), authorizeSmokeUnity(origin, unity, users[1]), authorizeSmokeUnity(origin, unity, owner)]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const before = (log().match(/existing scene preserved/g) || []).length;
    await authorizeSmokeUnity(origin, unity, owner);
    await waitUntil(() => (log().match(/existing scene preserved/g) || []).length > before, 15000, 'final rapid-switch handoff');
    await new Promise(resolve => setTimeout(resolve, 1500));
    const sceneBuildCount = (log().match(/\[FactoryRuntime\] Native factory ready/g) || []).length;
    const preservedSwitches = (log().match(/existing scene preserved/g) || []).length;
    assert.equal(sceneBuildCount, 1);
    assert.ok(preservedSwitches >= 7);
    assert.ok(!/Shared dashboard login failed|NullReferenceException:|InvalidOperationException:|Native dashboard authorization ended/.test(log()));
    const result = { success: true, directory: sandbox.directory, sceneBuildCount, preservedSwitches,
        checks: ['real rebuilt Windows player exchanges account tickets over its named pipe',
            'owner and two read-only customers switch repeatedly and rapidly without another scene build',
            'the final handoff is not dropped and no authentication/runtime exception occurs'] };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { await stopOwnedSmokeProcess(unity, { forceTimeoutMs: 20000 }); await stopOwnedSmokeProcess(backend); });
