'use strict';
// Owned fixture only: real published Vue surfaces, loopback HTTP and display-only
// device frames. Never touches a commissioned database, collector or running app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');

const directory = createRunDirectory('widget-carousel-hover-ui');
const errors = [], checks = [], observations = [], requests = [];
const names = ['一号井式炉', '二号井式炉'];
const ids = ['temp_a', 'temp_b'];
const widgets = ['carousel_plc', 'carousel_api', 'carousel_independent', 'carousel_fixed', 'carousel_global'];
const sourceState = { epoch: 0, delayMs: 80 };
let helper, upstream, browser, page, info, lastPage;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pass = label => { checks.push(label); console.log('PASS ' + label); };

async function api(route, method = 'GET', data, expected = 200) {
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const response = await page.request.fetch(info.origin + '/api' + route, {
        method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
        ...(data === undefined ? {} : { data })
    });
    assert.equal(response.status(), expected, await response.text());
    return response.json();
}
async function control(data) {
    const response = await fetch(info.control, { method: 'POST', body: JSON.stringify(data) });
    assert.equal(response.status, 200);
}
function watchErrors(p) { p.on('pageerror', error => errors.push(error.message)); p.setDefaultTimeout(20000); }
function widget(p, id) { return p.locator(`[data-widget-id="${id}"]`); }
async function snapshot(p, id) {
    return widget(p, id).evaluate(el => {
        const q = selector => el.querySelector(selector)?.textContent.trim() || '';
        const text = q('.hud-module-reading strong') || q('.value-widget-body strong');
        const number = Number.parseFloat(text.replace(/,/g, ''));
        return { at: Date.now(), name: q('.widget-device-heading span'), count: q('.widget-device-heading small'),
            value: Number.isFinite(number) ? number : null, range: q('.hud-trend-range'),
            canvas: !!el.querySelector('.widget-chart canvas'), hovered: !!el.querySelector('.widget-shell')?.matches(':hover'),
            text: el.textContent.trim() };
    });
}
function coherent(id, row) {
    assert.ok(names.includes(row.name), `${id}: unknown/obsolete device heading ${JSON.stringify(row)}`);
    assert.equal(row.count, `${names.indexOf(row.name) + 1} / 2`, `${id}: device name and index disagree`);
    if (row.value === null) return; // An explicitly empty in-flight reading is not stale data.
    const a = row.name === names[0];
    if (id === 'carousel_plc') assert.ok(a ? row.value >= 800 : row.value < 800,
        `${id}: heading and live point belong to different devices ${JSON.stringify(row)}`);
    else assert.ok(a ? row.value >= 600 && row.value < 700 : row.value >= 700 && row.value < 800,
        `${id}: heading and external record belong to different devices ${JSON.stringify(row)}`);
    if (id !== 'carousel_independent') {
        const range = [...row.range.matchAll(/\d+(?:\.\d+)?/g)].map(match => Number(match[0]));
        if (range.length) assert.ok(range.every(value => id === 'carousel_plc' ? (a ? value >= 800 : value < 800)
            : a ? value >= 600 && value < 700 : value >= 700 && value < 800),
        `${id}: curve/range history leaked from another device ${JSON.stringify(row)}`);
    }
}
async function observeRotation(p, label) {
    // Fullscreen reflow may put the pointer on a card without an explicit hover
    // action. An unhovered rotation observation must first leave every card.
    await p.mouse.move(5, 5);
    const seen = new Map(['carousel_plc', 'carousel_api', 'carousel_independent'].map(id => [id, new Set()]));
    const rows = [];
    await waitUntil(async () => {
        const current = await Promise.all([...seen.keys()].map(id => snapshot(p, id)));
        return current.every(row => names.includes(row.name));
    }, 15000, `${label}: device catalog loaded`);
    await waitUntil(async () => {
        for (const id of seen.keys()) {
            const row = await snapshot(p, id); coherent(id, row); rows.push({ id, ...row });
            if (row.value !== null) seen.get(id).add(row.name);
        }
        return [...seen.values()].every(values => values.size === 2);
    }, 13000, `${label}: coherent A/B heading, point and external curves`);
    for (const id of ['carousel_plc', 'carousel_api']) assert.equal((await snapshot(p, id)).canvas, true, `${label}: ${id} chart painted`);
    observations.push({ surface: label, stage: 'rotation', rows });
    pass(`${label}: device names, indices, live values and curve ranges rotate together for PLC and HTTP datasets`);
}
async function pauseTest(p, id, label, { changeSource = true, durationMs = 5600, httpDelayMs = null, allowPendingPeer = false } = {}) {
    const originalHttpDelay = sourceState.delayMs;
    try {
    await p.mouse.move(5, 5);
    const initial = (await snapshot(p, id)).name;
    let switched;
    await waitUntil(async () => {
        const row = await snapshot(p, id); coherent(id, row);
        if (row.name !== initial) { switched = row; return true; }
        return false;
    }, 5000, `${label}: fresh device switching boundary`);
    await sleep(550); // Leave a measurable part of the 2 s interval to resume.
    await widget(p, id).locator('.widget-shell').hover();
    const paused = await snapshot(p, id), peerNames = new Set(), rows = [];
    coherent(id, paused);
    if (httpDelayMs !== null) sourceState.delayMs = httpDelayMs;
    if (changeSource) {
        if (id === 'carousel_plc') await control({ value: 889.1, valueB: 755.2 });
        else sourceState.epoch += 11;
    }
    const expected = id === 'carousel_plc' ? (paused.name === names[0] ? 889.1 : 755.2)
        : (paused.name === names[0] ? 610.1 : 710.2) + sourceState.epoch;
    const end = Date.now() + durationMs;
    let sawFreshValue = !changeSource;
    while (Date.now() < end) {
        const row = await snapshot(p, id); coherent(id, row);
        assert.equal(row.name, paused.name, `${label}: hovered component switched device`);
        assert.equal(row.count, paused.count, `${label}: hovered component changed its rotation index`);
        if (row.value !== null && Math.abs(row.value - expected) < 0.06) sawFreshValue = true;
        const peer = await snapshot(p, 'carousel_independent'); coherent('carousel_independent', peer);
        if (peer.value !== null || allowPendingPeer) peerNames.add(peer.name);
        rows.push({ id, ...row }); await sleep(125);
    }
    assert.equal(sawFreshValue, true, `${label}: current-device live refresh stopped while hovering`);
    assert.equal(peerNames.size, 2, `${label}: hovering one component also stopped another component`);
    await widget(p, id).screenshot({ path: path.join(directory, `${label.replace(/[^a-z0-9-]/g, '-')}-${id}-paused.png`) });
    await p.mouse.move(5, 5);
    const leftAt = Date.now();
    while (Date.now() - leftAt < 650) {
        const row = await snapshot(p, id); coherent(id, row);
        assert.equal(row.name, paused.name, `${label}: pointer leave caught up/skipped the paused interval immediately`);
        await sleep(80);
    }
    await waitUntil(async () => {
        const row = await snapshot(p, id); coherent(id, row);
        return row.name !== paused.name;
    }, 2400, `${label}: resumes remaining device interval`);
    const elapsed = Date.now() - leftAt;
    assert.ok(elapsed >= 900 && elapsed <= 2400, `${label}: remaining interval is not preserved (${elapsed} ms)`);
    observations.push({ surface: label, stage: 'hover', id, durationMs, httpDelayMs, allowPendingPeer,
        switched, paused, resumedAfterMs: elapsed, peerNames: [...peerNames], rows });
    pass(`${label}: ${id} hover pauses only its device switching, keeps live refresh and resumes the remaining interval (${elapsed} ms)`);
    } finally { sourceState.delayMs = originalHttpDelay; }
}
async function staticScopes(p, label) {
    const fixed = await snapshot(p, 'carousel_fixed');
    assert.equal(fixed.name, names[0]); assert.equal(fixed.count, ''); assert.ok(fixed.value >= 800);
    await widget(p, 'carousel_fixed').locator('.widget-shell').hover();
    await sleep(2200);
    const after = await snapshot(p, 'carousel_fixed'); assert.equal(after.name, names[0]); assert.equal(after.count, '');
    await waitUntil(async () => (await snapshot(p, 'carousel_global')).value === 333.3 + sourceState.epoch,
        12000, `${label}: global dataset refresh after the slow source`);
    const global = await snapshot(p, 'carousel_global'); assert.equal(global.name, ''); assert.equal(global.count, '');
    assert.equal(global.value, 333.3 + sourceState.epoch);
    await p.mouse.move(5, 5);
    observations.push({ surface: label, stage: 'fixed-global', fixed: after, global });
    pass(`${label}: fixed-device and global components retain their intended scope`);
}

(async () => {
    const infoFile = path.join(directory, 'server.json');
    helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'trend-source-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, TREND_SOURCE_INFO_FILE: infoFile },
        logFile: path.join(directory, 'server.log')
    });
    await waitUntil(() => { assert.equal(helper.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned display-only backend');
    info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    upstream = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture'), device = url.searchParams.get('device') || '';
        const epoch = sourceState.epoch, delayMs = sourceState.delayMs;
        const base = (device === 'temp_a' ? 610.1 : device === 'temp_b' ? 710.2 : 333.3) + epoch;
        requests.push({ device, at: Date.now(), epoch });
        await sleep(delayMs);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ rows: [0, .4, .2].map((offset, i) => ({ id: device, time: `样本${i + 1}`, value: +(base + offset).toFixed(1) })) }));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1',
        JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
    page = await context.newPage(); lastPage = page; watchErrors(page);
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.locator('.dashboard-designer-shell').waitFor();
    const connection = (await api('/data-sources/connections', 'POST', { name: '轮播悬停验收接口', sourceType: 'http_api',
        authType: 'none', baseUrl: `http://127.0.0.1:${upstream.address().port}/`, enabled: true })).connection;
    const dataset = (await api('/data-sources/datasets', 'POST', { name: '轮播悬停验收数据', connectionId: connection.id,
        source: 'http', rootPath: 'rows', refreshMs: 1000,
        request: { method: 'GET', path: '/read', parameters: [{ name: 'device', in: 'query', source: 'context', key: 'deviceId', required: false }] },
        columns: [{ name: 'time', path: 'time', label: '时间', type: 'string', role: 'category' },
            { name: 'value', path: 'value', label: '炉温', type: 'number', role: 'value', unit: '°C' }] })).dataset;
    const state = await api('/platform/designer');
    const { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
    function make(id, type, title, frame, data) {
        const w = createDashboardWidget(type);
        Object.assign(w, { id, title, runtimeTarget: 'overlay', visible: true, frame: { ...frame, rotation: 0 } });
        w.content = { ...w.content, showTitle: true, showDeviceLabel: true, categoryField: 'time', valueField: 'value',
            chartType: 'smoothLine', showAxis: true, showLegend: false, historyLength: 120 };
        w.data = { ...w.data, ...data };
        w.visibility = { ...w.visibility, viewIds: ['map_world', 'factory_overview'], viewModes: [], rules: [] };
        return w;
    }
    const rotate = { deviceScope: 'rotation', rotationDeviceIds: ids, rotationIntervalMs: 2000, refreshMs: 1000, unit: '°C', decimals: 1 };
    const plc = { ...rotate, mode: 'plc', pointId: info.pointIds[0], pointKey: 'analog.actual_temp', path: 'analog.actual_temp', requireConfiguredPoint: true };
    const external = { ...rotate, mode: 'dataset', datasetId: dataset.id, datasetField: 'value' };
    state.document.widgets = [
        make('carousel_plc', 'hud_chart_dock', '设备实时炉温', { x: 65, y: 130, width: 850, height: 330 }, plc),
        make('carousel_api', 'hud_chart_dock', '设备接口炉温', { x: 975, y: 130, width: 850, height: 330 }, external),
        make('carousel_independent', 'value', '独立轮播', { x: 975, y: 540, width: 400, height: 180 }, external),
        make('carousel_fixed', 'value', '固定设备', { x: 65, y: 540, width: 400, height: 180 }, { ...plc, deviceScope: 'fixed', deviceId: ids[0] }),
        make('carousel_global', 'value', '全局数据', { x: 515, y: 540, width: 400, height: 180 }, { ...external, deviceScope: 'global' })
    ];
    for (const view of state.document.scene.views) view.componentState = { show: widgets, hide: [] };
    await api('/platform/designer/draft', 'PUT', { sceneId: state.document.sceneId, document: state.document, expectedRevision: state.revision });
    await api('/platform/releases', 'POST', { sceneId: state.document.sceneId, notes: 'Owned carousel heading and hover regression' });
    const routeBase = { scene_id: state.document.sceneId, view_id: 'factory_overview', widget_ids: 'carousel_api' };
    function playbackRoute(time, extra = {}) {
        return '/data-sources/runtime-values?' + new URLSearchParams({ ...routeBase, playback_at: String(time), ...extra });
    }
    const historyReads = [];
    for (const time of [0, Date.now() - 120000]) {
        const result = await api(playbackRoute(time)), record = result.values.carousel_api;
        assert.ok(ids.includes(record.deviceId));
        assert.equal(record.deviceName, names[ids.indexOf(record.deviceId)]);
        assert.equal(record.value, record.deviceId === ids[0] ? 610.1 : 710.2);
        if (time === 0) assert.equal(record.deviceId, ids[0], 'zero clock is not replaced by the current wall clock');
        historyReads.push({ time, deviceId: record.deviceId, value: record.value });
    }
    for (const time of [-1, 1.5, Date.now() + 120000]) await api(playbackRoute(time), 'GET', undefined, 400);
    const ownedScope = await api(playbackRoute(0, { view_id: 'device_detail', device_id: ids[1] }));
    assert.equal(ownedScope.values.carousel_api.deviceId, ids[1]);
    assert.equal(ownedScope.values.carousel_api.value, 710.2);
    const foreignScope = await api(playbackRoute(0, { view_id: 'device_detail', device_id: 'FOREIGN' }));
    assert.equal(foreignScope.values.carousel_api.quality, 'bad');
    assert.equal(foreignScope.values.carousel_api.value, null);
    observations.push({ stage: 'historical-runtime-route', historyReads });
    pass('real runtime-values HTTP accepts zero and a 120-second historical carousel clock, rejects negative/fraction/future clocks and preserves registered-device scope');
    await page.evaluate(sceneId => localStorage.setItem(`dashboard-designer-state:${sceneId}`, JSON.stringify({
        viewId: 'factory_overview', selectedIds: ['carousel_api'], inspectorTab: 'data', layersCollapsed: false,
        viewPanelCollapsed: false, collapsedViewIds: [] })), state.document.sceneId);
    await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
    await widget(page, 'carousel_api').waitFor();
    const readPreview = page.getByRole('button', { name: '读取预览', exact: true });
    if (await readPreview.count()) await readPreview.click();
    let previewRow;
    await waitUntil(async () => { previewRow = await snapshot(page, 'carousel_api'); return previewRow.name === names[0] && previewRow.value === 610.1; },
        15000, 'ordinary editor preview uses first selected device');
    const editorRows = [];
    for (let i = 0; i < 10; i++) { const row = await snapshot(page, 'carousel_api'); coherent('carousel_api', row);
        assert.equal(row.name, names[0]); editorRows.push(row); await sleep(250); }
    observations.push({ surface: 'designer-editor', rows: editorRows });
    await page.screenshot({ path: path.join(directory, '01-designer-fixed-preview.png') });
    pass('ordinary designer editing keeps the first selected device name and external value synchronized instead of rotating behind a fixed preview');

    const runtime = await context.newPage(); lastPage = runtime; watchErrors(runtime);
    await runtime.goto(info.origin + '/group'); await widget(runtime, 'carousel_plc').waitFor();
    await observeRotation(runtime, 'map-runtime');
    await pauseTest(runtime, 'carousel_plc', 'map-runtime');
    await pauseTest(runtime, 'carousel_api', 'map-runtime', { durationMs: 17500, httpDelayMs: 3000, allowPendingPeer: true });
    await staticScopes(runtime, 'map-runtime');
    await runtime.screenshot({ path: path.join(directory, '02-map-runtime.png') });
    await runtime.close();

    const overlay = await context.newPage(); lastPage = overlay; watchErrors(overlay);
    await overlay.addInitScript(() => { window.__ownedHostHandlers = []; window.chrome = { webview: {
        postMessage() {}, addEventListener(name, fn) { if (name === 'message') window.__ownedHostHandlers.push(fn); }, removeEventListener() {} } }; });
    await overlay.goto(info.origin + '/overlay?embedded=unity&surface=overlay&scene=1');
    await overlay.locator('.dashboard-overlay-root').waitFor({ state: 'attached' });
    await overlay.evaluate(() => { for (const handler of window.__ownedHostHandlers) handler({ data: { type: 'overlay_host_state', visible: true,
        context: { factoryId: 'factory_default', sceneReady: true, viewId: 'factory_overview', viewMode: 'factory', deviceId: '', partId: '' } } }); });
    await overlay.addStyleTag({ content: 'html,body,#app{background:#171823!important}' });
    await widget(overlay, 'carousel_plc').waitFor();
    await observeRotation(overlay, 'native-overlay');
    await pauseTest(overlay, 'carousel_api', 'native-overlay');
    await staticScopes(overlay, 'native-overlay');
    await overlay.screenshot({ path: path.join(directory, '03-native-overlay.png') });
    await overlay.close();

    lastPage = page; await page.bringToFront();
    await page.getByRole('button', { name: '全屏预览当前视角', exact: true }).click();
    await page.locator('.dashboard-designer-shell.is-preview').waitFor();
    await observeRotation(page, 'designer-fullscreen');
    await pauseTest(page, 'carousel_api', 'designer-fullscreen');
    await page.screenshot({ path: path.join(directory, '04-designer-fullscreen.png') });
    await page.getByRole('button', { name: '退出全屏预览', exact: true }).click();
    assert.deepEqual(errors, []);
    const result = { success: true, directory, checks, errors, observations, requests,
        noCollectorOrCommissionedData: true, realUnityBackgroundTested: false };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: true, directory, checks, upstreamRequests: requests.length }, null, 2));
})().catch(async error => {
    if (lastPage) {
        const rendered = {};
        for (const id of widgets) rendered[id] = await widget(lastPage, id).count()
            ? await snapshot(lastPage, id).catch(cause => ({ error: cause.message })) : { missing: true };
        observations.push({ stage: 'failure-rendered-state', rendered });
    }
    await lastPage?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    const failure = { success: false, directory, error: error.stack, checks, errors, observations, requests };
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify(failure, null, 2));
    console.error(error.stack); console.error('ARTIFACT_DIRECTORY ' + directory); process.exitCode = 1;
}).finally(async () => {
    await browser?.close(); await stopOwnedSmokeProcess(helper);
    if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
