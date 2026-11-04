const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const { getBuiltinModels } = require('../backend/services/builtinModels');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForOwnedBackend, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');

let backend;
async function stop() { await stopOwnedSmokeProcess(backend); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);

(async () => {
    const root = path.resolve(__dirname, '..');
    const sandbox = await createSmokeSandbox('manual-disassembly-ui');
    sandbox.password = 'ManualLayout-' + require('node:crypto').randomBytes(18).toString('hex') + '!';
    const database = new Database(sandbox.filename);
    const targets = database.prepare('SELECT id,instance_config FROM devices ORDER BY id LIMIT 2').all();
    if (targets.length !== 2) throw new Error('Two isolated fixture devices are required');
    const template = getBuiltinModels().find(model => model.id === 'pit_furnace_2_v1');
    const modelIds = ['layout_model_a', 'layout_model_b'];
    modelIds.forEach((id, index) => database.prepare('INSERT INTO models (id,name,file_path,metadata,placement_level,asset_type) VALUES (?,?,?,?,?,?)')
        .run(id, index ? '井式炉2 · 型号B' : '井式炉2 · 型号A', template.file_path, template.metadata, 'device', 'model'));
    targets.forEach((device, index) => {
        const config = JSON.parse(device.instance_config || '{}');
        delete config.inspection; // These two fixture instances inherit one library model.
        config.manualLayoutUnrelatedMarker = { preserve: true, device: index };
        database.prepare('UPDATE devices SET name=?, model_type=?,model_file=NULL,rotation_y=?,scale=?,instance_config=? WHERE id=?')
            .run(index ? '现场设备B' : '现场设备A', modelIds[0], index ? -60 : 35,
                index ? .8 : 1, JSON.stringify(config), device.id);
    });
    const displayOnly=process.env.MANUAL_LAYOUT_DISPLAY_ONLY==='true';
    if(displayOnly){
        database.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();
        database.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
    }
    database.close();
    let serverDirectory=BACKEND_DIR;
    if(displayOnly){
        const {COLLECTOR_FILES}=require('../desktop/scripts/prepare-display-distribution.cjs');
        serverDirectory=path.join(sandbox.directory,'resources','backend');fs.mkdirSync(serverDirectory,{recursive:true});
        for(const name of ['server.js','services','db','routes','utils','middleware'])fs.cpSync(path.join(BACKEND_DIR,name),path.join(serverDirectory,name),{recursive:true,filter:file=>!COLLECTOR_FILES.includes(path.basename(file))});
        fs.symlinkSync(path.join(BACKEND_DIR,'assets'),path.join(serverDirectory,'assets'),'junction');
        fs.cpSync(path.join(root,'shared'),path.join(sandbox.directory,'resources','shared'),{recursive:true});
        fs.copyFileSync(path.join(root,'release-manifest.json'),path.join(sandbox.directory,'resources','release-manifest.json'));
        fs.writeFileSync(path.join(serverDirectory,'distribution.json'),'{"collector":false}');
    }
    const port = await findFreePort();
    const origin = `http://127.0.0.1:${port}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: serverDirectory,
        env: { ...sandbox.env, NODE_PATH:path.join(BACKEND_DIR,'node_modules'), PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: path.join(root, 'frontend/dist') },
        logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForOwnedBackend(origin, backend);
    await createSmokeSession(origin, sandbox);
    const info = { origin, directory: sandbox.directory, username: 'admin', password: sandbox.password,
        devices: targets.map(device => device.id), models: modelIds, database: sandbox.filename, backendPid: backend.pid };
    const infoFile = requireTestPath(process.env.MANUAL_LAYOUT_UI_INFO_FILE || path.join(root, 'output/manual-disassembly-ui-server.json'));
    fs.writeFileSync(infoFile, JSON.stringify(info, null, 2));
    console.log(JSON.stringify(info, null, 2));
    backend.once('exit', code => { console.error(`Isolated backend exited: ${code}`); process.exit(code || 1); });
})().catch(async error => { console.error(error); await stopOwnedSmokeProcess(backend); process.exit(1); });
