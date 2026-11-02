const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const WebSocket = require('../backend/node_modules/ws');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..'), checks = [], errors = [];
let sandbox, backend, browser, admin, display, origin, unity;
const check = name => { checks.push(name); console.log('PASS ' + name); };
async function start(port) {
    origin = `http://127.0.0.1:${port}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: path.join(root, 'frontend/dist') },
        logFile: path.join(sandbox.directory, `backend-${port}-${Date.now()}.log`) });
    await waitForHttp(origin + '/api/health');
}
async function launch() {
    browser = await playwright.chromium.launchPersistentContext(path.join(sandbox.directory, 'browser-profile'), {
        headless: true, viewport: { width: 1440, height: 1000 },
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
        args: ['--enable-unsafe-swiftshader'] });
    await browser.addInitScript(() => {
        window.__hostMessages = [];
        // The real native host owns the loading mask. This fixture tests the
        // account surfaces, not the independent map-asset loading pipeline.
        window.__DIGITAL_TWIN_NATIVE_LOADING__ = true;
        window.chrome = window.chrome || {};
        window.chrome.webview = { postMessage: message => window.__hostMessages.push(message),
            addEventListener() {}, removeEventListener() {} };
        localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'users' }));
    });
    admin = await browser.newPage(); display = await browser.newPage();
    for (const page of [admin, display]) { page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message)); }
}
async function session(page) { return (await page.request.get(origin + '/api/admin-auth/session')).json(); }
async function waitUser(page, username) {
    await waitUntil(async () => (await session(page)).user?.username === username, 15000, username + ' session');
}
async function connectUnityFixture() {
    unity = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers: { 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN } });
    await new Promise((resolve, reject) => { unity.once('open', resolve); unity.once('error', reject); });
    unity.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
}
async function lockPage() {
    await admin.getByRole('button', { name: '立即锁定', exact: true }).click();
    await admin.getByLabel('后台密码', { exact: true }).waitFor();
}
async function chooseUsername(name) {
    await admin.getByRole('button', { name: '选择本机已登录账号', exact: true }).click();
    await admin.getByRole('option', { name, exact: true }).click();
}
async function loginPassword(password) {
    await admin.getByLabel('后台密码', { exact: true }).fill(password);
    await admin.getByRole('button', { name: '解锁后台', exact: true }).click();
}
(async () => {
    sandbox = await createSmokeSandbox('account-session-ui');
    sandbox.password = 'AccountSession-Isolated-Test-20261031!';
    const port = await findFreePort(3981);
    await start(port); await createSmokeSession(origin, sandbox); await connectUnityFixture(); await launch();
    await admin.goto(origin + '/admin?embedded=unity&surface=admin');
    await admin.getByRole('textbox', { name: '账号', exact: true }).fill('admin');
    await admin.getByLabel('后台密码', { exact: true }).fill(sandbox.password);
    await admin.getByRole('button', { name: '解锁后台', exact: true }).click();
    await admin.locator('.users-settings').waitFor();
    await admin.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    const dialog = admin.getByRole('dialog', { name: '新增账户', exact: true });
    for (const name of ['设备管理 · 查看', '点位监视 · 查看'])
        assert.equal(await dialog.getByRole('checkbox', { name, exact: true }).isChecked(), true);
    assert.equal(await dialog.getByRole('checkbox', { name: '设备管理 · 新增 / 修改 / 导入', exact: true }).isChecked(), false);
    await dialog.getByLabel('登录账号', { exact: true }).fill('现场客户');
    await dialog.getByLabel('显示名称', { exact: true }).fill('现场客户');
    await dialog.getByLabel('初始密码', { exact: true }).fill('246813');
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    check('the real customer-template editor saves devices and point-monitor read-only by default');
    await display.goto(origin + '/group');
    await display.locator('.group-user').click();
    const menu = display.getByRole('region', { name: '账户设置', exact: true });
    await menu.getByRole('button', { name: /管理账户/ }).click();
    await menu.getByLabel('账号', { exact: true }).fill('现场客户');
    await menu.getByLabel('密码', { exact: true }).fill('246813');
    await display.locator('.group-portal').evaluate(el => { el.__identityMarker = 'preserve-display'; });
    const documentBorn = await display.evaluate(() => performance.timeOrigin);
    await menu.getByRole('button', { name: /添加并切换/ }).click();
    await waitUser(display, '现场客户'); await waitUser(admin, '现场客户');
    await admin.locator('.users-settings').waitFor({ state: 'hidden' });
    await admin.getByRole('button', { name: '设备管理', exact: true }).waitFor();
    assert.equal(await admin.getByRole('button', { name: '用户与权限', exact: true }).count(), 0);
    assert.equal(await admin.locator('#admin-unlock-password').count(), 0);
    await waitUntil(async () => (await admin.evaluate(() => window.__hostMessages.filter(m => m.action === 'sync_unity_session').length)) >= 2,
        15000, 'account handoff in the second surface');
    assert.equal(await display.evaluate(() => performance.timeOrigin), documentBorn);
    assert.equal(await display.locator('.group-portal').evaluate(el => el.__identityMarker), 'preserve-display');
    assert.equal((await session(admin)).pagePermissions['point-monitor'].view, true);
    await admin.screenshot({ path: path.join(sandbox.directory, '01-customer-readonly-admin.png') });
    check('switching from the display immediately updates the admin surface without a password prompt or display remount');
    await display.close(); display = null;
    const unityBadge = admin.locator('.admin-connection-strip .admin-connection-pill').first();
    await admin.getByText('Unity 已连接', { exact: true }).waitFor();
    await admin.getByRole('button', { name: '点位监视', exact: true }).click();
    assert.equal((await admin.request.get(origin + '/api/native-preview/status')).status(), 200);
    assert.equal((await unityBadge.textContent()).trim(), 'Unity 已连接');
    unity.close(); unity = null;
    await admin.getByText('Unity 未连接', { exact: true }).waitFor();
    await connectUnityFixture(); await admin.getByText('Unity 已连接', { exact: true }).waitFor();
    await admin.route('**/api/native-preview/status', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture unavailable"}' }));
    await admin.getByText('Unity 状态不可用', { exact: true }).waitFor();
    await admin.unroute('**/api/native-preview/status');
    await admin.getByText('Unity 已连接', { exact: true }).waitFor();
    check('a read-only customer sees real Unity connection, disconnect and recovery; a failed status request is not left checking forever');

    const originalSlots = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).accounts.map(a => a.slotId).sort();
    await lockPage();
    await waitUntil(async () => (await admin.getByLabel('账号', { exact: true }).inputValue()) === '现场客户', 10000, 'locked customer username');
    await admin.getByRole('button', { name: '选择本机已登录账号', exact: true }).click();
    assert.deepEqual((await admin.getByRole('option').allTextContents()).sort(), ['admin', '现场客户']);
    await admin.screenshot({ path: path.join(sandbox.directory, '02-remembered-username-menu.png') });
    await admin.keyboard.press('Escape');
    await chooseUsername('admin'); await loginPassword('incorrect-password');
    await admin.getByRole('alert').filter({ hasText: '后台密码不正确' }).waitFor();
    const history = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).recentUsernames;
    assert.deepEqual(history, ['现场客户', 'admin']);
    await admin.reload();
    await waitUntil(async () => (await admin.getByLabel('账号', { exact: true }).inputValue()) === '现场客户', 10000, 'failed login cannot change default');
    check('locking defaults to the selected customer, shows previous Chinese and admin usernames, and failed logins do not change the remembered default');
    await chooseUsername('admin'); await loginPassword(sandbox.password);
    await admin.locator('.users-settings').waitFor(); await waitUser(admin, 'admin');
    await lockPage();
    await waitUntil(async () => (await admin.getByLabel('账号', { exact: true }).inputValue()) === 'admin', 10000, 'last successful admin login');
    await chooseUsername('现场客户');
    assert.equal(await admin.getByLabel('后台密码', { exact: true }).inputValue(), '');
    await loginPassword('246813'); await waitUser(admin, '现场客户');
    await admin.getByRole('button', { name: '设备管理', exact: true }).waitFor();
    const unlockedSlots = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).accounts.map(a => a.slotId).sort();
    assert.deepEqual(unlockedSlots, originalSlots);
    const historyCookies = (await browser.cookies()).filter(cookie => cookie.name.endsWith('_usernames'));
    assert.equal(historyCookies.length, 1); assert.equal(historyCookies[0].httpOnly, true);
    assert.deepEqual(JSON.parse(Buffer.from(historyCookies[0].value, 'base64url').toString()), ['现场客户', 'admin']);
    check('each successful unlock becomes the next default without overwriting another account slot; history stores only usernames in an HttpOnly cookie');
    const deniedWrite = await admin.request.post(origin + '/api/devices', { headers: {
        'X-Admin-Request': '1', 'X-CSRF-Token': (await session(admin)).csrfToken, Origin: origin }, data: { name: 'Denied' } });
    assert.equal(deniedWrite.status(), 403);
    check('read-only UI grants cannot be used to mutate a device through the backend');
    const beforeSlots = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).accounts.map(a => a.slotId).sort();
    assert.equal(beforeSlots.length, 2);
    unity.close(); unity = null;
    await browser.close(); browser = null; await stopOwnedSmokeProcess(backend);
    await start(port); await launch();
    await admin.goto(origin + '/admin?embedded=unity&surface=admin');
    await admin.getByRole('button', { name: '设备管理', exact: true }).waitFor();
    await waitUser(admin, '现场客户');
    const afterSlots = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).accounts.map(a => a.slotId).sort();
    assert.deepEqual(afterSlots, beforeSlots);
    assert.equal(await admin.locator('#admin-unlock-password').count(), 0);
    check('closing both browser and backend preserves the selected customer and every valid account slot on restart');
    await browser.close(); browser = null; await stopOwnedSmokeProcess(backend);
    const alternate = await findFreePort(port + 1); await start(alternate); await launch();
    await admin.goto(origin + '/admin?embedded=unity&surface=admin');
    await admin.getByRole('button', { name: '设备管理', exact: true }).waitFor();
    await waitUser(admin, '现场客户');
    const changedSlots = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).accounts.map(a => a.slotId).sort();
    assert.deepEqual(changedSlots, beforeSlots);
    check('a desktop-style backend port change also preserves selected identity and saved account slots');
    await lockPage();
    await waitUntil(async () => (await admin.getByLabel('账号', { exact: true }).inputValue()) === '现场客户', 10000, 'username after a backend port change');
    await admin.getByRole('button', { name: '选择本机已登录账号', exact: true }).click();
    assert.equal(await admin.getByRole('option').count(), 2);
    check('username choices and the last selected account survive browser/backend restart and a changed backend port');
    await admin.keyboard.press('Escape');
    const locked = await session(admin);
    assert.equal((await admin.request.post(origin + '/api/admin-auth/accounts/logout', {
        headers: { 'X-Admin-Request': '1', 'X-CSRF-Token': locked.csrfToken, Origin: origin }, data: {} })).status(), 200);
    let releaseHistory;
    const heldHistory = new Promise(resolve => { releaseHistory = resolve; });
    await admin.route('**/api/admin-auth/accounts', async route => {
        const response = await route.fetch(); await heldHistory; await route.fulfill({ response });
    });
    await admin.reload();
    const usernameInput = admin.getByLabel('账号', { exact: true });
    await usernameInput.fill('手工输入'); releaseHistory();
    await admin.getByRole('button', { name: '选择本机已登录账号', exact: true }).waitFor();
    assert.equal(await usernameInput.inputValue(), '手工输入');
    await admin.unroute('**/api/admin-auth/accounts'); await admin.reload();
    await waitUntil(async () => (await usernameInput.inputValue()) === '现场客户', 10000, 'last successful username without an active session');
    assert.equal(await admin.getByLabel('后台密码', { exact: true }).inputValue(), '');
    check('after logout the last successful username is still suggested, and delayed history never overwrites manual typing');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory: sandbox.directory };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await admin?.screenshot({ path: path.join(sandbox.directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { unity?.terminate(); await browser?.close(); await stopOwnedSmokeProcess(backend); });
