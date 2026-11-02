// Owned fixture only: verify the retired template control cannot affect real device editing.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('device-form-ui'), checks = [], errors = [];
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
    page = await context.newPage(); page.setDefaultTimeout(30000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.getByRole('heading', { name: '设备管理', exact: true }).waitFor();
    const form = page.locator('.modal-box').filter({ has: page.getByRole('heading', { name: /^(新增|编辑)设备$/ }) });
    const noTemplate = async () => {
        await form.getByLabel(/^使用模型/).waitFor();
        assert.equal(await form.getByText('设备模板', { exact: true }).count(), 0);
        assert.equal(await form.getByText('不使用模板', { exact: true }).count(), 0);
        assert.equal(await form.getByText('设备逐层检查', { exact: true }).count(), 0);
        assert.equal(await form.getByText('配置策略', { exact: true }).count(), 0);
        assert.equal(await form.getByText('拆解检查覆盖 JSON', { exact: true }).count(), 0);
        assert.ok(await form.getByLabel(/^使用模型/).isVisible());
        assert.ok(await form.getByText('PLC 连接配置', { exact: true }).isVisible());
        assert.ok(await form.getByRole('checkbox', { name: '启用', exact: true }).isVisible());
        assert.equal(await form.getByText('启用此设备直连 PLC 采集', { exact: true }).count(), 0);
    };
    await page.getByRole('button', { name: '+ 添加设备', exact: true }).click(); await noTemplate();

    await form.getByLabel('设备名称',{exact:true}).fill('不能误关的设备草稿');
    const close=form.getByRole('button',{name:'关闭设备弹窗',exact:true});
    await page.locator('.modal-fade-enter-active').waitFor({state:'hidden'});
    const card=await form.boundingBox(), button=await close.boundingBox();
    assert.ok(Math.abs(button.y-card.y-9)<2,JSON.stringify({card,button}));assert.ok(Math.abs(card.x+card.width-button.x-button.width-9)<2);
    assert.equal(await close.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
    const field=await form.getByLabel('设备名称',{exact:true}).boundingBox();
    await page.mouse.move(field.x+20,field.y+12);await page.mouse.down();await page.mouse.move(8,8,{steps:10});await page.mouse.up();
    await page.mouse.click(8,8);await page.mouse.wheel(0,300);
    assert.ok(await form.isVisible());assert.equal(await form.getByLabel('设备名称',{exact:true}).inputValue(),'不能误关的设备草稿');
    await page.screenshot({path:path.join(directory,'00-safe-device-close.png'),fullPage:true});
    await page.keyboard.press('Escape');await form.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'+ 添加设备',exact:true}).click();await noTemplate();await close.click();await form.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'+ 添加设备',exact:true}).click();await noTemplate();
    check('device modal has a transparent top-right close; selection drags, mask clicks and scrolling do not dismiss; Escape and explicit close work');
    const newId = 'without_template_fixture';
    await form.getByLabel('设备 ID', { exact: true }).fill(newId);
    await form.getByLabel('设备名称', { exact: true }).fill('无模板新增验收');
    await form.getByLabel(/^使用模型/).selectOption(info.models[0]);
    await page.screenshot({ path: path.join(directory, '01-create-without-template.png') });

    let releaseSave;const heldSave=new Promise(resolve=>{releaseSave=resolve});let pendingRequests=0;
    await page.route('**/api/devices',async route=>{
        if(route.request().method()!=='POST')return route.continue();
        pendingRequests++;await heldSave;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"owned save failure"}'});
    });
    await form.getByRole('button',{name:'保存',exact:true}).click();
    await form.getByRole('button',{name:'保存中…',exact:true}).waitFor();
    assert.equal(await close.isDisabled(),true);assert.equal(await form.getByRole('button',{name:'取消',exact:true}).isDisabled(),true);
    await page.keyboard.press('Escape');await page.mouse.click(8,8);assert.ok(await form.isVisible());
    releaseSave();await page.getByText('owned save failure',{exact:true}).waitFor();
    await page.getByRole('button',{name:'确定',exact:true}).click();
    await form.getByRole('button',{name:'保存',exact:true}).waitFor();
    assert.equal(await close.isEnabled(),true);assert.equal(pendingRequests,1);
    assert.equal(await form.getByLabel('设备名称',{exact:true}).inputValue(),'无模板新增验收');
    await page.unroute('**/api/devices');
    check('pending save disables duplicate submits and all close paths; a failed save preserves the draft and restores the controls');
    let response = page.waitForResponse(r => r.url().endsWith('/api/devices') && r.request().method() === 'POST');
    await form.getByRole('button', { name: '保存', exact: true }).click();
    const created = await response; assert.equal(created.status(), 200); assert.ok((await created.json()).success);
    await form.waitFor({ state: 'hidden' });
    const read = async id => (await page.request.get(info.origin + '/api/devices/' + id)).json();
    const added = await read(newId); assert.equal(added.template_id, ''); assert.equal(added.model_type, info.models[0]);
    assert.equal('inspection' in JSON.parse(added.instance_config), false);
    check('new-device form omits template and inspection controls, saves normally, and inherits model inspection without creating an override');

    // Mark an existing isolated fixture with a legacy template reference. The
    // removed UI must not wipe that value or its model, points and PLC settings.
    await page.reload(); await page.getByRole('heading', { name: '设备管理', exact: true }).waitFor();
    const previous = await read(info.devices[0]);
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const inspection = { enabled: true, layoutMode: 'manual', manualPartOffsets: { fixture_part: [1, 2, 3] }, preserveFixture: 'instance-inspection' };
    const marked = await page.request.put(info.origin + '/api/devices/' + previous.id, {
        headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
        data: { ...previous, template_id: 'tpl_multipurpose_furnace', instance_config: JSON.stringify({ ...JSON.parse(previous.instance_config), inspection }) } });
    assert.equal(marked.status(), 200);
    await page.locator('.device-group tbody tr').filter({ has: page.getByText(previous.id, { exact: true }) }).getByRole('button', { name: '编辑', exact: true }).click();
    await form.getByLabel('设备名称', { exact: true }).waitFor(); await noTemplate();
    await form.getByLabel('设备名称', { exact: true }).fill('保留旧数据验收');
    response = page.waitForResponse(r => r.url().endsWith('/api/devices/' + previous.id) && r.request().method() === 'PUT');
    await form.getByRole('button', { name: '保存', exact: true }).click(); assert.equal((await response).status(), 200);
    const saved = await read(previous.id); assert.equal(saved.template_id, 'tpl_multipurpose_furnace');
    for (const key of ['model_type', 'model_file', 'line_id', 'plc_enabled', 'plc_protocol', 'plc_ip', 'plc_port']) assert.equal(saved[key], previous[key], key);
    assert.deepEqual(saved.dataPoints, previous.dataPoints);
    assert.deepEqual(JSON.parse(saved.instance_config).manualLayoutUnrelatedMarker, JSON.parse(previous.instance_config).manualLayoutUnrelatedMarker);
    assert.deepEqual(JSON.parse(saved.instance_config).inspection, inspection);
    check('editing hides both retired sections and preserves legacy inspection overrides, template references, model, points, PLC configuration and unrelated data');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
