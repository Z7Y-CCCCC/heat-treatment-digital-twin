'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('model-asset-transfer-browser'), root = path.resolve(__dirname, '..'), checks = [], errors = [];
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'empty-install-ui-server.cjs')], { cwd: root, env: { ...process.env, EMPTY_INSTALL_UI_INFO_FILE: infoFile, FRONTEND_DIST: process.env.UI_FRONTEND_DIST || path.join(root, 'frontend/dist') }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'empty system UI backend');
    const info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'models', modelLibraryStep: 'library' })));
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const transfer = page.getByRole('group', { name: '动作包导入导出' });
    await page.getByRole('heading', { name: '3D 模型库', exact: true }).waitFor();
    assert.equal(await transfer.count(), 0, 'model management must not contain a package banner');
    assert.equal(await page.getByRole('columnheader', { name: '交付状态', exact: true }).count(), 0);
    assert.deepEqual(await (await page.request.get(info.origin + '/api/models',{maxRetries:2})).json(), []);
    assert.equal(await page.locator('.model-table tbody tr[data-model-id]').count(), 0);
    await page.screenshot({ path: path.join(directory, '01-empty-model-library.png'), fullPage: true }); checks.push('empty installation login and model library render without seeded model cards or UI exceptions');
    // Factory creation is separately HTTP-tested; here establish one using the
    // authenticated fixture session, then exercise the real visible import UI.
    const response = await fetch(info.origin + '/api/factories', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie, 'X-CSRF-Token': info.session.csrfToken }, body: JSON.stringify({ name: '资产导入 UI 验收工厂', location: { country: 'CHN' } }) });
    assert.equal(response.status, 201); await page.reload();
    await page.getByTestId('model-library-nav').getByRole('button', { name: '动作动画', exact: true }).click(); await transfer.waitFor();
    assert.equal(await transfer.getByRole('button').count(), 2);
    assert.ok(await transfer.getByRole('button', { name: '导出动作包', exact: true }).isDisabled());
    const choose = async file => { const chooser = page.waitForEvent('filechooser'); await transfer.getByRole('button', { name: '导入动作包', exact: true }).click(); await (await chooser).setFiles(file); };
    await choose({ name: 'invalid.zip', mimeType: 'application/zip', buffer: Buffer.from('not a ZIP') });
    let modal = page.getByRole('dialog', { name: '导入动作包', exact: true });
    await modal.getByRole('alert').waitFor(); assert.equal(await modal.getByRole('button', { name: '确认导入', exact: true }).count(), 0);
    await modal.getByRole('button', { name: '关闭动作包弹窗', exact: true }).click();
    await choose(path.join(root, '导入文件/正式模型资产/cad_fixed_load_table_112200.zip'));
    await modal.getByRole('button', { name: '确认导入', exact: true }).waitFor();
    await page.mouse.move(700, 430); await page.mouse.down(); await page.mouse.move(5, 5); await page.mouse.up();
    assert.ok(await modal.isVisible(), 'dragging outside the dialog must not dismiss an inspected package');
    await page.screenshot({ path: path.join(directory, '02-inspected-model-motion-package.png'), fullPage: true });
    await modal.getByRole('button', { name: '确认导入', exact: true }).click();
    await modal.getByRole('status').getByText('动作包已导入', { exact: true }).waitFor();
    await modal.getByRole('button', { name: '完成', exact: true }).click();
    const models = await (await page.request.get(info.origin + '/api/models',{maxRetries:2})).json(); assert.equal(models.length, 1); assert.ok(models[0].motion_package?.actions.length);
    await page.getByLabel('选择动作动画模型', { exact: true }).selectOption(models[0].id);
    await page.locator('.model-preview-footer').getByText(/^预览：.*尺寸/).waitFor();
    for (const width of [1600, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      const bar = await page.locator('.motion-workspace-toolbar').boundingBox(), buttons = await transfer.boundingBox();
      assert.ok(Math.abs(buttons.x + buttons.width - bar.x - bar.width) < 2, 'package actions must align with the right edge');
      assert.ok(buttons.x >= bar.x && buttons.x + buttons.width <= width, 'buttons must not overflow');
      assert.ok(buttons.height < 45, 'the package banner must be replaced by a compact button group');
      await page.screenshot({ path: path.join(directory, `03-motion-package-actions-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.getByTestId('model-library-nav').getByRole('button', { name: '模型管理', exact: true }).click();
    await page.getByRole('navigation', { name: '模型库操作步骤' }).getByRole('button', { name: /模型资产/ }).click();
    assert.equal(await transfer.count(), 0);
    const row = page.locator(`[data-model-id="${models[0].id}"]`); await row.waitFor(); await row.locator('td').nth(2).click();
    await page.locator('.model-preview-footer').getByText(/^预览：.*尺寸/).waitFor();
    await page.screenshot({ path: path.join(directory, '03-imported-model-with-preview.png'), fullPage: true });
    checks.push('visible ZIP selection, checksum inspection, explicit import, model row and GLB preview work together');
    await page.getByTestId('model-library-nav').getByRole('button', { name: '动作动画', exact: true }).click();
    await transfer.getByRole('button', { name: '导出动作包', exact: true }).click();
    modal = page.getByRole('dialog', { name: '导出动作包', exact: true });
    assert.equal(await modal.locator('.model-choice-tag').count(), 1);
    await modal.getByRole('combobox', { name: '选择导出模型' }).click();
    const option = modal.getByRole('option').first(); await option.hover();
    assert.ok((await option.getAttribute('title')).length > 0);
    await modal.getByRole('combobox', { name: '选择导出模型' }).press('Escape');
    const downloadPromise = page.waitForEvent('download'); await modal.getByRole('button', { name: /^确认导出/ }).click();
    const download = await downloadPromise, downloaded = path.join(directory, 'downloaded-model-asset.zip'); await download.saveAs(downloaded);
    const validated = await require('../backend/services/modelAssetBundle').inspectAsset(downloaded); assert.ok(validated.actions.length);
    await modal.getByRole('status').getByText('动作包已导出', { exact: true }).waitFor();
    await modal.getByRole('button', { name: '完成', exact: true }).click();
    fs.writeFileSync(path.join(directory,'broken.zip'),'invalid ZIP');
    await choose([
      path.join(root, '导入文件/正式模型资产/cad_air_cooling_table_115800ht.zip'),
      path.join(root, '导入文件/正式模型资产/cad_water_cooling_tank_471000.zip'),
      path.join(directory,'broken.zip')
    ]);
    modal = page.getByRole('dialog', { name:'导入动作包',exact:true });
    await modal.locator('li[data-status="ready"]').nth(1).waitFor(); await modal.locator('li[data-status="error"]').waitFor();
    await modal.getByRole('button', {name:'确认导入',exact:true}).click();
    await modal.getByRole('status').getByText('已导入 2 个，失败 1 个',{exact:true}).waitFor();
    assert.equal(await modal.locator('li[data-status="imported"]').count(),2);
    assert.equal(await modal.getByRole('button',{name:'重试未完成项',exact:true}).count(),0);
    await modal.getByRole('button',{name:'完成',exact:true}).click();
    const batchModels = (await (await page.request.get(info.origin + '/api/models',{maxRetries:2})).json()).filter(m=>m.id!==models[0].id);
    assert.equal(batchModels.length,2);
    await transfer.getByRole('button',{name:'导出动作包',exact:true}).click();
    modal = page.getByRole('dialog',{name:'导出动作包',exact:true});
    await modal.locator('.model-choice-tag button').first().press('Enter');
    await modal.getByRole('combobox',{name:'选择导出模型'}).click();
    for(const model of batchModels) {
      const option = modal.locator(`[role="option"][data-model-id="${model.id}"]`);
      const { actionsForModel } = require('../backend/services/deviceAnimations'); const actions = actionsForModel(model);
      assert.match(await option.innerText(), new RegExp(`${actions.length} 个动作`));
      await option.hover(); assert.equal(await modal.getByRole('tooltip').textContent(), actions.map(a=>a.label).join('、'));
      await option.click();
    }
    assert.equal(await modal.locator('.model-choice-tag').count(),2);
    await modal.screenshot({path:path.join(directory,'04-model-options-action-details.png')});
    await modal.getByRole('combobox',{name:'选择导出模型'}).press('Escape');
    await modal.screenshot({path:path.join(directory,'04-multiple-model-tags.png')});
    const downloads=[]; const onDownload=d=>downloads.push(d); page.on('download',onDownload);
    await modal.getByRole('button',{name:/^确认导出/}).click();
    await modal.getByRole('status').getByText('已导出 2 个模型（1 个动作包）',{exact:true}).waitFor();
    await waitUntil(()=>downloads.length===1,10000,'one combined model download');page.off('download',onDownload);
    const combined = path.join(directory,'combined-motions.zip'); await downloads[0].saveAs(combined);
    const combinedInfo = await require('../backend/services/modelAssetCollection').inspectPackage(combined);
    assert.equal(combinedInfo.models.length,2); assert.ok(combinedInfo.models.every(item=>item.actions.length));
    await modal.screenshot({path:path.join(directory,'05-one-archive-exported.png')});
    await modal.getByRole('button',{name:'完成',exact:true}).click();
    const beforeCombined = (await (await page.request.get(info.origin+'/api/models',{maxRetries:2})).json()).length;
    await choose(combined); modal=page.getByRole('dialog',{name:'导入动作包',exact:true});
    await modal.getByRole('button',{name:'确认导入',exact:true}).waitFor();
    assert.equal(await modal.locator('.package-file-list>li').count(),1);
    assert.equal(await modal.locator('.collection-models li').count(),2);
    await modal.screenshot({path:path.join(directory,'06-collection-import-preview.png')});
    await modal.getByRole('button',{name:'确认导入',exact:true}).click();
    await modal.getByRole('status').getByText('已导入 2 个',{exact:true}).waitFor();
    assert.equal((await (await page.request.get(info.origin+'/api/models',{maxRetries:2})).json()).length,beforeCombined+2);
    await modal.getByRole('button',{name:'完成',exact:true}).click();
    checks.push('multiple legacy files tolerate one bad ZIP; model action details retained; multi-model export downloads exactly one directory-structured archive and the same archive imports all models');
    for (const mode of ['实时联动', '工艺动作', '设备联动', '部件动作']) {
      await page.getByRole('navigation', { name: '动作动画模式' }).getByRole('button', { name: mode, exact: true }).click();
      assert.equal(await transfer.getByRole('button').count(), 2); assert.equal(await page.getByText('项目导入文件', { exact: true }).count(), 0);
    }
    checks.push('right-aligned compact actions survive all motion tabs and narrow windows; dialogs reject invalid ZIPs, resist accidental dismissal and export a valid model+motion package');
    assert.deepEqual(errors, []); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, directory }, null, 2)); console.log(JSON.stringify({ success: true, checks, directory }, null, 2));
})().catch(async error => { await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error(error); process.exitCode = 1; })
    .finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
