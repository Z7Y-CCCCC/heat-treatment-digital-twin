const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveNativeClientPath, validateNativeClientFiles } = require('../nativeClientPath.cjs');

test('Windows native client uses the physical directory rather than a long junction spelling', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-native-path-test-'));
    t.after(() => {
        if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('dt-native-path-test-')) throw new Error('Unsafe cleanup target');
        fs.rmSync(root, { recursive: true, force: true });
    });
    const physical = path.join(root, 'client'), alias = path.join(root, 'long-' + 'a'.repeat(120), 'client');
    fs.mkdirSync(physical); fs.mkdirSync(path.dirname(alias));
    fs.symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const resolved = resolveNativeClientPath(alias, { platform: 'win32' });
    assert.equal(resolved, fs.realpathSync.native(physical));
    assert.ok(resolved.length < alias.length - 100);
    assert.equal(resolveNativeClientPath(resolved, { platform: 'win32' }), resolved);
    assert.equal(resolveNativeClientPath(alias, { platform: 'linux' }), alias);
});

test('missing Mono and player files fail before launching an opaque native error dialog', () => {
    const directory = path.resolve('fixture-native-client');
    const files = new Set(['HeatTreatmentDigitalTwin.exe', 'UnityPlayer.dll', 'HeatTreatmentDigitalTwin_Data/Managed/Assembly-CSharp.dll'].map(p => path.join(directory, p)));
    const io = { existsSync: p => files.has(p) };
    assert.throws(() => validateNativeClientFiles(directory, { io }), /mono-2.0-bdwgc/);
    files.add(path.join(directory, 'MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll'));
    assert.doesNotThrow(() => validateNativeClientFiles(directory, { io }));
    assert.equal(resolveNativeClientPath(path.join(directory, 'missing'), { io, platform: 'win32' }), path.join(directory, 'missing'));
});
