<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { catalogMatchesBinding, filterCatalogItems, catalogPreview, DATA_CATALOG_SOURCE_LABELS } from '../../../runtime/dataCatalog.js'

const props = defineProps({ binding: Object, factoryId: String, deviceId: String, tooltip: Boolean, kind: { type: String, default: 'device' }, widgetType: String, mapContext: Boolean, disabled: Boolean, immediate: Boolean })
const emit = defineEmits(['select'])
const catalog = ref({ categories: [], tables: [], items: [] }), loading = ref(false), error = ref('')
const categoryId = ref(''), tableId = ref(''), chosenId = ref('')
let sequence = 0, disposed = false, loadedScope = ''
const options = computed(() => ({ tooltip: props.tooltip, kind: props.kind, widgetType: props.widgetType, mapContext: props.mapContext }))
const items = computed(() => filterCatalogItems(catalog.value.items, { ...options.value, categoryId: categoryId.value, tableId: tableId.value }))
const tables = computed(() => catalog.value.tables.filter(table => catalog.value.items.some(item => item.tableId === table.id && filterCatalogItems([item], { ...options.value, categoryId: categoryId.value }).length)))
const chosen = computed(() => items.value.find(item => item.id === chosenId.value))
const current = computed(() => catalog.value.items.find(item => catalogMatchesBinding(item, props.binding, options.value)))
async function load() {
  const request = ++sequence; loading.value = true; error.value = ''
  const scope = `${props.factoryId || ''}\n${props.deviceId || ''}`
  if (loadedScope !== scope) { catalog.value = { categories: [], tables: [], items: [] }; chosenId.value = ''; loadedScope = scope }
  try {
    const response = await adminApi.getDataCenterCatalog({ ...(props.tooltip ? { deviceId: props.deviceId || '' } : { previewDeviceId: props.deviceId || '' }), factoryId: props.factoryId || '' })
    if (disposed || request !== sequence) return
    if (response.error || response.success === false) throw new Error(response.error || '数据目录读取失败')
    const sourceTables = response.tables || []
    const sourceItems = (response.items || []).map(item => ({ ...item, tableName: item.tableName || sourceTables.find(table => table.id === item.tableId)?.name || '' }))
    catalog.value = { categories: response.categories || [], tables: sourceTables, items: sourceItems }
    if (!catalog.value.categories.some(item => item.id === categoryId.value)) categoryId.value = ''
    if (!tables.value.some(item => item.id === tableId.value)) tableId.value = ''
  } catch (failure) { if (!disposed && request === sequence) { error.value = failure.message || '数据目录读取失败'; catalog.value = { categories: [], tables: [], items: [] }; chosenId.value = '' } }
  finally { if (!disposed && request === sequence) loading.value = false }
}
function choose() {
  if (props.disabled || !chosen.value) return
  emit('select', chosen.value)
}
watch(items, () => { if (chosenId.value && !items.value.some(item => item.id === chosenId.value)) chosenId.value = '' })
watch([categoryId, tableId], () => { if (!items.value.some(item => item.id === chosenId.value)) chosenId.value = '' })
watch(categoryId, () => { if (!tables.value.some(item => item.id === tableId.value)) tableId.value = '' })
watch(() => [props.factoryId, props.deviceId], load)
watch(chosenId, () => { if (props.immediate) { if (chosenId.value) choose(); else emit('select', null) } })
onMounted(() => { load(); window.addEventListener('digital-twin-data-center-changed', load); window.addEventListener('digital-twin-data-sets-changed', load) })
onBeforeUnmount(() => { disposed = true; sequence++; window.removeEventListener('digital-twin-data-center-changed', load); window.removeEventListener('digital-twin-data-sets-changed', load) })
</script>
<template>
  <section class="data-catalog-picker" aria-label="数据中心选取数据">
    <header><strong>选择数据</strong><button type="button" :disabled="loading" aria-label="刷新数据中心目录" @click="load"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg></button></header>
    <p>在数据中心整理一次，这里直接选取。{{ tooltip ? '数据随当前悬停对象变化。' : '原有绑定会保留，选取新数据后才替换。' }}</p>
    <small v-if="current" class="catalog-current">已绑定：{{ current.tableName || catalog.tables.find(table => table.id === current.tableId)?.name }} / {{ current.label }}</small>
    <fieldset :disabled="disabled || loading">
      <label>用途分类<select v-model="categoryId" aria-label="数据用途分类"><option value="">全部分类</option><option v-for="category in catalog.categories" :key="category.id" :value="category.id">{{ category.name }}</option></select></label>
      <label>数据表<select v-model="tableId" aria-label="选择数据表"><option value="">全部数据表</option><option v-for="table in tables" :key="table.id" :value="table.id">{{ table.name }}</option></select></label>
      <label>具体数据<select v-model="chosenId" aria-label="选择具体数据"><option value="">{{ loading ? '正在读取数据目录…' : '请选择数据项' }}</option><option v-for="item in items" :key="item.id" :value="item.id">{{ item.label }}{{ item.unit ? ` · ${item.unit}` : '' }}{{ item.deviceName ? ` · ${item.deviceName}` : '' }}{{ !tableId && item.tableName ? ` · ${item.tableName}` : '' }}</option></select></label>
      <div v-if="chosen" class="catalog-detail"><strong>{{ chosen.label }}</strong><span>{{ DATA_CATALOG_SOURCE_LABELS[chosen.sourceType] || '数据表' }} · {{ tooltip ? chosen.tooltipBinding?.deviceScope === 'global' ? '工厂范围 · 不随悬停对象变化' : `当前悬停${kind === 'part' ? '部件／所属设备' : '设备'}` : chosen.deviceName || ({ factory: '工厂范围', device: '设备范围', part: '部件范围' })[chosen.objectScope] || '当前对象' }}</span><span>预览：{{ catalogPreview(chosen) }} <small>{{ chosen.quality === 'good' ? '读取正常' : '以实际运行读取为准' }}</small></span></div>
      <button v-if="!immediate" type="button" class="catalog-apply" :disabled="!chosen" @click="choose">使用所选数据</button>
    </fieldset>
    <p v-if="error" class="catalog-error" role="alert">{{ error }} <button type="button" @click="load">重试</button></p>
    <p v-else-if="!loading && !items.length" class="catalog-empty">没有匹配的可用数据。请先在「数据中心」接入数据或配置只读点位；未接入的数据不会出现在这里。</p>
  </section>
</template>
<style scoped>
.data-catalog-picker{display:grid;gap:10px;padding:13px;border:1px solid #dce6f3;border-radius:9px;background:linear-gradient(135deg,#f8faff,#fff);font-size:12px;color:#41536d;min-width:0}.data-catalog-picker header{display:flex;justify-content:space-between;align-items:center}.data-catalog-picker header strong{font-weight:600;color:#335880}.data-catalog-picker header button{width:24px;height:24px;display:grid;place-items:center;border:0;background:none;color:#7b92b3;cursor:pointer}.data-catalog-picker svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6}.data-catalog-picker p{font-size:11px;line-height:1.6;margin:0;color:#8491a5}.data-catalog-picker fieldset{display:grid;gap:10px;padding:0;margin:0;border:0;min-width:0}.data-catalog-picker label{display:grid;gap:5px;font-size:11px;color:#7c899e;margin:0}.data-catalog-picker select{box-sizing:border-box;width:100%;min-width:0;max-width:100%;height:34px;padding:6px 8px;border:1px solid #dce2ec;border-radius:6px;background:#fff;color:#40516a;font:inherit;font-size:12px}.data-catalog-picker select:focus{outline:2px solid #9bbfea;outline-offset:1px}.catalog-detail{display:grid;gap:5px;padding:9px;background:#eef4fd;border-radius:6px;line-height:1.6;font-size:11px;overflow-wrap:anywhere}.catalog-detail small{color:#8b98ad}.catalog-current{padding:7px 8px;border-radius:5px;color:#6080ab;background:#edf3fc;overflow-wrap:anywhere;line-height:1.6}.data-catalog-picker .catalog-apply{background:#356bc5;border:1px solid #356bc5;border-radius:6px;padding:8px;color:white;font:inherit;font-weight:500;cursor:pointer}.data-catalog-picker button:disabled{opacity:.45;cursor:default}.data-catalog-picker .catalog-error{color:#b05459}.catalog-error button{color:inherit;border:0;background:none;text-decoration:underline;cursor:pointer}.catalog-empty{padding:6px 0}.data-catalog-picker button:focus-visible{outline:2px solid #9bbfea;outline-offset:2px}
</style>
