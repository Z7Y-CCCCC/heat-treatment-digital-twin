'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRunDirectory } = require('../../backend/scripts/integration-test-utils.cjs');
const root = path.resolve(__dirname, '../..'), directory = createRunDirectory('ui-origin-recovery');
function run(exe, args, filename) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(exe, args, { cwd: root, env, windowsHide: true, timeout: 120000, encoding: 'utf8' });
    fs.writeFileSync(path.join(directory, filename), (result.stdout || '') + (result.stderr || ''));
    if (result.error) throw result.error;
    assert.equal(result.status, 0, filename);
}
const helper = path.join(root, 'output/ui-origin-migration-helper');
run('dotnet', ['build', path.join(__dirname, 'Migration.csproj'), '--configuration', 'Debug', '--output', helper], 'build.log');
const checks = [];
for (const engine of ['WebView2', 'Electron']) {
    const output = path.join(directory, engine); fs.mkdirSync(output);
    const request = { Profile: path.join(output, 'profile'), OldOrigin: 'http://127.0.0.1:64974',
        NewOrigin: 'http://127.0.0.1:18081', Output: output, SelfTest: true };
    const file = path.join(directory, engine + '.json');
    for (let round = 0; round < 2; round++) {
        fs.writeFileSync(file, JSON.stringify(request));
        if (engine === 'WebView2') run('dotnet', [path.join(helper, 'Migration.dll'), file], engine + round + '.log');
        else run(path.join(root, 'desktop/node_modules/electron/dist/electron.exe'), [path.join(__dirname, 'electron.cjs'), '--request', file], engine + round + '.log');
        const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json')));
        assert.equal(result.success, true); assert.equal(result.sourceCount, 2); assert.equal(result.verifiedCount, 2); assert.equal(result.sourceUnmodified, true);
        checks.push({ engine, round, sourceCount: result.sourceCount, verifiedCount: result.verifiedCount });
        request.SelfTest = false; // Second run proves disk persistence/idempotence without seeding.
    }
}
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: true, directory, checks }, null, 2));
console.log(JSON.stringify({ success: true, directory, checks }, null, 2));
