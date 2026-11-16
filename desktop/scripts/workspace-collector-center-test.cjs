'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ensureWorkspaceCollectorCenter } = require('./ensure-workspace-collector-center.cjs');
function fixture(t) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-center-ui-'));
    t.after(() => fs.rmSync(project, { recursive: true, force: true }));
    for (const [name, text] of Object.entries({ 'collector-center/CenterForm.cs': 'UI V1',
        'collector-center/app.manifest': 'MANIFEST', 'collector-center/HeatTreatmentCollectorCenter.exe.config': 'CONFIG',
        'desktop/scripts/build-collector-center.cjs': 'BUILDER', 'desktop/assets/icon.ico': 'ICON' })) {
        fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true }); fs.writeFileSync(path.join(project, name), text);
    }
    let builds = 0;
    const build = output => { builds++; fs.writeFileSync(path.join(output, 'HeatTreatmentCollectorCenter.exe'), 'UI-' + builds);
        fs.writeFileSync(path.join(output, 'HeatTreatmentCollectorCenter.exe.config'), 'CONFIG'); };
    return { project, build, get builds() { return builds; } };
}
test('launcher UI uses verified source-matched cache; updates use new paths without overwriting an open old UI', t => {
    const f = fixture(t), a = ensureWorkspaceCollectorCenter(f), b = ensureWorkspaceCollectorCenter(f);
    assert.equal(a.uiOnly, true); assert.equal(a.reused, false); assert.equal(b.reused, true); assert.equal(f.builds, 1);
    fs.writeFileSync(path.join(f.project, 'collector-center/CenterForm.cs'), 'UI V2');
    const c = ensureWorkspaceCollectorCenter(f); assert.notEqual(c.executable, a.executable); assert.equal(f.builds, 2);
    assert.equal(fs.readFileSync(a.executable, 'utf8'), 'UI-1');
    assert.equal(fs.readFileSync(c.executable, 'utf8'), 'UI-2');
    assert.equal(fs.existsSync(path.join(f.project, 'collector-runtime')), false, 'UI build never creates a second service runtime');
});
test('both executable and config hashes are checked before reusing workspace UI', t => {
    const f = fixture(t), a = ensureWorkspaceCollectorCenter(f);
    fs.writeFileSync(a.executable, 'TAMPERED'); assert.equal(ensureWorkspaceCollectorCenter(f).reused, false);
    fs.writeFileSync(a.executable + '.config', 'TAMPERED'); assert.equal(ensureWorkspaceCollectorCenter(f).reused, false);
    assert.equal(f.builds, 3);
});
test('compile failures do not fall back to installed UI and do not leave a lock', t => {
    const f = fixture(t);
    assert.throws(() => ensureWorkspaceCollectorCenter({ project: f.project, build() { throw Error('BUILD_FAILED'); } }), /BUILD_FAILED/);
    assert.equal(ensureWorkspaceCollectorCenter(f).reused, false);
});
test('source changes during compilation refuse to certify a stale UI', t => {
    const f = fixture(t);
    assert.throws(() => ensureWorkspaceCollectorCenter({ project: f.project, build(output) {
        f.build(output); fs.writeFileSync(path.join(f.project, 'collector-center/CenterForm.cs'), 'CHANGED');
    } }), /源码在编译期间改变/);
});
test('startup command prepares both current UIs and the desktop limits workspace selection to unpackaged explicit launches', () => {
    const root = path.resolve(__dirname, '../..');
    const launcher = fs.readFileSync(path.join(root, '启动大屏.cmd'), 'utf8');
    assert.match(launcher, /set "ENSURE_CENTER=%APP_DIR%\\scripts\\ensure-workspace-collector-center\.cjs"/);
    assert.match(launcher, /"%NODE_EXE%" "%ENSURE_CENTER%"\r?\nif errorlevel 1 goto failed/);
    assert.match(launcher, /start .*--disable-http-cache --workspace-ui/);
    const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
    assert.match(main, /const workspaceUi = !app\.isPackaged && process\.argv\.includes\('--workspace-ui'\)/);
    assert.match(main, /workspaceUi\s*\? require\('\.\/scripts\/ensure-workspace-collector-center.cjs'\)\.ensureWorkspaceCollectorCenter\(\)\.executable/);
    assert.match(main, /DIGITAL_TWIN_WORKSPACE_CENTER: workspaceUi \? '1' : ''/);
});
