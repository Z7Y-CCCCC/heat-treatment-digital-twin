import { computed, ref, watch, onScopeDispose, unref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { showSaveFeedback } from '../../../runtime/saveFeedback.js'

export function usePointHistoryColumn({ factoryId, deviceId, canEdit, api = adminApi, notify = showSaveFeedback }) {
  const visible = ref(false), loading = ref(false), error = ref(''), rows = ref({}), saving = ref({})
  const anySaving = computed(() => Object.values(saving.value).some(Boolean))
  let generation = 0, disposed = false, confirmedFactory = ''
  const valid = version => !disposed && generation === version
  async function load() {
    if (disposed || anySaving.value) return
    const version = ++generation, factory = unref(factoryId)
    confirmedFactory = ''; rows.value = {}; error.value = ''; loading.value = true
    try {
      const result = await api.getHistoryPolicy(factory, unref(deviceId))
      if (!valid(version)) return
      if (!result?.success || !result.factoryId || typeof result.factoryId !== 'string' || factory && result.factoryId !== factory || !Array.isArray(result.points)) throw Error(result?.error || '保存策略读取未确认')
      confirmedFactory = result.factoryId
      rows.value = Object.fromEntries(result.points.map(point => [String(point.id), { mode: point.history_mode ?? 'recent', days: point.history_days ?? 30, label: point.label || point.name }]))
    } catch (cause) { if (valid(version)) error.value = cause.message }
    finally { if (valid(version)) loading.value = false }
  }
  async function toggle() {
    if (loading.value || anySaving.value) return
    visible.value = !visible.value
    if (visible.value) await load()
  }
  async function save(id, policy) {
    const key = String(id), row = rows.value[key]
    if (disposed || !unref(canEdit) || loading.value || !confirmedFactory || !row || saving.value[key]) return false
    const version = generation, factory = confirmedFactory
    const mode = policy.mode, days = policy.days
    if (!['recent','off','finite','permanent'].includes(mode) || !Number.isInteger(days) || days < 1 || days > 36500) {
      notify('保存失败：保留天数须为 1～36500 的整数', 'error'); return false
    }
    if (mode === row.mode && days === row.days) return true
    saving.value = { ...saving.value, [key]: true }
    try {
      const result = await api.savePointHistoryPolicy(factory, id, { mode, days })
      if (!valid(version)) return false
      if (!result?.success || result.factoryId !== factory || String(result.pointId) !== key) throw Error(result?.error || '保存未确认')
      rows.value = { ...rows.value, [key]: { ...row, mode, days } }
      notify(`${row.label || '点位'}保存策略已保存`)
      return true
    } catch (cause) { if (valid(version)) notify(`保存失败：${cause.message}`, 'error'); return false }
    finally { if (valid(version)) saving.value = { ...saving.value, [key]: false } }
  }
  watch([factoryId, deviceId], () => {
    generation++; confirmedFactory = ''; rows.value = {}; saving.value = {}; loading.value = false; error.value = ''
    if (visible.value) void load()
  })
  onScopeDispose(() => { disposed = true; generation++ })
  return { visible, loading, error, rows, saving, anySaving, toggle, load, save }
}
