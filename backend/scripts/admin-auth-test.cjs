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

    const owner = await restarted.login(replacementPassword, 'owner-users');
    const viewerAccount = await restarted.createUser(owner.token, owner.status.csrfToken,
        { username: 'viewer_one', displayName: '值班查看员', role: 'viewer', password });
    const customerAccount = await restarted.createUser(owner.token, owner.status.csrfToken,
        { username: 'customer_one', displayName: '现场操作员', role: 'customer', password });
    assert.equal(restarted.listUsers(owner.token, owner.status.csrfToken).length, 2);
    assert.equal('password' in restarted.listUsers(owner.token, owner.status.csrfToken)[0], false);
    const viewer = await restarted.login(password, 'viewer-login', '', 'viewer_one');
    const customer = await restarted.login(password, 'customer-login', '', 'customer_one');
    assert.equal(viewer.status.user.role, 'viewer');
    assert.equal(customer.status.permissions.launch, true);
    assert.throws(() => restarted.createNativeTicket(viewer.token, viewer.status.csrfToken), { code: 'ADMIN_PERMISSION_DENIED' });
    assert.throws(() => restarted.requireSession(viewer.token, viewer.status.csrfToken, { permission: 'edit' }), { code: 'ADMIN_PERMISSION_DENIED' });
    assert.throws(() => restarted.listUsers(customer.token, customer.status.csrfToken), { code: 'ADMIN_PERMISSION_DENIED' });
    restarted.updateUser(owner.token, owner.status.csrfToken, viewerAccount.id,
        { displayName: '现场操作员', role: 'customer', enabled: true });
    assert.equal(restarted.status(viewer.token).authenticated, false);
    const promoted = await restarted.login(password, 'viewer-login', '', 'viewer_one');
    assert.equal(promoted.status.permissions.launch, true);
    restarted.deleteUser(owner.token, owner.status.csrfToken, viewerAccount.id);
    assert.equal(restarted.status(promoted.token).authenticated, false);
    restarted.updateUser(owner.token, owner.status.csrfToken, customerAccount.id,
        { displayName: '现场操作员', role: 'customer', enabled: false });
    assert.equal(restarted.status(customer.token).authenticated, false);
    await assert.rejects(restarted.login(password, 'disabled-login', '', 'customer_one'), { code: 'ADMIN_PASSWORD_INVALID' });
    const nativeTicket = restarted.createNativeTicket(owner.token, owner.status.csrfToken);
    assert.match(nativeTicket.ticket, /^[a-f0-9]{64}$/);
    const nativeSession = restarted.exchangeNativeTicket(nativeTicket.ticket);
    assert.equal(nativeSession.status.authenticated, true);
    assert.equal(nativeSession.status.user.id, 'owner');
    assert.throws(() => restarted.exchangeNativeTicket(nativeTicket.ticket), { code: 'NATIVE_TICKET_INVALID' });
    const revokedTicket = restarted.createNativeTicket(owner.token, owner.status.csrfToken);
    restarted.lock(owner.token, owner.status.csrfToken);
    assert.throws(() => restarted.exchangeNativeTicket(revokedTicket.ticket), { code: 'ADMIN_AUTH_REQUIRED' });
    checks.push('single-use short-lived native handoff tickets enforce launch permission and session revocation');
    const persistedUsers = createAdminAuth({ dataDir, now: () => time });
    const persistedOwner = await persistedUsers.login(replacementPassword, 'owner-after-restart');
    assert.equal(persistedUsers.listUsers(persistedOwner.token, persistedOwner.status.csrfToken).length, 1);
    checks.push('named users, viewer/customer permissions, revocation and persistence');

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
        const cookieUpdates = response.headers.getSetCookie?.() || [response.headers.get('set-cookie')].filter(Boolean);
        const cookieJar = new Map(String(cookie || '').split(';').map(value => {
            const separator = value.indexOf('=');
            return separator < 0 ? null : [value.slice(0, separator).trim(), value.slice(separator + 1).trim()];
        }).filter(Boolean));
        for (const update of cookieUpdates) {
            const pair = update.split(';', 1)[0], separator = pair.indexOf('=');
            if (separator < 0) continue;
            const name = pair.slice(0, separator), value = pair.slice(separator + 1);
            if (value) cookieJar.set(name, value);
            else cookieJar.delete(name);
        }
        return { response, data, cookie: [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ') };
    }
    try {
        assert.equal((await request('/config')).response.status, 401, 'the live dashboard must require a signed-in account');
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
        assert.equal((await request('/config', credentials)).response.status, 200);
        assert.equal(setup.data.user.role, 'owner');
        const nativeTicket = await request('/admin-auth/native-ticket', { method: 'POST', body: {}, ...credentials });
        assert.equal(nativeTicket.response.status, 200);
        assert.match(nativeTicket.data.ticket, /^[a-f0-9]{64}$/);
        const nativeExchange = await request('/admin-auth/native-exchange', { method: 'POST', body: { ticket: nativeTicket.data.ticket } });
        assert.equal(nativeExchange.response.status, 200);
        assert.equal(nativeExchange.data.authenticated, true);
        assert.ok(nativeExchange.response.headers.get('set-cookie').includes('Path=/api'));
        assert.equal((await request('/admin-auth/session', { cookie: nativeExchange.cookie })).data.authenticated, true);
        assert.equal((await request('/admin-auth/native-exchange', { method: 'POST', body: { ticket: nativeTicket.data.ticket } })).response.status, 401);
        const createdViewer = await request('/admin-auth/users', { method: 'POST', body: {
            username: 'shift_viewer', displayName: '值班查看员', role: 'viewer', password: replacementPassword
        }, ...credentials });
        assert.equal(createdViewer.response.status, 201);
        const savedViewer = await request('/admin-auth/accounts/login', { method: 'POST', body: {
            username: 'shift_viewer', password: replacementPassword, slotId: '0123456789abcdef01234567'
        }, cookie: credentials.cookie });
        assert.equal(savedViewer.response.status, 200);
        assert.equal(savedViewer.data.accountSlotId, '0123456789abcdef01234567');
        assert.equal((await request('/admin-auth/session', { cookie: savedViewer.cookie })).data.user.username, 'shift_viewer');
        const accountList = await request('/admin-auth/accounts', { cookie: savedViewer.cookie });
        assert.deepEqual(accountList.data.accounts.map(account => account.slotId).sort(), ['0123456789abcdef01234567', 'main']);
        const switchedOwner = await request('/admin-auth/accounts/activate', { method: 'POST', body: { slotId: 'main' },
            cookie: savedViewer.cookie, csrf: setup.data.csrfToken });
        assert.equal(switchedOwner.data.user.role, 'owner');
        const switchedViewer = await request('/admin-auth/accounts/activate', { method: 'POST', body: { slotId: '0123456789abcdef01234567' },
            cookie: switchedOwner.cookie, csrf: savedViewer.data.csrfToken });
        assert.equal((await request('/admin-auth/session', { cookie: switchedViewer.cookie })).data.user.username, 'shift_viewer');
        const signedOutViewer = await request('/admin-auth/accounts/logout', { method: 'POST', cookie: switchedViewer.cookie,
            csrf: savedViewer.data.csrfToken });
        assert.equal(signedOutViewer.data.authenticated, false);
        assert.equal(signedOutViewer.data.accountSlotId, 'none');
        assert.deepEqual((await request('/admin-auth/accounts', { cookie: signedOutViewer.cookie })).data.accounts.map(account => account.slotId), ['main']);
        const restoredOwner = await request('/admin-auth/accounts/activate', { method: 'POST', body: { slotId: 'main' },
            cookie: signedOutViewer.cookie, csrf: setup.data.csrfToken });
        assert.equal(restoredOwner.data.user.role, 'owner');
        checks.push('multiple named HttpOnly account sessions switch without passwords and sign out independently');
        const viewerLogin = await request('/admin-auth/login', { method: 'POST', body: {
            username: 'shift_viewer', password: replacementPassword
        } });
        assert.equal(viewerLogin.data.user.role, 'viewer');
        const viewerTicket = await request('/admin-auth/native-ticket', { method: 'POST', body: {}, cookie: viewerLogin.cookie,
            csrf: viewerLogin.data.csrfToken });
        assert.equal(viewerTicket.response.status, 403);
        assert.equal((await request('/settings', { method: 'PUT', body: {}, cookie: viewerLogin.cookie,
            csrf: viewerLogin.data.csrfToken })).response.status, 403);
        assert.equal((await request('/database/backups/test/download', { cookie: viewerLogin.cookie })).response.status, 403);
        assert.equal((await request('/admin-auth/users', { cookie: viewerLogin.cookie })).response.status, 403);
        checks.push('viewer account is denied management writes, private reads and user administration over HTTP');
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
        checks.push('HTTP login cookie, one-time native session exchange, CSRF/origin checks and settings endpoint');

        const navigation = await request('/native-preview/navigate', { method: 'POST', body: {
            action: 'view', viewId: 'factory', devices: [{ id: 'injected' }], includeLayout: true, view: { malicious: true }
        }, ...credentials });
        assert.equal(navigation.response.status, 200);
        assert.equal('devices' in previewPayload, false);
        assert.equal('view' in previewPayload, false);
        assert.equal('includeLayout' in previewPayload, false);
        assert.equal((await request('/native-preview/navigate', { method: 'POST', body: { action: 'apply' }, ...credentials })).response.status, 400);
        assert.equal((await request('/native-preview/navigate', { method: 'POST', body: { action: 'view' }, ...credentials, headers: { Origin: 'https://untrusted.invalid' } })).response.status, 403);
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
