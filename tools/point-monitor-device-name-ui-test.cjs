// Narrow real-browser acceptance against an owned collector:false fixture.
// No live database, physical PLC or Unity process is opened or changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output', 'playwright', `point-monitor-device-name-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix), checks = [], errors = [], consoleErrors = [], writes = [];
let server, browser, page, info, db;
const pass = label => { checks.push(label); console.log('PASS ' + label); };
const monitor = () => page.getByTestId('data-center-monitor');
const cells = () => monitor().locator('.realtime-points-table tbody tr td:first-child');
async function loaded() {
  await monitor().waitFor();
  await waitUntil(() => cells().count().then(count => count === 4), 15000, 'owned point rows loaded');
  await waitUntil(() => monitor().getByRole('button', { name: '读取最新缓存', exact: true }).isEnabled(), 15000, 'cached read completed');
}
function snapshot() { return { devices: db.prepare('SELECT * FROM devices ORDER BY id').all(), points: db.prepare('SELECT * FROM data_points ORDER BY id').all() }; }
async function assertCells(name, fullPath) {
  assert.deepEqual(await cells().allTextContents(), Array(4).fill(name));
  for (const cell of await cells().all()) {
    assert.equal(await cell.getAttribute('title'), fullPath);
    assert.equal(await cell.evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');
  }
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'data-table-browser-ui-server.cjs')], {
    cwd: root, env: { ...process.env, DATA_BROWSER_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') }, logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return !!info.origin && !!info.database; } catch { return false; } }, 60000, 'owned point monitor fixture');
  requireTestPath(info.database); assert.equal(info.collectorFalse, true);
  db = new Database(info.database); const before = snapshot();
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'monitor', selectedDeviceForMonitor: 'all', pointMonitorAutoRefresh: false })));
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: pathname }); });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await monitor().waitFor();
  // With polling deliberately disabled, start from the same explicit cache
  // read offered by the page rather than relying on restore-before-config.
  await monitor().getByRole('button', { name: '读取最新缓存', exact: true }).click(); await loaded();
  const catalogResponse = await page.request.get(info.origin + '/api/data-center/catalog'); assert.equal(catalogResponse.status(), 200);
  const catalog = await catalogResponse.json(), device = catalog.devices.find(device => device.id === info.devices[0].id); assert.ok(device);
  const fullPath = [device.workshopName, device.lineName, device.name].join(' / '), selector = monitor().locator('.point-monitor-toolbar select');
  assert.equal(await selector.inputValue(), 'all'); await assertCells(device.name, fullPath);
  assert.ok(fullPath !== device.name && fullPath.includes(' / '));
  pass('全部设备模式只显示真实设备简名，不把车间／产线完整路径塞入单元格');
  await cells().first().hover(); assert.equal(await cells().first().getAttribute('title'), fullPath);
  pass('鼠标悬停的原生title包含完整车间／产线／设备路径，默认文本保持单行');
  assert.equal(await selector.locator(`option[value="${device.id}"]`).textContent(), fullPath);
  pass('设备筛选菜单仍保留完整层级，未将选择器或数据绑定一并改短');
  const screenshot = path.join(directory, 'point-monitor-short-device-name.png');
  await monitor().locator('.table-scroll').screenshot({ path: screenshot });
  const writeStart = writes.length;
  await selector.selectOption(device.id); await loaded(); await assertCells(device.name, fullPath);
  await monitor().getByRole('button', { name: '读取最新缓存', exact: true }).click(); await loaded(); await assertCells(device.name, fullPath);
  await selector.selectOption('all'); await loaded(); await assertCells(device.name, fullPath);
  pass('单设备、全部设备切换及刷新后名称／悬停路径均正确，不出现旧范围或重复路径');
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(writes.slice(writeStart).filter(write => !['/api/admin-auth/touch', '/api/native-preview'].includes(write.path)), []);
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
  pass('显示与筛选没有配置写入，真实定义与绑定不变，浏览器页面及控制台错误为零');
  const result = { success: true, checks, screenshot, errors, consoleErrors, writes, directory, fixtureDatabase: info.database, helperPid: server.pid, backendPid: info.backendPid, collectorFalse: true, noPhysicalPLC: true, noUnity: true };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ success: true, checks: checks.length, directory, screenshot }));
})().catch(async error => {
  console.error(error); if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, errors, consoleErrors, writes, directory }, null, 2)); process.exitCode = 1;
}).finally(async () => { db?.close(); await browser?.close(); await stopOwnedSmokeProcess(server); });
