// A private bundled MySQL instance, never the commissioned server/schema.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('../backend/node_modules/mysql2/promise');
const { MysqlRuntime } = require('../desktop/mysqlRuntime.cjs');
const { createSmokeProgramData } = require('../desktop/scripts/smoke-sandbox.cjs');
const { createRunDirectory, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { loadDeviceInspection, publicInspection, patchDeviceInspectionLayout, saveDeviceInspectionLayout } = require('../backend/services/deviceInspection');
const { presetMetadata } = require('../backend/services/inspectionPresets');
const { loadModelInspection, patchModelInspectionLayout, saveModelInspectionLayout } = require('../backend/services/modelInspection');
const root = path.resolve(__dirname, '..');
let runtime, connection;
(async () => {
    const directory = process.env.MANUAL_LAYOUT_MYSQL_FIXTURE
        ? requireTestPath(process.env.MANUAL_LAYOUT_MYSQL_FIXTURE) : createRunDirectory('manual-disassembly-mysql');
    assert.match(path.basename(directory), /^manual-disassembly-mysql-/);
    Object.assign(process.env, createSmokeProgramData(directory));
    runtime = new MysqlRuntime({ root: directory, runtimeDir: path.join(root, 'desktop/resources/mysql'),
        nodeBinary: process.execPath, hostScript: path.join(root, 'backend/services/privateMysqlHost.js'),
        dependenciesDir: path.join(root, 'backend/node_modules'), templateFile: path.join(root, 'desktop/resources/templates/factory-template.db') });
    await runtime.start();
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'data/database-config.json'), 'utf8'));
    connection = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    const tx = {
        async all(sql, params = []) { return (await connection.execute(sql, params))[0]; },
        async get(sql, params = []) { return (await this.all(sql, params))[0]; },
        async run(sql, params = []) { return (await connection.execute(sql, params))[0]; }
    };
    const comparisons = await tx.get(`SELECT
        JSON_EXTRACT('{"value":"ABC"}', '$') = JSON_EXTRACT('{"value":"abc"}', '$') AS folded,
        JSON_EXTRACT('{"value":1.0}', '$') = JSON_EXTRACT('{"value":1}', '$') AS numericEqual,
        JSON_EXTRACT('{"value":[1,2]}', '$') = JSON_EXTRACT('{"value":[2,1]}', '$') AS reordered`);
    assert.equal(comparisons.folded, 0); assert.equal(comparisons.numericEqual, 1); assert.equal(comparisons.reordered, 0);
    const device = await tx.get('SELECT * FROM devices ORDER BY id LIMIT 1');
    const factory = await tx.get('SELECT w.factory_id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=?', [device.line_id]);
    await tx.run(`INSERT INTO models (id,name,file_path,asset_type,placement_level,metadata)
        VALUES ('photo_multipurpose_furnace_v6','JSON layout regression','/assets/models/photo_multipurpose_furnace_v6_pipefix.glb','model','device',?)
        ON DUPLICATE KEY UPDATE metadata=VALUES(metadata)`, [JSON.stringify(presetMetadata('photo_multipurpose_furnace_v6'))]);
    await tx.run("UPDATE devices SET model_type='photo_multipurpose_furnace_v6',model_file=NULL,instance_config=? WHERE id=?", ['{"marker":{"Case":"ABC","decimal":1.0}}', device.id]);
    let loaded = await loadDeviceInspection(tx, await tx.get('SELECT * FROM devices WHERE id=?', [device.id]), factory.factory_id);
    const target = loaded.inspection.parts[0].id;
    for (const offset of [[-5.2526, 2.6074, -8.9538], [2.5, -1, 3], [2.5, -1, 3]]) {
        const current = await tx.get('SELECT * FROM devices WHERE id=?', [device.id]);
        const next = patchDeviceInspectionLayout(loaded, { revision: loaded.revision, parts: [{ id: target, explode_offset: offset }] });
        await connection.beginTransaction();
        try {
            const saved = await saveDeviceInspectionLayout(tx, current, loaded, next, factory.factory_id, 'mysql');
            await connection.commit();
            loaded = await loadDeviceInspection(tx, await tx.get('SELECT * FROM devices WHERE id=?', [device.id]), factory.factory_id);
            assert.equal(saved.revision, loaded.revision, 'save response revision must equal a fresh MySQL JSON read');
            assert.deepEqual(loaded.inspection.parts[0].explode_offset, offset);
        } catch (error) { await connection.rollback(); throw error; }
    }
    const stale = loaded;
    const current = await tx.get('SELECT * FROM devices WHERE id=?', [device.id]);
    const changed = typeof current.instance_config === 'string' ? JSON.parse(current.instance_config) : current.instance_config;
    changed.marker.Case = 'abc';
    await tx.run('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(changed), device.id]);
    loaded = await loadDeviceInspection(tx, await tx.get('SELECT * FROM devices WHERE id=?', [device.id]), factory.factory_id);
    assert.notEqual(stale.revision, loaded.revision, 'case-only JSON edits still invalidate revisions');
    assert.throws(() => patchDeviceInspectionLayout(loaded, { revision: stale.revision, parts: [] }), error => error.code === 'DEVICE_INSPECTION_CONFLICT');
    for (const value of ['null', null]) {
        await tx.run('UPDATE devices SET instance_config=? WHERE id=?', [value, device.id]);
        const row = await tx.get('SELECT * FROM devices WHERE id=?', [device.id]);
        loaded = await loadDeviceInspection(tx, row, factory.factory_id);
        const next = patchDeviceInspectionLayout(loaded, { revision: loaded.revision, parts: [] });
        const saved = await saveDeviceInspectionLayout(tx, row, loaded, next, factory.factory_id, 'mysql');
        assert.equal(saved.revision, (await loadDeviceInspection(tx, await tx.get('SELECT * FROM devices WHERE id=?', [device.id]), factory.factory_id)).revision);
    }
    const devicesBefore = await tx.all('SELECT * FROM devices ORDER BY id');
    let modelLayout = await loadModelInspection(tx, 'photo_multipurpose_furnace_v6', factory.factory_id);
    for (const offset of [[5, 6, 7], [8, 9, 10], [8, 9, 10]]) {
        const next = patchModelInspectionLayout(modelLayout, { revision: modelLayout.revision, parts: [{ id: target, explode_offset: offset }] });
        const saved = await saveModelInspectionLayout(tx, modelLayout, next, factory.factory_id, 'mysql');
        modelLayout = await loadModelInspection(tx, modelLayout.modelId, factory.factory_id);
        assert.equal(saved.revision, modelLayout.revision);
        assert.deepEqual(modelLayout.inspection.parts[0].explode_offset, offset);
    }
    assert.deepEqual(await tx.all('SELECT * FROM devices ORDER BY id'), devicesBefore);
    const result = { success: true, modelDefaultSaveReload: true, modelSavePreservesAllDeviceRows: true,
        repeatedSaveAndReload: true, unchangedSave: true, caseSensitiveConflict: true,
        jsonNullAndSqlNull: true, nativeJsonComparisons: comparisons, parts: publicInspection(loaded).inspection.parts.length, directory };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await connection?.end(); await runtime?.stop();
});
