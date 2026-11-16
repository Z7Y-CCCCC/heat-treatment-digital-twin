'use strict';
// Deliberate, user-confirmed repair for an OS-reserved UI port. NEVER invoked
// automatically on startup. Leaves old-origin storage and collector settings intact.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { startDisplayGateway } = require('../desktop/displayGateway.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2), port = Number(args[args.indexOf('--port') + 1]);
if (process.platform !== 'win32' || !args.includes('--apply') || !args.includes('--port') || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error('Explicit approval required: node tools/repair-ui-origin.cjs --apply --port PORT');
const profile = path.join(process.env.APPDATA, 'heat-treatment-digital-twin-desktop');
const portFile = path.join(profile, 'ui-gateway.json'), deploymentFile = path.join(profile, 'deployment.json');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function ensureIdle() {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "$p=Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^HeatTreatment(DigitalTwin|AdminHost)\\.exe$' -or ($_.Name -match '^(electron|msedgewebview2)\\.exe$' -and ($_.CommandLine -like ('*'+$env:DT_RECOVERY_PROFILE+'*') -or $_.CommandLine -like ('*'+$env:DT_RECOVERY_DESKTOP+'*'))) }; @($p | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"],
        { windowsHide: true, encoding: 'utf8', timeout: 15000, env: { ...process.env, DT_RECOVERY_PROFILE: profile, DT_RECOVERY_DESKTOP: path.join(root, 'desktop') } });
    if (result.error || result.status !== 0) throw Error('Cannot verify exclusive profile access');
    if (result.stdout.trim() && JSON.parse(result.stdout).length !== 0) throw Error('Close the display/startup-error window before repair; no process was stopped');
}
function run(exe, commandArgs, log, timeout = 120000, extraEnv = {}) {
    const env = { ...process.env, ...extraEnv };
    // Electron checks presence, not truthiness, of this environment switch.
    // An empty value can enter Node mode on Windows; remove it entirely.
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(exe, commandArgs, { cwd: root, windowsHide: true, timeout, encoding: 'utf8',
        env });
    fs.writeFileSync(log, (result.stdout || '') + (result.stderr || ''));
    if (result.error || result.status !== 0) throw Error('Recovery step failed; old port retained; inspect ' + log);
}
let guard, gateway, backup, portChanged = false;
(async () => {
    ensureIdle();
    const originalPortBytes = fs.readFileSync(portFile), originalDeployment = fs.readFileSync(deploymentFile);
    const saved = JSON.parse(originalPortBytes), deployment = JSON.parse(originalDeployment);
    if (saved.pendingOriginMigration) throw Error('Automatic origin migration is pending; resume startup or review recovery backups before manual repair');
    if (saved.version !== 1 || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535 || saved.port === port)
        throw Error('Invalid or unchanged saved UI port');
    if (deployment.mode !== 'client') throw Error('This repair is only for the display-owned gateway');
    guard = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(port, '127.0.0.1', resolve); });
    backup = path.join(profile, 'recovery', 'ui-origin-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'ui-gateway.before.json'), originalPortBytes);
    // Do not copy site databases or credentials into the source workspace.
    fs.writeFileSync(path.join(backup, 'deployment.sha256'), sha(originalDeployment));
    const helper = path.join(root, 'output/ui-origin-migration-helper');
    run('dotnet', ['build', path.join(root, 'tools/ui-origin-migration/Migration.csproj'), '--configuration', 'Debug', '--output', helper], path.join(backup, 'helper-build.log'));
    const results = [];
    for (const engine of ['WebView2', 'Electron']) {
        const output = path.join(backup, engine);
        fs.mkdirSync(output);
        const request = { Profile: engine === 'WebView2' ? path.join(profile, 'webview2') : profile,
            OldOrigin: `http://127.0.0.1:${saved.port}`, NewOrigin: `http://127.0.0.1:${port}`, Output: output, SelfTest: false };
        const file = path.join(backup, engine + '.request.json');
        fs.writeFileSync(file, JSON.stringify(request));
        if (engine === 'WebView2') run('dotnet', [path.join(helper, 'Migration.dll'), file], path.join(output, 'run.log'));
        else run(path.join(root, 'desktop/node_modules/electron/dist/electron.exe'), [path.join(root, 'tools/ui-origin-migration/electron.cjs'), '--request', file], path.join(output, 'run.log'));
        const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json')));
        if (result.success !== true || result.sourceUnmodified !== true || result.sourceCount !== result.verifiedCount) throw Error('Storage verification failed');
        results.push(result);
    }
    ensureIdle();
    if (!fs.readFileSync(portFile).equals(originalPortBytes) || !fs.readFileSync(deploymentFile).equals(originalDeployment)) throw Error('Configuration changed during recovery; refusing overwrite');
    const temporary = portFile + `.${process.pid}.recovery.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, port }));
    fs.renameSync(temporary, portFile); portChanged = true;
    await new Promise(resolve => guard.close(resolve)); guard = null;
    gateway = await startDisplayGateway({ backendOrigin: deployment.backendOrigin, frontendDir: path.join(root, 'frontend/dist'), portFile });
    const ui = await fetch(gateway.origin + '/admin', { signal: AbortSignal.timeout(5000) });
    if (!ui.ok) throw Error('New fixed UI origin did not serve the application');
    await ui.arrayBuffer();
    const health = await fetch(gateway.origin + '/api/health', { signal: AbortSignal.timeout(10000) });
    if (!health.ok) throw Error('Collector health did not pass through the new UI origin');
    await health.arrayBuffer();
    const report = { success: true, oldPort: saved.port, newPort: port, origin: gateway.origin,
        backup, storage: results, collectorConfigurationUnchanged: fs.readFileSync(deploymentFile).equals(originalDeployment),
        applicationHttpStatus: ui.status, collectorHealthHttpStatus: health.status, productionAppStarted: false };
    fs.writeFileSync(path.join(backup, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
})().catch(error => {
    if (portChanged && backup) {
        // Old and new storage both survive rollback; never erase migrated drafts.
        fs.writeFileSync(portFile, fs.readFileSync(path.join(backup, 'ui-gateway.before.json')));
    }
    console.error(error.message); process.exitCode = 1;
}).finally(async () => {
    if (gateway) await gateway.close();
    if (guard) await new Promise(resolve => guard.close(resolve));
});
