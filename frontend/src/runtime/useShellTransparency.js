import { computed, onScopeDispose, ref, watch } from 'vue'

export function useShellTransparency({ context, connected, send }) {
  const pending = ref(false), error = ref('')
  const available = computed(() => connected() && context.sceneReady === true && context.viewMode === 'device'
    && !!context.deviceId && context.shellTransparencyAvailable === true)
  let timer = null, expected = null, disposed = false
  function clear() { clearTimeout(timer); timer = null; expected = null; pending.value = false }
  watch(() => [context.deviceId, context.viewMode, context.shellTransparent, available.value], () => {
    if (!expected) return
    if (context.deviceId !== expected.deviceId || !available.value) { clear(); error.value = ''; return }
    if (context.shellTransparent === expected.enabled) clear()
  }, { flush:'sync' })
  async function toggle() {
    if (disposed || pending.value || !available.value) return false
    error.value = ''; pending.value = true
    const request = expected = { deviceId:context.deviceId, enabled:!context.shellTransparent }
    try {
      if (await send({ command:'shell_transparency', enabled:request.enabled }) === false) throw Error('外壳显示未切换，请检查运行端连接')
      if (disposed || expected !== request) return true
      // A successful HTTP relay is not a native acknowledgement. Never fake
      // the pressed state; only the Unity context can change the icon.
      timer = setTimeout(() => { if (expected === request) { clear(); error.value = '运行端未确认外壳显示，请重试' } }, 5000)
      return true
    } catch (failure) { if (!disposed && expected === request) { clear(); error.value = failure.message } return false }
  }
  onScopeDispose(() => { disposed = true; clear() })
  return { available, pending, error, toggle }
}
