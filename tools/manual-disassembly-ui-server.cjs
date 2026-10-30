const fs = require('node:fs');
const path = require('node:path');
const Database = require('../backend/node_modules/better-sqlite3');
const { createSmokeSandbox, createSmokeSession, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const { BACKEND_DIR, findFreePort, startLoggedProcess, waitForHttp } = require('../backend/scripts/integration-test-utils.cjs');

let backend;
async function stop() { await stopOwnedSmokeProcess(backend); process.exit(0); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);

(async () => {
    const root = path.resolve(__dirname, '..');
    const sandbox = await createSmokeSandbox('manual-disassembly-ui');
    sandbox.password = 'ManualLayout-Isolated-Test-20261030!';
    const database = new Database(sandbox.filename);
    const targets = database.prepare('SELECT id,instance_config FROM devices ORDER BY id LIMIT 2').all();
    if (targets.length !== 2) throw new Error('Two isolated fixture devices are required');
    targets.forEach((device, index) => {
        const config = JSON.parse(device.instance_config || '{}');
        config.manualLayoutUnrelatedMarker = { preserve: true, device: index };
        database.prepare('UPDATE devices SET name=?, model_type=?,model_file=NULL,rotation_y=?,scale=?,instance_config=? WHERE id=?')
            .run(index ? '井式炉2 · 独立布局B' : '井式炉2 · 手工布局A', 'pit_furnace_2_v1', index ? -60 : 35,
                index ? .8 : 1, JSON.stringify(config), device.id);
    });
    database.close();
    const port = await findFreePort(3957);
    const origin = `http://127.0.0.1:${port}`;
    backend = startLoggedProcess(process.execPath, ['server.js'], { cwd: BACKEND_DIR,
        env: { ...sandbox.env, PORT: String(port), HOST: '127.0.0.1', FRONTEND_DIST: path.join(root, 'frontend/dist') },
        logFile: path.join(sandbox.directory, 'backend.log') });
    await waitForHttp(`${origin}/api/health`);
    await createSmokeSession(origin, sandbox);
    const info = { origin, directory: sandbox.directory, username: 'admin', password: sandbox.password,
        devices: targets.map(device => device.id), database: sandbox.filename, backendPid: backend.pid };
    fs.writeFileSync(path.join(root, 'output/manual-disassembly-ui-server.json'), JSON.stringify(info, null, 2));
    console.log(JSON.stringify(info, null, 2));
    backend.once('exit', code => { console.error(`Isolated backend exited: ${code}`); process.exit(code || 1); });
})().catch(async error => { console.error(error); await stopOwnedSmokeProcess(backend); process.exit(1); });
