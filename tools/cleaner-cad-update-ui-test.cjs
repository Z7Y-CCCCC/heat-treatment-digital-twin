// Validate the delivered cleaner using an isolated database and owned server.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser;
(async()=>{
 const directory=createRunDirectory('cleaner-cad-update-ui'),infoFile=path.join(directory,'server.json');
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'line-simulation-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LINE_SIMULATION_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned cleaner fixture');
 const info=JSON.parse(fs.readFileSync(infoFile)),id='cad_cleaner_170700',checks=[],errors=[],writes=[];
 const {cadMotionActions}=await import('../frontend/src/three/cadMotionProfiles.js'),{buildLineSimulation}=await import('../frontend/src/three/lineSimulation.js');
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1600,height:1050}});page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(!['GET','HEAD'].includes(r.method())&&/\/api\/(devices|lines|models|plc)(\/|$)/.test(new URL(r.url()).pathname))writes.push(r.method()+' '+r.url())});
 await page.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'models',modelLibraryStep:'library'})));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 const row=page.locator(`[data-model-id="${id}"]`);await row.waitFor();
 const api=async route=>{const response=await page.request.get(info.origin+route);assert.equal(response.status(),200);return response.json()};
 const models=await api('/api/models'),devices=await api('/api/devices'),model=models.find(m=>m.id===id),metadata=JSON.parse(model.metadata);
 const source=await page.request.get(info.origin+model.file_path),bytes=await source.body();assert.equal(source.status(),200);
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),metadata.sourceAsset.sha256);
 const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
 for(const suffix of ['central_lower_body','lower_collection']){
  const name='cad_washing_machine_v1_'+suffix;assert.ok(gltf.nodes.some(node=>node.name===name));
  assert.ok(metadata.inspection.parts.some(part=>[part.node_name,...part.node_names||[]].includes(name)));
 }
 assert.equal(model.motion_package.actions.length,6);checks.push('latest GLB hash, both restored lower assemblies and six motion clips are present');
 await row.locator('td').nth(2).click();await page.waitForFunction(()=>document.querySelector('.model-preview-footer')?.textContent?.includes('17.07.00'));
 await page.locator('.model-preview-stage').screenshot({path:path.join(directory,'assembled.png')});
 await page.getByRole('navigation',{name:'模型库操作步骤'}).getByRole('button',{name:/拆解检查/}).click();await page.getByRole('button',{name:'▶ 演示拆解',exact:true}).click();
 await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="拆解进度"]')?.value)>.999);
 await page.locator('.model-preview-stage').screenshot({path:path.join(directory,'exploded.png')});
 await page.getByRole('button',{name:'↶ 反向组装',exact:true}).click();
 await page.waitForFunction(()=>Number(document.querySelector('input[aria-label="拆解进度"]')?.value)===0);
 checks.push('model library and restored lower assemblies render in disassembly');
 await page.getByRole('button',{name:'动作动画',exact:true}).click();await page.getByRole('combobox',{name:'选择动作动画模型',exact:true}).selectOption(id);
 const setTime=async(slider,value)=>{await slider.evaluate((element,next)=>{element.value=String(next);element.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
 for(const action of cadMotionActions(id)){
  await page.getByRole('button',{name:'预览 CAD 动作：'+action.label,exact:true}).click();const preview=page.locator('.cad-motion-preview');await preview.locator('.loading').waitFor({state:'hidden'});await preview.getByRole('button',{name:'暂停',exact:true}).click();
  const slider=preview.getByRole('slider',{name:'CAD 动作进度',exact:true});await setTime(slider,1.3);const before=await preview.locator('canvas').screenshot();await setTime(slider,3.7);assert.equal(before.equals(await preview.locator('canvas').screenshot()),false,action.label);
  await preview.screenshot({path:path.join(directory,action.id+'.png')});await preview.getByRole('button',{name:'复位',exact:true}).click();assert.equal(await slider.inputValue(),'0');
 }
 checks.push('all six actions render changing frames and support seeking and reset');
 await page.getByRole('button',{name:'设备联动',exact:true}).click();await page.getByRole('combobox',{name:'选择联动产线',exact:true}).selectOption('simulation_line_a');
 for(const name of ['料车实例 A','清洗机实例 A'])await page.getByRole('checkbox',{name:'参与联动：'+name,exact:true}).check();
 const plan=buildLineSimulation(['sim_0','sim_4'].map(key=>devices.find(device=>device.id===key)),models);await page.getByRole('button',{name:'预览选中设备',exact:true}).click();
 const sequence=page.getByTestId('line-equipment-sequence');await sequence.locator('.empty').waitFor({state:'hidden'});const slider=page.getByRole('slider',{name:'产线联动流程进度',exact:true});
 for(const kind of ['feed','fill','spray','drain','blow','reclaim']){
  const step=plan.steps.find(item=>item.kind===kind);assert.ok(step);await setTime(slider,step.start+step.duration/2);assert.equal(await sequence.getAttribute('data-step-kind'),kind);await sequence.locator('.preview').screenshot({path:path.join(directory,'line-'+kind+'.png')});
 }
 checks.push('updated cleaner participates in cart feeding, filling, spray, drainage, blow and unloading');
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);assert.deepEqual(await api('/api/devices'),devices);
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,writes,directory},null,2));console.log(JSON.stringify({success:true,checks,errors,writes,directory},null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
