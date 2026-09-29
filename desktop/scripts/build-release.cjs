const { spawnSync } = require('child_process');
const path = require('path');

// npm and double-click use the same unpacked -> smoke -> NSIS release flow.
// Arguments are release-script options, e.g. -StarterTemplate.
const project = path.resolve(__dirname, '../..');
const result = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(project, '生成安装包.ps1'), '-NoPause', ...process.argv.slice(2)
], { cwd: project, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
