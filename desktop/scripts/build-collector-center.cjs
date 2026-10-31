const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '../..');
const source = path.join(project, 'collector-center');
const output = path.join(project, 'desktop', '.cache', 'collector-center');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
fs.mkdirSync(output, { recursive: true });
const result = spawnSync(path.join(framework, 'csc.exe'), ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001',
    `/out:${path.join(output, 'HeatTreatmentCollectorCenter.exe')}`, `/win32icon:${path.join(project, 'desktop', 'assets', 'icon.ico')}`,
    `/win32manifest:${path.join(source, 'app.manifest')}`,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.ServiceProcess.dll', 'System.Web.Extensions.dll', 'System.Net.Http.dll'].map(name => `/reference:${path.join(framework, name)}`),
    ...['Program.cs', 'Operations.cs', 'CenterForm.cs', 'PointClient.cs', 'PointPanel.cs', 'SelfTests.cs'].map(name => path.join(source, name))],
{ windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
fs.copyFileSync(path.join(source, 'HeatTreatmentCollectorCenter.exe.config'), path.join(output, 'HeatTreatmentCollectorCenter.exe.config'));
console.log(`Native collector center: ${output}`);
