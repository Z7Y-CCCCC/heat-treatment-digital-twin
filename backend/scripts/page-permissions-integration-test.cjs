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
    const deviceReader = await account('device_reader', { devices: { view: true } });
    const monitorReader = await account('monitor_reader', { 'point-monitor': { view: true } });
    const motionReader = await account('motion_reader', { 'model-animations': { view: true } });
    const motionEditor = await account('motion_editor', { 'model-animations': { view: true, edit: true } });
    const motionRoute = `/devices/${device.id}/animations`;
    const animation = (await request(motionRoute, { session: motionEditor, expected: 200 })).data;
    const animationBody = { revision: animation.revision, config: { version: 1, staleMs: 5000, bindings: [] } };
    await request(`/datapoints?device_id=${device.id}`, { session: motionEditor, expected: 200 });
    await request(motionRoute, { session: motionReader, expected: 200 });
    await request(motionRoute, { method: 'PUT', session: motionReader, body: animationBody, expected: 403 });
    await request(motionRoute, { method: 'PUT', session: motionEditor, body: animationBody, noCsrf: true, expected: 403 });
    await request(motionRoute, { method: 'PUT', session: motionEditor, body: animationBody, expected: 200 });
    await request(`/devices/${device.id}`, { method: 'PUT', session: motionEditor, body: {}, expected: 403 });
    await request(motionRoute, { session: deviceReader, expected: 403 });
    const collectorViewer = await account('collector_viewer', { 'settings.data': { view:true } });
    const collectorEditor = await account('collector_editor', { 'settings.data': { view:true,edit:true } });
    const collectorStatus = (await request('/collector/status', { session:collectorViewer,expected:200 })).data;
    const sourceBody = { mode:collectorStatus.configuredMode,expectedMode:collectorStatus.configuredMode };
    await request('/collector/status', { session:deviceReader,expected:403 });
    await request('/collector/mode', { method:'PUT',session:collectorViewer,body:sourceBody,expected:403 });
    await request('/collector/mode', { method:'PUT',session:collectorEditor,body:sourceBody,noCsrf:true,expected:403 });
    await request('/collector/mode', { method:'PUT',session:collectorEditor,body:sourceBody,expected:200 });
    await request('/collector/mode', { method:'PUT',session:collectorEditor,body:{...sourceBody,plc_ip:'forbidden'},expected:400 });
    for (const session of [deviceReader, monitorReader]) {
        const status = await request('/native-preview/status', { session, expected: 200 });
        assert.equal(typeof status.data.unityClients, 'number');
        await request('/native-preview', { method: 'POST', session, body: {}, expected: 403 });
        await request('/native-preview/status', { method: 'POST', session, body: {}, expected: 403 });
        await request('/native-preview/status/private', { session, expected: 403 });
    }
    await request('/native-preview/status', { expected: 401 });
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
    await request('/models/permission_model/name', { method: 'PUT', session: reader, body: { name: '不应保存' }, expected: 403 });
    await request('/models/permission_model/name', { method: 'PUT', session: author, body: { name: '权限编辑名称' }, expected: 200 });
    await request('/models/permission_model/name', { method: 'PUT', session: author, body: { name: '禁止越权', metadata: '{}' }, expected: 400 });
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
    const lineEditor = await account('line_layout_editor', { lines: { view: true, edit: true } });
    const lineReader = await account('line_layout_reader', { lines: { view: true } });
    await request('/devices', { method: 'POST', session: owner,
        body: { id: 'batch_layout_peer', name: '组布局验收设备', line_id: line.id }, expected: 200 });
    const batch = { devices: [{ id: device.id, pos_x: 10.5, layoutConfig: { stationNumber: 4 } }, { id: 'batch_layout_peer', pos_x: 20.5 }] };
    await request('/devices/transforms', { method: 'PUT', body: batch, expected: 401 });
    await request('/devices/transforms', { method: 'PUT', session: lineReader, body: batch, expected: 403 });
    await request('/devices/transforms', { method: 'PUT', session: author, body: batch, expected: 403 });
    await request('/devices/transforms', { method: 'PUT', session: lineEditor, body: batch, noCsrf: true, expected: 403 });
    for (const body of [{ devices: [] }, { devices: Array(201).fill(batch.devices[0]) },
        { devices: [batch.devices[0], batch.devices[0]] }, { devices: [{ id: device.id, plc_ip: 'not-allowed' }] },
        { devices: [{ id: device.id, layoutConfig: { inspection: {} } }] },
        { devices: [{ id: device.id, pos_x: '5' }] }, { devices: [{ id: device.id, scale: 0 }] },
        { devices: batch.devices, unexpected: true }]) {
        await request('/devices/transforms', { method: 'PUT', session: lineEditor, body, expected: 400 });
    }
    // The first member is updated inside the transaction before the second fails.
    for (const invalid of [{ id: 'not-a-device', pos_x: 4 },
        { id: 'batch_layout_peer', line_id: 'foreign-or-missing-line' },
        { id: 'batch_layout_peer', layoutConfig: { laneLineId: 'foreign-or-missing-line' } }]) {
        await request('/devices/transforms', { method: 'PUT', session: lineEditor,
            body: { devices: [batch.devices[0], invalid] }, expected: invalid.id === 'not-a-device' ? 404 : 400 });
        const rollback = (await request(`/devices/${device.id}`, { session: owner, expected: 200 })).data;
        assert.deepEqual(rollback, afterTransform, 'failed group placement must roll back every member');
    }
    const groupSaved = (await request('/devices/transforms', { method: 'PUT', session: lineEditor, body: batch, expected: 200 })).data;
    assert.deepEqual(groupSaved.devices.map(row => row.pos_x), [10.5, 20.5]);
    const actual = (await request(`/devices/${device.id}`, { session: owner, expected: 200 })).data;
    const expectedConfig = { ...JSON.parse(afterTransform.instance_config), stationNumber: 4 };
    assert.deepEqual(actual, { ...afterTransform, pos_x: 10.5, instance_config: JSON.stringify(expectedConfig) });
    assert.deepEqual(groupSaved.devices[0].instance_config, actual.instance_config);
    await request('/devices/transforms', { method: 'PUT', session: composer,
        body: { devices: [{ id: device.id, pos_x: 17.5, layoutConfig: { stationNumber: null } }] }, expected: 200 });
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
    assert.equal(designer.data.pagePermissions['platform.map'].edit, true, 'old designer grants retain moved map editing');
    assert.equal(designer.data.pagePermissions['platform.loading'].edit, true, 'old designer grants retain moved loading editing');
    const movedSettings = (await request('/settings', { session: owner, expected: 200 })).data;
    const mapEditor = await account('map_only_editor', { 'platform.map': { view: true, edit: true } });
    await request('/settings', { method: 'PUT', session: mapEditor, body: { group_portal_config: movedSettings.group_portal_config || {} }, expected: 200 });
    await request('/settings', { method: 'PUT', session: mapEditor, body: { loading_experience_config: {} }, expected: 403 });
    await request('/settings', { method: 'PUT', session: mapEditor, body: { group_portal_config: {}, native_dashboard_config: {} }, expected: 403 });
    await request('/platform/designer/draft', { method: 'PUT', session: mapEditor, body: {}, expected: 403 });
    await request('/data-sources', { session: mapEditor, expected: 200 });
    const loadingEditor = await account('loading_only_editor', { 'platform.loading': { view: true, edit: true } });
    await request('/settings', { method: 'PUT', session: loadingEditor, body: { loading_experience_config: movedSettings.loading_experience_config || {} }, expected: 200 });
    await request('/settings', { method: 'PUT', session: loadingEditor, body: { group_portal_config: {} }, expected: 403 });
    await request('/data-sources', { session: loadingEditor, expected: 403 });
    const designerWithoutMap = await account('designer_no_map', { 'platform.designer': { view: true, edit: true }, 'platform.map': { view: false, edit: false } });
    await request('/settings', { method: 'PUT', session: designerWithoutMap, body: { group_portal_config: {} }, expected: 403 });

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
