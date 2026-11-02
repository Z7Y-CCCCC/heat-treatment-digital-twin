// Owned fixture only; do not lock or refresh the user's live editing session.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('account-dock-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    const info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'devices' })));
    await context.addInitScript(() => { window.__DIGITAL_TWIN_NATIVE_LOADING__=true;window.__hostMessages=[];window.chrome={webview:{postMessage:m=>window.__hostMessages.push(m),addEventListener(){},removeEventListener(){}}}; });
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();

    await page.getByRole('banner',{name:'后台工具栏'}).waitFor();
    const urls=['/group?level=world','/group?level=country&code=CHN','/group?level=province&code=610000','/group?level=city&code=610100','/group?level=district&code=610112','/site','/overlay?scene=1&view=street_demo','/overlay?scene=1&view=factory_overview','/overlay?scene=1&view=workshop_overview','/overlay?scene=1&view=line_overview','/overlay?scene=1&view=device_view'];
    for(const url of urls){
        await page.goto(info.origin+url+(url.includes('?')?'&':'?')+'embedded=unity&surface=overlay');
        const dock=page.getByLabel('右上角账户入口',{exact:true});await dock.waitFor();
        assert.equal(await page.locator('.group-user').count(),1);
        const box=await dock.boundingBox();assert.ok(Math.abs(box.x+box.width-1440)<1 && box.y===0, url+' at exact top right');
    }
    check('one shared account dock exists at the exact top-right edge for all map levels and street/factory/workshop/line/device routes');
    const dock=page.getByLabel('右上角账户入口',{exact:true});
    await page.mouse.move(400,500);
    await page.waitForFunction(()=>document.querySelector('.account-dock')?.classList.contains('is-hidden'));
    await page.mouse.move(1439,10);
    await page.waitForFunction(()=>!document.querySelector('.account-dock')?.classList.contains('is-hidden'));
    await page.locator('.group-user').click();
    const menu=page.getByRole('region',{name:'账户设置',exact:true});await menu.waitFor();
    await menu.getByRole('button',{name:/管理账户/}).click();
    await menu.getByLabel('账号',{exact:true}).fill('正在输入');
    await page.mouse.move(400,500);await page.waitForTimeout(3000);
    assert.equal(await dock.evaluate(el=>el.classList.contains('is-hidden')),false);
    assert.equal(await menu.getByLabel('账号',{exact:true}).inputValue(),'正在输入');
    await page.screenshot({path:path.join(directory,'01-device-account-menu.png')});
    await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
    await page.locator('.group-user').evaluate(el=>el.blur());
    await page.mouse.move(400,500);
    await page.waitForFunction(()=>document.querySelector('.account-dock')?.classList.contains('is-hidden'));
    await page.locator('.group-user').focus();
    await page.waitForFunction(()=>!document.querySelector('.account-dock')?.classList.contains('is-hidden'));
    check('idle slides out; right-edge hover and keyboard focus restore it; an open menu and typing stay visible');
    await page.waitForTimeout(400);
    const regions=await page.evaluate(()=>window.__hostMessages.filter(m=>m.type==='overlay_regions').at(-1)?.regions||[]);
    assert.ok(regions.some(r=>r.x+r.width>=1439 && r.y===0),'native hit regions include the edge hotspot');
    check('native Unity hit-test geometry retains the corner hotspot and account menu on lower-level views');
    await page.setViewportSize({width:720,height:900});
    await page.getByLabel('右上角账户入口',{exact:true}).screenshot({path:path.join(directory,'02-edge-button.png')});
    assert.deepEqual(errors,[]);
    const result={success:true,checks,browserErrors:errors,directory};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});

