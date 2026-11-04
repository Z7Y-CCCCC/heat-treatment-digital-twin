// Owned isolated browser fixture; never edits the running factory database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRunDirectory, requireTestPath, startLoggedProcess, waitUntil } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), directory = createRunDirectory('line-multiselect-ui'), checks = [], errors = [];
let server, browser, page;
const check = name => { checks.push(name); console.log('PASS ' + name); };
(async () => {
    const infoFile = path.join(directory, 'server.json');
    server = startLoggedProcess(process.execPath, [path.join(__dirname, 'manual-disassembly-ui-server.cjs')], {
        cwd: root, env: { ...process.env, MANUAL_LAYOUT_UI_INFO_FILE: infoFile }, logFile: path.join(directory, 'server.log') });
    await waitUntil(() => { assert.equal(server.exitCode, null); return fs.existsSync(infoFile); }, 60000, 'isolated UI server');
    const info = JSON.parse(fs.readFileSync(infoFile)); requireTestPath(info.database);
    const db = new Database(info.database), lineId = db.prepare('SELECT line_id FROM devices WHERE id=?').get(info.devices[0]).line_id;
    const layout = { version: 2, coordinateSpace: 'workshop_local', placementPending: false, transform: { x: 0, y: 0, z: 0, rotationY: 0 },
        flowDirection: 'right', lanes: [{ id: 'qa_lane1', name: '设备线 1', offsetZ: 0, length: 60 }, { id: 'qa_lane2', name: '设备线 2', offsetZ: 8, length: 60 }], rails: [] };
    db.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(layout), lineId);
    const ids = [...info.devices, 'qa_group_c', 'qa_unselected'];
    for (const [i, id] of ids.entries()) {
        if (i >= 2) db.prepare('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)').run(id, i === 2 ? '现场设备C' : '不应移动', lineId, info.models[0], '{}');
        const original = db.prepare('SELECT instance_config FROM devices WHERE id=?').get(id);
        const config = { ...JSON.parse(original.instance_config || '{}'), laneLineId: lineId, laneId: i === 3 ? 'qa_lane2' : 'qa_lane1', laneName: i === 3 ? '设备线 2' : '设备线 1', stationNumber: 11 + i,
            plcPreservationMarker: { device: id }, inspection: { preserve: id }, movement: { preserve: id } };
        db.prepare("UPDATE devices SET line_id=?,coordinate_space='line_local',pos_x=?,pos_z=?,instance_config=? WHERE id=?")
            .run(lineId, [-20, -3, 15, 27][i], i === 3 ? 8 : 0, JSON.stringify(config), id);
    }
    db.close();
    browser = await playwright.chromium.launch({ headless: true,
        ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), args: ['--enable-unsafe-swiftshader'] });
    const makePage = async () => {
        const context = await browser.newContext({ viewport: { width: 1920, height: 1250 } });
        await context.addInitScript(({ lineId }) => { localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({
            activeTab: 'lines', selectedLineEditorId: lineId, isLinePlannerEditorCollapsed: true, isLineDevicePoolCollapsed: true })); }, { lineId });
        const target = await context.newPage(); target.setDefaultTimeout(20000); target.on('pageerror', e => errors.push(e.message)); return target;
    };
    const login = async (target, username) => {
        await target.goto(info.origin + '/admin'); await target.getByRole('textbox', { name: '账号', exact: true }).fill(username);
        await target.getByLabel('后台密码', { exact: true }).fill(info.password);
        await target.getByRole('button', { name: '解锁后台', exact: true }).click();
        await target.locator(`[data-device-id="${ids[0]}"]`).waitFor();
    };
    page = await makePage(); await login(page, info.username);
    const toolbar = page.getByRole('toolbar', { name: '设备多选与间距' }), stage = page.locator('.line-preview-stage').first();
    const card = id => page.locator(`[data-device-id="${id}"]`);
    const data = async () => (await (await page.request.get(info.origin + '/api/devices')).json()).filter(d => ids.includes(d.id)).sort((a,b) => a.id.localeCompare(b.id));
    assert.equal(await page.getByText('批量添加与排布',{exact:true}).count(),0);
    assert.equal(await page.locator('.line-planner-steps,.line-editor-float-toggle').count(),0);
    const controls = page.getByRole('region',{name:'产线配置工具栏'});
    const layoutBox=await page.locator('.line-planner-layout').boundingBox(), previewBox=await page.locator('.line-planner-preview').boundingBox();
    assert.ok(Math.abs(layoutBox.x-previewBox.x)<2 && Math.abs(layoutBox.width-previewBox.width)<2,'canvas must no longer lose width to a configuration sidebar');
    const configure=controls.getByRole('button',{name:'产线与轨道设置',exact:true});await configure.click();
    assert.ok(await page.locator('#line-configuration-panel').isVisible());assert.ok((await page.locator('#line-configuration-panel').boundingBox()).height<=251);
    assert.ok((await page.locator('#line-configuration-panel').boundingBox()).y < (await stage.boundingBox()).y);
    await controls.screenshot({path:path.join(directory,'00-expanded-top-configuration.png')});
    await controls.getByRole('button',{name:'收起设置',exact:true}).click();
    await page.screenshot({path:path.join(directory,'00-full-width-line-canvas.png'),fullPage:true});
    const reading=page.locator('summary[aria-label="后台文字大小"]');await reading.click();
    await page.getByRole('group',{name:'后台文字大小设置'}).getByRole('button',{name:'150%',exact:true}).click();
    assert.equal(await page.locator('.line-config-toolbar label').evaluate(el=>getComputedStyle(el).fontSize),'19.5px');
    await page.reload(); await card(ids[0]).waitFor();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('digital_twin_admin_reading_v1')).textSize),150);
    await reading.click();await page.getByRole('group',{name:'后台文字大小设置'}).getByRole('button',{name:'115%',exact:true}).click();await reading.click();
    check('configuration is a compact toolbar above a full-width canvas; larger admin fonts persist locally across reload without changing data');
    const initial = await data(); let writes = 0;
    page.on('request', r => { if (/\/api\/devices(?:\/[^/]+\/transform|\/transforms)$/.test(new URL(r.url()).pathname) && r.method() === 'PUT') writes++; });
    const choose = async (members, modifier = 'Control') => {
        const clear = toolbar.getByRole('button', { name: '取消选择', exact: true }); if (await clear.count()) await clear.click();
        await card(members[0]).locator('strong').click();
        await page.keyboard.down(modifier);
        for (const id of members.slice(1)) await card(id).locator('strong').click();
        await page.keyboard.up(modifier);
        for (const id of members) assert.equal(await card(id).getAttribute('aria-pressed'), 'true');
    };
    await choose(ids.slice(0, 3)); assert.equal(writes, 0); assert.deepEqual(await data(), initial);
    await card(ids[1]).locator('strong').click({ modifiers: ['Control'] }); assert.equal(await card(ids[1]).getAttribute('aria-pressed'), 'false');
    await card(ids[1]).locator('strong').click({ modifiers: ['Shift'] }); assert.equal(await card(ids[1]).getAttribute('aria-pressed'), 'true');
    assert.equal(await toolbar.getByRole('button', { name: '等间距', exact: true }).isDisabled(), false);
    await stage.screenshot({ path: path.join(directory, '01-selected.png') });
    check('Ctrl and Shift toggle multi-selection without saving or moving devices; selected cards are visibly marked');
    const drag = async (dx, { modifier, cancel, dy = 0 } = {}) => {
        const box = await card(ids[1]).boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        if (modifier) await page.keyboard.down(modifier);
        await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 8 });
        if (cancel === 'Escape') await page.keyboard.press('Escape');
        if (cancel === 'pointercancel') await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
        if (cancel === 'lostpointercapture') await card(ids[1]).evaluate(el => el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 })));
        await page.mouse.up(); if (modifier) await page.keyboard.up(modifier);
    };
    let response = page.waitForResponse(r => r.url().endsWith('/api/devices/transforms') && r.request().method() === 'PUT');
    await drag(55, { modifier: 'Control' }); assert.equal((await response).status(), 200);
    await toolbar.getByRole('status').getByText('已保存', { exact: true }).waitFor();
    const moved = await data(), delta = moved.find(d => d.id === ids[0]).pos_x - initial.find(d => d.id === ids[0]).pos_x;
    assert.notEqual(delta, 0);
    for (const id of ids.slice(0,3)) {
        const old = initial.find(d => d.id === id), now = moved.find(d => d.id === id);
        assert.deepEqual(now, { ...old, pos_x: old.pos_x + delta });
    }
    assert.deepEqual(moved.find(d => d.id === ids[3]), initial.find(d => d.id === ids[3]));
    assert.equal(writes, 1); check('holding Ctrl while dragging a selected member moves the entire group with one atomic save; all gaps and PLC/model/inspection metadata survive');
    for (const cancel of ['Escape', 'pointercancel', 'lostpointercapture']) {
        await drag(55, { cancel }); assert.equal(await page.locator('.line-device-ghost').count(), 0);
        assert.deepEqual(await data(), moved); assert.equal(writes, 1);
    }
    check('Escape, pointer cancellation and lost capture all cancel without writes, ghost residue or stale pointer-up saves');
    response = page.waitForResponse(r => r.url().endsWith('/api/devices/transforms') && r.request().method() === 'PUT');
    await toolbar.getByRole('button', { name: '等间距', exact: true }).click(); assert.equal((await response).status(), 200);
    await toolbar.getByRole('status').getByText('已保存', { exact: true }).waitFor();
    const spaced = await data(), positions = ids.slice(0,3).map(id => spaced.find(d => d.id === id).pos_x);
    assert.equal(positions[0], moved.find(d => d.id === ids[0]).pos_x); assert.equal(positions[2], moved.find(d => d.id === ids[2]).pos_x);
    assert.equal(positions[1] - positions[0], positions[2] - positions[1]);
    check('one-click equal spacing fixes both ends and evenly redistributes selected device centers');
    await toolbar.getByLabel('设备中心间距（米）', { exact: true }).fill('100');
    await toolbar.getByRole('button', { name: '应用间距', exact: true }).click();
    await page.getByText('间距超出设备线长度，请减小间距', { exact: true }).waitFor();
    await page.getByRole('button', { name: '确定', exact: true }).click(); assert.equal(writes, 2); assert.deepEqual(await data(), spaced);
    await toolbar.getByLabel('设备中心间距（米）', { exact: true }).fill('10');
    response = page.waitForResponse(r => r.url().endsWith('/api/devices/transforms') && r.request().method() === 'PUT');
    await toolbar.getByRole('button', { name: '应用间距', exact: true }).click(); assert.equal((await response).status(), 200);
    await toolbar.getByRole('status').getByText('已保存', { exact: true }).waitFor();
    const manual = await data(), manualX = ids.slice(0,3).map(id => manual.find(d => d.id === id).pos_x);
    assert.deepEqual(manualX, [positions[0], positions[0] + 10, positions[0] + 20]);
    assert.deepEqual(manual.find(d => d.id === ids[3]), initial.find(d => d.id === ids[3]));
    check('explicit spacing applies to selected centers only; impossible spacing is rejected before any write');
    const beforeFailureStyle = await card(ids[1]).getAttribute('style');
    await page.route('**/api/devices/transforms', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '验收模拟保存失败' }) }));
    await drag(45); await page.getByRole('heading', { name: '设备布局保存失败', exact: true }).waitFor();
    assert.equal(await card(ids[1]).getAttribute('style'), beforeFailureStyle); assert.deepEqual(await data(), manual);
    await page.getByRole('button', { name: '确定', exact: true }).click(); await page.unroute('**/api/devices/transforms');
    assert.equal(await page.locator('.line-device-ghost').count(), 0);
    assert.equal(await card(ids[0]).getAttribute('aria-pressed'), 'true');
    check('HTTP failure leaves all original positions and selection intact and restores the native preview');
    await page.reload(); await card(ids[0]).waitFor(); assert.deepEqual(await data(), manual);
    assert.equal(await card(ids[0]).getAttribute('aria-pressed'), 'false');
    await choose([ids[0], ids[3]]); assert.ok(await toolbar.getByRole('button', { name: '等间距', exact: true }).isDisabled());
    assert.ok(await toolbar.getByRole('button', { name: '应用间距', exact: true }).isDisabled());
    await choose(ids.slice(0,3), 'Shift');
    await page.locator('.line-config-toolbar').screenshot({ path: path.join(directory, '02-line-toolbar.png') });
    await page.screenshot({ path: path.join(directory, '03-spacing.png'), fullPage: true });
    check('saved layouts survive reload; spacing across different lanes is disabled');
    const session = await (await page.request.get(info.origin + '/api/admin-auth/session')).json();
    const created = await page.request.post(info.origin + '/api/admin-auth/users', { headers: {
        Origin: info.origin, 'X-Admin-Request': '1', 'X-CSRF-Token': session.csrfToken }, data: {
        username: 'line_reader', password: info.password, role: 'viewer', permissions: { view: false }, pagePermissions: { lines: { view: true } } } });
    assert.equal(created.status(), 201, await created.text());
    const reader = await makePage(); await login(reader, 'line_reader');
    const readCard = id => reader.locator(`[data-device-id="${id}"]`);
    await readCard(ids[0]).locator('strong').click(); await readCard(ids[1]).locator('strong').click({ modifiers: ['Control'] });
    assert.equal(await readCard(ids[1]).getAttribute('aria-pressed'), 'true');
    assert.ok(await reader.getByRole('button', { name: '应用间距', exact: true }).isDisabled());
    const rb = await readCard(ids[0]).boundingBox(); await reader.mouse.move(rb.x + 40, rb.y + 25); await reader.mouse.down(); await reader.mouse.move(rb.x + 100, rb.y + 25); await reader.mouse.up();
    assert.deepEqual(await data(), manual); check('read-only users may select and inspect but cannot drag or set spacing');
    // Cross-lane drops update every binding in the same transaction.
    await choose(ids.slice(0, 3));
    const moveToLane = async laneId => {
        const laneBox = await page.locator(`[data-line-target-type="lane"][data-line-target-id="${laneId}"]`).boundingBox();
        const anchorBox = await card(ids[1]).boundingBox();
        const saved = page.waitForResponse(r => r.url().endsWith('/api/devices/transforms') && r.request().method() === 'PUT');
        await drag(0, { dy: laneBox.y + laneBox.height / 2 - anchorBox.y - anchorBox.height / 2 });
        assert.equal((await saved).status(), 200); await toolbar.getByRole('status').getByText('已保存', { exact: true }).waitFor();
    };
    await moveToLane('qa_lane2');
    const reBound = await data();
    for (const id of ids.slice(0, 3)) {
        const row = reBound.find(d => d.id === id), old = manual.find(d => d.id === id), config = JSON.parse(old.instance_config);
        assert.deepEqual(row, { ...old, pos_z: 8, instance_config: JSON.stringify({ ...config, laneId: 'qa_lane2', laneName: '设备线 2' }) });
    }
    await moveToLane('qa_lane1'); assert.deepEqual(await data(), manual);
    check('dragging a selected group between equipment lanes updates every lane binding and preserves all relative positions and station numbers');
    response = page.waitForResponse(r => r.url().endsWith('/api/devices/transforms') && r.request().method() === 'PUT');
    await drag(700); assert.equal((await response).status(), 200); await toolbar.getByRole('status').getByText('已保存', { exact: true }).waitFor();
    const clamped = await data(), clampedX = ids.slice(0, 3).map(id => clamped.find(d => d.id === id).pos_x);
    assert.deepEqual(clampedX, [10, 20, 30]); assert.deepEqual(clamped.find(d => d.id === ids[3]), manual.find(d => d.id === ids[3]));
    check('lane-edge clamping stops the entire group together without compressing its spacing');
    await toolbar.getByRole('button', { name: '取消选择', exact: true }).click();
    await card(ids[0]).focus(); await page.keyboard.press('Space');
    await card(ids[1]).focus(); await page.keyboard.press('Control+Space');
    assert.equal(await card(ids[0]).getAttribute('aria-pressed'), 'true'); assert.equal(await card(ids[1]).getAttribute('aria-pressed'), 'true');
    assert.equal(await card(ids[2]).getAttribute('aria-pressed'), 'false');
    await page.setViewportSize({ width: 1100, height: 900 });
    assert.ok((await toolbar.boundingBox()).x + (await toolbar.boundingBox()).width <= 1100);
    await toolbar.screenshot({ path: path.join(directory, '04-compact-toolbar.png') });
    check('keyboard multi-selection works and the compact toolbar wraps within a narrow desktop viewport');
    await page.setViewportSize({width:1600,height:1100});
    await page.locator('.admin-nav button[title="车间管理"]').click();
    await page.getByRole('button',{name:/空间与边界/}).click();
    assert.equal(await page.locator('.workshop-back-button').count(),0);
    await page.locator('.admin-nav button[title="组件配置"]').click();
    await page.locator('.secondary-page-nav-item').filter({hasText:'加载画面'}).click();
    const upload=page.locator('.loading-settings input[type=file]');await upload.waitFor();
    const fileButton=await upload.evaluate(el=>{const s=getComputedStyle(el,'::file-selector-button');return {radius:s.borderRadius,color:s.color}});
    assert.equal(fileButton.radius,'8px');assert.equal(fileButton.color,'rgb(36, 87, 166)');
    for(const percent of [130,200]) {
      await reading.click();await page.getByRole('group',{name:'后台文字大小设置'}).getByRole('button',{name:`${percent}%`,exact:true}).click();await reading.click();
      const saveLoading = page.getByRole('button',{name:'保存加载画面',exact:true});
      await saveLoading.scrollIntoViewIfNeeded();
      const box = await saveLoading.boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 1100 && box.x >= 0 && box.x + box.width <= 1600, 'large text must leave the save action reachable, not clipped');
      await page.screenshot({path:path.join(directory,`05-reading-${percent}.png`),fullPage:true});
    }
    await page.goto(info.origin+'/group');
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--admin-font-scale')),'');
    check('workshop back arrows are removed, file buttons use shared styling, 200% text stays operable, and leaving admin restores the unscaled runtime');
    assert.deepEqual(errors, []);
    const result = { success: true, checks, browserErrors: errors, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(async error => {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2)); console.error(error); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(server); });
