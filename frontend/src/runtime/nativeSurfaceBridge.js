export const NATIVE_SURFACE_CHANNEL='digital-twin-native-surface-v1'

export function isNativeUnitySurface(embedded, webview) {
  return embedded === 'unity' && typeof webview?.postMessage === 'function'
}

export function isNativeOverlaySurface(embedded, surface, webview) {
  return surface === 'overlay' && isNativeUnitySurface(embedded, webview)
}

export function requestNativeSceneSurface() {
  if(typeof BroadcastChannel==='undefined')return
  const channel=new BroadcastChannel(NATIVE_SURFACE_CHANNEL)
  channel.postMessage({type:'show_native_scene'})
  channel.close()
}
