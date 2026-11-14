<script setup>
import { computed, ref, watch } from 'vue'
import LoadingPortEditor from './LoadingPortEditor.vue'
import DockingCalibration from './DockingCalibration.vue'

const props = defineProps({ model: { type: Object, required: true }, devices: { type: Array, default: () => [] }, lines: { type: Array, default: () => [] }, models: { type: Array, default: () => [] }, confirm: { type: Function, default: async () => false }, canCalibrate: { type: Function, default: () => true } })
const emit = defineEmits(['saved', 'calibrated'])
const editor = ref(null), calibration = ref(null), deviceId = ref(''), expanded = ref(false), feedback = ref('')
let generation=0
const candidates = computed(() => props.devices.filter(device => String(device.model_type) === String(props.model.id)))
const selectedDevice = computed(() => candidates.value.find(device => String(device.id) === deviceId.value) || null)
const editors=()=>[editor.value,calibration.value].filter(Boolean)
const busy = computed(() => editors().some(item=>item.busy===true))
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
async function toggleCalibration(){
  if(busy.value)return
  const version=generation
  if(expanded.value){if(!await (calibration.value?.canLeave?.()??true)||version!==generation)return;expanded.value=false;return}
  if(editor.value?.dirty){if(await props.confirm('先保存当前料口区域，再检查小车对接？')!==true||version!==generation||busy.value)return;if(!await editor.value.savePending())return}
  if(version===generation&&!busy.value){feedback.value='';expanded.value=true}
}
async function canCalibrateLine(lineId){if(editor.value?.dirty){feedback.value='请先完成并保存料口区域，再显示或保存双实体对接校准。';return false}return await props.canCalibrate(lineId)}
async function choose(event) {
  const id = event.target.value
  if (!await canLeave()) { event.target.value = deviceId.value; return }
  deviceId.value = candidates.value.some(device => String(device.id) === id) ? id : ''
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
        <option value="">模型默认料口位置</option>
        <option v-for="device in candidates" :key="device.id" :value="String(device.id)">{{ device.name || device.id }} · 进出料信号</option>
      </select>
    </label>
    <div v-if="!selectedDevice" class="unselected-signals">
      <label>进料／取料信号<select disabled aria-label="进料取料信号"><option>先在上方选择具体设备</option></select></label>
      <label>出料／送料信号<select disabled aria-label="出料送料信号"><option>先在上方选择具体设备</option></select></label>
    </div>
    <LoadingPortEditor ref="editor" :model="model" :device="selectedDevice" :confirm="confirm" @saved="emit('saved', $event)" />
    <section class="docking-check-section" aria-label="按需检查小车对接"><button type="button" class="docking-check-toggle" :aria-expanded="expanded" :disabled="busy" @click="toggleCalibration"><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h7v12H3zM14 8h7v8h-7M10 12h4M12 10l2 2-2 2"/></svg>检查小车对接与实体位置</span><span>{{ expanded?'收起':'展开' }}</span></button><p>先在模型上画真实料口区域并保存，再按需核对小车与设备左右、高度偏差；实体错位在这里调整，不挪区域标记。标记对齐不代替关门阻挡与开门让口验收。</p><p v-if="feedback" class="workspace-feedback" role="status">{{ feedback }}</p><DockingCalibration v-if="expanded" ref="calibration" :model="model" :preferred-device-id="deviceId" :devices="devices" :lines="lines" :models="models" :confirm="confirm" :can-calibrate="canCalibrateLine" @calibrated="emit('calibrated', $event)" /></section>
  </section>
</template>

<style scoped>
.docking-check-section{margin-top:20px;border:1px solid #d9e4ef;border-radius:10px;padding:16px;background:#f8fbfe}.docking-check-toggle{display:flex;justify-content:space-between;align-items:center;gap:16px;width:100%;padding:12px 14px;border:1px solid #c8d9e8;border-radius:8px;background:#fff;color:#304c68;font:inherit;font-weight:600;cursor:pointer}.docking-check-toggle>span:first-child{display:flex;align-items:center;gap:10px}.docking-check-toggle svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.5}.docking-check-toggle:disabled{opacity:.5;cursor:not-allowed}.docking-check-section>p{font-size:13px;line-height:1.7;color:#61758a;margin:12px 2px}.workspace-feedback{color:#8f6a25!important}
.context-picker{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:14px 18px;margin:0 0 12px;background:#f4f8ff;border:1px solid #d7e3f2;border-radius:9px;font-size:14px;font-weight:600;color:#30465e}.context-picker select{min-width:260px;max-width:100%;padding:9px 12px;border:1px solid #c3d3e6;border-radius:7px;background:white;color:#24364b;font:inherit}
.unselected-signals{display:flex;gap:18px;flex-wrap:wrap;padding:0 18px 18px}.unselected-signals label{display:grid;gap:8px;min-width:260px;color:#40546f;font-size:14px}.unselected-signals select{padding:9px 12px;border:1px solid #d7e0ec;border-radius:7px;background:#f4f6fa;color:#687b92}
</style>
