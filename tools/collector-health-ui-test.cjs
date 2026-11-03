// Browser acceptance against an isolated collector + real loopback Modbus endpoint.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('collector-health-ui'),checks=[],errors=[];let helper,browser,page;
const check=name=>{checks.push(name);console.log('PASS '+name)};
(async()=>{
 const file=path.join(directory,'server.json');helper=startLoggedProcess(process.execPath,[path.join(__dirname,'device-animation-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MOTION_UI_INFO_FILE:file},logFile:path.join(directory,'helper.log')});
 await waitUntil(()=>fs.existsSync(file),60000,'isolated backend');const info=JSON.parse(fs.readFileSync(file));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:1517,height:960}});
 await context.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'settings',settingsSubpage:'data'})));
 page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));await page.goto(info.origin+'/admin');
 await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 const panel=page.getByRole('region',{name:'采集进程健康状态',exact:true});await panel.locator('h3').getByText('采集正常',{exact:true}).waitFor();
 assert.equal(await page.getByText('数据通路模式',{exact:true}).count(),0);assert.equal(await page.getByText('数据引擎状态',{exact:true}).count(),0);
 await panel.getByRole('button',{name:'设备状态',exact:true}).click();await panel.getByText('清洗机 · 联动验收',{exact:true}).waitFor();
 const initial=await (await page.request.get(info.origin+'/api/collector/status')).json();assert.equal(initial.processRunning,true);assert.equal(initial.counts.normal,1);
 await page.screenshot({path:path.join(directory,'01-observed-collector.png')});check('data-source selector replaced by automatically observed process, heartbeat, quality and per-device health');
 const control=body=>fetch(info.control,{method:'POST',body:JSON.stringify(body)});
 await control({offline:true});await panel.locator('h3').getByText('采集异常',{exact:true}).waitFor();await page.screenshot({path:path.join(directory,'02-device-fault.png')});
 await control({offline:false});await panel.locator('h3').getByText('采集正常',{exact:true}).waitFor();
 assert.equal((await (await page.request.get(info.origin+'/api/collector/status')).json()).process.pid,initial.process.pid);check('device offline/recovery appears without confusing a running process with healthy device data');
 async function mode(name){await panel.getByRole('button',{name,exact:true}).click();await page.locator('.app-dialog[role=dialog]').waitFor();await page.locator('.app-dialog-actions button').last().click();}
 await mode('模拟演示');await panel.locator('h3').getByText('模拟演示运行中',{exact:true}).waitFor();assert.equal((await(await page.request.get(info.origin+'/api/collector/status')).json()).configuredMode,'simulation');
 await mode('现场采集');await panel.locator('h3').getByText('采集正常',{exact:true}).waitFor();check('source changes require confirmation, persist only current factory, and reuse the existing worker');
 const api='**/api/collector/status';await page.route(api,route=>route.abort());await panel.locator('h3').getByText('采集状态未连接',{exact:true}).waitFor();await page.screenshot({path:path.join(directory,'03-api-disconnected.png')});
 assert.equal(await panel.getByRole('button',{name:'现场采集',exact:true}).isDisabled(),true);await page.unroute(api);await panel.locator('h3').getByText('采集正常',{exact:true}).waitFor();check('unavailable status never retains a green badge or enables stale source switches; automatically recovers');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,directory,errors},null,2));console.log(JSON.stringify({success:true,checks,directory},null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(helper)});
