// Owned backend, upstream and browser. Does not refresh the running desktop.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwright=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('cimpro-integration-ui'),errors=[],checks=[];let server,upstream,browser,page,info;
const check=name=>{checks.push(name);console.log('PASS '+name)};
async function api(route,method='GET',data,p=page,expected=200){
 const session=await(await p.request.get(info.origin+'/api/admin-auth/session')).json();
 const response=await p.request.fetch(info.origin+'/api'+route,{method,headers:{Origin:info.origin,'X-Admin-Request':'1','X-CSRF-Token':session.csrfToken},...(data===undefined?{}:{data})});
 assert.equal(response.status(),expected,await response.text());return response.json();
}
async function login(context,username=info.username,state={activeTab:'settings',settingsSubpage:'database'}){
 await context.addInitScript(state=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify(state)),state);
 const p=await context.newPage();p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));await p.goto(info.origin+'/admin');
 await p.getByRole('textbox',{name:'账号',exact:true}).fill(username);await p.getByLabel('后台密码',{exact:true}).fill(info.password);await p.getByRole('button',{name:'解锁后台',exact:true}).click();
 if(state.activeTab==='platform')await p.locator('.dashboard-designer-shell').waitFor();else await p.getByRole('tab',{name:'外部数据源',exact:true}).waitFor();return p;
}
(async()=>{
 const infoFile=path.join(directory,'server.json');server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>fs.existsSync(infoFile),60000,'owned backend');info=JSON.parse(fs.readFileSync(infoFile));
 const requests=[];
 upstream=http.createServer((req,res)=>{const batch=new URL(req.url,'http://localhost').searchParams.get('batch');requests.push(batch);res.writeHead(200,{'Content-Type':'application/json'});setTimeout(()=>res.end(JSON.stringify({data:[{batch,temperature:batch==='B'?850:batch==='SLOW'?100:batch==='FAST'?900:0}]})),batch==='SLOW'?600:0)});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 page=await login(await browser.newContext({viewport:{width:1600,height:1000}}),undefined,{activeTab:'platform',platformSubpage:'designer'});
 await page.getByRole('button',{name:'接口与参数',exact:true}).click();let panel=page.getByRole('dialog',{name:'接口与参数',exact:true});
 await panel.getByRole('button',{name:'＋ 添加参数',exact:true}).click();await panel.getByLabel('参数标识 1',{exact:true}).fill('batch');await panel.getByLabel('参数名称 1',{exact:true}).fill('生产批次');await panel.getByLabel('参数默认值 1',{exact:true}).fill('A');
 await panel.getByRole('button',{name:'＋ 添加参数',exact:true}).click();await panel.getByLabel('参数标识 2',{exact:true}).fill('minimum');await panel.getByLabel('参数名称 2',{exact:true}).fill('起始值');await panel.getByLabel('参数类型 2',{exact:true}).selectOption('number');
 await panel.getByRole('button',{name:'应用到草稿',exact:true}).click();await panel.getByText('已应用到草稿',{exact:true}).waitFor();await panel.screenshot({path:path.join(directory,'01-global-parameters.png')});
 await page.setViewportSize({width:1000,height:768});assert.ok(await panel.evaluate(el=>el.scrollWidth<=el.clientWidth));await panel.screenshot({path:path.join(directory,'01-parameters-compact.png')});await page.setViewportSize({width:1600,height:1000});
 await panel.getByRole('button',{name:'关闭接口与参数',exact:true}).click();await page.getByRole('button',{name:'保存草稿',exact:true}).click();await waitUntil(async()=>((await api('/platform/designer')).document.parameters || []).length===2,10000,'saved parameter definitions');
 check('actual designer UI creates typed global parameters and saves them to the server draft');
 const connection=(await api('/data-sources/connections','POST',{name:'ERP 批次接口',sourceType:'http_api',authType:'none',baseUrl:`http://127.0.0.1:${upstream.address().port}/`,enabled:true})).connection;
 const definition=(await api('/data-sources/datasets','POST',{name:'批次温度',connectionId:connection.id,source:'http',rootPath:'data',refreshMs:1000,request:{method:'GET',path:'/batch',parameters:[{name:'batch',in:'query',source:'parameter',key:'batch',type:'string'}]},columns:[{name:'temperature',path:'temperature',label:'实际温度',type:'number',role:'value',unit:'°C'}]})).dataset;
 const sourcePage=await login(await browser.newContext({viewport:{width:1366,height:900}}));await sourcePage.getByRole('tab',{name:'外部数据源',exact:true}).click();await sourcePage.locator('.source-workspace .workspace-tabs').getByRole('button',{name:'数据集',exact:true}).click();
 const editor=sourcePage.locator('.dataset-workspace');await editor.getByLabel('数据集名称',{exact:true}).fill('批次温度 ERP');await editor.getByRole('tab',{name:'参数与匹配',exact:true}).click();assert.equal(await editor.getByLabel('全局参数标识 1',{exact:true}).inputValue(),'batch');await editor.getByRole('button',{name:'保存数据集',exact:true}).click();await editor.getByText('已保存',{exact:true}).waitFor();
 await editor.getByRole('tab',{name:'数据预览',exact:true}).click();await editor.getByLabel('预览参数 batch',{exact:true}).fill('B');await editor.getByRole('button',{name:'读取预览',exact:true}).click();await editor.getByRole('cell',{name:'850',exact:true}).waitFor();await editor.screenshot({path:path.join(directory,'02-source-global-parameter.png')});await sourcePage.close();
 check('actual source workspace preserves a global parameter binding and previews the external ERP result');
 const designer=await api('/platform/designer'),{createDashboardWidget}=await import('../frontend/src/runtime/dashboardSchema.js');
 const filter=createDashboardWidget('filter',0,{x:160,y:160});filter.id='batch_filter';filter.title='生产批次';filter.content={...filter.content,parameterKey:'batch',control:'select',options:[{label:'批次 A',value:'A'},{label:'批次 B',value:'B'}]};
 const value=createDashboardWidget('value',1,{x:160,y:300});value.id='batch_temperature';value.title='批次温度';value.data={...value.data,mode:'dataset',datasetId:definition.id,datasetField:'temperature',datasetMode:'first',deviceScope:'current'};
 designer.document.widgets.push(filter,value);for(const view of designer.document.scene.views){view.componentState ||= {show:[],hide:[]};view.componentState.show ||= [];view.componentState.show.push(filter.id,value.id)}
 await api('/platform/designer/draft','PUT',{sceneId:designer.document.sceneId,document:designer.document,expectedRevision:designer.revision});await api('/platform/releases','POST',{sceneId:designer.document.sceneId,notes:'Owned parameter / SDK acceptance'});
 const runtime=params=>api('/data-sources/runtime-values?'+new URLSearchParams({scene_id:designer.document.sceneId,view_id:'factory_overview',parameters:JSON.stringify(params)}));
 assert.equal((await runtime({batch:'A'})).values[value.id].value,0);assert.equal((await runtime({batch:'B'})).values[value.id].value,850);
 await api('/data-sources/runtime-values?'+new URLSearchParams({parameters:'{bad'}),'GET',undefined,page,400);await api('/data-sources/runtime-values?'+new URLSearchParams({parameters:JSON.stringify({undeclared:'x'})}),'GET',undefined,page,400);
 check('publish preserves parameters and filters, live API resolves A/B including zero and rejects malformed or undeclared parameters');
 // A new browser page reads only the published runtime, not the designer draft.
 const runtimePage=await page.context().newPage();runtimePage.on('pageerror',e=>errors.push(e.message));await runtimePage.goto(info.origin+'/group');await runtimePage.waitForFunction(()=>!!window.DigitalTwin);await runtimePage.evaluate(()=>window.DigitalTwin.ready());
 const select=runtimePage.locator('.map-surface-widget-layer').getByRole('combobox',{name:'生产批次',exact:true});await select.waitFor();
 await select.selectOption('1');await waitUntil(async()=>await runtimePage.locator('.map-surface-widget-layer').innerText().then(t=>t.includes('850')),10000,'runtime B parameter result');
 await runtimePage.screenshot({path:path.join(directory,'02-published-filter-B.png')});assert.ok(requests.includes('B'));
 await runtimePage.evaluate(async()=>{window.ownedEvents=[];window.ownedOff=window.DigitalTwin.on('parametersChanged',p=>window.ownedEvents.push(p));await window.DigitalTwin.setParameters({batch:'A',minimum:0})});
 await waitUntil(async()=>await select.inputValue()==='0',10000,'SDK synchronizes filter');assert.equal(await runtimePage.evaluate(()=>window.ownedEvents.at(-1).minimum),0);
 await runtimePage.evaluate(()=>window.DigitalTwin.resetParameters());assert.equal(await runtimePage.evaluate(async()=>(await window.DigitalTwin.getParameters()).batch),'A');
 const denied=await runtimePage.evaluate(async()=>{try{await window.DigitalTwin.setParameters({undeclared:'bad'});return false}catch{return true}});assert.equal(denied,true);
 const context=await runtimePage.evaluate(()=>window.DigitalTwin.getContext());assert.ok(!('csrfToken' in context));
 const navigationCount=await runtimePage.evaluate(()=>performance.getEntriesByType('navigation').length);
 await runtimePage.evaluate(()=>window.DigitalTwin.setParameters({batch:'SLOW'}));await waitUntil(()=>requests.includes('SLOW'),10000,'slow upstream request');await runtimePage.evaluate(()=>window.DigitalTwin.setParameters({batch:'FAST'}));
 await waitUntil(async()=>await runtimePage.locator('.map-surface-widget-layer').innerText().then(t=>t.includes('900')),10000,'fast response');await new Promise(resolve=>setTimeout(resolve,750));assert.ok((await runtimePage.locator('.map-surface-widget-layer').innerText()).includes('900'));assert.equal(await runtimePage.evaluate(()=>performance.getEntriesByType('navigation').length),navigationCount);
 check('late parameter responses cannot replace the latest component value and parameter changes do not navigate/reload the runtime');
 await runtimePage.reload();await runtimePage.waitForFunction(()=>!!window.DigitalTwin);assert.equal(await runtimePage.evaluate(async()=>{await window.DigitalTwin.ready();return (await window.DigitalTwin.getParameters()).batch}),'A');
 check('published map filter and same-window SDK drive real upstream data without reloading the page, typed callbacks stay synchronized and restart restores published defaults');
 await runtimePage.close();await page.reload();await page.locator('.dashboard-designer-shell').waitFor();
 await page.getByRole('button',{name:'接口与参数',exact:true}).click();panel=page.getByRole('dialog',{name:'接口与参数',exact:true});await panel.getByRole('tab',{name:'软件接口',exact:true}).click();await panel.getByRole('button',{name:/更新参数/}).click();await panel.getByLabel('软件接口调用参数',{exact:true}).fill(JSON.stringify([{batch:'B',minimum:0}]));await panel.getByRole('button',{name:'运行预览',exact:true}).click();await panel.getByLabel('接口执行结果',{exact:true}).filter({hasText:'"success": true'}).waitFor();
 await waitUntil(async()=>await page.locator('[data-widget-id="batch_temperature"]').innerText().then(t=>t.includes('850')),10000,'designer parameter refresh');
 await panel.screenshot({path:path.join(directory,'03-software-interface.png')});
 check('software interface panel invokes the actual designer preview; changing a parameter refreshes its dataset-backed component');
 assert.deepEqual(errors,[]);const result={success:true,checks,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))}});
