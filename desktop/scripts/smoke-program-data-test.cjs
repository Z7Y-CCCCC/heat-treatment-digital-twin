const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRunDirectory } = require('../../backend/scripts/integration-test-utils.cjs');
const { createSmokeProgramData } = require('./smoke-sandbox.cjs');
const root = path.resolve(__dirname, '../..');
const directory = createRunDirectory('smoke-program-data');
const fakeMachineRoot = path.join(directory, 'untouched-machine-data');
fs.mkdirSync(fakeMachineRoot);
fs.writeFileSync(path.join(fakeMachineRoot, 'sentinel.txt'), 'unchanged');
const isolated = createSmokeProgramData(directory);
assert.equal(isolated.PROGRAMDATA, isolated.ProgramData);
assert.match(isolated.ProgramData, /^[\x20-\x7e]+$/);
assert.notEqual(isolated.ProgramData.toLowerCase(), fakeMachineRoot.toLowerCase());
const env = { ...process.env, ProgramData: fakeMachineRoot, PROGRAMDATA: fakeMachineRoot, ...isolated,
    APP_DATA_DIR: path.join(directory, 'data'), LICENSE_FILE: path.join(directory, 'license.json'),
    LICENSE_ENFORCE: 'false', SMOKE_REPO_ROOT: root };
const code = `
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(process.env.ProgramData, process.env.PROGRAMDATA);
// Match the packaged desktop entry point's machine-state override.
process.env.LICENSE_MACHINE_STATE_FILE = path.join(process.env.ProgramData, 'HeatTreatmentDigitalTwin', 'machine-identity.json');
const license = require(path.join(process.env.SMOKE_REPO_ROOT, 'backend/services/license.js'));
assert.equal(license.getLocalMachineId().available, true);
`;
for (let index = 0; index < 2; index++) {
    const run = spawnSync(process.execPath, ['-e', code], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr || run.error?.message);
}
assert.ok(fs.existsSync(isolated.LICENSE_MACHINE_STATE_FILE));
assert.deepEqual(fs.readdirSync(fakeMachineRoot), ['sentinel.txt']);
assert.equal(fs.readFileSync(path.join(fakeMachineRoot, 'sentinel.txt'), 'utf8'), 'unchanged');
const result = { success: true, directory, programData: isolated.ProgramData,
    checks: { asciiPrivateProgramData: true, childEnvironmentCaseAliasesMatch: true,
        realLicenseIdentityWrittenOnlyInPrivateRoot: true, existingMachineSentinelUnchanged: true } };
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
