const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess,
    waitForHttp, waitUntil, forceStop } = require('../backend/scripts/integration-test-utils.cjs');
(async () => {
    const directory = createRunDirectory('native-collector-points');
    const data = path.join(directory, 'data'); fs.mkdirSync(data);
    const filename = await createTestDatabase(path.join(data, 'factory.db'));
    const Database = require('../backend/node_modules/better-sqlite3');
    const db = new Database(filename);
    db.prepare("UPDATE settings SET value='simulation' WHERE `key`='data_mode'").run();
    db.prepare("UPDATE factory_settings SET value='simulation' WHERE `key`='data_mode'").run(); db.close();
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
    const token = crypto.randomBytes(32).toString('hex'), password = crypto.randomBytes(24).toString('base64');
    const env = { ...process.env, APP_DATA_DIR: data, DB_TYPE: 'sqlite', SQLITE_FILE: filename, HOST: '127.0.0.1', PORT: String(port),
        ADMIN_API_TOKEN: token, MCP_API_TOKEN: '', LICENSE_ENFORCE: 'false', UPLOADS_DIR: path.join(directory, 'uploads'),
        DB_BACKUP_DIR: path.join(data, 'backups'), DB_RECOVERY_DIR: path.join(data, 'recovery') };
    const backend = startLoggedProcess(process.execPath, [path.join(BACKEND_DIR, 'server.js')], { cwd: BACKEND_DIR, env, logFile: path.join(directory, 'backend.log') });
    let native;
    const json = async (route, options) => {
        const response = await fetch(origin + route, { ...options, signal: AbortSignal.timeout(10000) });
        const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
    };
    try {
        await waitForHttp(origin + '/api/health');
        await waitUntil(async () => (await json('/api/health')).engine?.process?.status === 'running', 30000, 'collector');
        await json('/api/admin-auth/setup', { method: 'POST', headers: { Origin: origin, 'X-Admin-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
        const report = path.join(directory, 'native-api.json');
        native = spawn(path.resolve(__dirname, '../desktop/.cache/collector-center/HeatTreatmentCollectorCenter.exe'),
            ['--point-api-test', origin, report], { windowsHide: true, env: { ...process.env, NATIVE_TEST_USER: 'admin', NATIVE_TEST_PASSWORD: password, NATIVE_TEST_GATE: '1' } });
        const done = new Promise((resolve, reject) => { native.once('error', reject); native.once('exit', resolve); });
        await waitUntil(() => fs.existsSync(report + '.before'), 15000, 'native authenticated first point read');
        const before = JSON.parse(fs.readFileSync(report + '.before', 'utf8').replace(/^\uFEFF/, ''));
        assert.ok(before.points.length > 0);
        const points = await json(`/api/datapoints?factory_id=${encodeURIComponent(before.factory)}&device_id=${encodeURIComponent(before.device)}`, { headers: { 'X-Admin-Token': token } });
        const point = points.find(p => String(p.id) === before.points[0].id); assert.ok(point);
        const label = '后台实时同步验收';
        await json(`/api/datapoints/${encodeURIComponent(point.id)}?factory_id=${encodeURIComponent(before.factory)}`, {
            method: 'PUT', headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...point, label }) });
        fs.writeFileSync(report + '.continue', 'continue');
        assert.equal(await done, 0, fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : 'native failed');
        const result = JSON.parse(fs.readFileSync(report, 'utf8').replace(/^\uFEFF/, ''));
        assert.ok(result.after.some(p => p.Name === label));
        assert.ok(!result.before.some(p => p.Name === label));
        console.log(JSON.stringify({ success: true, existingBackendLogin: true, sameDatabaseAsUnityAdmin: true,
            backendEditObservedWithoutClientRestart: true, productionDataModified: false, directory }, null, 2));
    } finally { if (native && native.exitCode === null) native.kill(); await forceStop(backend); }
})().catch(error => { console.error(error); process.exitCode = 1; });
