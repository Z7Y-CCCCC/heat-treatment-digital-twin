'use strict';
// Status labels are tested against explicitly authored saved fixture data.
// Draft changes use real UI controls; only explicit saves may mutate this DB.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { startLoadingPortsFixture } = require('./loading-ports-ui-server.cjs');
const { normalizeLineLayout } = require('../backend/utils/spatialLayout');
const root = path.resolve(__dirname, '..'), artifacts = requireTestPath(path.join(root, 'output', 'playwright'));
fs.mkdirSync(artifacts, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifacts, `model-configuration-status-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
const checks = [], screenshots = [], errors = [], consoleErrors = [], writes = [], optionSnapshots = [], selectorMeasurements = [];
const emptyPorts = () => ({ version: 1, inlet: null, outlet: null });
// Keep this UI contract explicit, rather than deriving the oracle from the
// implementation under test. Root confirms these strings before this runs.
const labels = { empty: '未设置', default: '默认布局', layout: '已设置 2 个部件', motion: '已设置 1 项', inlet: '仅进料口', outlet: '仅出料口', both: '双口已设置' };
const optionLabel = (name, status) => `${name} · ${labels[status]}`;
let fixture, browser, page, info, baseline, names, ids;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const clone = value => structuredClone(value);
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value;
function snapshotDB() {
 const db = new Database(requireTestPath(info.database), { readonly: true, fileMustExist: true });
 try { return Object.fromEntries(['models', 'devices', 'data_points', 'lines'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])); }
 finally { db.close(); }
}
const managementWrites = () => writes.filter(row => /^\/api\/(?:models|devices|datapoints|data-points|lines)(?:\/|$)/.test(row.path));
async function snap(name) { await page.mouse.move(260, 80); const file = path.join(directory, name + '.png'); await page.screenshot({ path: file, fullPage: false }); screenshots.push(file); }
async function measureSelector(select, name) {
 const measured = await select.evaluate((element, name) => {
  const style = getComputedStyle(element), rect = element.getBoundingClientRect(), canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  context.font = style.font;
  const selected = element.selectedOptions[0]?.textContent.trim() || '', entries = [...element.options].filter(option => option.value).map(option => ({ value: option.value, text: option.textContent.trim(), textWidth: context.measureText(option.textContent.trim()).width }));
  const availableTextWidth = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 20;
  return { name, selected, selectedTextWidth: context.measureText(selected).width, availableTextWidth, width: rect.width, left: rect.left, right: rect.right, font: style.font, maxWidth: style.maxWidth, longest: entries.sort((a, b) => b.textWidth - a.textWidth).slice(0, 3), viewportWidth: innerWidth };
 }, name);
 selectorMeasurements.push(measured); console.log('SELECTOR ' + JSON.stringify(measured)); return measured;
}
async function options(select, name, expected) {
 const rows = await select.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, text: node.textContent.trim() })).filter(row => row.value));
 optionSnapshots.push({ name, rows });
 assert.equal(new Set(rows.map(row => row.value)).size, rows.length, 'model option values must remain unique IDs');
 const saved = await (await page.request.get(info.origin + '/api/models')).json();
 for (const row of rows) {
  assert.ok(saved.some(model => model.id === row.value), `option value is a real model ID, never a suffixed name: ${row.value}`);
  const pattern = name.startsWith('ports') ? / · (?:未设置|仅进料口|仅出料口|双口已设置|配置异常)$/
   : name.startsWith('layout') ? / · (?:未设置|默认布局|已设置 \d+ 个部件)$/ : / · (?:未设置|已设置 \d+ 项(?:／内置 \d+ 项)?|内置 \d+ 项)$/;
  assert.match(row.text, pattern, `every real model option must include this page's saved configuration status: ${row.text}`);
 }
 for (const [id, state] of Object.entries(expected)) assert.equal(rows.find(row => row.value === id)?.text, optionLabel(names[id], state), `${name} ${id}`);
 return rows;
}
async function expectedOne(select, id, state) { await waitUntil(async () => (await select.locator(`option[value="${id}"]`).innerText()).trim() === optionLabel(names[id], state), 10000, `saved selector status ${id} ${state}`); }
async function nav(label) { const modelNav = page.getByTestId('model-library-nav'); await modelNav.waitFor(); const toggle = modelNav.getByTitle('模型库', { exact: true }); await toggle.waitFor(); if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click(); const button = modelNav.getByRole('button', { name: label, exact: true }); await button.waitFor(); await button.click(); }
async function portsPage() { await nav('模型管理'); await page.getByRole('navigation', { name: '模型库操作步骤' }).getByRole('button', { name: /进出料口/ }).click(); const select = page.getByLabel('选择进出料口模型', { exact: true }); await select.waitFor(); return select; }
async function layoutPage() { await nav('拆解布局'); const select = page.getByLabel('选择拆解布局模型', { exact: true }); await select.waitFor(); return select; }
async function motionPage() { await nav('动作动画'); await page.getByRole('navigation', { name: '动作动画模式' }).getByRole('button', { name: '部件动作', exact: true }).click(); const select = page.getByLabel('选择动作动画模型', { exact: true }); await select.waitFor(); return select; }
async function saveResponse(route, button) { const pending = page.waitForResponse(response => new URL(response.url()).pathname === route && response.request().method() === 'PUT'); await button.click(); const response = await pending; assert.equal(response.status(), 200, await response.text()); await response.finished(); return response.json(); }
(async () => {
 fixture = await startLoadingPortsFixture(); info = fixture.info; requireTestPath(info.database); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
 ids = { draft: info.models[0], configured: info.models[1], inlet: 'status_ui_inlet', outlet: 'status_ui_outlet', retired: 'status_ui_retired' };
 names = { [ids.draft]: '状态验收 · 待设置型号', [ids.configured]: '状态验收 · 全部已设置', [ids.inlet]: '状态验收 · 仅进料口', [ids.outlet]: '状态验收 · 仅出料口', [ids.retired]: '状态验收 · 旧自定义动作' };
 const db = new Database(info.database);
 try {
  const original = db.prepare('SELECT * FROM models WHERE id=?').get(ids.draft), configured = db.prepare('SELECT * FROM models WHERE id=?').get(ids.configured), source = parsed(original.metadata);
  const clean = () => { const meta = clone(source); meta.loadingPorts = emptyPorts(); meta.partBindings = []; delete meta.motionAuthoring; delete meta.disassemblyLayout; meta.inspection.enabled = true; meta.inspection.parts = meta.inspection.parts.slice(0, 2); meta.inspection.parts.forEach(part => { part.explode_offset = [0, 0, 0]; part.explode_rotation = [0, 0, 0]; }); return meta; };
  const a = clean(), b = clean(); b.loadingPorts = clone(parsed(configured.metadata).loadingPorts); b.inspection.parts[0].explode_offset = [.5, 0, 0]; b.disassemblyLayout = { version: 1, configured: true };
  b.partBindings = [{ id: 'status_saved_part', name: '既有部件动作', node_name: b.inspection.parts[0].node_name, source_group: 'analog', source_key: 'qa_feedback', action: 'translate', axis: 'y', input_min: 0, input_max: 1, output_min: 0, output_max: .4, speed_factor: 1, transition_duration: .2 }];
  db.prepare('UPDATE models SET name=?,metadata=? WHERE id=?').run(names[ids.draft], JSON.stringify(a), ids.draft);
  db.prepare('UPDATE models SET name=?,metadata=? WHERE id=?').run(names[ids.configured], JSON.stringify(b), ids.configured);
  for (const [key, kind] of [['inlet', 'inlet'], ['outlet', 'outlet'], ['retired', null]]) {
   const meta = clean(); meta.inspection.parts = []; if (kind) meta.loadingPorts[kind] = clone(parsed(configured.metadata).loadingPorts[kind]);
   if (key === 'retired') meta.motionAuthoring = { version: 1, actions: [{ id: 'user_status_retired', label: '已移除的旧自定义动作', mode: 'position', tracks: [] }] };
   db.prepare('INSERT INTO models(id,name,file_path,metadata,default_scale,placement_level,asset_type) VALUES(?,?,?,?,?,?,?)').run(ids[key], names[ids[key]], original.file_path, JSON.stringify(meta), original.default_scale, 'device', 'model');
  }
  // Canonicalize only this fixture's known legacy lane/rail setup before the
  // strict read-only baseline; otherwise old backend repair is not a UI write.
  const line = db.prepare('SELECT layout_json FROM lines WHERE id=?').get(info.lineId), layout = normalizeLineLayout(line.layout_json);
  db.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(layout), info.lineId);
 } finally { db.close(); }
 baseline = snapshotDB();
 browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
 const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
 await context.addInitScript(({ factoryId }) => { if (!localStorage.getItem('digital_twin_factory_scope_v1')) localStorage.setItem('digital_twin_factory_scope_v1', factoryId); if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'models', modelLibraryStep: 'library' })); }, { factoryId: info.factoryId });
 page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
 page.on('request', request => { const url = new URL(request.url()); if (url.origin === info.origin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname }); });
 await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
 await page.locator(`[data-model-id="${ids.draft}"]`).waitFor(); await page.locator(`[data-model-id="${ids.draft}"]`).locator('td').nth(2).click();
 const expectedPorts = { [ids.draft]: 'empty', [ids.configured]: 'both', [ids.inlet]: 'inlet', [ids.outlet]: 'outlet', [ids.retired]: 'empty' };
 const expectedLayout = { [ids.draft]: 'default', [ids.configured]: 'layout', [ids.inlet]: 'empty', [ids.outlet]: 'empty', [ids.retired]: 'empty' };
 const expectedMotion = { [ids.draft]: 'empty', [ids.configured]: 'motion', [ids.inlet]: 'empty', [ids.outlet]: 'empty', [ids.retired]: 'empty' };
 let select = await portsPage(); await options(select, 'ports-initial', expectedPorts); await select.selectOption(ids.configured); await measureSelector(select, 'ports-selected-configured'); await snap('01b-ports-configured-selector'); await select.selectOption(ids.draft); assert.equal(await select.inputValue(), ids.draft); await snap('01-ports-unconfigured');
 select = await layoutPage(); await options(select, 'layout-initial', expectedLayout); await select.selectOption(ids.configured); await measureSelector(select, 'layout-selected-configured'); await snap('02b-layout-configured-selector'); await select.selectOption(ids.draft); assert.equal(await select.inputValue(), ids.draft); await snap('02-layout-default');
 select = await motionPage(); await options(select, 'motion-initial', expectedMotion); await select.selectOption(ids.configured); await measureSelector(select, 'motion-selected-configured'); await snap('03b-motion-configured-selector'); await select.selectOption(ids.draft); assert.equal(await select.inputValue(), ids.draft); await snap('03-motion-unconfigured');
 assert.deepEqual(managementWrites(), []); assert.deepEqual(snapshotDB(), baseline);
 pass('三个下拉每个模型选项显示本页持久化状态，单进/单出/双口分明，value仍是模型ID；只读浏览不写库');

 select = await portsPage(); await select.selectOption(ids.draft);
 let editor = page.getByRole('region', { name: '进出料口配置', exact: true }); await editor.locator('canvas').waitFor({ timeout: 60000 }); await editor.locator('.preview-overlay').waitFor({ state: 'hidden', timeout: 60000 });
 const advanced = editor.locator('.advanced-panel'); await advanced.locator(':scope > summary').click(); await editor.locator('.node-assistant > summary').click();
 const nodeSelect = editor.getByLabel('选择进出料口辅助节点', { exact: true }); await waitUntil(async () => (await nodeSelect.locator('option[value]:not([value=""])').count()) > 0, 30000, 'real model nodes loaded');
 const nodeId = await nodeSelect.locator('option[value]:not([value=""])').first().getAttribute('value'); await nodeSelect.selectOption(nodeId); await editor.getByRole('button', { name: '取节点底部', exact: true }).click();
 await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).fill('1.35'); await expectedOne(select, ids.draft, 'empty'); assert.deepEqual(managementWrites(), []); assert.deepEqual(snapshotDB(), baseline); await snap('04-port-draft-still-unconfigured');
 await saveResponse(`/api/models/${ids.draft}/loading-ports`, editor.getByRole('button', { name: '保存配置', exact: true })); await expectedOne(select, ids.draft, 'inlet');
 await editor.getByRole('navigation', { name: '选择进出料口', exact: true }).getByRole('button', { name: /^出料口/ }).click(); await editor.getByRole('button', { name: '与进料口同位置', exact: true }).click(); await expectedOne(select, ids.draft, 'inlet'); assert.equal(managementWrites().length, 1);
 await saveResponse(`/api/models/${ids.draft}/loading-ports`, editor.getByRole('button', { name: '保存配置', exact: true })); await expectedOne(select, ids.draft, 'both'); await snap('05-port-both-saved');
 pass('进出料口未保存选点不误标；真实保存后下拉即时从未设置变成单进料口，再变双口');

 select = await layoutPage(); await select.selectOption(ids.draft); editor = page.getByTestId('manual-disassembly-layout'); await editor.locator('canvas').waitFor({ timeout: 60000 }); await editor.locator('.viewport-state').waitFor({ state: 'hidden', timeout: 60000 });
 await editor.getByRole('listbox', { name: '布局部件', exact: true }).getByRole('option').first().click(); await editor.getByLabel('X轴拆解位移', { exact: true }).fill('.45'); await editor.getByLabel('X轴拆解位移', { exact: true }).press('Tab');
 await editor.getByText('有未保存的位置', { exact: true }).waitFor(); await expectedOne(select, ids.draft, 'default'); assert.equal(managementWrites().length, 2); await snap('06-layout-draft-still-default');
 await saveResponse(`/api/models/${ids.draft}/inspection`, editor.getByRole('button', { name: '保存模型布局', exact: true })); await expectedOne(select, ids.draft, 'layout');
 await editor.getByLabel('X轴拆解位移', { exact: true }).fill('0'); await editor.getByLabel('X轴拆解位移', { exact: true }).press('Tab'); await expectedOne(select, ids.draft, 'layout');
 await saveResponse(`/api/models/${ids.draft}/inspection`, editor.getByRole('button', { name: '保存模型布局', exact: true })); await expectedOne(select, ids.draft, 'layout'); await snap('07-layout-zero-position-saved');
 pass('默认拆解布局本地位移草稿不误标，保存后标已设置；显式保存的全零位置仍为已设置');

 select = await motionPage(); await select.selectOption(ids.draft); editor = page.locator('.animation-workspace .model-binding-editor'); await editor.getByRole('button', { name: '新增动作', exact: true }).click();
 const bindingNode = editor.locator('.model-node-picker select'); await waitUntil(async () => (await bindingNode.locator('option[value]:not([value=""])').count()) > 0, 60000, 'real bindable mesh nodes ready');
 const bindingNodePath = await bindingNode.locator('option[value]:not([value=""])').first().getAttribute('value'); await bindingNode.selectOption(bindingNodePath); await editor.getByLabel('绑定名称', { exact: true }).fill('状态验收部件动作'); await editor.getByLabel('点位字段', { exact: true }).fill('qa_status_speed'); await editor.getByRole('button', { name: '加入绑定列表', exact: true }).click();
 await expectedOne(select, ids.draft, 'empty'); assert.equal(managementWrites().length, 4); await snap('08-motion-draft-still-unconfigured');
 await saveResponse(`/api/models/${ids.draft}/bindings`, editor.locator('.model-binding-header').getByRole('button', { name: '保存绑定', exact: true }));
 await page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '保存成功', exact: true }) }).getByRole('button', { name: '确定', exact: true }).click(); await expectedOne(select, ids.draft, 'motion'); await snap('09-motion-saved');
 pass('部件动作加入列表仅为草稿，只有真实保存绑定后模型下拉标为已设置');

 await page.reload(); select = await motionPage(); await options(select, 'motion-after-reload', { ...expectedMotion, [ids.draft]: 'motion' }); await expectedOne(select, ids.draft, 'motion'); await select.selectOption(ids.draft); assert.equal(await select.inputValue(), ids.draft);
 select = await layoutPage(); await options(select, 'layout-after-reload', { ...expectedLayout, [ids.draft]: 'layout' });
 select = await portsPage(); await options(select, 'ports-after-reload', { ...expectedPorts, [ids.draft]: 'both' });
 await page.setViewportSize({ width: 1024, height: 1000 });
 for (const [kind, open] of [['ports', portsPage], ['layout', layoutPage], ['motion', motionPage]]) {
  select = await open();
  const longest = selectorMeasurements.find(item => item.name.startsWith(kind + '-selected')).longest[0]; await select.selectOption(longest.value);
  const metric = await measureSelector(select, kind + '-longest-selected-1024');
  assert.ok(metric.selectedTextWidth <= metric.availableTextWidth + 1, 'selected long model name and saved status must not be truncated: ' + JSON.stringify(metric));
  assert.ok(metric.left >= 0 && metric.right <= 1025); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
  await snap('10-' + kind + '-longest-selected-1024'); await select.click(); await snap('11-' + kind + '-options-open-1024'); await page.keyboard.press('Escape');
 }
 pass('1024窗口最长真实模型名及状态选中项完整显示，原生展开选项可读且不横向溢出');
 const after = snapshotDB(); for (const table of ['devices', 'data_points', 'lines']) assert.deepEqual(after[table], baseline[table], table + ' unchanged');
 for (const before of baseline.models) {
  const current = after.models.find(row => row.id === before.id); if (before.id !== ids.draft) assert.deepEqual(current, before, 'peer model remains byte-identical: ' + before.id);
  else for (const key of Object.keys(before)) if (key !== 'metadata') assert.deepEqual(current[key], before[key], 'selected model unrelated column unchanged: ' + key);
 }
 const beforeMeta = parsed(baseline.models.find(row => row.id === ids.draft).metadata), afterMeta = parsed(after.models.find(row => row.id === ids.draft).metadata);
 for (const key of Object.keys(beforeMeta)) {
  if (key === 'runtime') assert.deepEqual(afterMeta.runtime, { ...beforeMeta.runtime, enableGenericBindings: true }, 'saving the first generic part action only enables its existing runtime flag');
  else if (!['loadingPorts', 'inspection', 'partBindings', 'disassemblyLayout'].includes(key)) assert.deepEqual(afterMeta[key], beforeMeta[key], 'unrelated metadata unchanged: ' + key);
 }
 assert.deepEqual(afterMeta.disassemblyLayout, { version: 1, configured: true }, 'explicit saved zero-position layout has durable provenance');
 assert.ok(afterMeta.inspection.parts.every(part => part.explode_offset.every(value => value === 0)), 'all-zero authored layout must remain configured after reload');
 assert.deepEqual(managementWrites(), [ { method: 'PUT', path: `/api/models/${ids.draft}/loading-ports` }, { method: 'PUT', path: `/api/models/${ids.draft}/loading-ports` }, { method: 'PUT', path: `/api/models/${ids.draft}/inspection` }, { method: 'PUT', path: `/api/models/${ids.draft}/inspection` }, { method: 'PUT', path: `/api/models/${ids.draft}/bindings` } ]);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.assetPath)).digest('hex'), info.assetSha256); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
 pass('刷新后状态持久化，选值仍为原模型ID；仅五次明确保存，其他模型/设备/PLC/点位/布局/GLB不变');
 fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, errors, consoleErrors, writes, optionSnapshots, selectorMeasurements, explicitSaveCount: 5, fixtureDatabase: info.database, backendPid: info.backendPid, noPhysicalPLC: true, noUnity: true, directory }, null, 2)); console.log(JSON.stringify({ success: true, checks: checks.length, directory }));
})().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await snap('failure').catch(() => {}); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, errors, consoleErrors, writes, optionSnapshots, selectorMeasurements, directory }, null, 2)); process.exitCode = 1; }).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(fixture?.backend); });
