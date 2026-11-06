// Owns its backend, DB, browser and native-bridge fixture. Never edits site data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createRunDirectory, startLoggedProcess, waitUntil} = require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess} = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('component-visibility-ui');
let server, browser, page, info;
const errors = [], checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
async function api(route, method = 'GET', data) {
  const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
  const response = await page.request.fetch(info.origin + '/api' + route, {method,
    headers:{Origin:info.origin, 'X-Admin-Request':'1', 'X-CSRF-Token':session.csrfToken},
    ...(data === undefined ? {} : {data})});
  assert.equal(response.status(), 200, await response.text());
  return response.json();
}
async function status(id, visible, reason) {
  const badge = page.locator(`[data-component-id="${id}"] .component-display-badge`);
  await badge.waitFor();
  await waitUntil(async () => (await badge.textContent()) === (visible ? '显示' : '隐藏'), 4000, id + ' status');
  if (reason) assert.match(await badge.getAttribute('title'), reason);
}
async function hostContext(native, viewId, viewMode, extra = {}) {
  await native.evaluate(payload => { for (const fn of window.ownedHandlers) fn({data:{type:'overlay_host_state',visible:true,context:payload}}); },
    {factoryId:'factory_default',sceneReady:true,viewId,viewMode,...extra});
}
(async () => {
  const infoFile = path.join(directory, 'server.json');
  server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
    cwd:path.resolve(__dirname, '..'), env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'backend.log')});
  await waitUntil(() => { assert.equal(server.exitCode,null); return fs.existsSync(infoFile); }, 60000, 'owned backend');
  info = JSON.parse(fs.readFileSync(infoFile));
  browser = await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),args:['--enable-unsafe-swiftshader']});
  const context = await browser.newContext({viewport:{width:1600,height:1050}});
  await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({activeTab:'platform',platformSubpage:'designer'})));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror',e=>errors.push(e.message));
  await page.goto(info.origin + '/admin');
  await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);
  await page.getByLabel('后台密码',{exact:true}).fill(info.password);
  await page.getByRole('button',{name:'解锁后台',exact:true}).click();
  await page.locator('.dashboard-designer-shell').waitFor();
  const state = await api('/platform/designer');
  const {createDashboardWidget} = await import('../frontend/src/runtime/dashboardSchema.js');
  const make = (type,id,index,patch={}) => ({...createDashboardWidget(type,index,{x:30+index*125,y:30+index*70}),id,title:id,...patch});
  const widgets = [
    make('return_button','widget_return_button',0,{runtimeTarget:'unity'}),
    make('navigation','widget_navigation',1,{runtimeTarget:'unity',content:{showTitle:false,projectLabel:'导航验收',statusText:'运行中'},visibility:{viewModes:['factory','custom']}}),
    make('text','visible_text',2,{content:{text:'实时读数',showTitle:false}}),
    make('text','manual_hidden',3,{visible:false,content:{text:'手动隐藏'}}),
    make('text','rule_hidden',4,{visibility:{rules:[{path:'viewMode',operator:'==',value:'device'}]},content:{text:'设备条件'}}),
    make('text','group_hidden',5,{groupId:'audit_group',content:{text:'组隐藏'}}),
    make('text','view_restricted',6,{visibility:{viewIds:['device_detail']},content:{text:'指定视角'}}),
    make('button','event_hide',7,{content:{text:'隐藏读数'},events:[{trigger:'click',action:'set_visibility',targetType:'widget',targetId:'visible_text',visibility:'hide'}]}),
    make('navigation','line_navigation',8,{content:{showTitle:false,projectLabel:'',statusText:''},visibility:{viewModes:['line']},events:[{trigger:'click',action:'toggle_visibility',targetType:'widget',targetId:'visible_text'}]}),
    make('return_button','second_return',9,{visibility:{viewModes:['line']}})
  ];
  state.document.widgets=widgets;
  state.document.metadata={...state.document.metadata,unifiedMapDesigner:1};
  state.document.scene.defaultViewId='factory_overview';
  const componentState={show:widgets.map(w=>w.id),hide:['group:audit_group']};
  const view=(id,name,mode,targetType,parentViewId='',targetId='')=>({id,name,mode,targetType,parentViewId,returnViewId:parentViewId,targetId,componentState:structuredClone(componentState)});
  state.document.scene.views=[view('map_world','全球地图','custom','factory'),view('factory_overview','全厂总览','factory','factory'),view('line_overview','产线视角','line','line','factory_overview','audit_line'),view('device_detail','设备实体视角','device','device','line_overview',info.devices[0])];
  await api('/platform/designer/draft','PUT',{sceneId:state.document.sceneId,document:state.document,expectedRevision:state.revision});
  await api('/platform/releases','POST',{sceneId:state.document.sceneId,notes:'Owned component visibility fixture'});
  await page.reload(); await page.locator('.dashboard-designer-shell').waitFor();
  const tree=page.getByRole('tree',{name:'视角层级',exact:true});
  await tree.locator('[data-view-id="factory_overview"] .view-tree-select').click();
  await page.getByRole('combobox',{name:'组件显隐范围',exact:true}).selectOption('all');
  await status('widget_return_button',false,/首层/);
  await status('widget_navigation',true);
  await status('visible_text',true);
  await status('manual_hidden',false,/手动/);
  await status('rule_hidden',false,/条件/);
  await status('group_hidden',false,/当前视角/);
  await status('view_restricted',false,/指定视角/);
  assert.equal(await page.locator('.component-display-badge').evaluateAll(nodes=>nodes.every(el=>el.scrollWidth<=el.clientWidth+1 && getComputedStyle(el).whiteSpace==='nowrap')),true);
  pass('every component has a display state; automatic/manual/group/view/rule hides have distinct reasons');
  await page.locator('[data-component-id="widget_return_button"]').click();
  const detail=page.getByRole('status',{name:'组件大屏显隐',exact:true});
  await detail.waitFor(); assert.match(await detail.textContent(),/首层视角自动隐藏返回键/);
  assert.equal(await page.getByRole('checkbox',{name:'启用组件显示',exact:true}).isChecked(),true);
  await page.locator('[data-widget-id="widget_return_button"]').waitFor(); // editable ghost remains selectable
  await page.getByRole('combobox',{name:'组件显隐范围',exact:true}).selectOption('hidden');
  assert.equal(await page.locator('[data-component-id="visible_text"]').count(),0);
  await status('widget_return_button',false,/首层/);
  await page.getByRole('combobox',{name:'组件显隐范围',exact:true}).selectOption('all');
  await page.locator('[data-component-id="manual_hidden"]').click();
  await page.getByRole('checkbox',{name:'启用组件显示',exact:true}).check();
  await status('manual_hidden',true);
  await page.getByRole('checkbox',{name:'启用组件显示',exact:true}).uncheck();
  await status('manual_hidden',false,/手动/);
  await page.screenshot({path:path.join(directory,'01-designer-visibility.png')});
  pass('hidden components remain selectable/editable; explicit manual toggle does not rewrite automatic rules');
  await tree.locator('[data-view-id="line_overview"] .view-tree-select').click();
  await status('widget_return_button',true);
  await status('widget_navigation',false,/类型/);
  await tree.locator('[data-view-id="device_detail"] .view-tree-select').click();
  await status('widget_return_button',true);
  await status('rule_hidden',true);
  await status('view_restricted',true);
  await tree.locator('[data-view-id="factory_overview"] .view-tree-select').click();
  pass('switching factory/line/device recomputes visibility immediately, including the preserved root return policy');
  await page.getByRole('button',{name:'全屏预览当前视角',exact:true}).click();
  await page.locator('.dashboard-designer-shell.is-preview').waitFor();
  assert.equal(await page.locator('.designer-widget[data-widget-id="widget_return_button"]').count(),0);
  for(const id of ['manual_hidden','rule_hidden','group_hidden','view_restricted']) assert.equal(await page.locator(`.designer-widget[data-widget-id="${id}"]`).count(),0);
  await page.locator('.designer-widget[data-widget-id="visible_text"]').waitFor();
  await page.locator('.designer-widget[data-widget-id="event_hide"]').click();
  await page.locator('.designer-widget[data-widget-id="visible_text"]').waitFor({state:'hidden'});
  await page.locator('.fullscreen-exit-button').click();
  await page.locator('.dashboard-designer-shell:not(.is-preview)').waitFor();
  await status('visible_text',false,/事件/);
  await page.locator('[data-widget-id="visible_text"]').waitFor();
  pass('actual designer preview and event hides follow runtime visibility; returning to editing retains hidden components for editing');
  const native=await context.newPage(); native.on('pageerror',e=>errors.push(e.message));
  await native.addInitScript(()=>{window.ownedHandlers=[];window.chrome={webview:{postMessage(){},addEventListener(name,fn){if(name==='message')window.ownedHandlers.push(fn)},removeEventListener(){}}}});
  await native.route('**/api/health',async route=>{const response=await route.fetch(),body=await response.json();body.readiness={...body.readiness,displayReady:true};await route.fulfill({response,json:body});});
  await native.goto(info.origin+'/overlay?embedded=unity&surface=overlay&scene=1');
  await native.locator('.dashboard-overlay-root').waitFor({state:'attached'});
  await hostContext(native,'factory_overview','factory');
  await native.locator('[data-widget-id="visible_text"]').waitFor();
  await native.getByRole('status',{name:'大屏正在加载',exact:true}).waitFor({state:'hidden'});
  assert.equal(await native.locator('.overlay-return-widget').count(),0);
  await native.locator('.overlay-navigation').waitFor();
  for(const id of ['manual_hidden','rule_hidden','group_hidden','view_restricted']) assert.equal(await native.locator(`[data-widget-id="${id}"]`).count(),0);
  await hostContext(native,'line_overview','line',{lineId:'audit_line'});
  await native.locator('[data-widget-id="widget_return_button"] .overlay-line-return').waitFor();
  await native.locator('[data-widget-id="second_return"] .overlay-line-return').waitFor();
  await waitUntil(async()=>await native.locator('.overlay-navigation[data-widget-id="widget_navigation"]').count()===0,4000,'navigation view filter');
  const lineNav=native.locator('.overlay-navigation[data-widget-id="line_navigation"]');
  await lineNav.waitFor(); assert.equal((await lineNav.textContent()).trim(),'');
  await lineNav.locator('button').click(); await native.locator('[data-widget-id="visible_text"]').waitFor({state:'hidden'});
  await lineNav.locator('button').click(); await native.locator('[data-widget-id="visible_text"]').waitFor();
  await hostContext(native,'device_detail','device',{deviceId:info.devices[0],lineId:'audit_line',inspectionStage:'solid'});
  await native.locator('[data-widget-id="rule_hidden"]').waitFor();
  await native.locator('[data-widget-id="view_restricted"]').waitFor();
  await hostContext(native,'factory_overview','factory',{deviceId:'',inspectionStage:''});
  await native.locator('[data-widget-id="event_hide"]').click();
  await native.locator('[data-widget-id="visible_text"]').waitFor({state:'hidden'});
  await native.screenshot({path:path.join(directory,'02-native-visibility.png')});
  pass('published native HUD matches editor statuses, keeps root return hidden, and applies navigation rules and event hides');
  pass('additional authored navigation/return instances render independently; blank text and authored click actions are honored');
  const map=await context.newPage(); map.on('pageerror',e=>errors.push(e.message));
  await map.goto(info.origin+'/group');
  await map.locator('.map-surface-widget-layer [data-widget-id="widget_navigation"]').waitFor();
  for(const id of ['manual_hidden','rule_hidden','group_hidden','view_restricted']) assert.equal(await map.locator(`.map-surface-widget-layer [data-widget-id="${id}"]`).count(),0);
  pass('map view obeys the same view/group/rule/manual policies and accepts legacy Unity-tagged WebView navigation');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));
  console.log(directory);
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack);console.error('Browser errors: '+JSON.stringify([...new Set(errors)].slice(0,6)));process.exitCode=1;})
  .finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});
