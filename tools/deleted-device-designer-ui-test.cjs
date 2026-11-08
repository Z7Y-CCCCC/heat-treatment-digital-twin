// Owned collector:false SQLite + loopback backend only. Never uses the installed
// application, its database/session, physical PLC, Unity, or a user's window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');

const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output', 'playwright', `deleted-device-designer-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix);
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], consoleErrorDetails = [], httpFailures = [], writes = [], responses = [];
const log = path.join(directory, 'run.log');
const removedDeviceId = 'DeletedBindingFurnace03';
const replacementDeviceId = 'RemainingBindingFurnace04';
const chartId = 'cfg_device_trend_Furnace_03';
const textId = 'deleted_binding_draft_text';
const privateTitleId = 'deleted_device_private_title';
const privateValueId = 'deleted_device_private_value';
const initialTitle = '删除设备前的独立说明';
const editedTitle = '仍保留的未保存说明';
const editedText = '移除设备专属内容，不覆盖其他画面编辑';
let server, browser, page, info, sceneId, viewId, removedPointId, replacementPointId, baselineRelease, savedDraft, sameShellOnReentry;

function pass(label) { checks.push(label); console.log('PASS ' + label); fs.appendFileSync(log, 'PASS ' + label + '\n'); }
const shell = () => page.locator('.dashboard-designer-shell');
const chart = () => page.locator(`.designer-widget[data-widget-id="${chartId}"]`);
const diagnosticFrame = () => page.locator(`.designer-diagnostic-frame[data-diagnostic-widget-id="${chartId}"], [data-diagnostic-widget-id="${chartId}"] .designer-diagnostic-frame`);
const layer = id => page.locator(`.layer-list [data-component-id="${id}"]`);
const diagnostic = () => page.locator(`[data-diagnostic-component-id="${chartId}"]`);
const publishButton = () => page.locator('.designer-toolbar .publish-button');
const saveButton = () => page.locator('.designer-toolbar .save-button');
async function api(route, method = 'GET', data, expectedStatus = 200) {
  assert.equal(new URL(info.origin).hostname, '127.0.0.1');
  assert.notEqual(new URL(info.origin).port, '3001', 'never use installed backend');
  const session = await page.request.get(info.origin + '/api/admin-auth/session').then(response => response.json());
  const response = await page.request.fetch(info.origin + '/api' + route, {
    method, headers: { Origin: info.origin, 'X-Factory-ID': info.factoryId, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data })
  });
  assert.equal(response.status(), expectedStatus, await response.text());
  const body = await response.json();
  if (expectedStatus === 200) assert.notEqual(body.success, false, JSON.stringify(body));
  return body;
}
async function designerReady() {
  await shell().waitFor(); await page.locator('.designer-loading').waitFor({ state: 'hidden' });
  await waitUntil(() => publishButton().isDisabled().then(disabled => !disabled), 20000, 'owned designer ready');
}
async function chooseView() {
  await page.getByRole('tree', { name: '视角层级', exact: true }).locator(`[data-view-id="${viewId}"] .view-tree-select`).click();
  await page.locator('.designer-device-picker select').waitFor();
}
async function revealLayers() {
  if (await layer(textId).count() === 0) await page.locator('.layer-heading').click();
  await layer(textId).waitFor();
}
async function locateChart() {
  await diagnostic().first().waitFor();
  await diagnostic().getByRole('button', { name: /定位组件/ }).first().click();
  const advanced = page.locator('.designer-right-panel .data-catalog-advanced');
  await advanced.waitFor();
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click();
  await page.locator('.point-binding-editor').waitFor();
  assert.equal(await chart().getAttribute('class').then(value => value.split(/\s+/).includes('selected')), true);
  assert.equal(await page.locator('.inspector-tabs button.active').innerText(), '数据来源');
  await expectDiagnosticFrame();
}
async function expectDiagnosticFrame() {
  await diagnosticFrame().waitFor({ state: 'visible' });
  await waitUntil(async () => diagnosticFrame().evaluate(element => {
    const scroll = element.closest('.designer-canvas-scroll');
    if (!scroll) return false;
    const viewport = scroll.getBoundingClientRect(), target = element.getBoundingClientRect();
    return target.left >= viewport.left && target.top >= viewport.top
      && target.right <= viewport.right && target.bottom <= viewport.bottom;
  }), 10000, 'red diagnostic target scrolled into the editor viewport');
  const visual = await diagnosticFrame().evaluate(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    const width = parseFloat(style.width), scale = rect.width / width;
    const widget = [...element.closest('.designer-canvas-scroll').querySelectorAll('.designer-widget')]
      .find(item => item.dataset.widgetId === element.dataset.diagnosticWidgetId || item.dataset.widgetId === element.parentElement?.dataset.diagnosticWidgetId);
    const widgetRect = widget?.getBoundingClientRect();
    return { borderStyle: style.borderTopStyle, borderColor: style.borderTopColor,
      screenBorder: parseFloat(style.borderTopWidth) * scale, pointerEvents: style.pointerEvents,
      opacity: style.opacity, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      widgetRect: widgetRect && { left: widgetRect.left, top: widgetRect.top, width: widgetRect.width, height: widgetRect.height } };
  });
  assert.equal(visual.borderStyle, 'dashed', 'diagnostic outline is distinct from the normal solid blue selection');
  const [red, green, blue] = visual.borderColor.match(/\d+(?:\.\d+)?/g).slice(0, 3).map(Number);
  assert.ok(red >= 200 && green <= 110 && blue <= 110, 'problem focus outline is visibly red');
  assert.ok(visual.screenBorder >= 1.9, `low-zoom diagnostic border remains at least 2 screen pixels (${visual.screenBorder})`);
  assert.equal(visual.pointerEvents, 'none', 'diagnostic presentation must not block selection, dragging or binding controls');
  assert.equal(visual.opacity, '1', 'diagnostic outline cannot fade with a hidden component');
  assert.ok(visual.widgetRect, 'owned fixture chart still exists and can be compared to the diagnostic rectangle');
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(visual.rect[key] - visual.widgetRect[key]) <= 3,
    `diagnostic ${key} follows the actual component bounds, not a stale or sibling frame`);
}
async function screenshot(name) {
  await shell().scrollIntoViewIfNeeded();
  const filename = path.join(directory, name + '.png');
  await page.screenshot({ path: filename, fullPage: false }); screenshots.push(filename);
}
async function saveFromUi() {
  const responsePromise = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/platform/designer/draft');
  await saveButton().click(); const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  const saved = await response.json(); responses.push({ kind: 'draft', status: response.status(), revision: saved.revision, warnings: saved.warnings });
  await waitUntil(() => saveButton().isDisabled(), 10000, 'acknowledged draft save');
  return saved;
}
async function currentReleaseId() { return (await api('/platform/designer')).currentRelease?.id || ''; }
async function editIndependentText() {
  await revealLayers(); await layer(textId).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '内容', exact: true }).click();
  await page.getByRole('textbox', { name: '组件标题', exact: true }).fill(editedTitle);
  await page.getByRole('textbox', { name: '文本内容', exact: true }).fill(editedText);
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill('245');
  await page.getByRole('spinbutton', { name: '宽度', exact: true }).fill('410');
  await page.getByRole('spinbutton', { name: '宽度', exact: true }).press('Tab');
  assert.equal(await saveButton().isEnabled(), true);
}
async function expectIndependentEdits(document) {
  const text = document.widgets.find(widget => widget.id === textId); assert.ok(text);
  assert.equal(text.title, editedTitle); assert.equal(text.content.text, editedText);
  assert.equal(text.frame.x, 245); assert.equal(text.frame.width, 410);
  assert.equal(document.widgets.some(widget => [privateTitleId, privateValueId].includes(widget.id)), false, 'private device labels and bindings cannot resurrect after save');
  for (const view of document.scene.views) for (const key of ['show', 'hide']) {
    assert.equal((view.componentState?.[key] || []).some(id => [privateTitleId, privateValueId].includes(id)), false, 'removed private IDs leave no view references');
  }
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'data-table-browser-ui-server.cjs')], {
    cwd: root, env: { ...process.env, DATA_BROWSER_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') }, logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return Boolean(info.origin && info.database); } catch { return false; } }, 60000, 'complete owned collector-free fixture');
  requireTestPath(info.database); assert.equal(info.collectorFalse, true);
  assert.equal(new URL(info.origin).hostname, '127.0.0.1'); assert.notEqual(new URL(info.origin).port, '3001');
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Hong_Kong' });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { consoleErrors.push(message.text()); consoleErrorDetails.push({ message: message.text(), location: message.location() }); } });
  page.on('response', response => { if (response.status() >= 400) httpFailures.push({ status: response.status(), method: response.request().method(), url: response.url() }); });
  page.on('request', request => {
    const url = new URL(request.url()); assert.equal(url.hostname, '127.0.0.1', 'all application requests stay in owned loopback fixture');
    if (/^\/api\/(platform|devices|datapoints)/.test(url.pathname) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname });
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click(); await designerReady();

  const rows = await api('/devices'), prototype = rows.find(device => device.id === info.devices[0].id); assert.ok(prototype?.line_id);
  for (const [id, name, offset] of [[removedDeviceId, '3# 删除绑定验收炉', 0], [replacementDeviceId, '4# 手动重绑验收炉', 20]]) {
    await api('/devices', 'POST', { id, name, line_id: prototype.line_id, model_type: prototype.model_type, plc_enabled: false, plc_protocol: 'S7', pos_x: offset, coordinate_space: 'line_local', instance_config: {} });
    const point = await api('/datapoints', 'POST', { device_id: id, name: 'actual_temp', label: '炉内温度', plc_tag: 'DB1.DBD0', data_type: 'REAL', category: 'analog', unit: '℃', sample_interval_ms: 1000, access_type: 'READ' });
    assert.ok(point.id); if (id === removedDeviceId) removedPointId = String(point.id); else replacementPointId = String(point.id);
  }
  const state = await api('/platform/designer'), { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
  sceneId = state.document.sceneId; viewId = state.document.scene.views.find(view => view.mode === 'device')?.id; assert.ok(viewId);
  const title = createDashboardWidget('text', 0, { x: 220, y: 220 }), trend = createDashboardWidget('hud_chart_dock', 1, { x: 710, y: 235 });
  const privateVisibility = { ...title.visibility, viewIds: [viewId], rules: [{ source: 'context', path: 'deviceId', operator: '==', value: removedDeviceId }] };
  state.document.canvas = { ...state.document.canvas, width: 1280, height: 900 };
  state.document.widgets = [
    { ...title, id: textId, title: initialTitle, content: { ...title.content, text: '独立静态说明', showTitle: false }, data: { mode: 'static', readOnly: true }, frame: { ...title.frame, x: 220, y: 220, width: 390, height: 130 }, visibility: { ...title.visibility, viewIds: [viewId] } },
    // A fixed binding alone does not make this public component device-owned.
    // Its missing source must be diagnosed, not silently removed or rebound.
    { ...trend, id: chartId, title: '共享的固定炉温趋势', content: { ...trend.content, chartType: 'smoothLine', seriesName: '炉内温度', showTitle: true }, frame: { ...trend.frame, x: 710, y: 235, width: 480, height: 280 }, data: { mode: 'plc', deviceScope: 'fixed', deviceId: removedDeviceId, pointId: removedPointId, pointKey: 'analog.actual_temp', path: 'analog.actual_temp', requireConfiguredPoint: true, readOnly: true, unit: '℃' }, visibility: { ...trend.visibility, viewIds: [viewId], matchBoundDevice: false, rules: [] } },
    { ...title, id: privateTitleId, title: '被删除设备的专属标题', content: { ...title.content, text: '3# 炉的专属炉温标题', showTitle: false }, data: { mode: 'static', value: '3# 炉的专属炉温标题' }, frame: { ...title.frame, x: 220, y: 395, width: 250, height: 85 }, visibility: privateVisibility },
    { ...title, id: privateValueId, title: '被删除设备的专属炉温', content: { ...title.content, text: '{value} ℃', showTitle: false }, data: { mode: 'plc', deviceScope: 'fixed', deviceId: removedDeviceId, pointId: removedPointId, pointKey: 'analog.actual_temp', path: 'analog.actual_temp', requireConfiguredPoint: true, readOnly: true, unit: '℃' }, frame: { ...title.frame, x: 475, y: 395, width: 180, height: 85 }, visibility: privateVisibility }
  ];
  for (const view of state.document.scene.views) view.componentState = { ...view.componentState, show: view.id === viewId ? [textId, chartId, privateTitleId, privateValueId] : [], hide: [] };
  state.document.scene.defaultViewId = viewId;
  state.document.metadata = { ...state.document.metadata, unifiedMapDesigner: 1 };
  const initial = await api('/platform/designer/draft', 'PUT', { sceneId, document: state.document, expectedRevision: state.revision });
  assert.deepEqual(initial.warnings, []);
  baselineRelease = (await api('/platform/releases', 'POST', { sceneId, notes: 'Owned deletion regression baseline' })).release; assert.ok(baselineRelease?.id);
  await page.evaluate(({ sceneId, viewId, deviceId }) => localStorage.setItem('dashboard-designer-state:' + sceneId, JSON.stringify({ viewId, editorDeviceId: deviceId, collapsedViewIds: [], zoom: .45, manualZoom: true })), { sceneId, viewId, deviceId: removedDeviceId });
  await page.reload(); await designerReady(); await chooseView();
  await page.locator('.designer-device-picker select').selectOption(removedDeviceId); await revealLayers(); await chart().waitFor({ state: 'visible' });
  await page.locator(`.designer-widget[data-widget-id="${privateTitleId}"]`).waitFor({ state: 'visible' });
  await page.locator(`.designer-widget[data-widget-id="${privateValueId}"]`).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('button', { name: '编辑悬停提示内容与数据来源', exact: true }).count(), 0);
  assert.equal(await page.locator('.designer-mode-tabs').getByRole('button', { name: '悬停提示', exact: true }).count(), 1);
  await screenshot('01-valid-binding-before-device-deletion');
  pass('真实API建立设备专属标题/数值与共享固定绑定，删除前均正常显示且合法发布；重复悬停按钮不存在');

  await editIndependentText();
  const mountedShell = await shell().elementHandle();
  await page.locator('.admin-nav').getByRole('button', { name: '工厂与区域', exact: true }).click();
  const impact = await api(`/devices/${removedDeviceId}/deletion-impact`); assert.equal(impact.name, '3# 删除绑定验收炉');
  const deletion = await api(`/devices/${removedDeviceId}`, 'DELETE', { confirmationName: impact.name });
  const sceneCleanup = deletion.dashboardCleanup?.scenes.find(scene => scene.sceneId === sceneId); assert.ok(sceneCleanup);
  assert.ok(sceneCleanup.removedWidgetIds.includes(privateTitleId)); assert.ok(sceneCleanup.removedWidgetIds.includes(privateValueId));
  assert.equal(sceneCleanup.removedWidgetIds.includes(chartId), false, 'shared fixed source is not ownership evidence');
  assert.equal((await api('/devices')).some(device => device.id === removedDeviceId), false);
  assert.equal((await api('/datapoints')).some(point => String(point.id) === removedPointId), false);
  await page.locator('.admin-nav').getByRole('button', { name: '组件配置', exact: true }).click(); await designerReady();
  // Switching the AdminPanel top-level tab currently remounts the designer,
  // while inner platform subpages hide it. Either lifecycle must retain the
  // user's edits; DOM identity is not itself the persistence requirement.
  sameShellOnReentry = await mountedShell.evaluate(element => element.isConnected);
  assert.equal(await page.locator(`.designer-widget[data-widget-id="${privateTitleId}"]`).count(), 0);
  assert.equal(await page.locator(`.designer-widget[data-widget-id="${privateValueId}"]`).count(), 0);
  assert.equal(await layer(privateTitleId).count(), 0); assert.equal(await layer(privateValueId).count(), 0);
  const cleanedState = await api('/platform/designer');
  const chartAuthoringBeforeFocus = cleanedState.document.widgets.find(widget => widget.id === chartId); assert.ok(chartAuthoringBeforeFocus);
  assert.equal(cleanedState.document.widgets.some(widget => [privateTitleId, privateValueId].includes(widget.id)), false);
  assert.equal(cleanedState.document.scene.views.some(view => view.id === viewId), true, 'generic device view remains reusable');
  await diagnostic().first().waitFor();
  assert.match(await diagnostic().first().innerText(), /已删除|不存在/);
  await revealLayers(); await layer(textId).click();
  await page.locator('.inspector-tabs').getByRole('button', { name: '内容', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '组件标题', exact: true }).inputValue(), editedTitle);
  assert.equal(await page.getByRole('textbox', { name: '文本内容', exact: true }).inputValue(), editedText);
  assert.equal(await page.getByRole('spinbutton', { name: 'X', exact: true }).inputValue(), '245');
  assert.equal(await page.getByRole('spinbutton', { name: '宽度', exact: true }).inputValue(), '410');
  assert.equal(await currentReleaseId(), baselineRelease.id);
  await locateChart();
  await screenshot('02a-problem-component-red-dashed-focus');
  await layer(textId).click();
  await diagnosticFrame().waitFor({ state: 'hidden' });
  assert.equal(await page.locator(`.designer-diagnostic-frame[data-diagnostic-widget-id="${textId}"]`).count(), 0,
    'an ordinary selection never inherits the error focus of a different component');
  await locateChart();
  pass('定位问题组件显示醒目红色虚线并滚动到实际位置，低缩放线宽和指针穿透正确；选择其他组件后清除，重复定位可再次显示');
  const catalogPicker = page.locator('.designer-right-panel .data-catalog-picker');
  await waitUntil(async () => await catalogPicker.getByLabel('数据用途分类', { exact: true }).locator('option').count() > 1
    && await catalogPicker.getByLabel('选择数据表', { exact: true }).locator('option').count() > 1
    && await catalogPicker.getByLabel('选择具体数据', { exact: true }).locator('option').count() > 1, 20000, 'repair catalog remains available despite deleted fixed source');
  assert.equal(await catalogPicker.locator('.catalog-error').count(), 0, 'known deleted preview source must not empty the repair catalog or issue a 404');
  const repairCatalog = await api('/data-center/catalog');
  const replacementItem = repairCatalog.items.find(item => String(item.binding?.pointId) === replacementPointId); assert.ok(replacementItem);
  assert.equal(await catalogPicker.getByLabel('选择具体数据', { exact: true }).locator('option').evaluateAll((options, wanted) => options.some(option => option.value === wanted), replacementItem.id), true);
  const bindingEditor = page.locator('.point-binding-editor');
  assert.match(await bindingEditor.innerText(), /已删除|不存在/);
  assert.equal(await bindingEditor.getByLabel('点位预览设备', { exact: true }).inputValue(), removedDeviceId);
  assert.equal(await bindingEditor.getByLabel('绑定采集点位', { exact: true }).isDisabled(), true);
  assert.equal(await bindingEditor.getByLabel('点位预览设备', { exact: true }).locator(`option[value="${removedDeviceId}"]`).evaluate(option => option.disabled), true);
  assert.equal(await bindingEditor.locator('dl').count(), 0, 'no replacement device or same-name point sample masquerades as the deleted source');
  await screenshot('02-deleted-source-diagnosis-preserves-other-edits');
  pass('正式删除同步清理设备专属标题/数值及其绑定，重进设计器不会复活；共享固定来源单独诊断，其他未保存文字/尺寸保留');

  savedDraft = await saveFromUi();
  await expectIndependentEdits(savedDraft.document);
  const dangling = savedDraft.document.widgets.find(widget => widget.id === chartId); assert.ok(dangling);
  for (const key of ['frame', 'data', 'style', 'visibility']) assert.deepEqual(dangling[key], chartAuthoringBeforeFocus[key],
    `diagnostic focus is transient presentation and cannot alter authored ${key}`);
  assert.equal(dangling.data.mode, 'plc'); assert.equal(dangling.data.deviceId, removedDeviceId); assert.equal(dangling.data.pointId, removedPointId);
  assert.ok(savedDraft.warnings.length > 0); assert.ok(savedDraft.warnings.some(warning => warning.includes(chartId)));
  assert.equal(await currentReleaseId(), baselineRelease.id);
  await screenshot('03-draft-saved-with-explicit-binding-warning');
  pass('已删除设备的专属内容不再写回；共享失效来源及其他修改可保存草稿并返回warning，不重绑/冻结，发布版本未变');

  const releaseWrites = writes.filter(write => write.path === '/api/platform/releases').length;
  await publishButton().click();
  await page.getByTestId('designer-publish-notice').waitFor();
  assert.match(await page.getByTestId('designer-publish-notice').innerText(), /尚未发布|待完善|配置/);
  assert.equal(writes.filter(write => write.path === '/api/platform/releases').length, releaseWrites, 'invalid references cannot create a release');
  assert.equal(await currentReleaseId(), baselineRelease.id);
  await screenshot('04-publication-stopped-with-draft-retained');
  pass('保存并发布对失效来源友好阻止，仅保留草稿，没有向release接口提交无效版本');

  // The repair is an explicit user choice, never an automatic same-role fallback.
  await locateChart();
  await bindingEditor.getByLabel('点位预览设备', { exact: true }).selectOption(replacementDeviceId);
  await bindingEditor.getByLabel('绑定采集点位', { exact: true }).selectOption(replacementPointId);
  const repaired = await saveFromUi(); await expectIndependentEdits(repaired.document);
  const rebound = repaired.document.widgets.find(widget => widget.id === chartId);
  assert.equal(rebound.data.deviceId, replacementDeviceId); assert.equal(rebound.data.pointId, replacementPointId); assert.equal(rebound.data.mode, 'plc');
  assert.deepEqual(repaired.warnings, []);
  await diagnosticFrame().waitFor({ state: 'hidden' });
  const publishedPromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/platform/releases');
  await publishButton().click(); const publishedResponse = await publishedPromise; assert.equal(publishedResponse.status(), 200, await publishedResponse.text());
  const published = await publishedResponse.json(); assert.notEqual(published.release.id, baselineRelease.id);
  await page.getByTestId('designer-publish-notice').filter({ hasText: '保存并发布成功' }).waitFor();
  await expectIndependentEdits(published.document);
  await screenshot('05-explicit-point-rebinding-publishes-successfully');
  pass('手动选择另一台真实设备及READ点位后才能发布成功，原独立文字/布局仍保留，动态PLC绑定没有变成常量');

  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  pass('全程独占loopback/SQLite fixture，无用户窗口、现场数据或浏览器错误');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, pageErrors, consoleErrors, consoleErrorDetails, httpFailures, writes, responses, sameShellOnReentry, directory, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, helperPid: server.pid, baselineReleaseId: baselineRelease.id, removedDeviceId, removedPointId, replacementDeviceId, replacementPointId, scope: 'private collector:false SQLite + owned loopback APIs; no installed backend/DB/account/session/PLC/Unity/user window' }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, screenshots: screenshots.length, directory }));
})().catch(async error => {
  console.error(error.stack); fs.appendFileSync(log, 'FAIL ' + error.stack + '\n');
  if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, pageErrors, consoleErrors, consoleErrorDetails, httpFailures, writes, responses, directory, fixtureDatabase: info?.database }, null, 2));
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); fs.appendFileSync(log, 'Stopped only the owned fixture helper/backend/source process tree.\n'); });
