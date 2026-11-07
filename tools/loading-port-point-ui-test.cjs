'use strict';
// Real pointer acceptance against an owned collector-free fixture. Authored GLB
// is read-only; CPU raycasts locate pixels, never invoke application handlers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { startLoadingPortsFixture } = require('./loading-ports-ui-server.cjs');
const root = path.resolve(__dirname, '..');
const prefix = requireTestPath(path.join(root, 'output/playwright', `loading-port-point-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
fs.mkdirSync(path.dirname(prefix), { recursive: true });
const directory = fs.mkdtempSync(prefix);
const runLog = path.join(directory, 'run.log');
fs.writeFileSync(runLog, 'Owned SQLite / random loopback backend, auto-start disabled; no commissioned DB, PLC or Unity.\n');
const checks = [], errors = [], consoleErrors = [], expectedConsoleErrors = [], mutations = [], picks = [], screenshots = [], audits = [];
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => structuredClone(value);
const empty = () => ({ version: 1, inlet: null, outlet: null });
let fixture, browser, page, sceneRoot, THREE, inferLoadingPort, surfacePoint, cameraDistance, expectingConflictConsole = false;
const check = name => { checks.push(name); console.log('PASS ' + name); fs.appendFileSync(runLog, 'PASS ' + name + '\n'); };
const closeVector = (actual, expected) => actual.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 2e-5, `${actual} != ${expected}`));

async function main() {
  fixture = await startLoadingPortsFixture({ templateId: 'cad_air_cooling_table_115800ht' });
  const info = fixture.info;
  requireTestPath(info.database); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const headers = { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie,
    'X-CSRF-Token': info.session.csrfToken, 'X-Factory-ID': info.factoryId };
  const api = async (route, method = 'GET', body) => {
    const response = await fetch(info.origin + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`); return data;
  };
  const models = async () => (await api('/api/models')).filter(row => info.models.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id));
  const devices = async () => (await api('/api/devices')).filter(row => info.devices.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id));
  const modelRoute = `/api/models/${info.models[0]}/loading-ports`;
  const initialModels = await models(), initialDevices = await devices();
  await api(`/api/models/${info.models[0]}`, 'PUT', { name: '风冷台 · 11.58.00HT CAD' });
  let current = await api(modelRoute);
  await api(modelRoute, 'PUT', { revision: current.revision, ports: empty() });
  const emptyModels = await models();
  assert.deepEqual(emptyModels[1], initialModels[1]);
  assert.deepEqual(await devices(), initialDevices);

  THREE = await import(pathToFileURL(path.join(root, 'frontend/node_modules/three/build/three.module.js')).href);
  const { GLTFLoader } = await import(pathToFileURL(path.join(root, 'frontend/node_modules/three/examples/jsm/loaders/GLTFLoader.js')).href);
  const { restoreGltfNodeNames } = await import(pathToFileURL(path.join(root, 'frontend/src/three/gltfNodeIdentity.js')).href);
  ({ inferLoadingPort } = await import(pathToFileURL(path.join(root, 'frontend/src/three/lineLoadingAlignment.js')).href));
  ({ loadingPortSurfacePoint: surfacePoint, loadingPortCameraDistance: cameraDistance } = await import(pathToFileURL(path.join(root, 'frontend/src/three/LoadingPortPreview.js')).href));
  assert.equal(typeof cameraDistance, 'function', 'the aspect-aware preview camera contract is required');
  const bytes = fs.readFileSync(info.assetPath);
  sceneRoot = restoreGltfNodeNames(await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
  sceneRoot.updateMatrixWorld(true);

  browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.addInitScript(({ lineId }) => {
    if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
      activeTab: 'models', modelLibraryStep: 'library', selectedLineEditorId: lineId, isLineDevicePoolCollapsed: true }));
  }, { lineId: info.lineId });
  page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') { consoleErrors.push(message.text()); if (expectingConflictConsole) expectedConsoleErrors.push(message.text()); } });
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
      const body = request.postDataJSON();
      mutations.push({ method: request.method(), path: pathname, body: pathname.startsWith('/api/admin-auth/') ? { username: body?.username } : body });
    }
  });
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password);
  await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  const steps = page.getByRole('navigation', { name: '模型库操作步骤' }); await steps.waitFor();
  await page.locator(`[data-model-id="${info.models[0]}"]`).locator('td').nth(2).click();
  await steps.getByRole('button', { name: /进出料口/ }).click();
  await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]);
  const getEditor = () => page.getByRole('region', { name: '进出料口配置', exact: true });
  const reloadWithModels = async () => {
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models' && response.request().method() === 'GET' && response.status() === 200);
    await page.reload(); await (await response).finished();
  };
  let editor = getEditor();
  const ready = async editor => {
    await editor.locator('canvas').waitFor({ timeout: 60000 });
    await editor.locator('.preview-overlay').waitFor({ state: 'hidden', timeout: 60000 });
    await editor.locator('.point-summary, .base-missing').waitFor();
  };
  const advanced = editor => editor.locator('.advanced-panel');
  const openAdvanced = async editor => { if (await advanced(editor).getAttribute('open') === null) await advanced(editor).locator(':scope > summary').click(); };
  const closeAdvanced = async editor => { if (await advanced(editor).getAttribute('open') !== null) await advanced(editor).locator(':scope > summary').click(); };
  const readVector = async (editor, instance = false) => {
    await openAdvanced(editor);
    const labels = instance ? ['进出料口 X 偏移', '进出料口送料高度偏移', '进出料口 Z 偏移'] : ['进出料口 X 位置', '进出料口 Y 送料高度', '进出料口 Z 位置'];
    const values = await Promise.all(labels.map(label => editor.getByLabel(label, { exact: true }).inputValue()));
    await closeAdvanced(editor); return values.map(Number);
  };
  const switchKind = async (editor, kind) => {
    await editor.getByRole('navigation', { name: '选择进出料口' }).getByRole('button', { name: kind === 'inlet' ? /^进料口/ : /^出料口/ }).click();
  };
  const samePosition = (editor, kind) => editor.getByRole('button', { name: kind === 'inlet' ? '与出料口同位置' : '与进料口同位置', exact: true });
  const readPortDetails = async editor => {
    await openAdvanced(editor);
    const result = { angle: Number(await editor.getByLabel('进出料口水平外向角度', { exact: true }).inputValue()),
      nodeName: await editor.getByLabel('进出料口关联节点名称', { exact: true }).inputValue() };
    await closeAdvanced(editor); return result;
  };
  const assertRemovedControls = async editor => {
    assert.equal(await page.locator('.loading-port-optional-step').count(), 0);
    assert.equal(await page.getByLabel('跳过进出料口配置', { exact: true }).count(), 0);
    assert.equal(await editor.locator('.editor-heading').getByRole('button', { name: '重新读取', exact: true }).count(), 0);
  };
  const snap = async (editor, name) => {
    const filename = path.join(directory, name + '.png'); await editor.screenshot({ path: filename }); screenshots.push(filename);
  };
  const checkHeightLabel = async (editor, kind, height) => {
    const labels = editor.locator('.loading-port-height-label').filter({ hasText: kind === 'inlet' ? '进料口' : '出料口' });
    await labels.first().waitFor();
    const label = await labels.first().evaluate(element => ({ text: element.textContent,
      fontSize: parseFloat(getComputedStyle(element).fontSize), pointerEvents: getComputedStyle(element).pointerEvents,
      width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    assert.ok(label.fontSize >= 14, `readable fixed-screen label required: ${JSON.stringify(label)}`);
    assert.equal(label.pointerEvents, 'none', 'height annotation must not intercept real canvas clicks');
    assert.match(label.text, /高度/); assert.ok(label.text.includes(String(Number(height.toFixed(4)))), `${label.text} must show clicked model-local Y ${height}`);
    assert.ok(label.width > 50 && label.height >= 18); return label;
  };
  const reset = async editor => {
    await closeAdvanced(editor);
    await editor.getByRole('button', { name: '完整视图', exact: true }).click();
    await editor.locator('canvas').scrollIntoViewIfNeeded(); await page.waitForTimeout(250);
  };
  const cpuCamera = rect => {
    const box = new THREE.Box3().setFromObject(sceneRoot), center = box.getCenter(new THREE.Vector3()), extent = box.getSize(new THREE.Vector3()).length();
    const camera = new THREE.PerspectiveCamera(42, rect.width / rect.height, Math.max(extent / 10000, .00001), Math.max(extent * 100, 10));
    camera.position.copy(center).add(new THREE.Vector3(.9, .65, 1.1).normalize().multiplyScalar(cameraDistance(extent, camera.aspect)));
    camera.lookAt(center); camera.updateMatrixWorld(true);
    return { box, camera, center };
  };
  // Reproduce public resetCamera math and locate actual authored triangle hits.
  const pixel = async (editor, variant = 0, blank = false) => {
    await reset(editor);
    const rect = await editor.locator('canvas').boundingBox(); assert.ok(rect?.width > 50 && rect.height > 50);
    const viewport = page.viewportSize();
    const { camera, center } = cpuCamera(rect);
    const meshes = []; sceneRoot.traverseVisible(node => { if (node.isMesh) meshes.push(node) });
    const raycaster = new THREE.Raycaster();
    const cast = (x, y) => {
      raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), camera);
      return raycaster.intersectObjects(meshes, false)[0];
    };
    if (blank) {
      for (const [x, y] of [[.03, .9], [.97, .9], [.03, .2], [.97, .2]]) {
        const sx = rect.x + rect.width * x, sy = rect.y + rect.height * y;
        if (sx > 0 && sx < viewport.width && sy > 0 && sy < viewport.height && !cast(x, y)) return { x: sx, y: sy, rect };
      }
      throw Error('Cannot find a blank authored-geometry pixel');
    }
    const suggestion = inferLoadingPort(sceneRoot, {}, { id: 'cad_air_cooling_table_115800ht' });
    const desired = suggestion ? new THREE.Vector3(...suggestion.position) : center.clone();
    const projected = desired.clone().project(camera), candidates = [];
    for (let iy = -5; iy <= 5; iy++) for (let ix = -5; ix <= 5; ix++) {
      const nx = (projected.x + 1) / 2 + ix * .009, ny = (1 - projected.y) / 2 + iy * .009;
      const x = rect.x + rect.width * nx, y = rect.y + rect.height * ny;
      if (nx < .06 || nx > .94 || ny < .15 || ny > .94 || x < 0 || x > viewport.width - 1 || y < 0 || y > viewport.height - 1) continue;
      const hit = cast(nx, ny), point = surfacePoint(hit, sceneRoot); if (!point) continue;
      const distance = new THREE.Vector3(...point.position).distanceTo(desired);
      candidates.push({ x, y, rect, point, distance, normalized: [nx, ny] });
    }
    candidates.sort((a, b) => a.distance - b.distance); assert.ok(candidates.length > variant, 'visible CAD surface target required');
    return candidates[variant];
  };
  const clickSurface = async (editor, variant, instance = false) => {
    const target = await pixel(editor, variant);
    await page.mouse.click(target.x, target.y);
    const values = await readVector(editor, instance);
    picks.push({ variant, viewport: page.viewportSize(), canvasRect: target.rect, screen: [target.x, target.y], normalized: target.normalized, expected: target.point, displayed: values, instance });
    return { values, target };
  };
  const audit = async (editor, width, label) => {
    await page.setViewportSize({ width, height: 1050 }); await closeAdvanced(editor); await reset(editor);
    const canvasRect = await editor.locator('canvas').boundingBox(), editorRect = await editor.boundingBox();
    const { box, camera } = cpuCamera(canvasRect), corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z).project(camera).toArray());
    assert.ok(corners.every(([x, y, z]) => Math.abs(x) < .98 && Math.abs(y) < .98 && z > -1 && z < 1), `complete view must frame every bounding-box corner at width ${width}: ${JSON.stringify(corners)}`);
    if (editorRect.width <= 850) assert.ok(canvasRect.width >= editorRect.width * .85, `narrow editor must have a full-width stacked preview: ${JSON.stringify({ editorRect, canvasRect })}`);
    for (const target of [editor.getByRole('button', { name: '保存配置', exact: true }), editor.getByRole('button', { name: '完整视图', exact: true })]) {
      await target.scrollIntoViewIfNeeded(); const rect = await target.boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width + 2 && rect.y + rect.height <= 1052, 'key control must remain scroll-reachable');
    }
    const data = await editor.evaluate((element, args) => {
      const visible = e => e.getClientRects().length && !e.closest('details:not([open]) > :not(summary)');
      const items = [...element.querySelectorAll('p,strong,small,summary,button,h3')].filter(e => visible(e) && !e.closest('button:disabled'));
      return { ...args, scale: Number(getComputedStyle(document.documentElement).getPropertyValue('--admin-font-scale')),
        pageWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        samples: items.map(e => ({ text: e.textContent.trim().slice(0, 100), fontSize: parseFloat(getComputedStyle(e).fontSize), color: getComputedStyle(e).color })),
        advancedOpen: element.querySelector('.advanced-panel').open };
    }, { width, label });
    assert.ok(Math.abs(data.scale - 1.15) < .001); assert.ok(data.scrollWidth <= width + 2);
    assert.equal(data.advancedOpen, false); assert.ok(data.samples.every(item => item.fontSize >= 13 * 1.15 - .1)); audits.push({ ...data, canvasRect, editorRect, bboxCorners: corners });
    await snap(editor, label + '-' + width);
    if (editorRect.width <= 850) {
      await snap(editor.locator('.config-panel'), label + '-' + width + '-controls');
      await reset(editor); await snap(editor.locator('.preview-panel'), label + '-' + width + '-full-width-preview');
    }
  };
  await ready(editor);
  await assertRemovedControls(editor);
  assert.equal(await samePosition(editor, 'inlet').count(), 0, 'no peer port means no copy affordance');
  await switchKind(editor, 'outlet'); assert.equal(await samePosition(editor, 'outlet').count(), 0); await switchKind(editor, 'inlet');
  check('top optional/Skip strip and heading Reload are removed; both unconfigured ports expose no same-position button');
  assert.equal(await advanced(editor).getAttribute('open'), null);
  assert.equal(await editor.locator('input[type=checkbox]:visible').count(), 0);
  assert.equal(await editor.getByRole('button', { name: /启用|点击模型表面定位|取消表面定位/ }).count(), 0);
  assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  await audit(editor, 1024, '00-empty-narrow');
  const narrowWriteCount = mutations.filter(row => row.path.startsWith('/api/models/')).length;
  const narrowPick = await clickSurface(editor, 0); closeVector(narrowPick.values, narrowPick.target.point.position);
  await checkHeightLabel(editor, 'inlet', narrowPick.values[1]);
  assert.deepEqual(await models(), emptyModels); assert.deepEqual(await devices(), initialDevices);
  await reset(editor); await snap(editor.locator('.preview-panel'), '00-narrow-real-precise-pick');
  await editor.getByRole('button', { name: '清除选点', exact: true }).click();
  assert.match(await editor.locator('.point-summary').innerText(), /未设置/);
  assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  assert.equal(mutations.filter(row => row.path.startsWith('/api/models/')).length, narrowWriteCount);
  assert.deepEqual(await models(), emptyModels);
  check('1024 actual-container preview precisely picks a visible authored surface, then clears back to empty without a model write');
  await audit(editor, 1600, '01-empty-optional');
  const writesBefore = mutations.filter(row => row.path === modelRoute).length;
  const first = await clickSurface(editor, 0); closeVector(first.values, first.target.point.position);
  await checkHeightLabel(editor, 'inlet', first.values[1]);
  assert.deepEqual(await models(), emptyModels); assert.equal(mutations.filter(row => row.path === modelRoute).length, writesBefore);
  await snap(editor, '02-real-first-pick-unsaved');
  const firstDetails = await readPortDetails(editor);
  await switchKind(editor, 'outlet'); assert.equal(await samePosition(editor, 'outlet').isEnabled(), true);
  await samePosition(editor, 'outlet').click(); closeVector(await readVector(editor), first.values);
  assert.deepEqual(await readPortDetails(editor), firstDetails, 'a new target inherits the copied source direction and node identity');
  await switchKind(editor, 'inlet'); closeVector(await readVector(editor), first.values);
  await switchKind(editor, 'outlet'); await editor.getByRole('button', { name: '清除选点', exact: true }).click(); await switchKind(editor, 'inlet');
  assert.deepEqual(await models(), emptyModels); assert.deepEqual(await devices(), initialDevices); assert.equal(mutations.filter(row => row.path === modelRoute).length, writesBefore);
  check('one real inlet point can initialize the empty outlet with independent XYZ/direction/node draft, without saving');
  const second = await clickSurface(editor, 10); closeVector(second.values, second.target.point.position);
  assert.notDeepEqual(second.values, first.values);
  const blank = await pixel(editor, 0, true); await page.mouse.click(blank.x, blank.y); closeVector(await readVector(editor), second.values);
  const gestureTarget = await pixel(editor, 0);
  await page.mouse.move(gestureTarget.x, gestureTarget.y); await page.mouse.down();
  await page.mouse.move(gestureTarget.x + 65, gestureTarget.y + 18, { steps: 8 });
  await page.mouse.move(gestureTarget.x, gestureTarget.y, { steps: 8 }); await page.mouse.up();
  closeVector(await readVector(editor), second.values);
  await page.mouse.move(gestureTarget.x, gestureTarget.y); await page.mouse.wheel(0, 120); await page.waitForTimeout(250);
  closeVector(await readVector(editor), second.values);
  await switchKind(editor, 'outlet');
  const outlet = await clickSurface(editor, 18); closeVector(outlet.values, outlet.target.point.position);
  await switchKind(editor, 'inlet'); closeVector(await readVector(editor), second.values);
  await editor.getByRole('button', { name: '清除选点', exact: true }).click();
  assert.match(await editor.locator('.point-summary').innerText(), /未设置/);
  const finalPick = await clickSurface(editor, 3); closeVector(finalPick.values, finalPick.target.point.position);
  await checkHeightLabel(editor, 'inlet', finalPick.values[1]);
  await checkHeightLabel(editor, 'outlet', outlet.values[1]);
  assert.deepEqual(await models(), emptyModels); assert.deepEqual(await devices(), initialDevices);
  check('real repeated clicks and inlet/outlet drafts work; blank clicks, return-to-origin drag and wheel never set or save points');
  await audit(editor, 1024, '03-single-point-baseline');
  await page.setViewportSize({ width: 1600, height: 1050 });
  const saveResponse = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await saveResponse).status(), 200);
  await editor.getByText(/模型进出料口默认配置已保存/).waitFor();
  let modelSaved = await models();
  closeVector(parsed(modelSaved[0].metadata).loadingPorts.inlet.position, finalPick.values);
  closeVector(parsed(modelSaved[0].metadata).loadingPorts.outlet.position, outlet.values);
  for (const key of Object.keys(parsed(emptyModels[0].metadata))) if (key !== 'loadingPorts') assert.deepEqual(parsed(modelSaved[0].metadata)[key], parsed(emptyModels[0].metadata)[key]);
  assert.deepEqual(modelSaved[1], initialModels[1]); assert.deepEqual(await devices(), initialDevices);
  await page.reload(); await page.getByLabel('选择进出料口模型', { exact: true }).waitFor();
  await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]); editor = getEditor(); await ready(editor);
  closeVector(await readVector(editor), finalPick.values);
  await checkHeightLabel(editor, 'inlet', finalPick.values[1]);
  await audit(editor, 1600, '04-model-saved-reloaded');
  check('only Save persists actual raycast XYZ; reload restores both ports, peer metadata and all devices stay unchanged');

  const openInstanceFromLineCanvas = async () => {
    const menu = page.getByTitle('工厂建模', { exact: true });
    if (!await page.getByRole('button', { name: '产线管理', exact: true }).isVisible()) await menu.click();
    await page.getByRole('button', { name: '产线管理', exact: true }).click();
    const lineDevice = page.locator(`.line-preview-stage [data-device-id="${info.devices[0]}"]`); await lineDevice.waitFor();
    const writeStart = mutations.length;
    await lineDevice.focus(); await lineDevice.press('Enter');
    assert.equal(await lineDevice.getAttribute('aria-pressed'), 'true');
    await page.getByRole('toolbar', { name: '设备多选与间距', exact: true }).getByRole('button', { name: '进出料口微调', exact: true }).click();
    assert.equal(mutations.slice(writeStart).filter(row => /^\/api\/(models|devices|lines)(?:\/|$)/.test(row.path)).length, 0, 'selecting an existing line canvas instance and opening its editor must not write configuration');
  };
  await openInstanceFromLineCanvas();
  let dialog = page.getByRole('dialog', { name: '设备进出料口微调', exact: true }); await dialog.waitFor();
  editor = dialog.getByRole('region', { name: '进出料口配置', exact: true }); await ready(editor);
  assert.equal(await advanced(editor).getAttribute('open'), null);
  const instance = await clickSurface(editor, 20, true), base = parsed(modelSaved[0].metadata).loadingPorts.inlet;
  closeVector(instance.values, instance.target.point.position.map((value, axis) => value - base.position[axis]));
  assert.deepEqual(await devices(), initialDevices); assert.deepEqual(await models(), modelSaved);
  const instanceRoute = `/api/devices/${info.devices[0]}/loading-ports`;
  const instanceResponse = page.waitForResponse(response => new URL(response.url()).pathname === instanceRoute && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await instanceResponse).status(), 200);
  await editor.getByText(/此设备的进出料口微调已保存/).waitFor();
  let instanceSaved = await devices(); const savedInstance = parsed(instanceSaved[0].instance_config);
  closeVector(savedInstance.loadingPortOverrides.inlet.offset, instance.values); assert.equal(savedInstance.loadingPortOverrides.inlet.yawDegrees, 0);
  for (const key of Object.keys(parsed(initialDevices[0].instance_config))) assert.deepEqual(savedInstance[key], parsed(initialDevices[0].instance_config)[key]);
  for (const key of Object.keys(initialDevices[0])) if (key !== 'instance_config') assert.deepEqual(instanceSaved[0][key], initialDevices[0][key]);
  assert.deepEqual(instanceSaved.slice(1), initialDevices.slice(1)); assert.deepEqual(await models(), modelSaved);
  await snap(dialog, '05-instance-offset-only');
  await dialog.getByRole('button', { name: '关闭设备进出料口微调', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await openInstanceFromLineCanvas();
  dialog = page.getByRole('dialog', { name: '设备进出料口微调', exact: true }); editor = dialog.getByRole('region', { name: '进出料口配置', exact: true }); await ready(editor);
  closeVector(await readVector(editor, true), instance.values);
  const reopened = await api(instanceRoute); closeVector(reopened.overrides.inlet.offset, instance.values);
  closeVector(reopened.ports.inlet.position, instance.target.point.position);
  await checkHeightLabel(editor, 'inlet', instance.target.point.position[1]);
  assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  assert.deepEqual(await devices(), instanceSaved); assert.deepEqual(await models(), modelSaved);
  await reset(editor); await snap(dialog, '05-instance-reopened-offset');
  await assertRemovedControls(editor);
  const instanceCopyWrites = mutations.filter(row => row.path === instanceRoute).length;
  await openAdvanced(editor); await editor.getByLabel('进出料口水平方向微调角度', { exact: true }).fill('31'); await closeAdvanced(editor);
  await switchKind(editor, 'outlet'); await openAdvanced(editor); await editor.getByLabel('手动输入设备偏移', { exact: true }).check();
  await editor.getByLabel('进出料口水平方向微调角度', { exact: true }).fill('-23'); await closeAdvanced(editor);
  await samePosition(editor, 'outlet').click();
  const outletBase = parsed(modelSaved[0].metadata).loadingPorts.outlet;
  const outletCopiedOffset = instance.target.point.position.map((value, axis) => value - outletBase.position[axis]);
  closeVector(await readVector(editor, true), outletCopiedOffset);
  await openAdvanced(editor); assert.equal(Number(await editor.getByLabel('进出料口水平方向微调角度', { exact: true }).inputValue()), -23); await closeAdvanced(editor);
  await checkHeightLabel(editor, 'outlet', instance.target.point.position[1]);
  await switchKind(editor, 'inlet'); closeVector(await readVector(editor, true), instance.values);
  await switchKind(editor, 'outlet'); await openAdvanced(editor);
  const shiftedOffset = outletCopiedOffset.map((value, axis) => value + [.2, .1, -.3][axis]);
  for (const [axis, label] of ['进出料口 X 偏移', '进出料口送料高度偏移', '进出料口 Z 偏移'].entries()) await editor.getByLabel(label, { exact: true }).fill(String(shiftedOffset[axis]));
  await closeAdvanced(editor); await switchKind(editor, 'inlet'); closeVector(await readVector(editor, true), instance.values);
  await samePosition(editor, 'inlet').click();
  const shiftedEffective = outletBase.position.map((value, axis) => value + shiftedOffset[axis]);
  const inletCopiedOffset = shiftedEffective.map((value, axis) => value - base.position[axis]);
  closeVector(await readVector(editor, true), inletCopiedOffset);
  await openAdvanced(editor); assert.equal(Number(await editor.getByLabel('进出料口水平方向微调角度', { exact: true }).inputValue()), 31); await closeAdvanced(editor);
  assert.deepEqual(await devices(), instanceSaved); assert.deepEqual(await models(), modelSaved); assert.equal(mutations.filter(row => row.path === instanceRoute).length, instanceCopyWrites);
  await reset(editor); await snap(dialog, '05-instance-same-position-unsaved');
  const copyInstanceResponse = page.waitForResponse(response => new URL(response.url()).pathname === instanceRoute && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await copyInstanceResponse).status(), 200);
  await editor.getByText(/此设备的进出料口微调已保存/).waitFor(); instanceSaved = await devices();
  const copiedInstance = parsed(instanceSaved[0].instance_config).loadingPortOverrides;
  closeVector(copiedInstance.inlet.offset, inletCopiedOffset); closeVector(copiedInstance.outlet.offset, shiftedOffset);
  assert.equal(copiedInstance.inlet.yawDegrees, 31); assert.equal(copiedInstance.outlet.yawDegrees, -23);
  for (const key of Object.keys(savedInstance)) if (key !== 'loadingPortOverrides') assert.deepEqual(parsed(instanceSaved[0].instance_config)[key], savedInstance[key]);
  assert.deepEqual(instanceSaved.slice(1), initialDevices.slice(1)); assert.deepEqual(await models(), modelSaved);
  await dialog.getByRole('button', { name: '关闭设备进出料口微调', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await openInstanceFromLineCanvas(); dialog = page.getByRole('dialog', { name: '设备进出料口微调', exact: true }); editor = dialog.getByRole('region', { name: '进出料口配置', exact: true }); await ready(editor);
  closeVector(await readVector(editor, true), inletCopiedOffset); await switchKind(editor, 'outlet'); closeVector(await readVector(editor, true), shiftedOffset);
  const copiedReopened = await api(instanceRoute); closeVector(copiedReopened.ports.inlet.position, shiftedEffective); closeVector(copiedReopened.ports.outlet.position, shiftedEffective);
  await reset(editor); await snap(dialog, '05-instance-same-position-saved-reopened');
  check('instance same-position works both ways using each target base, keeps independent offsets and target yaw, saves only this device and reopens at equal effective XYZ');
  await dialog.getByRole('button', { name: '关闭设备进出料口微调', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  check('instance real surface click saves and reopens the same raw offset, not model defaults, peers, placement, PLC, movement or inspection');

  current = await api(modelRoute); await api(modelRoute, 'PUT', { revision: current.revision, ports: empty() });
  const noBaseModels = await models(), noBaseDevices = await devices();
  await reloadWithModels(); await openInstanceFromLineCanvas();
  dialog = page.getByRole('dialog', { name: '设备进出料口微调', exact: true }); editor = dialog.getByRole('region', { name: '进出料口配置', exact: true }); await ready(editor);
  const noBaseTarget = await pixel(editor, 0); await page.mouse.click(noBaseTarget.x, noBaseTarget.y);
  assert.match(await editor.locator('.base-missing').innerText(), /可跳过/);
  assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  await snap(dialog, '06-instance-no-base-can-skip');
  assert.equal(await samePosition(editor, 'inlet').count(), 0); await switchKind(editor, 'outlet'); assert.equal(await samePosition(editor, 'outlet').count(), 0);
  await dialog.getByRole('button', { name: '关闭设备进出料口微调', exact: true }).click();
  assert.deepEqual(await models(), noBaseModels); assert.deepEqual(await devices(), noBaseDevices);
  current = await api(modelRoute); const inletOnly = empty(); inletOnly.inlet = clone(parsed(modelSaved[0].metadata).loadingPorts.inlet);
  await api(modelRoute, 'PUT', { revision: current.revision, ports: inletOnly }); const oneBaseModels = await models();
  await reloadWithModels(); await openInstanceFromLineCanvas(); dialog = page.getByRole('dialog', { name: '设备进出料口微调', exact: true }); editor = dialog.getByRole('region', { name: '进出料口配置', exact: true }); await ready(editor);
  await switchKind(editor, 'outlet'); assert.equal(await samePosition(editor, 'outlet').isDisabled(), true, 'an instance cannot create a missing target model port');
  await snap(dialog, '06-instance-peer-exists-target-base-missing'); await dialog.getByRole('button', { name: '关闭设备进出料口微调', exact: true }).click();
  assert.deepEqual(await models(), oneBaseModels); assert.deepEqual(await devices(), noBaseDevices);
  check('copy is absent with no peer, and disabled for an instance whose target model base is absent; no default port or device mutation is invented');
  current = await api(modelRoute); await api(modelRoute, 'PUT', { revision: current.revision, ports: empty() });
  if (!await page.getByRole('button', { name: '模型管理', exact: true }).isVisible()) await page.getByTitle('模型库', { exact: true }).click();
  await page.getByRole('button', { name: '模型管理', exact: true }).click();
  await steps.getByRole('button', { name: /进出料口/ }).click();
  await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]); editor = getEditor(); await ready(editor);
  const preSkipWrites = mutations.filter(row => row.path.startsWith('/api/models/')).length;
  await assertRemovedControls(editor); await steps.getByRole('button', { name: /拆解/ }).click();
  await page.locator('.inspection-workspace').waitFor();
  assert.equal(mutations.filter(row => row.path.startsWith('/api/models/')).length, preSkipWrites);
  assert.deepEqual(await devices(), noBaseDevices); assert.deepEqual((await api(modelRoute)).ports, empty());
  check('no-base instance clicks create nothing; normal model-library navigation still enters inspection without the removed Skip strip or any write');
  // Restore a useful selected-point view in this private fixture for final visual evidence.
  current = await api(modelRoute);
  await api(modelRoute, 'PUT', { revision: current.revision, ports: parsed(modelSaved[0].metadata).loadingPorts });
  await steps.getByRole('button', { name: /进出料口/ }).click(); editor = getEditor(); await ready(editor);
  const beforeModelCopy = await models(), beforeCopyDevices = await devices(), modelCopyWrites = mutations.filter(row => row.path === modelRoute).length;
  await openAdvanced(editor); await editor.getByLabel('进出料口水平外向角度', { exact: true }).fill('45'); await editor.getByLabel('进出料口关联节点名称', { exact: true }).fill('same_position_inlet_source'); await closeAdvanced(editor);
  const sourceInletPosition = await readVector(editor);
  await switchKind(editor, 'outlet'); await openAdvanced(editor); await editor.getByLabel('进出料口水平外向角度', { exact: true }).fill('-135'); await editor.getByLabel('进出料口关联节点名称', { exact: true }).fill('old_outlet_node'); await closeAdvanced(editor);
  await samePosition(editor, 'outlet').click(); closeVector(await readVector(editor), sourceInletPosition);
  assert.deepEqual(await readPortDetails(editor), { angle: -135, nodeName: 'same_position_inlet_source' });
  await openAdvanced(editor); const copiedPosition = sourceInletPosition.map((value, axis) => value + [.3, .15, -.25][axis]);
  for (const [axis, label] of ['进出料口 X 位置', '进出料口 Y 送料高度', '进出料口 Z 位置'].entries()) await editor.getByLabel(label, { exact: true }).fill(String(copiedPosition[axis]));
  await closeAdvanced(editor); await switchKind(editor, 'inlet'); closeVector(await readVector(editor), sourceInletPosition);
  await samePosition(editor, 'inlet').click(); closeVector(await readVector(editor), copiedPosition); assert.deepEqual(await readPortDetails(editor), { angle: 45, nodeName: 'same_position_inlet_source' });
  await switchKind(editor, 'outlet'); closeVector(await readVector(editor), copiedPosition); await switchKind(editor, 'inlet');
  assert.deepEqual(await models(), beforeModelCopy); assert.deepEqual(await devices(), beforeCopyDevices); assert.equal(mutations.filter(row => row.path === modelRoute).length, modelCopyWrites);
  await checkHeightLabel(editor, 'inlet', copiedPosition[1]); await checkHeightLabel(editor, 'outlet', copiedPosition[1]);
  await reset(editor); await snap(editor, '07-model-same-position-unsaved'); await snap(editor.locator('.config-panel'), '07-model-same-position-unsaved-controls');
  const modelCopyResponse = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'PUT');
  await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await modelCopyResponse).status(), 200); await editor.getByText(/模型进出料口默认配置已保存/).waitFor();
  modelSaved = await models(); const copiedModelPorts = parsed(modelSaved[0].metadata).loadingPorts;
  closeVector(copiedModelPorts.inlet.position, copiedPosition); closeVector(copiedModelPorts.outlet.position, copiedPosition);
  closeVector(copiedModelPorts.inlet.direction, [Math.SQRT1_2, 0, -Math.SQRT1_2]); closeVector(copiedModelPorts.outlet.direction, [-Math.SQRT1_2, 0, Math.SQRT1_2]);
  assert.equal(copiedModelPorts.outlet.nodeName, 'same_position_inlet_source'); assert.deepEqual(modelSaved[1], initialModels[1]); assert.deepEqual(await devices(), beforeCopyDevices);
  for (const key of Object.keys(parsed(beforeModelCopy[0].metadata))) if (key !== 'loadingPorts') assert.deepEqual(parsed(modelSaved[0].metadata)[key], parsed(beforeModelCopy[0].metadata)[key]);
  await page.reload(); await page.getByLabel('选择进出料口模型', { exact: true }).waitFor(); await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]); editor = getEditor(); await ready(editor);
  closeVector(await readVector(editor), copiedPosition); assert.deepEqual(await readPortDetails(editor), { angle: 45, nodeName: 'same_position_inlet_source' }); await switchKind(editor, 'outlet'); closeVector(await readVector(editor), copiedPosition); assert.deepEqual(await readPortDetails(editor), { angle: -135, nodeName: 'same_position_inlet_source' }); await switchKind(editor, 'inlet');
  check('model copy works inlet→outlet and outlet→inlet, independent XYZ and target directions are preserved, node follows source, and only explicit Save/reload persists it');
  await openAdvanced(editor); await editor.getByLabel('进出料口 X 位置', { exact: true }).fill(String(copiedPosition[0] + .7)); await closeAdvanced(editor);
  current = await api(modelRoute); const concurrentPorts = clone(current.ports); concurrentPorts.inlet.position[0] += .35;
  await api(modelRoute, 'PUT', { revision: current.revision, ports: concurrentPorts });
  const conflictResponse = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'PUT');
  expectingConflictConsole = true; await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await conflictResponse).status(), 409);
  await editor.getByRole('alert').filter({ hasText: '当前草稿已保留' }).waitFor(); expectingConflictConsole = false;
  closeVector(await readVector(editor), [copiedPosition[0] + .7, copiedPosition[1], copiedPosition[2]]);
  assert.equal(await samePosition(editor, 'inlet').isDisabled(), true); await assertRemovedControls(editor);
  await editor.getByRole('button', { name: '放弃未保存修改', exact: true }).click(); await page.getByRole('button', { name: '确定', exact: true }).click();
  assert.equal(await editor.getByRole('button', { name: '放弃未保存修改', exact: true }).count(), 0);
  await editor.getByRole('button', { name: '读取最新配置', exact: true }).waitFor(); assert.equal(await samePosition(editor, 'inlet').isDisabled(), true); assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  assert.deepEqual((await api(modelRoute)).ports, concurrentPorts); closeVector(await readVector(editor), copiedPosition);
  await reset(editor); await snap(editor, '07-conflict-discard-recovery-visible');
  const recoveryResponse = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'GET');
  await editor.getByRole('button', { name: '读取最新配置', exact: true }).click(); assert.equal((await recoveryResponse).status(), 200); await ready(editor);
  closeVector(await readVector(editor), concurrentPorts.inlet.position); assert.equal(await samePosition(editor, 'inlet').isEnabled(), true); assert.equal(await editor.getByRole('button', { name: '读取最新配置', exact: true }).count(), 0);
  await samePosition(editor, 'inlet').click(); assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isEnabled(), true);
  const recoveredSave = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'PUT'); await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await recoveredSave).status(), 200); await editor.getByText(/模型进出料口默认配置已保存/).waitFor(); modelSaved = await models();
  assert.deepEqual(parsed(modelSaved[0].metadata).loadingPorts, copiedModelPorts); assert.deepEqual(await devices(), beforeCopyDevices);
  check('real409 keeps the draft; discarding it still exposes Read latest and blocks stale writes; explicit reload restores copy/edit/save on the fresh revision');
  await reset(editor); await audit(editor, 1600, '07-final-complete-view');
  await assertRemovedControls(editor); await audit(editor, 1024, '07-same-position-narrow');
  const adminPage = page, readerName = 'loading_ports_reader', readerPassword = 'LoadingPorts-ReadOnly-' + crypto.randomBytes(12).toString('hex') + '!';
  await api('/api/admin-auth/users', 'POST', { username: readerName, password: readerPassword, role: 'viewer', permissions: { view: false }, pagePermissions: { models: { view: true, edit: false }, devices: { view: true, edit: false } } });
  const readerContext = await browser.newContext({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
  await readerContext.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'models', modelLibraryStep: 'library' })));
  page = await readerContext.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const readerWrites = []; page.on('request', request => { if (/^\/api\/(models|devices)(?:\/|$)/.test(new URL(request.url()).pathname) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) readerWrites.push(request.url()); });
  await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(readerName); await page.getByLabel('后台密码', { exact: true }).fill(readerPassword); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  const readerSteps = page.getByRole('navigation', { name: '模型库操作步骤' }); await readerSteps.waitFor(); await page.locator(`[data-model-id="${info.models[0]}"]`).locator('td').nth(2).click(); await readerSteps.getByRole('button', { name: /进出料口/ }).click(); await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]); editor = getEditor(); await ready(editor);
  await assertRemovedControls(editor); assert.equal(await samePosition(editor, 'inlet').isDisabled(), true); assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
  const readerBefore = await readVector(editor), readerPoint = await pixel(editor, 4); await page.mouse.click(readerPoint.x, readerPoint.y); closeVector(await readVector(editor), readerBefore); assert.deepEqual(readerWrites, []);
  await reset(editor); await snap(editor, '08-readonly-copy-disabled');
  await switchKind(editor, 'outlet'); assert.equal(await samePosition(editor, 'outlet').isDisabled(), true); assert.deepEqual(await models(), modelSaved); assert.deepEqual(await devices(), beforeCopyDevices);
  const readerSession = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const denied = await page.request.put(info.origin + modelRoute, { headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': readerSession.csrfToken, 'X-Factory-ID': info.factoryId }, data: { revision: (await api(modelRoute)).revision, ports: copiedModelPorts } }); assert.equal(denied.status(), 403);
  await readerContext.close(); page = adminPage;
  check('real read-only account sees disabled same-position/save controls, surface clicks write nothing, and backend rejects a direct port mutation with403');
  assert.deepEqual((await models())[1], initialModels[1]); assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, expectedConsoleErrors, 'only the deliberate real409 resource error is expected; WebGL errors must not be swallowed'); assert.equal(expectedConsoleErrors.length, 1); assert.match(expectedConsoleErrors[0], /409/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.assetPath)).digest('hex'), info.assetSha256);
  assert.equal(mutations.filter(row => /\/api\/(?:plc|engine|collector)(?:\/|$)/.test(row.path)).length, 0);
  const result = { success: true, checks, directory, fixtureDirectory: info.directory, errors, consoleErrors, expectedConsoleErrors, picks, audits, screenshots, mutations,
    noPLCCommands: true, assetUnchanged: true, pointerSource: 'real page.mouse plus CPU authored-triangle raycast; no component access', ownedBackendPid: info.backendPid };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ success: true, directory, checks, screenshotCount: screenshots.length, realPicks: picks.length, errors, ownedBackendPid: info.backendPid }, null, 2));
  fs.appendFileSync(runLog, JSON.stringify({ success: true, checks: checks.length, screenshotCount: screenshots.length, realPicks: picks.length, ownedBackendPid: info.backendPid }) + '\n');
}
main().catch(async error => {
  await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack || String(error), errors, consoleErrors, mutations, picks }, null, 2));
  console.error(error); process.exitCode = 1;
  fs.appendFileSync(runLog, 'FAIL ' + (error.stack || String(error)) + '\n');
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(fixture?.backend); fs.appendFileSync(runLog, 'Stopped only the owned fixture backend process/tree.\n'); });
