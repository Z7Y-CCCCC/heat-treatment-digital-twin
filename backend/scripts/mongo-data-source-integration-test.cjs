'use strict';
// Real MongoDB + least-privilege login, not an HTTP/protocol mock. No field PLC.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { MongoClient, Long, Decimal128, Binary } = require('mongodb');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const { createMongoFixture } = require('./fixtures/mongo-fixture.cjs');
const directory = createRunDirectory('mongo-data-source'), checks = [];
const check = message => { checks.push(message); console.log('PASS ' + message); };
let fixture;
(async () => {
    const file = path.join(directory, 'app.db'); await createTestDatabase(file);
    Object.assign(process.env, { APP_DATA_DIR: directory, DB_TYPE: 'sqlite', SQLITE_FILE: file, DATA_SOURCE_BACKUP_DIR: path.join(directory, 'backups') });
    fixture = await createMongoFixture(directory);
    const sources = require('../services/dataSources'), sets = require('../services/dataSets');
    const collection = fixture.database.collection('设备参数');
    const docs = Array.from({ length: 120 }, (_, i) => ({ deviceId: `other_${i}`, telemetry: { temperature: i }, numericId: i }));
    docs.push({ deviceId: 'device_a', telemetry: { temperature: 0 }, enabled: false, singleBool: false, count: 0, when: new Date('2026-11-04T00:00:00Z'), longId: Long.fromString('9007199254740993'), decimal: Decimal128.fromString('123.456789123456789'), secretNote: 'must-not-leak', numericId: 137 });
    docs.push({ deviceId: 'device_b', telemetry: { temperature: 888.5 }, enabled: true, numericId: 138 });
    docs.push({ deviceId: '{"$ne":null}', telemetry: { temperature: 9 }, numericId: 139 });
    docs[0].nullableNumber = null; docs[1].nullableNumber = 12.5; docs[0].binaryPayload = new Binary(Buffer.from('owned-binary'));
    await collection.insertMany(docs);
    await fixture.database.collection('empty_collection').insertOne({ marker: true }); await fixture.database.collection('empty_collection').deleteMany({});
    await fixture.database.command({ profile: 2 });
    const tested = await sources.testDataSource(fixture.config);
    assert.equal(tested.success, true, JSON.stringify(tested));
    const saved = sources.saveDataSource({ ...fixture.config, healthToken: tested.healthToken }, 'factory_default');
    assert.equal(saved.password, '******'); assert.equal(saved.health.status, 'healthy'); assert.equal(saved.backupSupported, false);
    const tables = await sources.listTables(saved.id);
    assert.ok(tables.some(t => t.name === '设备参数' && t.type === 'COLLECTION'));
    assert.ok(!tables.some(t => t.name.startsWith('system.')));
    const fields = await sources.listColumns(saved.id, fixture.name, '设备参数');
    assert.ok(fields.some(f => f.path === 'telemetry.temperature' && f.dataType === 'double'));
    assert.ok(fields.some(f => f.path === 'nullableNumber' && f.dataType === 'double'));
    assert.ok(fields.some(f => f.path === 'binaryPayload' && f.dataType.includes('unsupported')));
    assert.deepEqual(await sources.listColumns(saved.id, fixture.name, 'empty_collection'), []);
    check('native authenticated test/save/masked credentials, collection and nested-field discovery, empty collection');
    const definition = { name: 'MongoDB device parameters', connectionId: saved.id, source: 'database', refreshMs: 1000,
        database: { schema: fixture.name, table: '设备参数', orderBy: 'numericId', orderDirection: 'desc' }, match: { field: 'deviceId', contextKey: 'deviceId' },
        columns: [{ name: 'value', path: 'telemetry.temperature', type: 'number' }, { name: 'enabled', path: 'enabled', type: 'boolean' }, { name: 'when', path: 'when', type: 'string' }, { name: 'longId', path: 'longId', type: 'string' }, { name: 'decimal', path: 'decimal', type: 'string' }] };
    const normalized = await sets.saveDataSet(definition, 'factory_default');
    const a = await sets.readDefinition(normalized, { deviceId: 'device_a' }, 'factory_default', true);
    assert.equal(a.quality, 'good'); assert.equal(a.rows[0].value, 0); assert.equal(a.rows[0].enabled, false);
    assert.equal(a.rows[0].when, '2026-11-04T00:00:00.000Z'); assert.equal(a.rows[0].longId, '9007199254740993'); assert.equal(a.rows[0].decimal, '123.456789123456789');
    const raw = await sources.readDataSetTable(normalized, { deviceId: 'device_a' }, 'factory_default');
    assert.equal(raw[0].secretNote, undefined); assert.equal(raw[0]._id, undefined);
    const parentAndChild = await sets.readDefinition({ ...normalized, columns: [...normalized.columns.slice(0, 1), { name: 'parent', path: 'telemetry', type: 'string' }] }, { deviceId: 'device_a' }, 'factory_default', true);
    assert.equal(parentAndChild.rows[0].value, 0); assert.equal(parentAndChild.rows[0].parent, '{"temperature":0}');
    const bDef = { ...normalized, columns: normalized.columns.slice(0, 1) };
    const b = await sets.readDefinition(bDef, { deviceId: 'device_b' }, 'factory_default', true);
    assert.equal(b.rows[0].value, 888.5);
    assert.equal((await sets.readDefinition(bDef, { deviceId: 'missing' }, 'factory_default', true)).quality, 'empty');
    assert.equal((await sets.readDefinition(bDef, { deviceId: '{"$ne":null}' }, 'factory_default', true)).rows[0].value, 9);
    const boolDef = { ...bDef, match: { field: 'singleBool', contextKey: 'parameter', parameterKey: 'flag', parameterType: 'boolean' } };
    assert.equal((await sets.readDefinition(boolDef, { parameters: { flag: false } }, 'factory_default', true)).rows[0].value, 0);
    const numberDef = { ...bDef, match: { field: 'numericId', contextKey: 'parameter', parameterKey: 'number', parameterType: 'number' } };
    assert.equal((await sets.readDefinition(numberDef, { parameters: { number: 137 } }, 'factory_default', true)).rows[0].value, 0);
    await collection.insertOne({ deviceId: 'device_a', telemetry: { temperature: 2 } });
    await assert.rejects(sets.readDefinition(bDef, { deviceId: 'device_a' }, 'factory_default', true), /多条/);
    await collection.deleteOne({ deviceId: 'device_a', 'telemetry.temperature': 2 });
    check('server-side device filtering beyond the first 100 documents, switching A/B, zero/false/date/Long/Decimal, projection, missing/duplicate records and typed global parameters');
    const direct = await sources.previewBinding({ connectionId: saved.id, schema: fixture.name, table: '设备参数', field: 'telemetry.temperature', valueMode: 'list', orderBy: 'numericId', orderDirection: 'desc', rowLimit: 20 });
    assert.equal(direct.rows[0].value, 9); assert.equal(direct.rows.length, 20);
    const count = await sources.previewBinding({ connectionId: saved.id, schema: fixture.name, table: '设备参数', valueMode: 'count' });
    assert.equal(count.value, docs.length);
    const maximum = await sources.previewBinding({ connectionId: saved.id, schema: fixture.name, table: '设备参数', field: 'telemetry.temperature', valueMode: 'max' });
    assert.equal(maximum.value, 888.5);
    await assert.rejects(sources.readDataSetTable({ ...normalized, database: { ...normalized.database, schema: 'admin' } }, { deviceId: 'device_a' }, 'factory_default'), /所选连接/);
    await assert.rejects(sources.readDataSetTable({ ...normalized, columns: [{ path: '$where' }] }, { deviceId: 'device_a' }, 'factory_default'), /不支持/);
    await assert.rejects(sources.readDataSetTable({ ...normalized, database: { ...normalized.database, table: 'system.users' } }, { deviceId: 'device_a' }, 'factory_default'), /系统集合/);
    await assert.rejects(sources.listTables(saved.id, 'another_factory'), /不存在/);
    await assert.rejects(sources.createConnectionBackup(saved.id), /不参与/);
    await assert.rejects(sources.executeReadOnlyQuery(saved.id, 'SELECT 1'), /MongoDB 不支持 SQL/);
    assert.ok(!sources.getBackupStatus().connections.some(c => c.id === saved.id));
    const reader = new MongoClient(fixture.uri, { auth: { username: fixture.username, password: fixture.password }, authSource: fixture.name, serverSelectionTimeoutMS: 2000 });
    try { await reader.connect(); await assert.rejects(reader.db(fixture.name).collection('设备参数').insertOne({ unauthorized: true }), error => error.code === 13); }
    finally { await reader.close(); }
    const wrong = await sources.testDataSource({ ...fixture.config, password: 'owned-wrong-password' });
    assert.equal(wrong.health.status, 'auth_failed'); assert.ok(!JSON.stringify(wrong).includes(fixture.password));
    sources.saveDataSource({ ...saved, name: 'Renamed MongoDB' });
    assert.equal((await sources.testDataSource({ id: saved.id })).success, true);
    const priorSql = sources.saveDataSource({ name: 'Old SQL credentials', type: 'mysql', user: 'do_not_carry', password: 'owned-previous-secret', database: 'prior' });
    const switched = sources.saveDataSource({ id: priorSql.id, type: 'mongodb', database: fixture.name, defaultSchema: fixture.name, trustServerCertificate: false });
    assert.equal(switched.user, ''); assert.equal(switched.password, '', 'changing driver must not forward SQL credentials to MongoDB');
    const tls = await sources.testDataSource({ ...fixture.config, encrypt: true, queryTimeoutMs: 1000 });
    assert.equal(tls.success, false, 'TLS must not silently downgrade to the plaintext fixture');
    check('native list/count/max, factory/database isolation, rejected operators/system collections, actual read-only database role, credential retention and backup exclusion');
    const profile = await fixture.database.collection('system.profile').find({ appName: 'HeatTreatmentReadOnly' }).toArray();
    assert.ok(profile.some(row => row.command?.find === '设备参数'));
    assert.ok(profile.every(row => !['insert', 'update', 'delete', 'drop', 'create', 'createUser', 'findAndModify'].some(key => Object.hasOwn(row.command || {}, key))));
    assert.ok(profile.every(row => !(row.command?.pipeline || []).some(stage => ['$out', '$merge', '$function'].some(key => Object.hasOwn(stage, key)))));
    check('actual MongoDB profiler confirms adapter issues only bounded read commands, not writes or user-supplied pipelines');
    const net = require('node:net'), sockets = new Set();
    const blackhole = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => blackhole.listen(0, '127.0.0.1', resolve));
    try {
        const start = Date.now();
        assert.equal((await sources.testDataSource({ ...fixture.config, port: blackhole.address().port, queryTimeoutMs: 1000 })).success, false);
        assert.ok(Date.now() - start < 5000);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => blackhole.close(resolve)); }
    check('TLS is never downgraded, driver changes clear foreign credentials and an unresponsive MongoDB handshake is bounded');
    if (!fixture.external) {
        await fixture.stopDatabase(); const started = Date.now();
        const down = await sources.testDataSource({ ...fixture.config, queryTimeoutMs: 1000 });
        assert.equal(down.success, false); assert.ok(Date.now() - started < 5000);
        await fixture.restart(); assert.equal((await sources.testDataSource(fixture.config)).success, true);
        check('owned database exit produces a bounded failure and recovers after restart without restarting the application');
    }
    const result = { success: true, serverVersion: (await fixture.database.admin().serverInfo()).version, checks, directory, noPlcOrSiteProfile: true };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: error.stack, checks }, null, 2)); process.exitCode = 1; })
.finally(async () => { await require('../db/database').closeDb(); await fixture?.close(); });
