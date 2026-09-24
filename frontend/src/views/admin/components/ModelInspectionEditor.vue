<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import inspectionConfig from '../../../../../shared/inspectionConfig.mjs'
import { generateInspectionParts, inspectionTimeline, spreadInspectionParts } from '../../../runtime/InspectionPreview.js'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch } from '../../../runtime/adminSession.js'
import InspectionVectorInput from './InspectionVectorInput.vue'
import InspectionCameraFields from './InspectionCameraFields.vue'

const { createInspectionDefaults, normalizeInspection, validateInspection } = inspectionConfig
const props = defineProps({
    modelValue: { type: Object, required: true }, modelId: { type: String, default: '' },
    nodes: { type: Array, default: () => [] }, partBindings: { type: Array, default: () => [] },
    previewState: { type: Object, default: () => ({}) }, devices: { type: Array, default: () => [] },
    previewDeviceId: { type: String, default: '' }, saving: Boolean, saveRevision: { type: Number, default: 0 }, savedSignature: { type: String, default: '' },
    nativePreviewBusy: Boolean, status: { type: String, default: '' }
})
const emit = defineEmits(['update:modelValue', 'save', 'reload', 'command', 'capture-camera', 'native-preview', 'update:previewDeviceId'])
const draft = reactive(normalizeInspection(props.modelValue, props.partBindings))
const selection = ref(draft.parts[0]?.id || '')
const selectionOrdinal = ref(draft.parts.length ? 0 : -1)
const activeSection = ref('parts')
const nodeQuery = ref('')
const pendingNodes = ref([])
const shellPendingNodes = ref([])
const generationParent = ref('')
const layoutMode = ref('radial')
const spacing = ref(1)
const message = ref('')
const jsonDraft = ref('')
const jsonInput = ref(null)
const presets = ref([])
const selectedPreset = ref('')
const presetStatus = ref('')
const confirmAction = ref(null)
const savedSignature = ref(JSON.stringify(draft))
let presetAbort

watch(() => JSON.stringify(props.modelValue), text => {
    if (text === JSON.stringify(draft)) return
    const next = normalizeInspection(props.modelValue, props.partBindings)
    if (JSON.stringify(next) === JSON.stringify(draft)) return
    for (const key of Object.keys(draft)) delete draft[key]
    Object.assign(draft, next)
    if (!draft.parts.some(part => part.id === selection.value)) { selection.value = draft.parts[0]?.id || ''; selectionOrdinal.value = draft.parts.length ? 0 : -1 }
})
watch(draft, () => {
    if (JSON.stringify(props.modelValue) !== JSON.stringify(draft)) emit('update:modelValue', JSON.parse(JSON.stringify(draft)))
}, { deep: true })
watch(() => [props.modelId, props.saveRevision, props.savedSignature], () => {
    savedSignature.value = props.savedSignature || JSON.stringify(normalizeInspection(props.modelValue, props.partBindings))
    message.value = ''
    pendingNodes.value = []
}, { immediate: true })
watch(() => props.previewState.selectedId, id => { if (id) { selection.value = id; selectionOrdinal.value = draft.parts.findIndex(part => part.id === id) } })
watch(() => props.status, () => { message.value = '' })

const dirty = computed(() => JSON.stringify(normalizeInspection(draft, props.partBindings)) !== savedSignature.value)
const validation = computed(() => validateInspection(draft, props.nodes))
const timeline = computed(() => inspectionTimeline(draft))
const playbackSpeed = computed(() => Math.max(0.25, Math.min(3, Number(draft.playback_speed) || 1)))
const playbackDuration = computed(() => timeline.value.duration / playbackSpeed.value)
const selectedIndex = computed(() => draft.parts[selectionOrdinal.value]?.id === selection.value ? selectionOrdinal.value : draft.parts.findIndex(part => part.id === selection.value))
const selectedPart = computed(() => draft.parts[selectedIndex.value])
const nodeOptions = computed(() => {
    const query = nodeQuery.value.toLocaleLowerCase().trim()
    return props.nodes.filter(node => node.meshCount > 0 && (!query || `${node.name} ${node.displayName} ${node.path}`.toLocaleLowerCase().includes(query)))
})
const groupOptions = computed(() => props.nodes.filter(node => !node.isMesh && node.type !== 'Mesh' && node.meshCount > 0))
const matchingDevices = computed(() => props.devices.filter(device => (device.model_type || device.model_id || device.modelId) === props.modelId))
const matchingPresets = computed(() => presets.value.filter(preset => !preset.modelId || preset.modelId === props.modelId))
const selectedPresetRecord = computed(() => matchingPresets.value.find(preset => preset.id === selectedPreset.value))
const splitList = value => [...new Set(String(value).split(/[,，\n]/).map(item => item.trim()).filter(Boolean))]
const splitNodes = value => [...new Set(String(value).split(/\r?\n/).filter(Boolean))]
const formatNode = node => `${'　'.repeat(Math.min((node.path?.match(/\//g) || []).length, 3))}${node.displayName || node.name} · ${node.isMesh || node.type === 'Mesh' ? '网格' : '装配组'} (${node.meshCount})`

function nodeEntries(part) {
    return [
        ...[...new Set([part.node_path, ...(part.node_paths || [])].filter(Boolean))].map(value => ({ kind: 'path', value, label: props.nodes.find(node => node.path === value)?.displayName || value })),
        ...[...new Set([part.node_name, ...(part.node_names || [])].filter(Boolean))].map(value => ({ kind: 'name', value, label: value }))
    ]
}
function removeNode(part, entry) {
    if (entry.kind === 'path') {
        if (part.node_path === entry.value) part.node_path = ''
        part.node_paths = (part.node_paths || []).filter(value => value !== entry.value)
    } else {
        if (part.node_name === entry.value) part.node_name = ''
        part.node_names = (part.node_names || []).filter(value => value !== entry.value)
    }
}
function appendNodes(part, values) {
    part.node_paths = [...new Set([...(part.node_paths || []), ...values])]
    pendingNodes.value = []
    shellPendingNodes.value = []
}
function choosePart(id, focus = false, index = -1) {
    selection.value = id
    selectionOrdinal.value = index >= 0 ? index : draft.parts.findIndex(part => part.id === id)
    if (draft.parts.filter(part => part.id === id).length === 1) emit('command', { command: 'select', partId: id, focus })
}
function addPart() {
    if (draft.parts.length >= 64) return
    let index = 1
    while (draft.parts.some(part => part.id === `part_${index}`)) index++
    const part = normalizeInspection({ ...createInspectionDefaults(), parts: [{ id: `part_${index}`, name: `新部件 ${index}`, node_paths: [...pendingNodes.value] }] }).parts[0]
    draft.parts.push(part)
    selection.value = part.id
    selectionOrdinal.value = draft.parts.length - 1
    pendingNodes.value = []
}
function movePart(direction) {
    const index = selectedIndex.value
    const next = index + direction
    if (index < 0 || next < 0 || next >= draft.parts.length) return
    const [part] = draft.parts.splice(index, 1)
    draft.parts.splice(next, 0, part)
    selectionOrdinal.value = next
}
function removePart() {
    const index = selectedIndex.value
    if (index < 0) return
    draft.parts.splice(index, 1)
    selection.value = draft.parts[Math.min(index, draft.parts.length - 1)]?.id || ''
    selectionOrdinal.value = Math.min(index, draft.parts.length - 1)
    emit('command', { command: 'clear' })
}
function requestConfirmation(text, run) { confirmAction.value = { text, run } }
function confirmPending() {
    const pending = confirmAction.value
    confirmAction.value = null
    pending?.run()
}
function generateParts() {
    const additions = generateInspectionParts(props.nodes, { parentPath: generationParent.value, existingParts: draft.parts, partBindings: props.partBindings })
    if (!additions.length) {
        message.value = '没有可追加的独立装配组。请选择更深一层父节点；已配置的节点不会重复加入。材质合并网格不能自动当作真实零部件。'
        return
    }
    const arranged = draft.offset_space === 'model' ? spreadInspectionParts(additions, props.nodes, { mode: layoutMode.value, spacing: spacing.value }) : additions
    draft.parts.push(...arranged)
    selection.value = additions[0].id
    selectionOrdinal.value = draft.parts.length - additions.length
    message.value = `已追加 ${additions.length} 个装配组；原部件的名称、ID、偏移及 PLC 关联均保留。请检查结构与方向后保存。`
}
function applySpread() {
    requestConfirmation('将根据模型实际边界重新计算全部部件的拆解位移，保留名称、ID、转角、时序及 PLC 关联。', () => {
        draft.parts = spreadInspectionParts(draft.parts, props.nodes, { mode: layoutMode.value, spacing: spacing.value })
        message.value = '空间布局已应用到草稿，位移仍可逐个微调。'
    })
}
function replaceDraft(value) {
    const normalized = normalizeInspection(value, props.partBindings)
    for (const key of Object.keys(draft)) delete draft[key]
    Object.assign(draft, normalized)
    selection.value = draft.parts[0]?.id || ''
    selectionOrdinal.value = draft.parts.length ? 0 : -1
    emit('command', { command: 'stage', stage: 'solid' })
}
function applyPreset() {
    const preset = selectedPresetRecord.value
    if (!preset) return
    requestConfirmation(`应用“${preset.name}”将替换当前拆解草稿；模型文件、已有动作绑定和已保存版本不会被修改。`, () => {
        replaceDraft(preset.inspection)
        message.value = `已载入“${preset.name}”，请预览并保存后发布。`
    })
}
async function loadPresets() {
    presetAbort?.abort()
    presetAbort = new AbortController()
    try {
        const response = await adminFetch(`${API_BASE}/models/inspection-presets`, { signal: presetAbort.signal })
        if (!response.ok) throw new Error(response.status === 404 ? '当前服务尚未提供模型预设，可直接手动编排。' : `读取预设失败：${response.status}`)
        const result = await response.json()
        presets.value = Array.isArray(result.presets) ? result.presets : []
        presetStatus.value = ''
    } catch (error) { if (error.name !== 'AbortError') presetStatus.value = error.message }
}
function exportJson() {
    jsonDraft.value = JSON.stringify(normalizeInspection(draft, props.partBindings), null, 2)
    const url = URL.createObjectURL(new Blob([jsonDraft.value], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${props.modelId || 'model'}-inspection.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    message.value = '已导出当前拆解草稿，包含多节点、镜头、时序及 PLC 关联。'
}
async function readJsonFile(event) {
    const file = event.target.files?.[0]
    if (!file) return
    try {
        if (file.size > 1024 * 1024) throw new Error('配置文件不能超过 1 MB')
        jsonDraft.value = await file.text()
        activeSection.value = 'exchange'
        message.value = '文件已读入，点击“校验并载入草稿”后才会应用。'
    } catch (error) { message.value = error.message }
    event.target.value = ''
}
function importJson() {
    try {
        const parsed = JSON.parse(jsonDraft.value)
        const value = parsed?.inspection || parsed?.metadata?.inspection || parsed
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 inspection 配置对象')
        if (!Array.isArray(value.parts)) throw new Error('配置缺少 parts 部件数组；没有应用任何更改')
        const rawValidation = validateInspection(value, props.nodes)
        const dataLossErrors = rawValidation.errors.filter(error => error.code.startsWith('too_many_') || error.code === 'invalid_config')
        if (dataLossErrors.length) throw new Error(dataLossErrors.map(error => error.message).join('；'))
        requestConfirmation(`载入 JSON 将替换当前拆解草稿（${value.parts.length} 个部件）。校验问题会保留在界面中，修正前不能保存。`, () => {
            replaceDraft(value)
            message.value = 'JSON 已载入草稿；保存之前不会写入模型。'
        })
    } catch (error) { message.value = `JSON 配置未载入：${error.message}` }
}
function captureCamera(stage, partId = '') {
    emit('capture-camera', { stage, partId, apply: camera => {
        if (partId) {
            const part = draft.parts.find(item => item.id === partId)
            if (part) part.camera = camera
        } else draft[stage].camera = camera
    } })
}
function setPartId(value) { if (selectedPart.value) { selectedPart.value.id = value; selection.value = value } }
function toggleCamera(enabled) { selectedPart.value.camera = enabled ? { ...createInspectionDefaults().exploded.camera, target_offset: [0, 0, 0] } : null }
function save() {
    if (!validation.value.valid) { message.value = '请先修正下方校验错误，再保存拆解配置。'; return }
    message.value = ''
    emit('save')
}
onMounted(loadPresets)
onUnmounted(() => presetAbort?.abort())
defineExpose({ dirty, draft, validation, exportJson, importJson, generateParts, applyPreset })
</script>

<template>
    <div class="inspection-authoring" data-testid="inspection-editor">
        <header class="editor-heading">
            <div><h3>拆解编排工作台</h3><p>配置一次，同型号设备复用；部件结构、动画和镜头均由工程师定义。</p></div>
            <span class="draft-indicator" :class="{ dirty }">{{ dirty ? '未保存的草稿' : '已载入模型配置' }}</span>
            <button type="button" class="primary" data-testid="save-inspection" :disabled="saving || !validation.valid || !nodes.length" @click="save">{{ saving ? '保存中…' : '保存拆解配置' }}</button>
        </header>
        <div class="inspection-playback">
            <div class="playback-buttons">
                <button type="button" :class="{ active: previewState.stage === 'exploded' }" @click="emit('command', {command:'stage', stage:'exploded'})">▶ 演示拆解</button>
                <button type="button" :class="{ active: previewState.stage === 'solid' }" @click="emit('command', {command:'stage', stage:'solid'})">↶ 反向组装</button>
                <button type="button" :class="{ active: previewState.stage === 'xray' }" @click="emit('command', {command:'stage', stage:'xray'})">外壳透视</button>
                <button type="button" @click="emit('command', {command:previewState.paused ? 'resume' : 'pause'})">{{ previewState.paused ? '继续' : '暂停' }}</button>
                <label class="check"><input v-model="draft.labels.enabled" type="checkbox" /> 空间标签</label>
            </div>
            <label class="timeline-scrub"><span>{{ ((previewState.progress || 0) * 100).toFixed(0) }}%</span><input type="range" min="0" max="1" step="0.001" :value="previewState.progress || 0" aria-label="拆解进度" @input="emit('command', {command:'progress', progress:Number($event.target.value)})" /><span>{{ playbackDuration.toFixed(2) }} 秒实际播放</span></label>
            <label class="timeline-speed"><span>拆解速度</span><input v-model.number="draft.playback_speed" type="range" min="0.25" max="3" step="0.05" aria-label="拆解播放速度" /><strong>{{ playbackSpeed.toFixed(2) }}×</strong><button type="button" @click="draft.playback_speed = 1">正常速度</button></label>
            <div class="speed-hint"><span>0.25× 慢速</span><span>1× 正常</span><span>3× 快速</span><small>修改后保存拆解配置，实时大屏会同步使用该速度。</small></div>
            <div class="timeline-phases"><span :style="{flex:Math.max(draft.shell_duration, 0.1)}">外壳退场 {{ draft.shell_duration }}s</span><span :style="{flex:Math.max(timeline.duration - draft.shell_duration, 0.1)}">依次展开 {{ draft.parts.filter(p => p.enabled !== false).length }} 个部件 · 组装时整体倒放</span></div>
        </div>

        <div class="preset-row">
            <select v-model="selectedPreset" aria-label="模型拆解预设"><option value="">{{ matchingPresets.length ? '选择可编辑的模型预设' : '暂无此模型预设' }}</option><option v-for="preset in matchingPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option></select>
            <button type="button" :disabled="!selectedPresetRecord" @click="applyPreset">应用预设</button>
            <button type="button" @click="requestConfirmation('丢弃未保存的拆解编辑，重新载入模型当前已保存版本？', () => emit('reload'))">重新载入</button>
            <button type="button" @click="exportJson">导出 JSON</button>
        </div>
        <small v-if="presetStatus" class="hint">{{ presetStatus }}</small>
        <div v-if="confirmAction" class="confirmation" role="alert"><p>{{ confirmAction.text }}</p><button type="button" class="primary" @click="confirmPending">确认应用</button><button type="button" @click="confirmAction = null">取消</button></div>
        <div v-if="message || status" class="editor-notice" role="status">{{ message || status }}</div>
        <div v-if="validation.errors.length" class="validation-errors" role="alert" data-testid="inspection-errors"><strong>修正后才能保存（{{ validation.errors.length }}）</strong><ul><li v-for="(error, index) in validation.errors" :key="`${error.code}-${index}`"><button v-if="error.partId" type="button" @click="selection = error.partId; activeSection = 'parts'">{{ error.partId }}</button> {{ error.message }}</li></ul></div>
        <details v-if="validation.warnings.length" class="validation-warnings"><summary>{{ validation.warnings.length }} 项编排提示</summary><ul><li v-for="(warning, index) in validation.warnings" :key="index">{{ warning.message }}</li></ul></details>
        <nav class="editor-tabs" aria-label="拆解配置分类"><button v-for="tab in [{id:'parts',label:'部件与运动'},{id:'shell',label:'外壳与时序'},{id:'camera',label:'镜头与标签'},{id:'exchange',label:'配置与运行端'}]" :key="tab.id" type="button" :class="{ active: activeSection === tab.id }" @click="activeSection = tab.id">{{ tab.label }}</button></nav>

        <section v-if="activeSection === 'parts'">
            <details class="generator-panel"><summary>从模型装配组生成 / 空间布局</summary>
                <p class="hint">只读取模型真实节点组，不推断或虚构内部机械结构。自动生成只追加，保留现有部件。</p>
                <div class="grid two"><label>装配组父节点<select v-model="generationParent"><option value="">自动识别顶层装配组</option><option v-for="node in groupOptions" :key="node.path" :value="node.path">{{ formatNode(node) }}</option></select></label><label>布局方式<select v-model="layoutMode"><option value="radial">沿实际空间方向展开</option><option value="grid">展台网格排布</option><option value="x">沿 X 轴排开</option><option value="y">沿 Y 轴分层</option><option value="z">沿 Z 轴排开</option></select></label><label>展开间距倍率<input v-model.number="spacing" type="number" min="0.1" max="5" step="0.1" /></label><div class="button-row"><button type="button" :disabled="!nodes.length || draft.parts.length >= 64" @click="generateParts">从装配组追加部件</button><button type="button" :disabled="!draft.parts.length || draft.offset_space !== 'model'" @click="applySpread">应用空间布局</button></div></div>
                <p v-if="draft.offset_space !== 'model'" class="hint">当前为旧版父节点坐标。自动空间布局需要在“外壳与时序”切换为模型坐标；切换后请复核已有位移。</p>
            </details>
            <div class="part-workbench">
                <aside class="part-list"><header><strong>装配部件 {{ draft.parts.length }}/64</strong><button type="button" :disabled="draft.parts.length >= 64" @click="addPart">＋ 新部件</button></header>
                    <div v-for="(part, index) in draft.parts" :key="`${index}-${part.id}`" class="part-list-row" :class="{ selected: selectedIndex === index, disabled: part.enabled === false }"><button type="button" class="part-select" @click="choosePart(part.id, false, index)"><span>{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ part.name || '未命名部件' }}</strong><small>{{ part.group || `${nodeEntries(part).length} 个节点` }}</small></div></button><input v-model="part.enabled" type="checkbox" :aria-label="`启用 ${part.name}`" /></div>
                    <p v-if="!draft.parts.length" class="empty-state">先从真实装配组生成，或新增部件并选择一个或多个节点。</p>
                </aside>
                <div v-if="selectedPart" class="part-properties">
                    <div class="part-property-heading"><strong>{{ selectedPart.name || '编辑部件' }}</strong><div class="button-row"><button type="button" :disabled="selectedIndex <= 0" aria-label="部件上移" @click="movePart(-1)">↑</button><button type="button" :disabled="selectedIndex >= draft.parts.length - 1" aria-label="部件下移" @click="movePart(1)">↓</button><button type="button" @click="choosePart(selectedPart.id, true)">部件特写</button><button type="button" class="danger" @click="requestConfirmation(`从拆解草稿移除“${selectedPart.name}”？模型节点和 PLC 动作绑定不会删除。`, removePart)">移除</button></div></div>
                    <div class="grid two"><label>中文显示名称<input v-model="selectedPart.name" placeholder="如：后循环风机总成" /></label><label>分组名称<input v-model="selectedPart.group" placeholder="如：驱动机构" /></label><label>稳定部件 ID<input :value="selectedPart.id" @input="setPartId($event.target.value)" /><small class="hint">被组件引用后请保持不变。</small></label><label>详情视角 ID<input v-model="selectedPart.detail_view_id" placeholder="留空自动聚焦" /></label></div>
                    <label>部件说明<textarea v-model="selectedPart.description" rows="2" placeholder="描述功能、检查内容及已确认的结构" /></label>
                    <div class="target-editor"><strong>所属节点（可多选）</strong><div class="target-chips"><span v-for="entry in nodeEntries(selectedPart)" :key="`${entry.kind}:${entry.value}`" :title="entry.value">{{ entry.label }}<button type="button" :aria-label="`移除节点 ${entry.label}`" @click="removeNode(selectedPart, entry)">×</button></span></div>
                        <input v-model="nodeQuery" placeholder="搜索节点中文名 / 原始名 / 路径" aria-label="搜索模型节点" />
                        <select v-model="pendingNodes" multiple size="6" aria-label="选择部件模型节点"><option v-for="node in nodeOptions" :key="node.path" :value="node.path">{{ formatNode(node) }}</option></select>
                        <div class="button-row"><button type="button" :disabled="!pendingNodes.length" @click="appendNodes(selectedPart, pendingNodes)">加入选中的 {{ pendingNodes.length || '' }} 个节点</button><small class="hint">Ctrl / Shift 多选；同一部件可含多个独立总成。</small></div>
                        <details><summary>按原始节点名引用 / 修正缺失路径</summary><label>原始节点名（一行一个，区分大小写）<textarea :value="selectedPart.node_names.join('\n')" rows="2" @input="selectedPart.node_names = splitNodes($event.target.value)" /></label><label>路径引用（一行一个）<textarea :value="selectedPart.node_paths.join('\n')" rows="2" @input="selectedPart.node_paths = splitNodes($event.target.value)" /></label><small class="hint">上方标签中的旧版单节点引用也会保留，点击 × 可以移除。</small></details>
                    </div>
                    <InspectionVectorInput v-model="selectedPart.explode_offset" label="拆解位移" :unit="draft.offset_space === 'model' ? '模型坐标 / 模型单位' : '父节点坐标 / 模型单位'" />
                    <InspectionVectorInput v-model="selectedPart.explode_rotation" label="拆解转角" unit="度" :step="5" />
                    <div class="grid two"><label>额外延迟（秒）<input v-model.number="selectedPart.delay" type="number" min="0" max="10" step="0.05" /></label><label>运动时长（0 = 继承）<input v-model.number="selectedPart.duration" type="number" min="0" max="10" step="0.05" /></label></div>
                    <InspectionVectorInput v-model="selectedPart.label_offset" label="空间标签偏移" />
                    <details class="part-camera-panel"><summary>部件特写镜头</summary><label class="check"><input type="checkbox" :checked="!!selectedPart.camera" @change="toggleCamera($event.target.checked)" /> 为此部件指定镜头</label><p v-if="!selectedPart.camera" class="hint">按该部件自身大小自动取景，小型电机、阀门也能拉近。</p><InspectionCameraFields v-if="selectedPart.camera" v-model="selectedPart.camera" label="部件特写" @capture="captureCamera('', selectedPart.id)" /></details>
                    <details class="point-link-panel" open><summary>PLC 点位与低代码组件关联</summary><label>点位键（逗号或换行分隔）<textarea :value="selectedPart.point_keys.join('\n')" rows="2" placeholder="motors.rear_fan_rpm&#10;analog.temperature" @input="selectedPart.point_keys = splitList($event.target.value)" /></label><label>点位 ID（原有 ID 保留）<textarea :value="selectedPart.point_ids.join('\n')" rows="2" placeholder="point_temperature_01" @input="selectedPart.point_ids = splitList($event.target.value)" /></label><small class="hint">这里只关联参数上下文，不会改变采集地址或模型原有动作绑定。</small></details>
                </div>
                <div v-else class="empty-state">选择左侧部件，配置节点、运动和 PLC 参数。</div>
            </div>
        </section>

        <section v-if="activeSection === 'shell'" class="configuration-section">
            <div class="section-heading"><h4>外壳先退场，内部部件再展开</h4><label class="check"><input v-model="draft.enabled" type="checkbox" /> 启用设备拆解</label></div>
            <div class="grid three"><label>退场方式<select v-model="draft.shell.transition"><option value="clip">沿轴逐层裁切</option><option value="fade">渐隐退场</option><option value="hide">定时隐藏</option></select></label><label>裁切轴<select v-model="draft.shell.axis"><option value="x">X</option><option value="y">Y</option><option value="z">Z</option></select></label><label>裁切方向<select v-model="draft.shell.direction"><option :value="1">正向</option><option :value="-1">反向</option></select></label><label>外壳退场时长（秒）<input v-model.number="draft.shell_duration" type="number" min="0" max="5" step="0.1" /></label><label>透视保留不透明度<input v-model.number="draft.shell.opacity" type="number" min="0" max="1" step="0.01" /></label><label class="check"><input v-model="draft.shell.wireframe" type="checkbox" /> 透视显示线框</label></div>
            <div class="target-editor"><strong>外壳节点</strong><p class="hint">请只选择实际外壳网格或外壳专用节点，不要选择包含内部总成的父节点；否则会阻止保存，避免拆解时组件消失。</p><div class="target-chips"><span v-for="entry in nodeEntries(draft.shell)" :key="`${entry.kind}:${entry.value}`" :title="entry.value">{{ entry.label }}<button type="button" :aria-label="`移除外壳 ${entry.label}`" @click="removeNode(draft.shell, entry)">×</button></span></div><input v-model="nodeQuery" placeholder="搜索外壳模型节点" /><select v-model="shellPendingNodes" multiple size="7" aria-label="外壳节点选择"><option v-for="node in nodeOptions" :key="node.path" :value="node.path">{{ formatNode(node) }}</option></select><button type="button" :disabled="!shellPendingNodes.length" @click="appendNodes(draft.shell, shellPendingNodes)">将选中节点加入外壳</button><label>按原始外壳节点名引用（一行一个）<textarea :value="draft.shell.node_names.join('\n')" rows="2" @input="draft.shell.node_names = splitNodes($event.target.value)" /></label></div>
            <h4>分解运动与时间轴</h4><div class="grid three"><label>位移坐标<select v-model="draft.offset_space"><option value="model">模型坐标（推荐新配置）</option><option value="parent">父节点坐标（兼容旧版）</option></select></label><label>默认运动时长（秒）<input v-model.number="draft.animation_duration" type="number" min="0.05" max="10" step="0.05" /></label><label>部件依次间隔（秒）<input v-model.number="draft.stagger" type="number" min="0" max="1" step="0.01" /></label><label>缓动曲线<select v-model="draft.easing"><option value="smoothstep">平滑起止</option><option value="cubic">立方缓入缓出</option><option value="linear">匀速</option></select></label></div><p class="hint">每件开始时间 = 外壳退场时长 + 部件顺序 × 依次间隔 + 额外延迟。反向组装沿同一时间轴倒放，可在任意位置暂停或反转。</p>
            <div class="part-timing-list"><div v-for="part in timeline.parts" :key="part.id"><span>{{ draft.parts.find(item => item.id === part.id)?.name }}</span><div><i :style="{ left: `${part.start / timeline.duration * 100}%`, width: `${part.duration / timeline.duration * 100}%` }" /></div><small>{{ part.start.toFixed(2) }}–{{ (part.start + part.duration).toFixed(2) }}s</small></div></div>
        </section>

        <section v-if="activeSection === 'camera'" class="configuration-section">
            <div class="grid two"><label class="check"><input v-model="draft.labels.enabled" type="checkbox" /> 默认显示空间标签</label><label class="check"><input v-model="draft.labels.leader_lines" type="checkbox" /> 显示标签引线</label></div>
            <div class="stage-camera-cards"><article v-for="stage in [{key:'solid',name:'完整设备'},{key:'xray',name:'透视内部'},{key:'exploded',name:'全部拆解'}]" :key="stage.key"><header><h4>{{ stage.name }}</h4><button type="button" @click="emit('command', {command:'stage', stage:stage.key})">预览此镜头</button></header><div class="grid two"><label>低代码视角 ID<input v-model="draft[stage.key].view_id" placeholder="可选，桥接大屏视角" /></label><label>独立镜头过渡（秒）<input v-model.number="draft[stage.key].transition_seconds" type="number" min="0.05" max="10" step="0.05" /></label></div><InspectionCameraFields v-model="draft[stage.key].camera" :label="stage.name" @capture="captureCamera(stage.key)" /></article></div><p class="hint">拆解与组装过程中镜头和完整时间轴同步。鼠标拖动预览可手动构图，再点“记录当前预览镜头”。</p>
        </section>

        <section v-if="activeSection === 'exchange'" class="configuration-section">
            <h4>将未保存草稿推送到 Unity 设备</h4><p class="hint">仅影响选中设备的内存预览，不写数据库。发布前请保存；运行端重新载入配置会丢弃草稿预览。</p><div class="native-preview-row"><select :value="previewDeviceId" aria-label="选择运行端预览设备" @change="emit('update:previewDeviceId', $event.target.value)"><option value="">选择使用此模型的设备</option><option v-for="device in matchingDevices" :key="device.id" :value="device.id">{{ device.name }} · {{ device.id }}</option></select><button type="button" class="primary" :disabled="nativePreviewBusy || !validation.valid || !matchingDevices.some(device => device.id === previewDeviceId)" @click="emit('native-preview')">{{ nativePreviewBusy ? '推送中…' : '推送草稿并预览' }}</button></div><small v-if="!matchingDevices.length" class="hint">当前场景没有使用此模型的设备，请先在设备配置中选择此模型。</small>
            <h4>JSON 交换</h4><p class="hint">可直接交换 inspection 对象，也接受包含 inspection 的模型元数据。导入不直接保存，稳定部件 ID 和点位 ID 原样保留。</p><div class="button-row"><button type="button" @click="jsonInput?.click()">选择 JSON 文件</button><button type="button" @click="jsonDraft = JSON.stringify(normalizeInspection(draft, partBindings), null, 2)">把当前草稿填入编辑器</button><button type="button" @click="exportJson">导出 JSON</button></div><input ref="jsonInput" type="file" accept=".json,application/json" hidden @change="readJsonFile" /><textarea v-model="jsonDraft" class="json-editor" rows="16" spellcheck="false" aria-label="拆解配置 JSON" placeholder="在此粘贴 inspection JSON…" /><button type="button" :disabled="!jsonDraft.trim()" @click="importJson">校验并载入草稿</button>
        </section>
        <footer class="editor-footer"><span>{{ draft.parts.length }} 个部件 · {{ nodeEntries(draft.shell).length }} 个外壳引用 · {{ validation.valid ? '校验通过' : '配置需修正' }}</span><button type="button" class="primary" :disabled="saving || !validation.valid || !nodes.length" @click="save">保存拆解配置</button></footer>
    </div>
</template>

<style scoped>
.inspection-authoring { --ink: #223d4c; --muted: #667e8b; --line: #dce6eb; color: var(--ink); font-size: 14px; }
.inspection-authoring * { box-sizing: border-box; }
.inspection-authoring input[hidden] { display: none !important; }
button, input, textarea, select { font: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-height: 32px; padding: 6px 10px; color: #365664; border: 1px solid #c8d8df; border-radius: 6px; background: #fff; cursor: pointer; white-space: nowrap; font-size: 13px; }
button:hover:not(:disabled) { background: #eaf5f8; border-color: #6ca9bb; }
button:disabled { cursor: not-allowed; opacity: .45; }
button.primary { background: #137c91; color: #fff; border-color: #137c91; }
button.primary:hover:not(:disabled) { background: #086578; }
button.danger { color: #b54b49; }
button.active { background: #d9f1f6; border-color: #53a6ba; color: #095d73; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #219db8; outline-offset: 2px; }
input:not([type=checkbox]):not([type=range]), select, textarea { display: block; width: 100%; min-width: 0; border: 1px solid #cddbe2; border-radius: 6px; background: #fff; padding: 8px; color: #294b5b; }
textarea { resize: vertical; min-height: 60px; line-height: 1.5; }
select[multiple] { font-size: 13px; }
input[type=checkbox], input[type=range] { accent-color: #13889e; }
label { display: grid; gap: 6px; color: #526c79; font-size: 13px; min-width: 0; }
label.check { display: inline-flex; align-items: center; gap: 6px; }
h3, h4, p { margin: 0; }
h3 { font-size: 19px; color: #174659; }
h4 { font-size: 15px; }
.editor-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
.editor-heading > div { flex: 1; min-width: 200px; }
.editor-heading p { color: var(--muted); font-size: 13px; margin-top: 6px; line-height: 1.55; }
.draft-indicator { border: 1px solid #c9dfd6; padding: 4px 7px; border-radius: 5px; background: #eef7f2; color: #427363; font-size: 12px; }
.draft-indicator.dirty { border-color: #ecd4a3; background: #fff7e7; color: #a27026; }
.inspection-playback { display: grid; gap: 10px; padding: 14px; background: #eef5f8; border: 1px solid #ccdde5; border-radius: 9px; }
.playback-buttons, .button-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.playback-buttons .check { margin-left: auto; }
.timeline-scrub { display: flex; align-items: center; gap: 12px; color: #23596c; font-variant-numeric: tabular-nums; }
.timeline-scrub input { flex: 1; min-width: 100px; }
.timeline-scrub span { min-width: 42px; }
.timeline-speed { display: flex; align-items: center; gap: 10px; color: #23596c; font-variant-numeric: tabular-nums; }
.timeline-speed > span { min-width: 70px; font-weight: 600; }
.timeline-speed input { flex: 1; min-width: 100px; }
.timeline-speed strong { min-width: 48px; color: #137c91; text-align: center; }
.timeline-speed button { min-height: 27px; padding: 3px 8px; font-size: 12px; }
.speed-hint { display: flex; align-items: center; gap: 12px; color: #6b8793; font-size: 11px; }
.speed-hint small { margin-left: auto; color: #527957; }
.timeline-phases { display: flex; gap: 4px; color: #557888; font-size: 12px; }
.timeline-phases span { background: #c7e0ea; border-radius: 3px; padding: 5px 7px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.timeline-phases span + span { background: #d8e9d9; color: #527957; }
.preset-row, .native-preview-row { display: flex; align-items: center; gap: 8px; margin: 12px 0; }
.preset-row select, .native-preview-row select { flex: 1; }
.hint { color: var(--muted); font-size: 12px; line-height: 1.6; }
.confirmation { margin: 12px 0; padding: 12px; background: #fff6e3; border: 1px solid #e9c888; border-radius: 7px; }
.confirmation p { color: #7f622e; margin-bottom: 9px; line-height: 1.6; }
.confirmation button + button { margin-left: 8px; }
.editor-notice { margin: 10px 0; padding: 9px 12px; border-left: 3px solid #4b9cad; background: #eef8fa; color: #377182; font-size: 13px; line-height: 1.5; }
.validation-errors { padding: 12px; margin: 10px 0; color: #9c3330; background: #fff0ee; border: 1px solid #efc3bd; border-radius: 7px; font-size: 13px; }
.validation-errors ul, .validation-warnings ul { padding-left: 19px; margin: 8px 0 0; line-height: 1.7; }
.validation-errors button { min-height: 22px; font-size: 11px; padding: 1px 5px; color: #973d37; border-color: #e2aaa0; background: #fff; }
.validation-warnings { color: #97712f; padding: 8px 10px; background: #fff9ed; border: 1px solid #eee0bd; border-radius: 7px; font-size: 13px; }
.editor-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin: 15px 0 14px; padding-bottom: 8px; }
.editor-tabs button { flex: 1; border-color: transparent; background: #f4f7f9; }
.editor-tabs button.active { background: #e2f2f7; border-color: #b7d8e3; }
.generator-panel, .target-editor, .part-camera-panel, .point-link-panel { padding: 12px; background: #f8fbfc; border: 1px solid var(--line); border-radius: 7px; }
summary { cursor: pointer; font-size: 13px; font-weight: 600; }
details[open] > summary { margin-bottom: 10px; }
.generator-panel { margin-bottom: 14px; }
.generator-panel .hint { margin-bottom: 10px; }
.grid { display: grid; gap: 10px; }
.grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.part-workbench { display: grid; grid-template-columns: minmax(155px, .7fr) minmax(0, 2fr); gap: 14px; align-items: start; }
.part-list { border: 1px solid var(--line); background: #fafcfd; border-radius: 8px; overflow: hidden; position: sticky; top: 0; max-height: 760px; overflow-y: auto; }
.part-list > header { display: grid; gap: 8px; padding: 11px; border-bottom: 1px solid var(--line); font-size: 13px; }
.part-list > header button { width: 100%; }
.part-list-row { display: flex; align-items: center; padding-right: 9px; border-bottom: 1px solid #eaf0f3; }
.part-list-row.selected { background: #e0f1f6; box-shadow: inset 3px 0 #26899e; }
.part-list-row.disabled { opacity: .55; }
.part-select { flex: 1; min-width: 0; border: 0; border-radius: 0; padding: 11px 8px; background: transparent; text-align: left; justify-content: start; gap: 9px; }
.part-select:hover:not(:disabled) { background: transparent; }
.part-select > span { font-size: 12px; color: #81a0ae; font-variant-numeric: tabular-nums; }
.part-select > div { min-width: 0; display: grid; gap: 4px; }
.part-select strong { white-space: normal; font-size: 13px; line-height: 1.4; }
.part-select small { color: #6d8b99; font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.part-properties { display: grid; gap: 13px; min-width: 0; }
.part-property-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.part-property-heading > strong { flex: 1; font-size: 15px; }
.part-property-heading button { min-height: 28px; padding: 3px 7px; font-size: 12px; }
.target-editor { display: grid; gap: 8px; }
.target-editor > strong { font-size: 13px; }
.target-editor details { margin-top: 2px; }
.target-editor details label { margin-top: 8px; }
.target-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.target-chips > span { display: inline-flex; align-items: center; max-width: 100%; padding-left: 6px; color: #4f7989; border: 1px solid #c3dce6; border-radius: 4px; background: #eaf4f8; font-size: 12px; overflow-wrap: anywhere; }
.target-chips button { color: #7e99a5; padding: 1px 6px; min-height: 24px; border: 0; background: transparent; }
.point-link-panel label { margin-bottom: 9px; }
.empty-state { padding: 25px 14px; color: #7a909b; font-size: 13px; line-height: 1.7; }
.configuration-section { display: grid; gap: 16px; }
.section-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; justify-content: space-between; }
.part-timing-list { display: grid; gap: 8px; }
.part-timing-list > div { display: grid; grid-template-columns: 140px minmax(100px, 1fr) 85px; gap: 10px; align-items: center; font-size: 12px; }
.part-timing-list > div > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.part-timing-list > div > div { position: relative; height: 10px; border-radius: 4px; background: #eaf1f4; }
.part-timing-list i { position: absolute; height: 100%; top: 0; background: #63a9bd; border-radius: 3px; }
.part-timing-list small { font-variant-numeric: tabular-nums; color: #728b97; text-align: right; }
.stage-camera-cards { display: grid; gap: 12px; }
.stage-camera-cards article { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: #f8fbfc; }
.stage-camera-cards header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.json-editor { font-family: Consolas, monospace; font-size: 12px; background: #f7fafb !important; }
.editor-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
.editor-footer span { color: var(--muted); font-size: 12px; }
button, label, summary, .part-select strong { font-size: 14px; }
@media(max-width: 980px) { .part-workbench { grid-template-columns: minmax(0, 1fr); } .part-list { position: static; max-height: 240px; } .part-list > header { display: flex; align-items: center; justify-content: space-between; } .part-list > header button { width: auto; } .part-list-row { display: inline-flex; width: 50%; vertical-align: top; } .grid.three { grid-template-columns: repeat(2, minmax(0, 1fr)); } .preset-row { flex-wrap: wrap; } .preset-row select { flex-basis: 100%; } }
@media(max-width: 600px) { .grid.two, .grid.three { grid-template-columns: minmax(0, 1fr); } .editor-tabs { flex-wrap: wrap; } .editor-tabs button { flex-basis: 45%; } .native-preview-row { flex-direction: column; align-items: stretch; } .part-timing-list > div { grid-template-columns: 85px minmax(50px, 1fr) 75px; gap: 5px; } .playback-buttons .check { margin-left: 0; } .speed-hint { flex-wrap: wrap; gap: 7px; } .speed-hint small { flex-basis: 100%; margin-left: 0; } }
</style>
