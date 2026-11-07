<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { LoadingPortPreview } from '../../../three/LoadingPortPreview.js'
import { normalizeLoadingPorts, normalizeLoadingPortOverrides, validateLoadingPorts, validateLoadingPortOverrides, resolveLoadingPort } from '../../../../../shared/loadingPorts.mjs'

const props = defineProps({ model: { type: Object, required: true }, device: { type: Object, default: null }, confirm: { type: Function, default: async () => false } })
const emit = defineEmits(['saved'])
const viewport = ref(null), loaded = ref(null), draft = ref(null), savedSignature = ref(''), activeKind = ref('inlet')
const loading = ref(false), saving = ref(false), error = ref(''), message = ref(''), conflict = ref(false)
const previewLoading = ref(false), previewReady = ref(false), previewError = ref(''), nodes = ref([]), nodeQuery = ref(''), selectedNode = ref(''), suggestion = ref(null)
const context = ref(null), pendingContext = ref(null)
let generation = 0, disposed = false, mounted = false, requestAbort, saveAbort, previewAbort, preview
const clone = value => JSON.parse(JSON.stringify(value))
const emptyConfig = () => ({ version: 1, inlet: null, outlet: null })
const metadataOf = model => typeof model?.metadata === 'string' ? JSON.parse(model.metadata) : model?.metadata || {}
const requestedContext = () => ({ model: props.model, device: props.device, key: `${props.model?.id || ''}:${props.device?.id || ''}` })
const instanceMode = computed(() => !!context.value?.device)
const editable = computed(() => canAdminPage(instanceMode.value ? 'devices' : 'models', 'edit'))
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== savedSignature.value)
const busy = computed(() => loading.value || saving.value)
const title = computed(() => context.value?.device?.name || context.value?.model?.name || context.value?.model?.id || '模型')
const kindLabel = computed(() => activeKind.value === 'inlet' ? '进料口' : '出料口')
const row = computed(() => draft.value?.[activeKind.value] || null)
const basePorts = computed(() => {
  if (!loaded.value) return emptyConfig()
  try { return instanceMode.value ? normalizeLoadingPorts(metadataOf(loaded.value.model).loadingPorts) : normalizeLoadingPorts(draft.value) }
  catch { return emptyConfig() }
})
const basePort = computed(() => basePorts.value[activeKind.value])
const picking = computed(() => !!draft.value && previewReady.value && !previewLoading.value && !busy.value && editable.value && !conflict.value && !pendingContext.value && (!instanceMode.value || !!basePort.value))
const validation = computed(() => !draft.value ? { valid: false, errors: [] } : (instanceMode.value ? validateLoadingPortOverrides(draft.value) : validateLoadingPorts(draft.value)))
const saveProblem = computed(() => validation.value.errors[0]?.message || '')
const effectivePorts = computed(() => {
  if (!validation.value.valid || !loaded.value) return emptyConfig()
  try {
    const model = { ...loaded.value.model, metadata: { ...metadataOf(loaded.value.model), loadingPorts: basePorts.value } }
    const device = instanceMode.value ? { instance_config: { loadingPortOverrides: validation.value.normalized } } : null
    return { version: 1, inlet: resolveLoadingPort(model, device, 'inlet'), outlet: resolveLoadingPort(model, device, 'outlet') }
  } catch { return emptyConfig() }
})
const effectivePort = computed(() => effectivePorts.value[activeKind.value])
const otherKind = computed(() => activeKind.value === 'inlet' ? 'outlet' : 'inlet')
const otherKindLabel = computed(() => otherKind.value === 'inlet' ? '进料口' : '出料口')
const otherPort = computed(() => effectivePorts.value[otherKind.value])
const canUseOtherPosition = computed(() => canChange() && !!otherPort.value && (!instanceMode.value || !!basePort.value))
const angle = computed(() => row.value && !instanceMode.value ? Math.atan2(-row.value.direction[2], row.value.direction[0]) * 180 / Math.PI : 0)
const nodeOptions = computed(() => {
  const query = nodeQuery.value.trim().toLocaleLowerCase()
  return nodes.value.filter(node => !query || `${node.name} ${node.path}`.toLocaleLowerCase().includes(query)).slice(0, 500)
})
const format = value => Number.isFinite(value) ? Number(value.toFixed(5)).toLocaleString('zh-CN', { maximumFractionDigits: 5 }) : '—'
const canChange = () => !disposed && !!draft.value && !busy.value && editable.value && !conflict.value && !pendingContext.value

function setEnabled(enabled) {
  if (!canChange()) return
  if (instanceMode.value) {
    if (enabled && !basePort.value) return
    draft.value[activeKind.value] = enabled ? { offset: [0, 0, 0], yawDegrees: 0 } : null
  } else {
    // Enabling a port is not evidence of a selected location. Never invent an origin point.
    if (enabled) { togglePicking(); return }
    draft.value[activeKind.value] = null
  }
  suggestion.value = null; error.value = ''
  message.value = enabled ? '已启用手动偏移草稿；也可以直接点击右侧模型选点，保存后生效。' : instanceMode.value ? '已恢复沿用模型默认，保存后生效；仍可直接点击右侧重新微调。' : '已清除选点。此口可跳过，也可以直接点击右侧重新设置；保存后生效。'
}
function setAngle(value) {
  if (!row.value || instanceMode.value || !canChange()) return
  const degrees = Number(value)
  if (value === '' || !Number.isFinite(degrees)) { error.value = '方向角度必须是有限数字。'; return }
  const radians = degrees % 360 * Math.PI / 180
  row.value.direction = [Math.cos(radians), 0, -Math.sin(radians)]
}
function setDirection(direction) { if (row.value && !instanceMode.value && canChange()) row.value.direction = [...direction] }
function usePoint(point) {
  if (!canChange() || !point) return false
  if (!Array.isArray(point.position) || point.position.length !== 3 || !point.position.every(value => typeof value === 'number' && Number.isFinite(value))) {
    error.value = '选点位置无效，请在模型的真实表面重新点击。'; return false
  }
  try {
    if (instanceMode.value) {
      if (!basePort.value) { message.value = '模型尚未设置此口，可以跳过；如需微调，请先到模型管理设置可选的进出料口基准点。'; return false }
      const override = { offset: point.position.map((value, axis) => value - basePort.value.position[axis]), yawDegrees: row.value?.yawDegrees ?? 0 }
      draft.value[activeKind.value] = normalizeLoadingPortOverrides({ ...emptyConfig(), [activeKind.value]: override })[activeKind.value]
      message.value = `此设备的${kindLabel.value}基准点已写入微调草稿。仅记录相对模型的偏移，原方向与模型默认不变；保存后生效。`
    } else {
      const supplied = point.direction
      const surfaceDirection = Array.isArray(supplied) && supplied.length === 3 && supplied.every(Number.isFinite) && supplied[1] === 0 && (supplied[0] !== 0 || supplied[2] !== 0) ? supplied : [1, 0, 0]
      const candidate = normalizeLoadingPorts({ ...emptyConfig(), [activeKind.value]: { position: [...point.position], direction: row.value?.direction || surfaceDirection, nodeName: point.nodeName ?? row.value?.nodeName ?? '' } })[activeKind.value]
      if (row.value) { row.value.position = candidate.position; row.value.nodeName = candidate.nodeName }
      else draft.value[activeKind.value] = candidate
      message.value = `${kindLabel.value}单点位置已写入草稿。Y 是轨道／料盘齐平的送料基准高度；可继续点击修改，保存后生效。`
    }
    suggestion.value = null; error.value = ''; return true
  } catch (cause) { error.value = `选点未应用：${cause.message || cause}`; return false }
}
function useOtherPosition() {
  if (!canUseOtherPosition.value) return false
  const source = otherPort.value
  if (!usePoint({ position: [...source.position], direction: [...source.direction], nodeName: source.nodeName })) return false
  message.value = `${kindLabel.value}的位置已设为与${otherKindLabel.value}相同；已有方向设置保留，保存后生效。`
  return true
}
function useNode(bottom = false) {
  const point = preview?.nodePoint(selectedNode.value, bottom)
  if (!point) { error.value = '选中节点没有可测量的网格。'; return }
  if (!usePoint(point)) return
  message.value = bottom ? '已取节点底部（包围盒最低点）。它不一定是送料轨道高度，请调整 Y 后保存。' : '已取节点中心作为定位起点，不代表送料高度。请将 Y 调整到实际轨道／料盘基准后保存。'
}
function readSuggestion() {
  if (!canChange() || instanceMode.value) return
  try {
    const candidate = preview?.infer(null, loaded.value?.model || context.value?.model, activeKind.value)
    if (!candidate) { suggestion.value = null; message.value = '该模型结构无法可靠识别此口。请点击真实表面或选择节点，再手动设置送料高度与方向。'; return }
    const normalized = normalizeLoadingPorts({ version: 1, inlet: null, outlet: null, [activeKind.value]: { position: candidate.position, direction: candidate.direction, nodeName: candidate.nodeName || '' } })
    suggestion.value = normalized[activeKind.value]
    message.value = '已读取结构建议（虚线点），尚未写入草稿。请核对后点击“应用建议”，再保存。'
  } catch (cause) { error.value = `读取结构建议失败：${cause.message || cause}` }
}
function applySuggestion() {
  if (!suggestion.value || !canChange() || instanceMode.value) return
  draft.value[activeKind.value] = clone(suggestion.value); suggestion.value = null
  message.value = '结构建议已应用到草稿，尚未保存。请检查送料高度与外向箭头。'
}
function togglePicking() {
  // Compatibility helper: picking is always enabled when legal, not a separate UI mode.
  if (!picking.value) return
  suggestion.value = null; error.value = ''
  message.value = `直接点击右侧${kindLabel.value}下沿，与轨道／料盘齐平的单个基准点；重新点击即可修改，拖动与缩放不会设点。`
}

async function preparePreview() {
  const requestedGeneration = generation
  await nextTick()
  if (disposed || generation !== requestedGeneration) return
  if (!mounted || !viewport.value || !loaded.value) return
  previewAbort?.abort(); previewAbort = new AbortController()
  const version = generation, controller = previewAbort
  previewLoading.value = true; previewReady.value = false; previewError.value = ''; nodes.value = []; selectedNode.value = ''
  preview?.dispose(); preview = null
  try {
    const runtime = new LoadingPortPreview(viewport.value, { onSurface: point => {
      if (disposed || generation !== version || preview !== runtime || controller.signal.aborted || !picking.value) return
      usePoint(point)
    } })
    preview = runtime
    const entries = await runtime.load(loaded.value.model, { signal: controller.signal })
    if (disposed || generation !== version || preview !== runtime || controller.signal.aborted) return
    nodes.value = entries || []; previewReady.value = true; runtime.setPorts(effectivePorts.value, suggestion.value, activeKind.value)
  } catch (cause) {
    if (!disposed && generation === version && !controller.signal.aborted) { previewError.value = `三维预览不可用：${cause.message || cause}`; preview?.dispose(); preview = null }
  } finally { if (!disposed && generation === version && previewAbort === controller) previewLoading.value = false }
}

function checkResponse(result, target) {
  const object = target.device ? result?.device : result?.model
  if (result?.success !== true || String(object?.id || '') !== String((target.device || target.model)?.id || '') || !result?.model || result.revision == null) throw Object.assign(new Error(result?.error || '后端未确认进出料口配置，请重新读取后重试。'), { code: result?.code, status: result?.status })
  if (target.device && String(result.model.id) !== String(target.model?.id)) throw new Error('设备关联的模型已改变，请重新选择设备后读取配置。')
  if (!Object.hasOwn(result, target.device ? 'overrides' : 'ports')) throw new Error('后端响应缺少进出料口配置。')
  const value = target.device ? normalizeLoadingPortOverrides(result.overrides) : normalizeLoadingPorts(result.ports)
  // Validate the defaults independently: effective instance ports are NOT a
  // substitute for model defaults and must never be saved back into metadata.
  if (target.device) normalizeLoadingPorts(metadataOf(result.model).loadingPorts)
  return value
}

async function loadContext(target = requestedContext()) {
  const version = ++generation
  requestAbort?.abort(); previewAbort?.abort(); requestAbort = new AbortController()
  const controller = requestAbort
  context.value = target; pendingContext.value = null; loaded.value = null; draft.value = null; savedSignature.value = ''
  nodes.value = []; suggestion.value = null; selectedNode.value = ''; previewReady.value = false; preview?.dispose(); preview = null
  loading.value = true; error.value = ''; message.value = ''; conflict.value = false
  try {
    if (!target.model?.id || target.device && !target.device.id) throw new Error('请先选择模型或设备。')
    const result = target.device ? await adminApi.getDeviceLoadingPorts(target.device.id, { signal: controller.signal }) : await adminApi.getModelLoadingPorts(target.model.id, { signal: controller.signal })
    if (disposed || generation !== version || controller.signal.aborted) return false
    const value = checkResponse(result, target)
    loaded.value = result; draft.value = value; savedSignature.value = JSON.stringify(value)
    void preparePreview()
    return true
  } catch (cause) { if (!disposed && generation === version && !controller.signal.aborted) error.value = `读取配置失败：${cause.message || cause}`; return false }
  finally { if (!disposed && generation === version) loading.value = false }
}

async function save() {
  if (busy.value || !editable.value || !loaded.value || !draft.value || !validation.value.valid || conflict.value) return false
  if (!dirty.value) return true
  const version = generation, target = context.value, submitted = clone(validation.value.normalized)
  saveAbort?.abort(); saveAbort = new AbortController()
  const controller = saveAbort
  saving.value = true; error.value = ''; message.value = ''
  try {
    const body = { revision: loaded.value.revision, [target.device ? 'overrides' : 'ports']: submitted }
    const result = target.device ? await adminApi.saveDeviceLoadingPorts(target.device.id, body, { signal: controller.signal }) : await adminApi.saveModelLoadingPorts(target.model.id, body, { signal: controller.signal })
    if (disposed || generation !== version || controller.signal.aborted) return false
    const value = checkResponse(result, target)
    loaded.value = result; draft.value = value; savedSignature.value = JSON.stringify(value)
    message.value = target.device ? '此设备的进出料口微调已保存，模型默认配置未改变。' : '模型进出料口默认配置已保存，设备将按默认值与各自微调计算。'
    emit('saved', result)
    return true
  } catch (cause) {
    if (!disposed && generation === version && !controller.signal.aborted) {
      conflict.value = cause.status === 409 || cause.code === 'LOADING_PORT_CONFLICT'
      error.value = conflict.value ? '配置已被其他管理员修改。当前草稿已保留；请先复制重要数值，再“读取最新配置”，避免覆盖他人的版本。' : `保存失败，草稿已保留：${cause.message || cause}`
    }
    return false
  } finally {
    if (!disposed && generation === version) {
      saving.value = false
      if (!dirty.value && pendingContext.value) void loadContext(pendingContext.value)
    }
  }
}

function discardPending() {
  if (saving.value) return false
  if (savedSignature.value) draft.value = JSON.parse(savedSignature.value)
  suggestion.value = null
  // Discarding a draft does not refresh its stale revision. Keep the conflict
  // recovery visible until an explicit reload succeeds.
  if (!conflict.value) error.value = ''
  message.value = '已放弃未保存的修改。'
  if (pendingContext.value) void loadContext(pendingContext.value)
  return true
}
async function canLeave() {
  if (saving.value) return false
  if (!dirty.value) return true
  const version = generation
  const confirmed = await props.confirm('进出料口配置尚未保存，放弃修改并离开？')
  if (confirmed !== true || disposed || generation !== version || saving.value) return false
  return discardPending()
}
async function reloadConfig() {
  if (busy.value) return false
  if (dirty.value && !await props.confirm('重新读取将放弃当前进出料口草稿，继续？')) return false
  if (disposed) return false
  return loadContext(pendingContext.value || context.value || requestedContext())
}
async function acceptPendingContext() {
  const target = pendingContext.value
  if (!target || busy.value) return
  if (await canLeave() && context.value?.key !== target.key) await loadContext(target)
}

watch(() => `${props.model?.id || ''}:${props.device?.id || ''}`, () => {
  const target = requestedContext()
  if (target.key === context.value?.key) { pendingContext.value = null; return }
  if (dirty.value || saving.value) { pendingContext.value = target; return }
  void loadContext(target)
}, { immediate: true })
watch(activeKind, () => { suggestion.value = null; message.value = ''; selectedNode.value = '' })
watch(selectedNode, id => preview?.selectNode(id))
watch(picking, value => preview?.setPicking(value))
watch([effectivePorts, suggestion, activeKind], () => preview?.setPorts(effectivePorts.value, suggestion.value, activeKind.value), { deep: true })
onMounted(async () => { mounted = true; await nextTick(); if (loaded.value) void preparePreview() })
onUnmounted(() => { disposed = true; generation++; requestAbort?.abort(); saveAbort?.abort(); previewAbort?.abort(); preview?.dispose(); preview = null })
defineExpose({ canLeave, savePending: () => dirty.value ? save() : !busy.value, discardPending, busy })
</script>

<template>
  <section class="loading-port-editor" aria-label="进出料口配置" :aria-busy="busy">
    <header class="editor-heading">
      <div><h3>{{ title }} · {{ instanceMode ? '进出料口微调' : '进出料口（可选）' }}</h3><p>{{ instanceMode ? '只微调此设备，模型默认不变；没有交接对齐需求可以跳过。' : '需要小车或设备交接对齐时再设置；没有此需求可以跳过。' }}</p></div>
      <span v-if="dirty" class="dirty-badge">未保存</span>
    </header>
    <p v-if="pendingContext" class="warning" role="alert">已选择另一个对象，但当前草稿尚未处理。此处仍显示 {{ title }} 的配置。<button type="button" :disabled="busy" @click="acceptPendingContext">放弃草稿并切换</button></p>
    <p v-if="error" class="error" role="alert">{{ error }}<button v-if="conflict || !draft" type="button" :disabled="busy" @click="reloadConfig">{{ conflict ? '读取最新配置' : '重试读取' }}</button></p><p v-if="message" class="notice" role="status">{{ message }}</p>
    <div v-if="loading" class="initial-state" role="status">正在读取进出料口配置…</div>
    <div v-else-if="!draft" class="initial-state"><span>配置暂不可用，请重试读取。</span></div>
    <div v-else class="editor-body">
      <div class="config-panel">
        <nav class="port-tabs" aria-label="选择进出料口">
          <button v-for="kind in ['inlet','outlet']" :key="kind" type="button" :disabled="busy" :class="{ active: activeKind === kind, outlet: kind === 'outlet' }" :aria-pressed="activeKind === kind" @click="activeKind = kind"><strong>{{ kind === 'inlet' ? '进料口' : '出料口' }}</strong><small>{{ instanceMode ? basePorts[kind] ? draft[kind] ? '设备已微调' : '沿用模型默认' : '未设置 · 可跳过' : draft[kind] ? '已设置' : '未设置 · 可跳过' }}</small></button>
        </nav>
        <div class="point-guide"><strong>直接在右侧模型上点一下</strong><p>选择 {{ kindLabel }} 的下沿，与轨道／料盘齐平的<strong>单个送料基准点</strong>。</p><p>不用先启用或切换定位模式。选好后仍可继续点击修改，拖动旋转、滚轮缩放不会设点。</p></div>
        <p v-if="instanceMode && !basePort" class="base-missing" role="status">模型还没有设置此口，当前可跳过。如需设备微调，请到“模型管理 → 进出料口（可选）”先设置模型默认基准点。</p>
        <div v-else class="point-summary" :class="{configured:!!effectivePort}" role="status"><span>{{ kindLabel }}</span><strong>{{ effectivePort ? instanceMode ? row ? '此设备已微调' : '沿用模型默认点' : '已设置单点' : '未设置，可跳过' }}</strong><small>{{ effectivePort ? '重新点击可修改，保存后生效。' : '没有选点时保持未配置，不会自动创建。' }}</small></div>
        <div class="point-actions"><button type="button" :disabled="!picking" @click="togglePicking">重新选点</button><button type="button" :disabled="busy || !editable || conflict || !!pendingContext || !row" @click="setEnabled(false)">{{ instanceMode ? '恢复模型默认' : '清除选点' }}</button></div>
        <button v-if="otherPort" type="button" class="same-position" :disabled="!canUseOtherPosition" :title="instanceMode && !basePort ? '请先设置当前口的模型默认点，再微调此设备。' : `只将${kindLabel}位置设为与${otherKindLabel}相同，不自动保存。`" @click="useOtherPosition">与{{ otherKindLabel }}同位置</button>
        <p class="optional-note">这里只记录一个位置点，不设置区域或宽高。进料口、出料口均为可选；不配置不会影响模型使用。</p>
        <div class="save-actions"><button type="button" class="primary" :disabled="busy || !dirty || !editable || !!saveProblem || conflict" @click="save">{{ saving ? '正在保存…' : '保存配置' }}</button><button v-if="dirty" type="button" class="discard" :disabled="busy" @click="canLeave">放弃未保存修改</button></div>
        <p v-if="saveProblem" class="error" role="alert">{{ saveProblem }}</p><p v-if="!editable" class="hint readonly-note">当前账号为只读，可以查看但不能更改配置。</p>
        <details class="advanced-panel">
          <summary>高级微调 · 坐标、方向与辅助定位</summary>
          <p class="hint advanced-guide">普通设置只需直接选点。这里用于精确修正已有坐标／方向，或在三维预览不可用时辅助定位；修改后仍需手动保存。</p>
          <fieldset :disabled="busy || !editable || conflict || !!pendingContext" class="port-fields">
            <template v-if="instanceMode">
              <div class="default-summary"><strong>模型默认 {{ kindLabel }}</strong><template v-if="basePort"><span>X {{ format(basePort.position[0]) }} · Y {{ format(basePort.position[1]) }} · Z {{ format(basePort.position[2]) }}</span><small>外向方向 [{{ basePort.direction.map(format).join(', ') }}]</small></template><p v-else>模型尚未配置此口。实例微调不会自行创建新口，可以跳过。</p></div>
              <label v-if="basePort" class="enable-row"><span>手动输入设备偏移</span><input type="checkbox" :checked="!!row" :disabled="!basePort || busy || !editable" @change="setEnabled($event.target.checked)"></label>
              <template v-if="row"><div class="vector-fields"><label>X 偏移<input v-model.number="row.offset[0]" type="number" step="any" aria-label="进出料口 X 偏移"></label><label>Y 送料高度偏移<input v-model.number="row.offset[1]" type="number" step="any" aria-label="进出料口送料高度偏移"></label><label>Z 偏移<input v-model.number="row.offset[2]" type="number" step="any" aria-label="进出料口 Z 偏移"></label></div><label>水平方向微调（度）<input v-model.number="row.yawDegrees" type="number" step="any" aria-label="进出料口水平方向微调角度"></label><p class="hint">偏移相对模型默认口，正 Y 向上。重选点只改变偏移，不改变已有方向微调。</p></template>
              <div v-if="effectivePort" class="effective-summary"><strong>此设备实际使用的单点</strong><span>X {{ format(effectivePort.position[0]) }} · Y {{ format(effectivePort.position[1]) }} · Z {{ format(effectivePort.position[2]) }}</span></div>
            </template>
            <template v-else>
              <p v-if="!row" class="hint">还没有选点。可直接点右侧模型，或明确应用下方辅助结果；不会自动创建 [0,0,0] 点。</p>
              <template v-if="row"><div class="vector-fields"><label>X 位置<input v-model.number="row.position[0]" type="number" step="any" aria-label="进出料口 X 位置"></label><label>Y 送料高度<input v-model.number="row.position[1]" type="number" step="any" aria-label="进出料口 Y 送料高度"></label><label>Z 位置<input v-model.number="row.position[2]" type="number" step="any" aria-label="进出料口 Z 位置"></label></div><label>水平外向角度（度）<input :value="Number(angle.toFixed(4))" type="number" step="any" aria-label="进出料口水平外向角度" @input="setAngle($event.target.value)"></label><div class="direction-buttons" aria-label="快捷设置水平外向方向"><button type="button" @click="setDirection([1,0,0])">+X</button><button type="button" @click="setDirection([-1,0,0])">−X</button><button type="button" @click="setDirection([0,0,1])">+Z</button><button type="button" @click="setDirection([0,0,-1])">−Z</button></div><p class="hint">0° = +X，90° = −Z。方向用于交接对齐；重新选点保留已有方向。Y 是轨道／料盘基准高度，不是门板中心。</p><label>关联节点名称（可留空）<input v-model="row.nodeName" type="text" maxlength="512" aria-label="进出料口关联节点名称"></label></template>
              <details class="node-assistant"><summary>辅助定位 · 选真实模型节点</summary><label>搜索模型节点<input v-model="nodeQuery" type="search" placeholder="例如：炉口、轨道、门" aria-label="搜索进出料口模型节点"></label><label>选择节点<select v-model="selectedNode" aria-label="选择进出料口辅助节点"><option value="">请选择（选择不会改变配置）</option><option v-for="node in nodeOptions" :key="node.id" :value="node.id">{{ node.path }} ({{ node.meshCount }} 网格)</option></select></label><small v-if="nodes.length > 500" class="hint">最多展示 500 个结果，请搜索缩小范围。</small><div class="assistant-actions"><button type="button" :disabled="!selectedNode || !preview || previewLoading" @click="useNode(false)">取节点中心</button><button type="button" :disabled="!selectedNode || !preview || previewLoading" @click="useNode(true)">取节点底部</button></div><p class="hint">包围盒仅辅助定位，不是要设置区域。节点中心或最低点不一定是轨道／料盘高度，请核对 Y。</p></details>
              <div class="inference-actions"><button type="button" :disabled="!preview || previewLoading" @click="readSuggestion">从模型已有结构读取</button><button v-if="suggestion" type="button" class="primary" @click="applySuggestion">应用建议到草稿</button></div><p v-if="suggestion" class="hint">建议 X {{ format(suggestion.position[0]) }} · Y {{ format(suggestion.position[1]) }} · Z {{ format(suggestion.position[2]) }}，尚未写入配置。</p>
            </template>
          </fieldset>
        </details>
      </div>
      <section class="preview-panel" aria-label="独立进出料口预览">
        <div class="preview-toolbar"><span><i class="inlet-dot"></i>进料口 <i class="outlet-dot"></i>出料口</span><div><span class="current-port">当前：{{ kindLabel }}</span><button type="button" :disabled="!preview || previewLoading" @click="preview?.resetCamera()">完整视图</button></div></div>
        <p v-if="picking" class="pick-tip">点击 {{ kindLabel }} 下沿的单个基准点 · 可重复修改</p>
        <div class="preview-stage"><div ref="viewport" class="viewport"></div><div v-if="previewLoading" class="preview-overlay" role="status">正在载入原始模型…</div><div v-else-if="previewError" class="preview-overlay"><p>{{ previewError }}</p><button type="button" @click="preparePreview">重试三维预览</button><small>可展开“高级微调”查看或修正已有数据。</small></div></div>
        <p class="preview-caption">拖动旋转 · 滚轮缩放。仅记录模型本地单点，不改变模型文件或比例，不自动保存。{{ instanceMode ? '视图展示模型默认点加本设备微调。' : suggestion ? '虚线透明点是未应用建议。' : '点标记就是当前进出料口基准点。' }}</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.loading-port-editor{display:flex;flex-direction:column;min-width:0;min-height:0;color:#24364b;background:#fff;font-size:calc(15px * var(--admin-font-scale,1));line-height:1.6;container-type:inline-size;container-name:loading-port-editor}
.editor-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px;border-bottom:1px solid #dfe6ef;flex-wrap:wrap}
.editor-heading h3{margin:0 0 6px;font-size:calc(18px * var(--admin-font-scale,1));color:#24364b}
.editor-heading p{margin:0;color:#526177;font-size:calc(14px * var(--admin-font-scale,1))}
.assistant-actions,.inference-actions,.preview-toolbar>div{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
button,input,select{font:inherit}button{border:1px solid #cbd5e3;border-radius:7px;background:#fff;color:#40546f;padding:9px 12px;font-size:calc(14px * var(--admin-font-scale,1));cursor:pointer}
button:hover:not(:disabled){background:#eef3fb;border-color:#658ac4}button.primary{background:#2b5db6;color:white;border-color:#2b5db6}button.primary:hover:not(:disabled){background:#224f9f}
button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #2b5db6;outline-offset:3px}
.dirty-badge{background:#fff6df;color:#805810;padding:4px 9px;border-radius:20px;font-size:calc(13px * var(--admin-font-scale,1))}
.error,.notice,.warning{padding:12px 14px;border-radius:7px;margin:12px 20px 0;line-height:1.7;overflow-wrap:anywhere}
.error{background:#fff1f2;border:1px solid #efc9ce;color:#a72d39}.notice{background:#edf4ff;border:1px solid #cbdcf3;color:#2459a6}.warning{background:#fff6df;border:1px solid #ead6a5;color:#805810}.warning button,.error button{margin-left:12px}
.initial-state{min-height:220px;display:grid;place-items:center;color:#526177}
.editor-body{display:grid;grid-template-columns:minmax(280px,340px) minmax(0,1fr);min-height:530px;flex:1}
.config-panel{padding:20px;min-width:0;border-right:1px solid #dfe6ef}
.port-tabs{display:grid;grid-template-columns:1fr 1fr;gap:10px}.port-tabs button{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:12px;text-align:left}
.port-tabs button.active{background:#e9f6fb;border-color:#3a8a9f;color:#12627a}.port-tabs button.outlet.active{background:#fff4e8;border-color:#b58a48;color:#805810}
.port-tabs strong{font-size:calc(15px * var(--admin-font-scale,1))}.port-tabs small{font-size:calc(13px * var(--admin-font-scale,1));color:#526177}
.point-guide{margin:18px 0;padding:15px;background:#f5f8fc;border-radius:8px;line-height:1.75}.point-guide>strong{color:#30465e;font-size:calc(15px * var(--admin-font-scale,1))}.point-guide p{margin:9px 0 0;font-size:calc(14px * var(--admin-font-scale,1));color:#40546f}
.point-summary{display:grid;gap:5px;padding:14px;border:1px solid #dfe6ef;border-radius:8px;background:#f7f9fc;color:#526177}.point-summary>span,.point-summary small{font-size:calc(13px * var(--admin-font-scale,1))}.point-summary strong{font-weight:600;color:#40546f}.point-summary.configured{background:#edf7f1;border-color:#c8e1d2}.point-summary.configured strong{color:#23694b}
.base-missing{padding:14px;border:1px solid #ead6a5;border-radius:8px;background:#fff6df;color:#805810;font-size:calc(14px * var(--admin-font-scale,1));line-height:1.75}
.point-actions{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0}.optional-note{margin:15px 0;color:#526177;font-size:calc(13px * var(--admin-font-scale,1));line-height:1.75}
.same-position{width:100%;background:#edf3ff;border-color:#bdcff0;color:#2459a6}
.save-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:18px 0}.save-actions>.primary{flex:1;min-height:42px;font-weight:500}.discard{color:#526177}.readonly-note{margin-top:14px}
.advanced-panel{border-top:1px solid #dfe6ef;padding-top:17px;margin-top:18px}.advanced-panel>summary{cursor:pointer;font-weight:600;font-size:calc(14px * var(--admin-font-scale,1));color:#2459a6;line-height:1.7}.advanced-guide{margin:14px 0!important}
.port-fields{border:0;padding:0;margin:0;display:grid;gap:14px;min-width:0}.port-fields label{display:flex;flex-direction:column;gap:8px;color:#40546f;min-width:0;font-size:calc(14px * var(--admin-font-scale,1))}
.port-fields .enable-row{display:flex;flex-direction:row;align-items:center;justify-content:space-between;color:#30465e;font-weight:600;padding:4px 0}.enable-row input{width:18px;height:18px;accent-color:#2b5db6}
.port-fields input:not([type=checkbox]),select{border:1px solid #cbd5e3;background:white;border-radius:7px;padding:9px 10px;min-width:0;width:100%;box-sizing:border-box;color:#24364b;font-size:calc(15px * var(--admin-font-scale,1))}
.vector-fields{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:8px}.vector-fields input{padding-left:7px!important;padding-right:3px!important;font-variant-numeric:tabular-nums}
.direction-buttons{display:flex;gap:7px}.direction-buttons button{flex:1;padding:7px}
.hint{color:#596579;font-size:calc(13px * var(--admin-font-scale,1));line-height:1.75;margin:0;overflow-wrap:anywhere}
.default-summary,.effective-summary{display:grid;gap:8px;padding:14px;background:#f5f8fc;border:1px solid #dfe6ef;border-radius:8px;line-height:1.7;font-size:calc(14px * var(--admin-font-scale,1))}.default-summary p{margin:0;color:#526177}.default-summary small{color:#596579;font-size:calc(13px * var(--admin-font-scale,1))}.effective-summary{background:#edf7f1;border-color:#c8e1d2;color:#23694b}
.node-assistant{border-top:1px solid #dfe6ef;padding-top:14px}.node-assistant summary{cursor:pointer;font-weight:600;color:#40546f;margin-bottom:14px;font-size:calc(14px * var(--admin-font-scale,1))}.node-assistant label,.node-assistant .assistant-actions{margin-bottom:12px}.inference-actions button{font-size:calc(14px * var(--admin-font-scale,1))}.config-panel>.error{margin:14px 0 0}
.preview-panel{display:flex;flex-direction:column;min-width:0;min-height:0;padding:18px;background:#f8faff}.preview-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap;font-size:calc(14px * var(--admin-font-scale,1))}.preview-toolbar>span{display:flex;align-items:center;gap:6px;white-space:nowrap}.preview-toolbar button{padding:8px 10px}.current-port{font-size:calc(13px * var(--admin-font-scale,1));color:#526177}
.inlet-dot,.outlet-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#168aa7}.outlet-dot{background:#e78b22;margin-left:8px}
.preview-stage{position:relative;flex:1;min-height:470px;border:1px solid #dfe6ef;border-radius:10px;overflow:hidden;background:#f1f5f9}.viewport{position:absolute;inset:0}.preview-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:12px;text-align:center;background:#f2f6fa;color:#40546f;line-height:1.75}.preview-overlay p{margin:0;overflow-wrap:anywhere}.preview-overlay small{color:#526177;font-size:calc(13px * var(--admin-font-scale,1))}
.pick-tip{margin:0 0 12px;padding:10px;border:1px solid #c6dce8;border-radius:6px;background:#edf8ff;color:#12627a;text-align:center;pointer-events:none;font-size:calc(14px * var(--admin-font-scale,1))}.preview-caption{margin:12px 2px 0;color:#526177;line-height:1.75;font-size:calc(13px * var(--admin-font-scale,1))}
@container loading-port-editor (max-width:850px){.editor-body{grid-template-columns:minmax(0,1fr);flex:none}.config-panel{border-right:0;border-bottom:1px solid #dfe6ef}.preview-stage{min-height:400px}.preview-panel{min-height:460px}}
@media(max-width:850px){.editor-body{grid-template-columns:minmax(0,1fr);flex:none}.config-panel{border-right:0;border-bottom:1px solid #dfe6ef}.preview-stage{min-height:400px}.preview-panel{min-height:460px}}
@media(max-width:500px){.editor-heading{padding:14px}.config-panel,.preview-panel{padding:12px}.vector-fields{grid-template-columns:1fr}.error,.notice,.warning{margin-left:12px;margin-right:12px}}
</style>
