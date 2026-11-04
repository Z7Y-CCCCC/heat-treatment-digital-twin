'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('model-asset-transfer-browser'), root = path.resolve(__dirname, '..'), checks = [], errors = [];
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'empty-install-ui-server.cjs')], { cwd: root, env: { ...process.env, EMPTY_INSTALL_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'empty system UI backend');
    const info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'models', modelLibraryStep: 'library' })));
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const transfer = page.getByRole('region', { name: '项目模型与动作文件导入导出' }); await transfer.waitFor();
    assert.deepEqual(await (await page.request.get(info.origin + '/api/models')).json(), []);
    assert.equal(await page.locator('.model-table tbody tr[data-model-id]').count(), 0);
    await page.screenshot({ path: path.join(directory, '01-empty-model-library.png'), fullPage: true }); checks.push('empty installation login and model library render without seeded model cards or UI exceptions');
    // Factory creation is separately HTTP-tested; here establish one using the
    // authenticated fixture session, then exercise the real visible import UI.
    const response = await fetch(info.origin + '/api/factories', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie, 'X-CSRF-Token': info.session.csrfToken }, body: JSON.stringify({ name: '资产导入 UI 验收工厂', location: { country: 'CHN' } }) });
    assert.equal(response.status, 201); await page.reload(); await transfer.waitFor();
    await transfer.getByLabel('选择模型动作资产 ZIP').setInputFiles(path.join(root, '导入文件/正式模型资产/cad_fixed_load_table_112200.zip'));
    await transfer.getByRole('button', { name: '确认导入当前工厂（创建新资产）', exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, '02-inspected-model-motion-package.png'), fullPage: true });
    await transfer.getByRole('button', { name: '确认导入当前工厂（创建新资产）', exact: true }).click();
    await transfer.getByText(/已导入到当前工厂/).waitFor();
    const models = await (await page.request.get(info.origin + '/api/models')).json(); assert.equal(models.length, 1); assert.ok(models[0].motion_package?.actions.length);
    const row = page.locator(`[data-model-id="${models[0].id}"]`); await row.waitFor(); await row.locator('td').nth(2).click();
    await page.locator('.model-preview-footer').getByText(/^预览：.*尺寸/).waitFor();
    await page.screenshot({ path: path.join(directory, '03-imported-model-with-preview.png'), fullPage: true });
    checks.push('visible ZIP selection, checksum inspection, explicit import, model row and GLB preview work together');
    const downloadPromise = page.waitForEvent('download'); await transfer.getByRole('button', { name: '导出模型及动作文件', exact: true }).click();
    const download = await downloadPromise, downloaded = path.join(directory, 'downloaded-model-asset.zip'); await download.saveAs(downloaded);
    const validated = await require('../backend/services/modelAssetBundle').inspectAsset(downloaded); assert.ok(validated.actions.length);
    checks.push('visible export button downloads a valid model+motion file package');
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, directory }, null, 2)); console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(async error => { await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1; })
    .finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
