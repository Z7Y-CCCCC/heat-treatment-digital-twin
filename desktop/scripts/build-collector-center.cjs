'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const { fingerprintInputs, buildCachedNative, snapshotBuildEnvironment, fingerprintBuildEnvironment, assertBuildEnvironmentUnchanged } = require('./native-build-cache.cjs');
const project = path.resolve(__dirname, '../..');
const source = path.join(project, 'collector-center');
const workspaceOutput = process.env.DIGITAL_TWIN_COLLECTOR_CENTER_BUILD_DIR;
const output = workspaceOutput ? path.resolve(workspaceOutput) : path.join(project, 'desktop/.cache/collector-center');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319');
// Pin the former Framework response-file reference set, plus the explicitly
// used HttpClient library and standard library. No machine-local csc.rsp flags
// or implicit standard-library choice may alter a cache-backed compilation.
const references = ['mscorlib.dll', 'Accessibility.dll', 'Microsoft.CSharp.dll',
    'System.Configuration.dll', 'System.Configuration.Install.dll', 'System.Core.dll',
    'System.Data.dll', 'System.Data.DataSetExtensions.dll', 'System.Data.Linq.dll', 'System.Data.OracleClient.dll',
    'System.Deployment.dll', 'System.Design.dll', 'System.DirectoryServices.dll', 'System.dll',
    'System.Drawing.Design.dll', 'System.Drawing.dll', 'System.EnterpriseServices.dll', 'System.Management.dll',
    'System.Messaging.dll', 'System.Runtime.Remoting.dll', 'System.Runtime.Serialization.dll',
    'System.Runtime.Serialization.Formatters.Soap.dll', 'System.Security.dll', 'System.ServiceModel.dll',
    'System.ServiceModel.Web.dll', 'System.ServiceProcess.dll', 'System.Transactions.dll', 'System.Web.dll',
    'System.Web.Extensions.Design.dll', 'System.Web.Extensions.dll', 'System.Web.Mobile.dll',
    'System.Web.RegularExpressions.dll', 'System.Web.Services.dll', 'System.Windows.Forms.dll',
    'System.Workflow.Activities.dll', 'System.Workflow.ComponentModel.dll', 'System.Workflow.Runtime.dll',
    'System.Xml.dll', 'System.Xml.Linq.dll', 'System.Net.Http.dll'].map(name => path.join(framework, name));
const icon = path.join(project, 'desktop/assets/icon.ico'), compiler = path.join(framework, 'csc.exe');
const compilerInputs = [compiler, compiler + '.config', path.join(framework, 'cscomp.dll'), path.join(framework, 'cscompui.dll')];

function build(staging, environment) {
        assertBuildEnvironmentUnchanged(environment);
        const result = spawnSync(compiler, ['/noconfig', '/nostdlib+', '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
            `/out:${path.join(staging, 'HeatTreatmentCollectorCenter.exe')}`, `/win32icon:${icon}`,
            `/win32manifest:${path.join(source, 'app.manifest')}`,
            ...references.map(file => `/reference:${file}`),
            ...['Program.cs', 'Operations.cs', 'CenterForm.cs', 'CenterNavigation.cs', 'PointClient.cs', 'PointPanel.cs', 'SelfTests.cs'].map(name => path.join(source, name))],
            { env: environment, windowsHide: true, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw Error(`Collector center build failed: ${result.status}`);
        fs.copyFileSync(path.join(source, 'HeatTreatmentCollectorCenter.exe.config'), path.join(staging, 'HeatTreatmentCollectorCenter.exe.config'));
}
async function main() {
    const environment = snapshotBuildEnvironment(), environmentIdentity = fingerprintBuildEnvironment(environment);
    const fingerprint = () => {
        assertBuildEnvironmentUnchanged(environment);
        return fingerprintInputs([__filename, source, icon, ...compilerInputs, ...references], environmentIdentity);
    };
    // The workspace launcher already owns the lock and immutable per-source
    // output path. Replacing that directory would discard its open build.lock.
    if (workspaceOutput) {
        fs.mkdirSync(output, { recursive: true });
        const before = fingerprint();
        build(output, environment);
        if (fingerprint() !== before) throw Error('Workspace collector center inputs changed during compilation');
        return { reused: false };
    }
    return buildCachedNative({
        output, required: ['HeatTreatmentCollectorCenter.exe', 'HeatTreatmentCollectorCenter.exe.config'],
        fingerprint, force: process.env.DESKTOP_FORCE_COLLECTOR_REBUILD === 'true',
        build: staging => build(staging, environment)
    });
}
if (require.main === module) main().then(result => console.log(result.reused ? '采集运行中心源码、编译器及全部输出校验通过，复用缓存。' : `Native collector center: ${output}`))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { main };
