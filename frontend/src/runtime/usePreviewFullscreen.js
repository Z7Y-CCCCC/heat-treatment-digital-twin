import { nextTick, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue'

// Reuse the existing canvas. WebView hosts without browser fullscreen still
// receive a viewport-sized preview through the caller's Teleport.
export function usePreviewFullscreen(target) {
  const active = ref(false)
  let nativeTarget = null, nativeEntered = false, previousFocus = null, previousOverflow = '', revision = 0
  function restore() {
    if (!active.value) return
    active.value = false
    document.body.style.overflow = previousOverflow
    const focus = previousFocus
    nextTick(() => { if (focus?.isConnected) focus.focus({ preventScroll:true }) })
  }
  function exit() {
    revision++
    const owned = nativeTarget
    nativeTarget = null; nativeEntered = false
    restore()
    if (owned && document.fullscreenElement === owned) void document.exitFullscreen?.().catch(() => {})
  }
  async function enter() {
    if (active.value || !target.value) return
    const version = ++revision
    previousFocus = document.activeElement
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    active.value = true
    await nextTick()
    if (!active.value || version !== revision || !target.value) return
    const element = target.value
    element.querySelector('[data-preview-fullscreen-toggle]')?.focus({ preventScroll:true })
    if (!element.requestFullscreen || document.fullscreenElement) return
    nativeTarget = element
    try {
      await element.requestFullscreen({ navigationUI:'hide' })
      if (version !== revision || !active.value) {
        if (document.fullscreenElement === element) await document.exitFullscreen()
        return
      }
      nativeEntered = document.fullscreenElement === element
    } catch {
      if (version === revision) { nativeTarget = null; nativeEntered = false }
      // The in-app preview is already open; do not show a misleading failure.
    }
  }
  function changed() {
    if (nativeTarget && document.fullscreenElement === nativeTarget) nativeEntered = true
    else if (nativeEntered) exit()
  }
  function keydown(event) {
    if (!active.value) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); exit()
    } else if (event.key === 'Tab') {
      const controls = [...(target.value?.querySelectorAll('button:not(:disabled),[href],input,select,[tabindex="0"]') || [])]
        .filter(element => element.getClientRects().length)
      const index = controls.indexOf(document.activeElement), step = event.shiftKey ? -1 : 1
      event.preventDefault()
      controls[(index + step + controls.length) % controls.length]?.focus()
    }
  }
  onMounted(() => { document.addEventListener('fullscreenchange', changed); window.addEventListener('keydown', keydown, true) })
  onBeforeUnmount(() => { exit(); document.removeEventListener('fullscreenchange', changed); window.removeEventListener('keydown', keydown, true) })
  onDeactivated(exit)
  return { active, enter, exit, toggle:() => active.value ? exit() : enter() }
}
