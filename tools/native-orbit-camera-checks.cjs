const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '..');
const directory = createRunDirectory('orbit-camera-checks');
const version = fs.readFileSync(path.join(root, 'unity-client/ProjectSettings/ProjectVersion.txt'), 'utf8').match(/^m_EditorVersion:\s*(.+)$/m)?.[1]?.trim();
const editor = process.env.UNITY_EDITOR_PATH || path.join('C:/Program Files', `Unity ${version}`, 'Editor/Unity.exe');
assert.ok(fs.existsSync(editor), `Unity editor not found: ${editor}`);
const log = path.join(directory, 'unity.log'), reportFile = path.join(directory, 'native-result.json');
const started = Date.now();
const result = spawnSync(editor, ['-batchmode', '-quit', '-nographics', '-projectPath', path.join(root, 'unity-client'),
    '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.OrbitCameraChecks.Run', '-logFile', log],
    { cwd: root, windowsHide: true, env: { ...process.env, ORBIT_CAMERA_REPORT: reportFile }, timeout: 600000 });
if (result.error) throw result.error;
assert.equal(result.status, 0, `Native camera checks failed; see ${log}`);
assert.ok(fs.existsSync(reportFile) && fs.statSync(reportFile).mtimeMs >= started, 'Unity did not write a fresh report');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert.equal(report.status, 'passed');
assert.ok(report.checks.length >= 100);
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: reportFile, log }, null, 2));
