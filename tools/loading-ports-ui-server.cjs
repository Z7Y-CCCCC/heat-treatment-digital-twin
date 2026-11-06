'use strict';
// Disposable UI fixture: only output/ SQLite is written, asset files are read-only.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('../backend/node_modules/better-sqlite3');
const { getBuiltinModels } = require('../backend/services/builtinModels');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForOwnedBackend, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');

async function startLoadingPortsFixture() {
    const root = path.resolve(__dirname, '..'), sandbox = await createSmokeSandbox('loading-ports-ui-fixture');
    sandbox.password = 'LoadingPorts-' + crypto.randomBytes(18).toString('hex') + '!';
    const db = new Database(requireTestPath(sandbox.filename));
    let info;
    try {
        const line = db.prepare('SELECT l.*,w.factory_id FROM lines l JOIN workshops w ON w.id=l.workshop_id WHERE l.id=(SELECT line_id FROM devices WHERE line_id IS NOT NULL ORDER BY id LIMIT 1)').get();
        if (!line) throw new Error('An isolated seeded line/workshop is required');
        const template = getBuiltinModels().find(model => model.id === 'pit_furnace_2_v1');
        if (!template?.file_path) throw new Error('Read-only packaged GLB fixture is required');
        const modelIds = ['loading_ui_model_a', 'loading_ui_model_b'];
        const names = ['送料型号 A', '送料型号 B'];
        for (const [index, id] of modelIds.entries()) {
            const metadata = JSON.parse(template.metadata);
            metadata.loadingPorts = { version: 1, inlet: { position: [0, index ? 1.8 : 1.1, index ? 1.6 : 1], direction: [0, 0, 1], nodeName: '' },
                outlet: { position: [0, index ? 2.1 : 1.4, -1], direction: [0, 0, -1], nodeName: '' } };
            metadata.loadingPortPreservationMarker = { Case: 'KEEP-ABC', nested: [index, { untouched: true }] };
            metadata.inspection.loadingPortTestMarker = { retained: id };
            db.prepare('INSERT INTO models (id,name,file_path,metadata,default_scale,placement_level,asset_type) VALUES (?,?,?,?,?,?,?)')
                .run(id, names[index], template.file_path, JSON.stringify(metadata), 1, 'device', 'model');
        }
        const layout = { version: 2, coordinateSpace: 'workshop_local', placementPending: false, transform: { x: 0, y: 0, z: 0, rotationY: 0 }, flowDirection: 'right',
            lanes: [{ id: 'loading_ui_lane', name: '送料设备线', offsetZ: -10, length: 70, sort_order: 0 }],
            rails: [{ id: 'loading_ui_rail', name: '送料小车导轨', offsetZ: 0, length: 70, sort_order: 0 }] };
        db.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(layout), line.id);
        const devices = ['loading_ui_a', 'loading_ui_b', 'loading_ui_c'], deviceNames = ['送料设备 A', '送料设备 B', '送料设备 C'];
        for (const [index, id] of devices.entries()) {
            const instance = { workshop_id: line.workshop_id, laneId: 'loading_ui_lane', laneName: '送料设备线', laneLineId: line.id, layoutPlaced: true,
                plcPreservationMarker: { endpoint: `192.0.2.${10 + index}`, keep: true },
                inspection: { enabled: true, extension: { retained: id } }, movement: { path: [[index, 0, 0], [index + 1, 0, 2]], marker: 'KEEP' },
                customLoadingPortMarker: { Case: 'ABC', device: id } };
            db.prepare('INSERT INTO devices (id,name,line_id,model_type,model_file,coordinate_space,pos_x,pos_y,pos_z,rotation_y,scale,instance_config,plc_enabled,plc_protocol,plc_ip,plc_port) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(id, deviceNames[index], line.id, modelIds[index === 2 ? 1 : 0], null, 'line_local', [-20, 0, 20][index], [0, 1.2, -.6][index], [-9, -12, -15][index], 0, 1,
                    JSON.stringify(instance), 0, 'S7', `192.0.2.${10 + index}`, 1102);
        }
        // Avoid real-network reads or synthetic data writes during UI-only tests.
        db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();
        db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
        info = { directory: sandbox.directory, database: sandbox.filename, username: 'admin', password: sandbox.password,
            devices, deviceNames, models: modelIds, modelNames: names, lineId: line.id, factoryId: line.factory_id, layout,
            assetPath: path.resolve(BACKEND_DIR, '.' + template.file_path), assetSha256: crypto.createHash('sha256').update(fs.readFileSync(path.resolve(BACKEND_DIR, '.' + template.file_path))).digest('hex') };
    } finally { db.close(); }
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
    const backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: process.env.UI_FRONTEND_DIST || path.join(root, 'frontend/dist') },
        logFile: path.join(sandbox.directory, 'backend.log') });
    try {
        await waitForOwnedBackend(origin, backend);
        const session = await createSmokeSession(origin, sandbox);
        return { backend, info: { ...info, origin, session, backendPid: backend.pid }, sandbox };
    } catch (error) { await stopOwnedSmokeProcess(backend); throw error; }
}
module.exports = { startLoadingPortsFixture };
if (require.main === module) {
    let backend;
    async function stop() { await stopOwnedSmokeProcess(backend); process.exit(0); }
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    startLoadingPortsFixture().then(result => {
        backend = result.backend;
        const infoFile = requireTestPath(process.env.LOADING_PORTS_UI_INFO_FILE || path.join(path.resolve(__dirname, '..'), 'output/loading-ports-ui-server.json'));
        fs.writeFileSync(infoFile, JSON.stringify(result.info, null, 2)); console.log(JSON.stringify(result.info, null, 2));
        backend.once('exit', code => process.exit(code || 1));
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
