<script setup>
import { computed, ref, onMounted } from 'vue'
import { QUALITY_PROFILES } from '../runtime/nativeQuality.js'
const props = defineProps({ state: { type: Object, required: true } })
const emit = defineEmits(['select', 'query'])
const index = computed(() => QUALITY_PROFILES.findIndex(p => p.key === props.state.profile))
const preview = ref(null)
let pointer = null
function down(event) {
  if (event.button !== 0 || !props.state.enabled || props.state.pending) return
  pointer = { id: event.pointerId, x: event.clientX }
}
function move(event) {
  if (!pointer || pointer.id !== event.pointerId || Math.abs(event.clientX - pointer.x) < 10) return
  if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId)
  const box = event.currentTarget.getBoundingClientRect()
  preview.value = Math.min(2, Math.max(0, Math.floor((event.clientX - box.left) / (box.width / 3))))
}
function up(event) {
  if (!pointer || pointer.id !== event.pointerId) return
  const target = preview.value
  pointer = null
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  preview.value = null
  if (target !== null) emit('select', QUALITY_PROFILES[target].key)
}
function select(key) { if (!props.state.pending) emit('select', key) }
function cancel() { pointer = null; preview.value = null }
function keyboard(event, i) {
  const next = { ArrowRight: (i + 1) % 3, ArrowLeft: (i + 2) % 3, Home: 0, End: 2 }[event.key]
  if (next === undefined) return
  event.preventDefault(); emit('select', QUALITY_PROFILES[next].key)
  event.currentTarget.parentElement.querySelectorAll('button')[next]?.focus()
}
onMounted(() => emit('query'))
</script>

<template>
  <section class="quality-control" aria-label="画质切换">
    <header><span>画质</span><small>{{ state.pending ? '切换中…' : !state.enabled ? '等待 Unity' : state.automatic ? '自动识别' : '本次运行' }}</small></header>
    <div class="quality-capsule" role="radiogroup" aria-label="画质档位" :aria-busy="!!state.pending"
      :style="{ '--quality-index': preview ?? Math.max(0, index) }"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="cancel" @lostpointercapture="cancel">
      <i v-if="index >= 0 || preview !== null" class="quality-capsule-thumb" aria-hidden="true"></i>
      <button v-for="(profile, i) in QUALITY_PROFILES" :key="profile.key" type="button" role="radio"
        :aria-checked="state.profile === profile.key" :tabindex="i === Math.max(0, index) ? 0 : -1"
        :disabled="!state.enabled || !!state.pending" @click="select(profile.key)" @keydown="keyboard($event, i)">
        <span>{{ profile.label }}</span><small>{{ profile.shortcut }}</small>
      </button>
    </div>
  </section>
</template>

<style scoped>
.quality-control{margin:12px 0 14px}.quality-control>header{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;color:#e2e6ec;font-size:11px}.quality-control>header small{color:#96a1b0;font-size:10px}.quality-capsule{position:relative;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));padding:3px;border:1px solid #ffffff24;border-radius:999px;background:#ffffff08;touch-action:pan-y;user-select:none}.quality-capsule-thumb{position:absolute;left:3px;top:3px;bottom:3px;width:calc((100% - 6px)/3);border-radius:999px;background:#ffffff23;box-shadow:0 1px 5px #0002;transform:translateX(calc(var(--quality-index)*100%));transition:transform .18s ease;pointer-events:none}.quality-capsule button{position:relative;z-index:1;display:grid;gap:1px;place-items:center;padding:6px 4px;border:0;border-radius:999px;background:transparent;color:#aeb6c2;font:inherit;font-size:11px;cursor:pointer}.quality-capsule button[aria-checked=true]{color:#fff}.quality-capsule button small{font-size:9px;opacity:.6}.quality-capsule button:disabled{cursor:wait;opacity:.55}.quality-capsule button:focus-visible{outline:2px solid #a8c8ee;outline-offset:-2px}@media(prefers-reduced-motion:reduce){.quality-capsule-thumb{transition:none}}
</style>
