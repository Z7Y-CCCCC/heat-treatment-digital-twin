// Owned loopback fixture only: do not touch installed settings, PLCs or Unity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('admin-connection-status-ui'), checks = [], errors = [];
let server, browser, page, info, actualSnapshotEvidence, fixtureDevices = [], mode = 'simulation', rowStates = [], unityConnected = true;
const mockHits = { native: 0, nativePreview: 0, engine: 0, devices: 0 };
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const badge = kind => page.locator(`[data-connection-kind="${kind}"]`);
const tooltip = () => page.locator('.admin-device-connection-tooltip[role="tooltip"]');
const deviceRow = id => tooltip().locator(`[data-device-id="${id}"]`);
function statusPayload() {
  const now = Date.now();
  return { mode, observedAt: now, configuredDevices: fixtureDevices.length,
    plcStatus: { status: mode === 'simulation' ? 'simulating' : 'connected', timestamp: now, message: 'Owned fixture data',
      devices: fixtureDevices.map((device, index) => ({ deviceId: device.id, deviceName: device.name,
        status: rowStates[index] === false ? 'error' : 'connected', quality: rowStates[index] === false ? 'bad' : 'good',
        lastReadAt: rowStates[index] === false ? null : now, lastSuccessAt: rowStates[index] === false ? null : now, timestamp: now })) },
    collectorStatus: { status: mode === 'simulation' ? 'simulating' : 'connected', devices: fixtureDevices.length, lastFrameAt: now } };
}
async function expectTone(tone) {
  await waitUntil(async () => (await badge('devices').getAttribute('class')).split(/\s+/).includes(tone), 12000, 'connection badge ' + tone);
}
async function expectPlug(target, connected) {
  assert.equal(await target.locator('svg[data-plug-state]').getAttribute('data-plug-state'), connected ? 'connected' : 'disconnected');
  assert.equal(await target.locator('svg[data-plug-state]').getAttribute('aria-hidden'), 'true');
}
async function expectRows(states) {
  assert.equal(await tooltip().locator('[data-device-id]').count(), fixtureDevices.length);
  for (let index = 0; index < fixtureDevices.length; index++) {
    const device = fixtureDevices[index], row = deviceRow(device.id);
    // Screen-reader labels may convey status; the visible row must use only
    // the device name and connected/disconnected plug, not state wording.
    assert.equal((await row.innerText()).trim(), device.name);
    await expectPlug(row, states[index]);
  }
}
async function openTooltip() {
  await badge('devices').hover();
  await tooltip().waitFor({ state: 'visible' });
  const triggerBox = await badge('devices').boundingBox(), tipBox = await tooltip().boundingBox();
  assert.ok(tipBox.y >= triggerBox.y + triggerBox.height - 2, 'device tooltip appears below its trigger');
}
async function closeTooltip() {
  await page.mouse.move(5, 5);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await tooltip().waitFor({ state: 'hidden' });
}
async function snapshot(name) {
  await page.screenshot({ path: path.join(directory, name), fullPage: false });
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned header connection backend');
  info = JSON.parse(fs.readFileSync(infoFile));
  fixtureDevices = info.devices.map((id, index) => ({ id, name: `图标验收设备 ${index + 1}`, plc_enabled: 1,
    model_type: 'builtin_furnace', line_id: '', workshop_id: '', instance_config: '{}' }));
  rowStates = fixtureDevices.map(() => true);
  browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1680, height: 1080 } });
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'workshops' })));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  // Only this owned page receives controlled state transitions. All login,
  // permission, shell and unrelated requests continue to the owned backend.
  await page.route('**/api/engine/status', route => { mockHits.engine++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusPayload()) }); });
  await page.route('**/api/native-preview/status', route => { mockHits.native++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unityClients: unityConnected ? 1 : 0 }) }); });
  // Initial workshop/spatial preview also reports Unity client count. Keep
  // that controlled response consistent with the controlled status endpoint,
  // rather than racing a real zero-client preview against fake GET=1.
  await page.route('**/api/native-preview', route => { mockHits.nativePreview++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, unityClients: unityConnected ? 1 : 0 }) }); });
  await page.route('**/api/devices', route => { mockHits.devices++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureDevices) }); });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await badge('unity').waitFor(); await badge('devices').waitFor(); await expectTone('is-online');
  // APIRequestContext is not routed by page.route. This proves the real
  // owned collector also exposes individual simulator snapshot health, not
  // just the controlled UI fixture below.
  let actual;
  await waitUntil(async () => {
    const response = await page.request.get(info.origin + '/api/engine/status');
    assert.equal(response.status(), 200, 'owned engine status is authenticated');
    actual = await response.json();
    return actual.mode === 'simulation' && Array.isArray(actual.plcStatus?.devices) && actual.plcStatus.devices.length > 0
      && actual.plcStatus.devices.some(row => row.status === 'connected' && row.quality === 'good' && row.lastReadAt);
  }, 20000, 'real owned simulator per-device snapshot rows');
  const realRows = actual.plcStatus.devices;
  assert.equal(new Set(realRows.map(row => row.deviceId)).size, realRows.length, 'real snapshot IDs are unique');
  assert.equal(realRows.length, actual.configuredDevices, 'real snapshot rows cover configured simulator devices');
  const freshConnected = realRows.filter(row => {
    const timestamp = Number(row.lastReadAt) || Date.parse(row.lastReadAt);
    return row.status === 'connected' && row.quality === 'good' && Number.isFinite(timestamp) && Date.now() - timestamp < 6000;
  });
  assert.equal(freshConnected.length, realRows.length, 'actual running simulator links have fresh good readings');
  assert.ok(realRows.every(row => row.deviceName), 'actual snapshot rows preserve device names');
  actualSnapshotEvidence = { mode: actual.mode, configuredDevices: actual.configuredDevices, snapshotRows: realRows.length, freshConnected: freshConnected.length };
  pass('actual owned simulator engine status exposes named, unique per-device rows backed by fresh good readings independently of route mocks');
  await waitUntil(async () => await badge('unity').locator('svg[data-plug-state]').getAttribute('data-plug-state') === 'connected', 12000, 'first Unity status check completes with connected plug');
  assert.equal((await badge('unity').innerText()).trim(), 'Unity');
  assert.equal((await badge('devices').innerText()).trim(), '模拟运行');
  assert.equal(await page.locator('.admin-connection-strip .admin-connection-pill i').count(), 0, 'old round status dots are gone');
  await expectPlug(badge('unity'), true); await expectPlug(badge('devices'), true);
  await openTooltip(); await expectRows(rowStates); await snapshot('01-all-connected.png');
  pass('Unity and simulation badges use connected plug icons, green total connectivity and device-only names in the below-trigger tooltip');

  rowStates[1] = false; unityConnected = false;
  await expectTone('is-partial');
  await waitUntil(async () => await badge('unity').locator('svg[data-plug-state]').getAttribute('data-plug-state') === 'disconnected', 12000, 'Unity disconnected plug');
  await expectRows(rowStates); await snapshot('02-partial-and-unity-disconnected.png');
  assert.equal((await badge('unity').innerText()).trim(), 'Unity');
  assert.equal((await badge('devices').innerText()).trim(), '模拟运行');
  pass('per-device failure is yellow instead of aggregate simulation false-green; Unity is a split plug and each row uses its own connection icon');

  rowStates = fixtureDevices.map(() => false); await expectTone('is-offline'); await expectRows(rowStates);
  await expectPlug(badge('devices'), false); await snapshot('03-all-disconnected.png');
  pass('all device links down are red with split plugs, without visible connected/disconnected status text');

  await closeTooltip(); await badge('devices').focus(); await tooltip().waitFor({ state: 'visible' });
  assert.equal(await badge('devices').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape'); await tooltip().waitFor({ state: 'hidden' });
  assert.equal(await badge('devices').getAttribute('aria-expanded'), 'false');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await badge('devices').click(); await tooltip().waitFor({ state: 'visible' }); await expectRows(rowStates);
  await closeTooltip();
  pass('keyboard focus opens the tooltip, Escape dismisses it and touch-style button click can show device link status');

  const originals = fixtureDevices;
  fixtureDevices = Array.from({ length: 48 }, (_, index) => ({ ...originals[index % originals.length],
    id: `header_test_device_${index}`, name: `滚动验收设备 ${String(index + 1).padStart(2, '0')}` }));
  rowStates = fixtureDevices.map((_, index) => index % 3 !== 0);
  await page.reload(); await badge('devices').waitFor(); await expectTone('is-partial'); await openTooltip(); await expectRows(rowStates);
  const overflow = await tooltip().evaluate(element => {
    const candidates = [element, ...element.querySelectorAll('*')];
    const scroll = candidates.find(item => item.scrollHeight > item.clientHeight + 5 && ['auto', 'scroll'].includes(getComputedStyle(item).overflowY));
    return scroll ? { scrollable: true, height: scroll.clientHeight, scrollHeight: scroll.scrollHeight } : { scrollable: false };
  });
  assert.equal(overflow.scrollable, true); assert.ok(overflow.height < 600);
  const box = await tooltip().boundingBox(); assert.ok(box.y + box.height <= 1080, 'long device list stays within viewport');
  await tooltip().evaluate(element => {
    const scroll = [element, ...element.querySelectorAll('*')].find(item => item.scrollHeight > item.clientHeight + 5 && ['auto', 'scroll'].includes(getComputedStyle(item).overflowY));
    scroll.scrollTop = scroll.scrollHeight;
  });
  await snapshot('04-scrollable-device-links.png'); await closeTooltip();
  pass('long per-device link list is scrollable, keeps individual icon states and remains bounded within the viewport');

  fixtureDevices = originals; rowStates = originals.map(() => true); mode = 'integrated_plc';
  await page.reload(); await badge('devices').waitFor(); await expectTone('is-online');
  assert.doesNotMatch(await badge('devices').innerText(), /模拟/);
  await openTooltip(); await expectRows(rowStates); await closeTooltip();
  mode = 'external'; await waitUntil(async () => (await badge('devices').innerText()).trim() === '外部接口', 12000, 'external mode label');
  assert.doesNotMatch(await badge('devices').innerText(), /模拟/);
  pass('real PLC and external modes retain accurate labels rather than being called simulation');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, checks, errors, actualSnapshotEvidence, screenshotDirectory: directory }, null, 2));
  console.log('REPORT ' + directory);
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  const badgeDiagnostics = page ? await page.locator('[data-connection-kind]').evaluateAll(elements => elements.map(element => ({ kind: element.dataset.connectionKind, label: element.getAttribute('aria-label'), class: element.className, icon: element.querySelector('svg')?.getAttribute('data-plug-state') }))).catch(() => []) : [];
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: false, checks, errors, mockHits, badgeDiagnostics, failure: error.stack, screenshotDirectory: directory }, null, 2));
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
