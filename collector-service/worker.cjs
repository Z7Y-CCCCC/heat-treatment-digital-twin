const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { MysqlRuntime } = require('./mysqlRuntime.cjs');
const { publishDirectory } = require('./directoryPublish.cjs');
const { createRotatingLogWriter } = require('./logManager.cjs');
const { terminateProcess } = require('./processLifecycle.cjs');

let database, backend, stopping = false, stopPromise, watchdog;
const logStreams = [];
const shutdownToken = crypto.randomBytes(32).toString('hex');
const configArg = process.argv.indexOf('--config');
const configFile = path.resolve(process.argv[configArg + 1]);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
const root = path.resolve(config.root), resources = path.resolve(config.resourcesRoot);
const port = Number(config.port || 3001);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid collector port');
const origin = `http://127.0.0.1:${port}`;
const dataDir = path.join(root, 'data'), logsDir = path.join(root, 'logs'), uploadsDir = path.join(root, 'uploads');
const dependencies = path.join(root, 'backend-dependencies');
const log = message => console.log(`[Collector] ${message}`);

function request(route, method = 'GET') {
    return new Promise((resolve, reject) => {
        const req = http.request(`${origin}${route}`, { method, headers: { 'X-Shutdown-Token': shutdownToken } }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
            res.on('error', reject);
        });
        req.setTimeout(2500, () => req.destroy(new Error('Collector health/shutdown timeout')));
        req.on('error', reject); req.end();
    });
}

async function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(watchdog);
    stopPromise = (async () => {
        // MySQL must outlive the backend's shutdown backup and database close.
        try { await terminateProcess(backend, { gracefulShutdown: async () => {
            const result = await request('/api/internal/shutdown', 'POST');
            if (result.status !== 202) throw new Error(`Shutdown HTTP ${result.status}`);
        }, gracefulTimeoutMs: 14000 }); }
        finally {
            await database?.stop();
            logStreams.forEach(stream => stream.end());
        }
    })();
    return stopPromise;
}

async function main() {
    if (stopping) return;
    for (const dir of [root, dataDir, logsDir, uploadsDir]) await fs.promises.mkdir(dir, { recursive: true });
    const archive = path.join(resources, 'backend-dependencies.tar');
    const marker = path.join(dependencies, '.archive-sha256');
    const hash = await new Promise((resolve, reject) => {
        const digest = crypto.createHash('sha256'), stream = fs.createReadStream(archive);
        stream.on('data', chunk => digest.update(chunk));
        stream.on('error', reject); stream.on('end', () => resolve(digest.digest('hex')));
    });
    let previous; try { previous = await fs.promises.readFile(marker, 'utf8'); } catch { }
    if (previous !== hash) {
        const staging = path.join(root, `backend-dependencies.preparing-${process.pid}`);
        await fs.promises.mkdir(staging, { recursive: true });
        log('Preparing backend dependencies');
        await new Promise((resolve, reject) => {
            const tar = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
                ['-xf', archive, '-C', staging], { windowsHide: true, stdio: 'ignore' });
            tar.once('error', reject); tar.once('close', code => code === 0 ? resolve() : reject(new Error(`Dependency extraction failed: ${code}`)));
        });
        for (const name of ['express', 'mysql2', 'better-sqlite3', 'ws']) {
            if (!fs.existsSync(path.join(staging, name, 'package.json'))) throw new Error(`Missing backend dependency: ${name}`);
        }
        await fs.promises.writeFile(path.join(staging, '.archive-sha256'), hash);
        await publishDirectory(staging, dependencies);
    }
    if (stopping) return;
    const template = path.join(resources, 'templates', 'factory-template.db');
    const snapshot = path.join(dataDir, 'factory.db');
    if (!fs.existsSync(snapshot)) await fs.promises.copyFile(template, snapshot);
    const sourceUploads = path.join(resources, 'templates', 'uploads');
    if (fs.existsSync(sourceUploads)) await fs.promises.cp(sourceUploads, uploadsDir,
        { recursive: true, dereference: true, force: false, errorOnExist: false });
    if (stopping) return;
    database = new MysqlRuntime({ root, runtimeDir: path.join(resources, 'mysql'), nodeBinary: path.join(resources, 'runtime', 'node.exe'),
        hostScript: path.join(resources, 'backend', 'services', 'privateMysqlHost.js'), dependenciesDir: dependencies,
        templateFile: template, onProgress: log,
        onUnexpectedExit: error => { console.error(error); stop().finally(() => process.exit(1)); } });
    const managedMysql = await database.start();
    if (stopping) { await database.stop(); return; }
    for (const filename of ['backend.log', 'backend-error.log']) {
        const stream = await createRotatingLogWriter(logsDir, filename);
        stream.on('error', error => console.error(`Log error: ${error.message}`));
        logStreams.push(stream);
    }
    const environment = { ...process.env };
    // Services never inherit the developer/user's database or automation tokens.
    for (const key of Object.keys(environment)) {
        if (/^(MYSQL_|DB_|SQLITE_|ADMIN_API_TOKEN$|MCP_API_TOKEN$|NODE_OPTIONS$|DESKTOP_CONTROL_|APP_DATA_DIR$|UPLOADS_DIR$)/i.test(key)) delete environment[key];
    }
    backend = spawn(path.join(resources, 'runtime', 'node.exe'), [path.join(resources, 'backend', 'server.js')], {
        cwd: path.join(resources, 'backend'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...environment, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port),
            APP_DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir, FRONTEND_DIST: path.join(resources, 'frontend'),
            NODE_PATH: dependencies, REMOTE_ACCESS_ENABLED: 'false', ENABLE_CORS: 'false',
            DESKTOP_AUTO_START_SUPPORTED: 'false', DESKTOP_SHUTDOWN_TOKEN: shutdownToken,
            LICENSE_ENFORCE: fs.existsSync(path.join(dataDir, 'license-public-key.pem')) ? 'true' : 'false',
            LICENSE_PUBLIC_KEY_FILE: path.join(dataDir, 'license-public-key.pem'),
            LICENSE_MACHINE_STATE_FILE: path.join(root, 'machine-identity.json'),
            FFMPEG_PATH: path.join(resources, 'ffmpeg', 'ffmpeg.exe'),
            SQLITE_RECOVERY_TEMPLATE: template, SQLITE_UPGRADE_TEMPLATE: template,
            ...(managedMysql ? { MYSQLDUMP_PATH: path.join(resources, 'mysql', 'bin', 'mysqldump.exe'),
                MYSQL_CLIENT_PATH: path.join(resources, 'mysql', 'bin', 'mysql.exe') } : {}) }
    });
    backend.stdout.pipe(logStreams[0], { end: false }); backend.stderr.pipe(logStreams[1], { end: false });
    backend.on('error', error => { console.error(error); if (!stopping) stop().finally(() => process.exit(1)); });
    backend.once('exit', code => { if (!stopping) { console.error(`Backend exited: ${code}`); stop().finally(() => process.exit(1)); } });
    const deadline = Date.now() + 60000;
    while (!stopping && Date.now() < deadline) {
        try {
            const response = await request('/api/health');
            const readyHealth = JSON.parse(response.body);
            if (response.status === 200 && readyHealth.status === 'ok' && readyHealth.db?.connected === true) {
                let healthFailures = 0, probing = false;
                watchdog = setInterval(async () => {
                    if (stopping || probing) return;
                    probing = true;
                    try {
                        const health = await request('/api/health');
                        if (health.status !== 200 || JSON.parse(health.body).status !== 'ok') throw new Error('Invalid collector health');
                        healthFailures = 0;
                    } catch (error) {
                        if (++healthFailures >= 3 && !stopping) {
                            console.error(`Backend health repeatedly failed: ${error.message}`);
                            stop().finally(() => process.exit(1));
                        }
                    } finally { probing = false; }
                }, 5000);
                console.log('COLLECTOR_READY');
                return;
            }
        } catch { }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('Collector backend failed to become healthy');
}

let started = false;
readline.createInterface({ input: process.stdin }).on('line', line => {
    line = line.trim();
    if (line === 'start' && !started) {
        started = true;
        main().catch(error => { console.error(error); stop().finally(() => process.exit(1)); });
    }
    if (line === 'stop') stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
}).on('close', () => stop().finally(() => process.exit(0)));
process.on('SIGTERM', () => stop().finally(() => process.exit(0)));
