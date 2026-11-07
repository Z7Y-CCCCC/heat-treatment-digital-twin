'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('data-center-browse');
const checks = [];
let closeDb, apiServer;
const pass = label => { checks.push(label); console.log('PASS ' + label); };
(async () => {
    const filename = await createTestDatabase(path.join(directory, 'factory.db'));
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: filename, DATA_SOURCE_BACKUP_DIR: path.join(directory, 'backups'), LICENSE_ENFORCE: 'false' });
    for (const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
    const database = require('../db/database'); closeDb = database.closeDb;
    const db = await database.getDb(), center = require('../services/dataCenter'), browse = require('../services/dataCenterBrowse');
    const factoryId = 'factory_default', workshop = await db.get('SELECT id,name FROM workshops WHERE factory_id=? LIMIT 1', [factoryId]);
    await db.run('INSERT INTO factories (id,name) VALUES (?,?)', ['browse_foreign', 'Foreign factory']);
    await db.run('INSERT INTO workshops (id,name,factory_id) VALUES (?,?,?)', ['browse_foreign_ws', 'Foreign workshop', 'browse_foreign']);
    await db.run('INSERT INTO `lines` (id,name,workshop_id) VALUES (?,?,?)', ['browse_foreign_line', 'Foreign line', 'browse_foreign_ws']);
    await db.run('INSERT INTO devices (id,name,line_id,instance_config) VALUES (?,?,?,?)', ['browse_foreign_device', 'Foreign device', 'browse_foreign_line', JSON.stringify({ workshop_id: workshop.id })]);
    const catalog = await center.buildCatalog(factoryId, '', null, '', { runtimePreview: false });
    const pointField = catalog.items.find(field => field.sourceType === 'plc' && field.type === 'number'), boolField = catalog.items.find(field => field.tableId === pointField.tableId && field.type === 'boolean');
    const first = await browse.browseTable(factoryId, 'internal_devices', { field_id: 'internal_device_name', page_size: '2' });
    assert.equal(first.fields.length, 5); assert.equal(first.records.length, 2); assert.equal(first.total, catalog.devices.length); assert.equal(first.page, 1); assert.equal(first.hasMore, true);
    assert.ok(first.records.every(record => record.value === catalog.devices.find(device => device.id === record.objectId)?.name && record.updatedAt === null && record.quality === 'good'));
    const second = await browse.browseTable(factoryId, 'internal_devices', { field_id: 'internal_device_name', page_size: '2', page: '2' });
    assert.ok(second.records.every(record => !first.records.some(previous => previous.id === record.id)));
    pass('device records are real per-object values, field filter retains all metadata, and pagination never repeats first sample');
    const searched = await browse.browseTable(factoryId, 'internal_devices', { field_id: 'internal_device_workshop', q: workshop.name });
    assert.ok(searched.total > 0); assert.ok(searched.records.every(record => record.objectPath.includes(workshop.name) || record.value.includes(workshop.name)));
    const specific = await browse.browseTable(factoryId, 'internal_devices', { device_id: catalog.devices[0].id });
    assert.equal(specific.total, 5); assert.ok(specific.records.every(record => record.objectId === catalog.devices[0].id));
    await assert.rejects(() => browse.browseTable('browse_foreign', pointField.tableId), error => error.status === 404);
    await assert.rejects(() => browse.browseTable(factoryId, 'internal_devices', { device_id: 'browse_foreign_device' }), error => error.status === 404);
    await assert.rejects(() => browse.browseTable(factoryId, 'internal_devices', { field_id: pointField.id }), error => error.status === 404);
    pass('search and specific object selection work; foreign line override cannot leak across factory or field/table boundaries');
    const initialSettings = JSON.stringify(await db.all('SELECT * FROM factory_settings ORDER BY factory_id,`key`'));
    const pointsBefore = JSON.stringify(await db.all('SELECT * FROM data_points ORDER BY id'));
    const absent = await browse.browseTable(factoryId, pointField.tableId);
    assert.ok(absent.records.every(record => record.value === null && record.quality !== 'good' && record.updatedAt === null));
    assert.equal(absent.capabilities.history, false);
    await assert.rejects(() => browse.browseTable(factoryId, pointField.tableId, { mode: 'history' }), /历史/);
    pass('absent runtime never uses saved samples; PLC history is not invented from aggregate metrics');
    const timestamp = Date.now(), calls = [];
    global.dataEngine = { getPointRuntimeValues: async (deviceId, points, requestedFactory) => {
        calls.push({ deviceId, requestedFactory });
        return { deviceStatus: { deviceId, quality: 'good', online: true, lastReadAt: timestamp }, snapshotTimestamp: timestamp,
            points: points.map(point => ({ id: point.id, device_id: deviceId, value: String(point.id) === pointField.binding.pointId ? 0 : false, quality: 'good', lastReadAt: timestamp })) };
    } };
    const live = await browse.browseTable(factoryId, pointField.tableId);
    assert.equal(live.records.find(record => record.fieldId === pointField.id).value, 0);
    assert.equal(live.records.find(record => record.fieldId === boolField.id).value, false);
    assert.ok(live.records.every(record => record.updatedAt === new Date(timestamp).toISOString() && record.quality === 'good'));
    assert.equal(calls.length, 1); assert.equal(calls[0].requestedFactory, factoryId);
    const matchActualZero = await browse.browseTable(factoryId, pointField.tableId, { field_id: pointField.id, q: '0' });
    assert.equal(matchActualZero.records.length, 1); assert.equal(matchActualZero.records[0].value, 0);
    const matchDisplayedFalse = await browse.browseTable(factoryId, pointField.tableId, { field_id: boolField.id, q: '否' });
    assert.equal(matchDisplayedFalse.records.length, 1); assert.equal(matchDisplayedFalse.records[0].value, false);
    const matchActualUnit = await browse.browseTable(factoryId, pointField.tableId, { field_id: pointField.id, q: pointField.unit });
    assert.equal(matchActualUnit.records.length, 1); assert.equal(matchActualUnit.records[0].value, 0); assert.equal(matchActualUnit.records[0].unit, pointField.unit);
    pass('fresh owned point frame retains numeric zero and boolean false with actual sample timestamp and value search');
    for (const [label, lastReadAt, quality] of [['missing sample timestamp', null, 'unknown'], ['old sample', timestamp - 3600000, 'stale'], ['future sample', timestamp + 60000, 'unknown'], ['invalid sample', 'not-a-time', 'unknown']]) {
        global.dataEngine.getPointRuntimeValues = async deviceId => ({ deviceStatus: { deviceId, quality: 'good' }, snapshotTimestamp: Date.now(), points: [{ id: pointField.binding.pointId, device_id: deviceId, value: 777, quality: 'good', lastReadAt }] });
        const response = await browse.browseTable(factoryId, pointField.tableId, { field_id: pointField.id });
        assert.equal(response.records[0].value, null, label); assert.equal(response.records[0].quality, quality, label);
    }
    pass('missing, invalid, future and old point sample times cannot be promoted by a fresh frame heartbeat');
    global.dataEngine.getPointRuntimeValues = async deviceId => ({ deviceStatus: { deviceId, quality: 'good' }, snapshotTimestamp: timestamp, points: [{ id: pointField.binding.pointId, device_id: 'browse_foreign_device', value: 999, quality: 'good', lastReadAt: timestamp }] });
    assert.equal((await browse.browseTable(factoryId, pointField.tableId, { field_id: pointField.id })).records[0].value, null);
    global.dataEngine.getPointRuntimeValues = async deviceId => ({ deviceStatus: { deviceId, quality: 'bad', online: false }, points: [{ id: pointField.binding.pointId, device_id: deviceId, value: 999, quality: 'good', lastReadAt: timestamp }] });
    const disconnected = await browse.browseTable(factoryId, pointField.tableId, { field_id: pointField.id });
    assert.equal(disconnected.records[0].value, null); assert.equal(disconnected.records[0].quality, 'bad');
    const status = await browse.browseTable(factoryId, 'internal_connection', { device_id: pointField.deviceId });
    assert.equal(status.records[0].value, '数据异常 / 未连接'); assert.equal(status.capabilities.searchSupportsValue, false);
    pass('foreign runtime frame and disconnected quality cannot expose apparently normal live values');
    delete global.dataEngine;
    const metadata = { inspection: { parts: [{ id: 'front_door', name: '前门', group: '机构', description: '模型说明', nodeNames: ['Door'] }, { id: 'fan', name: '风机', group: '机构', description: '风机说明', nodeNames: ['Fan'] }] } };
    await db.run('INSERT INTO models (id,name,file_path,factory_id,metadata) VALUES (?,?,?,?,?)', ['browse_parts_model', 'Browser part fixture', '/fixture.glb', factoryId, JSON.stringify(metadata)]);
    await db.run('UPDATE devices SET model_type=?,instance_config=? WHERE id=?', ['browse_parts_model', JSON.stringify({ inspection: { parts: [{ ...metadata.inspection.parts[0], description: '实例真实说明' }, metadata.inspection.parts[1]] } }), pointField.deviceId]);
    const parts = await browse.browseTable(factoryId, 'internal_parts', { device_id: pointField.deviceId, field_id: 'internal_part_description' });
    assert.equal(parts.total, 2); assert.equal(parts.records.find(record => record.objectName === '前门').value, '实例真实说明');
    assert.ok(parts.records.every(record => record.objectPath.includes(catalog.devices.find(device => device.id === pointField.deviceId).name)));
    pass('all authored parts are listed per device and instance overrides are real records');
    let requests = 0, shouldFail = false;
    const actualTime = new Date(timestamp - 3600000).toISOString(), oldTime = new Date(timestamp - 2 * 86400000).toISOString();
    apiServer = http.createServer((req,res) => {
        requests++;
        if (shouldFail) { res.writeHead(500); res.end('fixture-secret-token / private-source-path'); return; }
        const data = Array.from({ length: 130 }, (_, index) => ({ name: `对象 ${index + 1}`, count: index, flag: index % 2 === 0, recorded: index === 0 ? oldTime : actualTime, seconds: Math.floor((timestamp - 3600000) / 1000), updatedAt: index === 0 ? null : index === 1 ? 'not-a-time' : actualTime, update_time: oldTime }));
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ rows: data }));
    });
    await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
    const sources = require('../services/dataSources'), datasets = require('../services/dataSets');
    const connection = sources.saveDataSource({ name: 'Browse HTTP fixture', sourceType: 'http_api', baseUrl: `http://127.0.0.1:${apiServer.address().port}`, enabled: true, authType: 'bearer', token: 'fixture-secret-token', requestTimeoutMs: 1000 }, factoryId);
    const dataset = await datasets.saveDataSet({ name: '真实返回记录', source: 'http', connectionId: connection.id, rootPath: 'rows', request: { method: 'GET', path: '/private-source-path' }, columns: [
        { name: 'name', label: '对象名称', path: 'name', type: 'string', role: 'category' },
        { name: 'count', label: '当前数量', path: 'count', type: 'number', unit: '件' },
        { name: 'flag', label: '开关状态', path: 'flag', type: 'boolean' },
        { name: 'recorded', label: '采样时间', path: 'recorded', type: 'string', role: 'time' }
    ] }, factoryId);
    const tableId = center.stableId('dataset', dataset.id), fieldId = center.stableId('field', dataset.id, 'count');
    const source = await browse.browseTable(factoryId, tableId, { field_id: fieldId, page_size: '2' });
    assert.equal(source.total, 100); assert.equal(source.records.length, 2); assert.equal(source.fields.length, 4); assert.equal(source.records[0].value, 0); assert.equal(source.records[0].objectName, '对象 1');
    assert.equal(source.sourceRecordCount, 100); assert.equal(source.sourceLimit, 100); assert.equal(source.countScope, 'returned-records'); assert.match(source.notice, /不代表整个外部数据库/); assert.equal(source.capabilities.history, true);
    const source2 = await browse.browseTable(factoryId, tableId, { field_id: fieldId, page_size: '2', page: '2' });
    assert.deepEqual(source2.records.map(record => record.value), [2,3]); assert.equal(requests, 1, 'existing prepared source cache is reused');
    assert.equal(JSON.stringify(source).includes('fixture-secret-token'), false); assert.equal(JSON.stringify(source).includes('/private-source-path'), false);
    const beforeDenied = requests; let authorizedTable;
    await assert.rejects(() => browse.browseTable(factoryId, tableId, {}, { authorizeExternal: ({ table }) => {
        authorizedTable = table; throw Object.assign(new Error('fixture denied'), { statusCode: 403, code: 'ADMIN_PERMISSION_DENIED' });
    } }), error => error.statusCode === 403 && error.code === 'ADMIN_PERMISSION_DENIED');
    assert.equal(authorizedTable.sourceType, 'dataset'); assert.equal(requests, beforeDenied, 'external authorization happens before a source read');
    let internalAuthorizationCalls = 0;
    await browse.browseTable(factoryId, 'internal_devices', {}, { authorizeExternal: () => { internalAuthorizationCalls++; throw new Error('must not apply'); } });
    assert.equal(internalAuthorizationCalls, 0, 'external grant does not narrow internal data table grants');
    pass('prepared external table returns actual paginated records, truthful100-row window and no connection secrets or arbitrary source paths');
    const history = await browse.browseTable(factoryId, tableId, { mode: 'history', field_id: fieldId, start: new Date(timestamp - 86400000).toISOString(), end: new Date(timestamp).toISOString() });
    assert.equal(history.total, 99); assert.ok(history.records.every(record => record.updatedAt === actualTime));
    const filterValue = await browse.browseTable(factoryId, tableId, { field_id: fieldId, q: '23' });
    assert.equal(filterValue.records.find(record => record.objectName === '对象 24')?.value, 23);
    pass('history range filters actual source time-role records and value search uses returned actual data');
    const secondsDataset = await datasets.saveDataSet({ ...dataset, id: '', revision: '', name: 'Unix seconds records', columns: [{ name: 'seconds', label: 'Unix秒采样时间', path: 'seconds', type: 'number', role: 'time' }] }, factoryId);
    const seconds = await browse.browseTable(factoryId, center.stableId('dataset', secondsDataset.id));
    assert.equal(seconds.records[0].updatedAt, new Date(Math.floor((timestamp - 3600000) / 1000) * 1000).toISOString());
    pass('numeric Unix-second source timestamps normalize correctly rather than becoming1970 millisecond dates');
    const inferredDataset = await datasets.saveDataSet({ ...dataset, id: '', revision: '', name: 'MES legacy update records', columns: [
        { name: 'count', label: '已完成数量', path: 'count', type: 'number' },
        { name: 'updatedAt', label: '更新时间', path: 'updatedAt', type: 'string' }
    ] }, factoryId);
    const inferredTable = center.stableId('dataset', inferredDataset.id), inferredTimeField = center.stableId('field', inferredDataset.id, 'updatedAt');
    const inferred = await browse.browseTable(factoryId, inferredTable, { page_size: '10' });
    assert.equal(inferred.capabilities.history, false, 'an inferred update field is not an authored historical mapping');
    assert.equal(inferred.timeSource, 'source-update-field'); assert.equal(inferred.timeFieldId, inferredTimeField);
    assert.equal(inferred.fields.find(field => field.id === inferredTimeField).role, 'time');
    assert.equal(inferred.fields.find(field => field.id === inferredTimeField).timeInferred, true);
    assert.ok(inferred.records.filter(record => record.objectId === 'row_3').every(record => record.updatedAt === actualTime), 'all fields in the same source record have the same actual update time');
    assert.ok(inferred.records.filter(record => ['row_1', 'row_2'].includes(record.objectId)).every(record => record.updatedAt === null), 'missing and malformed source times remain missing');
    assert.equal(inferred.records.find(record => record.objectId === 'row_1' && record.fieldId === inferredTimeField).quality, 'empty');
    assert.equal(inferred.records.find(record => record.objectId === 'row_2' && record.fieldId === inferredTimeField).quality, 'bad');
    assert.ok(inferred.records.filter(record => record.fieldId === inferredTimeField).every(record => record.valueType === 'datetime'));
    assert.match(inferred.notice, /接口提供的记录更新时间/);
    await assert.rejects(() => browse.browseTable(factoryId, inferredTable, { mode: 'history' }), /历史/);
    const savedInferred = (await datasets.listDataSets(factoryId)).find(definition => definition.id === inferredDataset.id);
    assert.equal(savedInferred.columns.find(column => column.name === 'updatedAt').role, '', 'browsing does not rewrite the stored source definition');
    const priorityDataset = await datasets.saveDataSet({ ...inferredDataset, id: '', revision: '', name: 'Explicit sampled priority', columns: [
        ...inferredDataset.columns, { name: 'recorded', label: '采样时间', path: 'recorded', type: 'string', role: 'time' }
    ] }, factoryId);
    const priority = await browse.browseTable(factoryId, center.stableId('dataset', priorityDataset.id));
    assert.equal(priority.records[0].updatedAt, oldTime); assert.equal(priority.timeSource, 'configured-time-field'); assert.equal(priority.capabilities.history, true);
    const ambiguousDataset = await datasets.saveDataSet({ ...inferredDataset, id: '', revision: '', name: 'Ambiguous update columns', columns: [
        ...inferredDataset.columns, { name: 'update_time', label: '最后更新时间', path: 'update_time', type: 'string' }
    ] }, factoryId);
    const ambiguous = await browse.browseTable(factoryId, center.stableId('dataset', ambiguousDataset.id));
    assert.ok(ambiguous.records.every(record => record.updatedAt === null)); assert.equal(ambiguous.capabilities.history, false); assert.match(ambiguous.notice, /多个可能的更新时间/);
    pass('legacy MES update fields display actual row time without fake history; missing, invalid and ambiguous timestamps stay truthful and explicit roles win');
    const mappedDataset = await datasets.saveDataSet({ name: '设备映射数据', source: 'http', connectionId: connection.id, rootPath: 'rows', request: { method: 'GET', path: '/mapped', parameters: [{ name: 'device', source: 'context', key: 'deviceId', in: 'query' }] }, columns: [{ name: 'count', label: '数量', path: 'count', type: 'number' }] }, factoryId);
    const beforeMapped = requests;
    const mappedEmpty = await browse.browseTable(factoryId, center.stableId('dataset', mappedDataset.id));
    assert.equal(mappedEmpty.records.length, 0); assert.equal(mappedEmpty.capabilities.deviceRequired, true); assert.match(mappedEmpty.notice, /先选择设备/); assert.equal(requests, beforeMapped);
    const mapped = await browse.browseTable(factoryId, center.stableId('dataset', mappedDataset.id), { device_id: pointField.deviceId });
    assert.equal(mapped.records[0].objectId, pointField.deviceId);
    const partDataset = await datasets.saveDataSet({ name: '部件映射数据', source: 'http', connectionId: connection.id, rootPath: 'rows', request: { method: 'GET', path: '/part', parameters: [{ name: 'part', source: 'context', key: 'partId', in: 'query' }] }, columns: [{ name: 'count', label: '数量', path: 'count', type: 'number' }] }, factoryId);
    const partEmpty = await browse.browseTable(factoryId, center.stableId('dataset', partDataset.id), { device_id: pointField.deviceId });
    assert.equal(partEmpty.parts.length, 2); assert.equal(partEmpty.capabilities.partRequired, true); assert.equal(partEmpty.total, 0);
    const partRead = await browse.browseTable(factoryId, center.stableId('dataset', partDataset.id), { device_id: pointField.deviceId, part_id: 'front_door' });
    assert.equal(partRead.records[0].objectName, '前门');
    await assert.rejects(() => browse.browseTable(factoryId, center.stableId('dataset', partDataset.id), { device_id: pointField.deviceId, part_id: 'foreign_part' }), error => error.status === 404);
    pass('mapped external tables require explicit device/part context, list real available parts, and never guess another object');
    sources.saveDataSource({ ...connection, enabled: false }, factoryId);
    const beforeDisabled = requests;
    const disabled = await browse.browseTable(factoryId, tableId); assert.equal(disabled.total, 0); assert.match(disabled.notice, /停用/); assert.equal(requests, beforeDisabled);
    sources.saveDataSource({ ...connection, enabled: true }, factoryId);
    const errorDataset = await datasets.saveDataSet({ ...dataset, id: '', revision: '', name: 'Fault fixture', request: { method: 'GET', path: '/uncached-error' } }, factoryId);
    shouldFail = true;
    await assert.rejects(() => browse.browseTable(factoryId, center.stableId('dataset', errorDataset.id)), error => error.status === 502 && !error.message.includes('fixture-secret-token') && !error.message.includes('/private-source-path'));
    pass('disabled sources make no read request; external failure is sanitized and cannot publish credentials or raw response');
    for (const input of [{ page_size: '101' }, { page: '0' }, { q: ['bad'] }, { device_id: { id: 'bad' } }, { field_id: '__proto__' }, { q: 'x'.repeat(121) }, { mode: 'unknown' }, { sql: 'SELECT *' }, { mode: 'history', start: '2026-02-31T12:00:00Z', end: '2026-03-02T12:00:00Z' }, { mode: 'history', start: '2026-01-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }, { mode: 'history', start: '2026-11-01T12:00:00', end: '2026-11-01T13:00:00' }]) {
        if (input.field_id === '__proto__') await assert.rejects(() => browse.browseTable(factoryId, 'internal_devices', input), error => error.status === 404);
        else await assert.rejects(() => browse.browseTable(factoryId, 'internal_devices', input), error => error.status === 400);
    }
    assert.equal(JSON.stringify(await db.all('SELECT * FROM data_points ORDER BY id')), pointsBefore, 'browser did not mutate point definitions');
    const currentSettings = await db.all('SELECT * FROM factory_settings ORDER BY factory_id,`key`');
    const withoutDatasets = currentSettings.filter(row => row.key !== datasets.KEY);
    assert.equal(JSON.stringify(withoutDatasets), JSON.stringify(JSON.parse(initialSettings).filter(row => row.key !== datasets.KEY)), 'browser did not persist category changes or readings');
    pass('bounded query validation rejects malformed paging, arrays, unknown controls and impossible or excessive date ranges; browsing does not mutate bindings or point definitions');
    const result = { success: true, directory, checks, noPhysicalPLC: true, noUnity: true, fixtureDatabase: filename, fixtureOnlyHTTP: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    delete global.dataEngine;
    if (apiServer) await new Promise(resolve => apiServer.close(resolve));
    if (closeDb) await closeDb();
});
