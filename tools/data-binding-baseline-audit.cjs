// Diagnostic fixture: characterize capabilities, not tests that endorse limitations.
// Not part of CI: future implementations should turn the capability flags true.
// All data and settings remain in a unique output directory; only owned loopback HTTP.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..');
const { createRunDirectory } = require(path.join(root, 'backend/scripts/integration-test-utils.cjs'));
const directory = createRunDirectory('binding-gap-probe');
Object.assign(process.env, { APP_DATA_DIR: directory, DATA_SOURCE_BACKUP_DIR: path.join(directory, 'backups'), DB_TYPE: 'sqlite', SQLITE_FILE: path.join(directory, 'unused.db') });
const service = require(path.join(root, 'backend/services/dataSources'));
let server, requests = [];
(async () => {
    const payload = { data: { devices: [{ id: 'furnace-a', temperature: 700 }, { id: 'furnace-b', temperature: 850 }],
        orders: [{ department: 'A', quantity: 12 }, { department: 'B', quantity: 24 }] } };
    server = http.createServer((req, res) => { requests.push({ method: req.method, path: req.url }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    const config = { name: 'Owned ERP fixture', sourceType: 'http_api', connector: 'http', baseUrl, healthPath: '/health', authType: 'none', enabled: true, responseFormat: 'json', requestTimeoutMs: 2000, method: 'POST' };
    const test = await service.testDataSource(config, 'factory_default'); assert.equal(test.success, true);
    const saved = service.saveDataSource({ ...config, healthToken: test.healthToken }, 'factory_default');
    const binding = { mode: 'http_api', connectionId: saved.id, apiPath: '/devices', jsonPath: 'data.devices[0].temperature', refreshMs: 5000,
        contextKey: 'deviceId', contextField: 'id', params: { deviceId: { source: 'context', path: 'deviceId' } } };
    const a = (await service.readRuntimeBindings([{ id: 'temperature', data: binding }], { factoryId: 'factory_default', deviceId: 'furnace-a' })).temperature;
    const b = (await service.readRuntimeBindings([{ id: 'temperature', data: binding }], { factoryId: 'factory_default', deviceId: 'furnace-b' })).temperature;
    assert.ok(Number.isFinite(a.value) && Number.isFinite(b.value), 'Owned fixture must return numeric samples');
    requests = [];
    const rows = await service.readHttpApiBinding({ ...binding, jsonPath: 'data.orders' }, 'factory_default');
    assert.equal(rows.rows.length, 2, 'Owned raw rows must be retained');
    requests = [];
    await service.readRuntimeBindings([
        { id: 'a', data: { ...binding, apiPath: '/one-shared-response', jsonPath: 'data.devices[0].temperature' } },
        { id: 'b', data: { ...binding, apiPath: '/one-shared-response', jsonPath: 'data.devices[1].temperature' } }
    ], { factoryId: 'factory_default', deviceId: 'shared-response-probe' });
    assert.ok(requests.length > 0, 'Owned endpoint must be read');
    const result = { success: true, directory, capabilities: {
        dynamicHttpContext: a.value === 700 && b.value === 850,
        normalizesRawArrayIntoLabelValueSeries: rows.series.length === 2,
        sharedResponseReadOnce: requests.length === 1,
        configurableReadOnlyPost: requests.every(req => req.method === 'POST')
    }, observations: {
        contextNotAppliedToHttpSelection: { furnaceA: a.value, furnaceB: b.value, expectedBWithContextMapping: 850 },
        rawObjectArraysRetainedButNoExplicitMapping: { rawRows: rows.rows.length, normalizedSeries: rows.series.length, actualFields: Object.keys(rows.rows[0]) },
        sameEndpointDifferentFieldsReadsTwice: { requests: requests.length, methods: requests.map(req => req.method) },
        postIsNotAConfigurableReadMethod: { inputMethod: config.method, observedMethods: requests.map(req => req.method) }
    } };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
