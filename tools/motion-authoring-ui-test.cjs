'use strict';
// Retirement regression: the custom model-animation editor is gone. A legacy
// package is prepared only in this disposable fixture, never through the UI.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const artifactRoot = requireTestPath(path.resolve(__dirname, '../output/playwright')); fs.mkdirSync(artifactRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifactRoot, `custom-motion-editor-removal-browser-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`)), checks = [], errors = [], authoringRequests = [], animationWrites = [];
let helper, browser, page, live;
const check = message => { checks.push(message); console.log('PASS ' + message); };
async function assertNoLivePreview() {
    assert.equal(await live.locator('.link-preview, .motion-link-stage, canvas').count(), 0);
    for (const name of ['跟随采集', '本页试动作']) assert.equal(await live.getByRole('button', { name, exact: true }).count(), 0);
    assert.equal(await live.getByRole('slider', { name: '试动作进度', exact: true }).count(), 0);
}
(async () => {
    const infoFile = path.join(directory, 'server.json');
    helper = startLoggedProcess(process.execPath, [path.join(__dirname, 'motion-authoring-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MOTION_AUTHORING_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log')
    });
    let info;
    await waitUntil(() => {
        assert.equal(helper.exitCode, null);
        try { info = JSON.parse(fs.readFileSync(infoFile)); return !!info.origin; } catch { return false; }
    }, 60000, 'owned display-only backend complete bootstrap');
    requireTestPath(info.database); assert.match(info.origin,/^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie, 'X-CSRF-Token': info.session.csrfToken };
    const api = async (route, method = 'GET', body) => {
        const response = await fetch(info.origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const route = `/api/models/${info.modelId}/motion-actions`, original = await api(route);
    const node = original.nodes.find(n => n.name.endsWith('roller_bed_metal')); assert.ok(node);
    const action = {
        id: 'user_legacy_preserved', label: '既有承料台抬升', mode: 'position', duration: 2, cycle: 'forward',
        tracks: [{ nodeId: node.id, operation: 'translate', axis: 'y', from: 0, to: .4, start: 0, end: 1, easing: 'linear', pivot: [0, 0, 0], fromColor: '#000000', toColor: '#ffffff' }]
    };
    const seeded = await api(route, 'PUT', { revision: original.revision, actions: [action] });
    const part = {id:'retained-part-lift',name:'承料台部件抬升',node_name:node.name,source_group:'analog',source_key:'stroke',
        action:'translate',axis:'y',input_min:0,input_max:1,output_min:0,output_max:.4,speed_factor:1,transition_duration:.1};
    const metadata = typeof seeded.model.metadata === 'string' ? JSON.parse(seeded.model.metadata) : seeded.model.metadata;
    await api(`/api/models/${info.modelId}/bindings`,'PUT',{expectedBindings:metadata.partBindings || [],partBindings:[part]});
    const preservedBaseline = await api(route);
    const historicalBinding = {actionId:'clip:'+action.id,enabled:true,pointId:info.pointId,dataItemId:'',trigger:{mode:'range'},
        inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:.1,kind:'clip',mode:'position',clipId:action.id,partId:'',
        sourceGroup:'analog',sourceKey:'stroke',extension:{archive:'must remain'}};
    // Directly seed only the disposable output DB, never activate a retired
    // clip through the API, which now correctly rejects newly enabled clips.
    const db = new Database(requireTestPath(info.database));
    let historicalInstance;
    try {
        const stored = db.prepare('SELECT instance_config FROM devices WHERE id=?').get(info.deviceId);
        historicalInstance = {...JSON.parse(stored.instance_config || '{}'),animationBindings:{version:1,staleMs:5000,bindings:[historicalBinding]}};
        db.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(historicalInstance),info.deviceId);
    } finally { db.close(); }
    const historicalDevice = await api(`/api/devices/${info.deviceId}`);
    const peerDevice = await api('/api/devices/author_peer');
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'model-animations' })));
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (/\/api\/models\/[^/]+\/motion-actions(?:\/|\?|$)/.test(request.url())) authoringRequests.push(request.method() + ' ' + request.url());
        if (/\/api\/devices\/[^/]+\/animations(?:\?|$)/.test(request.url()) && request.method() === 'PUT') animationWrites.push({url:request.url(),body:request.postDataJSON()});
    });
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const modes = page.getByRole('navigation', { name: '动作动画模式' }), transfer = page.getByRole('group', { name: '动作包导入导出' });
    await modes.waitFor();
    assert.deepEqual(await modes.getByRole('button').allTextContents(), ['实时联动', '部件动作', '设备联动']);
    assert.equal(await page.getByRole('region', { name: '工艺动作编辑器' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '新增工艺动作' }).count(), 0);
    for (const width of [1600, 1024]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const label of ['设备联动', '实时联动', '部件动作']) {
            await modes.getByRole('button', { name: label, exact: true }).click();
            assert.equal(await modes.getByRole('button', { name: label, exact: true }).getAttribute('aria-pressed'), 'true');
            assert.equal(await transfer.getByRole('button').count(), 2);
            assert.equal(await page.locator('.motion-author').count(), 0);
        }
        await page.getByLabel('选择动作动画模型', { exact: true }).selectOption(info.modelId);
        await page.screenshot({ path: path.join(directory, `01-three-modes-${width}.png`), fullPage: true });
    }
    check('custom animation entry/editor removed; all three retained modes and package controls work at wide and narrow widths');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await modes.getByRole('button', { name: '实时联动', exact: true }).click();
    live = page.getByRole('region', { name: '设备实时动画联动' });
    await live.getByRole('button', { name: /备料台 · 动作验收/ }).click();
    await live.locator('.action-list').getByRole('button',{name:/承料台部件抬升/}).waitFor();
    assert.equal(await live.getByRole('button', { name: /既有承料台抬升/ }).count(),0);
    assert.equal(await live.getByRole('button',{name:/采集点位直连/}).count(),0);
    assert.equal(await live.getByLabel('联动采集点位',{exact:true}).count(),0);
    await live.getByText('存在旧自定义动画绑定；保存时会确认停用，历史配置保留。',{exact:true}).waitFor();
    await assertNoLivePreview();
    assert.deepEqual(animationWrites,[]);
    assert.deepEqual(await api(`/api/devices/${info.deviceId}`),historicalDevice);
    check('retired custom clip is not selectable; real-time linkage has no duplicate preview and loading/switching modes never changes its historical binding');
    await live.getByRole('button',{name:'保存并同步',exact:true}).click();
    const confirmation = page.getByRole('dialog').filter({hasText:'自定义模型动画功能已移除'});
    await confirmation.waitFor();
    await page.screenshot({path:path.join(directory,'02-retirement-confirmation.png'),fullPage:true});
    await confirmation.getByRole('button',{name:'取消',exact:true}).click();
    assert.deepEqual(animationWrites,[]);
    assert.deepEqual(await api(`/api/devices/${info.deviceId}`),historicalDevice);
    check('canceling explicit retirement leaves all stored fields and the enabled history unchanged');
    await live.getByRole('button',{name:'保存并同步',exact:true}).click();
    await confirmation.getByRole('button',{name:'确定',exact:true}).click();
    await live.getByText('已保存，Unity 自动同步',{exact:true}).waitFor();
    assert.equal(animationWrites.length,1);
    const disabledDevice = await api(`/api/devices/${info.deviceId}`), disabledInstance = JSON.parse(disabledDevice.instance_config);
    assert.deepEqual(disabledInstance.animationBindings.bindings.find(binding=>binding.actionId===historicalBinding.actionId),{...historicalBinding,enabled:false});
    for (const key of Object.keys(historicalInstance)) if(key!=='animationBindings') assert.deepEqual(disabledInstance[key],historicalInstance[key]);
    for (const key of Object.keys(historicalDevice)) if(key!=='instance_config') assert.deepEqual(disabledDevice[key],historicalDevice[key]);
    const publicHistory = animationWrites[0].body.config.bindings.find(binding=>binding.actionId===historicalBinding.actionId);
    assert.equal(publicHistory.enabled,false);
    for(const field of ['pointId','dataItemId','trigger','inputMin','inputMax','invert','speed','transitionSeconds']) assert.deepEqual(publicHistory[field],historicalBinding[field]);
    await assertNoLivePreview();
    assert.equal(await live.getByRole('button', { name: /既有承料台抬升/ }).count(), 0);
    check('confirmed save explicitly disables the legacy clip while preserving its complete history and all other device fields');
    await live.locator('.action-list').getByRole('button',{name:/承料台部件抬升/}).click();
    await live.getByRole('switch', { name: '启用动作联动' }).check();
    const catalog = await api('/api/data-center/catalog?device_id=' + info.deviceId);
    const dataItem = catalog.items.find(item => item.binding?.pointId === info.pointId); assert.ok(dataItem);
    await live.getByLabel('动作数据用途分类', { exact: true }).selectOption(dataItem.categoryId);
    await live.getByLabel('动作数据表', { exact: true }).selectOption(dataItem.tableId);
    await live.getByLabel('动作驱动数据项', { exact: true }).selectOption(dataItem.id);
    await live.getByRole('button', { name: '保存并同步', exact: true }).click();
    await live.getByText('已保存，Unity 自动同步', { exact: true }).waitFor();
    const partId = 'part:'+part.id;
    const bound = await api(`/api/devices/${info.deviceId}/animations`);
    assert.equal(bound.config.bindings.find(binding => binding.actionId === partId).enabled, true);
    assert.equal(bound.config.bindings.find(binding => binding.actionId === partId).dataItemId, dataItem.id);
    await assertNoLivePreview();
    await live.getByRole('button', { name: '运行状况', exact: true }).click();
    await fetch(info.control, { method: 'POST', body: JSON.stringify({ value: 1 }) });
    await live.locator('.health-list').getByText('运行', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(directory, '03-current-part-live.png'), fullPage: true });
    await fetch(info.control, { method: 'POST', body: JSON.stringify({ offline: true }) });
    await live.locator('.health-list').getByText('数据无效', { exact: true }).waitFor();
    await fetch(info.control, { method: 'POST', body: JSON.stringify({ offline: false, value: 0 }) });
    await live.locator('.health-list').getByText('停止', { exact: true }).waitFor();
    const current = await api(`/api/devices/${info.deviceId}/animations`);
    assert.equal(current.config.bindings.find(binding=>binding.actionId===partId).dataItemId,dataItem.id);
    assert.equal(current.config.bindings.find(binding=>binding.actionId===historicalBinding.actionId).enabled,false);
    assert.equal(animationWrites.length,2);
    check('legal current part action still binds to data-center feedback and handles actual fresh, invalid and recovered read frames without reviving the legacy clip');
    await live.getByRole('button', { name: /备料台 · 独立实例/ }).click();
    await live.getByRole('button', { name: '动作绑定', exact: true }).click();
    await live.locator('.action-list').getByRole('button',{name:/承料台部件抬升/}).click();
    assert.equal(await live.getByRole('switch', { name: '启用动作联动' }).isChecked(), false);
    assert.equal(await live.getByRole('button', { name: /既有承料台抬升/ }).count(),0);
    assert.deepEqual(await api('/api/devices/author_peer'),peerDevice);
    check('same-model peer device remains independently unbound');
    await modes.getByRole('button', { name: '部件动作', exact: true }).click();
    await page.reload(); await modes.waitFor();
    assert.deepEqual(await modes.getByRole('button').allTextContents(), ['实时联动', '部件动作', '设备联动']);
    const preserved = await api(route);
    assert.equal(preserved.revision, preservedBaseline.revision);
    assert.deepEqual(preserved.actions, preservedBaseline.actions);
    assert.deepEqual(preserved.model.motion_package, preservedBaseline.model.motion_package);
    assert.deepEqual(authoringRequests, []);
    assert.deepEqual(errors, []);
    check('reload cannot revive editor; existing model package unchanged; no custom-editor requests or page errors');
    const result = { success: true, realtimePreviewRemoved: true, checks, directory, errors, authoringRequests, animationWrites, runtimeStatusValidated: true, geometryValidated: false, noCollectorOrSiteChanges: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(helper); });
