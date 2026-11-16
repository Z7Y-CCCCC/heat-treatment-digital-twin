'use strict';
// Synthetic, self-contained assets for the isolated workspace acceptance test.
// No commissioned model, export, database, PLC address or credential is read.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
const { encodeGlb } = require('../backend/services/motionAuthoring');
const { normalizeModelMetadata } = require('../backend/services/modelAssetMetadata');
const assets = require('../backend/services/modelAssetBundle');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function visibleGlb(marker = 'complete') {
    const { BoxGeometry } = require('../backend/node_modules/three');
    const geometry = new BoxGeometry(.65, 1.5, .4).toNonIndexed();
    const positions = Buffer.from(geometry.attributes.position.array.buffer), normals = Buffer.from(geometry.attributes.normal.array.buffer);
    const binary = Buffer.concat([positions, normals]);
    const document = { asset: { version: '2.0', generator: 'isolated-model-workspace-fixture' }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name: 'FixtureRoot', children: [1, 2] }, { name: 'Door', mesh: 0, translation: [-.6, 0, 0] }, { name: 'Fan', mesh: 0, translation: [.6, 0, 0] }],
        buffers: [{ byteLength: binary.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 }, { buffer: 0, byteOffset: positions.length, byteLength: normals.length, target: 34962 }],
        accessors: [{ bufferView: 0, componentType: 5126, count: geometry.attributes.position.count, type: 'VEC3', min: [-.325, -.75, -.2], max: [.325, .75, .2] }, { bufferView: 1, componentType: 5126, count: geometry.attributes.normal.count, type: 'VEC3' }],
        materials: [{ name: 'Fixture steel', pbrMetallicRoughness: { baseColorFactor: [.28, .48, .64, 1], metallicFactor: .25, roughnessFactor: .55 } }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }], extras: { marker } };
    return encodeGlb(document, [{ type: 0x4e4f534a, bytes: Buffer.alloc(0) }, { type: 0x004e4942, bytes: binary }]);
}
const binding = (id, label, node, end = 1) => ({ id, name: label, node_name: node, action: 'translate', axis: 'y', source_group: 'status', source_key: id + '_feedback', input_min: 0, input_max: 1, output_min: 0, output_max: end });
const motion = (bytes, modelId, clips) => ({ schemaVersion: 1, modelId, sourceSha256: sha(bytes), rigSha256: sha(bytes),
    endpointConvention: { door: { closed: 0, open: 1 } },
    nodes: [{ name: 'Door', p: [-.6, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], v: [1] }, { name: 'Fan', p: [.6, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], v: [1] }],
    clips: clips.map(({ id, label, node, end = 1 }) => ({ id, label, mode: 'position', duration: 1, count: 3,
        tracks: [{ node, channel: 'p', size: 3, values: [node === 'Door' ? -.6 : .6, 0, 0, node === 'Door' ? -.6 : .6, end / 2, 0, node === 'Door' ? -.6 : .6, end, 0] }] })) });

async function writePackage(filename, source, metadata, clips = [], sourceId = 'workspace_source') {
    requireTestPath(filename);
    const entries = new Map([['model.glb', source]]);
    if (clips.length) { entries.set('motion.glb', source); entries.set('motion.json', Buffer.from(JSON.stringify(motion(source, sourceId, clips)))); }
    const model = { id: sourceId, name: '模块化设备 · 资产验收', asset_type: 'model', placement_level: 'device', default_scale: 1, tags: ['workspace-fixture'], metadata: normalizeModelMetadata(metadata, { name: '模块化设备' }) };
    entries.set('manifest.json', Buffer.from(JSON.stringify({ format: assets.FORMAT, version: 1, model,
        files: [...entries].map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha(bytes) })) })));
    await assets.writeZip(filename, entries); return filename;
}
async function createAssets(directory) {
    requireTestPath(directory); fs.mkdirSync(directory, { recursive: true });
    const source = visibleGlb(), inspection = { version: 2, enabled: true, offset_space: 'model', parts: [
        { id: 'door-part', name: '门板', node_names: ['Door'], explode_offset: [-1.2, 0, 0] },
        { id: 'fan-part', name: '风机', node_names: ['Fan'], explode_offset: [1.2, 0, 0] }
    ] };
    const metadata = { assetSpec: { version: '1.0.0', device_family: '模块化设备', unit: 'm', axis_rule: 'Y-up / Z-forward' },
        inspection, disassemblyLayout: { version: 1, configured: true }, partBindings: [binding('door', '开门', 'Door')],
        loadingPorts: { version: 1, inlet: { position: [0, 0, .2], direction: [0, 0, 1], nodeName: 'Door' }, outlet: null },
        preserveFixture: { unrelatedMetadata: true }, endpointConvention: { door: { closed: 0, open: 1 } } };
    const complete = await writePackage(path.join(directory, 'complete.zip'), source, metadata, [{ id: 'door', label: '开门', node: 'Door' }]);
    const fan = await writePackage(path.join(directory, 'supplement-fan.zip'), source, { partBindings: [binding('fan', '风机', 'Fan')], preserveFixture: metadata.preserveFixture }, [{ id: 'fan', label: '风机', node: 'Fan' }]);
    const layout = await writePackage(path.join(directory, 'supplement-layout.zip'), source, { inspection: { ...inspection, parts: inspection.parts.map(part => part.id === 'door-part' ? { ...part, explode_offset: [-2.4, 0, 0] } : part) }, disassemblyLayout: { version: 1, configured: true } });
    const replaceDoor = await writePackage(path.join(directory, 'replace-door.zip'), source, { partBindings: [binding('door', '开门', 'Door', 1.8)] }, [{ id: 'door', label: '开门', node: 'Door', end: 1.8 }]);
    const raw = path.join(directory, 'standalone.glb'); fs.writeFileSync(raw, visibleGlb('raw-no-configuration'));
    for (const filename of [complete, fan, layout, replaceDoor]) await assets.inspectAsset(filename);
    return { complete, fan, layout, replaceDoor, raw, sourceSha256: sha(source) };
}
module.exports = { createAssets, visibleGlb, writePackage };
