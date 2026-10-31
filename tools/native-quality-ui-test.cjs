// Real Unity + real WebView2 + local named pipes. Uses only an isolated output/ site/profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createSmokeSandbox, createSmokeSession, authorizeSmokeUnity, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp, waitUntil, testFetch } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..');
let backend, unity, browser, page, directory;
(async () => {
    const sandbox = await createSmokeSandbox('native-quality-ui'); directory = sandbox.directory;
    sandbox.password = 'Quality-Fixture-20261031!';
    const origin = `http://127.0.0.1:${await findFreePort()}`, debugPort = await findFreePort();
    const player = path.resolve(process.env.NATIVE_QUALITY_PLAYER || path.join(root, 'unity-client/Builds/Windows/HeatTreatmentDigitalTwin.exe'));
    const host = path.resolve(process.env.NATIVE_QUALITY_HOST || path.join(root, 'unity-client/Builds/Windows/AdminHost/HeatTreatmentAdminHost.exe'));
    assert.ok(fs.existsSync(player) && fs.existsSync(host), 'build the native player and host before testing');
    const logFile = path.join(directory, 'unity.log'), errors = [], checks = [];
    const check = label => { checks.push(label); console.log('PASS ' + label); };
    const log = () => fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...sandbox.env,
        PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: path.join(root, 'frontend/dist') }, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(origin + '/api/health', 90000);
    const session = await createSmokeSession(origin, sandbox);
    const readSettings = () => testFetch(origin + '/api/settings', { headers: { 'X-Admin-Token': sandbox.env.ADMIN_API_TOKEN } }).then(r => r.json());
    let before;
    unity = spawn(player, ['-force-d3d11', '-screen-fullscreen', '0', '-screen-width', '1280', '-screen-height', '850', '-logFile', logFile], {
        cwd: path.dirname(player), windowsHide: false, stdio: 'ignore', env: { ...sandbox.env,
            DIGITAL_TWIN_BACKEND_HTTP_URL: origin, DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws',
            DIGITAL_TWIN_ADMIN_URL: origin + '/admin', DIGITAL_TWIN_ADMIN_HOST_PATH: host,
            DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
            HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost' } });
    fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify({ origin, debugPort, unityPid: unity.pid, logFile }));
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`, 90000);
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const context = browser.contexts()[0];
    // Seed only this fixture's already-authenticated HttpOnly cookie; never use a live profile.
    await context.addCookies(session.cookie.split('; ').map(pair => {
        const separator = pair.indexOf('=');
        return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: origin, httpOnly: true, sameSite: 'Strict' };
    }));
    const admin = await waitUntil(() => context.pages().find(p => p.url().startsWith(origin + '/admin')), 30000, 'owned native admin WebView');
    admin.setDefaultTimeout(30000);
    await admin.reload();
    await admin.getByRole('button', { name: '解锁后台', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await admin.evaluate(() => fetch('/api/admin-auth/session', { credentials: 'include' }).then(r => r.json()).then(s => s.displayAuthenticated)), true);
    await authorizeSmokeUnity(origin, unity, session);
    await waitUntil(() => log().includes('[FactoryRuntime] Native factory ready:'), 120000, 'actual Unity scene');
    await admin.evaluate(() => window.chrome.webview.postMessage({ type: 'host_action', action: 'show_dashboard' }));
    page = await waitUntil(() => context.pages().find(p => p.url().startsWith(origin + '/group')), 30000, 'native map/account surface');
    page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(() => {
        window.__qualityTestStates = [];
        window.chrome.webview.addEventListener('message', event => { if (event.data?.type === 'native_quality_state') window.__qualityTestStates.push(event.data); });
    });
    await page.locator('.group-user').click();
    const capsule = page.getByRole('radiogroup', { name: '画质档位', exact: true });
    await capsule.waitFor();
    await waitUntil(() => capsule.getByRole('radio').first().isEnabled(), 15000, 'actual native quality snapshot');
    assert.equal(await capsule.getByRole('radio').count(), 3);
    assert.equal(await page.locator('.quality-notice').count(), 0, 'startup state must not replay an old success');
    before = await readSettings(); // Exclude one-time host startup defaults from the quality-switch comparison.
    check('account menu has a compact three-position quality capsule initialized from the real renderer');
    async function applied(profile, label, act) {
        const count = await page.evaluate(() => window.__qualityTestStates.length);
        await act();
        const state = await waitUntil(async () => (await page.evaluate(() => window.__qualityTestStates)).slice(count).find(s => s.profile === profile && s.notify), 12000, 'actual renderer acknowledgement: ' + profile);
        assert.ok(Math.abs(state.renderScale - ({ integrated_gpu: .84, balanced: 1, showcase: 1.15 })[profile]) < .001);
        assert.equal(state.msaa, profile === 'integrated_gpu' ? 2 : 4);
        await page.getByRole('status').filter({ hasText: `画质已切换：${label}` }).waitFor();
        await waitUntil(() => page.locator('.quality-notice').evaluate(el => getComputedStyle(el).opacity === '1'), 3000, 'visible quality bubble');
        return state;
    }
    await applied('integrated_gpu', '流畅', () => capsule.getByRole('radio', { name: '流畅 F1', exact: true }).click());
    for (const [key, profile, label] of [['F1', 'integrated_gpu', '流畅'], ['F2', 'balanced', '均衡'], ['F3', 'showcase', '高画质']]) {
        await applied(profile, label, () => page.keyboard.press(key));
        assert.equal(await capsule.getByRole('radio', { name: `${label} ${key}`, exact: true }).getAttribute('aria-checked'), 'true');
    }
    check('F1/F2/F3 change actual URP scale/MSAA, update the capsule and show the acknowledged quality bubble');
    await applied('integrated_gpu', '流畅', () => capsule.getByRole('radio', { name: '流畅 F1', exact: true }).click());
    const box = await capsule.boundingBox();
    await applied('showcase', '高画质', async () => {
        await page.mouse.move(box.x + box.width / 6, box.y + box.height / 2); await page.mouse.down();
        await page.mouse.move(box.x + box.width * 5 / 6, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
    });
    await page.screenshot({ path: path.join(directory, '01-account-capsule-and-bubble.png') });
    check('clicking and dragging the capsule both apply real temporary quality, not just an animated visual selection');
    await page.locator('.quality-notice').waitFor({ state: 'hidden', timeout: 6000 });
    await page.goto(origin + '/overlay?embedded=unity&surface=overlay&scene=1');
    await page.locator('.dashboard-overlay-root.is-scene-ready').waitFor();
    await page.evaluate(() => {
        window.__qualityTestStates = [];
        window.chrome.webview.addEventListener('message', event => { if (event.data?.type === 'native_quality_state') window.__qualityTestStates.push(event.data); });
        window.chrome.webview.postMessage({ type: 'dashboard_action', action: 'get_quality_profile' });
    });
    await waitUntil(() => page.evaluate(() => window.__qualityTestStates.some(s => s.enabled)), 10000, 'factory surface quality snapshot');
    await applied('balanced', '均衡', () => page.keyboard.press('F2'));
    await page.screenshot({ path: path.join(directory, '02-live-scene-quality-bubble.png') });
    assert.deepEqual(await readSettings(), before, 'temporary quality switches must not rewrite saved backend settings');
    assert.doesNotMatch(log(), /(?:NullReferenceException|MissingReferenceException|Unhandled Exception):/);
    assert.deepEqual(errors, []);
    check('live factory screen also shows the bubble; no restart, mesh replacement or persisted configuration change is needed');
    const result = { success: true, unityPid: unity.pid, checks, errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    if (browser) {
        const pages = browser.contexts().flatMap(context => context.pages());
        const snapshots = await Promise.all(pages.map(async p => ({ url: p.url(), text: await p.locator('body').innerText().catch(() => ''),
            states: await p.evaluate(() => window.__qualityTestStates || []).catch(() => []) })));
        fs.writeFileSync(path.join(directory, 'pages.json'), JSON.stringify(snapshots, null, 2));
        if (!page) page = pages.find(p => p.url().includes('/admin')) || pages[0];
    }
    await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close().catch(() => {}); await stopOwnedSmokeProcess(unity); await stopOwnedSmokeProcess(backend); });
