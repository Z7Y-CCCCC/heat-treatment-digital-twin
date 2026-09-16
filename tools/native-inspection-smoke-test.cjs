const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('../backend/node_modules/better-sqlite3');
const { WebSocket } = require('../backend/node_modules/ws');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, requestJson, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { getInspectionPresets } = require('../backend/services/inspectionPresets');

const root = path.resolve(__dirname, '..');
const executable = path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
let backend, unity, web;
(async () => {
    if (!fs.existsSync(executable)) throw new Error('Build the current Unity client before running this test');
    const sandbox = await createSmokeSandbox('native-inspection');
    const presets = getInspectionPresets();
    const db = new Database(sandbox.filename);
    const devices = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 4').all();
    assert.equal(devices.length, 4);
    for (let index = 0; index < devices.length; index++) {
        db.prepare("UPDATE devices SET model_type=?,model_file=NULL,rotation_y=?,scale=1,instance_config='{}',plc_enabled=0 WHERE id=?").run(presets[index].modelId, [0, 35, -65, 135][index], devices[index].id);
    }
    db.close();
    const port = await findFreePort(3921);
    const origin = `http://127.0.0.1:${port}`;
    const logFile = path.join(sandbox.directory, 'unity.log');
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...sandbox.env, PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: path.join(root, 'frontend/dist') }, logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(`${origin}/api/health`);
    const contexts = [];
    web = new WebSocket(origin.replace('http:', 'ws:') + '/ws');
    web.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'dashboard_context_changed') contexts.push(message.payload); });
    await new Promise((resolve, reject) => { web.once('open', resolve); web.once('error', reject); });
    web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
    unity = spawn(executable, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1600', '-screen-height', '900', '-logFile', logFile], {
        cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
        env: { ...sandbox.env, NO_PROXY: '127.0.0.1,localhost', DIGITAL_TWIN_BACKEND_HTTP_URL: origin, DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws' }
    });
    const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    await waitUntil(() => { if (unity.exitCode !== null) throw new Error(`Unity exited: ${unity.exitCode}`); return log().includes('[FactoryRuntime] Native factory ready'); }, 120000, 'real Unity models ready');
    const results = [];
    const send = (deviceId, inspection) => requestJson(`${origin}/api/native-preview/navigate`, { method: 'POST', body: JSON.stringify({ action: 'inspection', focus: { mode: 'device', deviceId }, inspection }) });
    const next = (deviceId, fence, predicate, label, timeout = 20000) => waitUntil(() => contexts.slice(fence).find(frame => frame.deviceId === deviceId && predicate(frame)), timeout, label);
    for (let index = 0; index < devices.length; index++) {
        const deviceId = devices[index].id, preset = presets[index];
        let fence = contexts.length;
        await send(deviceId, { command: 'stage', stage: 'exploded' });
        const exploded = await next(deviceId, fence, frame => frame.inspectionProgress > .999 && !frame.inspectionAnimating, 'complete staged explosion');
        assert.deepEqual(exploded.inspectionIssues.filter(issue => issue.severity === 'error'), [], preset.modelId);
        assert.equal(exploded.inspectionParts.length, preset.inspection.parts.length);
        const projected = await next(deviceId, fence, frame => frame.inspectionProgress > .999 && frame.inspectionParts.some(part => part.anchor.visible && part.label.visible), 'world-projected part labels');
        const target = preset.inspection.parts.find(part => part.point_keys.length) || preset.inspection.parts[0];
        fence = contexts.length;
        await send(deviceId, { command: 'select', partId: target.id });
        const selected = await next(deviceId, fence, frame => frame.partId === target.id && frame.inspectionStage === 'part', 'selected-part context');
        assert.deepEqual(selected.partPointKeys, target.point_keys);
        fence = contexts.length;
        await send(deviceId, { command: 'isolate', enabled: true });
        await next(deviceId, fence, frame => frame.inspectionIsolated, 'part isolation');
        fence = contexts.length;
        await send(deviceId, { command: 'clear' });
        await send(deviceId, { command: 'progress', progress: .43 });
        await next(deviceId, fence, frame => Math.abs(frame.inspectionProgress - .43) < .001 && !frame.inspectionAnimating, 'scrub/pause');
        fence = contexts.length;
        await send(deviceId, { command: 'stage', stage: 'solid' });
        const assembled = await next(deviceId, fence, frame => frame.inspectionProgress === 0 && !frame.inspectionAnimating && frame.inspectionStage === 'solid', 'reverse assembly');
        assert.equal(assembled.partId, '');
        results.push({ modelId: preset.modelId, deviceId, parts: exploded.inspectionParts.length, visibleLabels: projected.inspectionParts.filter(part => part.anchor.visible && part.label.visible).length, pointKeys: selected.partPointKeys, checks: ['actual GLB loaded', 'shell and staged explosion', 'spatial labels', 'selected part + PLC context', 'isolation', 'scrub/pause', 'continuous reverse assembly'] });
        console.log(`PASS real Unity ${preset.modelId} (${exploded.inspectionParts.length} parts)`);
    }
    assert.ok(!/\b(?:NullReferenceException|InvalidOperationException|ArgumentException|UnityException|IndexOutOfRangeException):/.test(log()), 'Unity logged a runtime exception');
    for (const preset of presets) assert.ok(log().includes(`[RuntimeModelLibrary] Loaded ${preset.modelId}`), `${preset.modelId} did not load`);
    const evidence = { success: true, results, origin, directory: sandbox.directory, unityLog: logFile, frames: contexts.length };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(sandbox.directory, 'contexts.json'), JSON.stringify(contexts, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(async () => {
    web?.terminate();
    await stopOwnedSmokeProcess(unity);
    await stopOwnedSmokeProcess(backend);
});
