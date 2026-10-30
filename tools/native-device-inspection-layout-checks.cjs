const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output');
fs.mkdirSync(output, { recursive: true });
const golden = spawnSync(process.execPath, ['--test', 'frontend/tests/device-inspection-offset-contract.test.mjs'],
    { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 60000 });
if (golden.error) throw golden.error;
assert.equal(golden.status, 0, 'Three/manual-drag golden checks must pass before the native comparison');
const version = fs.readFileSync(path.join(root, 'unity-client/ProjectSettings/ProjectVersion.txt'), 'utf8')
    .match(/^m_EditorVersion:\s*(.+)$/m)?.[1]?.trim();
const editor = process.env.UNITY_EDITOR_PATH || path.join('C:\\Program Files', `Unity ${version}`, 'Editor/Unity.exe');
assert.ok(fs.existsSync(editor), `Unity editor not found: ${editor}`);
const log = path.join(output, 'device-inspection-offset-native-contract.log');
const reportFile = path.join(output, 'device-inspection-offset-native-contract.json');
const started = Date.now();
const result = spawnSync(editor, ['-batchmode', '-quit', '-force-d3d11', '-projectPath', path.join(root, 'unity-client'),
    '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.DeviceInspectionLayoutChecks.Run', '-logFile', log],
    { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 600000 });
if (result.error) throw result.error;
assert.equal(result.status, 0, `Native layout comparison failed; see ${log}`);
assert.ok(fs.existsSync(reportFile) && fs.statSync(reportFile).mtimeMs >= started, 'Unity did not write a fresh native comparison report');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert.equal(report.status, 'passed');
assert.equal(report.cases, 4);
console.log(JSON.stringify({ ...report, log, report: reportFile }, null, 2));
