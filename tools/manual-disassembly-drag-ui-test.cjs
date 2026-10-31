// Starts its own isolated database/backend. Requires a local Playwright
// installation (or PLAYWRIGHT_MODULE) and, optionally, BROWSER_EXECUTABLE.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..');
let server, browser;

(async () => {
    const directory = createRunDirectory('manual-disassembly-drag-ui'), checks = [], errors = [];
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: root, env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => {
        assert.equal(server.exitCode, null, 'isolated backend supervisor exited');
        return fs.existsSync(infoFile);
    }, 60000, 'isolated browser fixture');
    const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    requireTestPath(info.directory);
    assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage();
    page.setDefaultTimeout(30000); page.on('pageerror', error => errors.push(error.message));
    const editor = page.getByTestId('manual-disassembly-layout'), canvas = editor.locator('canvas');
    const offsets = () => editor.locator('input[type=number]').evaluateAll(es => es.map(e => Number(e.value)));
    const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) < .0002);
    const choose = id => editor.getByRole('option').filter({ hasText: id }).click();
    const ready = async (deviceId = info.devices[0]) => {
        await page.waitForFunction(id => document.querySelector('[data-testid="manual-disassembly-layout"]')?.dataset.deviceId === id, deviceId, { timeout: 60000 });
        await editor.waitFor({ state: 'visible', timeout: 60000 });
        await editor.getByRole('option').filter({ hasText: 'pf2_hood' }).waitFor({ timeout: 60000 });
        await editor.locator('.viewport-state').waitFor({ state: 'hidden', timeout: 60000 });
        // Bootstrap/resume may replace a clean editor after its first read.
        // Scroll in one DOM task rather than retaining a soon-detached handle.
        await canvas.evaluate(element => element.scrollIntoView({ block: 'nearest' }));
        await page.waitForFunction(() => {
            const element = document.querySelector('[data-testid="manual-disassembly-layout"] canvas');
            return element?.isConnected && element.width > 0 && element.getBoundingClientRect().width > 0
                && !document.querySelector('[data-testid="manual-disassembly-layout"] .viewport-state');
        });
    };
    const direct = async () => {
        await choose('pf2_hood'); const baseline = await offsets(); await choose('pf2_well');
        await editor.getByRole('button', { name: '完整视图', exact: true }).click();
        const box = await canvas.boundingBox(); assert.ok(box);
        const start = { x: box.x + box.width * .525, y: box.y + box.height * .295 };
        await page.mouse.move(start.x, start.y); await page.mouse.down();
        await page.mouse.move(start.x + 45, start.y + 20, { steps: 8 });
        assert.match(await editor.locator('.viewport-hint').innerText(), /正在移动/);
        assert.ok(!near(await offsets(), baseline));
        return { baseline, start };
    };
    const check = name => { checks.push(name); console.log(`PASS ${name}`); };
    try {
        await page.goto(info.origin + '/admin');
        await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
        await page.getByLabel('后台密码', { exact: true }).fill(info.password);
        await page.getByRole('button', { name: '解锁后台', exact: true }).click();
        const modelNav = page.getByTestId('model-library-nav');
        await modelNav.getByRole('button', { name: '模型管理', exact: true }).waitFor();
        await modelNav.getByRole('button', { name: '拆解布局', exact: true }).waitFor();
        assert.equal(await page.locator('.nav-group').filter({ has: page.getByTitle('工厂建模', { exact: true }) })
            .getByRole('button', { name: '拆解布局', exact: true }).count(), 0);
        await modelNav.getByTitle('模型库', { exact: true }).click();
        await modelNav.getByRole('button', { name: '拆解布局', exact: true }).waitFor({ state: 'hidden' });
        await modelNav.getByTitle('模型库', { exact: true }).click();
        await page.getByRole('button', { name: '拆解布局', exact: true }).click(); await ready();
        check('model library expands to model management and disassembly; factory modelling has no duplicate entry');
        await editor.screenshot({ path: path.join(directory, '01-editor.png') });
        const peerRoute = `/api/devices/${encodeURIComponent(info.devices[1])}/inspection`;
        const peer = await (await page.request.get(info.origin + peerRoute)).json();
        await choose('pf2_hood');
        await editor.getByRole('button', { name: '完整视图', exact: true }).click();
        // Screen positions of the visible handles on this real GLB with the
        // fixed viewport/default camera, not private renderer introspection.
        const handles = [
            ['X', .569, .310, 35, 7, [0]], ['Y', .528, .211, 0, -35, [1]],
            ['Z', .494, .314, -30, 12, [2]], ['XY', .544, .265, 25, -25, [0, 1]],
            ['XZ', .535, .307, 25, 20, [0, 2]], ['YZ', .512, .270, -25, -25, [1, 2]]
        ];
        const gizmo = async handle => {
            const [, x, y, dx, dy] = handle, box = await canvas.boundingBox(); assert.ok(box);
            const start = { x: box.x + box.width * x, y: box.y + box.height * y };
            const baseline = await offsets();
            await page.mouse.move(start.x, start.y); await page.mouse.down();
            await page.mouse.move(start.x + dx, start.y + dy, { steps: 8 });
            assert.match(await editor.locator('.viewport-hint').innerText(), /正在移动/);
            return { baseline, start, end: { x: start.x + dx, y: start.y + dy } };
        };
        for (const handle of handles) {
            const { baseline } = await gizmo(handle), edited = await offsets();
            for (let i = 0; i < 3; i++) assert.equal(Math.abs(edited[i] - baseline[i]) > .001, handle[5].includes(i), `${handle[0]} axis ${i}`);
            await page.mouse.up();
            await editor.press('Control+z'); assert.ok(near(await offsets(), baseline));
            await editor.press('Control+Shift+z'); assert.ok(near(await offsets(), edited));
            await editor.press('Control+z');
            check(`${handle[0]} handle obeys its axis/plane constraint and one-step undo/redo`);
        }
        for (const kind of ['escape', 'pointercancel', 'capture-loss', 'blur']) {
            const { baseline, end } = await gizmo(handles[0]);
            if (kind === 'escape') await page.keyboard.press('Escape');
            if (kind === 'pointercancel') await canvas.dispatchEvent('pointercancel', { pointerId: 1, button: 0 });
            if (kind === 'capture-loss') {
                await canvas.evaluate(element => element.releasePointerCapture(1));
                await page.mouse.move(end.x + 1, end.y + 1);
            }
            if (kind === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await page.mouse.up();
            assert.ok(near(await offsets(), baseline));
            assert.ok(!await page.getByTestId('save-manual-layout').isDisabled());
            check(`gizmo ${kind} rolls back and releases pointer ownership`);
        }
        for (const kind of ['escape', 'pointercancel', 'capture-loss', 'blur']) {
            const { baseline, start } = await direct();
            if (kind === 'escape') await page.keyboard.press('Escape');
            if (kind === 'pointercancel') await canvas.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', button: 0 });
            if (kind === 'capture-loss') {
                await canvas.evaluate(element => element.releasePointerCapture(1));
                await page.mouse.move(start.x + 46, start.y + 21); // Flush pending lostpointercapture.
            }
            if (kind === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await page.mouse.up();
            assert.ok(near(await offsets(), baseline), `${kind} must roll back the entire gesture`);
            assert.ok(!await page.getByTestId('save-manual-layout').isDisabled());
            assert.doesNotMatch(await editor.locator('.viewport-hint').innerText(), /正在移动/);
            check(`${kind} cancels without a stuck canvas or partial history`);
        }
        const gesture = await direct();
        await canvas.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: false, button: 0,
            clientX: gesture.start.x, clientY: gesture.start.y });
        await page.mouse.move(gesture.start.x + 60, gesture.start.y + 30, { steps: 5 });
        const edited = await offsets(); await page.mouse.up();
        assert.ok(!near(edited, gesture.baseline));
        await editor.press('Control+z'); assert.ok(near(await offsets(), gesture.baseline));
        await editor.press('Control+Shift+z'); assert.ok(near(await offsets(), edited));
        check('secondary pointer is ignored; one gesture creates exactly one undo/redo step');
        for (const [axis, value] of [['X', '3.125'], ['Y', '-1.25'], ['Z', '.75']]) {
            await editor.getByLabel(`${axis}轴拆解位移`, { exact: true }).fill(value);
            await editor.getByLabel(`${axis}轴拆解位移`, { exact: true }).press('Tab');
        }
        const savedOffset = [3.125, -1.25, .75]; assert.ok(near(await offsets(), savedOffset));
        await editor.getByRole('button', { name: '查看装配原位', exact: true }).click();
        assert.ok(await editor.getByLabel('X轴拆解位移', { exact: true }).isDisabled());
        assert.ok(near(await offsets(), savedOffset));
        await editor.getByRole('button', { name: '返回手工拆解布局', exact: true }).click();
        check('numeric edits and assembled preview preserve authored positions');
        const originalCanvas = await canvas.elementHandle();
        const savedResponse = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/devices/${info.devices[0]}/inspection`));
        await page.getByTestId('save-manual-layout').click(); assert.equal((await savedResponse).status(), 200);
        await page.waitForFunction(() => document.querySelector('.manual-layout .dirty-pill')?.textContent.includes('已载入'));
        assert.ok(await originalCanvas.evaluate(element => element.isConnected), 'save must not needlessly recreate GPU/model resources');
        assert.ok(near(await offsets(), savedOffset));
        await editor.screenshot({ path: path.join(directory, '02-saved.png') });
        assert.deepEqual(await (await page.request.get(info.origin + peerRoute)).json(), peer);
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[1]); await ready(info.devices[1]); await choose('pf2_hood');
        assert.ok(!near(await offsets(), savedOffset));
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[0]); await ready(); await choose('pf2_hood');
        assert.ok(near(await offsets(), savedOffset));
        await page.reload(); await ready(); await choose('pf2_hood'); assert.ok(near(await offsets(), savedOffset));
        check('HTTP save, device switch and full reload retain only device A; same-model device B is unchanged');
        await editor.getByLabel('X轴拆解位移', { exact: true }).fill('4.125'); await editor.getByLabel('X轴拆解位移', { exact: true }).press('Tab');
        const inspectionUrl = info.origin + `/api/devices/${info.devices[0]}/inspection`;
        await page.route(inspectionUrl, route => route.request().method() === 'PUT'
            ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '隔离并发冲突验收', code: 'DEVICE_INSPECTION_CONFLICT' }) }) : route.continue());
        await page.getByTestId('save-manual-layout').click();
        await editor.getByText(/保存失败，拖拽草稿仍保留/).waitFor();
        assert.ok(near(await offsets(), [4.125, -1.25, .75]));
        await page.unroute(inspectionUrl);
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[1]);
        await page.getByRole('button', { name: '继续编辑', exact: true }).click();
        assert.equal(await page.getByLabel('选择拆解布局设备', { exact: true }).inputValue(), info.devices[0]);
        assert.ok(near(await offsets(), [4.125, -1.25, .75]));
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[1]);
        await page.getByRole('button', { name: '放弃修改并切换', exact: true }).click(); await ready(info.devices[1]);
        check('409 retains the draft; cancel switching preserves it and explicit discard switches without saving');
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[0]); await ready(); await choose('pf2_hood');
        assert.ok(near(await offsets(), savedOffset), 'discard never writes the conflicting draft');
        await editor.getByLabel('X轴拆解位移', { exact: true }).fill('5.125'); await editor.getByLabel('X轴拆解位移', { exact: true }).press('Tab');
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[1]);
        await page.getByRole('button', { name: '保存并切换', exact: true }).click(); await ready(info.devices[1]);
        assert.equal(await page.getByLabel('选择拆解布局设备', { exact: true }).inputValue(), info.devices[1]);
        await page.getByLabel('选择拆解布局设备', { exact: true }).selectOption(info.devices[0]); await ready(); await choose('pf2_hood');
        assert.ok(near(await offsets(), [5.125, -1.25, .75]));
        assert.deepEqual(await (await page.request.get(info.origin + peerRoute)).json(), peer);
        const orbitBefore = await canvas.screenshot(), orbitOffset = await offsets(), box = await canvas.boundingBox();
        await page.mouse.move(box.x + 60, box.y + 80); await page.mouse.down();
        await page.mouse.move(box.x + 160, box.y + 110, { steps: 12 }); await page.mouse.up();
        assert.ok(!orbitBefore.equals(await canvas.screenshot()), 'empty-canvas orbit still works after cancellations');
        assert.ok(near(await offsets(), orbitOffset), 'orbit is not a layout edit');
        check('save-and-switch persists before leaving; camera orbit works after interrupted gestures');
        const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
        const remoteSave = async (partId, offset) => {
            const current = await (await page.request.get(inspectionUrl)).json();
            const response = await page.request.put(inspectionUrl, { headers: { Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken },
                data: { revision: current.revision, parts: [{ id: partId, explode_offset: offset }], enabled: true } });
            assert.equal(response.status(), 200, await response.text());
        };
        const editX = async value => {
            await editor.getByLabel('X轴拆解位移', { exact: true }).fill(value);
            await editor.getByLabel('X轴拆解位移', { exact: true }).press('Tab');
        };
        const clean = () => page.waitForFunction(() => document.querySelector('.manual-layout .dirty-pill')?.textContent.includes('已载入')
            && !document.querySelector('[data-testid="save-manual-layout"]')?.disabled);
        await editX('6.125'); await remoteSave('pf2_well', [1, 2, 3]);
        await page.getByTestId('save-manual-layout').click(); await clean();
        assert.ok(near(await offsets(), [6.125, -1.25, .75]));
        const merged = await (await page.request.get(inspectionUrl)).json();
        assert.deepEqual(merged.inspection.parts.find(part => part.id === 'pf2_well').explode_offset, [1, 2, 3]);
        await page.getByTestId('save-manual-layout').click(); await clean();
        await page.getByRole('button', { name: '设备管理', exact: true }).click();
        await editor.waitFor({ state: 'hidden' });
        assert.equal(await page.getByRole('button', { name: '保存并切换', exact: true }).count(), 0);
        await page.getByRole('button', { name: '拆解布局', exact: true }).click(); await ready(); await choose('pf2_hood');
        assert.ok(near(await offsets(), [6.125, -1.25, .75]));
        check('real 409 merges only local parts; repeated save clears dirty state and permits another page');
        await editX('7.125'); await remoteSave('pf2_hood', [8.125, -1.25, .75]);
        await page.getByTestId('save-manual-layout').click();
        await page.getByRole('button', { name: '保留草稿', exact: true }).click();
        assert.ok(near(await offsets(), [7.125, -1.25, .75]));
        await page.getByTestId('save-manual-layout').click();
        await page.getByRole('button', { name: '使用当前拖拽位置', exact: true }).click(); await clean();
        assert.ok(near(await offsets(), [7.125, -1.25, .75]));
        check('same-part conflicts preserve the draft unless the user explicitly confirms the local position');
        await editX('9.125');
        const download = page.waitForEvent('download');
        await editor.getByRole('button', { name: '导出草稿', exact: true }).click();
        const downloaded = await download, draftFile = path.join(directory, 'exported-draft.json'); await downloaded.saveAs(draftFile);
        assert.deepEqual(JSON.parse(fs.readFileSync(draftFile)).inspection.parts.find(part => part.id === 'pf2_hood').explode_offset, [9.125, -1.25, .75]);
        await editor.getByRole('button', { name: '重新读取布局', exact: true }).click();
        await page.getByRole('button', { name: '继续编辑', exact: true }).click();
        assert.ok(near(await offsets(), [9.125, -1.25, .75]));
        await editor.getByRole('button', { name: '重新读取布局', exact: true }).click();
        await page.getByRole('button', { name: '放弃草稿并读取', exact: true }).click(); await ready(); await choose('pf2_hood');
        assert.ok(near(await offsets(), [7.125, -1.25, .75]));
        check('draft export and explicit reload provide a safe conflict recovery exit');
        await page.getByRole('button', { name: '模型管理', exact: true }).click();
        await page.getByRole('heading', { name: '3D 模型库', exact: true }).waitFor();
        await page.getByRole('button', { name: '拆解布局', exact: true }).click(); await ready();
        await page.screenshot({ path: path.join(directory, '03-model-library-submenu.png'), fullPage: true });
        check('model-management and disassembly children switch normally after a saved layout');
        assert.deepEqual(errors, [], 'no browser JavaScript exceptions');
        const result = { success: true, checks, directory, browserErrors: errors };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
        throw error;
    }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await browser?.close(); await stopOwnedSmokeProcess(server);
});
