// Same-origin WebView2 pages share only transient, native-confirmed quality
// state. No settings writes, account tokens or persisted "current" snapshots.
export const QUALITY_CHANNEL = 'digital-twin-native-quality-v1'
const profiles = new Set(['auto', 'integrated_gpu', 'balanced', 'showcase'])
function qualityCommand(value) {
  if (value?.type !== 'dashboard_action' || !['get_quality_profile', 'set_quality_profile', 'quality_hotkey'].includes(value.action)) return null
  if (value.action !== 'get_quality_profile' && !profiles.has(value.profile)) return null
  return { type: 'dashboard_action', action: value.action,
    ...(value.action === 'get_quality_profile' ? {} : {profile: value.profile, requestId: String(value.requestId || '').slice(0, 80)}) }
}
export function createQualityTransport({ relay = false, channel, receive, postNative }) {
  let latest = null, disposed = false
  const publish = snapshot => {
    if (disposed || relay) return
    if (snapshot?.type !== 'native_quality_state' || !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision <= (latest?.revision || 0) || !profiles.has(snapshot.profile) || snapshot.profile === 'auto') return
    latest = {type:'native_quality_state',revision:snapshot.revision,profile:snapshot.profile,
      automatic:snapshot.automatic===true,enabled:snapshot.enabled===true,hotkeysEnabled:snapshot.hotkeysEnabled===true,
      requestId:String(snapshot.requestId||'').slice(0,80),notify:false}
    channel?.postMessage({kind: 'state', snapshot: latest})
  }
  const listener = event => {
    if (disposed) return
    const message = event.data
    if (relay) { if (message?.kind === 'state') receive(message.snapshot); return }
    if (message?.kind !== 'command') return
    const command = qualityCommand(message.command)
    if (!command) return
    if (command.action === 'get_quality_profile' && latest) channel?.postMessage({kind:'state', snapshot:{...latest, requestId:'', notify:false}})
    try { postNative(command) } catch { /* Only a connected native surface can acknowledge a request. */ }
  }
  channel?.addEventListener('message', listener)
  return { publish,
    post(value) {
      if (disposed) throw new Error('Quality transport is closed')
      const command = qualityCommand(value)
      if (!command) throw new Error('Invalid quality command')
      if (relay) {
        if (!channel) throw new Error('Native quality relay is unavailable')
        channel.postMessage({kind:'command',command})
      } else postNative(command)
    },
    dispose() { disposed = true; latest = null; channel?.removeEventListener('message', listener); channel?.close() }
  }
}
