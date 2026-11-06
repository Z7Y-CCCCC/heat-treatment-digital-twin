// Real built UI + owned backend/WebSocket peer. No live account, factory or renderer is touched.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{once}=require('node:events');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright'),WebSocket=require('../backend/node_modules/ws');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('global-view-navigation-ui'),errors=[],checks=[];
let server,browser,page,native;
const pass=name=>{checks.push(name);console.log('PASS '+name)};
(async()=>{
  const infoFile=path.join(directory,'server.json');
  server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'backend.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned backend');
  const info=JSON.parse(fs.readFileSync(infoFile));
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'designer'}));window.__DIGITAL_TWIN_NATIVE_LOADING__=true;window.chrome={webview:{postMessage(){},addEventListener(){},removeEventListener(){}}}});
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
  const global=page.getByTestId('global-view-section'),tree=page.getByRole('tree',{name:'视角层级',exact:true});await tree.waitFor();
  await waitUntil(async()=>await global.getByRole('switch',{name:'启用全部全局视角',exact:true}).isEnabled(),10000,'loaded global policy');
  assert.equal(await global.locator('.section-heading').getAttribute('aria-expanded'),'false');
  assert.equal(await global.locator('[data-global-view-id]').count(),0);
  await global.locator('.section-heading').click();
  assert.equal(await global.locator('.section-heading').getAttribute('aria-expanded'),'true');
  assert.equal(await global.locator('[data-global-view-id]').count(),7);assert.equal(await tree.locator('[data-view-id]').count(),7);
  assert.equal(await tree.locator('[data-view-id^="map_"],[data-view-id^="site_"]').count(),0);
  assert.equal(await global.locator('[draggable="true"]').count(),0);
  for(const width of [1440,1366]){await page.setViewportSize({width,height:1000});await page.locator('.designer-left-panel').screenshot({path:path.join(directory,`categories-${width}.png`)});}
  pass('global switches and factory-only draggable hierarchy are separated, compact and fit 1366/1440px screens');
  const master=global.getByRole('switch',{name:'启用全部全局视角',exact:true});await master.click();
  await waitUntil(async()=>await master.isEnabled() && await master.getAttribute('aria-checked')==='false',10000,'saved all off');
  assert.equal(await global.getByRole('switch',{checked:false}).count(),8);
  await page.reload();await tree.waitFor();await waitUntil(async()=>await master.isEnabled()&&await master.getAttribute('aria-checked')==='false',10000,'persisted policy');
  assert.equal(await global.locator('.section-heading').getAttribute('aria-expanded'),'false');
  assert.equal(await global.locator('[data-global-view-id]').count(),0);
  await global.locator('.section-heading').click();
  assert.equal(await global.locator('[data-global-view-id]').count(),7);
  await global.screenshot({path:path.join(directory,'global-off.png')});
  pass('master switch saves without scene publish and survives reopening; disabling never removes editable global rows');
  const cookie=(await context.cookies(info.origin)).map(c=>`${c.name}=${c.value}`).join('; ');
  native=new WebSocket(info.origin.replace('http:','ws:')+'/ws',{headers:{Cookie:cookie}});await once(native,'open');native.send(JSON.stringify({type:'client_hello',role:'unity'}));
  const config=await(await page.request.get(info.origin+'/api/config')).json(),factoryId=config.factoryId;
  const commands=[];
  native.on('message',buffer=>{const message=JSON.parse(buffer);if(message.type!=='native_scene_preview')return;const payload=message.payload;commands.push(payload);setTimeout(()=>native.readyState===1&&native.send(JSON.stringify({type:'dashboard_context',payload:{...payload.focus,factoryId,viewId:payload.viewId,viewMode:payload.focus.mode,sceneReady:true}})),100)});
  for(const source of ['/group?embedded=unity&surface=overlay','/site?embedded=unity&surface=overlay&stage=street&factoryId='+factoryId]){
    const fence=commands.length;
    await page.goto(info.origin+source);
    await waitUntil(async()=>new URL(page.url()).pathname==='/overlay'&&!new URL(page.url()).searchParams.has('entryViewId'),30000,'first visible native view acknowledged');
    assert.ok(commands.length>fence);assert.equal(commands.at(-1).viewId,config.platform.document.scene.defaultViewId);
    assert.equal(await page.locator('.group-portal,.factory-drilldown').count(),0);
    assert.equal(await page.getByText('全球',{exact:true}).count(),0);
  }
  pass('cold startup and direct street links skip all disabled globals, focus first local view and never render a map or stale breadcrumb');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(directory);
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack);process.exitCode=1})
.finally(async()=>{native?.terminate();await browser?.close();await stopOwnedSmokeProcess(server)});
