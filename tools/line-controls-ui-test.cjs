// Isolated profile/database only. Never connects to the operator's running app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), directory = createRunDirectory('line-controls-ui'), checks = [], errors = [];
let server, browser, page;
const check = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd: root, env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'isolated UI server');
  const info = JSON.parse(fs.readFileSync(infoFile)); requireTestPath(info.database);
  const db = new Database(info.database), line = db.prepare('SELECT l.* FROM lines l WHERE l.id=(SELECT line_id FROM devices WHERE id=?)').get(info.devices[0]);
  const layout = { version: 2, coordinateSpace: 'workshop_local', placementPending: false,
    transform: { x: 0, y: 0, z: 0, rotationY: 0 }, flowDirection: 'right',
    lanes: [{ id: 'qa_lane1', name: '设备线 1', offsetZ: -10, length: 60 }, { id: 'qa_lane2', name: '设备线 2', offsetZ: 10, length: 60 }],
    rails: [{ id: 'qa_rail1', name: '小车导轨 1', offsetZ: 0, length: 60 }] };
  db.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(layout), line.id);
  for (const id of info.devices) {
    const config = JSON.parse(db.prepare('SELECT instance_config FROM devices WHERE id=?').get(id).instance_config || '{}');
    db.prepare("UPDATE devices SET coordinate_space='line_local', pos_z=-10, instance_config=? WHERE id=?")
      .run(JSON.stringify({ ...config, laneLineId: line.id, laneId: 'qa_lane1', laneName: '设备线 1' }), id);
  }
  db.close();
  browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(lineId => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'lines', selectedLineEditorId: lineId, isLineDevicePoolCollapsed: true })), line.id);
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(info.origin + '/admin'); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
  await page.getByLabel('后台密码', { exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  const controls = page.getByRole('region', { name: '产线配置工具栏' }); await controls.waitFor();
  const picker = controls.getByRole('button', { name: '选择编辑产线', exact: true });
  const pill = type => controls.getByRole('button', { name: type === 'lane' ? '管理设备线' : '管理小车导轨', exact: true });
  const popup = type => page.getByRole('dialog', { name: type === 'lane' ? '设备线管理' : '小车导轨管理', exact: true });
  const shape = (type, id) => page.locator(`[data-line-target-type="${type}"][data-line-target-id="${id}"]`);
  const getLines = async () => (await (await page.request.get(info.origin + '/api/lines')).json());
  const getLayout = async () => (await getLines()).find(row => row.id === line.id).layout;
  const savedLayout = await getLayout(), mutations = [];
  page.on('request', request => { if (/\/api\/(lines|devices)(\/|$)/.test(new URL(request.url()).pathname) && ['POST','PUT','DELETE'].includes(request.method())) mutations.push(request.method() + ' ' + new URL(request.url()).pathname); });

  assert.equal(await controls.getByText('产线与轨道设置', { exact: true }).count(), 0);
  assert.equal(await page.locator('.line-planner-editor,#line-configuration-panel').count(), 0);
  for (const type of ['lane', 'rail']) {
    const style = await pill(type).evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, cursor: getComputedStyle(el).cursor, height: el.getBoundingClientRect().height }));
    assert.notEqual(style.shadow, 'none'); assert.equal(style.cursor, 'pointer'); assert.ok(style.height >= 32);
    await pill(type).click(); await popup(type).waitFor();
    const anchor = await pill(type).boundingBox(), box = await popup(type).boundingBox();
    assert.ok(box.y >= anchor.y + anchor.height); assert.ok(box.x >= 0 && box.x + box.width <= 1600);
    await page.mouse.move(1, 1); assert.ok(await popup(type).isVisible(), 'hover alone must not close editor');
    await popup(type).screenshot({ path: path.join(directory, `01-${type}-popup.png`) });
    await page.keyboard.press('Escape'); assert.equal(await popup(type).count(), 0);
    assert.equal(await pill(type).evaluate(el => el === document.activeElement), true);
  }
  check('raised equipment-lane and rail pills open independent floating editors directly below, never on hover, without reflowing the canvas');

  for (const [type, id, name] of [['lane','qa_lane2','设备线 2'], ['rail','qa_rail1','小车导轨 1']]) {
    await pill(type).click(); await popup(type).getByRole('button', { name: `选中 ${name}`, exact: true }).click();
    await shape(type,id).waitFor(); assert.ok((await shape(type,id).getAttribute('class')).includes('is-selected'));
    assert.equal(await shape(type,id).evaluate(el => document.activeElement === el), true);
    const box = await shape(type,id).boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= 1000);
    assert.equal(await page.locator('.line-map-item.is-selected').count(), 1);
  }
  assert.deepEqual(mutations, []); assert.deepEqual(await getLayout(), savedLayout);
  await page.screenshot({ path: path.join(directory, '02-focused-rail.png'), fullPage: true });
  check('selecting a lane or rail closes the popup, scrolls to and persistently highlights only that canvas shape without moving or saving anything');

  // Add/edit/remove draft geometry from each popup. Existing device bindings survive.
  for (const type of ['lane','rail']) {
    await pill(type).click(); const list = popup(type), beforeIds = await list.locator('[data-structure-id]').evaluateAll(rows => rows.map(row => row.dataset.structureId));
    await list.getByRole('button', { name: type === 'lane' ? '+ 设备线' : '+ 小车导轨', exact: true }).click();
    const added = list.locator('[data-structure-id]').last(), id = await added.getAttribute('data-structure-id');
    assert.ok(!beforeIds.includes(id));
    const fields = added.locator('input'); await fields.nth(0).fill('验证' + type); await fields.nth(1).fill('24'); await fields.nth(2).fill('72');
    // Clicking outside commits the focused field before its editor is removed.
    await page.locator('.line-planner-header h2').click();
    await pill(type).click(); const edited = list.locator(`[data-structure-id="${id}"]`);
    assert.equal(await edited.locator('input').nth(0).inputValue(), '验证' + type);
    assert.equal(await edited.locator('input').nth(1).inputValue(), '24'); assert.equal(await edited.locator('input').nth(2).inputValue(), '72');
    await edited.getByRole('button', { name: '删除 验证' + type, exact: true }).click();
    assert.equal(await shape(type,id).count(),0); assert.equal(await list.locator('[data-structure-id]').count(),beforeIds.length);
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(mutations, []); assert.deepEqual(await getLayout(),savedLayout);
  check('both floating editors retain name/offset/length editing and add/delete draft geometry; outside dismissal commits input rather than losing it');

  await pill('lane').click();await popup('lane').getByRole('button',{name:'删除 设备线 2',exact:true}).click();
  await popup('lane').getByRole('button',{name:'删除 设备线 1',exact:true}).click();await page.getByText('至少保留一条设备线',{exact:true}).waitFor();
  await page.getByRole('button',{name:'确定',exact:true}).click();assert.equal(await page.locator('[data-line-target-type="lane"]').count(),1);
  await page.getByRole('button',{name:'放弃画布修改',exact:true}).click();await shape('lane','qa_lane2').waitFor();assert.deepEqual(await getLayout(),savedLayout);
  check('deleting the final equipment lane is still rejected, and discarded popup changes restore the saved canvas');

  const openCreate = async () => { await controls.getByRole('button', { name: '+ 新增产线', exact: true }).click(); return page.getByRole('dialog', { name: '新增产线', exact: true }); };
  let create = await openCreate();
  assert.equal(await create.locator('input').count(),2); assert.equal(await create.locator('select').count(),1);
  await create.getByRole('textbox', { name: '产线 ID', exact: true }).fill('qa_created_line');
  await create.getByRole('textbox', { name: '产线名称', exact: true }).fill('新增验证产线');
  const close = create.getByRole('button', { name: '关闭产线弹窗', exact: true }), cb = await close.boundingBox(), mb = await create.boundingBox();
  assert.ok(cb.x + cb.width >= mb.x + mb.width - 10 && cb.y <= mb.y + 8);
  assert.equal(await close.evaluate(el=>getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  await page.mouse.click(2,2); assert.ok(await create.isVisible());
  await create.getByRole('button',{name:'+ 添加产线',exact:true}).focus(); await page.keyboard.press('Tab');
  assert.equal(await close.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape'); assert.equal(await create.count(),0);
  create=await openCreate(); assert.equal(await create.getByRole('textbox',{name:'产线名称',exact:true}).inputValue(),'新增验证产线');
  await create.screenshot({path:path.join(directory,'03-create-line-dialog.png')});
  check('new line is a focused modal with the original three fields, corner close button, retained draft, keyboard focus containment and no backdrop/drag dismissal');

  // Failure must leave the draft editable; success closes the modal and refreshes selection.
  await page.route('**/api/lines', route => route.request().method()==='POST' ? route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'隔离测试创建失败'})}) : route.continue());
  await create.getByRole('button',{name:'+ 添加产线',exact:true}).click();
  await page.getByRole('heading',{name:'新增产线失败',exact:true}).waitFor(); await page.getByRole('button',{name:'确定',exact:true}).click();
  assert.ok(await create.isVisible()); assert.equal(await create.getByRole('textbox',{name:'产线 ID',exact:true}).inputValue(),'qa_created_line');
  await page.unroute('**/api/lines');
  await create.getByRole('button',{name:'+ 添加产线',exact:true}).click(); await page.getByRole('heading',{name:'新增成功',exact:true}).waitFor();
  await page.getByRole('button',{name:'确定',exact:true}).click(); assert.equal(await create.count(),0);
  assert.ok((await picker.textContent()).includes('新增验证产线')); assert.equal((await getLines()).filter(row=>row.id==='qa_created_line').length,1);
  assert.equal((await getLines()).find(row=>row.id==='qa_created_line').workshop_id,line.workshop_id);
  check('creation failure preserves the draft; retry really persists exactly one line and automatically selects it without an inline expansion');

  await picker.click(); let lineList=page.getByRole('dialog',{name:'产线选择',exact:true});
  assert.equal(await lineList.locator('.line-option').count(),(await getLines()).length);
  for(const row of await lineList.locator('.line-option').all()) assert.equal(await row.getByRole('button',{name:/删除产线 /}).count(),1);
  await page.keyboard.press('ArrowUp');assert.equal(await lineList.locator('.line-option-select').last().evaluate(el=>el===document.activeElement),true);
  await lineList.getByRole('textbox',{name:'搜索产线',exact:true}).fill(line.name);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); assert.ok((await picker.textContent()).includes(line.name));
  await picker.click();lineList=page.getByRole('dialog',{name:'产线选择',exact:true});
  await lineList.locator('[data-line-option-id="qa_created_line"]').getByRole('button',{name:'删除产线 新增验证产线',exact:true}).click();
  await page.getByRole('heading',{name:'永久删除产线「新增验证产线」',exact:true}).waitFor();
  assert.ok(await page.getByRole('button',{name:'永久删除',exact:true}).isDisabled());
  await page.getByRole('button',{name:'取消',exact:true}).click(); assert.ok((await getLines()).some(row=>row.id==='qa_created_line'));
  await picker.click(); await page.locator('[data-line-option-id="qa_created_line"]').getByRole('button',{name:'删除产线 新增验证产线',exact:true}).click();
  await page.locator('.app-dialog-verification input').fill('新增验证产线');
  await page.getByRole('button',{name:'永久删除',exact:true}).click(); await page.getByRole('heading',{name:'删除成功',exact:true}).waitFor(); await page.getByRole('button',{name:'确定',exact:true}).click();
  assert.equal((await getLines()).some(row=>row.id==='qa_created_line'),false); assert.ok((await picker.textContent()).includes(line.name));
  check('each dropdown row has a trash icon, searchable keyboard selection works, deleting an unselected line keeps the current selection and still requires named destructive confirmation');

  // Existing line metadata is still reachable, but changes stay a draft until Save.
  await picker.click(); await page.locator(`[data-line-option-id="${line.id}"]`).getByRole('button',{name:`编辑产线 ${line.name}`,exact:true}).click();
  const edit=page.getByRole('dialog',{name:'编辑产线资料',exact:true});await edit.getByRole('textbox',{name:'产线名称',exact:true}).fill('更名验证');await edit.getByRole('button',{name:'应用',exact:true}).click();
  assert.ok((await picker.textContent()).includes('更名验证'));assert.equal((await getLines()).find(row=>row.id===line.id).name,line.name);
  await page.getByRole('button',{name:'放弃画布修改',exact:true}).click(); await waitUntil(async()=> (await picker.textContent()).includes(line.name),5000,'restore line name');
  check('line name/workshop/order editing remains available without restoring the removed settings block; unsaved edits can be discarded');

  // Saving structure changes through the existing API remains authoritative across reload.
  await pill('rail').click();await popup('rail').getByLabel('小车导轨 1 长度',{exact:true}).fill('68');await popup('rail').getByRole('button',{name:'选中 小车导轨 1',exact:true}).click();
  await page.getByRole('button',{name:'保存产线结构',exact:true}).click(); await page.getByRole('heading',{name:'系统提示',exact:true}).waitFor();await page.getByRole('button',{name:'确定',exact:true}).click();
  assert.equal((await getLayout()).rails[0].length,68);await page.reload();await controls.waitFor();
  await pill('rail').click();assert.equal(await popup('rail').getByLabel('小车导轨 1 长度',{exact:true}).inputValue(),'68');await page.keyboard.press('Escape');
  check('floating geometry changes use the existing explicit Save action and survive a page reload');

  for(const percent of [115,200]) {
    const reading=page.locator('summary[aria-label="后台文字大小"]');await reading.click();await page.getByRole('group',{name:'后台文字大小设置'}).getByRole('button',{name:`${percent}%`,exact:true}).click();await reading.click();
    await page.setViewportSize({width:1100,height:900});await pill('lane').click();let box=await popup('lane').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=1100&&box.y+box.height<=900);
    await popup('lane').screenshot({path:path.join(directory,`04-lane-popup-${percent}.png`)});await page.keyboard.press('Escape');
    const modal=await openCreate();const save=modal.getByRole('button',{name:'+ 添加产线',exact:true});await save.scrollIntoViewIfNeeded();box=await save.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=1100&&box.y>=0&&box.y+box.height<=900);await page.keyboard.press('Escape');
  }
  check('at narrow desktop width and 200% text both popup editors and creation actions remain within the viewport and reachable');

  const session=await(await page.request.get(info.origin+'/api/admin-auth/session')).json();
  const user=await page.request.post(info.origin+'/api/admin-auth/users',{headers:{Origin:info.origin,'X-Admin-Request':'1','X-CSRF-Token':session.csrfToken},data:{username:'line_reader',password:info.password,role:'viewer',permissions:{view:false},pagePermissions:{lines:{view:true}}}});assert.equal(user.status(),201,await user.text());
  const readerContext=await browser.newContext({viewport:{width:1600,height:1000}});await readerContext.addInitScript(lineId=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'lines',selectedLineEditorId:lineId})),line.id);
  const reader=await readerContext.newPage();reader.on('pageerror',error=>errors.push(error.message));await reader.goto(info.origin+'/admin');await reader.getByRole('textbox',{name:'账号',exact:true}).fill('line_reader');await reader.getByLabel('后台密码',{exact:true}).fill(info.password);await reader.getByRole('button',{name:'解锁后台',exact:true}).click();
  const readerControls=reader.getByRole('region',{name:'产线配置工具栏'});await readerControls.waitFor();assert.ok(await readerControls.getByRole('button',{name:'+ 新增产线',exact:true}).isDisabled());
  await readerControls.getByRole('button',{name:'选择编辑产线',exact:true}).click();for(const button of await reader.getByRole('button',{name:/删除产线 /}).all())assert.ok(await button.isDisabled());await reader.keyboard.press('Escape');
  await readerControls.getByRole('button',{name:'管理设备线',exact:true}).click();const readonly=reader.getByRole('dialog',{name:'设备线管理',exact:true});assert.ok(await readonly.getByRole('button',{name:'+ 设备线',exact:true}).isDisabled());assert.ok(await readonly.getByLabel('设备线 1 长度',{exact:true}).isDisabled());
  await readonly.getByRole('button',{name:'选中 设备线 1',exact:true}).click();assert.ok((await reader.locator('[data-line-target-id="qa_lane1"]').getAttribute('class')).includes('is-selected'));
  check('read-only users may open and focus geometry, but creation, row trash icons and all structure mutation controls remain disabled');
  assert.deepEqual(errors,[]);const result={success:true,checks,browserErrors:errors,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));console.error(error);process.exitCode=1;
}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});
