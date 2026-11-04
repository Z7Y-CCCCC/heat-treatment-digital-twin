// Exercise the shipped UI with an owned fixture; never edit the operator's data.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser;
(async()=>{
 const directory=createRunDirectory('tempering-motion-ui'),infoFile=path.join(directory,'server.json');
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'line-simulation-ui-server.cjs')],{
  cwd:path.resolve(__dirname,'..'),env:{...process.env,LINE_SIMULATION_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')
 });
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned tempering furnace fixture');
 const info=JSON.parse(fs.readFileSync(infoFile)),id='cad_tempering_furnace_091300',checks=[],errors=[],writes=[];
 const {cadMotionActions}=await import('../frontend/src/three/cadMotionProfiles.js');
 const {buildLineSimulation}=await import('../frontend/src/three/lineSimulation.js');
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1600,height:1050}});page.setDefaultTimeout(45000);
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(!['GET','HEAD'].includes(request.method())&&/\/api\/(devices|lines|models|plc)(\/|$)/.test(new URL(request.url()).pathname))writes.push(request.method()+' '+request.url())});
 await page.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'model-animations',modelLibraryStep:'bindings'})));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);
 await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 await page.getByTestId('model-animation-page').waitFor();
 const api=async route=>{const response=await page.request.get(info.origin+route);assert.equal(response.status(),200);return response.json()};
 const models=await api('/api/models'),devices=await api('/api/devices'),model=models.find(item=>item.id===id),metadata=JSON.parse(model.metadata);
 const asset=await page.request.get(info.origin+model.file_path);
 assert.equal(crypto.createHash('sha256').update(await asset.body()).digest('hex'),metadata.sourceAsset.sha256);
 assert.equal(model.motion_package.actions.length,4);checks.push('original GLB is intact and four portable actions are registered');
 await page.getByRole('combobox',{name:'选择动作动画模型',exact:true}).selectOption(id);
 const setTime=async(slider,value)=>{await slider.evaluate((element,next)=>{element.value=String(next);element.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
 for(const action of cadMotionActions(id)){
  await page.getByRole('button',{name:'预览 CAD 动作：'+action.label,exact:true}).click();
  const preview=page.locator('.cad-motion-preview');await preview.locator('.loading').waitFor({state:'hidden'});
  await preview.getByRole('button',{name:'暂停',exact:true}).click();
  const slider=preview.getByRole('slider',{name:'CAD 动作进度',exact:true});
  await setTime(slider,1.3);const before=await preview.locator('canvas').screenshot();await setTime(slider,3.7);
  assert.equal(before.equals(await preview.locator('canvas').screenshot()),false,action.label+' must change rendered geometry');
  await preview.screenshot({path:path.join(directory,action.id+'.png')});
  await preview.getByRole('button',{name:'复位',exact:true}).click();assert.equal(await slider.inputValue(),'0');
  checks.push(action.label+' renders and supports pause/seek/reset');
 }
 await page.getByRole('button',{name:'实时联动',exact:true}).click();
 const live=page.getByRole('region',{name:'设备实时动画联动',exact:true});
 await live.getByRole('button',{name:/^回火炉实例/}).click();
 for(const action of cadMotionActions(id))await live.locator('.action-list').getByText(action.label,{exact:true}).waitFor();
 assert.equal((await api('/api/devices/sim_temper/animations')).actions.length,4);
 checks.push('four actions are available for per-device real-time binding');
 await page.getByRole('button',{name:'设备联动',exact:true}).click();
 await page.getByRole('combobox',{name:'选择联动产线',exact:true}).selectOption('simulation_line_a');
 await page.getByRole('checkbox',{name:'参与联动：料车实例 A',exact:true}).check();
 await page.getByRole('textbox',{name:'搜索联动设备',exact:true}).fill('回火炉实例');
 await page.getByRole('checkbox',{name:'参与联动：回火炉实例',exact:true}).check();
 const plan=buildLineSimulation(['sim_0','sim_temper'].map(key=>devices.find(item=>item.id===key)),models);
 await page.getByRole('button',{name:'预览选中设备',exact:true}).click();
 const sequence=page.getByTestId('line-equipment-sequence');await sequence.locator('.empty').waitFor({state:'hidden'});
 const slider=page.getByRole('slider',{name:'产线联动流程进度',exact:true});
 for(const kind of ['feed','tempering_heat','tempering_hold','reclaim']){
  const step=plan.steps.find(item=>item.kind===kind);await setTime(slider,step.start+step.duration/2);
  assert.equal(await sequence.getAttribute('data-step-kind'),kind);
  await sequence.locator('.preview').screenshot({path:path.join(directory,'line-'+kind+'.png')});
 }
 await setTime(slider,plan.total);await sequence.getByRole('button',{name:'复位',exact:true}).click();assert.equal(await slider.inputValue(),'0');
 checks.push('cart loading, closed-door heating, circulation holding and unloading render without error');
 assert.deepEqual(await api('/api/devices'),devices);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 const result={success:true,checks,errors,writes,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
