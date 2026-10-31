<script setup>
import { nextTick, onUnmounted, ref } from 'vue'

const props = defineProps({ busy: Boolean })
const emit = defineEmits(['change'])
const menu = ref(null), target = ref(null), position = ref({ left: 0, top: 0 })
const levels = [{ value: 'factory', label: '工厂级' }, { value: 'workshop', label: '车间级' }, { value: 'line', label: '产线级' }, { value: 'device', label: '设备级' }]
let trigger = null
function close() {
  target.value = null
  window.removeEventListener('pointerdown', outside, true)
  window.removeEventListener('keydown', keydown, true)
  window.removeEventListener('resize', close)
  window.removeEventListener('wheel', close, true)
  trigger?.focus?.({ preventScroll: true })
}
function outside(event) { if (!menu.value?.contains(event.target)) close() }
function keydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const items = [...(menu.value?.querySelectorAll('button:not(:disabled)') || [])]
  if (!items.length) return
  event.preventDefault(); event.stopPropagation()
  const index = items.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
  items[next]?.focus({ preventScroll: true })
}
async function open(model, point) {
  close(); trigger = document.activeElement
  target.value = { id: model.id, level: model.placement_level || 'device', environment: model.asset_type === 'environment' }
  position.value = { left: point.clientX, top: point.clientY }
  await nextTick()
  const box = menu.value?.getBoundingClientRect()
  if (!box) return
  position.value = { left: Math.max(8, Math.min(point.clientX, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(point.clientY, window.innerHeight - box.height - 8)) }
  await nextTick()
  menu.value?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true })
  window.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', keydown, true)
  window.addEventListener('resize', close)
  window.addEventListener('wheel', close, { capture: true, passive: true })
}
function choose(level) {
  if (!target.value || props.busy) return
  const current = target.value
  close()
  if (level !== current.level) emit('change', { id: current.id, level })
}
onUnmounted(close)
defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <div v-if="target" ref="menu" class="model-placement-menu" role="menu" aria-label="更改模型层级" :style="{ left: `${position.left}px`, top: `${position.top}px` }" @contextmenu.prevent>
      <div class="placement-menu-title">更改层级</div>
      <button v-for="level in levels" :key="level.value" type="button" role="menuitemradio" :aria-label="level.label" :aria-checked="target.level === level.value" :disabled="busy || target.environment && level.value !== 'factory'" @click="choose(level.value)"><span>{{ level.label }}</span><i v-if="target.level === level.value" aria-hidden="true">✓</i></button>
    </div>
  </Teleport>
</template>

<style scoped>
.model-placement-menu { position: fixed; z-index: 10010; width: 148px; padding: 5px; border: 1px solid #dce3ec; border-radius: 8px; background: #fff; box-shadow: 0 8px 24px #17203322; color: #344054; font: 12px 'Inter Variable', 'Noto Sans SC Variable', sans-serif; }
.placement-menu-title { padding: 5px 8px 7px; color: #8b96a6; font-size: 11px; }
.model-placement-menu button { display: flex; justify-content: space-between; width: 100%; padding: 6px 9px; border: 0; border-radius: 5px; background: transparent; color: inherit; font: inherit; text-align: left; }
.model-placement-menu button:hover:not(:disabled), .model-placement-menu button:focus-visible { outline: none; background: #edf4ff; color: #2457a6; }
.model-placement-menu button:disabled { color: #b2bac6; cursor: not-allowed; }
.model-placement-menu i { font-style: normal; color: #2563eb; }
</style>
