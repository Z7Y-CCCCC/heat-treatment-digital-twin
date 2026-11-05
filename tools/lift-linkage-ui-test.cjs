// Isolated page regression: the lift mechanism stays connected while seeking.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser;
(async()=>{
 const directory=createRunDirectory('lift-linkage-ui'),infoFile=path.join(directory,'server.json'),errors=[];
 server=startLoggedProcess(process.execPath,[path.join(__dirname,'line-simulation-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,LINE_SIMULATION_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
 await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned lift fixture');
 const info=JSON.parse(fs.readFileSync(infoFile));
 browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1600,height:1000}});page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'models',modelLibraryStep:'library'})));
 await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
 await page.locator('[data-model-id="cad_lifting_load_table_111400"]').waitFor();
 await page.getByRole('button',{name:'动作动画',exact:true}).click();await page.getByRole('combobox',{name:'选择动作动画模型',exact:true}).selectOption('cad_lifting_load_table_111400');
 const preview=page.locator('.cad-motion-preview');
 const setTime=async value=>{await preview.getByRole('slider',{name:'CAD 动作进度',exact:true}).evaluate((element,next)=>{element.value=String(next);element.dispatchEvent(new Event('input',{bubbles:true}))},value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))};
 for(const [id,label]of [['lift_up','备料台上升 / 回位'],['lift_down','备料台下降 / 回位']]){
  await page.getByRole('button',{name:'预览 CAD 动作：'+label,exact:true}).click();await preview.locator('.loading').waitFor({state:'hidden'});await preview.getByRole('button',{name:'暂停',exact:true}).click();
  await setTime(0);const home=await preview.locator('canvas').screenshot();await setTime(4);assert.equal(home.equals(await preview.locator('canvas').screenshot()),false);
  await preview.screenshot({path:path.join(directory,id+'-full-stroke.png')});
  const box=await preview.locator('canvas').boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.67,box.y+box.height*.45,{steps:16});await page.mouse.up();
  await preview.screenshot({path:path.join(directory,id+'-rotated.png')});await setTime(8);await preview.screenshot({path:path.join(directory,id+'-returned.png')});
 }
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks:['lift up/down render and seek without page errors','full-stroke, rotated and return frames captured'],errors,directory},null,2));console.log(JSON.stringify({success:true,errors,directory}));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
