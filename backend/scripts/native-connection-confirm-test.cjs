'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { createRunDirectory } = require('./integration-test-utils.cjs');
const { createAdminAuth } = require('../services/adminAuth');
const WsServer = require('../services/wsServer');
const { WebSocket } = require('ws');
const { adminSessionCookieName, adminWebSocketCookieName } = require('../middleware/security');
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
    const end = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < end, 'Timed out waiting for isolated peer'); await sleep(10); }
}
async function authFixture(realtime = false) {
    let time = Date.now();
    const auth = createAdminAuth({ dataDir: path.join(createRunDirectory('native-confirm'), 'data'), now: realtime ? Date.now : () => time });
    const password = crypto.randomBytes(24).toString('base64url');
    const owner = await auth.setup(password, 'fixture-source');
    return { auth, owner, password, advance: milliseconds => { time += milliseconds; } };
}

test('native proof binds a single-use exchange to its exact source and child session, with CSRF/active permissions', async () => {
    const { auth, owner, password, advance } = await authFixture();
    const ticket = auth.createNativeTicket(owner.token, owner.status.csrfToken).ticket;
    let queriedKey = '';
    const probe = sessionKey => { queriedKey = sessionKey; return { connected: true, sceneReady: true, secret: 'DO_NOT_EXPOSE' }; };
    assert.deepEqual(Object.keys(auth.confirmNativeTicket(owner.token, owner.status.csrfToken, ticket, probe)).sort(),
        ['success', 'exchanged', 'connected', 'sceneReady', 'observedAt'].sort());
    assert.equal(queriedKey, '', 'unexchanged ticket must not look at any existing Unity peer');
    const child = auth.exchangeNativeTicket(ticket);
    assert.throws(() => auth.exchangeNativeTicket(ticket), { code: 'NATIVE_TICKET_INVALID' });
    const confirmed = auth.confirmNativeTicket(owner.token, owner.status.csrfToken, ticket, probe);
    assert.equal(queriedKey, hash(child.token)); assert.equal(confirmed.connected, true); assert.equal(confirmed.sceneReady, true);
    assert.equal(JSON.stringify(confirmed).includes(ticket), false); assert.equal(JSON.stringify(confirmed).includes(child.token), false);
    assert.throws(() => auth.confirmNativeTicket(owner.token, 'bad-csrf', ticket, probe), { code: 'ADMIN_CSRF_INVALID' });
    const other = await auth.login(password, 'fixture-other-source');
    assert.throws(() => auth.confirmNativeTicket(other.token, other.status.csrfToken, ticket, probe), { code: 'NATIVE_CONFIRM_INVALID' });
    const viewerAccount = await auth.createUser(owner.token, owner.status.csrfToken, { username: 'native_confirm_viewer', role: 'viewer', password });
    const viewer = await auth.login(password, 'fixture-no-launch', '', viewerAccount.username);
    assert.throws(() => auth.confirmNativeTicket(viewer.token, viewer.status.csrfToken, ticket, probe), { code: 'ADMIN_PERMISSION_DENIED' });
    advance(30001);
    assert.throws(() => auth.confirmNativeTicket(owner.token, owner.status.csrfToken, ticket, probe), { code: 'NATIVE_CONFIRM_INVALID' });
    const next = auth.createNativeTicket(owner.token, owner.status.csrfToken).ticket;
    auth.lock(owner.token, owner.status.csrfToken);
    assert.throws(() => auth.createNativeTicket(owner.token, owner.status.csrfToken), { code: 'ADMIN_AUTH_REQUIRED' });
    assert.throws(() => auth.confirmNativeTicket(owner.token, owner.status.csrfToken, next, probe), { code: 'ADMIN_AUTH_REQUIRED' });
    assert.throws(() => auth.exchangeNativeTicket(next), { code: 'NATIVE_TICKET_INVALID' });
});

test('native confirmations automatically expire without a status poll and are bounded per process', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { auth, owner } = await authFixture();
    const ticket = auth.createNativeTicket(owner.token, owner.status.csrfToken).ticket;
    auth.exchangeNativeTicket(ticket);
    t.mock.timers.tick(30000);
    assert.throws(() => auth.confirmNativeTicket(owner.token, owner.status.csrfToken, ticket), { code: 'NATIVE_CONFIRM_INVALID' });
    for (let index = 0; index < 64; index++) auth.createNativeTicket(owner.token, owner.status.csrfToken);
    assert.throws(() => auth.createNativeTicket(owner.token, owner.status.csrfToken), { code: 'NATIVE_TICKET_LIMIT' });
    auth.lock(owner.token, owner.status.csrfToken);
});

test('native peer proof excludes other sessions, web role, stale sockets, future timestamps and scene-not-ready', async t => {
    const f = await authFixture(true), hub = new WsServer();
    const express = require('express'), app = express();
    app.use(express.json({ limit: '16kb' }));
    app.use('/api/admin-auth', require('../routes/adminAuth')(() => f.auth));
    const server = require('node:http').createServer(app);
    hub.attach(server, { verifyClient: (info, done) => {
        const prefix = `${adminWebSocketCookieName()}=`;
        const cookie = String(info.req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(prefix));
        const token = cookie?.slice(prefix.length) || '';
        info.req.adminSessionToken = f.auth.status(token).displayAuthenticated ? token : '';
        done(Boolean(info.req.adminSessionToken));
    } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`, sockets = [];
    const previousPort = process.env.PORT; process.env.PORT = String(server.address().port);
    const previousWsServer = global.wsServer; global.wsServer = hub;
    t.after(async () => {
        global.wsServer = previousWsServer;
        if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
        for (const socket of sockets) socket.terminate(); hub.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    });
    const request = async (route, { token = f.owner.token, csrf = f.owner.status.csrfToken, body = {}, originHeader = origin, adminRequest = '1' } = {}) => {
        const response = await fetch(`${origin}/api/admin-auth/${route}`, { method: 'POST', headers: {
            'Content-Type': 'application/json', 'X-Admin-Request': adminRequest, 'X-CSRF-Token': csrf, Origin: originHeader,
            Cookie: `${adminSessionCookieName()}=${token}`
        }, body: JSON.stringify(body) });
        return { response, data: await response.json() };
    };
    const connect = async (token, role) => {
        const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws`, { headers: { Cookie: `${adminWebSocketCookieName()}=${token}` } });
        sockets.push(socket); await once(socket, 'open'); socket.send(JSON.stringify({ type: 'client_hello', role }));
        await until(() => [...hub.clients].some(peer => peer.adminSessionKey === hash(token) && peer.clientRole === role));
        return socket;
    };
    const issued = await request('native-ticket'); assert.equal(issued.response.status, 200);
    const ticket = issued.data.ticket;
    await connect(f.owner.token, 'unity');
    let result = await request('native-confirm', { body: { ticket } });
    assert.equal(result.data.exchanged, false); assert.equal(result.data.connected, false);
    const child = f.auth.exchangeNativeTicket(ticket);
    result = await request('native-confirm', { body: { ticket } });
    assert.equal(result.data.exchanged, true); assert.equal(result.data.connected, false, 'an already-online Unity cannot satisfy another ticket');
    const newPeer = await connect(child.token, 'web');
    result = await request('native-confirm', { body: { ticket } }); assert.equal(result.data.connected, false);
    newPeer.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
    await until(() => hub.nativeSessionConnectionHealth(hash(child.token)).connected);
    result = await request('native-confirm', { body: { ticket } });
    assert.equal(result.data.connected, true); assert.equal(result.data.sceneReady, false);
    newPeer.send(JSON.stringify({ type: 'dashboard_context', payload: { sceneReady: true } }));
    await until(() => hub.nativeSessionConnectionHealth(hash(child.token)).sceneReady);
    result = await request('native-confirm', { body: { ticket } }); assert.equal(result.data.sceneReady, true);
    const peer = [...hub.clients].find(item => item.adminSessionKey === hash(child.token));
    peer.lastCommunicationAt = Date.now() - 16000;
    result = await request('native-confirm', { body: { ticket } }); assert.equal(result.data.connected, false);
    peer.lastCommunicationAt = Date.now() + 10000;
    result = await request('native-confirm', { body: { ticket } }); assert.equal(result.data.connected, false);
    assert.equal((await request('native-confirm', { body: { ticket }, csrf: 'invalid' })).response.status, 403);
    assert.equal((await request('native-confirm', { body: { ticket }, originHeader: 'https://untrusted.invalid' })).response.status, 403);
    assert.equal((await request('native-confirm', { body: { ticket }, adminRequest: '0' })).response.status, 403);
    assert.equal((await request('native-confirm', { body: { ticket, shell: 'DO_NOT_EXECUTE' } })).response.status, 400);
    assert.equal((await request('native-confirm', { body: { ticket }, token: '' })).response.status, 401);
    const responseText = JSON.stringify(result.data);
    assert.equal(responseText.includes(child.token), false); assert.equal(responseText.includes(hash(child.token)), false);
    newPeer.close(); await once(newPeer, 'close'); await until(() => !hub.nativeSessionConnectionHealth(hash(child.token)).connected);
});
