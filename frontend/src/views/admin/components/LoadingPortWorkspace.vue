<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import LoadingPortEditor from './LoadingPortEditor.vue'
import DockingCalibration from './DockingCalibration.vue'

const props = defineProps({ model: { type: Object, required: true }, devices: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] }, models: { type: Array, default: () => [] }, confirm: { type: Function, default: async () => false }, canCalibrate: { type: Function, default: () => true } })
const emit = defineEmits(['saved', 'calibrated'])
const editor = ref(null), calibration = ref(null), deviceId = ref(''), dockingActive = ref(false), dockingMounted = ref(false), switching = ref(false), feedback = ref('')
let generation=0
const candidates = computed(() => props.devices.filter(device => String(device.model_type) === String(props.model.id)))
const selectedDevice = computed(() => candidates.value.find(device => String(device.id) === deviceId.value) || null)
const editors=()=>[editor.value,calibration.value].filter(Boolean)
const childBusy = computed(() => editors().some(item=>item.busy===true))
const busy = computed(() => childBusy.value || switching.value)
const dirty = computed(() => editors().some(item=>item.dirty===true))
async function canLeave(){
  if(busy.value)return false
  const version=generation
  if(dirty.value){if(await props.confirm('料口区域或实体对接位置尚未保存，放弃这些修改并离开？')!==true||version!==generation||busy.value)return false;return discardPending()}
  for(const item of editors())if(!await (item.canLeave?.()??true))return false
  return version===generation&&!busy.value
}
async function savePending(){if(busy.value)return false;for(const item of editors())if(!await (item.savePending?.()??true))return false;return true}
function discardPending(){if(busy.value)return false;for(const item of editors())if(item.discardPending?.()===false)return false;return true}
async function showModel(startDrawing = false) {
  if (busy.value) return false
  const version = generation
  switching.value = true
  try {
    if (dockingActive.value && (!await (calibration.value?.canLeave?.() ?? true) || version !== generation || childBusy.value)) return false
    dockingActive.value = false
    await nextTick()
    if (version !== generation || childBusy.value) return false
    if (startDrawing) return editor.value?.setDrawing?.(true) !== false
    return true
  } finally { switching.value = false }
}
async function toggleCalibration(){
  if(busy.value)return false
  if(dockingActive.value)return showModel()
  const version=generation
  switching.value=true
  try {
    if(editor.value?.dirty){if(await props.confirm('先保存当前料口区域，再检查小车对接？')!==true||version!==generation||childBusy.value)return false;if(!await editor.value.savePending())return false}
    if(version!==generation||childBusy.value||editor.value?.dirty)return false
    editor.value?.setDrawing?.(false, false)
    feedback.value='';dockingMounted.value=true;dockingActive.value=true
    return true
  } finally { switching.value=false }
}
async function canCalibrateLine(lineId){if(editor.value?.dirty){feedback.value='请先完成并保存料口区域，再显示或保存双实体对接校准。';return false}return await props.canCalibrate(lineId)}
async function chooseDevice(id) {
  if (!await canLeave()) return false
  deviceId.value = candidates.value.some(device => String(device.id) === String(id)) ? String(id) : ''
  return true
}
async function choose(event) {
  if (!await chooseDevice(event.target.value)) event.target.value = deviceId.value
}
// Calibration selects a physical station independently of the library model.
// Background model refresh/deletion must not unmount its unsaved position.
watch(() => props.model.id, () => { generation++;deviceId.value = '' })
defineExpose({ canLeave, savePending, discardPending, busy, dirty })
</script>

<template>
  <section class="loading-port-workspace" aria-label="模型与设备进出料口配置">
    <label class="context-picker">配置对象
      <select :value="deviceId" aria-label="选择进出料配置设备" :disabled="busy" @change="choose">
        <option value="">模型料口位置</option>
        <option v-for="device in candidates" :key="device.id" :value="String(device.id)">{{ device.name || device.id }} · 实际料口与进出料信号</option>
      </select>
    </label>
    <div v-if="!selectedDevice" class="unselected-signals">
      <label>进料／取料信号<select disabled aria-label="进料取料信号"><option>先在上方选择具体设备</option></select></label>
      <label>出料／送料信号<select disabled aria-label="出料送料信号"><option>先在上方选择具体设备</option></select></label>
    </div>
    <p v-if="feedback" class="workspace-feedback" role="status">{{ feedback }}</p>
    <LoadingPortEditor ref="editor" :model="model" :device="selectedDevice" :confirm="confirm" docking-available :docking-preview="dockingActive" :workspace-busy="childBusy" :preview-switching="switching" @toggle-docking="toggleCalibration" @request-drawing="showModel(true)" @saved="emit('saved', $event)">
      <template #preview><DockingCalibration v-if="dockingMounted" v-show="dockingActive" ref="calibration" inline auto-preview :active="dockingActive" data-preview-mode="docking" :model="model" :preferred-device-id="deviceId" :devices="devices" :lines="lines" :models="models" :confirm="confirm" :can-calibrate="canCalibrateLine" @calibrated="emit('calibrated', $event)" /></template>
    </LoadingPortEditor>
  </section>
</template>

<style scoped>
.workspace-feedback{margin:12px 18px;color:#8f6a25;font-size:13px;line-height:1.7}
.context-picker{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 18px;margin:0 0 12px;background:#f4f8ff;border:1px solid #d7e3f2;border-radius:9px;font-size:14px;font-weight:600;color:#30465e}.context-picker select{min-width:260px;max-width:100%;padding:9px 12px;border:1px solid #c3d3e6;border-radius:7px;background:white;color:#24364b;font:inherit}
.unselected-signals{display:flex;gap:18px;flex-wrap:wrap;padding:0 18px 18px}.unselected-signals label{display:grid;gap:8px;min-width:260px;color:#40546f;font-size:14px}.unselected-signals select{padding:9px 12px;border:1px solid #d7e0ec;border-radius:7px;background:#f4f6fa;color:#687b92}
</style>
