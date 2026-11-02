const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRunDirectory } = require('../backend/scripts/integration-test-utils.cjs');
const cad = require('./model-profiles/pit-workshop-cad-layout.json');
const root = path.resolve(__dirname, '..');
const build = process.argv.includes('--build');
const directory = createRunDirectory('hall-visibility');
const devices = cad.devices.map(d => ({ ...d, line_id: cad.target.lineId, instance_config: { ground: d.ground, stationNumber: d.number } }));
const models = [...new Set(devices.map(d => d.model_type))].map(id => {
    const n = id.match(/^pit_furnace_(\d)_v1$/)?.[1];
    const folder = path.join(root, 'backend/assets/models', n ? `pit_furnace_references_v1/PitFurnace${n}` : 'pit_workshop_aux_v1');
    const data = JSON.parse(fs.readFileSync(path.join(folder, n ? 'metadata.json' : id + '.json')));
    return { id, name: data.name || data.display_name, file_path: path.join(folder, id + '.glb'), default_scale: 1,
        metadata: { ...(data.metadata || data), runtime: { enableGenericBindings: false, enableInspection: false }, partBindings: [], inspection: { enabled: false, parts: [] } } };
});
const line = { id: cad.target.lineId, name: '井式炉产线', layout_json: { transform: { x: 0, y: 0, z: 0, rotationY: 0 }, rails: [] }, devices };
const config = { factoryId: cad.target.factoryId, models, settings: {}, workshops: [{ id: cad.target.workshopId, name: '井式炉车间', layout_json: { size: cad.workshopSize, ground: cad.ground, boundary: { enabled: true } }, lines: [line] }] };
fs.writeFileSync(path.join(directory, 'fixture.json'), JSON.stringify({ devices, config }, null, 2));
const editor = process.env.UNITY_EDITOR_PATH || 'C:/Program Files/Unity 2022.3.34f1c1/Editor/Unity.exe';
const result = spawnSync(editor, ['-batchmode', ...(build ? ['-nographics', '-quit'] : []), '-projectPath', path.join(root, 'unity-client'), '-executeMethod', 'HeatTreatment.DigitalTwin.Editor.FactoryHallVisibilityChecks.' + (build ? 'BuildExistingClient' : 'Run'), '-logFile', path.join(directory, 'unity.log')], { cwd: root, windowsHide: true, env: { ...process.env, HALL_CHECK_DIRECTORY: directory, HALL_BUILD_DIRECTORY: path.join(directory, 'client') }, timeout: 600000 });
if (result.error) throw result.error;
const report = fs.existsSync(path.join(directory, 'native-result.json')) ? JSON.parse(fs.readFileSync(path.join(directory, 'native-result.json'))) : null;
const success = result.status === 0 && (build ? fs.existsSync(path.join(directory, 'client/HeatTreatmentDigitalTwin_Data/Managed/Assembly-CSharp.dll')) : report?.success);
console.log(JSON.stringify({ directory, exitCode: result.status, success: !!success, ...(build ? { buildDirectory: path.join(directory, 'client') } : { checks: report?.checks?.length, error: report?.error }) }, null, 2));
if (!success) process.exitCode = 1;
