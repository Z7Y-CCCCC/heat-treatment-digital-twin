// Private backend/browser/native-WebSocket fixture only; never drives the user's app.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { once } = require('node:events');
const Database = require('../backend/node_modules/better-sqlite3');
const WebSocket = require('../backend/node_modules/ws');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), directory = createRunDirectory('scene-camera-controls-ui');
const checks = [], errors = [], commands = [];
let server, browser, page, native;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: root, env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'private server');
  const info = JSON.parse(fs.readFileSync(infoFile));
  const db = new Database(info.database), scope = db.prepare('SELECT w.factory_id AS factoryId,w.id AS workshopId,l.id AS lineId FROM workshops w JOIN lines l ON l.workshop_id=w.id JOIN devices d ON d.line_id=l.id WHERE d.id=?').get(info.devices[0]); db.close();
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1598, height: 867 } });
  await context.addInitScript(() => {
    window.__DIGITAL_TWIN_NATIVE_LOADING__ = true;
    window.__cameraHostMessages = [];
    window.chrome = { webview: { postMessage(message) { window.__cameraHostMessages.push(message); }, addEventListener() {}, removeEventListener() {} } };
  });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await page.getByRole('banner', { name: '后台工具栏' }).waitFor();
  const cookie = (await context.cookies(info.origin)).map(c => `${c.name}=${c.value}`).join('; ');
  native = new WebSocket(info.origin.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
  native.on('message', bytes => { const message = JSON.parse(bytes); if (message.type === 'native_scene_preview') commands.push(message.payload); });
  await once(native, 'open'); native.send(JSON.stringify({ type: 'client_hello', role: 'unity' }));
  let sequence = 0;
  const publish = sceneReady => native.send(JSON.stringify({ type: 'dashboard_context', payload: { ...scope, viewId: 'line_overview', viewMode: 'line', sceneId: 'owned-scene', sceneReady,
    startupLoading: { loadId: 'camera-ui-load', sequence: ++sequence, progress: sceneReady ? 100 : 50, step: sceneReady ? '场景已就绪' : '正在加载' } } }));
  publish(true);
  await page.goto(info.origin + '/overlay?embedded=unity&surface=overlay&scene=1&factoryId=' + scope.factoryId);
  const trigger = page.getByRole('button', { name: '调整视角（无需滚轮）', exact: true });
  await trigger.waitFor(); publish(true);
  await trigger.click();
  const panel = page.getByRole('group', { name: '视角调整', exact: true }); await panel.waitFor();
  await waitUntil(() => panel.getByRole('button', { name: '拉近', exact: true }).isEnabled(), 20000, 'native-ready camera controls');
  for (const [label, action] of [['拉近', 'zoomIn'], ['拉远', 'zoomOut'], ['向左旋转', 'rotateLeft'], ['向右旋转', 'rotateRight'], ['恢复视角', 'fit']]) {
    const count = commands.length;
    await panel.getByRole('button', { name: label, exact: true }).click();
    await waitUntil(() => commands.length === count + 1, 10000, action + ' native relay');
    assert.equal(commands.at(-1).action, 'camera'); assert.equal(commands.at(-1).cameraAction, action);
    assert.equal(commands.at(-1).viewId, 'line_overview'); assert.equal(commands.at(-1).focus.lineId, scope.lineId);
    assert.equal(commands.at(-1).factoryId, scope.factoryId); assert.equal(commands.at(-1).includeLayout, undefined);
    await waitUntil(async () => await panel.getAttribute('aria-busy') === 'false', 5000, 'request finished');
  }
  pass('all five left-click actions reach the secured native relay and preserve current line/factory without layout writes');
  for (const width of [1598, 1280, 720]) {
    await page.setViewportSize({ width, height: 680 });
    const box = await trigger.boundingBox(), menu = await panel.boundingBox();
    assert.ok(Math.abs(box.x + box.width - (width - 16)) < 2 && Math.abs(box.y + box.height - 660) < 2);
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= width);
  }
  await page.setViewportSize({ width: 1280, height: 680 });
  await page.screenshot({ path: path.join(directory, 'camera-controls-expanded.png'), animations: 'disabled' });
  await panel.screenshot({ path: path.join(directory, 'camera-controls-detail.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
  assert.equal(page.url().includes('/overlay?'), true); assert.equal(commands.length, 5);
  await trigger.focus(); await page.keyboard.press('Enter'); await panel.waitFor();
  await page.mouse.click(640, 360); await panel.waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(directory, 'camera-controls-collapsed.png'), animations: 'disabled' });
  pass('the small lower-right button fits 720–1598px widths; keyboard/outside dismissal does not navigate away');
  await trigger.click(); await panel.waitFor(); publish(false);
  await waitUntil(async () => !(await panel.getByRole('button', { name: '拉近', exact: true }).isEnabled()), 5000, 'loading blocks commands');
  publish(true); await waitUntil(() => panel.getByRole('button', { name: '拉近', exact: true }).isEnabled(), 5000, 'scene-ready recovery');
  native.close(); await once(native, 'close');
  await panel.getByRole('button', { name: '拉近', exact: true }).click();
  await panel.getByRole('alert').waitFor(); assert.match(await panel.getByRole('alert').innerText(), /未连接/);
  pass('loading disables controls and a disconnected native client shows an explicit error rather than false success');
  assert.deepEqual(errors, []);
  const result = { success: true, checks, browserErrors: errors, commandCount: commands.length, directory };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => { native?.terminate(); await browser?.close(); await stopOwnedSmokeProcess(server); });
