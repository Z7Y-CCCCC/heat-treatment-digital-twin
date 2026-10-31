import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useManualDisassemblyPage } from '../src/views/admin/composables/useManualDisassemblyPage.js'
const copy = value => JSON.parse(JSON.stringify(value))
const layout = () => ({ version: 2, enabled: true, offset_space: 'model', parts: [
  { id: 'hood', node_name: 'hood', explode_offset: [0, 1, 0], explode_rotation: [0, 0, 0] },
  { id: 'base', node_name: 'base', explode_offset: [0, 0, 0], explode_rotation: [0, 0, 0] }
] })
function fixture(answers = []) {
  const models = ref(['a', 'b', 'unused'].map(id => ({ id, name: `型号 ${id}`, placement_level: 'device', asset_type: 'model',
    file_path: `/${id}.glb`, metadata: JSON.stringify({ inspection: layout(), customer: { Case: 'ABC' }, partBindings: [{ node: 'hood', point: 'temperature' }] }) })))
  models.value.push({ id: 'hall', placement_level: 'factory', asset_type: 'environment', file_path: '/hall.glb' }, { id: 'no-file', placement_level: 'device' })
  const snapshots = new Map(models.value.slice(0, 3).map(m => [m.id, { modelId: m.id, inspection: layout(), revision: m.id.repeat(64), source: 'model', assetRevision: m.file_path }]))
  const calls = { reads: [], saves: [], asks: [], discards: 0 }
  const api = {
    async getModelInspection(id) { calls.reads.push(id); return copy(snapshots.get(id)) },
    async saveModelInspection(id, payload) {
      calls.saves.push({ id, payload: copy(payload) })
      const next = copy(snapshots.get(id)); next.revision = `saved-${id}`
      for (const patch of payload.parts) next.inspection.parts.find(p => p.id === patch.id).explode_offset = patch.explode_offset
      snapshots.set(id, next); return { success: true, ...next }
    },
    getDeviceInspection() { assert.fail('model editing must not read a device instance') },
    saveDeviceInspection() { assert.fail('model editing must not write a device instance') }
  }
  const state = useManualDisassemblyPage({ models, api, scope: 'model', initialModelId: 'a', ask: async options => { calls.asks.push(options); return answers.shift() } })
  let draft
  const editor = { getDraft: () => copy(draft), discardChanges() { calls.discards++; draft = copy(state.inspection.value) } }
  state.setEditorGetter(() => editor)
  return { models, snapshots, calls, api, state, editor, async load() { await state.ensureSelection(); draft = copy(state.inspection.value) },
    edit(offset = [9, 8, 7]) { draft.parts[0].explode_offset = offset; state.dirty.value = true; return copy(draft) }, draft: () => copy(draft) }
}

test('model choices include every usable device model, even without a single installed instance', async () => {
  const f = fixture(); await f.load()
  assert.deepEqual(f.state.choices.value.map(m => m.id), ['a', 'b', 'unused'])
  assert.equal(f.state.model.value.id, 'a'); assert.equal(f.state.device.value, null)
  assert.deepEqual(f.calls.reads, ['a'])
  await f.state.selectModel('unused'); assert.equal(f.state.model.value.id, 'unused')
  await f.state.ensureSelection(); assert.deepEqual(f.calls.reads, ['a', 'unused'])
})

for (const asObject of [false, true]) test(`model save updates only model metadata (${asObject ? 'object' : 'JSON'})`, async () => {
  const f = fixture(); if (asObject) f.models.value[0].metadata = JSON.parse(f.models.value[0].metadata)
  await f.load(); f.edit()
  const original = copy(f.models.value[0]), peer = copy(f.models.value[1])
  assert.equal(await f.state.save(), true)
  assert.equal(f.calls.saves[0].id, 'a')
  const stored = asObject ? f.models.value[0].metadata : JSON.parse(f.models.value[0].metadata)
  assert.deepEqual(stored.customer, { Case: 'ABC' }); assert.deepEqual(stored.partBindings, [{ node: 'hood', point: 'temperature' }])
  assert.deepEqual(stored.inspection.parts[0].explode_offset, [9, 8, 7])
  for (const key of Object.keys(original)) if (key !== 'metadata') assert.deepEqual(f.models.value[0][key], original[key])
  assert.deepEqual(f.models.value[1], peer); assert.equal(f.state.dirty.value, false)
  assert.equal(await f.state.canLeave(), true)
})

for (const answer of [false, 'secondary', true]) test(`model switching honors unsaved changes (${answer})`, async () => {
  const f = fixture([answer]); await f.load(); const draft = f.edit()
  assert.equal(await f.state.selectModel('b'), answer !== false)
  assert.equal(f.calls.saves.length, answer === true ? 1 : 0)
  assert.equal(f.calls.discards, answer === 'secondary' ? 1 : 0)
  assert.equal(f.state.selectedModelId.value, answer === false ? 'a' : 'b')
  if (answer === false) assert.deepEqual(f.draft(), draft)
})

test('model replacement, removal and page resume preserve a dirty geometry context', async () => {
  const f = fixture(); await f.load(); const draft = f.edit()
  f.models.value[0].file_path = '/replaced.glb'
  assert.equal(f.state.model.value.file_path, '/a.glb')
  f.models.value.shift(); await f.state.ensureSelection(); await f.state.loadSelected()
  assert.equal(f.state.model.value.id, 'a'); assert.deepEqual(f.draft(), draft)
  assert.equal(f.calls.reads.length, 1)
})

test('model version conflicts rebase local parts without replacing remote metadata or other part positions', async () => {
  const f = fixture(); await f.load(); f.edit()
  const latest = copy(f.snapshots.get('a')); latest.revision = 'remote'; latest.inspection.parts[1].explode_offset = [3, 2, 1]
  latest.inspection.parts[0].duration = 4; f.snapshots.set('a', latest)
  const save = f.api.saveModelInspection; let count = 0
  f.api.saveModelInspection = (id, payload) => ++count === 1 ? { error: 'changed', code: 'MODEL_INSPECTION_CONFLICT' } : save(id, payload)
  assert.equal(await f.state.save(), true)
  assert.deepEqual(f.calls.saves[0].payload.parts, [{ id: 'hood', explode_offset: [9, 8, 7] }])
  assert.equal(f.calls.saves[0].payload.revision, 'remote')
  assert.deepEqual(f.state.inspection.value.parts[1].explode_offset, [3, 2, 1]); assert.equal(f.state.inspection.value.parts[0].duration, 4)
})

test('an active model drag cannot be partially saved or switched', async () => {
  const f = fixture(); await f.load(); f.edit(); f.editor.dragging = true
  assert.equal(await f.state.save(), false); assert.equal(await f.state.selectModel('b'), false)
  assert.equal(f.calls.saves.length, 0); assert.equal(f.calls.asks.length, 0)
})

test('a failed model save keeps its draft, revision and cached metadata', async () => {
  const f = fixture(); await f.load(); const draft = f.edit(), before = f.models.value[0].metadata
  f.api.saveModelInspection = async () => ({ error: 'offline' })
  assert.equal(await f.state.save(), false); assert.deepEqual(f.draft(), draft)
  assert.equal(f.models.value[0].metadata, before); assert.equal(f.state.dirty.value, true)
})
