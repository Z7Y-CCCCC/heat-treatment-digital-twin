// Owned SQLite/backend/browser fixture only; never change a running site's factories.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('factory-enable-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser, page, info;
async function request(route, method = 'GET', data, factoryId) {
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const response = await page.request.fetch(info.origin + '/api' + route, { method,
        headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken,
            ...(factoryId ? { 'X-Factory-ID': factoryId } : {}) }, ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
    return response.json();
}
async function login(context, username, tab = 'factories') {
    await context.addInitScript(tab => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: tab, settingsSubpage: 'data' })), tab);
    const next = await context.newPage(); next.setDefaultTimeout(30000); next.on('pageerror', e => errors.push(e.message));
    await next.goto(info.origin + '/admin');
    await next.getByLabel('账号', { exact: true }).fill(username);
    await next.getByLabel('后台密码', { exact: true }).fill(info.password);
    await next.getByRole('button', { name: '解锁后台', exact: true }).click();
    await next.locator(tab === 'users' ? '.users-settings' : tab === 'settings' ? '.factory-collection-settings table' : tab === 'devices' ? '.asset-hierarchy-bar' : '.factory-table').waitFor();
    return next;
}
async function checked(toggle, value) {
    await waitUntil(async () => await toggle.getAttribute('aria-checked') === String(value) && await toggle.getAttribute('aria-busy') === 'false', 10000, 'saved capsule state');
    assert.equal(await toggle.innerText(), value ? '启用' : '停用');
}
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    info = JSON.parse(fs.readFileSync(infoFile)); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1626, height: 1000 } });
    page = await login(context, info.username);
    const location = { country: 'CHN', regionName: '天津市', city: '天津市', districtName: '和平区' };
    const factory = (await request('/factories', 'POST', { name: '胶囊开关验收厂', location })).factory;
    const other = (await request('/factories', 'POST', { name: '第二验收厂', location })).factory;
    await request('/workshops', 'POST', { id: 'capsule_workshop', name: '验收车间' }, factory.id);
    await request('/lines', 'POST', { id: 'capsule_line', name: '验收产线', workshop_id: 'capsule_workshop' }, factory.id);
    await request('/devices', 'POST', { id: 'capsule_device', name: '验收设备', line_id: 'capsule_line', model_type: 'builtin_furnace', plc_enabled: 0 }, factory.id);
    const before = (await request('/factories')).factories.find(item => item.id === factory.id);
    const devicesBefore = await request('/devices', 'GET', undefined, factory.id);
    assert.deepEqual([before.workshopCount, before.lineCount, before.deviceCount], [1, 1, 1]);
    await page.reload();
    const row = page.locator(`[data-factory-id="${factory.id}"]`), toggle = row.getByRole('switch');
    const otherToggle = page.locator(`[data-factory-id="${other.id}"]`).getByRole('switch');
    await checked(toggle, true);
    const defaultToggle = page.locator('[data-factory-id="factory_default"]').getByRole('switch');
    assert.equal(await defaultToggle.isEnabled(), true);
    await defaultToggle.click(); await checked(defaultToggle, false);
    assert.equal((await request('/factories')).activeFactoryId, 'factory_default');
    assert.ok((await request('/config')).workshops.length);
    await defaultToggle.click(); await checked(defaultToggle, true);
    const style = await toggle.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight, background: getComputedStyle(el).backgroundColor,
        radius: getComputedStyle(el).borderRadius, knob: getComputedStyle(el.querySelector('i')).backgroundColor }));
    assert.deepEqual(style, { width: 68, height: 28, background: 'rgb(222, 245, 233)', radius: '999px', knob: 'rgb(255, 255, 255)' });
    check('all factories including the selected runtime factory can be hidden; no default-factory restriction');

    let release, mutations = [];
    const gate = new Promise(resolve => { release = resolve; });
    const target = info.origin + '/api/factories/' + factory.id;
    const delay = async route => { mutations.push(route.request().postDataJSON()); await gate; await route.continue(); };
    await page.route(target, delay);
    await toggle.click();
    await waitUntil(async () => mutations.length === 1 && await toggle.getAttribute('aria-busy') === 'true', 10000, 'pending update');
    assert.equal(await toggle.isDisabled(), true); assert.equal(await otherToggle.isDisabled(), true);
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.evaluate(el => el.click()); assert.equal(mutations.length, 1);
    release(); await checked(toggle, false); await page.unroute(target, delay);
    assert.deepEqual(mutations, [{ enabled: false }]);
    assert.deepEqual(await row.locator('td').allTextContents().then(cells => cells.slice(2, 5)), ['1', '1', '1']);
    await page.reload(); await checked(toggle, false);
    assert.deepEqual((await request('/factories')).factories.find(item => item.id === factory.id), { ...before, enabled: false });
    check('click persists only enabled=false, prevents duplicate writes, preserves counts/name/location and survives refresh');
    await toggle.focus(); await page.keyboard.press('Space'); await checked(toggle, true);
    assert.deepEqual(await request('/devices', 'GET', undefined, factory.id), devicesBefore);
    check('keyboard activation restores enabled state without changing equipment or PLC configuration');

    await page.route(target, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '验收：工厂状态冲突' }) }), { times: 1 });
    await toggle.click();
    await page.getByRole('alert').filter({ hasText: '验收：工厂状态冲突' }).waitFor();
    await checked(toggle, true); assert.equal(await toggle.isEnabled(), true);
    assert.deepEqual((await request('/factories')).factories.find(item => item.id === factory.id), before);
    await toggle.click(); await checked(toggle, false); await toggle.click(); await checked(toggle, true);
    check('failed save reconciles with the server, leaves the old state intact and allows retry');
    await page.locator('.factory-registry').screenshot({ path: path.join(directory, '01-factory-capsules.png') });

    await page.evaluate(id => localStorage.setItem('digital_twin_factory_scope_v1', id), factory.id);
    await page.reload(); await toggle.waitFor();
    assert.equal(await toggle.isEnabled(), true);
    await toggle.click(); await checked(toggle, false);
    const scopedContext = await browser.newContext();
    await scopedContext.addInitScript(id => localStorage.setItem('digital_twin_factory_scope_v1', id), factory.id);
    const scopedPage = await login(scopedContext, info.username, 'devices');
    assert.equal(await scopedPage.getByLabel('当前编辑工厂', { exact: true }).inputValue(), factory.id);
    assert.ok(await scopedPage.getByLabel('当前编辑工厂', { exact: true }).locator(`option[value="${factory.id}"]`).count());
    assert.equal((await request('/config', 'GET', undefined, factory.id)).factoryId, factory.id);
    await toggle.click(); await checked(toggle, true);
    assert.equal(await otherToggle.isEnabled(), true);
    await page.evaluate(() => localStorage.removeItem('digital_twin_factory_scope_v1')); await page.reload();
    check('hidden factory remains selectable and editable without changing the current editing scope');

    const collectionPage = await login(await browser.newContext({ viewport: { width: 1280, height: 900 } }), info.username, 'settings');
    const collection = collectionPage.locator(`[data-collection-factory-id="${factory.id}"]`).getByRole('switch');
    await checked(collection, true);
    await collection.click(); await checked(collection, false);
    assert.equal((await request('/factories')).factories.find(item => item.id === factory.id).enabled, true);
    await toggle.click(); await checked(toggle, false);
    await collection.click(); await checked(collection, true);
    assert.equal((await request('/factories')).factories.find(item => item.id === factory.id).enabled, false);
    await collectionPage.reload(); await checked(collection, true);
    await collectionPage.locator('.factory-collection-settings').screenshot({ path: path.join(directory, '02-independent-collection-capsules.png') });
    await toggle.click(); await checked(toggle, true);
    check('data-route collection capsule works independently of visibility and persists after refresh');

    await request('/admin-auth/users', 'POST', { username: 'factory_reader', displayName: '工厂只读', password: info.password, role: 'viewer',
        permissions: { view: false }, pagePermissions: { factories: { view: true } } });
    const readonly = await login(await browser.newContext(), 'factory_reader');
    assert.equal(await readonly.locator('.factory-toggle:not(:disabled)').count(), 0);
    const deniedSession = await (await readonly.request.get(info.origin + '/api/admin-auth/session')).json();
    const denied = await readonly.request.put(target, { headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': deniedSession.csrfToken }, data: { enabled: false } });
    assert.equal(denied.status(), 403);
    const deniedCollection = await readonly.request.put(target + '/collection', { headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': deniedSession.csrfToken }, data: { enabled: false } });
    assert.equal(deniedCollection.status(), 403);
    check('read-only users see the capsule but cannot change factory status in UI or API');

    const users = await login(await browser.newContext({ viewport: { width: 1626, height: 1000 } }), info.username, 'users');
    const account = users.getByRole('switch', { name: '启用账户：factory_reader', exact: true });
    assert.deepEqual(await account.evaluate(el => ({ width: el.offsetWidth, height: el.offsetHeight, background: getComputedStyle(el).backgroundColor,
        radius: getComputedStyle(el).borderRadius, knob: getComputedStyle(el.querySelector('i')).backgroundColor })), style);
    await account.click(); await checked(account, false); await account.click(); await checked(account, true);
    check('factory and account switches share exactly the same appearance; existing account enable/disable still saves');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
