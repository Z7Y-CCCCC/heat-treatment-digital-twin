// Read-only production audit. All database writes/credentials belong to a new
// isolated output/ fixture; never connects to a configured PLC or existing DB.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const execute = promisify(execFile);
const mysql = require('../backend/node_modules/mysql2/promise');
const Database = require('../backend/node_modules/better-sqlite3');
const { createRunDirectory, findFreePort, waitUntil, waitForExit } = require('../backend/scripts/integration-test-utils.cjs');
const { stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const source = path.resolve(process.argv[2]);
const run = createRunDirectory('runtime-resource-audit');
const root = path.join(run, 'machine-data'), resources = path.join(run, 'resources');
const controlFile = path.join(run, 'sampling-control.json');
let host, display, sampler, connection, phase = 'startup', cookie = '', csrf = '', origin;
const samples = [], phases = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function roots() { fs.writeFileSync(controlFile, JSON.stringify({ roots: [host?.pid, display?.pid].filter(Boolean) })); }
function files(directory) {
    if (!fs.existsSync(directory)) return 0;
    return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => {
        const file = path.join(directory, entry.name);
        return sum + (entry.isDirectory() ? files(file) : entry.isFile() ? fs.statSync(file).size : 0);
    }, 0);
}
async function api(route, body) {
    const response = await fetch(origin + '/api' + route, { method: body ? 'POST' : 'GET',
        headers: { 'X-Admin-Request': '1', Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status} ${route}: ${result.error}`);
    for (const update of response.headers.getSetCookie?.() || []) {
        const pair = update.split(';')[0], name = pair.split('=')[0];
        const jar = new Map(cookie.split('; ').filter(Boolean).map(item => [item.split('=')[0], item]));
        jar.set(name, pair); cookie = [...jar.values()].join('; ');
    }
    if (result.csrfToken) csrf = result.csrfToken;
    return result;
}
async function databaseStats() {
    const [status] = await connection.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_data_written','Innodb_os_log_written','Innodb_data_reads','Innodb_data_writes','Com_select','Com_insert','Com_delete','Questions')");
    const [[metrics]] = await connection.query('SELECT COUNT(*) n FROM metric_snapshots');
    const [[events]] = await connection.query('SELECT COUNT(*) n FROM event_logs');
    return { counters: Object.fromEntries(status.map(item => [item.Variable_name, Number(item.Value)])), metricRows: Number(metrics.n), eventRows: Number(events.n),
        logsBytes: files(path.join(root, 'logs')), backupBytes: files(path.join(root, 'data', 'backups')) + files(path.join(root, 'data', 'site-backups')),
        mysqlFilesBytes: files(path.join(root, 'mysql')) };
}
async function measure(name, seconds, action) {
    phase = name; console.log(`AUDIT phase=${name} seconds=${seconds}`);
    const before = await databaseStats(), start = Date.now();
    const result = await action?.();
    await sleep(Math.max(0, seconds * 1000 - (Date.now() - start)));
    const after = await databaseStats();
    const rows = samples.filter(sample => sample.phase === name);
    const intervals = [];
    for (let index = 1; index < rows.length; index++) {
        const previous = rows[index - 1], next = rows[index], elapsed = (next.timestamp - previous.timestamp) / 1000;
        const previousById = new Map(previous.processes.map(item => [item.pid, item]));
        let cpu = 0, read = 0, write = 0;
        for (const item of next.processes) {
            const old = previousById.get(item.pid);
            if (!old || item.error || old.error) continue;
            cpu += Math.max(0, item.cpuSeconds - old.cpuSeconds);
            read += Math.max(0, item.ioReadBytes - old.ioReadBytes);
            write += Math.max(0, item.ioWriteBytes - old.ioWriteBytes);
        }
        intervals.push({ cpuPercent: cpu / elapsed / next.logicalProcessors * 100,
            coreEquivalent: cpu / elapsed, ioReadBytesPerSecond: read / elapsed, ioWriteBytesPerSecond: write / elapsed,
            rssMb: next.processes.reduce((sum, item) => sum + (item.rss || 0), 0) / 1048576 });
    }
    const average = key => intervals.reduce((sum, item) => sum + item[key], 0) / Math.max(intervals.length, 1);
    phases.push({ name, durationSeconds: (Date.now() - start) / 1000, samples: rows.length,
        logicalProcessors: os.cpus().length, cpuPercentAverage: average('cpuPercent'), cpuPercentPeak5s: Math.max(0, ...intervals.map(item => item.cpuPercent)),
        coreEquivalentAverage: average('coreEquivalent'), ioReadBytesPerSecond: average('ioReadBytesPerSecond'), ioWriteBytesPerSecond: average('ioWriteBytesPerSecond'),
        rssMbAverage: average('rssMb'), before, after, ...(result ? { actionResult: result } : {}) });
}
(async () => {
    console.log(`AUDIT directory=${run}`);
    fs.mkdirSync(resources);
    for (const name of ['runtime', 'mysql', 'ffmpeg', 'frontend', 'backend', 'shared', 'collector-service'])
        fs.symlinkSync(path.join(source, name), path.join(resources, name), 'junction');
    fs.copyFileSync(path.join(source, 'backend-dependencies.tar'), path.join(resources, 'backend-dependencies.tar'));
    fs.mkdirSync(path.join(resources, 'templates'));
    const template = path.join(resources, 'templates', 'factory-template.db');
    fs.copyFileSync(path.join(source, 'templates', 'factory-template.db'), template);
    if (fs.existsSync(path.join(source, 'templates', 'uploads')))
        fs.symlinkSync(path.join(source, 'templates', 'uploads'), path.join(resources, 'templates', 'uploads'), 'junction');
    const fixture = new Database(template);
    fixture.prepare("UPDATE settings SET value='simulation' WHERE key='data_mode'").run();
    fixture.prepare("UPDATE settings SET value='factory_default' WHERE key='active_factory_id'").run();
    fixture.prepare("UPDATE factory_settings SET value='simulation' WHERE key='data_mode'").run();
    fixture.prepare('UPDATE devices SET plc_enabled=0').run();
    const deviceCount = fixture.prepare('SELECT COUNT(*) n FROM devices').get().n;
    fixture.close();
    const port = await findFreePort(3951); origin = `http://127.0.0.1:${port}`;
    const serviceConfig = path.join(run, 'collector-service.json');
    fs.writeFileSync(serviceConfig, JSON.stringify({ root, resourcesRoot: resources, port, backendOrigin: origin }));
    host = spawn(path.join(resources, 'collector-service', 'HeatTreatmentCollector.exe'), ['--console', '--config', serviceConfig],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const hostLog = fs.createWriteStream(path.join(run, 'host.log'));
    host.stdout.pipe(hostLog, { end: false }); host.stderr.pipe(hostLog, { end: false });
    let output = ''; host.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); });
    await waitUntil(() => {
        if (host.exitCode !== null) throw new Error('Collector exited; see host.log');
        return output.includes('COLLECTOR_SERVICE_READY');
    }, 240000, 'collector ready', 300);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'data', 'database-config.json'), 'utf8'));
    connection = await mysql.createConnection({ host: config.host, port: config.port, user: config.user, password: config.password, database: config.database });
    roots();
    sampler = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sample-owned-processes.ps1'), '-ControlFile', controlFile],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let partial = '';
    sampler.stdout.on('data', chunk => {
        partial += chunk;
        let index;
        while ((index = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, index).trim(); partial = partial.slice(index + 1);
            if (!line) continue;
            try { const item = { ...JSON.parse(line), phase }; samples.push(item); fs.appendFileSync(path.join(run, 'samples.jsonl'), JSON.stringify(item) + '\n'); }
            catch { console.error(`Sampler invalid output: ${line.slice(0, 150)}`); }
        }
    });
    sampler.stderr.on('data', chunk => console.error(String(chunk)));
    console.log('AUDIT warming up 45 seconds (startup backups excluded from steady-state baseline)');
    await sleep(45000);
    await api('/admin-auth/setup', { password: crypto.randomBytes(24).toString('hex') });
    await measure('collector-only', 60);
    const nativeDir = path.join(source, 'native-client');
    const adminHost = path.join(nativeDir, 'AdminHost', 'HeatTreatmentAdminHost.exe');
    display = spawn(path.join(nativeDir, 'HeatTreatmentDigitalTwin.exe'), ['-screen-fullscreen', '0', '-screen-width', '1600', '-screen-height', '900', '-logFile', '-'], {
        cwd: nativeDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
            DIGITAL_TWIN_BACKEND_HTTP_URL: origin, DIGITAL_TWIN_BACKEND_WEBSOCKET_URL: origin.replace('http:', 'ws:') + '/ws',
            DIGITAL_TWIN_ADMIN_URL: origin + '/admin', DIGITAL_TWIN_ADMIN_HOST_PATH: adminHost,
            DIGITAL_TWIN_ADMIN_FIXED_RUNTIME: path.join(path.dirname(adminHost), 'WebView2Runtime'), DIGITAL_TWIN_MAXIMIZE_WINDOW: 'false' }
    });
    const nativeLog = fs.createWriteStream(path.join(run, 'native.log'));
    display.stdout.pipe(nativeLog, { end: false }); display.stderr.pipe(nativeLog, { end: false });
    let nativeText = ''; display.stdout.on('data', chunk => { nativeText = (nativeText + chunk).slice(-131072); });
    roots(); await sleep(8000);
    const { ticket } = await api('/admin-auth/native-ticket', {});
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$taskPipe=[System.IO.Pipes.NamedPipeClientStream]::new('.', 'HeatTreatmentUnityAuth_${display.pid}', [System.IO.Pipes.PipeDirection]::Out, [System.IO.Pipes.PipeOptions]::Asynchronous); $taskPipe.Connect(10000); $taskWriter=[System.IO.StreamWriter]::new($taskPipe,[System.Text.UTF8Encoding]::new($false)); $taskWriter.WriteLine('{"action":"sync_unity_session","ticket":"${ticket}"}'); $taskWriter.Flush(); $taskWriter.Dispose(); $taskPipe.Dispose()`], { windowsHide: true, timeout: 15000 });
    await waitUntil(() => {
        if (display.exitCode !== null) throw new Error('Unity exited; see native.log');
        return nativeText.includes('[StartupProgress] 100|');
    }, 120000, 'full Unity scene loaded', 500);
    await sleep(12000);
    await measure('unity-loaded-1600x900', 60);
    await measure('site-backup-with-unity', 25, async () => {
        const started = Date.now(), result = await api('/site-backups/export', {});
        return { elapsedMs: Date.now() - started, size: result.backup?.size || result.size || null };
    });
    const [tables] = await connection.query('SELECT table_name, table_rows, data_length, index_length FROM information_schema.tables WHERE table_schema=?', [config.database]);
    const report = { success: true, createdAt: new Date().toISOString(), directory: run, source, deviceCount, simulationOnly: true, physicalPlcDisabled: true,
        limits: ['Short test, not a long-run leak certification.', 'Process I/O counters include file and network I/O, not physical disk active percent.',
            'Unity runs a loaded scene; this does not measure browser map interactions or every inspection view.', 'Small packaged template, not months of production history.'],
        phases, tables, counterErrors: samples.flatMap(item => item.processes.filter(process => process.error)) };
    if (report.counterErrors.length || phases.some(item => item.samples < 3)) throw new Error('Insufficient valid process counter samples');
    fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    if (fs.existsSync(controlFile)) fs.writeFileSync(controlFile, JSON.stringify({ stop: true }));
    if (display?.exitCode === null) await stopOwnedSmokeProcess(display);
    await connection?.end().catch(() => {});
    if (host?.exitCode === null) { host.stdin.write('stop\n'); try { await waitForExit(host, 40000); } finally { if (host.exitCode === null) await stopOwnedSmokeProcess(host); } }
    if (sampler?.exitCode === null) await stopOwnedSmokeProcess(sampler);
});
