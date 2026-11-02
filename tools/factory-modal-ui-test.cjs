// Owned fixture only; do not lock or refresh the user's live editing session.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('factory-modal-ui'), checks = [], errors = [];
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
    const context = await browser.newContext({ viewport: { width: 1626, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'factories' })));
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();

    const create=page.getByRole('button',{name:'＋ 新建工厂',exact:true});await create.waitFor();await create.click();
    const dialog=page.getByRole('dialog',{name:'新建工厂',exact:true});await dialog.waitFor();
    const close=dialog.getByRole('button',{name:'关闭',exact:true}), name=dialog.getByRole('textbox',{name:'工厂名称',exact:true});
    await name.fill('保留我的工厂草稿');
    const cardBox=await dialog.boundingBox(),closeBox=await close.boundingBox();
    assert.ok(Math.abs(closeBox.y-cardBox.y-9)<2);
    assert.ok(Math.abs(cardBox.x+cardBox.width-closeBox.x-closeBox.width-9)<2);
    assert.equal(await close.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    check('close control sits 8px inside the card top-right, has no background and keeps its accessible name');
    const inputBox=await name.boundingBox();
    await page.mouse.move(inputBox.x+40,inputBox.y+15);await page.mouse.down();await page.mouse.move(8,8,{steps:12});await page.mouse.up();
    assert.ok(await dialog.isVisible());assert.equal(await name.inputValue(),'保留我的工厂草稿');
    await page.mouse.click(8,8);assert.ok(await dialog.isVisible());
    await page.mouse.wheel(0,500);assert.ok(await dialog.isVisible());
    await page.screenshot({path:path.join(directory,'01-factory-modal-safe-close.png'),fullPage:true});
    check('drag-selection, release over the backdrop, backdrop clicks and scrolling preserve the dialog and draft');
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
    await create.click();await dialog.waitFor();await close.click();await dialog.waitFor({state:'hidden'});
    await create.click();await dialog.waitFor();await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
    check('explicit close, cancel and Escape remain functional');
    assert.deepEqual(errors,[]);const result={success:true,checks,browserErrors:errors,directory};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
})().catch(async error=>{await page?.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();await stopOwnedSmokeProcess(server);});
