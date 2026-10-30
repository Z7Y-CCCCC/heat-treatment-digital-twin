// Read-only verification against the explicit additive import receipt.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../db/database');
const { getPitFurnaceModels } = require('../services/pitFurnaceModels');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function metadataEqual(actual, expected, at = 'metadata') {
    // MySQL binary JSON can reserialize IEEE-754 values with a different last digit.
    if (typeof expected === 'number') {
        assert.equal(typeof actual, 'number', at);
        assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), at);
    } else if (expected && typeof expected === 'object') {
        assert.equal(Array.isArray(actual), Array.isArray(expected), at);
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), at);
        for (const key of Object.keys(expected)) metadataEqual(actual[key], expected[key], `${at}.${key}`);
    } else assert.equal(actual, expected, at);
}

(async () => {
    const receipt = read(path.join(root, 'output/pit-furnace-system-import-result.json'));
    const migrationFile = path.join(root, 'output/pit-furnace-factory-migration-result.json');
    const migration = fs.existsSync(migrationFile) ? read(migrationFile) : null;
    if (migration) { receipt.factoryId = migration.factoryId; receipt.workshopId = migration.workshopId; }
    const before = read(receipt.backup);
    const config = loadDatabaseConfig();
    for (const key of ['type', 'host', 'port', 'database']) assert.equal(config[key], receipt.target[key], `Database target mismatch: ${key}`);
    const db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    const checks = [];
    try {
        await db.query('START TRANSACTION READ ONLY');
        const after = {};
        for (const table of ['lines', 'devices', 'models']) {
            [after[table]] = await db.query(`SELECT * FROM \`${table}\` ORDER BY id`);
            for (const row of before[table]) assert.equal(stable(after[table].find(item => item.id === row.id)), stable(row), `Original ${table} record changed: ${row.id}`);
            checks.push(`${before[table].length} original ${table} records unchanged`);
        }
        const line = after.lines.find(item => item.id === receipt.lineId);
        assert.equal(line.name, '井式炉');
        assert.equal(line.workshop_id, receipt.workshopId);
        const layout = parse(line.layout_json);
        assert.equal(layout.coordinateSpace, 'workshop_local');
        assert.equal(layout.transform.z, migration ? migration.lineTransformZ : 30);
        checks.push('independent pit furnace line in selected workshop');
        if (migration) {
            const [ownership] = await db.query('SELECT w.factory_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=?', [receipt.lineId]);
            assert.equal(ownership[0].factory_id, migration.factoryId);
            const [originalLine] = await db.query('SELECT l.id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=? AND w.factory_id=?', [receipt.lineId, migration.sourceFactoryId]);
            assert.equal(originalLine.length, 0);
            const [projects] = await db.query('SELECT id FROM projects WHERE id=? AND factory_id=?', [migration.projectId, migration.factoryId]);
            assert.equal(projects.length, 1);
            checks.push('pit line belongs to a new independent factory/project, absent from Tianjin factory');
        }
        // Run the actual configuration route with a SELECT-only adapter. This does
        // not initialize the app/database or start any collector/PLC connection.
        const databaseModule = require('../db/database');
        const originalGetDb = databaseModule.getDb;
        const select = async (sql, values = []) => {
            assert.match(sql.trim(), /^SELECT\b/i, 'Configuration verification must stay read-only');
            return (await db.query(sql, values))[0];
        };
        try {
            databaseModule.getDb = async () => ({
                all: select,
                get: async (sql, values) => (await select(sql, values))[0],
                run: async () => { throw new Error('Unexpected write during read-only configuration verification'); }
            });
            const router = require('../routes/config');
            const handler = router.stack.find(layer => layer.route?.path === '/').route.stack[0].handle;
            let payload, status = 200;
            const response = { status: code => { status = code; return response; }, json: value => { payload = value; } };
            await handler({ factoryId: receipt.factoryId }, response);
            assert.equal(status, 200, payload?.error);
            const configured = payload.workshops.find(item => item.id === receipt.workshopId).lines.find(item => item.id === receipt.lineId);
            assert.equal(configured.layout.placementPending, false);
            assert.deepEqual(configured.devices.map(item => item.id), receipt.deviceIds);
            for (const id of receipt.modelIds) assert.ok(payload.models.some(item => item.id === id));
            checks.push('existing configuration route exposes placed line, all five devices and all five models');
        } finally { databaseModule.getDb = originalGetDb; }
        const expectedModels = getPitFurnaceModels();
        for (let i = 0; i < 5; i++) {
            const expected = expectedModels[i];
            const device = after.devices.find(item => item.id === receipt.deviceIds[i]);
            const model = after.models.find(item => item.id === expected.id);
            assert.equal(device.line_id, receipt.lineId);
            assert.equal(device.model_type, model.id);
            assert.equal(device.model_file, model.file_path);
            assert.equal(device.coordinate_space, 'line_local');
            assert.equal(device.plc_enabled, 0);
            assert.equal(parse(device.instance_config).integration_source, 'pit_furnace_line_v1');
            metadataEqual(parse(model.metadata), parse(expected.metadata));
            assert.equal(parse(model.metadata).inspection.enabled, true);
            assert.equal(model.factory_id, receipt.factoryId);
            checks.push(`${device.id}: correct model, assembly inspection, no PLC enablement`);
        }
        for (const file of receipt.copied) assert.equal(hash(file.path), file.sha256, `Deployed file changed: ${file.path}`);
        checks.push(`${receipt.copied.length} workspace/installed upload files match SHA256`);
        const manifest = receipt.modelIds.map(id => {
            const model = after.models.find(item => item.id === id);
            const deployed = receipt.copied.filter(file => path.basename(file.path) === `${id}-system.glb`).at(-1);
            assert.ok(deployed, `Missing deployed model: ${id}`);
            return { ...model, file_path: deployed.path };
        });
        fs.writeFileSync(path.join(root, 'output/pit-furnace-native-manifest.json'), JSON.stringify(manifest, null, 2));
        for (const file of read(path.join(root, 'output/pit-furnace-original-hashes.json'))) assert.equal(hash(file.Path).toUpperCase(), file.Hash.toUpperCase());
        checks.push('original Unity Factory scene, graphics settings and furnace model unchanged');
        const report = { status: 'passed', checkedAt: new Date().toISOString(), lineId: receipt.lineId, checks, existingEquipmentModified: false, plcEnabled: false, cadComponentCompletenessVerified: false };
        fs.writeFileSync(path.join(root, 'output/pit-furnace-system-verification.json'), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
    } finally { await db.end(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
