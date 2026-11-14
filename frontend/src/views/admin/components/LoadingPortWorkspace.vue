<script setup>
import { computed, ref, watch } from 'vue'
import LoadingPortEditor from './LoadingPortEditor.vue'
import DockingCalibration from './DockingCalibration.vue'

const props = defineProps({ model: { type: Object, required: true }, devices: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] }, models: { type: Array, default: () => [] }, confirm: { type: Function, default: async () => false }, canCalibrate: { type: Function, default: () => true } })
const emit = defineEmits(['saved', 'calibrated'])
const editor = ref(null), calibration = ref(null), deviceId = ref(''), section = ref('ports')
const candidates = computed(() => props.devices.filter(device => String(device.model_type) === String(props.model.id)))
const selectedDevice = computed(() => candidates.value.find(device => String(device.id) === deviceId.value) || null)
const current = () => section.value === 'calibration' ? calibration.value : editor.value
const busy = computed(() => current()?.busy === true)
async function changeSection(value) { if (value !== section.value && !busy.value && await (current()?.canLeave() ?? true)) section.value = value }
async function choose(event) {
  const id = event.target.value
  if (editor.value && !await editor.value.canLeave()) { event.target.value = deviceId.value; return }
  deviceId.value = candidates.value.some(device => String(device.id) === id) ? id : ''
}
// Calibration selects a physical station independently of the library model.
// Background model refresh/deletion must not unmount its unsaved position.
watch(() => props.model.id, () => { deviceId.value = '' })
defineExpose({ canLeave: () => current()?.canLeave() ?? true, savePending: () => current()?.savePending() ?? true,
  discardPending: () => current()?.discardPending(), busy })
</script>

<template>
  <section class="loading-port-workspace" aria-label="模型与设备进出料口配置">
    <nav class="port-workspace-tabs" aria-label="进出料口工具"><button type="button" :aria-pressed="section === 'ports'" :disabled="busy" @click="changeSection('ports')">料口选点</button><button type="button" :aria-pressed="section === 'calibration'" :disabled="busy" @click="changeSection('calibration')">对接校准</button></nav>
    <DockingCalibration v-if="section === 'calibration'" ref="calibration" :model="model" :devices="devices" :lines="lines" :models="models" :confirm="confirm" :can-calibrate="canCalibrate" @calibrated="emit('calibrated', $event)" />
    <template v-else>
    <label class="context-picker">配置对象
      <select :value="deviceId" aria-label="选择进出料配置设备" :disabled="busy" @change="choose">
        <option value="">模型默认料口位置</option>
        <option v-for="device in candidates" :key="device.id" :value="String(device.id)">{{ device.name || device.id }} · 进出料信号</option>
      </select>
    </label>
    <div v-if="!selectedDevice" class="unselected-signals">
      <label>进料／取料信号<select disabled aria-label="进料取料信号"><option>先在上方选择具体设备</option></select></label>
      <label>出料／送料信号<select disabled aria-label="出料送料信号"><option>先在上方选择具体设备</option></select></label>
    </div>
    <LoadingPortEditor ref="editor" :model="model" :device="selectedDevice" :confirm="confirm" @saved="emit('saved', $event)" />
    </template>
  </section>
</template>

<style scoped>
.port-workspace-tabs{display:flex;gap:8px;margin:0 0 14px}.port-workspace-tabs button{padding:10px 16px;border:1px solid #d4dfea;border-radius:8px;background:#fff;color:#435b73;font:inherit;font-size:14px;cursor:pointer}.port-workspace-tabs button[aria-pressed=true]{background:#e6f2f8;border-color:#bdd8e6;color:#1d6d89;font-weight:600}.port-workspace-tabs button:disabled{opacity:.5;cursor:not-allowed}
.context-picker{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 18px;margin:0 0 12px;background:#f4f8ff;border:1px solid #d7e3f2;border-radius:9px;font-size:14px;font-weight:600;color:#30465e}.context-picker select{min-width:260px;max-width:100%;padding:9px 12px;border:1px solid #c3d3e6;border-radius:7px;background:white;color:#24364b;font:inherit}
.unselected-signals{display:flex;gap:18px;flex-wrap:wrap;padding:0 18px 18px}.unselected-signals label{display:grid;gap:8px;min-width:260px;color:#40546f;font-size:14px}.unselected-signals select{padding:9px 12px;border:1px solid #d7e0ec;border-radius:7px;background:#f4f6fa;color:#687b92}
</style>
