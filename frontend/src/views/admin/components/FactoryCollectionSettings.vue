<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { FACTORY_DIRECTORY_CHANGE_EVENT } from '../../../runtime/factoryScope.js'
import EnableCapsule from '../../../components/EnableCapsule.vue'

const factories = ref([]), busyId = ref(''), error = ref(''), message = ref('')
async function load() {
  try {
    const result = await adminApi.listFactories()
    if (result.error) throw new Error(result.error)
    factories.value = result.factories || []
  } catch (cause) { error.value = cause.message || '读取采集状态失败' }
}
async function toggle(factory) {
  if (busyId.value || !canAdminPage('settings.data', 'edit')) return
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
  } finally { busyId.value = '' }
}
onMounted(() => { load(); window.addEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, load) })
onUnmounted(() => window.removeEventListener(FACTORY_DIRECTORY_CHANGE_EVENT, load))
</script>

<template>
  <section class="factory-collection-settings" aria-labelledby="factory-collection-title">
    <h3 id="factory-collection-title">工厂采集</h3>
    <div class="collection-table-wrap">
      <table><thead><tr><th>工厂</th><th>采集</th></tr></thead><tbody>
        <tr v-for="factory in factories" :key="factory.id" :data-collection-factory-id="factory.id">
          <td>{{ factory.name }}</td>
          <td><EnableCapsule :enabled="factory.collectionEnabled !== false" :pending="busyId === factory.id" :disabled="!!busyId || !canAdminPage('settings.data', 'edit')" :label="`采集：${factory.name}`" @toggle="toggle(factory)" /></td>
        </tr>
      </tbody></table>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.factory-collection-settings{margin:0 0 24px}.factory-collection-settings h3{margin:0 0 14px;color:#263349;font-size:16px}.collection-table-wrap{max-height:300px;overflow:auto;border:1px solid #e1e6ee;border-radius:9px}.factory-collection-settings table{width:100%;border-collapse:collapse;text-align:left;font-size:12px}.factory-collection-settings th{position:sticky;top:0;z-index:1;padding:9px 14px;background:#f6f8fb;color:#8590a2;font-weight:500}.factory-collection-settings td{padding:9px 14px;border-top:1px solid #edf0f5;color:#4f5c70}.factory-collection-settings th:last-child,.factory-collection-settings td:last-child{width:90px}.factory-collection-settings p{margin:10px 0 0;font-size:12px;color:#7b879a}.factory-collection-settings p[role=alert]{color:#b64250}
</style>
