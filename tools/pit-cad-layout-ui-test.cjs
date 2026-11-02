// Use the actual CAD fixture in the existing editor. Production data is not touched.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const {resolveGround,buildGroundMesh}=require('../shared/industrialGround.mjs');
const directory=createRunDirectory('pit-cad-layout-ui'),errors=[],checks=[];let server,browser,page;
const check=text=>{checks.push(text);console.log('PASS '+text)};
// Retry only idempotent verification reads when a pooled keep-alive socket resets.
// Browser save actions and HTTP errors are never retried or masked.
const readJson=async url=>{const response=await page.request.get(url,{maxRetries:2});assert.ok(response.ok(),`${url}: ${response.status()}`);return response.json()};
(async()=>{
 const infoFile=path.join(directory,'fixture.json');
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'pit-cad-layout-test.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PIT_CAD_KEEP_FIXTURE:'1',PIT_CAD_FIXTURE_INFO_FILE:infoFile},logFile:path.join(directory,'fixture.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},90000,'CAD fixture ready');const info=JSON.parse(fs.readFileSync(infoFile));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const context=await browser.newContext({viewport:{width:1680,height:1100},extraHTTPHeaders:{'X-Factory-ID':info.factoryId}});
 await context.addInitScript(factoryId=>{localStorage.setItem('digital_twin_factory_scope_v1',factoryId);localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'composer'}))},info.factoryId);
 page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 const loadedGlbs=new Set();page.on('response',response=>{if(response.ok()&&response.url().endsWith('.glb'))loadedGlbs.add(response.url())});
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 await page.locator('.composer-preview-stage canvas').waitFor();
 await waitUntil(async()=>await page.locator('.device-pill').count()===17,30000,'all seventeen CAD devices are placed');
 assert.equal(await page.locator('.composer-device-list').first().locator('.device-pill').count(),9);
 await page.getByRole('button',{name:'车间',exact:true}).click();await page.waitForTimeout(3500);
 assert.equal(await page.locator('.composer-preview-error').count(),0,'no missing-model placeholders');
 await waitUntil(()=>loadedGlbs.size>=10,30000,'all five library assets and five auxiliary assets actually requested');
 const workshops=await readJson(info.origin+'/api/workshops'),lines=await readJson(info.origin+'/api/lines');
 let devices=await readJson(info.origin+'/api/devices');const workshop=workshops.find(w=>w.id===info.workshopId),line=lines.find(l=>l.id===info.lineId);
 const ground=resolveGround({...workshop,lines:[{...line,devices:devices.filter(d=>d.line_id===line.id)}]});assert.equal(ground.areas.length,10);
 assert.ok(buildGroundMesh(ground).positions.every(Number.isFinite));
 await page.screenshot({path:path.join(directory,'01-cad-workshop-editor.png'),fullPage:true});await page.locator('.composer-preview-stage').screenshot({path:path.join(directory,'cad-workshop-viewport.png')});
 check('17 actual placed objects, nine library furnaces and eight auxiliary objects, load without placeholder errors; shared mesh contains ten pits');
 await page.locator('.device-pill').filter({hasText:'原设备 PitFurnace_02'}).click();const devicePanel=page.locator('.composer-device-layout-float');await devicePanel.waitFor();
 const height=devicePanel.getByLabel('标高 Y（米）',{exact:true});assert.equal(Number(await height.inputValue()),-4.65);
 assert.ok(await devicePanel.getByLabel('地面跟随设备（基坑 / 高台）',{exact:true}).isChecked());
 for(const y of [-4.8,-4.65]){
  await height.fill(String(y));await height.press('Tab');const response=page.waitForResponse(r=>r.url().endsWith('/api/devices/PitFurnace_02/transform')&&r.request().method()==='PUT');
  await devicePanel.getByRole('button',{name:'保存设备布局',exact:true}).click();assert.equal((await response).status(),200);
  await page.getByText('设备布局已保存',{exact:true}).waitFor();await page.getByRole('button',{name:'确定',exact:true}).click();await page.locator('.app-dialog').waitFor({state:'hidden'});
  const device=await readJson(info.origin+'/api/devices/PitFurnace_02');assert.equal(device.pos_y,y);assert.equal(JSON.parse(device.instance_config).ground.enabled,true);
  devices=await readJson(info.origin+'/api/devices');const resolved=resolveGround({...workshop,lines:[{...line,devices:devices.filter(d=>d.line_id===line.id)}]});
  const hole=resolved.areas.find(area=>area.id.includes('PitFurnace_02'));assert.ok(hole);assert.equal(hole.elevation,y);
 }
 check('editing a CAD furnace negative elevation moves its following pit; save/reload values remain correct and the CAD height is restored');
 await devicePanel.getByRole('button',{name:'取消选中设备',exact:true}).click();await page.locator('.composer-ground-panel summary').click();
 const groundPanel=page.getByRole('region',{name:'车间地面编辑',exact:true});await groundPanel.waitFor();
 for(const y of [-4.7,-4.8]){
  await groundPanel.getByLabel('区域标高（米）',{exact:true}).fill(String(y));const response=page.waitForResponse(r=>r.url().endsWith('/api/workshops/'+info.workshopId+'/ground')&&r.request().method()==='PUT');
  await groundPanel.getByRole('button',{name:'保存地面',exact:true}).click();assert.equal((await response).status(),200);await groundPanel.getByText('地面已保存',{exact:true}).waitFor();
 }
 await page.reload();await page.locator('.composer-ground-panel summary').click();assert.equal(Number(await groundPanel.getByLabel('区域标高（米）',{exact:true}).inputValue()),-4.8);
 assert.equal(await page.locator('.device-pill').count(),17);await page.getByRole('button',{name:'车间',exact:true}).click();await page.waitForTimeout(1500);
 await page.screenshot({path:path.join(directory,'02-saved-ground-and-layout.png'),fullPage:true});
 check('the CAD support-platform shared pit can be edited through the real ground panel and retains its saved height after reload');
 assert.deepEqual(errors,[]);const result={success:true,checks,browserErrors:errors,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({error:error.stack,errors,checks},null,2));console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
