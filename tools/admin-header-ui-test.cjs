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
    const factory = header.getByRole('combobox', { name: '当前编辑工厂', exact: true });
    await factory.waitFor(); await waitUntil(() => factory.isEnabled(), 10000, 'factory directory');
    assert.equal(await page.locator('.admin-content .asset-hierarchy-bar').count(), 0);
    assert.equal(await header.locator('.asset-factory-caption').innerText(), '当前工厂 / 区域');
    assert.equal(await header.locator('.asset-factory-icon svg').count(), 1);
    assert.equal(await header.locator('.asset-factory-dot').count(), 1);
    assert.match(await factory.getAttribute('title'), /车间：.*\n产线：.*\n设备：/);
    assert.equal(await page.locator('.asset-hierarchy-path').count(), 0);
    check('reference-style factory card is in the toolbar with icon, caption, status dot and full scope tooltip, not above page content');
    assert.equal(await header.getByText('数字孪生后台配置管理', { exact: true }).count(), 0);
    assert.equal(await header.locator('.admin-setup-flow, .admin-setup-step').count(), 0);
    assert.equal(await header.getByText('配置顺序', { exact: true }).count(), 0);
    const lock = header.getByRole('button', { name: '立即锁定', exact: true });
    const guide = header.getByRole('button', { name: '打开系统常见问题向导', exact: true });
    assert.equal((await lock.textContent()).trim(), ''); assert.equal(await lock.locator('svg').count(), 1);
    assert.match(await lock.getAttribute('title'), /立即锁定/);
    assert.deepEqual(await header.locator('.admin-connection-strip').evaluate(el => [...el.children].map(node =>
        node.matches('.admin-connection-controls') ? 'connections' : node.matches('.admin-reading-settings') ? 'reading' : node.matches('.admin-lock-button') ? 'lock' : node.matches('.help-guide-launch') ? 'guide' : 'unexpected')),
        ['connections', 'reading', 'lock', 'guide']);
    assert.deepEqual(await header.locator('.admin-connection-pill').evaluateAll(nodes => nodes.map(node => node.dataset.connectionKind)), ['unity', 'devices']);
    assert.equal(await header.getByRole('button', { name: '外观设置', exact: true }).count(), 1);
    check('long heading and configuration-order strip are absent; connection, reading, icon-only lock and guide remain');

    for (const width of [1920, 1626, 1440, 1280, 1024, 720]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const bounds = await header.evaluate(el => {
            const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
            return { header: rect(el), guide: rect(el.querySelector('.help-guide-launch')), lock: rect(el.querySelector('.admin-lock-button')),
                logo: rect(el.querySelector('.header-logo-section')), status: rect(el.querySelector('.admin-connection-pill')),
                factory: rect(el.querySelector('.asset-factory-select')), connections: rect(el.querySelector('.admin-connection-strip')),
                padding: parseFloat(getComputedStyle(el).paddingRight) };
        });
        assert.ok(Math.abs(bounds.guide.right - (bounds.header.right - bounds.padding)) < 2, `guide must be rightmost at ${width}px`);
        assert.ok(bounds.lock.right < bounds.guide.x && bounds.guide.x - bounds.lock.right <= 9, `lock immediately before guide at ${width}px`);
        assert.ok(bounds.logo.right <= bounds.status.x, `logo must not overlap status at ${width}px`);
        assert.ok(bounds.lock.width === 36 && bounds.lock.height === 36);
        assert.ok(bounds.lock.y >= bounds.header.y && bounds.guide.bottom <= bounds.header.bottom);
        assert.ok(bounds.factory.x > bounds.logo.right && bounds.factory.right < bounds.connections.x, `factory card between logo and right toolbar at ${width}px`);
        assert.ok(bounds.factory.y >= bounds.header.y && bounds.factory.bottom <= bounds.header.bottom, `factory card inside toolbar at ${width}px`);
        assert.ok(bounds.factory.width >= 160 && bounds.factory.height >= 52, `factory card stays readable at ${width}px`);
        await header.screenshot({ path: path.join(directory, `header-${width}.png`) });
    }
    check('guide stays at the right edge and lock immediately to its left from 720px through 1920px without clipping or overlap');

    await page.setViewportSize({ width: 1626, height: 1000 });
    const originalFactoryId = await factory.getAttribute('data-factory-id');
    // Create and switch only inside this run's private fixture, never the live installation.
    const alternateFactory = await page.evaluate(async () => {
        const session = await (await fetch('/api/admin-auth/session')).json();
        const response = await fetch('/api/factories', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
            body: JSON.stringify({ name: '切换验收工厂' }) });
        const result = await response.json();
        if (!response.ok || !result.factory) throw new Error(result.error || 'Fixture factory creation failed');
        window.dispatchEvent(new CustomEvent('digital-twin-factory-directory-changed'));
        return result.factory;
    });
    await factory.click();
    const factoryMenu = page.getByRole('listbox', { name: '工厂列表', exact: true });
    const option = id => factoryMenu.locator(`[data-factory-id="${id}"]`);
    await option(alternateFactory.id).waitFor();
    assert.equal(await option(originalFactoryId).getAttribute('aria-selected'), 'true');
    assert.equal(await factory.getAttribute('aria-expanded'), 'true');
    await waitUntil(async () => await page.locator('.asset-factory-menu').evaluate(el => getComputedStyle(el).opacity) === '1', 5000, 'dropdown opening transition');
    await page.screenshot({ path: path.join(directory, 'factory-dropdown-open.png'), fullPage: false, animations: 'disabled' });
    const cardBounds = await factory.boundingBox(), menuBounds = await page.locator('.asset-factory-menu').boundingBox();
    await page.screenshot({ path: path.join(directory, 'factory-dropdown-preview.png'), animations: 'disabled',
        clip: { x: cardBounds.x - 12, y: 0, width: menuBounds.width + 24, height: menuBounds.y + menuBounds.height + 16 } });
    for (const width of [1626, 720]) {
        await page.setViewportSize({ width, height: 1000 });
        const bounds = await page.locator('.asset-factory-menu').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 1000);
    }
    await page.setViewportSize({ width: 1626, height: 1000 });
    await page.keyboard.press('Escape'); await factoryMenu.waitFor({ state: 'hidden' });
    await factory.press('Enter'); await factoryMenu.waitFor();
    await page.locator('.header-logo-section').click(); await factoryMenu.waitFor({ state: 'hidden' });
    await factory.press('ArrowDown'); await factoryMenu.waitFor();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    check('custom dropdown shows the selected factory, fits desktop and compact windows, and supports keyboard, Escape and outside dismissal');
    const switchDialog = page.locator('.app-dialog-overlay');
    await switchDialog.getByRole('heading', { name: '切换工厂配置', exact: true }).waitFor();
    assert.equal(await factory.isDisabled(), true);
    assert.equal(await header.locator('.asset-factory-current strong').innerText(), '正在切换…');
    await switchDialog.getByRole('button', { name: '取消', exact: true }).click();
    await waitUntil(() => factory.isEnabled(), 10000, 'cancelled factory switch');
    assert.equal(await factory.getAttribute('data-factory-id'), originalFactoryId);
    check('cancelling a factory switch restores the selection and keeps the original factory');
    for (const id of [alternateFactory.id, originalFactoryId]) {
        await factory.click();
        await option(id).click();
        await switchDialog.getByRole('button', { name: '不保存并切换', exact: true }).click();
        await waitUntil(async () => await factory.isEnabled() && await factory.getAttribute('data-factory-id') === id
            && await page.evaluate(() => localStorage.getItem('digital_twin_factory_scope_v1')) === id, 20000, 'confirmed factory switch');
    }
    check('confirming factory switches updates the stored scope and reloads the chosen factory in both directions');
    await factory.focus();
    assert.equal(await factory.evaluate(el => document.activeElement === el), true);
    assert.notEqual(await header.locator('.asset-factory-select').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.keyboard.press('Escape');
    await page.locator('.admin-nav').getByRole('button', { name: '产线管理', exact: true }).click();
    await page.getByRole('heading', { name: '产线结构管理', exact: true }).waitFor();
    await factory.waitFor();
    assert.equal(await page.locator('.admin-content .asset-hierarchy-bar').count(), 0);
    await page.screenshot({ path: path.join(directory, 'factory-card-line-page.png'), fullPage: false });
    check('factory card stays keyboard accessible and remains in the fixed toolbar on the production-line page');
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
