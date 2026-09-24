// Actual HTTP + WS against a freshly seeded output/ SQLite; never localhost:3001.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');
const { normalizeInspection, validateInspection } = require('../../shared/inspectionConfig.cjs');
const { stringifyModelMetadata } = require('../services/modelAssetMetadata');
const { getInspectionPresets, presetMetadata } = require('../services/inspectionPresets');
const { getBuiltinModels } = require('../services/builtinModels');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, forceStop, waitForHttp, requestJson, testFetch, waitUntil } = require('./integration-test-utils.cjs');

let backend;
const sockets = [];
const checks = [];
function check(name, run) { run(); checks.push(name); console.log(`PASS ${name}`); }
function glbNodes(modelId) {
    const model = getBuiltinModels().find(item => item.id === modelId);
    const file = fs.readFileSync(path.join(BACKEND_DIR, model.file_path.replace(/^\//, '')));
    const gltf = JSON.parse(file.toString('utf8', 20, 20 + file.readUInt32LE(12)));
    const nodes = [];
    function visit(index, ordinal, parentPath) {
        const node = gltf.nodes[index];
        const segment = `${node.name.replaceAll('/', '_')}#${ordinal}`;
        const nodePath = parentPath ? `${parentPath}/${segment}` : segment;
        nodes.push({ name: node.name, path: nodePath, parentPath, isMesh: node.mesh !== undefined });
        (node.children || []).forEach((child, childIndex) => visit(child, childIndex, nodePath));
    }
    gltf.scenes[gltf.scene || 0].nodes.forEach((index, ordinal) => visit(index, ordinal, ''));
    return nodes;
}

async function socket(origin, role, messages) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    sockets.push(ws);
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'client_hello', role }));
    return ws;
}

(async () => {
    const presets = getInspectionPresets();
    for (const preset of presets) check(`${preset.modelId} resolves every authored node and preserves full config`, () => {
        const validation = validateInspection(preset.inspection, glbNodes(preset.modelId));
        assert.deepEqual(validation.errors, []);
        assert.deepEqual(JSON.parse(stringifyModelMetadata(presetMetadata(preset.modelId))).inspection, preset.inspection);
    });
    check('canonical shell retains first target and opaque case-sensitive identifiers', () => {
        const config = normalizeInspection({ shell: { node_names: [' Cover ', 'cover'], node_paths: ['Root#0/Cover#0'] }, parts: [] });
        assert.deepEqual(config.shell.node_names, [' Cover ', 'cover']);
        assert.deepEqual(config.shell.node_paths, ['Root#0/Cover#0']);
        assert.deepEqual(normalizeInspection(config), config);
    });
    check('shell limit/missing nodes and conflicting parts are rejected without truncation', () => {
        assert.ok(validateInspection({ shell: { node_paths: Array.from({ length: 101 }, (_, i) => `Root#${i}`) } }).errors.some(error => error.code === 'too_many_shell_targets'));
        assert.ok(validateInspection({ shell: { node_names: ['missing'] } }, [{ name: 'found', path: 'found#0' }]).errors.some(error => error.code === 'missing_shell_node'));
        assert.equal(validateInspection({ parts: [{ id: 'a', node_path: 'Root#0' }, { id: 'b', node_path: 'Root#0/Child#0' }] }).valid, false);
        assert.ok(validateInspection({ shell: { node_path: 'Root#0' }, parts: [{ id: 'inner', node_path: 'Root#0/Child#0' }] }, [
            { name: 'Root', path: 'Root#0' }, { name: 'Child', path: 'Root#0/Child#0' }
        ]).errors.some(error => error.code === 'shell_part_overlap'));
    });
    check('explicit empty parts and disabled motion remain intentional', () => {
        const result = JSON.parse(stringifyModelMetadata({ partBindings: [{ id: 'fan', node_name: 'Fan' }], inspection: { parts: [] }, runtime: { enableGenericBindings: false } }));
        assert.deepEqual(result.inspection.parts, []);
        assert.equal(result.runtime.enableGenericBindings, false);
    });
    check('rich authoring survives backend write serialization including 256 PLC links', () => {
        const config = normalizeInspection({ ...presets[0].inspection, parts: [{ id: 'multi', group: 'group', node_names: ['A', 'B'], explode_rotation: [23, -37, 51], delay: .4, duration: 2,
            camera: { yaw: -28, pitch: -35, distance_scale: .08, target_offset: [1, 2, 3] }, point_ids: Array.from({ length: 256 }, (_, i) => `point-${i}`), enabled: false }] });
        assert.deepEqual(JSON.parse(stringifyModelMetadata({ inspection: config })).inspection, config);
    });
    check('packaging carries both shared module entry points', () => {
        const mapping = require('../../desktop/package.json').build.extraResources.find(item => item.to === 'shared');
        assert.ok(mapping.filter.includes('*.cjs') && mapping.filter.includes('*.mjs'));
    });

    const directory = createRunDirectory('inspection-platform');
    const dataDirectory = path.join(directory, 'data');
    await createTestDatabase(path.join(dataDirectory, 'factory.db'));
    const port = await findFreePort(3891);
    const origin = `http://127.0.0.1:${port}`;
    backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
        cwd: BACKEND_DIR, env: { ...process.env, APP_DATA_DIR: dataDirectory, PORT: String(port), HOST: '127.0.0.1' }, logFile: path.join(directory, 'backend.log')
    });
    await waitForHttp(`${origin}/api/health`);
    const unityMessages = [], webMessages = [];
    const unity = await socket(origin, 'unity', unityMessages);
    await socket(origin, 'web', webMessages);
    await waitUntil(async () => (await requestJson(`${origin}/api/native-preview/status`)).unityClients === 1, 5000, 'test Unity hello');
    const post = (route, payload) => requestJson(origin + route, { method: 'POST', body: JSON.stringify(payload) });
    const saved = structuredClone(presets[0].inspection);
    saved.parts[0].name = '往返保存验证';
    const modelId = presets[0].modelId;
    const result = await requestJson(`${origin}/api/models/${modelId}`, { method: 'PUT', body: JSON.stringify({ metadata: { ...presetMetadata(modelId), inspection: saved } }) });
    check('model PUT stores complete v2 fields in the isolated DB', () => assert.deepEqual(JSON.parse(result.model.metadata).inspection, saved));
    const modelChanged = await waitUntil(() => unityMessages.find(message => message.type === 'model_metadata_changed'), 5000, 'model metadata change event');
    check('model PUT notifies Unity to reload the new inspection metadata', () => assert.equal(modelChanged.payload.modelId, modelId));
    const models = await requestJson(`${origin}/api/models`);
    check('model GET reloads the same saved authoring', () => assert.deepEqual(JSON.parse(models.find(model => model.id === modelId).metadata).inspection, saved));
    const listed = await requestJson(`${origin}/api/models/inspection-presets`);
    check('preset endpoint supplies all four editable equipment examples', () => assert.equal(listed.presets.length, 4));
    const draft = structuredClone(saved); draft.parts[0].explode_offset = [2, 3, 4];
    const preview = { action: 'inspection_preview', focus: { mode: 'device', deviceId: 'fixture-device' }, inspectionConfig: draft };
    const denied = await fetch(`${origin}/api/native-preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preview) });
    check('anonymous unsaved engineer preview remains protected', () => assert.equal(denied.status, 401));
    await post('/api/native-preview', preview);
    const received = await waitUntil(() => unityMessages.find(message => message.payload?.action === 'inspection_preview'), 5000, 'unsaved preview');
    check('engineer preview forwards full config but never persists it', () => assert.deepEqual(received.payload.inspectionConfig, draft));
    const unchanged = (await requestJson(`${origin}/api/models`)).find(model => model.id === modelId);
    check('preview leaves saved model metadata unchanged', () => assert.equal(unchanged.metadata, result.model.metadata));
    for (const inspection of [{ command: 'stage', stage: 'exploded' }, { command: 'stage', stage: 'solid' }, { command: 'select', partId: saved.parts[0].id }, { command: 'progress', progress: .37 }, { command: 'isolate', enabled: true }, { command: 'labels', enabled: false }, { command: 'clear' }, { command: 'pause' }, { command: 'resume' }]) {
        const response = await testFetch(`${origin}/api/native-preview/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspection', focus: { mode: 'device', deviceId: 'fixture-device' }, inspection }) });
        assert.equal(response.status, 200);
    }
    await waitUntil(() => unityMessages.filter(message => message.payload?.action === 'inspection').length === 9, 5000, 'view-only commands');
    checks.push('nine viewing-only inspection commands reach Unity while admin is locked');
    const explodedView = await testFetch(`${origin}/api/native-preview/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'view', viewId: 'device_exploded', focus: { mode: 'device', deviceId: 'fixture-device', inspectionStage: 'exploded' } }) });
    check('device exploded view forwards its inspection stage to Unity', () => assert.equal(explodedView.status, 200));
    const explodedMessage = await waitUntil(() => unityMessages.find(message => message.type === 'native_scene_preview' && message.payload?.action === 'view' && message.payload?.focus?.inspectionStage === 'exploded'), 5000, 'exploded view stage');
    check('Unity navigation payload identifies the completed exploded stage', () => assert.equal(explodedMessage.payload.focus.inspectionStage, 'exploded'));
    const count = unityMessages.filter(message => message.type === 'native_scene_preview').length;
    for (const inspection of [{ command: 'delete' }, { command: 'stage', stage: 'bad' }, { command: 'progress', progress: -1 }, { command: 'isolate', enabled: 'false' }, { command: 'select' }]) {
        const response = await testFetch(`${origin}/api/native-preview/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'inspection', focus: { deviceId: 'fixture-device' }, inspection }) });
        assert.equal(response.status, 400);
    }
    check('invalid commands fail without broadcasting', () => assert.equal(unityMessages.filter(message => message.type === 'native_scene_preview').length, count));
    const context = { viewMode: 'device', viewId: 'device_exploded', deviceId: 'fixture-device', inspectionEnabled: true, inspectionStage: 'exploded', inspectionProgress: .37,
        inspectionAnimating: true, inspectionPhase: 'exploding', inspectionIsolated: false, inspectionLabelsEnabled: true, inspectionLeaderLines: true,
        inspectionHoveredPartId: 'part-1', inspectionIssues: [{ code: 'note', message: '结构示意', severity: 'warning' }],
        inspectionParts: [{ id: 'part-1', name: '泵组', group: 'drive', description: 'configured', pointIds: ['p1'], pointKeys: ['motors.speed'], selected: true,
            anchor: { x: .4, y: .5, visible: true }, label: { x: .35, y: .45, visible: true } }], partId: 'part-1', partPointIds: ['p1'] };
    unity.send(JSON.stringify({ type: 'dashboard_context', payload: context }));
    const frame = await waitUntil(() => webMessages.find(message => message.type === 'dashboard_context_changed' && message.payload.inspectionProgress === .37), 5000, 'inspection projections');
    check('WebSocket preserves spatial labels, issues, progress and PLC association', () => {
        assert.deepEqual(frame.payload.inspectionParts, context.inspectionParts);
        assert.equal(frame.payload.inspectionIssues[0].message, '结构示意');
        assert.equal(frame.payload.inspectionPhase, 'exploding');
    });
    unity.send(JSON.stringify({ type: 'dashboard_context', payload: { ...context, viewMode: 'factory', viewId: 'factory_overview' } }));
    const exited = await waitUntil(() => webMessages.find(message => message.payload?.viewMode === 'factory'), 5000, 'inspection exit');
    check('leaving device view clears inspection and selected-part state', () => { assert.equal(exited.payload.inspectionEnabled, false); assert.deepEqual(exited.payload.inspectionParts, []); assert.equal(exited.payload.partId, ''); });
    const evidence = { success: true, checks, origin, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(async () => {
    for (const socket of sockets) socket.terminate();
    await forceStop(backend);
});
