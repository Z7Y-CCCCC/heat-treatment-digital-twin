const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocket } = require('../backend/node_modules/ws');
const { createRunDirectory, requireTestPath, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');

// The caller supplies the already-running, explicitly isolated S7 test backend.
// No PLC/DB settings, collection cadence, or render-quality settings are changed.
const origin = process.argv[2];
const fixtureDirectory = process.argv[3] && requireTestPath(process.argv[3]);
const seconds = Math.max(30, Math.min(300, Number(process.env.NATIVE_LOAD_SECONDS) || 90));
const project = path.resolve(__dirname, '..');
const executable = path.join(project, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe');
let unity, sampler, web, controlFile, directory, report, runError;

(async () => {
    assert.ok(fixtureDirectory && fs.existsSync(fixtureDirectory), 'Provide the existing isolated backend fixture directory');
    assert.equal(new URL(origin).hostname, '127.0.0.1');
    directory = createRunDirectory('native-connected-load');
    const password = process.env.NATIVE_LOAD_PASSWORD || `Native-Audit-${crypto.randomBytes(16).toString('hex')}!`;
    const session = await createSmokeSession(origin, { directory: fixtureDirectory, password });
    fs.writeFileSync(path.join(directory, 'test-account.json'), JSON.stringify({ username: 'admin', password }, null, 2));
    const api = route => fetch(`${origin}${route}`, { headers: { Cookie: session.cookie }, signal: AbortSignal.timeout(10000) }).then(async response => {
        assert.ok(response.ok, `${route}: HTTP ${response.status}`); return response.json();
    });
    const config = await api('/api/config');
    const devices = (config.workshops || []).flatMap(workshop => [...(workshop.devices || []), ...(workshop.lines || []).flatMap(line => line.devices || [])]);
    assert.equal(devices.length, 20, 'This acceptance run requires exactly 20 configured devices');
    assert.ok(devices.every(device => device.dataPoints?.length === 100), 'Each configured device must expose 100 points');
    const modelIds = [...new Set(devices.map(device => device.model_type))];
    const seenPoints = new Map();
    let frames = 0, sceneReady = false;
    web = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: session.cookie } });
    web.on('message', raw => {
        const message = JSON.parse(String(raw));
        if (message.type === 'dashboard_context_changed' && message.payload?.sceneReady) sceneReady = true;
        if (message.type !== 'realtime_frame') return;
        frames++;
        for (const device of message.payload?.devices || []) {
            const id = device.furnace_id || device.device_id || device.id;
            if (!seenPoints.has(id)) seenPoints.set(id, new Set());
            for (const key of Object.keys(device.pointMeta || {})) seenPoints.get(id).add(key);
        }
    });
    await new Promise((resolve, reject) => { web.once('open', resolve); web.once('error', reject); });
    web.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
    const logFile = path.join(directory, 'unity.log');
    const startedAt = Date.now();
    unity = spawn(executable, ['-batchmode', '-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1600', '-screen-height', '900', '-logFile', logFile], {
        cwd: path.dirname(executable), windowsHide: true, stdio: 'ignore',
        env: { ...process.env, APP_USER_DATA_DIR: directory, DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws',
            DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false', NO_PROXY: '127.0.0.1,localhost' }
    });
    controlFile = path.join(directory, 'sample-control.json');
    fs.writeFileSync(controlFile, JSON.stringify({ roots: [unity.pid] }));
    const sampleFile = path.join(directory, 'process-samples.jsonl');
    const sampleStream = fs.createWriteStream(sampleFile);
    sampler = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tools/sample-owned-processes.ps1'), '-ControlFile', controlFile],
        { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    sampler.stdout.pipe(sampleStream, { end: false }); sampler.stderr.pipe(sampleStream, { end: false });
    sampler.once('close', () => sampleStream.end());
    await authorizeSmokeUnity(origin, unity, session);
    const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    await waitUntil(() => {
        if (unity.exitCode !== null) throw new Error(`Unity exited with ${unity.exitCode}`);
        return log().includes('[FactoryRuntime] Native factory ready');
    }, 150000, '20 real Unity models ready');
    const readyAt = Date.now();
    console.log(`Native 20x100 ready in ${readyAt - startedAt} ms; sampling ${seconds}s: ${directory}`);
    const initialHealth = await api('/api/health');
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    const finalHealth = await api('/api/health');
    assert.equal(unity.exitCode, null);
    for (const model of modelIds) assert.ok(log().includes(`[RuntimeModelLibrary] Loaded ${model}`), `${model} must load real geometry`);
    assert.ok(!log().includes('fallback geometry'), 'No replacement geometry permitted');
    assert.ok(!/\b(?:NullReferenceException|InvalidOperationException|ArgumentException|UnityException|IndexOutOfRangeException):/.test(log()), 'No Unity runtime exceptions permitted');
    assert.equal(seenPoints.size, 20);
    assert.ok([...seenPoints.values()].every(points => points.size === 100), 'Realtime socket must deliver all 2000 actual points');
    assert.ok(sceneReady && frames > 20, 'Scene must be ready while actual realtime frames continue');
    fs.writeFileSync(controlFile, JSON.stringify({ stop: true, roots: [unity.pid] }));
    await new Promise(resolve => setTimeout(resolve, 5500));
    const samples = fs.readFileSync(sampleFile, 'utf8').split(/\r?\n/).filter(line => line.startsWith('{')).map(JSON.parse);
    const unitySamples = samples.map(sample => ({ timestamp: sample.timestamp, ...sample.processes.find(process => process.pid === unity.pid) })).filter(sample => Number.isFinite(sample.cpuSeconds));
    const stable = unitySamples.filter(sample => sample.timestamp >= readyAt);
    assert.ok(stable.length >= 5, 'Stable process samples are required');
    const first = stable[0], last = stable.at(-1);
    const cpuOneCorePercent = (last.cpuSeconds - first.cpuSeconds) / ((last.timestamp - first.timestamp) / 1000) * 100;
    const sceneBuildCount = (log().match(/\[FactoryRuntime\] Native factory ready/g) || []).length;
    const sceneBuildStartedCount = (log().match(/\[StartupProgress\] 5\|/g) || []).length;
    const transportFaults = log().split(/\r?\n/).filter(line => /^\[RealtimeWebSocket\].*(?:error:|disconnected:|Send failed:)/.test(line));
    const stableConnection = sceneBuildStartedCount === 1 && sceneBuildCount === 1 && transportFaults.length === 0;
    report = { success: false, stabilityPassed: stableConnection, cleanupComplete: false, directory, sourceFixture: fixtureDirectory, origin, executable,
        deviceCount: devices.length, pointsPerDevice: 100, receivedPointCount: [...seenPoints.values()].reduce((total, points) => total + points.size, 0),
        framesObserved: frames, modelIds, readyMilliseconds: readyAt - startedAt, stableSeconds: seconds, sceneReady,
        sceneBuildStartedCount, sceneBuildCount, transportFaults,
        qualityApplied: log().split(/\r?\n/).filter(line => line.includes('[NativeQuality]')),
        renderer: log().split(/\r?\n/).find(line => line.includes('Renderer:'))?.trim(),
        memory: { peakPrivateBytes: Math.max(...unitySamples.map(sample => sample.privateBytes)),
            stableStartPrivateBytes: first.privateBytes, stableEndPrivateBytes: last.privateBytes,
            stablePeakRss: Math.max(...stable.map(sample => sample.rss)), cpuOneCorePercent,
            cpuTotalMachinePercent: cpuOneCorePercent / samples[0].logicalProcessors },
        initialHealth, finalHealth,
        limitation: 'Short local Windows run, 1600x900 D3D11 batch player. CPU excludes backend; no long-duration, installation, or prospective field-PC certification.' };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
    assert.ok(stableConnection, `Stable load must not reconnect/reload: ${sceneBuildStartedCount} builds started, ${sceneBuildCount} completed, ${transportFaults.length} transport faults`);
})().catch(error => { runError = error.stack || error.message; console.error(runError); process.exitCode = 1; }).finally(async () => {
    if (controlFile) fs.writeFileSync(controlFile, JSON.stringify({ stop: true, roots: [] }));
    web?.terminate();
    const cleanupErrors = [];
    // A rendered Windows player and its WebView tree can take longer than a
    // tiny test process to report exit after taskkill. This changes only the
    // isolated harness's exit-observation budget, not production supervision.
    for (const child of [sampler, unity]) {
        try { await stopOwnedSmokeProcess(child, { forceTimeoutMs: 20000 }); }
        catch (error) { cleanupErrors.push(error.message); console.error(error.stack || error.message); }
    }
    if (directory) {
        report ||= { directory, sourceFixture: fixtureDirectory, origin, executable };
        report.cleanupComplete = cleanupErrors.length === 0;
        report.cleanupErrors = cleanupErrors;
        if (runError) report.error = runError;
        report.success = report.stabilityPassed === true && report.cleanupComplete && !runError;
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ ...report, initialHealth: undefined, finalHealth: undefined }, null, 2));
        if (!report.success) process.exitCode = 1;
    }
});
