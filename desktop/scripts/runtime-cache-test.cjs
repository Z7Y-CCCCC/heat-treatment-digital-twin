const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTreeManifest, verifyFileManifest } = require('./runtime-cache.cjs');

test('runtime cache validates nested DLLs and invalidates changed or missing files', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cache-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'locales'));
    fs.writeFileSync(path.join(root, 'runtime.exe'), 'executable');
    const nested = path.join(root, 'locales', 'zh.dll');
    fs.writeFileSync(nested, 'original');
    const manifest = createTreeManifest(root);
    assert.equal(verifyFileManifest(root, manifest), true);
    fs.writeFileSync(nested, 'modified');
    assert.equal(verifyFileManifest(root, manifest), false);
    fs.writeFileSync(nested, 'original');
    assert.equal(verifyFileManifest(root, manifest), true);
    fs.unlinkSync(nested);
    assert.equal(verifyFileManifest(root, manifest), false);
});

test('runtime cache rejects malformed and escaping manifests', () => {
    for (const manifest of [null, [], [{}], [{ name: '../outside', sha256: 'x' }], [{ name: '/absolute', sha256: 'x' }]]) {
        assert.equal(verifyFileManifest(os.tmpdir(), manifest), false);
    }
});
