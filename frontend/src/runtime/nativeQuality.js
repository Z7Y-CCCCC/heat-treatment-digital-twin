import { reactive, onMounted, onUnmounted } from 'vue'
import { createQualityTransport, QUALITY_CHANNEL } from './nativeQualityTransport.js'

export const QUALITY_PROFILES = [
  { key: 'integrated_gpu', label: '流畅', shortcut: 'F1' },
  { key: 'balanced', label: '均衡', shortcut: 'F2' },
  { key: 'showcase', label: '高画质', shortcut: 'F3' }
]
export function createNativeQualityControl({ state, post, later = setTimeout, cancel = clearTimeout }) {
  let revision = 0, sequence = 0, pendingId = '', pendingTimer, noticeTimer, disposed = false
  const session = Math.random().toString(36).slice(2)
  function notice(text, error = false) {
    cancel(noticeTimer); state.notice = text; state.error = error
    noticeTimer = later(() => { state.notice = '' }, error ? 5000 : 2800)
  }
  function request(profile, hotkey = false) {
    if (disposed || !QUALITY_PROFILES.some(p => p.key === profile) && profile !== 'auto') return false
    if (!state.enabled || hotkey && state.hotkeysEnabled === false) return false
    const requestId = `${session}-${++sequence}`
    cancel(pendingTimer); pendingId = requestId; state.pending = profile
    pendingTimer = later(() => { pendingId = ''; state.pending = ''; notice('画质切换未确认，请重试', true) }, 8000)
    try { post({ type: 'dashboard_action', action: hotkey ? 'quality_hotkey' : 'set_quality_profile', profile, requestId }) }
    catch { cancel(pendingTimer); pendingId = ''; state.pending = ''; notice('无法连接 Unity 客户端', true); return false }
    return true
  }
  function receive(message) {
    if (disposed || message?.type !== 'native_quality_state' || !Number.isSafeInteger(message.revision) || message.revision <= revision
      || !QUALITY_PROFILES.some(p => p.key === message.profile)) return false
    revision = message.revision
    Object.assign(state, { profile: message.profile, automatic: message.automatic === true,
      enabled: message.enabled === true, hotkeysEnabled: message.hotkeysEnabled === true })
    if (message.requestId && message.requestId === pendingId) { cancel(pendingTimer); pendingId = ''; state.pending = '' }
    if (message.notify === true && state.enabled) {
      const label = QUALITY_PROFILES.find(p => p.key === message.profile).label
      notice(`画质已切换：${message.automatic ? '自动 · ' : ''}${label}`)
    }
    return true
  }
  function query() { if (!disposed) try { post({ type: 'dashboard_action', action: 'get_quality_profile' }) } catch { /* Keep controls unavailable until a real native snapshot arrives. */ } }
  function keydown(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const profile = ({ F1: 'integrated_gpu', F2: 'balanced', F3: 'showcase', F4: 'auto' })[event.key || event.code]
    if (!profile || !state.enabled || state.hotkeysEnabled === false) return
    event.preventDefault(); event.stopPropagation(); request(profile, true)
  }
  return { request, receive, query, keydown, dispose() { disposed = true; cancel(pendingTimer); cancel(noticeTimer) } }
}

export function useNativeQuality(active = () => true, { relay = false, hotkeys = true } = {}) {
  const state = reactive({ profile: '', automatic: false, enabled: false, hotkeysEnabled: false, pending: '', notice: '', error: false })
  let channel = null
  try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(QUALITY_CHANNEL) } catch { /* A standalone browser can still edit saved settings. */ }
  let controller
  const transport = createQualityTransport({ relay, channel, receive: snapshot => controller.receive(snapshot), postNative: message => {
    if (!window.chrome?.webview) throw new Error('Native host unavailable')
    window.chrome.webview.postMessage(message)
  } })
  controller = createNativeQualityControl({ state, post: transport.post })
  let hostVisible = false
  const message = event => {
    if (!active()) return
    if (controller.receive(event.data)) transport.publish(event.data)
    if (event.data?.type === 'overlay_host_state') {
      if (!hostVisible && event.data.visible !== false) controller.query()
      hostVisible = event.data.visible !== false
    }
  }
  const keydown = event => { if (active()) controller.keydown(event) }
  onMounted(() => {
    window.chrome?.webview?.addEventListener('message', message)
    if (hotkeys) window.addEventListener('keydown', keydown, true)
    controller.query()
  })
  onUnmounted(() => {
    controller.dispose()
    transport.dispose()
    window.chrome?.webview?.removeEventListener('message', message)
    if (hotkeys) window.removeEventListener('keydown', keydown, true)
  })
  return { qualityState: state, setQuality: controller.request, queryQuality: controller.query }
}
