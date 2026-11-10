// Real isolated SQLite bootstraps: authored local coordinates are not a
// migration input, including when unrelated legacy objects still need repair.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, requireTestPath } = require('./integration-test-utils.cjs');

async function bootstrap(filename) {
    await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, '--bootstrap-isolated', filename], {
            cwd: BACKEND_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', bytes => { output += bytes; });
        child.stderr.on('data', bytes => { output += bytes; });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error('Isolated bootstrap failed: ' + output)));
    });
}

function snapshot(db) {
    return {
        workshops: db.prepare('SELECT * FROM workshops ORDER BY id').all(),
        lines: db.prepare('SELECT * FROM `lines` ORDER BY id').all(),
        devices: db.prepare('SELECT * FROM devices ORDER BY id').all(),
        environment: db.prepare("SELECT value FROM settings WHERE key='native_environment_config'").get().value,
        settingKeys: db.prepare('SELECT key FROM settings ORDER BY key').all().map(row => row.key)
    };
}

function auditWrites(db) {
    db.exec(`CREATE TABLE spatial_bootstrap_writes (table_name TEXT, object_id TEXT);
        CREATE TRIGGER spatial_workshop_write BEFORE UPDATE OF layout_json ON workshops
            BEGIN INSERT INTO spatial_bootstrap_writes VALUES ('workshops', OLD.id); END;
        CREATE TRIGGER spatial_line_write BEFORE UPDATE OF layout_json ON lines
            BEGIN INSERT INTO spatial_bootstrap_writes VALUES ('lines', OLD.id); END;
        CREATE TRIGGER spatial_device_write BEFORE UPDATE OF line_id,pos_x,pos_y,pos_z,rotation_y,coordinate_space,instance_config ON devices
            BEGIN INSERT INTO spatial_bootstrap_writes VALUES ('devices', OLD.id); END;
        CREATE TRIGGER spatial_environment_write BEFORE UPDATE OF value ON settings
            WHEN OLD.key='native_environment_config'
            BEGIN INSERT INTO spatial_bootstrap_writes VALUES ('settings', OLD.key); END;`);
}

async function run() {
    const directory = createRunDirectory('spatial-bootstrap-idempotency');
    const filename = path.join(directory, 'factory.db');
    await createTestDatabase(filename);
    let db = new Database(filename);
    const workshop = db.prepare('SELECT * FROM workshops ORDER BY id LIMIT 1').get();
    const line = db.prepare('SELECT * FROM `lines` WHERE workshop_id=? ORDER BY id LIMIT 1').get(workshop.id);
    const workshopLayout = { ...JSON.parse(workshop.layout_json), transform: { x: 13.234567890123, y: .823456789012, z: -31.456789012345, rotationY: 27.123456789012 },
        authorExtension: { revision: 'keep exact workshop JSON', anchors: [.12345678901234] } };
    const lineLayout = { ...JSON.parse(line.layout_json), transform: { x: -3.234567890123, y: .234567890123, z: 9.456789012345, rotationY: -16.456789012345, authorBasis: 'keep' },
        authorExtension: { revision: 'keep exact line JSON' } };
    lineLayout.lanes[0].authorLaneExtension = { calibration: .91234567890123 };
    db.prepare('UPDATE workshops SET layout_json=? WHERE id=?').run(JSON.stringify(workshopLayout, null, 2) + '\n', workshop.id);
    db.prepare('UPDATE `lines` SET layout_json=? WHERE id=?').run(JSON.stringify(lineLayout, null, 3) + '\n', line.id);
    const selected = db.prepare('SELECT id FROM devices WHERE line_id=? ORDER BY id LIMIT 4').all(line.id);
    const rotations = [-3.141593, 3.141593, 2.345678901234, 47.123456789012];
    for (let index = 0; index < selected.length; index++) {
        db.prepare('UPDATE devices SET pos_x=?,pos_y=?,pos_z=?,rotation_y=?,instance_config=? WHERE id=?').run(
            .123456789012345 + index, .987654321098765, -8.123456789012345, rotations[index],
            '{\n "zAuthorFirst": [3,2,1], "laneLineId": ' + JSON.stringify(line.id) + ', "authorNumber": 0.123456789012345\n}\n', selected[index].id);
    }
    const instance = '{\n "railLineId": ' + JSON.stringify(line.id) + ', "workshop_id": ' + JSON.stringify(workshop.id) + ', "authorSequence": [2,1]\n}\n';
    db.prepare(`INSERT INTO devices (id,name,line_id,model_type,instance_config,pos_x,pos_y,pos_z,rotation_y,coordinate_space)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run('calibrated_workshop_cart', 'Calibrated workshop cart', null, 'transfer_cart', instance,
            1.123456789012, 2.123456789012, 3.123456789012, -3.141593, 'workshop_local');
    db.prepare(`INSERT INTO devices (id,name,line_id,model_type,instance_config,pos_x,pos_y,pos_z,rotation_y,coordinate_space)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run('calibrated_line_cart', 'Calibrated no-primary line cart', null, 'transfer_cart', instance,
            4.123456789012, 5.123456789012, 6.123456789012, 3.141593, 'line_local');
    db.prepare(`INSERT INTO devices (id,name,line_id,model_type,instance_config,pos_x,pos_y,pos_z,rotation_y,coordinate_space)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run('calibrated_primary_workshop_device', 'Calibrated primary-linked workshop device', line.id, 'builtin_furnace', instance,
            7.123456789012, 8.123456789012, 9.123456789012, 2.345678901234, 'workshop_local');
    const calibratedWall = { id: 'calibrated_wall', workshopId: workshop.id, coordinateSpace: 'workshop_local',
        x: 4.123456789012, baseY: .423456789012, z: 5.123456789012, rotationY: 57.123456789012, authorExtension: { ordered: ['B', 'A'] } };
    db.prepare("UPDATE settings SET value=? WHERE key='native_environment_config'").run(JSON.stringify({ version: 3, authorExtension: 'preserve', walls: [calibratedWall] }, null, 2) + '\n');
    auditWrites(db);
    const authored = snapshot(db);
    db.close();
    const checks = [];
    for (let pass = 1; pass <= 2; pass++) {
        await bootstrap(filename);
        db = new Database(filename);
        assert.deepEqual(snapshot(db), authored, 'Already calibrated objects must remain exact through bootstrap ' + pass);
        assert.deepEqual(db.prepare('SELECT * FROM spatial_bootstrap_writes').all(), [], 'Complete local/v2 engineering must execute no spatial migration writes');
        db.close();
        checks.push('complete calibrated bootstrap ' + pass + ' preserves raw values/JSON and executes no spatial UPDATE');
    }

    db = new Database(filename);
    db.prepare(`INSERT INTO workshops (id,factory_id,name,layout_json) VALUES (?,?,?,?)`).run('legacy_workshop', workshop.factory_id, 'Legacy workshop', '{}');
    db.prepare(`INSERT INTO lines (id,workshop_id,name,layout_json) VALUES (?,?,?,?)`).run('legacy_line', 'legacy_workshop', 'Legacy line',
        JSON.stringify({ version: 1, authorExtension: 'retain legacy extension', lanes: [{ id: 'legacy_lane', offsetZ: 0, length: 60 }], rails: [] }));
    const localLineInLegacyWorkshop = { version: 2, coordinateSpace: 'workshop_local',
        transform: { x: 7.123456789012, y: .723456789012, z: -4.234567890123, rotationY: 44.987654321012, authorBasis: 'retain' },
        lanes: [{ id: 'v2_lane', offsetZ: 1.23, length: 60, authorItem: 'retain' }], rails: [], authorExtension: 'retain v2 line extension' };
    db.prepare(`INSERT INTO lines (id,workshop_id,name,layout_json) VALUES (?,?,?,?)`).run('v2_line_in_legacy_workshop', 'legacy_workshop', 'Existing local line in a legacy workshop',
        JSON.stringify(localLineInLegacyWorkshop, null, 2));
    const insert = db.prepare(`INSERT INTO devices (id,name,line_id,model_type,instance_config,pos_x,pos_y,pos_z,rotation_y,coordinate_space)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const oldWorld = { x: 12.345678, y: 1.234567, z: -15.456789 };
    insert.run('legacy_device', 'Legacy device', line.id, 'builtin_furnace', '{}', oldWorld.x, oldWorld.y, oldWorld.z, 1.5708, 'legacy_world');
    insert.run('legacy_rail_cart', 'Legacy rail cart', null, 'transfer_cart', JSON.stringify({ railLineId: line.id, workshop_id: workshop.id }),
        -22.5, .5, 7.25, 0, 'legacy_world');
    insert.run('legacy_other_workshop', 'Legacy other workshop', 'legacy_line', 'builtin_furnace', '{}', 38, 0, 27, 0, 'legacy_world');
    insert.run('calibrated_device_in_legacy_workshop', 'Existing calibrated local device', 'v2_line_in_legacy_workshop', 'builtin_furnace', '{\n "author": [3,1,2]\n}',
        8.123456789012, .812345678901, -6.234567890123, -3.141593, 'line_local');
    const localDeviceInLegacyWorkshop = db.prepare("SELECT * FROM devices WHERE id='calibrated_device_in_legacy_workshop'").get();
    const oldWall = { id: 'legacy_wall', workshopId: workshop.id, x: 10, baseY: 1, z: 20, rotationY: 30, authorExtension: 'retain wall extension' };
    db.prepare("UPDATE settings SET value=? WHERE key='native_environment_config'").run(JSON.stringify({ version: 3, authorExtension: 'preserve', walls: [calibratedWall, oldWall] }, null, 2));
    db.exec('DELETE FROM spatial_bootstrap_writes');
    db.close();
    await bootstrap(filename);
    db = new Database(filename);
    const mixed = snapshot(db);
    for (const table of ['workshops', 'lines', 'devices']) {
        for (const row of authored[table]) assert.deepEqual(mixed[table].find(item => item.id === row.id), row,
            'Unrelated legacy repair must not rewrite a calibrated ' + table + ' row ' + row.id);
    }
    assert.deepEqual(mixed.settingKeys, authored.settingKeys, 'Migration must not add a settings marker');
    assert.deepEqual(JSON.parse(mixed.environment).walls[0], calibratedWall, 'Already local walls must not be rounded or reinterpreted');
    const writes = db.prepare('SELECT * FROM spatial_bootstrap_writes').all();
    const allowed = new Set(['workshops:legacy_workshop', 'lines:legacy_line', 'lines:v2_line_in_legacy_workshop', 'devices:legacy_device', 'devices:legacy_rail_cart',
        'devices:legacy_other_workshop', 'settings:native_environment_config']);
    assert.ok(writes.length > 0);
    for (const row of writes) assert.ok(allowed.has(row.table_name + ':' + row.object_id), 'Calibrated object was UPDATEd: ' + JSON.stringify(row));
    checks.push('mixed legacy repair updates only pending spatial objects and never adds a marker');

    const { normalizeWorkshopLayout, normalizeLineLayout, composeSpatialTransforms, localToParentPoint } = require('../utils/spatialLayout');
    const parent = composeSpatialTransforms(normalizeWorkshopLayout(authored.workshops.find(row => row.id === workshop.id).layout_json).transform,
        normalizeLineLayout(authored.lines.find(row => row.id === line.id).layout_json).transform);
    const closePoint = (actual, expected, name) => {
        for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(actual[axis] - expected[axis]) < .000002, name + ' world ' + axis + ' changed');
    };
    const rebasedLine = mixed.lines.find(row => row.id === 'v2_line_in_legacy_workshop');
    const rebasedLayout = JSON.parse(rebasedLine.layout_json);
    assert.equal(rebasedLayout.authorExtension, localLineInLegacyWorkshop.authorExtension);
    assert.equal(rebasedLayout.transform.authorBasis, localLineInLegacyWorkshop.transform.authorBasis);
    assert.equal(rebasedLayout.lanes[0].authorItem, localLineInLegacyWorkshop.lanes[0].authorItem);
    assert.equal(JSON.parse(mixed.lines.find(row => row.id === 'legacy_line').layout_json).authorExtension, 'retain legacy extension');
    const retainedDevice = mixed.devices.find(row => row.id === localDeviceInLegacyWorkshop.id);
    assert.deepEqual(retainedDevice, localDeviceInLegacyWorkshop, 'Parent workshop migration must not rewrite a calibrated line-local device');
    const rebasedParent = composeSpatialTransforms(normalizeWorkshopLayout(mixed.workshops.find(row => row.id === 'legacy_workshop').layout_json).transform,
        normalizeLineLayout(rebasedLayout).transform);
    const retainedPoint = { x: retainedDevice.pos_x, y: retainedDevice.pos_y, z: retainedDevice.pos_z };
    closePoint(localToParentPoint(retainedPoint, rebasedParent), localToParentPoint(retainedPoint, normalizeLineLayout(localLineInLegacyWorkshop).transform), 'Rebased v2 line device');
    checks.push('a v2 line rebases into a legacy workshop without moving or rewriting its calibrated device or losing extensions');
    const migrated = mixed.devices.find(row => row.id === 'legacy_device');
    assert.equal(migrated.coordinate_space, 'line_local');
    closePoint(localToParentPoint({ x: migrated.pos_x, y: migrated.pos_y, z: migrated.pos_z }, parent), oldWorld, 'Legacy device');
    const cart = mixed.devices.find(row => row.id === 'legacy_rail_cart');
    assert.equal(cart.line_id, line.id);
    assert.equal(cart.coordinate_space, 'line_local');
    closePoint(localToParentPoint({ x: cart.pos_x, y: cart.pos_y, z: cart.pos_z }, parent), { x: -22.5, y: .5, z: 7.25 }, 'Legacy no-primary rail cart');
    const wall = JSON.parse(mixed.environment).walls[1];
    assert.equal(wall.coordinateSpace, 'workshop_local');
    assert.equal(wall.authorExtension, oldWall.authorExtension);
    closePoint(localToParentPoint({ x: wall.x, y: wall.baseY, z: wall.z }, normalizeWorkshopLayout(authored.workshops.find(row => row.id === workshop.id).layout_json).transform),
        { x: oldWall.x, y: oldWall.baseY, z: oldWall.z }, 'Legacy wall');
    checks.push('legacy world device, no-primary rail cart and wall preserve world positions');
    db.exec('DELETE FROM spatial_bootstrap_writes');
    db.close();
    for (let pass = 1; pass <= 2; pass++) {
        await bootstrap(filename);
        db = new Database(filename);
        assert.deepEqual(snapshot(db), mixed, 'After legacy repair, another bootstrap must preserve exact authored values');
        assert.deepEqual(db.prepare('SELECT * FROM spatial_bootstrap_writes').all(), [], 'Finished migration must not run again');
        db.close();
        checks.push('repaired engineering bootstrap ' + pass + ' is byte/idempotent with zero spatial UPDATE');
    }
    const result = { success: true, checks: checks.length, passed: checks, directory, bootstraps: 5, database: 'isolated SQLite', liveConfigurationWrites: 0, browserOperations: 0 };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv.includes('--bootstrap-isolated')) {
    (async () => {
        const filename = requireTestPath(process.argv[process.argv.indexOf('--bootstrap-isolated') + 1]);
        for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
            'SQLITE_TEMPLATE_FILE', 'SQLITE_RECOVERY_TEMPLATE', 'SQLITE_UPGRADE_TEMPLATE']) delete process.env[key];
        Object.assign(process.env, { APP_DATA_DIR: path.dirname(filename), DB_TYPE: 'sqlite', SQLITE_FILE: filename,
            DB_BACKUP_DIR: path.join(path.dirname(filename), 'backups'), DB_RECOVERY_DIR: path.join(path.dirname(filename), 'recovery'), LICENSE_ENFORCE: 'false' });
        const { getDb, closeDb } = require('../db/database');
        try { await getDb(); } finally { await closeDb(); }
    })().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
} else run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
