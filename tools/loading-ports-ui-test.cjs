'use strict';
// Real browser + owned isolated backend. No production URLs or installed app.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { startLoadingPortsFixture } = require('./loading-ports-ui-server.cjs');
const { resolveLoadingPort } = require('../shared/loadingPorts.cjs');
const directory = createRunDirectory('loading-ports-browser'), checks = [], errors = [], mutations = [], consoleErrors = [];
let fixture, browser, page;
const check = name => { checks.push(name); console.log('PASS ' + name); };
const clone = value => JSON.parse(JSON.stringify(value));
const parsed = value => typeof value === 'string' ? JSON.parse(value) : value;
const closeTo = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

(async () => {
    fixture = await startLoadingPortsFixture();
    const info = fixture.info;
    requireTestPath(info.database); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { 'Content-Type': 'application/json', Origin: info.origin, 'X-Admin-Request': '1', Cookie: info.session.cookie,
        'X-CSRF-Token': info.session.csrfToken, 'X-Factory-ID': info.factoryId };
    const api = async (route, method = 'GET', body) => {
        const response = await fetch(info.origin + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json(); assert.ok(response.ok, `${response.status} ${route} ${JSON.stringify(data)}`); return data;
    };
    const models = async () => (await api('/api/models')).filter(model => info.models.includes(model.id)).sort((a, b) => a.id.localeCompare(b.id));
    const devices = async () => (await api('/api/devices')).filter(device => info.devices.includes(device.id)).sort((a, b) => a.id.localeCompare(b.id));
    const initialModels = await models(), initialDevices = await devices();
    const modelRoute = `/api/models/${info.models[0]}/loading-ports`;
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
    await context.addInitScript(({ lineId }) => {
        if (!localStorage.getItem('digital_twin_admin_ui_state_v1')) localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
            activeTab: 'models', modelLibraryStep: 'library', selectedLineEditorId: lineId, isLineDevicePoolCollapsed: true }));
    }, { lineId: info.lineId });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
            const body = request.postDataJSON();
            mutations.push({ method: request.method(), path: url.pathname, body: url.pathname.startsWith('/api/admin-auth/') ? { username: body?.username } : body });
        }
    });
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    const modelSteps = page.getByRole('navigation', { name: '模型库操作步骤' }); await modelSteps.waitFor();
    await page.locator(`[data-model-id="${info.models[0]}"]`).locator('td').nth(2).click();
    await modelSteps.getByRole('button', { name: /进出料口/ }).click();
    await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]);
    let editor = page.getByRole('region', { name: '进出料口配置', exact: true });
    await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).waitFor();
    await editor.locator('canvas').waitFor({ timeout: 60000 });
    await editor.locator('.preview-overlay').waitFor({ state: 'hidden', timeout: 60000 });
    for (const width of [1600, 1024]) {
        await page.setViewportSize({ width, height: 1050 });
        await editor.screenshot({ path: path.join(directory, `01-model-ports-${width}.png`) });
    }
    await page.setViewportSize({ width: 1600, height: 1050 });
    await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).fill('1.35');
    await editor.getByLabel('进出料口 Z 位置', { exact: true }).fill('1.25');
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'PUT');
    await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await savedResponse).status(), 200);
    await editor.getByText(/模型进出料口默认配置已保存/).waitFor();
    const modelSaved = await models();
    for (const [index, model] of modelSaved.entries()) {
        const previous = initialModels[index];
        if (model.id !== info.models[0]) { assert.deepEqual(model, previous); continue; }
        const before = parsed(previous.metadata), after = parsed(model.metadata);
        closeTo(after.loadingPorts.inlet.position[1], 1.35); closeTo(after.loadingPorts.inlet.position[2], 1.25);
        for (const key of Object.keys(before)) if (key !== 'loadingPorts') assert.deepEqual(after[key], before[key], key);
        for (const key of Object.keys(previous)) if (key !== 'metadata') assert.deepEqual(model[key], previous[key], key);
    }
    assert.deepEqual(await devices(), initialDevices);
    await page.reload(); await page.getByLabel('选择进出料口模型', { exact: true }).waitFor();
    await page.getByLabel('选择进出料口模型', { exact: true }).selectOption(info.models[0]);
    editor = page.getByRole('region', { name: '进出料口配置', exact: true });
    await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).waitFor();
    closeTo(Number(await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).inputValue()), 1.35);
    check('model ports save/reload at wide and narrow widths while preserving peer model, inspection, custom metadata, GLB and all device rows');

    // Real optimistic conflict: another administrator commits while this draft is open.
    await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).fill('1.77');
    const concurrent = await api(modelRoute), otherPorts = clone(concurrent.ports); otherPorts.inlet.position[1] = 1.55;
    await api(modelRoute, 'PUT', { revision: concurrent.revision, ports: otherPorts });
    const conflictResponse = page.waitForResponse(response => new URL(response.url()).pathname === modelRoute && response.request().method() === 'PUT');
    await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await conflictResponse).status(), 409);
    await editor.getByRole('alert').filter({ hasText: '当前草稿已保留' }).waitFor();
    closeTo(Number(await editor.getByLabel('进出料口 Y 送料高度', { exact: true }).inputValue()), 1.77);
    closeTo((await api(modelRoute)).ports.inlet.position[1], 1.55);
    assert.equal(await editor.getByRole('button', { name: '保存配置', exact: true }).isDisabled(), true);
    await editor.screenshot({ path: path.join(directory, '02-model-conflict-preserved.png') });
    await editor.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('input[aria-label="进出料口 Y 送料高度"]')?.value) === 1.55);
    check('real model CAS conflict keeps unsaved numeric draft, protects the concurrent version and requires explicit reload');

    const factoryMenu = page.getByTitle('工厂建模', { exact: true });
    if (!await page.getByRole('button', { name: '设备管理', exact: true }).isVisible()) await factoryMenu.click();
    await page.getByRole('button', { name: '设备管理', exact: true }).click();
    const deviceRow = page.getByRole('row').filter({ has: page.locator('code').filter({ hasText: new RegExp(`^${info.devices[0]}$`) }) });
    await deviceRow.getByRole('button', { name: '进出料口微调', exact: true }).click();
    const instanceDialog = page.getByRole('dialog', { name: '设备进出料口微调', exact: true }); await instanceDialog.waitFor();
    editor = instanceDialog.getByRole('region', { name: '进出料口配置', exact: true });
    await editor.getByLabel('单独微调此设备', { exact: true }).check();
    await editor.getByLabel('进出料口 X 偏移', { exact: true }).fill('.2');
    await editor.getByLabel('进出料口送料高度偏移', { exact: true }).fill('.25');
    await editor.getByLabel('进出料口 Z 偏移', { exact: true }).fill('.4');
    await editor.getByLabel('进出料口水平方向微调角度', { exact: true }).fill('0');
    const deviceSnapshot = await devices(), defaultSnapshot = await models();
    const instanceResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/devices/${info.devices[0]}/loading-ports` && response.request().method() === 'PUT');
    await editor.getByRole('button', { name: '保存配置', exact: true }).click(); assert.equal((await instanceResponse).status(), 200);
    await editor.getByText(/此设备的进出料口微调已保存/).waitFor();
    const instanceSaved = await devices();
    for (const [index, device] of instanceSaved.entries()) {
        if (device.id !== info.devices[0]) { assert.deepEqual(device, deviceSnapshot[index]); continue; }
        const before = parsed(deviceSnapshot[index].instance_config), after = parsed(device.instance_config);
        assert.deepEqual(after.loadingPortOverrides, { version: 1, inlet: { offset: [.2, .25, .4], yawDegrees: 0 }, outlet: null });
        for (const key of Object.keys(before)) assert.deepEqual(after[key], before[key]);
        for (const key of Object.keys(device)) if (key !== 'instance_config') assert.deepEqual(device[key], deviceSnapshot[index][key]);
    }
    assert.deepEqual(await models(), defaultSnapshot);
    await instanceDialog.screenshot({ path: path.join(directory, '03-device-override.png') });
    check('one instance offset saves only its overrides, preserving PLC, position, movement/inspection and same-model peer/defaults');
    await editor.getByLabel('进出料口 X 偏移', { exact: true }).fill('.35');
    await instanceDialog.getByRole('button', { name: /关闭/ }).first().click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await instanceDialog.waitFor();
    closeTo(Number(await editor.getByLabel('进出料口 X 偏移', { exact: true }).inputValue()), .35);
    await instanceDialog.screenshot({ path: path.join(directory, '03-instance-cancel-leave-kept-draft.png') });
    await instanceDialog.getByRole('button', { name: /关闭/ }).first().click();
    await page.getByRole('button', { name: '确定', exact: true }).click();
    await instanceDialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await devices(), instanceSaved);
    check('unsaved instance close confirmation is reachable; Cancel restores native dialog/draft and Confirm leaves without saving');

    await page.getByRole('button', { name: '产线管理', exact: true }).click();
    const card = id => page.locator(`[data-device-id="${id}"]`);
    await card(info.devices[0]).waitFor();
    const alignmentWrites = () => mutations.filter(row => row.path === '/api/devices/loading-alignment');
    const openAlignment = async mode => {
        const title = mode === 'faces' ? '进料面前后对齐' : '送料高度对齐';
        await page.getByRole('button', { name: title, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: title, exact: true }); await dialog.waitFor(); return dialog;
    };
    const generate = async dialog => {
        await dialog.getByRole('button', { name: /^(生成对齐预览|重新生成预览)$/ }).click();
        await dialog.locator('[data-alignment-device]').first().waitFor({ timeout: 60000 });
        await dialog.getByRole('button', { name: '确认并应用', exact: true }).waitFor();
        await page.waitForFunction(title => !document.querySelector(`dialog[aria-label="${title}"] footer button:last-child`)?.disabled, await dialog.getAttribute('aria-label'), { timeout: 60000 });
        await dialog.locator('.preview-state').waitFor({ state: 'hidden', timeout: 60000 });
        await dialog.locator('canvas').waitFor({ timeout: 60000 });
    };
    const apply = async dialog => {
        const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/devices/loading-alignment' && response.request().method() === 'PUT');
        await dialog.getByRole('button', { name: '确认并应用', exact: true }).click();
        const result = await response; assert.equal(result.status(), 200, await result.text()); await dialog.waitFor({ state: 'hidden' });
        return result.request().postDataJSON();
    };
    const compareAxisOnly = (before, after, column, referenceId) => {
        assert.ok(after.some((device, index) => device[column] !== before[index][column]), 'alignment should move at least one participant');
        for (const [index, device] of after.entries()) {
            for (const key of Object.keys(device)) if (key !== column) assert.deepEqual(device[key], before[index][key], key);
            if (device.id === referenceId) assert.deepEqual(device, before[index], 'reference is unchanged');
        }
    };
    for (const mode of ['faces', 'heights']) {
        const before = await devices(), writeCount = alignmentWrites().length;
        let dialog = await openAlignment(mode);
        const previewMutationStart = mutations.length;
        await dialog.getByLabel('对齐参与范围', { exact: true }).selectOption('lane');
        await dialog.getByLabel('对齐基准设备', { exact: true }).selectOption(info.devices[0]);
        await generate(dialog);
        assert.equal(alignmentWrites().length, writeCount); assert.deepEqual(await devices(), before);
        assert.equal(mutations.slice(previewMutationStart).filter(row => /^\/api\/(models|devices|lines)(?:\/|$)/.test(row.path)).length, 0, 'preview must not issue any management mutation');
        for (const width of [1600, 1024]) {
            await page.setViewportSize({ width, height: 1050 });
            await dialog.screenshot({ path: path.join(directory, `04-${mode}-preview-${width}.png`) });
        }
        await page.setViewportSize({ width: 1600, height: 1050 });
        await dialog.getByLabel('参与设备进出料口', { exact: true }).selectOption('outlet');
        await dialog.locator('[data-alignment-device]').first().waitFor({ state: 'hidden' });
        assert.equal(await dialog.getByRole('button', { name: '确认并应用', exact: true }).isDisabled(), true);
        await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
        assert.equal(alignmentWrites().length, writeCount); assert.deepEqual(await devices(), before);
        assert.equal(mutations.slice(previewMutationStart).filter(row => /^\/api\/(models|devices|lines)(?:\/|$)/.test(row.path)).length, 0, 'cancel must not issue any management mutation');
        dialog = await openAlignment(mode);
        await dialog.getByLabel('对齐参与范围', { exact: true }).selectOption('lane');
        await dialog.getByLabel('对齐基准设备', { exact: true }).selectOption(info.devices[0]);
        await generate(dialog); const payload = await apply(dialog), after = await devices();
        assert.equal(payload.mode, mode); compareAxisOnly(before, after, mode === 'faces' ? 'pos_z' : 'pos_y', info.devices[0]);
        const currentModels = await models(), reference = after.find(device => device.id === info.devices[0]);
        const referencePort = resolveLoadingPort(currentModels.find(model => model.id === reference.model_type), reference);
        for (const device of after) {
            const port = resolveLoadingPort(currentModels.find(model => model.id === device.model_type), device);
            const axis = mode === 'faces' ? 2 : 1, column = mode === 'faces' ? 'pos_z' : 'pos_y';
            closeTo(device[column] + port.position[axis], reference[column] + referencePort.position[axis]);
        }
        check(`${mode} preview writes nothing; parameter changes invalidate it; cancel is inert; confirmed alignment changes only ${mode === 'faces' ? 'Z' : 'Y'} and leaves reference fixed`);
    }

    // Selected-range alignment must leave the third same-lane device untouched.
    const selectionToolbar = page.getByRole('toolbar', { name: '设备多选与间距' });
    const clear = selectionToolbar.getByRole('button', { name: '取消选择', exact: true }); if (await clear.count()) await clear.click();
    await card(info.devices[0]).locator('strong').click();
    await card(info.devices[1]).locator('strong').click({ modifiers: ['Control'] });
    assert.equal(await card(info.devices[0]).getAttribute('aria-pressed'), 'true'); assert.equal(await card(info.devices[1]).getAttribute('aria-pressed'), 'true');
    // Give the selected peer a different height in this private test DB, then
    // refresh UI; selection is re-applied after reload rather than manipulated.
    const selectedDb = new Database(requireTestPath(info.database));
    selectedDb.prepare('UPDATE devices SET pos_y=pos_y+0.6 WHERE id=?').run(info.devices[1]); selectedDb.close();
    await page.reload(); await card(info.devices[0]).waitFor();
    await card(info.devices[0]).locator('strong').click(); await card(info.devices[1]).locator('strong').click({ modifiers: ['Control'] });
    const selectedBefore = await devices(), selectedDialog = await openAlignment('heights');
    await selectedDialog.getByLabel('对齐参与范围', { exact: true }).selectOption('selected');
    await selectedDialog.getByLabel('对齐基准设备', { exact: true }).selectOption(info.devices[0]);
    await generate(selectedDialog); assert.equal(await selectedDialog.locator('[data-alignment-device]').count(), 2);
    const selectedPayload = await apply(selectedDialog);
    assert.deepEqual(selectedPayload.devices.map(row => row.id).sort(), info.devices.slice(0, 2).sort());
    const selectedAfter = await devices(); assert.deepEqual(selectedAfter[2], selectedBefore[2]);
    compareAxisOnly(selectedBefore, selectedAfter, 'pos_y', info.devices[0]);
    check('selected-range height alignment affects only selected peers and leaves the unselected same-lane device untouched');

    // Actual stale-source rejection without WS refresh: another editor writes to
    // this owned SQLite between preview and confirmation, preserving the plan.
    const conflictDialog = await openAlignment('faces');
    await conflictDialog.getByLabel('对齐参与范围', { exact: true }).selectOption('lane');
    await conflictDialog.getByLabel('对齐基准设备', { exact: true }).selectOption(info.devices[0]);
    await generate(conflictDialog);
    const conflictDb = new Database(requireTestPath(info.database));
    conflictDb.prepare('UPDATE devices SET pos_z=pos_z+0.15 WHERE id=?').run(info.devices[1]); conflictDb.close();
    const concurrentDevices = await devices();
    const alignmentConflict = page.waitForResponse(response => new URL(response.url()).pathname === '/api/devices/loading-alignment' && response.request().method() === 'PUT');
    await conflictDialog.getByRole('button', { name: '确认并应用', exact: true }).click(); assert.equal((await alignmentConflict).status(), 409);
    await conflictDialog.getByRole('alert').waitFor();
    assert.equal(await conflictDialog.locator('[data-alignment-device]').count(), 3);
    assert.equal(await conflictDialog.getByLabel('对齐基准设备', { exact: true }).inputValue(), info.devices[0]);
    assert.deepEqual(await devices(), concurrentDevices);
    await conflictDialog.screenshot({ path: path.join(directory, '05-alignment-conflict-preserved.png') });
    await conflictDialog.getByRole('button', { name: '取消', exact: true }).click();
    check('actual stale-source alignment CAS rejects the whole batch while keeping the preview settings/table and concurrent positions intact');

    assert.deepEqual(errors, []);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(info.assetPath)).digest('hex'), info.assetSha256);
    assert.equal(mutations.filter(row => /\/api\/(?:plc|engine|collector)(?:\/|$)/.test(row.path)).length, 0);
    const result = { success: true, checks, directory, fixtureDirectory: info.directory, errors, consoleErrors, mutations,
        noPLCCommands: true, assetUnchanged: true, ownedBackendPid: info.backendPid };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, mutations: mutations.map(({ method, path }) => ({ method, path })) }, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack || String(error), errors, consoleErrors, mutations }, null, 2));
    console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(fixture?.backend); });
