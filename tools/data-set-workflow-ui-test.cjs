// Owned backend, upstream and browser. Does not refresh the running desktop.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const playwright=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('data-set-workflow-ui'),errors=[],checks=[];let server,upstream,browser,page,info;
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
 upstream=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:info.devices[0],temperature:700,label:'设备A'},{id:info.devices[1],temperature:850,label:'设备B'}]}))});await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 page=await login(await browser.newContext({viewport:{width:1600,height:1000}}));
 const connection=(await api('/data-sources/connections','POST',{name:'ERP 接口',sourceType:'http_api',authType:'none',baseUrl:`http://127.0.0.1:${upstream.address().port}/`,enabled:true})).connection;
 await page.reload();await page.getByRole('tab',{name:'外部数据源',exact:true}).click();
 const workspace=page.locator('.source-workspace');await workspace.locator('.workspace-tabs').getByRole('button',{name:'数据集',exact:true}).click();
 const editor=page.locator('.dataset-workspace');await workspace.getByRole('button',{name:'＋ 新建数据集',exact:true}).click();
 await editor.getByLabel('数据集名称',{exact:true}).fill('井式炉设备参数');await editor.getByLabel('数据集连接',{exact:true}).selectOption(connection.id);
 await editor.getByLabel('数据集请求路径',{exact:true}).fill('/devices');await editor.getByLabel('结果根节点',{exact:true}).fill('data');
 await workspace.screenshot({path:path.join(directory,'00-reading-config.png')});
 await editor.getByRole('button',{name:'解析字段',exact:true}).click();await editor.getByLabel('发现的来源字段',{exact:true}).waitFor();
 await editor.getByLabel('发现的来源字段',{exact:true}).selectOption('temperature');await editor.getByRole('button',{name:'添加到映射',exact:true}).click();
 await editor.getByLabel('字段名称 1',{exact:true}).fill('实际温度');
 await editor.getByLabel('字段单位 1',{exact:true}).fill('°C');
 await editor.getByRole('button',{name:'字段设置 1',exact:true}).click();await editor.getByLabel('字段标识 1',{exact:true}).waitFor();
 await editor.getByRole('button',{name:'字段设置 1',exact:true}).click();
 await workspace.screenshot({path:path.join(directory,'00-field-mapping.png')});
 await editor.getByRole('tab',{name:'参数与匹配',exact:true}).click();await editor.getByLabel('按当前对象匹配记录',{exact:true}).check();
 await editor.getByRole('button',{name:'保存数据集',exact:true}).click();await editor.getByText('已保存',{exact:true}).waitFor();
 const definition=(await api('/data-sources/datasets')).datasets.find(d=>d.name==='井式炉设备参数');assert.ok(definition);
 await editor.getByRole('tab',{name:'数据预览',exact:true}).click();await editor.getByLabel('预览 deviceId',{exact:true}).fill(info.devices[0]);await editor.getByRole('button',{name:'读取预览',exact:true}).click();await editor.getByRole('cell',{name:'700',exact:true}).waitFor();
 await editor.getByLabel('预览 deviceId',{exact:true}).fill(info.devices[1]);await editor.getByRole('button',{name:'读取预览',exact:true}).click();await editor.getByRole('cell',{name:'850',exact:true}).waitFor();
 await workspace.screenshot({path:path.join(directory,'01-dataset-preview.png')});
 await page.setViewportSize({width:1366,height:900});await workspace.screenshot({path:path.join(directory,'01-dataset-1366.png')});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page overflow at 1366');
 await page.setViewportSize({width:1000,height:768});await workspace.screenshot({path:path.join(directory,'01-dataset-compact.png')});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page overflow at 1000');
 await page.setViewportSize({width:1600,height:1000});
 check('actual source UI creates a reusable dataset, discovers fields, maps them and previews A/B through one object-aware definition');

 const designer=await api('/platform/designer'),{createDashboardWidget}=await import('../frontend/src/runtime/dashboardSchema.js');
 const widget=createDashboardWidget('value',0,{x:160,y:170});widget.id='dataset_temperature';widget.title='设备温度';
 widget.data={...widget.data,mode:'dataset',datasetId:definition.id,datasetField:'temperature',datasetMode:'first',deviceScope:'current'};
 designer.document.widgets.push(widget);
 for(const view of designer.document.scene.views){view.componentState ||= {show:[],hide:[]};view.componentState.show ||= [];view.componentState.show.push(widget.id)}
 await api('/platform/designer/draft','PUT',{sceneId:designer.document.sceneId,document:designer.document,expectedRevision:designer.revision});
 await api('/platform/releases','POST',{sceneId:designer.document.sceneId,notes:'Owned data-set workflow'});
 const runtime=id=>api('/data-sources/runtime-values?'+new URLSearchParams({scene_id:designer.document.sceneId,view_id:'factory_overview',device_id:id}));
 assert.equal((await runtime(info.devices[0])).values[widget.id].value,700);assert.equal((await runtime(info.devices[1])).values[widget.id].value,850);
 check('draft/save/publish preserve dataset identity, and the published runtime resolves the selected device instead of a fixed first row');
 const dp=await login(await browser.newContext({viewport:{width:1600,height:1000}}),info.username,{activeTab:'platform',platformSubpage:'designer'});
 await dp.locator(`[data-widget-id="${widget.id}"]`).waitFor();
 await dp.locator('.designer-left-panel .layer-list button').filter({hasText:'设备温度'}).click();
 await dp.locator('.inspector-tabs').getByRole('button',{name:'数据来源',exact:true}).click();
 const binding=dp.getByRole('region',{name:'组件数据集绑定',exact:true});await binding.getByLabel('组件数据集',{exact:true}).waitFor();
 assert.equal(await binding.getByLabel('组件数据集',{exact:true}).inputValue(),definition.id);assert.equal(await binding.getByLabel('组件数据集字段',{exact:true}).inputValue(),'temperature');
 await binding.getByRole('button',{name:'指定设备',exact:true}).click();await binding.getByLabel('绑定指定设备',{exact:true}).selectOption(info.devices[1]);
 await binding.getByRole('button',{name:'读取预览',exact:true}).click();await binding.locator('.binding-result strong').filter({hasText:'850'}).waitFor();
 await binding.locator('summary').click();assert.ok(await binding.getByLabel('组件数据集取值',{exact:true}).isVisible());await binding.locator('summary').click();
 await dp.locator('.designer-right-panel').screenshot({path:path.join(directory,'02-component-data-source.png')});
 check('designer data-source inspector offers dataset/field/value mode/current-or-fixed device, and renders a real B-device preview');

 await api('/admin-auth/users','POST',{username:'dataset_reader',displayName:'数据集只读',password:info.password,role:'viewer',permissions:{view:false},pagePermissions:{'settings.database':{view:true},'platform.designer':{view:true}}},page,201);
 const readonly=await login(await browser.newContext(), 'dataset_reader');await readonly.getByRole('tab',{name:'外部数据源',exact:true}).click();await readonly.locator('.workspace-tabs').getByRole('button',{name:'数据集',exact:true}).click();
 await readonly.locator('.dataset-editor').waitFor();assert.equal(await readonly.getByRole('button',{name:'保存数据集',exact:true}).isDisabled(),true);
 await api('/data-sources/datasets','POST',definition,readonly,403);
 await api('/data-sources/datasets/preview','POST',{definition},readonly,403);
 const rr=await api('/data-sources/datasets/preview','POST',{datasetId:definition.id,context:{deviceId:info.devices[1]}},readonly);assert.equal(rr.result.rows[0].temperature,850);
 check('read-only accounts can browse and preview saved datasets, but neither modify nor submit arbitrary definitions');
 assert.deepEqual(errors,[]);const result={success:true,checks,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve))}});
