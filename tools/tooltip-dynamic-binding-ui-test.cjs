'use strict';
// Owned profile, display-only engine and actual Vue/browser surfaces. No PLC,
// commissioned database, user installation or private application state writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const Database = require('../backend/node_modules/better-sqlite3');
const { createRunDirectory, startLoggedProcess, waitUntil, findFreePort, waitForHttp, requireTestPath, BACKEND_DIR } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const ROOT = path.resolve(__dirname, '..');
const PATHS = { status_value: 'hover.device.status', workshop_value: 'hover.device.workshopName', line_value: 'hover.device.lineName' };
const STATUS = { good: '数据正常', bad: '数据异常 / 未连接', stale: '数据已过期' };
const CUSTOM_STYLE = { color: '#d6ff8c', fontSize: 13, fontWeight: 700, fontFamily: 'Microsoft YaHei UI', padding: 0 };
const FROZEN = '错误冻结：永远数据正常';

async function fixtureServer() {
    // This reuses the existing manual-disassembly/trend fixture's isolated
    // sandbox and collector-free backend copy, adding controllable real frames.
    const sandbox = await createSmokeSandbox('tooltip-dynamic-binding-server');
    sandbox.password = 'TooltipDynamic-Isolated-' + require('node:crypto').randomBytes(12).toString('hex') + '!';
    const db = new Database(sandbox.filename);
    const project = db.prepare('SELECT * FROM projects WHERE factory_id=? ORDER BY is_active DESC,created_at LIMIT 1').get('factory_default');
    const scene = db.prepare('SELECT * FROM scenes WHERE project_id=? ORDER BY is_active DESC,sort_order LIMIT 1').get(project.id);
    const targets = db.prepare('SELECT id FROM devices ORDER BY id LIMIT 2').all().map(row => row.id);
    assert.equal(targets.length, 2);
    const deviceNames = ['绑定验收设备A', '绑定验收设备B'];
    const workshops = ['dynamic_workshop_a', 'dynamic_workshop_b'], lines = ['dynamic_line_a', 'dynamic_line_b'];
    const workshopNames = ['关联车间A', '关联车间B'], lineNames = ['关联产线A', '关联产线B'];
    for (let i = 0; i < 2; i++) {
        db.prepare('INSERT INTO workshops(id,name,factory_id) VALUES(?,?,?)').run(workshops[i], workshopNames[i], 'factory_default');
        db.prepare('INSERT INTO lines(id,name,workshop_id) VALUES(?,?,?)').run(lines[i], lineNames[i], workshops[i]);
        db.prepare('UPDATE devices SET name=?,line_id=?,plc_enabled=0 WHERE id=?').run(deviceNames[i], lines[i], targets[i]);
    }
    db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();
    db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
    const { createEmptyDocument } = require('../backend/utils/dashboardDocument');
    const document = createEmptyDocument({ project, scene });
    const deviceTemplate = document.tooltipTemplates.templates.find(template => template.id === 'tooltip_device');
    assert.ok(deviceTemplate);
    const preserved = {};
    for (const [key, expectedPath] of Object.entries(PATHS)) {
        const field = deviceTemplate.widgets.find(widget => widget.id === 'tooltip_device_' + key);
        assert.ok(field, 'actual preset field exists: ' + key);
        assert.equal(field.data.path, expectedPath);
        field.style = { ...field.style, ...CUSTOM_STYLE };
        field.frame = { ...field.frame, width: 130, height: 26 };
        preserved[key] = { frame: { ...field.frame }, style: { ...field.style } };
        // Stored legacy documents bypass new save normalization. Remove the
        // provenance marker just as an old version would have persisted it.
        delete field.dynamicBinding;
        delete field.dynamicField;
        field.data = { mode: 'static', deviceScope: 'current', readOnly: true };
        field.content = { ...field.content, text: key === 'status_value' ? '数据正常' : key === 'workshop_value' ? '冻结旧车间' : '冻结旧产线' };
    }
    for (const widget of deviceTemplate.widgets) { delete widget.dynamicBinding; delete widget.dynamicField; }
    const legacyCopy = JSON.parse(JSON.stringify(deviceTemplate));
    legacyCopy.id = 'tooltip_legacy_numeric_copy'; legacyCopy.name = '旧版复制提示';
    const oldBackground = legacyCopy.backgroundWidgetId;
    legacyCopy.widgets.forEach((widget, i) => {
        if (widget.id === oldBackground) legacyCopy.backgroundWidgetId = `${legacyCopy.id}_${i}`;
        widget.id = `${legacyCopy.id}_${i}`; delete widget.dynamicBinding; delete widget.dynamicField;
    });
    document.tooltipTemplates.templates.push(legacyCopy);
    for (const view of document.scene.views) if (['factory', 'workshop', 'line'].includes(view.mode)) {
        view.metadata = { ...view.metadata, tooltipTemplates: { ...view.metadata?.tooltipTemplates, device: 'inherit' },
            deviceTooltip: { ...view.metadata?.deviceTooltip, enabled: true } };
    }
    db.prepare('UPDATE scenes SET draft_json=?,draft_revision=1 WHERE id=?').run(JSON.stringify(document), scene.id);
    db.close();
    const { COLLECTOR_FILES } = require('../desktop/scripts/prepare-display-distribution.cjs');
    const backendDirectory = path.join(sandbox.directory, 'resources/backend');
    fs.mkdirSync(backendDirectory, { recursive: true });
    for (const entry of ['server.js', 'services', 'db', 'routes', 'utils', 'middleware'])
        fs.cpSync(path.join(BACKEND_DIR, entry), path.join(backendDirectory, entry), { recursive: true,
            filter: filename => !COLLECTOR_FILES.includes(path.basename(filename)) });
    fs.symlinkSync(path.join(BACKEND_DIR, 'assets'), path.join(backendDirectory, 'assets'), 'junction');
    fs.symlinkSync(path.join(BACKEND_DIR, 'node_modules'), path.join(backendDirectory, 'node_modules'), 'junction');
    fs.cpSync(path.join(ROOT, 'shared'), path.join(sandbox.directory, 'resources/shared'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'release-manifest.json'), path.join(sandbox.directory, 'resources/release-manifest.json'));
    fs.writeFileSync(path.join(backendDirectory, 'distribution.json'), '{"collector":false}');
    const origin = `http://127.0.0.1:${await findFreePort()}`;
    Object.assign(process.env, sandbox.env, { PORT: origin.split(':').at(-1), HOST: '127.0.0.1', FRONTEND_DIST: path.join(ROOT, 'frontend/dist') });
    require(path.join(backendDirectory, 'server.js'));
    await waitForHttp(origin + '/api/health'); await createSmokeSession(origin, sandbox);
    const state = { qualityA: 'good', qualityB: 'good', alarmA: false, runningA: true };
    function broadcast() {
        const now = Date.now();
        const frames = targets.map((deviceId, index) => {
            const quality = state[index ? 'qualityB' : 'qualityA'];
            return { furnace_id: deviceId, furnace_name: deviceNames[index], timestamp: now,
                analog: { actual_temp: index ? 712.3 : 856.7 },
                status: { online: quality !== 'bad', running: index ? true : state.runningA, alarm: index ? false : state.alarmA },
                quality: { analog: { actual_temp: quality }, status: { _connection: quality, running: quality, alarm: quality } } };
        });
        for (const frame of frames) global.dataEngine.deviceSnapshots.set(frame.furnace_id, frame);
        global.wsServer?.broadcastDeviceData(frames);
    }
    const control = http.createServer(async (req, res) => {
        try {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const patch = JSON.parse(raw || '{}');
            for (const key of ['qualityA', 'qualityB']) if (key in patch) {
                if (!['good', 'bad', 'stale'].includes(patch[key])) throw new Error('unsupported fixture quality');
                state[key] = patch[key];
            }
            for (const key of ['alarmA', 'runningA']) if (key in patch) state[key] = !!patch[key];
            broadcast(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state));
        } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
    broadcast(); setInterval(broadcast, 350);
    fs.writeFileSync(requireTestPath(process.env.TOOLTIP_DYNAMIC_BINDING_INFO_FILE), JSON.stringify({ origin,
        control: `http://127.0.0.1:${control.address().port}`, directory: sandbox.directory, database: sandbox.filename,
        username: 'admin', password: sandbox.password, devices: targets, deviceNames, workshops, lines, workshopNames, lineNames,
        sceneId: String(scene.id), preserved }, null, 2));
}

async function browserTest() {
    const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
    const directory = createRunDirectory('tooltip-dynamic-binding-ui');
    const errors = [], checks = [], observations = [];
    let helper, browser, page, native, info;
    const pass = label => { checks.push(label); console.log('PASS ' + label); };
    const clone = value => JSON.parse(JSON.stringify(value));
    async function api(route, method = 'GET', data, expected = 200) {
        const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
        const response = await page.request.fetch(info.origin + '/api' + route, { method,
            headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
            ...(data === undefined ? {} : { data }) });
        assert.equal(response.status(), expected, await response.text()); return response.json();
    }
    async function control(patch) {
        const response = await fetch(info.control, { method: 'POST', body: JSON.stringify(patch) }); assert.equal(response.status, 200);
    }
    function field(template, key) { return template.widgets.find(widget => widget.data?.path === PATHS[key]); }
    function assertDynamic(template, label) {
        for (const [key, expectedPath] of Object.entries(PATHS)) {
            const widget = field(template, key); assert.ok(widget, `${label}: ${key} retains its semantic source`);
            assert.equal(widget.data.mode, 'runtime'); assert.equal(widget.data.path, expectedPath);
            assert.equal(widget.dynamicField, expectedPath, `${label}: copied/migrated system field retains its canonical role`);
            assert.ok(widget.content.text.includes('{value}')); assert.ok(widget.dynamicBinding, `${label}: durable binding provenance`);
            assert.equal(widget.content.lines, undefined); assert.equal(widget.content.value, undefined);
            assert.equal(widget.content.valueMap, undefined);
        }
    }
    async function host(extra) {
        await native.evaluate(context => { for (const fn of window.__ownedHandlers) fn({ data: { type: 'overlay_host_state', visible: true, context } }); },
            { factoryId: 'factory_default', sceneReady: true, viewId: 'factory_overview', viewMode: 'factory', deviceId: '', lineId: '', workshopId: '',
                hoveredDeviceId: info.devices[0], deviceHoverPointer: { visible: true, x: .55, y: .5 }, ...extra });
    }
    try {
        const infoFile = path.join(directory, 'server.json');
        helper = startLoggedProcess(process.execPath, [__filename, '--fixture-server'], { cwd: ROOT,
            env: { ...process.env, TOOLTIP_DYNAMIC_BINDING_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
        await waitUntil(() => { assert.equal(helper.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned display-only tooltip backend');
        info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
        browser = await playwright.chromium.launch({ headless: true,
            ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
        const context = await browser.newContext({ viewport: { width: 1680, height: 1200 } });
        await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'platform', platformSubpage: 'designer' })));
        page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
        await page.goto(info.origin + '/admin');
        await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
        await page.getByLabel('后台密码', { exact: true }).fill(info.password);
        await page.getByRole('button', { name: '解锁后台', exact: true }).click();
        await page.locator('.dashboard-designer-shell').waitFor();
        let stored = await api('/platform/designer');
        const original = stored.document.tooltipTemplates.templates.find(template => template.id === 'tooltip_device');
        assertDynamic(original, 'legacy default repair');
        assertDynamic(stored.document.tooltipTemplates.templates.find(template => template.id === 'tooltip_legacy_numeric_copy'), 'legacy numeric copied-template repair');
        for (const key of Object.keys(PATHS)) {
            const repaired = field(original, key); assert.deepEqual(repaired.frame, info.preserved[key].frame);
            for (const [styleKey, value] of Object.entries(CUSTOM_STYLE)) assert.equal(repaired.style[styleKey], value);
        }
        pass('loading old frozen default and numeric copied templates restores live semantic fields without losing typography or geometry');
        await page.getByRole('button', { name: '悬停提示', exact: true }).click();
        const editor = page.getByRole('region', { name: '悬停提示模板编辑器', exact: true }); await editor.waitFor();
        await editor.locator('.tooltip-template-row[data-tooltip-template-id="tooltip_device"]').click();
        await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[0]);
        const surface = editor.locator('.tooltip-surface-preview');
        const rendered = key => surface.locator(`[data-tooltip-widget-id="tooltip_device_${key}"] .text-widget-body`).textContent();
        for (const [key, expectedPath] of Object.entries(PATHS)) {
            await editor.locator(`[data-tooltip-layer-id="tooltip_device_${key}"]`).click();
            await editor.getByRole('button', { name: '内容', exact: true }).click();
            const current = editor.getByLabel('悬停文字当前显示', { exact: true }); await current.waitFor();
            assert.equal(await current.isEditable(), false);
            assert.equal(await editor.getByRole('button', { name: '改为自定义文字', exact: true }).count(), 0);
            const format = editor.getByLabel('悬停元素文字', { exact: true });
            assert.equal(await format.count(), 0, 'linked metadata has no constant/format editing entry');
            assert.equal(await editor.getByLabel('悬停空值文字', { exact: true }).count(), 0);
            assert.equal(await editor.getByRole('button', { name: '＋ 映射规则', exact: true }).count(), 0);
            await editor.getByRole('button', { name: '数据来源', exact: true }).click();
            const linked = editor.getByLabel('悬停关联字段', { exact: true }); await linked.waitFor();
            assert.equal(await linked.inputValue(), expectedPath); assert.equal(await linked.isEditable(), false);
            assert.equal(await editor.getByLabel('悬停元素数据来源', { exact: true }).count(), 0);
        }
        await editor.locator('[data-tooltip-layer-id="tooltip_device_status_value"]').click();
        await editor.getByRole('button', { name: '内容', exact: true }).click();
        const currentStatus = editor.getByLabel('悬停文字当前显示', { exact: true });
        async function previewState(quality) {
            await control({ qualityA: quality });
            await waitUntil(async () => (await rendered('status_value')).trim() === STATUS[quality] && await currentStatus.inputValue() === STATUS[quality],
                10000, 'editor true quality ' + quality);
            observations.push({ surface: 'editor', quality, text: (await rendered('status_value')).trim() });
        }
        for (const quality of ['good', 'bad', 'stale', 'good']) await previewState(quality);
        await control({ alarmA: true, runningA: false }); await previewState('good');
        await editor.screenshot({ path: path.join(directory, '01-repaired-status-readonly-editor.png') });
        pass('readonly status text follows real websocket good, bad, stale and recovery; process alarm/running does not invent a data-connection state');
        await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[1]);
        await waitUntil(async () => (await rendered('workshop_value')).trim() === info.workshopNames[1]
            && (await rendered('line_value')).trim() === info.lineNames[1], 10000, 'device B associations');
        await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[0]);
        await waitUntil(async () => (await rendered('workshop_value')).trim() === info.workshopNames[0]
            && (await rendered('line_value')).trim() === info.lineNames[0], 10000, 'device A associations');
        pass('workshop and production line remain object-linked and update with the selected device, not saved preview copy');
        for (const [key, value] of [['title', '设备资料 · 可修改标题'], ['status_label', '数据链路'], ['workshop_label', '车间归属'], ['line_label', '产线归属']]) {
            await editor.locator(`[data-tooltip-layer-id="tooltip_device_${key}"]`).click();
            await editor.getByRole('button', { name: '内容', exact: true }).click();
            const fixed = editor.getByLabel('悬停元素文字', { exact: true }); assert.equal(await fixed.isEditable(), true);
            assert.equal(await editor.getByLabel('悬停文字当前显示', { exact: true }).count(), 0);
            await fixed.fill(value); await fixed.blur();
            await waitUntil(async () => (await rendered(key)).trim() === value, 5000, 'editable fixed ' + key);
        }
        // A new user-authored field is not a preset system identity/status row.
        // It may choose another real dynamic source, without freezing a value.
        await editor.getByRole('button', { name: '＋ 文字', exact: true }).click();
        const ordinaryId = await editor.locator('.tooltip-layer-row.active').getAttribute('data-tooltip-layer-id');
        await editor.getByRole('button', { name: '数据来源', exact: true }).click();
        const ordinarySource = editor.getByLabel('悬停元素数据来源', { exact: true });
        await ordinarySource.selectOption('runtime');
        const ordinaryField = editor.getByLabel('悬停字段', { exact: true });
        await ordinaryField.waitFor(); assert.equal(await ordinaryField.isEnabled(), true);
        assert.equal(await ordinaryField.inputValue(), 'hover.device.name');
        await ordinaryField.selectOption('hover.device.workshopName');
        assert.equal(await ordinaryField.inputValue(), 'hover.device.workshopName');
        assert.equal(await ordinarySource.locator('option[value="static"]').count(), 0);
        const ordinaryText = () => surface.locator(`[data-tooltip-widget-id="${ordinaryId}"] .text-widget-body`).textContent();
        await waitUntil(async () => (await ordinaryText()).trim() === info.workshopNames[0], 5000, 'new text can choose the real workshop source');
        await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[1]);
        await waitUntil(async () => (await ordinaryText()).trim() === info.workshopNames[1], 5000, 'new dynamic text follows device B');
        await editor.getByLabel('悬停预览设备', { exact: true }).selectOption(info.devices[0]);
        await waitUntil(async () => (await ordinaryText()).trim() === info.workshopNames[0], 5000, 'restore device A for template copying');
        observations.push({ surface: 'editor-new-user-text', source: 'hover.device.workshopName', changedDevices: 2 });
        await editor.locator(`[data-tooltip-selection-id="${ordinaryId}"] .tooltip-element-delete`).click();
        await waitUntil(async () => !(await editor.locator(`[data-tooltip-layer-id="${ordinaryId}"]`).count()), 5000, 'remove owned new-text fixture to retain authored card layout');
        pass('ordinary new text can switch from device name to a real workshop field and follow device changes, while fixed-value conversion stays unavailable');
        await editor.getByRole('button', { name: '复制模板', exact: true }).click();
        const copyId = await editor.locator('.tooltip-template-row.active').getAttribute('data-tooltip-template-id');
        assert.notEqual(copyId, 'tooltip_device');
        await page.getByRole('button', { name: '保存草稿', exact: true }).click();
        await waitUntil(async () => (await api('/platform/designer')).document.tooltipTemplates.templates.some(template => template.id === copyId),
            12000, 'saved UI template copy');
        stored = await api('/platform/designer');
        const copy = stored.document.tooltipTemplates.templates.find(template => template.id === copyId); assertDynamic(copy, 'UI template copy');
        assert.equal(copy.widgets.find(widget => widget.title === '提示标题').content.text, '设备资料 · 可修改标题');
        pass('fixed titles and left captions remain directly editable; copying the template preserves dynamic-binding provenance');
        const forged = clone(stored.document);
        for (const template of forged.tooltipTemplates.templates.filter(template => ['tooltip_device', copyId].includes(template.id))) {
            for (const key of Object.keys(PATHS)) {
                const widget = field(template, key);
                widget.data = { mode: 'static', readOnly: true };
                widget.content.text = FROZEN; widget.content.lines = [FROZEN]; widget.content.value = FROZEN;
                widget.content.valueMap = [{ value: STATUS.good, text: FROZEN }];
            }
        }
        const lineView = forged.scene.views.find(view => view.id === 'line_overview');
        lineView.metadata = { ...lineView.metadata, tooltipTemplates: { ...lineView.metadata?.tooltipTemplates, device: copyId } };
        await api('/platform/designer/draft', 'PUT', { sceneId: forged.sceneId, document: forged, expectedRevision: stored.revision });
        stored = await api('/platform/designer');
        for (const template of stored.document.tooltipTemplates.templates.filter(template => ['tooltip_device', copyId].includes(template.id))) {
            assertDynamic(template, 'forged static save'); assert.ok(!JSON.stringify(template).includes(FROZEN));
        }
        await api('/platform/releases', 'POST', { sceneId: forged.sceneId, notes: 'Owned semantic tooltip binding acceptance' });
        pass('forged static/lines/value/valueMap saves cannot freeze semantic fields in the original or copied template');
        await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
        await page.getByRole('button', { name: '悬停提示', exact: true }).click(); await editor.waitFor();
        await editor.locator('.tooltip-template-row[data-tooltip-template-id="tooltip_device"]').click();
        await editor.locator('[data-tooltip-layer-id="tooltip_device_status_value"]').click();
        await editor.getByRole('button', { name: '内容', exact: true }).click();
        assert.equal(await editor.getByLabel('悬停文字当前显示', { exact: true }).isEditable(), false);
        await editor.screenshot({ path: path.join(directory, '02-reload-retains-dynamic-binding.png') });
        native = await context.newPage(); native.setDefaultTimeout(20000); native.on('pageerror', error => errors.push(error.message));
        await native.addInitScript(() => { window.__ownedHandlers = []; window.chrome = { webview: { postMessage() {},
            addEventListener(name, fn) { if (name === 'message') window.__ownedHandlers.push(fn); }, removeEventListener() {} } }; });
        // Readiness-only host fixture, as in the existing tooltip UI test. Data
        // and every status transition still come from the real backend/WS store.
        await native.route('**/api/health', async route => { const response = await route.fetch(), body = await response.json();
            body.readiness = { ...body.readiness, displayReady: true }; await route.fulfill({ response, json: body }); });
        await native.goto(info.origin + '/overlay?embedded=unity&surface=overlay&scene=1');
        await native.locator('.dashboard-overlay-root').waitFor({ state: 'attached' });
        await native.addStyleTag({ content: 'html,body,#app{background:#171823!important}' });
        await host({});
        await native.getByRole('status', { name: '大屏正在加载', exact: true }).waitFor({ state: 'hidden' });
        const card = native.getByLabel('悬停设备详情', { exact: true }); await card.waitFor();
        const nativeText = key => card.locator(`[data-tooltip-widget-id="tooltip_device_${key}"] .text-widget-body`).textContent();
        assert.match(await card.textContent(), /设备资料 · 可修改标题/);
        for (const quality of ['good', 'bad', 'stale', 'good']) {
            await control({ qualityA: quality });
            await waitUntil(async () => (await nativeText('status_value')).trim() === STATUS[quality], 10000, 'published native quality ' + quality);
            observations.push({ surface: 'native-overlay', quality, text: (await nativeText('status_value')).trim() });
            if (quality === 'bad') await card.screenshot({ path: path.join(directory, '03-runtime-bad-status-not-frozen.png') });
        }
        await control({ qualityB: 'stale' }); await host({ hoveredDeviceId: info.devices[1] });
        await waitUntil(async () => (await nativeText('status_value')).trim() === STATUS.stale
            && (await nativeText('workshop_value')).trim() === info.workshopNames[1]
            && (await nativeText('line_value')).trim() === info.lineNames[1], 10000, 'published device B identity/status/associations');
        await card.screenshot({ path: path.join(directory, '04-runtime-device-b-associations.png') });
        pass('published actual overlay follows good/bad/stale/recovery and another device’s true status, workshop and production line');
        await host({ viewId: 'line_overview', viewMode: 'line', lineId: info.lines[1], hoveredDeviceId: info.devices[1] });
        const copiedCard = native.locator(`.tooltip-surface[data-tooltip-template-id="${copyId}"]`); await copiedCard.waitFor();
        const copiedStatus = field(copy, 'status_value').id;
        const copiedStatusText = () => copiedCard.locator(`[data-tooltip-widget-id="${copiedStatus}"] .text-widget-body`).textContent();
        await control({ qualityB: 'bad' }); await waitUntil(async () => (await copiedStatusText()).trim() === STATUS.bad, 10000, 'copied native bad');
        await control({ qualityB: 'good' }); await waitUntil(async () => (await copiedStatusText()).trim() === STATUS.good, 10000, 'copied native recovery');
        await copiedCard.screenshot({ path: path.join(directory, '05-runtime-copied-template-live-status.png') });
        await host({ hoveredDeviceId: '', deviceHoverPointer: { visible: false } }); await copiedCard.waitFor({ state: 'hidden' });
        pass('published copied template keeps live status through failure/recovery and hides on pointer leave');
        assert.deepEqual(errors, []);
        const result = { success: true, directory, checks, errors, observations, noCollectorOrCommissionedData: true,
            actualUnityBackgroundTested: false, readinessOnlyHostFixture: true };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ success: true, directory, checks }, null, 2));
    } catch (error) {
        await (native || page)?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ success: false, directory, error: error.stack, checks, errors, observations }, null, 2));
        console.error(error.stack); console.error('ARTIFACT_DIRECTORY ' + directory); process.exitCode = 1;
    } finally { await browser?.close(); await stopOwnedSmokeProcess(helper); }
}

if (process.argv.includes('--fixture-server')) fixtureServer().catch(error => { console.error(error.stack); process.exit(1); });
else browserTest();
