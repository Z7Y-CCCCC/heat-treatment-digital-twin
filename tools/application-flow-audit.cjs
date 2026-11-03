// Source/runtime regression only. Never builds an installer, reuses a site
// profile, connects a real PLC, or controls an already running desktop process.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const { createSmokeEnvironment, stopOwnedSmokeProcess } = require('../desktop/scripts/smoke-sandbox.cjs');
const root = path.resolve(__dirname, '..'), directory = createRunDirectory('application-flow-audit');
const env = createSmokeEnvironment(directory, { MANUAL_LAYOUT_DISPLAY_ONLY: 'true' }), results = [];
const historyOnly = process.argv.includes('--history-ui');
const backend = [
    'database-readiness-test.cjs', 'admin-auth-test.cjs', 'admin-auth-integration-test.cjs',
    'admin-session-persistence-test.cjs', 'admin-login-history-test.cjs',
    'page-permissions-test.cjs', 'page-permissions-integration-test.cjs',
    'license-test.cjs', 'offline-activation-test.cjs', 'factory-isolation-test.cjs',
    'factory-display-collection-test.cjs', 'configuration-sync-test.cjs',
    'backend-recovery-edge-test.cjs', 'backend-service-failure-test.cjs',
    'site-recovery-intent-test.cjs', 'power-recovery-test.cjs', 'runtime-display-test.cjs',
    'ws-queue-test.cjs', 'http-integrity-test.cjs'
];
const entries = historyOnly ? [] : backend.map(script => ({ name: script, args: [path.join(root, 'backend/scripts', script)] }));
if (!historyOnly) entries.push({ name: 'frontend-regressions', cwd: path.join(root, 'frontend'), args: [
    '--experimental-test-module-mocks', '--test', '--test-concurrency=1', ...fs.readdirSync(path.join(root, 'frontend/tests')).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`)
] });
if (!historyOnly) entries.push({ name: 'desktop-lifecycle-units', args: ['--test', ...[
    'process-lifecycle-test.cjs', 'desktop-supervisor-unit-test.cjs', 'activation-client-test.cjs'
].map(name => path.join(root, 'desktop/scripts', name))] });
if (process.argv.includes('--ui')) for (const script of [
    'account-session-ui-test.cjs', 'account-policy-ui-test.cjs', 'account-dock-ui-test.cjs', 'activation-flow-ui-test.cjs'
]) entries.push({ name: script, args: [path.join(__dirname, script)], timeoutMs: 240000 });
if (historyOnly) for (const script of [
    'admin-header-ui-test.cjs', 'factory-modal-ui-test.cjs', 'device-form-ui-test.cjs',
    'users-feedback-ui-test.cjs', 'users-table-ui-test.cjs', 'points-tabs-ui-test.cjs',
    'model-library-ui-test.cjs', 'platform-tabs-ui-test.cjs', 'map-settings-tabs-ui-test.cjs',
    'project-migration-ui-test.cjs', 'quick-cast-ui-test.cjs', 'quality-admin-sync-ui-test.cjs',
    'view-hierarchy-ui-test.cjs', 'data-source-workspace-ui-test.cjs', 'data-set-workflow-ui-test.cjs',
    'line-multiselect-ui-test.cjs', 'industrial-ground-ui-test.cjs', 'industrial-ground-cutaway-visual-test.cjs',
    'manual-disassembly-drag-ui-test.cjs', 'widget-playback-ui-test.cjs', 'component-data-delivery-test.cjs',
    'account-session-ui-test.cjs', 'account-policy-ui-test.cjs', 'account-dock-ui-test.cjs',
    'activation-flow-ui-test.cjs', 'login-fault-ui-test.cjs'
]) entries.push({ name: script, args: [path.join(__dirname, script)], timeoutMs: 240000 });
if (process.argv.includes('--native')) for (const script of [
    'desktop/scripts/backend-supervisor-test.cjs', 'desktop/scripts/admin-host-retry-test.cjs',
    'desktop/scripts/admin-host-parent-test.cjs', 'tools/native-account-session-smoke-test.cjs', 'tools/native-client-smoke-test.cjs'
]) entries.push({ name: path.basename(script), args: [path.join(root, script)], timeoutMs: 240000 });
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7).split(',');
if (only) {
    for (const name of only) if (!entries.some(entry => entry.name === name)) throw new Error('未知测试：' + name);
    entries.splice(0, entries.length, ...entries.filter(entry => only.includes(entry.name)));
}
if (!entries.length) throw new Error('没有选择任何检查');

let child;
const { execFileSync } = require('node:child_process');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const changedFiles = [...new Set([
    ...execFileSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0'),
    ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0')
].filter(Boolean))].map(filename => ({ path: filename, sha256: fs.existsSync(path.join(root, filename))
    ? require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, filename))).digest('hex') : null }));
let running;
function progress() {
    const file = path.join(directory, 'progress.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify({ commit, changedFiles, startedAt, planned: entries.map(entry => entry.name), running, results }, null, 2));
    fs.renameSync(file + '.tmp', file);
}
const startedAt = new Date().toISOString();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    stopOwnedSmokeProcess(child).finally(() => process.exit(130));
});
(async () => {
    console.log(`Audit evidence: ${directory}`);
    progress();
    for (const entry of entries) {
        running = { name: entry.name, startedAt: new Date().toISOString() }; progress();
        const started = Date.now(), logPath = path.join(directory, `${entry.name}.log`), log = fs.createWriteStream(logPath);
        let timedOut = false, spawnError;
        child = spawn(process.execPath, entry.args, { cwd: entry.cwd || root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
        const current = child, timer = setTimeout(() => { timedOut = true; void stopOwnedSmokeProcess(current); }, entry.timeoutMs || 180000);
        const code = await new Promise(resolve => { current.once('error', error => { spawnError = error.message; resolve(-1); }); current.once('close', resolve); });
        clearTimeout(timer); child = null; await new Promise(resolve => log.end(resolve));
        const result = { name: entry.name, passed: code === 0 && !timedOut && !spawnError, code, durationMs: Date.now() - started, log: logPath, ...(timedOut ? { timedOut } : {}), ...(spawnError ? { error: spawnError } : {}) };
        results.push(result); console.log(`${result.passed ? 'PASS' : 'FAIL'} ${entry.name} (${result.durationMs}ms)`);
        running = null; progress();
        if (!result.passed) console.error(fs.readFileSync(logPath, 'utf8').slice(-4000));
    }
    const result = { commit, changedFiles, startedAt, success: results.every(item => item.passed), passed: results.filter(item => item.passed).length, total: results.length,
        excluded: ['installer/package verification', 'long-running endurance and acquisition tests', 'active operator desktop/profile', 'field hardware and ERP services'], results };
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ success: result.success, passed: result.passed, total: result.total, result: path.join(directory, 'result.json') }, null, 2));
    if (!result.success) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => stopOwnedSmokeProcess(child));
