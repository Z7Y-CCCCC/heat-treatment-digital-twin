const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { createAdminAuth } = require('../services/adminAuth');

const runDirectory = createRunDirectory('admin-auth');
process.env.APP_DATA_DIR = path.join(runDirectory, 'http-data');
process.env.LICENSE_ENFORCE = 'false';
delete process.env.ADMIN_API_TOKEN;
delete process.env.MCP_API_TOKEN;
const password = crypto.randomBytes(24).toString('base64url');
const replacementPassword = crypto.randomBytes(24).toString('base64url');
const checks = [];

async function serviceChecks() {
    let time = 100000;
    const dataDir = path.join(runDirectory, 'service-data');
    const service = createAdminAuth({ dataDir, now: () => time });
    assert.equal(service.status('').configured, false);
    assert.throws(() => service.requireSession('', ''), { code: 'ADMIN_AUTH_REQUIRED' });
    await assert.rejects(service.setup('short', 'local'), { code: 'ADMIN_PASSWORD_FORMAT' });
    const first = await service.setup(password, 'local');
    assert.equal(first.status.authenticated, true);
    await assert.rejects(service.setup(replacementPassword, 'local'), { code: 'ADMIN_ALREADY_CONFIGURED' });
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-security.json'), 'utf8'));
    assert.equal(stored.password.hash.length, 128);
    assert.equal(JSON.stringify(stored).includes(password), false);
    assert.equal('password' in first.status, false);
    checks.push('first-run setup, salted password hash, no credential leakage');

    assert.throws(() => service.touch(first.token, 'invalid'), { code: 'ADMIN_CSRF_INVALID' });
    for (const value of [0, 481, -1, 1.5, '30', null]) {
        assert.throws(() => service.updateSettings(first.token, first.status.csrfToken, value), { code: 'ADMIN_IDLE_FORMAT' });
    }
    service.updateSettings(first.token, first.status.csrfToken, 5);
    for (let i = 0; i < 29; i++) {
        time += 10000;
        assert.equal(service.status(first.token).authenticated, true);
    }
    time += 10000;
    assert.equal(service.status(first.token).authenticated, false);
    checks.push('configurable idle timeout; status polling cannot extend a session');

    const active = await service.login(password, 'local');
    time += 4 * 60000;
    service.touch(active.token, active.status.csrfToken);
    time += 4 * 60000;
    assert.equal(service.status(active.token).authenticated, true);
    time += 60000;
    assert.equal(service.status(active.token).authenticated, false);
    const bounded = await service.login(password, 'local');
    const deadline = bounded.status.absoluteExpiresAt;
    while (time + 4 * 60000 < deadline) {
        time += 4 * 60000;
        service.touch(bounded.token, bounded.status.csrfToken);
    }
    time = deadline;
    assert.equal(service.status(bounded.token).authenticated, false);
    checks.push('real activity renews idle time; eight-hour absolute limit remains');

    const windowA = await service.login(password, 'local');
    const windowB = await service.login(password, 'local');
    service.lock(windowA.token, windowA.status.csrfToken);
    assert.equal(service.status(windowA.token).authenticated, false);
    assert.equal(service.status(windowB.token).authenticated, false);
    checks.push('manual lock revokes every engineer window');

    const lockOwner = await service.login(password, 'lock-race');
    const pendingLogin = service.login(password, 'pending-login');
    service.lock(lockOwner.token, lockOwner.status.csrfToken);
    await assert.rejects(pendingLogin, { code: 'ADMIN_AUTH_REQUIRED' });
    checks.push('manual lock cancels password verification already in flight');

    const stale = await service.login(password, 'stale-window');
    time += 4 * 60000;
    const stillActive = await service.login(password, 'active-window');
    time += 60000;
    assert.throws(() => service.lock(stale.token, stale.status.csrfToken), { code: 'ADMIN_AUTH_REQUIRED' });
    assert.equal(service.status(stillActive.token).authenticated, true);
    service.lock(stillActive.token, stillActive.status.csrfToken);
    assert.equal(service.lock(stillActive.token, stillActive.status.csrfToken).authenticated, false);
    checks.push('an expired window cannot falsely confirm that other active sessions were locked');

    const changing = await service.login(password, 'local');
    const other = await service.login(password, 'local');
    await assert.rejects(service.changePassword(changing.token, changing.status.csrfToken, 'wrong-password', replacementPassword, 'local'), { code: 'ADMIN_PASSWORD_INVALID' });
    const changed = await service.changePassword(changing.token, changing.status.csrfToken, password, replacementPassword, 'local');
    assert.equal(service.status(changed.token).authenticated, true);
    assert.equal(service.status(changing.token).authenticated, false);
    assert.equal(service.status(other.token).authenticated, false);
    await assert.rejects(service.login(password, 'old-password-test'), { code: 'ADMIN_PASSWORD_INVALID' });
    const restarted = createAdminAuth({ dataDir, now: () => time });
    assert.equal(restarted.status(changed.token).authenticated, false);
    assert.equal(restarted.status('').configured, true);
    assert.equal(restarted.status('').idleTimeoutMinutes, 5);
    assert.equal((await restarted.login(replacementPassword, 'local')).status.authenticated, true);
    checks.push('password changes revoke old sessions; restart preserves settings but locks access');

    for (let i = 0; i < 4; i++) {
        await assert.rejects(restarted.login('wrong-password', 'brute-force'), { code: 'ADMIN_PASSWORD_INVALID' });
    }
    await assert.rejects(restarted.login('wrong-password', 'brute-force'), { code: 'ADMIN_RATE_LIMITED' });
    await assert.rejects(restarted.login(replacementPassword, 'brute-force'), { code: 'ADMIN_RATE_LIMITED' });
    time += 60000;
    assert.equal((await restarted.login(replacementPassword, 'brute-force')).status.authenticated, true);
    checks.push('failed-password throttling and recovery without real-time sleeps');

    const racing = createAdminAuth({ dataDir: path.join(runDirectory, 'race-data') });
    const setupResults = await Promise.allSettled([racing.setup(password, 'one'), racing.setup(replacementPassword, 'two')]);
    assert.equal(setupResults.filter(item => item.status === 'fulfilled').length, 1);
    const damagedDir = path.join(runDirectory, 'damaged-data');
    fs.mkdirSync(damagedDir, { recursive: true });
    fs.writeFileSync(path.join(damagedDir, 'admin-security.json'), '{}');
    assert.throws(() => createAdminAuth({ dataDir: damagedDir }), { code: 'ADMIN_CONFIG_UNAVAILABLE' });
    checks.push('setup races and damaged credentials fail closed');
}

async function httpChecks() {
    const express = require('express');
    const { createCorsMiddleware, protectManagementWrites } = require('../middleware/security');
    const app = express();
    app.use(createCorsMiddleware());
    app.use(express.json());
    app.use('/api/admin-auth', require('../routes/adminAuth')());
    app.use(protectManagementWrites);
    let writes = 0;
    let previewPayload;
    app.get('/api/config', (req, res) => res.json({ display: 'running' }));
    app.put('/api/settings', (req, res) => res.json({ success: true, writes: ++writes }));
    app.get('/api/database/backups/test/download', (req, res) => res.json({ private: true }));
    app.use('/api/native-preview', require('../routes/nativePreview')({ wsServer: {
        broadcastToRole(type, payload) { previewPayload = payload; return 1; }
    } }));
    app.post('/api/internal/shutdown', (req, res) => res.status(403).json({ error: 'shutdown token still required' }));
    app.post('/api/mcp', (req, res) => res.json({ success: true }));
    app.use((req, res) => res.status(404).json({ error: 'not found' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    process.env.PORT = String(server.address().port);
    const origin = `http://127.0.0.1:${process.env.PORT}`;
    async function request(url, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
        const response = await fetch(`${origin}/api${url}`, {
            method,
            headers: {
                'X-Admin-Request': '1',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
                ...headers
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    try {
        assert.equal((await request('/config')).response.status, 200);
        assert.equal((await request('/settings', { method: 'PUT', body: {} })).response.status, 401);
        assert.equal((await request('/database/backups/test/download')).response.status, 401);
        const rejectedOrigin = await request('/admin-auth/setup', { method: 'POST', body: { password }, headers: { Origin: 'https://untrusted.invalid' } });
        assert.equal(rejectedOrigin.response.status, 403);
        const setup = await request('/admin-auth/setup', { method: 'POST', body: { password } });
        assert.equal(setup.response.status, 200);
        const setCookie = setup.response.headers.get('set-cookie');
        assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict') && setCookie.includes('Path=/api'));
        assert.equal(setCookie.includes('Secure'), false, 'loopback HTTP must remain usable');
        assert.equal(setup.response.headers.get('cache-control'), 'no-store');
        const credentials = { cookie: setup.cookie, csrf: setup.data.csrfToken };
        assert.equal((await request('/admin-auth/session', credentials)).data.authenticated, true);
        assert.equal((await request('/settings', { method: 'PUT', body: {}, cookie: credentials.cookie })).response.status, 403);
        assert.equal((await request('/settings', { method: 'PUT', body: {}, ...credentials, headers: { Origin: 'https://untrusted.invalid' } })).response.status, 403);
        assert.equal((await request('/settings', { method: 'PUT', body: {}, ...credentials })).response.status, 200);
        assert.equal((await request('/database/backups/test/download', credentials)).response.status, 200);
        const saved = await request('/admin-auth/settings', { method: 'PUT', body: { idleTimeoutMinutes: 15 }, ...credentials });
        assert.equal(saved.data.idleTimeoutMinutes, 15);
        const devCors = await request('/admin-auth/session', { headers: { Origin: 'http://localhost:5173' } });
        assert.equal(devCors.response.headers.get('access-control-allow-credentials'), 'true');
        const otherLocalService = await request('/admin-auth/session', { headers: { Origin: 'http://localhost:49999' } });
        assert.equal(otherLocalService.response.headers.get('access-control-allow-credentials'), null);
        checks.push('HTTP login cookie, CSRF/origin checks, private reads and settings endpoint');

        const navigation = await request('/native-preview/navigate', { method: 'POST', body: {
            action: 'view', viewId: 'factory', devices: [{ id: 'injected' }], includeLayout: true, view: { malicious: true }
        } });
        assert.equal(navigation.response.status, 200);
        assert.equal('devices' in previewPayload, false);
        assert.equal('view' in previewPayload, false);
        assert.equal('includeLayout' in previewPayload, false);
        assert.equal((await request('/native-preview/navigate', { method: 'POST', body: { action: 'apply' } })).response.status, 400);
        assert.equal((await request('/native-preview/navigate', { method: 'POST', body: { action: 'view' }, headers: { Origin: 'https://untrusted.invalid' } })).response.status, 403);
        assert.equal((await request('/native-preview', { method: 'POST', body: { action: 'apply' } })).response.status, 401);
        checks.push('public viewing remains available without exposing layout mutation');

        const second = await request('/admin-auth/login', { method: 'POST', body: { password } });
        const locked = await request('/admin-auth/lock', { method: 'POST', ...credentials });
        assert.equal(locked.response.status, 200);
        assert.equal((await request('/admin-auth/session', { cookie: second.cookie })).data.authenticated, false);
        assert.equal((await request('/settings', { method: 'PUT', body: {}, ...credentials })).response.status, 401);
        assert.equal((await request('/SETTINGS', { method: 'PUT', body: {} })).response.status, 401);
        const upperApi = await fetch(`${origin}/API/settings`, { method: 'PUT' });
        assert.equal(upperApi.status, 401);
        assert.equal((await request('/mcp', { method: 'POST', body: {} })).response.status, 401);
        assert.equal((await request('/internal/not-shutdown', { method: 'POST' })).response.status, 401);
        assert.equal((await request('/internal/shutdown', { method: 'POST' })).response.status, 403);
        process.env.ADMIN_API_TOKEN = crypto.randomBytes(32).toString('hex');
        assert.equal((await request('/settings', { method: 'PUT', body: {}, headers: { 'X-Admin-Token': process.env.ADMIN_API_TOKEN } })).response.status, 200);
        delete process.env.ADMIN_API_TOKEN;
        process.env.MCP_API_TOKEN = crypto.randomBytes(32).toString('hex');
        assert.equal((await request('/mcp', { method: 'POST', body: {}, headers: { 'X-MCP-Token': process.env.MCP_API_TOKEN } })).response.status, 200);
        delete process.env.MCP_API_TOKEN;
        assert.equal(writes, 2);
        checks.push('lock blocks writes/MCP/case variants while trusted automation remains compatible');
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

(async () => {
    await serviceChecks();
    await httpChecks();
    const result = { success: true, checks, artifacts: runDirectory };
    fs.writeFileSync(path.join(runDirectory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
