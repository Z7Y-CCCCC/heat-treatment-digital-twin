// Real-browser acceptance, using only our own collector-free SQLite fixture.
// No commissioned database, PLC connection, or Unity process is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output', 'playwright', `data-center-inline-edit-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix);
const runLog = path.join(directory, 'run.log');
fs.writeFileSync(runLog, 'Owned collector-free SQLite fixture; only loopback health API; no PLC or Unity.\n');
const checks = [], pageErrors = [], consoleErrors = [], screenshots = [], metadataWrites = [], audits = [];
let server, browser, page, info, injectSaveFailure = false;
const pass = label => { checks.push(label); console.log('PASS ' + label); fs.appendFileSync(runLog, 'PASS ' + label + '\n'); };
const fieldRow = id => page.locator(`[data-field-id="${id}"]`);
const nameInput = () => page.getByLabel('数据项显示名称', { exact: true });
const categorySelect = () => page.getByLabel('数据项用途分类', { exact: true });
const category = name => page.locator('.category-choice').filter({ hasText: name });
const withoutMetadata = item => Object.fromEntries(Object.entries(item).filter(([key]) => !['label', 'categoryId'].includes(key)));
async function api(route, method = 'GET', data) {
  const sessionResponse = await page.request.get(info.origin + '/api/admin-auth/session');
  assert.equal(sessionResponse.status(), 200);
  const session = await sessionResponse.json();
  const response = await page.request.fetch(info.origin + '/api' + route, {
    method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
    ...(data === undefined ? {} : { data })
  });
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function loaded() { await page.locator('.catalog-layout[aria-busy="false"]').waitFor(); await fieldRow('internal_device_name').waitFor(); }
async function selectSection(name) { await page.locator('#data-center-submenu').getByRole('button', { name, exact: true }).click(); }
async function confirm(label) { const dialog = page.getByRole('dialog'); await dialog.waitFor(); await dialog.getByRole('button', { name: label, exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); }
async function begin(id = 'internal_device_name') { await fieldRow(id).locator('.field-edit').click(); await nameInput().waitFor(); }
async function savedLabel(id, value) {
  await waitUntil(async () => (await api('/data-center/catalog')).items.find(item => item.id === id)?.label === value, 10000, 'metadata saved');
  await page.locator('.catalog-layout[aria-busy="false"]').waitFor();
  await nameInput().waitFor({ state: 'hidden' });
}
async function screenshot(name) {
  const file = path.join(directory, name + '.png');
  await page.screenshot({ path: file, fullPage: false }); screenshots.push(file); return file;
}
async function readingScale(expected) {
  const actual = await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--admin-font-scale')));
  assert.ok(Math.abs(actual - expected / 100) < .001, `font scale is ${actual}, expected ${expected}%`);
  assert.ok(Math.abs(await page.evaluate(() => visualViewport.scale) - 1) < .001, 'browser zoom is unchanged');
}
async function overview(total) {
  await page.locator('.source-overview').waitFor();
  await waitUntil(async () => Number(await page.locator('.source-overview strong').innerText()) === total, 10000, 'saved connection count');
  const response = await api('/data-sources');
  const saved = response.connections.filter(item => !item.primary);
  assert.equal(saved.length, total);
  assert.equal(await page.locator('.source-overview b').nth(0).innerText(), String(saved.filter(item => item.enabled === true).length));
  assert.equal(await page.locator('.source-overview b').nth(1).innerText(), String(saved.filter(item => item.enabled === true && item.health?.status === 'healthy').length));
  assert.equal(await page.locator('.source-type-card').count(), 0, 'types are not exposed on the source homepage');
  return response;
}
async function openPicker() {
  await page.getByRole('button', { name: '＋ 新建数据源', exact: true }).click();
  await page.getByRole('dialog', { name: '新建数据源', exact: true }).waitFor();
  assert.equal(await page.locator('.source-type-card').count(), 28);
  assert.equal(await page.locator('.source-type-card em.ready').getByText('可接入', { exact: true }).count(), await page.locator('.source-type-card em.ready').count());
  assert.equal(await page.locator('.source-type-card').getByText('已接入', { exact: true }).count(), 0);
}
async function auditPicker(name, scale, fitAll) {
  await readingScale(scale);
  // The lazy-loaded logos must have rendered before visual QA, not just captions.
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.source-type-card img')];
    return images.length === 28 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  const audit = await page.locator('.source-picker').evaluate((picker, { name, scale }) => {
    const p = picker.getBoundingClientRect();
    const cards = [...picker.querySelectorAll('.source-type-card')].map(card => {
      const r = card.getBoundingClientRect(), title = card.querySelector('strong'), status = card.querySelector('em');
      return { title: title.textContent.trim(), status: status.textContent.trim(), fontSize: parseFloat(getComputedStyle(title).fontSize), statusFontSize: parseFloat(getComputedStyle(status).fontSize),
        left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height,
        inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
        withinPicker: r.top >= p.top && r.bottom <= p.bottom,
        visible: !!card.getClientRects().length && getComputedStyle(card).visibility === 'visible' };
    });
    return { name, scale, viewport: { width: innerWidth, height: innerHeight }, picker: { left: p.left, right: p.right, top: p.top, bottom: p.bottom, clientHeight: picker.clientHeight, scrollHeight: picker.scrollHeight, overflow: getComputedStyle(picker).overflowY },
      catalog: { clientHeight: picker.querySelector('.source-catalog').clientHeight, scrollHeight: picker.querySelector('.source-catalog').scrollHeight, overflow: getComputedStyle(picker.querySelector('.source-catalog')).overflowY },
      pageWidth: document.documentElement.scrollWidth, cards };
  }, { name, scale });
  audits.push(audit);
  assert.equal(audit.cards.length, 28); assert.ok(audit.cards.every(card => card.visible));
  assert.ok(audit.cards.every(card => card.fontSize >= 13.5 * scale / 100 - .1 && card.statusFontSize >= 12.5 * scale / 100 - .1), 'type captions respect the chosen scale');
  assert.ok(audit.picker.left >= 0 && audit.picker.right <= audit.viewport.width + 1);
  assert.ok(audit.pageWidth <= audit.viewport.width + 2, 'page does not acquire horizontal overflow');
  assert.ok(!/auto|scroll/.test(audit.catalog.overflow) || audit.catalog.scrollHeight <= audit.catalog.clientHeight + 1, 'no nested catalog scroll region');
  if (fitAll) { assert.ok(audit.cards.every(card => card.inViewport && card.withinPicker), 'all 28 choices fit without scrolling'); assert.ok(audit.picker.scrollHeight <= audit.picker.clientHeight + 1, 'picker needs no scrolling at normal desktop resolution'); }
  else {
    assert.ok(/auto|scroll/.test(audit.picker.overflow)); if (fitAll === false) assert.ok(audit.picker.scrollHeight > audit.picker.clientHeight + 1, 'large text falls back to whole-dialog scrolling');
    await page.locator('.source-type-card').last().scrollIntoViewIfNeeded();
    const lastVisible = await page.locator('.source-type-card').last().evaluate(card => { const r = card.getBoundingClientRect(), p = card.closest('.source-picker').getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom; });
    assert.ok(lastVisible, 'last source choice remains reachable');
    await screenshot(name + '-bottom'); await page.locator('.source-picker').evaluate(picker => { picker.scrollTop = 0; });
  }
  await screenshot(name);
}
async function newPage(context) {
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), expectedInjectedFailure: injectSaveFailure, location: message.location() }); });
  await page.route('**/api/data-center/items/*', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    const entry = { url: route.request().url(), body: route.request().postDataJSON(), injectedFailure: injectSaveFailure };
    metadataWrites.push(entry);
    if (injectSaveFailure) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ success: false, error: '隔离验收：元数据保存失败，请重试' }) });
    return route.continue();
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).waitFor();
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: root, env: { ...process.env, MANUAL_LAYOUT_DISPLAY_ONLY: 'true', MANUAL_LAYOUT_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: path.join(root, 'frontend', 'dist') },
    logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned collector-free fixture');
  info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); assert.equal(new URL(info.origin).hostname, '127.0.0.1'); requireTestPath(info.database);
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1100 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => { if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'tables' })); });
  await newPage(context); await loaded(); await readingScale(115);
  const initialCatalog = await api('/data-center/catalog');
  const initialItem = initialCatalog.items.find(item => item.id === 'internal_device_name'); assert.ok(initialItem);
  fs.writeFileSync(path.join(directory, 'initial-catalog.json'), JSON.stringify(initialCatalog, null, 2));
  assert.equal(await page.locator('main .field-form').count(), 0);
  assert.equal(await page.locator('.data-center .field-form').count(), 0);
  const pencil = fieldRow(initialItem.id).getByRole('button', { name: '整理数据项 设备名称', exact: true });
  assert.equal(await pencil.innerText(), ''); assert.equal(await pencil.locator('svg').count(), 1);
  assert.ok(await pencil.getAttribute('title')); assert.ok(await pencil.getAttribute('aria-label'));
  const staticCloseup = path.join(directory, '00-115-1680-field-icons-closeup.png'); await page.locator('.fields-section').screenshot({ path: staticCloseup }); screenshots.push(staticCloseup);
  pass('底部 field-form 已移除，整理按钮为有 title/aria 的纯 SVG 铅笔图标');
  await begin();
  assert.equal(await nameInput().count(), 1); assert.equal(await categorySelect().count(), 1);
  assert.equal(await fieldRow(initialItem.id).getByLabel('数据项显示名称', { exact: true }).count(), 1);
  assert.equal(await nameInput().inputValue(), initialItem.label); assert.equal(await categorySelect().inputValue(), initialItem.categoryId);
  assert.equal(await fieldRow(initialItem.id).locator('input,select').count(), 2);
  assert.equal(await fieldRow(initialItem.id).locator('.field-value input,.field-value select,.field-scope input').count(), 0);
  for (const label of ['保存数据项 设备名称', '取消编辑数据项 设备名称']) { const button = fieldRow(initialItem.id).getByRole('button', { name: label, exact: true }); assert.equal(await button.innerText(), ''); assert.equal(await button.locator('svg').count(), 1); assert.ok(await button.getAttribute('title')); }
  assert.ok(await nameInput().evaluate(el => document.activeElement === el));
  await nameInput().fill('设备名称 · 行内草稿'); await categorySelect().selectOption('production');
  await screenshot('01-115-1680-inline-edit');
  const closeup = path.join(directory, '01-115-1680-inline-edit-closeup.png'); await page.locator('.fields-section').screenshot({ path: closeup }); screenshots.push(closeup);
  pass('点击当前行即显示名称 input / 分类 select，勾号/X 就地保存取消，预览值/绑定没有编辑控件');
  let writes = metadataWrites.length;
  await fieldRow(initialItem.id).getByRole('button', { name: '取消编辑数据项 设备名称', exact: true }).click();
  await nameInput().waitFor({ state: 'hidden' }); assert.equal(metadataWrites.length, writes);
  assert.deepEqual((await api('/data-center/catalog')).items.find(item => item.id === initialItem.id), initialItem);
  await begin(); await nameInput().fill('Esc 应丢弃'); await categorySelect().selectOption('production'); await nameInput().press('Escape');
  await nameInput().waitFor({ state: 'hidden' }); assert.equal(metadataWrites.length, writes);
  await begin(); await nameInput().fill('分类 Esc 应丢弃'); await categorySelect().press('Escape'); await nameInput().waitFor({ state: 'hidden' }); assert.equal(metadataWrites.length, writes);
  pass('X、名称 Esc 和分类 Esc 取消不写 API，原始元数据保持不变');
  await begin(); await nameInput().fill('中文输入法组合中的草稿');
  for (const key of ['Enter', 'Escape']) {
    await nameInput().evaluate((input, key) => input.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, isComposing: true, keyCode: 229, bubbles: true, cancelable: true })), key);
    assert.equal(await nameInput().inputValue(), '中文输入法组合中的草稿'); assert.equal(metadataWrites.length, writes);
  }
  await categorySelect().evaluate(select => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, keyCode: 229, bubbles: true, cancelable: true })));
  assert.equal(await nameInput().inputValue(), '中文输入法组合中的草稿'); assert.equal(metadataWrites.length, writes);
  await nameInput().press('Escape'); await nameInput().waitFor({ state: 'hidden' });
  pass('中文 IME composition Enter/Escape 不误保存或取消当前行草稿，组合结束后普通Esc可取消');
  await begin(); await nameInput().fill('设备显示名称（验收）'); await categorySelect().selectOption('production');
  await fieldRow(initialItem.id).getByRole('button', { name: '保存数据项 设备名称', exact: true }).click(); await savedLabel(initialItem.id, '设备显示名称（验收）');
  let updated = (await api('/data-center/catalog')).items.find(item => item.id === initialItem.id);
  assert.equal(updated.categoryId, 'production'); assert.deepEqual(withoutMetadata(updated), withoutMetadata(initialItem));
  assert.deepEqual(Object.keys(metadataWrites.at(-1).body).sort(), ['categoryId', 'label', 'revision']);
  pass('勾号真实保存仅发送 label/categoryId/revision，设备动态 binding/tooltipBinding/预览值及其它元数据不变');
  await begin(); await nameInput().fill('设备显示名称（Enter）'); await nameInput().press('Enter'); await savedLabel(initialItem.id, '设备显示名称（Enter）');
  pass('Enter 触发真实保存并返回该行的静态显示状态');
  await begin(); await nameInput().fill('保留这份行内草稿');
  await fieldRow('internal_device_id').locator('.field-edit').click(); await confirm('继续编辑');
  assert.equal(await nameInput().inputValue(), '保留这份行内草稿'); assert.equal(await page.locator('.field-row-editing').count(), 1); assert.equal(await fieldRow(initialItem.id).locator('input').count(), 1);
  await fieldRow('internal_device_id').locator('.field-edit').click(); await confirm('放弃修改');
  assert.equal(await fieldRow('internal_device_id').locator('input').count(), 1); assert.equal(await page.locator('.field-row-editing').count(), 1); await nameInput().press('Escape');
  pass('只允许一行编辑；dirty 换行时继续编辑保留当前行草稿，放弃修改才切换目标行');
  writes = metadataWrites.length;
  await begin(); await nameInput().fill('筛选确认草稿'); await category('设备资料').click(); await confirm('继续编辑'); assert.equal(await nameInput().inputValue(), '筛选确认草稿');
  assert.equal(await category('全部数据').getAttribute('aria-pressed'), 'true');
  await category('设备资料').click(); await confirm('放弃修改'); await nameInput().waitFor({ state: 'hidden' }); assert.equal(await category('设备资料').getAttribute('aria-pressed'), 'true');
  assert.equal(metadataWrites.length, writes); await category('全部数据').click(); await loaded();
  pass('dirty 分类筛选有继续/放弃确认；继续保持原筛选和草稿，放弃不发保存请求');
  const categoriesBefore = (await api('/data-center/catalog')).categories;
  await category('设备资料').click();
  await page.getByLabel('添加用途分类', { exact: true }).click(); await page.getByLabel('用途分类名称', { exact: true }).fill('不能被重复加号覆盖的草稿');
  await page.getByLabel('添加用途分类', { exact: true }).click(); assert.equal(await page.getByLabel('用途分类名称', { exact: true }).inputValue(), '不能被重复加号覆盖的草稿'); assert.equal(await page.getByRole('dialog').count(), 0); assert.ok(await page.getByLabel('用途分类名称', { exact: true }).evaluate(input => document.activeElement === input));
  await page.getByRole('button', { name: '重命名', exact: true }).click(); await confirm('继续编辑'); assert.equal(await page.getByLabel('用途分类名称', { exact: true }).inputValue(), '不能被重复加号覆盖的草稿');
  await page.getByRole('button', { name: '重命名', exact: true }).click(); await confirm('放弃修改'); assert.equal(await page.getByLabel('用途分类名称', { exact: true }).inputValue(), '设备资料');
  await page.getByLabel('用途分类名称', { exact: true }).fill('分类重命名未保存草稿');
  await page.getByRole('button', { name: '重命名', exact: true }).click(); assert.equal(await page.getByLabel('用途分类名称', { exact: true }).inputValue(), '分类重命名未保存草稿'); assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByLabel('添加用途分类', { exact: true }).click(); await confirm('继续编辑'); assert.equal(await page.getByLabel('用途分类名称', { exact: true }).inputValue(), '分类重命名未保存草稿');
  await page.getByLabel('添加用途分类', { exact: true }).click(); await confirm('放弃修改'); assert.equal(await page.getByLabel('用途分类名称', { exact: true }).inputValue(), '');
  await page.locator('.category-form').getByRole('button', { name: '取消', exact: true }).click(); await category('全部数据').click(); await loaded();
  assert.deepEqual((await api('/data-center/catalog')).categories, categoriesBefore);
  pass('分类草稿重复点击同一＋/重命名聚焦且不覆盖；切换新建/已有分类须继续/放弃确认，不写库');
  await begin(); await nameInput().fill('失败之后保留草稿'); await categorySelect().selectOption('realtime'); injectSaveFailure = true;
  await nameInput().press('Enter'); await page.locator('.center-message.error').filter({ hasText: '隔离验收：元数据保存失败，请重试' }).waitFor();
  assert.equal(await nameInput().inputValue(), '失败之后保留草稿'); assert.equal(await categorySelect().inputValue(), 'realtime'); assert.equal(await nameInput().getAttribute('aria-invalid'), 'true'); assert.ok(await nameInput().isEnabled());
  assert.equal((await api('/data-center/catalog')).items.find(item => item.id === initialItem.id).label, '设备显示名称（Enter）');
  await screenshot('02-115-1680-failed-save-draft'); injectSaveFailure = false; await nameInput().press('Enter'); await savedLabel(initialItem.id, '失败之后保留草稿');
  pass('隔离 409 保存失败后草稿/分类留在当前行且可重试，失败未改数据库');
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await loaded(); assert.equal(await fieldRow(initialItem.id).locator('strong').first().innerText(), '失败之后保留草稿');
  await page.reload(); await loaded(); assert.equal(await fieldRow(initialItem.id).locator('strong').first().innerText(), '失败之后保留草稿'); assert.equal(await fieldRow(initialItem.id).locator('td').nth(1).innerText(), '实时采集');
  assert.deepEqual(withoutMetadata((await api('/data-center/catalog')).items.find(item => item.id === initialItem.id)), withoutMetadata(initialItem));
  pass('刷新及浏览器 reload 恢复已保存显示名称/分类，动态元数据不变');
  await selectSection('数据源'); const emptySources = await overview(0); assert.ok(emptySources.connections.some(item => item.primary), 'primary database fixture exists but is excluded');
  await page.getByText('暂无已配置的数据源', { exact: true }).waitFor(); assert.equal(await page.locator('.source-row').count(), 0); assert.equal(await page.locator('.source-start button').count(), 0);
  await screenshot('03-115-1680-source-zero'); pass('源首页统计真实已保存连接，primary 不计数；0 个时空状态且不显示类型卡片');
  await page.setViewportSize({ width: 1366, height: 768 }); await screenshot('03-115-1366-source-zero');
  await openPicker(); pass('只有右上角新建按钮打开有 aria-labelledby 的28类型弹窗；可接入不伪装为已接入');
  await page.setViewportSize({ width: 1366, height: 768 }); await auditPicker('04-115-1366-picker-all-28', 115, true);
  pass('1366×768 默认115%字体全部28类型一页可见，不缩字号、不隐藏类型、不需要滚动');
  await page.getByLabel('关闭数据源类型选择', { exact: true }).click(); await page.setViewportSize({ width: 1680, height: 1100 });
  await openPicker(); await page.locator('.source-type-card').filter({ hasText: 'HTTP / REST' }).click();
  await page.getByLabel('数据源名称', { exact: true }).fill('本机健康API（行内验收）'); await page.getByLabel('API 根地址', { exact: true }).fill(info.origin); await page.getByLabel('健康检查地址', { exact: true }).fill('/api/health');
  await overview(0); assert.equal(await page.locator('.source-row').count(), 0); pass('未保存的 HTTP 草稿不计入源数量或已保存列表');
  await page.getByRole('button', { name: '保存数据源', exact: true }).click(); const sourceResponse = await overview(1);
  const connection = sourceResponse.connections.find(item => !item.primary); assert.equal(connection.baseUrl, info.origin); assert.equal(connection.healthPath, '/api/health');
  await page.locator('.source-row').filter({ hasText: connection.name }).waitFor(); await page.getByLabel('关闭数据源编辑', { exact: true }).click(); await page.locator('.source-form').waitFor({ state: 'hidden' });
  await page.locator('.source-row').filter({ hasText: connection.name }).waitFor(); await overview(1); await screenshot('05-115-1680-source-one');
  await page.setViewportSize({ width: 1366, height: 768 }); await screenshot('05-115-1366-source-one'); await page.setViewportSize({ width: 1680, height: 1100 });
  await page.reload(); await page.locator('.source-overview').waitFor(); await overview(1); await page.locator('.source-row').filter({ hasText: connection.name }).waitFor();
  pass('通过真实UI保存 own /api/health 连接后数量为1；关编辑和 reload 仍保留真实连接列表');
  const datasetResponse = await api('/data-sources/datasets', 'POST', { name: '本机服务状态（验收）', connectionId: connection.id, source: 'http', enabled: true, refreshMs: 5000, request: { method: 'GET', path: '/api/health', parameters: [] }, rootPath: '', columns: [{ name: 'status', label: '本机API返回状态', path: 'status', type: 'string', unit: '' }] });
  const sourcesBefore = await api('/data-sources'), datasetsBefore = await api('/data-sources/datasets');
  await selectSection('数据表'); await loaded(); const ownCatalog = await api('/data-center/catalog'); const ownField = ownCatalog.items.find(item => item.sourceType === 'dataset' && item.label === '本机API返回状态'); assert.ok(ownField, JSON.stringify(datasetResponse));
  await page.locator('.table-card').filter({ hasText: '本机服务状态（验收）' }).click(); await fieldRow(ownField.id).waitFor(); await begin(ownField.id); await nameInput().fill('API显示名称（行内整理）'); await categorySelect().selectOption('production'); await nameInput().press('Enter'); await savedLabel(ownField.id, 'API显示名称（行内整理）');
  const ownAfter = (await api('/data-center/catalog')).items.find(item => item.id === ownField.id); assert.deepEqual(withoutMetadata(ownAfter), withoutMetadata(ownField)); assert.deepEqual(await api('/data-sources'), sourcesBefore); assert.deepEqual(await api('/data-sources/datasets'), datasetsBefore);
  pass('外部API字段行内整理仅改目录显示名称/分类；dataset 动态绑定、数据源连接与请求/列映射元数据逐项不变');
  assert.ok(metadataWrites.every(entry => JSON.stringify(Object.keys(entry.body).sort()) === JSON.stringify(['categoryId', 'label', 'revision']))); pass('全部行内编辑PUT均严格只发送三项元数据，无value/binding/API配置写入');
  await selectSection('数据源'); await overview(1); await page.setViewportSize({ width: 1024, height: 768 }); await openPicker();
  await auditPicker('06-115-1024-picker-scroll-fallback', 115, null); pass('1024px小窗口完整保留28选项，允许整体弹窗滚动且最后一项可达');
  await context.close();
  const largeContext = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  await largeContext.addInitScript(() => { localStorage.setItem('digital_twin_admin_reading_v1', JSON.stringify({ textSize: 200 })); localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'sources' })); });
  await newPage(largeContext); await page.locator('.source-overview').waitFor(); await overview(1); await openPicker(); await auditPicker('07-200-1366-picker-scroll-fallback', 200, false);
  pass('200%文字保持实际27px/25px类型标题与状态，不限制字号；28选项整体滚动全部可达');
  await largeContext.close(); assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors.filter(error => !error.expectedInjectedFailure), []); pass('真实浏览器无pageerror和非预期console error（409注入错误单独记录）');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, audits, pageErrors, consoleErrors, metadataWrites, screenshots, directory, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, serverPid: server.pid, scope: 'owned SQLite and loopback health API only; collector false; no PLC or Unity' }, null, 2));
  const summary = { success: true, checks: checks.length, directory, screenshots: screenshots.length, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length };
  console.log(JSON.stringify(summary)); fs.appendFileSync(runLog, JSON.stringify(summary) + '\n');
})().catch(async error => {
  console.error(error); if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  fs.appendFileSync(runLog, 'FAIL ' + error.stack + '\n');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, checks, audits, pageErrors, consoleErrors, metadataWrites, screenshots, directory, error: String(error), stack: error.stack, fixtureDatabase: info?.database }, null, 2)); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); await stopOwnedSmokeProcess(server); fs.appendFileSync(runLog, 'Stopped only this test owned server process/tree.\n'); });
