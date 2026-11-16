// Owned loopback fixture only: do not touch installed settings, PLCs or Unity.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { adminConnectionStatus } = require('../backend/services/adminConnectionStatus');
const { createServiceControl, collectorCenterViewForPath, collectorCenterArguments } = require('../desktop/serviceControl.cjs');
const directory = createRunDirectory('admin-connection-status-ui'), checks = [], errors = [];
let server, browser, page, info, actualSnapshotEvidence, fixtureDevices = [], mode = 'simulation', rowStates = [], unityConnected = true;
let unitySceneReady = true, databaseConnected = true, statusUnavailable = false, collectionAllowed = true, controlWrites = 0;
let lockRequests = 0, centerReceiptMode = 'matching';
const anchorEvidence = [], centerLaunchEvidence = [], centerBridgeEvidence = [], unexpectedNativeActions = [];
const centerActionPaths = { collector_center_data: '/service/collector-center/data', collector_center_runtime: '/service/collector-center/runtime' };
// Use the shipped desktop handler and argument mapping, with an owned launch
// seam only. This never contacts the installed private desktop-control port,
// opens a real center, or restarts anything. Real native GUI smoke is separate.
const centerControl = createServiceControl({
  restart: async () => { throw new Error('No restart is permitted in this owned fixture'); },
  openCenter: async ({ view }) => {
    const args = collectorCenterArguments(view);
    assert.deepEqual(args, ['--open-view', view]);
    centerLaunchEvidence.push({ view, args, receiptMode: centerReceiptMode });
    return { opened: true, view: centerReceiptMode === 'matching' ? view : view === 'points' ? 'overview' : 'points' };
  }
});
const mockHits = { native: 0, nativePreview: 0, engine: 0, devices: 0, connections: 0 };
const serviceNames = { unity: 'Unity', devices: '设备采集', data: '数据服务', session: '登录状态' };
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
async function expectAnchor(kind) {
  await page.waitForFunction(owner => {
    const pill = document.querySelector('[data-connection-kind="' + owner + '"]');
    const panel = document.querySelector('.admin-service-connection-panel[role="dialog"]');
    if (!pill || !panel) return false;
    const trigger = pill.getBoundingClientRect(), box = panel.getBoundingClientRect();
    const expectedLeft = Math.max(12, Math.min(trigger.left + trigger.width / 2 - box.width / 2, innerWidth - box.width - 12));
    return Math.abs(box.left - expectedLeft) <= 1.5 && Math.abs(box.top - trigger.bottom - 10) <= 1.5;
  }, kind);
  const trigger = await badge(kind).boundingBox(), panel = await tooltip().boundingBox(), viewport = page.viewportSize();
  const centeredLeft = trigger.x + trigger.width / 2 - panel.width / 2;
  const expectedLeft = Math.max(12, Math.min(centeredLeft, viewport.width - panel.width - 12));
  assert.ok(Math.abs(panel.x - expectedLeft) <= 1.5, `${kind} panel centers under its own pill, except the exact 12px screen-edge clamp`);
  assert.ok(Math.abs(panel.y - trigger.y - trigger.height - 10) <= 1.5, `${kind} panel top is its own pill bottom + 10px`);
  assert.ok(panel.x >= 0 && panel.x + panel.width <= viewport.width + 1, 'real AdminPanel service menu stays horizontally bounded');
  assert.ok(panel.y >= 0 && panel.y + panel.height <= viewport.height + 1, 'real AdminPanel service menu stays vertically bounded');
  anchorEvidence.push({ kind, viewport, trigger, panel, expectedLeft, clamped: Math.abs(centeredLeft - expectedLeft) > 1.5 });
}
async function login() {
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  await badge('unity').waitFor();
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
  await context.exposeBinding('__ownedServiceControl', async (_source, message) => {
    assert.equal(_source.page, page, 'only the owned AdminPanel page invokes this fixture bridge');
    const pathname = centerActionPaths[message.action];
    if (!pathname) { unexpectedNativeActions.push(message.action); return { success: false, code: 'OWNED_FIXTURE_DENIED' }; }
    const expectedView = collectorCenterViewForPath(pathname);
    assert.equal(expectedView, message.action === 'collector_center_data' ? 'points' : 'overview');
    return new Promise((resolve, reject) => {
      let status;
      const response = { writeHead(value) { status = value; }, end(body) {
        try {
          const result = JSON.parse(body);
          centerBridgeEvidence.push({ action: message.action, pathname, expectedView, status, result });
          resolve({ ...result, ...(status >= 400 ? { code: 'OWNED_LAUNCH_UNCONFIRMED' } : {}) });
        } catch (error) { reject(error); }
      } };
      try { assert.equal(centerControl({ method: 'POST' }, response, pathname), true); }
      catch (error) { reject(error); }
    });
  });
  await context.addInitScript(() => {
    localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'workshops' }));
    const listeners = new Set();
    window.chrome ||= {};
    window.chrome.webview = {
      addEventListener(type, handler) { if (type === 'message') listeners.add(handler); },
      removeEventListener(type, handler) { if (type === 'message') listeners.delete(handler); },
      postMessage(message) {
        if (message?.type !== 'service_connection_action') return;
        window.__ownedServiceControl(message).then(result => {
          for (const handler of listeners) handler({ data: { type: 'service_connection_result', requestId: message.requestId, ...result } });
        });
      }
    };
  });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/(?:engine\/restart|collector\/mode|database)(?:[/?]|$)/.test(request.url())) controlWrites++;
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/admin-auth/lock') lockRequests++;
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
  await login();
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
    assert.equal((await badge(kind).innerText()).trim(), serviceNames[kind], 'four service names are complete and visible');
    assert.ok((await badge(kind).getAttribute('aria-label')).length > 4, 'named buttons retain meaningful service labels');
    assert.equal((await badge(kind).boundingBox()).height, 32, 'existing 32px capsule height is preserved');
  }
  assert.equal(await page.locator('.admin-connection-strip .admin-connection-pill i').count(), 0, 'old round status dots are gone');
  await expectPlug(badge('unity'), true); await expectPlug(badge('devices'), false);
  await expectPlug(badge('data'), true); await expectPlug(badge('session'), true);
  for (const viewport of [{ width: 1680, height: 1080 }, { width: 820, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const kind of Object.keys(serviceNames)) {
      await badge(kind).click(); await tooltip().waitFor(); await expectAnchor(kind);
      await snapshot('10-anchor-' + kind + '-' + viewport.width + '.png'); await closeTooltip();
    }
  }
  await page.setViewportSize({ width: 1680, height: 1080 });
  pass('all four menus in the full AdminPanel anchor below their own pill centers at 1680px and 820px widths, with exact screen-edge clamping');
  await openTooltip(); await expectRows(rowStates, true); assert.match(await tooltip().innerText(), /模拟/);
  await snapshot('01-four-icons-simulation-not-green.png');
  pass('four named 32px capsules use exact service status; real simulator quality remains visible but simulation is amber, never green PLC');

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
  // Real AdminPanel async controller + session refresh, not just a component
  // emission fixture. Hover-open every service then trigger a read-only check.
  for (const kind of Object.keys(serviceNames)) {
    await page.mouse.move(5, 5); await badge(kind).hover(); await tooltip().waitFor();
    assert.equal(await tooltip().getAttribute('data-connection-panel-kind'), kind);
    const before = mockHits.connections;
    await tooltip().locator('[data-connection-action="check"]').click();
    for (const other of Object.keys(serviceNames).filter(other => other !== kind)) {
      await badge(other).hover();
      assert.equal(await tooltip().getAttribute('data-connection-panel-kind'), kind, 'adjacent hover cannot replace a live operation menu');
      assert.equal(await tooltip().locator('header strong').innerText(), serviceNames[kind]);
    }
    await waitUntil(() => mockHits.connections > before, 12000, 'same-owner check really reads the status API');
    await waitUntil(async () => (await tooltip().innerText()).includes('已重新检测'), 12000, 'same-owner check receives real controller feedback');
    assert.equal(await tooltip().getAttribute('data-connection-panel-kind'), kind, 'completed async refresh does not jump to another service');
    assert.equal(controlWrites, writesBefore, 'all four detection actions stay read-only');
    const selected = Object.keys(serviceNames).find(other => other !== kind);
    await badge(selected).click();
    assert.equal(await tooltip().getAttribute('data-connection-panel-kind'), selected, 'explicit other-pill click still switches service');
    await closeTooltip();
  }
  await snapshot('09-four-service-menu-owner-regression.png');
  pass('all four real AdminPanel read-only actions retain their menu owner through adjacent hover, async session/status refresh and feedback; explicit switching remains usable');

  const workshopDraft = page.getByPlaceholder('车间名称（如 压铸车间）', { exact: true });
  const sentinel = 'Owned unsaved workshop draft';
  await workshopDraft.fill(sentinel);
  const lockCountBeforeGuard = lockRequests;
  await badge('session').click(); await tooltip().waitFor();
  const unlock = tooltip().locator('[data-connection-action="unlock"]');
  assert.equal(await unlock.isEnabled(), true, 'the real AdminPanel session action has an injected unlock callback');
  assert.equal(await unlock.getAttribute('title'), '重新解锁后台');
  await unlock.click();
  const draftAlert = page.locator('.app-dialog[role="dialog"]');
  await draftAlert.waitFor(); assert.match(await draftAlert.innerText(), /未保存|编辑表单/);
  assert.match(await draftAlert.innerText(), /当前修改已保留/);
  assert.equal(await workshopDraft.inputValue(), sentinel, 'unlock guard preserves the exact unsaved form draft');
  assert.equal(lockRequests, lockCountBeforeGuard, 'dirty unlock never calls backend lock');
  assert.equal(await page.locator('.admin-unlock-page .admin-unlock-card').count(), 0, 'dirty unlock remains in the authenticated AdminPanel');
  const dirtySession = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  assert.equal(dirtySession.authenticated, true, 'server authentication is preserved when unlock is refused for a draft');
  await snapshot('11-session-unlock-dirty-guard.png');
  await draftAlert.getByRole('button', { name: '确定', exact: true }).click(); await draftAlert.waitFor({ state: 'hidden' });
  await closeTooltip(); await workshopDraft.fill('');
  await badge('session').click(); await tooltip().waitFor(); await tooltip().locator('[data-connection-action="unlock"]').click();
  await page.locator('.admin-unlock-page .admin-unlock-card').waitFor();
  assert.equal(await page.locator('[data-connection-kind]').count(), 0, 'clean unlock really exits AdminPanel and shows its existing password gate');
  await waitUntil(() => lockRequests === lockCountBeforeGuard + 1, 12000, 'exactly one owned backend lock request');
  await waitUntil(async () => {
    const result = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    return result.authenticated === false;
  }, 12000, 'backend confirms clean relock');
  await snapshot('12-session-existing-password-gate.png'); await login();
  await expectTone('is-online');
  assert.equal((await (await page.request.get(info.origin + '/api/admin-auth/session')).json()).authenticated, true,
    'return to AdminPanel requires a fresh real backend authentication');
  await snapshot('13-session-reauthenticated.png');
  pass('session lock icon refuses unsaved drafts without changing authentication; a clean click opens the real password page and fresh login restores AdminPanel');

  for (const [kind, view, title] of [['devices', 'points', '打开设备采集管理（状态 / 点位）'], ['data', 'overview', '打开数据服务管理（API / 数据库）']]) {
    await badge(kind).click(); await tooltip().waitFor();
    assert.equal(await tooltip().locator('.connection-management-scope').innerText(), kind === 'devices'
      ? '管理范围：设备连接、采集进程、点位与读数质量' : '管理范围：后台 API、数据库与大屏数据通道');
    if (kind === 'data') assert.equal(await tooltip().locator('[data-device-id]').count(), 0);
    const center = tooltip().locator('[data-connection-action="center"]');
    assert.equal(await center.isEnabled(), true); assert.equal(await center.getAttribute('title'), title);
    const launchesBefore = centerLaunchEvidence.length;
    await center.click();
    await waitUntil(() => centerLaunchEvidence.length === launchesBefore + 1, 12000, 'production desktop handler receives the distinct center page');
    const result = centerBridgeEvidence.at(-1);
    assert.equal(result.status, 200); assert.deepEqual(result.result, { success: true, opened: true, view });
    const expectedFeedback = kind === 'devices' ? '已打开设备采集管理：采集状态 / 点位；不代表设备已恢复在线'
      : '已打开数据服务管理：API / 数据库 / 数据通道；不代表服务已恢复正常';
    await waitUntil(async () => await tooltip().getByRole('status').innerText() === expectedFeedback, 12000, 'confirmed page-specific info feedback');
    assert.equal(await tooltip().getAttribute('data-connection-panel-kind'), kind);
    assert.match(await tooltip().getByRole('status').innerText(), kind === 'devices' ? /不代表设备已恢复在线/ : /API \/ 数据库 \/ 数据通道.*不代表服务已恢复正常/);
    assert.equal(await tooltip().getByRole('status').getAttribute('class'), 'connection-feedback is-info');
    await snapshot('14-center-' + view + '-confirmed.png'); await closeTooltip();
  }
  centerReceiptMode = 'wrong-view';
  await badge('data').click(); await tooltip().waitFor(); await tooltip().locator('[data-connection-action="center"]').click();
  await tooltip().getByRole('alert').waitFor();
  assert.equal(centerBridgeEvidence.at(-1).status, 503, 'production handler refuses a mismatched native page receipt');
  assert.equal(centerBridgeEvidence.at(-1).result.success, false);
  assert.doesNotMatch(await tooltip().getByRole('alert').innerText(), /已打开|恢复成功/);
  await snapshot('15-center-wrong-view-rejected.png'); await closeTooltip(); centerReceiptMode = 'matching';
  assert.deepEqual(unexpectedNativeActions, [], 'no restart, reconnect or other native action ran in this owned center-only fixture');
  assert.equal(controlWrites, writesBefore, 'lock/center workflow never changes collection mode, restarts collection or writes database settings');
  pass('device center opens points and data center opens overview via shipped route/argument mapping; matching receipts yield info only, wrong page is rejected without false success (native GUI verified separately)');
  statusUnavailable = true;
  await waitUntil(async () => (await badge('data').getAttribute('aria-label')).includes('检测失败'), 12000, 'failed status request');
  for (const kind of ['unity', 'devices', 'data', 'session']) await expectPlug(badge(kind), false);
  await snapshot('08-detection-failure-not-green.png');
  pass('Unity scene pending, database failure, restricted rows and failed detection remain accurate non-green states; icon check is truly read-only');
  assert.ok(mockHits.connections > 5, 'full AdminPanel polls the new minimal status endpoint');

  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: true, scope: 'owned AdminPanel backend/authentication plus production desktop handler with owned launch seam; no installed controls or real native GUI claimed', checks, errors, mockHits, controlWrites, lockRequests, anchorEvidence, centerLaunchEvidence, centerBridgeEvidence, unexpectedNativeActions, actualSnapshotEvidence, screenshotDirectory: directory }, null, 2));
  console.log('REPORT ' + directory);
})().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  const badgeDiagnostics = page ? await page.locator('[data-connection-kind]').evaluateAll(elements => elements.map(element => ({ kind: element.dataset.connectionKind, label: element.getAttribute('aria-label'), class: element.className, icon: element.querySelector('svg[data-plug-state]')?.getAttribute('data-plug-state') }))).catch(() => []) : [];
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ success: false, checks, errors, mockHits, controlWrites, lockRequests, anchorEvidence, centerLaunchEvidence, centerBridgeEvidence, unexpectedNativeActions, badgeDiagnostics, failure: error.stack, screenshotDirectory: directory }, null, 2));
  console.error(error.stack); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
