'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const { fingerprintInputs, buildConfigurationInputs, buildCachedNative, snapshotBuildEnvironment, fingerprintBuildEnvironment, assertBuildEnvironmentUnchanged } = require('./native-build-cache.cjs');
const { sha256 } = require('./runtime-cache.cjs');
const desktop = path.resolve(__dirname, '..'), project = path.dirname(desktop);
const source = path.join(project, 'collector-service'), output = path.join(desktop, '.cache/collector-service');
const copied = ['mysqlRuntime.cjs', 'directoryPublish.cjs', 'logManager.cjs', 'processLifecycle.cjs', 'templateData.cjs'];

async function main() {
    const environment = snapshotBuildEnvironment(), environmentIdentity = fingerprintBuildEnvironment(environment);
    function sdkVersion() {
        assertBuildEnvironmentUnchanged(environment);
        const sdk = spawnSync('dotnet', ['--version'], { cwd: project, env: environment, windowsHide: true, encoding: 'utf8' });
        if (sdk.error) throw sdk.error;
        if (sdk.status !== 0 || typeof sdk.stdout !== 'string' || !sdk.stdout.trim()) throw Error('Cannot determine .NET SDK version');
        assertBuildEnvironmentUnchanged(environment);
        return sdk.stdout.trim();
    }
    const inputs = [__filename, source, path.join(project, 'shared/DependencyArchive.cs'),
        ...copied.map(name => path.join(desktop, name)), ...buildConfigurationInputs(source)];
    const assets = path.join(source, 'obj/project.assets.json');
    const result = await buildCachedNative({
        output, required: ['HeatTreatmentCollector.exe', 'worker.cjs', ...copied],
        fingerprint: () => fingerprintInputs(inputs, JSON.stringify([sdkVersion(), environmentIdentity])),
        restoredState: () => fs.existsSync(assets) ? sha256(assets) : 'missing',
        force: process.env.DESKTOP_FORCE_COLLECTOR_REBUILD === 'true',
        build: staging => {
            assertBuildEnvironmentUnchanged(environment);
            const result = spawnSync('dotnet', ['publish', path.join(source, 'HeatTreatmentCollector.csproj'),
                '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', staging],
                { cwd: project, env: environment, windowsHide: true, stdio: 'inherit' });
            if (result.error) throw result.error;
            if (result.status !== 0) throw Error(`Collector service build failed: ${result.status}`);
            fs.copyFileSync(path.join(source, 'worker.cjs'), path.join(staging, 'worker.cjs'));
            for (const name of copied) fs.copyFileSync(path.join(desktop, name), path.join(staging, name));
        }
    });
    console.log(result.reused ? '采集服务源码、SDK、依赖记录及全部输出校验通过，复用缓存。' : `Windows collector service: ${output}`);
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
