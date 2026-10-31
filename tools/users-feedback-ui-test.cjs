// Owned fixture only: exercise account feedback and modal chrome without live users.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const directory = createRunDirectory('users-feedback-ui'), checks = [], errors = [];
const check = name => { checks.push(name); console.log('PASS ' + name); };
let server, browser, page;
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: path.resolve(__dirname, '..'), env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'owned UI server');
    const info = JSON.parse(fs.readFileSync(infoFile));
    assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'users' })));
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    const passwordField = page.getByLabel('后台密码', { exact: true });
    const showPassword = page.getByRole('button', { name: '显示后台密码', exact: true });
    await showPassword.waitFor();
    assert.equal(await passwordField.inputValue(), '');
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('textbox', { name: '账号', exact: true }).focus();
    assert.ok(await showPassword.isVisible(), 'explicit eye remains visible after fill and blur');
    await showPassword.click();
    assert.equal(await passwordField.getAttribute('type'), 'text');
    assert.equal(await passwordField.inputValue(), info.password);
    const hidePassword = page.getByRole('button', { name: '隐藏后台密码', exact: true });
    await hidePassword.focus(); await page.keyboard.press('Space');
    assert.equal(await passwordField.getAttribute('type'), 'password');
    assert.ok(await showPassword.isVisible());
    await passwordField.fill(''); assert.ok(await showPassword.isVisible());
    await passwordField.fill(info.password);
    await page.screenshot({ path: path.join(directory, '00-stable-password-eye.png') });
    check('password eye is always present for empty, filled and blurred inputs; pointer and keyboard toggles preserve the value');
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.locator('.users-settings').waitFor();
    await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增账户', exact: true });
    const close = dialog.getByRole('button', { name: '关闭', exact: true });
    await page.locator('.user-editor-enter-active').waitFor({ state: 'hidden' });
    const chrome = async () => {
        const cardBox = await dialog.boundingBox(), closeBox = await close.boundingBox();
        assert.ok(cardBox && closeBox);
        assert.ok(Math.abs(closeBox.y - cardBox.y - 9) < 2, JSON.stringify({ cardBox, closeBox }));
        assert.ok(Math.abs(cardBox.x + cardBox.width - closeBox.x - closeBox.width - 9) < 2);
        assert.deepEqual(await close.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, shadow: getComputedStyle(el).boxShadow })),
            { background: 'rgba(0, 0, 0, 0)', shadow: 'none' });
        return closeBox;
    };
    const initialCloseBox = await chrome();
    await page.screenshot({ path: path.join(directory, '01-top-right-close.png') });
    const username = `feedback_${Date.now().toString(36)}`, displayName = '消息弹出验收账户';
    await dialog.getByLabel('登录账号', { exact: true }).fill(username);
    await dialog.getByLabel('显示名称', { exact: true }).fill(displayName);
    await dialog.getByLabel('初始密码', { exact: true }).fill(info.password);
    await dialog.getByRole('checkbox', { name: '模型库 · 模型管理 · 查看', exact: true }).check();
    const outsideSafe = async target => {
        const box = await target.boundingBox(), heading = await target.getByRole('heading').boundingBox();
        const y = heading.y + heading.height / 2, outsideX = box.x + box.width + 16;
        // Reproduce down inside the dialog, select text, then release on the mask.
        // Browsers dispatch the resulting click on their common ancestor (mask).
        await page.mouse.move(heading.x + 2, y); await page.mouse.down();
        await page.mouse.move(outsideX, y, { steps: 12 }); await page.mouse.up();
        assert.equal(await page.locator('.user-editor-leave-active').count(), 0, 'selection must not start the close transition');
        assert.ok(await target.isVisible(), 'dragging a text selection onto the backdrop must not dismiss the account editor');
        assert.ok((await page.evaluate(() => window.getSelection()?.toString() || '')).trim(), 'text must remain selectable for copying');
        await page.mouse.click(outsideX, y);
        assert.equal(await page.locator('.user-editor-leave-active').count(), 0, 'empty-space clicks must not start closing');
        assert.ok(await target.isVisible(), 'clicking empty space must not discard the account draft');
        await page.mouse.move(outsideX, y); await page.mouse.down();
        await page.mouse.move(heading.x + 4, y, { steps: 8 }); await page.mouse.up();
        assert.ok(await target.isVisible(), 'dragging from the mask into the dialog must not dismiss it either');
    };
    await outsideSafe(dialog);
    assert.equal(await dialog.getByLabel('登录账号', { exact: true }).inputValue(), username);
    assert.equal(await dialog.getByLabel('显示名称', { exact: true }).inputValue(), displayName);
    assert.equal(await dialog.getByLabel('初始密码', { exact: true }).inputValue(), info.password);
    assert.ok(await dialog.getByRole('checkbox', { name: '模型库 · 模型管理 · 查看', exact: true }).isChecked());
    check('text selection across the backdrop, reverse drags and empty-space clicks preserve the open create dialog and every draft field');

    await dialog.locator('.editor-form').evaluate(el => { el.scrollTop = el.scrollHeight; });
    assert.ok(await dialog.locator('.editor-form').evaluate(el => el.scrollTop > 0));
    const afterScroll = await chrome();
    for (const coordinate of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(afterScroll[coordinate] - initialCloseBox[coordinate]) < 1,
        'scroll only the form, never the header close control');
    check('close is transparent at the card upper-right and remains visible while the form scrolls');

    // Have the actual isolated backend reject a malformed payload once.
    // The valid UI draft remains intact for the subsequent real retry.
    let rejectCreate = true, backendValidation = '';
    await page.route('**/api/admin-auth/users', async route => {
        if (rejectCreate && route.request().method() === 'POST') {
            const body = route.request().postDataJSON();
            const response = await route.fetch({ postData: JSON.stringify({ ...body, username: '无效 用户名' }) });
            assert.equal(response.status(), 400);
            backendValidation = (await response.json()).error;
            await route.fulfill({ response });
        } else await route.continue();
    });
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click();
    const error = page.locator('.user-notice[role=alert]');
    await error.waitFor();
    await waitUntil(() => error.evaluate(el => getComputedStyle(el).opacity === '1'), 5000, 'visible error popup');
    assert.ok(backendValidation); assert.equal(await error.locator('span').innerText(), backendValidation);
    assert.ok(await dialog.isVisible());
    assert.equal(await dialog.getByLabel('登录账号', { exact: true }).inputValue(), username);
    assert.equal(await dialog.getByLabel('显示名称', { exact: true }).inputValue(), displayName);
    assert.equal(await dialog.getByLabel('初始密码', { exact: true }).inputValue(), info.password);
    assert.ok(await dialog.getByRole('checkbox', { name: '模型库 · 模型管理 · 查看', exact: true }).isChecked());
    assert.ok(!(await page.locator('.users-settings').innerText()).includes(backendValidation));
    assert.ok(!(await dialog.innerText()).includes(backendValidation));
    assert.ok(await error.evaluate(el => { const box = el.getBoundingClientRect(); return !!document.elementFromPoint(box.x + 15, box.y + 15)?.closest('.user-notice'); }));
    await page.screenshot({ path: path.join(directory, '02-creation-error-popup.png') });
    await page.getByRole('button', { name: '关闭消息', exact: true }).click();
    await error.waitFor({ state: 'hidden' });
    assert.ok(await dialog.isVisible());
    check('real backend creation errors float above the card, never inline, and preserve all draft fields and grants');

    rejectCreate = false;
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click();
    await page.locator('.user-notice[role=status]').getByText('账户已创建', { exact: true }).waitFor();
    await dialog.waitFor({ state: 'hidden' });
    const accountRow = page.locator('.users-table tbody tr').filter({ hasText: username });
    await accountRow.getByText(displayName, { exact: true }).waitFor();
    await page.locator('.user-notice').waitFor({ state: 'hidden', timeout: 10000 });
    check('retry creates the account successfully; success feedback disappears automatically without leaving stale errors');

    await accountRow.getByRole('button', { name: '管理账户', exact: true }).click();
    const edit = page.getByRole('dialog', { name: `编辑账户 · ${username}`, exact: true });
    await edit.getByLabel('显示名称', { exact: true }).fill('保留编辑草稿');
    await outsideSafe(edit);
    assert.equal(await edit.getByLabel('显示名称', { exact: true }).inputValue(), '保留编辑草稿');
    check('the edit-account dialog uses the same explicit-dismiss policy and preserves unsaved changes while selecting text');
    await page.route('**/api/admin-auth/users/*', async route => {
        if (route.request().method() === 'PUT') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '保存暂不可用，请重试' }) });
        else await route.continue();
    });
    await edit.getByRole('button', { name: '保存修改', exact: true }).click();
    await error.getByText('保存暂不可用，请重试', { exact: true }).waitFor();
    assert.equal(await edit.getByLabel('显示名称', { exact: true }).inputValue(), '保留编辑草稿');
    await edit.getByRole('button', { name: '关闭', exact: true }).click();
    await error.waitFor({ state: 'hidden' });
    check('edit failures use the same popup and closing the editor clears stale feedback');

    await page.setViewportSize({ width: 720, height: 680 });
    await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    await dialog.waitFor();
    await page.locator('.user-editor-enter-active').waitFor({ state: 'hidden' });
    await dialog.locator('.editor-form').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await chrome();
    await close.focus();
    assert.equal(await close.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(directory, '03-compact-close.png') });
    await page.keyboard.press('Enter');
    await dialog.waitFor({ state: 'hidden' });
    check('compact windows retain the upper-right close button and keyboard activation');
    await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    await dialog.waitFor(); await dialog.getByLabel('登录账号', { exact: true }).focus();
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '＋ 新增账户', exact: true }).click();
    await dialog.waitFor(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    check('Escape and the explicit Cancel button still close the dialog normally');

    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
