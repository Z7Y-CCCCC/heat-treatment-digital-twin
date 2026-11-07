'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {requireTestPath,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const artifactRoot=requireTestPath(path.resolve(__dirname,'../output/playwright'));fs.mkdirSync(artifactRoot,{recursive:true});
const directory=fs.mkdtempSync(path.join(artifactRoot,`boolean-endpoints-browser-${new Date().toISOString().replace(/[-:.]/g,'')}-${process.pid}-`)),checks=[],pageErrors=[],snapshots=[],animationWrites=[];let helper,browser,page,info,live;
const pass=label=>{checks.push(label);console.log('PASS '+label)};
async function api(route,method='GET',data,status=200){const session=await(await page.request.get(info.origin+'/api/admin-auth/session')).json();const response=await page.request.fetch(info.origin+route,{method,headers:{Origin:info.origin,'X-Admin-Request':'1','X-CSRF-Token':session.csrfToken,'X-Factory-Id':info.factoryId},...(data===undefined?{}:{data})});assert.equal(response.status(),status,await response.text());return response.json()}
async function control(data){const response=await fetch(info.control,{method:'POST',body:JSON.stringify(data)});assert.equal(response.status,200)}
// This form validates real runtime status; geometry remains covered by native tests.
async function state(reason){await live.locator('.health-list').getByText(reason,{exact:true}).waitFor()}
async function snapshot(name){const runtimeStatus=await live.locator('.health-list').innerText();snapshots.push({name,runtimeStatus});await page.screenshot({path:path.join(directory,name+'.png'),fullPage:false});fs.writeFileSync(path.join(directory,name+'.json'),JSON.stringify({runtimeStatus,geometryValidated:false},null,2))}
async function noPreview(){assert.equal(await live.locator('.link-preview,.motion-link-stage,canvas').count(),0);for(const name of ['跟随采集','本页试动作'])assert.equal(await live.getByRole('button',{name,exact:true}).count(),0);assert.equal(await live.getByRole('slider',{name:'试动作进度',exact:true}).count(),0);assert.equal(await live.locator('.endpoint-test-controls').count(),0)}
(async()=>{
 const infoFile=path.join(directory,'server.json');helper=startLoggedProcess(process.execPath,[path.join(__dirname,'boolean-endpoints-browser-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,ENDPOINT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(helper.exitCode,null);return fs.existsSync(infoFile)},60000,'owned endpoint backend');info=JSON.parse(fs.readFileSync(infoFile));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});const context=await browser.newContext({viewport:{width:1680,height:1120}});
 await context.addInitScript(id=>{localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'model-animations'}));localStorage.setItem('digital_twin_factory_scope_v1',id)},info.factoryId);
 page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>pageErrors.push(error.message));page.on('request',request=>{if(request.method()==='PUT'&&/\/api\/devices\/[^/]+\/animations(?:\?|$)/.test(request.url()))animationWrites.push(request.postDataJSON())});await page.goto(info.origin+'/admin');
 await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 await page.getByRole('button',{name:'实时联动',exact:true}).click();live=page.getByRole('region',{name:'设备实时动画联动'});await live.getByRole('button',{name:/送料小车 · 双到位反馈验收/}).click();
 await live.locator('.action-list').getByRole('button',{name:/推料伸出 \/ 退回/}).click();
 await live.getByRole('button',{name:/^到位反馈 · 两个开关量/}).click();
 const catalog=await api('/api/data-center/catalog?device_id='+info.deviceId),point=side=>catalog.items.find(item=>String(item.binding?.pointId)===info.points[side]);
 assert.ok(point('extended'));assert.ok(point('retracted'));
 await live.getByLabel('推料到位数据项',{exact:true}).selectOption(point('extended').id);await live.getByRole('switch',{name:'启用动作联动',exact:true}).check();
 assert.equal(await live.getByRole('button',{name:'保存并同步',exact:true}).isDisabled(),true,'partial pair must not save');
 await live.getByLabel('退回到位数据项',{exact:true}).selectOption(point('retracted').id);await live.getByLabel('动作过渡秒数',{exact:true}).fill('1');
 await live.getByRole('button',{name:'保存并同步',exact:true}).click();await live.getByText('已保存，Unity 自动同步',{exact:true}).waitFor();
 let saved=await api('/api/devices/'+info.deviceId+'/animations'),binding=saved.config.bindings.find(row=>row.actionId==='clip:feed');assert.deepEqual(binding.trigger,{mode:'endpoints',extended:{dataItemId:point('extended').id},retracted:{dataItemId:point('retracted').id}});assert.equal(binding.pointId,'');assert.ok(!binding.dataItemId);
 await noPreview();await page.screenshot({path:path.join(directory,'00-configured-feedback.png'),fullPage:false});await live.getByRole('button',{name:'运行状况',exact:true}).click();await state('退回到位');await snapshot('01-retracted');pass('真实小车双开关量保存成功，缺一端禁止保存；实时联动无重复3D画布和试动作控件');
 await control({extended:false,retracted:false});await state('等待到位反馈');await page.waitForTimeout(1300);await state('等待到位反馈');await snapshot('02-waiting-extended');pass('两端未到位持续显示等待，超过显示过渡时间也不自动确认推料到位');
 await control({extended:true,retracted:false});await state('推料到位');await snapshot('03-extended');
 await control({extended:false,retracted:false});await state('等待到位反馈');await page.waitForTimeout(1300);await state('等待到位反馈');await snapshot('04-waiting-retracted');
 await control({extended:false,retracted:true});await state('退回到位');await snapshot('05-retracted');pass('推料和退回状态只由唯一到位反馈确认，离开某端不擅自确认另一端');
 await control({extended:true,retracted:true});await state('到位反馈冲突');await snapshot('06-conflict');
 await control({extended:true,retracted:false,bad:true});await state('数据无效');await snapshot('07-invalid');await control({bad:false});await state('推料到位');await snapshot('08-reconnected-current-end');pass('反馈冲突、坏质量仍明确显示；恢复重新读取当前确认端点');
 await control({paused:true});await state('数据超时');await snapshot('09-stale');await control({paused:false,extended:false,retracted:true});await state('退回到位');await snapshot('10-recovered');pass('停帧按真实读取时间超时，恢复以最新有效反馈显示');
 await live.getByRole('button',{name:'动作绑定',exact:true}).click();await live.getByRole('button',{name:'重新读取',exact:true}).click();await live.locator('.action-list').getByRole('button',{name:/推料伸出 \/ 退回/}).click();
 assert.equal(await live.getByLabel('推料到位数据项',{exact:true}).inputValue(),point('extended').id);assert.equal(await live.getByLabel('退回到位数据项',{exact:true}).inputValue(),point('retracted').id);await noPreview();
 assert.deepEqual((await api('/api/devices/'+info.deviceId+'/animations')).config,saved.config);assert.equal(animationWrites.length,1);pass('查看状态和重新读取不写配置，双反馈绑定保持一致');
 await page.setViewportSize({width:1024,height:1000});await page.screenshot({path:path.join(directory,'11-compact.png'),fullPage:false});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);await noPreview();
 const sizes=await live.evaluate(el=>({content:el.querySelector('.link-content').getBoundingClientRect().width,config:el.querySelector('.link-config').getBoundingClientRect().width}));assert.ok(Math.abs(sizes.content-sizes.config)<3,JSON.stringify(sizes));pass('紧凑布局不横向溢出，配置占满右侧且双反馈选择保持可操作');
 assert.deepEqual(pageErrors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,realtimePreviewRemoved:true,runtimeStatusValidated:true,geometryValidated:false,checks,pageErrors,snapshots,animationWrites,noCollectorOrSite:true,modelId:info.modelId,actionId:'clip:feed',directory},null,2));console.log(JSON.stringify({success:true,directory,checks:checks.length},null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:false,checks,error:error.stack,pageErrors,snapshots,directory},null,2));console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(helper)});
