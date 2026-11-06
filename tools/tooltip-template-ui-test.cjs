// Owned backend, database and browser fixture: never modifies commissioned data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('tooltip-template-ui');
const checks = [], errors = [];
let server, browser, page, info, upstream;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function api(route, method = 'GET', data) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + '/api' + route, { method,
    headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function hostContext(native, extra) {
  await native.evaluate(payload => { for (const fn of window.ownedHandlers) fn({ data: { type: 'overlay_host_state', visible: true, context: payload } }); },
    { factoryId: 'factory_default', sceneReady: true, viewId: 'factory_overview', viewMode: 'factory', workshopId: '', lineId: '', deviceId: '', hoveredDeviceId: '', deviceHoverPointer: { visible: false }, ...extra });
}
function assertTemplateBackgroundFits(template) {
  assert.ok(template.backgroundWidgetId, 'the template identifies its full-canvas background independently of layer order');
  const background = template.widgets.find(widget => widget.id === template.backgroundWidgetId);
  assert.equal(background?.type, 'container');
  assert.deepEqual({ x: background.frame.x, y: background.frame.y, width: background.frame.width, height: background.frame.height, rotation: background.frame.rotation },
    { x: 0, y: 0, width: template.canvas.width, height: template.canvas.height, rotation: 0 });
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned tooltip backend');
  info = JSON.parse(fs.readFileSync(infoFile));
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1080 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.locator('.dashboard-designer-shell').waitFor();
  await page.getByRole('button', { name: '悬停提示', exact: true }).click();
  const modeStyle = await page.locator('.designer-mode-tabs button.active').evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, weight: getComputedStyle(element).fontWeight }));
  const actionStyle = await page.getByRole('button', { name: '导出模板', exact: true }).evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor, weight: getComputedStyle(element).fontWeight }));
  assert.notEqual(modeStyle.color, actionStyle.color); assert.notEqual(modeStyle.background, actionStyle.background); assert.equal(modeStyle.weight, '600');
  const editor = page.getByRole('region', { name: '悬停提示模板编辑器', exact: true });
  await editor.waitFor();
  const surface = editor.locator('.tooltip-surface-preview');
  await surface.waitFor();
  await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[0]);
  await waitUntil(async () => (await surface.textContent()).includes('现场设备A'), 10000, 'device A preview');
  assert.equal(await editor.locator('.tooltip-element-hitbox').count() > 8, true);
  pass('device tooltip is independently editable basic widgets in local canvas');
  // Metadata/state values remain live and object-linked; they are not fixed copy.
  for (const [key, path] of [['name', 'hover.device.name'], ['status_value', 'hover.device.status'], ['workshop_value', 'hover.device.workshopName'], ['line_value', 'hover.device.lineName']]) {
    await editor.locator(`[data-tooltip-layer-id="tooltip_device_${key}"]`).click();
    await editor.getByRole('button', { name: '内容', exact: true }).click();
    const current = editor.getByLabel('悬停文字当前显示', { exact: true });
    await current.waitFor(); assert.equal(await current.isEditable(), false);
    assert.equal(await editor.getByRole('button', { name: '改为自定义文字', exact: true }).count(), 0);
    await editor.getByRole('button', { name: '数据来源', exact: true }).click();
    const source = editor.getByLabel('悬停元素数据来源', { exact: true });
    assert.equal(await source.inputValue(), 'runtime');
    assert.equal(await source.locator('option[value="static"]').count(), 0);
    assert.equal(await editor.getByLabel('悬停字段', { exact: true }).inputValue(), path);
  }
  await editor.getByRole('button', { name: '内容', exact: true }).click();
  pass('device identity, connection state, workshop and line remain readonly linked values without a fixed-text conversion');
  await editor.locator('[data-tooltip-layer-id="tooltip_device_title"]').click();
  const titleSelection = editor.locator('[data-tooltip-selection-id="tooltip_device_title"]');
  await titleSelection.waitFor({ state: 'visible' });
  assert.equal(await titleSelection.evaluate(element => getComputedStyle(element).borderTopColor), 'rgb(81, 191, 255)');
  assert.equal(await titleSelection.evaluate(element => Number(getComputedStyle(element.parentElement).zIndex) > Number(getComputedStyle(element.closest('.tooltip-small-canvas').querySelector('.tooltip-surface-preview')).zIndex)), true);
  assert.equal(await editor.locator('.tooltip-local-toolbar').getByRole('button', { name: '锁定 / 解锁', exact: true }).count(), 0);
  assert.equal(await editor.locator('.tooltip-local-toolbar').getByRole('button', { name: '删除元素', exact: true }).count(), 0);
  const lockIcon = titleSelection.locator('.tooltip-element-lock'), deleteIcon = titleSelection.locator('.tooltip-element-delete');
  const textBeforeIcon = await surface.textContent();
  await lockIcon.click(); assert.equal(await deleteIcon.isDisabled(), true);
  assert.match(await lockIcon.getAttribute('aria-label'), /^解锁/);
  assert.equal(await surface.textContent(), textBeforeIcon);
  await lockIcon.click(); assert.equal(await deleteIcon.isEnabled(), true);
  const resize = titleSelection.locator('.tooltip-resize-handle'); await resize.waitFor({ state: 'visible' });
  const templateWidth = editor.getByLabel('悬停模板宽度', { exact: true });
  const templateHeight = editor.getByLabel('悬停模板高度', { exact: true });
  const titleCanvasBefore = { width: Number(await templateWidth.inputValue()), height: Number(await templateHeight.inputValue()) };
  const sizeBefore = await titleSelection.boundingBox();
  const handleBefore = await resize.boundingBox();
  await page.mouse.move(handleBefore.x + handleBefore.width / 2, handleBefore.y + handleBefore.height / 2); await page.mouse.down();
  await page.mouse.move(handleBefore.x + handleBefore.width / 2, handleBefore.y + handleBefore.height / 2 + 10); await page.mouse.up();
  assert.ok((await titleSelection.boundingBox()).height > sizeBefore.height);
  assert.deepEqual({ width: Number(await templateWidth.inputValue()), height: Number(await templateHeight.inputValue()) }, titleCanvasBefore,
    'resizing an ordinary text element must not resize the template');
  await editor.locator('[data-tooltip-layer-id="tooltip_device_background"]').click();
  const nameHit = editor.locator('.tooltip-element-hitbox[data-tooltip-widget-id="tooltip_device_name"]'); await nameHit.click();
  await editor.locator('[data-tooltip-selection-id="tooltip_device_name"]').waitFor({ state: 'visible' });
  await editor.getByRole('button', { name: '＋ 文字', exact: true }).click();
  const deleteId = await editor.locator('.tooltip-layer-row.active').getAttribute('data-tooltip-layer-id');
  await editor.locator(`[data-tooltip-selection-id="${deleteId}"] .tooltip-element-delete`).click();
  assert.equal(await editor.locator(`[data-tooltip-layer-id="${deleteId}"]`).count(), 0);
  await editor.locator('[data-tooltip-layer-id="tooltip_device_title"]').click();
  await page.screenshot({ path: path.join(directory, '00-selection-and-element-icons.png') });
  pass('list selection highlights above the card; per-element corner lock/delete icons work without blocking foreground clicks');
  // Exercise the real pointerdown/click sequence, not just direct selection
  // method calls: Ctrl/Meta must toggle once and ordinary dragging must retain
  // the selected set. The existing foreground geometry is restored afterward.
  const selectionIds = ['tooltip_device_title', 'tooltip_device_name', 'tooltip_device_hint'];
  const [selectionA, selectionB, selectionC] = selectionIds;
  const selectionLayer = id => editor.locator(`[data-tooltip-layer-id="${id}"]`);
  const selectionHitbox = id => editor.locator(`.tooltip-element-hitbox[data-tooltip-widget-id="${id}"]`);
  const readSelectionFrames = async () => {
    const frames = {};
    for (const id of selectionIds) frames[id] = await selectionHitbox(id).evaluate(element => ({
      x: parseFloat(element.style.left), y: parseFloat(element.style.top),
      width: parseFloat(element.style.width), height: parseFloat(element.style.height)
    }));
    return frames;
  };
  async function expectSelection(ids, label) {
    const expected = [...ids].sort();
    await waitUntil(async () => JSON.stringify(await editor.locator('.tooltip-selection-frame').evaluateAll(elements => elements.map(element => element.getAttribute('data-tooltip-selection-id')).sort())) === JSON.stringify(expected), 5000, label);
    assert.deepEqual(await editor.locator('.tooltip-layer-row.active').evaluateAll(elements => elements.map(element => element.getAttribute('data-tooltip-layer-id')).sort()), expected);
    assert.match(await editor.locator('.tooltip-canvas-footer').textContent(), new RegExp(`${ids.length}\\s*个已选`));
    for (const id of ids) assert.equal(await editor.locator(`[data-tooltip-selection-id="${id}"]`).evaluate(element => getComputedStyle(element).borderTopColor), 'rgb(81, 191, 255)');
  }
  async function selectionDrag(id, dx, dy, modifier) {
    const target = selectionHitbox(id); await target.scrollIntoViewIfNeeded();
    const bounds = await target.boundingBox(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    if (modifier) await page.keyboard.down(modifier);
    try {
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 4 }); await page.mouse.up();
    } finally { if (modifier) await page.keyboard.up(modifier); }
  }
  const selectionFramesBefore = await readSelectionFrames();
  await selectionLayer(selectionA).click();
  await selectionLayer(selectionB).click({ modifiers: ['Control'] });
  await expectSelection([selectionA, selectionB], 'tooltip layer Ctrl click adds a second highlighted item');
  await selectionLayer(selectionA).click({ modifiers: ['Control'] });
  await expectSelection([selectionB], 'tooltip layer Ctrl click removes the clicked item');
  await selectionLayer(selectionA).click({ modifiers: ['Meta'] });
  await expectSelection([selectionA, selectionB], 'tooltip layer Meta click adds once');
  await selectionLayer(selectionB).click({ modifiers: ['Meta'] });
  await expectSelection([selectionA], 'tooltip layer Meta click removes once');
  await selectionLayer(selectionC).click();
  await expectSelection([selectionC], 'an unmodified unselected tooltip layer replaces the selection');
  await selectionHitbox(selectionA).click();
  await selectionHitbox(selectionB).click({ modifiers: ['Control'] });
  await expectSelection([selectionA, selectionB], 'tooltip canvas Ctrl click selects two items without a second click toggle');
  await selectionHitbox(selectionB).click({ modifiers: ['Control'] });
  await expectSelection([selectionA], 'tooltip canvas Ctrl click deselects once');
  await selectionHitbox(selectionB).click({ modifiers: ['Meta'] });
  await expectSelection([selectionA, selectionB], 'tooltip canvas Meta click adds once');
  await selectionHitbox(selectionB).click({ modifiers: ['Meta'] });
  await expectSelection([selectionA], 'tooltip canvas Meta click removes once');
  await selectionHitbox(selectionC).click();
  await expectSelection([selectionC], 'an unmodified unselected tooltip canvas item replaces the selection');
  assert.deepEqual(await readSelectionFrames(), selectionFramesBefore, 'selection clicks never edit geometry');
  await selectionHitbox(selectionA).click();
  await selectionHitbox(selectionB).click({ modifiers: ['Control'] });
  await selectionDrag(selectionA, 18, 18);
  await expectSelection([selectionA, selectionB], 'ordinary dragging retains the tooltip multi-selection');
  const selectionFramesMoved = await readSelectionFrames();
  const selectionDelta = id => ({ x: selectionFramesMoved[id].x - selectionFramesBefore[id].x, y: selectionFramesMoved[id].y - selectionFramesBefore[id].y });
  assert.deepEqual(selectionDelta(selectionA), selectionDelta(selectionB), 'the two tooltip elements share one movement delta');
  assert.ok(selectionDelta(selectionA).x > 0 && selectionDelta(selectionA).y > 0);
  assert.deepEqual(selectionFramesMoved[selectionC], selectionFramesBefore[selectionC], 'unselected tooltip elements stay in place');
  for (const id of [selectionA, selectionB]) assert.deepEqual([selectionFramesMoved[id].width, selectionFramesMoved[id].height], [selectionFramesBefore[id].width, selectionFramesBefore[id].height]);
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readSelectionFrames()) === JSON.stringify(selectionFramesBefore), 5000, 'one undo restores the complete tooltip group drag');
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readSelectionFrames()) === JSON.stringify(selectionFramesMoved), 5000, 'one redo restores the complete tooltip group drag');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readSelectionFrames()) === JSON.stringify(selectionFramesBefore), 5000, 'restore tooltip foreground geometry before lock regression');
  const selectionALock = editor.locator(`[data-tooltip-selection-id="${selectionA}"] .tooltip-element-lock`);
  await selectionALock.click();
  await selectionDrag(selectionB, 18, 18);
  const lockedSelectionFrames = await readSelectionFrames();
  assert.deepEqual(lockedSelectionFrames[selectionA], selectionFramesBefore[selectionA], 'locked selected tooltip element must not move');
  assert.ok(lockedSelectionFrames[selectionB].x > selectionFramesBefore[selectionB].x && lockedSelectionFrames[selectionB].y > selectionFramesBefore[selectionB].y, 'unlocked selected tooltip element can still move');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readSelectionFrames()) === JSON.stringify(selectionFramesBefore), 5000, 'locked-item drag undo restores only the movable element');
  await selectionALock.click();
  await selectionDrag(selectionA, 18, 18, 'Control');
  await expectSelection([selectionB], 'Ctrl pointerdown cancels the clicked tooltip item even when the pointer continues moving');
  assert.deepEqual(await readSelectionFrames(), selectionFramesBefore, 'a cancelled tooltip item cannot drag the remaining selection');
  await selectionHitbox(selectionA).click({ modifiers: ['Control'] });
  await expectSelection([selectionA, selectionB], 'tooltip selection can be restored after cancellation');
  await editor.screenshot({ path: path.join(directory, '00-tooltip-ctrl-multiselect.png') });
  await selectionLayer(selectionC).click(); await selectionLayer(selectionA).click();
  await expectSelection([selectionA], 'restore the original single tooltip title selection');
  assert.equal(await selectionALock.getAttribute('aria-label'), '锁定悬停元素 提示标题');
  pass('tooltip layer/canvas Ctrl and Meta multi-select toggle once, preserve group drag and undo/redo, skip locked items and never drag after cancellation');
  // The user's full-card background and the dotted template boundary are one
  // size operation, not a numeric-canvas edit followed by a second manual drag.
  // Give this owned page room for outward drags without leaving the viewport.
  await page.setViewportSize({ width: 1680, height: 1400 });
  const backgroundId = 'tooltip_device_background';
  const canvasNode = editor.locator('.tooltip-small-canvas[data-tooltip-canvas="tooltip_device"]');
  const backgroundHitbox = editor.locator(`.tooltip-element-hitbox[data-tooltip-widget-id="${backgroundId}"]`);
  const readTemplateSize = async () => ({ width: Number(await templateWidth.inputValue()), height: Number(await templateHeight.inputValue()) });
  const readBackgroundSize = async () => backgroundHitbox.evaluate(element => ({ width: parseFloat(element.style.width), height: parseFloat(element.style.height), x: parseFloat(element.style.left), y: parseFloat(element.style.top) }));
  const readForegroundFrames = async () => editor.locator(`.tooltip-element-hitbox:not([data-tooltip-widget-id="${backgroundId}"])`).evaluateAll(elements => elements.map(element => ({
    id: element.getAttribute('data-tooltip-widget-id'), x: element.style.left, y: element.style.top,
    width: element.style.width, height: element.style.height, transform: element.style.transform
  })));
  const originalCanvasSize = await readTemplateSize(), foregroundFramesBefore = await readForegroundFrames();
  async function checkBackgroundSize(expected, label) {
    await waitUntil(async () => {
      const size = await readBackgroundSize();
      return size.x === 0 && size.y === 0 && size.width === expected.width && size.height === expected.height;
    }, 5000, label);
    assert.deepEqual(await canvasNode.evaluate(element => ({ width: parseFloat(element.style.width), height: parseFloat(element.style.height) })), expected);
    assert.deepEqual(await readForegroundFrames(), foregroundFramesBefore, 'resizing the template must not move or scale independent text, data fields or dividers');
  }
  await templateHeight.fill(String(originalCanvasSize.height + 40)); await templateHeight.blur();
  await templateWidth.fill(String(originalCanvasSize.width + 24)); await templateWidth.blur();
  const manualCanvasSize = await readTemplateSize();
  assert.deepEqual(manualCanvasSize, { width: originalCanvasSize.width + 24, height: originalCanvasSize.height + 40 });
  await checkBackgroundSize(manualCanvasSize, 'numeric template size immediately resizes its full-card background');
  await editor.locator(`[data-tooltip-layer-id="${backgroundId}"]`).click();
  const backgroundCorner = editor.locator(`[data-tooltip-selection-id="${backgroundId}"] .tooltip-resize-handle`);
  await backgroundCorner.scrollIntoViewIfNeeded();
  const corner = await backgroundCorner.boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 36, corner.y + corner.height / 2 + 60); await page.mouse.up();
  const cornerCanvasSize = await readTemplateSize();
  assert.ok(cornerCanvasSize.width > manualCanvasSize.width && cornerCanvasSize.height > manualCanvasSize.height,
    'background corner drag expands past the old template bounds without a prior numeric edit');
  await checkBackgroundSize(cornerCanvasSize, 'background corner resize updates the dotted canvas boundary');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readTemplateSize()) === JSON.stringify(manualCanvasSize), 5000, 'one undo restores both background and canvas after corner resize');
  await checkBackgroundSize(manualCanvasSize, 'background dimensions undo with the canvas dimensions');
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readTemplateSize()) === JSON.stringify(cornerCanvasSize), 5000, 'one redo restores both corner-resized dimensions');
  await checkBackgroundSize(cornerCanvasSize, 'background dimensions redo with the canvas dimensions');
  // The canvas bottom handle works while a foreground label, not the
  // background, is selected; changing height never changes the canvas width.
  await editor.locator('[data-tooltip-layer-id="tooltip_device_title"]').click();
  const bottomHandle = editor.locator('.tooltip-canvas-resize-handle.s');
  await bottomHandle.waitFor({ state: 'visible' }); await bottomHandle.scrollIntoViewIfNeeded();
  const bottom = await bottomHandle.boundingBox();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2); await page.mouse.down();
  await page.mouse.move(bottom.x + bottom.width / 2, bottom.y + bottom.height / 2 + 36); await page.mouse.up();
  const bottomCanvasSize = await readTemplateSize();
  assert.equal(bottomCanvasSize.width, cornerCanvasSize.width);
  assert.ok(bottomCanvasSize.height > cornerCanvasSize.height, 'the canvas bottom edge adjusts height directly without selecting or manually fitting the background');
  await checkBackgroundSize(bottomCanvasSize, 'bottom-edge height drag updates the background in the same operation');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readTemplateSize()) === JSON.stringify(cornerCanvasSize), 5000, 'bottom-edge resize is a single undoable operation');
  await checkBackgroundSize(cornerCanvasSize, 'bottom-edge undo keeps background and canvas synchronized');
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readTemplateSize()) === JSON.stringify(bottomCanvasSize), 5000, 'bottom-edge resize redo restores the synchronized card');
  await checkBackgroundSize(bottomCanvasSize, 'bottom-edge redo keeps background and canvas synchronized');
  await editor.screenshot({ path: path.join(directory, '00-template-background-size-linked.png') });
  // Restore the fixture dimensions before the existing copy/save/runtime cases.
  await templateWidth.fill(String(originalCanvasSize.width)); await templateWidth.blur();
  await templateHeight.fill(String(originalCanvasSize.height)); await templateHeight.blur();
  await checkBackgroundSize(originalCanvasSize, 'numeric restoration fits the background without a manual follow-up drag');
  await page.setViewportSize({ width: 1680, height: 1080 });
  await editor.locator('[data-tooltip-layer-id="tooltip_device_title"]').click();
  pass('template inputs, background corner and canvas bottom-edge resizing keep the card synchronized without moving independent foreground widgets');
  await editor.getByLabel('悬停元素文字', { exact: true }).fill('设备资料 · 自定义');
  await editor.getByLabel('悬停元素文字', { exact: true }).blur();
  await waitUntil(async () => (await surface.textContent()).includes('设备资料 · 自定义'), 5000, 'custom title preview');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => !(await surface.textContent()).includes('设备资料 · 自定义'), 5000, 'tooltip undo');
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await waitUntil(async () => (await surface.textContent()).includes('设备资料 · 自定义'), 5000, 'tooltip redo');
  await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[1]);
  await waitUntil(async () => (await surface.textContent()).includes('现场设备B') && !(await surface.textContent()).includes('现场设备A'), 5000, 'device B preview');
  pass('per-element text edit, undo/redo and hover sample switching without fixed-device binding');
  await editor.getByRole('button', { name: '＋ 文字', exact: true }).click();
  await editor.getByLabel('悬停元素名称', { exact: true }).fill('自定义数据项');
  await editor.getByLabel('悬停元素名称', { exact: true }).blur();
  await editor.getByRole('button', { name: '数据来源', exact: true }).click();
  await editor.getByLabel('悬停元素数据来源', { exact: true }).selectOption('runtime');
  await editor.getByLabel('悬停字段', { exact: true }).selectOption('hover.device.id');
  await editor.getByLabel('悬停字段', { exact: true }).blur();
  await waitUntil(async () => (await surface.textContent()).includes(info.devices[1]), 5000, 'custom data field');
  await editor.getByLabel('悬停元素数据来源', { exact: true }).selectOption('plc');
  const plcOptions = await editor.getByLabel('悬停采集点位', { exact: true }).locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
  assert.ok(plcOptions.length, 'fixture has PLC points');
  await editor.getByLabel('悬停采集点位', { exact: true }).selectOption(plcOptions[0]);
  await editor.getByRole('button', { name: '样式', exact: true }).click();
  const elementId = await editor.locator('.tooltip-layer-row.active').getAttribute('data-tooltip-layer-id');
  const hitbox = editor.locator(`.tooltip-element-hitbox[data-tooltip-widget-id="${elementId}"]`);
  const before = await hitbox.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 40); await page.mouse.up();
  const after = await hitbox.boundingBox(); assert.ok(after.x > before.x && after.y > before.y);
  await editor.getByRole('button', { name: '复制模板', exact: true }).click();
  await editor.getByLabel('悬停模板名称', { exact: true }).fill('产线专用设备提示');
  await editor.getByLabel('悬停模板名称', { exact: true }).blur();
  const copyId = await editor.locator('.tooltip-template-row.active').getAttribute('data-tooltip-template-id');
  await editor.getByLabel('提示模板应用视角', { exact: true }).selectOption('line_overview');
  await editor.getByLabel('视角提示模板', { exact: true }).selectOption(copyId);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await waitUntil(async () => !(await page.getByRole('button', { name: '保存草稿', exact: true }).isEnabled()), 10000, 'saved tooltip draft');
  let state = await api('/platform/designer');
  const original = state.document.tooltipTemplates.templates.find(item => item.id === 'tooltip_device');
  assertTemplateBackgroundFits(original);
  assertTemplateBackgroundFits(state.document.tooltipTemplates.templates.find(item => item.id === copyId));
  const pointWidget = original.widgets.find(item => item.id === elementId);
  assert.equal(pointWidget.data.deviceScope, 'current'); assert.equal(pointWidget.data.deviceId || '', ''); assert.equal(pointWidget.data.pointId || '', ''); assert.ok(pointWidget.data.pointKey);
  assert.equal(original.widgets.find(item => item.id === 'tooltip_device_line_68').frame.height, 1);
  assert.equal(state.document.scene.views.find(view => view.id === 'line_overview').metadata.tooltipTemplates.device, copyId);
  assert.equal(state.document.tooltipTemplates.defaults.device, 'tooltip_device');
  await page.locator('.dashboard-designer-shell').screenshot({ path: path.join(directory, '01-device-template-editor.png') });
  pass('semantic PLC binding, drag geometry, shared template copy/view reference and save persist');
  // Reproduce the user's save failure without touching any commissioned data:
  // unrelated incomplete main-canvas widgets must not discard tooltip edits.
  const beforeIncomplete = await api('/config');
  const fixturePrefix = 'tooltip_save_incomplete_';
  const incompleteDocument = structuredClone(state.document);
  incompleteDocument.widgets.push(...[1, 2, 3].map(index => ({
    id: fixturePrefix + index, type: 'filter', title: `待配置筛选 ${index}`,
    visible: true, frame: { x: 220 + index * 30, y: 200, width: 300, height: 100 },
    content: { control: 'select', parameterKey: '', options: [] }, data: { mode: 'static', readOnly: true },
    visibility: { viewIds: ['factory_overview'] }
  })), {
    id: fixturePrefix + 'business', type: 'business_summary', title: '待配置业务摘要',
    visible: true, frame: { x: 360, y: 340, width: 480, height: 300 },
    content: { section: 'batches' }, data: { mode: 'business', connectionId: '', readOnly: true },
    visibility: { viewIds: ['factory_overview'] }
  });
  const fixtureSave = await api('/platform/designer/draft', 'PUT', { sceneId: state.document.sceneId, document: incompleteDocument, expectedRevision: state.revision });
  assert.equal(fixtureSave.warnings.length, 4);
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
  await page.getByRole('button', { name: '悬停提示', exact: true }).click(); await editor.waitFor();
  await editor.locator('[data-tooltip-template-id="tooltip_device"].tooltip-template-row').click();
  await editor.locator('[data-tooltip-layer-id="tooltip_device_title"]').click();
  await editor.getByLabel('悬停元素文字', { exact: true }).fill('设备资料 · 自定义（保存回归）');
  await editor.getByLabel('悬停元素文字', { exact: true }).blur();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  const issues = page.getByLabel('组件配置问题', { exact: true });
  await issues.waitFor();
  assert.equal(await issues.locator('li').count(), 4);
  state = await api('/platform/designer');
  for (const item of state.document.tooltipTemplates.templates) assertTemplateBackgroundFits(item);
  assert.equal(state.document.tooltipTemplates.templates.find(item => item.id === 'tooltip_device').widgets.find(item => item.id === 'tooltip_device_title').content.text, '设备资料 · 自定义（保存回归）');
  assert.equal(state.document.widgets.filter(item => item.id.startsWith(fixturePrefix)).length, 4);
  await page.getByRole('button', { name: '保存并发布', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '草稿已保存，尚未发布' }).waitFor();
  assert.equal((await api('/config')).platform.currentRelease.id, beforeIncomplete.platform.currentRelease.id);
  await issues.locator(`li[data-diagnostic-component-id="${fixturePrefix}business"]`).getByRole('button').click();
  await page.locator(`.designer-widget.selected[data-widget-id="${fixturePrefix}business"]`).waitFor();
  assert.equal(await page.locator('.designer-mode-tabs button.active').textContent().then(value => value.trim()), '画面布局');
  await page.getByText('外部业务数据库', { exact: false }).first().waitFor();
  await page.screenshot({ path: path.join(directory, '01-incomplete-draft-saved-and-located.png') });
  // Explicitly remove only our four unconfigured test widgets, then proceed
  // with the existing full publication/runtime checks on this owned fixture.
  state.document.widgets = state.document.widgets.filter(item => !item.id.startsWith(fixturePrefix));
  const completedSave = await api('/platform/designer/draft', 'PUT', { sceneId: state.document.sceneId, document: state.document, expectedRevision: state.revision });
  assert.deepEqual(completedSave.warnings, []);
  pass('incomplete main-canvas bindings save tooltip edits intact, block publication clearly, and locate the selected problem widget');
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
  await page.getByRole('button', { name: '悬停提示', exact: true }).click(); await editor.waitFor();
  await editor.locator(`[data-tooltip-template-id="${copyId}"].tooltip-template-row`).click();
  await waitUntil(async () => (await surface.textContent()).includes('设备资料 · 自定义'), 5000, 'reload template');
  upstream = http.createServer((request, response) => {
    const device = new URL(request.url, 'http://fixture').searchParams.get('device');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ value: device === info.devices[0] ? 101.1 : 202.2 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await api('/data-sources/connections', 'POST', { id: 'tooltip_ui_api', name: 'Tooltip UI fixture', sourceType: 'http_api', baseUrl: `http://127.0.0.1:${upstream.address().port}`, authType: 'none', healthPath: '/', requestTimeoutMs: 1000 });
  await api('/data-sources/datasets', 'POST', { id: 'tooltip_ui_dataset', name: '悬停电量测试', connectionId: 'tooltip_ui_api', source: 'http', enabled: true, refreshMs: 5000,
    request: { method: 'GET', path: '/', parameters: [{ name: 'device', in: 'query', source: 'context', key: 'deviceId', required: true }] },
    columns: [{ name: 'reading', path: 'value', label: '电量', type: 'number', role: 'value', unit: 'kWh' }] });
  await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[0]);
  await editor.getByRole('button', { name: '＋ 文字', exact: true }).click();
  await editor.getByRole('button', { name: '数据来源', exact: true }).click();
  await editor.getByLabel('悬停元素数据来源', { exact: true }).selectOption('dataset');
  await editor.getByLabel('组件数据集', { exact: true }).selectOption('tooltip_ui_dataset');
  await editor.getByLabel('组件数据集字段', { exact: true }).selectOption('reading');
  await editor.getByRole('button', { name: '读取预览', exact: true }).click();
  await waitUntil(async () => (await surface.textContent()).includes('101.1 kWh'), 5000, 'dataset text and unit');
  await new Promise(resolve => setTimeout(resolve, 1500)); // a PLC refresh must not erase the external preview
  assert.match(await surface.textContent(), /101\.1 kWh/);
  await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[1]);
  await waitUntil(async () => !(await surface.textContent()).includes('101.1 kWh'), 5000, 'clear old dataset sample');
  await editor.getByRole('button', { name: '读取预览', exact: true }).click();
  await waitUntil(async () => (await surface.textContent()).includes('202.2 kWh'), 5000, 'dataset receives changed hover device parameter');
  pass('each text can bind an external dataset with hover parameters, units and stable preview');
  await editor.getByRole('button', { name: '部件提示', exact: true }).click();
  await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[0]);
  await waitUntil(async () => (await editor.getByLabel('悬停预览部件', { exact: true }).locator('option').count()) > 1, 15000, 'part sample list');
  const selectedPart = await editor.getByLabel('悬停预览部件', { exact: true }).inputValue();
  assert.ok(selectedPart);
  const partPreviewInspection = await api(`/devices/${info.devices[0]}/inspection`);
  const describedPart = partPreviewInspection.inspection.parts.find(part => typeof part.description === 'string' && part.description.trim());
  assert.ok(describedPart, 'the real fixture has an authored part description, not a placeholder');
  const otherPreviewPart = partPreviewInspection.inspection.parts.find(part => part.id !== describedPart.id && typeof part.description === 'string' && part.description.trim() && part.description !== describedPart.description);
  assert.ok(otherPreviewPart, 'the real fixture has a second target with its own distinct description');
  const partSelector = editor.getByLabel('悬停预览部件', { exact: true });
  await partSelector.selectOption(describedPart.id);
  const descriptionBody = surface.locator('[data-tooltip-widget-id="tooltip_part_description"] .text-widget-body');
  const renderedDescription = async () => (await descriptionBody.locator('p').allTextContents()).join('\n');
  await waitUntil(async () => (await renderedDescription()).includes(describedPart.description.trim()), 5000, 'authored part description preview');
  await editor.locator('[data-tooltip-layer-id="tooltip_part_description"]').click();
  await editor.getByRole('button', { name: '内容', exact: true }).click();
  const descriptionText = editor.getByLabel('悬停元素文字', { exact: true });
  const displayedText = editor.getByLabel('悬停文字当前显示', { exact: true });
  assert.equal(await descriptionText.inputValue(), '{value}');
  await displayedText.waitFor(); assert.equal(await displayedText.isEditable(), false);
  const originalDescriptionText = await renderedDescription();
  await waitUntil(async () => await displayedText.inputValue() === originalDescriptionText, 5000, 'bound text inspector mirrors the selected part paragraph');
  assert.equal(await editor.getByRole('button', { name: '改为自定义文字', exact: true }).count(), 0);
  // A constant display format would also freeze the live source implicitly.
  // It must be rejected and restored, rather than saved as custom prose.
  await descriptionText.fill('不允许把当前部件说明冻结成固定文案'); await descriptionText.blur();
  await waitUntil(async () => await descriptionText.inputValue() === '{value}', 5000, 'constant bound-text format is rejected and restored');
  assert.equal(await renderedDescription(), originalDescriptionText);
  await editor.getByRole('button', { name: '数据来源', exact: true }).click();
  const descriptionSource = editor.getByLabel('悬停元素数据来源', { exact: true });
  assert.equal(await descriptionSource.inputValue(), 'runtime');
  assert.equal(await descriptionSource.locator('option[value="static"]').count(), 0);
  assert.equal(await editor.getByLabel('悬停字段', { exact: true }).inputValue(), 'hover.part.description');
  await editor.getByRole('button', { name: '内容', exact: true }).click();
  await partSelector.selectOption(otherPreviewPart.id);
  await waitUntil(async () => (await surface.locator('[data-tooltip-widget-id="tooltip_part_name"]').textContent()).includes(otherPreviewPart.name), 5000, 'preview another actual part');
  await waitUntil(async () => await renderedDescription() === String(otherPreviewPart.description).split('\n').filter(Boolean).join('\n'), 5000, 'description follows the new selected part instead of frozen preview copy');
  await waitUntil(async () => await displayedText.inputValue() === await renderedDescription(), 5000, 'readonly displayed text updates with the selected part');
  assert.equal((await api(`/devices/${info.devices[0]}/inspection`)).inspection.parts.find(part => part.id === describedPart.id).description, describedPart.description, 'template formatting must not modify source part data');
  await page.locator('.dashboard-designer-shell').screenshot({ path: path.join(directory, '02-linked-part-description-editor.png') });
  pass('part descriptions remain readonly linked values, reject constant formats, and follow the selected part');
  // Only genuine fixed copy, such as a template title, is directly editable.
  await editor.locator('[data-tooltip-layer-id="tooltip_part_title"]').click();
  await editor.getByRole('button', { name: '内容', exact: true }).click();
  const fixedTitle = editor.getByLabel('悬停元素文字', { exact: true });
  assert.equal(await fixedTitle.isEditable(), true);
  assert.equal(await editor.getByLabel('悬停文字当前显示', { exact: true }).count(), 0);
  await fixedTitle.fill('部件资料 · 自定义'); await fixedTitle.blur();
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => await fixedTitle.inputValue() === 'COMPONENT / 部件', 5000, 'undo restores only fixed template copy');
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await waitUntil(async () => await fixedTitle.inputValue() === '部件资料 · 自定义', 5000, 'redo preserves editable fixed copy');
  await editor.getByLabel('提示模板应用视角', { exact: true }).selectOption('device_xray');
  await editor.getByLabel('视角提示模板', { exact: true }).selectOption('disabled');
  await page.getByRole('button', { name: '保存并发布', exact: true }).click();
  await page.getByTestId('designer-publish-notice').waitFor();
  assert.match(await page.getByTestId('designer-publish-notice').textContent(), /成功|发布/);
  state = await api('/platform/designer');
  assert.equal(state.document.scene.views.find(view => view.id === 'device_xray').metadata.tooltipTemplates.part, 'disabled');
  assert.equal(state.document.tooltipTemplates.templates.find(item => item.id === 'tooltip_part').widgets.find(widget => widget.id === 'tooltip_part_title').content.text, '部件资料 · 自定义');
  const savedDescription = state.document.tooltipTemplates.templates.find(item => item.id === 'tooltip_part').widgets.find(widget => widget.id === 'tooltip_part_description');
  assert.equal(savedDescription.content.text, '{value}');
  assert.equal(savedDescription.data.mode, 'runtime');
  assert.equal(savedDescription.data.path, 'hover.part.description');
  assert.equal(state.document.tooltipTemplates.templates.find(item => item.id === 'tooltip_part').widgets.find(widget => widget.id === 'tooltip_part_title').data.mode, 'static');
  for (const [key, path] of [['name', 'hover.device.name'], ['status_value', 'hover.device.status'], ['workshop_value', 'hover.device.workshopName'], ['line_value', 'hover.device.lineName']]) {
    const linked = state.document.tooltipTemplates.templates.find(item => item.id === 'tooltip_device').widgets.find(widget => widget.id === `tooltip_device_${key}`);
    assert.equal(linked.data.mode, 'runtime'); assert.equal(linked.data.path, path); assert.ok(linked.content.text.includes('{value}'));
  }
  await page.locator('.dashboard-designer-shell').screenshot({ path: path.join(directory, '02-part-template-editor.png') });
  pass('part tooltip template and per-view disable share draft/publish lifecycle');
  const native = await context.newPage(); native.on('pageerror', error => errors.push(error.message));
  await native.addInitScript(() => { window.ownedHandlers = []; window.chrome = { webview: { postMessage() {}, addEventListener(name, fn) { if (name === 'message') window.ownedHandlers.push(fn); }, removeEventListener() {} } }; });
  await native.route('**/api/health', async route => { const response = await route.fetch(), body = await response.json(); body.readiness = { ...body.readiness, displayReady: true }; await route.fulfill({ response, json: body }); });
  await native.goto(info.origin + '/overlay?embedded=unity&surface=overlay&scene=1');
  await native.locator('.dashboard-overlay-root').waitFor({ state: 'attached' });
  await hostContext(native, {});
  await native.getByRole('status', { name: '大屏正在加载', exact: true }).waitFor({ state: 'hidden' });
  await hostContext(native, { hoveredDeviceId: info.devices[0], deviceHoverPointer: { visible: true, x: .85, y: .9 } });
  const runtimeCard = native.getByLabel('悬停设备详情', { exact: true });
  await runtimeCard.waitFor(); assert.match(await runtimeCard.textContent(), /设备资料 · 自定义/); assert.match(await runtimeCard.textContent(), /现场设备A/);
  const bounds = await runtimeCard.boundingBox(); assert.ok(bounds.x + bounds.width <= 1680 && bounds.y + bounds.height <= 1080);
  const runtimeBackgroundBounds = await runtimeCard.locator(`[data-tooltip-widget-id="${original.backgroundWidgetId}"]`).boundingBox();
  assert.ok(Math.abs(runtimeBackgroundBounds.width - bounds.width) < 1 && Math.abs(runtimeBackgroundBounds.height - bounds.height) < 1,
    'the published full-card background fits the runtime template boundary');
  await hostContext(native, { hoveredDeviceId: info.devices[1], deviceHoverPointer: { visible: true, x: .5, y: .5 } });
  await waitUntil(async () => (await runtimeCard.textContent()).includes('现场设备B') && !(await runtimeCard.textContent()).includes('现场设备A'), 5000, 'runtime hover switch');
  await hostContext(native, {}); await runtimeCard.waitFor({ state: 'hidden' });
  pass('published runtime uses edited basic widgets, exact hover object, edge avoidance and hides on leave');
  const registered = await api('/devices');
  const hoverDevice = registered.find(device => String(device.id) === info.devices[1]);
  await hostContext(native, { viewId: 'line_overview', viewMode: 'line', lineId: hoverDevice.line_id || '', hoveredDeviceId: info.devices[1], deviceHoverPointer: { visible: true, x: .5, y: .5 } });
  await native.locator(`.tooltip-surface[data-tooltip-template-id="${copyId}"]`).waitFor();
  await waitUntil(async () => (await runtimeCard.textContent()).includes('202.2 kWh'), 10000, 'published nested dataset binds actual hovered device');
  pass('published template dataset queries render hovered-device values, not preview or rotating-device values');
  const inspection = await api(`/devices/${info.devices[0]}/inspection`);
  const part = inspection.inspection.parts.find(item => item.id === describedPart.id);
  const otherPart = inspection.inspection.parts.find(item => item.id === otherPreviewPart.id);
  assert.ok(part && otherPart);
  const partState = { viewId: 'device_detail', viewMode: 'device', deviceId: info.devices[0], inspectionEnabled: true, inspectionStage: 'solid', inspectionHoveredPartId: part.id, inspectionHoverPointer: { visible: true, x: .5, y: .5 }, inspectionParts: [part, otherPart].map(item => ({ ...item, pointIds: item.point_ids || [], pointKeys: item.point_keys || [] })) };
  await hostContext(native, partState);
  const partCard = native.getByLabel('悬停部件详情', { exact: true }); await partCard.waitFor(); assert.match(await partCard.textContent(), /部件资料 · 自定义/);
  const runtimeDescription = partCard.locator('[data-tooltip-widget-id="tooltip_part_description"] .text-widget-body');
  const runtimeDescriptionText = async () => (await runtimeDescription.locator('p').allTextContents()).join('\n');
  await waitUntil(async () => await runtimeDescriptionText() === String(part.description).split('\n').filter(Boolean).join('\n'), 5000, 'runtime description reads actual hovered part');
  await hostContext(native, { ...partState, inspectionHoveredPartId: otherPart.id });
  await waitUntil(async () => await runtimeDescriptionText() === String(otherPart.description).split('\n').filter(Boolean).join('\n'), 5000, 'runtime description follows another hovered part after publication');
  assert.match(await partCard.textContent(), /部件资料 · 自定义/, 'fixed template title is shared while linked data changes');
  await hostContext(native, partState);
  await native.screenshot({ path: path.join(directory, '03-published-part-tooltip.png') });
  await hostContext(native, { ...partState, viewId: 'device_xray', inspectionStage: 'xray' }); await partCard.waitFor({ state: 'hidden' });
  pass('published part tooltip honors shared content and specific view disable');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ checks, errors, screenshotDirectory: directory }, null, 2));
  console.log('REPORT ' + directory);
})().catch(async error => { console.error(error); if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); if (upstream?.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); } });
