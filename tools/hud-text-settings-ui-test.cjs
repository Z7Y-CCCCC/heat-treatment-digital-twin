// Real inspector -> draft -> release -> runtime, using only an owned backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('hud-text-settings-ui');
const checks = [], errors = [];
let server, browser, page, info;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function api(route, method = 'GET', data) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + '/api' + route, {
    method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data })
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function select(id) {
  const index = ['hud_kpi_panel', 'hud_device_status', 'hud_alarm_panel', 'hud_chart_dock'].indexOf(id.replace('owned_', ''));
  await page.locator('.layer-list button').filter({ has: page.getByText('验收' + index, { exact: true }) }).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '内容', exact: true }).click();
}
async function edit(label, value) {
  const input = page.getByRole('textbox', { name: label, exact: true });
  await input.fill(value); await input.blur();
}
async function publish() {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/platform/releases');
  await page.locator('.designer-toolbar .publish-button').click();
  assert.equal((await response).status(), 200);
  await page.getByTestId('designer-publish-notice').filter({ hasText: '保存并发布成功' }).waitFor();
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'backend.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned backend');
  info = JSON.parse(fs.readFileSync(infoFile));
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.locator('.dashboard-designer-shell').waitFor();
  const state = await api('/platform/designer');
  state.document.metadata = { ...state.document.metadata, unifiedMapDesigner: 1 };
  const { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
  const types = ['hud_kpi_panel', 'hud_device_status', 'hud_alarm_panel', 'hud_chart_dock'];
  state.document.widgets = types.map((type, index) => {
    const widget = createDashboardWidget(type, index, { x: 40 + (index % 2) * 780, y: 180 + Math.floor(index / 2) * 420 });
    widget.id = 'owned_' + type; widget.title = '验收' + index;
    // Legacy snapshots have no eyebrow field. The form must show its real default.
    delete widget.content.eyebrow;
    return widget;
  });
  for (const view of state.document.scene.views) view.componentState = { show: state.document.widgets.map(w => w.id), hide: [] };
  await api('/platform/designer/draft', 'PUT', { sceneId: state.document.sceneId, document: state.document, expectedRevision: state.revision });
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
  await page.getByRole('tree', { name: '视角层级', exact: true }).locator('[data-view-id="factory_overview"] .view-tree-select').click();
  const kpi = page.locator('[data-widget-id="owned_hud_kpi_panel"]');
  await select('owned_hud_kpi_panel');
  assert.deepEqual(await page.locator('.layer-actions button').allTextContents(), ['置顶', '置底']);
  assert.equal(await page.getByRole('textbox', { name: '副标题（小字）', exact: true }).inputValue(), 'PRODUCTION');
  assert.equal(await kpi.locator('.hud-module-eyebrow').innerText(), 'PRODUCTION');
  pass('legacy visible subtitle and inspector value agree instead of a blank field hiding a renderer default');
  await edit('副标题（小字）', '车间 · 当班累计');
  await edit('圆环名称', '综合产效'); await edit('底部文字', '本班统计');
  assert.equal(await kpi.locator('.hud-module-eyebrow').innerText(), '车间 · 当班累计');
  assert.equal(await kpi.locator('.hud-module-note').innerText(), '本班统计');
  await page.locator('.inspector-tabs').getByRole('button', { name: '样式', exact: true }).click();
  await page.locator('.hud-copy-settings summary').click();
  const size = page.getByRole('spinbutton', { name: '副标题字号', exact: true });
  await size.fill('14'); await size.blur();
  assert.equal(await kpi.locator('.hud-module-eyebrow').evaluate(el => getComputedStyle(el).fontSize), '14px');
  await publish();
  const saved = (await api('/platform/designer')).document.widgets.find(w => w.id === 'owned_hud_kpi_panel');
  assert.equal(saved.content.eyebrow, '车间 · 当班累计'); assert.equal(saved.style.eyebrowFontSize, 14);
  await kpi.screenshot({ path: path.join(directory, '01-custom-designer.png') });
  let runtime = await context.newPage(); runtime.on('pageerror', e => errors.push(e.message));
  await runtime.goto(info.origin + '/group');
  let runtimeKpi = runtime.locator('.map-surface-widget-layer .widget-kind-hud_kpi_panel').filter({ hasText: '验收0' });
  await runtimeKpi.locator('.hud-module-eyebrow').filter({ hasText: '车间 · 当班累计' }).waitFor();
  assert.equal(await runtimeKpi.locator('.hud-module-eyebrow').evaluate(el => getComputedStyle(el).fontSize), '14px');
  assert.equal(await runtimeKpi.locator('.hud-module-note').innerText(), '本班统计');
  await runtimeKpi.screenshot({ path: path.join(directory, '02-custom-runtime.png') });
  await runtime.close();
  pass('editing subtitle, ring label, footer and subtitle size saves and publishes identically to the runtime');
  let native;
  async function loadNative() {
    native = await context.newPage(); native.on('pageerror', e => errors.push(e.message));
    await native.addInitScript(() => { window.ownedHostHandlers = []; window.chrome = { webview: { postMessage() {}, addEventListener(name, fn) { if (name === 'message') window.ownedHostHandlers.push(fn); }, removeEventListener() {} } }; });
    // This fixture has no Unity process. Simulate only its readiness handshake;
    // measurement values still come from the owned backend, not canned readings.
    await native.route('**/api/health', async route => {
      const response = await route.fetch(), body = await response.json();
      body.readiness = { ...body.readiness, displayReady: true };
      await route.fulfill({ response, json: body });
    });
    // scene=1 is the existing native factory-surface marker, not a database scene ID.
    await native.goto(info.origin + '/overlay?embedded=unity&surface=overlay&scene=1');
    await native.locator('.dashboard-overlay-root').waitFor({ state: 'attached' });
    await native.addStyleTag({ content: 'html,body,#app{background:#26282e!important}' });
    await native.evaluate(() => { for (const fn of window.ownedHostHandlers) fn({ data: { type: 'overlay_host_state', visible: true, context: { factoryId: 'factory_default', sceneReady: true, viewId: 'factory_overview', viewMode: 'factory', deviceId: '', partId: '' } } }); });
  }
  await loadNative();
  let nativeKpi = native.locator('[data-widget-id="owned_hud_kpi_panel"]');
  await nativeKpi.locator('.hud-module-eyebrow').filter({ hasText: '车间 · 当班累计' }).waitFor();
  await native.getByRole('status', { name: '大屏正在加载', exact: true }).waitFor({ state: 'hidden' });
  await nativeKpi.locator('.widget-data-placeholder').waitFor({ state: 'hidden' });
  assert.equal(await nativeKpi.locator('.hud-module-eyebrow').evaluate(el => getComputedStyle(el).fontSize), '14px');
  await nativeKpi.screenshot({ path: path.join(directory, '02-custom-native-overlay.png'), animations: 'disabled' });
  await native.close();
  pass('the native WebView overlay also reads the published subtitle and typography through the existing host context');
  await select('owned_hud_kpi_panel');
  await edit('副标题（小字）', ''); await edit('圆环名称', ''); await edit('底部文字', '');
  assert.equal(await kpi.locator('.hud-module-eyebrow').count(), 0);
  assert.equal(await kpi.locator('.hud-module-ring-copy em').count(), 0);
  await publish(); runtime = await context.newPage(); runtime.on('pageerror', e => errors.push(e.message));
  await runtime.goto(info.origin + '/group');
  runtimeKpi = runtime.locator('.map-surface-widget-layer .widget-kind-hud_kpi_panel').filter({ hasText: '验收0' });
  await runtimeKpi.waitFor();
  assert.equal(await runtimeKpi.locator('.hud-module-eyebrow').count(), 0);
  assert.equal(await runtimeKpi.locator('.hud-module-note').count(), 0);
  await runtime.close();
  await loadNative(); nativeKpi = native.locator('[data-widget-id="owned_hud_kpi_panel"]'); await nativeKpi.waitFor();
  assert.equal(await nativeKpi.locator('.hud-module-eyebrow').count(), 0);
  await native.close();
  await page.reload(); await page.getByRole('tree', { name: '视角层级', exact: true }).locator('[data-view-id="factory_overview"] .view-tree-select').click();
  await select('owned_hud_kpi_panel');
  assert.equal(await page.getByRole('textbox', { name: '副标题（小字）', exact: true }).inputValue(), '');
  assert.equal(await kpi.locator('.hud-module-eyebrow').count(), 0);
  await kpi.screenshot({ path: path.join(directory, '03-blank-hidden-after-reload.png') });
  pass('clearing fields really hides their text after publish and application-style reload, with no PRODUCTION fallback');
  for (const [type, field, value] of [['hud_device_status', '在线数量标题', '已连接'], ['hud_alarm_panel', '空列表文字', '暂无告警'], ['hud_chart_dock', '区间标题', '温度范围']]) {
    await select('owned_' + type);
    const details = page.locator('.hud-copy-settings');
    if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
    await edit(field, value);
  }
  await publish();
  const final = (await api('/platform/designer')).document;
  assert.equal(final.widgets.find(w => w.type === 'hud_device_status').content.onlineLabel, '已连接');
  assert.equal(final.widgets.find(w => w.type === 'hud_alarm_panel').content.emptyText, '暂无告警');
  assert.equal(final.widgets.find(w => w.type === 'hud_chart_dock').content.rangeLabel, '温度范围');
  assert.deepEqual(errors, []);
  pass('device, event and chart static captions are available in a compact other-text section and survive publication');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, directory }, null, 2));
  console.log(directory);
})().catch(async error => { await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
