'use strict';
// Real Vue controls and browser, but only in-memory authored fixtures on an
// isolated Vite origin. No installed collector, PLC, database or field account.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module'), { pathToFileURL } = require('node:url');
const { createRunDirectory, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { validateMovementConfig } = require('../backend/services/movementConfig');
const root = path.resolve(__dirname, '..'), front = path.join(root, 'frontend');
const frontRequire = createRequire(path.join(front, 'package.json'));
const directory = createRunDirectory('simple-station-ui'), errors = [], writes = [];
const point = (id, data_type, label) => ({ id, device_id: 'cart', data_type, label, access_type: 'READ' });
const cart = { id: 'cart', name: '送料小车', line_id: 'line', model_type: 'transfer_cart', coordinate_space: 'line_local',
    pos_x: 0, pos_y: 0, pos_z: 0, lineLayout: { rails: [{ id: 'rail', length: 20 }] },
    instance_config: { role: 'transfer_cart', railLineId: 'line', railId: 'rail', custom: 'preserved',
        movement: { enabled: true, valueMode: 'station', stationInputMeaning: 'target', currentPositionPointId: '1', startActionPointId: '3',
            simulationEnabled: true, acceleration: 1, maxSpeed: 2, sceneUnitsPerMeter: 1, smoothingMs: 100,
            start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 0, z: 0 }, stations: [{ value: 1, anchorDeviceId: 'furnace', position: { x: 10, y: 0, z: 0 }, distanceMeters: 8 }] } },
    dataPoints: [point('1', 'WORD', '目标工位编号'), point('2', 'BOOL', '小车到位')] };
const fixed = { id: 'furnace', name: '加热炉', line_id: 'line', pos_x: 10, pos_y: 0, pos_z: 3,
    coordinate_space: 'line_local', instance_config: { laneLineId: 'line', laneId: 'lane', stationNumber: 1 } };
let server, browser;
(async () => {
    const entry = path.join(directory, 'entry.mjs'), html = path.join(directory, 'index.html');
    const url = name => '/@fs/' + path.join(root, name).replaceAll('\\', '/');
    fs.writeFileSync(entry, `import {createApp,h} from 'vue';
import Mobile from ${JSON.stringify(url('frontend/src/views/admin/components/MobileDeviceMotion.vue'))};
import ${JSON.stringify(url('frontend/src/style.css'))};
import {adminApi} from ${JSON.stringify(url('frontend/src/config/factoryConfig.js'))};
import {adminSession} from ${JSON.stringify(url('frontend/src/runtime/adminSession.js'))};
import {normalizePagePermissions} from ${JSON.stringify(url('shared/pagePermissions.mjs'))};
Object.assign(adminSession,{authenticated:true,user:{role:'owner'},pagePermissions:normalizePagePermissions({},{owner:true})});
const read=async()=>fetch('/fixture/state').then(r=>r.json());
adminApi.getDevice=async()=>structuredClone((await read()).devices[0]);
adminApi.updateDeviceMovement=async(id,movement,pointIds,expectedMovement)=>fetch('/fixture/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,movement,pointIds,expectedMovement})}).then(r=>r.json());
const initial=await read();createApp({render:()=>h(Mobile,{devices:initial.devices})}).mount('#app');`);
    fs.writeFileSync(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#f4f6fa;font:14px 'Microsoft YaHei',sans-serif}#app{max-width:1250px;margin:auto}.input{width:100%;box-sizing:border-box}.btn{padding:8px 14px}</style><div id="app"></div><script>window.__DIGITAL_TWIN_BACKEND_ORIGIN__=location.origin</script><script type="module" src="${'/@fs/' + entry.replaceAll('\\', '/')}"></script></html>`);
    const { createServer } = await import(pathToFileURL(frontRequire.resolve('vite')).href);
    server = await createServer({ root: front, configFile: path.join(front, 'vite.config.js'), cacheDir: path.join(directory, '.vite'),
        resolve: { dedupe: ['vue'] }, optimizeDeps: { include: ['vue'] }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
        plugins: [{ name: 'isolated-simple-cart', configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
            // Same-origin /api could otherwise reach the project's ordinary
            // Vite proxy. Block it before any proxy middleware, not only in
            // the browser's cross-origin request guard.
            if (req.url.startsWith('/api/')) { res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"Live APIs disabled in isolated presentation fixture"}'); }
            if (!req.url.startsWith('/fixture/')) return next();
            res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
            if (req.url === '/fixture/state') return res.end(JSON.stringify({ devices: [cart, fixed] }));
            try {
                let raw = ''; for await (const chunk of req) raw += chunk;
                const body = JSON.parse(raw); assert.equal(body.id, 'cart'); validateMovementConfig(body.movement);
                assert.deepEqual(body.expectedMovement, cart.instance_config.movement ?? null);
                assert.deepEqual(body.pointIds, ['1', '2']); assert.equal(body.movement.arrivalSignalPointId, '2');
                cart.instance_config.movement = body.movement; writes.push(body); res.end('{"success":true}');
            } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
        }); } }] });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1360, height: 950 } }); page.setDefaultTimeout(60000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
        const requested = new URL(route.request().url());
        if (['http:', 'https:'].includes(requested.protocol) && requested.origin !== origin) {
            errors.push(`Blocked non-fixture request ${requested.origin}`); return route.abort('blockedbyclient');
        }
        return route.continue();
    });
    assert.equal((await page.request.get(origin + '/api/health')).status(), 503, 'Vite must never proxy to an installed collector');
    const pageUrl = origin + '/@fs/' + html.replaceAll('\\', '/'); await page.goto(pageUrl);
    const smooth = page.getByRole('checkbox', { name: '到位时平滑对齐', exact: true }); await smooth.waitFor();
    assert.equal(await smooth.isChecked(), true);
    assert.equal(await page.getByLabel('PLC 到位 BOOL 信号', { exact: true }).inputValue(), '', 'legacy moving signal must not become arrival');
    for (const name of ['切换简易工位显示', '工位编号数据含义', '移动场景单位每米', '移动轨道起始 X', '移动视觉平滑时间（毫秒）', '开启移动运动细节模拟'])
        assert.equal(await page.getByLabel(name, { exact: true }).count(), 0, name);
    assert.equal(await page.locator('details').count(), 0, 'retired fields must not survive in an advanced/collapsed form');
    assert.equal(cart.instance_config.movement.acceleration, 1, 'opening the simple editor must not rewrite a saved legacy configuration');
    await page.getByLabel('移动位置数值点位', { exact: true }).selectOption('1');
    await page.getByLabel('PLC 到位 BOOL 信号', { exact: true }).selectOption('2');
    await page.getByRole('checkbox', { name: '启用移动同步', exact: true }).check();
    await page.getByRole('button', { name: /^从当前产线导入 \d+ 个$/ }).click();
    await page.getByRole('button', { name: '保存移动配置', exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes('移动配置已保存'));
    assert.equal(writes.length, 1); assert.equal(writes[0].movement.arrivalSmoothing, true);
    for (const key of ['acceleration', 'maxSpeed', 'sceneUnitsPerMeter']) assert.equal(Object.hasOwn(writes[0].movement, key), false);
    assert.equal(await page.getByLabel('移动场景单位每米').count(), 0);
    await page.screenshot({ path: path.join(directory, 'simple-cart-desktop.png'), fullPage: true });
    await smooth.uncheck(); await page.getByRole('button', { name: '保存移动配置', exact: true }).click();
    await waitUntil(() => writes.length === 2, 10000, 'unchecked smoothing persisted');
    await page.reload(); await smooth.waitFor(); assert.equal(await smooth.isChecked(), false);
    await page.setViewportSize({ width: 760, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(directory, 'simple-cart-narrow.png'), fullPage: true });
    assert.equal(writes.length, 2); assert.equal(cart.instance_config.custom, 'preserved'); assert.deepEqual(errors, []);
    const result = { success: true, legacyRecordShowsOnlySimpleForm: true, noAdvancedOrSwitchEntry: true, defaultChecked: true,
        uncheckedReopened: true, oneClickStations: true, noPhysicalFields: true, isolatedOrigin: true, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await server?.close(); });
