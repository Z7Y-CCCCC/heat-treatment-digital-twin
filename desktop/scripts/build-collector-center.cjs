'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const { fingerprintInputs, buildCachedNative } = require('./native-build-cache.cjs');
const project = path.resolve(__dirname, '../..');
const source = path.join(project, 'collector-center');
const workspaceOutput = process.env.DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR;
const output = workspaceOutput ? path.resolve(workspaceOutput) : path.join(project, 'desktop/.cache/collector-center');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
const references = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.ServiceProcess.dll', 'System.Web.Extensions.dll', 'System.Net.Http.dll'].map(name => path.join(framework, name));
const icon = path.join(project, 'desktop/assets/icon.ico'), compiler = path.join(framework, 'csc.exe');

function build(staging) {
        const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
            `/out:${path.join(staging, 'HeatTreatmentCollectorCenter.exe')}`, `/win32icon:${icon}`,
            `/win32manifest:${path.join(source, 'app.manifest')}`,
            ...references.map(file => `/reference:${file}`),
            ...['Program.cs', 'Operations.cs', 'CenterForm.cs', 'CenterNavigation.cs', 'PointClient.cs', 'PointPanel.cs', 'SelfTests.cs'].map(name => path.join(source, name))],
            { windowsHide: true, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw Error(`Collector center build failed: ${result.status}`);
        fs.copyFileSync(path.join(source, 'HeatTreatmentCollectorCenter.exe.config'), path.join(staging, 'HeatTreatmentCollectorCenter.exe.config'));
}
async function main() {
    // The workspace launcher already owns the lock and immutable per-source
    // output path. Replacing that directory would discard its open build.lock.
    if (workspaceOutput) {
        fs.mkdirSync(output, { recursive: true });
        build(output);
        return { reused: false };
    }
    return buildCachedNative({
        output, required: ['HeatTreatmentCollectorCenter.exe', 'HeatTreatmentCollectorCenter.exe.config'],
        fingerprint: () => fingerprintInputs([__filename, source, compiler, icon, ...references]),
        force: process.env.DESKTOP_FORCE_COLLECTOR_REBUILD === 'true', build
    });
}
main().then(result => console.log(result.reused ? '采集运行中心源码、编译器及全部输出校验通过，复用缓存。' : `Native collector center: ${output}`))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
