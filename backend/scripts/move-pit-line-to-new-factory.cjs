// Explicit, transactional relocation requested by Ethan. Existing factories and
// equipment are preserved; only the five imported pit furnaces change ownership.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../db/database');
const { normalizeWorkshopLayout, normalizeLineLayout } = require('../utils/spatialLayout');
const ROOT = path.resolve(__dirname, '../..');
const FACTORY = 'factory_pit_furnaces_v1';
const WORKSHOP = 'ws_pit_furnaces_v1';
const LINE = 'line_pit_furnaces_v1';
const PROJECT = FACTORY + '_project';
const SCENE = FACTORY + '_scene';
const DEVICE_IDS = [1, 2, 3, 4, 5].map(n => `PitFurnace_0${n}`);
const MODEL_IDS = [1, 2, 3, 4, 5].map(n => `pit_furnace_${n}_v1`);
const TABLES = ['factories', 'workshops', 'lines', 'devices', 'models', 'projects', 'scenes', 'factory_settings'];
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const key = (table, row) => table === 'factory_settings' ? `${row.factory_id}/${row.key}` : row.id;

(async () => {
    const c = loadDatabaseConfig();
    assert.equal(c.type, 'mysql');
    const db = await mysql.createConnection({ host: c.host, port: c.port, user: c.user, password: c.password, database: c.database });
    const target = { type: c.type, host: c.host, port: c.port, database: c.database };
    try {
        const before = {};
        for (const table of TABLES) [before[table]] = await db.query(`SELECT * FROM \`${table}\``);
        const line = before.lines.find(row => row.id === LINE);
        assert.ok(line, 'Imported pit line must exist before relocation');
        const devices = before.devices.filter(row => DEVICE_IDS.includes(row.id));
        const models = before.models.filter(row => MODEL_IDS.includes(row.id));
        assert.equal(devices.length, 5);
        assert.equal(models.length, 5);
        assert.deepEqual(before.devices.filter(row => row.line_id === LINE).map(row => row.id).sort(), DEVICE_IDS);
        if (line.workshop_id === WORKSHOP) {
            assert.ok(before.factories.some(row => row.id === FACTORY));
            assert.ok(before.workshops.some(row => row.id === WORKSHOP && row.factory_id === FACTORY));
            assert.ok(models.every(row => row.factory_id === FACTORY));
            assert.ok(devices.every(row => parse(row.instance_config).workshop_id === WORKSHOP));
            console.log(JSON.stringify({ status: 'already_moved', factoryId: FACTORY, workshopId: WORKSHOP, lineId: LINE }));
            return;
        }
        const sourceWorkshop = before.workshops.find(row => row.id === line.workshop_id);
        assert.equal(sourceWorkshop.factory_id, 'factory_default', 'Refuse to relocate a line with unexpected current ownership');
        assert.ok(!before.factories.some(row => row.id === FACTORY));
        assert.ok(!before.workshops.some(row => row.id === WORKSHOP));
        assert.ok(!before.projects.some(row => row.id === PROJECT));
        assert.ok(!before.scenes.some(row => row.id === SCENE));
        assert.ok(devices.every(row => parse(row.instance_config).integration_source === 'pit_furnace_line_v1'));
        assert.ok(models.every(row => row.factory_id === sourceWorkshop.factory_id));
        const plan = { factoryId: FACTORY, factoryName: '井式炉工厂', workshopId: WORKSHOP, workshopName: '井式炉车间',
            lineId: LINE, deviceIds: DEVICE_IDS, modelIds: MODEL_IDS, sourceFactoryId: sourceWorkshop.factory_id, sourceWorkshopId: sourceWorkshop.id,
            location: '未配置，未复制天津位置', existingEquipmentModified: false };
        if (!process.argv.includes('--apply')) { console.log(JSON.stringify({ status: 'dry_run', ...plan }, null, 2)); return; }
        const directory = path.join(ROOT, 'output', 'pit-furnace-factory-migration-' + new Date().toISOString().replace(/[:.]/g, '-'));
        fs.mkdirSync(directory, { recursive: true });
        const backup = path.join(directory, 'before-config.json');
        fs.writeFileSync(backup, JSON.stringify({ target, ...before }, null, 2));
        fs.writeFileSync(path.join(directory, 'plan.json'), JSON.stringify(plan, null, 2));
        const changed = (table, row) => table === 'lines' && row.id === LINE || table === 'devices' && DEVICE_IDS.includes(row.id) || table === 'models' && MODEL_IDS.includes(row.id);
        await db.beginTransaction();
        try {
            await db.execute('INSERT INTO factories (id,name,location_json,is_enabled,sort_order) VALUES (?,?,?,1,?)',
                [FACTORY, plan.factoryName, JSON.stringify({ country: 'CHN', regionCode: '', regionName: '', cityCode: '', city: '', districtCode: '', districtName: '', latitude: null, longitude: null }), Math.max(-1, ...before.factories.map(row => row.sort_order || 0)) + 1]);
            await db.execute('INSERT INTO projects (id,factory_id,name,description,is_active) VALUES (?,?,?,?,1)', [PROJECT, FACTORY, '井式炉独立数字孪生项目', '独立井式炉产线；不复用原工厂设备、场景组件或PLC绑定']);
            await db.execute("INSERT INTO scenes (id,project_id,name,scene_type,layout_json,camera_json,theme_json,is_active,sort_order) VALUES (?,?,?,'factory_overview','{}','{}','{}',1,0)", [SCENE, PROJECT, '井式炉工厂总览']);
            // Same presentation defaults as the standard create-factory route;
            // no location, published widgets, points or data sources are cloned.
            for (const row of before.factory_settings.filter(row => row.factory_id === 'factory_default'))
                await db.execute('INSERT INTO factory_settings (factory_id,`key`,value) VALUES (?,?,?)', [FACTORY, row.key, row.value]);
            const workshopLayout = normalizeWorkshopLayout({ size: { width: 100, depth: 60, height: 12 } });
            await db.execute('INSERT INTO workshops (id,name,factory_id,sort_order,layout_json) VALUES (?,?,?,0,?)', [WORKSHOP, plan.workshopName, FACTORY, JSON.stringify(workshopLayout)]);
            const lineLayout = normalizeLineLayout(parse(line.layout_json));
            lineLayout.transform = { x: 0, y: 0, z: 0, rotationY: 0 };
            await db.execute('UPDATE `lines` SET workshop_id=?,sort_order=0,layout_json=? WHERE id=?', [WORKSHOP, JSON.stringify(lineLayout), LINE]);
            for (const device of devices) {
                const config = parse(device.instance_config);
                config.workshop_id = WORKSHOP;
                if ('workshopId' in config) config.workshopId = WORKSHOP;
                config.showStatusLight = false;
                delete config.statusLightY;
                await db.execute('UPDATE devices SET instance_config=? WHERE id=?', [JSON.stringify(config), device.id]);
            }
            for (const model of models) await db.execute('UPDATE models SET factory_id=? WHERE id=?', [FACTORY, model.id]);
            for (const table of TABLES) {
                const [after] = await db.query(`SELECT * FROM \`${table}\``);
                for (const row of before[table].filter(row => !changed(table, row))) {
                    assert.equal(stable(after.find(item => key(table, item) === key(table, row))), stable(row), `Unrelated record changed: ${table}/${key(table, row)}`);
                }
            }
            await db.commit();
        } catch (error) { await db.rollback(); throw error; }
        const result = { status: 'moved', ...plan, target, backup, projectId: PROJECT, sceneId: SCENE, lineTransformZ: 0, plcSettingsUnchanged: true, existingRecordsUnchanged: true };
        fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(ROOT, 'output/pit-furnace-factory-migration-result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result, null, 2));
    } finally { await db.end(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
