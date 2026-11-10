<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { lineSceneUnitsPerMeter } from '../../../../../shared/lineRailSpacing.mjs'

const props = defineProps({
  lines: { type: Array, default: () => [] }, workshops: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' }, layout: { type: Object, required: true },
  draft: { type: Object, required: true }, busy: Boolean, creating: Boolean,
  layoutDirty: Boolean, layoutSaving: Boolean,
  savedSnapshot: { type: String, default: '' },
  deviceCount: { type: Number, default: 0 }, totalDevices: { type: Number, default: 0 }
})
const emit = defineEmits(['select', 'delete', 'create', 'edit', 'add-item', 'remove-item', 'change-item', 'change-rail-spacing', 'save-layout', 'focus-item'])
const popup = ref(''), popupElement = ref(null), popupStyle = ref({}), modal = ref(''), modalElement = ref(null)
const lineTrigger = ref(null), laneTrigger = ref(null), railTrigger = ref(null), createTrigger = ref(null)
const lineQuery = ref(''), editDraft = ref({})
const canEdit = computed(() => canAdminPage('lines', 'edit'))
const canDelete = computed(() => canAdminPage('lines', 'delete'))
const selected = computed(() => props.lines.find(line => line.id === props.selectedId))
const label = line => `${props.workshops.find(ws => ws.id === line?.workshop_id)?.name || ''} / ${line?.name || ''}`
const filteredLines = computed(() => props.lines.filter(line => `${label(line)} ${line.id}`.toLowerCase().includes(lineQuery.value.trim().toLowerCase())))
const items = computed(() => popup.value === 'rail' ? props.layout.rails : props.layout.lanes)
const itemLabel = computed(() => popup.value === 'rail' ? '小车导轨' : '设备线')
const layoutUnits = computed(() => lineSceneUnitsPerMeter(props.layout))
const savedItemIds = computed(() => {
  try {
    const layout = JSON.parse(props.savedSnapshot)
    return new Set((popup.value === 'rail' ? layout.rails : layout.lanes)?.map(item => item.id) || [])
  } catch { return null }
})
const isNewItem = id => savedItemIds.value !== null && !savedItemIds.value.has(id)
let anchor = null, modalReturnFocus = null, resizeObserver

function closePopup(restore = false) {
  popup.value = ''
  if (restore) anchor?.focus?.({ preventScroll: true })
}
function positionPopup() {
  if (!popup.value || !anchor || !popupElement.value) return
  const box = anchor.getBoundingClientRect(), width = popupElement.value.getBoundingClientRect().width
  if (box.bottom < 0 || box.top > window.innerHeight) { closePopup(); return }
  const top = Math.min(box.bottom + 8, Math.max(8, window.innerHeight - 160))
  popupStyle.value = {
    left: `${Math.max(8, Math.min(box.left, window.innerWidth - width - 8))}px`, top: `${top}px`,
    maxHeight: `${Math.max(140, Math.min(440, window.innerHeight - top - 12))}px`
  }
}
async function togglePopup(kind, event) {
  if (popup.value === kind) { closePopup(true); return }
  anchor = event.currentTarget; popup.value = kind; lineQuery.value = ''
  await nextTick(); positionPopup()
  popupElement.value?.querySelector(kind === 'lines' ? 'input' : 'button:not(:disabled)')?.focus({ preventScroll: true })
}
function outside(event) {
  if (!popup.value || popupElement.value?.contains(event.target) || anchor?.contains(event.target)) return
  // Commit a focused number/name field before removing its floating editor.
  if (popupElement.value?.contains(document.activeElement)) document.activeElement.blur()
  closePopup()
}
function popupKey(event) {
  if (event.key === 'Escape' && popup.value) { event.preventDefault(); event.stopPropagation(); closePopup(true) }
  if (popup.value !== 'lines' || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
  const options = [...(popupElement.value?.querySelectorAll('.line-option-select') || [])]
  if (!options.length) return
  event.preventDefault(); event.stopPropagation()
  const index = options.indexOf(document.activeElement)
  const backwards = event.key === 'ArrowUp'
  const next = index < 0 ? (backwards ? options.length - 1 : 0) : (index + (backwards ? -1 : 1) + options.length) % options.length
  options[next]?.focus({ preventScroll: true })
}
function chooseLine(id) { closePopup(); emit('select', id); lineTrigger.value?.focus({ preventScroll: true }) }
function deleteLine(id) { if (props.busy || !canDelete.value) return; closePopup(); emit('delete', id) }
function selectItem(id) { const type = popup.value; closePopup(); emit('focus-item', { type, id }) }
function selectItemWithKeyboard(id, event) {
  if (event.target !== event.currentTarget || !['Enter', ' '].includes(event.key)) return
  event.preventDefault(); event.stopPropagation(); selectItem(id)
}
function addItem() { if (!props.busy && canEdit.value) emit('add-item', popup.value) }
function removeItem(id) { if (!props.busy && canEdit.value) emit('remove-item', popup.value, id) }
async function restoreItemField(id, field, event, type = popup.value) {
  await nextTick()
  const item = (type === 'rail' ? props.layout.rails : props.layout.lanes).find(item => item.id === id)
  if (item) event.target.value = item[field]
}
async function changeItem(id, field, event) {
  if (field !== 'name' && event.target.value === '') return
  if (!props.busy && canEdit.value) emit('change-item', { type: popup.value, id, field, value: event.target.value })
  await restoreItemField(id, field, event)
}
async function changeSpacing(id, field, event) {
  const item = props.layout.rails.find(item => item.id === id)
  if (!props.busy && !props.creating && canEdit.value && selected.value && (field === 'laneId' || item?.spacing)) {
    emit('change-rail-spacing', { railId: id, field, value: event.target.value })
  }
  await nextTick()
  const current = props.layout.rails.find(item => item.id === id)
  if (current) event.target.value = current.spacing?.[field] ?? ''
}
async function changeLayoutUnits(event) {
  if (!props.busy && !props.creating && canEdit.value && selected.value) emit('change-rail-spacing', { railId: '', field: 'sceneUnitsPerMeter', value: event.target.value })
  await nextTick()
  event.target.value = layoutUnits.value
}
function saveLayout() {
  if (canEdit.value && !props.busy && !props.creating && !props.layoutSaving && props.layoutDirty && selected.value) emit('save-layout')
}
async function openModal(kind, line) {
  if (!canEdit.value || props.busy) return
  modalReturnFocus = kind === 'create' ? createTrigger.value : lineTrigger.value
  closePopup(); editDraft.value = line ? { id: line.id, name: line.name, workshop_id: line.workshop_id, sort_order: line.sort_order } : {}
  modal.value = kind
  await nextTick(); modalElement.value?.querySelector('input')?.focus()
}
function closeModal() {
  if (props.creating) return
  modal.value = ''; modalReturnFocus?.focus?.({ preventScroll: true })
}
function modalKey(event) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeModal(); return }
  if (event.key !== 'Tab') return
  const controls = [...modalElement.value.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
  const first = controls[0], last = controls.at(-1)
  if (!first) { event.preventDefault(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function applyEdit() {
  if (!canEdit.value || props.busy || !editDraft.value.name?.trim() || !editDraft.value.workshop_id) return
  emit('edit', { ...editDraft.value, name: editDraft.value.name.trim() }); closeModal()
}
watch(() => props.selectedId, () => closePopup())
watch(() => props.creating, busy => { if (!busy && !modal.value) nextTick(() => modalReturnFocus?.focus?.({ preventScroll: true })) })
onMounted(() => {
  window.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', popupKey, true)
  window.addEventListener('resize', positionPopup)
  window.addEventListener('scroll', positionPopup, true)
  resizeObserver = new ResizeObserver(positionPopup)
  for (const el of [lineTrigger.value, laneTrigger.value, railTrigger.value]) if (el) resizeObserver.observe(el)
})
onUnmounted(() => {
  window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', popupKey, true)
  window.removeEventListener('resize', positionPopup); window.removeEventListener('scroll', positionPopup, true)
  resizeObserver?.disconnect()
})
defineExpose({ closeCreation: () => { modal.value = ''; modalReturnFocus?.focus?.({ preventScroll: true }) } })
</script>

<template>
  <section class="line-config-toolbar" aria-label="产线配置工具栏">
    <span class="line-picker-label">产线</span>
    <button ref="lineTrigger" type="button" class="line-picker-trigger" aria-label="选择编辑产线" aria-haspopup="dialog" :aria-expanded="popup === 'lines'" :disabled="creating" @click="togglePopup('lines', $event)"><span>{{ selected ? label(selected) : '暂无产线' }}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg></button>
    <button ref="createTrigger" type="button" class="btn btn-primary btn-sm" :disabled="!canEdit || busy || creating" @click="openModal('create')">+ 新增产线</button>
    <div class="line-preview-metrics">
      <button ref="laneTrigger" type="button" class="structure-pill" aria-label="管理设备线" aria-haspopup="dialog" :aria-expanded="popup === 'lane'" :disabled="!selected || creating" @click="togglePopup('lane', $event)">{{ layout.lanes.length }} 条设备线<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button>
      <button ref="railTrigger" type="button" class="structure-pill rail-pill" aria-label="管理小车导轨" aria-haspopup="dialog" :aria-expanded="popup === 'rail'" :disabled="!selected || creating" @click="togglePopup('rail', $event)">{{ layout.rails.length }} 条导轨<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg></button>
      <span class="device-count">{{ deviceCount }}/{{ totalDevices }} 台设备</span>
    </div>
    <div v-if="selected" class="line-rail-spacing-config" role="group" aria-label="设备线与小车轨道间距设置">
      <div v-for="rail in layout.rails" :key="rail.id" class="rail-spacing-row" :data-rail-spacing-id="rail.id">
        <strong class="rail-spacing-name">{{ rail.name || rail.id }}</strong>
        <label class="structure-field"><span>关联设备线</span><select :value="rail.spacing?.laneId || ''" :aria-label="`${rail.name} 关联设备线`" class="input" :disabled="!canEdit || busy || creating" @change="changeSpacing(rail.id, 'laneId', $event)"><option value="">选择设备线（不关联则自由偏移）</option><option v-for="lane in layout.lanes" :key="lane.id" :value="lane.id">{{ lane.name || lane.id }}</option></select></label>
        <label class="structure-field"><span>设备线—轨道中心距（米）</span><input :value="rail.spacing?.distanceMeters ?? ''" :aria-label="`${rail.name} 设备线与轨道中心距（米）`" class="input" type="number" min="0" max="10000" step="any" :placeholder="rail.spacing ? '' : '先选择设备线'" :disabled="!canEdit || busy || creating || !rail.spacing" @change="changeSpacing(rail.id, 'distanceMeters', $event)" /></label>
        <label class="structure-field"><span>设备线哪一侧</span><select :value="rail.spacing?.side || ''" :aria-label="`${rail.name} 相对设备线方向`" class="input" :disabled="!canEdit || busy || creating || !rail.spacing" @change="changeSpacing(rail.id, 'side', $event)"><option value="" disabled>先选择设备线</option><option value="positive">+Z 侧</option><option value="negative">−Z 侧</option></select></label>
      </div>
      <div class="line-spacing-actions">
        <label class="structure-field layout-units"><span>产线场景单位 / 米</span><input :value="layoutUnits" aria-label="产线场景单位每米" class="input" type="number" min="0" max="100000" step="any" :disabled="!canEdit || busy || creating" @change="changeLayoutUnits($event)" /></label>
        <span class="line-spacing-save-state" role="status">{{ layoutSaving ? '保存中…' : layoutDirty ? '有未保存修改' : '已保存' }}</span>
        <button type="button" class="btn btn-primary btn-sm" aria-label="保存设备线与轨道设置" :disabled="!canEdit || busy || creating || layoutSaving || !layoutDirty" @click="saveLayout">{{ layoutSaving ? '保存中…' : '保存产线结构' }}</button>
      </div>
    </div>
    <Teleport to="body">
      <section v-if="popup" ref="popupElement" class="line-control-popup" :class="{ 'line-list-popup': popup === 'lines' }" :style="popupStyle" role="dialog" :aria-label="popup === 'lines' ? '产线选择' : `${itemLabel}管理`">
        <template v-if="popup === 'lines'">
          <input v-model="lineQuery" class="input line-search" aria-label="搜索产线" placeholder="搜索产线…" />
          <div v-for="line in filteredLines" :key="line.id" class="line-option" :class="{ active: selectedId === line.id }" :data-line-option-id="line.id">
            <button class="line-option-select" type="button" :aria-pressed="selectedId === line.id" @click="chooseLine(line.id)"><span :title="label(line)">{{ label(line) }}</span><i v-if="selectedId === line.id" aria-hidden="true">✓</i></button>
            <button type="button" class="line-icon-button" :aria-label="`编辑产线 ${line.name}`" title="编辑产线资料" :disabled="!canEdit || busy" @click="openModal('edit', line)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5 5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/></svg></button>
            <button type="button" class="line-icon-button danger" :aria-label="`删除产线 ${line.name}`" title="删除产线" :disabled="!canDelete || busy" @click="deleteLine(line.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg></button>
          </div>
          <p v-if="!filteredLines.length" class="line-empty">{{ lines.length ? '没有匹配的产线' : '暂无产线' }}</p>
        </template>
        <template v-else>
          <header><strong>{{ itemLabel }}</strong><button class="btn btn-sm" type="button" :disabled="!canEdit || busy" @click="addItem">+ {{ itemLabel }}</button></header>
          <div v-for="item in items" :key="item.id" class="structure-row" :class="{ 'is-new': isNewItem(item.id) }" :data-structure-id="item.id" role="group" :aria-label="item.name" tabindex="0" @click="selectItem(item.id)" @keydown="selectItemWithKeyboard(item.id, $event)">
            <span v-if="isNewItem(item.id)" class="new-item-corner"><span>新增</span></span>
            <div class="structure-field structure-name"><span>名称</span><input :value="item.name" :aria-label="`${item.name} 名称`" class="input" :disabled="!canEdit || busy" @click.stop @input="changeItem(item.id, 'name', $event)" /></div>
            <div class="structure-field"><span>偏移Z（场景坐标）</span><input :value="item.offsetZ" :aria-label="`${item.name} 偏移Z`" type="number" step="0.5" class="input" :disabled="!canEdit || busy || !!item.spacing" @click.stop @input="changeItem(item.id, 'offsetZ', $event)" @change="restoreItemField(item.id, 'offsetZ', $event)" /></div>
            <div class="structure-field"><span>长度（场景坐标）</span><input :value="item.length" :aria-label="`${item.name} 长度`" type="number" min="1" step="0.5" class="input" :disabled="!canEdit || busy" @click.stop @input="changeItem(item.id, 'length', $event)" @change="restoreItemField(item.id, 'length', $event)" /></div>
            <div class="structure-row-actions"><button type="button" class="line-icon-button danger" :aria-label="`删除 ${item.name}`" title="删除" :disabled="!canEdit || busy" @click.stop="removeItem(item.id)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg></button></div>
          </div>
          <p v-if="!items.length" class="line-empty">暂无{{ itemLabel }}</p>
        </template>
      </section>
      <div v-if="modal" class="line-modal-backdrop" @keydown="modalKey">
        <section ref="modalElement" class="line-create-dialog" role="dialog" aria-modal="true" :aria-label="modal === 'create' ? '新增产线' : '编辑产线资料'">
          <header><h3>{{ modal === 'create' ? '新增产线' : '编辑产线资料' }}</h3><button type="button" class="line-dialog-close" aria-label="关闭产线弹窗" :disabled="creating" @click="closeModal">×</button></header>
          <form v-if="modal === 'create'" class="line-create-row" @submit.prevent="canEdit && !creating && emit('create')">
            <label>产线 ID<input v-model="draft.id" placeholder="产线ID，如 line_e" class="input" :disabled="creating" required /></label>
            <label>产线名称<input v-model="draft.name" placeholder="产线名称，如 E 产线" class="input" :disabled="creating" required /></label>
            <label>所属车间<select v-model="draft.workshop_id" class="input" :disabled="creating" required><option value="" disabled>选择所属车间</option><option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option></select></label>
            <footer><button type="button" class="btn" :disabled="creating" @click="closeModal">取消</button><button type="submit" class="btn btn-primary" :disabled="creating || !canEdit">{{ creating ? '添加中…' : '+ 添加产线' }}</button></footer>
          </form>
          <form v-else class="line-create-row" @submit.prevent="applyEdit">
            <label>产线名称<input v-model="editDraft.name" class="input" required /></label>
            <label>所属车间<select v-model="editDraft.workshop_id" class="input" required><option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option></select></label>
            <label>排序<input v-model.number="editDraft.sort_order" type="number" class="input" /></label>
            <footer><button type="button" class="btn" @click="closeModal">取消</button><button type="submit" class="btn btn-primary" :disabled="!canEdit || busy">应用</button></footer>
          </form>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
.line-config-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:10px 16px; color:#52687d; font-size:calc(13px * var(--admin-font-scale,1)); }
.line-picker-trigger { display:flex; align-items:center; gap:12px; width:clamp(220px,24vw,380px); min-height:36px; padding:7px 10px; border:1px solid #ccd5e2; border-radius:8px; background:#fff; color:#344054; font:inherit; text-align:left; cursor:pointer; }
.line-picker-trigger span { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
svg { flex-shrink:0; width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.line-preview-metrics { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-left:auto; font-size:calc(12px * var(--admin-font-scale,1)); }
.line-rail-spacing-config { flex:1 0 100%; display:grid; gap:8px; min-width:0; padding-top:10px; border-top:1px solid #e8edf4; }
.rail-spacing-row { display:grid; grid-template-columns:minmax(100px,.7fr) minmax(150px,1fr) minmax(180px,1fr) minmax(110px,.65fr); align-items:end; gap:10px; }
.rail-spacing-name { align-self:center; overflow:hidden; text-overflow:ellipsis; color:#52687d; }
.rail-spacing-row .input { box-sizing:border-box; width:100%; min-width:0; }
.line-spacing-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.line-spacing-actions .layout-units { flex:0 1 340px; margin:0; }
.line-spacing-save-state { margin-left:auto; font-size:calc(12px * var(--admin-font-scale,1)); }
.structure-pill { display:flex; align-items:center; gap:5px; min-height:34px; padding:5px 10px; color:#35566c; background:linear-gradient(#fff,#edf2f7); border:1px solid #c2cedb; border-bottom-width:2px; border-radius:999px; box-shadow:0 2px 4px #22385816,inset 0 1px #fff; font:inherit; font-weight:650; cursor:pointer; transition:box-shadow .15s,background .15s; }
.structure-pill:hover:not(:disabled),.structure-pill[aria-expanded=true] { color:#2457a6; background:#edf4ff; border-color:#8bacdc; box-shadow:0 3px 9px #2457a622; }
.structure-pill:active:not(:disabled) { box-shadow:inset 0 1px 3px #22385820; }
.rail-pill { color:#896026; }
.device-count { padding:5px 9px; color:#647282; background:#f0f3f5; border:1px solid #e0e5eb; border-radius:999px; }
.line-control-popup { box-sizing:border-box; position:fixed; z-index:1200; width:min(560px,calc(100vw - 16px)); padding:14px; overflow-y:auto; overflow-x:hidden; border:1px solid #d6dfeb; border-radius:12px; background:#fff; box-shadow:0 12px 36px #17203326,0 2px 6px #17203312; color:#344054; font:calc(13px * var(--admin-font-scale,1)) 'Inter Variable','Noto Sans SC Variable',sans-serif; }
.line-list-popup { width:min(440px,calc(100vw - 16px)); padding:8px; }
.line-search { box-sizing:border-box; width:100%; max-width:100%; min-width:0; margin-bottom:6px; }
.line-option { display:flex; align-items:center; gap:3px; padding:3px; border-radius:7px; }
.line-option.active { background:#edf4ff; }
.line-option-select { display:flex; align-items:center; gap:8px; min-width:0; flex:1; min-height:36px; padding:6px; border:0; background:transparent; color:inherit; font:inherit; cursor:pointer; text-align:left; }
.line-option-select span { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.line-option-select i { color:#2563eb; font-style:normal; }
.line-option:hover { background:#f2f6fb; }
.line-icon-button { display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; width:32px; min-height:32px; padding:6px; border:1px solid transparent; border-radius:6px; background:transparent; color:#6b7c93; cursor:pointer; }
.line-icon-button:hover:not(:disabled) { background:#eaf1fc; color:#2457a6; }
.line-icon-button.danger:hover:not(:disabled) { background:#fff0ee; color:#cf3e36; }
.line-control-popup header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
.structure-row { position:relative; display:grid; grid-template-columns:minmax(100px,1fr) 76px 76px auto; align-items:end; gap:8px; padding:10px; margin-top:8px; background:#f7f9fc; border:1px solid #e8edf4; border-radius:8px; cursor:pointer; }
.structure-row:hover,.structure-row:focus-visible { background:#edf4ff; border-color:#94b6e5; }
.structure-row.is-new { border-color:#42b883; background:#f3fcf7; box-shadow:inset 0 0 0 1px #42b88320; padding-top:24px; }
.structure-row.is-new .structure-name > span { padding-left:20px; }
.new-item-corner { position:absolute; inset:0 auto auto 0; width:46px; height:46px; overflow:hidden; border-top-left-radius:7px; pointer-events:none; }
.new-item-corner > span { position:absolute; top:7px; left:-16px; width:65px; text-align:center; transform:rotate(-45deg); background:#25875d; color:#fff; font-size:10px; line-height:17px; letter-spacing:1px; }
.structure-row:focus-visible { outline:2px solid #4389e9; outline-offset:2px; }
.structure-field,.line-create-row label { display:grid; gap:6px; min-width:0; color:#65738a; font-size:calc(12px * var(--admin-font-scale,1)); }
.layout-units { grid-template-columns:minmax(150px,1fr) 100px; align-items:center; max-width:320px; margin-bottom:12px; }
.layout-units input { box-sizing:border-box; width:100%; min-width:0; }
.structure-row input { box-sizing:border-box; width:100%; min-width:0; padding:6px 8px; }
.structure-row-actions { display:flex; align-items:center; gap:4px; }
.line-empty { color:#8995a6; margin:16px 6px; }
.line-modal-backdrop { position:fixed; z-index:2000; inset:0; display:grid; place-items:center; padding:16px; background:#17203355; }
.line-create-dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; overscroll-behavior:contain; border:1px solid #dce3ec; border-radius:14px; background:#fff; box-shadow:0 20px 70px #17203335; color:#344054; font:calc(13px * var(--admin-font-scale,1)) 'Inter Variable','Noto Sans SC Variable',sans-serif; }
.line-create-dialog header { position:relative; padding:20px 44px 16px 22px; border-bottom:1px solid #edf0f5; }
.line-create-dialog h3 { margin:0; font-size:calc(16px * var(--admin-font-scale,1)); }
.line-dialog-close { position:absolute; top:4px; right:4px; width:32px; height:32px; padding:0; border:0; background:transparent; color:#73829a; font-size:calc(22px * var(--admin-font-scale,1)); cursor:pointer; }
.line-create-row { display:grid; gap:16px; padding:20px 22px; }
.line-create-row .input { box-sizing:border-box; width:100%; }
.line-create-row footer { display:flex; justify-content:flex-end; gap:8px; padding-top:4px; }
button:focus-visible { outline:2px solid #4389e9; outline-offset:2px; }
button:disabled { opacity:.45; cursor:not-allowed; }
@media(max-width:760px) { .rail-spacing-row { grid-template-columns:minmax(0,1fr) minmax(0,1fr); } .rail-spacing-name { grid-column:1 / -1; } }
@media(max-width:600px) { .structure-row { grid-template-columns:minmax(80px,1fr) minmax(60px,.6fr) minmax(60px,.6fr); } .structure-row-actions { grid-column:1/-1; justify-content:flex-end; } .rail-spacing-row { grid-template-columns:minmax(0,1fr); } }
@media(prefers-reduced-motion:reduce) { .structure-pill { transition:none; } }
</style>
