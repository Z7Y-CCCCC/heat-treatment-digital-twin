// Focused real-browser acceptance on our own collector-free SQLite sandbox.
// Never opens or edits the operator's database, PLC, Unity or scene.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), artifactRoot = requireTestPath(path.join(root, 'output', 'playwright'));
fs.mkdirSync(artifactRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifactRoot, `model-library-cleanup-ui-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
const checks = [], screenshots = [], errors = [], consoleErrors = [], writes = [];
let server, browser, page, info;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function screenshot(name) {
  const file = path.join(directory, name + '.png');
  await page.screenshot({ path: file, fullPage: false }); screenshots.push(file);
}
function readFixtureRows() {
  const db = new Database(requireTestPath(info.database), { readonly: true });
  try { return { models: db.prepare('SELECT * FROM models ORDER BY id').all(), devices: db.prepare('SELECT * FROM devices ORDER BY id').all() }; }
  finally { db.close(); }
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: root, env: { ...process.env, MANUAL_LAYOUT_DISPLAY_ONLY: 'true', MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned collector-free model fixture');
  info = JSON.parse(fs.readFileSync(infoFile)); requireTestPath(info.database);
  assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  // A real authored variant, not merely a second label for the same asset:
  // scale is deliberately different and must survive any exact deduplication.
  const fixture = new Database(info.database);
  try { fixture.prepare('UPDATE models SET default_scale=? WHERE id=?').run(1.25, info.models[1]); }
  finally { fixture.close(); }
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'models', modelLibraryStep: 'library' })));
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname }); });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  const table = page.locator('.model-table'), steps = page.getByRole('navigation', { name: '模型库操作步骤' });
  await table.locator('tbody tr').first().waitFor(); await steps.waitFor();
  const baseline = readFixtureRows(), writeFence = writes.length;
  const models = await (await page.request.get(info.origin + '/api/models')).json();
  assert.ok(Array.isArray(models) && models.length);
  assert.equal(await table.getByRole('button', { name: '进出料口', exact: true }).count(), 0);
  assert.equal(await table.locator('[data-model-id] button').filter({ hasText: '进出料口' }).count(), 0);
  assert.equal(await steps.getByRole('button', { name: /进出料口/ }).count(), 1);
  assert.equal(await table.getByRole('columnheader', { name: '操作', exact: true }).count(), 1);
  pass('模型表操作列不再重复显示进出料口按钮；独立配置步骤保留');
  await table.scrollIntoViewIfNeeded(); await screenshot('01-model-table-clean-actions');
  const tableScroll = page.locator('.model-table-scroll');
  await tableScroll.evaluate(element => { element.scrollLeft = element.scrollWidth - element.clientWidth; });
  const operationHeader = table.getByRole('columnheader', { name: '操作', exact: true });
  const operationBounds = await operationHeader.boundingBox(), scrollBounds = await tableScroll.boundingBox();
  assert.ok(operationBounds.x >= scrollBounds.x && operationBounds.x + operationBounds.width <= scrollBounds.x + scrollBounds.width + 2, 'operation column is visible for evidence');
  await screenshot('01b-model-table-operation-actions');
  await tableScroll.evaluate(element => { element.scrollLeft = 0; });

  for (const id of info.models) assert.ok(models.some(model => model.id === id), `fixture model ${id} remains individually addressable`);
  assert.equal(Number(models.find(model => model.id === info.models[1]).default_scale), 1.25);
  const removed = String(process.env.MODEL_LIBRARY_QA_REMOVED_IDS || '').split(',').filter(Boolean);
  for (const id of removed) { assert.ok(!models.some(model => model.id === id), `${id} not present in active library`); assert.equal(await table.locator(`[data-model-id="${id}"]`).count(), 0); }
  assert.equal(new Set(models.map(model => model.id)).size, models.length);
  pass('模型 ID 唯一；未请求清理的测试模型和各自配置未被误删');

  const row = table.locator(`[data-model-id="${info.models[0]}"]`);
  await row.locator('td').nth(2).click();
  await steps.getByRole('button', { name: /进出料口/ }).click();
  const selector = page.getByLabel('选择进出料口模型', { exact: true }); await selector.waitFor();
  await selector.selectOption(info.models[0]);
  const editor = page.getByRole('region', { name: '进出料口配置', exact: true });
  await editor.locator('canvas').waitFor({ timeout: 60000 }); await editor.locator('.preview-overlay').waitFor({ state: 'hidden', timeout: 60000 });
  await editor.locator('.point-summary, .base-missing').waitFor();
  assert.equal(await editor.getByRole('navigation', { name: '选择进出料口', exact: true }).getByRole('button').count(), 2);
  assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  await screenshot('02-dedicated-ports-editor');
  pass('仍可从独立进出料口步骤选择模型并正常查看三维预览，不自动设点或保存');
  await steps.getByRole('button', { name: /模型资产/ }).click(); await table.waitFor({ state: 'visible' });
  assert.equal(await table.getByRole('button', { name: '进出料口', exact: true }).count(), 0);
  assert.deepEqual(readFixtureRows(), baseline);
  const mutations = writes.slice(writeFence).filter(request => !['/api/admin-auth/touch','/api/native-preview'].includes(request.path));
  assert.deepEqual(mutations, []); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  pass('往返模型资产／进出料口不写模型、设备或点位，页面无错误');
  const result = { success: true, checks, screenshots, errors, consoleErrors, writes, directory, collectorFalse: true, fixtureDatabase: info.database, backendPid: info.backendPid, helperPid: server.pid, removedIds: removed };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, directory }));
})().catch(async error => {
  console.error(error.stack); if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, errors, consoleErrors, writes, directory, fixtureDatabase: info?.database }, null, 2)); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
