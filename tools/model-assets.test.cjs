const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('./model-assets.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-assets-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('model-assets-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  fs.mkdirSync(path.join(root, 'backend/assets/models'), { recursive: true });
  const file = Buffer.alloc(20); file.write('glTF'); file.writeUInt32LE(2, 4); file.writeUInt32LE(20, 8);
  fs.writeFileSync(path.join(root, 'backend/assets/models/炉.glb'), file);
  fs.writeFileSync(path.join(root, 'model-assets.aliases.json'), JSON.stringify({ mirrors: [], uploads: [{ source: 'backend/assets/models/炉.glb', target: 'backend/uploads/models/local.glb' }] }));
  api.main(root, ['--update']); return root;
}
test('Unicode model path and deterministic manifest', t => {
  const root = fixture(t); const before = fs.readFileSync(path.join(root, 'model-assets.manifest.json'));
  api.main(root, ['--update']); assert.deepEqual(fs.readFileSync(path.join(root, 'model-assets.manifest.json')), before);
  assert.equal(api.main(root, ['--check']).valid, true);
});
test('changed, missing and unregistered models fail', t => {
  const root = fixture(t); const p = path.join(root, 'backend/assets/models/炉.glb');
  const data = fs.readFileSync(p); data[16] = 2; fs.writeFileSync(p, data);
  assert.throws(() => api.main(root, ['--check']), /内容已变/);
  fs.renameSync(p, path.join(root, 'backend/assets/models/new.glb'));
  assert.throws(() => api.main(root, ['--check']), /尚未纳入清单/);
});
test('unhydrated LFS pointer is rejected', t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'backend/assets/models/炉.glb'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 20\n');
  assert.throws(() => api.main(root, ['--check']), /git lfs pull/);
});
test('restore missing uploads, never overwrite another version', t => {
  const root = fixture(t); assert.equal(api.main(root, ['--restore-uploads']).restoredUploads, 1);
  const p = path.join(root, 'backend/uploads/models/local.glb'); fs.writeFileSync(p, 'local edit');
  assert.throws(() => api.main(root, ['--restore-uploads']), /未覆盖/); assert.equal(fs.readFileSync(p, 'utf8'), 'local edit');
});
test('traversal and off-main sync fail before writes or network', t => {
  const root = fixture(t); assert.throws(() => api.safe(root, '../outside.glb'), /Unsafe/);
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/codex/test'], { cwd: root, windowsHide: true });
  assert.throws(() => api.main(root, ['--sync']), /不是 main/);
});
test('gltf external resource is included and checked', t => {
  const root = fixture(t); const folder = path.join(root, 'backend/assets/models');
  fs.writeFileSync(path.join(folder, 'scene.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'buffer.bin' }] }));
  fs.writeFileSync(path.join(folder, 'buffer.bin'), 'mesh'); api.main(root, ['--update']);
  fs.writeFileSync(path.join(folder, 'buffer.bin'), 'changed'); assert.throws(() => api.main(root, ['--check']), /内容已变/);
});
