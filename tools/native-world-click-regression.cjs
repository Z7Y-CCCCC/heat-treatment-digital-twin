const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Run the real editor fixture and reject old reports if compilation or a
// preliminary check fails before the play-mode fixture can write its result.
const root = path.resolve(__dirname, '..');
const project = path.join(root, 'unity-client');
const version = fs.readFileSync(path.join(project, 'ProjectSettings/ProjectVersion.txt'), 'utf8')
    .match(/^m_EditorVersion:\s*(.+)$/m)?.[1]?.trim();
assert.ok(version, 'Unity project version is missing');
const editor = process.env.UNITY_EDITOR_PATH
    || path.join('C:\\Program Files', `Unity ${version}`, 'Editor/Unity.exe');
assert.ok(fs.existsSync(editor), `Unity editor is missing: ${editor}`);
const output = path.join(root, 'output');
fs.mkdirSync(output, { recursive: true });
const log = path.join(output, 'click-freeze-unity-checks-20261030.log');
const reportFile = path.join(output, 'pit-furnace-native-system-report.json');
const started = Date.now();
console.log(`Running world-click regression with Unity ${version}`);
const result = spawnSync(editor, [
    '-batchmode', '-force-d3d11', '-projectPath', project,
    '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.PitFurnaceSystemChecks.Run',
    '-logFile', log
], { cwd: root, windowsHide: true, stdio: 'inherit', timeout: 600000 });
if (result.error) throw result.error;
assert.equal(result.status, 0, `Unity regression failed (exit ${result.status}); see ${log}`);
assert.ok(fs.existsSync(reportFile) && fs.statSync(reportFile).mtimeMs >= started,
    'Unity did not write a fresh regression report');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert.equal(report.status, 'passed', report.error || 'Unity regression did not pass');
assert.deepEqual(report.runtimeErrors, [], 'Unity logged runtime errors');
const pressure = report.models.flatMap(model => (model.worldClickPressure || [])
    .map(check => ({ modelId: model.id, ...check })));
assert.equal(report.models.length, 5, 'Five real pit-furnace models must be checked');
assert.ok(pressure.some(check => check.modelId === 'pit_furnace_2_v1' && check.partId === 'pf2_fixture'),
    'The reported hanging-fixture target was not checked');
assert.ok(pressure.some(check => check.renderedFrames > 0 && check.cameraInvalidation),
    'Rendered-frame clicks and camera invalidation must be checked');
console.log(JSON.stringify({ status: report.status, checks: report.checkCount,
    models: report.models.length,
    clicks: pressure.reduce((count, check) => count + check.clicks, 0),
    renderedFrames: pressure.reduce((count, check) => count + (check.renderedFrames || 0), 0),
    pressure, report: reportFile, log }, null, 2));
