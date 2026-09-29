const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
    BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort,
    startLoggedProcess, waitForHttp, forceStop
} = require('./integration-test-utils.cjs');

async function main() {
    const directory = createRunDirectory('mcp-platform');
    const dataDir = path.join(directory, 'data');
    await createTestDatabase(path.join(dataDir, 'factory.db'));
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;
    const token = crypto.randomBytes(32).toString('hex');
    const env = { ...process.env, NODE_ENV: 'test', APP_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ADMIN_API_TOKEN: token, MCP_API_TOKEN: token, MCP_TEST_URL: `${origin}/api/mcp` };
    const backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR, env, logFile: path.join(directory, 'backend.log')
    });
    async function api(url, factoryId = 'factory_default', body) {
        const response = await fetch(`${origin}${url}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token, 'X-MCP-Token': token, 'X-Factory-ID': factoryId },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        const result = await response.json();
        assert.ok(response.ok, JSON.stringify(result));
        return result;
    }
    async function rpc(name, args = {}, factoryId = 'factory_default', expectError = false) {
        const response = await api('/api/mcp', factoryId, { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } });
        assert.equal(response.result?.isError, expectError, JSON.stringify(response.result?.content));
        return response.result.structuredContent;
    }
    try {
        await waitForHttp(`${origin}/api/health`, 30000);
        const original = await rpc('get_project_state');
        const created = await api('/api/factories', 'factory_default', { name: 'MCP 隔离测试工厂' });
        const factoryId = created.factory.id;
        const secondary = await rpc('get_project_state', {}, factoryId);
        assert.equal(secondary.factoryId, factoryId);
        assert.deepEqual(secondary.workshops, []);
        assert.deepEqual(secondary.devices, []);
        assert.notEqual(secondary.designer.scene.id, original.designer.scene.id);
        await rpc('upsert_workshop', { id: 'mcp_isolated_ws', name: '独立车间' }, factoryId);
        await rpc('upsert_line', { id: 'mcp_isolated_line', name: '独立产线', workshopId: 'mcp_isolated_ws' }, factoryId);
        await rpc('upsert_workshop', { id: 'mcp_isolated_ws', name: '不能覆盖其他工厂' }, 'factory_default', true);
        assert.equal((await api('/api/workshops', factoryId))[0].name, '独立车间');
        assert.equal((await api('/api/lines', factoryId))[0].id, 'mcp_isolated_line');
        assert.equal((await api('/api/workshops')).some(row => row.id === 'mcp_isolated_ws'), false);
        await rpc('save_dashboard_draft', { sceneId: original.designer.scene.id, document: original.designer.document, expectedRevision: original.designer.revision }, factoryId, true);
        await rpc('publish_dashboard', { sceneId: original.designer.scene.id }, factoryId, true);
        const defaultSettings = await api('/api/settings');
        await rpc('set_data_mode', { mode: 'simulation', simulationIntervalMs: 1234 }, factoryId);
        assert.equal((await api('/api/settings', factoryId)).simulation_interval_ms, '1234');
        assert.equal((await api('/api/settings')).simulation_interval_ms, defaultSettings.simulation_interval_ms);
        const configured = await rpc('configure_demo_site');
        assert.equal(configured.success, true);
        const repeated = await rpc('configure_demo_site');
        assert.equal(repeated.success, true);
        const after = await rpc('get_project_state');
        assert.equal(after.workshops.filter(row => row.id === 'ws_demo_south').length, 1);
        assert.equal(after.designer.document.widgets.filter(widget => widget.groupId === 'group_device_part_detail').length, 3);
        assert.equal((await rpc('get_project_state', {}, factoryId)).devices.length, 0);
        const otherDemo = await rpc('configure_demo_site', {}, factoryId);
        const repeatedOther = await rpc('configure_demo_site', {}, factoryId);
        assert.equal(otherDemo.success, true);
        assert.deepEqual(repeatedOther.deviceIds, otherDemo.deviceIds);
        assert.ok(otherDemo.deviceIds.every(id => !configured.deviceIds.includes(id)));
        const otherState = await rpc('get_project_state', {}, factoryId);
        assert.equal(otherState.devices.length, 3);
        assert.equal(otherState.designer.document.widgets.filter(widget => widget.groupId === 'group_device_part_detail').length, 3);
        assert.equal((await rpc('get_project_state')).designer.currentRelease.id, after.designer.currentRelease.id);
        // Device/point changes queue collector restarts; wait for the completed
        // mode switch rather than checking in the middle of its debounce.
        for (let attempt = 0; attempt < 50; attempt += 1) {
            const state = await rpc('get_project_state');
            if (state.engine?.mode === 'simulation') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        for (const script of ['mcp-interface-test.cjs', 'native-scene-preview-test.cjs']) {
            const result = spawnSync(process.execPath, [path.join(__dirname, script)], { cwd: BACKEND_DIR, env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
            fs.writeFileSync(path.join(directory, `${script}.log`), `${result.stdout || ''}\n${result.stderr || ''}`);
            assert.equal(result.status, 0, `${script}: ${result.error?.message || result.stderr}`);
        }
        const summary = { success: true, factoryIsolation: true, demoRepeatable: true, inspectionBindings: true, mcpInterface: true, nativePreview: true, directory };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary));
    } finally { await forceStop(backend); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
