const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mysql = require('../backend/node_modules/mysql2/promise');
const Database = require('../backend/node_modules/better-sqlite3');
const { createRunDirectory, findFreePort, waitUntil, waitForExit } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess, createSmokeProgramData } = require('../desktop/scripts/smoke-sandbox.cjs');

const source = path.resolve(process.argv[2] || 'desktop/resources');
const project = path.resolve(__dirname, '..');
const sourceHost = fs.existsSync(path.join(source, 'collector-service', 'HeatTreatmentCollector.exe'))
    ? path.join(source, 'collector-service') : path.join(project, 'desktop', '.cache', 'collector-service');
let child;
(async () => {
    const run = createRunDirectory('collector-service-smoke'), resources = path.join(run, 'resources'), root = path.join(run, 'machine-data');
    const machineEnv = createSmokeProgramData(run);
    console.log(`Collector smoke workspace: ${run}`);
    fs.mkdirSync(resources);
    for (const name of ['runtime', 'mysql', 'ffmpeg', 'frontend', 'backend', 'shared']) {
        let from = path.join(source, name);
        if (!fs.existsSync(from)) from = name === 'frontend' ? path.join(project, 'frontend', 'dist') : path.join(project, name);
        fs.symlinkSync(from, path.join(resources, name), 'junction');
    }
    fs.symlinkSync(sourceHost, path.join(resources, 'collector-service'), 'junction');
    fs.copyFileSync(path.join(source, 'backend-dependencies.tar'), path.join(resources, 'backend-dependencies.tar'));
    fs.mkdirSync(path.join(resources, 'templates'));
    const template = path.join(resources, 'templates', 'factory-template.db');
    fs.copyFileSync(path.join(source, 'templates', 'factory-template.db'), template);
    if (fs.existsSync(path.join(source, 'templates', 'uploads')))
        fs.symlinkSync(path.join(source, 'templates', 'uploads'), path.join(resources, 'templates', 'uploads'), 'junction');
    const fixture = new Database(template);
    fixture.prepare("UPDATE settings SET value='simulation' WHERE key='data_mode'").run();
    fixture.prepare("UPDATE factory_settings SET value='simulation' WHERE key='data_mode'").run();
    fixture.prepare('UPDATE devices SET plc_enabled=0').run();
    const expectedDevices = fixture.prepare('SELECT COUNT(*) n FROM devices').get().n;
    fixture.close();
    const port = await findFreePort(3941), backendOrigin = `http://127.0.0.1:${port}`;
    const filename = path.join(run, 'collector-service.json');
    fs.writeFileSync(filename, JSON.stringify({ version: 1, root, resourcesRoot: resources, port, backendOrigin }));
    let connection;
    const launches = [];
    const desktopExe = path.join(path.dirname(source), '热处理数字孪生大屏.exe');
    let packagedFrontendVerified = false;
    const phases = process.argv.includes('--with-host-crash')
        ? ['first-start', 'restart', 'host-crash', 'after-host-crash'] : ['first-start', 'restart'];
    for (const phase of phases) {
        console.log(`Collector smoke: ${phase}`);
        let stdout = '', stderr = '';
        child = spawn(path.join(sourceHost, 'HeatTreatmentCollector.exe'), ['--console', '--no-power-request', '--config', filename],
            { cwd: run, windowsHide: true, env: { ...process.env, ...machineEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        try {
            await waitUntil(() => {
                if (child.exitCode !== null) throw new Error(`Service host failed: ${stdout}\n${stderr}\n${run}`);
                return stdout.includes('COLLECTOR_SERVICE_READY');
            }, 240000, 'service worker ready', 300);
            const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'database-config.json'), 'utf8'));
            connection = await mysql.createConnection({ host: config.host, port: config.port, user: config.user,
                password: config.password, database: config.database });
            const [[count]] = await connection.query('SELECT COUNT(*) n FROM devices');
            assert.equal(Number(count.n), expectedDevices);
            if (phase === 'first-start') {
                await connection.query("INSERT INTO settings (`key`,value) VALUES ('collector_persistence_test','retained')");
            } else {
                const [[row]] = await connection.query("SELECT value FROM settings WHERE `key`='collector_persistence_test'");
                assert.equal(row.value, 'retained');
            }
            let health;
            await waitUntil(async () => {
                health = await (await fetch(`${backendOrigin}/api/health`)).json();
                return health.engine?.collectorStatus?.frames > 1;
            }, 15000, `collection frames without Unity (${phase})`, 300);
            assert.equal(health.components.unity.clients, 0);
            assert.equal(health.historyRetention.metricDays, 90);
            assert.equal(health.historyRetention.eventDays, null);
            const frames = health.engine.collectorStatus.frames;
            if (phase === 'first-start' && fs.existsSync(desktopExe)) {
                const frontendRoot = path.join(run, 'frontend-user');
                const env = { ...process.env, ...machineEnv, APP_USER_DATA_DIR: frontendRoot,
                    DIGITAL_TWIN_COLLECTOR_CONFIG: filename, NATIVE_CLIENT_SMOKE_MODE: 'true',
                    DESKTOP_SMOKE_EXIT_AFTER_MS: '5000', DISABLE_AUTO_START: 'true' };
                delete env.DESKTOP_SMOKE_STANDALONE;
                delete env.DIGITAL_TWIN_DEPLOYMENT_FILE;
                const display = spawn(desktopExe, [], { cwd: path.dirname(desktopExe), windowsHide: true, env, stdio: 'ignore' });
                try {
                    assert.equal(await waitForExit(display, 90000), 0);
                    const frontLog = fs.readFileSync(path.join(frontendRoot, 'logs', 'native-client.log'), 'utf8');
                    assert.ok(frontLog.includes('[FactoryRuntime] Application tab chrome requested'));
                    for (const name of ['data', 'mysql', 'backend-dependencies', 'uploads'])
                        assert.equal(fs.existsSync(path.join(frontendRoot, name)), false, `Unity client must not create ${name}`);
                    assert.equal(fs.existsSync(path.join(frontendRoot, 'logs', 'backend.log')), false);
                    assert.equal(child.exitCode, null, 'exiting real Unity desktop must not stop service host');
                    packagedFrontendVerified = true;
                } finally { if (display.exitCode === null) await stopOwnedSmokeProcess(display); }
            }
            // A client reads and closes its HTTP connection. The collector has
            // no desktop process parent and must keep producing fresh frames.
            await (await fetch(`${backendOrigin}/admin`)).text();
            await waitUntil(async () => {
                const next = await (await fetch(`${backendOrigin}/api/health`)).json();
                return next.engine.collectorStatus.frames > frames;
            }, 10000, 'collector continues after display connection closes', 300);
            const mysqlPid = Number(fs.readFileSync(path.join(root, 'mysql', 'mysqld.pid'), 'utf8'));
            await connection.end(); connection = null;
            if (phase === 'host-crash') {
                child.kill('SIGKILL');
                assert.notEqual(await waitForExit(child, 40000), 0);
                await waitUntil(() => {
                    try { process.kill(mysqlPid, 0); return false; }
                    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
                }, 10000, 'job object kills only owned MySQL after service host crash', 100);
            } else {
                child.stdin.write('stop\n');
                assert.equal(await waitForExit(child, 40000), 0);
            }
            assert.throws(() => process.kill(mysqlPid, 0), { code: 'ESRCH' }, 'service stop must not leave MySQL orphaned');
            launches.push({ phase, frames, zeroUnityClients: true, mysqlStopped: true, graceful: phase !== 'host-crash' });
        } finally {
            await connection?.end().catch(() => {});
            if (child?.exitCode === null) await stopOwnedSmokeProcess(child);
        }
    }
    const report = { success: true, consoleServiceHost: true, packagedFrontendVerified, windowsScmInstallTest: 'requires-elevation',
        launches, source, directory: run, programData: machineEnv.ProgramData };
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (child?.exitCode === null) await stopOwnedSmokeProcess(child);
});
