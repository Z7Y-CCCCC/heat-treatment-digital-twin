// End-to-end vendor -> real desktop activation IPC -> owned service -> original
// account setup -> renewal/history. No production key, machine state or process.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createSmokeSandbox, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, startLoggedProcess, waitUntil, waitForHttp, BACKEND_DIR } = require('../backend/scripts/integration-test-utils.cjs');
const { decodeActivationCode, encodeActivationCode } = require('../shared/activationCode.cjs');
const { createActivationClient } = require('../desktop/activation.cjs');
const checks = [], errors = [], check = name => { checks.push(name); console.log('PASS ' + name); };
let sandbox, issuer, backend, desktop, browser, nativeBrowser, page, adminPage, origin, issuerUrl;
(async () => {
    sandbox = await createSmokeSandbox('offline-activation-flow');
    const vendorDir = path.join(sandbox.directory, 'vendor'), vendorLog = path.join(sandbox.directory, 'vendor.log');
    issuer = startLoggedProcess(process.execPath, [path.resolve(__dirname, 'license-generator/license-generator.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...sandbox.env, LICENSE_ISSUER_DATA_DIR: vendorDir, LICENSE_GENERATOR_NO_OPEN: 'true' }, logFile: vendorLog });
    await waitUntil(() => { const match = fs.existsSync(vendorLog) && fs.readFileSync(vendorLog, 'utf8').match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/); if (match) issuerUrl = new URL(match[0]); return !!match; }, 15000, 'owned vendor server');
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    page = await browser.newPage({ viewport: { width: 1000, height: 900 } }); page.on('pageerror', e => errors.push(e.message));
    await page.goto(issuerUrl.href); await page.getByRole('button', { name: '初始化密钥', exact: true }).click();
    await page.getByText('签发就绪', { exact: true }).waitFor();
    const publicKeyFile = path.join(vendorDir, 'license-public-key.pem');
    assert.ok(fs.existsSync(publicKeyFile)); assert.ok(fs.existsSync(path.join(vendorDir, 'license-private-key.pem')));
    const port = await findFreePort(3957); origin = `http://127.0.0.1:${port}`;
    const env = { ...sandbox.env, PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: path.resolve(__dirname, '../frontend/dist'),
        LICENSE_PUBLIC_KEY_FILE: publicKeyFile, LICENSE_ENFORCE: 'true', LICENSE_REQUIRE_MACHINE_BOUND: 'true', LICENSE_MACHINE_ID: 'owned-activation-machine' };
    const startBackend = async () => {
        backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env, licenseEnforced: true, logFile: path.join(sandbox.directory, 'backend.log') });
        await waitForHttp(origin + '/api/health');
    };
    await startBackend();
    const client = createActivationClient(origin), initial = await client.status();
    assert.equal(initial.required, true); assert.equal(initial.publicKeyConfigured, true); assert.match(initial.machineId, /^machine-[a-f0-9]{32}$/);
    assert.equal(Object.hasOwn(initial, 'token'), false);
    assert.equal((await fetch(origin + '/api/devices')).status, 402);
    assert.notEqual((await fetch(origin + '/api/license/history')).status, 200);
    await waitUntil(async () => (await (await fetch(origin + '/api/health')).json()).db.connected, 20000, 'database ready');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal((await (await fetch(origin + '/api/health')).json()).engine.process.pid, null);
    check('fresh machine blocks business APIs and PLC collection before activation, without creating an account');

    for (const headers of [{ Origin: 'https://attacker.invalid' }, { Host: 'attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
        const status = await new Promise((resolve, reject) => {
            const req = require('node:http').get(origin + '/api/activation', { headers }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
        });
        assert.equal(status, 403, JSON.stringify(headers));
    }
    assert.equal((await fetch(origin + '/api/activation', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ activationCode: 'bad' }) })).status, 403);
    check('bootstrap rejects foreign Origin/Host/cross-site requests and missing nonce; it grants no management session');

    await page.getByLabel('本机指纹', { exact: true }).fill(initial.machineId);
    await page.getByLabel('客户名称', { exact: true }).fill('离线激活验收厂');
    await page.getByRole('button', { name: '生成激活码', exact: true }).click();
    const codeField = page.getByRole('textbox', { name: '生成的激活码', exact: true }); await codeField.waitFor();
    const code = await codeField.inputValue(); assert.match(code, /^HTA1\./);
    const document = decodeActivationCode(code); assert.equal(document.payload.bindingVersion, 2);
    await page.screenshot({ path: path.join(sandbox.directory, '01-vendor-tool.png'), fullPage: true });
    const vendorApi = async (route, data) => { const url = new URL(route, issuerUrl); url.search = issuerUrl.search;
        return page.request.post(url.href, { data }); };
    const originalPrivate = fs.readFileSync(path.join(vendorDir, 'license-private-key.pem'));
    assert.equal((await vendorApi('/api/generate-keys', {})).status(), 409);
    assert.deepEqual(fs.readFileSync(path.join(vendorDir, 'license-private-key.pem')), originalPrivate);
    const wrongMachine = await (await vendorApi('/api/sign', { ...document.payload, licenseId: 'WRONG-MACHINE', machineId: 'machine-00000000000000000000000000000000' })).json();
    await assert.rejects(client.activate(wrongMachine.activationCode), /未授权这台电脑/);
    const expired = await (await vendorApi('/api/sign', { ...document.payload, licenseId: 'EXPIRED', issuedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2021-01-01T00:00:00.000Z' })).json();
    await assert.rejects(client.activate(expired.activationCode), /过期/);
    const forged = structuredClone(document); forged.payload.customer = '篡改';
    await assert.rejects(client.activate(encodeActivationCode(forged)), /签名/);
    await assert.rejects(client.activate(code.slice(0, -4)), /不完整|有误/);
    assert.equal((await client.status()).required, true);
    check('vendor UI issues a real signed machine-bound code; keys cannot be overwritten; wrong-machine, expired, truncated and forged codes are rejected');

    const debugPort = await findFreePort(9223), desktopLog = path.join(sandbox.directory, 'desktop.log');
    const electron = require('../desktop/node_modules/electron');
    desktop = startLoggedProcess(electron, [`--remote-debugging-port=${debugPort}`, path.resolve(__dirname, 'activation-window-fixture.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...sandbox.env, ACTIVATION_UI_DATA: path.join(sandbox.directory, 'desktop'), ACTIVATION_UI_ORIGIN: origin }, logFile: desktopLog });
    await waitUntil(() => fs.existsSync(desktopLog) && fs.readFileSync(desktopLog, 'utf8').includes('ACTIVATION_GATE_WAITING'), 30000, 'real desktop activation IPC');
    nativeBrowser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const nativeContext = nativeBrowser.contexts()[0];
    const startup = nativeContext.pages().find(p => p.url().endsWith('startup.html')); assert.ok(startup);
    startup.on('pageerror', e => errors.push(e.message)); startup.setDefaultTimeout(30000);
    await startup.getByRole('region', { name: '软件激活', exact: true }).waitFor();
    assert.equal(await startup.getByLabel('本机指纹', { exact: true }).inputValue(), initial.machineId);
    assert.equal(await startup.evaluate(() => typeof window.require), 'undefined');
    await startup.getByLabel('激活码', { exact: true }).fill('HTA1.bad.bad');
    await startup.getByRole('button', { name: '激活并继续', exact: true }).click();
    await startup.getByRole('alert').filter({ hasText: /不完整|有误/ }).waitFor();
    assert.equal(startup.url().endsWith('startup.html'), true);
    await startup.screenshot({ path: path.join(sandbox.directory, '02-startup-activation.png') });
    await startup.getByLabel('激活码', { exact: true }).fill(code);
    await stopOwnedSmokeProcess(backend); backend = null;
    await startup.getByRole('button', { name: '激活并继续', exact: true }).click();
    await startup.getByRole('alert').filter({ hasText: /激活服务.*(?:不可用|中断)/ }).waitFor();
    assert.equal(await startup.getByLabel('激活码', { exact: true }).inputValue(), code);
    assert.equal(startup.url().endsWith('startup.html'), true);
    await startBackend();
    check('a service interruption during activation preserves the entered code and prompt; the next attempt obtains the recovered service nonce');
    await startup.getByRole('button', { name: '激活并继续', exact: true }).click();
    await startup.waitForURL(origin + '/admin');
    const status = await (await fetch(origin + '/api/admin-auth/session')).json(); assert.equal(status.configured, false);
    check('real sandboxed desktop preload activates through IPC, preserves the prompt on error, then resumes the unchanged first-account setup page');

    await startup.getByRole('heading', { name: '设置后台密码', exact: true }).waitFor();
    await startup.locator('#admin-unlock-password').fill('246813');
    await startup.getByLabel('确认后台密码', { exact: true }).fill('246813');
    const setupResponse = startup.waitForResponse(response => response.url() === origin + '/api/admin-auth/setup' && response.request().method() === 'POST');
    // The native fixture stays hidden so it cannot steal the operator's focus.
    // Submit via its actual DOM button rather than OS hit-testing a hidden HWND.
    await startup.getByRole('button', { name: '设置密码并进入后台', exact: true }).evaluate(button => button.click());
    const setupResult = await setupResponse;
    assert.equal(setupResult.status(), 200, await setupResult.text());
    await waitUntil(async () => (await (await nativeContext.request.get(origin + '/api/admin-auth/session')).json()).authenticated, 15000, 'original setup flow');
    const session = await (await nativeContext.request.get(origin + '/api/admin-auth/session')).json();
    assert.equal(session.user.username, 'admin');
    const writeHeaders = { Origin: origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken };
    const renewed = await (await vendorApi('/api/sign', { ...document.payload, licenseId: 'LIC-RENEWAL', expiresAt: '9999-12-31T23:59:59.000Z' })).json();
    // Keep the desktop IPC/setup assertions in the real hidden native window.
    // Capture the same admin page in a normal headless renderer: capturing a
    // hidden Electron HWND can wait forever for a compositor frame on Windows.
    const adminContext = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
    await adminContext.addCookies(await nativeContext.cookies());
    await adminContext.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'settings', settingsSubpage: 'license' })));
    adminPage = await adminContext.newPage(); adminPage.on('pageerror', e => errors.push(e.message));
    await adminPage.goto(origin + '/admin');
    await adminPage.getByRole('heading', { name: '授权信息', exact: true }).waitFor();
    await adminPage.getByRole('button', { name: '续期 / 更新授权', exact: true }).click();
    await adminPage.getByLabel('新激活码', { exact: true }).fill('HTA1.bad.bad');
    let renewalResponse = adminPage.waitForResponse(r => r.url() === origin + '/api/license' && r.request().method() === 'PUT');
    await adminPage.getByRole('button', { name: '更新授权', exact: true }).click();
    assert.equal((await renewalResponse).status(), 400);
    assert.equal((await nativeContext.request.get(origin + '/api/license/history').then(r => r.json())).records.length, 1);
    const processBeforeRenewal = (await (await fetch(origin + '/api/health')).json()).engine.process.pid;
    await adminPage.getByLabel('新激活码', { exact: true }).fill(renewed.activationCode);
    renewalResponse = adminPage.waitForResponse(r => r.url() === origin + '/api/license' && r.request().method() === 'PUT');
    await adminPage.getByRole('button', { name: '更新授权', exact: true }).click();
    const renewal = await renewalResponse;
    assert.equal(renewal.status(), 200, await renewal.text());
    assert.equal((await (await fetch(origin + '/api/health')).json()).engine.process.pid, processBeforeRenewal, 'renewal does not restart collection');
    const history = await (await nativeContext.request.get(origin + '/api/license/history')).json();
    assert.equal(history.records.length, 2); assert.equal(history.records[0].licenseId, 'LIC-RENEWAL'); assert.equal(history.records[0].current, true);
    assert.equal(history.records[1].activationCode, code);
    await nativeContext.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'settings', settingsSubpage: 'license' })));
    await startup.reload();
    await startup.getByRole('heading', { name: '授权信息', exact: true }).waitFor();
    await startup.getByRole('region', { name: '本机激活记录', exact: true }).waitFor();
    await startup.locator('.license-history').getByText('LIC-RENEWAL', { exact: true }).waitFor();
    assert.equal(await startup.getByText('LIC-RENEWAL', { exact: true }).count(), 2);
    await startup.getByRole('button', { name: '查看激活码', exact: true }).first().evaluate(button => button.click());
    assert.match(await startup.locator('.license-code-view textarea').inputValue(), /^HTA1\./);
    await adminPage.getByRole('region', { name: '本机激活记录', exact: true }).getByText('LIC-RENEWAL', { exact: true }).waitFor();
    await adminPage.getByRole('button', { name: '查看激活码', exact: true }).first().click();
    await adminPage.locator('.license-settings-panel').screenshot({ path: path.join(sandbox.directory, '03-license-history.png'), animations: 'disabled' });
    fs.writeFileSync(path.join(sandbox.directory, 'native-license-history.txt'), await startup.locator('.license-settings-panel').innerText());
    check('original six-character password setup still works; owner renewal retains both codes and the actual admin page displays the activation history');
    await stopOwnedSmokeProcess(desktop); desktop = null; await nativeBrowser.close().catch(() => {}); nativeBrowser = null;
    await stopOwnedSmokeProcess(backend); await startBackend();
    assert.equal((await createActivationClient(origin).status()).required, false);
    const afterRestart = await (await fetch(origin + '/api/license')).json(); assert.equal(afterRestart.licenseId, 'LIC-RENEWAL');
    check('service restart retains activation and renewal; startup no longer asks for a code');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory: sandbox.directory };
    fs.writeFileSync(path.join(sandbox.directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    if (adminPage) {
        await adminPage.screenshot({ path: path.join(sandbox.directory, 'admin-failure.png'), fullPage: true, timeout: 5000 }).catch(() => {});
        fs.writeFileSync(path.join(sandbox.directory, 'admin-failure.txt'), await adminPage.locator('body').innerText().catch(() => 'unavailable'));
    }
    for (const [index, native] of (nativeBrowser?.contexts()[0]?.pages() || []).entries()) {
        await native.screenshot({ path: path.join(sandbox.directory, `native-failure-${index}.png`), fullPage: true, timeout: 2000 }).catch(() => {});
        fs.writeFileSync(path.join(sandbox.directory, `native-failure-${index}.txt`), await native.locator('body').innerText().catch(() => 'unavailable'));
    }
    await page?.screenshot({ path: path.join(sandbox.directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1;
}).finally(async () => { await nativeBrowser?.close().catch(() => {}); await browser?.close(); for (const child of [desktop, backend, issuer]) await stopOwnedSmokeProcess(child); });
