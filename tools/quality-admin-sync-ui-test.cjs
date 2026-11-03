// Owned backend + two real same-origin browser pages. The native renderer
// acknowledgement is a fixture; no live Unity/profile/account is manipulated.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('quality-admin-sync'),checks=[],errors=[];
let server,browser,admin,dashboard;
const pass=text=>{checks.push(text);console.log('PASS '+text)};
(async()=>{
  const infoFile=path.join(directory,'server.json');
  server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'server.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned backend');
  const info=JSON.parse(fs.readFileSync(infoFile));
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  admin=await context.newPage();admin.setDefaultTimeout(30000);admin.on('pageerror',e=>errors.push(e.message));
  await admin.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'settings',settingsSubpage:'performance'})));
  await admin.goto(info.origin+'/admin');await admin.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await admin.getByLabel('后台密码',{exact:true}).fill(info.password);await admin.getByRole('button',{name:'解锁后台',exact:true}).click();
  const selector=()=>admin.getByLabel('现场电脑画质档位',{exact:true});await selector().waitFor();
  assert.equal(await admin.getByText('模型几何策略',{exact:true}).count(),0);
  assert.equal(await admin.getByText('始终保留导入模型完整几何',{exact:true}).count(),0);
  const settings=()=>admin.request.get(info.origin+'/api/settings').then(r=>r.json());
  const before=await settings();let settingsWrites=0,engineRestarts=0;
  admin.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname==='/api/settings')settingsWrites++;if(new URL(r.url()).pathname==='/api/engine/restart')engineRestarts++});
  dashboard=await context.newPage();dashboard.setDefaultTimeout(30000);dashboard.on('pageerror',e=>errors.push(e.message));
  await dashboard.addInitScript(()=>{
    const listeners=new Set();let revision=0;
    window.__nativeQualityFixture={profile:'balanced',automatic:true,commands:[]};
    window.chrome=window.chrome||{};
    window.chrome.webview={addEventListener:(name,f)=>{if(name==='message')listeners.add(f)},removeEventListener:(name,f)=>listeners.delete(f),
      postMessage:command=>{
        if(command.type!=='dashboard_action'||!['get_quality_profile','set_quality_profile','quality_hotkey'].includes(command.action))return;
        const state=window.__nativeQualityFixture;state.commands.push(command);
        if(command.action!=='get_quality_profile'){state.automatic=command.profile==='auto';state.profile=state.automatic?'balanced':command.profile}
        const snapshot={type:'native_quality_state',revision:++revision,profile:state.profile,automatic:state.automatic,enabled:true,hotkeysEnabled:true,requestId:command.requestId||'',notify:command.action!=='get_quality_profile'};
        queueMicrotask(()=>{for(const f of listeners)f({data:snapshot})});
      }};
  });
  await dashboard.goto(info.origin+'/group?embedded=unity');
  await dashboard.locator('.account-dock').hover();await dashboard.locator('.group-user').click();
  const capsule=dashboard.getByRole('radiogroup',{name:'画质档位',exact:true});await capsule.waitFor();
  await waitUntil(()=>capsule.getByRole('radio').first().isEnabled(),10000,'native acknowledgement fixture');
  await capsule.getByRole('radio',{name:'高画质 F3',exact:true}).click();
  await waitUntil(async()=>await selector().inputValue()==='showcase',10000,'capsule to admin synchronization');
  assert.deepEqual(await settings(),before);assert.equal(settingsWrites,0);
  pass('dashboard capsule updates the real admin selector without silently persisting a runtime override');
  for(const[key,profile]of[['F1','integrated_gpu'],['F2','balanced'],['F3','showcase']]){
    await dashboard.keyboard.press(key);await waitUntil(async()=>await selector().inputValue()===profile,5000,'hotkey synchronization '+key);
  }
  pass('F1/F2/F3 synchronize the backend page, including when its WebView is not focused');
  await selector().selectOption('balanced');
  await waitUntil(()=>dashboard.evaluate(()=>window.__nativeQualityFixture.profile==='balanced'&&!window.__nativeQualityFixture.automatic),5000,'admin selection acknowledged by native fixture');
  assert.equal(await capsule.getByRole('radio',{name:'均衡 F2',exact:true}).getAttribute('aria-checked'),'true');
  await selector().selectOption('auto');await waitUntil(()=>dashboard.evaluate(()=>window.__nativeQualityFixture.automatic),5000,'auto selection acknowledged');
  assert.equal(await selector().inputValue(),'auto');
  pass('admin changes relay back to the same native controller, including automatic mode');
  await dashboard.keyboard.press('F3');await waitUntil(async()=>await selector().inputValue()==='showcase',5000,'high profile before explicit save');
  const saving=admin.waitForResponse(r=>new URL(r.url()).pathname==='/api/settings'&&r.request().method()!=='GET');
  await admin.getByRole('button',{name:'保存当前参数',exact:true}).click();const response=await saving;assert.equal(response.status(),200);
  assert.deepEqual(response.request().postDataJSON(),{native_quality_profile:'showcase'});assert.equal((await settings()).native_quality_profile,'showcase');assert.equal(engineRestarts,0);
  await admin.getByRole('button',{name:'确定',exact:true}).click();
  pass('explicit Save persists the current confirmed profile only and does not restart acquisition');
  await dashboard.keyboard.press('F1');await waitUntil(async()=>await selector().inputValue()==='integrated_gpu',5000,'temporary switch after save');
  await admin.reload();await selector().waitFor();await waitUntil(async()=>await selector().inputValue()==='integrated_gpu',10000,'late/reloaded admin snapshot');
  assert.equal((await settings()).native_quality_profile,'showcase');assert.equal(await admin.locator('.quality-notice').count(),0);
  await admin.screenshot({path:path.join(directory,'admin-synced.png')});
  pass('reopening the admin page queries the latest renderer state, not its saved startup default, and replays no success toast');
  assert.deepEqual(errors,[]);const result={success:true,directory,checks,browserErrors:errors};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await admin?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack||error.message);process.exitCode=1})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
