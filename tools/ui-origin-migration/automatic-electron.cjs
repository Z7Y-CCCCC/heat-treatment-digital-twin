'use strict';
// Test-only real Electron runner. All profiles live under the isolated output.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const http = require('node:http');
// Each assertion uses a new socket: deliberate close/rebind below must not
// reuse a Node fetch pool connection to the just-closed test server.
const get = url => new Promise((resolve, reject) => http.get(url, { agent: false }, res => {
    let body = '';res.on('data', c => body += c);res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(body) }));
}).on('error', reject));
const { startDisplayGateway } = require('../../desktop/displayGateway.cjs');
const { recoverUiOrigin } = require('../../desktop/uiOriginRecovery.cjs');
const request = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--request') + 1], 'utf8'));
assert.ok(path.resolve(request.profile).startsWith(path.resolve(request.directory) + path.sep));
app.setPath('userData', request.profile);
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => app.exit(2), 180000);
let gateway;
app.whenReady().then(async () => {
    const portFile = path.join(request.profile, 'ui-gateway.json');
    gateway = await startDisplayGateway({ backendOrigin: request.backend, frontendDir: request.frontend, portFile });
    assert.ok(gateway.originMigration);assert.equal(gateway.originMigration.fromOrigin, request.oldOrigin);
    assert.equal((await get(gateway.origin + '/admin')).status, 503);
    const receipt = await recoverUiOrigin({ BrowserWindow, browserSession: session.defaultSession,
        profileRoot: request.profile, migration: gateway.originMigration, nativeHostExecutable: request.nativeHost });
    for (const engine of ['native', 'electron']) {
        assert.equal(receipt[engine].sourceCount, 2);assert.equal(receipt[engine].verifiedCount, 2);
        assert.equal(receipt[engine].sourceUnmodified, true);
    }
    assert.equal((await get(gateway.origin + '/api/health')).status, 503);
    const origin = gateway.origin;
    if (!request.interruptBeforeAck) {
        await gateway.completeOriginMigration();
        assert.equal((await get(origin + '/admin')).status, 200);
        const health = await get(origin + '/api/health');assert.equal(health.status, 200);
        assert.equal((await health.json()).fixture, true);
        assert.equal(JSON.parse(fs.readFileSync(portFile)).pendingOriginMigration, undefined);
        await gateway.close();
        gateway = await startDisplayGateway({ backendOrigin: request.backend, frontendDir: request.frontend, portFile });
        assert.equal(gateway.origin, origin);assert.equal(gateway.originMigration, null);
        assert.equal((await get(origin + '/admin')).status, 200);
    } else assert.ok(JSON.parse(fs.readFileSync(portFile)).pendingOriginMigration);
    await gateway.close();gateway = null;
    fs.writeFileSync(request.result, JSON.stringify({ success: true, origin, receipt, interrupted: request.interruptBeforeAck }));
    clearTimeout(watchdog);app.exit(0);
}).catch(async error => {
    fs.writeFileSync(request.result, JSON.stringify({ success: false, error: error.stack }));
    console.error(error.stack);if (gateway) await gateway.close();clearTimeout(watchdog);app.exit(1);
});
