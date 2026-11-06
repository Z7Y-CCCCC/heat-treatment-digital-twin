'use strict';
// Retirement regression: the custom model-animation editor is gone. A legacy
// package is prepared only in this disposable fixture, never through the UI.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('custom-motion-editor-removal-browser'), checks = [], errors = [], authoringRequests = [];
let helper, browser, page;
const check = message => { checks.push(message); console.log('PASS ' + message); };
(async () => {
    const infoFile = path.join(directory, 'server.json');
    helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'motion-authoring-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MOTION_AUTHORING_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log')
    });
    await waitUntil(() => { assert.equal(helper.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned display-only backend');
    const info = JSON.parse(fs.readFileSync(infoFile));
    const headers = { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie, 'X-CSRF-Token': info.session.csrfToken };
    const api = async (route, method = 'GET', body) => {
        const response = await fetch(info.origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const route = `/api/models/${info.modelId}/motion-actions`, original = await api(route);
    const node = original.nodes.find(n => n.name.endsWith('roller_bed_metal')); assert.ok(node);
    const action = {
        id: 'user_legacy_preserved', label: '既有承料台抬升', mode: 'position', duration: 2, cycle: 'forward',
        tracks: [{ nodeId: node.id, operation: 'translate', axis: 'y', from: 0, to: .4, start: 0, end: 1, easing: 'linear', pivot: [0, 0, 0], fromColor: '#000000', toColor: '#ffffff' }]
    };
    const seeded = await api(route, 'PUT', { revision: original.revision, actions: [action] });
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'model-animations' })));
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/api\/models\/[^/]+\/motion-actions(?:\/|\?|$)/.test(request.url())) authoringRequests.push(request.method() + ' ' + request.url()); });
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const modes = page.getByRole('navigation', { name: '动作动画模式' }), transfer = page.getByRole('group', { name: '动作包导入导出' });
    await modes.waitFor();
    assert.deepEqual(await modes.getByRole('button').allTextContents(), ['实时联动', '部件动作', '设备联动']);
    assert.equal(await page.getByRole('region', { name: '工艺动作编辑器' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '新增工艺动作' }).count(), 0);
    for (const width of [1600, 1024]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const label of ['设备联动', '实时联动', '部件动作']) {
            await modes.getByRole('button', { name: label, exact: true }).click();
            assert.equal(await modes.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
            assert.equal(await transfer.getByRole('button').count(), 2);
            assert.equal(await page.locator('.motion-author').count(), 0);
        }
        await page.getByLabel('选择动作动画模型', { exact: true }).selectOption(info.modelId);
        await page.screenshot({ path: path.join(directory, `01-three-modes-${width}.png`), fullPage: true });
    }
    check('custom animation entry/editor removed; all three retained modes and package controls work at wide and narrow widths');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await modes.getByRole('button', { name: '实时联动', exact: true }).click();
    const live = page.getByRole('region', { name: '设备实时动画联动' });
    await live.getByRole('button', { name: /备料台 · 动作验收/ }).click();
    await live.getByRole('button', { name: /既有承料台抬升/ }).click();
    await live.getByRole('switch', { name: '启用动作联动' }).check();
    const catalog = await api('/api/data-center/catalog?device_id=' + info.deviceId);
    const dataItem = catalog.items.find(item => item.binding?.pointId === info.pointId); assert.ok(dataItem);
    await live.getByLabel('动作驱动数据项', { exact: true }).selectOption(dataItem.id);
    await live.getByRole('button', { name: '保存并同步', exact: true }).click();
    await live.getByText('已保存，Unity 自动同步', { exact: true }).waitFor();
    await live.getByRole('button', { name: '运行状况', exact: true }).click();
    await fetch(info.control, { method: 'POST', body: JSON.stringify({ value: 1 }) });
    await live.locator('.health-list').getByText('运行', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, '02-legacy-action-live.png'), fullPage: true });
    await fetch(info.control, { method: 'POST', body: JSON.stringify({ offline: true }) });
    await live.locator('.health-list').getByText('数据无效', { exact: true }).waitFor();
    await fetch(info.control, { method: 'POST', body: JSON.stringify({ offline: false, value: 0 }) });
    await live.locator('.health-list').getByText('停止', { exact: true }).waitFor();
    check('previously saved action still binds to prepared data and handles fresh, invalid and recovered read frames');
    await live.getByRole('button', { name: /备料台 · 独立实例/ }).click();
    await live.getByRole('button', { name: '动作绑定', exact: true }).click();
    assert.equal(await live.getByRole('switch', { name: '启用动作联动' }).isChecked(), false);
    check('same-model peer device remains independently unbound');
    await modes.getByRole('button', { name: '部件动作', exact: true }).click();
    await page.reload(); await modes.waitFor();
    assert.deepEqual(await modes.getByRole('button').allTextContents(), ['实时联动', '部件动作', '设备联动']);
    const preserved = await api(route);
    assert.equal(preserved.revision, seeded.revision);
    assert.deepEqual(preserved.actions, seeded.actions);
    assert.deepEqual(preserved.model.motion_package, seeded.model.motion_package);
    assert.deepEqual(authoringRequests, []);
    assert.deepEqual(errors, []);
    check('reload cannot revive editor; existing model package unchanged; no custom-editor requests or page errors');
    const result = { success: true, checks, directory, errors, authoringRequests, noCollectorOrSiteChanges: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(helper); });
