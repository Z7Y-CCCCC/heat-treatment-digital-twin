<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
const props = defineProps({ modelValue: { type: String, default: '' }, options: { type: Array, default: () => [] }, disabled: Boolean })
const emit = defineEmits(['update:modelValue', 'change'])
const trigger = ref(null), panel = ref(null), open = ref(false), query = ref(''), style = ref({})
const selected = computed(() => props.options.find(item => item.value === props.modelValue))
const filtered = computed(() => props.options.filter(item => item.label.toLowerCase().includes(query.value.trim().toLowerCase())))
const listId = `point-device-${Math.random().toString(36).slice(2)}`
function close(restore = false) { open.value = false; if (restore) trigger.value?.focus({ preventScroll: true }) }
function position() {
  if (!open.value || !trigger.value) return
  const box = trigger.value.getBoundingClientRect()
  if (box.bottom < 0 || box.top >= innerHeight) { close(); return }
  const width = Math.min(Math.max(420, box.width), innerWidth - 16)
  const below = innerHeight - box.bottom - 16, above = box.top - 16
  const up = below < 220 && above > below, height = Math.min(360, Math.max(80, up ? above : below), innerHeight - 16)
  style.value = { width: `${width}px`, left: `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`, maxHeight: `${height}px`,
    ...(up ? { bottom: `${Math.max(8, innerHeight - box.top + 6)}px` } : { top: `${Math.max(8, box.bottom + 6)}px` }) }
}
async function show() {
  if (props.disabled) return
  if (open.value) { close(); return }
  query.value = ''; open.value = true; position(); await nextTick(); panel.value?.querySelector('input')?.focus({ preventScroll: true })
}
function choose(value) { if (props.disabled) return; emit('update:modelValue', value); emit('change', value); close(true) }
function outside(event) { if (!panel.value?.contains(event.target) && !trigger.value?.contains(event.target)) close() }
function key(event) {
  if (event.isComposing) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  if (event.key === 'Tab') { event.preventDefault(); close(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const rows = [...(panel.value?.querySelectorAll('[role=option]') || [])]; if (!rows.length) return
  event.preventDefault()
  const current = rows.indexOf(document.activeElement), backwards = event.key === 'ArrowUp'
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : current < 0 ? (backwards ? rows.length - 1 : 0) : (current + (backwards ? -1 : 1) + rows.length) % rows.length
  rows[index]?.focus({ preventScroll: true }); rows[index]?.scrollIntoView({ block: 'nearest' })
}
watch(() => props.disabled, disabled => { if (disabled) close() })
onMounted(() => { window.addEventListener('pointerdown', outside, true); window.addEventListener('resize', position); window.addEventListener('scroll', position, true) })
onUnmounted(() => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) })
</script>
<template>
  <div class="point-device-picker">
    <button ref="trigger" type="button" class="point-device-trigger input input-sm" aria-label="选择点位所属设备" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="listId" :title="selected?.label || '选择设备'" :disabled="disabled" @click="show" @keydown.down.prevent="show"><span>{{ selected?.label || '选择设备' }}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
    <Teleport to="body"><section v-if="open" ref="panel" class="point-device-popup" :style="style" aria-label="点位设备选项" @keydown="key">
      <input v-model="query" class="point-device-search" aria-label="搜索点位设备" placeholder="搜索设备、产线或车间…" />
      <div :id="listId" role="listbox" aria-label="点位所属设备"><button v-for="item in filtered" :key="item.value" type="button" role="option" :aria-selected="item.value === modelValue" @click="choose(item.value)"><span>{{ item.label }}</span><i v-if="item.value === modelValue" aria-hidden="true">✓</i></button><p v-if="!filtered.length">没有匹配的设备</p></div>
    </section></Teleport>
  </div>
</template>
<style scoped>
.point-device-picker{min-width:0;width:100%}.point-device-trigger{box-sizing:border-box;width:100%;min-width:0;display:flex;align-items:center;gap:5px;cursor:pointer;color:inherit;text-align:left;font:inherit}.point-device-trigger>span{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.point-device-trigger svg{flex-shrink:0;width:13px;height:13px;stroke:currentColor;stroke-width:1.6;fill:none}.point-device-trigger:disabled{opacity:.55;cursor:not-allowed}
.point-device-popup{box-sizing:border-box;position:fixed;z-index:1800;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid #d6dfeb;border-radius:10px;background:#fff;box-shadow:0 10px 32px #17203326;color:#344054;font:calc(13px * var(--admin-font-scale,1)) 'Inter Variable','Noto Sans SC Variable',sans-serif;overflow:hidden}.point-device-search{box-sizing:border-box;width:100%;min-width:0;flex-shrink:0;min-height:34px;padding:7px 10px;border:1px solid #d6dfeb;border-radius:6px;color:inherit;background:#f9fbfe;font:inherit}.point-device-popup [role=listbox]{overflow:auto;overscroll-behavior:contain;min-height:0}.point-device-popup [role=option]{box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.point-device-popup [role=option]>span{flex:1;min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.6}.point-device-popup [role=option]:hover,.point-device-popup [aria-selected=true]{background:#edf4ff;color:#2457a6}.point-device-popup i{font-style:normal}.point-device-popup p{padding:10px;color:#8995a6}.point-device-popup :focus-visible,.point-device-trigger:focus-visible{outline:2px solid #4389e9;outline-offset:-2px}
</style>
<style scoped>
.point-device-picker{min-width:190px;max-width:260px}.point-device-trigger{min-height:32px;padding:6px 8px;border:1px solid #d2d5df;border-radius:6px;background:#fbfbfd}
</style>
