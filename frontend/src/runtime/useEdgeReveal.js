import { onScopeDispose, ref, watch } from 'vue'

// Keep the edge hotspot alive while the full control slides off screen.
// Pointer hover, keyboard focus and an open/busy panel must never time out.
export function useEdgeReveal({ element, keepOpen = () => false, delay = 1200 }) {
    const hidden = ref(true)
    let timer = null, hovering = false, disposed = false
    function clear() { if (timer !== null) clearTimeout(timer); timer = null }
    function reveal() { if (disposed) return; clear(); hidden.value = false }
    function arm() {
        clear()
        if (disposed || hidden.value || hovering || keepOpen()) return
        timer = setTimeout(() => {
            timer = null
            if (!disposed && !hovering && !keepOpen() && !element.value?.querySelector(':focus-visible,input:focus,select:focus,textarea:focus')) hidden.value = true
        }, delay)
    }
    function enter() { hovering = true; reveal() }
    function leave() { hovering = false; arm() }
    watch(keepOpen, active => { if (active) reveal(); else arm() }, { flush: 'sync', immediate: true })
    onScopeDispose(() => { disposed = true; clear() })
    return { hidden, reveal, enter, leave, arm }
}
