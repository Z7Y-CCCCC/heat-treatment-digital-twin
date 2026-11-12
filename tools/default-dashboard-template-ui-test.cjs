// Isolated empty-install fixture only. Never reads/writes the operator's database.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const {INFO}=require('../backend/services/defaultDashboardTemplate');
const root=path.resolve(__dirname,'..'),directory=createRunDirectory('default-dashboard-template-ui'),errors=[],checks=[];
let server,browser,page;
(async()=>{
  const infoFile=path.join(directory,'server.json');
  server=startLoggedProcess(process.execPath,[path.join(__dirname,'empty-install-ui-server.cjs')],{cwd:root,env:{...process.env,EMPTY_INSTALL_UI_INFO_FILE:infoFile,FRONTEND_DIST:path.join(root,'frontend/dist')},logFile:path.join(directory,'backend.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned empty backend');
  const info=JSON.parse(fs.readFileSync(infoFile));
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1598,height:960}});
  await context.addCookies(info.session.cookie.split('; ').map(pair=>{const i=pair.indexOf('=');return {name:pair.slice(0,i),value:pair.slice(i+1),url:info.origin,httpOnly:true,sameSite:'Strict'}}));
  const api=async(url,options={})=>{const response=await context.request.fetch(info.origin+'/api'+url,{...options,headers:{'X-CSRF-Token':info.session.csrfToken,...options.headers}});const body=await response.json();assert.ok(response.ok(),JSON.stringify(body));return body};
  assert.equal((await api('/factories')).factories.length,0);
  checks.push('fresh isolated installation still has zero factories rather than importing Tianjin data');
  const factory=(await api('/factories',{method:'POST',data:{name:'隔离默认模板测试工厂'}})).factory;
  const headers={'X-Factory-Id':factory.id};
  const initial=await api('/platform/designer',{headers});
  assert.equal(initial.document.widgets.length,35);assert.equal(initial.document.metadata.defaultTemplate.sha256,INFO.sha256);
  assert.ok(initial.currentRelease);assert.equal(initial.releases.length,1);
  assert.ok(initial.document.widgets.every(w=>!w.data.deviceId&&!w.data.pointId&&!w.data.connectionId));
  const config=await api('/config',{headers});
  assert.equal((await api('/devices',{headers})).length,0);assert.equal((await api('/models',{headers})).length,0);
  assert.equal(config.platform.document.widgets.length,35);
  checks.push('explicit new factory gets the frozen component layout in both draft and initial runtime release, without models/devices/point bindings');
  // Preserve the first factory's custom edit when another factory is created.
  initial.document.widgets[0].title='隔离现场自定义，不应被覆盖';
  await api('/platform/designer/draft',{method:'PUT',headers,data:{sceneId:initial.document.sceneId,document:initial.document,expectedRevision:initial.revision}});
  const saved=await api('/platform/designer',{headers});
  const Database=require('../backend/node_modules/better-sqlite3');
  const readStored=()=>{const db=new Database(info.env.SQLITE_FILE,{readonly:true,fileMustExist:true});try{return db.prepare('SELECT draft_json,draft_revision FROM scenes WHERE id=?').get(saved.document.sceneId)}finally{db.close()}};
  const storedBefore=readStored();
  const second=(await api('/factories',{method:'POST',data:{name:'另一个隔离测试工厂'}})).factory;
  const other=await api('/platform/designer',{headers:{'X-Factory-Id':second.id}});
  assert.ok(other.document.widgets.every(w=>!saved.document.widgets.some(old=>old.id===w.id)));
  assert.deepEqual(readStored(),storedBefore);
  const unchanged=await api('/platform/designer',{headers});assert.equal(unchanged.revision,saved.revision);assert.deepEqual(unchanged.document.widgets,saved.document.widgets);
  checks.push('new factories have independent globally unique widget identities and do not reset an existing customized draft');
  // Register an intentionally empty GLB in this owned test DB only, standing in
  // for a separately imported model. Never copy the operator's model library.
  const modelId='default_template_fixture_model',modelPath='/uploads/models/default-template-fixture.glb';
  const modelDirectory=path.join(info.env.UPLOADS_DIR,'models');fs.mkdirSync(modelDirectory,{recursive:true});
  const gltf=Buffer.from(JSON.stringify({asset:{version:'2.0'},scene:0,scenes:[{nodes:[]}],nodes:[]}));
  const json=Buffer.alloc(Math.ceil(gltf.length/4)*4,0x20);gltf.copy(json);
  const glb=Buffer.alloc(20+json.length);glb.writeUInt32LE(0x46546c67,0);glb.writeUInt32LE(2,4);glb.writeUInt32LE(glb.length,8);glb.writeUInt32LE(json.length,12);glb.writeUInt32LE(0x4e4f534a,16);json.copy(glb,20);
  fs.writeFileSync(path.join(modelDirectory,'default-template-fixture.glb'),glb);
  const fixtureDb=new Database(info.env.SQLITE_FILE);
  try{fixtureDb.prepare('INSERT INTO models (id,name,file_path,factory_id,metadata,default_scale,placement_level) VALUES (?,?,?,?,?,1,?)').run(modelId,'隔离空模型',modelPath,factory.id,'{}','device')}finally{fixtureDb.close()}
  const workshopId='default_template_fixture_ws',lineId='default_template_fixture_line';
  await api('/workshops',{method:'POST',headers,data:{id:workshopId,name:'隔离车间'}});
  await api('/lines',{method:'POST',headers,data:{id:lineId,name:'隔离产线',workshop_id:workshopId}});
  const createDevice=async id=>api('/devices',{method:'POST',headers,data:{id,name:id,line_id:lineId,model_type:modelId,model_file:modelPath,plc_enabled:false}});
  const {flattenPlaybackDevices}=require('../shared/widgetPlayback.mjs');
  const assertSharedLayout=async expectedIds=>{
    const current=await api('/config',{headers});
    assert.deepEqual(flattenPlaybackDevices(current).map(device=>device.id).sort(),[...expectedIds].sort());
    assert.deepEqual(current.platform.document.widgets,config.platform.document.widgets);
    assert.deepEqual(current.platform.document.scene.views,config.platform.document.scene.views);
    assert.deepEqual(readStored(),storedBefore);
    return current;
  };
  const deviceA='default_template_device_a',deviceB='default_template_device_b',deviceC='default_template_device_after_empty';
  await createDevice(deviceA);await assertSharedLayout([deviceA]);
  await createDevice(deviceB);await assertSharedLayout([deviceA,deviceB]);
  await api('/devices/'+deviceA,{method:'DELETE',headers,data:{confirmationName:deviceA}});await assertSharedLayout([deviceB]);
  await api('/devices/'+deviceB,{method:'DELETE',headers,data:{confirmationName:deviceB}});await assertSharedLayout([]);
  await createDevice(deviceC);await assertSharedLayout([deviceC]);
  const deviceD='default_template_device_after_empty_2';await createDevice(deviceD);await assertSharedLayout([deviceC,deviceD]);
  assert.equal((await api('/devices',{headers:{'X-Factory-Id':second.id}})).length,0);
  checks.push('real device create/delete APIs keep the shared draft and release unchanged, including zero devices followed by a new device; other factories stay empty');
  await context.addInitScript(id=>{localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'designer'}));localStorage.setItem('digital_twin_factory_scope_v1',id)},factory.id);
  page=await context.newPage();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(info.origin+'/admin');
  await page.getByRole('note',{name:'固定的内置默认模板',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'重绑定数据',exact:true}).count(),0);
  const badge=page.locator('.builtin-template-badge');assert.match(await badge.innerText(),/7 个视角/);
  assert.match(await badge.getAttribute('title'),/现场编辑不会改写它/);
  assert.match(await badge.getAttribute('title'),/新增设备自动沿用共享设备视角布局/);
  for(const width of [1598,1280]){await page.setViewportSize({width,height:960});assert.ok(await badge.isVisible());}
  await page.screenshot({path:path.join(directory,'default-template-designer.png')});
  await page.locator('.designer-toolbar').screenshot({path:path.join(directory,'default-template-toolbar.png')});
  checks.push('real designer shows a fixed built-in baseline notice instead of rebind action, while normal factory editing remains available');
  for(const viewId of ['device_detail','device_xray','device_exploded','device_part']){
    await page.locator(`[data-view-id="${viewId}"] .view-tree-select`).click();
    const picker=page.locator('.designer-device-picker select');await picker.waitFor();await picker.selectOption(deviceC);
    assert.equal(await picker.inputValue(),deviceC);
    const layoutIds=()=>page.locator('.designer-widget').evaluateAll(nodes=>nodes.map(node=>node.dataset.widgetId).sort());
    const first=await layoutIds();assert.ok(first.length>0,`${viewId} must show shared components for the newly added device`);
    assert.equal(new Set(first).size,first.length,'no duplicate component copies');
    assert.ok(first.every(id=>initial.document.widgets.some(widget=>widget.id===id)),'only the fixed factory-view widgets appear in device views');
    await picker.selectOption(deviceD);assert.deepEqual(await layoutIds(),first,`${viewId} must be identical for both newly added devices`);
  }
  await page.screenshot({path:path.join(directory,'new-device-shared-template.png')});
  checks.push('designer automatically exposes shared components and the new device selector in all four device views without copying widgets');
  assert.deepEqual(errors,[]);
  const result={success:true,checks,errors,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));console.error(error);process.exitCode=1;})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});
