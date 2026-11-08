// Collector-free, private SQLite + loopback browser fixture only. No real data,
// PLC/Unity/backend process, session, application or user window is operated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), artifacts = requireTestPath(path.join(root, 'output', 'playwright'));
fs.mkdirSync(artifacts, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifacts, `device-management-hierarchy-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
const checks = [], screenshots = [], pageErrors = [], consoleErrors = [], writes = [];
const secondWorkshop = { id: 'DirectorySecondWorkshop', name: '导航验收二号车间' };
const secondLine = { id: 'DirectorySecondLine', name: '导航验收二号产线' };
const emptyLine = { id: 'DirectoryEmptyLine', name: '真实空设备产线' };
const extra = [
  { id: 'DirectorySecondFixed', name: '二线专属固定炉', role: '', line_id: secondLine.id },
  { id: 'DirectorySecondAuxiliary', name: '二线专属辅助车', role: 'auxiliary', line_id: secondLine.id },
  { id: 'DirectoryWorkshopAuxiliary', name: '车间直属不挂产线辅助车', role: 'auxiliary', line_id: null }
];
let helper, browser, page, info, prototype, firstWorkshop, firstLine;
const workspace = () => page.locator('.device-management-browser');
const nav = () => workspace().locator('.device-directory-nav');
const table = () => workspace().locator('.device-directory-table');
function pass(label) { checks.push(label); console.log('PASS ' + label); }
async function api(route, method = 'GET', data) {
  assert.equal(new URL(info.origin).hostname, '127.0.0.1'); assert.notEqual(new URL(info.origin).port, '3001');
  const session = await page.request.get(info.origin + '/api/admin-auth/session').then(response => response.json());
  const response = await page.request.fetch(info.origin + '/api' + route, { method,
    headers: { Origin: info.origin, 'X-Factory-ID': info.factoryId, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), 200, await response.text()); const body = await response.json(); assert.notEqual(body.success, false, JSON.stringify(body)); return body;
}
async function screenshot(name) { const filename = path.join(directory, name + '.png'); await page.screenshot({ path: filename, fullPage: false }); screenshots.push(filename); }
async function expectRows(expected) {
  await waitUntil(async () => JSON.stringify(await table().locator('tbody tr[data-device-id]').evaluateAll(rows => rows.map(row => row.dataset.deviceId).sort())) === JSON.stringify([...expected].sort()), 15000, 'selected range has only its actual device rows');
}
async function chooseTitle(title, expected) { await nav().getByTitle(title, { exact: true }).click(); await expectRows(expected); assert.equal(await nav().locator('.directory-node.selected').count(), 1); }
async function checkLayout(width) {
  await page.setViewportSize({ width, height: 768 });
  const dimensions = await workspace().evaluate(element => {
    const workspace = element.getBoundingClientRect(), nav = element.querySelector('.device-directory-nav').getBoundingClientRect(), list = element.querySelector('.device-directory-list').getBoundingClientRect(), scroll = element.querySelector('.device-directory-table-scroll');
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, workspaceRight: workspace.right, navRight: nav.right, listLeft: list.left, tableWidth: scroll.clientWidth, tableScrollWidth: scroll.scrollWidth };
  });
  assert.ok(dimensions.workspaceRight <= width + 1, JSON.stringify(dimensions));
  assert.ok(dimensions.pageWidth <= width + 1, JSON.stringify(dimensions));
  assert.ok(dimensions.navRight <= dimensions.listLeft + 1, JSON.stringify(dimensions));
  assert.ok(dimensions.tableScrollWidth <= dimensions.tableWidth + 1, JSON.stringify(dimensions));
  const model = table().locator('tbody tr[data-device-id] .directory-model-cell button').first();
  assert.equal(await model.isVisible(), true, 'model preview remains accessible at common window width');
  const modelBounds = await model.boundingBox(); assert.ok(modelBounds.width >= 80, JSON.stringify(modelBounds));
  assert.ok(await model.getAttribute('title'), 'full model name remains available on hover');
  await screenshot(`0${width === 1280 ? 6 : 7}-left-tree-single-table-${width}px`);
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'data-table-browser-ui-server.cjs')], {
    cwd: root, env: { ...process.env, DATA_BROWSER_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(helper.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return Boolean(info.origin && info.database); } catch { return false; } }, 60000, 'private collector:false fixture');
  requireTestPath(info.database); assert.equal(info.collectorFalse, true); assert.notEqual(new URL(info.origin).port, '3001');
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Hong_Kong' });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'devices' })));
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => { const url = new URL(request.url()); assert.equal(url.hostname, '127.0.0.1', 'all application requests stay inside owned fixture');
    if (/^\/api\/(?:devices|workshops|lines|datapoints)/.test(url.pathname) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname }); });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await workspace().waitFor(); await expectRows(info.devices.map(device => device.id));
  prototype = (await api('/devices')).find(device => device.id === info.devices[0].id); assert.ok(prototype?.line_id);
  firstLine = (await api('/lines')).find(line => line.id === prototype.line_id); firstWorkshop = (await api('/workshops')).find(workshop => workshop.id === firstLine.workshop_id);
  await api('/workshops', 'POST', { ...secondWorkshop, sort_order: 20 });
  await api('/lines', 'POST', { ...secondLine, workshop_id: secondWorkshop.id, sort_order: 20 });
  await api('/lines', 'POST', { ...emptyLine, workshop_id: secondWorkshop.id, sort_order: 21 });
  for (const item of extra) await api('/devices', 'POST', { id: item.id, name: item.name, line_id: item.line_id, model_type: prototype.model_type, plc_enabled: false, coordinate_space: item.line_id ? 'line_local' : 'workshop_local', instance_config: item.role ? { role: item.role, workshop_id: secondWorkshop.id } : {} });
  for (let index = 0; index < 15; index++) await api('/workshops', 'POST', { id: `DirectoryEmptyWorkshop${index}`, name: `导航滚动空车间${String(index + 1).padStart(2, '0')}`, sort_order: 50 + index });
  await page.reload(); await workspace().waitFor(); await nav().locator('.directory-root').click(); await expectRows([...info.devices.map(device => device.id), ...extra.map(device => device.id)]);
  assert.equal(await workspace().locator('.device-directory-table').count(), 1);
  assert.equal(await page.locator('.device-group').count(), 0);
  assert.equal(await page.getByRole('heading', { name: '设备管理', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '+ 添加设备', exact: true }).count(), 1);
  const add = await workspace().getByRole('button', { name: '+ 添加设备', exact: true }).boundingBox();
  const heading = await workspace().locator('.device-directory-heading').boundingBox();
  assert.ok(add.x > heading.x + heading.width / 2 && add.y >= heading.y && add.y + add.height <= heading.y + heading.height + 1, JSON.stringify({ add, heading }));
  await screenshot('01-all-devices-one-table-no-duplicate-heading');
  pass('设备管理只保留一套标题/新增入口；左侧层级导航、右侧唯一设备表覆盖所有真实设备');

  await chooseTitle(secondWorkshop.name, extra.map(device => device.id));
  await chooseTitle(`${secondWorkshop.name} / ${secondLine.name}`, [extra[0].id, extra[1].id]);
  await chooseTitle(`${secondWorkshop.name} / ${secondLine.name} / 固定设备`, [extra[0].id]);
  await screenshot('02-workshop-line-fixed-category-filter');
  await chooseTitle(`${secondWorkshop.name} / ${secondLine.name} / 辅助设备`, [extra[1].id]);
  pass('逐级点选车间/产线/固定或辅助分类只显示对应设备，不混入其它产线');

  await chooseTitle(`${secondWorkshop.name} / ${emptyLine.name}`, []);
  await chooseTitle(`${secondWorkshop.name} / ${emptyLine.name} / 固定设备`, []);
  assert.equal(await table().locator('.device-directory-empty').count(), 1); assert.match(await table().innerText(), /此分类暂无设备/);
  await screenshot('03-empty-category-no-fabricated-device');
  pass('没有设备的真实产线/分类显示明确空状态，不用其它设备补空分类');

  await chooseTitle(`${secondWorkshop.name} / 车间级设备`, [extra[2].id]);
  await chooseTitle(`${secondWorkshop.name} / 车间级设备 / 辅助设备`, [extra[2].id]);
  const auxiliaryName = table().locator(`[data-device-id="${extra[2].id}"] .directory-device-name`);
  assert.equal(await auxiliaryName.innerText(), extra[2].name);
  assert.equal(await auxiliaryName.getAttribute('title'), `${secondWorkshop.name} / 车间级设备 / ${extra[2].name}`);
  await screenshot('04-workshop-level-auxiliary-preserved');
  pass('车间直属且不挂产线的辅助设备仍可访问；名称列只显示设备名称，悬停title提供完整路径');

  await chooseTitle(`${secondWorkshop.name} / ${secondLine.name} / 固定设备`, [extra[0].id]);
  const row = table().locator(`[data-device-id="${extra[0].id}"]`);
  const writeCount = writes.length;
  await row.getByRole('button', { name: `编辑设备：${extra[0].name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑设备', exact: true });
  await dialog.getByLabel('设备名称', { exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('设备名称', { exact: true }).inputValue(), extra[0].name);
  assert.equal(await dialog.getByLabel(/^使用模型/).inputValue(), prototype.model_type);
  await screenshot('05-existing-edit-form-opens-from-icon');
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(writes.length, writeCount); assert.equal((await api('/devices/' + extra[0].id)).name, extra[0].name);
  pass('原编辑功能通过铅笔图标正常打开，取消不提交写请求、不更改设备记录');

  await chooseTitle(firstWorkshop.name, info.devices.map(device => device.id));
  await chooseTitle(`${firstWorkshop.name} / ${firstLine.name}`, info.devices.map(device => device.id));
  await checkLayout(1280); await checkLayout(1024);
  pass('1280/1024常用窗口保持左树右单表，表头与操作列无需横向拖动');
  const list = workspace().locator('.device-directory-table-scroll'), tree = nav().locator('.device-directory-tree');
  const scrollability = await workspace().evaluate(element => Object.fromEntries(['device-directory-table-scroll','device-directory-tree'].map(name => { const el = element.querySelector('.' + name); return [name, { height: el.clientHeight, fullHeight: el.scrollHeight }]; })));
  for (const item of Object.values(scrollability)) assert.ok(item.fullHeight > item.height, JSON.stringify(scrollability));
  const treeBefore = await tree.evaluate(element => element.scrollTop);
  await list.evaluate(element => { element.scrollTop = element.scrollHeight; }); assert.ok(await list.evaluate(element => element.scrollTop) > 0); assert.equal(await tree.evaluate(element => element.scrollTop), treeBefore);
  const listBefore = await list.evaluate(element => element.scrollTop);
  await tree.evaluate(element => { element.scrollTop = element.scrollHeight; }); assert.ok(await tree.evaluate(element => element.scrollTop) > 0); assert.equal(await list.evaluate(element => element.scrollTop), listBefore);
  await screenshot('08-tree-and-table-scroll-independently');
  pass('超出范围的树和设备表各自可纵向滚动，滚动一侧不会带动另一侧');
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); pass('所有浏览器流程无页面/控制台异常，仅正式API准备自有fixture');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, pageErrors, consoleErrors, writes, scrollability, directory, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, helperPid: helper.pid, scope: 'private collector:false SQLite + owned loopback APIs/headless browser only; no installed backend, user data, PLC, Unity or user window' }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, screenshots: screenshots.length, directory }));
})().catch(async error => {
  console.error(error.stack); if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, pageErrors, consoleErrors, writes, directory }, null, 2)); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(helper); });
