<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { showSaveFeedback } from '../../../runtime/saveFeedback.js'
import { adminApi } from '../../../config/factoryConfig.js'

const props = defineProps({ factoryId:String, deviceId:String, canEdit:Boolean })
const open = ref(false), loading = ref(false), busy = ref(false), policy = ref(null)
const error = ref('')
const loadedFactoryId = ref('')
let generation = 0, disposed = false
function valid(version) { return !disposed && version === generation }
async function load() {
  const version = ++generation, factoryId = props.factoryId
  policy.value = null; loadedFactoryId.value = ''; error.value = ''
  loading.value = true
  try {
    const result = await adminApi.getHistoryPolicy(factoryId, props.deviceId)
    if (!valid(version)) return
    if (!result.success || typeof result.factoryId !== 'string' || !result.factoryId || factoryId && result.factoryId !== factoryId || !result.policy || !Array.isArray(result.points)) throw Error(result.error || '当前工厂策略读取失败，请重新读取策略')
    // An unset browser preference means the server's current factory, not a
    // missing user selection. Pin subsequent writes to the confirmed response.
    loadedFactoryId.value = result.factoryId
    policy.value = result.policy
  } catch (cause) { if (valid(version)) error.value = cause.message }
  finally { if (valid(version)) loading.value = false }
}
function toggle(event) {
  open.value = event.target.open
  // Reopen after adding/removing points must refresh the saved point list.
  if (open.value && !loading.value && !busy.value) void load()
}
watch(() => [props.factoryId, props.deviceId], () => {
  generation++; loading.value = false; policy.value = null; loadedFactoryId.value = ''; error.value = ''
  if (open.value) void load()
})
async function save() {
  if (!props.canEdit || busy.value || loading.value || !policy.value || !loadedFactoryId.value) return
  const version = generation, factoryId = loadedFactoryId.value
  busy.value = true; error.value = ''
  try {
    const result = await adminApi.saveHistoryPolicy(factoryId, {...policy.value})
    if (!valid(version)) return
    if (!result.success || result.factoryId !== factoryId) throw Error(result.error || '保存未确认')
    showSaveFeedback('工厂历史策略已保存')
  } catch (cause) { if (valid(version)) showSaveFeedback(`保存失败：${cause.message}`, 'error') }
  finally { busy.value = false }
}
onUnmounted(() => { disposed = true; generation++ })
</script>
<template>
  <details class="history-settings" data-testid="point-history-settings" @toggle="toggle">
    <summary>趋势与历史记录 <span>近期滚动保留 · 长期按点位可选</span></summary>
    <div class="history-body">
      <p class="history-note">显示窗口与保存期限分开。点位默认只保留近期 24 小时，长期记录按点位开启；全厂指标默认按 90 天保留，可另行关闭或调整。关闭记录不影响实时显示。告警和操作事件不受此设置影响。</p>
      <p v-if="loading" role="status">正在读取当前工厂策略…</p>
      <p v-if="error" class="history-error" role="alert">{{ error }}</p>
      <button v-if="!policy && !loading" class="btn" type="button" @click="load">重新读取策略</button>
      <template v-if="policy">
        <fieldset :disabled="!canEdit || busy || loading">
          <legend>当前工厂 · 近期趋势与指标</legend>
          <div class="history-fields">
            <label class="history-check"><input v-model="policy.recentEnabled" aria-label="启用近期趋势记录" type="checkbox" />启用近期趋势记录</label>
            <label>近期保留（小时）<input v-model.number="policy.recentHours" aria-label="近期趋势保留小时" class="input" type="number" min="1" max="720" :disabled="!policy.recentEnabled" /></label>
            <label>全厂指标历史<select v-model="policy.metricMode" aria-label="全厂指标历史模式" class="input"><option value="off">关闭记录</option><option value="finite">按天保留</option><option value="permanent">永久保留</option></select></label>
            <label v-if="policy.metricMode === 'finite'">指标保留（天）<input v-model.number="policy.metricDays" aria-label="指标保留天数" class="input" type="number" min="1" max="36500" /></label>
          </div>
          <button class="btn btn-primary" type="button" @click="save">{{ busy ? '保存中…' : '保存工厂历史策略' }}</button>
        </fieldset>
      </template>
    </div>
  </details>
</template>
<style scoped>
.history-settings{margin:12px 0 18px;border:1px solid #dce5f1;border-radius:9px;background:#f8faff;color:#344a66;font-size:calc(13px * var(--admin-font-scale,1))}.history-settings summary{padding:13px 16px;cursor:pointer;font-weight:600}.history-settings summary span{font-weight:400;color:#748298;margin-left:12px}.history-body{padding:0 16px 16px}.history-note{color:#748298;line-height:1.7}.history-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:14px}.history-body label{display:grid;gap:7px;min-width:0}.history-body .history-check{display:flex;align-items:center;gap:7px}.history-body fieldset{border:1px solid #dce5f1;border-radius:7px;padding:14px;margin:12px 0}.history-body legend{padding:0 7px}.history-body input:not([type=checkbox]),.history-body select{box-sizing:border-box;width:100%;min-width:0;background:#fff;color:#344a66;border:1px solid #d5dfed;border-radius:6px;padding:9px;font:inherit}.history-body h4{margin:16px 0 12px}.history-error{color:#bb3939}.history-body :disabled{opacity:.65}.history-point{border-top:1px solid #dce5f1;padding-top:3px}.history-body button{padding:8px 14px;border-radius:6px;cursor:pointer}.history-body button:disabled{cursor:default}@media(max-width:700px){.history-settings summary span{display:block;margin:6px 0 0}.history-fields{grid-template-columns:1fr}}
</style>
