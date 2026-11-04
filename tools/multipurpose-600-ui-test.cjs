const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser;
(async()=>{
 const directory=createRunDirectory('multipurpose-600-ui'),infoFile=path.join(directory,'server.json');
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'line-simulation-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LINE_SIMULATION_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned 600 furnace fixture');
 const info=JSON.parse(fs.readFileSync(infoFile)),id='cad_multipurpose_furnace_082000';
 const {cadMotionActions}=await import('../frontend/src/three/cadMotionProfiles.js'),{buildLineSimulation}=await import('../frontend/src/three/lineSimulation.js');
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[],writes=[],checks=[];page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method())&&/\/api\/(devices|lines|models|plc)(\/|$)/.test(new URL(r.url()).pathname))writes.push(r.method()+' '+r.url())});
 await page.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'models',modelLibraryStep:'library'})));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 const row=page.locator(`[data-model-id="${id}"]`);await row.waitFor();await row.locator('td').nth(2).click();await page.waitForFunction(()=>document.querySelector('.model-preview-footer')?.textContent?.includes('600普通多用炉'));
 const api=async route=>{const r=await page.request.get(info.origin+route);assert.equal(r.status(),200);return r.json()};
 const models=await api('/api/models'),model=models.find(m=>m.id===id),metadata=JSON.parse(model.metadata),asset=await page.request.get(info.origin+model.file_path);
 assert.equal(crypto.createHash('sha256').update(await asset.body()).digest('hex'),metadata.sourceAsset.sha256);assert.equal(metadata.inspection.parts.length,35);checks.push('model is listed once and original GLB bytes are intact');
 await page.locator('.model-preview-stage').screenshot({path:path.resolve(__dirname,'../output/multipurpose-600-model.png')});
 await page.getByRole('navigation',{name:'模型库操作步骤'}).getByRole('button',{name:/拆解检查/}).click();await page.getByRole('button',{name:'▶ 演示拆解',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="拆解进度"]')?.value)>.999);
 await page.locator('.model-preview-stage').screenshot({path:path.resolve(__dirname,'../output/multipurpose-600-exploded.png')});
 await page.getByRole('button',{name:'↶ 反向组装',exact:true}).click();await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="拆解进度"]')?.value)===0);checks.push('35 assembly groups explode and reassemble in the real UI');
 await page.getByRole('button',{name:'动作动画',exact:true}).click();await page.getByRole('combobox',{name:'选择动作动画模型',exact:true}).selectOption(id);
 const setTime=async(selector,value)=>{await selector.evaluate((el,v)=>{el.value=String(v);el.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
 for(const action of cadMotionActions(id)){
  await page.getByRole('button',{name:'预览 CAD 动作：'+action.label,exact:true}).click();const preview=page.locator('.cad-motion-preview');await preview.locator('.loading').waitFor({state:'hidden'});await preview.getByRole('button',{name:'暂停',exact:true}).click();
  const slider=preview.getByRole('slider',{name:'CAD 动作进度',exact:true});await setTime(slider,1.3);const a=await preview.locator('canvas').screenshot();await setTime(slider,3.7);const b=await preview.locator('canvas').screenshot();assert.equal(a.equals(b),false,action.label+' should change rendered geometry/effects');
  if(action.id==='basket_up'){
   const closeup=preview.getByRole('button',{name:'沥油近景',exact:true});await closeup.waitFor();
   const near=await preview.locator('canvas').screenshot();await preview.getByRole('button',{name:'完整视图',exact:true}).click();await setTime(slider,3.7);
   assert.equal(near.equals(await preview.locator('canvas').screenshot()),false,'oil closeup can return to the complete furnace');
   await closeup.click();await setTime(slider,3.7);checks.push('oil drainage opens in closeup and can switch back to the complete furnace');
  }
  if(['internal_transfer','heating','basket_up'].includes(action.id))await preview.screenshot({path:path.resolve(__dirname,'../output/multipurpose-600-'+action.id+'.png')});
  await preview.getByRole('button',{name:'复位',exact:true}).click();assert.equal(await slider.inputValue(),'0');console.log('PASS '+action.label);
 }
 checks.push('all nine actions render changing frames and support seek/pause/reset');
 await page.getByRole('button',{name:'设备联动',exact:true}).click();await page.getByRole('combobox',{name:'选择联动产线',exact:true}).selectOption('simulation_line_a');
 await page.getByRole('checkbox',{name:'参与联动：料车实例 A',exact:true}).check();await page.getByRole('textbox',{name:'搜索联动设备',exact:true}).fill('多用炉实例 A');await page.getByRole('checkbox',{name:'参与联动：多用炉实例 A',exact:true}).check();
 const devices=await api('/api/devices'),before=JSON.stringify(devices),selected=['sim_0','sim_6'].map(v=>devices.find(d=>d.id===v)),plan=buildLineSimulation(selected,models);
 await page.getByRole('button',{name:'预览选中设备',exact:true}).click();const sequence=page.getByTestId('line-equipment-sequence');await sequence.locator('.empty').waitFor({state:'hidden'});
 const slider=page.getByRole('slider',{name:'产线联动流程进度',exact:true});
 for(const kind of ['feed','hot_feed','heat_treat','hot_return','quench','drip','reclaim']){
  const step=plan.steps.find(s=>s.kind===kind);await setTime(slider,step.start+step.duration/2);assert.equal(await sequence.getAttribute('data-step-kind'),kind);
  await sequence.locator('.preview').screenshot({path:path.join(directory,kind+'.png')});
  if(kind==='drip')assert.ok((await sequence.locator('.hud').innerText()).includes('沥油'));
  if(kind==='quench')await page.screenshot({path:path.resolve(__dirname,'../output/multipurpose-600-line-preview.png'),fullPage:true});
 }
 await setTime(slider,plan.total);assert.ok((await sequence.locator('.hud').innerText()).includes('本次联动完成'));checks.push('selected cart feeds, transfers to hot chamber, heats, returns, quenches and retrieves material');
 assert.equal(JSON.stringify(await api('/api/devices')),before);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({checks,errors,writes},null,2));console.log(JSON.stringify({checks,errors,writes,directory},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
