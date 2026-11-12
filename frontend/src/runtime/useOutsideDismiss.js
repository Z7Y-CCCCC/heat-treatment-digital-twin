import { onMounted, onScopeDispose } from 'vue'

// Scene clicks bypass the transparent WebView's DOM. The composition host
// reports them separately without consuming the original Unity gesture.
export function useOutsideDismiss({ element, isOpen, dismiss }) {
  let webview
  function outside(event) {
    if (!isOpen()) return
    const root = element.value
    if (root && (event.composedPath?.().includes(root) || root.contains(event.target))) return
    dismiss()
  }
  function scenePointer(event) {
    if (event.data?.type === 'overlay_scene_pointerdown' && isOpen()) dismiss()
  }
  onMounted(() => {
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    webview = window.chrome?.webview
    webview?.addEventListener('message', scenePointer)
  })
  onScopeDispose(() => {
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('focusin', outside)
    webview?.removeEventListener('message', scenePointer)
  })
  return { outside }
}
