const assert = require('node:assert/strict');
const fs = require('node:fs'), crypto = require('node:crypto');
const { getBuiltinModels, mergeBuiltinModels } = require('../services/builtinModels');
const { validateInspection } = require('../../shared/inspectionConfig.cjs');
const id = 'cad_tempering_furnace_091300', builtin = getBuiltinModels().find(m => m.id === id);
const defaults = JSON.parse(builtin.metadata);
assert.equal(defaults.inspection.parts.length, 19);
assert.equal(validateInspection(defaults.inspection).valid, true);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require('node:path').join(__dirname, '../assets/models', id + '.glb'))).digest('hex'), defaults.sourceAsset.sha256);
const legacy = { marker: { preserve: true }, partBindings: [{ id: 'plc', action: 'translate' }],
    inspection: { enabled: false, offset_space: 'parent', parts: [], labels: { enabled: false },
        solid: { camera: { yaw: 12 } }, shell: { opacity: .31 } } };
const record = { ...builtin, name: '客户回火炉', metadata: JSON.stringify(legacy) }, original = structuredClone(record);
const resolve = row => mergeBuiltinModels([row]).find(m => m.id === id);
const next = JSON.parse(resolve(record).metadata);
assert.deepEqual(record, original, 'reads never rewrite or mutate the stored record');
assert.deepEqual(next.marker, legacy.marker); assert.deepEqual(next.partBindings, legacy.partBindings);
assert.equal(next.inspection.enabled, false); assert.equal(next.inspection.labels.enabled, false);
assert.equal(next.inspection.solid.camera.yaw, 12); assert.equal(next.inspection.shell.opacity, .31);
assert.equal(next.inspection.offset_space, 'model'); assert.equal(next.inspection.parts.length, 19);
const authored = { ...legacy, inspection: { ...legacy.inspection, parts: [{ id: 'custom', node_name: 'custom', explode_offset: [9, 8, 7] }] } };
assert.equal(resolve({ ...record, metadata: JSON.stringify(authored) }).metadata, JSON.stringify(authored));
for (const row of [
    { ...record, file_path: '/uploads/models/replacement.glb' },
    { ...record, metadata: JSON.stringify({ ...legacy, sourceAsset: { sha256: '0'.repeat(64) } }) },
    { ...record, metadata: '{invalid' }, { ...record, metadata: JSON.stringify({ inspection: { parts: 'invalid' } }) },
    { ...record, metadata: JSON.stringify({ inspection: 'invalid' }) },
    { ...record, metadata: JSON.stringify({ inspection: { parts: [], shell: { node_names: ['custom_shell'] } } }) }
]) assert.equal(resolve(row).metadata, row.metadata, 'replacement and invalid documents are not silently repaired');
const objectRecord = { ...record, metadata: structuredClone(legacy) };
assert.equal(resolve(objectRecord).metadata.inspection.parts.length, 19);
assert.deepEqual(objectRecord.metadata, legacy, 'MySQL JSON object is not mutated');
const policy = process.env.APP_EMPTY_INSTALL;
try { process.env.APP_EMPTY_INSTALL = '1'; assert.equal(getBuiltinModels().length, 0); assert.equal(mergeBuiltinModels([]).length, 0); assert.equal(resolve(record).metadata, record.metadata); }
finally { if (policy === undefined) delete process.env.APP_EMPTY_INSTALL; else process.env.APP_EMPTY_INSTALL = policy; }
console.log('PASS 19 real CAD assemblies; immutable legacy fallback; custom layouts, bindings, replacements and empty installs preserved');
