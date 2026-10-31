const assert = require('assert/strict');
const crypto = require('crypto');
const path = require('path');
const { BACKEND_DIR, createRunDirectory, findFreePort, forceStop, startLoggedProcess, waitForHttp } = require('./integration-test-utils.cjs');
const { createSmokeProgramData } = require('../../desktop/scripts/smoke-sandbox.cjs');
let backend;
(async () => {
    const directory = createRunDirectory('page-permissions-http');
    Object.assign(process.env, createSmokeProgramData(directory), {
        APP_DATA_DIR: path.join(directory, 'data'), DB_TYPE: 'sqlite', HOST: '127.0.0.1',
        SQLITE_FILE: path.join(directory, 'data', 'factory.db'), UPLOADS_DIR: path.join(directory, 'uploads'),
        LICENSE_FILE: path.join(directory, 'data', 'license.json'), LICENSE_ENFORCE: 'false',
        ADMIN_API_TOKEN: '', MCP_API_TOKEN: '', PORT: String(await findFreePort(3951))
    });
    const { getDb, closeDb } = require('../db/database');
    const db = await getDb();
    await db.upsert('settings', { key: 'data_mode', value: 'simulation' }, 'key');
    const workshop = await db.get('SELECT * FROM workshops LIMIT 1');
    const line = await db.get('SELECT * FROM `lines` WHERE workshop_id=? LIMIT 1', [workshop.id]);
    const device = await db.get('SELECT * FROM devices WHERE line_id=? LIMIT 1', [line.id]);
    const originalConfig = JSON.parse(device.instance_config || '{}');
    originalConfig.permissionFixture = 'must-survive';
    await db.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(originalConfig), device.id]);
    await db.run('INSERT INTO data_points (device_id,name,label,plc_tag) VALUES (?,?,?,?)', [device.id, 'permission_point', '权限测试点', 'DB1.DBD0']);
    await db.run("INSERT INTO data_points (device_id,name,label,plc_tag,data_type,point_kind,alarm_text) VALUES (?,?,?,?,?,?,?)",
        [device.id, 'bj81', 'bj81', 'DB1.DBX90.0', 'BOOL', 'alarm', '原始报警文本']);
    await db.run('INSERT INTO models (id,name,file_path,metadata) VALUES (?,?,?,?)', ['permission_model', '权限测试模型', '/assets/models/test.glb', '{}']);
    await closeDb();
    const origin = `http://127.0.0.1:${process.env.PORT}`;
    backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], { cwd: BACKEND_DIR,
        env: process.env, logFile: path.join(directory, 'backend.log') });
    await waitForHttp(`${origin}/api/health`);
    let checks = 0;
    async function request(route, { method = 'GET', session, body, expected, noCsrf = false } = {}) {
        const response = await fetch(`${origin}/api${route}`, { method,
            headers: { Origin: origin, 'X-Admin-Request': '1', 'X-Factory-ID': workshop.factory_id,
                ...(session ? { Cookie: session.cookie, ...(!noCsrf ? { 'X-CSRF-Token': session.csrfToken } : {}) } : {}),
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        if (expected !== undefined) { assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data).slice(0,500)}`); checks++; }
        const cookies = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
        return { data, cacheControl: response.headers.get('cache-control'), cookie: cookies || session?.cookie, csrfToken: data.csrfToken || session?.csrfToken };
    }
    const password = crypto.randomBytes(24).toString('base64url');
    const owner = await request('/admin-auth/setup', { method: 'POST', body: { password }, expected: 200 });
    async function account(username, grants) {
        const result = await request('/admin-auth/users', { method: 'POST', session: owner,
            body: { username, password, role: 'viewer', permissions: { view: false }, pagePermissions: grants }, expected: 201 });
        const session = await request('/admin-auth/login', { method: 'POST', body: { username, password }, expected: 200 });
        return { ...session, userId: result.data.user.id };
    }
    const reader = await account('model_reader', { models: { view: true } });
    const catalog = await request('/admin-auth/page-catalog', { session: owner, noCsrf: true, expected: 200 });
    assert.equal(catalog.cacheControl, 'no-store');
    assert.deepEqual(catalog.data.pages, require('../../shared/adminPages.mjs').getAdminPageCatalog());
    assert.ok(catalog.data.pages.some(p => p.key === 'points.alarms'));
    assert.ok(owner.data.pageCatalog.some(p => p.key === 'points.alarms'));
    await request('/admin-auth/page-catalog', { session: reader, expected: 403 });
    await request('/admin-auth/page-catalog', { expected: 401 });
    const alarmEditor = await account('alarm_text_editor', { 'points.alarms': { view: true, edit: true } });
    assert.equal(alarmEditor.data.pagePermissions.points.view, false);
    const originalPoints = (await request(`/datapoints?device_id=${device.id}`, { session: alarmEditor, expected: 200 })).data;
    const trigger = originalPoints.find(p => p.name === 'bj81');
    const normal = originalPoints.find(p => p.name === 'permission_point');
    await request('/devices', { session: alarmEditor, expected: 200 });
    const alarmPatch = { device_id: device.id, points: [{ id: trigger.id, alarm_text: '新报警文本' }] };
    await request('/datapoints/alarm-texts', { method: 'POST', session: alarmEditor, body: alarmPatch, noCsrf: true, expected: 403 });
    await request('/datapoints/sync', { method: 'POST', session: alarmEditor, body: { device_id: device.id, points: [] }, expected: 403 });
    await request('/datapoints/alarm-texts', { method: 'POST', session: reader, body: alarmPatch, expected: 403 });
    await request('/datapoints/alarm-texts', { method: 'POST', session: alarmEditor,
        body: { ...alarmPatch, points: [{ ...alarmPatch.points[0], plc_tag: 'DB9.DBX0.0' }] }, expected: 400 });
    await request('/datapoints/alarm-texts', { method: 'POST', session: alarmEditor,
        body: { ...alarmPatch, points: [...alarmPatch.points, { id: normal.id, alarm_text: '不应生效' }] }, expected: 400 });
    const unchanged = (await request(`/datapoints?device_id=${device.id}`, { session: alarmEditor, expected: 200 })).data;
    assert.deepEqual(unchanged, originalPoints, 'an invalid patch must roll back every text update');
    await request('/datapoints/alarm-texts', { method: 'POST', session: alarmEditor, body: { ...alarmPatch, device_id: 'not-a-device' }, expected: 404 });
    await request('/datapoints/alarm-texts', { method: 'POST', session: alarmEditor, body: alarmPatch, expected: 200 });
    const updatedPoints = (await request(`/datapoints?device_id=${device.id}`, { session: alarmEditor, expected: 200 })).data;
    assert.deepEqual(updatedPoints, originalPoints.map(p => p.id === trigger.id ? { ...p, alarm_text: '新报警文本' } : p));
    await request('/models', { session: reader, expected: 200 });
    await request('/platform/designer', { session: reader, expected: 403 });
    await request('/database/config', { session: reader, expected: 403 });
    await request('/admin-auth/users', { session: reader, expected: 403 });
    await request('/models/missing', { method: 'PUT', session: reader, body: {}, expected: 403 });
    await request('/models/missing', { method: 'DELETE', session: reader, expected: 403 });
    await request('/license', { method: 'PUT', session: reader, body: {}, expected: 403 });
    await request('/license', { method: 'PUT', body: {}, expected: 401 });
    await request('/system/runtime', { method: 'PUT', session: reader, body: {}, expected: 403 });
    await request('/system/runtime', { method: 'PUT', body: {}, expected: 401 });
    await request('/system/runtime', { session: reader, expected: 403 });
    await request('/system/runtime', { expected: 401 });
    await request('/admin-auth/touch', { method: 'POST', session: reader, body: {}, expected: 200 });
    const author = await account('model_editor', { models: { view: true, edit: true } });
    await request('/models/missing', { method: 'PUT', session: author, body: {}, expected: 404 });
    await request('/models/missing', { method: 'DELETE', session: author, expected: 403 });
    await request('/models/permission_model', { method: 'PUT', session: author,
        body: { metadata: { assetSpec: { delivery_status: 'released' }, release: { status: 'released', version: '1.0.0' } } }, expected: 403 });
    const modelPublisher = await account('model_publisher', { models: { view: true, edit: true, publish: true } });
    await request('/models/permission_model', { method: 'PUT', session: modelPublisher,
        body: { metadata: { assetSpec: { delivery_status: 'released' }, release: { status: 'released', version: '1.0.0' } } }, expected: 200 });
    await request('/devices', { method: 'POST', session: author, body: {}, expected: 403 });
    await request('/mcp', { method: 'POST', session: author, body: { method: 'tools/call', params: { name: 'update_device' } }, expected: 403 });
    const composer = await account('layout_editor', { composer: { view: true, edit: true } });
    await request(`/devices/${device.id}`, { method: 'PUT', session: composer, body: { plc_ip: 'not-allowed' }, expected: 403 });
    await request(`/devices/${device.id}/transform`, { method: 'PUT', session: composer, body: { plc_ip: 'not-allowed' }, expected: 400 });
    await request(`/devices/${device.id}/transform`, { method: 'PUT', session: composer, body: { pos_x: 17.5 }, expected: 200 });
    const afterTransform = (await request(`/devices/${device.id}`, { session: composer, expected: 200 })).data;
    assert.equal(afterTransform.pos_x, 17.5);
    assert.equal(afterTransform.plc_ip, device.plc_ip);
    assert.equal(afterTransform.model_type, device.model_type);
    assert.equal(JSON.parse(afterTransform.instance_config).permissionFixture, 'must-survive');
    const movement = await account('movement_editor', { 'mobile-devices': { view: true, edit: true } });
    await request(`/devices/${device.id}/movement`, { method: 'PUT', session: movement, body: { movement: { enabled: false }, plc_ip: 'not-allowed' }, expected: 400 });
    await request(`/devices/${device.id}/movement`, { method: 'PUT', session: movement, body: { movement: { enabled: false } }, expected: 200 });
    await request(`/devices/${device.id}/transform`, { method: 'PUT', session: movement, body: { pos_x: 99 }, expected: 403 });
    const workshopEditor = await account('workshop_editor', { workshops: { view: true, edit: true } });
    await request(`/lines/${line.id}/placement`, { method: 'PUT', session: workshopEditor,
        body: { transform: { x: 5, y: 0, z: 0, rotationY: 0 }, placementPending: false }, expected: 200 });
    await request(`/lines/${line.id}`, { method: 'PUT', session: workshopEditor, body: { name: 'not-allowed' }, expected: 403 });
    const dataEditor = await account('data_editor', { 'settings.data': { view: true, edit: true } });
    await request('/settings', { method: 'PUT', session: dataEditor, body: { data_mode: 'simulation' }, expected: 200 });
    await request('/settings', { method: 'PUT', session: dataEditor, body: { data_mode: 'simulation', native_quality_profile: 'showcase' }, expected: 403 });
    await request('/settings', { method: 'PUT', session: dataEditor, body: { unexpected_setting: 'value' }, expected: 403 });
    const databaseEditor = await account('database_editor', { 'settings.database': { view: true, edit: true } });
    await request('/database/backups/fixture.sql/restore', { method: 'POST', session: databaseEditor, body: {}, expected: 403 });
    const designer = await account('screen_editor', { 'platform.designer': { view: true, edit: true } });
    await request('/platform/designer', { session: designer, expected: 200 });
    await request('/platform/releases', { method: 'POST', session: designer, body: {}, expected: 403 });
    await request('/platform/releases/missing/activate', { method: 'POST', session: designer, body: {}, expected: 403 });
    const publisher = await account('screen_publisher', { 'platform.designer': { view: true, publish: true } });
    await request('/platform/designer/draft', { method: 'PUT', session: publisher, body: {}, expected: 403 });
    await request('/platform/releases', { method: 'POST', session: publisher, body: {}, expected: 200 });
    await request('/platform/releases/missing', { method: 'DELETE', session: publisher, expected: 403 });
    const pointsEditor = await account('point_editor', { points: { view: true, edit: true } });
    await request('/datapoints/sync', { method: 'POST', session: pointsEditor, body: { device_id: device.id, points: [] }, expected: 403 });
    await request('/admin-auth/users/' + reader.userId, { method: 'PUT', session: owner, body: { enabled: true, pagePermissions: {} }, expected: 200 });
    await request('/models', { session: reader, expected: 401 });
    await request('/admin-auth/lock', { method: 'POST', session: author, body: {}, expected: 200 });
    await request('/models/missing', { method: 'PUT', session: author, body: {}, expected: 401 });
    console.log(JSON.stringify({ success: true, checks, pageReadIsolation: true, actionIsolation: true,
        narrowAuthoringEndpoints: true, implicitDeletionBlocked: true, lockAndRevocation: true, artifacts: directory }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => forceStop(backend));
