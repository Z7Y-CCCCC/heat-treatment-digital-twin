'use strict';
// Clone the current project's exact published HTTP/dataset cards, field mappings and part IDs.
// Only clone IDs and source transports change. Original desktop JSON/MySQL are never written.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BACKEND_DIR, requireTestPath, findFreePort, startLoggedProcess, waitForHttp, waitUntil, sleep, percentile } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { createReferenceJsonFixture } = require('./latency-http-fixture.cjs');
const fast=process.env.LATENCY_FAST==='1';
let backend, browser, page, sandbox, report; const fixtures = [], events = [], errors = [], checks = [];
async function main() {
    const referenceFile = requireTestPath(process.argv[2]);
    const reference = JSON.parse(fs.readFileSync(referenceFile));
    assert.equal(reference.activeFactoryId, 'factory_pit_furnaces_v1');
    sandbox = await createSmokeSandbox('current-project-http-latency'); console.log('ARTIFACTS ' + sandbox.directory);
    const db = new Database(sandbox.filename), line = db.prepare('SELECT id FROM lines LIMIT 1').get().id;
    db.prepare('DELETE FROM data_points').run(); db.prepare('DELETE FROM devices').run();
    db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();
    db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
    for (const d of reference.devices) db.prepare('INSERT INTO devices (id,name,line_id,model_type,plc_enabled,instance_config) VALUES (?,?,?,?,0,?)').run(d.id, d.name, line, d.model_type, '{}');
    db.close();
    const origin = `http://127.0.0.1:${await findFreePort()}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...sandbox.env, HOST: '127.0.0.1', PORT: new URL(origin).port,
        FRONTEND_DIST: path.resolve(__dirname, '../frontend/dist') }, logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(origin + '/api/health'); const session = await createSmokeSession(origin, sandbox);
    const api = async (route, method = 'GET', data) => {
        const r = await fetch(origin + '/api' + route, { method, headers: { Origin: origin, 'X-Admin-Request': '1', 'Content-Type': 'application/json',
            Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
        const v = await r.json(); assert.ok(r.ok, route + ': ' + JSON.stringify(v)); return v;
    };
    const sourceIds = {}, sources = {};
    for (const c of reference.sources) {
        if (!reference.payloads[c.id]) continue;
        const f = await createReferenceJsonFixture(reference.payloads[c.id]); fixtures.push(f); sources[c.id] = f;
        const connection = (await api('/data-sources/connections', 'POST', { name: c.name + ' · HTTP联调副本', sourceType: 'http_api', connector: 'http',
            authType: 'none', baseUrl: f.origin + '/', enabled: true })).connection; sourceIds[c.id] = connection.id;
    }
    const datasetIds = {};
    for (const definition of reference.datasets) {
        const d = structuredClone(definition); delete d.id; delete d.revision; if(fast)d.refreshMs=250; d.connectionId = sourceIds[d.connectionId];
        datasetIds[definition.id] = (await api('/data-sources/datasets', 'POST', d)).dataset.id;
    }
    const designer = await api('/platform/designer');
    const document = structuredClone(reference.publishedDocument);
    document.projectId = designer.document.projectId; document.sceneId = designer.document.sceneId;
    const original = document.widgets.filter(w => ['dataset', 'http_api'].includes(w.data?.mode)); assert.equal(original.length, 10);
    document.widgets = original.map(w => { if(fast)w.data.refreshMs=250; if (w.data.mode === 'dataset') w.data.datasetId = datasetIds[w.data.datasetId];
        else { w.data.connectionId = sourceIds[w.data.connectionId]; for (const d of w.data.datasets || []) d.connectionId = sourceIds[d.connectionId] || d.connectionId; } return w; });
    for (const v of document.scene.views) v.componentState = { show: document.widgets.map(w => w.id), hide: [] };
    await api('/platform/designer/draft', 'PUT', { sceneId: document.sceneId, document, expectedRevision: designer.revision });
    await api('/platform/releases', 'POST', { sceneId: document.sceneId, notes: 'Current published interface contracts cloned into isolated HTTP acceptance' });
    browser = await playwright.chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addCookies(session.cookie.split('; ').map(pair => { const at = pair.indexOf('='); return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin, httpOnly: true }; }));
    page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
    // This stage tests exact existing contracts and view contexts in the production overlay renderer.
    // The independent plc-unity-latency test supplies the real native-host/Unity evidence.
    await page.addInitScript(() => { window.__hostHandlers = []; window.chrome = { webview: { postMessage() {}, addEventListener(name, fn) { if (name === 'message') window.__hostHandlers.push(fn); }, removeEventListener() {} } }; });
    await page.goto(origin + '/overlay?embedded=unity&surface=overlay&scene=1');
    await page.locator('.dashboard-overlay-root').waitFor({ state: 'attached' });
    await page.addStyleTag({ content: 'html,body,#app{background:#171823!important}' });
    await page.evaluate(() => { window.__contractDom = []; const seen = new Map();
        const scan = () => { for (const el of document.querySelectorAll('.overlay-widget')) { const id = el.dataset.widgetId, text = el.innerText;
            if (seen.get(id) !== text) { seen.set(id, text); window.__contractDom.push({ id, text, at: Date.now() }); } } };
        new MutationObserver(scan).observe(document.querySelector('.dashboard-overlay-root'), { subtree: true, childList: true, characterData: true });
    });
    const select = async (deviceId, partId, viewId = 'device_part') => page.evaluate(input => {
        for (const fn of window.__hostHandlers) fn({ data: { type: 'overlay_host_state', visible: true, context: { factoryId: 'factory_default', sceneReady: true,
            viewMode: 'device', viewId: input.viewId, deviceId: input.deviceId, partId: input.partId, inspectionStage: input.partId ? 'part' : 'solid' } } });
    }, { deviceId, partId, viewId });
    const latencies = [];
    for (const definition of reference.datasets) {
        const f = sources[definition.connectionId], payload = reference.payloads[definition.connectionId], deviceId = payload.deviceId, partId = payload.rows[0].partId;
        const widget = document.widgets.find(w => w.id === 'pit_part_data_' + deviceId); assert.ok(widget);
        await select(deviceId, partId); const panel = page.locator(`[data-widget-id="${widget.id}"]`);
        await waitUntil(async () => (await panel.innerText()).replace(/,/g, '').includes('90000'), 15000, 'existing part mapping ' + deviceId);
        for (let n = 0; n < 3; n++) {
            await sleep(51 + n * 97); const t0 = Date.now(), epoch = ++f.state.epoch, expected = String(90000 + epoch);
            const dom = await waitUntil(() => page.evaluate(({ id, t0, expected }) => window.__contractDom.find(r => r.id === id && r.at >= t0 && r.text.replace(/,/g, '').includes(expected)),
                { id: widget.id, t0, expected }), 10000, 'current part timed update ' + deviceId, 25);
            latencies.push(dom.at - t0); events.push({ type: 'part', deviceId, partId, widgetId: widget.id, changedAt: t0, domAt: dom.at, epoch });
        }
        // Original match.field=partId must select a different row, not reuse the previous one.
        await select(deviceId, payload.rows[1].partId); await waitUntil(async () => (await panel.innerText()).includes(payload.rows[1].name), 15000, 'original partId match ' + deviceId);
        const runtime = await api('/data-sources/runtime-values?' + new URLSearchParams({ view_id: 'device_part', device_id: deviceId, part_id: payload.rows[1].partId, playback_at: String(Date.now()) }));
        assert.equal(runtime.values[widget.id].quality, 'good'); assert.equal(runtime.values[widget.id].value, 90003);
        checks.push(deviceId + ': original card, columns, current-device scope, partId matching and 3 timed value updates pass');
        await panel.screenshot({ path: path.join(sandbox.directory, deviceId + '.png') });
    }
    const erp = sources.pit_demo_erp, order = page.locator('[data-widget-id="pit_playback_orders"]');
    await select('PitFurnace_01', '', 'device_detail'); await waitUntil(async () => (await order.innerText()).includes('API_EPOCH_0'), 15000, 'original legacy HTTP orders');
    const orderTimes = [];
    for (let n = 1; n <= (fast ? 12 : 3); n++) { await sleep(79 + n * 41); const t0 = Date.now(); erp.state.epoch = n;
        const dom = await waitUntil(() => page.evaluate(({ t0, n }) => window.__contractDom.find(r => r.id === 'pit_playback_orders' && r.at >= t0 && r.text.includes('API_EPOCH_' + n)), { t0, n }), 20000, 'original 5-second orders refresh', 25);
        orderTimes.push(dom.at - t0); events.push({ type: 'orders', changedAt: t0, domAt: dom.at, epoch: n }); }
    checks.push('original legacy http_api production tasks preserve device filtering and selected refresh profile; unique updates observed');
    assert.deepEqual(errors, []);
    const stats = rows => ({ samples: rows.length, min: Math.min(...rows), p50: percentile(rows, 50), p95: percentile(rows, 95), max: Math.max(...rows) });
    report = { success: true, directory: sandbox.directory, referenceFile, productionDataModified: false, actualNativeHost: false,
        transportChangeInCloneOnly: '11 local JSON file sources replaced with loopback HTTP APIs preserving their JSON contracts',
        fastProfile:fast, interfaceRefreshMs:fast ? 250 : 'original', publishedComponentCount: reference.publishedDocument.widgets.length, clonedInterfaceCards: 10, partDevices: 9,
        metrics: { partPanelChangeToDomMs: stats(latencies), productionTaskChangeToDomMs: stats(orderTimes) }, checks, errors };
}
main().catch(async error => { console.error(error); process.exitCode = 1; report = { success: false, directory: sandbox?.directory, error: error.stack, checks };
    await page?.screenshot({ path: path.join(sandbox.directory, 'failure.png') }).catch(() => {}); }).finally(async () => {
    await browser?.close(); await stopOwnedSmokeProcess(backend); for (const f of fixtures) await f.close();
    if (sandbox) { fs.writeFileSync(path.join(sandbox.directory, 'events.json'), JSON.stringify(events, null, 2)); fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(report, null, 2)); }
    console.log(JSON.stringify(report, null, 2));
});
