// Owned fixture only; do not lock or refresh the user's live editing session.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('admin-header-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    const info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1626, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'devices' })));
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const header = page.getByRole('banner', { name: '后台工具栏', exact: true }); await header.waitFor();
    assert.equal(await header.getByText('数字孪生后台配置管理', { exact: true }).count(), 0);
    const lock = header.getByRole('button', { name: '立即锁定', exact: true });
    const guide = header.getByRole('button', { name: '打开系统常见问题向导', exact: true });
    assert.equal((await lock.textContent()).trim(), ''); assert.equal(await lock.locator('svg').count(), 1);
    assert.match(await lock.getAttribute('title'), /立即锁定/);
    assert.deepEqual(await header.locator('.admin-connection-strip').evaluate(el => [...el.children].map(node =>
        node.matches('.admin-connection-pill') ? 'status' : node.matches('.admin-lock-button') ? 'lock' : node.matches('.help-guide-launch') ? 'guide' : 'unexpected')),
        ['status', 'status', 'lock', 'guide']);
    check('long heading is absent; two status badges precede an icon-only, accessibly named lock and the guide');

    for (const width of [1920, 1626, 1440, 1280, 1024, 720]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const bounds = await header.evaluate(el => {
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
            return { header: rect(el), guide: rect(el.querySelector('.help-guide-launch')), lock: rect(el.querySelector('.admin-lock-button')),
                flow: rect(el.querySelector('.admin-setup-flow')), status: rect(el.querySelector('.admin-connection-pill')),
                padding: parseFloat(getComputedStyle(el).paddingRight) };
        });
        assert.ok(Math.abs(bounds.guide.right - (bounds.header.right - bounds.padding)) < 2, `guide must be rightmost at ${width}px`);
        assert.ok(bounds.lock.right < bounds.guide.x && bounds.guide.x - bounds.lock.right <= 9, `lock immediately before guide at ${width}px`);
        assert.ok(bounds.flow.right <= bounds.status.x, `setup steps must not overlap status at ${width}px`);
        assert.ok(bounds.lock.width === 36 && bounds.lock.height === 36);
        assert.ok(bounds.lock.y >= bounds.header.y && bounds.guide.bottom <= bounds.header.bottom);
        await header.screenshot({ path: path.join(directory, `header-${width}.png`) });
    }
    check('guide stays at the right edge and lock immediately to its left from 720px through 1920px without clipping or overlap');

    await page.setViewportSize({ width: 1626, height: 1000 });
    await guide.click();
    const dialog = page.getByRole('dialog', { name: '系统向导', exact: true }); await dialog.waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await guide.focus(); await page.keyboard.press('Enter'); await dialog.waitFor();
    await page.getByRole('button', { name: '关闭系统向导', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    check('rightmost guide still opens by pointer and keyboard, and closes normally');

    const request = page.waitForResponse(r => r.url().endsWith('/api/admin-auth/lock') && r.request().method() === 'POST');
    await lock.focus(); await page.keyboard.press('Space'); assert.equal((await request).status(), 200);
    await page.getByRole('button', { name: '解锁后台', exact: true }).waitFor();
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    assert.equal(session.authenticated, false); assert.equal(session.displayAuthenticated, true);
    check('icon-only lock remains keyboard operable and locks the backend while retaining display authentication');

    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
