// Owned database/browser only. No site draft, account or desktop restart.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('designer-entry-view-ui'), errors = [], checks = [];
let server, browser, page, info;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function api(route, method = 'GET', data) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + '/api' + route, { method,
    headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), 200, await response.text()); return response.json();
}
const nameInput = () => page.getByRole('textbox', { name: '视角名称', exact: true });
async function named(value) { await waitUntil(async () => await nameInput().inputValue().catch(() => '') === value, 15000, 'selected view ' + value); }
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'backend.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned backend'); info = JSON.parse(fs.readFileSync(infoFile));
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1550, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click(); await page.locator('.dashboard-designer-shell').waitFor();
  const state = await api('/platform/designer'), nav = await api('/view-navigation');
  for (const key of Object.keys(nav.config.enabled)) nav.config.enabled[key] = false;
  await api('/view-navigation', 'PUT', { config: nav.config, revision: nav.revision });
  const overview = state.document.scene.views.find(view => view.id === 'factory_overview'); overview.metadata = { ...overview.metadata, hierarchyHidden: true };
  const acknowledged = await api('/platform/designer/draft', 'PUT', { sceneId: state.document.sceneId, document: state.document, expectedRevision: state.revision });
  state.document = acknowledged.document;
  const workshop = state.document.scene.views.find(view => view.id === 'workshop_overview');
  await page.evaluate(scene => localStorage.setItem('dashboard-designer-state:' + scene, JSON.stringify({ viewId: 'map_world', collapsedViewIds: [] })), state.document.sceneId);
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor(); await named(workshop.name);
  assert.equal(await page.getByRole('switch', { name: '启用全部全局视角', exact: true }).getAttribute('aria-checked'), 'false');
  await page.screenshot({ path: path.join(directory, '01-off-global-hidden-local-entry.png') });
  pass('initial entry skips all seven disabled global views and the hidden local default despite a saved map selection');
  await page.locator('[data-global-view-id="map_world"] .global-view-name').click();
  await named(state.document.scene.views.find(view => view.id === 'map_world').name.replace(/^\s*\d{2}\s+/, ''));
  await page.locator('.admin-nav').getByRole('button', { name: '工厂与区域', exact: true }).click();
  await page.locator('.admin-nav').getByRole('button', { name: '组件配置', exact: true }).click();
  await page.locator('.dashboard-designer-shell').waitFor(); await named(workshop.name);
  pass('disabled views remain explicitly editable, but returning from another admin page defaults back to an available view');
  const device = state.document.scene.views.find(view => view.mode === 'device');
  await page.getByRole('tree', { name: '视角层级', exact: true }).locator(`[data-view-id="${device.id}"] .view-tree-select`).click(); await named(device.name);
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor(); await named(device.name);
  pass('an available last selection survives application-style reload instead of being forcibly replaced by map_world');
  const saved = await api('/platform/designer');
  assert.equal(saved.revision, acknowledged.revision, 'navigation alone cannot save a revision');
  // The read-time normalizer stamps response metadata; it is not a draft write.
  delete saved.document.metadata.updatedAt; delete state.document.metadata.updatedAt;
  assert.deepEqual(saved.document, state.document, 'navigation alone cannot save or rewrite the authored draft');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, directory }, null, 2)); console.log(directory);
})().catch(async error => { await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {}); console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
