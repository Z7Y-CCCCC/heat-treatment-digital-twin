const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { BACKEND_DIR, createRunDirectory, findFreePort, forceStop, startLoggedProcess, waitForHttp } = require('./integration-test-utils.cjs');
const { createSmokeProgramData } = require('../../desktop/scripts/smoke-sandbox.cjs');

let backend;
(async () => {
    const directory = createRunDirectory('admin-auth-integration');
    Object.assign(process.env, createSmokeProgramData(directory));
    process.env.APP_DATA_DIR = path.join(directory, 'data');
    process.env.LICENSE_FILE = path.join(process.env.APP_DATA_DIR, 'license.json');
    process.env.DB_TYPE = 'sqlite';
    process.env.SQLITE_FILE = path.join(process.env.APP_DATA_DIR, 'factory.db');
    process.env.UPLOADS_DIR = path.join(directory, 'uploads');
    process.env.PORT = String(await findFreePort(3911));
    process.env.HOST = '127.0.0.1';
    process.env.LICENSE_ENFORCE = 'false';
    process.env.ADMIN_API_TOKEN = crypto.randomBytes(32).toString('hex');
    process.env.MCP_API_TOKEN = crypto.randomBytes(32).toString('hex');
    const origin = `http://127.0.0.1:${process.env.PORT}`;
    process.env.TEST_BASE_URL = origin;
    process.env.MCP_TEST_URL = `${origin}/api/mcp`;
    const { getDb, closeDb } = require('../db/database');
    const db = await getDb();
    await db.upsert('settings', { key: 'data_mode', value: 'simulation' }, 'key');
    await db.upsert('settings', { key: 'lan_display_enabled', value: 'false' }, 'key');
    await closeDb();
    backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR, env: process.env, logFile: path.join(directory, 'backend.log')
    });
    await waitForHttp(`${origin}/api/health`);
    const malformedPassword = crypto.randomBytes(24).toString('hex');
    const malformed = await fetch(`${origin}/api/admin-auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"' + malformedPassword
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes(malformedPassword), false, 'parser errors must not echo a password');
    const denied = await fetch(`${origin}/api/settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(denied.status, 401, 'actual backend must reject anonymous local writes');

    // Use real cookie sessions and the actual mounted read routes, without
    // sending the automation token used by the separate regression scripts.
    async function sessionRequest(route, { method = 'GET', session, body } = {}) {
        const response = await fetch(`${origin}/api${route}`, {
            method,
            headers: { Origin: origin, 'X-Admin-Request': '1',
                ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const data = method === 'HEAD' ? null : await response.json();
        const cookies = (response.headers.getSetCookie?.() || []).map(value => value.split(';', 1)[0]).join('; ');
        return { response, data, cookie: cookies || session?.cookie || '', csrfToken: data?.csrfToken || session?.csrfToken };
    }
    const password = crypto.randomBytes(24).toString('base64url');
    const owner = await sessionRequest('/admin-auth/setup', { method: 'POST', body: { password } });
    assert.equal(owner.response.status, 200);
    for (const account of [{ username: 'display_viewer', role: 'viewer' },
        { username: 'no_display', role: 'customer', permissions: { view: false, launch: false, cast: false, backup: true } }]) {
        assert.equal((await sessionRequest('/admin-auth/users', { method: 'POST', session: owner, body: { ...account, password } })).response.status, 201);
    }
    const viewer = await sessionRequest('/admin-auth/login', { method: 'POST', body: { username: 'display_viewer', password } });
    const noDisplay = await sessionRequest('/admin-auth/login', { method: 'POST', body: { username: 'no_display', password } });
    const selectedSlot='a'.repeat(24);
    const slotted=await sessionRequest('/admin-auth/accounts/login',{method:'POST',session:owner,body:{slotId:selectedSlot,username:'display_viewer',password}});
    assert.equal(slotted.response.status,200);
    const touched=await sessionRequest('/admin-auth/touch',{method:'POST',session:slotted,body:{}});
    assert.equal(touched.response.status,200);assert.equal(touched.data.accountSlotId,selectedSlot);
    assert.equal(touched.data.user.username,'display_viewer');
    const ownerSettings=await sessionRequest('/admin-auth/settings',{method:'PUT',session:owner,body:{idleTimeoutMinutes:30}});
    assert.equal(ownerSettings.response.status,200);assert.equal(ownerSettings.data.accountSlotId,'main');
    const displayReads = ['/platform/metrics/latest', '/platform/events?limit=1', '/data-sources/map-values?level=world'];
    for (const route of displayReads) {
        for (const method of ['GET', 'HEAD'])
            assert.equal((await sessionRequest(route, { method, session: viewer })).response.status, 200, `${method} ${route} must support an authenticated display viewer`);
        assert.equal((await sessionRequest(route)).response.status, 401, `${route} must reject anonymous readers`);
        assert.equal((await sessionRequest(route, { session: noDisplay })).response.status, 403, `${route} must require the view capability`);
    }
    const managementReads = ['/platform', '/platform/designer', '/data-sources', '/data-sources/connections/missing/tables',
        '/platform/events/private', '/platform/metrics/latest/private', '/data-sources/map-values/private'];
    for (const route of managementReads)
        assert.equal((await sessionRequest(route, { session: viewer })).response.status, 403, `${route} must not inherit the display read exception`);
    for (const [method, route, body] of [
        ['POST', '/platform/events', { title: 'must not be written by viewer' }],
        ['POST', '/platform/releases', {}], ['PUT', '/platform/designer/draft', {}],
        ['POST', '/data-sources/preview', {}], ['POST', '/data-sources/connections', {}],
        ['DELETE', '/data-sources/connections/missing', {}],
        ['POST', '/platform/metrics/latest', {}], ['POST', '/data-sources/map-values', {}]
    ]) assert.equal((await sessionRequest(route, { method, body, session: viewer })).response.status, 403, `${method} ${route} must remain administrator-only`);
    assert.equal((await sessionRequest('/admin-auth/lock', { method: 'POST', session: owner, body: {} })).response.status, 200);
    for (const route of displayReads)
        assert.equal((await sessionRequest(route, { session: owner })).response.status, 200, `${route} must keep a locked display readable`);
    assert.equal((await sessionRequest('/platform/events', { method: 'POST', session: owner, body: { title: 'locked owner' } })).response.status, 401);
    const displayReadAuthorization = { actualReadRoutes: 3, viewerGetAndHead: true, anonymousAndNoViewDenied: true,
        managementReadsDenied: managementReads.length, managementWritesDenied: 8, lockedDisplayReadable: true };
    const scripts = ['dashboard-designer-test.cjs', 'native-scene-preview-test.cjs'];
    for (const script of scripts) {
        // Do not block this client's event loop for tens of seconds. Its HTTP
        // pool must process idle socket closure while the nested fixture runs;
        // spawnSync can leave stale keep-alive sockets for the next MCP request.
        const child = spawn(process.execPath, [path.join(__dirname, script)], {
            cwd: BACKEND_DIR, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; forceStop(child).catch(() => {}); }, 45000);
        const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
        assert.equal(timedOut, false, `${script} exceeded its owned fixture deadline`);
        assert.equal(status, 0, `${script} did not pass`);
    }
    // Verify MCP authorization and its nested HTTP calls without requiring a
    // commissioned factory / live Unity hardware in this isolated fixture.
    async function rpc(method, params = {}) {
        const response = await fetch(`${origin}/api/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-MCP-Token': process.env.MCP_API_TOKEN },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        assert.equal(response.status, 200);
        return response.json();
    }
    assert.ok((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name);
    const state = (await rpc('tools/call', { name: 'get_project_state' })).result.structuredContent;
    assert.ok(state.lines.length > 0);
    const created = await rpc('tools/call', { name: 'upsert_device', arguments: {
        id: 'admin_auth_integration_fixture', name: '后台访问测试设备', lineId: state.lines[0].id,
        modelType: 'builtin_furnace', plcEnabled: false
    } });
    assert.equal(created.result.isError, false, 'MCP credentials were not forwarded to the nested device API');
    assert.equal(created.result.structuredContent.success, true);
    console.log(JSON.stringify({ success: true, anonymousWriteBlocked: true, displayReadAuthorization, mcpNestedAuthorization: true, authenticatedRegressions: scripts, artifacts: directory }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    if (error.cause) console.error('REQUEST_ERROR_CAUSE', error.cause);
    process.exitCode = 1;
}).finally(() => forceStop(backend));
