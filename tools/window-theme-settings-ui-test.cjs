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
  assert.equal(await panel.getByRole('button',{name:'蓝白',exact:true}).count(),0);
  assert.equal(await panel.getByRole('button',{name:'深色',exact:true}).count(),0);
  const trigger=page.getByRole('button',{name:'外观设置',exact:true});
  const popover=page.getByRole('dialog',{name:'外观设置',exact:true});
  const open=async()=>{await trigger.click();await popover.waitFor();await waitUntil(async()=>await popover.getByRole('button',{name:'深色',exact:true}).isEnabled(),8000,'appearance loaded')};
  await open();await popover.getByRole('button',{name:'150%',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--admin-font-scale')),'1.5');
  const title=panel.getByRole('textbox',{name:'主标题',exact:true});await title.fill('未保存的启动标题');
  // Editing elsewhere closes only the popover, never the page's unsaved fields.
  if(!await popover.isVisible())await open();
  const before=(await (await context.request.get(info.origin+'/api/settings/loading-experience')).json()).config;
  for(const [name,theme,background] of [['深色','dark','#28282b'],['蓝白','light','#f5f7fb']]){
    const response=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname==='/api/settings/loading-experience/config');
    await popover.getByRole('button',{name,exact:true}).click();const saved=await response;assert.equal(saved.status(),200);
    assert.deepEqual(saved.request().postDataJSON(),{theme});
    const config=await (await context.request.get(info.origin+'/api/settings/loading-experience')).json();
    assert.equal(config.config.theme,theme);assert.equal(config.config.background,background);assert.equal(config.config.title,before.title);
    assert.equal(await title.inputValue(),'未保存的启动标题');
    assert.ok(await page.evaluate(()=>window.themeNotices.some(message=>message.type==='loading_appearance_changed')));
    assert.ok(await popover.isVisible());await page.screenshot({path:path.join(directory,theme+'.png')});
  }
  checks.push('one Aa appearance button contains both features; theme saves touch no title/image/draft or text-size preference');
  await page.keyboard.press('Escape');await popover.waitFor({state:'hidden'});assert.ok(await trigger.evaluate(el=>document.activeElement===el));
  const contentResponse=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname==='/api/settings/loading-experience/config');
  await panel.getByRole('button',{name:'保存加载画面',exact:true}).click();const contentSaved=await contentResponse;
  assert.equal(contentSaved.status(),200);assert.equal(Object.hasOwn(contentSaved.request().postDataJSON(),'theme'),false);
  assert.equal((await contentSaved.json()).config.theme,'light');
  await page.reload();await panel.waitFor();await open();
  assert.equal(await popover.getByRole('button',{name:'蓝白',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await popover.getByRole('button',{name:'150%',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await title.inputValue(),'未保存的启动标题');
  checks.push('reopening retains theme and font size independently; content saves do not reset the toolbar theme');
  await page.route('**/api/settings/loading-experience/config',route=>route.fulfill({status:503,json:{error:'主题保存暂不可用'}}));
  await popover.getByRole('button',{name:'深色',exact:true}).click();await popover.getByRole('alert').filter({hasText:'主题保存暂不可用'}).waitFor();
  assert.equal(await popover.getByRole('button',{name:'蓝白',exact:true}).getAttribute('aria-pressed'),'true');
  await popover.getByRole('button',{name:'100%',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--admin-font-scale')),'1');
  await page.unroute('**/api/settings/loading-experience/config');
  checks.push('a failed theme save gives an error, keeps the confirmed theme, and leaves font controls usable');
  await popover.getByRole('button',{name:'200%',exact:true}).click();await page.setViewportSize({width:760,height:600});await page.waitForTimeout(100);
  let bounds=await popover.boundingBox();assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=760&&bounds.y+bounds.height<=600);
  await page.screenshot({path:path.join(directory,'compact-200-percent.png')});
  // Copy/drag starting inside must not dismiss the menu on outside release.
  const heading=await popover.locator('.appearance-heading strong').boundingBox();await page.mouse.move(heading.x+4,heading.y+5);await page.mouse.down();await page.mouse.move(bounds.x-8,heading.y+5,{steps:8});await page.mouse.up();assert.ok(await popover.isVisible());
  await page.keyboard.press('Escape');await popover.waitFor({state:'hidden'});await trigger.click();await popover.waitFor();
  await page.mouse.click(2,590);await popover.waitFor({state:'hidden'});
  checks.push('large text and smaller windows keep the floating panel within bounds; Escape/outside-click close it, while a text-selection drag does not');
  // Ordinary users retain local reading controls, but no new global edit grant.
  const owner=(await (await context.request.get(info.origin+'/api/admin-auth/session')).json());
  const created=await context.request.post(info.origin+'/api/admin-auth/users',{headers:{Origin:info.origin,'X-Admin-Request':'1','X-CSRF-Token':owner.csrfToken},data:{username:'appearance_reader',password:info.password,role:'viewer',permissions:{view:true},pagePermissions:{devices:{view:true}}}});
  assert.equal(created.status(),201,await created.text());
  const reader=await browser.newContext({viewport:{width:1440,height:1000}}),readerPage=await reader.newPage();
  await readerPage.goto(info.origin+'/admin');await readerPage.getByRole('textbox',{name:'账号',exact:true}).fill('appearance_reader');await readerPage.getByLabel('后台密码',{exact:true}).fill(info.password);await readerPage.getByRole('button',{name:'解锁后台',exact:true}).click();
  await readerPage.getByRole('button',{name:'外观设置',exact:true}).click();const readerPanel=readerPage.getByRole('dialog',{name:'外观设置',exact:true});await readerPanel.waitFor();
  assert.ok(await readerPanel.getByRole('button',{name:'深色',exact:true}).isDisabled());await readerPanel.getByRole('button',{name:'130%',exact:true}).click();
  assert.equal(await readerPage.evaluate(()=>document.documentElement.style.getPropertyValue('--admin-font-scale')),'1.3');await reader.close();
  checks.push('a read-only user can adjust local typography but cannot change the shared theme');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(JSON.stringify({success:true,checks,directory}));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error);process.exitCode=1}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
