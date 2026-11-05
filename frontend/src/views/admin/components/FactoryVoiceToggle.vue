<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import EnableCapsule from '../../../components/EnableCapsule.vue'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch, canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope, FACTORY_SCOPE_CHANGE_EVENT } from '../../../runtime/factoryScope.js'
import AdminNotice from './AdminNotice.vue'
import { useAdminNotice } from '../composables/useAdminNotice.js'

const enabled = ref(false), loaded = ref(false), pending = ref(false), factoryId = ref('')
const { notice, show, clear } = useAdminNotice()
let generation = 0, controller, disposed = false
async function load() {
  const current = ++generation; controller?.abort(); controller = new AbortController()
  const request = controller; let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; request.abort() }, 8000)
  loaded.value = false; pending.value = true
  try {
    const response = await adminFetch(`${API_BASE}/settings/voice`, { headers: { 'X-Factory-ID': getFactoryScope() }, signal: controller.signal, cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.success !== true || typeof data.enabled !== 'boolean' || !data.factoryId) throw Error(data.error || '工厂语音状态读取失败')
    if (current !== generation || disposed) return
    factoryId.value = data.factoryId; enabled.value = data.enabled; loaded.value = true
  } catch (error) { if (!disposed && current === generation && (timedOut || error.name !== 'AbortError')) show(timedOut ? '语音状态读取超时' : error.message || '语音状态读取失败', 'error') }
  finally { clearTimeout(timeout); if (!disposed && current === generation) pending.value = false }
}
async function toggle() {
  if (!loaded.value || pending.value || !canAdminPage('points', 'edit')) return
  const current = generation, id = factoryId.value, next = !enabled.value
  pending.value = true; controller = new AbortController()
  const request = controller; let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; request.abort() }, 8000)
  try {
    const response = await adminFetch(`${API_BASE}/settings/voice`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Factory-ID': id }, body: JSON.stringify({ enabled: next }), signal: controller.signal })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.success !== true || data.factoryId !== id || data.enabled !== next) throw Error(data.error || '语音开关保存失败')
    if (disposed || current !== generation) return
    enabled.value = next; show(next ? '当前工厂语音播报已启用' : '当前工厂语音播报已停用')
  } catch (error) {
    if (!disposed && current === generation && (timedOut || error.name !== 'AbortError')) {
      show(timedOut ? '语音开关保存超时' : error.message || '语音开关保存失败', 'error')
      // A lost HTTP acknowledgement is not proof that the server rolled back.
      if (timedOut || error instanceof TypeError) void load()
    }
  }
  finally { clearTimeout(timeout); if (!disposed && current === generation) pending.value = false }
}
function storageChanged(event) { if (event.key === 'digital_twin_factory_scope_v1') void load() }
onMounted(() => { void load(); window.addEventListener(FACTORY_SCOPE_CHANGE_EVENT, load); window.addEventListener('storage', storageChanged) })
onUnmounted(() => { disposed = true; generation++; controller?.abort(); window.removeEventListener(FACTORY_SCOPE_CHANGE_EVENT, load); window.removeEventListener('storage', storageChanged) })
</script>
<template>
  <span class="factory-voice-toggle"><span>语音播报</span><EnableCapsule :enabled="enabled" :disabled="!loaded || !canAdminPage('points','edit')" :pending="pending" label="当前工厂语音播报" :title="loaded ? '当前工厂语音播报总开关' : '正在读取工厂语音状态'" @toggle="toggle" /></span>
  <AdminNotice :state="notice" @close="clear" />
</template>
<style scoped>.factory-voice-toggle { display:inline-flex; align-items:center; flex-wrap:wrap; gap:7px; white-space:nowrap; }.factory-voice-toggle :deep(.enable-capsule) { vertical-align:middle; }</style>
