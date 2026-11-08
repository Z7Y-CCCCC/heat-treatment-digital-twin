// Isolated browser regression: owned collector:false SQLite + random loopback
// backend only. No installed database, account, PLC, Unity or user window.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');

const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output', 'playwright', `designer-diagnostic-focus-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix);
const mainId = 'diagnostic_main_hidden', ordinaryId = 'diagnostic_main_ordinary';
const tooltipId = 'diagnostic_nested_value', tooltipOrdinaryId = 'diagnostic_nested_ordinary';
const deviceTemplateId = 'diagnostic_device_template', partTemplateId = 'diagnostic_part_template';
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], httpFailures = [], writes = [], forbiddenRequests = [];
const geometryChecks = [];
let helper, browser, page, info, initialState, persistedDraftBefore, revision, sceneId, viewId;
function pass(label) { checks.push(label); console.log('PASS ' + label); }
const shell = () => page.locator('.dashboard-designer-shell');
const mainFrame = () => page.locator(`.designer-diagnostic-frame[data-diagnostic-widget-id="${mainId}"]`);
const tooltipFrame = id => page.locator(`.tooltip-diagnostic-frame[data-tooltip-diagnostic-template-id="${id}"][data-tooltip-diagnostic-widget-id="${tooltipId}"]`);
const issue = (id, templateName) => {
  const candidates = page.locator(`.designer-validation-issues [data-diagnostic-component-id="${id}"]`);
  return (templateName ? candidates.filter({ hasText: `悬停模板“${templateName}”` }) : candidates).first();
};
async function api(route, method = 'GET', data) {
  assert.equal(new URL(info.origin).hostname, '127.0.0.1');
  assert.notEqual(new URL(info.origin).port, '3001');
  const session = await page.request.get(info.origin + '/api/admin-auth/session').then(response => response.json());
  const response = await page.request.fetch(info.origin + '/api' + route, {
    method, headers: { Origin: info.origin, 'X-Factory-ID': info.factoryId, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data })
  });
  assert.equal(response.status(), 200, await response.text());
  const body = await response.json(); assert.notEqual(body.success, false, JSON.stringify(body)); return body;
}
async function ready() {
  await shell().waitFor(); await page.locator('.designer-loading').waitFor({ state: 'hidden' });
  await waitUntil(() => page.locator('.designer-toolbar .publish-button').isEnabled(), 20000, 'fixture designer ready');
}
function readPersistedDraft() {
  const database = new Database(requireTestPath(info.database), { readonly: true });
  try { return database.prepare('SELECT draft_json, draft_revision FROM scenes WHERE id=?').get(sceneId); }
  finally { database.close(); }
}
async function screenshot(name) {
  const filename = path.join(directory, name + '.png');
  await page.screenshot({ path: filename, fullPage: false }); screenshots.push(filename);
}
async function expectRedFrame(frame, viewportSelector) {
  await frame.waitFor({ state: 'visible' });
  await waitUntil(async () => {
    const geometry = await frame.evaluate((element, selector) => {
    const viewport = element.closest(selector)?.getBoundingClientRect(), rect = element.getBoundingClientRect();
    const scroll = element.closest(selector);
    const shown = viewport && rect.left >= viewport.left - 2 && rect.top >= viewport.top - 2
      && rect.right <= viewport.right + 2 && rect.bottom <= viewport.bottom + 2
      && rect.left >= 0 && rect.top >= 60 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    const bounds = value => value && Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]]));
    return { shown, rect: bounds(rect), viewport: bounds(viewport), scrollLeft: scroll?.scrollLeft, scrollTop: scroll?.scrollTop,
      scrollWidth: scroll?.scrollWidth, scrollHeight: scroll?.scrollHeight, innerWidth, innerHeight };
    }, viewportSelector);
    geometryChecks.push({ selector: viewportSelector, ...geometry });
    return geometry.shown;
  }, 10000, 'diagnostic rectangle scrolled into both its editor and the actual browser viewport');
  const style = await frame.evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    return { border: style.borderTopStyle, color: style.borderTopColor, opacity: style.opacity,
      pointerEvents: style.pointerEvents, screenBorder: parseFloat(style.borderTopWidth) * rect.width / parseFloat(style.width) };
  });
  assert.equal(style.border, 'dashed');
  const [red, green, blue] = style.color.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
  assert.ok(red >= 200 && green <= 110 && blue <= 110, `visibly red diagnostic border: ${style.color}`);
  assert.ok(style.screenBorder >= 1.9, `at least 2 screen pixels at current zoom: ${style.screenBorder}`);
  assert.equal(style.opacity, '1'); assert.equal(style.pointerEvents, 'none');
}
async function locateMain() {
  await issue(mainId).getByRole('button', { name: /定位组件/ }).click();
  await expectRedFrame(mainFrame(), '.designer-canvas-scroll');
  assert.equal(await page.locator('.inspector-tabs button.active').innerText(), '数据来源');
}
async function locateTooltip(id, name, kindLabel) {
  await issue(tooltipId, name).getByRole('button', { name: /定位组件/ }).click();
  await page.locator('.tooltip-template-editor').waitFor();
  assert.equal(await page.locator('.tooltip-kind-tabs button.active').innerText(), kindLabel);
  assert.equal(await page.locator('.tooltip-template-row.active').getAttribute('data-tooltip-template-id'), id);
  await expectRedFrame(tooltipFrame(id), '.tooltip-canvas-viewport');
  assert.equal(await page.locator('.tooltip-inspector-tabs button.active').innerText(), '数据来源');
  assert.equal(await page.locator(`.tooltip-layer-row[data-tooltip-layer-id="${tooltipId}"]`).getAttribute('class').then(value => value.includes('active')), true);
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'data-table-browser-ui-server.cjs')], {
    cwd: root, env: { ...process.env, DATA_BROWSER_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') }, logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(helper.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return Boolean(info.origin && info.database); } catch { return false; } }, 60000, 'owned fixture startup');
  requireTestPath(info.database); assert.equal(info.collectorFalse, true);
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Hong_Kong' });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) httpFailures.push({ status: response.status(), url: response.url() }); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1' || url.origin !== info.origin) forbiddenRequests.push(request.url());
    if (/^\/api\/(platform|devices|datapoints)/.test(url.pathname) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click(); await ready();
  const state = await api('/platform/designer');
  sceneId = state.document.sceneId; viewId = state.document.scene.views.find(view => view.mode === 'device')?.id; assert.ok(viewId);
  const { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
  const { createTooltipTemplate } = await import('../shared/tooltipTemplates.mjs');
  const text = createDashboardWidget('text');
  const missing = { mode: 'plc', deviceScope: 'fixed', deviceId: 'DiagnosticMissingDevice', pointId: '987654321',
    pointKey: 'analog.temp', path: 'analog.temp', requireConfiguredPoint: true, readOnly: true, unit: '℃' };
  state.document.canvas = { ...state.document.canvas, width: 1280, height: 1800 };
  state.document.widgets = [
    { ...text, id: ordinaryId, title: '普通文字组件', content: { ...text.content, text: '普通选中保持蓝框' },
      frame: { ...text.frame, x: 220, y: 240, width: 390, height: 90 }, data: { mode: 'static', readOnly: true }, visibility: { ...text.visibility, viewIds: [viewId] } },
    { ...text, id: mainId, title: '隐藏但需定位的问题组件', visible: false, content: { ...text.content, text: '{value} ℃' },
      frame: { ...text.frame, x: 840, y: 1430, width: 350, height: 90 }, data: missing, visibility: { ...text.visibility, viewIds: [viewId], matchBoundDevice: false } }
  ];
  const buildTemplate = (kind, id, name) => {
    const template = createTooltipTemplate(kind, id); template.name = name;
    const source = template.widgets.find(widget => widget.type === 'text');
    template.canvas = { ...template.canvas, width: 960, height: 1080 };
    template.widgets = [
      { ...source, id: tooltipOrdinaryId, title: '普通独立提示文字', frame: { ...source.frame, x: 50, y: 80, width: 300, height: 45 }, content: { ...source.content, text: '普通提示文字' }, data: { mode: 'static', readOnly: true }, dynamicBinding: undefined, dynamicField: undefined },
      { ...source, id: tooltipId, title: kind === 'device' ? '设备模板问题数值' : '部件模板问题数值', frame: { ...source.frame, x: 580, y: 930, width: 300, height: 45 },
        content: { ...source.content, text: '{value} ℃' }, data: { ...missing, deviceScope: 'current', deviceId: '' }, dynamicBinding: undefined, dynamicField: undefined }
    ];
    template.backgroundWidgetId = ''; return template;
  };
  state.document.tooltipTemplates = { templates: [buildTemplate('device', deviceTemplateId, '设备定位验收'), buildTemplate('part', partTemplateId, '部件定位验收')], defaults: { device: deviceTemplateId, part: partTemplateId } };
  for (const view of state.document.scene.views) view.componentState = { ...view.componentState, show: [], hide: [] };
  state.document.scene.defaultViewId = viewId; state.document.metadata = { ...state.document.metadata, unifiedMapDesigner: 1 };
  const saved = await api('/platform/designer/draft', 'PUT', { sceneId, document: state.document, expectedRevision: state.revision });
  assert.ok(saved.warnings.some(message => message.includes(mainId))); assert.ok(saved.warnings.some(message => message.includes(tooltipId)));
  initialState = saved.document; revision = saved.revision; persistedDraftBefore = readPersistedDraft();
  await page.evaluate(({ sceneId, viewId, deviceId }) => localStorage.setItem('dashboard-designer-state:' + sceneId, JSON.stringify({ viewId, editorDeviceId: deviceId, collapsedViewIds: [], zoom: .45, manualZoom: true })), { sceneId, viewId, deviceId: info.devices[0].id });
  await page.reload(); await ready();
  await issue(mainId).waitFor(); await issue(tooltipId, '设备定位验收').waitFor(); await issue(tooltipId, '部件定位验收').waitFor();
  assert.equal(await page.locator('.designer-toolbar .save-button').isDisabled(), true);
  pass('独占fixture草稿包含主画面失效来源及设备/部件提示的同ID嵌套问题，加载后不产生待保存修改');

  await locateMain();
  assert.match(await mainFrame().innerText(), /问题组件|当前隐藏/);
  await screenshot('01-main-hidden-red-dashed-focus');
  await page.locator('.layer-list [data-component-id="' + ordinaryId + '"]').click();
  await mainFrame().waitFor({ state: 'hidden' });
  const blue = await page.locator(`.designer-widget[data-widget-id="${ordinaryId}"]`).evaluate(element => getComputedStyle(element, '::after').borderTopColor);
  assert.equal(blue, 'rgb(67, 185, 255)', 'ordinary main-canvas selection is blue, not a leftover error outline');
  await locateMain(); await locateMain();
  await expectRedFrame(mainFrame(), '.designer-canvas-scroll');
  pass('隐藏问题组件有不透明红色虚线及位置提示并滚入视口；低缩放线宽正确，普通选择保持蓝框，重复跳转生效');

  await locateTooltip(deviceTemplateId, '设备定位验收', '设备提示');
  assert.equal(await mainFrame().count(), 0);
  await screenshot('02-device-tooltip-red-dashed-focus');
  await page.locator(`.tooltip-layer-row[data-tooltip-layer-id="${tooltipOrdinaryId}"]`).click();
  await tooltipFrame(deviceTemplateId).waitFor({ state: 'hidden' });
  const selection = page.locator(`.tooltip-selection-frame[data-tooltip-selection-id="${tooltipOrdinaryId}"]`);
  assert.equal(await selection.evaluate(element => getComputedStyle(element).borderTopColor), 'rgb(81, 191, 255)');
  await locateTooltip(deviceTemplateId, '设备定位验收', '设备提示');
  for (let count = 0; count < 4; count++) await page.locator('.tooltip-local-toolbar').getByRole('button', { name: '−', exact: true }).click();
  assert.match(await page.locator('.tooltip-local-toolbar').innerText(), /50%/);
  await locateTooltip(deviceTemplateId, '设备定位验收', '设备提示');
  await expectRedFrame(tooltipFrame(deviceTemplateId), '.tooltip-canvas-viewport');
  for (let count = 0; count < 5; count++) await page.locator('.tooltip-local-toolbar').getByRole('button', { name: '＋', exact: true }).click();
  assert.match(await page.locator('.tooltip-local-toolbar').innerText(), /175%/);
  await locateTooltip(deviceTemplateId, '设备定位验收', '设备提示');
  for (let count = 0; count < 3; count++) await page.locator('.tooltip-local-toolbar').getByRole('button', { name: '＋', exact: true }).click();
  assert.match(await page.locator('.tooltip-local-toolbar').innerText(), /250%/);
  await locateTooltip(deviceTemplateId, '设备定位验收', '设备提示');
  pass('嵌套设备提示直接切到正确模板和数据来源，内部/外层滚动正确；普通独立元素保持蓝框，50/150/175/250%缩放线宽及重复定位生效');

  await page.locator('.tooltip-kind-tabs').getByRole('button', { name: '部件提示', exact: true }).click();
  await tooltipFrame(deviceTemplateId).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.tooltip-diagnostic-frame').count(), 0);
  await locateTooltip(partTemplateId, '部件定位验收', '部件提示');
  assert.equal(await tooltipFrame(deviceTemplateId).count(), 0);
  await screenshot('03-part-template-owner-specific-focus');
  await locateTooltip(deviceTemplateId, '设备定位验收', '设备提示');
  assert.equal(await tooltipFrame(partTemplateId).count(), 0);
  await locateMain(); assert.equal(await page.locator('.tooltip-template-editor').count(), 0);
  pass('切换提示类型清除旧红框，同ID元素按模板归属定位，不误选另一模板；可从悬停提示返回主画面问题位置');

  const final = await api('/platform/designer');
  // The read route normalizes metadata.updatedAt to its request timestamp;
  // compare every authored field, excluding only this non-persisted read stamp.
  const authoredDocument = document => {
    const copy = JSON.parse(JSON.stringify(document)); delete copy.metadata?.updatedAt; return copy;
  };
  assert.equal(final.revision, revision); assert.deepEqual(authoredDocument(final.document), authoredDocument(initialState));
  assert.deepEqual(readPersistedDraft(), persistedDraftBefore, 'persisted draft bytes and revision remain exactly unchanged');
  assert.equal(await page.locator('.designer-toolbar .save-button').isDisabled(), true);
  assert.deepEqual(writes, []); assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(httpFailures, []); assert.deepEqual(forbiddenRequests, []);
  pass('所有定位操作仅改变瞬时界面：草稿及修订完全不变、无写请求、无浏览器错误、请求均属于隔离loopback');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, writes, pageErrors, consoleErrors, httpFailures, forbiddenRequests, directory, fixtureDatabase: info.database, revision,
    persistedDraftDigest: crypto.createHash('sha256').update(persistedDraftBefore.draft_json).digest('hex'),
    geometryChecks, scope: 'private collector:false SQLite + owned random loopback backend; no installed DB/backend/account/PLC/Unity/user window' }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, screenshots: screenshots.length, directory }));
})().catch(async error => {
  console.error(error.stack); if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, writes, pageErrors, consoleErrors, httpFailures, forbiddenRequests, geometryChecks, directory, fixtureDatabase: info?.database }, null, 2)); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(helper); });
