// Owned isolated backend + actual built designer. Never touches a live user's draft.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('view-hierarchy-ui'), checks = [], errors = [];
let server, browser, page;
const check = text => { checks.push(text); console.log('PASS ' + text); };
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
    await waitUntil(() => {assert.equal(server.exitCode,null);return fs.existsSync(infoFile);},60000,'owned test server');
    const info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
    const context = await browser.newContext({viewport:{width:1600,height:1100}});
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'designer'})));
    page = await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(info.origin+'/admin');
    await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);
    await page.getByLabel('后台密码',{exact:true}).fill(info.password);
    await page.getByRole('button',{name:'解锁后台',exact:true}).click();
    const tree=page.getByRole('tree',{name:'视角层级',exact:true});await tree.waitFor();
    const row=id=>tree.locator(`[data-view-id="${id}"]`);
    assert.equal(await page.getByRole('tablist', { name: '选择大屏视角', exact: true }).count(), 0);
    assert.equal(await page.locator('.designer-brand,.designer-brand-mark,.unified-designer-views').count(), 0);
    const designerHandle = await page.locator('.dashboard-designer-shell').elementHandle();
    for (const id of ['map_country','map_province','map_city','map_district','site_street','site_factory','workshop_overview','line_overview','device_detail','device_xray','device_exploded','device_part','factory_overview','map_world']) {
        const globalRow=page.locator(`[data-global-view-id="${id}"]`);
        if (id.startsWith('map_') || id.startsWith('site_')) await globalRow.locator('.global-view-name').click();
        else await row(id).locator('.view-tree-select').click();
        const selectedRow=(id.startsWith('map_') || id.startsWith('site_'))?globalRow:row(id);
        await waitUntil(async () => /(^| )(active|selected)( |$)/.test(await selectedRow.getAttribute('class')), 5000, `selected view ${id}`);
        await page.waitForTimeout(75);
        assert.ok(/(^| )(active|selected)( |$)/.test(await selectedRow.getAttribute('class')), `tree selection must not bounce away from ${id}`);
        assert.equal(await designerHandle.evaluate(el => el.isConnected), true, 'changing view must keep the same designer and draft');
        const name = await page.getByLabel('视角名称', { exact: true }).inputValue();
        assert.equal(/^(map_|site_)/.test(id) ? name.replace(/^\s*\d{2}\s+/, '') : name, (await selectedRow.locator(id.startsWith('map_') || id.startsWith('site_') ? '.global-view-name>span:last-child' : '.view-tree-select strong').textContent()).trim());
    }
    await page.screenshot({path:path.join(directory,'01-clean-designer-toolbar.png'),fullPage:true});
    check('top duplicate view tabs and D mark are absent; maps, street, building and device views remain selectable in one mounted designer without bouncing to factory overview');
    for (const title of ['数据采集', '模型库']) {
        const toggle = page.locator(`.admin-nav .nav-group-toggle[title="${title}"]`);
        if (!(await toggle.locator('..').getAttribute('class')).split(' ').includes('open')) await toggle.click();
    }
    const navIcon = async title => page.locator(`.admin-nav .nav-subitem[title="${title}"] svg path`).evaluateAll(nodes => nodes.map(n => n.getAttribute('d')));
    const mappingIcon = await navIcon('点位映射'), monitorIcon = await navIcon('点位监视');
    const modelIcon = await navIcon('模型管理'), layoutIcon = await navIcon('拆解布局');
    assert.ok(mappingIcon.length && monitorIcon.length && modelIcon.length && layoutIcon.length);
    assert.notDeepEqual(mappingIcon, monitorIcon); assert.notDeepEqual(modelIcon, layoutIcon);
    assert.equal((await page.locator('.admin-nav .nav-subitem[title="点位监视"] svg').evaluate(el => getComputedStyle(el).strokeWidth)), '1.75px');
    await page.locator('.admin-nav').screenshot({path:path.join(directory,'02-distinct-sidebar-icons.png')});
    check('point monitor and disassembly layout have distinct, semantic outline icons using the existing stroke style');
    async function save() {
        const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/platform/designer/draft'&&r.request().method()==='PUT');
        await page.getByRole('button',{name:'保存草稿',exact:true}).click();
        assert.equal((await response).status(),200);
    }
    assert.equal(await tree.getByRole('treeitem').count(),7);
    assert.equal(await page.locator('[data-global-view-id]').count(),7);
    assert.ok(!(await tree.innerText()).includes('全球地图'));
    assert.ok(!/^\s*0[1-7]\s/m.test(await tree.innerText()));
    assert.equal(await tree.locator('.view-list-icon').count(),0);
    check('seven local views use compact draggable grips; seven global views use switches; legacy numeric prefixes and black mode icons are gone');
    // Real native HTML drag sequence, not a direct invocation of Vue handlers.
    async function drag(source,target,zone='inside') {
        // Settle layout/scroll before pressing: scrolling programmatically while
        // a native drag is in progress can cancel it on Chromium/Windows.
        await tree.scrollIntoViewIfNeeded();
        const dropTarget=target ? row(target) : tree.locator('.view-root-drop');
        const handle=row(source).getByRole('button',{name:/^拖动/});await handle.scrollIntoViewIfNeeded();
        if(target) await dropTarget.scrollIntoViewIfNeeded();
        await handle.hover();
        const box=await handle.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
        await page.mouse.move(box.x+box.width/2+10,box.y+box.height/2,{steps:5});
        if(!target) await dropTarget.scrollIntoViewIfNeeded();const destination=await dropTarget.boundingBox();
        const y=destination.y+destination.height*(zone==='before'?.1:zone==='after'?.9:.5);
        await page.mouse.move(destination.x+destination.width*.65,y,{steps:12});
        await page.mouse.move(destination.x+destination.width*.65,y+1,{steps:2});
        await page.mouse.up();
    }
    await drag('line_overview','factory_overview');
    await waitUntil(async()=>await row('line_overview').getAttribute('aria-level')==='2',5000,'drop changes actual parent');
    assert.equal(await row('device_detail').getAttribute('aria-level'),'3');
    await page.getByTitle('撤销 Ctrl+Z',{exact:true}).click();
    assert.equal(await row('line_overview').getAttribute('aria-level'),'3');
    await page.getByTitle('重做 Ctrl+Y',{exact:true}).click();
    assert.equal(await row('line_overview').getAttribute('aria-level'),'2');
    check('hierarchy dragging participates in existing undo/redo');
    await save();
    const state=await (await page.request.get(info.origin+'/api/platform/designer')).json();
    const saved=state.document.scene.views.find(v=>v.id==='line_overview');
    assert.equal(saved.parentViewId,'factory_overview');assert.equal(saved.returnViewId,'factory_overview');
    check('dragging a grip moves its whole subtree and saves both parent and return relationships through the real API');
    await row('device_xray').click({button:'right'});
    await page.getByRole('menuitem',{name:'隐藏此视角',exact:true}).click();
    await row('device_xray').waitFor({state:'hidden'});
    assert.equal(await row('device_exploded').getAttribute('aria-level'),'4');
    await save();
    await page.reload();await tree.waitFor();
    await row('device_xray').waitFor({state:'hidden'});
    assert.equal(await row('device_exploded').getAttribute('aria-level'),'4');
    assert.equal(await row('line_overview').getAttribute('aria-level'),'2');
    await page.getByText('已隐藏（1）',{exact:true}).click();
    await page.getByRole('button',{name:'恢复设备透视视角',exact:true}).click();
    assert.equal(await row('device_xray').getAttribute('aria-level'),'4');
    assert.equal(await row('device_exploded').getAttribute('aria-level'),'5');
    check('right-click hide skips the row in the hierarchy, persists after reopen, and restores the original child links without deleting views');
    await row('factory_overview').click({button:'right'});await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('menu',{name:'视角菜单'}).count(),0);
    await drag('factory_overview','device_detail');
    assert.equal(await row('factory_overview').getAttribute('aria-level'),'1','cycles must not be accepted');
    check('Escape dismisses the compact context menu and dropping onto a descendant cannot create a cycle');
    const ids=()=>tree.locator('[data-view-id]').evaluateAll(nodes=>nodes.map(n=>n.dataset.viewId));
    await drag('workshop_overview','line_overview','after');
    let order=await ids();assert.ok(order.indexOf('workshop_overview')>order.indexOf('line_overview'));
    await drag('workshop_overview','line_overview','before');
    order=await ids();assert.ok(order.indexOf('workshop_overview')<order.indexOf('line_overview'));
    await drag('workshop_overview','');assert.equal(await row('workshop_overview').getAttribute('aria-level'),'1');
    await drag('workshop_overview','factory_overview');assert.equal(await row('workshop_overview').getAttribute('aria-level'),'2');
    check('real upper/lower drop zones reorder siblings and the root drop zone promotes a view to the top level');
    for (const width of [1600,1366]) {await page.setViewportSize({width,height:1000});await tree.screenshot({path:path.join(directory,`hierarchy-${width}.png`)});}
    const auth=await (await page.request.get(info.origin+'/api/admin-auth/session')).json();
    const created=await page.request.post(info.origin+'/api/admin-auth/users',{headers:{'X-CSRF-Token':auth.csrfToken,'X-Admin-Request':'1',Origin:info.origin},data:{username:'hierarchy_reader',displayName:'层级只读',password:info.password,role:'viewer',permissions:{view:true},pagePermissions:{'platform.designer':{view:true,edit:false}}}});
    assert.equal(created.status(),201);
    const readerContext=await browser.newContext({viewport:{width:1366,height:1000}});
    await readerContext.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'designer'})));
    const reader=await readerContext.newPage();reader.on('pageerror',e=>errors.push(e.message));
    await reader.goto(info.origin+'/admin');await reader.getByRole('textbox',{name:'账号',exact:true}).fill('hierarchy_reader');
    await reader.getByLabel('后台密码',{exact:true}).fill(info.password);await reader.getByRole('button',{name:'解锁后台',exact:true}).click();
    const readonlyTree=reader.getByRole('tree',{name:'视角层级',exact:true});await readonlyTree.waitFor();
    assert.equal(await readonlyTree.locator('.view-drag-handle:not(:disabled)').count(),0);
    assert.equal(await readonlyTree.locator('[draggable="true"]').count(),0);
    await readonlyTree.locator('[data-view-id="factory_overview"]').click({button:'right'});
    assert.ok(await reader.getByRole('menuitem',{name:'隐藏此视角',exact:true}).isDisabled());
    check('read-only page access cannot drag hierarchy handles or hide/restore views');
    await readerContext.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({success:true,directory,checks,browserErrors:errors},null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack||error.message);process.exitCode=1;})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});
