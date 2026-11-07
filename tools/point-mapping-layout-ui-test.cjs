// Real-browser single-line point layout/edit acceptance against an owned collector:false fixture.
// Writes only disposable output SQLite; no commissioned DB, PLC, Unity or service restart.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output/playwright', `point-mapping-layout-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix), runLog = path.join(directory, 'run.log');
fs.writeFileSync(runLog, 'Owned collector:false output SQLite / random127.0.0.1 only; no PLC/Unity.\n');
const checks = [], errors = [], consoleErrors = [], audits = [], screenshots = [], mutations = [], pointIds = {};
let stubbedVoiceEnumerations = 0;
let server, browser, page, info, injectingFailure = false;
const check = text => { checks.push(text); console.log('PASS ' + text); fs.appendFileSync(runLog, 'PASS ' + text + '\n'); };
const rows = () => page.locator('.point-mapping-row');
const row = id => page.locator(`.point-mapping-row[data-point-id="${id}"]`);
const workspace = () => page.getByTestId('points-workspace');
const saveButton = () => page.getByTestId('points-savebar').getByRole('button', { name: /保存(全部设备|当前设备)配置/ });
const removeButton = entry => entry.locator('button.btn-danger');
async function api(route, method = 'GET', body, status = 200) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + route, { method, headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken }, ...(body === undefined ? {} : { data: body }) });
  assert.equal(response.status(), status, await response.text()); return response.json();
}
async function snap(name, locator) {
  const filename = path.join(directory, name + '.png');
  if (locator) await locator.screenshot({ path: filename }); else await page.screenshot({ path: filename, fullPage: false });
  screenshots.push(filename);
}
async function closeAlert(title) {
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.getByRole('button', { name: '确定', exact: true }).click();
}
async function showAdvanced(show) {
  const action = page.getByRole('button', { name: show ? '显示换算字段' : '收起换算字段', exact: true });
  if (await action.count()) await action.click();
}
async function loaded(expected = 5) {
  await workspace().waitFor(); await waitUntil(async () => await rows().count() === expected, 20000, 'all seeded point rows loaded');
  await waitUntil(async () => !(await saveButton().innerText()).includes('正在'), 10000, 'point editor ready');
}
async function makePage(context, username = info.username, password = info.password) {
  page = await context.newPage(); page.setDefaultTimeout(20000);
  // The display-only fixture intentionally does not copy the Windows voice
  // enumeration helper. Stub just that read-only list, never save or playback.
  await page.route('**/api/voice/voices', route => {
    assert.equal(route.request().method(), 'GET'); stubbedVoiceEnumerations++;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, supported: false, voices: [] }) });
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push({ text: message.text(), expectedInjectedFailure: injectingFailure, location: message.location() }); });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
      const body = request.postDataJSON(); mutations.push({ path: pathname, method: request.method(), body: pathname.startsWith('/api/admin-auth/') ? { username: body?.username } : body, expectedInjectedFailure: injectingFailure });
    }
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(username);
  await page.getByLabel('后台密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click(); await loaded();
  return page;
}
async function contextFor(width, textSize) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.addInitScript(({ textSize }) => {
    if (textSize !== 115) localStorage.setItem('digital_twin_admin_reading_v1', JSON.stringify({ textSize }));
    localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'data-center', dataCenterSection: 'mapping', selectedDeviceForPoints: 'all', pointsSubpage: 'mapping' }));
  }, { textSize }); return context;
}
async function audit(name, width, textSize) {
  await page.mouse.move(0, 0);
  const scroll = workspace().locator('.point-table-scroll');
  await scroll.evaluate(el => { el.scrollLeft = 0; });
  const result = await workspace().evaluate((workspace, args) => {
    const visible = el => !!el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
    const describe = el => `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')}`;
    const scroll = workspace.querySelector('.point-table-scroll'), table = scroll.querySelector('.point-mapping-table');
    const sr = scroll.getBoundingClientRect();
    const pointRows = [...table.querySelectorAll('tbody tr.point-mapping-row')].map(row => {
      const r = row.getBoundingClientRect();
      const device = row.querySelector('.point-device-trigger');
      return { id: row.dataset.pointId, left: r.left, right: r.right, width: r.width, scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
        top: r.top, bottom: r.bottom, height: r.height, cells: row.cells.length,
        deviceCaption: { text: device.querySelector('span').textContent.trim(), title: device.getAttribute('title') },
        controls: [...row.querySelectorAll('input,select,button,summary')].filter(visible).map(el => {
          const box = el.getBoundingClientRect();
          const name = (el.getAttribute('aria-label') || [...(el.labels || [])].map(label => label.textContent).join(' ') || el.textContent || el.getAttribute('title') || '').trim();
          return { selector: describe(el), name, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            centerY: (box.top + box.bottom) / 2, width: box.width, fontSize: parseFloat(getComputedStyle(el).fontSize), disabled: el.disabled,
            color: getComputedStyle(el).color, shortNativeSelect: el.matches('.point-short-select > select') };
        }) };
    });
    // The explicit table region is allowed to scroll at narrow/high-font and
    // advanced settings. No other page region may acquire horizontal scrolling.
    const horizontalScrollRegions = [...workspace.querySelectorAll('*')].filter(el => visible(el) && !el.matches('input,select,textarea,option,button,svg,path') && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && ['auto','scroll'].includes(getComputedStyle(el).overflowX))
      .map(el => ({ selector: describe(el), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
    return { ...args, actualScale: Number(getComputedStyle(document.documentElement).getPropertyValue('--admin-font-scale')), zoom: visualViewport.scale,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, rows: pointRows, horizontalScrollRegions,
      scrollRegion: { role: scroll.getAttribute('role'), name: scroll.getAttribute('aria-label'), left: sr.left, right: sr.right,
        clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
        overflowX: getComputedStyle(scroll).overflowX }, tableWidth: table.getBoundingClientRect().width };
  }, { name, width, textSize });
  audits.push(result);
  assert.ok(Math.abs(result.actualScale - textSize / 100) < .001, 'the chosen persisted font scale must be respected'); assert.ok(Math.abs(result.zoom - 1) < .001);
  assert.equal(result.rows.length, 5); assert.ok(result.pageWidth <= width + 2, `${name} document horizontally overflows ${result.pageWidth}`);
  assert.equal(result.scrollRegion.role, 'region'); assert.equal(result.scrollRegion.name, '点位配置列表');
  assert.ok(result.scrollRegion.left >= 0 && result.scrollRegion.right <= width + 2, `${name} table scroll region exceeds page`);
  assert.ok(result.horizontalScrollRegions.length <= 1 && result.horizontalScrollRegions.every(region => /\.point-table-scroll(?:\.|$)/.test(region.selector)), `${name} horizontal scrolling must be limited to the explicit table region: ${JSON.stringify(result.horizontalScrollRegions)}`);
  const mustFitWithoutHorizontalDrag = textSize === 115 && width >= 1366 && name.endsWith('-common');
  const advanced = name.endsWith('-advanced');
  const transparent = color => color === 'transparent' || /^rgba\([^)]*,\s*0(?:\.0+)?\)$/.test(color) || /\/\s*0(?:\.0+)?\s*\)$/.test(color);
  if (mustFitWithoutHorizontalDrag) assert.ok(result.scrollRegion.scrollWidth <= result.scrollRegion.clientWidth + 2, `${name} common columns require horizontal dragging: ${JSON.stringify(result.scrollRegion)}`);
  for (const point of result.rows) {
    const expectedDeviceName = point.id === String(pointIds.peer) ? '设备B' : '现场设备A · 温控与传动完整名称';
    assert.equal(point.deviceCaption.text, expectedDeviceName, 'the first column contains only the device name');
    assert.ok(!/[\\/]/.test(point.deviceCaption.text), 'the compact caption never falls back to a hierarchy path');
    assert.ok(point.deviceCaption.title.includes('默认车间') && point.deviceCaption.title.includes(' / ') && point.deviceCaption.title.endsWith(expectedDeviceName), 'hover title preserves the full hierarchy and device name');
    assert.ok(Math.abs(point.width - result.tableWidth) < 2, 'every point is exactly one full-width table row');
    assert.equal(point.cells, advanced ? 14 : 11, 'all original point columns remain cells of one tr');
    const centers = point.controls.map(control => control.centerY);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 2, `${name} must not split a point into stacked lines: ${JSON.stringify(point)}`);
    assert.equal(point.controls.length, (point.id === String(pointIds.alarm) ? 11 : 10) + (advanced ? 3 : 0), 'all common fields and operations remain represented exactly once');
    for (const control of point.controls) {
      if (control.shortNativeSelect) assert.ok(transparent(control.color), `${name} native selected text must remain transparent, including disabled/read-only states: ${JSON.stringify(control)}`);
      assert.ok(control.name, 'each field/control has a visible or accessible label');
      assert.ok(control.left >= point.left - 1 && control.right <= point.right + 1 && control.top >= point.top - 1 && control.bottom <= point.bottom + 1 && control.width > 20, `${name} clipped ${JSON.stringify(control)}`);
      assert.ok(control.fontSize >= 12 * textSize / 100 - .1, `${name} must not downscale ${JSON.stringify(control)}`);
    }
  }
  // Scroll-reach every displayed input/select/action inside the only explicit
  // horizontal region, without touching Vue state or changing field values.
  const controls = workspace().locator('.point-mapping-row input:visible,.point-mapping-row select:visible,.point-mapping-row button:visible');
  for (let index = 0; index < await controls.count(); index++) {
    const control = controls.nth(index);
    const reached = await control.evaluate(async el => {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = el.getBoundingClientRect(), scroller = el.closest('.point-table-scroll'), sr = scroller.getBoundingClientRect();
      return { selector: `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, '.')}`,
        name: (el.getAttribute('aria-label') || [...(el.labels || [])].map(label => label.textContent).join(' ') || el.textContent || '').trim(),
        id: el.closest('.point-mapping-row')?.dataset.pointId, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        regionLeft: sr.left, regionRight: sr.right, scrollLeft: scroller.scrollLeft, documentScrollLeft: document.documentElement.scrollLeft,
        viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    assert.ok(reached.left >= reached.regionLeft - 1 && reached.right <= reached.regionRight + 1 && reached.top >= -1 && reached.bottom <= reached.viewportHeight + 1 && reached.documentScrollLeft === 0,
      `${name} field/action is reachable in the explicit table region: ${JSON.stringify(reached)}`);
  }
  await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await snap(name + '-right-actions');
  await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('.admin-content,.admin-main,.table-scroll,.point-table-scroll')) { el.scrollTop = 0; el.scrollLeft = 0; } document.activeElement?.blur?.(); });
  await snap(name); await snap(name + '-table', scroll);
  fs.writeFileSync(path.join(directory, 'audit.json'), JSON.stringify(audits, null, 2));
  check(`${name}: persisted text scale, one line per point, original fields, device-only captions/full-path titles, transparent native selected text, sole explicit horizontal region and right-end actions reachable${mustFitWithoutHorizontalDrag ? '; common view fits without horizontal dragging' : ''}`);
}

(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], { cwd: root, env: { ...process.env, MANUAL_LAYOUT_DISPLAY_ONLY: 'true', MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => {
    assert.equal(server.exitCode, null); if (!fs.existsSync(infoFile)) return false;
    try { info = JSON.parse(fs.readFileSync(infoFile, 'utf8')); return Boolean(info.origin && info.database && info.backendPid); }
    catch (error) { if (error instanceof SyntaxError) return false; throw error; }
  }, 60000, 'complete owned collector:false fixture metadata');
  requireTestPath(info.database); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const db = new Database(requireTestPath(info.database));
  try {
    db.prepare('DELETE FROM data_points').run(); db.prepare("UPDATE devices SET plc_enabled=0,plc_protocol='S7'").run();
    db.prepare('UPDATE devices SET name=? WHERE id=?').run('现场设备A · 温控与传动完整名称', info.devices[0]);
    db.prepare('UPDATE devices SET name=? WHERE id=?').run('设备B', info.devices[1]);
    const insert = db.prepare(`INSERT INTO data_points (device_id,name,label,plc_tag,data_type,point_kind,category,value_role,scale,offset,expression,display_format,unit,alarm_text,voice_config) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const rows = [
      ['real', info.devices[0], 'qa_real', '实际温度', 'DB90.DBD0', 'REAL', 'normal', 'analog', .125, -2.5, 'raw * 0.125 - 2.5', '0.00', '°C', ''],
      ['string', info.devices[0], 'qa_string', '配方名称 STRING', 'DB90,S20.32', 'STRING', 'normal', 'analog', 1, 0, '', '', '', ''],
      ['bool', info.devices[0], 'qa_bool', '运行状态 BOOL', 'DB90.DBX80.0', 'BOOL', 'normal', 'status', 1, 0, '', '', '', ''],
      ['alarm', info.devices[0], 'bj1', '报警触发 BOOL', 'DB90.DBX80.1', 'BOOL', 'alarm', 'status', 1, 0, '', '', '', '风机过热报警：请检查现场设备'],
      ['peer', info.devices[1], 'qa_peer', '第二设备温度', 'DB90.DBD0', 'REAL', 'normal', 'analog', 1, 0, '', '0.0', '°C', '']
    ];
    for (const [key, deviceId, name, label, tag, type, kind, category, scale, offset, expression, format, unit, alarm] of rows) pointIds[key] = Number(insert.run(deviceId, name, label, tag, type, kind, category, name, scale, offset, expression, format, unit, alarm, JSON.stringify({ enabled: false, rules: [] })).lastInsertRowid);
  } finally { db.close(); }
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  let mainContext, mainPage;
  for (const textSize of [115, 200]) for (const width of [1440, 1366, 1024]) {
    const context = await contextFor(width, textSize); await makePage(context);
    assert.equal(await page.locator('#points-panel-mapping .points-table').count(), 1, 'every point remains one table row');
    assert.equal(await page.locator('.point-mapping-card,.point-fields-main,.point-fields-secondary,.point-fields-advanced').count(), 0, 'no stacked point cards or grouped field rows');
    assert.equal(await page.getByLabel('筛选点位设备', { exact: true }).inputValue(), 'all');
    await showAdvanced(false);
    for (const id of Object.values(pointIds)) {
      const entry = row(id); for (const selector of ['.point-name-input', '.point-usage-input', '.point-datatype-select', '.plc-address-input', '.sample-input', '.access-input', '.voice-config-button']) assert.equal(await entry.locator(selector).count(), 1, selector);
      assert.equal(await entry.getByRole('button', { name: '选择点位所属设备', exact: true }).count(), 1);
    }
    assert.equal(await row(pointIds.string).locator('.point-datatype-select').inputValue(), 'STRING'); assert.equal(await row(pointIds.bool).locator('.point-datatype-select').inputValue(), 'BOOL');
    assert.equal(await row(pointIds.real).locator('.point-short-select').nth(0).locator('span').innerText(), '监控');
    assert.equal(await row(pointIds.real).locator('.point-short-select').nth(1).locator('span').innerText(), 'REAL');
    assert.equal(await row(pointIds.alarm).locator('.point-short-select').first().locator('span').innerText(), '报警');
    assert.ok((await row(pointIds.real).locator('.point-datatype-select').locator('option[value="REAL"]').innerText()).includes('浮点数'), 'native options keep their full descriptions');
    const selectedDevice = row(pointIds.real).getByRole('button', { name: '选择点位所属设备', exact: true });
    assert.equal((await selectedDevice.innerText()).trim(), '现场设备A · 温控与传动完整名称');
    assert.ok((await selectedDevice.getAttribute('title')).includes('默认车间'), 'the compact device label keeps the full hierarchy in its title');
    assert.equal(await row(pointIds.alarm).locator('.point-usage-input').inputValue(), 'alarm_trigger'); assert.equal(await row(pointIds.alarm).locator('.alarm-text-input').inputValue(), '风机过热报警：请检查现场设备');
    assert.equal(await row(pointIds.bool).getByLabel('单位', { exact: true }).isDisabled(), true);
    await audit(`${textSize}-${width}-common`, width, textSize);
    await showAdvanced(true); assert.equal(Number(await row(pointIds.real).getByLabel('换算倍率', { exact: true }).inputValue()), .125); assert.equal(Number(await row(pointIds.real).getByLabel('偏移修正', { exact: true }).inputValue()), -2.5); assert.equal(await row(pointIds.real).getByLabel('显示小数', { exact: true }).inputValue(), '0.00');
    await audit(`${textSize}-${width}-advanced`, width, textSize); await showAdvanced(false);
    if (textSize === 115 && width === 1440) { mainContext = context; mainPage = page; } else await context.close();
  }
  page = mainPage; await loaded();
  const shortDevice = row(pointIds.peer).getByRole('button', { name: '选择点位所属设备', exact: true });
  await shortDevice.hover(); await page.waitForTimeout(1000);
  await snap('functional-short-device-name-native-title', row(pointIds.peer));
  const deviceTitleEvidence = { deviceName: await shortDevice.locator('span').innerText(), nativeHoverTitle: await shortDevice.getAttribute('title'), hovered: true, note: 'Headless page screenshots do not reliably render OS-native title tooltips; the actual native title is asserted and a full-path dropdown is captured without modifying UI.' };
  fs.writeFileSync(path.join(directory, 'device-title-evidence.json'), JSON.stringify(deviceTitleEvidence, null, 2));
  await shortDevice.click(); const shortDeviceOptions = page.getByRole('region', { name: '点位设备选项', exact: true }); await shortDeviceOptions.waitFor();
  const shortSelectedOption = shortDeviceOptions.getByRole('option', { selected: true }); assert.equal(await shortSelectedOption.locator('span').innerText(), deviceTitleEvidence.nativeHoverTitle);
  await snap('functional-short-device-full-path-options', shortDeviceOptions); await page.keyboard.press('Escape');
  check('short device name is readable on its own, long device names never become paths, and real native hover titles/full-path selection options remain intact');
  const initialPoints = await api('/api/datapoints'), initialDevices = await api('/api/devices'), initialModels = await api('/api/models'), initialCatalog = await api('/api/data-center/catalog');
  const writesBefore = mutations.filter(row => row.path === '/api/datapoints/sync').length;
  await row(pointIds.real).locator('.point-name-input').fill('实际温度 · 布局整理');
  await page.getByTestId('add-data-point').click(); await page.getByTestId('add-data-point').click(); assert.equal(await page.locator('.point-mapping-row.is-new-point').count(), 2);
  const firstNew = page.locator('.point-mapping-row.is-new-point').first(), secondNew = page.locator('.point-mapping-row.is-new-point').last();
  await firstNew.locator('.point-name-input').fill('新增布局验收点位'); await firstNew.locator('.plc-address-input').fill('DB92.DBW0'); await secondNew.locator('.point-name-input').fill('不保存的临时行'); await removeButton(secondNew).click();
  await firstNew.getByRole('button', { name: '选择点位所属设备', exact: true }).click(); const deviceOptions = page.getByRole('region', { name: '点位设备选项', exact: true }); await deviceOptions.waitFor(); await deviceOptions.getByRole('textbox', { name: '搜索点位设备', exact: true }).fill('现场设备A · 温控与传动完整名称'); await deviceOptions.getByRole('option').click();
  assert.equal(await page.locator('.point-mapping-row.is-new-point').count(), 1); await workspace().getByText('存在未保存的修改', { exact: true }).waitFor();
  await snap('functional-new-green-row', firstNew);
  assert.deepEqual(await api('/api/datapoints'), initialPoints); assert.equal(mutations.filter(row => row.path === '/api/datapoints/sync').length, writesBefore);
  check('new/deleted rows and edited labels remain dirty drafts, with stable IDs and no hidden point writes');
  await firstNew.locator('.plc-address-input').fill('DB90.DBD0'); assert.ok(await row(pointIds.real).locator('.has-duplicate').count()); assert.ok(await firstNew.locator('.has-duplicate').count()); assert.match(await firstNew.locator('.plc-address-input').getAttribute('title'), /重复/);
  assert.equal(await row(pointIds.peer).locator('.has-duplicate').count(), 0, 'same address on a different device is not a conflict'); await snap('functional-duplicate-warning', firstNew);
  await firstNew.locator('.plc-address-input').fill('invalid-address'); assert.ok(await firstNew.locator('.has-warning').count()); assert.ok(await firstNew.locator('.plc-address-input').getAttribute('title')); await firstNew.locator('.plc-address-input').fill('DB92.DBW0');
  check('same-device duplicate and invalid PLC-address warnings remain visible/accessibly titled; another device does not cause a false conflict');
  await page.getByLabel('筛选点位设备', { exact: true }).selectOption(info.devices[0]); const dialog = page.getByRole('dialog'); await dialog.waitFor(); await dialog.getByRole('button', { name: '取消', exact: true }).click(); await waitUntil(async () => await page.getByLabel('筛选点位设备', { exact: true }).inputValue() === 'all', 10000, 'canceled device filter restored'); assert.equal(await firstNew.locator('.point-name-input').inputValue(), '新增布局验收点位');
  await row(pointIds.real).locator('.voice-config-button').click(); await page.locator('.voice-config-modal').waitFor(); assert.ok(await page.locator('.voice-config-modal').getByRole('button', { name: '+ 添加播报规则', exact: true }).isEnabled()); await page.locator('.voice-config-modal').getByRole('button', { name: '完成配置', exact: true }).click();
  check('dirty device switching can be canceled without losing row drafts; point voice configuration remains reachable without playing/generating audio');
  await page.route('**/api/datapoints/sync', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '隔离布局验收：点位保存冲突' }) })); injectingFailure = true;
  await saveButton().click(); await closeAlert('保存失败'); injectingFailure = false;
  assert.equal(await firstNew.locator('.point-name-input').inputValue(), '新增布局验收点位'); assert.equal(await row(pointIds.real).locator('.point-name-input').inputValue(), '实际温度 · 布局整理'); assert.deepEqual(await api('/api/datapoints'), initialPoints); await snap('functional-failed-save-drafts'); await page.unroute('**/api/datapoints/sync');
  check('a deliberate409 save failure preserves all edited/new row drafts and leaves the database untouched');
  await saveButton().click(); await closeAlert('点位配置已保存'); await waitUntil(async () => await page.locator('.point-mapping-row.is-new-point').count() === 0, 10000, 'saved IDs assigned');
  let savedPoints = await api('/api/datapoints'); const added = savedPoints.find(point => point.label === '新增布局验收点位'); assert.ok(added?.id); assert.equal(savedPoints.length, initialPoints.length + 1);
  for (const original of initialPoints) { const saved = savedPoints.find(point => point.id === original.id); assert.ok(saved); const expected = { ...original, ...(original.id === pointIds.real ? { label: '实际温度 · 布局整理' } : {}) }; assert.deepEqual(saved, expected, `point ${original.id} technical definition remains stable`); }
  assert.deepEqual(await api('/api/devices'), initialDevices); assert.deepEqual(await api('/api/models'), initialModels);
  const savedCatalog = await api('/api/data-center/catalog'); const beforeBinding = initialCatalog.items.find(item => item.binding?.pointId === String(pointIds.real)), afterBinding = savedCatalog.items.find(item => item.binding?.pointId === String(pointIds.real)); assert.ok(beforeBinding && afterBinding); assert.deepEqual(afterBinding.binding, beforeBinding.binding); assert.deepEqual(afterBinding.tooltipBinding, beforeBinding.tooltipBinding);
  assert.ok(mutations.filter(row => row.path === '/api/datapoints/sync').every(row => row.body.points.every(point => !Object.keys(point).some(key => key.startsWith('__')))));
  check('explicit API save assigns IDs and persists only intended edits/addition; existing address/type/name/unit/conversion/voice bindings, devices and models stay unchanged');
  await page.reload(); await loaded(6); assert.equal(await row(pointIds.real).locator('.point-name-input').inputValue(), '实际温度 · 布局整理'); assert.equal(await row(added.id).locator('.plc-address-input').inputValue(), 'DB92.DBW0');
  await removeButton(row(added.id)).click(); assert.equal((await api('/api/datapoints')).length, 6); await saveButton().click(); await closeAlert('点位配置已保存'); await loaded(); savedPoints = await api('/api/datapoints'); assert.equal(savedPoints.length, 5); assert.ok(!savedPoints.some(point => point.id === added.id)); await snap('functional-saved-reloaded');
  check('reload restores saved rows; deleting a saved row remains a draft until explicit save, without touching peer definitions');
  await api('/api/admin-auth/users', 'POST', { username: 'point_layout_reader', password: info.password, role: 'viewer', permissions: { view: false }, pagePermissions: { points: { view: true, edit: false }, 'points.alarms': { view: true, edit: false } } }, 201);
  const readerContext = await contextFor(1024, 200); await makePage(readerContext, 'point_layout_reader');
  assert.equal(await page.getByTestId('add-data-point').isDisabled(), true); assert.equal(await saveButton().isDisabled(), true);
  for (const id of Object.values(pointIds)) { const entry = row(id); for (const selector of ['.point-name-input', '.point-usage-input', '.point-datatype-select', '.plc-address-input', '.sample-input', '.access-input', '.unit-input']) assert.equal(await entry.locator(selector).isDisabled(), true); assert.equal(await removeButton(entry).isDisabled(), true); assert.equal(await entry.getByRole('button', { name: '选择点位所属设备', exact: true }).isDisabled(), true); }
  assert.equal(await row(pointIds.alarm).locator('.alarm-text-input').isDisabled(), true);
  await audit('200-1024-readonly', 1024, 200); await showAdvanced(true);
  for (const id of Object.values(pointIds)) for (const name of ['换算倍率', '偏移修正', '显示小数']) assert.equal(await row(id).getByLabel(name, { exact: true }).isDisabled(), true);
  await audit('200-1024-readonly-advanced', 1024, 200); await showAdvanced(false);
  await row(pointIds.real).locator('.voice-config-button').click(); await page.locator('.voice-config-modal').waitFor(); assert.equal(await page.locator('.voice-config-modal').getByRole('button', { name: '+ 添加播报规则', exact: true }).isDisabled(), true); await page.locator('.voice-config-modal').getByRole('button', { name: '完成配置', exact: true }).click();
  const denied = await api('/api/datapoints/sync', 'POST', { device_id: info.devices[0], points: savedPoints.filter(point => point.device_id === info.devices[0]) }, 403); assert.ok(denied.error); assert.deepEqual(await api('/api/datapoints'), savedPoints);
  await readerContext.close(); page = mainPage; check('real read-only account can inspect single-line rows/voice rules but cannot change fields, devices, add/delete/save; backend denies writes403');
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors.filter(error => !error.expectedInjectedFailure), []); assert.equal(consoleErrors.filter(error => error.expectedInjectedFailure).length, 1); assert.ok(consoleErrors.every(error => /409/.test(error.text)));
  assert.equal(mutations.filter(row => /\/api\/(plc|engine|collector)(?:\/|$)/.test(row.path)).length, 0);
  assert.equal(mutations.filter(row => /\/api\/voice\/(?:generate|upload)/.test(row.path)).length, 0);
  const voiceEnumerationStub = { route: '/api/voice/voices', method: 'GET', response: { success: true, supported: false, voices: [] }, count: stubbedVoiceEnumerations, reason: 'display-only fixture omits Windows voice enumeration helper; only rule entry and object identity are tested, no audio generation or playback' };
  const result = { success: true, checks, audits, screenshots, errors, consoleErrors, mutations, directory, pointIds, fixtureDatabase: info.database, fixtureBackendPid: info.backendPid, serverPid: server.pid, noPLCCommands: true, noUnity: true, collectorFalse: true, voiceEnumerationStub, deviceTitleEvidence };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ success: true, checks: checks.length, audits: audits.length, screenshots: screenshots.length, directory })); fs.appendFileSync(runLog, JSON.stringify({ success: true, checks: checks.length, audits: audits.length, screenshots: screenshots.length }) + '\n');
  await mainContext.close();
})().catch(async error => { console.error(error); if (page && !page.isClosed()) await snap('failure').catch(() => {}); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, checks, audits, screenshots, errors, consoleErrors, mutations, directory, error: error.stack || String(error), fixtureDatabase: info?.database }, null, 2)); fs.appendFileSync(runLog, 'FAIL ' + error.stack + '\n'); process.exitCode = 1; }).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); fs.appendFileSync(runLog, 'Stopped only the owned fixture server process/tree.\n'); });
