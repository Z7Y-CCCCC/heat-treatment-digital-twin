// Explicit, additive deployment into the configured existing MySQL database.
// Never starts the application, initializes/migrates a database, enables PLCs,
// changes existing devices, or overwrites a colliding asset/configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../db/database');
const { getPitFurnaceModels } = require('../services/pitFurnaceModels');

const ROOT = path.resolve(__dirname, '../..');
const LINE_ID = 'line_pit_furnaces_v1';
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const flag = name => process.argv.includes(name);
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; };

async function main() {
    const factoryId = option('--factory');
    const workshopId = option('--workshop');
    if (!factoryId || !workshopId) throw new Error('Specify --factory and --workshop from the existing configuration. Default is dry-run; use --apply to insert.');
    const config = loadDatabaseConfig();
    if (config.type !== 'mysql') throw new Error('This explicit deployment adapter requires the configured MySQL database.');
    const db = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    const target = { type: config.type, host: config.host, port: config.port, database: config.database };
    const sourceModels = getPitFurnaceModels();
    const modelIds = sourceModels.map(model => model.id);
    const deviceIds = [1, 2, 3, 4, 5].map(n => `PitFurnace_0${n}`);
    try {
        const [workshops] = await db.execute('SELECT * FROM workshops WHERE id=? AND factory_id=?', [workshopId, factoryId]);
        if (workshops.length !== 1) throw new Error('The selected workshop/factory pair does not exist.');
        const [existingLines] = await db.query('SELECT * FROM `lines` ORDER BY id');
        const [existingDevices] = await db.query('SELECT * FROM devices ORDER BY id');
        const [existingModels] = await db.query('SELECT * FROM models ORDER BY id');
        const priorLine = existingLines.find(line => line.id === LINE_ID);
        if (priorLine || existingDevices.some(device => deviceIds.includes(device.id)) || existingModels.some(model => modelIds.includes(model.id))) {
            const installed = priorLine && existingDevices.filter(device => deviceIds.includes(device.id)).length === 5
                && existingModels.filter(model => modelIds.includes(model.id)).length === 5
                && priorLine.workshop_id === workshopId
                && existingDevices.filter(device => deviceIds.includes(device.id)).every((device) => device.line_id === LINE_ID
                    && json(device.instance_config)?.integration_source === 'pit_furnace_line_v1');
            if (!installed) throw new Error('Partial installation or colliding IDs found; no configuration will be overwritten.');
            console.log(JSON.stringify({ status: 'already_installed', target, lineId: LINE_ID, devices: deviceIds, changed: false }));
            return;
        }
        const layout = { version: 2, coordinateSpace: 'workshop_local', placementPending: false,
            transform: { x: 0, y: 0, z: 30, rotationY: 0 }, flowDirection: 'right',
            lanes: [{ id: 'pit_lane_1', name: '井式炉设备线', type: 'device_lane', offsetZ: 0, length: 60, sort_order: 0 }], rails: [] };
        const line = { id: LINE_ID, name: '井式炉', workshop_id: workshopId,
            sort_order: Math.max(-1, ...existingLines.filter(item => item.workshop_id === workshopId).map(item => Number(item.sort_order) || 0)) + 1,
            layout_json: JSON.stringify(layout) };
        const models = sourceModels.map(model => ({ id: model.id, name: model.name,
            file_path: `/uploads/models/${model.id}-system.glb`, thumbnail: `/uploads/models/${model.id}-preview.png`,
            default_scale: 1, asset_type: 'model', placement_level: 'device', factory_id: factoryId,
            tags: model.tags, metadata: model.metadata }));
        const devices = sourceModels.map((model, index) => ({ id: deviceIds[index], name: model.name, line_id: LINE_ID,
            model_type: model.id, model_file: models[index].file_path, template_id: '',
            instance_config: JSON.stringify({ integration_source: 'pit_furnace_line_v1', caption: model.name,
                workshop_id: workshopId, laneId: 'pit_lane_1', laneName: '井式炉设备线', laneLineId: LINE_ID,
                scaleMultiplier: 1, animationProfile: 'static', dataProfile: 'heat_treatment',
                labelY: 7, statusLightY: 6.5 }),
            pos_x: -20 + index * 10, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1,
            coordinate_space: 'line_local', sort_order: index, plc_enabled: 0, plc_ip: '' }));
        const uploads = [option('--uploads'), option('--mirror-uploads')].filter(Boolean).map(item => path.resolve(item));
        if (!uploads.length) uploads.push(path.join(ROOT, 'backend/uploads'));
        const plan = { target, factoryId, workshopId, line, devices, models, uploads, plcEnabled: false, existingRecordsModified: false };
        if (!flag('--apply')) { console.log(JSON.stringify({ status: 'dry_run', target, factoryId, workshopId, line: line.name, lineId: LINE_ID, devices: devices.map(({ id, name, pos_x }) => ({ id, name, pos_x })), uploads, existingRecordsModified: false }, null, 2)); return; }

        const output = path.join(ROOT, 'output', 'pit-furnace-system-import-' + new Date().toISOString().replace(/[:.]/g, '-'));
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'before-config.json'), JSON.stringify({ target, lines: existingLines, devices: existingDevices, models: existingModels }, null, 2));
        fs.writeFileSync(path.join(output, 'import-plan.json'), JSON.stringify(plan, null, 2));
        const copied = [];
        for (const uploadsRoot of uploads) {
            const directory = path.join(uploadsRoot, 'models'); fs.mkdirSync(directory, { recursive: true });
            for (const source of sourceModels) {
                for (const [url, filename] of [[source.file_path, `${source.id}-system.glb`], [source.thumbnail, `${source.id}-preview.png`]]) {
                    const data = fs.readFileSync(path.join(ROOT, 'backend', url.replace(/^\//, '')));
                    const destination = path.join(directory, filename);
                    if (fs.existsSync(destination)) {
                        if (hash(fs.readFileSync(destination)) !== hash(data)) throw new Error(`Refusing to overwrite different asset: ${destination}`);
                    } else fs.writeFileSync(destination, data, { flag: 'wx' });
                    copied.push({ path: destination, sha256: hash(data) });
                }
            }
        }
        async function insert(table, row) {
            const keys = Object.keys(row);
            await db.execute(`INSERT INTO \`${table}\` (${keys.map(key => '`' + key + '`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => row[key]));
        }
        await db.beginTransaction();
        try {
            for (const model of models) await insert('models', model);
            await insert('lines', line);
            for (const device of devices) await insert('devices', device);
            for (const [table, originals] of [['lines', existingLines], ['devices', existingDevices], ['models', existingModels]]) {
                const [after] = await db.query(`SELECT * FROM \`${table}\` ORDER BY id`);
                for (const before of originals) if (stable(after.find(row => row.id === before.id)) !== stable(before)) throw new Error(`Existing ${table} record changed: ${before.id}`);
            }
            await db.commit();
        } catch (error) { await db.rollback(); throw error; }
        const result = { status: 'installed', target, factoryId, workshopId, lineId: LINE_ID, deviceIds, modelIds,
            existingRecordsUnchanged: true, copied, backup: path.join(output, 'before-config.json'), plcEnabled: false };
        fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
        fs.writeFileSync(path.join(ROOT, 'output/pit-furnace-system-import-result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify({ ...result, copied: copied.length }, null, 2));
    } finally { await db.end(); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
