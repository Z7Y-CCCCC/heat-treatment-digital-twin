const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const desktop = path.resolve(__dirname, '..'), project = path.dirname(desktop);
const output = path.join(desktop, '.cache', 'collector-service');
const result = spawnSync('dotnet', ['publish', path.join(project, 'collector-service', 'HeatTreatmentCollector.csproj'),
    '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', output],
    { cwd: project, windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Collector service build failed: ${result.status}`);
fs.copyFileSync(path.join(project, 'collector-service', 'worker.cjs'), path.join(output, 'worker.cjs'));
for (const name of ['mysqlRuntime.cjs', 'directoryPublish.cjs', 'logManager.cjs', 'processLifecycle.cjs'])
    fs.copyFileSync(path.join(desktop, name), path.join(output, name));
console.log(`Windows collector service: ${output}`);
