// Real built registry/map with an owned SQLite fixture; no live factory is edited.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright'),Database=require('../backend/node_modules/better-sqlite3');
const {createRunDirectory,startLoggedProcess,waitUntil,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
const {stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const directory=createRunDirectory('factory-density-tooltips-ui'),errors=[],checks=[];
let server,browser,page;
const pass=name=>{checks.push(name);console.log('PASS '+name)};
(async()=>{
  const infoFile=path.join(directory,'server.json');
  server=startLoggedProcess(process.execPath,[path.join(__dirname,'manual-disassembly-ui-server.cjs')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,MANUAL_LAYOUT_UI_INFO_FILE:infoFile},logFile:path.join(directory,'backend.log')});
  await waitUntil(()=>{assert.equal(server.exitCode,null);return fs.existsSync(infoFile)},60000,'owned backend');const info=JSON.parse(fs.readFileSync(infoFile));
  const db=new Database(requireTestPath(info.database));
  db.prepare('UPDATE factories SET location_json=? WHERE id=?').run(JSON.stringify({country:'CHN',regionCode:'120000'}),'factory_default');
  for(const [id,name,country,region,count] of [['density_b','第二工厂','CHN','610000',3],['density_c','江苏一厂','CHN','320000',1],['density_d','江苏二厂','CHN','320000',1],['density_empty','空工厂','CHN','330000',0],['density_kor','韩国工厂','KOR','',7]]){
    db.prepare('INSERT INTO factories(id,name,location_json) VALUES(?,?,?)').run(id,name,JSON.stringify({country,regionCode:region}));
    if(!count)continue;
    db.prepare('INSERT INTO workshops(id,factory_id,name) VALUES(?,?,?)').run(id+'_ws',id,name+'车间');
    db.prepare('INSERT INTO lines(id,workshop_id,name) VALUES(?,?,?)').run(id+'_line',id+'_ws',name+'产线');
    for(let i=0;i<count;i++)db.prepare('INSERT INTO devices(id,line_id,name,model_type,plc_enabled) VALUES(?,?,?,?,0)').run(id+'_d'+i,id+'_line',name+'设备'+(i+1),'builtin_furnace');
  }
  db.close();
  browser=await playwright.chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{}),args:['--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('digital_twin_admin_ui_state_v1',JSON.stringify({activeTab:'factories'})));
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  const reads=[],writes=[];page.on('request',r=>{const url=new URL(r.url());if(['workshops','lines','devices'].some(x=>url.pathname==='/api/'+x))reads.push({path:url.pathname,factory:r.headers()['x-factory-id']});if(!['GET','HEAD'].includes(r.method())&&/^\/api\/(factories|workshops|lines|devices|settings)(\/|$)/.test(url.pathname))writes.push(url.pathname)});
  await page.goto(info.origin+'/admin');await page.getByRole('textbox',{name:'账号',exact:true}).fill(info.username);await page.getByLabel('后台密码',{exact:true}).fill(info.password);await page.getByRole('button',{name:'解锁后台',exact:true}).click();await page.locator('.factory-table').waitFor();
  const tooltip=page.getByRole('tooltip');
  for(const [kind,label,name,count] of [['workshops','车间','第二工厂车间',1],['lines','产线','第二工厂产线',1],['devices','设备','第二工厂设备1',3]]){
    const button=page.getByRole('button',{name:`第二工厂的${label}：${count}`,exact:true});
    await page.mouse.move(2,2);await button.hover();await tooltip.locator('li').filter({hasText:new RegExp('^'+name+'$')}).waitFor();
    assert.equal(await tooltip.getAttribute('data-factory-id'),'density_b');assert.equal(await tooltip.getAttribute('data-kind'),kind);
    assert.equal(await tooltip.locator('li').count(),count);assert.equal(await tooltip.getByText('现场设备A',{exact:true}).count(),0);
    await tooltip.hover();assert.ok(await tooltip.isVisible());await tooltip.screenshot({path:path.join(directory,`names-${kind}.png`)});
    const requests=reads.filter(r=>r.factory==='density_b'&&r.path==='/api/'+kind).length;
    assert.equal(requests,1);await page.mouse.move(2,2);await tooltip.waitFor({state:'hidden'});await button.hover();await tooltip.locator('li').filter({hasText:new RegExp('^'+name+'$')}).waitFor();
    assert.equal(reads.filter(r=>r.factory==='density_b'&&r.path==='/api/'+kind).length,1,'repeat hover uses the short-lived cache');
    await button.focus();await page.keyboard.press('Escape');await tooltip.waitFor({state:'hidden'});
  }
  pass('three count columns expose real scoped names on hover/focus; lists stay open under the pointer and cached hovers do not repeat requests');
  const fence=reads.length;await page.mouse.move(2,2);await page.getByRole('button',{name:'空工厂的设备：0',exact:true}).hover();await tooltip.getByText('暂无设备',{exact:true}).waitFor();assert.equal(reads.length,fence);
  await page.mouse.move(2,2);await tooltip.waitFor({state:'hidden'});
  const preview=page.getByRole('dialog',{name:'工厂分布轻量预览'});await page.getByRole('button',{name:/工厂分布预览/}).click();await preview.locator('[data-region-code="610000"]').waitFor();
  const area=code=>preview.locator(`[data-region-code="${code}"]`),fill=el=>el.evaluate(node=>getComputedStyle(node).fill),brightness=color=>color.match(/\d+/g).map(Number).reduce((a,b)=>a+b,0);
  assert.equal(await area('610000').getAttribute('data-device-count'),'3');assert.equal(await area('320000').getAttribute('data-device-count'),'2');assert.equal(await area('330000').getAttribute('data-device-count'),'0');
  assert.ok(brightness(await fill(area('610000')))<brightness(await fill(area('320000'))));assert.ok(brightness(await fill(area('320000')))<brightness(await fill(area('330000'))));
  assert.equal(await fill(area('130000')),'rgb(232, 237, 244)','unoccupied areas retain original blue');
  assert.equal(await fill(area('330000')),'rgb(237, 247, 240)','a registered factory with zero devices still uses the lightest green');
  await preview.screenshot({path:path.join(directory,'china-green-density.png')});await preview.getByRole('button',{name:'全球地图',exact:true}).click();
  assert.equal(await area('KOR').getAttribute('data-device-count'),'7');assert.ok(Number(await area('CHN').getAttribute('data-device-count'))>7);
  assert.ok(brightness(await fill(area('CHN')))<brightness(await fill(area('KOR'))));await preview.screenshot({path:path.join(directory,'world-green-density.png')});
  pass('province and world map fills use summed device counts rather than factory markers; higher counts are darker green and zero stays pale');
  // Failed reads must not masquerade as empty inventories.
  await page.reload();await page.locator('.factory-table').waitFor();await page.route('**/api/devices',route=>route.fulfill({status:503,json:{error:'名称暂不可用'}}));
  await page.getByRole('button',{name:'第二工厂的设备：3',exact:true}).hover();await tooltip.getByText('名称暂不可用',{exact:true}).waitFor();assert.equal(await tooltip.getByText('暂无设备',{exact:true}).count(),0);
  await page.mouse.move(2,2);await tooltip.waitFor({state:'hidden'});await page.unroute('**/api/devices');await page.getByRole('button',{name:'第二工厂的设备：3',exact:true}).hover();await tooltip.getByText('第二工厂设备1',{exact:true}).waitFor();
  await page.setViewportSize({width:800,height:700});await waitUntil(async()=>{const box=await tooltip.boundingBox();return box&&box.x>=0&&box.y>=0&&box.x+box.width<=800&&box.y+box.height<=700},5000,'popover follows resized viewport');
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);pass('empty and error states are distinct, errors retry successfully, popovers fit small windows and no factory activation/configuration writes occur');
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,errors,directory},null,2));console.log(directory);
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png')}).catch(()=>{});console.error(error.stack);process.exitCode=1})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server)});
