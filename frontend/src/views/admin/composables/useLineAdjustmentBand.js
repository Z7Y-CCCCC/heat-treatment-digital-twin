import { ref, watch, onScopeDispose } from 'vue'
import { lineAdjustmentBand } from '../../../../../shared/lineAdjustmentBand.mjs'

// Measure only on line/model/geometry changes, never on each render frame.
// Reading a model or recomputing a band does not move or save any equipment.
export function useLineAdjustmentBand(source, { delay = 100 } = {}) {
  const band = ref(null), pending = ref(false), error = ref('')
  let version = 0, timer, stopped = false
  const refresh = () => {
    const request = source(), generation = ++version
    clearTimeout(timer); band.value = null; error.value = ''
    pending.value = !!request
    if (!request) return
    timer = setTimeout(async () => {
      try {
        const rows = await request.measure()
        if (stopped || generation !== version || request.key !== source()?.key) return
        band.value = lineAdjustmentBand(request.layout, rows)
      } catch (cause) { if (!stopped && generation === version) error.value = cause.message || '微调范围检查失败' }
      finally { if (!stopped && generation === version) pending.value = false }
    }, delay)
  }
  // A lane and its bound devices are translated in one Vue batch. Do not
  // invalidate on the transient half-updated relative coordinate mid-batch.
  const stopWatch = watch(() => source()?.key, refresh, { immediate: true, flush: 'pre' })
  onScopeDispose(() => { stopped = true; version++; clearTimeout(timer); stopWatch() })
  return { band, pending, error, refresh }
}
