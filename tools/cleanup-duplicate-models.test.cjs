'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const cleanup = require('./cleanup-duplicate-models.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cleanup-unit-'));
  const roots = { assets: path.join(directory, 'assets'), uploads: path.join(directory, 'uploads') };
  const [copyId, originalId] = cleanup.PAIRS[0], token = copyId.slice(6);
  fs.mkdirSync(path.join(roots.assets, 'models'), { recursive: true });
  fs.mkdirSync(path.join(roots.assets, 'motions'), { recursive: true });
  fs.mkdirSync(path.join(roots.uploads, 'projects', token), { recursive: true });
  const source = Buffer.from('exactly-the-same-test-glb'), rig = Buffer.from('exactly-the-same-rig');
  const clip = id => Buffer.from(JSON.stringify({ schemaVersion: 1, modelId: id, sourceSha256: sha(source), rigSha256: sha(rig), nodes: [], clips: [{ id: 'push', samples: [0, .5, 1] }] }));
  const sourceClip = clip(originalId), copyClip = clip(copyId);
  const builtinMotion = { sourcePath: '/assets/models/' + originalId + '.glb', sourceSha256: sha(source), rigPath: '/assets/motions/' + originalId + '.glb', rigSha256: sha(rig), clipPath: '/assets/motions/' + originalId + '.json', clipSha256: sha(sourceClip), actions: [{ id: 'push', label: '推料', mode: 'position', duration: 4, channels: ['fork:p'] }] };
  const motion = { ...builtinMotion, sourcePath: '/uploads/projects/' + token + '/model.glb', rigPath: '/uploads/projects/' + token + '/motion.glb', clipPath: '/uploads/projects/' + token + '/motion.json', clipSha256: sha(copyClip) };
  const sourceMeta = { sourceAsset: { sha256: sha(source), filename: 'original-cad.glb' }, inspection: { enabled: true, parts: [{ id: 'fork', node: 'fork' }] }, partBindings: [], loadingPorts: { version: 1, inlet: { position: [0, 1.25, 0], direction: [0, 0, 1] } } };
  const copyMeta = { ...structuredClone(sourceMeta), assetImport: { requestId: 'test-request-abcdefgh', packageSha256: 'f'.repeat(64) }, motionAuthoring: { version: 1, actions: [], bundle: motion } };
  delete copyMeta.loadingPorts;
  const original = { id: originalId, name: '水冷槽', asset_type: 'model', placement_level: 'device', default_scale: 1, factory_id: null, tags: ['packaged', 'cad'], file_path: builtinMotion.sourcePath, metadata: sourceMeta };
  const copy = { ...structuredClone(original), id: copyId, factory_id: 'factory_default', tags: ['cad'], file_path: motion.sourcePath, metadata: copyMeta };
  for (const [url, bytes] of [[builtinMotion.sourcePath, source], [motion.sourcePath, source], [builtinMotion.rigPath, rig], [motion.rigPath, rig], [builtinMotion.clipPath, sourceClip], [motion.clipPath, copyClip]]) {
    const prefix = url.startsWith('/assets/') ? '/assets/' : '/uploads/';
    fs.writeFileSync(path.join(prefix === '/assets/' ? roots.assets : roots.uploads, url.slice(prefix.length)), bytes);
  }
  return { directory, roots, original, copy, builtinMotion, dispose() {
    const parent = fs.realpathSync(os.tmpdir()), target = fs.realpathSync(directory);
    assert.equal(path.dirname(target), parent); assert.match(path.basename(target), /^model-cleanup-unit-/);
    fs.rmSync(target, { recursive: true, force: true });
  } };
}
test('verified source + rig + clip modelId-only differences reuse source without touching ports', () => {
  const f = fixture(); try {
    const before = cleanup.stable([f.original, f.copy]);
    const result = cleanup.verifyPair(f.original, f.copy, f.builtinMotion, f.roots);
    assert.equal(result.fileEvidence.length, 6); assert.equal(result.sourcePortsRetained, true);
    assert.equal(cleanup.stable([f.original, f.copy]), before);
  } finally { f.dispose(); }
});
test('authored actions, custom ports, changed bindings, sourceAsset and unknown bundle fields abort', () => {
  const f = fixture(); try {
    for (const mutate of [
      m => { m.metadata.motionAuthoring.actions.push({ id: 'authored' }); },
      m => { m.metadata.loadingPorts = structuredClone(f.original.metadata.loadingPorts); },
      m => { m.metadata.loadingPorts = null; },
      m => { m.metadata.partBindings.push({ id: 'different-node' }); },
      m => { m.metadata.sourceAsset.filename = 'independent.glb'; },
      m => { m.metadata.motionAuthoring.bundle.hidden = true; },
      m => { m.default_scale = 2; },
      m => { m.tags.push('independent'); }
    ]) {
      const copy = structuredClone(f.copy); mutate(copy);
      assert.throws(() => cleanup.verifyPair(f.original, copy, f.builtinMotion, f.roots));
    }
  } finally { f.dispose(); }
});
test('binary mutation aborts even while database metadata is unchanged', () => {
  const f = fixture(); try {
    fs.appendFileSync(cleanup.resolveAsset(f.copy.file_path, f.roots), 'changed');
    assert.throws(() => cleanup.verifyPair(f.original, f.copy, f.builtinMotion, f.roots), /资产文件已变化/);
  } finally { f.dispose(); }
});
test('different motion samples abort even if imported clip hash is recalculated', () => {
  const f = fixture(); try {
    const bundle = f.copy.metadata.motionAuthoring.bundle, filename = cleanup.resolveAsset(bundle.clipPath, f.roots);
    const clip = JSON.parse(fs.readFileSync(filename)); clip.clips[0].samples[1] = .75;
    const bytes = Buffer.from(JSON.stringify(clip)); fs.writeFileSync(filename, bytes); bundle.clipSha256 = sha(bytes);
    assert.throws(() => cleanup.verifyPair(f.original, f.copy, f.builtinMotion, f.roots), /动作采样数据不同/);
  } finally { f.dispose(); }
});
test('asset resolver rejects traversal and non-local URLs', () => {
  const f = fixture(); try {
    assert.throws(() => cleanup.resolveAsset('/assets/../outside.glb', f.roots), /越界/);
    assert.throws(() => cleanup.resolveAsset('/uploads/%2e%2e/outside.glb', f.roots), /越界/);
    assert.throws(() => cleanup.resolveAsset('https://example.test/model.glb', f.roots), /非本地/);
  } finally { f.dispose(); }
});
const permittedRefs = () => Object.entries(cleanup.EXPECTED_DEVICES).map(([id, copy]) => ({ copy, table: 'devices', id, column: 'model_type', path: '' }));
test('only the two approved device refs and own transport paths are permitted', () => {
  const copy = cleanup.PAIRS[0][0], refs = [...permittedRefs(), { copy, table: 'models', id: copy, column: 'metadata', path: 'motionAuthoring.bundle.sourcePath' }];
  cleanup.assertReferences(refs);
  for (const unexpected of [
    { copy, table: 'devices', id: 'another-device', column: 'model_type', path: '' },
    { copy, table: 'scenes', id: 'scene', column: 'config', path: 'models[0].id' },
    { copy, table: 'models', id: copy, column: 'metadata', path: 'partBindings[0].targetModel' }
  ]) assert.throws(() => cleanup.assertReferences([...refs, unexpected]), /计划外/);
  assert.throws(() => cleanup.assertReferences(refs.slice(1)), /设备引用已变化/);
});
test('reference scan catches JSON text, nested map keys, full URLs and project prefix paths', () => {
  const copy = cleanup.PAIRS[0][0], token = copy.slice(6), columns = [{ TABLE_NAME: 'scenes', COLUMN_NAME: 'config', DATA_TYPE: 'json' }];
  const rows = { scenes: [{ id: 'scene', config: JSON.stringify({ [copy]: 'name', nested: [{ url: 'http://127.0.0.1:3001/uploads/projects/' + token + '/motion.json?v=1' }] }) }] };
  const refs = cleanup.findReferences(rows, columns);
  assert.equal(refs.length, 2); assert.ok(refs.some(ref => ref.path.includes('<key>'))); assert.ok(refs.some(ref => ref.path.includes('nested[0].url')));
});
test('expected changes preserve all other device/PLC/layout fields and all original ports', () => {
  const models = cleanup.PAIRS.flatMap(([copy, original]) => [
    { id: original, name: 'original', file_path: '/assets/' + original + '.glb', metadata: { loadingPorts: { inlet: [1, 2, 3] } } },
    { id: copy, name: 'copy', file_path: '/uploads/' + copy + '.glb', metadata: { inspection: { parts: [] } } }
  ]);
  models.push({ id: cleanup.VARIANT, name: cleanup.VARIANT_NAME, metadata: { loadingPorts: { inlet: [4, 5, 6] } } });
  const devices = Object.entries(cleanup.EXPECTED_DEVICES).map(([id, model_type]) => ({ id, model_type, model_file: null, line_id: 'line_a', plc_options: { rack: 3 }, pos_x: 10, scale: 2, instance_config: { actions: ['push'], layout: { z: 5 } } }));
  devices.push({ id: 'other', model_type: 'different', instance_config: { keep: true } });
  const before = { models, devices, scenes: [{ id: 'scene', config: { current: 'unchanged' } }] }, after = cleanup.expectedAfter(before);
  assert.equal(after.models.length, models.length - 7); assert.equal(after.devices.length, devices.length);
  for (const device of devices) {
    const next = after.devices.find(row => row.id === device.id);
    const expected = { ...device }; if (Object.hasOwn(cleanup.EXPECTED_DEVICES, device.id)) expected.model_type = new Map(cleanup.PAIRS).get(device.model_type);
    assert.deepEqual(next, expected);
  }
  for (const [, id] of cleanup.PAIRS) assert.deepEqual(after.models.find(model => model.id === id), models.find(model => model.id === id));
  assert.deepEqual(after.models.find(model => model.id === cleanup.VARIANT), { ...models.find(model => model.id === cleanup.VARIANT), name: cleanup.RENAMED_VARIANT });
  assert.deepEqual(after.scenes, before.scenes); assert.equal(before.models.length, models.length);
});
test('durable backups are verified and never overwrite an existing backup', () => {
  const f = fixture(); try {
    const filename = path.join(f.directory, 'backup.json'), value = { models: [f.original], devices: [], secret: 'not-a-real-secret' };
    const digest = cleanup.writeVerifiedJson(filename, value);
    assert.equal(digest, sha(fs.readFileSync(filename))); assert.deepEqual(JSON.parse(fs.readFileSync(filename)), JSON.parse(cleanup.stable(value)));
    assert.throws(() => cleanup.writeVerifiedJson(filename, { overwritten: true }), /EEXIST/);
  } finally { f.dispose(); }
});
test('audited row guard aborts missing or changed live models without accepting a new baseline', () => {
  assert.throws(() => cleanup.verifyAuditRows([]), /独立审计快照/);
  assert.throws(() => cleanup.verifyAuditRows([{ id: cleanup.PAIRS[0][0], metadata: { changed: true } }]), /独立审计快照/);
});
