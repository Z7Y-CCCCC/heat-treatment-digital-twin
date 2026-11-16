const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const Database = require('../backend/node_modules/better-sqlite3');
const { startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), directory = path.join(root, 'output/workshop-arrangement/ui-' + Date.now());
fs.mkdirSync(directory, { recursive: true });
let server, browser, db, page;
const errors = [], checks = [], pass = text => { checks.push(text); console.log('PASS ' + text); };
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'docking-calibration-ui-server.cjs')], {
    cwd: root, env: { ...process.env, DOCKING_UI_INFO_FILE: infoFile, UI_FRONTEND_DIST: process.env.UI_FRONTEND_DIST || path.join(root, 'output/workshop-arrangement/frontend') }, logFile: path.join(directory, 'server.log')
  });
  await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned arrangement fixture');
  const info = JSON.parse(fs.readFileSync(infoFile)); db = new Database(info.database);
  // This editor fixture uses a real single-direction CAD cart, not a Z-facing
  // placeholder port on an X-axis push/pull mechanism. Calibrate its actual bed.
  const {pathToFileURL}=require('node:url');
  const {GLTFLoader}=await import(pathToFileURL(path.join(root,'frontend/node_modules/three/examples/jsm/loaders/GLTFLoader.js')));
  const {inferLoadingPort}=await import(pathToFileURL(path.join(root,'frontend/src/three/lineLoadingAlignment.js')));
  const cad=require('../backend/services/builtinModels').getBuiltinModels().find(m=>m.id==='cad_transfer_cart_101300');
  const bytes=fs.readFileSync(path.join(root,'backend',cad.file_path));
  const cadRoot=(await new Promise((yes,no)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',yes,no))).scene;
  const actualPort=inferLoadingPort(cadRoot,{model_type:cad.id},cad,'inlet');assert.ok(actualPort);
  const cartMetadata=JSON.parse(db.prepare('SELECT metadata FROM models WHERE id=?').get('docking_cart').metadata);
  cartMetadata.loadingPorts={version:1,inlet:actualPort,outlet:actualPort};
  db.prepare('UPDATE models SET metadata=? WHERE id=?').run(JSON.stringify(cartMetadata),'docking_cart');
  const line = db.prepare('SELECT * FROM lines WHERE id=?').get('line_a');
  if(process.env.WORKSHOP_RAIL_LENGTH_ONLY==='1'){
    const draft=JSON.parse(line.layout_json);draft.lanes.push({id:'empty_opposite',name:'空设备线 2',offsetZ:8,length:120});
    db.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(draft),'line_a');
  }
  for (const d of db.prepare("SELECT * FROM devices WHERE line_id='line_a' AND id NOT IN (?,?)").all(info.deviceId, info.cartId)) {
    const config=JSON.parse(d.instance_config||'{}');for(const key of ['laneLineId','railLineId'])if(config[key]==='line_a')config[key]='line_b';
    db.prepare('UPDATE devices SET line_id=?,instance_config=? WHERE id=?').run('line_b',JSON.stringify(config),d.id);
  } // owned fixture only
  for (let i = 1; i <= 8; i++) db.prepare(`INSERT INTO devices (id,name,model_type,line_id,coordinate_space,pos_x,pos_y,pos_z,rotation_y,scale,instance_config,plc_enabled)
    SELECT ?,?,model_type,line_id,coordinate_space,?,?,?,rotation_y,scale,?,0 FROM devices WHERE id=?`).run(`unplaced_${i}`, `待摆设备 ${i}`, i * 3, 0, 12, JSON.stringify({ preserve: { pool: i } }), info.deviceId);
  if(process.env.WORKSHOP_AUTO_ONLY==='1'){
    const original=db.prepare('SELECT * FROM devices WHERE id=?').get(info.deviceId);
    db.prepare(`INSERT INTO devices (id,name,model_type,line_id,coordinate_space,pos_x,pos_y,pos_z,rotation_y,scale,instance_config,plc_enabled)
      SELECT ?,?,model_type,line_id,coordinate_space,?,pos_y,pos_z,?,scale,instance_config,0 FROM devices WHERE id=?`).run('automatic_backwards','自动反向工位',-15,Math.PI,info.deviceId);
    assert.equal(db.prepare('SELECT instance_config FROM devices WHERE id=?').get('automatic_backwards').instance_config,original.instance_config);
  }

  const oldDevices = db.prepare('SELECT * FROM devices ORDER BY id').all();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  if(process.env.WORKSHOP_EMBEDDED==='1') await context.addInitScript(()=>{window.chrome ||= {};window.chrome.webview={postMessage(){},addEventListener(){},removeEventListener(){}}});
  await context.addInitScript(({ workshop }) => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'composer', selectedWorkshopEditorId: workshop, selectedLineEditorId: 'line_a', lineDevicePoolDockX: 2400, lineDevicePoolDockY: 1800 })), { workshop: line.workshop_id });
  page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => { const url = new URL(route.request().url()); return /^https?:$/.test(url.protocol) && url.origin !== info.origin ? route.abort() : route.continue(); });
  if(process.env.WORKSHOP_NAV_ONLY==='1') await page.route('**/api/admin-auth/page-catalog',async route=>{
    const response=await route.fetch(),body=await response.json();
    body.pages=body.pages.map(p=>p.key==='composer'?{...p,navGroup:'main',label:'现场编排器',menuOrder:20}:p);
    await route.fulfill({response,json:body});
  });
  await page.goto(info.origin + '/admin'+(process.env.WORKSHOP_EMBEDDED==='1'?'?embedded=unity':'')); await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username); await page.getByRole('textbox', { name: '后台密码', exact: true }).fill(info.password); await page.getByRole('button', { name: '解锁后台', exact: true }).click();
  const workbench = page.getByTestId('workshop-arrangement'); await workbench.waitFor();
  assert.equal(await page.locator('nav').getByRole('button', { name: '现场编排器', exact: true }).count(), 0);
  assert.equal(await page.locator('nav').getByRole('button', { name: '产线管理', exact: true }).count(), 0);
  const factoryMenu = page.locator('nav .nav-group').filter({has:page.locator('button[title="工厂建模"]')});
  assert.deepEqual(await factoryMenu.locator('.nav-subitem').allTextContents().then(labels=>labels.map(text=>text.trim())),['车间管理','设备管理','车间编排','设备运动配置']);
  assert.equal(await page.locator('nav').getByRole('button',{name:'车间编排',exact:true}).count(),1);
  assert.equal(await factoryMenu.getAttribute('class').then(value=>value.includes('active')),true,'restored workshop arrangement highlights its parent group');
  await factoryMenu.locator('button[title="工厂建模"]').click();
  await factoryMenu.getByRole('button',{name:'车间编排',exact:true}).waitFor({state:'hidden'});
  assert.equal(await factoryMenu.getByRole('button',{name:'车间编排',exact:true}).isVisible(),false);
  await factoryMenu.locator('button[title="工厂建模"]').click();
  await factoryMenu.getByRole('button',{name:'车间编排',exact:true}).click();await workbench.waitFor();
  pass('workshop arrangement is a single factory-modelling child immediately below device management, with parent selection and collapse preserved');
  await page.screenshot({ path: path.join(directory, '01-workshop-overview.png'), fullPage: true });
  const bounds = await workbench.boundingBox(); assert.ok(bounds.y + bounds.height <= 1002, 'workbench stays inside viewport');
  pass('one workshop-arrangement menu and a bounded overview, no old editor destinations');
  if(process.env.WORKSHOP_LINE_TREE_ONLY==='1') {
    const mutations = [], originalLines = db.prepare('SELECT * FROM lines ORDER BY id').all();
    page.on('request', request => {
      if (/^\/api\/(lines|devices|workshop-arrangement)(\/|$)/.test(new URL(request.url()).pathname) && ['POST','PUT','DELETE'].includes(request.method())) mutations.push(request.method() + ' ' + new URL(request.url()).pathname);
    });
    const tree = workbench.locator('.arrangement-tree'), title = tree.locator('.arrangement-lines-title'), add = title.getByRole('button',{name:'新增产线',exact:true});
    assert.equal(await tree.locator('.arrangement-tree-title button').count(),0);
    assert.equal(await add.locator('svg[aria-hidden="true"]').count(),1);
    assert.equal((await add.innerText()).trim(),''); assert.equal(await add.getAttribute('title'),'新增产线');
    const workshopBox=await tree.locator('.arrangement-workshop-row').boundingBox(),addBox=await add.boundingBox();
    assert.ok(addBox.y >= workshopBox.y+workshopBox.height,'add belongs below the workshop, in the production-line section');
    await add.click();const create=page.getByRole('dialog',{name:'新增产线',exact:true});await create.waitFor();
    assert.equal(await create.locator('select').inputValue(),line.workshop_id);
    await create.getByRole('button',{name:'关闭产线弹窗',exact:true}).click();await create.waitFor({state:'hidden'});
    pass('SVG add icon lives in the production-line section and opens creation for the current workshop without submitting');
    await workbench.locator('.arrangement-line-row').first().click();
    const selected=tree.locator('.arrangement-line-header.selected'), edit=selected.getByRole('button',{name:`编辑产线 ${line.name}`,exact:true}), remove=selected.getByRole('button',{name:`删除产线 ${line.name}`,exact:true});
    async function assertInline() {
      const row=await selected.locator('.arrangement-line-row').boundingBox(), actions=await selected.locator('.arrangement-line-actions').boundingBox();
      assert.ok(Math.abs(row.y+row.height/2-actions.y-actions.height/2)<2,'actions remain on the same line as the name');
      assert.ok(actions.x >= row.x+row.width-1,'icons follow the production-line name');
      for(const button of [edit,remove]) { assert.equal((await button.innerText()).trim(),'');assert.equal(await button.locator('svg[aria-hidden="true"]').count(),1);assert.equal(await button.locator('button').count(),0);assert.equal(await button.getAttribute('aria-label'),await button.getAttribute('title')); }
      assert.equal(await tree.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true,'tree never overflows horizontally');
    }
    await assertInline();await edit.focus();await page.keyboard.press('Enter');
    const editing=page.getByRole('dialog',{name:'编辑产线资料',exact:true});await editing.waitFor();
    assert.equal(await editing.getByRole('textbox',{name:'产线名称',exact:true}).inputValue(),line.name);
    await editing.getByRole('button',{name:'关闭产线弹窗',exact:true}).click();await editing.waitFor({state:'hidden'});
    await remove.click();await page.getByRole('heading',{name:`永久删除产线「${line.name}」`,exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'永久删除',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    await page.screenshot({path:path.join(directory,'02-inline-line-icons.png'),fullPage:true});
    pass('inline pencil/trash icons retain keyboard editing and the protected delete confirmation; cancel sends no mutation');
    for(const viewport of [{width:1280,height:820},{width:1000,height:750},{width:720,height:820}]) {
      await page.setViewportSize(viewport);
      if(viewport.width<=760) await workbench.getByRole('button',{name:'对象列表',exact:true}).click();
      await assertInline(); assert.equal(await add.isVisible(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    }
    await page.screenshot({path:path.join(directory,'03-narrow-line-icons.png'),fullPage:true});
    pass('name/actions stay on one row at desktop, narrow-sidebar and mobile-drawer widths');
    await page.setViewportSize({width:1000,height:750});
    const longName='这是一条用于验证长名称省略后编辑和删除图标仍然可见的产线';
    db.prepare('UPDATE lines SET name=? WHERE id=?').run(longName,line.id);
    await page.reload();await workbench.waitFor();await workbench.locator('.arrangement-line-row').first().click();
    const longHeader=tree.locator('.arrangement-line-header.selected');
    for(const action of ['编辑','删除'])assert.equal(await longHeader.getByRole('button',{name:`${action}产线 ${longName}`,exact:true}).isVisible(),true);
    assert.equal(await longHeader.locator('.arrangement-line-row span[title]').getAttribute('title'),longName);
    assert.equal(await tree.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.screenshot({path:path.join(directory,'04-long-name-line-icons.png'),fullPage:true});
    db.prepare('UPDATE lines SET name=? WHERE id=?').run(line.name,line.id);
    assert.deepEqual(db.prepare('SELECT * FROM lines ORDER BY id').all(),originalLines);assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices);assert.deepEqual(mutations,[]);assert.deepEqual(errors,[]);
    pass('long names truncate without hiding the icons; all create/edit/delete cancellations preserve line and device records');
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));return;
  }
  if(process.env.WORKSHOP_NAV_ONLY==='1') { fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));return; }
  await page.getByRole('button', { name: '车间管理', exact: true }).click(); await workbench.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: /03.*产线布局/ }).count(), 0);
  assert.equal(await page.locator('.workshop-map-stage:visible').count(), 0);
  await page.getByRole('button', { name: '车间编排', exact: true }).click(); await workbench.waitFor();
  pass('workshop management has no step 03 and no second placement canvas');
  const overview = workbench.locator('.arrangement-workshop-plan');
  await overview.locator('.workshop-map-line').first().click();
  const x = overview.getByLabel('相对车间 X', { exact: true }), oldX = Number(await x.inputValue());
  await x.fill(String(oldX + .5)); await x.press('Tab');
  await workbench.getByRole('button', { name: '保存布局', exact: true }).click();
  await page.getByRole('button', { name: '确定', exact: true }).click();
  await waitUntil(() => JSON.parse(db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json).transform.x === oldX + .5, 10000, 'atomic arrangement save');
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(), oldDevices);
  pass('common save writes only the requested line placement; devices, PLC and bindings stay byte-identical');
  await workbench.locator('.arrangement-line-row').first().click();
  await workbench.locator('.line-preview-stage:visible').waitFor();
  const pool = workbench.locator('.line-device-pool-dock'), poolToggle = workbench.getByRole('button', { name: /未摆放设备/ });
  async function assertPoolInside() {
    await waitUntil(async () => {
      const p = await pool.boundingBox(), c = await workbench.locator('.line-preview-stage:visible').boundingBox(), w = await workbench.boundingBox();
      return p && c && w && p.x >= w.x && p.y >= w.y && p.x + p.width <= w.x + w.width + 1 && p.y + p.height <= c.y + 1 && c.height > 80 && w.y + w.height <= (await page.evaluate(()=>innerHeight)) + 1;
    }, 10000, 'unplaced device pool stays within visible canvas, including restored off-screen preferences');
  }
  await pool.waitFor(); await assertPoolInside();
  assert.equal(await pool.locator('.line-device-pool-chip').count(), 8);
  assert.match(await poolToggle.innerText(), /8/);
  assert.equal(await pool.locator('.line-device-pool-items').evaluate(el => el.scrollWidth > el.clientWidth), true, 'many devices scroll horizontally rather than extending the page');
  await pool.getByRole('button', { name: '收起', exact: true }).click(); await pool.waitFor({ state: 'hidden' });
  assert.equal(await poolToggle.getAttribute('aria-expanded'), 'false');
  await poolToggle.click(); await pool.waitFor(); await assertPoolInside();
  for(const viewport of [{width:1280,height:650},{width:900,height:600},{width:760,height:820}]) {
    await page.setViewportSize(viewport);await assertPoolInside();
    await page.locator('.admin-content').evaluate(el=>el.scrollTop=el.scrollHeight);await assertPoolInside();
    assert.equal(await pool.locator('.line-device-pool-chip').first().isVisible(),true);
  }
  await page.screenshot({path:path.join(directory,'01b-short-window-device-tray.png'),fullPage:true});
  await page.setViewportSize({width:1600,height:1000});await assertPoolInside();
  pass('unplaced devices are visible on initial entry, with a persistent count and reopen action despite old off-screen dock preferences');
  if(process.env.WORKSHOP_POOL_ONLY==='1') {assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));return;}
  assert.equal(await workbench.getByRole('button', { name: '进料面前后对齐', exact: true }).count(), 0);
  assert.equal(await workbench.locator('.line-adjustment-overlay:visible').count(), 0);
  await page.screenshot({ path: path.join(directory, '02-line-plan.png'), fullPage: true });
  pass('object selection focuses the existing internal line editor without an old page or red calibration overlay');
  if(process.env.WORKSHOP_RAIL_LENGTH_ONLY==='1'){
    const lane=workbench.locator('.line-map-lane').first(),rail=workbench.locator('.line-map-rail').first();
    const equal=async()=>assert.equal(await rail.evaluate(el=>el.style.width),await lane.evaluate(el=>el.style.width));
    await lane.getByRole('button',{name:'设备线 1 设置',exact:true}).click();
    const length=page.getByRole('spinbutton',{name:'设备线 1 长度（米）',exact:true});await length.fill('82.5');await length.press('Tab');
    await equal();assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices);
    assert.match(await rail.getAttribute('title'),/长度自动跟随/);assert.equal(await rail.locator('.line-map-handle').count(),0);
    await page.screenshot({path:path.join(directory,'02g-dependent-rail-length.png'),fullPage:true});await lane.getByRole('button',{name:'设备线 1 设置',exact:true}).click();
    const handle=await lane.locator('.handle-right').boundingBox();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();
    for(const dx of [25,50,75]){await page.mouse.move(handle.x+dx,handle.y+handle.height/2,{steps:3});await equal();}
    await page.mouse.up();await equal();
    const snapshot=JSON.stringify(db.prepare('SELECT * FROM devices ORDER BY id').all());
    await workbench.getByRole('button',{name:'保存布局',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();
    const saved=JSON.parse(db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json);
    assert.equal(saved.rails[0].length,saved.lanes[0].length);assert.notEqual(saved.rails[0].length,120);assert.equal(saved.lanes[1].length,120);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM devices ORDER BY id').all()),snapshot,'visual resizing cannot rewrite any device/PLC/movement record');
    pass('typing and every pointer-move synchronize rail length to the occupied row, ignore a longer empty row, and preserve all device and movement data');
    await page.reload();await workbench.waitFor();await workbench.locator('.arrangement-line-row').first().click();await equal();
    await lane.getByRole('button',{name:'设备线 1 设置',exact:true}).click();const shrink=page.getByRole('spinbutton',{name:'设备线 1 长度（米）',exact:true});
    await shrink.fill('4');assert.equal(await page.locator('.app-dialog-overlay').count(),0,'intermediate numeric typing must not open a blocking modal');await shrink.press('Tab');
    await page.getByRole('button',{name:'确定',exact:true}).waitFor();assert.match(await page.locator('.app-dialog-body p').textContent(),/校准工位设备.*超出/);
    await page.getByRole('button',{name:'确定',exact:true}).click();await lane.getByRole('button',{name:'设备线 1 设置',exact:true}).click();await equal();
    assert.equal(db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json,JSON.stringify(saved));
    await workbench.getByRole('button',{name:'三维效果',exact:true}).click();
    await waitUntil(async()=>(await workbench.locator('.composer-preview-footer').textContent()).includes('预览已同步'),60000,'3D preview uses persisted synchronized rail length');
    await page.screenshot({path:path.join(directory,'02h-synchronized-rail-three.png'),fullPage:true});assert.deepEqual(errors,[]);
    pass('synchronized length survives save/reopen and renders in 3D; invalid shrink names the excluded station and preserves the entire saved layout');
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));return;
  }
  if(process.env.WORKSHOP_GIZMO_ONLY!=='1') {
  const originalLayout = db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json;
  const deviceLeft = await workbench.locator('.line-map-device:not(.line-device-ghost)').evaluateAll(els => els.map(el => el.style.left));
  await workbench.getByRole('button',{name:'预览自动排布',exact:true}).click();
  const proposal = page.getByRole('dialog',{name:/自动排布预览/}); await proposal.waitFor({timeout:60000});
  assert.ok(await proposal.locator('.proposal-turns span').count()>0,'known port normals produce an actual whole-model yaw recommendation');
  assert.ok(await proposal.locator('line[marker-end]').count()>=2,'preview shows real calibrated mouth arrows');
  assert.equal(db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json,originalLayout);
  await page.screenshot({path:path.join(directory,'02b-automatic-layout-preview.png'),fullPage:true});
  await proposal.getByRole('button',{name:'保留原布局',exact:true}).click(); await proposal.waitFor({state:'hidden'});
  await workbench.getByRole('button',{name:'预览自动排布',exact:true}).click(); await proposal.waitFor({timeout:60000});
  await proposal.getByRole('button',{name:'应用到草稿',exact:true}).click(); await proposal.waitFor({state:'hidden'});
  assert.deepEqual(await workbench.locator('.line-map-device:not(.line-device-ghost)').evaluateAll(els => els.map(el => el.style.left)), deviceLeft, 'automatic docking spacing cannot repack device X positions');
  assert.equal(await pool.locator('.line-device-pool-chip').count(), 8, 'the unplaced pool is not measured or automatically assigned');
  await workbench.getByRole('button',{name:'撤销排布',exact:true}).click();
  assert.equal(db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json,originalLayout);
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices);
  pass('actual measured-model proposal can cancel, apply to draft and undo without persisting any layout or bindings');
  if(process.env.WORKSHOP_AUTO_ONLY==='1'){
    await workbench.getByRole('button',{name:'预览自动排布',exact:true}).click();await proposal.waitFor({timeout:60000});
    await proposal.getByRole('button',{name:'应用到草稿',exact:true}).click();await proposal.waitFor({state:'hidden'});
    await workbench.getByRole('button',{name:'保存布局',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();
    const saved=db.prepare('SELECT * FROM devices ORDER BY id').all();
    assert.ok(saved.some(d=>d.rotation_y!==oldDevices.find(o=>o.id===d.id).rotation_y),'confirmed yaw corrections persist');
    for(const device of saved){const old=oldDevices.find(o=>o.id===device.id);for(const key of Object.keys(old))if(!['pos_z','rotation_y','instance_config'].includes(key))assert.deepEqual(device[key],old[key],key);assert.deepEqual(JSON.parse(device.instance_config||'{}'),JSON.parse(old.instance_config||'{}'));}
    assert.equal(JSON.parse(db.prepare('SELECT layout_json FROM lines WHERE id=?').get('line_a').layout_json).placementTemplate.mouthAligned,true);
    pass('confirmed automatic yaw and mouth-depth alignment saves atomically without changing X/Y, movement, model, ports or PLC identity');
    await page.reload();await workbench.waitFor();await workbench.locator('.arrangement-line-row').first().click();
    await workbench.getByRole('button',{name:'预览自动排布',exact:true}).click();await proposal.waitFor({timeout:60000});
    assert.equal(await proposal.locator('.proposal-turns span').count(),0,'reopened saved layout needs no repeated rotation');
    await proposal.getByRole('button',{name:'保留原布局',exact:true}).click();
    const modelRow=db.prepare('SELECT metadata FROM models WHERE id=?').get('docking_fixed'),missing=JSON.parse(modelRow.metadata);missing.loadingPorts.inlet=null;
    db.prepare('UPDATE models SET metadata=? WHERE id=?').run(JSON.stringify(missing),'docking_fixed');
    await page.reload();await workbench.waitFor();await workbench.locator('.arrangement-line-row').first().click();
    await workbench.getByRole('button',{name:'预览自动排布',exact:true}).click();
    const manual=page.getByRole('button',{name:'到三维调整',exact:true});await manual.waitFor({timeout:60000});
    assert.match(await page.locator('.app-dialog-body p').textContent(),/校准工位设备.*已校准/);
    await manual.click();const canvas=workbench.locator('.composer-preview-stage:visible canvas');await canvas.waitFor({timeout:60000});
    await waitUntil(()=>canvas.evaluate(el=>el.dataset.workshopSelection==='docking_ui_target'),60000,'named failure opens the affected real model in 3D');
    assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),saved,'failed recommendation never changes saved data');
    await page.screenshot({path:path.join(directory,'02f-automatic-manual-handoff.png'),fullPage:true});
    assert.deepEqual(errors,[]);pass('saved yaw is stable after reopen; exceptional missing calibration names the device and opens its 3D editor without changes');
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));return;
  }
  await workbench.getByRole('button',{name:'对接预览',exact:true}).click();const docking=page.getByRole('dialog',{name:'产线对接预览',exact:true});await docking.waitFor();
  await docking.locator('.docking-viewport canvas').waitFor({timeout:60000});assert.equal(await docking.getByRole('button',{name:'保存设备位置',exact:true}).count(),0);
  await waitUntil(()=>docking.getByRole('button',{name:'俯视',exact:true}).isEnabled(),60000,'finished readonly CAD preview, not just an empty WebGL canvas');
  await page.screenshot({path:path.join(directory,'02c-readonly-docking.png'),fullPage:true});await docking.getByRole('button',{name:'关闭预览',exact:true}).click();
  // Owned-fixture reproduction: both ports exist, but the single cart mouth
  // faces the same way as the furnace. Inspection must show, not rewrite, it.
  const originalCartMetadata = db.prepare('SELECT metadata FROM models WHERE id=?').get('docking_cart').metadata;
  const sameFacing = JSON.parse(originalCartMetadata);sameFacing.loadingPorts.outlet.direction=[0,0,1];
  db.prepare('UPDATE models SET metadata=? WHERE id=?').run(JSON.stringify(sameFacing),'docking_cart');
  await workbench.getByRole('button',{name:'对接预览',exact:true}).click();await docking.waitFor();
  await docking.locator('.calibration-port-status.warning').waitFor({timeout:60000});
  await docking.locator('.docking-viewport canvas').waitFor({timeout:60000});
  await waitUntil(()=>docking.getByRole('button',{name:'俯视',exact:true}).isEnabled(),60000,'finished same-facing CAD model and direction-arrow rendering');
  assert.match(await docking.locator('.calibration-port-status').innerText(),/两个料口均已读取/);
  assert.match(await docking.locator('.calibration-port-status').innerText(),/背向设备/);
  assert.equal(await docking.getByRole('button',{name:'俯视',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await docking.locator('.calibration-error').count(),0,'known direction mismatch is a diagnostic, not a blank blocking screen');
  assert.equal(await docking.getByRole('button',{name:'保存设备位置',exact:true}).count(),0);
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices);
  assert.deepEqual(JSON.parse(db.prepare('SELECT metadata FROM models WHERE id=?').get('docking_cart').metadata),sameFacing,'inspection cannot flip the saved port normal');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(directory,'02e-port-direction-inspection.png'),fullPage:true});
  await docking.getByRole('button',{name:'关闭预览',exact:true}).click();
  db.prepare('UPDATE models SET metadata=? WHERE id=?').run(originalCartMetadata,'docking_cart');
  pass('same-facing configured ports render actual CAD models and direction diagnostics in read-only top view without saving or flipping anything');
  const remove=workbench.locator('.line-map-device').filter({hasText:'校准工位设备'}).getByRole('button',{name:'移出',exact:true});
  await remove.click();assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices,'remove-to-pool stays a draft');
  await pool.waitFor(); await assertPoolInside();
  assert.equal(await pool.locator('.line-device-pool-chip').count(), 9);
  await page.setViewportSize({ width: 760, height: 820 }); await assertPoolInside();
  await page.screenshot({ path: path.join(directory, '02d-narrow-unplaced-devices.png'), fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 }); await assertPoolInside();
  // A pool item is still a real draggable device; dragging changes only the draft.
  const chip = pool.locator('.line-device-pool-chip').filter({ hasText: '待摆设备 1' });
  await chip.scrollIntoViewIfNeeded(); const chipRect = await chip.boundingBox();
  const laneRect = await workbench.locator('.line-map-lane').first().boundingBox();
  await page.mouse.move(chipRect.x + 35, chipRect.y + 20); await page.mouse.down();
  await page.mouse.move(laneRect.x + laneRect.width * .2, laneRect.y + laneRect.height / 2, { steps: 12 }); await page.mouse.up();
  await workbench.locator('.line-map-device').filter({ hasText: '待摆设备 1' }).waitFor();
  assert.equal(await pool.locator('.line-device-pool-chip').count(), 8);
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(), oldDevices, 'dragging from the pool cannot persist before common save');
  await workbench.getByRole('button',{name:'取消修改',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();
  await workbench.locator('.line-map-device').filter({hasText:'校准工位设备'}).waitFor();
  pass('docking is read-only and moving a device to the pool is draft-only until common save');


  }
  await workbench.getByRole('button', { name: '三维效果', exact: true }).click();
  await workbench.locator('.composer-preview-stage:visible').waitFor();
  await waitUntil(() => workbench.locator('.composer-preview-stage canvas').count().then(n => n > 0), 60000, 'real model renderer');
  await waitUntil(async () => (await workbench.locator('.composer-preview-footer').textContent()).includes('预览已同步'), 60000, 'finished real model loading');
  assert.equal(await workbench.locator('.composer-preview-error').count(), 0, 'all selected source models load');
  await page.screenshot({ path: path.join(directory, '03-three-view.png'), fullPage: true });
  await workbench.locator('.arrangement-device-children button').filter({hasText:'校准工位设备'}).click();
  const editorCanvas=workbench.locator('.composer-preview-stage canvas');
  await waitUntil(()=>editorCanvas.evaluate(el=>el.dataset.workshopSelection==='docking_ui_target'&&JSON.parse(el.dataset.workshopHandles||'[]').some(h=>h.axis==='X')),60000,'selected device has an actual transform handle');
  await workbench.locator('.arrangement-space-details summary').click();
  const xInput=workbench.getByLabel('X',{exact:true}),zInput=workbench.getByLabel('Z',{exact:true});
  const originalTransform={x:Number(await xInput.inputValue()),z:Number(await zInput.inputValue()),y:Number(await workbench.getByLabel('标高 Y（米）',{exact:true}).inputValue())};
  await workbench.locator('.arrangement-space-details summary').click();
  async function dragX(cancel=false){
    // Wait for camera flights to settle before using the public projected handle.
    let last;await waitUntil(async()=>{const point=await editorCanvas.evaluate(el=>JSON.parse(el.dataset.workshopHandles||'[]').find(h=>h.axis==='X'));const stable=last&&Math.hypot(last.x-point.x,last.y-point.y)<.3;last=point;return stable;},10000,'stable projected handle');
    await page.mouse.move(last.x,last.y);await page.mouse.down();await page.mouse.move(last.x+65,last.y+8,{steps:12});
    if(cancel)await page.keyboard.press('Escape');await page.mouse.up();
  }
  await dragX();
  await waitUntil(async()=>Math.abs(Number(await xInput.inputValue())-originalTransform.x)>.001,10000,'real pointer drag changes X');
  assert.equal(Number(await zInput.inputValue()),originalTransform.z);assert.equal(Number(await workbench.getByLabel('标高 Y（米）',{exact:true}).inputValue()),originalTransform.y);
  const movedX=Number(await xInput.inputValue());await workbench.getByRole('button',{name:'撤销设备摆放',exact:true}).click();assert.equal(Number(await xInput.inputValue()),originalTransform.x);
  await workbench.getByRole('button',{name:'重做设备摆放',exact:true}).click();assert.equal(Number(await xInput.inputValue()),movedX);
  await dragX(true);assert.equal(Number(await xInput.inputValue()),movedX,'Escape restores this gesture, not the whole saved layout');
  await workbench.getByRole('button',{name:'撤销设备摆放',exact:true}).click();
  await workbench.getByRole('button',{name:'转向',exact:true}).click();await workbench.getByRole('button',{name:'转 90°',exact:true}).click();
  assert.equal(await workbench.getByRole('button',{name:'撤销设备摆放',exact:true}).isEnabled(),true);await workbench.getByRole('button',{name:'撤销设备摆放',exact:true}).click();
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices,'gizmos and undo never write PLC, ports or device persistence');
  await page.screenshot({path:path.join(directory,'03c-device-direct-manipulation.png'),fullPage:true});
  pass('real canvas axis dragging, Escape cancellation, per-gesture undo/redo and horizontal turn actions preserve calibrated depth and remain draft-only');
  await workbench.getByRole('button',{name:'移动',exact:true}).click();
  await workbench.getByRole('button',{name:'高度／对接距离',exact:true}).click();
  await waitUntil(()=>editorCanvas.evaluate(el=>new Set(JSON.parse(el.dataset.workshopHandles||'[]').map(h=>h.axis)).size===3),10000,'explicit space mode reveals three labelled axes');
  const yHandle=await editorCanvas.evaluate(el=>JSON.parse(el.dataset.workshopHandles).find(h=>h.axis==='Y'));
  await page.mouse.move(yHandle.x,yHandle.y);await page.mouse.down();await page.mouse.move(yHandle.x,yHandle.y-55,{steps:10});await page.mouse.up();
  await waitUntil(async()=>Number(await workbench.getByLabel('标高 Y（米）',{exact:true}).inputValue())!==originalTransform.y,10000,'real height-axis gesture');
  await workbench.getByRole('button',{name:'撤销设备摆放',exact:true}).click();assert.equal(Number(await workbench.getByLabel('标高 Y（米）',{exact:true}).inputValue()),originalTransform.y);
  await page.screenshot({path:path.join(directory,'03d-three-labelled-axes.png'),fullPage:true});
  await workbench.locator('.arrangement-device-children button').filter({hasText:'校准转运小车'}).click();
  await waitUntil(()=>editorCanvas.evaluate(el=>el.dataset.workshopSelection==='docking_ui_cart'&&JSON.parse(el.dataset.workshopHandles||'[]').length>0),60000,'original CAD cart selection');
  assert.deepEqual(await editorCanvas.evaluate(el=>[...new Set(JSON.parse(el.dataset.workshopHandles).map(h=>h.axis))]),['X'],'cart has only its real along-rail translation');
  assert.equal(await workbench.getByRole('button',{name:'高度／对接距离',exact:true}).count(),0);
  await workbench.locator('.arrangement-device-children button').filter({hasText:'校准工位设备'}).click();
  await waitUntil(()=>editorCanvas.evaluate(el=>el.dataset.workshopSelection==='docking_ui_target'),60000,'reselected original station');
  assert.deepEqual(db.prepare('SELECT * FROM devices ORDER BY id').all(),oldDevices);
  pass('explicit height-axis dragging can be undone and the original CAD cart stays constrained to its bound rail');
  await workbench.locator('.arrangement-space-details summary').click();
  const elevation = workbench.getByLabel('标高 Y（米）', {exact:true}), oldY = Number(await elevation.inputValue());
  await elevation.fill(String(oldY + .1)); await elevation.press('Tab');
  await page.screenshot({path:path.join(directory,'03b-device-inspector.png'),fullPage:true});

  await workbench.getByRole('button', { name: '俯视排布', exact: true }).click();
  await workbench.getByRole('button', { name: '车间总览', exact: true }).click();
  assert.equal(await workbench.getByRole('button',{name:'保存布局',exact:true}).isEnabled(),true,'device draft survives plan/3D and layer switches');
  await workbench.getByRole('button',{name:'保存布局',exact:true}).click();await page.getByRole('button',{name:'确定',exact:true}).click();
  assert.equal(db.prepare('SELECT pos_y FROM devices WHERE id=?').get(info.deviceId).pos_y,oldY+.1);
  const savedDevice=db.prepare('SELECT * FROM devices WHERE id=?').get(info.deviceId),original=oldDevices.find(d=>d.id===info.deviceId);
  for(const key of Object.keys(original))if(!['pos_y','instance_config'].includes(key))assert.deepEqual(savedDevice[key],original[key],key);
  const savedConfig=JSON.parse(savedDevice.instance_config),oldConfig=JSON.parse(original.instance_config);
  const {ground:heightGround,...untouched}=savedConfig;assert.deepEqual(untouched,oldConfig,'height-linked ground must not overwrite bindings');
  assert.equal(heightGround.enabled,true);assert.ok(heightGround.width>0&&heightGround.depth>0,'explicit elevation editing retains existing ground-follow behavior');
  pass('device edits survive shared view selection and save narrowly without changing instance bindings');

  await page.setViewportSize({ width: 760, height: 820 });
  await page.screenshot({ path: path.join(directory, '04-narrow-workbench.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  const narrow = await workbench.boundingBox(); assert.ok(narrow.y + narrow.height <= 822);
  assert.deepEqual(errors, []);
  pass('same-model 3D view and narrow drawer layout render without browser errors or page overflow');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, errors, directory }, null, 2));
  console.log(JSON.stringify({ success: true, checks: checks.length, directory }));
})().catch(async error => { console.error(error); if (page) { console.error((await page.locator('body').innerText()).slice(-2200)); await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); } fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, errors }, null, 2)); process.exitCode = 1; })
  .finally(async () => { db?.close(); await browser?.close(); await stopOwnedSmokeProcess(server); });
