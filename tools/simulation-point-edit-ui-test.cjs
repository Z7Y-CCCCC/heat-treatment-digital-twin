'use strict';
// Own SQLite/backend/browser only. No commissioned DB, physical PLC or Unity.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('simulation-point-edit-ui'),root=path.resolve(__dirname,'..'),checks=[],errors=[];
let server,browser,page;
const pass=label=>{checks.push(label);console.log('PASS '+label)};
(async()=>{
 const infoFile=path.join(directory,'server.json');
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:root,env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned server');
 const info=JSON.parse(fs.readFileSync(infoFile));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1500,height:900},timezoneId:'Asia/Hong_Kong'});
 await context.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'data-center',dataCenterSection:'monitor',pointMonitorAutoRefresh:true,selectedDeviceForMonitor:'all'})));
 page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 const monitor=page.getByTestId('data-center-monitor');await monitor.waitFor();
 const pointId=await page.evaluate(async deviceId=>{
  const session=await(await fetch('/api/admin-auth/session')).json();
  const response=await fetch('/api/datapoints',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({device_id:deviceId,name:'ui_last_station',label:'模拟验收最后到位工位',data_type:'WORD',plc_tag:'DB8.DBW116',category:'analog',sample_interval_ms:1000,access_type:'READ'})});
  const data=await response.json();if(!response.ok)throw Error(data.error);return data.id;
 },info.devices[0]);
 const search=monitor.getByRole('searchbox',{name:'搜索实时点位',exact:true});await search.fill('模拟验收最后到位工位');
 const row=monitor.locator('tbody tr').filter({hasText:'模拟验收最后到位工位'});await row.waitFor();
 await row.getByText('模拟 · 自动',{exact:true}).waitFor({timeout:60000});assert.equal(await row.getByText('正常',{exact:true}).count(),1);
 const edit=row.getByRole('button',{name:'修改模拟验收最后到位工位的模拟值',exact:true});await edit.dblclick();
 const input=row.getByRole('textbox',{name:'模拟点位值',exact:true});await input.fill('123');
 await page.waitForTimeout(2600);assert.equal(await input.inputValue(),'123','automatic monitoring refresh must not replace a typed draft');
 await row.screenshot({path:path.join(directory,'01-inline-editor.png')});
 await row.getByRole('button',{name:'保存并固定',exact:true}).click();await row.getByText('模拟 · 已固定',{exact:true}).waitFor();
 await page.waitForTimeout(4600);assert.equal((await edit.innerText()).trim(),'123');
 pass('a newly added WORD point is simulated immediately; double-click editing survives polling, and save fixes its value across simulation ticks');
 await page.screenshot({path:path.join(directory,'02-value-fixed.png')});
 await page.reload();await monitor.waitFor();await search.fill('模拟验收最后到位工位');await row.getByText('模拟 · 已固定',{exact:true}).waitFor();assert.equal((await edit.innerText()).trim(),'123');
 pass('refreshing the whole page retains the server-held fixed value');
 await row.getByRole('button',{name:'恢复自动',exact:true}).click();await row.getByText('模拟 · 自动',{exact:true}).waitFor();assert.notEqual((await edit.innerText()).trim(),'123');
 await edit.dblclick();await input.fill('-1');await row.getByRole('button',{name:'保存并固定',exact:true}).click();await row.getByRole('alert').waitFor();assert.match(await row.getByRole('alert').innerText(),/WORD/);
 await input.press('Escape');await input.waitFor({state:'hidden'});
 pass('restore resumes automatic values; invalid WORD input is rejected, and Escape cancels without saving');
 // Keep an intentionally stale simulation reading in the monitor while the
 // independent engine status changes. The icon must follow the current mode.
 await page.route('**/api/plc/points/realtime?*',async route=>{
  const response=await route.fetch(),data=await response.json();
  data.points=(data.points||[]).map(point=>({...point,sourceMode:'simulation',simulationManual:true,value:null}));
  await route.fulfill({response,json:data});
 });
 await page.evaluate(async()=>{
  const session=await(await fetch('/api/admin-auth/session')).json();const response=await fetch('/api/collector/mode',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({mode:'external',expectedMode:'simulation'})});if(!response.ok)throw Error('Mode change failed');
 });
 await edit.waitFor({state:'hidden'});assert.equal(await row.getByRole('textbox',{name:'模拟点位值',exact:true}).count(),0);
 assert.equal(await row.locator('.simulation-point-display svg').count(),0);
 assert.equal(await row.locator('.simulation-point-source').count(),0);
 await row.screenshot({path:path.join(directory,'03-non-simulation-readonly.png')});
 pass('leaving simulation removes edit icons, controls and simulation labels even when cached rows still report simulation; no real PLC write endpoint is used');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,pointId,directory},null,2));console.log(JSON.stringify({success:true,checks:checks.length,directory}));
})().catch(async error=>{console.error(error);await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.stack,checks,errors},null,2));process.exitCode=1;}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
