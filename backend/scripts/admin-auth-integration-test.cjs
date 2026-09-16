const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { BACKEND_DIR, createRunDirectory, findFreePort, forceStop, startLoggedProcess, waitForHttp } = require('./integration-test-utils.cjs');

let backend;
(async () => {
    const directory = createRunDirectory('admin-auth-integration');
    process.env.APP_DATA_DIR = path.join(directory, 'data');
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
    const scripts = ['dashboard-designer-test.cjs', 'native-scene-preview-test.cjs'];
    for (const script of scripts) {
        const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
            cwd: BACKEND_DIR, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 45000
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        assert.equal(result.status, 0, `${script} did not pass`);
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
    console.log(JSON.stringify({ success: true, anonymousWriteBlocked: true, mcpNestedAuthorization: true, authenticatedRegressions: scripts, artifacts: directory }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
}).finally(() => forceStop(backend));
