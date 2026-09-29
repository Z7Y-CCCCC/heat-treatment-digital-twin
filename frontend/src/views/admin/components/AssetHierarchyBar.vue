<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { getFactoryScope, setFactoryScope, FACTORY_DIRECTORY_CHANGE_EVENT } from '../../../runtime/factoryScope.js'

const props = defineProps({
  workshops: { type: Array, default: () => [] },
  lines: { type: Array, default: () => [] },
  devices: { type: Array, default: () => [] },
  workshopId: { type: String, default: '' },
  lineId: { type: String, default: '' },
  deviceId: { type: String, default: '' },
  modelLibrary: { type: Boolean, default: false },
  requestSwitch: { type: Function, required: true }
})
const factories = ref([])
const factoryId = ref(getFactoryScope())
const error = ref('')
const switching = ref(false)

async function reloadFactories() {
  try {
    const result = await adminApi.listFactories()
    if (result.error) throw new Error(result.error)
    factories.value = (result.factories || []).filter(factory => factory.enabled)
    if (!factories.value.some(factory => factory.id === factoryId.value)) {
      factoryId.value = result.activeFactoryId || factories.value[0]?.id || ''
    }
  } catch (cause) { error.value = cause.message || '工厂列表读取失败' }
}
onMounted(() => { reloadFactories(); window.addEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, reloadFactories) })
onUnmounted(() => window.removeEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, reloadFactories))

const currentFactory = computed(() => factories.value.find(factory => factory.id === factoryId.value))
const currentDevice = computed(() => props.devices.find(device => device.id === props.deviceId))
const currentLine = computed(() => props.lines.find(line => line.id === (props.lineId || currentDevice.value?.line_id)))
const currentWorkshop = computed(() => props.workshops.find(workshop => workshop.id === (props.workshopId || currentLine.value?.workshop_id)))
const hierarchy = computed(() => [
  { level: '工厂', name: currentFactory.value?.name || '正在读取工厂…', active: true },
  { level: '车间', name: currentWorkshop.value?.name || '全部车间', active: !!currentWorkshop.value },
  { level: '产线', name: currentLine.value?.name || '全部产线', active: !!currentLine.value },
  { level: '设备', name: currentDevice.value?.name || '全部设备', active: !!currentDevice.value }
])

async function changeFactory(event) {
  const next = event.target.value
  if (!next || next === factoryId.value) return
  const name = factories.value.find(factory => factory.id === next)?.name || next
  error.value = ''
  switching.value = true
  let accepted = false
  try {
    accepted = await props.requestSwitch({ factoryId: next, factoryName: name })
  } catch (cause) {
    error.value = cause.message || '切换工厂失败'
  } finally {
    switching.value = false
  }
  if (!accepted) {
    event.target.value = factoryId.value
    return
  }
  setFactoryScope(next)
  factoryId.value = next
  window.location.reload()
}
</script>

<template>
  <section class="asset-hierarchy-bar" aria-label="当前资产层级">
    <div class="asset-hierarchy-heading"><span>资产归属</span><strong>工厂 → 车间 → 产线 → 设备</strong></div>
    <div class="asset-hierarchy-main">
      <label class="asset-factory-select">当前工厂
        <select :value="factoryId" :disabled="!factories.length || switching" @change="changeFactory">
          <option v-if="!factories.length" value="">正在读取…</option>
          <option v-for="factory in factories" :key="factory.id" :value="factory.id">{{ factory.name }}</option>
        </select>
      </label>
      <div class="asset-hierarchy-path">
        <div v-for="(item, index) in hierarchy" :key="item.level" class="asset-hierarchy-node" :class="{ active: item.active }">
          <span v-if="index" class="asset-hierarchy-arrow" aria-hidden="true">›</span>
          <span class="asset-hierarchy-copy"><small>{{ item.level }}</small><strong>{{ item.name }}</strong></span>
        </div>
      </div>
    </div>
    <p v-if="modelLibrary" class="asset-hierarchy-note">模型库包含集团共享资产和当前工厂资产；“适用层级”是资产分类，实际安装位置由场景或设备配置决定。</p>
    <p v-else class="asset-hierarchy-note">此处只切换后台编辑对象；地图同时展示所有已接入工厂。</p>
    <p v-if="switching" class="asset-hierarchy-note" role="status">正在确认并处理当前工厂的草稿，请稍候…</p>
    <p v-if="error" class="asset-hierarchy-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.asset-hierarchy-bar{margin:0 0 18px;padding:13px 16px;border:1px solid #dfe6f0;border-radius:10px;background:linear-gradient(110deg,#fbfcfe,#f4f7fc);color:#344159}
.asset-hierarchy-heading{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:10px;color:#8290a4}.asset-hierarchy-heading strong{font-size:10px;font-weight:600;letter-spacing:.03em;color:#536786}
.asset-hierarchy-main{display:flex;align-items:center;gap:14px;min-width:0}.asset-factory-select{display:grid;gap:3px;flex:0 0 clamp(230px,28%,380px);color:#8994a6;font-size:10px}.asset-factory-select select{width:100%;min-width:0;padding:6px 26px 6px 8px;border:1px solid #cfd8e8;border-radius:6px;background:#fff;color:#213b68;font:600 12px "Microsoft YaHei UI",sans-serif}.asset-hierarchy-path{display:flex;align-items:center;min-width:0;flex:1;gap:5px}.asset-hierarchy-node{display:flex;align-items:center;min-width:0;gap:5px}.asset-hierarchy-arrow{color:#a2aec1;font-size:17px}.asset-hierarchy-copy{display:grid;min-width:0;gap:1px;padding:4px 7px;border:1px solid #e2e7ef;border-radius:6px;background:#fff}.asset-hierarchy-copy small{color:#93a0b0;font-size:9px}.asset-hierarchy-copy strong{color:#9ba6b5;font-size:10px;font-weight:500;line-height:1.3;overflow-wrap:anywhere}.asset-hierarchy-node.active .asset-hierarchy-copy{border-color:#c5d7f5;background:#f0f5fe}.asset-hierarchy-node.active strong{color:#315da2;font-weight:600}.asset-hierarchy-note,.asset-hierarchy-error{margin:8px 0 0;color:#7c8ba1;font-size:10px}.asset-hierarchy-error{color:#b43e4d}@media(max-width:1050px){.asset-hierarchy-main{flex-wrap:wrap}.asset-factory-select{flex-basis:min(100%,380px)}.asset-hierarchy-path{flex-basis:100%;overflow-x:auto;padding-bottom:3px}.asset-hierarchy-node{flex:none}}
</style>
