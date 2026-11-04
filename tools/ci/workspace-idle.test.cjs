'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
const step = workflow.split('      - name: Refuse cleanup of an in-use build workspace\n')[1]?.split('\n      - uses: actions/checkout@v4')[0];
assert.ok(step, 'workspace guard must run BEFORE checkout, not after it');
const guard = step.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
test('build workspace protection is fail-closed, read-only and never terminates user processes', () => {
  assert.match(guard, /Get-CimInstance Win32_Process/);
  assert.match(guard, /throw .*Workspace is in use/);
  assert.doesNotMatch(guard, /Stop-Process|taskkill|Remove-Item|Move-Item|Start-Process|Invoke-Expression/);
  assert.match(guard, /OrdinalIgnoreCase/);
});
const fixtures = [
  ['unoccupied workspace', [], true],
  ['display inside checkout', [{ Name: 'HeatTreatmentDigitalTwin.exe', ProcessId: 101, ExecutablePath: 'C:\\fixture\\repo\\unity-client\\Builds\\Windows\\HeatTreatmentDigitalTwin.exe' }], false],
  ['different installed display', [{ Name: 'HeatTreatmentDigitalTwin.exe', ProcessId: 102, ExecutablePath: 'C:\\Program Files\\DigitalTwin\\HeatTreatmentDigitalTwin.exe' }], true],
  ['sibling path is not the workspace', [{ Name: 'HeatTreatmentAdminHost.exe', ProcessId: 103, ExecutablePath: 'C:\\fixture\\repo-other\\HeatTreatmentAdminHost.exe' }], true],
  ['collector inside checkout', [{ Name: 'HeatTreatmentCollectorService.exe', ProcessId: 104, ExecutablePath: 'c:\\FIXTURE\\REPO\\plugin\\HeatTreatmentCollectorService.exe' }], false],
  ['uninspectable display is not assumed safe', [{ Name: 'HeatTreatmentDigitalTwin.exe', ProcessId: 105, ExecutablePath: null }], false],
  ['backend using an external node executable', [{ Name: 'node.exe', ProcessId: 106, ExecutablePath: 'C:\\Node\\node.exe', CommandLine: 'node "C:/fixture/repo/backend/server.js"' }], false],
  ['an editor using the checkout', [{ Name: 'Unity.exe', ProcessId: 107, ExecutablePath: 'C:\\Unity\\Editor\\Unity.exe', CommandLine: 'Unity.exe -projectPath "C:\\fixture\\repo\\unity-client"' }], false],
  ['other backend project', [{ Name: 'node.exe', ProcessId: 108, ExecutablePath: 'C:\\Node\\node.exe', CommandLine: 'node "C:\\other\\backend\\server.js"' }], true],
];
for (const [label, processes, allowed] of fixtures) test(label, { skip: process.platform !== 'win32' }, () => {
  const json = Buffer.from(JSON.stringify(processes), 'utf8').toString('base64');
  const script = `$ProgressPreference='SilentlyContinue'; $env:GITHUB_WORKSPACE='C:\\fixture\\repo'; $fixture=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${json}')) | ConvertFrom-Json; function Get-CimInstance { param($ClassName) $fixture }; ${guard}; Write-Output 'WORKSPACE_GUARD_PASSED'`;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  let result, failed = false;
  try { result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 }); }
  catch (error) { failed = true; result = String(error.stderr || error.stdout); }
  assert.equal(!failed, allowed, `${label}: ${result}`);
  if (allowed) assert.match(result, /WORKSPACE_GUARD_PASSED/);
  else assert.match(result, /Workspace is in use/);
});
