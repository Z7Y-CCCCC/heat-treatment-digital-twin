// Real pointer/click regression in an owned database and browser only.
// Never connects to a commissioned/installed database or publishes a release.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('designer-multiselect-ui'), checks = [], errors = [];
let server, browser, page, info;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function api(route, method = 'GET', data) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + '/api' + route, { method,
    headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
const ids = ['ctrl_text_a', 'ctrl_text_b', 'ctrl_text_c_locked'];
const [a, b, c] = ids;
const canvasWidget = id => page.locator(`.designer-widget[data-widget-id="${id}"]`);
const layerWidget = id => page.locator(`.layer-list [data-component-id="${id}"]`);
async function readFrames() {
  const frames = {};
  for (const id of ids) frames[id] = await canvasWidget(id).evaluate(element => ({
    x: parseFloat(element.style.left), y: parseFloat(element.style.top),
    width: parseFloat(element.style.width), height: parseFloat(element.style.height)
  }));
  return frames;
}
async function expectSelection(selected, label) {
  const expected = [...selected].sort();
  await waitUntil(async () => JSON.stringify(await page.locator('.designer-widget.selected').evaluateAll(elements => elements.map(element => element.getAttribute('data-widget-id')).sort())) === JSON.stringify(expected), 5000, label);
  assert.deepEqual(await page.locator('.layer-list [data-component-id].active').evaluateAll(elements => elements.map(element => element.getAttribute('data-component-id')).sort()), expected);
  assert.match(await page.locator('.designer-statusbar').textContent(), new RegExp(`${selected.length}\\s*个已选`));
  for (const id of selected) assert.equal(await canvasWidget(id).evaluate(element => getComputedStyle(element, '::after').borderTopColor), 'rgb(67, 185, 255)');
  if (selected.length > 1) assert.equal(await page.locator('.selection-context-count').textContent(), `${selected.length}项`);
}
async function drag(id, dx, dy, modifier) {
  const target = canvasWidget(id); await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox(), x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  if (modifier) await page.keyboard.down(modifier);
  try {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 4 }); await page.mouse.up();
  } finally { if (modifier) await page.keyboard.up(modifier); }
}
async function selectPair() {
  // The empty origin is outside every fixture widget. Clear before choosing
  // A so an ordinary click on an already selected member cannot retain C.
  await page.locator('.designer-canvas-stage').click({ position: { x: 12, y: 12 } });
  await layerWidget(a).click(); await layerWidget(b).click({ modifiers: ['Control'] });
  await expectSelection([a, b], 'select the owned A/B pair');
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned multi-select backend');
  info = JSON.parse(fs.readFileSync(infoFile));
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1400 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.locator('.dashboard-designer-shell').waitFor();
  const state = await api('/platform/designer');
  const { createDashboardWidget } = await import('../frontend/src/runtime/dashboardSchema.js');
  state.document.canvas = { ...state.document.canvas, width: 1280, height: 900 };
  state.document.widgets = ids.map((id, index) => {
    const widget = createDashboardWidget('text', index, { x: index === 1 ? 750 : 260, y: index === 2 ? 550 : 250 });
    return { ...widget, id, title: `多选验收 ${String.fromCharCode(65 + index)}`, groupId: '', locked: index === 2,
      frame: { ...widget.frame, width: 240, height: 90 }, data: { mode: 'static' },
      content: { ...widget.content, text: `独立基础文字 ${String.fromCharCode(65 + index)}`, showTitle: false },
      visibility: { ...widget.visibility, viewIds: ['factory_overview'] } };
  });
  state.document.metadata = { ...state.document.metadata, unifiedMapDesigner: 1 };
  state.document.scene.defaultViewId = 'factory_overview';
  for (const view of state.document.scene.views) view.componentState = { show: view.id === 'factory_overview' ? ids : [], hide: [] };
  await api('/platform/designer/draft', 'PUT', { sceneId: state.document.sceneId, document: state.document, expectedRevision: state.revision });
  // An early tree click during async initial loading can be overwritten by
  // restored map state. Start this owned fixture in its authored local view.
  await page.evaluate(sceneId => localStorage.setItem('dashboard-designer-state:' + sceneId, JSON.stringify({
    viewId: 'factory_overview', collapsedViewIds: [], zoom: 0.4, manualZoom: true
  })), state.document.sceneId);
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
  await page.locator('.designer-loading').waitFor({ state: 'hidden' });
  await page.getByRole('tree', { name: '视角层级', exact: true }).locator('[data-view-id="factory_overview"] .view-tree-select').click();
  await waitUntil(async () => await page.getByRole('textbox', { name: '视角名称', exact: true }).inputValue().catch(() => '') === state.document.scene.views.find(view => view.id === 'factory_overview').name, 10000, 'loaded factory-overview fixture');
  if (await layerWidget(a).count() === 0) await page.locator('.layer-heading').click();
  for (const id of ids) await canvasWidget(id).waitFor({ state: 'visible' });
  // Initial load finishes by fitting the canvas, overriding restored zoom.
  // Use the actual toolbar only after the widgets/load have settled so both
  // selected highlights can be visible simultaneously in the real viewport.
  const zoomLabel = page.locator('.designer-toolbar .zoom-label');
  for (let attempt = 0; attempt < 15 && parseFloat(await zoomLabel.textContent()) > 45; attempt++) {
    await page.locator('.designer-toolbar').getByRole('button', { name: '−', exact: true }).click();
  }
  assert.ok(parseFloat(await zoomLabel.textContent()) <= 45, 'the visual fixture uses a stable small zoom after asynchronous fitting');
  const initialFrames = await readFrames();
  assert.equal(await canvasWidget(c).evaluate(element => element.classList.contains('locked')), true);
  // Both layer and canvas paths run Ctrl and Meta add/remove independently.
  await layerWidget(a).click(); await layerWidget(b).click({ modifiers: ['Control'] });
  await expectSelection([a, b], 'layer Ctrl click selects two highlighted items');
  await layerWidget(a).click({ modifiers: ['Control'] }); await expectSelection([b], 'layer Ctrl click removes the clicked item');
  await layerWidget(a).click({ modifiers: ['Meta'] }); await expectSelection([a, b], 'layer Meta click adds an item');
  await layerWidget(b).click({ modifiers: ['Meta'] }); await expectSelection([a], 'layer Meta click removes an item');
  await layerWidget(c).click(); await expectSelection([c], 'plain click on an unselected layer replaces the selected set');
  assert.deepEqual(await readFrames(), initialFrames);
  pass('layer Ctrl/Meta add and remove highlighted items, count the set, and ordinary unselected clicks replace it without geometry edits');
  await canvasWidget(a).click(); await canvasWidget(b).click({ modifiers: ['Control'] });
  await expectSelection([a, b], 'canvas Ctrl click is not toggled again by its following click event');
  await canvasWidget(b).click({ modifiers: ['Control'] }); await expectSelection([a], 'canvas Ctrl click removes only the clicked item');
  await canvasWidget(b).click({ modifiers: ['Meta'] }); await expectSelection([a, b], 'canvas Meta click adds once');
  await canvasWidget(b).click({ modifiers: ['Meta'] }); await expectSelection([a], 'canvas Meta click removes once');
  await canvasWidget(c).click(); await expectSelection([c], 'plain click on an unselected canvas item replaces selection');
  assert.deepEqual(await readFrames(), initialFrames);
  pass('real canvas pointerdown/click Ctrl and Meta gestures toggle once with two visible highlights and an accurate selected count');
  await selectPair(); await drag(a, 40, 40);
  await expectSelection([a, b], 'ordinary drag retains the selected pair');
  const movedFrames = await readFrames();
  const delta = id => ({ x: movedFrames[id].x - initialFrames[id].x, y: movedFrames[id].y - initialFrames[id].y });
  assert.deepEqual(delta(a), delta(b), 'selected components share one movement delta');
  assert.ok(delta(a).x > 0 && delta(a).y > 0);
  assert.deepEqual(movedFrames[c], initialFrames[c]);
  for (const id of [a, b]) assert.deepEqual([movedFrames[id].width, movedFrames[id].height], [initialFrames[id].width, initialFrames[id].height]);
  const viewportBounds = await page.locator('.designer-canvas-scroll').boundingBox();
  for (const id of [a, b]) {
    const bounds = await canvasWidget(id).boundingBox();
    assert.ok(bounds.x >= viewportBounds.x && bounds.y >= viewportBounds.y
      && bounds.x + bounds.width <= viewportBounds.x + viewportBounds.width
      && bounds.y + bounds.height <= viewportBounds.y + viewportBounds.height,
    `both selected canvas highlights must be simultaneously inside the viewport (${id})`);
  }
  await page.screenshot({ path: path.join(directory, '01-main-canvas-ctrl-multiselect.png') });
  pass('dragging an already selected canvas member moves both components together without resizing them or moving unselected components');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readFrames()) === JSON.stringify(initialFrames), 5000, 'one undo restores both dragged components');
  await page.getByRole('button', { name: '↷', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readFrames()) === JSON.stringify(movedFrames), 5000, 'one redo restores both dragged components');
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readFrames()) === JSON.stringify(initialFrames), 5000, 'restore before locked-item regression');
  pass('a complete multi-component drag is one undo/redo operation');
  await selectPair(); await canvasWidget(c).click({ modifiers: ['Control'] });
  await expectSelection([a, b, c], 'locked components may be included in a selection');
  await drag(b, 40, 40);
  await expectSelection([a, b, c], 'drag retains the locked and unlocked selected set');
  const lockedFrames = await readFrames();
  assert.deepEqual(lockedFrames[c], initialFrames[c], 'the selected locked member must stay fixed');
  assert.ok(lockedFrames[a].x > initialFrames[a].x && lockedFrames[b].x > initialFrames[b].x, 'unlocked members still move');
  assert.deepEqual({ x: lockedFrames[a].x - initialFrames[a].x, y: lockedFrames[a].y - initialFrames[a].y }, { x: lockedFrames[b].x - initialFrames[b].x, y: lockedFrames[b].y - initialFrames[b].y });
  await page.getByRole('button', { name: '↶', exact: true }).click();
  await waitUntil(async () => JSON.stringify(await readFrames()) === JSON.stringify(initialFrames), 5000, 'undo restores only movable selected components');
  assert.equal(await canvasWidget(c).evaluate(element => element.classList.contains('locked')), true);
  pass('a selected locked component stays stationary while the unlocked selected components share a drag');
  await selectPair(); await drag(a, 40, 40, 'Control');
  await expectSelection([b], 'Ctrl pointerdown cancels A even if the pointer continues moving');
  assert.deepEqual(await readFrames(), initialFrames, 'cancelling A cannot accidentally drag remaining B');
  await canvasWidget(a).click({ modifiers: ['Control'] }); await expectSelection([a, b], 'selection still works after the cancelled drag');
  pass('Ctrl cancellation followed by pointer movement never starts a drag on the remaining selection');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, checks, errors, screenshotDirectory: directory }, null, 2));
  console.log('REPORT ' + directory);
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: false, checks, errors, failure: error.stack, screenshotDirectory: directory }, null, 2));
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
