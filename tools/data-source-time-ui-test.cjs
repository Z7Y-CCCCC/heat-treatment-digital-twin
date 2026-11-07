// Three-view source-time regression. The helper owns a fresh collector:false
// SQLite sandbox and loopback HTTP source; no installed DB, PLC, Unity or window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output', 'playwright', `data-source-time-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix);
const checks = [], screenshots = [], audits = [], pageErrors = [], consoleErrors = [], reads = [], writes = [];
const log = path.join(directory, 'run.log');
let server, browser, page, info, dataset, table, sourceRows, catalog, browseResult;

function pass(label) {
  checks.push(label); console.log('PASS ' + label); fs.appendFileSync(log, 'PASS ' + label + '\n');
}
function localTime(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
async function api(route, method = 'GET', data) {
  assert.equal(new URL(info.origin).hostname, '127.0.0.1');
  if (/^\/data-(sources|center)\//.test(route) && !['GET', 'HEAD', 'OPTIONS'].includes(method)) writes.push({ method, path: '/api' + route, body: data, channel: 'owned-fixture-api' });
  const session = await page.request.get(info.origin + '/api/admin-auth/session').then(response => response.json());
  const response = await page.request.fetch(info.origin + '/api' + route, { method, headers: { Origin: info.origin, 'X-Factory-ID': info.factoryId, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken }, ...(data === undefined ? {} : { data }) });
  assert.equal(response.status(), 200, await response.text());
  const body = await response.json(); assert.notEqual(body.success, false, JSON.stringify(body)); return body;
}
async function catalogLoaded() { await page.locator('.catalog-layout[aria-busy="false"]').waitFor(); }
async function browserLoaded() {
  const panel = page.getByTestId('data-table-browser'); await panel.waitFor();
  await waitUntil(() => panel.getAttribute('aria-busy').then(value => value === 'false'), 20000, 'private actual records loaded');
  return panel;
}
async function shot(name, focus) {
  await focus.scrollIntoViewIfNeeded();
  const filename = path.join(directory, name + '.png'); await page.screenshot({ path: filename, fullPage: false }); screenshots.push(filename);
}
async function audit(name, focus, scrollSelector, valueSelector, oneLineRows = false) {
  const measurement = await focus.evaluate((section, args) => {
    const scroll = section.querySelector(args.scrollSelector), box = section.getBoundingClientRect();
    const values = [...section.querySelectorAll(args.valueSelector)].map(node => {
      const style = getComputedStyle(node), range = document.createRange(); range.selectNodeContents(node);
      const lines = [...range.getClientRects()].map(rect => Math.round(rect.top));
      return { text: node.textContent.trim(), whitespace: style.whiteSpace, lines: [...new Set(lines)].length, width: node.clientWidth, scrollWidth: node.scrollWidth };
    });
    const rows = [...scroll.querySelectorAll('tbody tr')].map(row => {
      const cell = row.querySelector('td'), style = getComputedStyle(cell);
      return { height: row.getBoundingClientRect().height, singleLine: (parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth) };
    });
    return { name: args.name, viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth, section: { left: box.left, right: box.right }, scroll: { width: scroll.scrollWidth, client: scroll.clientWidth }, values, rows };
  }, { name, scrollSelector, valueSelector });
  audits.push(measurement);
  assert.ok(measurement.pageWidth <= measurement.viewport.width + 2, `${name}: no page horizontal scrolling`);
  assert.ok(measurement.scroll.width <= measurement.scroll.client + 2, `${name}: no table horizontal scrolling`);
  assert.ok(measurement.section.left >= -1 && measurement.section.right <= measurement.viewport.width + 1, `${name}: section within viewport`);
  assert.ok(measurement.values.length > 0 && measurement.values.every(value => value.lines <= 1), `${name}: values/time stay on one text line`);
  if (oneLineRows) assert.ok(measurement.rows.every(row => row.height <= row.singleLine + 7), `${name}: records occupy one row, never stacked values`);
  await shot(name, focus);
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'data-table-browser-ui-server.cjs')], { cwd: root, env: { ...process.env, DATA_BROWSER_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return Boolean(info.origin && info.database); } catch { return false; } }, 60000, 'owned collector-free source-time fixture');
  requireTestPath(info.database); assert.equal(info.collectorFalse, true); assert.equal(new URL(info.sourceOrigin).hostname, '127.0.0.1');
  const sourceResponse = await fetch(info.sourceOrigin + '/records'); assert.equal(sourceResponse.status, 200);
  sourceRows = (await sourceResponse.json()).records; assert.ok(sourceRows.length >= 1);
  assert.ok(sourceRows.every(row => Date.now() - Date.parse(row.time) >= 3600000), 'source feedback predates browser fetch by at least one hour');
  pass('独立SQLite / collector:false / 自有loopback源；所有源更新时间均早于读取至少一小时');

  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: 'Asia/Hong_Kong' });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'tables' })));
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/data-center/') && request.method() === 'GET' && url.pathname.endsWith('/records')) reads.push(request.url());
    if (/^\/api\/data-(sources|center)\//.test(url.pathname) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click(); await catalogLoaded();
  const connection = (await api('/data-sources/connections', 'POST', { name: '时间验收自有MES接口', sourceType: 'http_api', baseUrl: info.sourceOrigin, authType: 'none', enabled: true, timeoutMs: 5000 })).connection;
  assert.ok(connection?.id);
  dataset = (await api('/data-sources/datasets', 'POST', { name: 'MES来源时间验收', connectionId: connection.id, source: 'http', enabled: true, refreshMs: 250, rootPath: 'records', request: { method: 'GET', path: '/records', parameters: [] }, columns: [
    { name: 'batch', label: '生产批次', path: 'batch', type: 'string' },
    { name: 'amount', label: '订单数量', path: 'amount', type: 'number', unit: '件' },
    { name: 'ready', label: '完成状态', path: 'ready', type: 'boolean' },
    { name: 'updatedAt', label: '更新时间', path: 'time', type: 'string' }
  ] })).dataset;
  assert.ok(dataset?.id); assert.equal(dataset.columns.find(column => column.name === 'updatedAt').role || '', '');
  const savedDefinitions = await api('/data-sources/datasets');
  pass('通过真实API创建普通旧版updatedAt字段（path=time、无role），未要求用户重配历史时间字段');

  // API fixture setup happens outside Vue's connection editor events. Reload
  // the owned page so props.connections represents the newly saved source too.
  await page.reload(); await catalogLoaded();
  await page.getByRole('button', { name: '＋ 新建 / 管理外部数据表', exact: true }).click();
  const editor = page.locator('.dataset-workspace'); await editor.waitFor();
  await editor.locator('.dataset-list button').filter({ hasText: dataset.name }).click();
  assert.ok((await editor.locator('.dataset-detail-heading').innerText()).includes(connection.name));
  await editor.getByRole('tab', { name: '数据预览', exact: true }).click();
  await editor.getByRole('button', { name: '读取预览', exact: true }).click();
  await editor.locator('.result-table tbody tr').first().waitFor();
  const firstPreviewTime = editor.locator('.result-table tbody tr').first().locator('td').nth(4);
  assert.equal(await firstPreviewTime.innerText(), localTime(sourceRows[0].time));
  assert.ok((await firstPreviewTime.getAttribute('title')).includes(sourceRows[0].time));
  assert.ok((await firstPreviewTime.getAttribute('title')).includes('本地时间'));
  await audit('01-dataset-preview-1920', editor, '.result-table', '.result-table tbody td:nth-child(5)', true);
  await page.setViewportSize({ width: 1366, height: 768 });
  await audit('01b-dataset-preview-1366', editor, '.result-table', '.result-table tbody td:nth-child(5)', true);
  pass('数据表数据预览显示香港完整本地时间，源ISO保留在悬停提示，两种桌面尺寸无需横向拖动');

  await page.locator('[data-data-center-section="tables"]').click(); await catalogLoaded();
  catalog = await api('/data-center/catalog');
  table = catalog.tables.find(entry => catalog.items.some(item => item.tableId === entry.id && item.datasetId === dataset.id)); assert.ok(table);
  const fields = catalog.items.filter(item => item.datasetId === dataset.id);
  assert.equal(fields.length, 4); assert.ok(fields.every(item => item.previewValue == null && item.quality === 'configured'), 'catalog remains configuration metadata, not persisted samples');
  await page.getByLabel('筛选数据来源', { exact: true }).selectOption('外部数据表');
  await page.locator('.table-card').filter({ hasText: table.name }).click();
  const updatedField = fields.find(item => item.binding.datasetField === 'updatedAt'); assert.ok(updatedField);
  const fieldRow = id => page.locator(`.fields-table tbody tr[data-field-id="${id}"]`);
  await waitUntil(() => fieldRow(updatedField.id).locator('.quality-label').innerText().then(text => text === '正常'), 20000, 'authorized live field sample');
  for (const item of fields) assert.notEqual(await fieldRow(item.id).locator('.field-value>span').innerText(), '—');
  assert.equal(await fieldRow(updatedField.id).locator('.field-value>span').innerText(), localTime(sourceRows[0].time));
  assert.ok((await fieldRow(updatedField.id).locator('.field-value>span').getAttribute('title')).includes(sourceRows[0].time));
  assert.ok(await page.locator('.field-sample-note').innerText().then(text => text.includes('同一条实际记录')));
  assert.ok(reads.some(url => new URL(url).pathname === `/api/data-center/tables/${table.id}/records`));
  await audit('02-field-catalog-1366', page.locator('.fields-section'), '.fields-scroll', '.field-value>span');
  await page.setViewportSize({ width: 1920, height: 1080 });
  await audit('02b-field-catalog-1920', page.locator('.fields-section'), '.fields-scroll', '.field-value>span');
  pass('字段目录通过独立授权records接口读取同一条真实记录；四项都有实际值和正常状态，更新时间本地格式且原值可查');

  await page.getByRole('group', { name: '数据表查看方式', exact: true }).getByRole('button', { name: '数据浏览', exact: true }).click();
  const panel = await browserLoaded();
  assert.equal(await panel.getByRole('button', { name: '历史记录', exact: true }).count(), 0);
  browseResult = await api(`/data-center/tables/${table.id}/records?page_size=100`);
  assert.equal(browseResult.capabilities.history, false); assert.ok(browseResult.records.length > 0);
  const sourceTimes = new Set(sourceRows.map(row => new Date(row.time).toISOString()));
  assert.ok(browseResult.records.every(record => sourceTimes.has(record.updatedAt)), 'every row timestamp comes from actual source time');
  assert.ok(browseResult.records.every(record => Date.parse(browseResult.readAt) - Date.parse(record.updatedAt) >= 3600000), 'source timestamp never replaced by fetch readAt');
  const currentRows = panel.locator('tbody tr'); assert.ok(await currentRows.count() > 0);
  for (const row of await currentRows.all()) {
    const time = row.locator('.record-time time'), raw = await time.getAttribute('datetime'); assert.ok(sourceTimes.has(raw));
    assert.equal(await time.innerText(), localTime(raw)); assert.ok((await time.getAttribute('title')).includes(raw));
    assert.equal(await row.locator('.record-quality').innerText(), '正常');
  }
  const datetimeRows = panel.locator(`tbody tr[data-field-id="${updatedField.id}"]`); assert.ok(await datetimeRows.count() > 0);
  assert.equal(await datetimeRows.first().locator('.record-value-line>span').innerText(), localTime(sourceRows[0].time));
  await audit('03-actual-records-1920', panel, '.browser-records-scroll', '.record-time time,.record-value-line>span', true);
  await page.setViewportSize({ width: 1366, height: 768 });
  await audit('03b-actual-records-1366', panel, '.browser-records-scroll', '.record-time time,.record-value-line>span', true);
  pass('数据浏览所有记录更新时间均取自源time而不是readAt；无空时间、无假历史入口，时间数据实际值也同步格式化');

  assert.deepEqual(await api('/data-sources/datasets'), savedDefinitions);
  assert.equal(writes.length, 3); // connection + dataset + dataset preview (read-only POST).
  assert.ok(writes.slice(2).every(write => write.path === '/api/data-sources/datasets/preview'), 'no config writes after owned fixture setup');
  assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []);
  pass('预览／字段目录／记录浏览不改数据表定义；无pageerror、console error或非预期配置写入');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, audits, reads, writes, pageErrors, consoleErrors, directory, sourceRows, browseResult, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, helperPid: server.pid, sourcePid: info.sourcePid, scope: 'owned SQLite + loopback records HTTP only; collector:false; no installed database/PLC/Unity/user window', timezoneId: 'Asia/Hong_Kong' }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, directory, screenshots: screenshots.length }));
})().catch(async error => {
  console.error(error); if (page && !page.isClosed()) { const filename = path.join(directory, 'failure.png'); await page.screenshot({ path: filename, fullPage: false }).then(() => screenshots.push(filename)).catch(() => {}); }
  fs.appendFileSync(log, 'FAIL ' + error.stack + '\n');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, audits, reads, writes, pageErrors, consoleErrors, directory, fixtureDatabase: info?.database }, null, 2)); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); fs.appendFileSync(log, 'Stopped only the owned fixture helper/backend/source process tree.\n'); });
