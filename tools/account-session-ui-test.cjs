const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..'), checks = [], errors = [];
let sandbox, backend, browser, admin, display, origin;
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
(async () => {
    sandbox = await createSmokeSandbox('account-session-ui');
    sandbox.password = 'AccountSession-Isolated-Test-20261031!';
    const port = await findFreePort(3981);
    await start(port); await createSmokeSession(origin, sandbox); await launch();
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
    const deniedWrite = await admin.request.post(origin + '/api/devices', { headers: {
        'X-Admin-Request': '1', 'X-CSRF-Token': (await session(admin)).csrfToken, Origin: origin }, data: { name: 'Denied' } });
    assert.equal(deniedWrite.status(), 403);
    check('read-only UI grants cannot be used to mutate a device through the backend');
    const beforeSlots = (await (await admin.request.get(origin + '/api/admin-auth/accounts')).json()).accounts.map(a => a.slotId).sort();
    assert.equal(beforeSlots.length, 2);
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
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory: sandbox.directory };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await admin?.screenshot({ path: path.join(sandbox.directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(backend); });
