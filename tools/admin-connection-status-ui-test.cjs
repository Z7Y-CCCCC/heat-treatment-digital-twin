// Owned loopback fixture only: do not touch installed settings, PLCs or Unity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { adminConnectionStatus } = require('../backend/services/adminConnectionStatus');
const directory = createRunDirectory('admin-connection-status-ui'), checks = [], errors = [];
let server, browser, page, info, actualSnapshotEvidence, fixtureDevices = [], mode = 'simulation', rowStates = [], unityConnected = true;
let unitySceneReady = true, databaseConnected = true, statusUnavailable = false, collectionAllowed = true, controlWrites = 0;
const mockHits = { native: 0, nativePreview: 0, engine: 0, devices: 0, connections: 0 };
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const badge = kind => page.locator(`[data-connection-kind="${kind}"]`);
const tooltip = () => page.locator('.admin-service-connection-panel[role="dialog"]');
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
function connectionPayload(factoryId = 'owned-fixture') {
  const now = Date.now(), factory = statusPayload();
  if (mode === 'external') factory.plcStatus.devices = [];
  return adminConnectionStatus({ now, factoryId, factory,
    engine: { ...factory, process: { status: 'running', lastHeartbeatAt: now } }, configuredMode: mode,
    pluginInstalled: true, databaseConnected, collectionAllowed,
    unityHealth: { status: unityConnected ? 'online' : 'offline', connectedClients: unityConnected ? 1 : 0,
      sceneReadyClients: unityConnected && unitySceneReady ? 1 : 0, lastCommunicationAt: unityConnected ? now : null },
    sessionStatus: { authenticated: true, expiresAt: now + 60000 }, runtime: { role: 'collector', owner: 'standalone' } });
}
async function expectPlug(target, connected) {
  assert.equal(await target.locator('svg[data-plug-state]').getAttribute('data-plug-state'), connected ? 'connected' : 'disconnected');
  assert.equal(await target.locator('svg[data-plug-state]').getAttribute('aria-hidden'), 'true');
}
async function expectRows(states, simulated = false) {
  assert.equal(await tooltip().locator('[data-device-id]').count(), fixtureDevices.length);
  for (let index = 0; index < fixtureDevices.length; index++) {
    const device = fixtureDevices[index], row = deviceRow(device.id);
    // Screen-reader labels may convey status; the visible row must use only
    // the device name and connected/disconnected plug, not state wording.
    assert.equal((await row.innerText()).trim(), device.name);
    await expectPlug(row, !simulated && states[index]);
    assert.ok((await row.getAttribute('class')).split(/\s+/).includes(states[index] ? simulated ? 'is-partial' : 'is-online' : 'is-offline'),
      'individual row color reflects its own observed reading quality without simulation false-green');
  }
}
async function openTooltip() {
  await page.mouse.move(5, 5);
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
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(?:engine\/restart|collector\/mode|database)(?:[/?]|$)/.test(request.url())) controlWrites++;
  });
  // Only this owned page receives controlled state transitions. All login,
  // permission, shell and unrelated requests continue to the owned backend.
  await page.route('**/api/engine/status', route => { mockHits.engine++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(statusPayload()) }); });
  await page.route('**/api/system/connections/status', route => {
    mockHits.connections++;
    return route.fulfill({ status: statusUnavailable ? 503 : 200, contentType: 'application/json', body: JSON.stringify(statusUnavailable
      ? { success: false, error: 'Owned connection probe unavailable' } : connectionPayload(route.request().headers()['x-factory-id'] || 'owned-fixture')) });
  });
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
  await badge('unity').waitFor(); await badge('devices').waitFor(); await expectTone('is-partial');
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
  const actualSummaryResponse = await page.request.get(info.origin + '/api/system/connections/status');
  assert.equal(actualSummaryResponse.status(), 200, 'actual new status route is mounted and authenticated');
  const actualSummary = await actualSummaryResponse.json();
  assert.deepEqual(actualSummary.services.map(service => service.key), ['unity', 'devices', 'data', 'session']);
  assert.equal(actualSummary.collection.mode, 'simulation'); assert.equal(actualSummary.collection.processRunning, true);
  assert.notEqual(actualSummary.services[1].tone, 'is-online'); assert.equal(actualSummary.services[1].connected, false);
  actualSnapshotEvidence.newStatusSummary = { mode: actualSummary.collection.mode, processRunning: actualSummary.collection.processRunning,
    tone: actualSummary.services[1].tone, factoryScopedRows: actualSummary.collection.devices.length };
  pass('actual owned simulator engine status exposes named, unique per-device rows backed by fresh good readings independently of route mocks');
  await waitUntil(async () => await badge('unity').locator('svg[data-plug-state]').getAttribute('data-plug-state') === 'connected', 12000, 'first Unity status check completes with connected plug');
  assert.equal(await page.locator('[data-connection-kind]').count(), 4);
  for (const kind of ['unity', 'devices', 'data', 'session']) {
    assert.equal((await badge(kind).innerText()).trim(), '', 'four pills are icon-only');
    assert.ok((await badge(kind).getAttribute('aria-label')).length > 4, 'icon buttons retain meaningful service labels');
    assert.equal((await badge(kind).boundingBox()).height, 32, 'existing 32px capsule height is preserved');
  }
  assert.equal(await page.locator('.admin-connection-strip .admin-connection-pill i').count(), 0, 'old round status dots are gone');
  await expectPlug(badge('unity'), true); await expectPlug(badge('devices'), false);
  await expectPlug(badge('data'), true); await expectPlug(badge('session'), true);
  await openTooltip(); await expectRows(rowStates, true); assert.match(await tooltip().innerText(), /模拟/);
  await snapshot('01-four-icons-simulation-not-green.png');
  pass('four icon-only 32px capsules use exact service status; real simulator quality remains visible but simulation is amber, never green PLC');

  rowStates[1] = false; unityConnected = false;
  await expectTone('is-partial');
  await waitUntil(async () => await badge('unity').locator('svg[data-plug-state]').getAttribute('data-plug-state') === 'disconnected', 12000, 'Unity disconnected plug');
  await expectRows(rowStates, true); await snapshot('02-simulation-quality-and-unity-offline.png');
  assert.match(await badge('devices').getAttribute('aria-label'), /模拟/);
  pass('simulation stays non-green while an individual failed reading turns its own row red; Unity disconnects independently');

  mode = 'integrated_plc'; rowStates = fixtureDevices.map(() => false); await expectTone('is-offline');
  // A real acquisition-mode change dismisses obsolete context. Re-enter the
  // same hover surface rather than pretending the old panel remains current.
  await openTooltip(); await expectRows(rowStates);
  await expectPlug(badge('devices'), false); await snapshot('03-all-disconnected.png');
  pass('all real PLC links down are red with split plugs, without visible row status text or generic API-up false-green');

  await closeTooltip(); await badge('devices').focus(); await tooltip().waitFor({ state: 'visible' });
  assert.equal(await badge('devices').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape'); await tooltip().waitFor({ state: 'hidden' });
  assert.equal(await badge('devices').getAttribute('aria-expanded'), 'false');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await badge('devices').click(); await tooltip().waitFor({ state: 'visible' }); await expectRows(rowStates);
  await closeTooltip();
  assert.equal(await badge('devices').getAttribute('aria-haspopup'), 'dialog');
  pass('keyboard focus opens the non-modal status dialog, Escape dismisses it and touch-style button click shows device link status');

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
  assert.doesNotMatch(await badge('devices').getAttribute('aria-label'), /模拟/);
  await openTooltip(); await expectRows(rowStates); await closeTooltip();
  rowStates[1] = false; await expectTone('is-partial');
  await openTooltip(); await expectRows(rowStates); await closeTooltip();
  mode = 'external'; await waitUntil(async () => (await badge('devices').getAttribute('aria-label')).includes('外部接口'), 12000, 'external mode label');
  assert.doesNotMatch(await badge('devices').getAttribute('aria-label'), /模拟/);
  pass('real PLC and external modes retain accurate labels rather than being called simulation');

  unityConnected = true; unitySceneReady = false;
  await waitUntil(async () => (await badge('unity').getAttribute('aria-label')).includes('场景同步中'), 12000, 'Unity channel online but scene pending');
  await expectPlug(badge('unity'), false); await badge('unity').click(); await tooltip().waitFor();
  assert.match(await tooltip().innerText(), /实时通道在线，场景尚未就绪/); await snapshot('05-unity-scene-pending.png'); await closeTooltip();
  databaseConnected = false;
  await waitUntil(async () => (await badge('data').getAttribute('aria-label')).includes('数据库连接异常'), 12000, 'API up database down');
  await expectPlug(badge('data'), false); await badge('data').click(); await tooltip().waitFor();
  assert.match(await tooltip().innerText(), /API 可达，数据库不可用/); await snapshot('06-api-up-database-down.png'); await closeTooltip();
  databaseConnected = true; mode = 'integrated_plc'; rowStates = fixtureDevices.map(() => true); collectionAllowed = false;
  await waitUntil(async () => (await badge('devices').getAttribute('aria-label')).includes('无权限查看'), 12000, 'collection permission denied');
  await badge('devices').click(); await tooltip().waitFor();
  assert.equal(await tooltip().locator('[data-device-id]').count(), 0); assert.match(await tooltip().innerText(), /无权限查看设备明细/);
  await snapshot('07-permission-filtered.png'); await closeTooltip();
  collectionAllowed = true;
  await expectTone('is-online');
  await badge('devices').click(); await tooltip().waitFor();
  const writesBefore = controlWrites, probesBefore = mockHits.connections;
  const check = tooltip().locator('[data-connection-action="check"]');
  assert.equal((await check.innerText()).trim(), '', 'operation button is icon-only');
  await check.click(); await waitUntil(() => mockHits.connections > probesBefore, 12000, 'explicit read-only detection');
  assert.equal(controlWrites, writesBefore, 'detect never restarts engine, changes mode or touches database configuration');
  await waitUntil(async () => (await tooltip().innerText()).includes('已重新检测'), 12000, 'read-only check feedback');
  await closeTooltip();
  statusUnavailable = true;
  await waitUntil(async () => (await badge('data').getAttribute('aria-label')).includes('检测失败'), 12000, 'failed status request');
  for (const kind of ['unity', 'devices', 'data', 'session']) await expectPlug(badge(kind), false);
  await snapshot('08-detection-failure-not-green.png');
  pass('Unity scene pending, database failure, restricted rows and failed detection remain accurate non-green states; icon check is truly read-only');
  assert.ok(mockHits.connections > 5, 'full AdminPanel polls the new minimal status endpoint');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, checks, errors, mockHits, controlWrites, actualSnapshotEvidence, screenshotDirectory: directory }, null, 2));
  console.log('REPORT ' + directory);
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  const badgeDiagnostics = page ? await page.locator('[data-connection-kind]').evaluateAll(elements => elements.map(element => ({ kind: element.dataset.connectionKind, label: element.getAttribute('aria-label'), class: element.className, icon: element.querySelector('svg[data-plug-state]')?.getAttribute('data-plug-state') }))).catch(() => []) : [];
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: false, checks, errors, mockHits, badgeDiagnostics, failure: error.stack, screenshotDirectory: directory }, null, 2));
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
