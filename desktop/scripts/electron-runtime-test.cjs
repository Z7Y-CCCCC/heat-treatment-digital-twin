const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runtimeReady, ensureElectronRuntime } = require('./ensure-electron-runtime.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-electron-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '43.1.1' }));
    return root;
}
function install(root, version = '43.1.1') {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'version'), version);
    fs.writeFileSync(path.join(root, 'path.txt'), 'electron.exe');
    for (const name of ['electron.exe', 'icudtl.dat', 'resources.pak']) fs.writeFileSync(path.join(root, 'dist', name), 'fixture');
}
test('npm-installed package without a runtime is explicitly restored', t => {
    const root = fixture(t);
    assert.equal(runtimeReady(root), false);
    assert.equal(ensureElectronRuntime(root, install), path.join(root, 'dist', 'electron.exe'));
    assert.equal(runtimeReady(root), true);
});
test('valid cached runtime is reused without downloading', t => {
    const root = fixture(t); install(root);
    ensureElectronRuntime(root, () => assert.fail('Should reuse the installed runtime'));
});
test('wrong version and incomplete runtime are repaired', t => {
    const root = fixture(t); install(root, '42.0.0');
    ensureElectronRuntime(root, install);
    fs.unlinkSync(path.join(root, 'dist', 'resources.pak'));
    ensureElectronRuntime(root, install);
    assert.equal(runtimeReady(root), true);
});
test('an unsuccessful runtime restoration fails the build', t => {
    const root = fixture(t);
    assert.throws(() => ensureElectronRuntime(root, () => {}), /runtime is incomplete/);
});
