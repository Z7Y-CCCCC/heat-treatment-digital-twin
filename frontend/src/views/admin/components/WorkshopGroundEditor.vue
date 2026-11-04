<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { normalizeGround, MAX_GROUND_AREAS } from '../../../../../shared/industrialGround.mjs'
import { adminApi } from '../../../config/factoryConfig.js'
const props = defineProps({ workshop: Object, readonly: Boolean, confirmLeave: Function })
const emit = defineEmits(['preview', 'saved'])
const records = ref({}), selected = ref(''), busy = ref(false), message = ref('')
const record = computed(() => records.value[props.workshop?.id])
const draft = computed(() => record.value?.draft)
const area = computed(() => draft.value?.areas.find(a => a.id === selected.value))
const size = computed(() => (props.workshop?.layout || JSON.parse(props.workshop?.layout_json || '{}')).size || { width: 100, depth: 80 })
const grip = computed(() => Math.max(size.value.width, size.value.depth) / 40)
let drag = null
function point(event) { const svg = event.currentTarget.ownerSVGElement || event.currentTarget; return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse()) }
function startDrag(event, a, resize = false) {
  if (props.readonly || busy.value || event.button !== 0) return
  event.preventDefault(); event.stopPropagation(); selected.value = a.id
  const p = point(event); drag = { id: a.id, px: p.x, pz: p.y, x: a.x, z: a.z, width: a.width, depth: a.depth, resize }
  event.currentTarget.setPointerCapture(event.pointerId)
}
function move(event) {
  if (!drag || props.readonly || busy.value) return
  const a = draft.value.areas.find(a => a.id === drag.id); if (!a) return
  const p = point(event), dx = p.x - drag.px, dz = p.y - drag.pz, round = n => Math.round(n * 10) / 10
  if (drag.resize) { a.width = Math.max(.2, Math.min(5000, round(drag.width + 2 * dx))); a.depth = Math.max(.2, Math.min(5000, round(drag.depth + 2 * dz))) }
  else { a.x = Math.max(-size.value.width / 2, Math.min(size.value.width / 2, round(drag.x + dx))); a.z = Math.max(-size.value.depth / 2, Math.min(size.value.depth / 2, round(drag.z + dz))) }
}
function keyMove(event, a) {
  const moves = { ArrowLeft: [-.5, 0], ArrowRight: [.5, 0], ArrowUp: [0, -.5], ArrowDown: [0, .5] }
  if (!moves[event.key] || props.readonly || busy.value) return
  event.preventDefault(); selected.value = a.id; a.x += moves[event.key][0]; a.z += moves[event.key][1]
}
const dirty = computed(() => Object.values(records.value).some(r => JSON.stringify(r.draft) !== r.saved))
watch(() => props.workshop, ws => {
  if (!ws) return
  if (!records.value[ws.id]) { const layout = ws.layout || JSON.parse(ws.layout_json || '{}'), ground = normalizeGround(layout.ground); records.value[ws.id] = { draft: ground, saved: JSON.stringify(ground), revision: ws.groundRevision, name: ws.name, hasGround: layout.ground !== undefined } }
  selected.value = record.value.draft.areas[0]?.id || ''; message.value = ''
}, { immediate: true })
watch(records, () => { for (const [id, r] of Object.entries(records.value)) emit('preview', { id, ground: r.hasGround || JSON.stringify(r.draft) !== r.saved ? normalizeGround(r.draft) : null }) }, { deep: true })
function add(elevation) {
  if (props.readonly || !draft.value || draft.value.areas.length >= MAX_GROUND_AREAS) return
  const id = `ground_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
  draft.value.areas.push({ id, name: elevation < draft.value.elevation ? '基坑' : '高台', x: 0, z: 0, width: 8, depth: 8, elevation }); selected.value = id
}
async function savePending() {
  if (busy.value) throw new Error('地面正在保存，请稍候')
  busy.value = true; message.value = ''
  try {
    for (const [id, r] of Object.entries(records.value)) {
      if (JSON.stringify(r.draft) === r.saved) continue
      const result = await adminApi.updateWorkshopGround(id, { ground: r.draft, expectedRevision: r.revision })
      if (!result.success) throw new Error(result.error || '地面未保存')
      r.hasGround = true; r.draft = result.ground; r.revision = result.revision; r.saved = JSON.stringify(result.ground)
      emit('saved', { id, ground: result.ground, revision: result.revision })
    }
    message.value = '地面已保存'
  } catch (error) { message.value = error.message; throw error }
  finally { busy.value = false }
}
function discardPending() { for (const r of Object.values(records.value)) r.draft = JSON.parse(r.saved) }
async function canLeave() {
  if (busy.value) return false
  if (!dirty.value) return true
  const choice = await props.confirmLeave?.()
  if (choice === 'secondary') { discardPending(); return true }
  if (choice !== true) return false
  try { await savePending(); return true } catch { return false }
}
function beforeUnload(event) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }
onMounted(() => window.addEventListener('beforeunload', beforeUnload))
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload))
defineExpose({ savePending, discardPending, canLeave, dirty })
</script>
<template>
  <section v-if="workshop && draft" class="ground-editor" aria-label="车间地面编辑">
    <header><strong>地面 · {{ workshop.name }}</strong><small v-if="dirty">未保存</small></header>
    <fieldset :disabled="readonly || busy">
      <label>地面标高（米）<input v-model.number="draft.elevation" type="number" min="-100" max="100" step="0.1" /></label>
      <div class="ground-actions"><button type="button" :disabled="draft.areas.length >= MAX_GROUND_AREAS" @click="add(draft.elevation - 2)">＋ 基坑</button><button type="button" :disabled="draft.areas.length >= MAX_GROUND_AREAS" @click="add(draft.elevation + 1)">＋ 高台</button></div>
      <svg class="ground-map" :viewBox="`${-size.width / 2} ${-size.depth / 2} ${size.width} ${size.depth}`" aria-label="地面区域平面图" role="img" @pointermove="move" @pointerup="drag = null" @pointercancel="drag = null">
        <rect :x="-size.width / 2" :y="-size.depth / 2" :width="size.width" :height="size.depth" fill="#e7edf0" stroke="#9baab5" :stroke-width="grip / 5" />
        <g v-for="a in draft.areas" :key="a.id" role="button" tabindex="0" :aria-label="`移动区域 ${a.name}`" @focus="selected = a.id" @keydown="keyMove($event, a)">
          <rect :x="a.x - a.width / 2" :y="a.z - a.depth / 2" :width="a.width" :height="a.depth" :fill="a.elevation < draft.elevation ? '#64748b' : '#cba96d'" :stroke="a.id === selected ? '#1677ff' : '#475569'" :stroke-width="grip / 4" @pointerdown="startDrag($event, a)" />
          <rect v-if="a.id === selected" :x="a.x + a.width / 2 - grip" :y="a.z + a.depth / 2 - grip" :width="grip * 2" :height="grip * 2" fill="#1677ff" @pointerdown="startDrag($event, a, true)" />
        </g>
      </svg>
      <label v-if="draft.areas.length">地面区域<select v-model="selected"><option v-for="a in draft.areas" :key="a.id" :value="a.id">{{ a.name }} · {{ a.elevation }}m</option></select></label>
      <div v-if="area" class="ground-fields">
        <label class="wide">名称<input v-model.trim="area.name" maxlength="60" /></label>
        <label>X<input v-model.number="area.x" type="number" step="0.1" /></label><label>Z<input v-model.number="area.z" type="number" step="0.1" /></label>
        <label>宽（米）<input v-model.number="area.width" type="number" min="0.2" max="5000" step="0.1" /></label><label>长（米）<input v-model.number="area.depth" type="number" min="0.2" max="5000" step="0.1" /></label>
        <label class="wide">区域标高（米）<input v-model.number="area.elevation" type="number" min="-100" max="100" step="0.1" /></label>
        <button type="button" class="wide" @click="draft.areas = draft.areas.filter(a => a.id !== selected); selected = draft.areas[0]?.id || ''">删除区域</button>
      </div>
      <button type="button" class="ground-save" :disabled="!dirty" @click="savePending().catch(() => {})">{{ busy ? '保存中…' : '保存地面' }}</button>
    </fieldset>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
<style scoped>
.ground-map{width:100%;height:160px;display:block;border-radius:7px;touch-action:none}.ground-map g{cursor:move}.ground-map g:focus{outline:none}.ground-map g:focus rect{stroke:#1677ff}
.ground-editor{padding:18px;border-bottom:1px solid #e5e7eb;font-size:calc(12px * var(--admin-font-scale, 1))}.ground-editor header{display:flex;justify-content:space-between;margin-bottom:12px}.ground-editor small{color:#b76e00}.ground-editor fieldset{border:0;padding:0;margin:0;display:grid;gap:10px;min-width:0}.ground-editor label{display:grid;gap:5px;color:#667085;min-width:0}.ground-editor input,.ground-editor select,.ground-editor button{box-sizing:border-box;width:100%;min-height:32px;border:1px solid #d0d5dd;border-radius:7px;padding:5px 8px;font:inherit;background:#fff;color:#344054}.ground-actions,.ground-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px}.wide{grid-column:1/-1}.ground-editor button{cursor:pointer}.ground-editor button:disabled{opacity:.5;cursor:default}.ground-editor .ground-save{background:#1677ff;color:white;border-color:#1677ff}.ground-editor p{margin:8px 0 0;overflow-wrap:anywhere}
</style>
