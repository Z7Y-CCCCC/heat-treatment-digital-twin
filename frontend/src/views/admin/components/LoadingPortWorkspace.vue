<script setup>
import { computed, ref, watch } from 'vue'
import LoadingPortEditor from './LoadingPortEditor.vue'

const props = defineProps({ model: { type: Object, required: true }, devices: { type: Array, default: () => [] }, confirm: { type: Function, default: async () => false } })
const emit = defineEmits(['saved'])
const editor = ref(null), deviceId = ref('')
const candidates = computed(() => props.devices.filter(device => String(device.model_type) === String(props.model.id)))
const selectedDevice = computed(() => candidates.value.find(device => String(device.id) === deviceId.value) || null)
const busy = computed(() => editor.value?.busy === true)
async function choose(event) {
  const id = event.target.value
  if (editor.value && !await editor.value.canLeave()) { event.target.value = deviceId.value; return }
  deviceId.value = candidates.value.some(device => String(device.id) === id) ? id : ''
}
watch(() => props.model.id, () => { deviceId.value = '' })
defineExpose({ canLeave: () => editor.value?.canLeave() ?? true, savePending: () => editor.value?.savePending() ?? true,
  discardPending: () => editor.value?.discardPending(), busy })
</script>

<template>
  <section class="loading-port-workspace" aria-label="模型与设备进出料口配置">
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
  </section>
</template>

<style scoped>
.context-picker{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 18px;margin:0 0 12px;background:#f4f8ff;border:1px solid #d7e3f2;border-radius:9px;font-size:14px;font-weight:600;color:#30465e}.context-picker select{min-width:260px;max-width:100%;padding:9px 12px;border:1px solid #c3d3e6;border-radius:7px;background:white;color:#24364b;font:inherit}
.unselected-signals{display:flex;gap:18px;flex-wrap:wrap;padding:0 18px 18px}.unselected-signals label{display:grid;gap:8px;min-width:260px;color:#40546f;font-size:14px}.unselected-signals select{padding:9px 12px;border:1px solid #d7e0ec;border-radius:7px;background:#f4f6fa;color:#687b92}
</style>
