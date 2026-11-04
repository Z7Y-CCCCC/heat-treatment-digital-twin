'use strict';
// Actual requested simulator -> actual collector -> WS -> Unity transforms and real WebView2 DOM.
// All state/profiles/databases belong to output/. Does not change the operator's project.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('../backend/node_modules/better-sqlite3');
const WebSocket = require('../backend/node_modules/ws');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil, sleep, percentile } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeSandbox, createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { createLatencyHttpFixture } = require('./latency-http-fixture.cjs');
const root = path.resolve(__dirname, '..'), simulatorDir = path.resolve(process.env.PLC_SIMULATOR_DIR || path.join(root, '../PLC仿真调试器'));
const samples = Math.max(5, Math.min(100, Number(process.env.LATENCY_SAMPLES || 12))), deviceId = 'latency_cleaner';
let backend, plc, unity, browser, socket, fixture, sandbox, page, controlOrigin, origin, report;
const fast=process.env.LATENCY_FAST==='1', refreshMs=fast ? 250 : 1000;
const checks = [], events = [], frames = [], diagnostics = [], errors = [], network = [];
const check = label => { checks.push(label); console.log('PASS ' + label); };
const stats = rows => ({ samples: rows.length, min: Math.min(...rows), p50: percentile(rows, 50), p95: percentile(rows, 95), max: Math.max(...rows) });
function startPlc(port, controlPort, name) {
    return startLoggedProcess(process.env.PYTHON || 'python', [path.join(simulatorDir, 'modbus_engine.py'), '--bind', '127.0.0.1',
        '--modbus-port', String(port), '--control-port', String(controlPort)], { cwd: simulatorDir,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }, logFile: path.join(sandbox.directory, name) });
}
async function write(area, offset, type, value) {
    const response = await fetch(controlOrigin + '/value', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ area, offset, type, value }), signal: AbortSignal.timeout(3000) });
    assert.ok(response.ok, await response.text());
}
function readDiagnostics() {
    if (!sandbox) return;
    const file = path.join(sandbox.directory, 'unity.log'); if (!fs.existsSync(file)) return;
    const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(s => s.startsWith('[DeviceAnimation] '));
    for (const row of rows.slice(diagnostics.length)) {
        try { diagnostics.push({ observedAt: Date.now(), snapshot: JSON.parse(row.slice(18)) }); } catch { break; }
    }
}
const action = (row, id) => row?.snapshot?.actions.find(a => a.clipId === id);
const device = row => row.message.payload?.devices?.find(d => (d.furnace_id || d.device_id || d.id) === deviceId);
async function observedMotion(from, predicate, label) {
    return waitUntil(() => { assert.equal(unity.exitCode, null, 'Unity exited'); readDiagnostics(); return diagnostics.slice(from).find(predicate); }, 20000, label, 25);
}
async function main() {
    assert.equal(process.platform, 'win32');
    sandbox = await createSmokeSandbox('plc-unity-latency');
    console.log('ARTIFACTS ' + sandbox.directory);
    const port = await findFreePort(), controlPort = await findFreePort(), backendPort = await findFreePort(), debugPort = await findFreePort();
    controlOrigin = `http://127.0.0.1:${controlPort}`; origin = `http://127.0.0.1:${backendPort}`;
    plc = startPlc(port, controlPort, 'modbus-before.log'); await waitForHttp(controlOrigin + '/health');
    await write('holding', 0, 'word', 6000); await write('coil', 0, 'bool', false); await write('coil', 1, 'bool', false);
    const db = new Database(sandbox.filename), line = db.prepare('SELECT id FROM lines LIMIT 1').get().id;
    db.prepare('DELETE FROM data_points').run(); db.prepare('DELETE FROM devices').run();
    db.prepare("UPDATE settings SET value='integrated_plc' WHERE `key`='data_mode'").run();
    db.prepare("UPDATE factory_settings SET value='integrated_plc' WHERE `key`='data_mode'").run();
    for (const id of [deviceId, 'latency_peer']) db.prepare('INSERT INTO devices (id,name,line_id,model_type,plc_enabled,plc_protocol,plc_ip,plc_port,plc_options,instance_config) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, id === deviceId ? '清洗机 · 延迟联调' : '未绑定对照设备', line, 'cad_cleaner_170700', id === deviceId ? 1 : 0,
            'MODBUS_TCP', '127.0.0.1', port, JSON.stringify({ unitId: 1, addressBase: 1 }), '{}');
    const ins = db.prepare("INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES (?,?,?,?,?,?,?,?,?,?)");
    const ids = {};
    for (const [name, label, tag, type, group] of [['actual_temp', '实际温度', 'HR40001', 'WORD', 'analog'], ['door', '门开启反馈', 'C00001', 'BOOL', 'doors'], ['pump', '循环泵运行', 'C00002', 'BOOL', 'motors']])
        ids[name] = String(ins.run(deviceId, name, label, tag, type, group, name, 100, 'READ', 'good').lastInsertRowid);
    db.close();
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, HOST: '127.0.0.1', PORT: String(backendPort), FRONTEND_DIST: path.join(root, 'frontend/dist') }, logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(origin + '/api/health', 90000); const session = await createSmokeSession(origin, sandbox);
    async function api(route, method = 'GET', data) {
        const r = await fetch(origin + '/api' + route, { method, headers: { 'Content-Type': 'application/json', Origin: origin,
            'X-Admin-Request': '1', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
        const value = await r.json(); assert.ok(r.ok, `${route}: ${JSON.stringify(value)}`); return value;
    }
    const config = await api(`/devices/${deviceId}/animations`);
    const binding = (clip, point) => ({ actionId: 'clip:' + clip, enabled: true, pointId: point, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 });
    await api(`/devices/${deviceId}/animations`, 'PUT', { revision: config.revision, config: { version: 1, staleMs: 1500,
        bindings: [binding('door', ids.door), binding('pumps', ids.pump)] } });
    fixture = await createLatencyHttpFixture();
    const source = (await api('/data-sources/connections', 'POST', { name: '延迟联调本地接口', sourceType: 'http_api', connector: 'http', authType: 'none', healthPath: '/health', baseUrl: fixture.origin + '/', enabled: true })).connection;
    const columns = [{ name: 'value', path: 'value', type: 'number', role: 'value', unit: '°C' }, { name: 'pressure', path: 'pressure', type: 'number' },
        ...['running', 'online', 'alarm'].map(name => ({ name, path: name, type: 'boolean' })), ...['name', 'id', 'time', 'msg', 'level'].map(name => ({ name, path: name, type: 'string', role: name === 'time' ? 'category' : '' }))];
    const dataset = (await api('/data-sources/datasets', 'POST', { name: '设备工艺实时接口', connectionId: source.id, source: 'http', rootPath: 'rows', refreshMs,
        request: { method: 'GET', path: '/read', readOnly: true, parameters: [{ name: 'device', in: 'query', source: 'context', key: 'deviceId', required: true }] }, columns })).dataset;
    const { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
    const designer = await api('/platform/designer'), types = ['value', 'text', 'status', 'metrics', 'hud_kpi_panel', 'trend', 'hud_chart_dock', 'alarm_list', 'hud_alarm_panel', 'marquee', 'device_list', 'hud_device_status', 'business_summary'];
    const widgets = types.map((type, i) => {
        const w = createDashboardWidget(type, i); w.id = 'latency_http_' + type; w.title = '接口 · ' + type;
        w.frame = { x: 30 + (i % 4) * 468, y: 115 + Math.floor(i / 4) * 212, width: 450, height: 198, rotation: 0 };
        w.data = { ...w.data, mode: 'dataset', datasetId: dataset.id, datasetField: type === 'text' ? 'name' : type === 'status' ? 'running' : 'value', deviceScope: 'fixed', deviceId, refreshMs, decimals: 0 };
        w.content = { ...w.content, showRing: false, items: [{ label: '温度', path: 'dataset.value', unit: '°C' }, { label: '压力', path: 'dataset.pressure' }], limit: 2 };
        w.visibility.viewIds = designer.document.scene.views.map(v => v.id); return w;
    });
    const w = createDashboardWidget('value'); w.id = 'latency_plc_value'; w.title = 'PLC 实际温度'; w.frame = { x: 1428, y: 751, width: 450, height: 198, rotation: 0 };
    w.data = { ...w.data, mode: 'plc', pointId: ids.actual_temp, pointKey: 'analog.actual_temp', path: 'analog.actual_temp', requireConfiguredPoint: true,
        deviceScope: 'fixed', deviceId, refreshMs, decimals: 0, unit: '°C' }; w.visibility.viewIds = designer.document.scene.views.map(v => v.id); widgets.push(w);
    designer.document.widgets = widgets; for (const v of designer.document.scene.views) v.componentState = { show: widgets.map(w => w.id), hide: [] };
    await api('/platform/designer/draft', 'PUT', { sceneId: designer.document.sceneId, document: designer.document, expectedRevision: designer.revision });
    await api('/platform/releases', 'POST', { sceneId: designer.document.sceneId, notes: 'Isolated PLC/Unity/HTTP latency acceptance' });
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: session.cookie } });
    socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'realtime_frame') frames.push({ receivedAt: Date.now(), message }); });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify({ type: 'client_hello', role: 'web' }));
    const exe = path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe'), host = path.join(root, 'unity-client/Builds/Windows/AdminHost/HeatTreatmentAdminHost.exe');
    unity = spawn(exe, ['-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1440', '-screen-height', '1000', '-logFile', path.join(sandbox.directory, 'unity.log')], {
        cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore', env: { ...sandbox.env, DIGITAL_TWIN_BACKEND_HTTP_URL: origin,
            DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws', DIGITAL_TWIN_ADMIN_URL: origin + '/admin', DIGITAL_TWIN_ADMIN_HOST_PATH: host,
            DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false', DEVICE_ANIMATION_DIAGNOSTICS: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
    fs.writeFileSync(path.join(sandbox.directory, 'target.json'), JSON.stringify({ origin, mockOrigin: fixture.origin, plcPort: port, controlPort, debugPort, unityPid: unity.pid, executable: exe }));
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 90000);
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); const context = browser.contexts()[0];
    await context.addCookies(session.cookie.split('; ').map(pair => { const n = pair.indexOf('='); return { name: pair.slice(0, n), value: pair.slice(n + 1), url: origin, httpOnly: true, sameSite: 'Strict' }; }));
    const admin = await waitUntil(() => context.pages().find(p => p.url().startsWith(origin + '/admin')), 30000, 'native admin WebView2');
    await admin.reload(); await authorizeSmokeUnity(origin, unity, session);
    await observedMotion(0, r => action(r, 'door')?.usable && action(r, 'door').position === 0, 'real Unity closed pose');
    const unityLog = () => fs.readFileSync(path.join(sandbox.directory, 'unity.log'), 'utf8');
    await waitUntil(() => unityLog().includes('[FactoryRuntime] Native factory ready:'), 120000, 'real factory scene');
    await admin.evaluate(() => window.chrome.webview.postMessage({ type: 'host_action', action: 'show_dashboard' }));
    page = await waitUntil(() => context.pages().find(p => p.url().startsWith(origin + '/group')), 30000, 'owned native dashboard surface');
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(30000);
    page.on('response', r => { if (r.url().includes('/runtime-values') || r.url().includes('/datapoints/realtime')) network.push({ at: Date.now(), url: r.url(), status: r.status() }); });
    await page.goto(origin + '/overlay?embedded=unity&surface=overlay&scene=1');
    await api('/native-preview/navigate', 'POST', { action: 'view', viewId: 'factory_overview', focus: { mode: 'factory' } });
    await page.locator('.dashboard-overlay-root.is-scene-ready').waitFor();
    await waitUntil(async () => await page.locator('.overlay-widget').count() === widgets.length && await page.locator('.widget-data-placeholder').count() === 0, 20000, 'all actual WebView2 components loaded');
    assert.ok(await page.evaluate(() => !!window.chrome.webview), 'must be actual native WebView2, not a bridge stub');
    check('requested simulator, collector, actual Unity motion rig and 14 real WebView2 component cards are connected');
    // Observe DOM commits from inside the real WebView. No network latency is inferred from polling.
    await page.evaluate(() => {
        window.__latencyDom = [];
        const seen = new Map();
        const scan = () => { for (const el of document.querySelectorAll('.overlay-widget')) {
            const id = el.dataset.widgetId, text = el.innerText; if (seen.get(id) === text) continue;
            seen.set(id, text); window.__latencyDom.push({ id, text, at: Date.now() });
        } };
        window.__latencyScan = scan;
        new MutationObserver(scan).observe(document.querySelector('.dashboard-overlay-root'), { subtree: true, childList: true, characterData: true }); scan();
    });
    await page.screenshot({ path: path.join(sandbox.directory, '01-native-components-initial.png') });
    const plcWS = [], plcDOM = [], httpDOM = [], motionStart = [], motionEnd = [], httpRequest = [], preciseMotion = [], receiveToTransform = [];
    const card = page.locator('[data-widget-id="latency_plc_value"]');
    await waitUntil(async () => (await card.innerText()).replace(/,/g, '').includes('6000'), 10000, 'initial actual PLC value');
    for (let i = 0; i < samples; i++) {
        await sleep(37 + (i * 83) % 217); const expected = 6100 + i, t0 = Date.now();
        await write('holding', 0, 'word', expected);
        const f = await waitUntil(() => frames.find(r => r.receivedAt >= t0 && device(r)?.analog?.actual_temp === expected && device(r)?.quality?.analog?.actual_temp === 'good'), 8000, 'PLC WS value ' + expected, 25);
        const dom = await waitUntil(() => page.evaluate(({ expected, t0 }) => window.__latencyDom.find(r => r.id === 'latency_plc_value' && r.at >= t0 && r.text.replace(/,/g, '').includes(String(expected))), { expected, t0 }), 8000, 'PLC DOM value ' + expected, 25);
        plcWS.push(f.receivedAt - t0); plcDOM.push(dom.at - t0); events.push({ type: 'plc_value', expected, sentAt: t0, websocketAt: f.receivedAt, domAt: dom.at });
    }
    check('unique PLC writes reach real WebSocket and real Unity-hosted component DOM without refresh/restart');
    for (let i = 0; i < samples; i++) {
        await sleep(79 + (i * 53) % 151); const t0 = Date.now(), epoch = 100 + i; fixture.state.epoch = epoch;
        const expected = String(7000 + epoch);
        const dom = await waitUntil(() => page.evaluate(({ expected, t0 }) => window.__latencyDom.find(r => r.id === 'latency_http_value' && r.at >= t0 && r.text.replace(/,/g, '').includes(expected)), { expected, t0 }), 30000, 'HTTP DOM ' + expected, 50);
        const req = fixture.requests.find(r => r.epoch === epoch && r.receivedAt >= t0); assert.ok(req);
        httpDOM.push(dom.at - t0); httpRequest.push(dom.at - req.receivedAt); events.push({ type: 'http_value', epoch, changedAt: t0, requestAt: req.receivedAt, repliedAt: req.repliedAt, domAt: dom.at });
        // Multiple-value families must follow the same dataset epoch, not merely show a changed heading.
        for (const type of ['metrics', 'hud_kpi_panel', 'hud_chart_dock']) await waitUntil(async () => (await page.locator(`[data-widget-id="latency_http_${type}"]`).innerText()).replace(/,/g, '').includes(expected), 5000, type + ' updates', 25);
    }
    check('HTTP dataset values and metrics/trend/KPI cards refresh automatically through the same native renderer');
    function assertGeometry(row) {
        const clip = JSON.parse(fs.readFileSync(path.join(root, 'backend/assets/motions/cad_cleaner_170700.json'))).clips.find(c => c.id === 'door');
        const a = action(row, 'door'), progress = a.position, at = progress * (clip.count - 1), left = Math.floor(at), right = Math.min(clip.count - 1, left + 1);
        for (const track of a.tracks) {
            const authored = clip.tracks.find(t => t.node === track.node && t.channel === track.channel);
            const value = Array.from({ length: authored.size }, (_, n) => authored.values[left * authored.size + n] * (1 - at + left) + authored.values[right * authored.size + n] * (at - left));
            if (track.channel === 'p') value[0] *= -1; else if (track.channel === 'q') { value[1] *= -1; value[2] *= -1; }
            if (['p', 'q', 's', 'v'].includes(track.channel)) value.forEach((v, n) => assert.ok(Math.abs(v - track.actual[n]) < .0002, 'actual transform ' + track.node));
        }
    }
    for (let i = 0; i < samples; i++) {
        await sleep(43 + (i * 61) % 177); readDiagnostics(); const from = diagnostics.length, target = i % 2 === 0 ? 1 : 0, t0 = Date.now();
        await write('coil', 0, 'bool', !!target); await write('coil', 1, 'bool', !!target);
        const first = await observedMotion(from, r => action(r, 'door')?.usable && (fast ? action(r,'door').firstTransformAt >= t0 && action(r,'door').target === target : true) && (target ? action(r, 'door').position > .001 : action(r, 'door').position < .999), 'actual native motion begins');
        const last = await observedMotion(from, r => action(r, 'door')?.usable && (target ? action(r, 'door').position > .999 : action(r, 'door').position < .001), 'native endpoint');
        assertGeometry(first); assertGeometry(last); assert.equal(action(last, 'pumps').running, !!target);
        if(fast){const a=action(first,'door');preciseMotion.push(a.firstTransformAt-t0);receiveToTransform.push(a.firstTransformAt-a.signalChangedAt);assert.ok(a.firstTransformAt>=a.signalChangedAt);}
        motionStart.push(first.observedAt - t0); motionEnd.push(last.observedAt - t0); events.push({ type: 'motion', target, sentAt: t0, firstDiagnosticAt: first.observedAt, endpointDiagnosticAt: last.observedAt });
    }
    assert.ok(diagnostics.every(r => r.snapshot.deviceId === deviceId), 'unbound peer must not acquire motion');
    check('real door transforms move both ways, match authored geometry; pump running follows PLC and unbound peer remains static');
    report = { success: false, directory: sandbox.directory, metrics: { plcToWebSocketMs: stats(plcWS), plcToNativeWidgetDomMs: stats(plcDOM),
        httpChangeToNativeWidgetDomMs: stats(httpDOM), httpRequestToNativeWidgetDomMs: stats(httpRequest),
        plcToMotionFirstObservedUpperBoundMs: stats(motionStart), plcToMotionEndpointObservedUpperBoundMs: stats(motionEnd) } };
    readDiagnostics(); const from = diagnostics.length, outageAt = Date.now(); await stopOwnedSmokeProcess(plc); plc = null;
    const bad = await waitUntil(() => frames.find(r => r.receivedAt >= outageAt && device(r)?.quality?.analog?.actual_temp === 'bad'), 10000, 'bad point quality', 25);
    const frozen = await observedMotion(from, r => !action(r, 'door')?.usable, 'native quality freeze');
    readDiagnostics(); const still = await observedMotion(diagnostics.length, r => !action(r, 'door')?.usable, 'continued native freeze');
    assert.equal(action(frozen, 'door').position, action(still, 'door').position); assert.equal(action(frozen, 'pumps').seconds, action(still, 'pumps').seconds);
    await waitUntil(async () => /离线|数据延迟/.test(await card.innerText()), 10000, 'PLC card explicitly marks last-known value unavailable');
    const recoveryAt = Date.now(); plc = startPlc(port, controlPort, 'modbus-after.log'); await waitForHttp(controlOrigin + '/health'); await write('holding', 0, 'word', 6500); await write('coil', 0, 'bool', true);
    await waitUntil(async () => (await card.innerText()).replace(/,/g, '').includes('6500'), 15000, 'PLC card recovery');
    readDiagnostics(); const recovered = await observedMotion(diagnostics.length, r => action(r, 'door')?.usable && action(r, 'door').position > .999, 'motion recovery');
    check('simulator outage explicitly marks the retained last-known card reading offline/delayed and freezes mechanical phase; restart restores data and motion without restarting Unity');
    fixture.state.fail = true;
    await waitUntil(async () => !(await page.locator('[data-widget-id="latency_http_value"]').innerText()).replace(/,/g, '').includes(String(7100 + samples - 1)), 15000, 'HTTP outage clears old value');
    await page.screenshot({ path: path.join(sandbox.directory, '02-interface-outage.png') });
    fixture.state.fail = false; fixture.state.epoch = 999;
    await waitUntil(async () => (await page.locator('[data-widget-id="latency_http_value"]').innerText()).replace(/,/g, '').includes('7999'), 15000, 'HTTP recovery');
    await page.screenshot({ path: path.join(sandbox.directory, '03-native-recovered.png') });
    check('HTTP 503 removes stale readings and next healthy response recovers automatically');
    assert.deepEqual(errors, []); assert.doesNotMatch(unityLog(), /fallback=[1-9]|Exception:|Motion material renderer missing|Motion rig node missing/);
    report = { success: true, directory: sandbox.directory, completedAt: new Date().toISOString(), simulatorDirectory: simulatorDir,
        productionDataModified: false, actualUnityPlayer: true, actualWebView2: true, nativeDiagnosticIntervalMs: 500, eventDrivenTransformDiagnostics: fast,
        preciseMotionMeasurement: fast ? 'PLC write request start to UTC timestamp recorded after actual Unity transform application. Diagnostic event timestamps are millisecond-resolution, not photons; periodic snapshot metrics remain upper bounds.' : null,
        measurement: 'Same-machine Date.now clock; PLC write request start to WS receive / MutationObserver DOM commit. Native motion is an upper-bound observation with 500ms diagnostic cadence plus 25ms polling, NOT exact frame-to-photon latency.',
        settings: { pointSampleMs: 100, plcWidgetRefreshMs: refreshMs, datasetRefreshMs: refreshMs, doorTransitionSeconds: 1 },
        plcInvalidValuePolicy: 'Last-known numeric value is retained underneath an offline/delayed/loading indication; it is not cleared to null.',
        metrics: { plcToWebSocketMs: stats(plcWS), plcToNativeWidgetDomMs: stats(plcDOM), httpChangeToNativeWidgetDomMs: stats(httpDOM),
            httpRequestToNativeWidgetDomMs: stats(httpRequest), plcToMotionFirstObservedUpperBoundMs: stats(motionStart), plcToMotionEndpointObservedUpperBoundMs: stats(motionEnd),
            ...(fast ? {plcToFirstTransformAppliedMs:stats(preciseMotion),nativeReceiveToTransformAppliedMs:stats(receiveToTransform)} : {}),
            outage: { badQualityMs: bad.receivedAt - outageAt, nativeFreezeObservedMs: frozen.observedAt - outageAt }, recovery: { nativeEndpointObservedMs: recovered.observedAt - recoveryAt } },
        checks, componentFamilies: types, frames: frames.length, diagnosticSnapshots: diagnostics.length, errors };
}
main().catch(async error => {
    console.error(error); process.exitCode = 1; report = { ...(report || {}), success: false, directory: sandbox?.directory, checks, error: error.stack };
    await page?.screenshot({ path: path.join(sandbox.directory, 'failure.png') }).catch(() => {});
    if (browser) fs.writeFileSync(path.join(sandbox.directory, 'pages.json'), JSON.stringify(await Promise.all(browser.contexts().flatMap(c => c.pages()).map(async p => ({ url: p.url(), text: await p.locator('body').innerText().catch(() => '') }))), null, 2));
}).finally(async () => {
    await browser?.close().catch(() => {}); socket?.terminate(); await stopOwnedSmokeProcess(unity); await stopOwnedSmokeProcess(backend); await stopOwnedSmokeProcess(plc); await fixture?.close();
    if (sandbox) { fs.writeFileSync(path.join(sandbox.directory, 'events.json'), JSON.stringify(events, null, 2)); fs.writeFileSync(path.join(sandbox.directory, 'http-requests.json'), JSON.stringify(fixture?.requests || [], null, 2));
        fs.writeFileSync(path.join(sandbox.directory, 'network.json'), JSON.stringify(network, null, 2));
        fs.writeFileSync(path.join(sandbox.directory, 'motion-snapshots.json'), JSON.stringify(diagnostics, null, 2)); fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2));
});
