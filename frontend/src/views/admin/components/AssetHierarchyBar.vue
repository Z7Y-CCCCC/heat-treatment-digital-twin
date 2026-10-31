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
    error.value = ''
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
  { level: '车间', name: currentWorkshop.value?.name || currentWorkshop.value?.id || '全部', active: !!currentWorkshop.value },
  { level: '产线', name: currentLine.value?.name || currentLine.value?.id || (currentDevice.value ? '未分配' : '全部'), active: !!currentLine.value },
  { level: '设备', name: currentDevice.value?.name || currentDevice.value?.id || '全部', active: !!currentDevice.value }
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
  <section class="asset-hierarchy-bar" aria-label="当前编辑范围">
    <div class="asset-hierarchy-main">
      <label class="asset-factory-select"><span>工厂</span>
        <select aria-label="当前编辑工厂" :title="currentFactory?.name" :value="factoryId" :disabled="!factories.length || switching" @change="changeFactory">
          <option v-if="!factories.length" value="">正在读取…</option>
          <option v-for="factory in factories" :key="factory.id" :value="factory.id">{{ factory.name }}</option>
        </select>
      </label>
      <ol class="asset-hierarchy-path" aria-label="编辑位置">
        <li v-for="item in hierarchy" :key="item.level" class="asset-hierarchy-node" :class="{ active: item.active }">
          <span class="asset-hierarchy-arrow" aria-hidden="true">/</span>
          <span class="asset-hierarchy-copy" :title="`${item.level}：${item.name}`"><small>{{ item.level }}</small><strong>{{ item.name }}</strong></span>
        </li>
      </ol>
    </div>
    <span v-if="switching" class="asset-hierarchy-status" role="status">正在切换…</span>
    <p v-if="error" class="asset-hierarchy-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.asset-hierarchy-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;box-sizing:border-box;width:fit-content;max-width:100%;margin:0 0 12px;padding:6px 10px;border:1px solid #dfe6f0;border-radius:7px;background:#f8faff;color:#344159}
.asset-hierarchy-main{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;min-width:0}.asset-factory-select{display:flex;align-items:center;gap:6px;min-width:0;color:#7d899c;font-size:11px}.asset-factory-select>span{flex:none}.asset-factory-select select{width:clamp(180px,22vw,260px);max-width:100%;min-width:0;min-height:28px;padding:4px 24px 4px 8px;border:1px solid #cfd8e8;border-radius:5px;background:#fff;color:#213b68;font:600 12px "Microsoft YaHei UI",sans-serif}.asset-hierarchy-path{display:flex;flex-wrap:wrap;align-items:center;min-width:0;gap:6px 8px;margin:0;padding:0;list-style:none}.asset-hierarchy-node{display:flex;align-items:center;min-width:0;gap:8px}.asset-hierarchy-arrow{color:#b3bdcc;font-size:12px}.asset-hierarchy-copy{display:flex;align-items:center;min-width:0;gap:5px}.asset-hierarchy-copy small{flex:none;color:#8b98ab;font-size:10px}.asset-hierarchy-copy strong{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8490a3;font-size:11px;font-weight:400}.asset-hierarchy-node.active strong{color:#344b6c;font-weight:500}.asset-hierarchy-status,.asset-hierarchy-error{margin:0;font-size:11px;color:#7c8ba1}.asset-hierarchy-error{color:#b43e4d}@media(max-width:760px){.asset-factory-select select{width:210px}.asset-hierarchy-copy strong{max-width:140px}}
</style>
