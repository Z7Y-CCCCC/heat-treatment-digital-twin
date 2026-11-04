// Owned backend and browser only. Never refresh or mutate a commissioned site.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('map-settings-tabs'), checks = [], errors = [];
const check = text => { checks.push(text); console.log('PASS ' + text); };
let server, browser, page, info;
async function request(route, method = 'GET', data) {
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const response = await page.request.fetch(info.origin + '/api' + route, { method,
        headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
        ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
    return response.json();
}
async function login(context, username = info.username) {
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'map' })));
    const next = await context.newPage(); next.setDefaultTimeout(20000); next.on('pageerror', error => errors.push(error.message));
    await next.goto(info.origin + '/admin');
    await next.getByLabel('账号', { exact: true }).fill(username);
    await next.getByLabel('后台密码', { exact: true }).fill(info.password);
    await next.getByRole('button', { name: '解锁后台', exact: true }).click();
    await next.locator('.group-appearance-admin').waitFor();
    await waitUntil(async () => !!(await next.getByRole('textbox', { name: '默认品牌标题', exact: true }).inputValue()), 10000, 'map settings load');
    if (username === info.username) await waitUntil(() => next.locator('.appearance-edit-controls').isEnabled(), 10000, 'editable settings');
    return next;
}
const labels = ['品牌与标题', 'Logo', '主题配色', '地图设置'];
async function select(page, name) {
    await page.getByRole('tab', { name, exact: true }).click();
    await waitUntil(async () => await page.getByRole('tab', { name, exact: true }).getAttribute('aria-selected') === 'true', 5000, 'selected tab');
    assert.equal(await page.locator('.appearance-tab-panel:visible').count(), 1);
    assert.equal(await page.getByRole('tab', { selected: true }).innerText(), name);
}
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI backend');
    info = JSON.parse(fs.readFileSync(infoFile)); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    page = await login(await browser.newContext({ viewport: { width: 1280, height: 900 } }));
    // Seed legacy component data via the owned backend. Theme edits must not
    // erase it while existing projects migrate to the unified designer.
    const original = await request('/settings');
    const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
    await request('/settings', 'PUT', { group_portal_config: { ...parse(original.group_portal_config), levels: {
        city: { brandTitle: '城市独立标题', layout: { brand: { x: 8, y: 9 } },
            dataBindings: { factsFactoryCount: { mode: 'http_api', connectionId: 'legacy_fixture_connection', apiPath: '/stats', jsonPath: 'count', refreshMs: 5000 } } }
    } } });
    const baseline = parse((await request('/settings')).group_portal_config).levels.city;
    await page.reload(); await page.locator('.group-appearance-admin').waitFor();
    await waitUntil(() => page.locator('.appearance-edit-controls').isEnabled(), 10000, 'legacy profile loaded');
    assert.deepEqual(await page.getByRole('tab').allTextContents(), labels);
    for (const name of ['画面组件', '数据来源', '画面编排']) assert.equal(await page.getByRole('tab', { name, exact: true }).count(), 0);
    assert.equal(await page.locator('.appearance-tab-panel:visible').count(), 1);
    for (const label of labels) await select(page, label);
    check('horizontal buttons show exactly one configuration section, with common save controls outside the scroller');

    await select(page, '品牌与标题');
    await page.getByRole('textbox', { name: '默认品牌标题', exact: true }).fill('地图分区验收');
    await select(page, '主题配色');
    const color = page.locator('[data-map-section="theme"] input[pattern]').first();
    await color.fill('#123456');
    await select(page, '地图设置');
    await page.getByRole('button', { name: '城市', exact: true }).click();
    const mapColor = page.locator('[data-map-section="map"] input[pattern]').first();
    await mapColor.fill('#224466'); await mapColor.blur();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await page.locator('.appearance-message:not(.failed)').waitFor();
    let settings = await request('/settings'), saved = typeof settings.group_portal_config === 'string' ? JSON.parse(settings.group_portal_config) : settings.group_portal_config;
    assert.equal(saved.brandTitle, '地图分区验收'); assert.equal(saved.background, '#123456');
    assert.equal(saved.levels.city.background, '#224466'); assert.equal(saved.levels.city.brandTitle, '城市独立标题');
    assert.deepEqual(saved.levels.city.layout, baseline.layout);
    assert.deepEqual(saved.levels.city.dataBindings, baseline.dataBindings);
    assert.equal(saved.levels.country, undefined);
    check('theme and map drafts persist together without clearing legacy titles, layout or bindings; retired component editors are absent');

    await page.reload(); await page.getByRole('textbox', { name: '默认品牌标题', exact: true }).waitFor();
    await waitUntil(() => page.locator('.appearance-edit-controls').isEnabled(), 10000, 'saved configuration reload');
    assert.equal(await page.getByRole('textbox', { name: '默认品牌标题', exact: true }).inputValue(), '地图分区验收');
    await page.getByRole('textbox', { name: '默认品牌标题', exact: true }).fill('');
    await select(page, '主题配色');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await waitUntil(async () => (await page.getByRole('tab', { selected: true }).innerText()) === '品牌与标题', 5000, 'invalid field category');
    assert.equal(await page.getByRole('textbox', { name: '默认品牌标题', exact: true }).evaluate(el => document.activeElement === el), true);
    await page.getByRole('textbox', { name: '默认品牌标题', exact: true }).fill('地图分区验收');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await waitUntil(async () => !(await page.locator('.appearance-message').getAttribute('class')).includes('failed'), 5000, 'clear validation after successful save');
    check('invalid fields hidden in a different tab are revealed and focused rather than silently preventing save');
    const first = page.getByRole('tab', { name: labels[0], exact: true }); await first.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('tab', { selected: true }).innerText(), labels[1]);
    await page.keyboard.press('End'); assert.equal(await page.getByRole('tab', { selected: true }).innerText(), labels.at(-1));
    await page.keyboard.press('Home'); assert.equal(await page.getByRole('tab', { selected: true }).innerText(), labels[0]);
    check('keyboard arrows, Home and End switch and focus the tab correctly');

    for (const [width, height] of [[1280, 900], [1024, 700], [760, 700]]) {
        await page.setViewportSize({ width, height });
        await select(page, '品牌与标题');
        await page.locator('.group-appearance-admin').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const body = page.locator('.appearance-section-body');
        assert.ok((await body.boundingBox()).height <= 561);
        await page.locator('.group-appearance-admin').screenshot({ path: path.join(directory, `tabs-${width}x${height}.png`) });
    }
    check('desktop, short and narrow windows keep a bounded form with no horizontal page overflow');

    await request('/admin-auth/users', 'POST', { username: 'map_reader', displayName: '地图只读', password: info.password, role: 'viewer',
        permissions: { view: false }, pagePermissions: { 'platform.map': { view: true } } });
    const readonly = await login(await browser.newContext({ viewport: { width: 1280, height: 900 } }), 'map_reader');
    for (const name of labels) await select(readonly, name);
    assert.equal(await readonly.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
    assert.ok(await readonly.locator('.appearance-reset-level').isDisabled());
    await select(readonly, '品牌与标题');
    assert.equal(await readonly.getByRole('textbox', { name: '默认品牌标题', exact: true }).isDisabled(), true);
    check('read-only users can browse every remaining category but cannot edit, reset levels or save');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, directory }, null, 2));
    console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
