// Persist both cosmetic themes through the real settings page/API in an owned DB.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('window-theme-settings-ui'),checks=[],errors=[];
let server,browser,page;
(async()=>{
  const infoFile=path.join(directory,'server.json');
  server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'backend.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned settings backend');
  const info=JSON.parse(fs.readFileSync(infoFile));
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{
    localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'loading'}));
    window.themeNotices=[];window.chrome={webview:{postMessage(message){window.themeNotices.push(message)},addEventListener(){},removeEventListener(){}}};
  });
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
  const panel=page.getByTestId('platform-loading-panel');await panel.waitFor();
  for(const [name,theme,background] of [['深色','dark','#28282b'],['蓝白','light','#f5f7fb']]){
    const button=panel.getByRole('button',{name,exact:true});await button.click();
    const response=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/api/settings');
    await panel.getByRole('button',{name:'保存加载画面',exact:true}).click();assert.equal((await response).status(),200);
    const config=await (await context.request.get(info.origin+'/api/settings/loading-experience')).json();
    assert.equal(config.config.theme,theme);assert.equal(config.config.background,background);
    assert.ok(await page.evaluate(()=>window.themeNotices.some(message=>message.type==='loading_appearance_changed')));
    await page.screenshot({path:path.join(directory,theme+'.png')});
    await page.reload();await panel.waitFor();await waitUntil(async()=>await panel.getByRole('button',{name,exact:true}).getAttribute('aria-pressed')==='true',8000,'saved theme after reopening');
    assert.equal(await panel.locator('input[type="color"]').count(),0);
    checks.push(`${name}: saved to real settings, public loading API matches, native notified, reopening retains choice`);
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks,directory}));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
