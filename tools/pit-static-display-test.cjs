const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { applyPitCadLayout } = require('./apply-pit-cad-layout.cjs');
const { createClient, applyStaticDisplay, PREFIX, PARAMS, TARGET } = require('./pit-static-display.cjs');
const cad = require('./model-profiles/pit-workshop-cad-layout.json');
const templates = require('./model-profiles/pit-static-hud-templates.json');
const WebSocket = require('../backend/node_modules/ws');

let backend, browser, unityFixture, page;
const checks = [], errors = [];
const pass = text => { checks.push(text); console.log('PASS ' + text); };
async function main() {
    const sandbox = await createSmokeSandbox('pit-static-acceptance');
    const origin = 'http://127.0.0.1:' + await findFreePort();
    sandbox.password = 'Owned-Pit-Static-Fixture-2026!';
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: path.resolve(__dirname, '../frontend/dist') }, logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(origin + '/api/health');
    const root = createClient(origin, sandbox.env.ADMIN_API_TOKEN, 'factory_default');
    const factoryId = (await root.api('/api/factories', 'POST', { name: '井式炉静态验收隔离厂' })).factory.id;
    const client = createClient(origin, sandbox.env.ADMIN_API_TOKEN, factoryId);
    await client.api('/api/workshops', 'POST', { id: TARGET.workshopId, name: '井式炉车间' });
    await client.api('/api/lines', 'POST', { id: TARGET.lineId, name: '井式炉产线', workshop_id: TARGET.workshopId });
    for (const spec of cad.devices.filter(d => d.id.startsWith('PitFurnace_'))) {
        await client.api('/api/devices', 'POST', { id: spec.id, name: spec.name, model_type: spec.model_type, line_id: TARGET.lineId, plc_enabled: 0, scale: 1 });
    }
    await applyPitCadLayout(origin, sandbox.env.ADMIN_API_TOKEN, { ...TARGET, factoryId });
    const result = await applyStaticDisplay(origin, sandbox.env.ADMIN_API_TOKEN, { factoryId, templates });
    const first = await client.call('get_project_state');
    const importedDir = path.join(sandbox.dataDir, 'data-source-files', factoryId);
    const importedCount = fs.readdirSync(importedDir).length;
    await applyStaticDisplay(origin, sandbox.env.ADMIN_API_TOKEN, { factoryId, templates });
    const repeated = await client.call('get_project_state');
    assert.equal(repeated.devices.length, 17); assert.equal(repeated.designer.document.widgets.length, first.designer.document.widgets.length);
    assert.equal(fs.readdirSync(importedDir).length, importedCount);
    assert.equal((await root.api('/api/data-sources')).connections.some(c => c.id === 'pit_demo_erp'), false);
    const external = (await client.api('/api/data-sources')).connections.filter(c => c.id.startsWith('pit_demo_'));
    assert.equal(external.length, 2); assert.ok(external.every(c => c.readOnly && c.health.status === 'healthy'));
    const data = await client.api('/api/data-sources/runtime-values?view_id=line_overview');
    assert.equal(data.values[PREFIX + 'erp_orders'].rows.length, 9);
    assert.equal(data.values[PREFIX + 'vms_cameras'].rows.length, 4);
    assert.ok(data.values[PREFIX + 'erp_orders'].rows.every(r => r.msg.includes('PIT-')));
    const document = repeated.designer.document;
    assert.equal(document.widgets.filter(w => w.id.startsWith(PREFIX + 'pick_')).length, 0, 'no truncated bottom device shortcuts');
    assert.ok(!document.widgets.some(w => w.id.startsWith(PREFIX) && w.visibility.viewIds.includes('line_overview') && w.frame.y >= 930), 'bottom reserved for WebView controls');
    assert.equal(document.widgets.filter(w => w.id.startsWith(PREFIX + 'value_')).length, 9 * PARAMS.length);
    assert.equal(document.widgets.filter(w => w.id.startsWith(PREFIX + 'passive_source_')).length, 8);
    for (const w of document.widgets.filter(w => w.id.startsWith(PREFIX))) assert.ok(!/模拟|非现场|示意|估算|演示/.test(JSON.stringify(w.content)), 'no excessive explanatory labels in the display');
    for (const w of document.widgets.filter(w => w.id.startsWith(PREFIX))) {
        assert.equal(w.animation.type, 'none');
        assert.ok(w.data.mode !== 'plc', 'no invented site PLC address or point binding');
        assert.ok(!/deviceDataMap\.(?:Furnace_|qxj\.|h1\.|111\.)/.test(JSON.stringify(w)), 'no borrowed Tianjin values');
    }
    pass('17 CAD objects and all device/ground/PLC fields retained; repeated setup reuses widgets and two private external JSON assets; Tianjin scope unchanged');
    pass('ERP 9 orders / VMS 4 camera records read through saved read-only external connectors, separate from 63 built-in-acquisition parameter widgets and 8 passive-facility panels');
    if (!process.argv.includes('--ui')) {
        const report = { success: true, checks, directory: result.directory };
        fs.writeFileSync(path.join(result.directory, 'acceptance.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    // This fake native context exists only in the owned isolated backend. Actual
    // Unity is validated separately by authenticated project MCP/native APIs.
    await client.api('/api/factories/' + factoryId + '/activate', 'POST', {});
    const session = await createSmokeSession(origin, sandbox);
    const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, extraHTTPHeaders: { 'X-Factory-ID': factoryId } });
    await context.addCookies(session.cookie.split('; ').map(piece => { const at = piece.indexOf('='); return { name: piece.slice(0, at), value: piece.slice(at + 1), url: origin }; }));
    await context.addInitScript(id => localStorage.setItem('digital_twin_factory_scope_v1', id), factoryId);
    unityFixture = new WebSocket(origin.replace('http', 'ws') + '/ws');
    const latest = new Map(); let lastCommand;
    unityFixture.on('message', bytes => { const message = JSON.parse(bytes); if (message.type === 'realtime_frame') for (const d of message.payload.devices) latest.set(d.furnace_id, d); if (message.type === 'native_scene_preview') lastCommand = message.payload; });
    await new Promise((resolve, reject) => { unityFixture.once('open', resolve); unityFixture.once('error', reject); });
    unityFixture.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
    const focus = (deviceId = '') => unityFixture.send(JSON.stringify({ type: 'dashboard_context', payload: {
        factoryId, sceneId: repeated.designer.scene.id, sceneReady: true, viewId: deviceId ? 'device_detail' : 'line_overview',
        viewMode: deviceId ? 'device' : 'line', workshopId: TARGET.workshopId, lineId: TARGET.lineId, deviceId,
        inspectionStage: deviceId ? 'solid' : '' } }));
    focus();
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/overlay?factoryId=' + factoryId);
    await page.getByText('生产订单', { exact: true }).first().waitFor();
    await page.getByText('视频监控', { exact: true }).waitFor();
    await waitUntil(() => latest.has('PitFurnace_01'), 20000, 'built-in acquisition frame');
    await waitUntil(async () => await page.locator('.widget-shell.data-pending').count() === 0, 20000, 'all data panels ready');
    await page.waitForTimeout(2200);
    assert.ok((await page.locator('.overlay-widget').count()) < 60, 'inactive detail widgets must not all be rendered');
    assert.ok((await page.locator('body').boundingBox()).width <= 1920);
    await page.screenshot({ path: path.join(result.directory, '01-static-overview.png') });
    for (const spec of cad.devices) {
        lastCommand = null;
        // Validate the actual widget event, not a direct synthetic UI handler.
        focus();
        await page.getByRole('combobox', { name: '选择设备', exact: true }).selectOption(spec.id);
        await waitUntil(() => lastCommand?.focus?.deviceId === spec.id, 5000, 'correct native device navigation request');
        focus(spec.id);
        const expectedName = repeated.devices.find(d => d.id === spec.id).name;
        await page.locator('.overlay-widget').getByText(expectedName, { exact: true }).waitFor();
        await page.getByText(`设备：${spec.id}`, { exact: true }).waitFor();
        if (spec.number <= 9) {
            assert.equal(await page.getByText('实际温度', { exact: true }).count(), 1);
            assert.equal(await page.getByText('炉盖状态', { exact: true }).count(), 1);
            const temperatures = await page.getByText(/^\d[\d,.]* °C$/).allTextContents();
            assert.ok(temperatures.some(text => Math.abs(parseFloat(text.replaceAll(',', '')) - latest.get(spec.id).analog.actual_temp) < 4), 'device-specific collected temperature');
            await page.getByText(new RegExp(`PIT-${String(spec.number).padStart(2, '0')} · 60`)).waitFor();
        } else {
            assert.equal(await page.getByText('实际温度', { exact: true }).count(), 0);
            await page.getByText('模型高度', { exact: true }).waitFor();
        }
        assert.equal(await page.locator('.overlay-widget .quality-bad').count(), 0);
        if ([1, 3, 10].includes(spec.number)) await page.screenshot({ path: path.join(result.directory, `detail-${spec.number}.png`) });
    }
    pass('WebView page opens every one of 17 objects through real navigation events; 9 furnace detail panels show their own acquisition values and ERP batch, 8 static facilities show no fictitious telemetry');
    focus('PitFurnace_02');
    await page.getByText('设备：PitFurnace_02', { exact: true }).waitFor();
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1600, height: 900 }]) {
        await page.setViewportSize(viewport); await page.waitForTimeout(400);
        const cropped = await page.locator('.overlay-widget .widget-text p').evaluateAll(nodes => nodes
            .filter(n => /^\d[\d,.]*\s*(?:°C|rpm)$/.test(n.textContent.trim()) && n.scrollWidth > n.clientWidth + 1)
            .map(n => ({ text: n.textContent, width: n.clientWidth, required: n.scrollWidth })));
        await page.screenshot({ path: path.join(result.directory, `detail-${viewport.width}.png`) });
        assert.deepEqual(cropped, [], 'important parameter values must not be ellipsized in a smaller window');
        const heading = await page.locator('.overlay-widget').getByText(repeated.devices.find(d => d.id === 'PitFurnace_02').name, { exact: true }).boundingBox();
        const hierarchy = await page.getByRole('navigation', { name: '逐级浏览' }).boundingBox();
        assert.ok(heading.y > hierarchy.y + hierarchy.height, 'detail heading must not overlap the breadcrumb');
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    pass('1366x768 and 1600x900 detail windows retain complete temperature and fan-speed values');
    focus(); await page.getByText('视频监控', { exact: true }).waitFor();
    const file = path.join(importedDir, external.find(c => c.id === 'pit_demo_erp').baseUrl);
    const bytes = fs.readFileSync(file); const frameTime = latest.get('PitFurnace_01').timestamp;
    try {
        fs.unlinkSync(file); await page.waitForTimeout(6000);
        const unavailable = await client.api('/api/data-sources/runtime-values?view_id=line_overview');
        assert.equal(unavailable.values[PREFIX + 'erp_orders'].quality, 'bad');
        assert.equal(unavailable.values[PREFIX + 'vms_cameras'].quality, 'good');
        assert.notEqual(latest.get('PitFurnace_01').timestamp, frameTime, 'external source failure must not stop internal acquisition');
    } finally { fs.writeFileSync(file, bytes, { mode: 0o600 }); }
    pass('loss of the owned ERP export reports bad quality, does not substitute a zero, and leaves VMS and built-in acquisition running');
    assert.deepEqual(errors, []);
    const report = { success: true, directory: result.directory, checks, browserErrors: errors };
    fs.writeFileSync(path.join(result.directory, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(async error => {
    if (page) await page.screenshot({ path: path.resolve(__dirname, '../output/pit-static-failure.png') }).catch(() => {});
    console.error(String(error.stack || error).replace(/(cookie:\s*)[^\r\n]+/gi, '$1[redacted]')); process.exitCode = 1;
}).finally(async () => { unityFixture?.close(); await browser?.close(); await stopOwnedSmokeProcess(backend); });
