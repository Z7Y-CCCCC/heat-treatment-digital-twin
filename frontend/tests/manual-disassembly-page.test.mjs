import test from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { manualLayoutPayload, useManualDisassemblyPage } from '../src/views/admin/composables/useManualDisassemblyPage.js'

const clone = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const layout = id => ({ version: 2, enabled: true, offset_space: 'parent', animation_duration: 1.7,
    shell: { opacity: .2 }, extension: { owner: id }, parts: [
        { id: 'part_a', name: '部件 A', explode_offset: [1, 2, 3], explode_rotation: [11, 22, 33],
            node_name: 'part_mesh', delay: .4, duration: 1.5, camera: { yaw: 22 }, point_ids: ['point_1'] },
        { id: 'part_b', name: '部件 B', explode_offset: [-1, -2, -3], explode_rotation: [0, 0, 0],
            node_name: 'peer_mesh', duration: 1.1 }
    ] })
const snapshot = id => ({ inspection: layout(id), revision: `${id}`.repeat(64), source: 'device', modelId: 'model_1', assetRevision: 'geometry-1' })

function fixture({ answers = [], instanceAsString = true, initialDeviceId = 'a' } = {}) {
    const originalConfig = { workshop_id: 'workshop_1', movement: { path: [[1, 2, 3]] },
        user_metadata: { Case: 'ABC', nested: ['keep'] }, inspection: layout('a') }
    const devices = ref(['a', 'b', 'c'].map(id => ({ id, name: `设备 ${id}`, model_type: 'model_1',
        instance_config: instanceAsString ? JSON.stringify({ ...clone(originalConfig), id }) : { ...clone(originalConfig), id },
        pos_x: 100, plc_enabled: true, plc_ip: '192.0.2.10' })))
    const models = ref([{ id: 'model_1', file_path: '/assets/model_1.glb', metadata: { author: 'retained' } }])
    const calls = { reads: [], saves: [], asks: [], discards: 0, order: [] }
    const snapshots = new Map(['a', 'b', 'c'].map(id => [id, snapshot(id)]))
    const api = {
        async getDeviceInspection(id) { calls.reads.push(id); calls.order.push(`read:${id}`); return clone(snapshots.get(id)) },
        async saveDeviceInspection(id, payload) {
            calls.saves.push({ id, payload: clone(payload) }); calls.order.push(`save:${id}`)
            const next = clone(snapshots.get(id))
            for (const part of next.inspection.parts) {
                const update = payload.parts.find(candidate => candidate.id === part.id)
                if (update) part.explode_offset = [...update.explode_offset]
            }
            next.revision = `saved-${id}`; next.source = 'device'
            snapshots.set(id, clone(next))
            return { success: true, ...next }
        }
    }
    const ask = async options => { calls.asks.push(options); return answers.shift() }
    const state = useManualDisassemblyPage({ devices, models, api, ask, initialDeviceId })
    let draft = null
    const editor = {
        getDraft: () => clone(draft),
        discardChanges() { calls.discards += 1; draft = clone(state.inspection.value) }
    }
    state.setEditorGetter(() => editor)
    return { state, api, calls, devices, models, snapshots, originalConfig,
        async load() { await state.loadSelected(); draft = clone(state.inspection.value) },
        edit(vector = [9, 8, 7]) { draft = clone(state.inspection.value); draft.parts[0].explode_offset = [...vector]; state.dirty.value = true; return draft },
        draft: () => draft, setDraft: value => { draft = value }, editor }
}

test('manual layout payload contains only part IDs and offsets, never stale bindings or instance fields', () => {
    const input = layout('a')
    const result = manualLayoutPayload(input, 'revision-a')
    assert.deepEqual(result, { revision: 'revision-a', enabled: true, parts: [
        { id: 'part_a', explode_offset: [1, 2, 3] }, { id: 'part_b', explode_offset: [-1, -2, -3] }
    ] })
    result.parts[0].explode_offset[0] = 100
    assert.deepEqual(input.parts[0].explode_offset, [1, 2, 3], 'payload arrays do not alias the editor draft')
    assert.equal('offset_space' in result, false)
    assert.equal('instance_config' in result, false)
    assert.equal('explode_rotation' in result.parts[0], false)
})

test('payload rejects missing revision, missing/duplicate IDs and non-finite or coerced vectors', () => {
    assert.throws(() => manualLayoutPayload(layout('a'), ''), /版本/)
    assert.throws(() => manualLayoutPayload({ parts: [] }, 'rev'), /没有/)
    assert.throws(() => manualLayoutPayload({ parts: [{ id: '', explode_offset: [1, 2, 3] }] }, 'rev'), /编号/)
    assert.throws(() => manualLayoutPayload({ parts: [layout('a').parts[0], layout('a').parts[0]] }, 'rev'), /重复/)
    for (const vector of [[NaN, 0, 0], [Infinity, 0, 0], [null, 0, 0], ['1', 0, 0], [1, 2], [100001, 0, 0]]) {
        const next = layout('a'); next.parts[0].explode_offset = vector
        assert.throws(() => manualLayoutPayload(next, 'rev'), /无效/)
    }
})

test('selection resolves available devices and uses the selected instance model-file override', async () => {
    const f = fixture()
    f.devices.value[0].model_file = '/uploads/instance-specific.glb'
    f.devices.value.push({ id: 'orphan', model_type: 'unknown' })
    await f.load()
    assert.equal(f.state.device.value.id, 'a')
    assert.equal(f.state.model.value.file_path, '/uploads/instance-specific.glb')
    assert.equal(f.models.value[0].file_path, '/assets/model_1.glb')
    assert.deepEqual(f.state.choices.value.map(item => item.id), ['a', 'b', 'c'])
    assert.equal(f.state.source.value, 'device')
    assert.equal(f.state.saveRevision.value, 1)
    assert.notEqual(f.state.inspection.value, f.snapshots.get('a').inspection)
    f.state.inspection.value.parts[0].explode_offset[0] = 99
    assert.equal(f.snapshots.get('a').inspection.parts[0].explode_offset[0], 1)
})

test('ensureSelection chooses the first available device only when the current ID is missing', async () => {
    const f = fixture({ initialDeviceId: 'missing' })
    await f.state.ensureSelection()
    assert.equal(f.state.selectedDeviceId.value, 'a')
    assert.deepEqual(f.calls.reads, ['a'])
    f.devices.value = []
    await f.state.ensureSelection()
    assert.equal(f.state.selectedDeviceId.value, '')
    assert.equal(f.state.inspection.value, null)
    assert.deepEqual(f.calls.reads, ['a'])
})

test('resuming the page cannot reload over an unsaved or in-flight layout', async () => {
    const f = fixture()
    await f.load(); f.edit([12, 34, 56])
    const reads = f.calls.reads.length, draft = f.draft(), revision = f.state.saveRevision.value
    await f.state.ensureSelection()
    assert.equal(f.calls.reads.length, reads)
    assert.deepEqual(f.draft(), draft)
    assert.equal(f.state.dirty.value, true)
    assert.equal(f.state.saveRevision.value, revision)
    f.state.dirty.value = false; f.state.saving.value = true
    await f.state.ensureSelection()
    assert.equal(f.calls.reads.length, reads)
})

test('duplicate activation reads do not remount a clean model; changed configuration still reloads', async () => {
    const f = fixture(), pending = deferred()
    f.api.getDeviceInspection = id => { f.calls.reads.push(id); return pending.promise }
    const first = f.state.ensureSelection()
    await f.state.ensureSelection()
    assert.deepEqual(f.calls.reads, ['a'], 'bootstrap and activation share the pending read')
    pending.resolve(snapshot('a')); await first
    await f.state.ensureSelection()
    assert.deepEqual(f.calls.reads, ['a'], 'a loaded, unchanged layout does not reload behind the user')
    f.models.value[0].metadata.inspection = { enabled: false }
    await f.state.ensureSelection()
    assert.deepEqual(f.calls.reads, ['a', 'a'], 'external model changes invalidate the clean context')
    f.devices.value[0].instance_config = JSON.stringify({ inspection: { enabled: true } })
    await f.state.ensureSelection()
    assert.deepEqual(f.calls.reads, ['a', 'a', 'a'], 'external instance changes also invalidate it')
})

test('external asset replacement or device removal cannot unmount and silently discard an edited model', async () => {
    const f = fixture()
    await f.load(); f.edit([12, 34, 56])
    const original = clone(f.state.model.value), draft = f.draft()
    f.models.value[0].file_path = '/replaced-under-same-model-id.glb'
    assert.equal(f.state.model.value.file_path, original.file_path)
    f.models.value.push({ id: 'model_2', file_path: '/different-model.glb' })
    f.devices.value[0].model_type = 'model_2'
    assert.equal(f.state.device.value.model_type, 'model_1')
    assert.equal(f.state.model.value.id, 'model_1')
    f.devices.value = f.devices.value.filter(d => d.id !== 'a')
    assert.equal(f.state.device.value.id, 'a', 'the active draft keeps its originally loaded geometry context')
    await f.state.ensureSelection(); await f.state.loadSelected()
    assert.equal(f.calls.reads.length, 1)
    assert.deepEqual(f.draft(), draft)
    assert.equal(f.state.dirty.value, true)
})

test('saving or switching during an unfinished drag never commits a partial gesture', async () => {
    const f = fixture()
    await f.load(); f.edit([4, 5, 6]); f.editor.dragging = true
    assert.equal(await f.state.save(), false)
    assert.equal(await f.state.selectDevice('b'), false)
    assert.equal(f.state.selectedDeviceId.value, 'a')
    assert.equal(f.state.dirty.value, true)
    assert.equal(f.calls.saves.length, 0)
    assert.equal(f.calls.asks.length, 0)
})

for (const rejectOld of [false, true]) test(`late old read ${rejectOld ? 'failure' : 'success'} cannot overwrite the new device`, async () => {
    const f = fixture(), old = deferred(), current = deferred()
    f.api.getDeviceInspection = id => { f.calls.reads.push(id); return id === 'a' ? old.promise : current.promise }
    const first = f.state.loadSelected()
    const second = f.state.selectDevice('b')
    await tick()
    assert.equal(f.state.selectedDeviceId.value, 'b')
    assert.equal(f.state.loading.value, true)
    if (rejectOld) old.reject(new Error('old read offline'))
    else old.resolve(snapshot('a'))
    await first
    assert.equal(f.state.loading.value, true, 'old completion cannot clear the active spinner')
    assert.equal(f.state.status.value, '')
    assert.equal(f.state.inspection.value, null)
    current.resolve(snapshot('b')); await second
    assert.equal(f.state.inspection.value.extension.owner, 'b')
    assert.equal(f.state.revision.value, snapshot('b').revision)
    assert.equal(f.state.loading.value, false)
    assert.equal(f.state.saveRevision.value, 1)
})

test('a mismatched model read fails closed rather than editing the wrong model', async () => {
    const f = fixture()
    f.api.getDeviceInspection = async () => ({ ...snapshot('a'), modelId: 'replaced_model' })
    await f.state.loadSelected()
    assert.equal(f.state.inspection.value, null)
    assert.equal(f.state.revision.value, '')
    assert.match(f.state.status.value, /模型已变化/)
    assert.equal(f.state.loading.value, false)
})

for (const instanceAsString of [true, false]) test(`save preserves current unrelated instance fields (${instanceAsString ? 'JSON text' : 'object'})`, async () => {
    const f = fixture({ instanceAsString }), pending = deferred()
    await f.load(); f.edit([8, 9, 10])
    const initialDevice = clone(f.devices.value[0]), peer = clone(f.devices.value[1])
    let sent
    f.api.saveDeviceInspection = (id, payload) => { sent = { id, payload }; return pending.promise }
    const saving = f.state.save()
    const current = instanceAsString ? JSON.parse(f.devices.value[0].instance_config) : clone(f.devices.value[0].instance_config)
    current.user_metadata.newField = 'changed during HTTP save'
    current.movement.path.push([4, 5, 6])
    f.devices.value[0].instance_config = instanceAsString ? JSON.stringify(current) : current
    const saved = snapshot('a'); saved.inspection.parts[0].explode_offset = [8, 9, 10]; saved.revision = 'saved'
    pending.resolve({ success: true, ...saved })
    assert.equal(await saving, true)
    const stored = instanceAsString ? JSON.parse(f.devices.value[0].instance_config) : f.devices.value[0].instance_config
    assert.deepEqual(stored.user_metadata, current.user_metadata)
    assert.deepEqual(stored.movement, current.movement)
    assert.deepEqual(stored.inspection, saved.inspection)
    assert.equal(typeof f.devices.value[0].instance_config, instanceAsString ? 'string' : 'object')
    for (const [key, value] of Object.entries(initialDevice)) if (key !== 'instance_config') assert.deepEqual(f.devices.value[0][key], value)
    assert.deepEqual(f.devices.value[1], peer)
    assert.deepEqual(f.models.value[0].metadata, { author: 'retained' })
    assert.deepEqual(sent, { id: 'a', payload: manualLayoutPayload(f.draft(), snapshot('a').revision) })
    assert.equal(f.state.dirty.value, false)
    assert.equal(f.state.saving.value, false)
    assert.equal(f.state.saveRevision.value, 2)
})

for (const failure of ['network', '409', 'unconfirmed']) test(`save ${failure} retains dirty editor draft and the previous saved version`, async () => {
    const f = fixture()
    await f.load(); const draft = clone(f.edit([10, 20, 30]))
    const saved = clone(f.state.inspection.value), previousDevice = clone(f.devices.value[0])
    f.api.saveDeviceInspection = async () => {
        if (failure === 'network') throw new Error('HTTP 503 offline')
        if (failure === '409') return { error: 'HTTP 409: configuration conflict', code: 'DEVICE_INSPECTION_CONFLICT' }
        return { success: false }
    }
    assert.equal(await f.state.save(), false)
    assert.deepEqual(f.draft(), draft)
    assert.deepEqual(f.state.inspection.value, saved)
    assert.deepEqual(f.devices.value[0], previousDevice)
    assert.equal(f.state.dirty.value, true)
    assert.equal(f.state.revision.value, snapshot('a').revision)
    assert.equal(f.state.saveRevision.value, 1, 'failure does not remount and erase the editor draft')
    assert.equal(f.state.saving.value, false)
    assert.match(f.state.status.value, /保存失败.*草稿仍保留/)
})

test('cancel device switching keeps the active device and draft without an extra read or save', async () => {
    const f = fixture({ answers: [false] })
    await f.load(); const draft = clone(f.edit())
    assert.equal(await f.state.selectDevice('b'), false)
    assert.equal(f.state.selectedDeviceId.value, 'a')
    assert.deepEqual(f.draft(), draft)
    assert.equal(f.state.dirty.value, true)
    assert.deepEqual(f.calls.reads, ['a'])
    assert.equal(f.calls.saves.length, 0)
    assert.equal(f.calls.discards, 0)
    assert.equal(f.calls.asks.length, 1)
    assert.equal(f.calls.asks[0].confirmText, '保存并切换')
})

test('save-and-switch waits for the successful device-only write before loading the next device', async () => {
    const f = fixture({ answers: [true] })
    await f.load(); f.edit([2, 4, 6])
    assert.equal(await f.state.selectDevice('b'), true)
    assert.deepEqual(f.calls.order, ['read:a', 'save:a', 'read:b'])
    assert.equal(f.calls.saves[0].id, 'a')
    assert.deepEqual(f.calls.saves[0].payload.parts[0].explode_offset, [2, 4, 6])
    assert.equal(f.state.selectedDeviceId.value, 'b')
    assert.equal(f.state.inspection.value.extension.owner, 'b')
    assert.equal(f.state.dirty.value, false)
    assert.equal(f.calls.discards, 0)
})

test('409 rebases only changed parts and preserves remote offsets, metadata and bindings', async () => {
    const f = fixture(); await f.load(); f.edit([12, 34, 56])
    const latest = clone(f.snapshots.get('a')); latest.revision = 'latest'
    latest.inspection.parts[1].explode_offset = [70, 80, 90]
    latest.inspection.parts[0].duration = 3.5
    latest.inspection.parts[0].point_ids = ['new-point']
    f.snapshots.set('a', latest)
    const save = f.api.saveDeviceInspection, writes = []
    f.api.saveDeviceInspection = async (id, payload) => {
        writes.push(clone(payload))
        return writes.length === 1 ? { error: '配置已更新', code: 'DEVICE_INSPECTION_CONFLICT' } : save(id, payload)
    }
    assert.equal(await f.state.save(), true)
    assert.equal(writes.length, 2)
    assert.equal(writes[1].revision, 'latest')
    assert.deepEqual(writes[1].parts, [{ id: 'part_a', explode_offset: [12, 34, 56] }])
    assert.deepEqual(f.state.inspection.value.parts[1].explode_offset, [70, 80, 90])
    assert.equal(f.state.inspection.value.parts[0].duration, 3.5)
    assert.deepEqual(f.state.inspection.value.parts[0].point_ids, ['new-point'])
    assert.equal(f.calls.asks.length, 0)
    assert.equal(f.state.dirty.value, false)
    assert.equal(await f.state.canLeave(), true)
})

for (const confirm of [false, true]) test(`overlapping remote offset requires explicit confirmation (${confirm})`, async () => {
    const f = fixture({ answers: [confirm] }); await f.load(); const draft = clone(f.edit())
    const latest = clone(f.snapshots.get('a')); latest.revision = 'latest'
    latest.inspection.parts[0].explode_offset = [101, 102, 103]; f.snapshots.set('a', latest)
    const save = f.api.saveDeviceInspection; let writes = 0
    f.api.saveDeviceInspection = (id, payload) => ++writes === 1
        ? { error: '配置已更新', code: 'DEVICE_INSPECTION_CONFLICT' } : save(id, payload)
    assert.equal(await f.state.save(), confirm)
    assert.equal(writes, confirm ? 2 : 1)
    assert.equal(f.calls.asks[0].confirmText, '使用当前拖拽位置')
    assert.equal(f.state.dirty.value, !confirm)
    if (!confirm) assert.deepEqual(f.draft(), draft)
})

for (const change of ['asset', 'nodes', 'coordinate-space']) test(`409 never transfers offsets onto a different ${change}`, async () => {
    const f = fixture(); await f.load(); const draft = clone(f.edit())
    const latest = clone(f.snapshots.get('a')); latest.revision = 'latest'
    if (change === 'asset') latest.assetRevision = 'replacement-file'
    if (change === 'nodes') latest.inspection.parts[0].node_name = 'replaced_mesh'
    if (change === 'coordinate-space') latest.inspection.offset_space = 'model'
    f.snapshots.set('a', latest)
    let writes = 0
    f.api.saveDeviceInspection = async () => { writes++; return { error: '配置已更新', code: 'DEVICE_INSPECTION_CONFLICT' } }
    assert.equal(await f.state.save(), false); assert.equal(writes, 1)
    assert.equal(f.state.dirty.value, true); assert.deepEqual(f.draft(), draft)
    assert.match(f.state.status.value, /模型或部件结构已变化/)
})

test('a second 409 is bounded and keeps the original dirty draft', async () => {
    const f = fixture(); await f.load(); const draft = clone(f.edit())
    let writes = 0
    f.api.saveDeviceInspection = async () => { writes++; return { error: '仍在更新', code: 'DEVICE_INSPECTION_CONFLICT' } }
    assert.equal(await f.state.save(), false); assert.equal(writes, 2)
    assert.equal(f.state.dirty.value, true); assert.deepEqual(f.draft(), draft)
})

test('explicit reload can cancel safely or discard and obtain a fresh revision', async () => {
    const f = fixture({ answers: [false, true] }); await f.load(); const draft = clone(f.edit())
    const latest = clone(f.snapshots.get('a')); latest.revision = 'fresh'; f.snapshots.set('a', latest)
    assert.equal(await f.state.reloadSelected(), false)
    assert.deepEqual(f.draft(), draft); assert.equal(f.calls.discards, 0)
    assert.equal(await f.state.reloadSelected(), true)
    assert.equal(f.calls.discards, 1); assert.equal(f.state.revision.value, 'fresh')
    assert.equal(f.state.dirty.value, false)
    assert.equal(await f.state.canLeave(), true)
})

test('discard-and-switch discards editor changes and never writes the old device', async () => {
    const f = fixture({ answers: ['secondary'] })
    await f.load(); f.edit()
    assert.equal(await f.state.selectDevice('b'), true)
    assert.equal(f.calls.discards, 1)
    assert.equal(f.calls.saves.length, 0)
    assert.deepEqual(f.calls.reads, ['a', 'b'])
    assert.equal(f.state.selectedDeviceId.value, 'b')
    assert.equal(f.state.dirty.value, false)
})

test('save-and-switch conflict stays on the old device and retains its draft', async () => {
    const f = fixture({ answers: [true] })
    await f.load(); const draft = clone(f.edit())
    f.api.saveDeviceInspection = async () => { throw new Error('HTTP 409: saved revision changed') }
    assert.equal(await f.state.selectDevice('b'), false)
    assert.equal(f.state.selectedDeviceId.value, 'a')
    assert.equal(f.state.dirty.value, true)
    assert.deepEqual(f.draft(), draft)
    assert.deepEqual(f.calls.reads, ['a'])
    assert.equal(f.calls.discards, 0)
})

test('switching and duplicate save requests are blocked while saving', async () => {
    const f = fixture(), pending = deferred()
    await f.load(); f.edit()
    let saves = 0
    f.api.saveDeviceInspection = () => { saves += 1; return pending.promise }
    const first = f.state.save()
    assert.equal(f.state.saving.value, true)
    assert.equal(await f.state.selectDevice('b'), false)
    assert.equal(await f.state.save(), false)
    assert.equal(f.state.selectedDeviceId.value, 'a')
    assert.equal(f.calls.asks.length, 0)
    assert.deepEqual(f.calls.reads, ['a'])
    assert.equal(saves, 1)
    assert.match(f.state.status.value, /等待/)
    pending.resolve({ success: true, ...snapshot('a'), revision: 'saved' }); await first
    assert.equal(await f.state.selectDevice('b'), true)
})

test('a second switch cannot open another unsaved-change dialog while the first is pending', async () => {
    const f = fixture(), prompt = deferred()
    await f.load(); f.edit()
    const state = useManualDisassemblyPage({ devices: f.devices, models: f.models, api: f.api,
        ask: options => { f.calls.asks.push(options); return prompt.promise }, initialDeviceId: 'a' })
    state.setEditorGetter(() => f.editor)
    await state.loadSelected(); state.dirty.value = true
    const first = state.selectDevice('b'); await tick()
    assert.equal(await state.selectDevice('c'), false)
    assert.equal(f.calls.asks.length, 1)
    prompt.resolve('secondary')
    assert.equal(await first, true)
    assert.equal(state.selectedDeviceId.value, 'b')
})

test('savePending skips clean state and fails locally without sending an invalid draft', async () => {
    const f = fixture()
    await f.load()
    assert.equal(await f.state.savePending(), true)
    assert.equal(f.calls.saves.length, 0)
    f.setDraft({ parts: [{ id: 'part_a', explode_offset: [Infinity, 0, 0] }] }); f.state.dirty.value = true
    assert.equal(await f.state.savePending(), false)
    assert.equal(f.calls.saves.length, 0)
    assert.equal(f.state.dirty.value, true)
    assert.equal(f.state.saving.value, false)
})

test('dispose ignores a late read and makes subsequent page operations inert', async () => {
    const f = fixture(), pending = deferred()
    f.api.getDeviceInspection = id => { f.calls.reads.push(id); return pending.promise }
    const loading = f.state.loadSelected()
    f.state.dispose()
    const pageBefore = { id: f.state.selectedDeviceId.value, loading: f.state.loading.value,
        inspection: f.state.inspection.value, revision: f.state.revision.value, status: f.state.status.value }
    pending.resolve(snapshot('a')); await loading
    await f.state.loadSelected(); await f.state.ensureSelection()
    assert.equal(await f.state.selectDevice('b'), false)
    assert.equal(await f.state.canLeave(), false)
    assert.equal(await f.state.save(layout('a')), false)
    f.state.discard()
    assert.deepEqual({ id: f.state.selectedDeviceId.value, loading: f.state.loading.value,
        inspection: f.state.inspection.value, revision: f.state.revision.value, status: f.state.status.value }, pageBefore)
    assert.deepEqual(f.calls.reads, ['a'])
    assert.equal(f.calls.saves.length, 0)
    assert.equal(f.calls.asks.length, 0)
    assert.equal(f.calls.discards, 0)
})

test('dispose during the unsaved-change prompt prevents its late discard-and-switch response', async () => {
    const f = fixture(), prompt = deferred()
    await f.load(); f.edit()
    const state = useManualDisassemblyPage({ devices: f.devices, models: f.models, api: f.api,
        ask: () => prompt.promise, initialDeviceId: 'a' })
    state.setEditorGetter(() => f.editor); await state.loadSelected(); state.dirty.value = true
    const beforeReads = f.calls.reads.length, leaving = state.selectDevice('b')
    await tick(); state.dispose(); prompt.resolve('secondary')
    assert.equal(await leaving, false)
    assert.equal(state.selectedDeviceId.value, 'a')
    assert.equal(state.dirty.value, true)
    assert.equal(f.calls.discards, 0)
    assert.equal(f.calls.reads.length, beforeReads)
})

test('a confirmed save completing after dispose updates only global device cache, not disposed page refs', async () => {
    const f = fixture(), pending = deferred()
    await f.load(); f.edit([90, 80, 70])
    const priorInspection = clone(f.state.inspection.value), priorRevision = f.state.revision.value
    f.api.saveDeviceInspection = () => pending.promise
    const saving = f.state.save(), priorStatus = f.state.status.value
    f.state.dispose()
    const saved = snapshot('a'); saved.inspection.parts[0].explode_offset = [90, 80, 70]; saved.revision = 'confirmed-after-dispose'
    pending.resolve({ success: true, ...saved })
    assert.equal(await saving, true, 'already committed backend save is still successful')
    assert.deepEqual(JSON.parse(f.devices.value[0].instance_config).inspection, saved.inspection)
    assert.deepEqual(f.state.inspection.value, priorInspection)
    assert.equal(f.state.revision.value, priorRevision)
    assert.equal(f.state.dirty.value, true)
    assert.equal(f.state.saveRevision.value, 1)
    assert.equal(f.state.status.value, priorStatus)
})
