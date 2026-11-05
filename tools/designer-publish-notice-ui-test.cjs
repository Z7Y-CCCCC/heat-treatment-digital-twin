// Real designer publication against an owned fixture; site drafts/releases are untouched.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {createRunDirectory,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('designer-publish-notice-ui'),errors=[],checks=[];
let server,browser,page;
const pass=name=>{checks.push(name);console.log('PASS '+name)};
(async()=>{
  const infoFile=path.join(directory,'server.json');
  server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'backend.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned backend');const info=JSON.parse(fs.readFileSync(infoFile));
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'platform',platformSubpage:'designer'})));
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();
  const publish=page.locator('.designer-toolbar .publish-button'),notice=page.getByTestId('designer-publish-notice');await publish.waitFor();await waitUntil(async()=>!(await publish.isDisabled()),10000,'designer ready');
  const shell=await page.locator('.dashboard-designer-shell').elementHandle();let posts=0;
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/platform/releases')posts++});
  const published=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/platform/releases');
  await publish.click();const response=await published;assert.equal(response.status(),200);const release=(await response.json()).release;
  await notice.filter({hasText:`保存并发布成功（版本 ${release.version}）`}).waitFor();assert.equal(await notice.getAttribute('role'),'status');
  assert.equal(await shell.evaluate(el=>el.isConnected),true);await page.screenshot({path:path.join(directory,'01-publish-success.png')});
  await notice.waitFor({state:'hidden',timeout:7000});pass('actual successful release shows a top success bubble with its real version, auto-dismisses and keeps the mounted designer intact');
  await page.route('**/api/platform/releases',route=>route.fulfill({status:503,json:{error:'发布服务暂不可用，请重试'}}));
  await publish.click();await notice.filter({hasText:'发布失败：发布服务暂不可用，请重试'}).waitFor();assert.equal(await notice.getAttribute('role'),'alert');
  await page.waitForTimeout(4200);assert.ok(await notice.isVisible());await page.screenshot({path:path.join(directory,'02-publish-failure.png')});
  await notice.getByRole('button',{name:'关闭发布消息',exact:true}).click();await notice.waitFor({state:'hidden'});await page.unroute('**/api/platform/releases');
  pass('publication failure shows a red persistent alert with the reason, leaves the page usable and can be dismissed');
  await page.getByRole('tree',{name:'视角层级',exact:true}).locator('[data-view-id="factory_overview"] .view-tree-select').click();
  const name=page.getByRole('textbox',{name:'视角名称',exact:true});await name.fill('发布提示验证视角');
  await page.route('**/api/platform/designer/draft',route=>route.fulfill({status:409,json:{error:'草稿修订冲突，请重新读取'}}));
  const fence=posts;await publish.click();await notice.filter({hasText:'保存失败：草稿修订冲突，请重新读取'}).waitFor();assert.equal(posts,fence);assert.equal(await name.inputValue(),'发布提示验证视角');
  await page.screenshot({path:path.join(directory,'03-save-failure-retains-draft.png')});await page.unroute('**/api/platform/designer/draft');
  pass('draft-save failure also has a top bubble, preserves edits and never proceeds to publish');
  // Retry must replace the error only after both save and publish have succeeded.
  let resume;const gate=new Promise(resolve=>{resume=resolve});await page.route('**/api/platform/releases',async route=>{await gate;await route.continue()});
  const retry=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/platform/releases');retry.catch(()=>{});await publish.click();
  await waitUntil(async()=>await publish.isDisabled(),5000,'publishing locks duplicate clicks');await notice.waitFor({state:'hidden'});
  await publish.evaluate(el=>el.click());resume();assert.equal((await retry).status(),200);await notice.filter({hasText:'保存并发布成功'}).waitFor();
  assert.equal(posts,fence+1);assert.equal(await name.inputValue(),'发布提示验证视角');await page.unroute('**/api/platform/releases');
  pass('retry clears stale errors, reports success only after acknowledgement and blocks duplicate publication while busy');
  await notice.getByRole('button',{name:'关闭发布消息',exact:true}).click();
  await page.setViewportSize({width:600,height:740});await page.route('**/api/platform/releases',route=>route.fulfill({status:500,json:{error:'接口暂时不可用，当前草稿已保留。'.repeat(12)}}));
  await publish.click();await notice.waitFor();const box=await notice.boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=600&&box.y+box.height<=740);
  await notice.screenshot({path:path.join(directory,'04-long-error-compact.png')});assert.deepEqual(errors,[]);pass('long failures wrap and remain readable inside compact windows without browser errors');
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(directory);
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack);process.exitCode=1})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
