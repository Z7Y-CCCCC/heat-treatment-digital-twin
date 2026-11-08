<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { DATA_CENTER_SECTIONS, dataCenterSourceLabel, dataCenterQuality, dataCenterPreview, dataCenterObjectLabel, filterDataCenterItems } from '../utils/dataCenterCatalog.js'
import { firstDataCenterSample } from '../utils/dataCenterFieldSamples.js'
import { dataBrowserErrorMessage, fullRecordTime, recordTime } from '../utils/dataTableBrowser.js'
const DataTableBrowser = defineAsyncComponent(() => import('./DataTableBrowser.vue'))

const props = defineProps({
  factoryId: String, activeSection: { type: String, default: 'tables' },
  sections: { type: Array, default: () => DATA_CENTER_SECTIONS },
  devices: { type: Array, default: () => [] }, canEdit: Boolean, canDelete: Boolean, confirm: Function
})
const emit = defineEmits(['navigate', 'refreshed'])
const catalog = ref({ categories: [], tables: [], items: [], revision: '', factoryId: '' })
const loading = ref(false), busy = ref(false), failed = ref(false), message = ref('')
const query = ref(''), categoryId = ref('all'), sourceType = ref('all'), selectedTableId = ref(''), previewDeviceId = ref('')
const categoryForm = ref(null), categoryInput = ref(null), fieldForm = ref(null), fieldInput = ref(null)
const fieldOriginal = ref(null), switching = ref(false)
const tableView = ref('fields')
const fieldSamples = ref({}), sampleLoading = ref(false), sampleHint = ref(''), sampleReadAt = ref(''), sampleQuality = ref('unknown')
let sampleSequence = 0, sampleController = null
const browseFactoryId = computed(() => props.factoryId || catalog.value.factoryId || '')
const workspaceBusy = computed(() => busy.value || switching.value)
const fieldDirty = computed(() => !!fieldForm.value && (!fieldOriginal.value || fieldForm.value.label !== fieldOriginal.value.label || fieldForm.value.categoryId !== fieldOriginal.value.categoryId))
let sequence = 0, editSequence = 0, disposed = false
const isTables = computed(() => props.activeSection === 'tables')
const activeContentSection = computed(() => props.activeSection === 'table-editor' ? 'tables' : props.activeSection)
const activeRegionLabel = computed(() => props.activeSection === 'table-editor' ? '外部数据表' : props.sections.find(section => section.key === props.activeSection)?.label || '数据中心内容')
const currentCategory = computed(() => catalog.value.categories.find(category => category.id === categoryId.value))
const items = computed(() => filterDataCenterItems(catalog.value.items, { query: query.value, categoryId: categoryId.value, sourceType: sourceType.value }))
const tables = computed(() => catalog.value.tables.filter(table => items.value.some(item => item.tableId === table.id)
  || (!query.value.trim() && sourceType.value === 'all' && (categoryId.value === 'all' || table.categoryId === categoryId.value))))
const selectedTable = computed(() => tables.value.find(table => table.id === selectedTableId.value) || tables.value[0])
const tableItems = computed(() => items.value.filter(item => item.tableId === selectedTable.value?.id))
const displayedTableItems = computed(() => tableItems.value.map(item => {
  if (selectedTable.value?.sourceType !== 'dataset') return item
  return { ...item, previewValue: null, quality: ['config_error', 'disabled'].includes(item.quality) ? item.quality : sampleQuality.value,
    previewHint: sampleHint.value || item.previewHint, ...fieldSamples.value[item.id] }
}))
const sourceOptions = computed(() => [...new Set(catalog.value.items.map(item => dataCenterSourceLabel(item.sourceType)))])
const previewDevices = computed(() => props.devices.length ? props.devices : catalog.value.devices || [])
const typeLabels = { number: '数值', string: '文字', boolean: '状态' }
const countCategory = id => catalog.value.items.filter(item => item.categoryId === id).length
const countTable = id => catalog.value.items.filter(item => item.tableId === id).length

function previewTitle(item) {
  if (item.previewValue == null) return item.previewHint || '来源尚未返回可用值'
  const display = dataCenterPreview(item), raw = String(item.previewValue)
  return display === raw ? display : `${display}\n来源原值：${raw}`
}
async function loadFieldSamples() {
  const generation = ++sampleSequence
  sampleController?.abort(); sampleController = null
  fieldSamples.value = {}; sampleReadAt.value = ''; sampleHint.value = ''; sampleLoading.value = false; sampleQuality.value = 'unknown'
  const table = selectedTable.value, factoryId = browseFactoryId.value, deviceId = previewDeviceId.value
  if (disposed || !isTables.value || loading.value || tableView.value !== 'fields' || table?.sourceType !== 'dataset' || !factoryId) return false
  if (table.enabled === false || table.sourceReady === false) { sampleHint.value = table.sourceError || '数据表或来源未启用，请先检查接入配置。'; return false }
  const controller = new AbortController(); sampleController = controller; sampleLoading.value = true
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    // Catalog read access alone never grants external data access. This request
    // uses the same separately authorized endpoint as the full records browser.
    const response = await adminApi.getDataTableRecords({ tableId: table.id, factoryId, mode: 'current', pageSize: 100, deviceId, signal: controller.signal })
    if (disposed || generation !== sampleSequence || table.id !== selectedTable.value?.id || factoryId !== browseFactoryId.value) return false
    if (controller.signal.aborted) throw Object.assign(new Error('实际数据读取超时，请检查连接后重试。'), { name: 'AbortError' })
    if (response.error || response.success === false) throw Object.assign(new Error(response.error || '核对样本读取失败'), { status: response.status })
    const sample = firstDataCenterSample(response.records || [])
    fieldSamples.value = sample.values; sampleReadAt.value = response.readAt || ''
    sampleQuality.value = response.sourceRecordCount === 0 ? 'empty' : 'unknown'
    sampleHint.value = Object.keys(sample.values).length ? `核对样本：${sample.objectName}。各项取自同一条实际记录；完整记录请切换「数据浏览」。`
      : response.notice || '来源当前没有返回记录，预览值显示 —。'
    return true
  } catch (error) {
    if (!disposed && generation === sampleSequence) { sampleHint.value = dataBrowserErrorMessage(error); sampleQuality.value = [401, 403].includes(error.status) ? 'unknown' : 'bad' }
    return false
  } finally { clearTimeout(timeout); if (!disposed && generation === sampleSequence) { sampleLoading.value = false; sampleController = null } }
}

async function load() {
  const generation = ++sequence, factoryId = props.factoryId, deviceId = previewDeviceId.value
  loading.value = true; failed.value = false; message.value = ''
  try {
    const response = await adminApi.getDataCenterCatalog({ previewDeviceId: deviceId, factoryId })
    if (disposed || generation !== sequence || factoryId !== props.factoryId) return
    if (response.error || response.success === false) throw new Error(response.error || '数据中心读取失败')
    catalog.value = { categories: response.categories || [], tables: response.tables || [], items: (response.items || []).map(item => ({ ...item, tableName: (response.tables || []).find(table => table.id === item.tableId)?.name || '' })), revision: response.revision, factoryId: response.factoryId || factoryId }
    if (response.devices) catalog.value.devices = response.devices
    if (categoryId.value !== 'all' && !catalog.value.categories.some(item => item.id === categoryId.value)) categoryId.value = 'all'
    emit('refreshed', response)
  } catch (error) {
    if (!disposed && generation === sequence) { failed.value = true; message.value = error.message || '数据中心读取失败，请重试' }
  } finally { if (!disposed && generation === sequence) loading.value = false }
}
function notifyChanged() { window.dispatchEvent(new CustomEvent('digital-twin-data-center-changed', { detail: { source: 'data-center-workspace' } })) }
async function editCategory(category = null) {
  if (!props.canEdit || busy.value || switching.value || loading.value) return
  if (categoryForm.value && categoryForm.value.id === (category?.id || '')) { categoryInput.value?.focus(); return }
  if ((fieldForm.value || categoryForm.value) && !await canLeave()) return
  categoryForm.value = { id: category?.id || '', name: category?.name || '' }
  fieldForm.value = null; fieldOriginal.value = null; editSequence++
  await nextTick(); categoryInput.value?.focus()
}
async function saveCategory() {
  if (!props.canEdit || workspaceBusy.value || !categoryForm.value?.name.trim()) return
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
  if (!props.canDelete || !category || category.id === 'uncategorized' || workspaceBusy.value || !props.confirm) return
  const factoryId = props.factoryId
  if ((categoryForm.value || fieldForm.value) && !await canLeave()) return
  if (disposed || factoryId !== props.factoryId) return
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
  if (!props.canEdit || busy.value || switching.value || loading.value) return false
  if (fieldForm.value?.id === item.id) { fieldInput.value?.focus(); return true }
  if ((fieldForm.value || categoryForm.value) && !await canLeave()) return false
  const current = catalog.value.items.find(entry => entry.id === item.id)
  if (!current || disposed) return false
  fieldForm.value = { id: current.id, label: current.label, categoryId: current.categoryId }
  fieldOriginal.value = { label: current.label, categoryId: current.categoryId, revision: catalog.value.revision }
  categoryForm.value = null
  editSequence++; failed.value = false; message.value = ''
  await nextTick(); fieldInput.value?.focus(); fieldInput.value?.scrollIntoView?.({ block: 'nearest' })
  return true
}
function setFieldInput(element) { fieldInput.value = element }
function cancelField() {
  if (busy.value || switching.value) return false
  fieldForm.value = null; fieldOriginal.value = null; editSequence++; failed.value = false; message.value = ''
  return true
}
function fieldKeys(event) {
  // IME candidate confirmation/cancellation is not a row edit command.
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Enter') { event.preventDefault(); void saveField() }
  else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelField() }
}
async function saveField() {
  if (!props.canEdit || busy.value || switching.value || !fieldForm.value?.label.trim()) return
  busy.value = true; failed.value = false
  const factoryId = props.factoryId
  try {
    const { id, label, categoryId } = fieldForm.value
    const response = await adminApi.saveDataItemMetadata(id, { label: label.trim(), categoryId, revision: fieldOriginal.value?.revision || catalog.value.revision })
    if (disposed || factoryId !== props.factoryId) return
    if (response.error || response.success === false) throw new Error(response.error || '数据项保存失败')
    fieldForm.value = null; fieldOriginal.value = null; editSequence++; await load(); notifyChanged(); message.value = '显示名称和分类已保存，数据绑定保持不变'
  } catch (error) { if (!disposed && factoryId === props.factoryId) { failed.value = true; message.value = error.message } }
  finally { busy.value = false }
}
function onDataChanged(event) {
  if (event?.detail?.source === 'data-center-workspace' || !isTables.value || busy.value || switching.value) return
  if (fieldForm.value || categoryForm.value) { if (!failed.value) message.value = '数据目录已有更新，请完成当前编辑后再刷新。'; return }
  void load()
}
async function canLeave() {
  if (busy.value || switching.value) return false
  if (!categoryForm.value && !fieldForm.value) return true
  if (!categoryForm.value && !fieldDirty.value) { discardPending(); return true }
  if (!props.confirm) return false
  const factoryId = props.factoryId, version = editSequence
  switching.value = true
  try {
    if (!await props.confirm('用途分类或数据项有未保存的修改，是否放弃并离开？', { title: '未保存的数据整理', confirmText: '放弃修改', cancelText: '继续编辑', type: 'warning' })) return false
    if (disposed || factoryId !== props.factoryId || version !== editSequence || busy.value) return false
    discardPending(); return true
  } finally { switching.value = false }
}
async function changeCatalogSelection(key, value) {
  const targets = { query, categoryId, sourceType, selectedTableId, previewDeviceId }
  if (!targets[key] || busy.value || loading.value || switching.value || targets[key].value === value) return false
  const factoryId = props.factoryId
  if ((categoryForm.value || fieldForm.value) && !await canLeave()) return false
  if (disposed || factoryId !== props.factoryId) return false
  targets[key].value = value
  return true
}
async function changeCatalogInput(key, event) {
  const targets = { query, sourceType, previewDeviceId }, value = event.target.value
  event.target.value = targets[key].value
  await changeCatalogSelection(key, value)
  if (event.target?.isConnected !== false) event.target.value = targets[key].value
}
async function refreshCatalog() {
  if (busy.value || loading.value || switching.value) return false
  if ((categoryForm.value || fieldForm.value) && !await canLeave()) return false
  await load(); return !failed.value
}
async function navigateCatalog(section) { if (await canLeave()) emit('navigate', section) }
async function changeTableView(view) {
  if (!['fields', 'records'].includes(view) || workspaceBusy.value || loading.value) return false
  if (tableView.value === view) return true
  const factoryId = props.factoryId
  if (!await canLeave() || disposed || factoryId !== props.factoryId) return false
  tableView.value = view
  return true
}
async function savePending() {
  if (workspaceBusy.value) throw new Error('数据整理正在保存或确认，请稍后再试')
  if (categoryForm.value) await saveCategory()
  if (fieldForm.value) await saveField()
  if (categoryForm.value || fieldForm.value) throw new Error(message.value || '请先填写完整的数据整理信息')
}
function discardPending() { categoryForm.value = null; fieldForm.value = null; fieldOriginal.value = null; editSequence++ }
watch(() => props.factoryId, () => {
  catalog.value = { categories: [], tables: [], items: [], revision: '', factoryId: '' }
  discardPending(); selectedTableId.value = ''
  tableView.value = 'fields'
  if (isTables.value) void load()
}, { immediate: true })
watch(previewDeviceId, () => { if (isTables.value) void load() })
watch(isTables, shown => { if (shown) void load(); else { sequence++; loading.value = false } })
watch(previewDevices, devices => { if (previewDeviceId.value && !devices.some(item => String(item.id) === previewDeviceId.value)) previewDeviceId.value = '' })
watch([selectedTable, tableView, previewDeviceId, browseFactoryId, isTables, loading], () => { void loadFieldSamples() }, { immediate: true })
if (typeof window !== 'undefined') {
  window.addEventListener('digital-twin-data-sets-changed', onDataChanged)
  window.addEventListener('digital-twin-data-center-changed', onDataChanged)
}
onBeforeUnmount(() => {
  disposed = true; sequence++; sampleSequence++; sampleController?.abort()
  window.removeEventListener('digital-twin-data-sets-changed', onDataChanged)
  window.removeEventListener('digital-twin-data-center-changed', onDataChanged)
})
defineExpose({ load, canLeave, isBusy: workspaceBusy, savePending, discardPending })
</script>

<template>
  <section class="data-center" data-testid="data-center-workspace">
    <div v-if="isTables" id="data-center-panel-tables" role="region" aria-label="数据表" class="center-catalog">
      <div class="catalog-topline"><div><h3>数据表</h3><p>设备资料与采集点位自动收录，外部数据配置一次、处处复用。</p></div><div class="catalog-actions"><button type="button" :disabled="loading || workspaceBusy" class="center-button" @click="refreshCatalog"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg>刷新</button><button v-if="sections.some(section=>section.key==='sources')" type="button" class="center-button primary" :disabled="workspaceBusy" @click="navigateCatalog('table-editor')">{{canEdit?'＋ 新建 / 管理外部数据表':'查看外部数据表'}}</button></div></div>
      <div v-if="message" class="center-message" :class="{error:failed}" role="status">{{message}}<button v-if="failed" type="button" :disabled="loading || workspaceBusy" @click="refreshCatalog">重新读取</button></div>
      <div class="catalog-layout" :aria-busy="loading">
        <aside class="category-sidebar" aria-label="按用途分类">
          <header><span>按用途分类</span><button v-if="canEdit" type="button" :disabled="busy" aria-label="添加用途分类" @click="editCategory()">＋</button></header>
          <button type="button" class="category-choice" :class="{active:categoryId==='all'}" :aria-pressed="categoryId==='all'" :disabled="workspaceBusy || loading" @click="changeCatalogSelection('categoryId','all')"><span class="category-dot all"></span><span>全部数据</span><small>{{catalog.items.length}}</small></button>
          <button v-for="category in catalog.categories" :key="category.id" type="button" class="category-choice" :class="{active:categoryId===category.id}" :aria-pressed="categoryId===category.id" :disabled="workspaceBusy || loading" @click="changeCatalogSelection('categoryId',category.id)"><span class="category-dot" :class="category.id"></span><span>{{category.name}}</span><small>{{countCategory(category.id)}}</small></button>
          <div v-if="currentCategory && currentCategory.id!=='uncategorized' && (canEdit || canDelete)" class="category-actions"><button v-if="canEdit" type="button" :disabled="busy" @click="editCategory(currentCategory)">重命名</button><button v-if="canDelete" type="button" :disabled="busy" @click="deleteCategory(currentCategory)">删除分类</button></div>
          <form v-if="categoryForm" class="category-form" @submit.prevent="saveCategory"><label>{{categoryForm.id?'重命名分类':'新建用途分类'}}<input ref="categoryInput" v-model="categoryForm.name" maxlength="60" required aria-label="用途分类名称" placeholder="例如：能耗管理" :disabled="busy" /></label><div><button type="button" :disabled="busy" @click="categoryForm=null">取消</button><button type="submit" :disabled="busy || !categoryForm.name.trim()">保存</button></div></form>
          <p class="category-note">分类只负责整理数据。删除分类不会删除数据或已绑定的组件。</p>
        </aside>
        <div class="catalog-main">
          <div class="catalog-tools"><label class="catalog-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input :value="query" :disabled="workspaceBusy || loading" @input="changeCatalogInput('query',$event)" type="search" aria-label="搜索数据项" placeholder="搜索名称、单位或适用对象" /></label><select :value="sourceType" :disabled="workspaceBusy || loading" @change="changeCatalogInput('sourceType',$event)" aria-label="筛选数据来源"><option value="all">全部来源</option><option v-for="option in sourceOptions" :key="option" :value="option">{{option}}</option></select><select v-if="previewDevices.length && tableView==='fields'" :value="previewDeviceId" :disabled="workspaceBusy || loading" @change="changeCatalogInput('previewDeviceId',$event)" aria-label="预览设备"><option value="">预览：自动选择设备</option><option v-for="device in previewDevices" :key="device.id" :value="String(device.id)">预览：{{device.name}}</option></select></div>
          <div class="catalog-caption"><span>{{currentCategory?.name || '全部数据'}} <b>{{tables.length}}</b> 张表 <span class="caption-divider">·</span> <b>{{items.length}}</b> 个数据项</span><small>{{loading?'正在读取…':'只显示当前工厂实际已有的数据'}}</small></div>
          <div v-if="tables.length" class="table-cards" aria-label="选择数据表"><button v-for="table in tables" :key="table.id" type="button" class="table-card" :class="{active:selectedTable?.id===table.id}" :aria-pressed="selectedTable?.id===table.id" :disabled="workspaceBusy || loading" @click="changeCatalogSelection('selectedTableId',table.id)"><span class="table-card-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M10 10v10M3 15h18"/></svg></span><strong>{{table.name}}</strong><span class="table-card-meta">{{dataCenterSourceLabel(table.sourceType)}}<i>·</i>{{countTable(table.id)}} 项</span><small>{{table.description || table.objectScope || '随当前对象读取，保持真实数据绑定'}}</small></button></div>
          <section v-if="selectedTable" class="fields-section" aria-label="数据表字段">
            <header><div><h4>{{selectedTable.name}}</h4><p>{{tableView==='fields' ? '字段目录整理名称与分类；右侧切换数据浏览，查看实际记录。' : '按对象和数据项查看实际记录，不修改原始数据或组件绑定。'}}</p></div><div class="table-view-switch" role="group" aria-label="数据表查看方式"><button type="button" :aria-pressed="tableView==='fields'" :class="{active:tableView==='fields'}" :disabled="workspaceBusy || loading" @click="changeTableView('fields')">字段目录</button><button type="button" :aria-pressed="tableView==='records'" :class="{active:tableView==='records'}" :disabled="workspaceBusy || loading" @click="changeTableView('records')">数据浏览</button></div></header>
            <template v-if="tableView==='fields'">
            <p v-if="selectedTable.sourceType==='dataset'" class="field-sample-note" role="status">{{sampleLoading?'正在读取实际核对样本…':sampleHint || '尚未读取核对样本'}}<span v-if="sampleReadAt" :title="fullRecordTime(sampleReadAt)">本次读取 {{recordTime(sampleReadAt)}}</span></p>
            <div class="fields-scroll"><table class="fields-table"><thead><tr><th>数据项</th><th>用途分类</th><th>适用对象</th><th>预览值</th><th>读取状态</th><th v-if="canEdit" class="field-operation">整理</th></tr></thead>
              <tbody><tr v-for="item in displayedTableItems" :key="item.id" :data-field-id="item.id" :class="{'field-row-editing':fieldForm?.id===item.id}" :aria-busy="fieldForm?.id===item.id && busy">
                <td><input v-if="fieldForm?.id===item.id" :ref="setFieldInput" v-model="fieldForm.label" class="field-inline-input" required maxlength="100" aria-label="数据项显示名称" :aria-invalid="failed" :disabled="workspaceBusy" @keydown="fieldKeys" /><strong v-else>{{item.label}}</strong><small>{{typeLabels[item.type] || '数据'}}{{item.unit?' · '+item.unit:''}}</small></td>
                <td><select v-if="fieldForm?.id===item.id" v-model="fieldForm.categoryId" class="field-inline-input" aria-label="数据项用途分类" :disabled="workspaceBusy" @keydown.esc="fieldKeys"><option v-for="category in catalog.categories" :key="category.id" :value="category.id">{{category.name}}</option></select><template v-else>{{catalog.categories.find(category=>category.id===item.categoryId)?.name || '未分类'}}</template></td>
                <td class="field-scope">{{dataCenterObjectLabel(item)}}</td><td class="field-value"><span :title="previewTitle(item)">{{dataCenterPreview(item)}}</span><small v-if="item.unit && dataCenterPreview(item)!=='—'">{{item.unit}}</small></td><td><span class="quality-label" :class="dataCenterQuality(item.quality).key"><i></i>{{selectedTable.sourceType==='dataset' && sampleLoading?'读取中…':dataCenterQuality(item.quality).label}}</span></td>
                <td v-if="canEdit"><div class="field-actions"><template v-if="fieldForm?.id===item.id"><button type="button" class="field-edit field-save" :disabled="workspaceBusy || !fieldForm.label.trim()" :aria-label="`保存数据项 ${item.label}`" title="保存修改" @click="saveField"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button><button type="button" class="field-edit" :disabled="workspaceBusy" :aria-label="`取消编辑数据项 ${item.label}`" title="取消修改（Esc）" @click="cancelField"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></template><button v-else type="button" class="field-edit" :disabled="workspaceBusy || loading" :aria-label="`整理数据项 ${item.label}`" title="编辑显示名称与用途分类，不改变原始值或绑定。" @click="editField(item)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z"/></svg></button></div></td>
              </tr></tbody>
            </table></div><p v-if="!tableItems.length" class="small-empty">这张表暂没有匹配的数据项。</p><footer>预览值只供核对；组件使用动态绑定，不会把这里的读数保存成固定文字。查看多对象的实际值，请切换「数据浏览」。</footer>
            </template>
            <DataTableBrowser v-else :key="`${browseFactoryId}:${selectedTable.id}`" :factory-id="browseFactoryId" :table="selectedTable" :devices="previewDevices" />
          </section>
          <div v-else class="catalog-empty"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="10" width="34" height="29" rx="5"/><path d="M7 20h34M20 20v19M7 30h34"/></svg><h4>{{loading?'正在收集已有数据…':query || sourceType!=='all'?'没有找到匹配的数据':'这个分类还没有数据'}}</h4><p>{{query || sourceType!=='all'?'试试其他名称，或切换到全部来源。':'已有设备资料和采集点位会自动出现，也可以接入外部数据后创建数据表。'}}</p><button v-if="!loading && sections.some(section=>section.key==='sources')" type="button" class="center-button" @click="emit('navigate','sources')">去接入数据</button></div>
        </div>
      </div>
    </div>
    <div v-else :id="`data-center-panel-${activeContentSection}`" role="region" :aria-label="activeRegionLabel" class="center-slot"><div v-if="activeSection==='table-editor'" class="external-table-guide"><button type="button" @click="emit('navigate','tables')">‹ 返回统一数据表</button><span>外部数据配置好后，字段会自动出现在数据表目录和设计器选项中。</span></div><slot /></div>
  </section>
</template>

<style scoped>
.field-sample-note { margin:0; padding:10px 16px; font-size:calc(13px * var(--admin-font-scale,1)); line-height:1.6; color:#52637a; background:#f7faff; border-bottom:1px solid #e6edf7; }
.field-sample-note span { margin-left:12px; white-space:nowrap; }
.data-center { color:#24364b; font-size:calc(15px * var(--admin-font-scale,1)); line-height:1.6; width:100%; min-width:0; }
.catalog-topline { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:18px; margin-bottom:20px; }
.catalog-topline h3 { margin:0 0 7px; font-size:calc(19px * var(--admin-font-scale,1)); font-weight:600; }
.catalog-topline p { margin:0; color:#526177; font-size:calc(14px * var(--admin-font-scale,1)); }
.catalog-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.center-button { display:flex; align-items:center; justify-content:center; gap:7px; min-height:calc(42px * var(--admin-font-scale,1)); box-sizing:border-box; padding:9px 14px; border:1px solid #cbd5e3; border-radius:7px; background:#fff; color:#40546f; font:inherit; font-size:calc(14px * var(--admin-font-scale,1)); font-weight:500; cursor:pointer; white-space:nowrap; }
.center-button svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6; }
.center-button.primary { color:#fff; background:#2b5db6; border-color:#2b5db6; box-shadow:0 2px 3px #2459a613; }
.center-button:hover { border-color:#658ac4; }
.center-button.primary:hover { background:#224f9f; }
.catalog-layout { display:grid; grid-template-columns:210px minmax(0,1fr); border:1px solid #dce3ed; border-radius:11px; overflow:hidden; background:#fff; min-height:510px; }
.category-sidebar { padding:20px 13px; background:#f7f9fc; border-right:1px solid #e0e6ef; }
.category-sidebar>header { display:flex; align-items:center; justify-content:space-between; padding:0 10px 16px; color:#40546f; font-size:calc(14px * var(--admin-font-scale,1)); font-weight:600; }
.category-sidebar>header button { border:0; background:none; color:#2459a6; font-size:calc(22px * var(--admin-font-scale,1)); cursor:pointer; line-height:1; }
.category-choice { display:flex; align-items:center; gap:9px; width:100%; margin-bottom:5px; padding:12px 10px; border:0; border-radius:7px; text-align:left; background:none; color:#40546f; font:inherit; font-size:calc(14px * var(--admin-font-scale,1)); cursor:pointer; }
.category-choice>span:nth-child(2) { flex:1; min-width:0; overflow-wrap:anywhere; }
.category-choice small { color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); }
.category-choice.active { background:#eaf1ff; color:#2459a6; font-weight:600; }
.category-choice.active small { color:#2459a6; }
.category-choice:hover { background:#eef3fb; }
.category-dot { width:7px; height:7px; border-radius:2px; flex:none; background:#76859b; }
.category-dot.all,.category-dot.device { background:#456fb2; }
.category-dot.realtime { background:#3c8871; }
.category-dot.production { background:#8b64ac; }
.category-dot.alarms { background:#b9515a; }
.category-dot.parts { background:#a27a27; }
.category-dot.uncategorized { background:#8490a2; }
.category-actions { display:flex; flex-wrap:wrap; justify-content:space-between; gap:10px; padding:14px 10px 8px; }
.category-actions button { background:none; border:0; padding:3px 0; color:#526177; font:inherit; font-size:calc(14px * var(--admin-font-scale,1)); cursor:pointer; }
.category-actions button:hover { color:#2459a6; }
.category-note { margin:23px 10px 0; padding-top:16px; border-top:1px solid #dfe6ef; color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); line-height:1.8; }
.category-form { padding:14px 10px; border-top:1px solid #dfe6ef; margin-top:8px; }
.category-form label { display:grid; gap:8px; font-size:calc(14px * var(--admin-font-scale,1)); color:#40546f; }
.category-form input { width:100%; box-sizing:border-box; }
.category-form>div { display:flex; justify-content:flex-end; gap:14px; margin-top:12px; }
.category-form button { padding:3px 0; border:0; background:none; color:#2459a6; font:inherit; font-size:calc(14px * var(--admin-font-scale,1)); cursor:pointer; }
.catalog-main { padding:22px; min-width:0; }
.catalog-tools { display:flex; align-items:center; gap:10px; }
.catalog-search { display:flex; align-items:center; gap:9px; flex:1; min-width:120px; border:1px solid #cbd5e3; border-radius:7px; padding:0 12px; height:calc(42px * var(--admin-font-scale,1)); box-sizing:border-box; }
.catalog-search svg { flex:none; width:17px; height:17px; fill:none; stroke:#65748a; stroke-width:1.6; }
.catalog-search input { min-width:0; width:100%; height:100%; border:0; background:none; padding:0; outline:0; }
.catalog-tools select { min-height:calc(42px * var(--admin-font-scale,1)); max-width:240px; }
.data-center input,.data-center select { font:inherit; font-size:calc(15px * var(--admin-font-scale,1)); color:#24364b; }
.data-center input::placeholder { color:#65748a; }
.data-center input:not(.catalog-search input),.data-center select { padding:9px 10px; border:1px solid #cbd5e3; border-radius:6px; background:#fff; min-width:0; }
.catalog-caption { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; margin:20px 0 14px; color:#526177; font-size:calc(14px * var(--admin-font-scale,1)); }
.catalog-caption b { font-weight:600; color:#30465e; margin:0 2px; }
.catalog-caption>small { color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); }
.caption-divider { margin:0 6px; color:#65748a; }
.table-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; margin-bottom:22px; max-height:280px; overflow:auto; padding:1px; }
.table-card { position:relative; display:grid; grid-template-columns:32px minmax(0,1fr); align-items:center; column-gap:10px; row-gap:7px; padding:16px; border:1px solid #dce3ed; border-radius:8px; background:#fff; text-align:left; font:inherit; cursor:pointer; min-width:0; }
.table-card.active { border-color:#658ac4; background:#f8faff; box-shadow:0 0 0 1px #dbe6f7 inset; }
.table-card:hover { border-color:#658ac4; }
.table-card-icon { grid-row:1 / 3; display:grid; place-items:center; width:32px; height:36px; border-radius:7px; background:#eef2f8; color:#456a9d; }
.table-card.active .table-card-icon { background:#eaf1ff; color:#2459a6; }
.table-card-icon svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.5; }
.table-card strong { color:#30465e; font-size:calc(15px * var(--admin-font-scale,1)); font-weight:600; overflow-wrap:anywhere; line-height:1.5; }
.table-card-meta { color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); }
.table-card-meta i { font-style:normal; margin:0 6px; color:#65748a; }
.table-card>small { grid-column:1 / -1; color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); line-height:1.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fields-section { border:1px solid #dfe6ef; border-radius:8px; overflow:hidden; }
.fields-section>header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:18px 16px; border-bottom:1px solid #e0e7f0; }
.fields-section>header>div:first-child { flex:1; min-width:190px; }
.table-view-switch { display:flex; align-items:center; flex:none; gap:3px; padding:4px; border:1px solid #cbd5e3; border-radius:8px; background:#f3f6fb; }
.table-view-switch button { padding:8px 12px; border:0; border-radius:5px; font:inherit; font-size:calc(14px * var(--admin-font-scale,1)); font-weight:600; white-space:nowrap; color:#40546f; background:none; cursor:pointer; }
.table-view-switch button.active { color:#fff; background:#2b5db6; }
.table-view-switch button:focus-visible { outline:2px solid #2b5db6; outline-offset:2px; }
.fields-section h4 { margin:0 0 6px; font-size:calc(17px * var(--admin-font-scale,1)); color:#30465e; font-weight:600; }
.fields-section header p { margin:0; color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); }
.fields-section header>span { color:#526177; font-size:calc(13px * var(--admin-font-scale,1)); white-space:nowrap; }
.fields-scroll { overflow:auto; max-height:480px; }
.fields-table { width:100%; border-collapse:collapse; font-size:calc(15px * var(--admin-font-scale,1)); text-align:left; line-height:1.6; }
.fields-table th { padding:13px 16px; background:#f5f7fa; color:#40546f; font-size:calc(14px * var(--admin-font-scale,1)); font-weight:600; white-space:nowrap; }
.fields-table td { padding:16px; color:#40546f; border-top:1px solid #e8edf4; vertical-align:middle; }
.fields-table tbody tr:hover { background:#f8faff; }
.fields-table td:first-child { min-width:120px; }
.fields-table td strong { display:block; color:#24364b; font-weight:600; }
.fields-table td:first-child small { display:block; color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); margin-top:5px; }
.field-scope { min-width:95px; max-width:190px; overflow-wrap:anywhere; line-height:1.6; }
.field-value { min-width:70px; max-width:180px; font-variant-numeric:tabular-nums; }
.field-value>span { display:inline-block; max-width:160px; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; white-space:nowrap; color:#24364b; }
.field-value>small { color:#596579; font-size:calc(13px * var(--admin-font-scale,1)); margin-left:5px; }
.quality-label { display:inline-flex; align-items:center; gap:6px; padding:4px 7px; border-radius:5px; background:#f0f3f7; color:#526177; white-space:nowrap; font-size:calc(13px * var(--admin-font-scale,1)); font-weight:500; }
.quality-label i { width:6px; height:6px; border-radius:50%; background:currentColor; }
.quality-label.good { color:#23694b; background:#edf7f1; }
.quality-label.configured { color:#2459a6; background:#eef4ff; }
.quality-label.bad { color:#a72d39; background:#fff1f2; }
.quality-label.stale { color:#805810; background:#fff6e5; }
.field-operation { width:90px; }
.field-actions { display:flex; align-items:center; gap:6px; min-width:36px; }
.field-edit { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; flex:none; padding:7px; border:1px solid transparent; border-radius:6px; background:#eef4ff; color:#2459a6; font:inherit; font-size:calc(14px * var(--admin-font-scale,1)); cursor:pointer; }
.field-edit:hover:not(:disabled) { border-color:#91b2e2; background:#e6efff; }.field-edit svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
.field-save { background:#edf7f1; color:#23694b; }
.field-row-editing,.fields-table tbody tr.field-row-editing:hover { background:#f8faff; }
.data-center .field-inline-input { width:100%; min-width:130px; max-width:220px; font-size:calc(15px * var(--admin-font-scale,1)); color:#24364b; background:#fff; }
.fields-section>footer { border-top:1px solid #e1e7f0; color:#596579; padding:13px 16px; font-size:calc(13px * var(--admin-font-scale,1)); line-height:1.8; }
.catalog-empty { display:grid; justify-items:center; text-align:center; padding:50px 30px; color:#596579; }
.catalog-empty>svg { width:48px; height:48px; fill:none; stroke:#8a9cba; stroke-width:1.3; margin-bottom:14px; }
.catalog-empty h4 { font-size:calc(17px * var(--admin-font-scale,1)); font-weight:600; color:#40546f; margin:0 0 9px; }
.catalog-empty p { font-size:calc(14px * var(--admin-font-scale,1)); line-height:1.8; max-width:430px; margin:0 0 20px; }
.small-empty { text-align:center; padding:18px; color:#596579; font-size:calc(14px * var(--admin-font-scale,1)); }
.center-message { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:13px 16px; border:1px solid #c8e1d2; border-radius:7px; background:#edf7f1; color:#23694b; margin:0 0 16px; font-size:calc(14px * var(--admin-font-scale,1)); }
.center-message.error { border-color:#efc9ce; background:#fff1f2; color:#a72d39; }
.center-message button { border:0; background:none; color:inherit; cursor:pointer; font:inherit; }
.center-slot { min-width:0; }
.external-table-guide { display:flex; align-items:center; gap:16px; padding:14px 16px; margin-bottom:20px; border:1px solid #dce5f2; border-radius:8px; background:#f8faff; font-size:calc(14px * var(--admin-font-scale,1)); color:#526177; }
.external-table-guide button { border:0; background:none; color:#2459a6; font:inherit; padding:0; cursor:pointer; white-space:nowrap; }
.data-center button:disabled,.data-center input:disabled,.data-center select:disabled { opacity:.55; cursor:default; }
.data-center button:focus-visible { outline:2px solid #2b5db6; outline-offset:3px; }
.data-center input:focus,.data-center select:focus { outline:0; border-color:#2b5db6; box-shadow:0 0 0 2px #2b5db620; }
.catalog-search:focus-within { border-color:#2b5db6; }
@media(max-width:1150px) {
  .catalog-layout { grid-template-columns:190px minmax(0,1fr); }
  .catalog-main { padding:16px; }
  .catalog-tools { flex-wrap:wrap; }
  .catalog-search { flex-basis:100%; }
  .catalog-tools select { flex:1; max-width:none; }
  .catalog-caption>small { display:none; }
}
@media(max-width:760px) {
  .catalog-topline { align-items:flex-start; flex-direction:column; }
  .catalog-layout { grid-template-columns:minmax(0,1fr); }
  .category-sidebar { border-right:0; border-bottom:1px solid #e0e6ef; display:flex; gap:4px; flex-wrap:wrap; padding:12px; }
  .category-sidebar>header { width:100%; padding:0 5px 8px; }
  .category-choice { width:auto; padding:10px; }
  .category-note { width:100%; margin:6px 5px; padding-top:8px; }
  .category-form { width:100%; }
  .category-actions { padding:8px; }
  .table-cards { grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); }
  .external-table-guide { flex-direction:column; align-items:flex-start; gap:8px; }
}
</style>
