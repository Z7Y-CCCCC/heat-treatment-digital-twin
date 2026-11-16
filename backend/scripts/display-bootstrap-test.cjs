'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { createAdminAuth } = require('../services/adminAuth');
const { displaySessionCookieName, adminSessionCookieName, suppliedReadSession } = require('../middleware/security');
const permissions = { view: true, launch: true, edit: false, manageUsers: false, cast: false, backup: false };
test('fresh local display needs no account/password and can never unlock any administration capability', async () => {
    const dataDir = path.join(createRunDirectory('display-bootstrap'), 'data'), auth = createAdminAuth({ dataDir });
    const display = auth.bootstrapDisplay();
    assert.equal(display.status.configured, false); assert.equal(display.status.authenticated, false);
    assert.equal(display.status.displayAuthenticated, true); assert.equal(display.status.displayOnly, true);
    assert.deepEqual(display.status.permissions, permissions); assert.equal(display.status.user.role, 'display');
    assert.equal(fs.existsSync(path.join(dataDir, 'admin-security.json')), false, 'no owner/account is silently created');
    assert.equal(auth.bootstrapDisplay(display.token).token, display.token, 'bootstrap is idempotent');
    for (const capability of ['session', 'owner', 'admin', 'edit', 'cast', 'backup', 'page:settings.runtime:edit'])
        assert.throws(() => auth.requireSession(display.token, display.status.csrfToken, { permission: capability }), { code: 'ADMIN_AUTH_REQUIRED' });
    for (const capability of ['view', 'launch']) assert.ok(auth.requireSession(display.token, display.status.csrfToken, { permission: capability }));
    assert.throws(() => auth.createDisplayTicket(display.token, 'wrong'), { code: 'ADMIN_CSRF_INVALID' });
    const ticket = auth.createDisplayTicket(display.token, display.status.csrfToken).ticket;
    const child = auth.exchangeNativeTicket(ticket);
    assert.equal(child.status.authenticated, false); assert.equal(child.status.displayOnly, true); assert.deepEqual(child.status.permissions, permissions);
    assert.throws(() => auth.exchangeNativeTicket(ticket), { code: 'NATIVE_TICKET_INVALID' });
    assert.throws(() => auth.createNativeTicket(child.token, child.status.csrfToken), { code: 'ADMIN_AUTH_REQUIRED' });
    assert.throws(() => auth.createDisplayTicket(child.token, child.status.csrfToken), { code: 'DISPLAY_SESSION_REQUIRED' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'admin-sessions.json'))).rows, [], 'display identities never enter persisted engineer sessions');
});
test('admin lock, logout, service restart and long display expiry never turn machine viewing into administrator access', async () => {
    let time = Date.now(); const dataDir = path.join(createRunDirectory('display-separation'), 'data');
    const auth = createAdminAuth({ dataDir, now: () => time });
    const display = auth.bootstrapDisplay(), owner = await auth.setup(crypto.randomBytes(24).toString('hex'), 'fixture');
    auth.lock(owner.token, owner.status.csrfToken);
    assert.equal(auth.status(display.token).displayAuthenticated, true);
    assert.equal(auth.status(display.token).authenticated, false);
    const ticket = auth.createDisplayTicket(display.token, display.status.csrfToken).ticket;
    assert.equal(auth.exchangeNativeTicket(ticket).status.authenticated, false);
    auth.logout(owner.token, owner.status.csrfToken);
    assert.equal(auth.status(display.token).displayAuthenticated, true);
    const restarted = createAdminAuth({ dataDir, now: () => time });
    assert.equal(restarted.status(display.token).displayAuthenticated, false);
    assert.equal(restarted.bootstrapDisplay().status.authenticated, false);
    time += 31 * 24 * 3600000;
    assert.equal(auth.status(display.token).displayAuthenticated, false);
    assert.throws(() => auth.createDisplayTicket(display.token, display.status.csrfToken), { code: 'ADMIN_AUTH_REQUIRED' });
    assert.equal(auth.bootstrapDisplay().status.authenticated, false);
});
test('bootstrap and ticket HTTP routes remain local/origin guarded, cookies are HttpOnly, and management stays locked', async t => {
    const auth = createAdminAuth({ dataDir: path.join(createRunDirectory('display-http'), 'data') });
    const express = require('express'), app = express(); app.use(express.json());
    app.use('/api/admin-auth', require('../routes/adminAuth')(() => auth));
    const server = require('node:http').createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, oldPort = process.env.PORT;
    process.env.PORT = String(server.address().port);
    t.after(async () => { if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    let cookie = '', csrf = '';
    async function request(route, body, headers = {}) {
        const response = await fetch(origin + '/api/admin-auth/' + route, { method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Admin-Request': '1', Cookie: cookie, 'X-CSRF-Token': csrf, ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { response, data: await response.json() };
    }
    assert.equal((await request('display-bootstrap', {}, { Origin: 'http://untrusted.invalid' })).response.status, 403);
    const boot = await request('display-bootstrap', {}); assert.equal(boot.response.status, 200);
    const setCookie = boot.response.headers.getSetCookie(); assert.ok(setCookie.every(value => /HttpOnly/.test(value) && /SameSite=Strict/.test(value)));
    cookie = setCookie.map(value => value.split(';')[0]).join('; ');
    assert.match(cookie, new RegExp(displaySessionCookieName())); assert.ok(!cookie.startsWith(adminSessionCookieName() + '='));
    const status = await request('session'); csrf = status.data.csrfToken;
    assert.equal(status.data.authenticated, false); assert.equal(status.data.displayOnly, true);
    const ticket = await request('native-display-ticket', {}); assert.equal(ticket.response.status, 200);
    const exchange = await request('native-exchange', { ticket: ticket.data.ticket });
    assert.equal(exchange.response.status, 200); assert.equal(exchange.data.authenticated, false); assert.equal(exchange.data.displayOnly, true);
    assert.equal((await request('native-ticket', {})).response.status, 401);
    assert.equal((await request('users')).response.status, 401);
    assert.equal((await request('native-display-ticket', {}, { 'X-CSRF-Token': 'bad' })).response.status, 403);
    const req = { get: name => name === 'cookie' ? cookie : '' };
    const readToken = suppliedReadSession(req, auth); assert.equal(auth.status(readToken).displayOnly, true);
    for (const permission of ['admin', 'page:settings.data:edit']) assert.throws(() => auth.requireSession(readToken, csrf, { permission }), { code: 'ADMIN_AUTH_REQUIRED' });
});
