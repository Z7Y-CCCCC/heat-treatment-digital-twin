<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { FACTORY_DIRECTORY_CHANGE_EVENT } from '../../../runtime/factoryScope.js'
import EnableCapsule from '../../../components/EnableCapsule.vue'

const factories = ref([]), busyId = ref(''), error = ref(''), message = ref('')
const statuses = ref({}), statusError = ref('')
let timer = null, controller = null, inFlight = false, disposed = false, statusGeneration = 0
const statusNames = { normal: '采集正常', simulation: '模拟运行', abnormal: '采集异常', connecting: '连接中', starting: '等待采集', unavailable: '采集不可用', disabled: '已停用', no_devices: '未配置设备', unconfigured: '未启用设备' }
function runtime(factory) { return statuses.value[factory.id] }
function statusText(factory) {
  if (statusError.value) return '状态未更新'
  const current = runtime(factory)
  if (!current) return '读取中…'
  const name = statusNames[current.status] || '状态未知'
  return current.pendingDevices ? `${name} · 待连接 ${current.pendingDevices}` : name
}
function count(factory, key) {
  const current = runtime(factory)
  return statusError.value || !current || ['disabled', 'no_devices', 'unconfigured'].includes(current.status) ? '—' : current[key]
}
function readTime(factory) {
  const value = runtime(factory)?.lastReadAt
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—'
}
async function refreshStatus() {
  if (disposed || inFlight || document.visibilityState === 'hidden') return
  inFlight = true
  const generation = statusGeneration
  controller = new AbortController()
  const timeout = setTimeout(() => controller?.abort(), 8000)
  try {
    const result = await adminApi.getFactoryCollectionStatus(controller.signal)
    if (disposed || generation !== statusGeneration) return
    if (result.error || !result.success || !Array.isArray(result.factories)) throw new Error(result.error || '读取工厂采集情况失败')
    statuses.value = Object.fromEntries(result.factories.map(factory => [factory.factoryId, factory]))
    for (const factory of factories.value) {
      if (factory.id !== busyId.value && statuses.value[factory.id]) factory.collectionEnabled = statuses.value[factory.id].collectionEnabled
    }
    statusError.value = ''
  } catch (cause) { if (!disposed && generation === statusGeneration) statusError.value = cause.message || '读取采集情况失败' }
  finally { clearTimeout(timeout); controller = null; inFlight = false }
}
async function load() {
  try {
    const result = await adminApi.listFactories()
    if (result.error) throw new Error(result.error)
    if (disposed) return
    factories.value = result.factories || []
    await refreshStatus()
  } catch (cause) { error.value = cause.message || '读取采集状态失败' }
}
async function toggle(factory) {
  if (busyId.value || !canAdminPage('settings.data', 'edit')) return
  statusGeneration++
  busyId.value = factory.id; error.value = ''; message.value = ''
  const enabled = factory.collectionEnabled === false
  try {
    const result = await adminApi.setFactoryCollection(factory.id, enabled)
    if (!result.success || result.factoryId !== factory.id || result.collectionEnabled !== enabled) throw new Error(result.error || '采集开关未确认')
    const current = factories.value.find(row => row.id === factory.id)
    if (current) current.collectionEnabled = enabled
    if (!result.runtimeApplied) message.value = '已保存，采集状态待同步。'
  } catch (cause) {
    const text = cause.message || '保存采集开关失败'
    await load(); error.value = text
  } finally { busyId.value = ''; statusGeneration++; await refreshStatus() }
}
function onVisibility() { if (document.visibilityState !== 'hidden') refreshStatus() }
onMounted(() => { load(); timer = setInterval(refreshStatus, 3000); window.addEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, load); document.addEventListener('visibilitychange', onVisibility) })
onUnmounted(() => { disposed = true; controller?.abort(); clearInterval(timer); window.removeEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, load); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <section class="factory-collection-settings" aria-labelledby="factory-collection-title">
    <h3 id="factory-collection-title">工厂采集</h3>
    <div class="collection-table-wrap">
      <table><thead><tr><th>工厂</th><th>采集状态</th><th>正常设备</th><th>异常设备</th><th>最近采集</th><th>采集</th></tr></thead><tbody>
        <tr v-for="factory in factories" :key="factory.id" :data-collection-factory-id="factory.id">
          <td>{{ factory.name }}</td>
          <td class="collection-state" :data-status="statusError ? 'unknown' : runtime(factory)?.status">{{ statusText(factory) }}</td>
          <td class="collection-count" :class="{ good: !statusError && runtime(factory)?.normalDevices > 0 }">{{ count(factory, 'normalDevices') }}</td>
          <td class="collection-count" :class="{ bad: !statusError && runtime(factory)?.abnormalDevices > 0 }">{{ count(factory, 'abnormalDevices') }}</td>
          <td class="collection-time">{{ readTime(factory) }}</td>
          <td><EnableCapsule :enabled="factory.collectionEnabled !== false" :pending="busyId === factory.id" :disabled="!!busyId || !canAdminPage('settings.data', 'edit')" :label="`采集：${factory.name}`" @toggle="toggle(factory)" /></td>
        </tr>
      </tbody></table>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="statusError && !error" role="alert">{{ statusError }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.factory-collection-settings{margin:0 0 24px}.factory-collection-settings h3{margin:0 0 14px;color:#263349;font-size:16px}.collection-table-wrap{max-height:300px;overflow:auto;border:1px solid #e1e6ee;border-radius:9px}.factory-collection-settings table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.factory-collection-settings th{position:sticky;top:0;z-index:1;padding:9px 14px;background:#f6f8fb;color:#8590a2;font-weight:500}.factory-collection-settings td{padding:9px 14px;border-top:1px solid #edf0f5;color:#4f5c70}.factory-collection-settings th:last-child,.factory-collection-settings td:last-child{width:90px}.factory-collection-settings p{margin:10px 0 0;font-size:12px;color:#7b879a}.factory-collection-settings p[role=alert]{color:#b64250}
.factory-collection-settings table{min-width:700px}.collection-count,.collection-time{font-variant-numeric:tabular-nums;white-space:nowrap}.collection-count.good,.collection-state[data-status=normal]{color:#21764e}.collection-count.bad,.collection-state[data-status=abnormal],.collection-state[data-status=unavailable]{color:#b64250}.collection-state{white-space:nowrap}.collection-state[data-status=connecting],.collection-state[data-status=starting],.collection-state[data-status=unknown]{color:#92743b}
</style>
