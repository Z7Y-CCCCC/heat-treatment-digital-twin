const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
    BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort,
    forceStop, startLoggedProcess, waitForHttp
} = require('./integration-test-utils.cjs');

let baseUrl = String(process.env.TEST_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
let token = String(process.env.ADMIN_API_TOKEN || '');

async function api(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'X-Admin-Token': token } : {}),
            ...(options.headers || {})
        }
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

function inFactory(factoryId, headers = {}) {
    return { ...headers, 'X-Factory-ID': factoryId };
}

async function verifyIsolation(databaseFile) {
    const { response: listResponse, body: listBody } = await api('/api/factories');
    assert.equal(listResponse.status, 200, listBody.error);
    assert.ok(listBody.factories.some(factory => factory.id === 'factory_default'));
    const originalActiveFactoryId = listBody.activeFactoryId;

    const { response: createResponse, body: created } = await api('/api/factories', {
        method: 'POST',
        body: JSON.stringify({
            name: '隔离测试工厂',
            location: { country: 'CHN', regionName: '浙江省', city: '宁波市', districtName: '北仑区' }
        })
    });
    assert.equal(createResponse.status, 201, created.error);
    const factoryId = created.factory.id;
    const workshopId = `isolation_ws_${Date.now()}`;
    const lineId = `isolation_line_${Date.now()}`;
    const deviceId = `isolation_device_${Date.now()}`;
    let activated = false;

    try {
        const defaultWorkshops = await api('/api/workshops', { headers: inFactory('factory_default') });
        const newFactoryWorkshops = await api('/api/workshops', { headers: inFactory(factoryId) });
        assert.equal(defaultWorkshops.response.status, 200);
        assert.ok(defaultWorkshops.body.length > 0, 'legacy/default factory fixture should contain its seeded workshop');
        assert.equal(newFactoryWorkshops.response.status, 200);
        assert.deepEqual(newFactoryWorkshops.body, [], 'a new factory must start with its own empty hierarchy');

        const defaultConfig = await api('/api/config', { headers: inFactory('factory_default') });
        const newFactoryConfig = await api('/api/config', { headers: inFactory(factoryId) });
        assert.equal(defaultConfig.response.status, 200, defaultConfig.body.error);
        assert.equal(newFactoryConfig.response.status, 200, newFactoryConfig.body.error);
        assert.notEqual(defaultConfig.body.platform.activeProject.id, newFactoryConfig.body.platform.activeProject.id,
            'factory projects/scenes must be independent');
        assert.equal(newFactoryConfig.body.factoryId, factoryId);
        assert.deepEqual(newFactoryConfig.body.workshops, []);

        for (const [scopeId, name] of [['factory_default', '默认厂数据源'], [factoryId, '新厂数据源']]) {
            const source = await api('/api/data-sources/connections', {
                method: 'POST', headers: inFactory(scopeId),
                body: JSON.stringify({ id: 'same_connection_id', name, type: 'sqlite', filename: databaseFile, enabled: true })
            });
            assert.equal(source.response.status, 200, source.body.error);
        }
        const [defaultSources, isolatedSources] = await Promise.all([
            api('/api/data-sources', { headers: inFactory('factory_default') }),
            api('/api/data-sources', { headers: inFactory(factoryId) })
        ]);
        assert.equal(defaultSources.body.connections.find(item => item.id === 'same_connection_id')?.name, '默认厂数据源');
        assert.equal(isolatedSources.body.connections.find(item => item.id === 'same_connection_id')?.name, '新厂数据源',
            'data-source connection catalogs must be isolated, including identical local IDs');

        const addWorkshop = await api('/api/workshops', {
            method: 'POST', headers: inFactory(factoryId),
            body: JSON.stringify({ id: workshopId, name: '隔离测试车间', sort_order: 0 })
        });
        assert.equal(addWorkshop.response.status, 200, addWorkshop.body.error);

        const rejectForeignLine = await api('/api/lines', {
            method: 'POST', headers: inFactory(factoryId),
            body: JSON.stringify({ id: `${lineId}_foreign`, name: '跨厂产线', workshop_id: defaultWorkshops.body[0].id })
        });
        assert.equal(rejectForeignLine.response.status, 400, 'a factory must not attach a line to another factory workshop');

        const addLine = await api('/api/lines', {
            method: 'POST', headers: inFactory(factoryId),
            body: JSON.stringify({ id: lineId, name: '隔离测试产线', workshop_id: workshopId, sort_order: 0 })
        });
        assert.equal(addLine.response.status, 200, addLine.body.error);

        const addDevice = await api('/api/devices', {
            method: 'POST', headers: inFactory(factoryId),
            body: JSON.stringify({ id: deviceId, name: '隔离测试设备', line_id: lineId, model_type: 'builtin_furnace', plc_enabled: false })
        });
        assert.equal(addDevice.response.status, 200, addDevice.body.error);

        const addPoint = await api('/api/datapoints', {
            method: 'POST', headers: inFactory(factoryId),
            body: JSON.stringify({ device_id: deviceId, name: 'temperature', label: '测试温度', plc_tag: 'DB1.DBD0', data_type: 'REAL', access_type: 'READ' })
        });
        assert.equal(addPoint.response.status, 200, addPoint.body.error);

        const isolatedDevices = await api('/api/devices', { headers: inFactory(factoryId) });
        const defaultDevices = await api('/api/devices', { headers: inFactory('factory_default') });
        assert.ok(isolatedDevices.body.some(device => device.id === deviceId));
        assert.ok(!defaultDevices.body.some(device => device.id === deviceId));
        const isolatedPoints = await api('/api/datapoints', { headers: inFactory(factoryId) });
        const defaultPoints = await api('/api/datapoints', { headers: inFactory('factory_default') });
        assert.ok(isolatedPoints.body.some(point => point.device_id === deviceId));
        assert.ok(!defaultPoints.body.some(point => point.device_id === deviceId));

        const isolatedSettingsWrite = await api('/api/settings', {
            method: 'PUT', headers: inFactory(factoryId),
            body: JSON.stringify({ simulation_interval_ms: 3333 })
        });
        assert.equal(isolatedSettingsWrite.response.status, 200, isolatedSettingsWrite.body.error);
        const [isolatedSettings, defaultSettings] = await Promise.all([
            api('/api/settings', { headers: inFactory(factoryId) }),
            api('/api/settings', { headers: inFactory('factory_default') })
        ]);
        assert.equal(isolatedSettings.body.simulation_interval_ms, '3333');
        assert.notEqual(defaultSettings.body.simulation_interval_ms, '3333', 'factory settings must not bleed into the default factory');

        const addEvent = await api('/api/platform/events', {
            method: 'POST', headers: inFactory(factoryId),
            body: JSON.stringify({ title: '隔离测试事件', event_type: 'manual' })
        });
        assert.equal(addEvent.response.status, 200, addEvent.body.error);
        const [isolatedEvents, defaultEvents] = await Promise.all([
            api('/api/platform/events', { headers: inFactory(factoryId) }),
            api('/api/platform/events', { headers: inFactory('factory_default') })
        ]);
        assert.ok(isolatedEvents.body.some(event => event.title === '隔离测试事件'));
        assert.ok(!defaultEvents.body.some(event => event.title === '隔离测试事件'));

        const activation = await api(`/api/factories/${encodeURIComponent(factoryId)}/activate`, { method: 'POST', body: '{}' });
        assert.equal(activation.response.status, 200, activation.body.error);
        activated = true;
        const afterActivation = await api('/api/factories');
        assert.equal(afterActivation.body.activeFactoryId, factoryId);

        const foreignContext = await api('/api/workshops', { headers: inFactory('factory_does_not_exist') });
        assert.equal(foreignContext.response.status, 404, 'unknown factory scopes must fail closed');

        console.log(JSON.stringify({
            success: true,
            factoryId,
            checks: ['independent hierarchy', 'cross-factory relation rejection', 'device and point isolation', 'project/scene isolation', 'per-factory external data-source catalog', 'per-factory settings', 'event isolation', 'runtime activation', 'invalid-scope rejection']
        }, null, 2));
    } finally {
        if (activated || originalActiveFactoryId !== 'factory_default') {
            const restore = await api(`/api/factories/${encodeURIComponent(originalActiveFactoryId)}/activate`, { method: 'POST', body: '{}' });
            assert.equal(restore.response.status, 200, restore.body.error);
        }
    }
}

async function main() {
    const directory = createRunDirectory('factory-isolation');
    const dataDir = path.join(directory, 'data');
    const databaseFile = path.join(dataDir, 'factory.db');
    await createTestDatabase(databaseFile);
    fs.writeFileSync(path.join(dataDir, 'database-config.json'), JSON.stringify({ type: 'sqlite', filename: databaseFile }));
    const port = await findFreePort(3961);
    baseUrl = `http://127.0.0.1:${port}`;
    token = crypto.randomBytes(32).toString('hex');
    const env = {
        ...process.env,
        APP_DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
        LICENSE_ENFORCE: 'false',
        ADMIN_API_TOKEN: token,
        MCP_API_TOKEN: crypto.randomBytes(32).toString('hex'),
        DB_BACKUP_INTERVAL_MS: String(24 * 60 * 60 * 1000)
    };
    let backend;
    try {
        backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
            cwd: BACKEND_DIR, env, logFile: path.join(directory, 'backend.log')
        });
        await waitForHttp(`${baseUrl}/api/health`);
        await verifyIsolation(databaseFile);
    } finally {
        await forceStop(backend);
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
