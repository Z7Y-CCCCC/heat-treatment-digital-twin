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
const previewLoading = ref(false), previewError = ref(''), nodes = ref([]), nodeQuery = ref(''), selectedNode = ref(''), picking = ref(false), suggestion = ref(null)
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
const angle = computed(() => row.value && !instanceMode.value ? Math.atan2(-row.value.direction[2], row.value.direction[0]) * 180 / Math.PI : 0)
const nodeOptions = computed(() => {
  const query = nodeQuery.value.trim().toLocaleLowerCase()
  return nodes.value.filter(node => !query || `${node.name} ${node.path}`.toLocaleLowerCase().includes(query)).slice(0, 500)
})
const format = value => Number.isFinite(value) ? Number(value.toFixed(5)).toLocaleString('zh-CN', { maximumFractionDigits: 5 }) : '—'

function setEnabled(enabled) {
  if (!draft.value || busy.value || !editable.value) return
  if (instanceMode.value) {
    if (enabled && !basePort.value) return
    draft.value[activeKind.value] = enabled ? { offset: [0, 0, 0], yawDegrees: 0 } : null
  } else {
    draft.value[activeKind.value] = enabled ? { position: [0, 0, 0], direction: [1, 0, 0], nodeName: '' } : null
  }
  suggestion.value = null; message.value = enabled ? '已加入草稿；请在三维视图检查位置、送料高度和方向后保存。' : instanceMode.value ? '已恢复沿用模型默认，保存后生效。' : '该口已设为未配置，保存后不参与进出料对齐。'
}
function setAngle(value) {
  if (!row.value || instanceMode.value || busy.value || !editable.value) return
  const degrees = Number(value)
  if (value === '' || !Number.isFinite(degrees)) { error.value = '方向角度必须是有限数字。'; return }
  const radians = degrees % 360 * Math.PI / 180
  row.value.direction = [Math.cos(radians), 0, -Math.sin(radians)]
}
function setDirection(direction) { if (row.value && !instanceMode.value && !busy.value && editable.value) row.value.direction = [...direction] }
function usePoint(point) {
  if (!point || instanceMode.value || busy.value || !editable.value || !draft.value) return
  if (!row.value) draft.value[activeKind.value] = { position: [...point.position], direction: [1, 0, 0], nodeName: point.nodeName || '' }
  else { row.value.position = [...point.position]; row.value.nodeName = point.nodeName || '' }
  suggestion.value = null
  message.value = '位置已写入草稿。Y 是真实送料基准高度，请核对后保存；方向未自动改变。'
}
function useNode(bottom = false) {
  const point = preview?.nodePoint(selectedNode.value, bottom)
  if (!point) { error.value = '选中节点没有可测量的网格。'; return }
  usePoint(point)
  message.value = bottom ? '已取节点底部（包围盒最低点）。它不一定是送料轨道高度，请调整 Y 后保存。' : '已取节点中心作为定位起点，不代表送料高度。请将 Y 调整到实际轨道／料盘基准后保存。'
}
function readSuggestion() {
  if (busy.value || !editable.value || instanceMode.value) return
  try {
    const candidate = preview?.infer(null, loaded.value?.model || context.value?.model, activeKind.value)
    if (!candidate) { suggestion.value = null; message.value = '该模型结构无法可靠识别此口。请点击真实表面或选择节点，再手动设置送料高度与方向。'; return }
    const normalized = normalizeLoadingPorts({ version: 1, inlet: null, outlet: null, [activeKind.value]: { position: candidate.position, direction: candidate.direction, nodeName: candidate.nodeName || '' } })
    suggestion.value = normalized[activeKind.value]
    message.value = '已读取结构建议（虚线点），尚未写入草稿。请核对后点击“应用建议”，再保存。'
  } catch (cause) { error.value = `读取结构建议失败：${cause.message || cause}` }
}
function applySuggestion() {
  if (!suggestion.value || !draft.value || busy.value || !editable.value || instanceMode.value) return
  draft.value[activeKind.value] = clone(suggestion.value); suggestion.value = null
  message.value = '结构建议已应用到草稿，尚未保存。请检查送料高度与外向箭头。'
}
function togglePicking() {
  if (!preview || previewLoading.value || busy.value || instanceMode.value || !editable.value) return
  picking.value = !picking.value
  message.value = picking.value ? '点击模型的真实表面设置当前口位置。拖动仍可旋转；方向与送料高度请另外核对。' : ''
}

async function preparePreview() {
  const requestedGeneration = generation
  await nextTick()
  if (disposed || generation !== requestedGeneration) return
  if (!mounted || !viewport.value || !loaded.value) return
  previewAbort?.abort(); previewAbort = new AbortController()
  const version = generation, controller = previewAbort
  previewLoading.value = true; previewError.value = ''; nodes.value = []; selectedNode.value = ''; picking.value = false
  preview?.dispose(); preview = null
  try {
    const runtime = new LoadingPortPreview(viewport.value, { onSurface: point => { usePoint(point); picking.value = false } })
    preview = runtime
    const entries = await runtime.load(loaded.value.model, { signal: controller.signal })
    if (disposed || generation !== version || preview !== runtime || controller.signal.aborted) return
    nodes.value = entries || []; runtime.setPorts(effectivePorts.value, suggestion.value, activeKind.value)
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
  nodes.value = []; suggestion.value = null; selectedNode.value = ''; picking.value = false; preview?.dispose(); preview = null
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
      error.value = conflict.value ? '配置已被其他管理员修改。当前草稿已保留；请先复制重要数值，再“重新读取”，避免覆盖他人的版本。' : `保存失败，草稿已保留：${cause.message || cause}`
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
  suggestion.value = null; error.value = ''; message.value = '已放弃未保存的修改。'
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
watch(activeKind, () => { suggestion.value = null; picking.value = false; message.value = ''; selectedNode.value = '' })
watch(selectedNode, id => preview?.selectNode(id))
watch(picking, value => preview?.setPicking(value))
watch([effectivePorts, suggestion, activeKind], () => preview?.setPorts(effectivePorts.value, suggestion.value, activeKind.value), { deep: true })
watch(editable, allowed => { if (!allowed) picking.value = false })
watch(busy, value => { if (value) picking.value = false })
onMounted(async () => { mounted = true; await nextTick(); if (loaded.value) void preparePreview() })
onUnmounted(() => { disposed = true; generation++; requestAbort?.abort(); saveAbort?.abort(); previewAbort?.abort(); preview?.dispose(); preview = null })
defineExpose({ canLeave, savePending: () => dirty.value ? save() : !busy.value, discardPending, busy })
</script>

<template>
  <section class="loading-port-editor" aria-label="进出料口配置" :aria-busy="busy">
    <header class="editor-heading">
      <div><h3>{{ title }} · {{ instanceMode ? '进出料口微调' : '进出料口配置' }}</h3><p>{{ instanceMode ? '只修改此设备的偏移与方向，不修改模型默认值。' : '设置所有同型号设备共用的进料口／出料口默认位置。' }}</p></div>
      <div class="heading-actions"><span v-if="dirty" class="dirty-badge">未保存</span><button type="button" :disabled="busy" @click="reloadConfig">重新读取</button><button type="button" class="primary" :disabled="busy || !dirty || !editable || !!saveProblem || conflict" @click="save">{{ saving ? '正在保存…' : '保存配置' }}</button></div>
    </header>
    <p v-if="pendingContext" class="warning" role="alert">已选择另一个对象，但当前草稿尚未处理。此处仍显示 {{ title }} 的配置。<button type="button" :disabled="busy" @click="acceptPendingContext">放弃草稿并切换</button></p>
    <p v-if="error" class="error" role="alert">{{ error }}</p><p v-if="message" class="notice" role="status">{{ message }}</p>
    <div v-if="loading" class="initial-state" role="status">正在读取进出料口配置…</div>
    <div v-else-if="!draft" class="initial-state"><span>配置尚未读取，点击“重新读取”重试。</span></div>
    <div v-else class="editor-body">
      <div class="config-panel">
        <nav class="port-tabs" aria-label="选择进出料口"><button v-for="kind in ['inlet','outlet']" :key="kind" type="button" :class="{ active: activeKind === kind, outlet: kind === 'outlet' }" :aria-pressed="activeKind === kind" @click="activeKind = kind"><strong>{{ kind === 'inlet' ? '进料口' : '出料口' }}</strong><small>{{ instanceMode ? basePorts[kind] ? draft[kind] ? '设备已微调' : '沿用模型默认' : '模型未配置' : draft[kind] ? '已配置' : '未配置' }}</small></button></nav>
        <p class="coordinate-guide"><strong>坐标怎么填？</strong> X / Z 是模型水平方向，Y 是实际送料基准高度（轨道／料盘），不是门板中心。单位沿用原模型；设备缩放和摆放角度由场景自动处理。</p>
        <fieldset :disabled="busy || !editable" class="port-fields">
          <template v-if="instanceMode">
            <div class="default-summary"><strong>模型默认 {{ kindLabel }}</strong><template v-if="basePort"><span>X {{ format(basePort.position[0]) }} · Y {{ format(basePort.position[1]) }} · Z {{ format(basePort.position[2]) }}</span><small>外向方向 [{{ basePort.direction.map(format).join(', ') }}]</small></template><p v-else>模型尚未配置此口。请先到“模型管理 → 进出料口配置”设置默认口，实例微调不会自行创建新口。</p></div>
            <label class="enable-row"><span>单独微调此设备</span><input type="checkbox" :checked="!!row" :disabled="!basePort || busy || !editable" @change="setEnabled($event.target.checked)"></label>
            <template v-if="row"><div class="vector-fields"><label>X 偏移<input v-model.number="row.offset[0]" type="number" step="any" aria-label="进出料口 X 偏移"></label><label>Y 送料高度偏移<input v-model.number="row.offset[1]" type="number" step="any" aria-label="进出料口送料高度偏移"></label><label>Z 偏移<input v-model.number="row.offset[2]" type="number" step="any" aria-label="进出料口 Z 偏移"></label></div><label>水平方向微调（度）<input v-model.number="row.yawDegrees" type="number" step="any" aria-label="进出料口水平方向微调角度"></label><p class="hint">偏移相对模型默认口，正 Y 向上。角度为模型本地 Y 轴旋转，不是设备在产线中的摆放角。</p><button type="button" @click="setEnabled(false)">恢复模型默认</button></template>
            <p v-else-if="basePort" class="hint">当前沿用模型默认。勾选后可微调此设备，不会影响其他同型号设备。</p>
            <div v-if="effectivePort" class="effective-summary"><strong>此设备实际使用的口</strong><span>X {{ format(effectivePort.position[0]) }} · Y {{ format(effectivePort.position[1]) }} · Z {{ format(effectivePort.position[2]) }}</span></div>
          </template>
          <template v-else>
            <label class="enable-row"><span>配置 {{ kindLabel }}</span><input type="checkbox" :checked="!!row" @change="setEnabled($event.target.checked)"></label>
            <p v-if="!row" class="hint">此口未配置，不会参与显式对齐。可先点击真实表面、选节点辅助定位，或读取结构建议；都需要手动应用与保存。</p>
            <template v-if="row"><div class="vector-fields"><label>X 位置<input v-model.number="row.position[0]" type="number" step="any" aria-label="进出料口 X 位置"></label><label>Y 送料高度<input v-model.number="row.position[1]" type="number" step="any" aria-label="进出料口 Y 送料高度"></label><label>Z 位置<input v-model.number="row.position[2]" type="number" step="any" aria-label="进出料口 Z 位置"></label></div><label>水平外向角度（度）<input :value="Number(angle.toFixed(4))" type="number" step="any" aria-label="进出料口水平外向角度" @input="setAngle($event.target.value)"></label><div class="direction-buttons" aria-label="快捷设置水平外向方向"><button type="button" @click="setDirection([1,0,0])">+X</button><button type="button" @click="setDirection([-1,0,0])">−X</button><button type="button" @click="setDirection([0,0,1])">+Z</button><button type="button" @click="setDirection([0,0,-1])">−Z</button></div><p class="hint">0° = +X，90° = −Z。箭头指向设备外侧；进料口箭头指向来料侧，不是向炉内。出料口箭头指向离料侧。</p><label>关联节点名称（可留空）<input v-model="row.nodeName" type="text" maxlength="512" aria-label="进出料口关联节点名称"></label></template>
            <details class="node-assistant" open><summary>辅助定位 · 选真实模型节点</summary><label>搜索模型节点<input v-model="nodeQuery" type="search" placeholder="例如：炉口、轨道、门" aria-label="搜索进出料口模型节点"></label><label>选择节点<select v-model="selectedNode" aria-label="选择进出料口辅助节点"><option value="">请选择（选择不会改变配置）</option><option v-for="node in nodeOptions" :key="node.id" :value="node.id">{{ node.path }} ({{ node.meshCount }} 网格)</option></select></label><small v-if="nodes.length > 500" class="hint">最多展示 500 个结果，请搜索缩小范围。</small><div class="assistant-actions"><button type="button" :disabled="!selectedNode || !preview || previewLoading" @click="useNode(false)">取节点中心</button><button type="button" :disabled="!selectedNode || !preview || previewLoading" @click="useNode(true)">取节点底部</button></div><p class="hint">包围盒只用于辅助定位。移动门板中心、节点最低点都不能直接当作送料高度，请检查 Y。</p></details>
            <div class="inference-actions"><button type="button" :disabled="!preview || previewLoading" @click="readSuggestion">从模型已有结构读取</button><button v-if="suggestion" type="button" class="primary" @click="applySuggestion">应用建议到草稿</button></div><p v-if="suggestion" class="hint">建议 X {{ format(suggestion.position[0]) }} · Y {{ format(suggestion.position[1]) }} · Z {{ format(suggestion.position[2]) }}，尚未写入配置。</p>
          </template>
        </fieldset>
        <p v-if="saveProblem" class="error" role="alert">{{ saveProblem }}</p><p v-if="!editable" class="hint">当前账号为只读，可以查看但不能更改配置。</p>
        <button v-if="dirty" type="button" class="discard" :disabled="busy" @click="canLeave">放弃未保存修改</button>
      </div>
      <section class="preview-panel" aria-label="独立进出料口预览">
        <div class="preview-toolbar"><span><i class="inlet-dot"></i>进料口 <i class="outlet-dot"></i>出料口</span><div><button v-if="!instanceMode" type="button" :class="{ active: picking }" :aria-pressed="picking" :disabled="!preview || previewLoading || busy || !editable" @click="togglePicking">{{ picking ? '取消表面定位' : '点击模型表面定位' }}</button><button type="button" :disabled="!preview || previewLoading" @click="preview?.resetCamera()">完整视图</button></div></div>
        <div class="preview-stage"><div ref="viewport" class="viewport"></div><div v-if="previewLoading" class="preview-overlay" role="status">正在载入原始模型…</div><div v-else-if="previewError" class="preview-overlay"><p>{{ previewError }}</p><button type="button" @click="preparePreview">重试三维预览</button><small>表单坐标仍可编辑与保存。</small></div><span v-else-if="picking" class="pick-tip">点击真实表面设置 {{ kindLabel }}；拖动旋转</span></div>
        <p class="preview-caption">拖动旋转 · 滚轮缩放 · 红 X / 绿 Y / 蓝 Z。点标记是口的位置，箭头是水平外向方向。{{ instanceMode ? '视图展示默认值加本设备微调，不包含产线摆放变换。' : suggestion ? '虚线透明点是未应用建议，不会自动保存。' : '预览保持原 glTF 比例与本地坐标，不改变模型文件。' }}</p>
      </section>
    </div>
  </section>
</template>

<style scoped>
.loading-port-editor{display:flex;flex-direction:column;min-width:0;min-height:0;color:#31465e;background:#fff;font-size:calc(13px * var(--admin-font-scale,1))}.editor-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 20px;border-bottom:1px solid #e4ebf2;flex-wrap:wrap}.editor-heading h3{margin:0 0 6px;font-size:calc(17px * var(--admin-font-scale,1));color:#233b58}.editor-heading p{margin:0;color:#73869c;font-size:calc(12px * var(--admin-font-scale,1))}.heading-actions,.assistant-actions,.inference-actions,.preview-toolbar>div{display:flex;align-items:center;gap:8px;flex-wrap:wrap}button,input,select{font:inherit}button{border:1px solid #cfdae7;border-radius:7px;background:#fff;color:#345779;padding:8px 11px;cursor:pointer}button:hover:not(:disabled){background:#edf4fc;border-color:#8fb7df}button.primary{background:#286cc1;color:white;border-color:#286cc1}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #86b6ed;outline-offset:2px}.dirty-badge{background:#fff0cd;color:#9b6a11;padding:4px 8px;border-radius:20px;font-size:calc(12px * var(--admin-font-scale,1))}.error,.notice,.warning{padding:10px 13px;border-radius:7px;margin:12px 20px 0;line-height:1.7;overflow-wrap:anywhere}.error{background:#fff1f1;border:1px solid #f2cccc;color:#b64040}.notice{background:#edf7ff;border:1px solid #cbe4f8;color:#2e658e}.warning{background:#fff6df;border:1px solid #f0dfac;color:#896527}.warning button{margin-left:12px}.initial-state{min-height:220px;display:grid;place-items:center;color:#75889d}.editor-body{display:grid;grid-template-columns:minmax(310px,390px) minmax(0,1fr);min-height:530px;flex:1}.config-panel{padding:18px;min-width:0;border-right:1px solid #e4ebf2}.port-tabs{display:grid;grid-template-columns:1fr 1fr;gap:10px}.port-tabs button{display:flex;flex-direction:column;align-items:flex-start;gap:5px;padding:11px 13px;text-align:left}.port-tabs button.active{background:#e9f6fb;border-color:#5babc1;color:#17778e}.port-tabs button.outlet.active{background:#fff4e8;border-color:#e1ac69;color:#996321}.port-tabs small{font-size:calc(11px * var(--admin-font-scale,1));color:#768ca0}.coordinate-guide{padding:12px;border-radius:8px;background:#f3f6fa;line-height:1.7;font-size:calc(12px * var(--admin-font-scale,1));color:#6f8195}.coordinate-guide strong{display:block;color:#48617b}.port-fields{border:0;padding:0;margin:0;display:grid;gap:13px;min-width:0}.port-fields label{display:flex;flex-direction:column;gap:7px;color:#48617c;min-width:0;font-size:calc(12px * var(--admin-font-scale,1))}.port-fields .enable-row{display:flex;flex-direction:row;align-items:center;justify-content:space-between;color:#2f4b67;font-weight:600;padding:4px 0}.enable-row input{width:18px;height:18px;accent-color:#2982bb}.port-fields input:not([type=checkbox]),select{border:1px solid #cfdce8;background:white;border-radius:7px;padding:9px 10px;min-width:0;width:100%;box-sizing:border-box;color:#2d4762}.vector-fields{display:grid;grid-template-columns:1fr 1.3fr 1fr;gap:8px}.vector-fields input{padding-left:7px!important;padding-right:3px!important;font-variant-numeric:tabular-nums}.direction-buttons{display:flex;gap:7px}.direction-buttons button{flex:1;padding:7px}.hint{color:#7b899b;font-size:calc(11px * var(--admin-font-scale,1));line-height:1.7;margin:0;overflow-wrap:anywhere}.default-summary,.effective-summary{display:grid;gap:7px;padding:12px;background:#f4f7fa;border:1px solid #e0e9f1;border-radius:8px;line-height:1.6;font-size:calc(12px * var(--admin-font-scale,1))}.default-summary p{margin:0;color:#8794a1}.default-summary small{color:#7588a0}.effective-summary{background:#eaf6f4;border-color:#cae7e1;color:#2e7868}.node-assistant{border-top:1px solid #e4ebf2;padding-top:13px}.node-assistant summary{cursor:pointer;font-weight:600;color:#4d627a;margin-bottom:13px}.node-assistant label,.node-assistant .assistant-actions{margin-bottom:10px}.inference-actions button{font-size:calc(12px * var(--admin-font-scale,1))}.config-panel>.error{margin:13px 0 0}.discard{margin-top:14px;color:#7d8391}.preview-panel{display:flex;flex-direction:column;min-width:0;min-height:0;padding:16px;background:#fbfcfe}.preview-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;font-size:calc(12px * var(--admin-font-scale,1))}.preview-toolbar>span{display:flex;align-items:center;gap:5px;white-space:nowrap}.preview-toolbar button{padding:7px 9px;font-size:calc(12px * var(--admin-font-scale,1))}.preview-toolbar button.active{border-color:#258eaa;background:#e0f3f9}.inlet-dot,.outlet-dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#168aa7}.outlet-dot{background:#e78b22;margin-left:8px}.preview-stage{position:relative;flex:1;min-height:430px;border:1px solid #dfe7ef;border-radius:10px;overflow:hidden;background:#f1f5f9}.viewport{position:absolute;inset:0}.preview-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:12px;text-align:center;background:#f2f6fa;color:#6f8194;line-height:1.7}.preview-overlay p{margin:0;overflow-wrap:anywhere}.preview-overlay small{color:#94a1b0}.pick-tip{position:absolute;top:12px;left:12px;right:12px;padding:9px;border-radius:6px;background:#e8f7ffea;color:#196981;text-align:center;pointer-events:none}.preview-caption{margin:10px 2px 0;color:#8696a8;line-height:1.7;font-size:calc(11px * var(--admin-font-scale,1))}@media(max-width:1050px){.editor-body{grid-template-columns:1fr}.config-panel{border-right:0;border-bottom:1px solid #e4ebf2}.preview-stage{min-height:400px}.preview-panel{min-height:460px}}@media(max-width:500px){.editor-heading{padding:14px}.config-panel,.preview-panel{padding:12px}.vector-fields{grid-template-columns:1fr}.error,.notice,.warning{margin-left:12px;margin-right:12px}}
</style>
