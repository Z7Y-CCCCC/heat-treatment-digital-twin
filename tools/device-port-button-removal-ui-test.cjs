'use strict';
// Read-only browser acceptance against an owned output/ SQLite fixture only.
// Does not open an installed app, physical PLC, live Unity or production DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { startLoadingPortsFixture } = require('./loading-ports-ui-server.cjs');
const { normalizeLineLayout } = require('../backend/utils/spatialLayout');
const root = path.resolve(__dirname, '..');
const artifacts = requireTestPath(path.join(root, 'output', 'playwright'));
fs.mkdirSync(artifacts, { recursive: true });
const directory = fs.mkdtempSync(path.join(artifacts, `device-port-button-removal-${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}-`));
const checks = [], screenshots = [], errors = [], consoleErrors = [], mutations = [];
let fixture, browser, page, info;
const pass = name => { checks.push(name); console.log('PASS ' + name); };
function readConfiguration() {
    const db = new Database(requireTestPath(info.database), { readonly: true, fileMustExist: true });
    try { return Object.fromEntries(['models', 'devices', 'data_points', 'lines'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()])); }
    finally { db.close(); }
}
async function snap(name) {
    const filename = path.join(directory, name + '.png');
    await page.screenshot({ path: filename, fullPage: false }); screenshots.push(filename);
}
function deviceRow(id) {
    return page.locator('.device-group tbody tr').filter({ has: page.locator('code').filter({ hasText: new RegExp('^' + id + '$') }) });
}
async function checkActions(id, name, label) {
    const row = deviceRow(id); await row.waitFor(); await row.scrollIntoViewIfNeeded();
    assert.equal(await row.getByRole('button', { name: '进出料口微调', exact: true }).count(), 0);
    assert.equal(await row.getByRole('button', { name: '编辑', exact: true }).count(), 1);
    assert.equal(await row.getByRole('button', { name: '删除', exact: true }).count(), 1);
    assert.equal(await row.getByRole('button', { name: '编辑', exact: true }).isEnabled(), true);
    assert.equal(await row.getByRole('button', { name: '删除', exact: true }).isEnabled(), true);
    await snap(label + '-clean-actions');
    await row.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '编辑设备', exact: true });
    await editor.getByLabel('设备名称', { exact: true }).waitFor();
    assert.equal(await editor.getByLabel('设备名称', { exact: true }).inputValue(), name);
    assert.equal(await editor.getByLabel('设备 ID', { exact: true }).isDisabled(), true);
    await snap(label + '-edit-open');
    await editor.getByRole('button', { name: '取消', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    const confirmation = page.getByRole('dialog').filter({ hasText: `永久删除设备「${name}」` }); await confirmation.waitFor();
    assert.equal(await confirmation.getByRole('button', { name: '永久删除', exact: true }).isDisabled(), true);
    await snap(label + '-delete-confirmation');
    await confirmation.getByRole('button', { name: '取消', exact: true }).click(); await confirmation.waitFor({ state: 'hidden' });
    await row.waitFor(); pass(label + ': 无进出料口按钮，编辑与删除确认均可打开并取消');
}
(async () => {
    fixture = await startLoadingPortsFixture(); info = fixture.info;
    requireTestPath(info.database); assert.match(info.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    // Make one existing fixture device workshop-level/unassigned. This change
    // is test setup only and happens before the read-only baseline is taken.
    const db = new Database(info.database);
    try {
        const old = db.prepare('SELECT instance_config FROM devices WHERE id=?').get(info.devices[2]);
        const config = { ...JSON.parse(old.instance_config), role: 'auxiliary', layoutPlaced: false,
            loadingPortOverrides: { version: 1, inlet: { offset: [.1, .2, .3], yawDegrees: 4 }, outlet: null } };
        // Workshop-level fixtures cannot keep a stale authored lane reference:
        // the existing backend compatibility repair correctly restores those.
        for (const key of ['laneId', 'laneName', 'laneLineId', 'railId', 'railName', 'railLineId']) delete config[key];
        db.prepare("UPDATE devices SET line_id=NULL,coordinate_space='workshop_local',instance_config=? WHERE id=?").run(JSON.stringify(config), info.devices[2]);
        // Seed the current public layout shape rather than measuring its legacy
        // canonicalisation as a write caused by opening an editor.
        const line = db.prepare('SELECT layout_json FROM lines WHERE id=?').get(info.lineId);
        const layout = normalizeLineLayout(line.layout_json);
        db.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(layout), info.lineId);
    } finally { db.close(); }
    const baseline = readConfiguration();
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce' });
    await context.addInitScript(factoryId => {
        localStorage.setItem('digital_twin_admin_ui_state_v1', JSON.stringify({ activeTab: 'devices' }));
        localStorage.setItem('digital_twin_factory_scope_v1', factoryId);
    }, info.factoryId);
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === info.origin && /^\/api\/(?:models|devices|data-points|datapoints|lines)(?:\/|$)/.test(url.pathname)
            && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutations.push({ method: request.method(), path: url.pathname });
    });
    await page.goto(info.origin + '/admin');
    await page.getByRole('textbox', { name: '账号', exact: true }).fill(info.username);
    await page.getByLabel('后台密码', { exact: true }).fill(info.password);
    await page.getByRole('button', { name: '解锁后台', exact: true }).click();
    await page.getByRole('heading', { name: '设备管理', exact: true }).waitFor();
    await deviceRow(info.devices[0]).waitFor(); await deviceRow(info.devices[2]).waitFor();
    assert.equal(await page.locator('.device-group').getByRole('button', { name: /进出料口/ }).count(), 0);
    assert.match(await deviceRow(info.devices[2]).locator('xpath=ancestor::div[contains(@class,"device-group")]').innerText(), /辅助设备/);
    pass('产线设备及车间级未分配设备表均无进出料口快捷按钮');
    await checkActions(info.devices[0], info.deviceNames[0], '01-assigned');
    await checkActions(info.devices[2], info.deviceNames[2], '02-unassigned');
    await page.setViewportSize({ width: 1024, height: 900 }); await deviceRow(info.devices[2]).scrollIntoViewIfNeeded(); await snap('03-compact-unassigned');
    assert.equal(await page.locator('.device-group').getByRole('button', { name: /进出料口/ }).count(), 0);
    await page.reload(); await page.getByRole('heading', { name: '设备管理', exact: true }).waitFor(); await deviceRow(info.devices[0]).waitFor();
    assert.equal(await page.locator('.device-group').getByRole('button', { name: /进出料口/ }).count(), 0);
    assert.deepEqual(mutations, []); assert.deepEqual(readConfiguration(), baseline);
    pass('宽窄窗口及重新读取不恢复快捷入口，不改模型默认、设备微调、PLC、点位或布局');
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, checks, screenshots, errors, consoleErrors, mutations,
        noManagementWrites: true, collectorFalse: true, noUnity: true, noPhysicalPLC: true, fixtureDatabase: info.database, backendPid: info.backendPid, directory }, null, 2));
    console.log(JSON.stringify({ success: true, checks: checks.length, directory }));
})().catch(async error => {
    console.error(error.stack); if (page && !page.isClosed()) await snap('failure').catch(() => {});
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: false, error: error.stack, checks, screenshots, errors, consoleErrors, mutations, directory }, null, 2)); process.exitCode = 1;
}).finally(async () => { await browser?.close(); await stopOwnedSmokeProcess(fixture?.backend); });
