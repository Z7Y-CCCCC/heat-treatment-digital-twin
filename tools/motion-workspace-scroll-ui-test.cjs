'use strict';
// Owned collector:false fixture only. No physical PLC, Unity or live configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), baseline = process.argv.includes('--baseline');
const readonlyOnly = process.argv.includes('--readonly-only');
const pickerOnly = process.argv.includes('--picker-only');
const emptyPickerCategory = { id: 'qa_empty_motion_category', name: '验收空分类', builtin: false };
const layoutEvidenceFile = process.argv.find(arg => arg.startsWith('--layout-evidence='))?.slice('--layout-evidence='.length);
const prefix = requireTestPath(path.join(root, 'output/playwright', `motion-workspace-scroll-${baseline ? 'baseline-' : ''}${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix), checks = [], audits = [], screenshots = [], errors = [], consoleErrors = [], mutations = [];
const assetRequests = [];
let emptyCategoryResponses = 0;
let server, browser, page, info, points, mainContext, mainPage;
const check = name => { checks.push(name); console.log('PASS ' + name); };
const live = () => page.locator('.animation-link');
const config = () => live().locator('.link-config');
const saveButton = () => live().getByRole('button', { name: '保存并同步', exact: true });
async function snap(name, locator) { const file = path.join(directory, name + '.png'); if (locator) await locator.screenshot({ path: file }); else await page.screenshot({ path: file, fullPage: false }); screenshots.push(file); }
async function api(route, method = 'GET', body, status = 200) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + route, { method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken }, ...(body === undefined ? {} : { data: body }) });
  assert.equal(response.status(), status, await response.text()); return response.json();
}
async function assertNoLivePreview() {
  assert.equal(await live().locator('.link-preview, .motion-link-stage, canvas').count(), 0, 'real-time linkage configuration must not mount a duplicate 3D renderer');
  for (const name of ['跟随采集', '本页试动作']) assert.equal(await live().getByRole('button', { name, exact: true }).count(), 0);
  assert.equal(await live().getByRole('slider', { name: '试动作进度', exact: true }).count(), 0);
  assert.equal(await live().locator('.endpoint-test-controls').count(), 0);
}
async function makePage(width, height, textSize, username = info.username) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  if (pickerOnly) await context.route(/\/api\/data-center\/catalog(?:\?|$)/, async route => {
    // A browser-only empty category fixture, never persisted to any database.
    assert.equal(new URL(route.request().url()).origin, info.origin);
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 200);
    const catalog = await response.json();
    assert.ok(Array.isArray(catalog.categories)); assert.ok(!catalog.categories.some(category => category.id === emptyPickerCategory.id));
    emptyCategoryResponses++;
    await route.fulfill({ response, json: { ...catalog, categories: [...catalog.categories, emptyPickerCategory] } });
  });
  await context.addInitScript(({ factoryId, textSize }) => {
    localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'model-animations', motionWorkspaceMode: 'live' }));
    localStorage.setItem('digital_twin_factory_scope_v1', factoryId);
    if (textSize !== 115) localStorage.setItem('digital_twin_admin_reading_v1', JSON.stringify({ textSize }));
  }, { factoryId: info.factoryId, textSize });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.bringToFront();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => { const url = new URL(request.url()); if (url.origin === info.origin && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method())) mutations.push({ method: request.method(), path: url.pathname }); });
  const requestIndexes = new WeakMap();
  page.on('request', request => { const url = new URL(request.url()); if (/\.(?:glb|gltf|bin|json)$/.test(url.pathname) && /\/(?:assets|uploads)\//.test(url.pathname)) { requestIndexes.set(request, assetRequests.length); assetRequests.push({ username, path: url.pathname, startedAt: Date.now(), finishedAt: null, status: null, failure: null }); } });
  page.on('response', response => { const index = requestIndexes.get(response.request()); if (index != null) assetRequests[index].status = response.status(); });
  page.on('requestfinished', request => { const index = requestIndexes.get(request); if (index != null) assetRequests[index].finishedAt = Date.now(); });
  page.on('requestfailed', request => { const index = requestIndexes.get(request); if (index != null) assetRequests[index].failure = request.failure()?.errorText; });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.getByRole('button', { name: '实时联动', exact: true }).click();
  await live().getByRole('button', { name: /送料小车 · 滚动验收/ }).click();
  await live().locator('.action-list').getByRole('button', { name: /推料伸出 \/ 退回/ }).click();
  await live().locator('.binding-fields').waitFor();
  await waitUntil(async () => (await live().getByLabel('动作驱动数据项', { exact: true }).count()) > 0 || (await live().getByLabel('推料到位数据项', { exact: true }).count()) > 0, 20000, 'ordinary or endpoint data selector ready');
  if (!baseline) await assertNoLivePreview();
  return context;
}
async function wheelColumn(delta) {
  const box = await config().boundingBox();
  const height = page.viewportSize().height;
  await page.mouse.move(box.x + box.width - 12, Math.min(height - 25, box.y + Math.min(box.height - 25, Math.max(35, box.height * .72))));
  await page.mouse.wheel(0, delta); await page.waitForTimeout(250);
}
async function measure(name) {
  return live().evaluate((el, name) => {
    const visible = node => !!node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom, right: r.right }; };
    const config = el.querySelector('.link-config'), content = el.querySelector('.link-content'), heading = el.querySelector('.link-heading');
    const fieldset = config.querySelector('.binding-fields'), tail = fieldset?.lastElementChild;
    return { name, viewport: { width: innerWidth, height: innerHeight }, scale: Number(getComputedStyle(document.documentElement).getPropertyValue('--admin-font-scale')), documentWidth: document.documentElement.scrollWidth,
      workspace: rect(el), heading: rect(heading), content: rect(content), tail: rect(tail), tailVisible: visible(tail),
      column: { ...rect(config), scrollTop: config.scrollTop, clientHeight: config.clientHeight, scrollHeight: config.scrollHeight, overflowY: getComputedStyle(config).overflowY, role: config.getAttribute('role'), label: config.getAttribute('aria-label'), tabIndex: config.tabIndex },
      parents: [...(function* (node) { for (let current = node.parentElement; current; current = current.parentElement) yield current; })(config)].filter(node => node.clientHeight > 0).map(node => ({ className: node.className, ...rect(node), scrollTop: node.scrollTop, overflowY: getComputedStyle(node).overflowY })),
      topControls: [...heading.querySelectorAll('h3,button')].map(node => ({ caption: node.textContent.trim(), ...rect(node) })) };
  }, name);
}
async function audit(name, textSize) {
  const before = await measure(name + '-before');
  await snap(name + '-top');
  for (let attempt = 0; attempt < 4; attempt++) await wheelColumn(1400);
  const bottom = await measure(name + '-bottom'); audits.push({ before, bottom }); await snap(name + '-bottom');
  if (baseline) {
    const reproduced = before.column.scrollHeight > before.column.clientHeight + 2 && Math.abs(bottom.column.scrollTop - before.column.scrollTop) < 2;
    // The old component can also exceed its ancestor's fixed viewport without
    // an internal scroll extent: a second form of the same inaccessible content.
    const clipped = bottom.column.bottom > bottom.viewport.height + 2 && bottom.parents.some(parent => parent.overflowY === 'hidden' && parent.bottom < bottom.column.bottom - 2);
    assert.ok(reproduced || clipped, `expected old clipping/no-wheel regression: ${JSON.stringify({ before, bottom })}`);
    check(name + ': old fixed-viewport/no-column-scroll bug reproduced'); return;
  }
  assert.ok(Math.abs(bottom.scale - textSize / 100) < .001, 'persisted font size must be respected');
  assert.ok(before.documentWidth <= before.viewport.width + 2, 'workspace cannot horizontally overflow the page');
  assert.equal(bottom.column.role, 'region'); assert.ok(bottom.column.label); assert.equal(bottom.column.tabIndex, 0);
  assert.ok(['auto', 'scroll'].includes(bottom.column.overflowY), 'config must be its own keyboard and wheel scrolling region');
  assert.ok(before.column.scrollHeight > before.column.clientHeight + 2, 'long form must produce a real scroll extent');
  assert.ok(bottom.column.scrollTop > before.column.scrollTop + 20, 'real mouse wheel must move the configuration column');
  assert.ok(bottom.column.scrollTop + bottom.column.clientHeight >= bottom.column.scrollHeight - 3, 'last configuration content must be reachable');
  assert.ok(bottom.tailVisible && bottom.tail.bottom <= bottom.column.bottom + 2 && bottom.tail.top >= bottom.column.top - 2, 'last hint/control must be inside the visible configuration column');
  assert.ok(before.workspace.top >= -1 && before.workspace.bottom <= before.viewport.height + 2, 'live workspace must fit its bounded viewport');
  for (const control of before.topControls) assert.ok(control.top >= 0 && control.bottom <= before.viewport.height + 2 && control.width > 1, `heading/save control clipped: ${JSON.stringify(control)}`);
  assert.ok(Math.abs(before.column.width - before.content.width) < 3, 'configuration must use the complete right-side content width');
  for (const key of ['top', 'bottom', 'width', 'height']) assert.ok(Math.abs(before.column[key] - bottom.column[key]) < 2, 'wheel scrolling must not move or resize the bounded configuration region');
  await assertNoLivePreview();
  for (let attempt = 0; attempt < 4; attempt++) await wheelColumn(-1400);
  const top = await measure(name + '-returned-top'); assert.ok(top.column.scrollTop <= 2, 'wheel up must return to action selection and data headings');
  assert.equal(await live().getByLabel('联动采集点位', { exact: true }).count(), 0, 'retired direct-point UI must not remain');
  assert.equal(await live().getByText('兼容旧配置 · 采集点位直连', { exact: true }).count(), 0);
  check(name + ': mouse wheel reaches both ends, title/save stay visible and configuration fills the right side; no preview or retired direct-point editor');
}
async function save() { await saveButton().click(); await live().getByText('已保存，Unity 自动同步', { exact: true }).waitFor(); }
function reuseEvidence(includeFunctional = false) {
  const prior = JSON.parse(fs.readFileSync(requireTestPath(layoutEvidenceFile), 'utf8'));
  assert.equal(prior.realtimePreviewRemoved, true, 'cannot reuse legacy tests which required the now-removed real-time canvas');
  const selectedChecks = prior.checks.filter(name => /^(?:115|200)-(?:1366x768|1440x900): mouse wheel/.test(name) || includeFunctional && /^(?:ordinary typed|two existing BOOL|saved two-feedback)/.test(name));
  assert.equal(selectedChecks.length, includeFunctional ? 7 : 4); assert.equal(prior.audits.length, 4);
  const selectedScreens = prior.screenshots.filter(file => /(?:115|200)-(?:1366x768|1440x900)-(?:top|bottom)\.png$/.test(file) || includeFunctional && /functional-two-feedback-saved\.png$/.test(file));
  assert.equal(selectedScreens.length, includeFunctional ? 9 : 8);
  const buildTime = fs.statSync(path.join(root, 'frontend/dist/index.html')).mtimeMs;
  assert.ok(selectedScreens.every(file => fs.statSync(requireTestPath(file)).mtimeMs >= buildTime), 'passed-stage evidence must postdate the unchanged frontend build');
  checks.push(...selectedChecks); audits.push(...prior.audits); screenshots.push(...selectedScreens);
}
async function checkModeLabels() {
  for (const mode of ['部件动作', '设备联动', '实时联动']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    if (mode === '部件动作') {
      await page.getByLabel('选择动作动画模型', { exact: true }).selectOption('ultrasonic_cleaner_cad');
      await page.locator('.cleaner-process-actions').waitFor();
      assert.ok((await page.locator('.cleaner-process-actions').innerText()).includes('内置部件动作'));
    }
    await page.waitForTimeout(150);
    assert.ok(!(await page.getByTestId('model-animation-page').innerText()).includes('工艺动作'), `${mode} cannot display retired process-action wording`);
  }
  await snap('functional-live-after-mode-checks');
  check('live, part and equipment linkage pages no longer display retired process-action wording');
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], { cwd: root, env: { ...process.env, MANUAL_LAYOUT_DISPLAY_ONLY: 'true', MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return !!info.origin && !!info.database; } catch { return false; } }, 60000, 'complete owned collector:false fixture descriptor');
  requireTestPath(info.database); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const db = new Database(info.database);
  try {
    db.prepare('DELETE FROM data_points').run();
    const builtin = require('../backend/services/builtinModels').getBuiltinModels().find(row => row.id === 'cad_transfer_cart_101300'); assert.ok(builtin);
    const metadata = JSON.parse(builtin.metadata); metadata.inspection = { ...metadata.inspection, enabled: false };
    db.prepare('INSERT OR REPLACE INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)').run(builtin.id, builtin.name, builtin.file_path, JSON.stringify(metadata), 'device', 'model');
    info.modelId = builtin.id; info.deviceId = info.devices[0];
    db.prepare('UPDATE devices SET name=?,model_type=?,model_file=NULL,plc_enabled=0,plc_protocol=?,instance_config=? WHERE id=?').run('送料小车 · 滚动验收', builtin.id, 'S7', JSON.stringify({ inspection: { enabled: false }, animationProfile: 'static', scaleMultiplier: 1 }), info.deviceId);
    db.prepare('UPDATE devices SET name=?,model_type=?,model_file=NULL,plc_enabled=0,instance_config=? WHERE id=?').run('小车 · 独立实例', builtin.id, JSON.stringify({ inspection: { enabled: false }, animationProfile: 'static' }), info.devices[1]);
    info.factoryId = db.prepare('SELECT w.factory_id FROM devices d JOIN lines l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id WHERE d.id=?').get(info.deviceId).factory_id;
    points = {};
    for (const [key, label, type, tag] of [['extended', '推料到位', 'BOOL', 'DB1.DBX0.0'], ['retracted', '退回到位', 'BOOL', 'DB1.DBX0.1'], ['stroke', '行程反馈', 'REAL', 'DB1.DBD4']]) points[key] = String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)').run(info.deviceId, key, label, tag, type, 'mechanisms', key, 1000, 'READ', 'good').lastInsertRowid);
  } finally { db.close(); }
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  if (pickerOnly) {
    const context = await makePage(1440, 1000, 115, info.username), picker = live().locator('.motion-data-picker');
    assert.equal(await picker.locator('input').count(), 0); assert.equal(await picker.getByPlaceholder('搜索中文名称或单位').count(), 0); assert.equal(await picker.locator('select').count(), 3);
    const category = picker.getByLabel('动作数据用途分类', { exact: true }), table = picker.getByLabel('动作数据表', { exact: true }), selected = picker.getByLabel('动作驱动数据项', { exact: true });
    assert.ok(await category.isVisible() && await table.isVisible() && await selected.isVisible()); assert.equal(await live().getByLabel('搜索联动设备', { exact: true }).count(), 1);
    assert.equal(await picker.getByText('全部分类', { exact: true }).count(), 0); assert.equal(await picker.getByText('全部数据表', { exact: true }).count(), 0);
    const optionValues = locator => locator.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean).sort());
    assert.equal(await category.inputValue(), ''); assert.equal(await category.isEnabled(), true);
    assert.equal(await table.isDisabled(), true); assert.equal(await selected.isDisabled(), true);
    assert.deepEqual(await optionValues(table), []); assert.deepEqual(await optionValues(selected), []);
    await snap('drive-data-picker-initial-cascade', picker);
    check('initial picker has no search or all-category/table options; only category is enabled and lower levels contain no fake choices');
    const catalog = await api('/api/data-center/catalog?device_id=' + info.deviceId), animation = await api('/api/devices/' + info.deviceId + '/animations'), ready = new Set(animation.dataItems.filter(item => item.motionReady === true).map(item => item.id));
    const eligible = catalog.items.filter(item => ready.has(item.id) && item.enabled !== false && item.sourceReady !== false && item.objectScope !== 'part' && ['number', 'boolean', 'string'].includes(item.type) && ['runtime', 'plc', 'dataset'].includes(item.binding?.mode));
    const stroke = eligible.find(item => String(item.binding?.pointId) === points.stroke), extended = eligible.find(item => String(item.binding?.pointId) === points.extended), other = eligible.find(item => item.categoryId !== stroke?.categoryId); assert.ok(stroke && extended && other, 'fixture has live points and device-information categories');
    const expectedTables = id => catalog.tables.filter(table => eligible.some(item => item.categoryId === id && item.tableId === table.id)).map(table => table.id).sort();
    const expectedItems = (categoryId, tableId) => eligible.filter(item => item.categoryId === categoryId && item.tableId === tableId).map(item => item.id).sort();
    const initialMutationCount = mutations.length;
    await category.selectOption(stroke.categoryId);
    assert.equal(await table.isEnabled(), true); assert.equal(await table.inputValue(), ''); assert.equal(await selected.isDisabled(), true);
    assert.deepEqual(await optionValues(table), expectedTables(stroke.categoryId)); assert.deepEqual(await optionValues(selected), []);
    await table.selectOption(stroke.tableId); assert.equal(await selected.isEnabled(), true);
    assert.deepEqual(await optionValues(selected), expectedItems(stroke.categoryId, stroke.tableId));
    await category.selectOption(other.categoryId);
    assert.equal(await table.inputValue(), '', 'every category change requires a fresh table selection'); assert.equal(await selected.inputValue(), ''); assert.equal(await selected.isDisabled(), true);
    assert.deepEqual(await optionValues(table), expectedTables(other.categoryId)); assert.deepEqual(await optionValues(selected), []);
    check('category selection exposes only its real tables, fields stay disabled until table selection, and category switching clears the table');
    await category.selectOption(emptyPickerCategory.id);
    assert.equal(await table.inputValue(), ''); assert.equal(await table.isDisabled(), true); assert.equal(await selected.isDisabled(), true);
    assert.deepEqual(await optionValues(table), []); assert.deepEqual(await optionValues(selected), []);
    assert.equal(await table.locator('option').count(), 1); assert.match((await table.locator('option').innerText()).trim(), /暂无.*数据表/);
    assert.match(await picker.getByRole('status').innerText(), /暂无.*数据表/);
    await snap('drive-data-picker-empty-category', picker);
    assert.deepEqual(mutations.slice(initialMutationCount), []); assert.equal(await live().locator('.unsaved').count(), 0);
    check('empty category shows no data tables and disables both lower levels without fake options or configuration writes');
    await category.selectOption(stroke.categoryId); await table.selectOption(stroke.tableId); await selected.selectOption(stroke.id); await live().getByRole('switch', { name: '启用动作联动', exact: true }).check(); await save();
    const saved = await api('/api/devices/' + info.deviceId + '/animations'), binding = saved.config.bindings.find(item => item.actionId === 'clip:feed');
    assert.equal(binding.dataItemId, stroke.id); assert.equal(binding.pointId, points.stroke); assert.equal(binding.enabled, true); assert.equal(binding.trigger.mode, 'range');
    check('selecting a field still persists its live data-item and actual PLC point binding, never a preview-value constant');
    await live().getByRole('button', { name: '重新读取', exact: true }).click();
    await live().locator('.action-list').getByRole('button', { name: /推料伸出 \/ 退回/ }).click();
    await waitUntil(async () => await category.inputValue() === stroke.categoryId && await table.inputValue() === stroke.tableId && await selected.inputValue() === stroke.id, 10000, 'persisted binding restores its owning category and table');
    assert.equal(await table.isEnabled(), true); assert.equal(await selected.isEnabled(), true); assert.deepEqual(await optionValues(selected), expectedItems(stroke.categoryId, stroke.tableId));
    await snap('drive-data-picker-existing-binding', picker);
    check('reloading an existing binding restores the actual owning category, table, and field without a hidden all-table fallback');
    const browseMutationCount = mutations.length;
    const assertBindingUntouched = async label => {
      assert.deepEqual(mutations.slice(browseMutationCount), [], label + ': no write request');
      assert.equal(await live().locator('.unsaved').count(), 0, label + ': no changed local binding'); assert.equal(await saveButton().isDisabled(), true);
      assert.equal((await picker.locator('.motion-source-summary strong').innerText()).trim(), '当前绑定：' + stroke.label, label + ': original bound source summary stays truthful');
      const current = await api('/api/devices/' + info.deviceId + '/animations'); assert.equal(current.revision, saved.revision); assert.deepEqual(current.config, saved.config, label + ': saved binding unchanged');
    };
    await category.selectOption(other.categoryId); assert.equal(await table.inputValue(), ''); assert.equal(await selected.isDisabled(), true);
    await assertBindingUntouched('browsing a different category');
    await table.selectOption(other.tableId); assert.equal(await selected.isEnabled(), true); assert.equal(await selected.inputValue(), '');
    assert.deepEqual(await optionValues(selected), expectedItems(other.categoryId, other.tableId));
    assert.equal(await selected.locator(`option[value="${stroke.id}"]`).count(), 0, 'original bound field must not appear as a fake out-of-table option');
    await assertBindingUntouched('browsing a different table');
    check('browsing category and table filters never changes the existing live binding or introduces out-of-table selected options');
    await table.selectOption(''); assert.equal(await table.inputValue(), ''); assert.equal(await selected.isDisabled(), true); assert.deepEqual(await optionValues(selected), []);
    await assertBindingUntouched('clearing a table filter');
    await category.selectOption(''); assert.equal(await table.inputValue(), ''); assert.equal(await table.isDisabled(), true); assert.equal(await selected.isDisabled(), true);
    assert.deepEqual(await optionValues(table), []); assert.deepEqual(await optionValues(selected), []); await assertBindingUntouched('clearing a category filter');
    await category.selectOption(emptyPickerCategory.id); assert.equal(await table.isDisabled(), true); assert.equal(await selected.isDisabled(), true);
    assert.deepEqual(await optionValues(table), []); assert.deepEqual(await optionValues(selected), []); await assertBindingUntouched('browsing an empty category with an existing binding');
    check('clearing category or table only resets filter UI; both local draft and saved live binding remain unchanged with no API write');
    await category.selectOption(stroke.categoryId); await table.selectOption(stroke.tableId);
    await assertBindingUntouched('returning to the original table before field selection');
    await selected.selectOption(extended.id);
    assert.equal(await selected.inputValue(), extended.id); assert.equal((await picker.locator('.motion-source-summary strong').innerText()).trim(), '当前绑定：' + extended.label);
    assert.equal(await live().locator('.unsaved').count(), 1); assert.equal(await saveButton().isEnabled(), true); assert.deepEqual(mutations.slice(browseMutationCount), []);
    assert.deepEqual((await api('/api/devices/' + info.deviceId + '/animations')).config, saved.config, 'only the local draft changes until explicit save');
    await save();
    const changed = await api('/api/devices/' + info.deviceId + '/animations'), next = changed.config.bindings.find(item => item.actionId === 'clip:feed');
    assert.equal(next.dataItemId, extended.id); assert.equal(next.pointId, points.extended); assert.equal(next.enabled, true); assert.equal(next.trigger.mode, 'condition'); assert.equal(next.trigger.value, true);
    assert.equal(mutations.slice(browseMutationCount).filter(request => request.method === 'PUT' && request.path === '/api/devices/' + info.deviceId + '/animations').length, 1);
    await snap('drive-data-picker-specific-field-saved', picker);
    check('only selecting a concrete field changes the local binding, and explicit save persists its real BOOL source and condition');
    assert.ok(emptyCategoryResponses >= 2); assert.equal(catalog.categories.some(category => category.id === emptyPickerCategory.id), false, 'empty category was response-only, not persisted');
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    const result = { success: true, realtimePreviewRemoved: true, pickerOnly: true, strictCascade: true, checks, screenshots, errors, consoleErrors, mutations, emptyCategoryResponses, emptyCategoryFixture: 'browser-response-only', collectorFalse: true, noUnity: true, noPhysicalPLC: true, fixtureDatabase: info.database, helperPid: server.pid, fixtureBackendPid: info.backendPid, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ success: true, pickerOnly: true, checks: checks.length, directory })); await context.close(); return;
  }
  if (readonlyOnly) {
    const request = await playwright.request.newContext();
    const login = await request.post(info.origin + '/api/admin-auth/login', { headers: { Origin: info.origin, 'X-Admin-Request': '1' }, data: { username: info.username, password: info.password } }); assert.equal(login.status(), 200, await login.text());
    const session = await (await request.get(info.origin + '/api/admin-auth/session')).json(), headers = { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken };
    const catalog = await (await request.get(info.origin + '/api/data-center/catalog?device_id=' + info.deviceId)).json(), source = side => catalog.items.find(item => String(item.binding?.pointId) === points[side]);
    const animations = await (await request.get(info.origin + '/api/devices/' + info.deviceId + '/animations')).json();
    const definition = { actionId: 'clip:feed', enabled: true, pointId: '', dataItemId: '', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1, trigger: { mode: 'endpoints', extended: { dataItemId: source('extended').id }, retracted: { dataItemId: source('retracted').id } } };
    const saved = await request.put(info.origin + '/api/devices/' + info.deviceId + '/animations', { headers, data: { revision: animations.revision, config: { version: 1, staleMs: 5000, bindings: [definition] } } }); assert.equal(saved.status(), 200, await saved.text());
    const user = await request.post(info.origin + '/api/admin-auth/users', { headers, data: { username: 'motion_scroll_reader', password: info.password, role: 'viewer', permissions: { view: true }, pagePermissions: { 'model-animations': { view: true, edit: false } } } }); assert.equal(user.status(), 201, await user.text()); await request.dispose();
    if (layoutEvidenceFile) reuseEvidence(true);
    const context = await makePage(1366, 768, 200, 'motion_scroll_reader');
    assert.equal(await saveButton().isDisabled(), true); assert.equal(await live().getByRole('switch', { name: '启用动作联动', exact: true }).isDisabled(), true); assert.equal(await live().getByLabel('推料到位数据项', { exact: true }).isDisabled(), true); assert.equal(await live().getByLabel('退回到位数据项', { exact: true }).isDisabled(), true);
    const before = await api('/api/devices/' + info.deviceId + '/animations'), denied = await api('/api/devices/' + info.deviceId + '/animations', 'PUT', { revision: before.revision, config: before.config }, 403); assert.ok(denied.error); assert.deepEqual(await api('/api/devices/' + info.deviceId + '/animations'), before);
    await audit('200-1366x768-readonly', 200); await snap('readonly-feedback-ready'); check('real read-only user can scroll and inspect but cannot mutate bindings; backend denies attempted save403'); await context.close();
    const owner = await makePage(1440, 900, 115); await checkModeLabels(); await owner.close();
    assert.deepEqual(errors, []); assert.ok(consoleErrors.every(message => /403/.test(message)), JSON.stringify(consoleErrors));
    const result = { success: true, realtimePreviewRemoved: true, readonlyOnly: true, validationMode: 'owned fixture without a real-time linkage renderer', layoutEvidenceFile: layoutEvidenceFile || null, checks, audits, screenshots, errors, consoleErrors, assetRequests, mutations, collectorFalse: true, noUnity: true, noPhysicalPLC: true, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, helperPid: server.pid, directory }; fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ success: true, checks: checks.length, audits: audits.length, directory })); return;
  }
  if (layoutEvidenceFile) {
    reuseEvidence();
    mainContext = await makePage(1440, 900, 115); mainPage = page;
    console.log('Reusing four verified layout matrices for the unchanged frontend build; continuing only functional, readonly and mode checks.');
  }
  for (const textSize of layoutEvidenceFile ? [] : baseline ? [115] : [115, 200]) for (const [width, height] of baseline ? [[1366, 768]] : [[1366, 768], [1440, 900]]) {
    const context = await makePage(width, height, textSize); await audit(`${textSize}-${width}x${height}`, textSize);
    if (baseline) { await context.close(); break; }
    if (textSize === 115 && width === 1440) { mainContext = context; mainPage = page; } else await context.close();
  }
  if (!baseline) {
    page = mainPage; await page.bringToFront(); const initialPoints = await api('/api/datapoints'), initialPeer = await api('/api/devices/' + info.devices[1] + '/animations');
    const directory = await api('/api/data-center/catalog?device_id=' + info.deviceId), item = key => directory.items.find(row => String(row.binding?.pointId) === points[key]);
    assert.ok(item('stroke') && item('extended') && item('retracted'));
    await live().getByLabel('动作数据用途分类', { exact: true }).selectOption(item('stroke').categoryId);
    await live().getByLabel('动作数据表', { exact: true }).selectOption(item('stroke').tableId);
    await live().getByLabel('动作驱动数据项', { exact: true }).selectOption(item('stroke').id);
    await live().getByRole('switch', { name: '启用动作联动', exact: true }).check();
    await live().getByRole('button', { name: /^条件触发/ }).click();
    await live().getByLabel('动作比较方式', { exact: true }).selectOption('gte'); await live().getByLabel('动作条件比较值', { exact: true }).fill('50'); await save();
    let saved = await api('/api/devices/' + info.deviceId + '/animations'), binding = saved.config.bindings.find(row => row.actionId === 'clip:feed'); assert.equal(binding.dataItemId, item('stroke').id); assert.equal(binding.pointId, points.stroke, 'canonical PLC data-item bindings preserve their actual source point ID'); assert.equal(binding.trigger.mode, 'condition'); assert.equal(binding.trigger.value, 50);
    check('ordinary typed data-center condition binding still persists via explicit save after wheel scrolling');
    await live().getByRole('button', { name: /^到位反馈 · 两个开关量/ }).click();
    await live().getByLabel('推料到位数据项', { exact: true }).selectOption(item('extended').id); assert.equal(await saveButton().isDisabled(), true);
    await live().getByLabel('退回到位数据项', { exact: true }).selectOption(item('retracted').id); await live().getByLabel('动作过渡秒数', { exact: true }).fill('1'); await save();
    saved = await api('/api/devices/' + info.deviceId + '/animations'); binding = saved.config.bindings.find(row => row.actionId === 'clip:feed');
    assert.deepEqual(binding.trigger, { mode: 'endpoints', extended: { dataItemId: item('extended').id }, retracted: { dataItemId: item('retracted').id } }); assert.equal(binding.pointId, ''); assert.ok(!binding.dataItemId);
    assert.deepEqual(await api('/api/datapoints'), initialPoints); assert.deepEqual(await api('/api/devices/' + info.devices[1] + '/animations'), initialPeer);
    await assertNoLivePreview();
    await snap('functional-two-feedback-saved');
    check('two existing BOOL feedback selections still save and reject half-configured pairs; point definitions and peer bindings remain untouched');
    const afterSaveWrites = mutations.length;
    await live().getByRole('button', { name: '运行状况', exact: true }).click(); await live().locator('.health-list').getByText('推料伸出 / 退回', { exact: true }).waitFor();
    await live().getByRole('button', { name: '动作绑定', exact: true }).click(); await assertNoLivePreview();
    assert.deepEqual((await api('/api/devices/' + info.deviceId + '/animations')).config.bindings.find(row => row.actionId === 'clip:feed').trigger, binding.trigger); assert.deepEqual(mutations.slice(afterSaveWrites), []);
    check('saved two-feedback binding and runtime status remain inspectable without preview controls or implicit writes');
    await api('/api/admin-auth/users', 'POST', { username: 'motion_scroll_reader', password: info.password, role: 'viewer', permissions: { view: true }, pagePermissions: { 'model-animations': { view: true, edit: false } } }, 201);
    // Keep the owner and read-only acceptance profiles isolated.
    await mainContext.close(); mainContext = null; mainPage = null;
    const reader = await makePage(1366, 768, 200, 'motion_scroll_reader');
    assert.equal(await saveButton().isDisabled(), true); assert.equal(await live().getByRole('switch', { name: '启用动作联动', exact: true }).isDisabled(), true); assert.equal(await live().getByLabel('推料到位数据项', { exact: true }).isDisabled(), true); assert.equal(await live().getByLabel('退回到位数据项', { exact: true }).isDisabled(), true);
    const response = await api('/api/devices/' + info.deviceId + '/animations', 'PUT', { revision: saved.revision, config: saved.config }, 403); assert.ok(response.error);
    await audit('200-1366x768-readonly', 200); await reader.close(); mainContext = await makePage(1440, 900, 115); mainPage = page;
    check('real read-only user can scroll and inspect but cannot mutate bindings; backend denies attempted save403');
    await checkModeLabels();
    assert.deepEqual(errors, []); assert.ok(consoleErrors.every(message => /403/.test(message)), JSON.stringify(consoleErrors));
  }
  assert.equal(mutations.filter(request => /^\/api\/(?:plc|collector|engine)(?:\/|$)/.test(request.path)).length, 0, 'no physical control APIs touched');
  const result = { success: true, realtimePreviewRemoved: !baseline, baselineBugReproduced: baseline, checks, audits, screenshots, errors, consoleErrors, assetRequests, mutations, directory, layoutEvidenceFile: layoutEvidenceFile || null, readonlyProfile: { role: 'viewer', displayView: true, modelAnimationEdit: false }, collectorFalse: true, noUnity: true, noPhysicalPLC: true, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, helperPid: server.pid };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ success: true, baseline, checks: checks.length, directory }));
})().catch(async error => { console.error(error); if (page && !page.isClosed()) await snap('failure').catch(() => {}); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, baseline, checks, audits, errors, consoleErrors, screenshots, error: error.stack, directory }, null, 2)); process.exitCode = 1; }).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); fs.appendFileSync(path.join(directory, 'run.log'), 'Stopped only owned fixture server process/tree.\n'); });
