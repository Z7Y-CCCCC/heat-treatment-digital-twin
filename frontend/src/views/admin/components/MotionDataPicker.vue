<script setup>
import { computed, ref, watch } from 'vue'
const props = defineProps({ catalog: Object, dataItemId: String, pointId: String, disabled: Boolean, busy: Boolean, error: String })
const emit = defineEmits(['select', 'refresh', 'clear'])
const categoryId = ref(''), tableId = ref('')
const categories = computed(() => props.catalog?.categories || [])
const selectedCategory = computed(() => categories.value.find(category => category.id === categoryId.value))
const availableItems = computed(() => (props.catalog?.items || []).filter(item => item.motionReady === true && item.enabled !== false && item.sourceReady !== false && item.objectScope !== 'part' && ['number', 'boolean', 'string'].includes(item.type) && ['runtime', 'plc', 'dataset'].includes(item.binding?.mode)))
const selected = computed(() => availableItems.value.find(item => item.id === props.dataItemId) || (!props.dataItemId && props.pointId ? availableItems.value.find(item => item.binding?.mode === 'plc' && String(item.binding.pointId) === props.pointId) : null))
const unavailable = computed(() => props.dataItemId && !selected.value ? (props.catalog?.items || []).find(item => item.id === props.dataItemId) : null)
const tables = computed(() => selectedCategory.value ? (props.catalog?.tables || []).filter(table => availableItems.value.some(item => item.tableId === table.id && item.categoryId === categoryId.value)) : [])
const selectedTable = computed(() => tables.value.find(table => table.id === tableId.value))
const items = computed(() => selectedTable.value ? availableItems.value.filter(item => item.categoryId === categoryId.value && item.tableId === tableId.value) : [])
const selectedInScope = computed(() => selected.value && items.value.some(item => item.id === selected.value.id))
const tablePlaceholder = computed(() => !selectedCategory.value ? '请先选择分类' : !tables.value.length ? '该分类暂无可用数据表' : '请选择数据表')
const itemPlaceholder = computed(() => !selectedCategory.value ? '请先选择分类' : !tables.value.length ? '该分类暂无可用数据表' : !selectedTable.value ? '请先选择数据表' : '请选择具体数据')
const typeLabel = type => ({ number: '数值', boolean: '开关量', string: '文字状态' })[type] || '数据'
function changeCategory(id) { categoryId.value = categories.value.some(category => category.id === id) ? id : ''; tableId.value = '' }
function changeTable(id) { tableId.value = tables.value.some(table => table.id === id) ? id : '' }
function choose(id) { if (props.disabled || props.busy) return; const item = items.value.find(item => item.id === id); if (item) emit('select', item) }
function clear() { if (!props.disabled && !props.busy) emit('clear') }
// Restore a saved binding's path without emitting a new binding selection.
// Watching its IDs (not preview values) leaves manual browsing undisturbed.
watch([() => selected.value?.id, () => selected.value?.categoryId, () => selected.value?.tableId], ([id, category, table]) => {
  if (id) {
    categoryId.value = categories.value.some(item => item.id === category) ? category : ''
    tableId.value = tables.value.some(item => item.id === table) ? table : ''
  }
}, { immediate: true })
watch([selectedCategory, tables], ([category, nextTables]) => {
  if (categoryId.value && !category) { categoryId.value = ''; tableId.value = '' }
  else if (tableId.value && !nextTables.some(table => table.id === tableId.value)) tableId.value = ''
}, { flush: 'sync' })
</script>
<template>
  <section class="motion-data-picker" aria-label="动作数据中心选取">
    <header><strong>驱动数据</strong><span>来自数据中心</span><button type="button" :disabled="busy" aria-label="刷新动作数据目录" @click="emit('refresh')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg></button></header>
    <p>先选分类，再选数据表，最后选具体数据，无需填写接口路径。</p>
    <div class="motion-data-filters"><label>用途分类<select :value="categoryId" aria-label="动作数据用途分类" :disabled="busy || !categories.length" @change="changeCategory($event.target.value)"><option value="">{{ categories.length ? '请选择分类' : '暂无可用分类' }}</option><option v-for="category in categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label><label>数据表<select :value="tableId" aria-label="动作数据表" :disabled="busy || !selectedCategory || !tables.length" @change="changeTable($event.target.value)"><option value="">{{ tablePlaceholder }}</option><option v-for="table in tables" :key="table.id" :value="table.id">{{ table.name }}</option></select></label></div>
    <label>具体数据<select :value="selectedInScope ? selected.id : ''" aria-label="动作驱动数据项" :disabled="disabled || busy || !selectedTable || !items.length" @change="choose($event.target.value)"><option value="">{{ itemPlaceholder }}</option><option v-for="item in items" :key="item.id" :value="item.id">{{ item.label }} · {{ typeLabel(item.type) }}{{ item.unit ? ` · ${item.unit}` : '' }}</option></select></label>
    <p v-if="selectedCategory && !busy && !tables.length" role="status">当前设备在该分类下暂无可用数据表，请切换分类或先到数据中心整理数据。</p>
    <button v-if="dataItemId || pointId" type="button" class="motion-clear-binding" aria-label="解除动作数据绑定" :disabled="disabled || busy" @click="clear">解除绑定<span>同时停用此动作</span></button>
    <div v-if="selected" class="motion-source-summary"><strong>当前绑定：{{ selected.label }}</strong><small>{{ typeLabel(selected.type) }}{{ selected.unit ? ` · ${selected.unit}` : '' }} · {{ selected.sourceType === 'plc' ? '本设备只读采集点位' : selected.sourceType === 'internal' ? '当前设备关联资料' : '已配置的数据表' }}</small><span>{{ selected.quality === 'good' && selected.previewValue != null ? `预览：${selected.previewValue}${selected.unit ? ` ${selected.unit}` : ''}` : '以现场实际读取结果为准，异常或超时会停止联动' }}</span></div>
    <p v-if="unavailable" class="motion-picker-error" role="alert">{{ unavailable.label }}：{{ unavailable.motionError || '当前设备无法读取此数据项，请检查数据中心的来源与对象映射后刷新目录。' }}</p>
    <p v-if="error" class="motion-picker-error" role="alert">{{ error }}</p><p v-else-if="!busy && !availableItems.length">此设备暂无可执行的数据项。请先在数据中心接入并整理；部件资料需在具备部件上下文的悬停编辑器中使用。</p>
  </section>
</template>
<style scoped>
.motion-data-picker{display:grid;gap:10px;padding:12px;border:1px solid #dce7f6;border-radius:9px;background:linear-gradient(130deg,#f5f9ff,#fff);color:#58708d}.motion-data-picker header{display:flex;align-items:center;gap:8px}.motion-data-picker header strong{font-size:12px;font-weight:600;color:#416389}.motion-data-picker header span{flex:1;font-size:10px;color:#98a8be}.motion-data-picker header button{width:22px;height:22px;padding:3px;border:0;background:none;color:#8b9eb9;cursor:pointer}.motion-data-picker svg{width:14px;height:14px;stroke:currentColor;stroke-width:1.6;fill:none}.motion-data-picker p{margin:0;font-size:11px;line-height:1.65;color:#8c9baf}.motion-data-picker label{display:grid;gap:5px;font-size:11px;color:#8798af}.motion-data-picker select{box-sizing:border-box;width:100%;max-width:100%;min-width:0;height:34px;padding:7px 8px;border:1px solid #d4dfef;border-radius:6px;background:#fff;font:inherit;font-size:12px;color:#425b7c}.motion-data-picker select:focus{outline:2px solid #9cbdeb;outline-offset:1px}.motion-data-filters{display:grid;grid-template-columns:1fr 1fr;gap:8px}.motion-source-summary{display:grid;gap:5px;padding:9px;border-radius:6px;background:#edf4ff;font-size:11px;color:#647f9f;line-height:1.6;overflow-wrap:anywhere}.motion-source-summary small{color:#8da1ba}.motion-source-summary strong{color:#5278a4;font-weight:500}.motion-data-picker .motion-picker-error{color:#b05459}button:disabled,select:disabled{opacity:.5;cursor:default}
.motion-clear-binding{display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;background:none;padding:0;font:inherit;font-size:11px;text-align:left;color:#aa6970;cursor:pointer}.motion-clear-binding span{color:#9aa7b7;font-size:10px}.motion-clear-binding:focus-visible{outline:2px solid #8bb9ef;outline-offset:3px}
</style>
