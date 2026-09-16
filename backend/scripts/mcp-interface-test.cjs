const assert = require('assert');

const BASE = process.env.MCP_TEST_URL || 'http://127.0.0.1:3001/api/mcp';

async function rpc(id, method, params = {}) {
    const response = await fetch(BASE, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(process.env.MCP_API_TOKEN ? { 'X-MCP-Token': process.env.MCP_API_TOKEN } : {}),
            ...(process.env.ADMIN_API_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_API_TOKEN } : {})
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
    return response.json();
}

(async () => {
    const init = await rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-interface-test', version: '1.0.0' }
    });
    assert.equal(init.result.serverInfo.name, 'digital-twin-control-mcp');

    const list = await rpc(2, 'tools/list');
    const toolNames = list.result.tools.map(tool => tool.name);
    for (const name of [
        'get_project_state', 'get_model_inspection', 'get_model_inspection_presets', 'apply_model_inspection_preset',
        'validate_model_inspection', 'save_model_inspection', 'update_model_inspection',
        'apply_model_inspection_layout', 'update_model_part_bindings', 'update_model_metadata',
        'configure_demo_site', 'configure_readonly_business_source', 'run_acceptance_checks',
        'get_license_status', 'get_release_status'
    ]) {
        assert(toolNames.includes(name), `工具缺失：${name}`);
    }

    const state = await rpc(3, 'tools/call', { name: 'get_project_state', arguments: {} });
    assert.equal(state.result.isError, false);
    assert(state.result.structuredContent.designer.document.scene.views.some(view => view.id === 'device_part'));

    const inspections = await rpc(31, 'tools/call', { name: 'get_model_inspection', arguments: { includeMetadata: false } });
    assert.equal(inspections.result.isError, false);
    assert(inspections.result.structuredContent.models.length > 0, '模型拆解清单为空');
    assert(inspections.result.structuredContent.models.every(item => item.validation.valid), '存在结构不合法的模型拆解配置');

    const presets = await rpc(32, 'tools/call', { name: 'get_model_inspection_presets', arguments: {} });
    assert.equal(presets.result.isError, false);
    assert(presets.result.structuredContent.count > 0, '模型拆解模板为空');

    const checks = await rpc(4, 'tools/call', { name: 'run_acceptance_checks', arguments: {} });
    assert.equal(checks.result.structuredContent.success, true);
    assert(checks.result.structuredContent.checks.every(check => check.passed), '存在未通过的 MCP 验收项');

    const license = await rpc(5, 'tools/call', { name: 'get_license_status', arguments: {} });
    assert.equal(license.result.structuredContent.readOnly, true);

    const release = await rpc(6, 'tools/call', { name: 'get_release_status', arguments: {} });
    assert.equal(release.result.structuredContent.mode, 'offline_signed_package');

    console.log(JSON.stringify({ success: true, protocolVersion: init.result.protocolVersion, tools: toolNames.length, checks: checks.result.structuredContent.checks.length }, null, 2));
})().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
