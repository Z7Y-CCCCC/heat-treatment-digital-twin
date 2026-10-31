const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const nsh = fs.readFileSync(path.resolve(__dirname, '../service-installer.nsh'), 'utf8');
assert.match(nsh, /-File "\$PLUGINSDIR\\collector-service-preflight\.ps1"/);
const code = fs.readFileSync(path.resolve(__dirname, '../collector-service-preflight.ps1'), 'utf8');
for (const state of ['absent', 'stopped', 'running', 'stop-fails', 'query-fails']) {
    test(`NSIS service preflight: ${state}`, () => {
        const mock = `
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.ServiceProcess
function Get-Service { [CmdletBinding()]param([string]$Name)
  if('${state}' -eq 'absent'){Write-Error 'missing' -ErrorId NoServiceFoundForGivenName -ErrorAction Stop}
  if('${state}' -eq 'query-fails'){throw 'mock access denied'}
  $s=[pscustomobject]@{Status=$(if('${state}' -eq 'stopped'){'Stopped'}else{'Running'})}
  $s | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value { param($state,$timeout) [Console]::WriteLine('WAIT_CALLED') }
  $s | Add-Member -MemberType ScriptMethod -Name Stop -Value {
    [Console]::WriteLine('STOP_CALLED')
    if('${state}' -eq 'stop-fails'){throw 'mock access denied'}
  }
  return $s
}
`;
        const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(mock + code, 'utf16le').toString('base64')],
            { windowsHide: true, encoding: 'utf8', timeout: 15000 });
        if (result.error) throw result.error;
        assert.equal(result.status, ['stop-fails', 'query-fails'].includes(state) ? 1 : 0, result.stderr);
        assert.equal(result.stdout.includes('STOP_CALLED'), ['running', 'stop-fails'].includes(state));
        assert.equal(result.stdout.includes('WAIT_CALLED'), state === 'running');
    });
}
