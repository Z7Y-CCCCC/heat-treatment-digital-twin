// Configuration-only acceptance: existing WebView widgets, built-in acquisition,
// and two explicit simulated external exports. No PLC settings or geometry writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const cad = require('./model-profiles/pit-workshop-cad-layout.json');

const TARGET = cad.target;
const PREFIX = 'pit_static_';
const OVERVIEWS = ['factory_overview', 'workshop_overview', 'line_overview'];
const DETAILS = ['device_detail']; // This pass deliberately does not configure animation/inspection views.
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PARAMS = [
    { key: 'actual_temp', label: '实际温度', path: 'analog.actual_temp', unit: '°C', decimals: 1 },
    { key: 'setpoint_temp', label: '设定温度', path: 'analog.setpoint_temp', unit: '°C', decimals: 0 },
    { key: 'fan_speed', label: '循环风机转速', path: 'motors.rear_fan_speed', unit: 'rpm', decimals: 0 },
    { key: 'fan_running', label: '循环风机', path: 'motors.rear_fan', onText: '运行', offText: '停止' },
    { key: 'cover_open', label: '炉盖状态', path: 'doors.front_door_open', onText: '开启', offText: '关闭' },
    { key: 'running', label: '设备运行', path: 'status.running', onText: '运行', offText: '待机' },
    { key: 'alarm', label: '报警状态', path: 'status.alarm', onText: '报警', offText: '正常' }
];

async function extractTemplates(source) {
    const { applyFactoryHudModules } = await import(pathToFileURL(path.resolve(__dirname, '../frontend/src/runtime/factoryHudModules.js')));
    const rendered = applyFactoryHudModules(source);
    const find = id => { const value = rendered.widgets.find(w => w.id === id); assert.ok(value, `Tianjin control missing: ${id}`); return value; };
    return Object.fromEntries(Object.entries({
        brand: 'heat_header_brand', panel: 'detail_params', label: 'cfg_param_Furnace_01_0_label',
        value: 'cfg_param_Furnace_01_0_value', pick: 'cfg_pick_Furnace_01',
        devices: 'reference_hud_factory_devices', events: 'reference_hud_factory_alarms'
    }).map(([key, id]) => {
        // Never copy Tianjin device IDs, point IDs, business records, actions or bindings.
        const w = find(id);
        return [key, { type: w.type, style: clone(w.style), frame: clone(w.frame), content: {}, sourceWidgetId: id }];
    }));
}

function createDemoPayloads(devices = cad.devices) {
    const furnaces = devices.filter(d => /^pit_furnace_/.test(d.model_type));
    const erp = { demo: true, demoVersion: 1, source: 'ERP 模拟导出（非现场业务）',
        summary: { orderCount: furnaces.length, plannedPieces: 540, completedPieces: 216 },
        orders: [], devices: {} };
    const vms = { demo: true, demoVersion: 1, source: 'VMS 模拟监控台账（无真实视频流）',
        summary: { cameraCount: 4, online: 3, maintenance: 1 }, cameras: [], devices: {} };
    furnaces.forEach((device, index) => {
        const number = String(device.number).padStart(2, '0');
        const batch = `PIT-${number}`, status = ['待装炉', '保温中', '待检验'][index % 3];
        const row = { id: batch, time: '生产订单', msg: `${number}号设备 · ${batch} · 60 件 · ${status}`, level: 'info', deviceId: device.id };
        erp.orders.push(row);
        erp.devices[device.id] = { rows: [row, { id: batch + '-material', time: '物料', msg: '42CrMo 工装件 · 工艺卡 HT-PIT-01', level: 'info' }] };
        const channel = index < 3 ? 1 : index < 6 ? 2 : 3;
        vms.devices[device.id] = { rows: [{ id: `CAM-${channel}`, time: `CH0${channel}`, msg: '车间监控 · 在线', level: 'info' }] };
    });
    ['炉前操作区', '炉体基坑区', '料台暂存区', '环件堆料区'].forEach((name, index) => {
        vms.cameras.push({ id: `CAM-${index + 1}`, time: `CH0${index + 1}`, msg: `${name} · ${index === 3 ? '维护中' : '在线'}`, level: index === 3 ? 'warning' : 'info' });
    });
    erp.fingerprint = hash(erp); vms.fingerprint = hash(vms);
    return { erp, vms };
}

function buildStaticDocument(target, templates) {
    const document = clone(target.designer.document);
    const existingIds = new Set(target.devices.map(d => d.id));
    assert.equal(existingIds.size, 17, 'inspect a changed workshop before applying this profile');
    for (const device of cad.devices) assert.ok(existingIds.has(device.id), `missing CAD object ${device.id}`);
    const widgets = document.widgets.filter(w => !w.id.startsWith(PREFIX));
    for (const widget of widgets.filter(w => w.type === 'navigation')) {
        widget.visible = false; // The brand and hierarchy already identify this factory.
        widget.content = { ...widget.content, projectLabel: '井式炉工厂', statusText: '' };
    }
    const add = (key, id, frame, content, views = OVERVIEWS, data = { mode: 'static' }, rules = []) => {
        const template = templates[key]; assert.ok(template, key);
        const widget = { id: PREFIX + id, type: template.type, runtimeTarget: 'overlay', visible: true,
            frame: { ...template.frame, ...frame }, style: clone(template.style), content, data: { readOnly: true, ...data },
            title: '', events: [], conditions: [], groupId: '', zIndex: key === 'panel' ? 10 : 20,
            animation: { type: 'none' }, visibility: { viewIds: views, rules, ruleMode: 'all', viewModes: [] } };
        widgets.push(widget); return widget;
    };
    const text = (id, frame, value, views = OVERVIEWS, rules = []) => add('label', id, frame, { text: value, showTitle: false }, views, { mode: 'static' }, rules);
    const events = (id, title, frame, connection, jsonPath, views = OVERVIEWS, rules = []) => {
        const w = add('events', id, frame, { showTitle: true, limit: 5, showTime: true, showLevel: false, eyebrow: connection === 'pit_demo_erp' ? 'ERP' : 'VMS', compact: true }, views,
            { mode: 'http_api', connectionId: connection, apiPath: '/', jsonPath, refreshMs: 5000 }, rules);
        w.title = title; return w;
    };
    add('brand', 'brand', { x: 88, y: 24, width: 650, height: 76 },
        { text: '井式炉工厂 · 车间运行总览', showTitle: false }, [...OVERVIEWS, ...DETAILS]);
    events('erp_orders', '生产订单', { x: 32, y: 170, width: 350, height: 360 }, 'pit_demo_erp', 'orders');
    events('vms_cameras', '视频监控', { x: 32, y: 550, width: 350, height: 320 }, 'pit_demo_vms', 'cameras');
    const furnaces = cad.devices.filter(d => /^pit_furnace_/.test(d.model_type)).sort((a, b) => a.number - b.number);
    add('panel', 'devices', { x: 1538, y: 170, width: 350, height: 570 }, { showTitle: false });
    text('devices_title', { x: 1552, y: 184, width: 322, height: 40 }, '炉体参数入口 · 9 台');
    furnaces.forEach((device, index) => {
        const row = add('pick', 'device_row_' + device.id, { x: 1552, y: 240 + index * 52, width: 190, height: 44 },
            { text: target.devices.find(d => d.id === device.id).name, align: 'left', showTitle: false });
        row.style.fontSize = 16;
        row.events = [{ trigger: 'click', action: 'switch_view', viewId: 'device_detail', deviceId: device.id, lineId: TARGET.lineId, workshopId: TARGET.workshopId }];
        const temperature = add('value', 'device_temp_' + device.id, { x: 1746, y: 240 + index * 52, width: 128, height: 44 },
            { text: '{value} °C', align: 'right', showTitle: false, fallback: '—' }, OVERVIEWS,
            { mode: 'runtime', deviceId: device.id, path: `deviceDataMap.${device.id}.analog.actual_temp`, decimals: 0 });
        temperature.style.fontSize = 20;
    });

    for (const device of cad.devices) {
        const actual = target.devices.find(d => d.id === device.id);
        const rules = [{ source: 'context', path: 'deviceId', operator: '==', value: device.id }];
        const isFurnace = /^pit_furnace_/.test(device.model_type);
        const label = actual.name || device.name;
        text('name_' + device.id, { x: 32, y: 205, width: 450, height: 40 }, label, DETAILS, rules);
        add('panel', 'params_panel_' + device.id, { x: 32, y: 260, width: 360, height: 400 }, { showTitle: false }, DETAILS, { mode: 'static' }, rules);
        if (isFurnace) {
            PARAMS.forEach((param, index) => {
                text('label_' + device.id + '_' + param.key, { x: 46, y: 274 + index * 50, width: 172, height: 42 }, param.label, DETAILS, rules);
                add('value', 'value_' + device.id + '_' + param.key, { x: 215, y: 274 + index * 50, width: 160, height: 42 },
                    { text: `{value}${param.unit ? ' ' + param.unit : ''}`, showTitle: false, fallback: '—', align: 'right', onText: param.onText, offText: param.offText }, DETAILS,
                    { mode: 'runtime', deviceScope: 'fixed', deviceId: device.id, path: `deviceDataMap.${device.id}.${param.path}`, decimals: param.decimals ?? 0 }, rules);
            });
            events('erp_' + device.id, '当前批次', { x: 32, y: 680, width: 360, height: 250 }, 'pit_demo_erp', `devices.${device.id}.rows`, DETAILS, rules);
            events('camera_' + device.id, '关联监控', { x: 1538, y: 680, width: 350, height: 250 }, 'pit_demo_vms', `devices.${device.id}.rows`, DETAILS, rules);
        } else {
            const model = target.models.find(m => m.id === device.model_type);
            const bounds = model?.metadata?.bounds_m || [];
            ['模型长度', '模型宽度', '模型高度'].forEach((label, index) => {
                text('passive_label_' + device.id + '_' + index, { x: 46, y: 274 + index * 72, width: 172, height: 44 }, label, DETAILS, rules);
                text('passive_' + device.id + '_' + index, { x: 222, y: 274 + index * 72, width: 150, height: 44 }, Number.isFinite(bounds[index]) ? bounds[index].toFixed(2) + ' m' : '—', DETAILS, rules);
            });
            text('passive_source_' + device.id, { x: 46, y: 475, width: 325, height: 44 }, '采集：未配置', DETAILS, rules);
        }
        add('panel', 'identity_panel_' + device.id, { x: 1538, y: 260, width: 350, height: 400 }, { showTitle: false }, DETAILS, { mode: 'static' }, rules);
        const rows = [`CAD 编号：${device.number}`, `类型：${isFurnace ? '井式炉' : '静态辅助设施'}`,
            `设备：${device.id}`, `X / Z：${device.pos_x} / ${device.pos_z} m`,
            `标高：${device.pos_y} m`, `模型：${target.models.find(m => m.id === device.model_type)?.name || device.model_type}`];
        rows.forEach((row, index) => text('info_' + device.id + '_' + index,
            { x: 1552, y: 274 + index * 52, width: 322, height: 48 }, row, DETAILS, rules));
    }
    document.widgets = widgets;
    document.name = '井式炉工厂 · 静态与数据接入验收';
    document.scene.defaultViewId = 'factory_overview';
    for (const view of document.scene.views) {
        if (OVERVIEWS.includes(view.id)) {
            view.targetId = view.mode === 'workshop' ? TARGET.workshopId : view.mode === 'line' ? TARGET.lineId : '';
            view.componentState = { ...view.componentState, show: [], hide: (view.componentState?.hide || []).filter(id => !id.startsWith(PREFIX)), hideNonTargetDevices: false };
        }
        if (view.id === 'device_detail') view.componentState = { ...view.componentState, show: [], hide: [], hideNonTargetDevices: true };
    }
    document.metadata = { ...document.metadata, pitStaticDisplay: 1, inheritedControlsFrom: 'factory_default',
        externalDemo: { erp: true, vms: true, transport: 'imported-json', videoStreams: false },
        acquisition: 'existing built-in simulation; no live PLC commissioned', staticCadGeometryPreserved: true };
    // No reference-HUD migrations may reinsert Tianjin widgets/bindings into this custom document.
    delete document.metadata.referenceHud; delete document.metadata.factoryHudModules;
    assert.ok(document.widgets.length <= 500);
    return document;
}

function createClient(origin, token, factoryId) {
    let sequence = 0;
    const headers = { 'X-Admin-Token': token, 'X-Factory-ID': factoryId };
    const api = async (route, method = 'GET', body) => {
        const multipart = body instanceof FormData;
        const response = await fetch(origin + route, { method, headers: { ...headers, ...(multipart ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
        const value = await response.json(); assert.ok(response.ok && !value.error, `${method} ${route}: ${response.status} ${value.error || ''}`); return value;
    };
    const call = async (name, args = {}) => {
        const envelope = await api('/api/mcp', 'POST', { jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } });
        assert.ok(!envelope.error && !envelope.result.isError, `${name}: ${envelope.error?.message || envelope.result?.content?.[0]?.text || ''}`);
        return envelope.result.structuredContent || JSON.parse(envelope.result.content[0].text);
    };
    return { api, call };
}

async function installDemoSource(client, id, name, payload) {
    const sources = await client.api('/api/data-sources');
    let existing = sources.connections.find(c => c.id === id);
    if (existing) {
        assert.equal(existing.connector, 'file', 'refusing to replace a real external connection');
        try {
            const current = await client.api('/api/data-sources/preview-http', 'POST', { connectionId: id, apiPath: '/', jsonPath: 'fingerprint' });
            if (current.result.value === payload.fingerprint) return existing;
        } catch { /* A missing private import is repaired with a new owned asset. */ }
    }
    const form = new FormData(); form.set('dataFile', new Blob([JSON.stringify(payload)]), id + '.json');
    const imported = await client.api('/api/data-sources/files', 'POST', form);
    const config = { id, name, sourceType: 'http_api', connector: 'file', baseUrl: imported.file.asset,
        healthPath: '/', responseFormat: 'json', authType: 'none', enabled: true, requestTimeoutMs: 3000 };
    const tested = await client.api('/api/data-sources/test', 'POST', config);
    assert.equal(tested.health.status, 'healthy');
    return (await client.api('/api/data-sources/connections' + (existing ? '/' + id : ''), existing ? 'PUT' : 'POST', { ...config, healthToken: tested.healthToken })).connection;
}

async function applyStaticDisplay(origin, token, { factoryId = TARGET.factoryId, sourceFactoryId = 'factory_default', templates: suppliedTemplates } = {}) {
    assert.ok(token, 'An authorized administrator session is required');
    const directory = createRunDirectory('pit-static-display');
    const client = createClient(origin, token, factoryId), sourceClient = createClient(origin, token, sourceFactoryId);
    const before = await client.call('get_project_state');
    assert.equal(before.settings.data_mode, 'simulation', 'This acceptance expects the existing built-in simulator; never switch live PLC mode silently');
    const source = await sourceClient.call('get_project_state');
    const sourceDocument = source.designer.currentRelease?.snapshot || source.designer.document;
    const sourceHash = hash(sourceDocument);
    fs.writeFileSync(path.join(directory, 'before.json'), JSON.stringify(before, null, 2), { mode: 0o600 });
    const templates = suppliedTemplates || await extractTemplates(sourceDocument);
    const payloads = createDemoPayloads();
    for (const [kind, payload] of Object.entries(payloads)) await installDemoSource(client, 'pit_demo_' + kind, `${kind.toUpperCase()} · 模拟外部导出`, payload);
    const document = buildStaticDocument(before, templates);
    const saved = await client.call('save_dashboard_draft', { sceneId: before.designer.scene.id, document, expectedRevision: before.designer.revision });
    const released = await client.call('publish_dashboard', { sceneId: before.designer.scene.id, version: `1.2.${saved.revision}`, notes: '井式炉静态展示；天津控件复用；内置模拟采集 + ERP/VMS 模拟外部导出' });
    const after = await client.call('get_project_state');
    assert.deepEqual(after.devices, before.devices, 'static acceptance must not change devices, PLC, transforms or point bindings');
    assert.deepEqual(after.workshops, before.workshops); assert.deepEqual(after.lines, before.lines);
    const unchanged = await sourceClient.call('get_project_state');
    assert.equal(hash(unchanged.designer.currentRelease?.snapshot || unchanged.designer.document), sourceHash, 'Tianjin release must be unchanged');
    assert.equal(unchanged.designer.revision, source.designer.revision, 'Tianjin draft must be unchanged');
    fs.writeFileSync(path.join(directory, 'after.json'), JSON.stringify(after, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'templates.json'), JSON.stringify(templates, null, 2));
    const values = await client.api('/api/data-sources/runtime-values?view_id=line_overview&line_id=' + TARGET.lineId);
    assert.equal(values.values[PREFIX + 'erp_orders'].quality, 'good');
    assert.equal(values.values[PREFIX + 'vms_cameras'].quality, 'good');
    const result = { success: true, directory, releaseId: released.release.id, revision: saved.revision,
        widgets: document.widgets.length, objects: 17, furnaceDevices: 9, passiveFacilities: 8,
        externalSources: ['pit_demo_erp', 'pit_demo_vms'], externalTransport: 'imported JSON exports, not live ERP/VMS',
        acquisition: 'built-in simulation (no site PLC connected)', sourceFactoryUnchanged: true, geometryAndPlcUnchanged: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); return result;
}
module.exports = { TARGET, PREFIX, PARAMS, createClient, extractTemplates, createDemoPayloads, buildStaticDocument, applyStaticDisplay };
if (require.main === module) applyStaticDisplay(process.env.PIT_CAD_ORIGIN || 'http://127.0.0.1:3001', process.env.ADMIN_API_TOKEN)
    .then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
