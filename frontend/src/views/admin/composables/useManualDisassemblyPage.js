import { computed, ref } from 'vue'

const copy = value => JSON.parse(JSON.stringify(value))
const parse = value => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
    try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {} } catch { return {} }
}
const contextKey = (device, model) => JSON.stringify([device?.id, device?.line_id, device?.model_type,
    device?.model_file, device?.instance_config, model?.id, model?.file_path, model?.metadata])

export function manualLayoutPayload(inspection, revision) {
    if (!revision) throw new Error('布局版本尚未读取，请重新加载设备')
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
    return { revision, parts, enabled: true }
}

export function useManualDisassemblyPage({ devices, models, api, ask, initialDeviceId = '' }) {
    const selectedDeviceId = ref(initialDeviceId)
    const inspection = ref(null)
    const revision = ref('')
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

    const frozenContext = computed(() => loadedContext.value && String(loadedContext.value.device.id) === selectedDeviceId.value
        && (dirty.value || saving.value || editor()?.dragging) ? loadedContext.value : null)
    const device = computed(() => frozenContext.value?.device || devices.value.find(item => String(item.id) === selectedDeviceId.value) || null)
    const model = computed(() => {
        if (frozenContext.value) return frozenContext.value.model
        const current = device.value
        if (!current) return null
        const asset = models.value.find(item => item.id === current.model_type)
        if (!asset) return null
        return current.model_file ? { ...asset, file_path: current.model_file } : asset
    })
    const choices = computed(() => devices.value.filter(item => models.value.some(asset => asset.id === item.model_type && (item.model_file || asset.file_path))))

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
        if (!device.value || !model.value) return
        const id = selectedDeviceId.value
        loading.value = true
        try {
            const result = await api.getDeviceInspection(id)
            if (disposed || sequence !== requestSequence) return
            if (result?.error || !result?.inspection || !result.revision) throw new Error(result?.error || '设备拆解配置读取失败')
            if (result.modelId && result.modelId !== device.value?.model_type) throw new Error('设备模型已变化，请刷新设备列表后重试')
            loadedContext.value = { device: copy(device.value), model: copy(model.value) }
            inspection.value = copy(result.inspection)
            revision.value = result.revision
            source.value = result.source || ''
            saveRevision.value += 1
        } catch (error) {
            if (!disposed && sequence === requestSequence) status.value = `读取失败：${error.message}`
        } finally {
            if (!disposed && sequence === requestSequence) loading.value = false
        }
    }

    async function save(draft = editor()?.getDraft?.()) {
        if (disposed || saving.value || loading.value || !device.value) return false
        if (editor()?.dragging) { status.value = '请先完成或取消当前拖拽，再保存。'; return false }
        const id = selectedDeviceId.value
        const sequence = requestSequence
        saving.value = true
        status.value = '正在保存本设备的部件位置…'
        try {
            const payload = manualLayoutPayload(draft, revision.value)
            const result = await api.saveDeviceInspection(id, payload)
            if (result?.error || result?.success !== true || !result.inspection || !result.revision) throw new Error(result?.error || '后端未确认保存')
            const existing = devices.value.find(item => String(item.id) === id)
            if (existing) {
                const config = { ...parse(existing.instance_config), inspection: copy(result.inspection) }
                existing.instance_config = typeof existing.instance_config === 'string' ? JSON.stringify(config) : config
            }
            if (disposed || sequence !== requestSequence || id !== selectedDeviceId.value) return true
            if (existing) loadedContext.value = { device: copy(existing), model: copy(model.value) }
            inspection.value = copy(result.inspection)
            revision.value = result.revision
            source.value = result.source || 'device'
            dirty.value = false
            saveRevision.value += 1
            status.value = '设备布局已保存；仅影响本设备，运行端将同步新的拆解位置。'
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

    async function canLeave() {
        if (disposed) return false
        if (editor()?.dragging) { status.value = '请先完成或取消当前拖拽，再切换。'; return false }
        if (saving.value) { status.value = '正在保存，请等待完成后再切换。'; return false }
        if (leavePending) return false
        if (!dirty.value) return true
        leavePending = true
        try {
            const choice = await ask({
                title: '拆解布局尚未保存', message: '当前设备的部件位置已调整，如何处理后再切换？',
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
        status, saveRevision, loadSelected, ensureSelection, selectDevice, save, discard, canLeave, dispose,
        setEditorGetter: getter => { editor = getter }, savePending: () => dirty.value ? save() : Promise.resolve(true) }
}
