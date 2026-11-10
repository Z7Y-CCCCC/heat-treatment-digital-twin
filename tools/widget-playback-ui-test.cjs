// Owned backend, upstream and browser. Does not refresh the running desktop.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwright=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('widget-playback-ui'),errors=[],checks=[];let server,upstream,browser,page,info;
const check=name=>{checks.push(name);console.log('PASS '+name)};
async function api(route,method='GET',data,p=page,expected=200){
 const session=await(await p.request.get(info.origin+'/api/admin-auth/session')).json();
 const response=await p.request.fetch(info.origin+'/api'+route,{method,headers:{Origin:info.origin,'X-Admin-Request':'1','X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});
 assert.equal(response.status(),expected,await response.text());return response.json();
}
async function waitForDesigner(p){
 // The shell mounts before draft/point data and the independent view policy.
 // A real UI click must not race late selection restoration from either load.
 await p.locator('.dashboard-designer-shell').waitFor();
 await p.locator('.designer-loading').waitFor({state:'hidden'});
 await p.locator('.designer-canvas-scroll').waitFor();
 await waitUntil(async()=>await p.getByTestId('global-view-section').getByRole('switch',{name:'启用全部全局视角',exact:true}).isEnabled(),20000,'designer view policy ready');
}
async function login(context,username=info.username,state={activeTab:'settings',settingsSubpage:'database'}){
 await context.addInitScript(state=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify(state)),state);
 const p=await context.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));await p.goto(info.origin+'/admin');
 await p.getByRole('textbox',{name:'账号',exact:true}).fill(username);await p.getByLabel('后台密码',{exact:true}).fill(info.password);await p.getByRole('button',{name:'解锁后台',exact:true}).click();
 if(state.activeTab==='platform')await waitForDesigner(p);else await p.getByRole('tab',{name:'外部数据源',exact:true}).waitFor();return p;
}
(async()=>{
 const infoFile=path.join(directory,'server.json');server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_DISPLAY_ONLY:'true',MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>fs.existsSync(infoFile),60000,'owned backend');info=JSON.parse(fs.readFileSync(infoFile));
 const requests=[];upstream=http.createServer((req,res)=>{const id=new URL(req.url,'http://localhost').searchParams.get('device');requests.push({id,at:Date.now()});res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({rows:[0,1,2].map((n)=>({id,time:'样本'+(n+1),temperature:id===info.devices[0]?n:850+n,pressure:10+n,speed:100+n,open:10+n,close:12+n,low:8+n,high:15+n,min:8+n,q1:10+n,median:11+n,q3:12+n,max:15+n,x:'X'+n,y:'Y'+(n%2)}))}))});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 page=await login(await browser.newContext({viewport:{width:1600,height:1000}}),undefined,{activeTab:'platform',platformSubpage:'designer'});
 const source=(await api('/data-sources/connections','POST',{name:'设备参数接口',sourceType:'http_api',authType:'none',baseUrl:`http://127.0.0.1:${upstream.address().port}/`,enabled:true})).connection;
 const numbers=['temperature','pressure','speed','open','close','low','high','min','q1','median','q3','max'];
 const ds=(await api('/data-sources/datasets','POST',{name:'设备工艺',connectionId:source.id,source:'http',rootPath:'rows',refreshMs:1000,request:{method:'GET',path:'/read',parameters:[{name:'device',in:'query',source:'context',key:'deviceId'}]},columns:[...numbers.map(name=>({name,path:name,label:name,type:'number',role:name==='temperature'?'value':''})),{name:'time',path:'time',label:'时间',type:'string',role:'category'},{name:'x',path:'x',label:'X',type:'string'},{name:'y',path:'y',label:'Y',type:'string'}]})).dataset;
 const designer=await api('/platform/designer'),{createDashboardWidget}=await import('../frontend/src/runtime/dashboardSchema.js'),{DASHBOARD_CHARTS}=await import('../shared/dashboardCharts.mjs');
 const card=createDashboardWidget('value');card.id='rotation_card';card.title='轮播温度';card.frame={x:35,y:35,width:360,height:150,rotation:0};card.data={...card.data,mode:'dataset',datasetId:ds.id,datasetField:'temperature',deviceScope:'rotation',rotationDeviceIds:info.devices.slice(0,2),rotationIntervalMs:2000,refreshMs:1000};card.visibility.viewIds=['map_world','device_detail','device_exploded'];
 // Basic cards now opt into glass and retain their authored color. Declare the
 // exact material under test in this owned fixture rather than relying on the
 // obsolete implicit-purple override of every basic widget.
 const authoredGlassFixture={surfaceSkin:'glass',background:'rgba(88, 79, 137, 0.22)',backgroundOpacity:0.22,backdropFilter:'blur(12px) saturate(125%)'};
 card.style={...card.style,...authoredGlassFixture};
 const charts=DASHBOARD_CHARTS.map((chart,i)=>{const w=createDashboardWidget('trend',i+1);w.id='chart_'+chart.id;w.title=chart.label;w.frame={x:35+(i%5)*365,y:205+Math.floor(i/5)*210,width:350,height:195,rotation:0};w.data={...card.data,deviceScope:'fixed',deviceId:info.devices[0],datasetFields:['temperature','pressure','speed']};w.content={...w.content,chartType:chart.id,categoryField:'time',xField:chart.id==='heatmap'?'x':'pressure',yField:'y',heatValueField:'temperature',openField:'open',closeField:'close',lowField:chart.id==='boxplot'?'min':'low',highField:chart.id==='boxplot'?'max':'high',q1Field:'q1',medianField:'median',q3Field:'q3'};w.visibility.viewIds=['map_world'];return w});
 designer.document.widgets=[...designer.document.widgets.filter(w=>['navigation','return_button'].includes(w.type)),card,...charts];for(const v of designer.document.scene.views)v.componentState={show:[card.id,...(v.id==='map_world'?charts.map(w=>w.id):[])],hide:[]};
 await api('/platform/designer/draft','PUT',{sceneId:designer.document.sceneId,document:designer.document,expectedRevision:designer.revision});await api('/platform/releases','POST',{sceneId:designer.document.sceneId,notes:'Owned rotation, glass and chart acceptance'});
 const runtime=await page.context().newPage();runtime.on('pageerror',e=>errors.push(e.message));runtime.on('response',async response=>{if(response.url().includes('/runtime-values')&&!response.ok())console.log('READ_FAILURE',response.status(),(await response.text()).slice(0,300))});await runtime.goto(info.origin+'/group');await runtime.locator('.map-surface-widget-layer .widget-kind-value').waitFor();
 await waitUntil(()=>new Set(requests.map(r=>r.id)).has(info.devices[1]),14000,'second playback device');await new Promise(r=>setTimeout(r,2500));
 assert.ok(requests.some(r=>r.id===info.devices[0]) && requests.some(r=>r.id===info.devices[1]));
 const rotatingCard=runtime.locator('.map-surface-widget-layer .widget-kind-value');await waitUntil(async()=>(await rotatingCard.innerText()).includes('850'),18000,'visible B value');await waitUntil(async()=>(await rotatingCard.innerText()).includes('0.0'),18000,'visible A value');
 await waitUntil(async()=>await runtime.locator('.map-surface-widget-layer .widget-chart').evaluateAll(nodes=>nodes.length===20 && nodes.every(n=>n.querySelector('canvas'))),15000,'all chart families painted');
 const style=await runtime.locator('.map-surface-widget-layer .widget-kind-value').evaluate(el=>({bg:getComputedStyle(el).backgroundImage,color:getComputedStyle(el).backgroundColor,blur:getComputedStyle(el).backdropFilter,glass:el.classList.contains('widget-surface-glass')}));assert.equal(style.glass,true);assert.equal(style.color,'rgba(88, 79, 137, 0.22)');assert.match(style.blur,/blur\(12px\)/);
 await runtime.screenshot({path:path.join(directory,'01-all-charts.png')});
 const current=runtime.locator('.map-surface-widget-layer .widget-kind-value');
 await waitUntil(async()=>!(await current.getAttribute('class')).split(/\s+/).includes('data-pending')&&/0\.0|850/.test(await current.innerText()),18000,'ready playback card for screenshot');
 const cardScreenshotState=await current.evaluate(el=>({text:el.innerText,dataPending:el.classList.contains('data-pending')}));
 await current.screenshot({path:path.join(directory,'02-device-card.png')});
 const frames=requests.filter(r=>r.id===info.devices[0]);assert.ok(frames.length>=2,'selected device refreshed rather than one-time loading');
 check('real published WebView rotates two devices and refreshes their data; explicitly authored opt-in purple glass and all 20 chart families render without browser errors');
 const detail=await api('/data-sources/runtime-values?'+new URLSearchParams({view_id:'device_exploded',device_id:info.devices[0],widget_ids:card.id,playback_at:String(Date.now())}));assert.equal(detail.values[card.id].deviceId,info.devices[0]);assert.equal(detail.values[card.id].value,0);
 await api('/data-sources/runtime-values?'+new URLSearchParams({view_id:'device_detail',device_id:'FOREIGN',widget_ids:card.id,playback_at:String(Date.now())})).then(v=>assert.equal(v.values[card.id].quality,'bad'));
 check('device/inspection view locks to its selected device, preserves zero readings and rejects foreign targets');
 await runtime.close();await page.reload();await waitForDesigner(page);
 // The charts above deliberately retain their published legacy map bindings.
 // Create a fresh factory-view chart and exercise the new explicit row editor
 // with real UI selections, rather than mutating its Vue state from evaluate.
 const tree=page.getByRole('tree',{name:'视角层级',exact:true});
 const selectFactoryView=async()=>{
  const row=tree.locator('[data-view-id="factory_overview"]');await row.locator('.view-tree-select').click();
  await waitUntil(async()=>(await row.getAttribute('class')).split(/\s+/).includes('active'),10000,'selected factory view settled');
 };
 await selectFactoryView();
 await page.locator('.chart-library summary').click();assert.equal(await page.locator('.chart-library button').count(),20);
 await page.locator('.chart-library').getByRole('button',{name:'雷达图',exact:true}).click();
 const chartId=await page.locator('.designer-widget.selected[data-widget-id]').getAttribute('data-widget-id');assert.ok(chartId);
 const workflow=page.getByRole('region',{name:'组件数据设置',exact:true}),rows=workflow.locator('.device-data-row');await workflow.waitFor();
 await workflow.getByRole('button',{name:/^按清单轮播数据/}).click();assert.equal(await rows.count(),1);
 const catalog=await api('/data-center/catalog');
 const field=catalog.items.find(item=>item.binding?.datasetId===ds.id&&item.binding.datasetField==='temperature');assert.ok(field,'owned prepared dataset is available in the real catalog');
 const openRow=async index=>{const row=rows.nth(index);if(await row.getAttribute('open')===null)await row.locator(':scope > summary').click();return row};
 const chooseRow=async(index,deviceId)=>{
  const row=await openRow(index);await row.getByLabel(`清单设备 ${index+1}`,{exact:true}).selectOption(deviceId);
  const picker=row.getByRole('region',{name:'数据中心选取数据',exact:true});
  await picker.getByLabel('数据用途分类',{exact:true}).selectOption(field.categoryId);
  await picker.getByLabel('选择数据表',{exact:true}).selectOption(field.tableId);
  await picker.getByLabel('选择具体数据',{exact:true}).selectOption(field.id);
  await waitUntil(async()=>await picker.getByLabel('选择具体数据',{exact:true}).inputValue()===field.id,6000,'assigned field restored');
 };
 await chooseRow(0,info.devices[0]);await workflow.getByRole('button',{name:'＋ 添加设备与对应数据',exact:true}).click();
 assert.equal(await rows.count(),2);await chooseRow(1,info.devices[1]);
 await workflow.getByLabel('每项显示秒数',{exact:true}).fill('6');await workflow.getByLabel('每项显示秒数',{exact:true}).press('Tab');
 await workflow.getByLabel('数据表刷新（秒）',{exact:true}).fill('2');await workflow.getByLabel('数据表刷新（秒）',{exact:true}).press('Tab');
 await workflow.getByRole('button',{name:/^始终显示指定设备的数据/}).click();
 await workflow.getByLabel('指定数据设备',{exact:true}).selectOption(info.devices[1]);assert.equal(await rows.count(),1);
 await waitUntil(async()=>await rows.getByLabel('选择具体数据',{exact:true}).inputValue()===field.id,6000,'fixed source keeps its existing field');
 await workflow.getByRole('button',{name:/^显示当前查看设备的数据/}).click();assert.equal(await rows.count(),2);
 await workflow.getByRole('button',{name:/^按清单轮播数据/}).click();assert.equal(await rows.count(),2);
 assert.equal(await workflow.getByLabel('每项显示秒数',{exact:true}).inputValue(),'6');
 assert.equal(await workflow.getByLabel('数据表刷新（秒）',{exact:true}).inputValue(),'2');
 for(const [index,deviceId] of info.devices.slice(0,2).entries()){
  const row=await openRow(index);assert.equal(await row.getByLabel(`清单设备 ${index+1}`,{exact:true}).inputValue(),deviceId);
  await waitUntil(async()=>await row.getByLabel('选择具体数据',{exact:true}).inputValue()===field.id,6000,'mode switches preserve each assigned field');
 }
 const savedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/platform/designer/draft'&&response.request().method()==='PUT');
 await page.getByRole('button',{name:'保存草稿',exact:true}).click();const saved=await savedResponse;assert.equal(saved.status(),200,await saved.text());
 const state=await api('/platform/designer'),savedChart=state.document.widgets.find(widget=>widget.id===chartId);assert.ok(savedChart);
 assert.equal(savedChart.data.bindingVersion,2);assert.equal(savedChart.data.deviceScope,'rotation');assert.equal(savedChart.data.rotationIntervalMs,6000);assert.equal(savedChart.data.refreshMs,2000);
 assert.deepEqual(savedChart.data.deviceBindings.map(row=>row.deviceId),info.devices.slice(0,2));
 assert.ok(savedChart.data.deviceBindings.every(row=>row.binding.mode==='dataset'&&row.binding.datasetId===ds.id&&row.binding.datasetField==='temperature'));
 const editorScreenshots=[];
 const captureEditor=async(name,focus)=>{
  // A tall node screenshot gets clipped by the inspector's real scroll area
  // and can contain blank space. Capture the real viewport in two positions.
  for(const row of await rows.all())if(await row.getAttribute('open')!==null)await row.locator(':scope > summary').click();
  await (focus==='periods'?workflow.getByLabel('每项显示秒数',{exact:true}):workflow.locator(':scope > h4').first()).scrollIntoViewIfNeeded();
  const file=path.join(directory,name+'.png');await page.screenshot({path:file,fullPage:false});editorScreenshots.push(file);
 };
 await captureEditor('03-playback-editor');await captureEditor('03b-playback-periods','periods');
 await page.reload();await waitForDesigner(page);
 await selectFactoryView();await page.locator(`[data-component-id="${chartId}"]`).click();
 await workflow.waitFor();assert.equal(await workflow.getByRole('button',{name:/^按清单轮播数据/}).getAttribute('aria-pressed'),'true');
 assert.equal(await rows.count(),2);assert.equal(await workflow.getByLabel('每项显示秒数',{exact:true}).inputValue(),'6');assert.equal(await workflow.getByLabel('数据表刷新（秒）',{exact:true}).inputValue(),'2');
 for(const [index,deviceId] of info.devices.slice(0,2).entries()){
  const row=await openRow(index);assert.equal(await row.getByLabel(`清单设备 ${index+1}`,{exact:true}).inputValue(),deviceId);
  await waitUntil(async()=>await row.getByLabel('选择具体数据',{exact:true}).inputValue()===field.id,6000,'reopened row restores table and field');
  assert.equal(await row.getByLabel('选择数据表',{exact:true}).inputValue(),field.tableId);
 }
 await captureEditor('04-playback-reopened');await captureEditor('04b-playback-reopened-periods','periods');
 check('new explicit device/data-table/field rows retain both sources through fixed/current/carousel switches, keep independent 6s switching and 2s refresh periods, and restore completely after save/reopen');
 assert.deepEqual(errors,[]);const result={success:true,directory,checks,upstreamRequests:requests.length,authoredGlassFixture,computedGlass:style,cardScreenshotState,editorScreenshots,browserExecutable:process.env.BROWSER_EXECUTABLE || null};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))}});
