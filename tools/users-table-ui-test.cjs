// Isolated accounts/database only. Never change the operator's real users.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('users-table-ui'), checks = [], errors = [];
let server, browser, page, info;
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function authRequest(route, method = 'GET', data) {
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    return page.request.fetch(info.origin + '/api' + route, { method,
        headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
        ...(data === undefined ? {} : { data }) });
}
async function rowCount(count) { await waitUntil(async () => await page.locator('.users-table tbody tr').count() === count, 10000, count + ' user rows'); }
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'users' })));
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(info.origin + '/admin');
    await page.getByLabel('账号', { exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.locator('.users-settings').waitFor();
    await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增账户', exact: true });
    const cast = dialog.getByRole('checkbox', { name: /投屏管理 选择终端/ });
    const backup = dialog.getByRole('checkbox', { name: /备份操作 创建与下载/ });
    const runtimeView = dialog.getByRole('checkbox', { name: '系统设置 · 运行与投屏 · 查看', exact: true });
    const databaseView = dialog.getByRole('checkbox', { name: '系统设置 · 数据连接与备份 · 查看', exact: true });
    for (const box of [cast, backup, runtimeView, databaseView]) assert.equal(await box.isChecked(), true);
    await cast.uncheck(); assert.equal(await runtimeView.isChecked(), false);
    await cast.check(); assert.equal(await runtimeView.isChecked(), true);
    await backup.uncheck(); assert.equal(await databaseView.isChecked(), false);
    await backup.check(); assert.equal(await databaseView.isChecked(), true);
    await runtimeView.uncheck(); assert.equal(await cast.isChecked(), false);
    await cast.check();
    for (const pageName of ['运行与投屏', '数据连接与备份']) {
        assert.equal(await dialog.getByRole('checkbox', { name: `系统设置 · ${pageName} · 新增 / 修改 / 导入`, exact: true }).isChecked(), false);
    }
    await dialog.getByRole('button', { name: '清空后台授权', exact: true }).click();
    assert.equal(await cast.isChecked(), false); assert.equal(await backup.isChecked(), false);
    await cast.check(); await backup.check();
    await dialog.getByLabel('登录账号', { exact: true }).fill('快捷用户');
    await dialog.getByLabel('显示名称', { exact: true }).fill('快捷用户');
    await dialog.getByLabel('初始密码', { exact: true }).fill('246813');
    await dialog.screenshot({ path: path.join(directory, '01-linked-capabilities.png') });
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await rowCount(1);
    const getUsers = async () => (await (await authRequest('/admin-auth/users')).json()).users;
    const user = (await getUsers()).find(user => user.username === '快捷用户');
    assert.equal(user.pagePermissions['settings.runtime'].view, true); assert.equal(user.pagePermissions['settings.database'].view, true);
    assert.equal(user.pagePermissions['settings.runtime'].edit, false); assert.equal(user.pagePermissions['settings.database'].edit, false);
    check('capability checkboxes and corresponding page reads stay linked; clear presets and explicit page denial also clear the shortcut without granting settings edits');

    await page.getByRole('button', { name: '管理账户', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑账户 · 快捷用户', exact: true });
    assert.equal(await edit.getByText(/启用此账户|启用该账户/).count(), 0);
    await edit.getByRole('button', { name: '关闭', exact: true }).click();
    const securityFile = path.join(info.directory, 'data', 'admin-security.json');
    const before = JSON.parse(fs.readFileSync(securityFile)).users.find(user => user.username === '快捷用户');
    const customerLogin = await context.request.post(info.origin + '/api/admin-auth/login', { headers: { Origin: info.origin, 'X-Admin-Request': '1' },
        data: { username: '快捷用户', password: '246813' } });
    // The shared context was switched; return to the owner's saved slot before
    // testing administration, retaining the customer cookie to test revocation.
    assert.equal(customerLogin.status(), 200);
    const accounts = (await (await context.request.get(info.origin + '/api/admin-auth/accounts')).json()).accounts;
    const customerSlot = accounts.find(account => account.user?.username === '快捷用户');
    const ownerSlot = accounts.find(account => account.user?.username === 'admin');
    await context.request.post(info.origin + '/api/admin-auth/accounts/activate', { headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': ownerSlot.csrfToken }, data: { slotId: ownerSlot.slotId } });
    const toggle = page.getByRole('switch', { name: '启用账户：快捷用户', exact: true });
    const mutation = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith(`/admin-auth/users/${user.id}`));
    await toggle.click(); assert.deepEqual((await mutation).postDataJSON(), { enabled: false });
    await waitUntil(async () => await toggle.getAttribute('aria-checked') === 'false', 10000, 'account disabled');
    const after = JSON.parse(fs.readFileSync(securityFile)).users.find(user => user.username === '快捷用户');
    assert.deepEqual({ ...after, enabled: before.enabled }, before);
    const revoked = await context.request.post(info.origin + '/api/admin-auth/accounts/activate', { headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': customerSlot.csrfToken }, data: { slotId: customerSlot.slotId } });
    assert.equal(revoked.status(), 401);
    await toggle.focus(); await page.keyboard.press('Space');
    await waitUntil(async () => await toggle.getAttribute('aria-checked') === 'true', 10000, 'keyboard enabled');
    assert.equal((await getUsers()).find(user => user.username === '快捷用户').enabled, true);
    check('enable control is an accessible keyboard-operable capsule in the table; its narrow patch preserves every other field and disabling revokes the customer session');
    await page.route(`**/api/admin-auth/users/${user.id}`, route => route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture update failed"}' }) : route.continue());
    await toggle.click(); await page.getByRole('alert').filter({ hasText: 'fixture update failed' }).waitFor();
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await page.unroute(`**/api/admin-auth/users/${user.id}`);
    check('failed enable updates show a message and do not fake a changed switch state');

    for (let index = 1; index <= 20; index++) {
        const response = await authRequest('/admin-auth/users', 'POST', { username: `分页用户${String(index).padStart(2, '0')}`, displayName: `分页用户${index}`, role: 'viewer', password: '246813' });
        assert.equal(response.status(), 201);
    }
    await page.getByRole('button', { name: '刷新列表', exact: true }).click(); await rowCount(10);
    const pager = page.getByRole('navigation', { name: '用户分页', exact: true });
    await pager.getByRole('button', { name: '末页', exact: true }).click(); await rowCount(1);
    assert.match(await pager.textContent(), /第 3 \/ 3 页/);
    await pager.getByRole('button', { name: '上一页', exact: true }).click(); await rowCount(10);
    await pager.getByRole('button', { name: '首页', exact: true }).click();
    assert.equal(await pager.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
    await pager.getByRole('button', { name: '第 2 页', exact: true }).click(); await rowCount(10);
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await waitUntil(async () => /第 2 \/ 3 页/.test(await pager.textContent()), 10000, 'refresh preserves current page');
    await pager.getByLabel('用户每页条数').selectOption('20'); await rowCount(20);
    assert.match(await pager.textContent(), /第 1 \/ 2 页/);
    await pager.getByRole('button', { name: '末页', exact: true }).click(); await rowCount(1);
    await page.locator('.users-table tbody tr').getByRole('button', { name: '管理账户', exact: true }).click();
    await page.getByRole('button', { name: '删除账户', exact: true }).click();
    await page.getByRole('button', { name: '确认删除此账户', exact: true }).click();
    await page.locator('.user-editor-backdrop').waitFor({ state: 'hidden' });
    await rowCount(20); assert.match(await pager.textContent(), /第 1 \/ 1 页/);
    assert.equal(await pager.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
    await pager.getByLabel('用户每页条数').selectOption('10'); await rowCount(10);
    await page.screenshot({ path: path.join(directory, '02-users-table-pagination.png'), fullPage: true });
    await page.setViewportSize({ width: 720, height: 900 });
    await pager.screenshot({ path: path.join(directory, '03-narrow-pagination.png') });
    check('first/previous/numbered/next/last pagination, page-size changes, refresh retention and last-page deletion all clamp correctly; controls wrap on narrow screens');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
