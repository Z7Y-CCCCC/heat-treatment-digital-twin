import { onMounted,onBeforeUnmount,onActivated,onDeactivated,reactive,ref } from 'vue'

// One controller per surface is shared by renderers and external readers. Only
// this virtual selection clock is paused; the real clock still refreshes data.
export const WidgetPlaybackKey = Symbol('widget-playback')
export function createWidgetPlaybackController({ now = () => Date.now() } = {}) {
  const states = reactive(new Map())
  const keyFor = widget => String((widget && typeof widget === 'object' ? widget.id : widget) ?? '')
  const realTime = value => {
    const number = Number(value ?? now())
    return Number.isFinite(number) ? Math.max(0, number) : Math.max(0, Number(now()) || 0)
  }
  function timeFor(widget, value) {
    const time = realTime(value), state = states.get(keyFor(widget))
    return Math.max(0, (state?.paused ? state.pausedAt : time) - (state?.offset || 0))
  }
  function setHovered(widget, hovered, value) {
    const key = keyFor(widget)
    if (!key) return
    const state = states.get(key), time = realTime(value)
    if (hovered) {
      if (state?.paused) return
      states.set(key, { offset: state?.offset || 0, paused: true, pausedAt: time })
    } else if (state?.paused) {
      // Resume from the remaining dwell period, not the global clock's current
      // device. This also prevents a quick switch immediately after mouseleave.
      states.set(key, { offset: state.offset + Math.max(0, time - state.pausedAt), paused: false, pausedAt: 0 })
    }
  }
  return { timeFor, setHovered, remove(widget) { states.delete(keyFor(widget)) }, reset() { states.clear() } }
}
export function useWidgetClock() {
  const now=ref(Date.now());let timer=0
  const stop=()=>{clearInterval(timer);timer=0}
  const start=()=>{stop();now.value=Date.now();timer=setInterval(()=>{now.value=Date.now()},100)}
  onMounted(start);onActivated(start);onDeactivated(stop);onBeforeUnmount(stop)
  return now
}
