const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser;
(async()=>{
 const directory=createRunDirectory('cart-push-hook-ui'),infoFile=path.join(directory,'server.json'),checks=[],errors=[],writes=[];
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'line-simulation-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LINE_SIMULATION_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned cart hook fixture');const info=JSON.parse(fs.readFileSync(infoFile)),id='cad_transfer_cart_101300';
 const {cadMotionActions}=await import('../frontend/src/three/cadMotionProfiles.js'),{buildLineSimulation}=await import('../frontend/src/three/lineSimulation.js');
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1600,height:1050}});page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method())&&/\/api\/(devices|models|lines|plc)(\/|$)/.test(new URL(r.url()).pathname))writes.push(r.method()+' '+r.url())});
 await page.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'model-animations',modelLibraryStep:'bindings'})));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();await page.getByTestId('model-animation-page').waitFor();
 const api=async route=>{const response=await page.request.get(info.origin+route);assert.equal(response.status(),200);return response.json()};
 const models=await api('/api/models'),devices=await api('/api/devices'),model=models.find(m=>m.id===id),metadata=JSON.parse(model.metadata),response=await page.request.get(info.origin+model.file_path),bytes=await response.body();
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),metadata.sourceAsset.sha256);assert.equal(model.motion_package.actions.length,6);assert.ok(metadata.cartPushHook);
 for(const action of ['clip:feed','clip:hook','clip:feed_opposite','clip:hook_opposite'])assert.ok(model.motion_package.actions.some(a=>a.id===action));
 const doc=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));for(const name of ['feed_carriage','push_hook','hook_latch'])assert.ok(doc.nodes.some(n=>n.name==='cad_transfer_cart_v1_'+name));checks.push('cart asset and six portable actions include both feed/hook directions');
 const motionResponse=await page.request.get(info.origin+model.motion_package.clipPath);assert.equal(motionResponse.status(),200);const motion=await motionResponse.json();
 for(const name of ['preview_chain_carriage_anchor','preview_chain_case_entry','preview_working_chain_link_0'])assert.ok(motion.nodes.some(n=>n.name===name));checks.push('portable rig includes a steel working chain joining the carriage clamp to the rear housing');
 await page.getByRole('combobox',{name:'选择动作动画模型',exact:true}).selectOption(id);
 const setTime=async(slider,value)=>{await slider.evaluate((element,next)=>{element.value=String(next);element.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
 for(const action of cadMotionActions(id)){
  await page.getByRole('button',{name:'预览 CAD 动作：'+action.label,exact:true}).click();const preview=page.locator('.cad-motion-preview');await preview.locator('.loading').waitFor({state:'hidden'});await preview.getByRole('button',{name:'暂停',exact:true}).click();
  const slider=preview.getByRole('slider',{name:'CAD 动作进度',exact:true});await setTime(slider,0);const before=await preview.locator('canvas').screenshot();await setTime(slider,3.7);assert.equal(before.equals(await preview.locator('canvas').screenshot()),false,action.label);
  await preview.screenshot({path:path.join(directory,action.id+'.png')});
  if(['feed','hook'].includes(action.id)){await preview.getByRole('button',{name:'完整视图',exact:true}).click();await preview.getByRole('button',{name:'推拉钩近景',exact:true}).click()}
  if(action.id==='feed')for(const [name,time] of [['rear',0],['front',4],['returned',8]]){await setTime(slider,time);await preview.screenshot({path:path.join(directory,'full-stroke-'+name+'.png')})}
  await preview.getByRole('button',{name:'复位',exact:true}).click();assert.equal(await slider.inputValue(),'0');
 }
 checks.push('hook feeding/release, travel and roller previews render, seek and reset');
 await page.getByRole('button',{name:'设备联动',exact:true}).click();await page.getByRole('combobox',{name:'选择联动产线',exact:true}).selectOption('simulation_line_a');
 for(const name of ['料车实例 A','清洗机实例 A'])await page.getByRole('checkbox',{name:'参与联动：'+name,exact:true}).check();
 const plan=buildLineSimulation(['sim_0','sim_4'].map(key=>devices.find(d=>d.id===key)),models);await page.getByRole('button',{name:'预览选中设备',exact:true}).click();const sequence=page.getByTestId('line-equipment-sequence');await sequence.locator('.empty').waitFor({state:'hidden'});
 const slider=page.getByRole('slider',{name:'产线联动流程进度',exact:true});
 for(const kind of ['feed','retract','pickup_extend','reclaim']){
  const step=plan.steps.find(s=>s.kind===kind);await setTime(slider,step.start+step.duration/2);assert.equal(await sequence.getAttribute('data-step-kind'),kind);await sequence.locator('.preview').screenshot({path:path.join(directory,'line-'+kind+'.png')});
 }
 checks.push('selected-line loading, empty retraction, pickup extension and pulling back render');
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(await api('/api/devices'),devices);
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,writes,directory},null,2));console.log(JSON.stringify({success:true,checks,errors,writes,directory},null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
