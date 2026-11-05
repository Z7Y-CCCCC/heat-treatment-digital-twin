// Close/reopen an owned browser profile; never stop the operator's application.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright'),Database=require('../backend/node_modules/better-sqlite3');
const {createRunDirectory,startLoggedProcess,waitUntil,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('collector-mode-restore-ui'),errors=[],checks=[];let helper,context,page;
(async()=>{
  const file=path.join(directory,'server.json');helper=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:file},logFile:path.join(directory,'backend.log')});
  await waitUntil(()=>{assert.equal(helper.exitCode,null);return fs.existsSync(file)},60000,'owned backend');const info=JSON.parse(fs.readFileSync(file));
  const db=new Database(requireTestPath(info.database));db.prepare('UPDATE devices SET plc_enabled=0').run();db.close();
  const writes=[];
  async function reopen(){
    context=await playwright.chromium.launchPersistentContext(path.join(directory,'browser-profile'),{headless:true,viewport:{width:1440,height:1000},...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
    await context.addInitScript(()=>{if(!localStorage.getItem('digital_twin_admin_ui_state_v1'))localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'settings',settingsSubpage:'data'}))});
    page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(r.method()==='PUT'&&new URL(r.url()).pathname==='/api/collector/mode')writes.push(r.postDataJSON())});
    await page.goto(info.origin+'/admin');const panel=page.getByRole('region',{name:'采集进程健康状态',exact:true}),unlock=page.getByRole('button',{name:'解锁后台',exact:true});
    await waitUntil(async()=>await panel.isVisible()||await unlock.isVisible(),20000,'restored workspace or sign-in');
    if(await unlock.isVisible()){await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await unlock.click()}
    await panel.waitFor();await waitUntil(async()=>await panel.locator('nav button[aria-pressed="true"]').count()===1&&await panel.locator('nav button').first().isEnabled(),15000,'saved source loaded');return panel;
  }
  let panel=await reopen();
  for(const [mode,label] of [['external','外部接口'],['integrated_plc','现场采集'],['simulation','模拟演示']]){
    const button=panel.getByRole('button',{name:label,exact:true});
    if(await button.getAttribute('aria-pressed')!=='true'){
      await button.click();await page.locator('.app-dialog[role=dialog]').waitFor();await page.locator('.app-dialog-actions button').last().click();
      await waitUntil(async()=>await button.getAttribute('aria-pressed')==='true'&&await button.isEnabled(),15000,'source confirmed and saved');
    }
    assert.equal((await(await page.request.get(info.origin+'/api/collector/status')).json()).configuredMode,mode);
    await context.close();context=null;const fence=writes.length;panel=await reopen();
    assert.equal(await panel.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed'),'true');assert.equal(writes.length,fence,'opening the software reads saved preference without overwriting it');
    await panel.screenshot({path:path.join(directory,`restored-${mode}.png`)});checks.push(mode);console.log(`PASS close/reopen profile restores ${label} without startup mode writes`);
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory,noSiteInterruption:true,noPlcConnections:true},null,2));console.log(directory);
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack);process.exitCode=1})
.finally(async()=>{await context?.close();await stopOwnedSmokeProcess(helper)});
