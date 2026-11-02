// Actual running Unity: authorized MCP/API queries and projection telemetry only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('../backend/node_modules/ws');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const { createClient, TARGET, PREFIX, PARAMS } = require('./pit-static-display.cjs');
const cad = require('./model-profiles/pit-workshop-cad-layout.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function verify(origin, token) {
    assert.ok(token, 'Administrator authorization is required');
    const directory = createRunDirectory('pit-static-live');
    const client = createClient(origin, token, TARGET.factoryId);
    const state = await client.call('get_project_state');
    assert.equal(state.devices.length, 17); assert.equal(state.designer.document.metadata.pitStaticDisplay, 1);
    assert.equal(state.designer.document.widgets.filter(w => w.id.startsWith(PREFIX + 'pick_')).length, 0, 'bottom device shortcuts must stay removed');
    assert.equal(state.settings.data_mode, 'simulation');
    const external = await client.api('/api/data-sources');
    for (const id of ['pit_demo_erp', 'pit_demo_vms']) {
        const source = external.connections.find(c => c.id === id); assert.ok(source?.readOnly); assert.equal(source.connector, 'file');
        const tested = await client.api('/api/data-sources/test', 'POST', { id }); assert.equal(tested.health.status, 'healthy');
    }
    const values = await client.api('/api/data-sources/runtime-values?view_id=line_overview');
    assert.equal(values.values[PREFIX + 'erp_orders'].rows.length, 9); assert.equal(values.values[PREFIX + 'vms_cameras'].rows.length, 4);
    assert.ok(Object.values(values.values).every(record => record.quality === 'good'));
    for (const spec of cad.devices.filter(d => d.number <= 9)) {
        const rows = values.values[PREFIX + 'erp_' + spec.id].rows;
        assert.ok(rows.some(r => r.msg.includes('PIT-' + String(spec.number).padStart(2, '0'))));
        for (const param of PARAMS) {
            const widget = state.designer.document.widgets.find(w => w.id === PREFIX + 'value_' + spec.id + '_' + param.key);
            assert.equal(widget.data.path, `deviceDataMap.${spec.id}.${param.path}`);
        }
    }
    await client.api('/api/factories/' + TARGET.factoryId + '/activate', 'POST', {});
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws', { headers: { 'X-Admin-Token': token, 'X-Factory-ID': TARGET.factoryId } });
    let context, projection;
    const latest = new Map(), observed = [];
    socket.on('message', bytes => {
        const m = JSON.parse(bytes);
        if (m.type === 'dashboard_context_changed') context = m.payload;
        if (m.type === 'scene_projection') projection = m.payload;
        if (m.type === 'realtime_frame') for (const device of m.payload.devices) latest.set(device.furnace_id, device);
    });
    const until = async (predicate, label) => { const deadline = Date.now() + 45000; while (Date.now() < deadline) { if (predicate()) return; await sleep(200); } throw Error('Unity verification timeout: ' + label); };
    const navigate = async (viewId, focus) => {
        const priorSequence = projection?.seq || 0;
        const result = await client.api('/api/native-preview/navigate', 'POST', { action: 'view', viewId, focus });
        assert.ok(result.sent === true || Number(result.sent) > 0, 'actual Unity must be connected');
        await until(() => context?.factoryId === TARGET.factoryId && context?.sceneReady && context?.viewId === viewId
            && (!focus.deviceId || context.deviceId === focus.deviceId) && projection?.available && projection.seq > priorSequence && projection.viewId === viewId, viewId + ' ' + (focus.deviceId || ''));
        await sleep(850);
    };
    try {
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('WebSocket timeout')), 10000); socket.once('open', () => { clearTimeout(timer); resolve(); }); socket.once('error', error => { clearTimeout(timer); reject(error); }); });
        socket.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
        socket.send(JSON.stringify({ type: 'scene_projection_subscribe', enabled: true }));
        await navigate('line_overview', { mode: 'line', lineId: TARGET.lineId, workshopId: TARGET.workshopId });
        assert.equal(projection.devices.length, 17); assert.equal(projection.devices.filter(d => d.visible).length, 17);
        const baseline = new Map(projection.devices.map(d => [d.id, d.matrix]));
        await until(() => cad.devices.filter(d => d.number <= 9).every(d => latest.has(d.id)), 'all nine internal-acquisition frames');
        for (const spec of cad.devices.filter(d => d.number <= 9)) {
            const data = latest.get(spec.id);
            for (const p of PARAMS) {
                const [group, key] = p.path.split('.'); assert.ok(data[group]?.[key] !== undefined); assert.equal(data.quality[group][key], 'good');
            }
        }
        for (const spec of cad.devices) {
            await navigate('device_detail', { mode: 'device', deviceId: spec.id, lineId: TARGET.lineId, workshopId: TARGET.workshopId });
            const selected = projection.devices.find(d => d.id === spec.id); assert.ok(selected?.visible, spec.id + ' must be visible in actual Unity');
            for (const device of projection.devices) for (let i = 0; i < 16; i++) assert.ok(Math.abs(device.matrix[i] - baseline.get(device.id)[i]) < 1e-4, device.id + ' static transform changed');
            observed.push({ id: spec.id, viewId: context.viewId, visible: true, staticTransformPreserved: true });
        }
        await navigate('line_overview', { mode: 'line', lineId: TARGET.lineId, workshopId: TARGET.workshopId });
        const frame1 = new Map(projection.devices.map(d => [d.id, d.matrix])); await sleep(1500);
        for (const d of projection.devices) assert.deepEqual(d.matrix, frame1.get(d.id), 'static layout must remain stationary while values update');
        const report = { success: true, directory, method: 'authenticated project MCP + native view API / WebSocket',
            actualUnityObjects: 17, verifiedDeviceViews: observed.length, internallyCollectedParameters: 9 * PARAMS.length,
            externalReadOnlyConnections: 2, erpOrders: 9, vmsCameraRecords: 4, staticTransformsPreserved: true,
            finalView: context.viewId, acquisition: 'built-in simulator; no live site PLC', externalData: 'sample exports; no live ERP/VMS/video' };
        fs.writeFileSync(path.join(directory, 'native-views.json'), JSON.stringify(observed, null, 2));
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
        return report;
    } finally { socket.close(); }
}
module.exports = { verify };
if (require.main === module) verify(process.env.PIT_CAD_ORIGIN || 'http://127.0.0.1:3001', process.env.ADMIN_API_TOKEN)
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
