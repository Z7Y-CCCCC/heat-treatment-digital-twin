'use strict';
// Replay only the supplementary toolbar checks against a prior owned fixture.
// Never accepts the live application's database or operates its browser window.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BACKEND_DIR, createRunDirectory, findFreePort, requireTestPath, startLoggedProcess, waitForHttp, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
assert.ok(fixturePath, 'provide an existing owned fixture server.json');
const fixture = JSON.parse(fs.readFileSync(requireTestPath(fixturePath), 'utf8'));
assert.equal(fixture.env?.DESKTOP_SMOKE_ISOLATED, 'true');
assert.equal(fixture.env?.APP_EMPTY_INSTALL, '1');
requireTestPath(fixture.env.SQLITE_FILE); requireTestPath(fixture.env.APP_USER_DATA_DIR);
assert.equal(path.dirname(fixture.env.SQLITE_FILE), path.join(fixture.env.APP_USER_DATA_DIR, 'data'));
const directory = createRunDirectory('model-package-toolbar-followup'), checks = [], errors = [];
let backend, browser, page;
(async () => {
  const origin = 'http://127.0.0.1:' + await findFreePort();
  backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR, env: { ...process.env, ...fixture.env, PORT: new URL(origin).port, HOST: '127.0.0.1', FRONTEND_DIST: path.resolve(__dirname, '../frontend/dist') }, logFile: path.join(directory, 'backend.log') });
  await waitForHttp(origin + '/api/health');
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'model-animations', motionWorkspaceMode: 'live' })));
  page = await context.newPage(); page.setDefaultTimeout(120000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(fixture.username); await page.getByLabel('后台密码', { exact: true }).fill(fixture.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.getByRole('banner', { name: '后台工具栏', exact: true }).waitFor();
  const before = await (await page.request.get(origin + '/api/models')).json(); assert.equal(before.length, 3);
  assert.equal(await page.getByRole('dialog').count(), 0);
  const transfer = page.getByRole('group', { name: '动作包导入导出', exact: true });
  for (const [index, mode] of ['实时联动', '设备联动', '部件动作'].entries()) {
    const button = page.getByRole('navigation', { name: '动作动画模式' }).getByRole('button', { name: mode, exact: true });
    await button.click({ noWaitAfter: true });
    await waitUntil(async () => { assert.equal(backend.exitCode, null); return await button.getAttribute('aria-pressed') === 'true'; }, 120000, 'owned toolbar workspace mode');
    assert.equal(await transfer.getByRole('button').count(), 2); assert.equal(await page.getByText('项目导入文件', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(directory, `${index + 1}-${['live', 'transfer', 'parts'][index]}.png`) });
    checks.push(mode + ' keeps exactly two compact package actions in a fresh page of the imported fixture');
  }
  assert.deepEqual(await (await page.request.get(origin + '/api/models')).json(), before, 'toolbar checks must not edit or duplicate imported models');
  assert.deepEqual(errors, []);
  const result = { success: true, scope: 'supplementary-toolbar-only', fixture: fixturePath, checks, errors, directory };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => { await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(backend); });
