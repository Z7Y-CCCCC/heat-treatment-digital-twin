import { computed, ref } from 'vue'
import { presentationChanges } from '../../../../../shared/inspectionPresentation.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const parse = value => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}
const contextKey = (device, model) => JSON.stringify([device?.id, device?.line_id, device?.model_type,
    device?.model_file, device?.instance_config, model?.id, model?.file_path, model?.metadata])
const frameKey = inspection => JSON.stringify([inspection?.offset_space, inspection?.parts?.map(part =>
    [part.id, part.enabled, part.node_path, part.node_paths, part.node_name, part.node_names, part.pivot, part.explode_rotation])])
const sameOffset = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function manualLayoutPayload(inspection, revision, baseline) {
    if (!revision) throw new Error('布局版本尚未读取，请重新加载布局')
    if (!Array.isArray(inspection?.parts) || !inspection.parts.length) throw new Error('没有可保存的部件，请先配置模型拆解部件')
    const ids = new Set()
    const parts = inspection.parts.map(part => {
        if (!part.id || ids.has(part.id)) throw new Error('部件编号缺失或重复')
        ids.add(part.id)
        const offset = part.explode_offset
        if (!Array.isArray(offset) || offset.length !== 3 || offset.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100000)) {
            throw new Error(`部件「${part.name || part.id}」的位置无效`)
        }
        return { id: part.id, explode_offset: [...offset] }
    })
    // The dedicated endpoint merges only these positions into the latest full
    // configuration. Never send a stale device/PLC/instance_config replacement.
    const presentation = baseline ? presentationChanges(inspection, baseline) : {}
    return { revision, parts, enabled: true, ...(Object.keys(presentation).length ? { presentation } : {}) }
}

export function useManualDisassemblyPage({ devices = ref([]), models, api, ask, initialDeviceId = '', initialModelId = '', scope = 'device' }) {
    const modelScope = scope === 'model'
    const selectedDeviceId = ref(modelScope ? initialModelId : initialDeviceId)
    const inspection = ref(null)
    const revision = ref('')
    const assetRevision = ref('')
    const source = ref('')
    const loading = ref(false)
    const saving = ref(false)
    const dirty = ref(false)
    const status = ref('')
    const saveRevision = ref(0)
    const loadedContext = ref(null)
    let requestSequence = 0
    let disposed = false
    let leavePending = false
    let editor = () => null

    const frozenContext = computed(() => loadedContext.value && loadedContext.value.id === selectedDeviceId.value
        && (dirty.value || saving.value || editor()?.dragging) ? loadedContext.value : null)
    const device = computed(() => frozenContext.value?.device || devices.value.find(item => String(item.id) === selectedDeviceId.value) || null)
    const model = computed(() => {
        if (frozenContext.value) return frozenContext.value.model
        if (modelScope) return models.value.find(item => String(item.id) === selectedDeviceId.value) || null
        const current = device.value
        if (!current) return null
        const asset = models.value.find(item => item.id === current.model_type)
        if (!asset) return null
        return current.model_file ? { ...asset, file_path: current.model_file } : asset
    })
    const choices = computed(() => modelScope
        ? models.value.filter(item => (item.placement_level || 'device') === 'device' && item.asset_type !== 'environment' && item.file_path)
        : devices.value.filter(item => models.value.some(asset => asset.id === item.model_type && (item.model_file || asset.file_path))))
    const read = id => modelScope ? api.getModelInspection(id) : api.getDeviceInspection(id)
    const write = (id, payload) => modelScope ? api.saveModelInspection(id, payload) : api.saveDeviceInspection(id, payload)

    async function loadSelected() {
        if (disposed) return
        if (dirty.value || saving.value || editor()?.dragging) return
        const sequence = ++requestSequence
        inspection.value = null
        revision.value = ''
        source.value = ''
        dirty.value = false
        status.value = ''
        loading.value = false
        if (!model.value || !modelScope && !device.value) return
        const id = selectedDeviceId.value
        loading.value = true
        try {
            const result = await read(id)
            if (disposed || sequence !== requestSequence) return
            if (result?.error || !result?.inspection || !result.revision) throw new Error(result?.error || '设备拆解配置读取失败')
            if (result.modelId && result.modelId !== (modelScope ? id : device.value?.model_type)) throw new Error('模型已变化，请刷新列表后重试')
            loadedContext.value = { id, device: copy(device.value), model: copy(model.value) }
            inspection.value = copy(result.inspection)
            revision.value = result.revision
            assetRevision.value = result.assetRevision || ''
            source.value = result.source || ''
            saveRevision.value += 1
        } catch (error) {
            if (!disposed && sequence === requestSequence) status.value = `读取失败：${error.message}`
        } finally {
            if (!disposed && sequence === requestSequence) loading.value = false
        }
    }

    async function save(draft = editor()?.getDraft?.()) {
        if (disposed || saving.value || loading.value || !model.value || !modelScope && !device.value) return false
        if (editor()?.dragging) { status.value = '请先完成或取消当前拖拽，再保存。'; return false }
        const id = selectedDeviceId.value
        const sequence = requestSequence
        const baseline = copy(inspection.value)
        saving.value = true
        status.value = modelScope ? '正在保存模型布局…' : '正在保存本设备的部件位置…'
        try {
            const payload = manualLayoutPayload(draft, revision.value, modelScope ? baseline : null)
            let result = await write(id, payload)
            if (['DEVICE_INSPECTION_CONFLICT', 'MODEL_INSPECTION_CONFLICT'].includes(result?.code)) {
                // Rebase ONLY locally edited positions. Unchanged parts and all
                // latest timings, bindings and unrelated device fields survive.
                const latest = await read(id)
                if (disposed || sequence !== requestSequence || id !== selectedDeviceId.value) return false
                if (latest?.error || !latest?.inspection || !latest.revision) throw new Error(latest?.error || '无法读取最新布局，请稍后重试')
                if (!assetRevision.value || latest.assetRevision !== assetRevision.value || frameKey(latest.inspection) !== frameKey(baseline)) {
                    throw new Error('模型或部件结构已变化；草稿未丢失，请导出草稿后重新读取布局')
                }
                const edits = payload.parts.filter(part => !sameOffset(part.explode_offset, baseline.parts.find(p => p.id === part.id)?.explode_offset))
                const overlaps = edits.filter(part => {
                    const remote = latest.inspection.parts.find(p => p.id === part.id)?.explode_offset
                    return !sameOffset(remote, baseline.parts.find(p => p.id === part.id)?.explode_offset) && !sameOffset(remote, part.explode_offset)
                })
                const displayOverlaps = Object.keys(payload.presentation || {}).filter(key =>
                    !sameOffset(latest.inspection[key], baseline[key]) && !sameOffset(latest.inspection[key], payload.presentation[key]))
                if ((overlaps.length || displayOverlaps.length) && await ask({ title: '拆解设置发生冲突',
                    message: `${overlaps.length} 个部件位置、${displayOverlaps.length} 项显示设置也被其他操作修改，是否使用当前草稿？`,
                    type: 'warning', showCancel: true, cancelText: '保留草稿', confirmText: '使用当前拖拽位置' }) !== true) {
                    status.value = '未覆盖其他修改，当前草稿已保留。'; return false
                }
                if (disposed || sequence !== requestSequence || id !== selectedDeviceId.value) return false
                result = await write(id, { ...payload, revision: latest.revision, parts: edits })
            }
            if (result?.error || result?.success !== true || !result.inspection || !result.revision) throw new Error(result?.error || '后端未确认保存')
            const existing = (modelScope ? models : devices).value.find(item => String(item.id) === id)
            if (existing) {
                const key = modelScope ? 'metadata' : 'instance_config'
                const config = { ...parse(existing[key]), inspection: copy(result.inspection) }
                existing[key] = modelScope && result.model?.metadata !== undefined ? copy(result.model.metadata)
                    : typeof existing[key] === 'string' ? JSON.stringify(config) : config
            }
            if (disposed || sequence !== requestSequence || id !== selectedDeviceId.value) return true
            if (existing) loadedContext.value = { id, device: modelScope ? null : copy(existing), model: copy(modelScope ? existing : model.value) }
            inspection.value = copy(result.inspection)
            revision.value = result.revision
            assetRevision.value = result.assetRevision || assetRevision.value
            source.value = result.source || 'device'
            dirty.value = false
            saveRevision.value += 1
            status.value = modelScope ? '模型布局已保存。' : '设备布局已保存；仅影响本设备，运行端将同步新的拆解位置。'
            return true
        } catch (error) {
            if (!disposed && sequence === requestSequence) status.value = `保存失败，拖拽草稿仍保留：${error.message}`
            return false
        } finally {
            if (!disposed && sequence === requestSequence) saving.value = false
        }
    }

    function discard() {
        if (disposed) return
        editor()?.discardChanges?.()
        dirty.value = false
        status.value = ''
    }

    async function reloadSelected() {
        if (disposed || saving.value || loading.value || editor()?.dragging) return false
        if (dirty.value && await ask({ title: '重新读取布局', message: '将放弃未保存的位置，载入服务器最新布局。',
            type: 'warning', showCancel: true, cancelText: '继续编辑', confirmText: '放弃草稿并读取' }) !== true) return false
        if (disposed) return false
        discard(); await loadSelected(); return !!inspection.value
    }

    async function canLeave() {
        if (disposed) return false
        if (editor()?.dragging) { status.value = '请先完成或取消当前拖拽，再切换。'; return false }
        if (saving.value) { status.value = '正在保存，请等待完成后再切换。'; return false }
        if (leavePending) return false
        if (!dirty.value) return true
        leavePending = true
        try {
            const choice = await ask({
                title: '拆解布局尚未保存', message: modelScope ? '模型布局已修改，如何处理？' : '当前设备的部件位置已调整，如何处理后再切换？',
                type: 'warning', showCancel: true, cancelText: '继续编辑',
                secondaryText: '放弃修改并切换', confirmText: '保存并切换'
            })
            if (disposed) return false
            if (choice === 'secondary') { discard(); return true }
            if (choice === true) return await save()
            return false
        } finally { leavePending = false }
    }

    async function selectDevice(id) {
        if (disposed) return false
        const next = String(id || '')
        if (next === selectedDeviceId.value && inspection.value) return true
        if (!await canLeave() || disposed) return false
        selectedDeviceId.value = next
        await loadSelected()
        return true
    }

    async function ensureSelection() {
        if (disposed) return
        // KeepAlive/native resume is not permission to discard the editor's
        // draft or replace its saved revision while a write is in flight.
        if (dirty.value || saving.value || editor()?.dragging) return
        if (loading.value) return
        if (!choices.value.some(item => String(item.id) === selectedDeviceId.value)) selectedDeviceId.value = String(choices.value[0]?.id || '')
        // Mount, tab activation and native resume can all request selection.
        // Reuse the current model unless its configuration actually changed.
        if (inspection.value && revision.value && loadedContext.value
            && contextKey(device.value, model.value) === contextKey(loadedContext.value.device, loadedContext.value.model)) return
        await loadSelected()
    }

    function dispose() { disposed = true; requestSequence += 1 }
    return { selectedDeviceId, device, model, choices, inspection, revision, source, loading, saving, dirty,
        selectedModelId: selectedDeviceId, selectModel: selectDevice,
        status, saveRevision, loadSelected, reloadSelected, ensureSelection, selectDevice, save, discard, canLeave, dispose,
        setEditorGetter: getter => { editor = getter }, savePending: () => dirty.value ? save() : Promise.resolve(true) }
}
