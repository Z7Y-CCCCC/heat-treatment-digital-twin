const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRunDirectory, startLoggedProcess, waitUntil, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const Database = require('../backend/node_modules/better-sqlite3'), playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
let server, browser;
(async () => {
    const directory = createRunDirectory('plc-status-label-ui'), infoFile = path.join(directory, 'fixture.json'), root = path.resolve(__dirname, '..');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], { cwd: root,
        env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 90000, 'isolated UI fixture');
    const info = JSON.parse(fs.readFileSync(infoFile)), db = new Database(requireTestPath(info.database));
    info.devices.forEach((id, i) => db.prepare('UPDATE devices SET name=?,plc_enabled=1,plc_ip=? WHERE id=?').run(i ? '连通无点位设备' : '离线无点位设备', '127.0.0.1', id)); db.close();
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'devices' })));
    await page.route('**/api/engine/status', route => route.fulfill({ json: { mode: 'realtime', collectorStatus: { status: 'running' },
        plcStatus: { status: 'offline', devices: info.devices.map((deviceId, i) => ({ deviceId, status: i ? 'no_points' : 'offline', noReadablePoints: true, plc_ip: '127.0.0.1', lastConnectedAt: i ? Date.now() : null, lastReadAt: null })) } } }));
    await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const offline = page.locator('tr').filter({ has: page.getByText('离线无点位设备', { exact: true }) });
    const online = page.locator('tr').filter({ has: page.getByText('连通无点位设备', { exact: true }) });
    await offline.locator('.plc-offline').getByText('离线', { exact: true }).waitFor();
    await online.locator('.plc-no_points').getByText('无点位', { exact: true }).waitFor();
    assert.equal(await page.getByText('offline', { exact: true }).count(), 0);
    assert.match(await online.innerText(), /最近读取：\s*-/);
    await page.screenshot({ path: path.join(directory, 'chinese-connection-status.png') }); assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, errors, directory }, null, 2)); console.log(JSON.stringify({ success: true, directory }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
