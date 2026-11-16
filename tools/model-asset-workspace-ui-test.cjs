'use strict';
// Real browser + newly-created loopback database/uploads/profile only.
// Run with UI_FRONTEND_DIST pointing at a fresh, isolated frontend test build.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const Database = require('../backend/node_modules/better-sqlite3');
const { requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), directory = requireTestPath(path.join(root, 'output/playwright', 'model-assets-' + Date.now()));
fs.mkdirSync(directory, { recursive: true });
let server, browser, page, db;
const checks = [], errors = [], consoleErrors = [], mutations = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const metadata = model => typeof model.metadata === 'string' ? JSON.parse(model.metadata) : model.metadata;
(async () => {
    const frontend = process.env.UI_FRONTEND_DIST;
    if (!frontend || !fs.existsSync(path.join(frontend, 'index.html'))) throw Error('UI_FRONTEND_DIST must name a completed isolated frontend build');
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'model-asset-workspace-ui-server.cjs')], { cwd: root, env: { ...process.env, UI_FRONTEND_DIST: frontend, MODEL_ASSET_WORKSPACE_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned model-asset workspace backend');
    const info = JSON.parse(fs.readFileSync(infoFile)); requireTestPath(info.database); db = new Database(info.database);
    browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => { if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'models' })); });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/') && ['POST','PUT','DELETE'].includes(request.method())) mutations.push({ method: request.method(), path: url.pathname }); });
    await page.route('**/*', route => { const url = new URL(route.request().url()); return /^https?:$/.test(url.protocol) && url.origin !== info.origin ? route.abort() : route.continue(); });
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByRole('textbox', { name: '后台密码', exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const management = page.getByTestId('model-management-page'), layoutPage = page.getByTestId('manual-disassembly-page'), actions = page.getByTestId('model-animation-page');
    const transfer = page.getByTestId('model-asset-transfer'), dialog = page.getByTestId('model-asset-transfer-dialog');
    await management.waitFor();
    const nav = page.getByTestId('model-library-nav');
    for (const label of ['模型管理','拆解布局','动作动画']) assert.equal(await nav.getByRole('button', { name: label, exact: true }).count(), 1);
    assert.equal(await page.getByTestId('model-asset-workspace').count(), 0, 'three original pages must not be merged');
    const tools = ['导入模型资产', '导出模型资产', '补充更新模型资产', '模型资产版本'];
    assert.equal(await transfer.getByRole('button').count(), 4);
    for (const label of tools) { const button = transfer.getByRole('button', { name: label, exact: true }); assert.equal((await button.innerText()).trim(), ''); assert.equal(await button.locator('svg').count(), 1); assert.equal(await button.getAttribute('title'), label); }
    assert.equal(await transfer.getByRole('button', { name: '补充更新模型资产', exact: true }).isDisabled(), true);
    assert.equal((await (await page.request.get(info.origin + '/api/models')).json()).length, 0);
    await page.screenshot({ path: path.join(directory, '01-empty-workspace.png'), fullPage: true });
    pass('three original model pages remain separate; only model management has the four accessible icon-only asset tools');
    const destinations = { '模型管理': management, '拆解布局': layoutPage, '动作动画': actions };
    const openPage = async label => { await nav.getByRole('button', { name: label, exact: true }).click(); await destinations[label].waitFor(); };
    const selectedRow = id => management.locator(`tr[data-model-id="${id}"][aria-selected="true"]`);
    const choose = async (label, filename) => { await openPage('模型管理'); const chooser = page.waitForEvent('filechooser'); await transfer.getByRole('button', { name: label, exact: true }).click(); await (await chooser).setFiles(filename); };
    const ready = async label => waitUntil(async () => { assert.equal(server.exitCode, null); const button = dialog.getByRole('button', { name: label, exact: true }); return await button.count() === 1 && await button.isEnabled(); }, 60000, 'inspected asset ready for explicit confirmation');
    const close = async () => { await dialog.press('Escape'); await dialog.waitFor({ state: 'hidden' }); };
    const getModels = async () => await (await page.request.get(info.origin + '/api/models')).json();
    const getModel = async id => (await getModels()).find(model => model.id === id);
    const apply = async (label, pathName = '/api/models/asset-import') => { const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === pathName); await dialog.getByRole('button', { name: label, exact: true }).click(); const result = await response; assert.ok(result.ok(), await result.text()); const body = await result.json(); await close(); return body; };
    await choose('导入模型资产', info.fixtures.complete); await dialog.waitFor(); await ready('确认导入模型资产');
    await dialog.screenshot({ path: path.join(directory, '02-complete-import-preview.png') });
    const imported = await apply('确认导入模型资产'), id = imported.model?.id || imported.models?.[0]?.id; assert.ok(id);
    await selectedRow(id).waitFor();
    const first = await getModel(id); assert.equal((await getModels()).length, 1); assert.equal(metadata(first).disassemblyLayout.configured, true); assert.equal(first.motion_package.actions[0].id, 'door');
    await openPage('拆解布局');
    await layoutPage.getByRole('combobox', { name: '选择拆解布局模型', exact: true }).selectOption(id);
    assert.equal(await transfer.count(), 0, 'layout page does not repeat asset tools');
    const layout = page.getByTestId('manual-disassembly-layout'); await layout.locator('canvas').waitFor({ timeout: 60000 });
    assert.equal(await layout.getAttribute('data-model-id'), id);
    await openPage('动作动画');
    await actions.getByRole('combobox', { name: '选择动作动画模型', exact: true }).selectOption(id);
    assert.equal(await transfer.count(), 0, 'action page does not repeat asset tools');
    await actions.getByRole('textbox', { name: '搜索动作节点', exact: true }).fill('开门'); assert.ok(await actions.locator('.action-card').count() > 0);
    assert.equal(await actions.getByRole('combobox', { name: '选择动作动画模型', exact: true }).inputValue(), id);
    await page.screenshot({ path: path.join(directory, '03-complete-model-actions.png'), fullPage: true });
    pass('one complete ZIP populates all three independent model pages, retaining their original selectors and real Three.js layout');
    // Independent, non-running site records make unintended binding changes detectable.
    const factoryId = first.factory_id;
    db.prepare('INSERT INTO workshops(id,factory_id,name,layout_json) VALUES(?,?,?,?)').run('workspace_site_workshop', factoryId, '保留车间', '{"preserve":true}');
    db.prepare('INSERT INTO lines(id,workshop_id,name,layout_json) VALUES(?,?,?,?)').run('workspace_site_line', 'workspace_site_workshop', '保留产线', '{"preserve":true}');
    db.prepare('INSERT INTO devices(id,name,line_id,model_type,instance_config,plc_enabled) VALUES(?,?,?,?,?,0)').run('workspace_site_device', '保留设备实例', 'workspace_site_line', id, JSON.stringify({ marker: 'preserve', inspection: { enabled: true, parts: [] }, deviceAnimations: { untouched: true } }));
    db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,access_type) VALUES(?,?,?,?,?,?,?,?)').run('workspace_site_device','fixture_feedback','仅测试点位','FIXTURE_ONLY','BOOL','status','door_feedback','READ');
    // Idempotency receipts are asset-transfer bookkeeping, not scene settings.
    const site = () => Object.fromEntries(['factories','workshops','lines','devices','data_points','factory_settings'].map(table => [table,
        db.prepare(`SELECT * FROM ${table}${table === 'factory_settings' ? " WHERE `key` != 'model_asset_import_receipts_v1'" : ''} ORDER BY 1`).all()]));
    const siteBefore = site(), firstMeta = metadata(first);
    async function supplement(file, modules) {
        await choose('补充更新模型资产', file); await dialog.waitFor();
        const choices = [['actions','动作'],['inspection','拆解布局'],['model','模型文件']];
        // Select the next scope before removing the default scope: never submit an intermediate empty update.
        for (const [module, label] of choices.sort((a,b) => Number(modules.includes(b[0])) - Number(modules.includes(a[0])))) {
            const box = dialog.getByRole('checkbox', { name: label, exact: true });
            if (modules.includes(module)) await box.check(); else await box.uncheck();
        }
        await ready('确认补充更新');
    }
    await supplement(info.fixtures.fan, ['actions']);
    await dialog.screenshot({ path: path.join(directory, '04-supplement-fan-preview.png') });
    const fanResult = await apply('确认补充更新'); assert.equal(fanResult.model.id, id);
    const afterFan = await getModel(id), fanMeta = metadata(afterFan);
    assert.deepEqual(fanMeta.partBindings.map(binding => binding.id).sort(), ['door','fan']); assert.deepEqual(afterFan.motion_package.actions.map(action => action.id).sort(), ['door','fan']);
    assert.deepEqual(fanMeta.inspection, firstMeta.inspection); assert.deepEqual(fanMeta.loadingPorts, firstMeta.loadingPorts); assert.equal(afterFan.file_path, first.file_path); assert.deepEqual(site(), siteBefore);
    assert.equal((await getModels()).length, 1);
    await openPage('动作动画');
    await actions.getByRole('combobox', { name: '选择动作动画模型', exact: true }).selectOption(id);
    await actions.getByRole('textbox', { name: '搜索动作节点', exact: true }).fill('风机'); assert.ok(await actions.locator('.action-card').count() > 0);
    pass('supplementing one fan action appends both binding and compiled action by ID, preserving the door, model, layout, ports and every site record');
    await choose('补充更新模型资产', info.fixtures.replaceDoor); await dialog.waitFor();
    await dialog.getByRole('checkbox', { name: '动作', exact: true }).check();
    await dialog.getByRole('checkbox', { name: '拆解布局', exact: true }).uncheck();
    await dialog.getByRole('checkbox', { name: '模型文件', exact: true }).uncheck();
    const replacement = dialog.locator('[data-replace-action-id="door"]'); await replacement.waitFor();
    assert.equal(await dialog.getByRole('button', { name: '确认补充更新', exact: true }).isDisabled(), true, 'same action ID must not be replaced silently');
    await replacement.check(); await ready('确认补充更新');
    await dialog.screenshot({ path: path.join(directory, '04b-explicit-door-replacement.png') });
    await apply('确认补充更新'); const afterDoor = await getModel(id);
    assert.equal(metadata(afterDoor).partBindings.find(binding => binding.id === 'door').output_max, 1.8); assert.equal(metadata(afterDoor).partBindings.find(binding => binding.id === 'fan').output_max, 1);
    assert.deepEqual(metadata(afterDoor).inspection, fanMeta.inspection); assert.deepEqual(site(), siteBefore);
    await transfer.getByRole('button', { name: '模型资产版本', exact: true }).click(); await dialog.waitFor();
    await waitUntil(async () => await dialog.locator('[data-version-id]').count() >= 2, 15000, 'pre-replacement version available');
    const beforeReplacement = dialog.locator('[data-version-id]').first(), beforeReplacementId = await beforeReplacement.getAttribute('data-version-id');
    await beforeReplacement.getByRole('button', { name: /回退|恢复/ }).click(); await ready('确认回退版本');
    await apply('确认回退版本', `/api/models/${id}/asset-history/${beforeReplacementId}/restore`);
    const beforeLayout = await getModel(id);
    assert.deepEqual(metadata(beforeLayout).partBindings, fanMeta.partBindings);
    assert.equal(beforeLayout.motion_package.clipSha256, afterFan.motion_package.clipSha256, 'restored clips retain the exact original action bytes');
    assert.deepEqual(site(), siteBefore);
    pass('replacing an existing action requires an explicit conflict checkbox, touches only that action, and can be reverted independently');
    await supplement(info.fixtures.layout, ['inspection']); await apply('确认补充更新');
    const afterLayout = await getModel(id), afterLayoutMeta = metadata(afterLayout);
    assert.equal(afterLayoutMeta.inspection.parts.find(part => part.id === 'door-part').explode_offset[0], -2.4);
    assert.deepEqual(afterLayoutMeta.partBindings, fanMeta.partBindings); assert.deepEqual(afterLayout.motion_package, beforeLayout.motion_package); assert.deepEqual(afterLayoutMeta.loadingPorts, fanMeta.loadingPorts); assert.equal(afterLayout.file_path, first.file_path); assert.deepEqual(site(), siteBefore);
    await openPage('拆解布局'); await layout.locator('canvas').waitFor({ timeout: 60000 });
    await layout.getByRole('option').filter({ hasText: '门板' }).click();
    assert.equal(Number(await layout.getByRole('spinbutton', { name: 'X轴拆解位移', exact: true }).inputValue()), -2.4);
    await page.screenshot({ path: path.join(directory, '05-updated-layout.png'), fullPage: true });
    pass('a layout-only patch changes the selected model layout without replacing model geometry, actions, ports or device overrides');
    await openPage('模型管理');
    await transfer.getByRole('button', { name: '模型资产版本', exact: true }).click(); await dialog.waitFor();
    await waitUntil(async () => await dialog.locator('[data-version-id]').count() >= 2, 15000, 'recorded pre-update asset versions');
    const historyResponse = await page.request.get(info.origin + `/api/models/${id}/asset-history`); assert.equal(historyResponse.status(), 200);
    const historyData = await historyResponse.json(), versions = historyData.versions || historyData.history || [];
    assert.ok(versions.length >= 2);
    await dialog.screenshot({ path: path.join(directory, '06-version-history.png') });
    const latest = dialog.locator('[data-version-id]').first(), versionId = await latest.getAttribute('data-version-id');
    await latest.getByRole('button', { name: /回退|恢复/ }).click(); await ready('确认回退版本');
    await apply('确认回退版本', `/api/models/${id}/asset-history/${versionId}/restore`);
    const restored = await getModel(id);
    assert.deepEqual(metadata(restored).inspection, fanMeta.inspection); assert.deepEqual(metadata(restored).partBindings, fanMeta.partBindings); assert.deepEqual(site(), siteBefore);
    pass('explicit asset-version restore recovers the layout while retaining previously-added actions and all instance/PLC records');
    await transfer.getByRole('button', { name: '导出模型资产', exact: true }).click(); await dialog.waitFor(); await ready('确认导出模型资产');
    const downloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: '确认导出模型资产', exact: true }).click();
    const assetPath = path.join(directory, 'roundtrip.zip'); await (await downloaded).saveAs(assetPath); await close();
    const exported = await require('../backend/services/modelAssetBundle').readAsset(assetPath);
    assert.deepEqual(exported.actions.map(action => action.id).sort(), ['door','fan']); assert.equal(exported.manifest.model.metadata.disassemblyLayout.configured, true);
    pass('complete export carries the currently-saved model, layout and appended actions in one portable archive');
    for (const viewport of [{ width: 1600, height: 1000 }, { width: 1024, height: 820 }, { width: 720, height: 900 }]) {
        await page.setViewportSize(viewport);
        for (const label of ['模型管理','拆解布局','动作动画']) {
            await openPage(label);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), true, label + ' page fits viewport');
            assert.equal(await destinations[label].evaluate(element => element.scrollWidth <= element.clientWidth + 2), true, label + ' content has no horizontal clipping');
            if (label === '模型管理') assert.equal(await transfer.count(), 1);
            else assert.equal(await transfer.count(), 0);
            await page.screenshot({ path: path.join(directory, `07-${label}-${viewport.width}.png`), fullPage: true });
        }
    }
    pass('all three independent pages render without page/content horizontal overflow at desktop, narrow and mobile widths');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await choose('导入模型资产', info.fixtures.raw);
    const pending = page.getByRole('region', { name: '待导入模型', exact: true }); await pending.waitFor();
    await pending.getByRole('textbox', { name: '模型名称', exact: true }).fill('仅模型文件 · 待补配置');
    const rawResponse = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/models/upload');
    await pending.getByRole('button', { name: '确认导入模型文件', exact: true }).click(); const rawSaved = await rawResponse; assert.equal(rawSaved.status(), 200); assert.equal((await rawSaved.json()).success, true);
    const rawModel = (await getModels()).find(model => model.name === '仅模型文件 · 待补配置'); assert.ok(rawModel); assert.ok(!rawModel.motion_package); assert.equal(metadata(rawModel).partBindings.length, 0); assert.ok(!metadata(rawModel).disassemblyLayout?.configured);
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await selectedRow(rawModel.id).waitFor();
    assert.deepEqual(site(), siteBefore); await page.screenshot({ path: path.join(directory, '08-raw-model-awaiting-config.png'), fullPage: true });
    pass('the same import icon accepts a standalone GLB without inventing decomposition layouts or actions');
    // Existing saved route names still open their independent pages, without data migration.
    for (const [activeTab, expected, selector] of [['disassembly-layout','拆解布局','选择拆解布局模型'],['model-animations','动作动画','选择动作动画模型']]) {
        await page.evaluate(state => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify(state)), { activeTab, selectedPreviewModelId: id, manualDisassemblyModelId: id });
        await page.reload(); await destinations[expected].waitFor();
        await waitUntil(async () => await destinations[expected].getByRole('combobox', { name: selector, exact: true }).inputValue() === id, 15000, 'saved page restores its original model selection');
        assert.equal(await destinations[expected].getByRole('combobox', { name: selector, exact: true }).inputValue(), id);
        assert.equal(await transfer.count(), 0);
        assert.equal(await page.locator('.model-inspection-editor').count(), 0);
    }
    assert.deepEqual(site(), siteBefore); assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    pass('saved original page routes reopen the correct independent page without migrating or rewriting any commissioned configuration');
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, consoleErrors, mutations, database: info.database, directory, noPhysicalPLC: true, noUnity: true }, null, 2));
    console.log(JSON.stringify({ success: true, checks: checks.length, directory }));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, errors, consoleErrors, mutations, directory }, null, 2)); console.error(error.stack); process.exitCode = 1;
}).finally(async () => { db?.close(); await browser?.close(); await stopOwnedSmokeProcess(server); });
