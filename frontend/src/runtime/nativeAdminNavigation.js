import { isNativeUnitySurface } from './nativeSurfaceBridge.js'

// The transparent Unity overlay is a separate WebView. Switch to the native
// admin surface instead of routing that overlay to /admin and stacking a
// second copy of the desktop chrome inside it.
export function openAdminSurface({ embedded, surface, webview, router, focus }) {
  // The group map can also be opened inside the existing admin WebView (for
  // example from factory-location settings). In that case the host already
  // is the admin window: asking it to "show admin" only reveals the locked
  // /admin page underneath while leaving this map and its own chrome visible.
  // Navigate within the same WebView instead of revealing another surface.
  if (surface === 'admin' && isNativeUnitySurface(embedded, webview)) {
    router.push({
      path: '/admin',
      query: { embedded: 'unity', ...(focus ? { focus } : {}) }
    })
    return 'route'
  }

  if (isNativeUnitySurface(embedded, webview)) {
    webview.postMessage({ type: 'host_action', action: 'show_admin', ...(focus ? { focus } : {}) })
    return 'native'
  }

  // A URL flag alone does not prove that this is hosted by Unity. Keeping it
  // when the bridge is absent makes AdminAccess draw a second fake window
  // chrome inside the desktop/browser shell (the nested-window bug).
  router.push({ path: '/admin', query: { ...(focus ? { focus } : {}) } })
  return 'route'
}

export function adminUiStateForFocus(state, focus) {
  if (focus !== 'factory-location') return state
  return { ...state, activeTab: 'platform', platformSubpage: 'scene' }
}

export function canResumeDashboardAfterLogin({ pending, authenticated, permissions } = {}) {
  return pending === true
    && authenticated === true
    && permissions?.launch === true
    && permissions?.view === true
}
