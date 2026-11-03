// Owned backend + simulated TV responses; never touch the user's session or TVs.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('quick-cast-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    const info = JSON.parse(fs.readFileSync(infoFile));
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => { window.__DIGITAL_TWIN_NATIVE_LOADING__=true;window.__hostMessages=[];window.chrome={webview:{postMessage:m=>window.__hostMessages.push(m),addEventListener(){},removeEventListener(){}}}; });
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.getByRole('banner',{name:'后台工具栏'}).waitFor();
    let session = null, reads = 0, failStart = false, noDevices = false;
    const commands = [], tv = { id: 'test-tv', name: '车间接待屏', address: '192.0.2.10' };
    await page.route('**/api/system/cast/**', async route => {
        const action = new URL(route.request().url()).pathname.split('/').at(-1);
        if (action === 'start') {
            commands.push(['start', route.request().postDataJSON().deviceId]);
            if (failStart) return route.fulfill({ json: { success:false, error:'电视暂时离线' }, status:400 });
            session = { deviceId:tv.id, deviceName:tv.name, state:'waiting_for_tv' };
        } else if(action === 'stop') { commands.push(['stop']); session = null; }
        else if(action === 'devices') reads++;
        await route.fulfill({ json: { success:true, devices:noDevices?[]:[tv], cast:{ ffmpegChecked:true, ffmpegAvailable:true, casting:!!session, session } } });
    });
    await page.goto(info.origin+'/group?embedded=unity&surface=overlay');
    await page.locator('.group-user').click();
    const menu = page.getByRole('region',{name:'账户设置',exact:true});
    const css = await menu.evaluate(el => ({background:getComputedStyle(el).backgroundImage,blur:getComputedStyle(el).backdropFilter}));
    assert.match(css.background, /0\.98/); assert.match(css.blur,/28px/);
    await page.screenshot({path:path.join(directory,'01-readable-account-menu.png')});
    check('account popover has an independent deep-purple glass surface, never the transparent chart skin');
    await menu.getByRole('button',{name:'投屏',exact:true}).click();
    const picker = page.getByRole('region',{name:'快捷投屏',exact:true}), originalUrl = page.url();
    await picker.getByRole('button',{name:/车间接待屏/}).click();
    assert.equal(commands.length,0);
    await picker.getByRole('button',{name:'开始投屏',exact:true}).click();
    await picker.getByText('等待电视接收',{exact:true}).waitFor();
    assert.equal(page.url(),originalUrl); assert.deepEqual(commands,[['start',tv.id]]);
    await page.screenshot({path:path.join(directory,'02-casting-picker.png')});
    check('TV selection, confirmation and real API command stay inside account popover; waiting is not falsely labelled playing');
    await picker.getByRole('button',{name:'返回账户菜单'}).click();
    const previousReads = reads; await page.waitForTimeout(3400);
    assert.equal(reads,previousReads); assert.equal(commands.length,1);
    await menu.getByRole('button',{name:'投屏',exact:true}).click();
    await picker.getByText('等待电视接收',{exact:true}).waitFor();
    await picker.getByRole('button',{name:'停止',exact:true}).click();
    await picker.getByRole('region',{name:'当前投屏',exact:true}).waitFor({state:'hidden'});
    check('leaving picker stops its polling but keeps TV playing; reopening reads session and stop disconnects explicitly');
    failStart = true;
    await picker.getByRole('button',{name:/车间接待屏/}).click();
    await picker.getByRole('button',{name:'开始投屏',exact:true}).click();
    await picker.getByRole('alert').getByText('电视暂时离线',{exact:true}).waitFor();
    assert.equal(await picker.getByRole('region',{name:'当前投屏',exact:true}).count(),0);
    await page.keyboard.press('Escape');
    await picker.waitFor({state:'hidden'});
    noDevices = true;
    await menu.getByRole('button',{name:'投屏',exact:true}).click();
    await picker.getByText('未发现电视',{exact:true}).waitFor();
    await page.setViewportSize({width:400,height:650});
    const box=await menu.boundingBox();assert.ok(box.x>=0 && box.x+box.width<=400 && box.y+box.height<=650);
    await page.screenshot({path:path.join(directory,'03-small-screen-empty-picker.png')});
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
    check('errors and empty discovery are actionable without duplicate notices; Escape returns one level and compact windows remain bounded');
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(info.origin+'/admin');
    await page.getByRole('banner',{name:'后台工具栏'}).waitFor();
    await page.getByText('系统设置',{exact:true}).first().click();
    const nav=page.getByRole('navigation',{name:'系统设置分类'});
    const geometry=[];
    for(const title of ['项目迁移','数据连接与备份','客户端性能']){
        await nav.getByRole('button',{name:new RegExp(title)}).click();
        await page.waitForTimeout(220);
        geometry.push(await nav.evaluate(el=>({box:[el.offsetWidth,el.offsetHeight],display:getComputedStyle(el).display,columns:getComputedStyle(el).gridTemplateColumns,items:[...el.querySelectorAll('button')].map(b=>({height:b.offsetHeight,number:getComputedStyle(b.querySelector('.secondary-page-number')).display,desc:getComputedStyle(b.querySelector('small')).display}))})));
    }
    assert.deepEqual(geometry[0],geometry[1]);assert.deepEqual(geometry[1],geometry[2]);
    await page.screenshot({path:path.join(directory,'04-consistent-settings-navigation.png')});
    check('migration, database and quality subpages keep identical numbered card navigation and geometry');
    assert.deepEqual(errors,[]);
    const result={success:true,checks,browserErrors:errors,directory,realTelevisionValidated:false};
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;})
.finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});
