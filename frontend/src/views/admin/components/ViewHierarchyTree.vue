<script setup>
import { computed, onBeforeUnmount, onDeactivated, onMounted, reactive, ref } from 'vue'
import { hierarchyHidden, moveView, viewDisplayName, viewTreeRows } from '../../../runtime/viewHierarchy.js'
const props = defineProps({ views: { type: Array, required: true }, selectedId: String, defaultId: String,
  collapsed: { type: Set, default: () => new Set() }, canEdit: Boolean })
const emit = defineEmits(['select', 'toggle', 'move', 'visibility'])
const rows = computed(() => viewTreeRows(props.views, props.collapsed))
const hidden = computed(() => props.views.filter(hierarchyHidden))
const dragging = ref(''), drop = reactive({ id: '', placement: '' }), menu = ref(null)
function clearDrag() { dragging.value = ''; drop.id = ''; drop.placement = '' }
function start(event, id) {
  if (!props.canEdit) { event.preventDefault(); return }
  menu.value = null; dragging.value = id
  event.dataTransfer.setData('application/x-dashboard-view', id); event.dataTransfer.effectAllowed = 'move'
}
function over(event, id) {
  if (!props.canEdit || !dragging.value) return
  const rect = event.currentTarget.getBoundingClientRect(), fraction = (event.clientY - rect.top) / rect.height
  const placement = !id ? 'root' : fraction < .25 ? 'before' : fraction > .75 ? 'after' : 'inside'
  if (!moveView(props.views, dragging.value, id, placement)) { drop.id = ''; event.dataTransfer.dropEffect = 'none'; return }
  event.preventDefault(); event.dataTransfer.dropEffect = 'move'; drop.id = id; drop.placement = placement
}
function finish(event, id) {
  if (!props.canEdit || !dragging.value || drop.id !== id || !drop.placement) return clearDrag()
  event.preventDefault(); event.stopPropagation()
  emit('move', { sourceId: dragging.value, targetId: id, placement: drop.placement }); clearDrag()
}
function openMenu(event, view) {
  event.preventDefault(); event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  menu.value = { id: view.id, x: Math.max(8, Math.min(event.clientX || rect.right, window.innerWidth - 176)),
    y: Math.max(8, Math.min(event.clientY || rect.bottom, window.innerHeight - 64)) }
}
function closeOutside(event) { if (!event.target.closest?.('.view-hierarchy-menu')) menu.value = null }
function closeOnEscape(event) { if (event.key === 'Escape') { menu.value = null; clearDrag() } }
onDeactivated(() => { menu.value = null; clearDrag() })
function hide() { const id = menu.value?.id; menu.value = null; if (props.canEdit && id) emit('visibility', { id, hidden: true }) }
onMounted(() => { window.addEventListener('pointerdown', closeOutside); window.addEventListener('keydown', closeOnEscape); window.addEventListener('blur', clearDrag) })
onBeforeUnmount(() => { window.removeEventListener('pointerdown', closeOutside); window.removeEventListener('keydown', closeOnEscape); window.removeEventListener('blur', clearDrag) })
</script>

<template>
  <div class="view-hierarchy">
    <div class="view-tree" role="tree" aria-label="视角层级">
      <div v-for="row in rows" :key="row.view.id" class="view-tree-row" :data-view-id="row.view.id"
        :data-drop="dragging && drop.id === row.view.id ? drop.placement : ''"
        :class="{ active: selectedId === row.view.id, dragging: dragging === row.view.id }"
        :style="{ marginLeft: `${Math.min(row.level, 6) * 8}px` }" role="treeitem" :aria-label="viewDisplayName(row.view)"
        :aria-level="row.level + 1" :aria-expanded="row.hasChildren ? !row.collapsed : undefined"
        @dragover="over($event, row.view.id)" @drop="finish($event, row.view.id)" @contextmenu="openMenu($event, row.view)">
        <button type="button" class="view-tree-toggle" :disabled="!row.hasChildren" :aria-label="`${row.collapsed ? '展开' : '收起'}${viewDisplayName(row.view)}`" @click="emit('toggle', row.view.id)">{{ row.hasChildren ? (row.collapsed ? '▸' : '▾') : '·' }}</button>
        <button type="button" class="view-drag-handle" :draggable="canEdit" :disabled="!canEdit" :aria-label="`拖动${viewDisplayName(row.view)}`" title="拖动调整层级"
          @dragstart="start($event, row.view.id)" @dragend="clearDrag" @click.stop @keydown.shift.f10="openMenu($event, row.view)">
          <svg viewBox="0 0 16 20" aria-hidden="true"><circle v-for="p in [[5,5],[11,5],[5,10],[11,10],[5,15],[11,15]]" :key="p.join()" :cx="p[0]" :cy="p[1]" r="1.3" /></svg>
        </button>
        <button type="button" class="view-tree-select" :title="viewDisplayName(row.view)" @click="emit('select', row.view.id)"><strong>{{ viewDisplayName(row.view) }}</strong><i v-if="defaultId === row.view.id" title="默认视角">●</i></button>
        <span v-if="dragging && drop.id === row.view.id && drop.placement === 'inside'" class="view-drop-label">移为子级</span>
      </div>
      <div v-if="dragging" class="view-root-drop" :class="{active: drop.placement === 'root'}" @dragover="over($event, '')" @drop="finish($event, '')">移为顶层</div>
    </div>
    <details v-if="hidden.length" class="hidden-views"><summary>已隐藏（{{ hidden.length }}）</summary><div v-for="view in hidden" :key="view.id"><span>{{ viewDisplayName(view) }}</span><button type="button" :disabled="!canEdit" :aria-label="`恢复${viewDisplayName(view)}`" @click="emit('visibility', {id:view.id, hidden:false})">恢复</button></div></details>
    <Teleport to="body"><div v-if="menu" class="view-hierarchy-menu" role="menu" aria-label="视角菜单" :style="{left:`${menu.x}px`,top:`${menu.y}px`}" @contextmenu.prevent><button type="button" role="menuitem" :disabled="!canEdit || views.filter(view => !hierarchyHidden(view)).length <= 1" @click="hide">隐藏此视角</button></div></Teleport>
  </div>
</template>

<style scoped>
.view-tree{display:grid;gap:2px}.view-tree-row{position:relative;display:grid;grid-template-columns:16px 22px minmax(0,1fr);align-items:center;min-height:34px;border:1px solid transparent;border-radius:7px;color:#303744}.view-tree-row:hover{background:#f4f6f9}.view-tree-row.active{border-color:#cdd5df;background:#eff3f8}.view-tree-row.dragging{opacity:.4}.view-tree-toggle,.view-drag-handle,.view-tree-select{border:0;background:transparent;color:inherit;padding:0;min-width:0;box-shadow:none}.view-tree-toggle{width:16px;height:24px;color:#97a0ae;font-size:13px;cursor:pointer}.view-tree-toggle:disabled{opacity:.5;cursor:default}.view-drag-handle{display:grid;place-items:center;width:22px;height:28px;cursor:grab;color:#85909f;touch-action:none}.view-drag-handle:active{cursor:grabbing}.view-drag-handle:disabled{cursor:default;opacity:.4}.view-drag-handle svg{width:14px;height:18px;fill:currentColor}.view-drag-handle:hover:not(:disabled){color:#3269c7;background:#e3ebf8;border-radius:4px}.view-tree-select{display:flex;align-items:center;gap:5px;width:100%;padding:7px 4px;text-align:left;cursor:pointer}.view-tree-select strong{flex:1;min-width:0;font-size:12px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}.view-tree-select i{color:#31a36a;font-size:8px;font-style:normal}.view-tree-row[data-drop=before]::before,.view-tree-row[data-drop=after]::after{content:'';position:absolute;left:17px;right:0;height:2px;background:#3977de;z-index:3}.view-tree-row[data-drop=before]::before{top:-2px}.view-tree-row[data-drop=after]::after{bottom:-2px}.view-tree-row[data-drop=inside]{border-color:#5b8de4;background:#eaf2ff}.view-drop-label{position:absolute;right:3px;bottom:-8px;background:#3977de;color:white;font-size:9px;border-radius:3px;padding:1px 3px;pointer-events:none;z-index:4}.view-root-drop{padding:8px;border:1px dashed #b5c5dd;border-radius:5px;text-align:center;font-size:11px;color:#617da7}.view-root-drop.active{background:#eaf2ff;border-color:#3977de}.hidden-views{margin-top:7px;border-top:1px solid #e7eaf0;padding-top:6px;color:#7c8795;font-size:11px}.hidden-views summary{cursor:pointer}.hidden-views>div{display:flex;align-items:center;gap:8px;padding:5px 3px}.hidden-views span{flex:1}.hidden-views button{padding:2px 7px;border:0;border-radius:4px;background:#eff3f8;color:#446b9b;font-size:11px;cursor:pointer}.view-hierarchy-menu{position:fixed;z-index:10050;width:160px;padding:4px;border:1px solid #dce2ea;border-radius:8px;box-shadow:0 7px 24px #172b4d24;background:#fff}.view-hierarchy-menu button{width:100%;padding:8px 10px;border:0;border-radius:5px;background:none;color:#29374a;text-align:left;font-size:12px;cursor:pointer}.view-hierarchy-menu button:hover:not(:disabled){background:#edf3fb}.view-hierarchy-menu button:disabled{opacity:.4;cursor:default}
</style>
