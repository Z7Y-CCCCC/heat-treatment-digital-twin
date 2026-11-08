// Read-only UI acceptance in an owned collector:false SQLite + loopback fixture.
// Never operates the installed application, real data, PLC, Unity or user window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');

const root = path.resolve(__dirname, '..');
const artifactRoot = requireTestPath(path.join(root, 'output', 'playwright'));
fs.mkdirSync(artifactRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifactRoot, `data-center-heading-motion-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], dataWrites = [];
let helper, browser, page, info;
const sections = [['tables', '数据表'], ['sources', '数据源'], ['mapping', '点位映射'], ['monitor', '点位监视'], ['alarms', '报警配置']];

function pass(label) { checks.push(label); console.log('PASS ' + label); }
async function screenshot(name) {
  const filename = path.join(directory, name + '.png');
  await page.screenshot({ path: filename, fullPage: false }); screenshots.push(filename);
}
async function section(key, label, index) {
  const button = page.locator(`#data-center-submenu [data-data-center-section="${key}"]`);
  await button.click();
  const workspace = page.getByTestId('data-center-workspace');
  await workspace.waitFor();
  await page.locator(`#data-center-panel-${key}`).waitFor();
  await waitUntil(async () => await button.getAttribute('aria-current') === 'page', 10000, 'correct active section');
  assert.equal(await page.locator('#data-center-submenu [aria-current="page"]').count(), 1);
  assert.equal(await workspace.locator('.center-heading').count(), 0);
  assert.equal(await workspace.locator('.center-nav').count(), 0);
  if (key === 'tables') await waitUntil(async () => await workspace.locator('.catalog-layout').getAttribute('aria-busy') === 'false', 20000, 'owned data catalog');
  if (key === 'sources') await workspace.getByRole('button', { name: '＋ 新建数据源', exact: true }).waitFor();
  await screenshot(`0${index + 1}-${key}-without-common-banner`);
  pass(`${label}保留左侧子菜单及页面内容，已移除重复数据中心公共横幅/步骤条`);
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'data-table-browser-ui-server.cjs')], {
    cwd: root, env: { ...process.env, DATA_BROWSER_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') }, logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(helper.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return Boolean(info.origin && info.database); } catch { return false; } }, 60000, 'owned collector-free fixture');
  requireTestPath(info.database); assert.equal(info.collectorFalse, true);
  assert.equal(new URL(info.origin).hostname, '127.0.0.1'); assert.notEqual(new URL(info.origin).port, '3001');
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Hong_Kong' });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'tables' })));
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url()); assert.equal(url.hostname, '127.0.0.1', 'application requests remain inside owned loopback fixture');
    if (/^\/api\/(?:data-center|data-sources|devices|datapoints|platform|models)/.test(url.pathname) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) dataWrites.push({ path: url.pathname, method: request.method() });
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.getByTestId('data-center-workspace').waitFor();
  for (let index = 0; index < sections.length; index++) await section(...sections[index], index);
  await page.locator('.admin-nav').getByRole('button', { name: '设备运动配置', exact: true }).click();
  const badge = page.locator('.mobile-motion-page .motion-latency-badge'); await badge.waitFor();
  assert.equal(await badge.innerText(), '运动点位采集周期 · 100ms');
  assert.match(await badge.getAttribute('title'), /不是实测传输延迟/);
  assert.match(await badge.getAttribute('title'), /保存运动绑定后/);
  assert.match(await badge.getAttribute('title'), /PLC 通信.*Unity 渲染/);
  assert.equal(await page.locator('.mobile-motion-page').getByText('端到端延迟 · 100ms', { exact: true }).count(), 0);
  await badge.hover();
  await screenshot('06-motion-badge-acquisition-cycle-not-measured-latency');
  pass('100ms徽章明确为保存绑定后的点位采集周期；悬停说明非实测传输延迟并说明PLC/Unity因素');
  await page.setViewportSize({ width: 1366, height: 768 });
  const bounds = await badge.boundingBox(); assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1366);
  await screenshot('07-motion-badge-compact-window');
  pass('常用1366×768窗口中采集周期徽章完整可读，没有横向溢出');
  assert.deepEqual(dataWrites, []); assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  pass('五子页和设备运动页面均无浏览器错误，验收未写入业务数据，仅操作隔离fixture');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, pageErrors, consoleErrors, dataWrites, directory, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, helperPid: helper.pid, scope: 'private collector:false fixture; headless browser; no installed backend/DB/PLC/Unity/user window' }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, screenshots: screenshots.length, directory }));
})().catch(async error => {
  console.error(error.stack); if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, pageErrors, consoleErrors, dataWrites, directory }, null, 2));
  process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(helper); });
