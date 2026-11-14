<script setup>
import { computed, nextTick, onActivated, onDeactivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminApi } from '../../../runtime/adminSession.js'
import { showSaveFeedback } from '../../../runtime/saveFeedback.js'
import { DockingCalibrationPreview } from '../../../three/DockingCalibrationPreview.js'
import { dockingCandidates, prepareDockingCalibration, dockingPreview, dockingSavePayload } from '../utils/dockingCalibration.js'

const props = defineProps({ model: Object, devices: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] },
  models: { type: Array, default: () => [] }, confirm: { type: Function, default: async () => false }, canCalibrate: { type: Function, default: () => true } })
const emit = defineEmits(['calibrated'])
const stationId = ref(''), cartId = ref(''), deviceKind = ref('inlet'), cartKind = ref('outlet'), stepMm = ref(10)
const plan = ref(null), position = ref(null), loading = ref(false), saving = ref(false), error = ref(''), conflict = ref(false)
const confirming = ref(false)
const viewport = ref(null), previewReady = ref(false), previewError = ref(''), view = ref('front')
const candidates = computed(() => dockingCandidates(props.devices, props.lines))
const station = computed(() => candidates.value.stations.find(r => r.device.id === stationId.value))
const carts = computed(() => candidates.value.carts.filter(r => r.line.id === station.value?.line.id && r.config.railId === station.value?.railId))
const editable = computed(() => canAdminApi('/api/devices/docking-calibration', 'PUT'))
const busy = computed(() => loading.value || saving.value || confirming.value)
const dirty = computed(() => !!plan.value && JSON.stringify(position.value) !== JSON.stringify(plan.value.position))
const deviation = computed(() => plan.value && position.value ? dockingPreview(plan.value, position.value) : null)
const deviceSource = row => row && Object.fromEntries(['id','line_id','coordinate_space','model_type','model_file','pos_x','pos_y','pos_z','rotation_y','scale','instance_config'].map(key => [key,row[key]]))
const sourceSignature = computed(() => JSON.stringify([{id:station.value?.line.id,workshop_id:station.value?.line.workshop_id,layout_json:station.value?.line.layout_json,layout:station.value?.line.layout}, deviceSource(station.value?.device), deviceSource(carts.value.find(r => r.device.id === cartId.value)?.device),
  props.models.filter(m => [station.value?.device.model_type, carts.value.find(r => r.device.id === cartId.value)?.device.model_type].includes(m.id)).map(m=>({id:m.id,file_path:m.file_path,default_scale:m.default_scale,metadata:m.metadata,placement_level:m.placement_level,asset_type:m.asset_type}))]))
let generation = 0, disposed = false, active = true, controller, preview
const valid = version => active && !disposed && version === generation
const format = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)}` : '—'
function release() { preview?.dispose(); preview = null; previewReady.value = false }
function reset() { generation++; controller?.abort(); release(); plan.value = null; position.value = null; error.value = ''; previewError.value = ''; conflict.value = false; loading.value = false }
function discardPending() { if (saving.value) return false; if (plan.value) { position.value = { ...plan.value.position }; preview?.setPosition(position.value) } return true }
async function confirmOnce(text) { if (disposed || confirming.value) return false; confirming.value = true; try { return await props.confirm(text) === true } finally { confirming.value = false } }
async function canLeave() {
  if (busy.value) return false
  if (!dirty.value) return true
  const version = generation
  if (!await confirmOnce('对接校准尚未保存，放弃设备位置调整并离开？') || !valid(version) || busy.value) return false
  return discardPending()
}
async function choose(key, event) {
  const previous = { stationId: stationId.value, cartId: cartId.value, deviceKind: deviceKind.value, cartKind: cartKind.value }[key]
  if (!await canLeave()) { event.target.value = previous; return }
  reset()
  const refs = { stationId, cartId, deviceKind, cartKind }; refs[key].value = event.target.value
  if (key === 'stationId' && !carts.value.some(r => r.device.id === cartId.value)) cartId.value = carts.value[0]?.device.id || ''
}
async function load() {
  if (busy.value || !station.value || !cartId.value) return false
  const requested = { version: generation, station: stationId.value, cart: cartId.value, signature: sourceSignature.value }
  if (dirty.value && !await confirmOnce('重新预览将放弃未保存的位置调整，继续？')) return false
  if (!valid(requested.version) || !station.value || await props.canCalibrate(station.value.line.id) !== true) return false
  if (!valid(requested.version) || requested.station !== stationId.value || requested.cart !== cartId.value || requested.signature !== sourceSignature.value || busy.value) return false
  reset(); loading.value = true; const version = generation, signature = sourceSignature.value, line = JSON.parse(JSON.stringify(station.value.line))
  controller = new AbortController()
  try {
    const [deviceResult, cartResult] = await Promise.all([adminApi.getDeviceLoadingPorts(stationId.value, { signal: controller.signal }), adminApi.getDeviceLoadingPorts(cartId.value, { signal: controller.signal })])
    if (!valid(version) || signature !== sourceSignature.value) return false
    if (deviceResult?.device?.id !== stationId.value || cartResult?.device?.id !== cartId.value) throw Error(deviceResult?.error || cartResult?.error || '读取结果不属于所选工位和小车')
    const result = await prepareDockingCalibration({ line, deviceResult, cartResult, deviceKind: deviceKind.value, cartKind: cartKind.value }, { signal: controller.signal })
    if (!valid(version) || signature !== sourceSignature.value) return false
    plan.value = result; position.value = { ...result.position }; view.value = 'front'; await nextTick()
    if (!valid(version)) return false
    if (viewport.value) {
      try { preview = new DockingCalibrationPreview(viewport.value); await preview.load(result, { signal: controller.signal }); if (valid(version)) previewReady.value = true }
      catch (cause) { if (valid(version)) { release(); previewError.value = `模型预览失败：${cause.message}，不能保存。请重新预览。` } }
    }
    return true
  } catch (cause) { if (valid(version) && cause.name !== 'AbortError') error.value = cause.message; return false }
  finally { if (valid(version)) loading.value = false }
}
function move(axis, direction) {
  if (!editable.value || busy.value || conflict.value || !previewReady.value || !plan.value) return
  const step = Number(stepMm.value)
  if (!Number.isFinite(step) || step < .1 || step > 1000) { error.value = '步长请输入 0.1–1000 毫米'; return }
  // Front orthographic view looks along -Z. +Three X is screen-right and
  // reflects persisted Unity X, so right means decreasing stored pos_x.
  const amount = step / 1000 * plan.value.unitsPerMeter * direction * (axis === 'x' ? -1 : 1)
  const next = { ...position.value, [axis]: Number((position.value[axis] + amount).toFixed(9)) }
  if (next[axis] === position.value[axis]) { error.value = '当前场景比例与坐标精度不足，无法表示该位移；请增大步长。'; return }
  try { dockingSavePayload(plan.value, next); position.value = next; preview?.setPosition(next); error.value = '' } catch (cause) { error.value = cause.message }
}
function setView(value) { if (!busy.value && previewReady.value) { view.value = value; preview?.setView(value) } }
async function save() {
  if (!editable.value || busy.value || !dirty.value || conflict.value || !previewReady.value) return false
  const version = generation, signature = sourceSignature.value, expectedId = stationId.value
  if (!await confirmOnce(`保存「${station.value.device.name || expectedId}」的实体左右位置和高度？只改设备摆放，不改料口标记、小车位置、PLC 或绑定。`)) return false
  if (!valid(version) || busy.value || signature !== sourceSignature.value || !editable.value || !plan.value) return false
  if (await props.canCalibrate(plan.value.line.id) !== true) return false
  if (!valid(version) || busy.value || signature !== sourceSignature.value || !editable.value || !dirty.value || conflict.value || !plan.value || !previewReady.value || stationId.value !== expectedId) return false
  const payload = dockingSavePayload(plan.value, position.value)
  saving.value = true
  try {
    const result = await adminApi.saveDockingCalibration(payload)
    if (!valid(version)) return false
    if (result?.success !== true || !Array.isArray(result.devices) || result.devices.length !== 1 || result.devices[0].id !== expectedId) {
      if (result?.status === 409 || result?.success === true) conflict.value = true
      throw Error(result?.error || '后端没有确认所选设备位置已保存')
    }
    const saved = result.devices[0]
    if (['x','y'].some(axis => Math.fround(saved['pos_' + axis]) !== Math.fround(position.value[axis]) || Math.abs(saved['pos_' + axis] - position.value[axis]) > Math.max(1e-9, Math.abs(position.value[axis]) * 1e-12))) { conflict.value = true; throw Error('后端回读位置未确认，可能已提交；已锁定调整，请重新预览读取真实位置') }
    reset(); saving.value = false; showSaveFeedback('对接校准已保存'); emit('calibrated', result); return true
  } catch (cause) { if (valid(version)) { error.value = cause.message; showSaveFeedback(`校准保存失败：${cause.message}`, 'error') } return false }
  finally { saving.value = false }
}
watch(sourceSignature, () => {
  if (!plan.value && !loading.value) return
  if (saving.value) { conflict.value = true; error.value = '校准来源在保存期间更新，正在核对后端提交结果。'; return }
  generation++; controller?.abort(); loading.value = false; release()
  if (plan.value) { conflict.value = true; error.value = '设备、模型或产线来源已更新，请重新预览；当前位置草稿未保存。' }
})
watch(() => candidates.value.stations.map(r => r.device.id).join('|'), () => {
  if (!station.value) { stationId.value = candidates.value.stations.find(r => r.device.model_type === props.model?.id)?.device.id || candidates.value.stations[0]?.device.id || ''; cartId.value = carts.value[0]?.device.id || '' }
}, { immediate: true })
watch(() => carts.value.map(r => r.device.id).join('|'), () => { if (!carts.value.some(r => r.device.id === cartId.value)) cartId.value = carts.value[0]?.device.id || '' }, { immediate: true })
function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onDeactivated(() => {
  active = false; generation++; controller?.abort()
  if (loading.value) { loading.value = false; release(); if (plan.value) { conflict.value = true; error.value = '预览已暂停，请重新预览再保存；当前位置草稿保留。' } }
  else preview?.pause()
})
onActivated(() => { active = true; preview?.resume() })
onBeforeUnmount(() => { disposed = true; reset(); window.removeEventListener('beforeunload', beforeUnload) })
defineExpose({ canLeave, savePending: () => dirty.value ? save() : true, discardPending, busy })
</script>

<template>
  <section class="docking-calibration" aria-label="对接校准" data-testid="docking-calibration">
    <header><div><h3>对接校准</h3><p>按工位同时核对小车与设备的真实料口。实体错位调整摆放；选点错误返回“料口选点”修正。</p></div><span class="permission-note" v-if="!editable">需要产线布局编辑权限才能调整和保存</span></header>
    <div class="calibration-pickers">
      <label>对接工位<select aria-label="选择对接工位" :value="stationId" :disabled="busy" @change="choose('stationId', $event)"><option v-if="!candidates.stations.length" value="">暂无已放置工位</option><option v-for="row in candidates.stations" :key="row.device.id" :value="row.device.id">{{ row.label }}</option></select></label>
      <label>对应小车<select aria-label="选择对接小车" :value="cartId" :disabled="busy" @change="choose('cartId', $event)"><option v-if="!carts.length" value="">该产线没有已放置小车</option><option v-for="row in carts" :key="row.device.id" :value="row.device.id">{{ row.device.name || row.device.id }}</option></select></label>
      <label>设备料口<select aria-label="选择设备校准料口" :value="deviceKind" :disabled="busy" @change="choose('deviceKind', $event)"><option value="inlet">进料口</option><option value="outlet">出料口</option></select></label>
      <label>小车料口<select aria-label="选择小车校准料口" :value="cartKind" :disabled="busy" @change="choose('cartKind', $event)"><option value="outlet">出料口</option><option value="inlet">进料口</option></select></label>
      <button type="button" :disabled="busy || !station || !cartId" @click="load">{{ loading ? '正在预览…' : plan ? '重新预览' : '显示对接预览' }}</button>
    </div>
    <p v-if="error" class="calibration-error" role="alert">{{ error }}</p><p v-if="previewError" class="calibration-error" role="alert">{{ previewError }}</p>
    <div v-if="plan" class="calibration-body">
      <aside class="calibration-adjustments">
        <h4>实体位置调整</h4>
        <div class="deviation-card" :class="{ aligned: deviation.aligned }"><span>左右偏差 <strong data-testid="docking-horizontal-deviation">{{ format(deviation.millimeters[0]) }} mm</strong></span><span>高度偏差 <strong data-testid="docking-height-deviation">{{ format(deviation.millimeters[1]) }} mm</strong></span><small>{{ deviation.aligned ? '左右与高度在 2 mm 容差内' : '蓝色设备料口相对橙色小车料口的偏差' }}</small></div>
        <p class="depth-note">前后间隙 {{ Math.abs(deviation.millimeters[2]).toFixed(1) }} mm；本页不改变设备前后位置或朝向。</p>
        <label>调整步长 / mm<input aria-label="校准调整步长毫米" type="number" min="0.1" max="1000" step="0.1" v-model="stepMm" :disabled="busy || !editable" /></label>
        <div class="nudge-controls"><button type="button" :disabled="busy || !editable || conflict || !previewReady" @click="move('x', -1)">← 向左</button><button type="button" :disabled="busy || !editable || conflict || !previewReady" @click="move('x', 1)">向右 →</button><button type="button" :disabled="busy || !editable || conflict || !previewReady" @click="move('y', 1)">↑ 升高</button><button type="button" :disabled="busy || !editable || conflict || !previewReady" @click="move('y', -1)">↓ 降低</button></div>
        <p class="position-readout">实体 X {{ position.x.toFixed(5) }} · Y {{ position.y.toFixed(5) }}<br />单位：产线坐标；{{ plan.unitsPerMeter }} 场景单位 / 米</p>
        <button type="button" :disabled="busy || !dirty" @click="discardPending">撤销本次校准</button>
        <button type="button" class="save-calibration" :disabled="busy || !editable || !dirty || conflict || !previewReady" @click="save">{{ saving ? '正在保存…' : '保存设备位置' }}</button>
        <p class="calibration-safety">预览小车按所选工位的真实料口摆放，左右基准固定，供手动调整比较；这里只做几何校准，不代表 PLC 工位映射已验证。调整只作用于预览，保存前现场位置不变，不保存小车偏移，也不发送 PLC 指令。</p>
      </aside>
      <div class="calibration-view"><nav aria-label="校准视图"><button type="button" :aria-pressed="view === 'front'" :disabled="busy || !previewReady" @click="setView('front')">正面</button><button type="button" :aria-pressed="view === 'top'" :disabled="busy || !previewReady" @click="setView('top')">俯视</button><span><i class="device-dot" />设备料口 <i class="cart-dot" />小车料口</span></nav><div ref="viewport" class="docking-viewport" aria-label="小车与设备对接模型预览" /><p>滚轮缩放 · 右键平移；蓝／橙标记固定在各自实体真实料口，不能拖动标记。</p></div>
    </div>
    <p v-else class="calibration-empty">选择工位及对应产线小车，再显示预览。两个料口必须已配置；单向小车需相向，旋转小车按真实转台朝向预览。这里只做几何校准，不代替 PLC 工位映射与实际停车验收；未配置时不会自动生成或移动标记。</p>
  </section>
</template>

<style scoped>
.docking-calibration{border:1px solid #dbe4ee;border-radius:12px;background:#fff;color:#2a3d52;overflow:hidden}.docking-calibration header{display:flex;gap:20px;justify-content:space-between;padding:18px 20px;background:#f4f8fc}.docking-calibration h3,.docking-calibration h4{margin:0 0 8px}.docking-calibration p{font-size:13px;line-height:1.65;margin:0;color:#64768b}.permission-note{font-size:12px;color:#916a2b;max-width:200px}.calibration-pickers{display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:16px 20px;border-bottom:1px solid #e5ebf2}.docking-calibration label{display:grid;gap:7px;font-size:13px;min-width:0}.calibration-pickers label:first-child{flex:2;min-width:220px}.calibration-pickers label:nth-child(2){flex:1;min-width:140px}.docking-calibration select,.docking-calibration input{min-width:0;max-width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #ced9e6;border-radius:7px;background:#fff;color:#2a3d52;font:inherit}.docking-calibration button{padding:9px 13px;border:1px solid #ced9e6;border-radius:7px;background:#f9fbfe;color:#34516d;font:inherit;font-size:13px;cursor:pointer}.docking-calibration button:disabled{opacity:.45;cursor:not-allowed}.calibration-body{display:grid;grid-template-columns:290px minmax(0,1fr)}.calibration-adjustments{display:flex;flex-direction:column;gap:14px;padding:20px;border-right:1px solid #e5ebf2;background:#f8fafc;min-width:0}.deviation-card{display:grid;gap:11px;padding:14px;border:1px solid #d4dfee;border-radius:9px;background:#fff;font-size:13px}.deviation-card span{display:flex;justify-content:space-between;gap:10px}.deviation-card strong{font-variant-numeric:tabular-nums}.deviation-card small{font-size:11px;color:#6e7f92}.deviation-card.aligned{border-color:#a7d8bd;background:#f3fbf6}.nudge-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}.calibration-adjustments .save-calibration{background:#254761;color:#fff;border-color:#254761}.calibration-view{display:flex;flex-direction:column;min-width:0}.calibration-view nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid #e5ebf2}.calibration-view nav button[aria-pressed=true]{background:#e7f1fc;border-color:#a7c8e9;color:#14568b}.calibration-view nav span{margin-left:auto;font-size:12px;display:flex;align-items:center;gap:7px}.calibration-view i{display:inline-block;width:9px;height:9px;border-radius:50%}.device-dot{background:#1677c8}.cart-dot{background:#e29124}.docking-viewport{height:480px;min-width:0;overflow:hidden;background:#eef3f8}.docking-viewport :deep(canvas){display:block;max-width:100%}.calibration-view>p{padding:10px 16px;background:#f8fafc}.calibration-error{padding:12px 20px!important;color:#b33c35!important;background:#fff4f2}.calibration-empty{padding:30px 20px!important}.calibration-safety,.position-readout,.depth-note{font-size:12px!important}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #367cca;outline-offset:2px}@media(max-width:1050px){.calibration-body{grid-template-columns:1fr}.calibration-adjustments{border-right:0;border-bottom:1px solid #e5ebf2;display:grid;grid-template-columns:1fr 1fr}.calibration-adjustments h4,.calibration-safety{grid-column:1/-1}.docking-viewport{height:420px}}@media(max-width:620px){.calibration-adjustments{grid-template-columns:1fr}.docking-calibration header{display:block}.calibration-pickers{padding:14px}.calibration-pickers label{flex:1;min-width:140px}.calibration-view nav span{margin-left:0}.docking-viewport{height:360px}}
</style>
