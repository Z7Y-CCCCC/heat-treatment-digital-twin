// One reproducible, isolated entry point for CI and field diagnostics. Hardware
// and real database tests are opt-in; no backend/data fixture is ever required.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BACKEND_DIR, createRunDirectory } = require('./integration-test-utils.cjs');

const scripts = [
    'test-isolation-test.cjs',
    'admin-auth-test.cjs', 'license-test.cjs', 'release-package-test.cjs',
    'math-expression-test.cjs', 'business-data-test.cjs', 'data-source-test.cjs',
    'data-source-http-regression-test.cjs', 'data-source-designer-test.cjs',
    'spatial-hierarchy-test.cjs', 'cast-discovery-test.cjs',
    'backend-concurrency-test.cjs', 'backend-recovery-edge-test.cjs',
    'backend-service-failure-test.cjs',
    'admin-auth-integration-test.cjs', 'production-readiness-test.cjs',
    'data-point-sync-test.cjs', 'deletion-safety-test.cjs',
    'native-dashboard-config-test.cjs', 'plc-protocol-test.cjs',
    'plc-value-precision-test.cjs',
    'inspection-platform-test.cjs',
    'database-retention-test.cjs', 'site-backup-test.cjs',
    'power-recovery-test.cjs', 'runtime-display-test.cjs', 'http-integrity-test.cjs'
];
if (process.platform === 'win32') scripts.push('voice-feature-test.cjs');
if (process.argv.includes('--with-plc-simulators')) scripts.push('plc-integration-test.cjs', 'plc-simulator-protocol-integration-test.cjs');

const directory = createRunDirectory('quality-suite');
const results = [];
let activeChild;
async function stopOwnedTree(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
        await new Promise(resolve => {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.once('error', resolve); killer.once('close', resolve);
        });
    } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already exited */ } }
    }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopOwnedTree(activeChild).finally(() => process.exit(130));
});

async function run(script) {
    const started = Date.now();
    const logPath = path.join(directory, script.replace(/\.cjs$/, '.log'));
    const log = fs.createWriteStream(logPath);
    const env = { ...process.env };
    for (const name of ['ADMIN_API_TOKEN', 'MCP_API_TOKEN', 'DB_TYPE', 'SQLITE_FILE', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'APP_DATA_DIR', 'UPLOADS_DIR', 'DB_BACKUP_DIR', 'DB_RECOVERY_DIR', 'SITE_BACKUP_DIR', 'SITE_IMPORT_DIR', 'SITE_BACKUP_MIRROR_DIR', 'DATA_SOURCE_BACKUP_DIR', 'LICENSE_FILE', 'LICENSE_PUBLIC_KEY', 'LICENSE_PUBLIC_KEY_FILE', 'SQLITE_RECOVERY_TEMPLATE', 'SQLITE_UPGRADE_TEMPLATE']) delete env[name];
    let timedOut = false;
    let spawnError;
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
        cwd: BACKEND_DIR, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChild = child;
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const timer = setTimeout(() => { timedOut = true; stopOwnedTree(child).catch(() => {}); }, 180000);
    const code = await new Promise(resolve => {
        child.once('error', error => { spawnError = error.message; });
        child.once('close', resolve);
    });
    clearTimeout(timer);
    activeChild = null;
    await new Promise(resolve => log.end(resolve));
    const result = { script, passed: code === 0 && !timedOut && !spawnError, code, durationMs: Date.now() - started, log: logPath, ...(timedOut ? { timedOut } : {}), ...(spawnError ? { error: spawnError } : {}) };
    results.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${script} (${result.durationMs}ms)`);
    if (!result.passed) console.error(fs.readFileSync(logPath, 'utf8').slice(-6000));
}

(async () => {
    for (const script of scripts) await run(script);
    const result = { success: results.every(item => item.passed), passed: results.filter(item => item.passed).length, total: results.length, results, optionalNotRun: ['MySQL backup (explicit test server required)', ...(process.argv.includes('--with-plc-simulators') ? [] : ['External S7/Modbus/OPC UA simulators']), ...(process.platform === 'win32' ? [] : ['Windows system speech'])] };
    const resultPath = path.join(directory, 'result.json');
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: result.success, passed: result.passed, total: result.total, result: resultPath }, null, 2));
    if (!result.success) process.exitCode = 1;
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
