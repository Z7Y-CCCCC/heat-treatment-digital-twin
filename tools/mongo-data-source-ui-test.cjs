'use strict';
// Owned MongoDB, display-only backend and real Vue overlay. No operator profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { createMongoFixture } = require('../backend/scripts/fixtures/mongo-fixture.cjs');
const directory = createRunDirectory('mongo-source-ui'), errors = [], checks = [];
let fixture, server, browser, page, info;
const check = message => { checks.push(message); console.log('PASS ' + message); };
async function api(route, method = 'GET', data) {
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const response = await page.request.fetch(info.origin + '/api' + route, { method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken }, ...(data === undefined ? {} : { data }) });
    assert.equal(response.status(), 200, await response.text()); return response.json();
}
(async () => {
    fixture = await createMongoFixture(directory);
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], { cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile, MANUAL_LAYOUT_DISPLAY_ONLY: 'true' }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned display-only backend');
    info = JSON.parse(fs.readFileSync(infoFile));
    await fixture.database.collection('设备参数').insertMany([{ deviceId: info.devices[0], telemetry: { temperature: 0 } }, { deviceId: info.devices[1], telemetry: { temperature: 888.5 } }]);
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'settings', settingsSubpage: 'database' })));
    page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.getByRole('tab', { name: '外部数据源', exact: true }).click();
    const workspace = page.locator('.source-workspace');
    await workspace.getByRole('button', { name: '＋ 新建数据源', exact: true }).click();
    await page.getByRole('dialog', { name: '新建数据源', exact: true }).locator('.source-type-card').filter({ hasText: 'MongoDB' }).click();
    const editor = page.getByRole('region', { name: '数据源配置', exact: true });
    await editor.getByLabel('数据源名称', { exact: true }).fill('MongoDB 设备数据');
    assert.equal(await editor.getByLabel('端口', { exact: true }).inputValue(), '27017');
    await editor.getByLabel('主机', { exact: true }).fill('127.0.0.1'); await editor.getByLabel('端口', { exact: true }).fill(String(fixture.port)); await editor.getByLabel('数据库名', { exact: true }).fill(fixture.name);
    await editor.getByRole('tab', { name: '认证', exact: true }).click();
    await editor.getByLabel('只读账号', { exact: true }).fill(fixture.username); await editor.getByLabel('密码', { exact: true }).fill(fixture.password); await editor.getByLabel('MongoDB 认证数据库', { exact: true }).fill(fixture.name);
    await editor.getByRole('tab', { name: '高级', exact: true }).click();
    assert.equal(await editor.getByLabel('TLS 加密连接', { exact: true }).isChecked(), true); await editor.getByLabel('TLS 加密连接', { exact: true }).uncheck();
    await editor.getByRole('button', { name: '测试连接', exact: true }).click(); await editor.locator('.source-health.healthy').waitFor();
    await editor.getByRole('button', { name: '保存数据源', exact: true }).click(); await editor.getByText('已保存：MongoDB 设备数据', { exact: true }).waitFor();
    await editor.getByRole('tab', { name: '数据预览', exact: true }).click();
    const preview = page.getByRole('region', { name: '数据源只读预览', exact: true });
    await preview.getByRole('button', { name: '读取集合', exact: true }).click();
    await preview.getByLabel('MongoDB 集合', { exact: true }).selectOption({ label: fixture.name + '.设备参数' });
    await preview.getByLabel('字段', { exact: true }).selectOption('telemetry.temperature');
    await preview.getByRole('button', { name: '读取样例', exact: true }).click(); await preview.getByText('当前值：888.5', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, '01-native-collection-preview.png'), fullPage: true });
    await page.getByRole('tab', { name: '自动备份', exact: true }).click();
    assert.equal(await page.locator('.database-backup-source-option').filter({ hasText: 'MongoDB 设备数据' }).count(), 0, 'read-only MongoDB must not appear as a SQL dump source');
    await page.getByRole('tab', { name: '外部数据源', exact: true }).click();
    check('catalog, native host/port/auth/TLS controls, test/save, collection/nested-field and real value preview work against authenticated MongoDB');
    await workspace.getByRole('button', { name: '数据集', exact: true }).click(); await workspace.getByRole('button', { name: '＋ 新建数据集', exact: true }).click();
    const datasetEditor = page.locator('.dataset-editor');
    await datasetEditor.getByLabel('数据集名称', { exact: true }).fill('MongoDB 当前设备'); await datasetEditor.getByLabel('数据集集合', { exact: true }).fill('设备参数');
    assert.equal(await datasetEditor.getByLabel('Schema', { exact: true }).count(), 0);
    await datasetEditor.getByRole('tab', { name: '参数与匹配', exact: true }).click(); await datasetEditor.getByRole('switch', { name: '按当前对象匹配记录', exact: true }).check(); await datasetEditor.getByLabel('记录匹配字段', { exact: true }).fill('deviceId');
    await datasetEditor.getByRole('tab', { name: '字段映射', exact: true }).click(); await datasetEditor.getByRole('button', { name: '解析字段', exact: true }).click();
    await datasetEditor.getByLabel('发现的来源字段', { exact: true }).selectOption('telemetry.temperature'); await datasetEditor.getByRole('button', { name: '添加到映射', exact: true }).click();
    await datasetEditor.getByLabel('字段单位 1', { exact: true }).fill('°C');
    await datasetEditor.getByRole('button', { name: '保存数据集', exact: true }).click(); await datasetEditor.getByText('已保存', { exact: true }).waitFor();
    await datasetEditor.getByRole('tab', { name: '数据预览', exact: true }).click(); await datasetEditor.getByLabel('预览 deviceId', { exact: true }).fill(info.devices[0]);
    await datasetEditor.getByRole('button', { name: '读取预览', exact: true }).click(); await datasetEditor.locator('.result-table tbody tr').waitFor();
    assert.equal((await datasetEditor.locator('.result-table tbody tr td').last().innerText()).trim(), '0');
    await page.screenshot({ path: path.join(directory, '02-device-dataset.png'), fullPage: true });
    check('a reusable dataset is authored through the real UI with current-device matching, discovered nested fields and a valid zero value');
    const definition = (await api('/data-sources/datasets')).datasets.find(d => d.name === 'MongoDB 当前设备'); assert.ok(definition);
    const designer = await api('/platform/designer');
    const { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
    const boundWidget = createDashboardWidget('value');
    Object.assign(boundWidget, { id: 'mongo_delivery_value', title: '设备温度', visible: true, runtimeTarget: 'overlay', zIndex: 100,
        frame: { x: 72, y: 200, width: 400, height: 220, rotation: 0 } });
    boundWidget.content.unit = '°C';
    boundWidget.data = { ...boundWidget.data, mode: 'dataset', datasetId: definition.id, datasetField: definition.columns[0].name, refreshMs: 1000, deviceScope: 'current' };
    boundWidget.visibility.viewIds = ['device_detail']; designer.document.widgets.push(boundWidget);
    for (const mode of ['fixed', 'rotation']) {
        const extra = createDashboardWidget('value');
        Object.assign(extra, { id: 'mongo_' + mode, title: mode === 'fixed' ? '固定设备' : '设备轮播', runtimeTarget: 'overlay',
            frame: { x: mode === 'fixed' ? 72 : 520, y: 200, width: 400, height: 220, rotation: 0 } });
        extra.data = { ...boundWidget.data, deviceScope: mode, deviceId: mode === 'fixed' ? info.devices[0] : '', rotationDeviceIds: info.devices, rotationIntervalMs: 2000 };
        extra.visibility.viewIds = ['factory_overview']; designer.document.widgets.push(extra);
    }
    const detail = designer.document.scene.views.find(view => view.id === 'device_detail');
    if (detail) detail.componentState = { show: ['mongo_delivery_value'], hide: [] };
    const overview = designer.document.scene.views.find(view => view.id === 'factory_overview');
    if (overview) overview.componentState = { show: ['mongo_fixed', 'mongo_rotation'], hide: [] };
    await api('/platform/designer/draft', 'PUT', { sceneId: designer.document.sceneId, document: designer.document, expectedRevision: designer.revision }); await api('/platform/releases', 'POST', { sceneId: designer.document.sceneId, notes: 'Owned MongoDB binding verification' });
    const overlay = await context.newPage(); overlay.on('pageerror', e => errors.push(e.message));
    await overlay.addInitScript(() => { window.__hostHandlers = []; window.chrome = { webview: { postMessage() {}, addEventListener(name, fn) { if (name === 'message') window.__hostHandlers.push(fn); }, removeEventListener() {} } }; });
    await overlay.goto(info.origin + '/overlay?embedded=unity&surface=overlay&scene=1'); await overlay.locator('.dashboard-overlay-root').waitFor({ state: 'attached' });
    // A plain dark backdrop, not a fabricated Unity scene, makes transparent
    // WebView material legible in this browser-only renderer test.
    await overlay.addStyleTag({ content: 'html,body,#app{background:#171823!important}' });
    const widget = overlay.locator('[data-widget-id="mongo_delivery_value"]');
    async function selectDevice(deviceId) { await overlay.evaluate(id => { for (const handler of window.__hostHandlers) handler({ data: { type: 'overlay_host_state', visible: true, context: { factoryId: 'factory_default', sceneReady: true, viewId: 'device_detail', viewMode: 'device', deviceId: id, partId: '' } } }); }, deviceId); }
    await selectDevice(info.devices[0]); await waitUntil(async () => (await widget.innerText()).includes('0') && !await widget.locator('.widget-data-placeholder').count(), 15000, 'real overlay zero');
    await selectDevice(info.devices[1]); await waitUntil(async () => (await widget.innerText()).includes('888.5'), 15000, 'real overlay selected device B');
    assert.ok((await widget.innerText()).includes('°C'), 'the dataset output unit is rendered without a duplicate widget override');
    await fixture.database.collection('设备参数').updateOne({ deviceId: info.devices[1] }, { $set: { 'telemetry.temperature': 999.5 } });
    await waitUntil(async () => (await widget.innerText()).includes('999.5'), 15000, 'real overlay periodic refresh');
    await overlay.screenshot({ path: path.join(directory, '03-real-overlay-refresh.png') });
    check('normal save/publish feeds the actual Vue overlay; changing devices and the database value updates the displayed component on its refresh interval');
    await overlay.evaluate(() => { for (const handler of window.__hostHandlers) handler({ data: { type: 'overlay_host_state', visible: true, context: { factoryId: 'factory_default', sceneReady: true, viewId: 'factory_overview', viewMode: 'factory', deviceId: '', partId: '' } } }); });
    const rotation = overlay.locator('[data-widget-id="mongo_rotation"]'), fixed = overlay.locator('[data-widget-id="mongo_fixed"]'), observed = new Set();
    await waitUntil(async () => {
        const body = await rotation.innerText();
        if (body.includes('999.5')) observed.add('B');
        else if (!await rotation.locator('.widget-data-placeholder').count()
            && Number.parseFloat((await rotation.locator('.value-widget-body strong').innerText().catch(() => '')).replace(/,/g, '')) === 0) observed.add('A');
        return observed.size === 2;
    }, 15000, 'MongoDB A/B rotation in the actual overlay');
    assert.ok(!(await fixed.innerText()).includes('999.5'));
    assert.ok((await fixed.innerText()).includes('0'));
    await overlay.screenshot({ path: path.join(directory, '04-fixed-and-rotation.png') });
    check('the same MongoDB dataset reuses fixed-device and multi-device rotation in overview widgets while continuing timed refresh');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, directory, noCollectionOrSoak: true, realUnityBackgroundTested: false };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => { await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2)); console.error(error); process.exitCode = 1; })
.finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); await fixture?.close(); });
