<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { DATA_CENTER_SECTIONS, dataCenterSourceLabel, dataCenterQuality, dataCenterPreview, dataCenterObjectLabel, filterDataCenterItems } from '../utils/dataCenterCatalog.js'

const props = defineProps({
  factoryId: String, activeSection: { type: String, default: 'tables' },
  sections: { type: Array, default: () => DATA_CENTER_SECTIONS },
  devices: { type: Array, default: () => [] }, canEdit: Boolean, canDelete: Boolean, confirm: Function
})
const emit = defineEmits(['navigate', 'refreshed'])
const catalog = ref({ categories: [], tables: [], items: [], revision: '' })
const loading = ref(false), busy = ref(false), failed = ref(false), message = ref('')
const query = ref(''), categoryId = ref('all'), sourceType = ref('all'), selectedTableId = ref(''), previewDeviceId = ref('')
const categoryForm = ref(null), categoryInput = ref(null), fieldForm = ref(null), fieldInput = ref(null)
let sequence = 0, disposed = false
const isTables = computed(() => props.activeSection === 'tables')
const activeContentSection = computed(() => props.activeSection === 'table-editor' ? 'tables' : props.activeSection)
const activeRegionLabel = computed(() => props.activeSection === 'table-editor' ? '外部数据表' : props.sections.find(section => section.key === props.activeSection)?.label || '数据中心内容')
const currentCategory = computed(() => catalog.value.categories.find(category => category.id === categoryId.value))
const items = computed(() => filterDataCenterItems(catalog.value.items, { query: query.value, categoryId: categoryId.value, sourceType: sourceType.value }))
const tables = computed(() => catalog.value.tables.filter(table => items.value.some(item => item.tableId === table.id)
  || (!query.value.trim() && sourceType.value === 'all' && (categoryId.value === 'all' || table.categoryId === categoryId.value))))
const selectedTable = computed(() => tables.value.find(table => table.id === selectedTableId.value) || tables.value[0])
const tableItems = computed(() => items.value.filter(item => item.tableId === selectedTable.value?.id))
const sourceOptions = computed(() => [...new Set(catalog.value.items.map(item => dataCenterSourceLabel(item.sourceType)))])
const previewDevices = computed(() => props.devices.length ? props.devices : catalog.value.devices || [])
const typeLabels = { number: '数值', string: '文字', boolean: '状态' }
const countCategory = id => catalog.value.items.filter(item => item.categoryId === id).length
const countTable = id => catalog.value.items.filter(item => item.tableId === id).length

async function load() {
  const generation = ++sequence, factoryId = props.factoryId, deviceId = previewDeviceId.value
  loading.value = true; failed.value = false; message.value = ''
  try {
    const response = await adminApi.getDataCenterCatalog({ previewDeviceId: deviceId, factoryId })
    if (disposed || generation !== sequence || factoryId !== props.factoryId) return
    if (response.error || response.success === false) throw new Error(response.error || '数据中心读取失败')
    catalog.value = { categories: response.categories || [], tables: response.tables || [], items: (response.items || []).map(item => ({ ...item, tableName: (response.tables || []).find(table => table.id === item.tableId)?.name || '' })), revision: response.revision }
    if (response.devices) catalog.value.devices = response.devices
    if (categoryId.value !== 'all' && !catalog.value.categories.some(item => item.id === categoryId.value)) categoryId.value = 'all'
    emit('refreshed', response)
  } catch (error) {
    if (!disposed && generation === sequence) { failed.value = true; message.value = error.message || '数据中心读取失败，请重试' }
  } finally { if (!disposed && generation === sequence) loading.value = false }
}
function notifyChanged() { window.dispatchEvent(new CustomEvent('digital-twin-data-center-changed', { detail: { source: 'data-center-workspace' } })) }
async function editCategory(category = null) {
  if (!props.canEdit || busy.value) return
  categoryForm.value = { id: category?.id || '', name: category?.name || '' }
  fieldForm.value = null
  await nextTick(); categoryInput.value?.focus()
}
async function saveCategory() {
  if (!props.canEdit || busy.value || !categoryForm.value?.name.trim()) return
  busy.value = true; failed.value = false; message.value = ''
  const factoryId = props.factoryId
  try {
    const response = await adminApi.saveDataCategory({ ...categoryForm.value, name: categoryForm.value.name.trim(), revision: catalog.value.revision })
    if (disposed || factoryId !== props.factoryId) return
    if (response.error || response.success === false) throw new Error(response.error || '分类保存失败')
    categoryForm.value = null; await load(); notifyChanged(); message.value = '分类已保存'
  } catch (error) { failed.value = true; message.value = error.message }
  finally { busy.value = false }
}
async function deleteCategory(category) {
  if (!props.canDelete || !category || category.id === 'uncategorized' || busy.value || !props.confirm) return
  const factoryId = props.factoryId
  if (!await props.confirm(`删除「${category.name}」分类？其中的数据项将移入“未分类”，原始数据和组件绑定不会删除。`, { title: '删除用途分类', type: 'warning', confirmText: '删除分类' })) return
  if (disposed || factoryId !== props.factoryId) return
  busy.value = true; failed.value = false
  try {
    const response = await adminApi.deleteDataCategory(category.id, catalog.value.revision)
    if (disposed || factoryId !== props.factoryId) return
    if (response.error || response.success === false) throw new Error(response.error || '分类删除失败')
    categoryId.value = 'uncategorized'; categoryForm.value = null; await load(); notifyChanged(); message.value = '分类已删除，数据项已移入未分类'
  } catch (error) { failed.value = true; message.value = error.message }
  finally { busy.value = false }
}
async function editField(item) {
  if (!props.canEdit || busy.value) return
  fieldForm.value = { id: item.id, label: item.label, categoryId: item.categoryId }
  categoryForm.value = null
  await nextTick(); fieldInput.value?.focus(); fieldInput.value?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
}
async function saveField() {
  if (!props.canEdit || busy.value || !fieldForm.value?.label.trim()) return
  busy.value = true; failed.value = false
  const factoryId = props.factoryId
  try {
    const { id, ...metadata } = fieldForm.value
    const response = await adminApi.saveDataItemMetadata(id, { ...metadata, revision: catalog.value.revision })
    if (disposed || factoryId !== props.factoryId) return
    if (response.error || response.success === false) throw new Error(response.error || '数据项保存失败')
    fieldForm.value = null; await load(); notifyChanged(); message.value = '显示名称和分类已保存，数据绑定保持不变'
  } catch (error) { failed.value = true; message.value = error.message }
  finally { busy.value = false }
}
function onDataChanged(event) { if (event?.detail?.source !== 'data-center-workspace' && isTables.value && !busy.value) void load() }
async function canLeave() {
  if (busy.value) return false
  if (!categoryForm.value && !fieldForm.value) return true
  if (!props.confirm || !await props.confirm('用途分类或数据项有未保存的修改，是否放弃并离开？', { title: '未保存的数据整理', confirmText: '放弃修改', cancelText: '继续编辑', type: 'warning' })) return false
  categoryForm.value = null; fieldForm.value = null
  return true
}
async function savePending() {
  if (busy.value) throw new Error('数据整理正在保存，请稍后再试')
  if (categoryForm.value) await saveCategory()
  if (fieldForm.value) await saveField()
  if (categoryForm.value || fieldForm.value) throw new Error(message.value || '请先填写完整的数据整理信息')
}
function discardPending() { categoryForm.value = null; fieldForm.value = null }
watch(() => props.factoryId, () => {
  catalog.value = { categories: [], tables: [], items: [], revision: '' }
  categoryForm.value = null; fieldForm.value = null; selectedTableId.value = ''
  if (isTables.value) void load()
}, { immediate: true })
watch(previewDeviceId, () => { if (isTables.value) void load() })
watch(isTables, shown => { if (shown) void load(); else { sequence++; loading.value = false } })
watch(previewDevices, devices => { if (previewDeviceId.value && !devices.some(item => String(item.id) === previewDeviceId.value)) previewDeviceId.value = '' })
if (typeof window !== 'undefined') {
  window.addEventListener('digital-twin-data-sets-changed', onDataChanged)
  window.addEventListener('digital-twin-data-center-changed', onDataChanged)
}
onBeforeUnmount(() => {
  disposed = true; sequence++
  window.removeEventListener('digital-twin-data-sets-changed', onDataChanged)
  window.removeEventListener('digital-twin-data-center-changed', onDataChanged)
})
defineExpose({ load, canLeave, isBusy: busy, savePending, discardPending })
</script>

<template>
  <section class="data-center" data-testid="data-center-workspace">
    <header class="center-heading">
      <div class="center-title"><span class="center-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 4 16 4 16 0V5M4 11v7c0 4 16 4 16 0v-7"/></svg></span><div><h2>数据中心</h2><p>先整理好数据，再轻松搭建画面</p></div></div>
      <ol class="center-flow" aria-label="数据使用流程"><li><b>1</b><span>接入数据</span></li><li aria-hidden="true">›</li><li><b>2</b><span>整理数据表</span></li><li aria-hidden="true">›</li><li><b>3</b><span>设计器选取</span></li></ol>
    </header>
    <div v-if="isTables" id="data-center-panel-tables" role="region" aria-label="数据表" class="center-catalog">
      <div class="catalog-topline"><div><h3>数据表</h3><p>设备资料与采集点位自动收录，外部数据配置一次、处处复用。</p></div><div class="catalog-actions"><button type="button" :disabled="loading || busy" class="center-button" @click="load"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg>刷新</button><button v-if="sections.some(section=>section.key==='sources')" type="button" class="center-button primary" @click="emit('navigate','table-editor')">{{canEdit?'＋ 新建 / 管理外部数据表':'查看外部数据表'}}</button></div></div>
      <div v-if="message" class="center-message" :class="{error:failed}" role="status">{{message}}<button v-if="failed" type="button" :disabled="loading" @click="load">重新读取</button></div>
      <div class="catalog-layout" :aria-busy="loading">
        <aside class="category-sidebar" aria-label="按用途分类">
          <header><span>按用途分类</span><button v-if="canEdit" type="button" :disabled="busy" aria-label="添加用途分类" @click="editCategory()">＋</button></header>
          <button type="button" class="category-choice" :class="{active:categoryId==='all'}" :aria-pressed="categoryId==='all'" @click="categoryId='all';fieldForm=null"><span class="category-dot all"></span><span>全部数据</span><small>{{catalog.items.length}}</small></button>
          <button v-for="category in catalog.categories" :key="category.id" type="button" class="category-choice" :class="{active:categoryId===category.id}" :aria-pressed="categoryId===category.id" @click="categoryId=category.id;fieldForm=null"><span class="category-dot" :class="category.id"></span><span>{{category.name}}</span><small>{{countCategory(category.id)}}</small></button>
          <div v-if="currentCategory && currentCategory.id!=='uncategorized' && (canEdit || canDelete)" class="category-actions"><button v-if="canEdit" type="button" :disabled="busy" @click="editCategory(currentCategory)">重命名</button><button v-if="canDelete" type="button" :disabled="busy" @click="deleteCategory(currentCategory)">删除分类</button></div>
          <form v-if="categoryForm" class="category-form" @submit.prevent="saveCategory"><label>{{categoryForm.id?'重命名分类':'新建用途分类'}}<input ref="categoryInput" v-model="categoryForm.name" maxlength="60" required aria-label="用途分类名称" placeholder="例如：能耗管理" :disabled="busy" /></label><div><button type="button" :disabled="busy" @click="categoryForm=null">取消</button><button type="submit" :disabled="busy || !categoryForm.name.trim()">保存</button></div></form>
          <p class="category-note">分类只负责整理数据。删除分类不会删除数据或已绑定的组件。</p>
        </aside>
        <div class="catalog-main">
          <div class="catalog-tools"><label class="catalog-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input v-model="query" type="search" aria-label="搜索数据项" placeholder="搜索名称、单位或适用对象" /></label><select v-model="sourceType" aria-label="筛选数据来源"><option value="all">全部来源</option><option v-for="option in sourceOptions" :key="option" :value="option">{{option}}</option></select><select v-if="previewDevices.length" v-model="previewDeviceId" aria-label="预览设备"><option value="">预览：自动选择设备</option><option v-for="device in previewDevices" :key="device.id" :value="String(device.id)">预览：{{device.name}}</option></select></div>
          <div class="catalog-caption"><span>{{currentCategory?.name || '全部数据'}} <b>{{tables.length}}</b> 张表 <span class="caption-divider">·</span> <b>{{items.length}}</b> 个数据项</span><small>{{loading?'正在读取…':'只显示当前工厂实际已有的数据'}}</small></div>
          <div v-if="tables.length" class="table-cards" aria-label="选择数据表"><button v-for="table in tables" :key="table.id" type="button" class="table-card" :class="{active:selectedTable?.id===table.id}" :aria-pressed="selectedTable?.id===table.id" @click="selectedTableId=table.id;fieldForm=null"><span class="table-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M10 10v10M3 15h18"/></svg></span><strong>{{table.name}}</strong><span class="table-card-meta">{{dataCenterSourceLabel(table.sourceType)}}<i>·</i>{{countTable(table.id)}} 项</span><small>{{table.description || table.objectScope || '随当前对象读取，保持真实数据绑定'}}</small></button></div>
          <section v-if="selectedTable" class="fields-section" aria-label="数据表字段"><header><div><h4>{{selectedTable.name}}</h4><p>{{selectedTable.description || '选择数据项后，设计器会自动沿用它的绑定。'}}</p></div><span>字段与预览</span></header><div class="fields-scroll"><table class="fields-table"><thead><tr><th>数据项</th><th>用途分类</th><th>适用对象</th><th>预览值</th><th>读取状态</th><th v-if="canEdit" class="field-operation">整理</th></tr></thead><tbody><tr v-for="item in tableItems" :key="item.id"><td><strong>{{item.label}}</strong><small>{{typeLabels[item.type] || '数据'}}{{item.unit?' · '+item.unit:''}}</small></td><td>{{catalog.categories.find(category=>category.id===item.categoryId)?.name || '未分类'}}</td><td class="field-scope">{{dataCenterObjectLabel(item)}}</td><td class="field-value"><span :title="dataCenterPreview(item)">{{dataCenterPreview(item)}}</span><small v-if="item.unit && dataCenterPreview(item)!=='—'">{{item.unit}}</small></td><td><span class="quality-label" :class="dataCenterQuality(item.quality).key"><i></i>{{dataCenterQuality(item.quality).label}}</span></td><td v-if="canEdit"><button type="button" class="field-edit" :disabled="busy" :aria-label="`整理数据项 ${item.label}`" @click="editField(item)">编辑</button></td></tr></tbody></table></div><p v-if="!tableItems.length" class="small-empty">这张表暂没有匹配的数据项。</p><footer>预览值只供核对；组件使用动态绑定，不会把这里的读数保存成固定文字。</footer></section>
          <div v-else class="catalog-empty"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="10" width="34" height="29" rx="5"/><path d="M7 20h34M20 20v19M7 30h34"/></svg><h4>{{loading?'正在收集已有数据…':query || sourceType!=='all'?'没有找到匹配的数据':'这个分类还没有数据'}}</h4><p>{{query || sourceType!=='all'?'试试其他名称，或切换到全部来源。':'已有设备资料和采集点位会自动出现，也可以接入外部数据后创建数据表。'}}</p><button v-if="!loading && sections.some(section=>section.key==='sources')" type="button" class="center-button" @click="emit('navigate','sources')">去接入数据</button></div>
          <form v-if="fieldForm" class="field-form" @submit.prevent="saveField"><header><strong>整理数据项</strong><span>只修改显示名称与分类，不改变原始值或绑定。</span></header><div><label>显示名称<input ref="fieldInput" v-model="fieldForm.label" required maxlength="100" aria-label="数据项显示名称" :disabled="busy" /></label><label>用途分类<select v-model="fieldForm.categoryId" aria-label="数据项用途分类" :disabled="busy"><option v-for="category in catalog.categories" :key="category.id" :value="category.id">{{category.name}}</option></select></label><button type="button" class="center-button" :disabled="busy" @click="fieldForm=null">取消</button><button type="submit" class="center-button primary" :disabled="busy || !fieldForm.label.trim()">保存</button></div></form>
        </div>
      </div>
    </div>
    <div v-else :id="`data-center-panel-${activeContentSection}`" role="region" :aria-label="activeRegionLabel" class="center-slot"><div v-if="activeSection==='table-editor'" class="external-table-guide"><button type="button" @click="emit('navigate','tables')">‹ 返回统一数据表</button><span>外部数据配置好后，字段会自动出现在数据表目录和设计器选项中。</span></div><slot /></div>
  </section>
</template>

<style scoped>
.data-center { color:#344054; font-size:calc(13px * var(--admin-font-scale,1)); width:100%; min-width:0; }
.center-heading { display:flex; justify-content:space-between; align-items:center; gap:24px; margin-bottom:22px; }.center-title { display:flex; align-items:center; gap:13px; }.center-symbol { display:grid; place-items:center; width:48px; height:48px; border-radius:13px; background:#eaf0fc; color:#4774cd; }.center-symbol svg { width:25px; height:25px; fill:none; stroke:currentColor; stroke-width:1.6; }.center-title h2 { margin:0 0 5px; font-size:calc(23px * var(--admin-font-scale,1)); font-weight:650; letter-spacing:-.5px; }.center-title p { margin:0; font-size:calc(12px * var(--admin-font-scale,1)); color:#8b96a7; }
.center-flow { display:flex; align-items:center; gap:14px; list-style:none; margin:0; padding:0; color:#a3adbc; }.center-flow li { display:flex; align-items:center; gap:7px; white-space:nowrap; font-size:calc(11px * var(--admin-font-scale,1)); }.center-flow b { display:grid; place-items:center; width:21px; height:21px; border:1px solid #e0e6ef; border-radius:50%; color:#7390bc; background:#fff; font-size:11px; font-weight:500; }
.catalog-topline { display:flex; align-items:center; justify-content:space-between; gap:18px; margin-bottom:18px; }.catalog-topline h3 { margin:0 0 7px; font-size:calc(17px * var(--admin-font-scale,1)); font-weight:600; }.catalog-topline p { margin:0; color:#8b96a7; font-size:calc(12px * var(--admin-font-scale,1)); }.catalog-actions { display:flex; align-items:center; gap:8px; }.center-button { display:flex; align-items:center; justify-content:center; gap:6px; padding:8px 12px; border:1px solid #dfe5ee; border-radius:7px; background:#fff; color:#66758c; font:inherit; font-size:calc(12px * var(--admin-font-scale,1)); cursor:pointer; white-space:nowrap; }.center-button svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.6; }.center-button.primary { color:#fff; background:#4d7bdd; border-color:#4d7bdd; box-shadow:0 2px 3px #4774cd13; }.center-button:hover { border-color:#9ab8ee; }.center-button.primary:hover { background:#416dca; }
.catalog-layout { display:grid; grid-template-columns:190px minmax(0,1fr); border:1px solid #e3e8f0; border-radius:11px; overflow:hidden; background:#fff; min-height:510px; }.category-sidebar { padding:19px 13px; background:#fafbfd; border-right:1px solid #e8ecf2; }.category-sidebar>header { display:flex; align-items:center; justify-content:space-between; padding:0 9px 16px; color:#8c97a9; font-size:calc(11px * var(--admin-font-scale,1)); }.category-sidebar>header button { border:0; background:none; color:#8ca0bd; font-size:19px; cursor:pointer; line-height:1; }.category-choice { display:flex; align-items:center; gap:9px; width:100%; margin-bottom:4px; padding:11px 10px; border:0; border-radius:7px; text-align:left; background:none; color:#728097; font:inherit; font-size:calc(12px * var(--admin-font-scale,1)); cursor:pointer; }.category-choice>span:nth-child(2) { flex:1; min-width:0; overflow-wrap:anywhere; }.category-choice small { color:#a6afbd; font-size:calc(10px * var(--admin-font-scale,1)); }.category-choice.active { background:#eaf0fd; color:#4774cd; }.category-choice.active small { color:#7e9bce; }.category-choice:hover { background:#eff3fa; }.category-dot { width:6px; height:6px; border-radius:2px; flex:none; background:#a4afbf; }.category-dot.all,.category-dot.device { background:#7c9bd2; }.category-dot.realtime { background:#61ae9f; }.category-dot.production { background:#a58ac9; }.category-dot.alarms { background:#cd8e90; }.category-dot.parts { background:#cfb070; }.category-dot.uncategorized { background:#b4bbc5; }
.category-actions { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; padding:13px 9px 8px; }.category-actions button { background:none; border:0; padding:0; color:#98a3b4; font:inherit; font-size:calc(10px * var(--admin-font-scale,1)); cursor:pointer; }.category-actions button:hover { color:#527fcf; }.category-note { margin:23px 9px 0; padding-top:16px; border-top:1px solid #e7ecf3; color:#a2acbb; font-size:calc(10px * var(--admin-font-scale,1)); line-height:1.8; }.category-form { padding:12px 9px; border-top:1px solid #e4eaf3; margin-top:8px; }.category-form label { display:grid; gap:8px; font-size:11px; color:#7c8ca5; }.category-form input { width:100%; box-sizing:border-box; }.category-form>div { display:flex; justify-content:flex-end; gap:10px; margin-top:10px; }.category-form button { padding:0; border:0; background:none; color:#6d91cf; font:inherit; font-size:11px; cursor:pointer; }
.catalog-main { padding:20px; min-width:0; }.catalog-tools { display:flex; align-items:center; gap:8px; }.catalog-search { display:flex; align-items:center; gap:8px; flex:1; min-width:120px; border:1px solid #e2e7ef; border-radius:7px; padding:0 10px; height:35px; }.catalog-search svg { flex:none; width:15px; height:15px; fill:none; stroke:#a1adbe; stroke-width:1.6; }.catalog-search input { min-width:0; width:100%; height:100%; border:0; background:none; padding:0; outline:0; }.catalog-tools select { height:35px; max-width:210px; }.data-center input,.data-center select { font:inherit; font-size:calc(11px * var(--admin-font-scale,1)); color:#66758d; }.data-center input::placeholder { color:#a3adbd; }.data-center input:not(.catalog-search input),.data-center select { padding:8px 9px; border:1px solid #e1e7ef; border-radius:6px; background:#fff; min-width:0; }.catalog-caption { display:flex; justify-content:space-between; gap:8px; margin:19px 0 12px; color:#8c98aa; font-size:calc(11px * var(--admin-font-scale,1)); }.catalog-caption b { font-weight:500; color:#657892; margin:0 2px; }.catalog-caption>small { color:#a4aebd; font-size:calc(10px * var(--admin-font-scale,1)); }.caption-divider { margin:0 6px; color:#c3cbd6; }
.table-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:10px; margin-bottom:20px; max-height:235px; overflow:auto; padding:1px; }.table-card { position:relative; display:grid; grid-template-columns:30px minmax(0,1fr); align-items:center; column-gap:9px; row-gap:6px; padding:14px; border:1px solid #e3e8f0; border-radius:8px; background:#fff; text-align:left; font:inherit; cursor:pointer; min-width:0; }.table-card.active { border-color:#9bb7ee; background:#f9fbff; box-shadow:0 0 0 1px #dce7fb inset; }.table-card:hover { border-color:#a9c0eb; }.table-card-icon { grid-row:1 / 3; display:grid; place-items:center; width:29px; height:32px; border-radius:7px; background:#f0f3f9; color:#8aa2c8; }.table-card.active .table-card-icon { background:#e9effc; color:#6287cf; }.table-card-icon svg { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:1.5; }.table-card strong { color:#51647e; font-size:calc(12px * var(--admin-font-scale,1)); font-weight:550; overflow-wrap:anywhere; }.table-card-meta { color:#a0acbc; font-size:calc(10px * var(--admin-font-scale,1)); }.table-card-meta i { font-style:normal; margin:0 6px; color:#c5cddb; }.table-card>small { grid-column:1 / -1; color:#9da9bb; font-size:calc(10px * var(--admin-font-scale,1)); line-height:1.65; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fields-section { border:1px solid #e7ebf2; border-radius:8px; overflow:hidden; }.fields-section>header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px; border-bottom:1px solid #e8edf4; }.fields-section h4 { margin:0 0 6px; font-size:calc(13px * var(--admin-font-scale,1)); color:#566a85; font-weight:550; }.fields-section header p { margin:0; color:#a0aabc; font-size:calc(10px * var(--admin-font-scale,1)); }.fields-section header>span { color:#a2adbd; font-size:calc(10px * var(--admin-font-scale,1)); white-space:nowrap; }.fields-scroll { overflow:auto; max-height:440px; }.fields-table { width:100%; border-collapse:collapse; font-size:calc(11px * var(--admin-font-scale,1)); text-align:left; }.fields-table th { padding:10px 14px; background:#fafbfd; color:#9aa6b7; font-weight:400; white-space:nowrap; }.fields-table td { padding:13px 14px; color:#8492a8; border-top:1px solid #edf0f5; vertical-align:middle; }.fields-table td:first-child { min-width:120px; }.fields-table td strong { display:block; color:#61748f; font-weight:500; }.fields-table td:first-child small { display:block; color:#a7b1c0; font-size:calc(10px * var(--admin-font-scale,1)); margin-top:5px; }.field-scope { min-width:95px; max-width:190px; overflow-wrap:anywhere; line-height:1.6; }.field-value { min-width:70px; max-width:180px; font-variant-numeric:tabular-nums; }.field-value>span { display:inline-block; max-width:160px; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; white-space:nowrap; color:#607490; }.field-value>small { color:#9facc0; font-size:10px; margin-left:4px; }.quality-label { display:inline-flex; align-items:center; gap:5px; color:#a0adbf; white-space:nowrap; font-size:calc(10px * var(--admin-font-scale,1)); }.quality-label i { width:5px; height:5px; border-radius:50%; background:#b6c1d0; }.quality-label.good { color:#7ea59b; }.quality-label.good i { background:#80b3a3; }.quality-label.configured i { background:#9cafd0; }.quality-label.bad { color:#c58c92; }.quality-label.bad i { background:#c79399; }.quality-label.stale i { background:#c4b283; }.field-operation { width:45px; }.field-edit { border:0; background:none; color:#82a0d0; font:inherit; font-size:calc(10px * var(--admin-font-scale,1)); cursor:pointer; }.fields-section>footer { border-top:1px solid #e9edf3; color:#a5aebe; padding:11px 15px; font-size:calc(10px * var(--admin-font-scale,1)); line-height:1.7; }
.catalog-empty { display:grid; justify-items:center; text-align:center; padding:50px 30px; color:#a2aebe; }.catalog-empty>svg { width:48px; height:48px; fill:none; stroke:#c8d3e6; stroke-width:1.3; margin-bottom:14px; }.catalog-empty h4 { font-size:calc(14px * var(--admin-font-scale,1)); font-weight:500; color:#8b9ab0; margin:0 0 9px; }.catalog-empty p { font-size:calc(11px * var(--admin-font-scale,1)); line-height:1.8; max-width:390px; margin:0 0 20px; }.small-empty { text-align:center; padding:16px; color:#a7b2c2; font-size:11px; }
.field-form { margin-top:15px; padding:16px; border:1px solid #dbe6f8; border-radius:8px; background:#fafcff; }.field-form header { display:flex; align-items:center; gap:10px; margin-bottom:14px; font-size:12px; }.field-form header strong { font-weight:500; color:#6f8bba; }.field-form header span { color:#a0afc5; font-size:10px; }.field-form>div { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; }.field-form label { display:grid; gap:7px; color:#8b9db8; font-size:11px; flex:1; min-width:120px; }
.center-message { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:11px 14px; border:1px solid #dae9df; border-radius:7px; background:#f6faf7; color:#709780; margin:0 0 15px; font-size:12px; }.center-message.error { border-color:#efdadc; background:#fdf8f8; color:#b77e84; }.center-message button { border:0; background:none; color:inherit; cursor:pointer; font:inherit; }.center-slot { min-width:0; }.external-table-guide { display:flex; align-items:center; gap:16px; padding:12px 15px; margin-bottom:18px; border:1px solid #e4eaf4; border-radius:8px; background:#f9fbff; font-size:11px; color:#97a6bb; }.external-table-guide button { border:0; background:none; color:#7798ce; font:inherit; padding:0; cursor:pointer; white-space:nowrap; }
.data-center button:disabled,.data-center input:disabled,.data-center select:disabled { opacity:.55; cursor:default; }.data-center button:focus-visible { outline:2px solid #9cbaf0; outline-offset:3px; }.data-center input:focus,.data-center select:focus { outline:0; border-color:#a6c0ee; box-shadow:0 0 0 2px #4774cd0a; }.catalog-search:focus-within { border-color:#a6c0ee; }
@media(max-width:1150px) { .center-flow { gap:8px; }.catalog-layout { grid-template-columns:165px minmax(0,1fr); }.catalog-main { padding:16px; }.catalog-tools { flex-wrap:wrap; }.catalog-search { flex-basis:100%; }.catalog-tools select { flex:1; max-width:none; }.catalog-caption>small { display:none; } }
@media(max-width:760px) { .center-heading { align-items:flex-start; flex-direction:column; gap:15px; }.catalog-topline { align-items:flex-start; flex-direction:column; }.catalog-layout { grid-template-columns:minmax(0,1fr); }.category-sidebar { border-right:0; border-bottom:1px solid #e8ecf2; display:flex; gap:4px; flex-wrap:wrap; padding:12px; }.category-sidebar>header { width:100%; padding:0 5px 8px; }.category-choice { width:auto; padding:8px; }.category-note { width:100%; margin:6px 5px; padding-top:8px; }.category-form { width:100%; }.category-actions { padding:8px; }.table-cards { grid-template-columns:repeat(auto-fill,minmax(165px,1fr)); }.external-table-guide { flex-direction:column; align-items:flex-start; gap:8px; } }
</style>
