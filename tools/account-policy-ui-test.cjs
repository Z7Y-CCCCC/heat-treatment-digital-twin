// Owned fixture only; never create users or change passwords on the live backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('account-policy-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    const info = JSON.parse(fs.readFileSync(infoFile));
    assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const owner = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await owner.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'users' })));
    page = await owner.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('admin');
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.locator('.users-settings').waitFor();
    await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增账户', exact: true });
    const username = dialog.getByLabel('登录账号', { exact: true });
    const initial = dialog.getByLabel('初始密码', { exact: true });
    for (const name of ['张三', '普通用户1', '值班员_A-1']) {
        await username.fill(name); assert.ok(await username.evaluate(el => el.checkValidity()), name);
    }
    await username.fill('无效 用户'); assert.ok(!(await username.evaluate(el => el.checkValidity())));
    await username.fill('普通用户1');
    await dialog.getByLabel('显示名称', { exact: true }).fill('中文登录验收');
    await dialog.getByRole('checkbox', { name: '模型库 · 模型管理 · 查看', exact: true }).check();
    assert.equal(await initial.getAttribute('minlength'), '6');
    let creates = 0;
    page.on('request', request => { if (request.url() === info.origin + '/api/admin-auth/users' && request.method() === 'POST') creates++; });
    await initial.fill('12345');
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click();
    assert.ok(await initial.evaluate(el => el.validity.tooShort));
    assert.equal(creates, 0);
    await initial.fill('246813');
    await username.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, '01-chinese-account-six-character-password.png') });
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(creates, 1);
    const row = page.locator('.users-table tbody tr').filter({ hasText: '普通用户1' });
    await row.getByText('中文登录验收', { exact: true }).waitFor();
    check('Chinese and mixed usernames pass native validation; five-character passwords cannot submit; six-character creation persists');

    await row.getByRole('button', { name: '管理账户', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑账户 · 普通用户1', exact: true });
    const reset = edit.getByLabel('重设密码', { exact: true });
    assert.equal(await reset.getAttribute('minlength'), '6');
    await reset.fill('135792');
    await edit.getByRole('button', { name: '保存修改', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    check('administrator resets a Chinese account to another six-character password through the real editor');

    const customerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const customer = await customerContext.newPage(); customer.setDefaultTimeout(30000);
    customer.on('pageerror', error => errors.push(error.message));
    await customer.goto(info.origin + '/admin');
    await customer.getByRole('textbox', { name: '账号', exact: true }).fill('普通用户1');
    const loginPassword = customer.getByLabel('后台密码', { exact: true });
    assert.equal(await loginPassword.getAttribute('minlength'), '6');
    await loginPassword.fill('135792');
    await customer.getByRole('button', { name: '解锁后台', exact: true }).click();
    await waitUntil(async () => (await (await customer.request.get(info.origin + '/api/admin-auth/session')).json()).authenticated, 15000, 'Chinese login');
    const loggedIn = await (await customer.request.get(info.origin + '/api/admin-auth/session')).json();
    assert.equal(loggedIn.user.username, '普通用户1');
    assert.equal(loggedIn.permissions.manageUsers, false);
    check('fresh browser login accepts Chinese username and six-character password without granting administrator privileges');

    await customer.goto(info.origin + '/group');
    await customer.locator('.group-user').click();
    const menu = customer.getByRole('region', { name: '账户设置', exact: true });
    await menu.getByRole('button', { name: /修改我的密码/ }).click();
    const current = menu.getByLabel('当前密码', { exact: true }), next = menu.getByLabel('新密码', { exact: true });
    assert.equal(await current.getAttribute('minlength'), '6'); assert.equal(await next.getAttribute('minlength'), '6');
    await current.fill('135792'); await next.fill('987654');
    await menu.getByRole('button', { name: /保存新密码/ }).click();
    await menu.getByText('密码已更新，其他会话已退出', { exact: true }).waitFor();
    check('real-time display account menu changes a six-character password to six characters successfully');

    await page.goto(info.origin + '/group');
    await page.locator('.group-user').click();
    const ownerMenu = page.getByRole('region', { name: '账户设置', exact: true });
    await ownerMenu.getByRole('button', { name: /管理账户/ }).click();
    await ownerMenu.getByLabel('账号', { exact: true }).fill('普通用户1');
    const addPassword = ownerMenu.getByLabel('密码', { exact: true });
    assert.equal(await addPassword.getAttribute('minlength'), '6');
    await addPassword.fill('987654');
    await ownerMenu.getByRole('button', { name: /添加并切换/ }).click();
    await waitUntil(async () => (await (await page.request.get(info.origin + '/api/admin-auth/session')).json()).user?.username === '普通用户1', 15000, 'Chinese account switching');
    await page.screenshot({ path: path.join(directory, '02-chinese-account-switch.png') });
    check('add-and-switch account also accepts the changed six-character password and Chinese login name');

    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
