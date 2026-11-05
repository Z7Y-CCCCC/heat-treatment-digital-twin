// Real UI/HTTP verification against an owned output/ fixture, never the live site.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
let server, browser, page;
const directory = createRunDirectory('points-tabs-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: root, env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'isolated UI server');
    const info = JSON.parse(fs.readFileSync(infoFile)); requireTestPath(info.database);
    assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const deviceId = info.devices[0], db = new Database(info.database);
    db.prepare('DELETE FROM data_points WHERE device_id=?').run(deviceId);
    db.prepare("UPDATE devices SET plc_protocol='S7',plc_enabled=0 WHERE id=?").run(deviceId);
    const insert = db.prepare(`INSERT INTO data_points (device_id,name,label,plc_tag,data_type,sample_interval_ms,access_type,point_kind,alarm_text)
        VALUES (?,?,?,?,?,1000,'READ',?,?)`);
    for (let i = 1; i <= 28; i++) insert.run(deviceId, `qa_normal_${i}`, `验收点位 ${i}`, `DB10.DBW${i * 2}`, 'WORD', 'normal', '');
    for (let i = 1; i <= 2; i++) insert.run(deviceId, `bj${i}`, `bj${i}`, `DB10.DBX0.${i - 1}`, 'BOOL', 'alarm', `原报警 ${i}`);
    db.close();
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const makePage = async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addInitScript(({ deviceId }) => {
            if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
                activeTab: 'points', selectedDeviceForPoints: deviceId, pointsSubpage: 'mapping'
            }));
        }, { deviceId });
        const target = await context.newPage(); target.setDefaultTimeout(30000); target.on('pageerror', error => errors.push(error.message));
        return target;
    };
    const login = async (target, username) => {
        await target.goto(info.origin + '/admin');
        await target.getByRole('textbox', { name: '账号', exact: true }).fill(username);
        await target.getByLabel('后台密码', { exact: true }).fill(info.password);
        await target.getByRole('button', { name: '解锁后台', exact: true }).click();
        await target.getByTestId('points-workspace').waitFor();
        await target.locator('.points-pagination-bar').first().getByText('30', { exact: true }).waitFor();
    };
    page = await makePage(); await login(page, info.username);
    const workspace = page.getByTestId('points-workspace'), add = page.getByTestId('add-data-point');
    const contextBar = page.getByRole('region', { name: '当前编辑范围', exact: true });
    const factorySelect = page.getByRole('combobox', { name: '当前编辑工厂', exact: true });
    await waitUntil(() => factorySelect.locator('option:checked').textContent().then(name => name !== '正在读取…'), 10000, 'factory name');
    assert.ok((await contextBar.boundingBox()).height <= 50, 'editor context should occupy a single compact row');
    assert.ok((await contextBar.boundingBox()).width < (await workspace.boundingBox()).width, 'do not stretch an empty context card across the page');
    assert.ok((await factorySelect.boundingBox()).width <= 262);
    assert.deepEqual(await contextBar.locator('.asset-hierarchy-node small').allTextContents(), ['车间', '产线', '设备']);
    assert.equal(await contextBar.locator('.asset-hierarchy-node strong').last().textContent(), '现场设备A');
    assert.equal(await contextBar.locator('.asset-hierarchy-heading,.asset-hierarchy-note').count(), 0);
    await contextBar.screenshot({ path: path.join(directory, '00-compact-edit-context.png') });
    check('edit context is a narrow single row with one factory selector and the current workshop, line and device, without explanatory copy');
    const mapping = page.getByRole('tab', { name: 'PLC 点位映射', exact: true }), alarms = page.getByRole('tab', { name: '报警配置', exact: true });
    const filter = page.getByLabel('筛选点位设备', { exact: true });
    let reads = 0; page.on('request', request => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/datapoints') reads++; });
    const addBox = await add.boundingBox(), tableBox = await page.locator('.points-table').boundingBox(), filterBox = await filter.boundingBox();
    assert.ok(addBox && tableBox && filterBox && addBox.y < tableBox.y && Math.abs(addBox.y - filterBox.y) < 16);
    assert.equal(await add.count(), 1); assert.ok(!await add.isDisabled());
    assert.equal(await page.getByRole('tablist', { name: '点位配置' }).getByRole('tab').count(), 2);
    assert.equal(await mapping.getAttribute('aria-selected'), 'true');
    await workspace.screenshot({ path: path.join(directory, '01-mapping.png') });
    check('add-point action is above the table beside the device filter; mapping and alarms are peer tabs');
    await add.click(); await page.locator('.points-pagination-bar').first().getByText('31', { exact: true }).waitFor();
    const lastRow = page.locator('.points-table tbody tr').last();
    await lastRow.locator('.point-name-input').fill('新增验收点位'); await lastRow.locator('.plc-address-input').fill('DB10.DBW100');
    await page.getByRole('button', { name: '显示换算字段', exact: true }).click();
    const readsBeforeTabs = reads;
    await alarms.click();
    assert.equal(await alarms.getAttribute('aria-selected'), 'true');
    assert.ok(await page.getByRole('tabpanel', { name: '报警配置', exact: true }).isVisible());
    assert.ok(!await page.locator('#points-panel-mapping').isVisible());
    const text = '1 => "验收报警一"\n2 => "验收报警二"';
    await page.locator('.alarm-textarea').fill(text);
    await page.getByText('bj1：验收报警一', { exact: true }).waitFor();
    await page.getByRole('button', { name: '匹配到报警点位', exact: true }).click();
    await page.getByRole('heading', { name: '报警文本已导入', exact: true }).waitFor();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await mapping.click();
    assert.equal(await filter.inputValue(), deviceId);
    assert.equal(await page.locator('.points-table tbody tr').last().locator('.point-name-input').inputValue(), '新增验收点位');
    assert.ok(await page.getByRole('button', { name: '收起换算字段', exact: true }).isVisible());
    assert.equal(reads, readsBeforeTabs, 'switching tabs must not reload or discard the shared draft');
    await alarms.click(); assert.equal(await page.locator('.alarm-textarea').inputValue(), text);
    await workspace.screenshot({ path: path.join(directory, '02-alarms.png') });
    check('normal-point and imported-alarm drafts, device selection, page and display state survive tab switching without extra reads');
    await page.getByTestId('points-savebar').getByRole('button', { name: '保存当前设备配置', exact: true }).click();
    await page.getByRole('heading', { name: '点位配置已保存', exact: true }).waitFor();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    const points = await (await page.request.get(info.origin + `/api/datapoints?device_id=${encodeURIComponent(deviceId)}`)).json();
    assert.equal(points.length, 31); assert.ok(points.some(p => p.label === '新增验收点位' && p.plc_tag === 'DB10.DBW100'));
    assert.equal(points.find(p => p.name === 'bj1').alarm_text, '验收报警一');
    assert.equal(points.find(p => p.name === 'bj2').alarm_text, '验收报警二');
    await mapping.focus(); await page.keyboard.press('End'); assert.equal(await alarms.getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowRight'); assert.equal(await mapping.getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowLeft'); assert.equal(await alarms.getAttribute('aria-selected'), 'true');
    await page.reload(); await workspace.waitFor();
    await waitUntil(() => filter.inputValue().then(value => value === deviceId), 10000, 'restored device filter after options load');
    assert.equal(await alarms.getAttribute('aria-selected'), 'true'); assert.equal(await filter.inputValue(), deviceId);
    check('shared save persists normal points and alarm texts; keyboard navigation and selected-tab persistence work');
    await mapping.click(); await page.setViewportSize({ width: 1000, height: 760 });
    const compactContext = await contextBar.boundingBox();
    assert.ok(compactContext.x + compactContext.width <= 1000 && compactContext.height <= 85);
    assert.ok(await add.isVisible()); assert.ok((await add.boundingBox()).y < (await page.locator('.points-table').boundingBox()).y);
    await page.screenshot({ path: path.join(directory, '03-compact.png'), fullPage: true });
    check('compact desktop keeps add-point above the table');
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const created = await page.request.post(info.origin + '/api/admin-auth/users', { headers: {
        Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken
    }, data: { username: 'points_reader', password: info.password, role: 'viewer', permissions: { view: false }, pagePermissions: { points: { view: true }, 'points.alarms': { view: true } } } });
    assert.equal(created.status(), 201, await created.text());
    const reader = await makePage(); await reader.goto(info.origin + '/admin');
    await reader.getByRole('textbox', { name: '账号', exact: true }).fill('points_reader');
    await reader.getByLabel('后台密码', { exact: true }).fill(info.password);
    await reader.getByRole('button', { name: '解锁后台', exact: true }).click(); await reader.getByTestId('points-workspace').waitFor();
    assert.ok(await reader.getByTestId('add-data-point').isDisabled());
    await reader.getByRole('tab', { name: '报警配置', exact: true }).click();
    assert.ok(await reader.locator('.alarm-textarea').isDisabled());
    assert.ok(await reader.getByRole('button', { name: '匹配到报警点位', exact: true }).isDisabled());
    assert.equal(await reader.locator('.page-readonly-notice').count(), 0);
    await reader.getByRole('tab', { name: 'PLC 点位映射', exact: true }).click();
    await reader.getByLabel('筛选点位设备', { exact: true }).selectOption('all');
    const readonlyPicker=reader.getByRole('button',{name:'选择点位所属设备',exact:true}).first();
    await readonlyPicker.waitFor();assert.ok(await readonlyPicker.isDisabled());
    check('read-only users can switch both tabs but cannot add, import or save edits');
    const alarmAccount = await page.request.post(info.origin + '/api/admin-auth/users', { headers: {
        Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken
    }, data: { username: 'alarm_editor', password: info.password, role: 'viewer', permissions: { view: false }, pagePermissions: { 'points.alarms': { view: true, edit: true } } } });
    assert.equal(alarmAccount.status(), 201, await alarmAccount.text());
    const alarmOnly = await makePage(); await alarmOnly.goto(info.origin + '/admin');
    await alarmOnly.getByRole('textbox', { name: '账号', exact: true }).fill('alarm_editor');
    await alarmOnly.getByLabel('后台密码', { exact: true }).fill(info.password);
    await alarmOnly.getByRole('button', { name: '解锁后台', exact: true }).click();
    await alarmOnly.getByTestId('points-workspace').waitFor();
    assert.equal(await alarmOnly.getByRole('tab', { name: 'PLC 点位映射', exact: true }).count(), 0);
    assert.equal(await alarmOnly.getByRole('tab', { name: '报警配置', exact: true }).getAttribute('aria-selected'), 'true');
    await alarmOnly.locator('.alarm-textarea').fill('1 => "仅报警编辑验收"');
    await alarmOnly.getByRole('button', { name: '匹配到报警点位', exact: true }).click();
    await alarmOnly.getByRole('heading', { name: '报警文本已导入', exact: true }).waitFor();
    await alarmOnly.getByRole('button', { name: '确定', exact: true }).click();
    const alarmResponse = alarmOnly.waitForResponse(response => new URL(response.url()).pathname === '/api/datapoints/alarm-texts' && response.request().method() === 'POST');
    await alarmOnly.getByTestId('points-savebar').getByRole('button', { name: '保存当前设备配置', exact: true }).click();
    assert.equal((await alarmResponse).status(), 200);
    await alarmOnly.getByRole('heading', { name: '报警文本已保存', exact: true }).waitFor();
    await alarmOnly.getByRole('button', { name: '确定', exact: true }).click();
    const alarmSaved = await (await page.request.get(info.origin + `/api/datapoints?device_id=${encodeURIComponent(deviceId)}`)).json();
    assert.deepEqual(alarmSaved, points.map(p => p.name === 'bj1' ? { ...p, alarm_text: '仅报警编辑验收' } : p));
    check('alarm-only account sees only its authorized tab and saves text without changing PLC definitions');

    // Simulate the next server page registration while a real editor is open.
    // Only the test response is extended; no live registry or user grants are written.
    let registerNewPage = false, catalogReads = 0;
    await page.route('**/api/admin-auth/page-catalog', async route => {
        const response = await route.fetch(), body = await response.json(); catalogReads++;
        if (registerNewPage) body.pages.push({ key: 'points.qa-page', label: '点位映射 · 新增验收标签', ownerOnly: false,
            actions: ['view', 'edit'], container: 'points', subpage: 'qa-page', tabLabel: '新增验收标签' });
        await route.fulfill({ response, json: body });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '用户与权限', exact: true }).click();
    await page.getByRole('button', { name: '管理账户', exact: true }).first().click();
    const matrix = page.locator('.page-permission-table');
    const liveCatalog = await (await page.request.get(info.origin + '/api/admin-auth/page-catalog')).json();
    assert.equal(await matrix.locator('tbody tr').count(), liveCatalog.pages.filter(item => !item.retired).length);
    assert.ok(await matrix.getByRole('rowheader', { name: '点位映射 · 报警配置', exact: true }).isVisible());
    const modelView = page.getByRole('checkbox', { name: '模型库 · 模型管理 · 查看', exact: true });
    await modelView.check();
    const readsBeforeRegistration = catalogReads;
    registerNewPage = true;
    const addedView = page.getByRole('checkbox', { name: '点位映射 · 新增验收标签 · 查看', exact: true });
    await addedView.waitFor({ timeout: 12000 });
    assert.ok(catalogReads > readsBeforeRegistration, 'the editor polls without a manual refresh');
    assert.ok(!await addedView.isChecked());
    assert.ok(await page.getByRole('checkbox', { name: '点位映射 · 新增验收标签 · 新增 / 修改 / 导入', exact: true }).isDisabled());
    assert.ok(await modelView.isChecked(), 'unsaved permissions survive the catalog update');
    await addedView.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, '04-live-permission-catalog.png') });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    check('an open permissions matrix automatically adds registered subpages, defaults to deny and preserves unsaved checkbox edits');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
