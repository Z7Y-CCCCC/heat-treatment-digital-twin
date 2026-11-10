// Plain Playwright acceptance. Only the owned backend/source/SQLite fixture
// is contacted. UI input is real clicks and native select/input changes;
// evaluate is used exclusively for read-only DOM layout measurements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname,'..'), directory = createRunDirectory('widget-binding-workflow-ui');
let server, browser, page, context, runtime, info, catalog, stage = 'starting fixture';
const checks=[], screenshots=[], audits=[], errors=[], writes=[], guardViolations=[];
const ids={kpi:'binding_workflow_kpi',current:'binding_workflow_current',alarm:'binding_workflow_alarm',global:'binding_workflow_global'};
const pass = label => {checks.push(label);console.log('PASS '+label);fs.appendFileSync(path.join(directory,'run.log'),'PASS '+label+'\n')};
const workflow = () => page.getByRole('region',{name:'组件数据设置',exact:true});
const rows = () => workflow().locator('.device-data-row');
const widget = (id,p=page) => p.locator(`${p===page?'.designer-widget':'.map-surface-widget-layer > div'}[data-widget-id="${id}"]`);
const modeNames = {current:/^显示当前查看设备的数据/,fixed:/^始终显示指定设备的数据/,rotation:/^按清单轮播数据/};
const metricValue = (id,label,p=page) => widget(id,p).locator('.hud-module-stat-list > div').filter({has:p.locator('dt').filter({hasText:label})}).locator('dd');
async function api(route,method='GET',data,p=page){
  const origin=new URL(info.origin);assert.equal(origin.hostname,'127.0.0.1');assert.notEqual(origin.port,'3001');
  const session=await p.request.get(info.origin+'/api/admin-auth/session').then(response=>response.json());
  const response=await p.request.fetch(info.origin+'/api'+route,{method,headers:{Origin:info.origin,'X-Factory-ID':info.factoryId,'X-Admin-Request':'1','X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});
  assert.equal(response.status(),200,await response.text());return response.json();
}
async function shot(name,p=page){const filename=path.join(directory,name+'.png');await p.screenshot({path:filename,fullPage:false});screenshots.push(filename);return filename}
async function readyDesigner(){
  // The shell is mounted before its draft/point requests finish, and the
  // global-view policy loads independently. Wait for both real UI states so
  // late entry restoration cannot overwrite a view/component click.
  await page.locator('.dashboard-designer-shell').waitFor();
  await page.locator('.designer-loading').waitFor({state:'hidden'});
  await page.locator('.designer-canvas-scroll').waitFor();
  await waitUntil(async()=>await page.getByTestId('global-view-section').getByRole('switch',{name:'启用全部全局视角',exact:true}).isEnabled(),20000,'designer global-view policy ready');
}
async function view(id){
  stage='select view '+id;
  await readyDesigner();
  if(/^(map_|site_)/.test(id)){
    const section=page.getByTestId('global-view-section'),heading=section.locator('.section-heading');
    if(await heading.getAttribute('aria-expanded')!=='true')await heading.click();
    const row=section.locator(`[data-global-view-id="${id}"]`),enabled=row.getByRole('switch');
    if(await enabled.getAttribute('aria-checked')!=='true'){
      await enabled.click();
      await waitUntil(async()=>await enabled.isEnabled()&&await enabled.getAttribute('aria-checked')==='true',20000,'global view enabled '+id);
    }
    await row.locator('.global-view-name').click();
    await waitUntil(async()=>(await row.getAttribute('class')).split(/\s+/).includes('selected'),10000,'selected global view '+id);return;
  }
  const tree=page.getByRole('tree',{name:'视角层级',exact:true});
  if(await tree.locator(`[data-view-id="${id}"]`).count()===0){const parent=tree.locator('[data-view-id="factory_overview"]');if(await parent.getAttribute('aria-expanded')==='false')await parent.locator('.view-tree-toggle').click()}
  await tree.locator(`[data-view-id="${id}"] .view-tree-select`).click();
  await waitUntil(async()=>(await tree.locator(`[data-view-id="${id}"]`).getAttribute('class')).split(/\s+/).includes('active'),10000,'selected factory/device view '+id);
}
async function selectWidget(id){stage='select component '+id;const layer=page.locator(`.layer-list [data-component-id="${id}"]`);await layer.click();await waitUntil(async()=>(await layer.getAttribute('class')).split(/\s+/).includes('active'),10000,'selected component '+id);await page.locator('.inspector-tabs').getByRole('button',{name:'数据来源',exact:true}).click();await workflow().waitFor()}
async function openRow(index){const row=rows().nth(index);if(await row.getAttribute('open')===null)await row.locator(':scope > summary').click();return row}
async function mainPicker(index){return (await openRow(index)).getByRole('region',{name:'数据中心选取数据',exact:true}).first()}
async function metricPicker(index,metricIndex){const row=await openRow(index),section=row.locator('.panel-metric-sources');if(await section.getAttribute('open')===null)await section.locator(':scope > summary').click();return section.locator('.panel-metric-source').nth(metricIndex).getByRole('region',{name:'数据中心选取数据',exact:true})}
const pointItem = (device,key) => {const item=catalog.items.find(item=>String(item.binding?.pointId)===info.points[device.id][key].id);assert.ok(item,`${device.id}/${key} catalog source exists`);return item};
async function choose(picker,item){
  await picker.getByLabel('数据用途分类',{exact:true}).selectOption(item.categoryId);
  await picker.getByLabel('选择数据表',{exact:true}).selectOption(item.tableId);
  await picker.getByLabel('选择具体数据',{exact:true}).selectOption(item.id);
  if(await picker.getByRole('button',{name:'使用所选数据',exact:true}).count())await picker.getByRole('button',{name:'使用所选数据',exact:true}).click();
  await waitUntil(async()=>await picker.getByLabel('选择具体数据',{exact:true}).inputValue()===item.id,10000,'explicit field '+item.id);
}
async function assertPicker(picker,item){await waitUntil(async()=>await picker.getByLabel('选择具体数据',{exact:true}).inputValue()===item.id,10000,'restored field '+item.id);assert.equal(await picker.getByLabel('选择数据表',{exact:true}).inputValue(),item.tableId);assert.equal(await picker.getByLabel('数据用途分类',{exact:true}).inputValue(),item.categoryId)}
async function setSeconds(value){const input=workflow().getByLabel('每项显示秒数',{exact:true});await input.fill(String(value));await input.press('Tab')}
async function save(){stage='save draft through UI';const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/platform/designer/draft'&&response.request().method()==='PUT');await page.getByRole('button',{name:'保存草稿',exact:true}).click();const result=await response;assert.equal(result.status(),200,await result.text());await waitUntil(async()=>await page.getByRole('button',{name:'保存草稿',exact:true}).isDisabled(),10000,'save completed');return api('/platform/designer')}
async function preview(){await page.getByRole('button',{name:'全屏预览当前视角',exact:true}).click();await page.locator('.dashboard-designer-shell.is-preview').waitFor()}
async function exitPreview(){await page.getByRole('button',{name:'退出全屏预览',exact:true}).first().click();await page.locator('.dashboard-designer-shell:not(.is-preview)').waitFor()}
async function audit(name,width,height,focus='modes'){
  await page.setViewportSize({width,height});
  const focusNode=focus==='rows' ? workflow().getByRole('heading',{name:'② 轮播清单',exact:true}) : focus==='global' ? workflow().locator('.global-panel-metrics > summary') : workflow().getByRole('heading',{name:'① 显示方式',exact:true});
  await focusNode.scrollIntoViewIfNeeded();
  if(focus==='rows')await rows().last().locator(':scope > summary').scrollIntoViewIfNeeded();
  const result=await workflow().evaluate((section,name)=>{
    const box=section.getBoundingClientRect(),body=section.closest('.inspector-body'),panel=body?.getBoundingClientRect();
    return {name,width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,workflow:{left:box.left,right:box.right,client:section.clientWidth,scroll:section.scrollWidth},panel:panel?{left:panel.left,right:panel.right,client:body.clientWidth,scroll:body.scrollWidth}:null,
      summaries:[...section.querySelectorAll('.device-data-row > summary')].map(node=>{const rect=node.getBoundingClientRect();return{text:node.textContent.trim(),client:node.clientWidth,scroll:node.scrollWidth,top:rect.top,bottom:rect.bottom,open:node.parentElement.open}}),
      controls:[...section.querySelectorAll('select,input,button')].filter(node=>node.getClientRects().length).map(node=>{const rect=node.getBoundingClientRect();return{tag:node.tagName,label:node.getAttribute('aria-label') || node.textContent.trim(),left:rect.left,right:rect.right}})};
  },name);audits.push(result);
  assert.ok(result.pageWidth<=width+2,'whole page has no horizontal overflow');
  assert.ok(result.workflow.scroll<=result.workflow.client+2,'binding workflow has no horizontal cropping');
  assert.ok(result.summaries.every(row=>row.scroll<=row.client+2),'folded summaries are not horizontally clipped');
  assert.ok(result.workflow.left>=-1&&result.workflow.right<=width+1,'workflow remains inside the viewport');
  assert.ok(result.controls.every(control=>control.left>=result.workflow.left-2&&control.right<=result.workflow.right+2),'visible data controls remain inside the workflow');
  await shot(name);return result;
}
async function initialFixture(){
  // Initial owned API fixture data is not an acceptance input to Vue.
  const source=(await api('/data-sources/connections','POST',{name:'自有工厂记录源',sourceType:'http_api',authType:'none',baseUrl:info.sourceOrigin,enabled:true})).connection;
  const dataset=(await api('/data-sources/datasets','POST',{name:'工厂工艺与能耗验收表',connectionId:source.id,source:'http',rootPath:'rows',refreshMs:1000,request:{method:'GET',path:'/factory',parameters:[]},columns:[{name:'overallProgress',path:'overallProgress',label:'工厂工艺进度',type:'number',unit:'%'},{name:'energy',path:'energy',label:'工厂耗电量',type:'number',unit:'kWh'},{name:'hoursTotal',path:'hoursTotal',label:'工厂累计运行时长',type:'number',unit:'h'}]})).dataset;
  const state=await api('/platform/designer'),{createDashboardWidget}=await import('../frontend/src/runtime/dashboardSchema.js');
  const make=(type,id,frame)=>({...createDashboardWidget(type),id,title:id,frame:{...frame,rotation:0}});
  const kpi=make('hud_kpi_panel',ids.kpi,{x:35,y:35,width:430,height:275});
  kpi.content={...kpi.content,chartLabel:'实际工艺进度',useBoundRing:true,note:'',items:[{label:'运行时长',unit:'h',binding:{mode:'plc',bindingVersion:2,deviceScope:'current',deviceBindings:[]}},{label:'耗电量',unit:'kWh',binding:{mode:'plc',bindingVersion:2,deviceScope:'current',deviceBindings:[]}}]};
  kpi.data={...kpi.data,mode:'static',deviceScope:'current'};
  const current=make('value',ids.current,{x:35,y:345,width:430,height:160}),a=info.devices[0],p=info.points[a.id].progress;
  current.data={...current.data,mode:'plc',bindingVersion:2,deviceScope:'current',pointId:p.id,pointKey:p.key,unit:p.unit,deviceBindings:[{deviceId:a.id,binding:{mode:'plc',deviceId:a.id,pointId:p.id,pointKey:p.key,unit:p.unit}}]};
  current.content={...current.content,label:'当前设备已配置读数',fallback:'—'};
  const alarm=make('hud_alarm_panel',ids.alarm,{x:505,y:35,width:550,height:275});alarm.data={...alarm.data,mode:'static'};alarm.content={...alarm.content,limit:10};
  const global=make('hud_kpi_panel',ids.global,{x:505,y:345,width:550,height:280});
  global.data={...global.data,mode:'dataset',bindingVersion:2,deviceScope:'global',datasetId:dataset.id,datasetField:'overallProgress',refreshMs:1000,unit:'%',deviceBindings:[]};
  global.content={...global.content,chartLabel:'工厂工艺进度',useBoundRing:true,note:'',items:[{label:'指定炉运行时长',unit:'h',binding:{mode:'runtime',bindingVersion:2,deviceScope:'global',path:'',deviceBindings:[]}},{label:'全厂耗电量',unit:'kWh',binding:{mode:'runtime',bindingVersion:2,deviceScope:'global',path:'',deviceBindings:[]}}]};
  const widgets=[kpi,current,alarm,global],show=widgets.map(widget=>widget.id);
  for(const widget of widgets)widget.visibility={...widget.visibility,viewIds:['map_world','factory_overview',...info.devices.map(device=>device.viewId)],viewModes:[],matchBoundDevice:false};
  const sceneView=(id,name,mode,targetType,parentViewId='',targetId='')=>({id,name,mode,targetType,targetId,parentViewId,returnViewId:parentViewId,componentState:{show:[...show],hide:[]}});
  state.document.widgets=widgets;state.document.canvas={...state.document.canvas,width:1280,height:720};
  state.document.scene.defaultViewId='factory_overview';state.document.metadata={...state.document.metadata,unifiedMapDesigner:1};
  state.document.scene.views=[sceneView('map_world','全球地图','custom','factory'),sceneView('factory_overview','全厂总览','factory','factory'),...info.devices.map(device=>sceneView(device.viewId,device.name,'device','device','factory_overview',device.id))];
  await api('/platform/designer/draft','PUT',{sceneId:state.document.sceneId,document:state.document,expectedRevision:state.revision});
  return {dataset,initialDocument:state.document};
}

(async()=>{
  const infoFile=path.join(directory,'server.json');server=startLoggedProcess(process.execPath,[path.join(__dirname,'widget-binding-workflow-ui-server.cjs')],{cwd:root,env:{...process.env,WIDGET_BINDING_UI_INFO_FILE:infoFile,UI_FRONTEND_DIST:process.env.UI_FRONTEND_DIST || path.join(root,'frontend','dist')},logFile:path.join(directory,'server.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);try{info=JSON.parse(fs.readFileSync(infoFile,'utf8'));return !!info.origin&&!!info.database}catch{return false}},60000,'owned binding fixture');
  requireTestPath(info.database);requireTestPath(info.directory);assert.equal(info.collectorFalse,true);assert.equal(info.noPhysicalPLC,true);assert.notEqual(new URL(info.origin).port,'3001');
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1});
  await context.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'designer'})));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&![info.origin,info.sourceOrigin].includes(url.origin)){guardViolations.push(url.href);return route.abort()}return route.continue()});
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(request.method()))writes.push({method:request.method(),path:url.pathname,body:request.postDataJSON()})});
  await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();await readyDesigner();
  const fixture=await initialFixture();catalog=await api('/data-center/catalog');
  await page.reload();await readyDesigner();await view('factory_overview');await selectWidget(ids.kpi);
  stage='configure two explicit device rows';await workflow().getByRole('button',{name:modeNames.rotation}).click();assert.equal(await rows().count(),1);
  for(const [index,device] of info.devices.slice(0,2).entries()){
    if(index)await workflow().getByRole('button',{name:'＋ 添加设备与对应数据',exact:true}).click();
    const row=await openRow(index);await row.getByLabel(`清单设备 ${index+1}`,{exact:true}).selectOption(device.id);
    await choose(await mainPicker(index),pointItem(device,'progress'));
    await choose(await metricPicker(index,0),pointItem(device,'hours'));await choose(await metricPicker(index,1),pointItem(device,'energy'));
  }
  await setSeconds(6);
  for(const row of await rows().all())if(await row.getAttribute('open')!==null)await row.locator(':scope > summary').click();
  for(const [index,device] of info.devices.slice(0,2).entries()){
    const summary=await rows().nth(index).locator(':scope > summary').innerText();assert.ok(summary.includes(info.points[device.id].progress.tag));assert.ok(summary.includes('正常'));assert.ok(summary.includes(`${info.points[device.id].progress.value}%`));
  }
  pass('each folded row shows its exact PLC address/current value/quality and true table; A keeps zero, B uses a different address and field role');
  await audit('01-folded-rows-1600',1600,1000,'rows');await audit('02-folded-rows-1280',1280,800,'rows');await page.setViewportSize({width:1600,height:1000});
  stage='cycle all display modes without losing assignments';
  for(let cycle=0;cycle<2;cycle++){
    await workflow().getByRole('button',{name:modeNames.fixed}).click();await workflow().getByLabel('指定数据设备',{exact:true}).selectOption(info.devices[1].id);
    assert.equal(await rows().count(),1);await assertPicker(await mainPicker(0),pointItem(info.devices[1],'progress'));
    await workflow().getByRole('button',{name:modeNames.current}).click();assert.equal(await rows().count(),2);
    await workflow().getByRole('button',{name:modeNames.rotation}).click();assert.equal(await rows().count(),2);assert.equal(await workflow().getByLabel('每项显示秒数',{exact:true}).inputValue(),'6');
    for(const [index,device] of info.devices.slice(0,2).entries()){await assertPicker(await mainPicker(index),pointItem(device,'progress'));await assertPicker(await metricPicker(index,0),pointItem(device,'hours'));await assertPicker(await metricPicker(index,1),pointItem(device,'energy'))}
  }
  pass('two complete current/fixed/carousel cycles preserve every device main source, internal metric and six-second interval');
  stage='add/reorder/delete one device';await workflow().getByRole('button',{name:'＋ 添加设备与对应数据',exact:true}).click();assert.equal(await rows().count(),3);
  assert.ok((await rows().nth(2).locator(':scope > summary').innerText()).includes('缺少数据'));
  await choose(await mainPicker(2),pointItem(info.devices[2],'progress'));
  await (await openRow(2)).getByRole('button',{name:'上移',exact:true}).click();assert.ok((await rows().nth(1).locator(':scope > summary > b').innerText()).includes(info.devices[2].name));
  await (await openRow(1)).getByRole('button',{name:'下移',exact:true}).click();await (await openRow(2)).getByRole('button',{name:'移除设备',exact:true}).click();assert.equal(await rows().count(),2);
  for(const [index,device] of info.devices.slice(0,2).entries())await assertPicker(await mainPicker(index),pointItem(device,'progress'));
  pass('adding creates a genuinely missing row; real reorder/delete controls leave all other assignments intact');
  stage='clear and restore one main row';await setSeconds(2);await (await mainPicker(1)).getByLabel('选择具体数据',{exact:true}).selectOption('');
  assert.ok((await rows().nth(1).locator(':scope > summary').innerText()).includes('缺少数据'));
  await preview();await waitUntil(async()=>(await widget(ids.kpi).locator('.widget-binding-notice').allTextContents()).join(' ').includes('未选择对应数据'),15000,'actual running carousel shows missing B source');await shot('03-running-missing-row');await exitPreview();
  await choose(await mainPicker(1),pointItem(info.devices[1],'progress'));await assertPicker(await metricPicker(1,0),pointItem(info.devices[1],'hours'));
  stage='clear and restore one internal metric';await (await metricPicker(1,0)).getByLabel('选择具体数据',{exact:true}).selectOption('');
  await preview();await waitUntil(async()=>await widget(ids.kpi).locator('.widget-device-heading span').innerText()===info.devices[1].name,15000,'B selected in real preview');assert.match(await metricValue(ids.kpi,'运行时长').innerText(),/^(?:--|—)h$/);await shot('04-running-missing-metric');await exitPreview();
  await choose(await metricPicker(1,0),pointItem(info.devices[1],'hours'));
  await workflow().getByRole('button',{name:'不绑定主数据，显示固定内容（保留设备清单）',exact:true}).click();await workflow().getByRole('button',{name:modeNames.rotation}).click();
  assert.equal(await rows().count(),2);for(const [index,device] of info.devices.slice(0,2).entries())await assertPicker(await mainPicker(index),pointItem(device,'progress'));
  pass('clear/restore of a main row and of one internal metric never borrows another device; temporarily unbinding the main value retains the full list');
  let saved=await save(),savedKpi=saved.document.widgets.find(widget=>widget.id===ids.kpi);
  assert.equal(savedKpi.data.bindingVersion,2);assert.equal(savedKpi.data.rotationIntervalMs,2000);assert.deepEqual(savedKpi.data.deviceBindings.map(row=>row.deviceId),info.devices.slice(0,2).map(device=>device.id));
  for(const [index,device] of info.devices.slice(0,2).entries()){assert.equal(savedKpi.data.deviceBindings[index].binding.pointId,info.points[device.id].progress.id);for(const [metricIndex,key] of ['hours','energy'].entries())assert.equal(savedKpi.content.items[metricIndex].binding.deviceBindings.find(row=>row.deviceId===device.id).binding.pointId,info.points[device.id][key].id)}
  fs.writeFileSync(path.join(directory,'saved-device-bindings.json'),JSON.stringify(savedKpi,null,2));
  await page.reload();await readyDesigner();await view('factory_overview');await selectWidget(ids.kpi);
  assert.equal(await workflow().getByRole('button',{name:modeNames.rotation}).getAttribute('aria-pressed'),'true');assert.equal(await workflow().getByLabel('每项显示秒数',{exact:true}).inputValue(),'2');
  for(const [index,device] of info.devices.slice(0,2).entries()){await assertPicker(await mainPicker(index),pointItem(device,'progress'));await assertPicker(await metricPicker(index,0),pointItem(device,'hours'));await assertPicker(await metricPicker(index,1),pointItem(device,'energy'))}
  await audit('05-reopened-config-1600',1600,1000);await audit('06-reopened-config-1280',1280,800);await page.setViewportSize({width:1600,height:1000});
  await view('map_world');await selectWidget(ids.kpi);assert.equal(await rows().count(),2);await assertPicker(await mainPicker(1),pointItem(info.devices[1],'progress'));await shot('07-existing-v2-map-editor');
  pass('real save/reload restores category/table/field, each internal metric, row order and timing; existing v2 device rows remain the editor on a map view');
  stage='current device and missing current-device row';await view('factory_overview');await preview();await widget(ids.current).getByRole('status').filter({hasText:'未选择当前查看设备'}).waitFor();await shot('08-no-current-device');await exitPreview();
  await view(info.devices[3].viewId);await preview();await widget(ids.current).getByRole('status').filter({hasText:'未选择对应数据'}).waitFor();assert.doesNotMatch(await widget(ids.current).locator('.value-widget-body > strong').innerText(),/0\.0/);await shot('09-current-device-missing-row');await exitPreview();
  await view(info.devices[0].viewId);await preview();await waitUntil(async()=>/^0\.0\s*%$/.test(await widget(ids.current).locator('.value-widget-body > strong').innerText()),10000,'current A shows actual zero');await exitPreview();
  pass('real view selection + interactive renderer clearly distinguishes no current device, a missing D row and the valid zero-valued A row');
  stage='actual alarm table and authored filters';await view('factory_overview');await selectWidget(ids.alarm);
  const eventItem=catalog.items.find(item=>item.id==='internal_event_records');assert.ok(eventItem);await choose(workflow().getByRole('region',{name:'数据中心选取数据',exact:true}),eventItem);
  assert.ok((await workflow().innerText()).includes('真实报警／事件记录'));
  await workflow().getByLabel(/^级别/).selectOption('warning');await waitUntil(async()=>(await widget(ids.alarm).innerText()).includes('A炉真实警告'),10000,'stored warning rendered');assert.ok(!(await widget(ids.alarm).innerText()).includes('B炉真实严重报警'));
  await workflow().getByLabel(/^记录范围/).selectOption('current');await waitUntil(async()=>await widget(ids.alarm).locator('.hud-module-alarm-list li').count()===0,6000,'no current device means no foreign events');
  await view(info.devices[0].viewId);await selectWidget(ids.alarm);await waitUntil(async()=>(await widget(ids.alarm).innerText()).includes('A炉真实警告'),6000,'current A warning');
  await view(info.devices[1].viewId);await selectWidget(ids.alarm);await waitUntil(async()=>await widget(ids.alarm).locator('.hud-module-alarm-list li').count()===0,6000,'B has no warning');
  await workflow().getByLabel(/^级别/).selectOption('critical');await waitUntil(async()=>(await widget(ids.alarm).innerText()).includes('B炉真实严重报警'),6000,'current B critical event');await shot('10-real-alarm-source-and-filter');
  await workflow().getByLabel(/^记录范围/).selectOption('factory');await workflow().getByLabel(/^级别/).selectOption('');
  assert.ok(!(await widget(ids.alarm).innerText()).includes('外厂记录不得显示'));
  pass('alarm entry selects the real stored event table; severity and current/factory filters update actual events and never show another factory');
  stage='global main with explicitly scoped independent metrics';await view('factory_overview');await selectWidget(ids.global);
  const mainBefore=(await api('/platform/designer')).document.widgets.find(widget=>widget.id===ids.global).data;
  const globalMetrics=workflow().locator('.global-panel-metrics > .panel-metric-source');assert.equal(await globalMetrics.count(),2);
  const mainOptions=await workflow().locator(':scope > .data-catalog-picker').getByLabel('选择具体数据',{exact:true}).locator('option').evaluateAll(options=>options.map(option=>option.value));assert.ok(!mainOptions.some(id=>catalog.items.find(item=>item.id===id)?.binding.mode==='plc'));
  await globalMetrics.nth(0).getByLabel('指标 1 数据范围',{exact:true}).selectOption('fixed');assert.equal(await globalMetrics.nth(0).getByLabel('指标 1 指定设备',{exact:true}).inputValue(),'');assert.equal(await globalMetrics.nth(0).getByRole('region',{name:'数据中心选取数据',exact:true}).count(),0);
  await shot('11-global-metric-needs-explicit-device');await globalMetrics.nth(0).getByLabel('指标 1 指定设备',{exact:true}).selectOption(info.devices[0].id);await choose(globalMetrics.nth(0).getByRole('region',{name:'数据中心选取数据',exact:true}),pointItem(info.devices[0],'hours'));
  const energyItem=catalog.items.find(item=>item.binding?.datasetId===fixture.dataset.id&&item.binding.datasetField==='energy');assert.ok(energyItem);await choose(globalMetrics.nth(1).getByRole('region',{name:'数据中心选取数据',exact:true}),energyItem);
  await view(info.devices[3].viewId);await preview();await waitUntil(async()=>await metricValue(ids.global,'指定炉运行时长').innerText()==='12h'&&await metricValue(ids.global,'全厂耗电量').innerText()==='456kWh',12000,'global card independently reads fixed A and real global table while D is selected');await shot('12-global-fixed-metric-runtime');await exitPreview();
  await selectWidget(ids.global);await audit('13-global-metrics-1600',1600,1000);await audit('14-global-metrics-1280',1280,800);await page.setViewportSize({width:1600,height:1000});
  saved=await save();const globalSaved=saved.document.widgets.find(widget=>widget.id===ids.global);
  assert.deepEqual(globalSaved.data,mainBefore);assert.equal(globalSaved.content.items[0].binding.deviceScope,'fixed');assert.equal(globalSaved.content.items[0].binding.deviceId,info.devices[0].id);assert.equal(globalSaved.content.items[1].binding.deviceScope,'global');
  fs.writeFileSync(path.join(directory,'saved-global-bindings.json'),JSON.stringify(globalSaved,null,2));
  await page.reload();await readyDesigner();await view('factory_overview');await selectWidget(ids.global);
  assert.equal(await workflow().getByLabel('指标 1 指定设备',{exact:true}).inputValue(),info.devices[0].id);await assertPicker(workflow().locator('.global-panel-metrics > .panel-metric-source').nth(0).getByRole('region',{name:'数据中心选取数据',exact:true}),pointItem(info.devices[0],'hours'));
  await assertPicker(workflow().locator('.global-panel-metrics > .panel-metric-source').nth(1).getByRole('region',{name:'数据中心选取数据',exact:true}),energyItem);
  pass('global HUD metrics have their own explicit fixed device or real global table; no first-device guess, no inherited D, no main-source change, complete reopened selection');
  stage='final completed binding evidence';await view('factory_overview');await selectWidget(ids.kpi);
  await waitUntil(async()=>await page.locator('.designer-validation-issues').count()===0,10000,'completed binding configuration has no remaining diagnostic');
  for(const row of await rows().all())if(await row.getAttribute('open')!==null)await row.locator(':scope > summary').click();
  const finalSummaries=[];
  for(const [index,device] of info.devices.slice(0,2).entries()){
    const summary=await rows().nth(index).locator(':scope > summary').innerText();finalSummaries.push(summary);
    assert.ok(summary.includes(info.points[device.id].progress.tag));assert.ok(summary.includes(`${info.points[device.id].progress.value}%`));assert.ok(summary.includes('正常'));
  }
  await audit('17-final-source-rows-1600',1600,1000,'rows');
  await audit('18-final-source-rows-1280',1280,800,'rows');
  await page.getByRole('button',{name:'收起左侧面板',exact:true}).click();
  await audit('19-final-source-rows-1280-left-collapsed',1280,800,'rows');
  const focused=path.join(directory,'20-final-source-inspector-1280.png');await page.locator('.designer-right-panel').screenshot({path:focused});screenshots.push(focused);
  await page.getByRole('button',{name:'展开左侧面板',exact:true}).click();await page.setViewportSize({width:1600,height:1000});
  fs.writeFileSync(path.join(directory,'final-source-summaries.json'),JSON.stringify({summaries:finalSummaries,remainingDiagnostics:await page.locator('.designer-validation-issues').count()},null,2));
  pass('completed saved/reopened editor has no residual diagnostic; two collapsed PLC rows visibly show distinct addresses, zero/current values and quality at both viewport sizes and with the left pane collapsed');
  stage='publish through UI and verify real map runtime';const releaseResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/platform/releases'&&response.request().method()==='POST');await page.getByRole('button',{name:'保存并发布',exact:true}).click();const release=await releaseResponse;assert.equal(release.status(),200,await release.text());
  runtime=await context.newPage();runtime.setDefaultTimeout(20000);runtime.on('pageerror',error=>errors.push(error.message));await runtime.goto(info.origin+'/group');await widget(ids.kpi,runtime).waitFor();
  for(const device of info.devices.slice(0,2)){
    await waitUntil(async()=>await widget(ids.kpi,runtime).locator('.widget-device-heading span').innerText()===device.name,16000,'published explicit device '+device.id);
    assert.equal(await widget(ids.kpi,runtime).locator('.hud-module-ring-copy strong').innerText(),`${info.points[device.id].progress.value}%`);
    assert.equal(await metricValue(ids.kpi,'运行时长',runtime).innerText(),`${info.points[device.id].hours.value}h`);assert.equal(await metricValue(ids.kpi,'耗电量',runtime).innerText(),`${info.points[device.id].energy.value}kWh`);
  }
  await widget(ids.current,runtime).getByRole('status').filter({hasText:'未选择当前查看设备'}).waitFor();
  await waitUntil(async()=>await metricValue(ids.global,'指定炉运行时长',runtime).innerText()==='12h'&&await metricValue(ids.global,'全厂耗电量',runtime).innerText()==='456kWh',12000,'published global/fixed independent metrics');
  await shot('15-published-real-frames-1600',runtime);await runtime.setViewportSize({width:1280,height:800});await shot('16-published-real-frames-1280',runtime);
  pass('published WebView uses actual owned websocket frames and stored release: A/B main values and both internal metrics stay paired, zero preserved, global/fixed metrics independent, current mode does not secretly rotate');
  assert.deepEqual(errors,[]);assert.deepEqual(guardViolations,[]);assert.ok(!writes.some(write=>/\/(?:write|plc-write|restart)$/.test(write.path)),'no PLC write or runtime restart was used');
  const result={success:true,directory,checks,screenshots,audits,errors,guardViolations,writes,fixtureDatabase:info.database,fixtureBackendPid:info.backendPid,helperPid:server.pid,collectorFalse:true,noPhysicalPLC:true,siteUntouched:true,realUIInput:true,publishedRuntime:'owned read-only websocket frames + prepared global HTTP table',sourceAudit:await fetch(info.sourceOrigin+'/audit').then(response=>response.json())};
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({success:true,directory,checks:checks.length,screenshots},null,2));
})().catch(async error=>{
  const failure={success:false,stage,error:error.stack,checks,screenshots,audits,errors,guardViolations,directory,fixtureDatabase:info?.database,fixtureBackendPid:info?.backendPid};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(failure,null,2));
  await shot('failure',page).catch(()=>{});console.error(JSON.stringify({stage,directory,error:error.stack,errors,guardViolations},null,2));process.exitCode=1;
}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
