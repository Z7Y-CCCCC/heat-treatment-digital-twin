<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { dataCenterQuality } from '../utils/dataCenterCatalog.js'
import { browserRequest, dataBrowserErrorMessage, fullRecordTime, localDateInput, numericHistoryTrend, recordTime, recordValue, recordValueTitle, validateHistoryRange } from '../utils/dataTableBrowser.js'

const props = defineProps({ factoryId: String, table: Object, devices: { type: Array, default: () => [] } })
const records = ref([]), fields = ref([]), parts = ref([]), capabilities = ref({ history: false, deviceRequired: false, partRequired: false, searchSupportsValue: false })
const loading = ref(false), failed = ref(''), notice = ref(''), readAt = ref('')
const mode = ref('current'), query = ref(''), appliedQuery = ref(''), deviceId = ref(''), partId = ref(''), fieldId = ref('')
const page = ref(1), pageSize = ref(20), total = ref(0), hasMore = ref(false), autoRefresh = ref(false)
const start = ref(localDateInput(Date.now() - 3600000)), end = ref(localDateInput())
let generation = 0, disposed = false, timer = null, requestController = null
const selectedField = computed(() => fields.value.find(field => field.id === fieldId.value))
const objectOptions = computed(() => props.table?.sourceType === 'dataset' && props.table?.objectScope === 'factory' ? [] : props.table?.deviceId ? props.devices.filter(device => String(device.id) === String(props.table.deviceId)) : props.devices)
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const rangeStart = computed(() => records.value.length ? (page.value - 1) * pageSize.value + 1 : 0)
const rangeEnd = computed(() => records.value.length ? rangeStart.value + records.value.length - 1 : 0)
const trend = computed(() => mode.value === 'history' && selectedField.value?.type === 'number' ? numericHistoryTrend(records.value, fieldId.value) : null)
const objectColumn = computed(() => props.table?.objectScope === 'part' ? '部件' : '对象')

async function load() {
  if (disposed || !props.factoryId || !props.table?.id) return false
  if (mode.value === 'history') {
    const error = validateHistoryRange(start.value, end.value)
    if (error) { failed.value = error; return false }
  }
  const version = ++generation, context = `${props.factoryId}\n${props.table.id}`
  requestController?.abort(); const controller = new AbortController(); requestController = controller
  const timeout = setTimeout(() => controller.abort(), 15000)
  const request = browserRequest({ tableId: props.table.id, factoryId: props.factoryId, mode: mode.value, q: appliedQuery.value,
    deviceId: deviceId.value, partId: partId.value, fieldId: fieldId.value, page: page.value, pageSize: pageSize.value, start: start.value, end: end.value })
  request.signal = controller.signal
  loading.value = true; failed.value = ''
  try {
    const response = await adminApi.getDataTableRecords(request)
    if (disposed || version !== generation || context !== `${props.factoryId}\n${props.table?.id}`) return false
    if (response.error || response.success === false) throw Object.assign(new Error(response.error || '实际数据读取失败，请重试。'), { status: response.status })
    records.value = response.records || []; fields.value = response.fields || []; parts.value = response.parts || []
    capabilities.value = { history: response.capabilities?.history === true, deviceRequired: response.capabilities?.deviceRequired === true,
      partRequired: response.capabilities?.partRequired === true, searchSupportsValue: response.capabilities?.searchSupportsValue === true }
    total.value = Number(response.total) || 0; hasMore.value = response.hasMore === true
    page.value = Number(response.page) || request.page; pageSize.value = Number(response.pageSize) || request.pageSize
    readAt.value = response.readAt || ''; notice.value = response.notice || ''
    return true
  } catch (error) {
    if (!disposed && version === generation) failed.value = dataBrowserErrorMessage(error)
    return false
  } finally { clearTimeout(timeout); if (!disposed && version === generation) { loading.value = false; requestController = null } }
}

function clearResults() {
  records.value = []; total.value = 0; hasMore.value = false; readAt.value = ''; notice.value = ''; failed.value = ''
}
async function changeFilter(key, value) {
  if (loading.value) return false
  if (key === 'field') fieldId.value = value
  else if (key === 'device') { deviceId.value = value; partId.value = ''; parts.value = [] }
  else if (key === 'part') partId.value = value
  else if (key === 'size') pageSize.value = Number(value)
  else return false
  page.value = 1; clearResults(); return load()
}
async function search() { if (loading.value) return false; appliedQuery.value = query.value.trim(); page.value = 1; clearResults(); return load() }
async function changeMode(next) {
  if (loading.value || next === mode.value || next === 'history' && !capabilities.value.history) return false
  mode.value = next; autoRefresh.value = false; page.value = 1; clearResults(); return load()
}
async function changePage(next) { if (loading.value || next < 1 || next > pages.value) return false; page.value = next; clearResults(); return load() }
async function queryHistory() { if (loading.value) return false; appliedQuery.value = query.value.trim(); page.value = 1; clearResults(); return load() }
async function refresh() { if (loading.value) return false; return load() }
function reset() {
  generation++; requestController?.abort(); requestController = null; records.value = []; fields.value = []; parts.value = []; total.value = 0; hasMore.value = false; readAt.value = ''
  failed.value = ''; notice.value = ''; capabilities.value = { history: false, deviceRequired: false, partRequired: false, searchSupportsValue: false }; loading.value = false
  mode.value = 'current'; query.value = ''; appliedQuery.value = ''; deviceId.value = ''; partId.value = ''; fieldId.value = ''
  page.value = 1; autoRefresh.value = false; start.value = localDateInput(Date.now() - 3600000); end.value = localDateInput()
  void load()
}
watch([() => props.factoryId, () => props.table?.id], reset, { immediate: true })
watch(() => props.table, (table, previous) => { if (table?.id && table.id === previous?.id) { clearResults(); void load() } }, { deep: true })
onMounted(() => { timer = setInterval(() => { if (autoRefresh.value && mode.value === 'current' && !loading.value && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) void load() }, 5000) })
onBeforeUnmount(() => { disposed = true; generation++; requestController?.abort(); if (timer) clearInterval(timer) })
defineExpose({ load, isBusy: loading })
</script>

<template>
  <section class="data-browser" data-testid="data-table-browser" aria-label="数据表实际记录浏览" :aria-busy="loading">
    <div class="browser-toolbar">
      <div class="browser-modes" aria-label="数据记录类型"><button type="button" :class="{active:mode==='current'}" :aria-pressed="mode==='current'" :disabled="loading" @click="changeMode('current')">当前数据</button><button v-if="capabilities.history" type="button" :class="{active:mode==='history'}" :aria-pressed="mode==='history'" :disabled="loading" @click="changeMode('history')">历史记录</button></div>
      <div class="browser-refresh"><label v-if="mode==='current'" class="auto-refresh"><input v-model="autoRefresh" type="checkbox" aria-label="自动刷新当前数据" />每 5 秒刷新</label><button type="button" class="browser-button" :disabled="loading" @click="refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg>{{loading?'读取中…':'刷新数据'}}</button></div>
    </div>
    <p class="browser-description">{{mode==='history'?'按来源记录时间筛选实际返回的数据，不生成采样值。':'这里显示实际对象的数据，不是字段配置中的单个预览样本。'}}<span v-if="readAt" :title="fullRecordTime(readAt)">本次读取 {{recordTime(readAt)}}</span></p>
    <form class="browser-filters" @submit.prevent="search">
      <label v-if="objectOptions.length && !table?.deviceId">对象<select :value="deviceId" aria-label="浏览对象" :disabled="loading" @change="changeFilter('device',$event.target.value)"><option value="">{{capabilities.deviceRequired?'请选择设备':'全部对象'}}</option><option v-for="device in objectOptions" :key="device.id" :value="String(device.id)">{{device.name || device.id}}</option></select></label>
      <label v-if="capabilities.partRequired || table?.sourceType==='dataset' && table?.objectScope==='part'">部件<select :value="partId" aria-label="浏览部件" :disabled="loading || !deviceId || !parts.length" @change="changeFilter('part',$event.target.value)"><option value="">{{!deviceId?'请先选择设备':parts.length?'请选择部件':'该设备暂无部件'}}</option><option v-for="part in parts" :key="part.id" :value="part.id">{{part.name || part.id}}</option></select></label>
      <label>数据项<select :value="fieldId" aria-label="浏览数据项" :disabled="loading || !fields.length" @change="changeFilter('field',$event.target.value)"><option value="">全部数据项</option><option v-for="field in fields" :key="field.id" :value="field.id">{{field.label}}{{field.unit?' · '+field.unit:''}}</option></select></label>
      <label class="record-search">搜索<input v-model="query" type="search" maxlength="100" aria-label="搜索数据记录" :placeholder="capabilities.searchSupportsValue?'对象、数据项或实际值':'对象或数据项名称'" :disabled="loading" /></label><button type="submit" class="browser-button" :disabled="loading">搜索</button>
    </form>
    <form v-if="mode==='history'" class="history-range" @submit.prevent="queryHistory"><label>开始时间<input v-model="start" type="datetime-local" aria-label="历史开始时间" :disabled="loading" /></label><label>结束时间<input v-model="end" type="datetime-local" aria-label="历史结束时间" :disabled="loading" /></label><button type="submit" class="browser-button primary" :disabled="loading">查询历史</button></form>
    <div v-if="failed" class="browser-message error" role="alert">{{failed}}<span v-if="records.length">下面保留上次成功读取的记录，并非本次最新结果。</span><button type="button" :disabled="loading" @click="refresh">重试</button></div>
    <p v-if="notice" class="browser-message" role="status">{{notice}}</p>
    <p v-if="!loading && !capabilities.history && mode==='current'" class="browser-boundary">当前表没有可用的历史存储，只展示实际读取的当前数据。</p>
    <div v-if="mode==='history' && trend" class="browser-trend" aria-label="本页数值历史趋势"><header><strong>{{selectedField.label}} · 本页历史趋势</strong><span>{{trend.points.length}} 个实际采样点{{selectedField.unit?' · '+selectedField.unit:''}}</span></header><div class="trend-plot"><div class="trend-values"><span>{{recordValue(trend.max)}}</span><span>{{recordValue(trend.min)}}</span></div><svg :viewBox="`-6 -6 ${trend.width+12} ${trend.height+12}`" preserveAspectRatio="none" role="img" :aria-label="`${selectedField.label}本页实际采样趋势`"><path :d="`M0 0H${trend.width}M0 ${trend.height/2}H${trend.width}M0 ${trend.height}H${trend.width}`" class="trend-grid"/><polyline v-for="(segment,index) in trend.segments" :key="index" :points="segment"/><circle v-for="(point,index) in trend.points" :key="`${point.id}-${index}`" :cx="point.x" :cy="point.y" r="3"><title>{{fullRecordTime(point.time)}} · {{point.value}}{{selectedField.unit}}</title></circle></svg></div><footer><span>{{recordTime(trend.start)}}</span><span>{{recordTime(trend.end)}}</span></footer><p>趋势仅对应本页记录；翻页查看其他记录。异常采样不连接成连续曲线。</p></div>
    <p v-else-if="mode==='history'" class="browser-boundary">{{selectedField?.type==='number'?'本页没有可绘制的正常数值采样。':'选择一个数值数据项，可查看本页实际采样趋势。'}}</p>
    <div class="browser-records-scroll"><table class="browser-records"><colgroup><col class="col-object"/><col class="col-field"/><col class="col-value"/><col class="col-time"/><col class="col-quality"/></colgroup><thead><tr><th>{{objectColumn}}</th><th>数据项</th><th>{{failed?'上次成功读取值':mode==='history'?'历史值':'实际值'}}</th><th>更新时间</th><th>读取状态</th></tr></thead><tbody><tr v-for="row in records" :key="row.id" :data-record-id="row.id" :data-field-id="row.fieldId"><td><span class="record-object" :title="row.objectPath || row.objectName || row.objectId">{{row.objectName || row.objectId || '—'}}</span></td><td><span :title="row.fieldName">{{row.fieldName || '—'}}</span></td><td class="record-value"><div class="record-value-line" :title="`${recordValueTitle(row.value,row)}${row.unit && row.value!=null ? ' ' + row.unit : ''}`"><span>{{recordValue(row.value,row)}}</span><small v-if="row.unit && row.value!=null" :title="row.unit">{{row.unit}}</small></div></td><td class="record-time"><time :datetime="row.updatedAt" :title="fullRecordTime(row.updatedAt)">{{recordTime(row.updatedAt)}}</time></td><td><span class="record-quality" :class="dataCenterQuality(row.quality).key" :title="dataCenterQuality(row.quality).label"><i aria-hidden="true"></i><span>{{dataCenterQuality(row.quality).label}}</span></span></td></tr></tbody></table><div v-if="!records.length" class="browser-empty" role="status"><strong>{{loading?'正在读取实际数据…':failed?'暂时无法读取记录':'暂无实际记录'}}</strong><p>{{loading?'请稍候。':failed?'请检查连接或时间范围后重试。':mode==='history'?'当前范围没有来源返回的记录，请调整时间或筛选条件。':'当前筛选没有匹配记录；可以清空搜索或切换数据项。'}}</p></div></div>
    <footer class="browser-pagination"><span>共 {{total}} 条数据值<span v-if="records.length">，显示 {{rangeStart}}–{{rangeEnd}} 条</span></span><div><label>每页<select :value="pageSize" aria-label="数据浏览每页条数" :disabled="loading" @change="changeFilter('size',$event.target.value)"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select></label><button type="button" class="browser-button" :disabled="loading || page<=1" @click="changePage(page-1)">上一页</button><span class="page-indicator">{{page}} / {{pages}}</span><button type="button" class="browser-button" :disabled="loading || !hasMore" @click="changePage(page+1)">下一页</button></div></footer>
    <p class="browser-readonly-note">数据浏览为只读，不修改设备资料、采集点位或设计器绑定。无更新时间或异常状态不会被当作正常的新数据。</p>
  </section>
</template>

<style scoped>
.data-browser{min-width:0;color:#24364b;font-size:calc(14px * var(--admin-font-scale,1));line-height:1.6;background:#fff;padding:16px}.browser-toolbar,.browser-refresh,.browser-pagination,.browser-pagination>div{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.browser-modes{display:inline-flex;gap:3px;background:#f0f3f8;border:1px solid #d6deeb;border-radius:7px;padding:3px}.browser-modes button{padding:7px 13px;border:0;border-radius:5px;background:transparent;color:#526177;font:inherit;cursor:pointer}.browser-modes button.active{color:#2459a6;background:#fff;box-shadow:0 1px 4px #274b7920;font-weight:600}.browser-refresh{justify-content:flex-end;gap:10px}.auto-refresh{display:flex;align-items:center;gap:6px;color:#526177;font-size:calc(13px * var(--admin-font-scale,1));cursor:pointer}.auto-refresh input{accent-color:#2b5db6;width:15px;height:15px}.browser-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:7px 11px;border:1px solid #cbd5e3;border-radius:6px;background:#fff;color:#40546f;font:inherit;font-size:calc(13px * var(--admin-font-scale,1));font-weight:500;white-space:nowrap;cursor:pointer}.browser-button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.6}.browser-button.primary{background:#2b5db6;border-color:#2b5db6;color:#fff}.browser-description{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin:14px 0;color:#526177;font-size:calc(13px * var(--admin-font-scale,1))}.browser-description>span{white-space:nowrap;font-variant-numeric:tabular-nums}.browser-filters,.history-range{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:14px}.browser-filters>label,.history-range>label{display:grid;gap:5px;min-width:0;flex:1 1 130px;color:#40546f;font-size:calc(13px * var(--admin-font-scale,1))}.browser-filters .record-search{flex:1.4 1 165px}.data-browser select,.data-browser input:not([type=checkbox]){box-sizing:border-box;width:100%;height:37px;min-width:0;max-width:100%;border:1px solid #cbd5e3;border-radius:6px;background:#fff;padding:7px 9px;color:#24364b;font:inherit;font-size:calc(14px * var(--admin-font-scale,1))}.data-browser input::placeholder{color:#65748a}.history-range{border:1px solid #dce5f2;background:#f8faff;padding:12px;border-radius:7px}.history-range>label{flex:1 1 185px}.browser-message{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:10px 12px;border:1px solid #d5e2f4;border-radius:6px;background:#f3f7ff;color:#405a7b;margin:0 0 12px;font-size:calc(13px * var(--admin-font-scale,1));overflow-wrap:anywhere}.browser-message.error{border-color:#efc9ce;background:#fff1f2;color:#a72d39}.browser-message button{border:0;background:none;padding:0;color:inherit;font:inherit;text-decoration:underline;cursor:pointer}.browser-boundary,.browser-readonly-note{margin:0 0 12px;color:#596579;font-size:calc(13px * var(--admin-font-scale,1));line-height:1.7}.browser-records-scroll{overflow-y:auto;overflow-x:hidden;max-height:470px;border:1px solid #dfe6ef;border-radius:7px}.browser-records{width:100%;table-layout:fixed;border-collapse:collapse;text-align:left;font-size:calc(14px * var(--admin-font-scale,1))}.col-object{width:23%}.col-field{width:22%}.col-value{width:20%}.col-time{width:22%}.col-quality{width:13%}.browser-records th{padding:11px 10px;position:sticky;top:0;z-index:1;background:#f5f7fa;color:#40546f;font-size:calc(13px * var(--admin-font-scale,1));font-weight:600;white-space:nowrap}.browser-records td{padding:12px 10px;border-top:1px solid #e8edf4;vertical-align:middle;color:#40546f}.browser-records tr:hover{background:#f8faff}.browser-records td>span:not(.record-quality),.record-time time{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.record-object{color:#24364b;font-weight:500;cursor:default}.record-value{font-variant-numeric:tabular-nums}.record-value-line{display:flex;align-items:center;gap:4px;width:100%;min-width:0;white-space:nowrap}.record-value-line>span{display:block;flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#24364b}.record-value-line>small{flex:0 1 auto;max-width:45%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(13px * var(--admin-font-scale,1));color:#596579}.record-time{font-size:calc(13px * var(--admin-font-scale,1));font-variant-numeric:tabular-nums}.record-quality{display:inline-flex;align-items:center;gap:5px;border-radius:5px;background:#f0f3f7;padding:3px 6px;font-size:calc(13px * var(--admin-font-scale,1));color:#526177;white-space:nowrap}.record-quality{max-width:100%;box-sizing:border-box;overflow:hidden}.record-quality>span{overflow:hidden;text-overflow:ellipsis;min-width:0}.record-quality i{width:5px;height:5px;flex:none;border-radius:50%;background:currentColor}.record-quality.good{color:#23694b;background:#edf7f1}.record-quality.bad{color:#a72d39;background:#fff1f2}.record-quality.stale{color:#805810;background:#fff6e5}.record-quality.configured{color:#2459a6;background:#eef4ff}.browser-empty{text-align:center;padding:35px 16px;color:#596579}.browser-empty strong{font-size:calc(15px * var(--admin-font-scale,1));font-weight:600;color:#40546f}.browser-empty p{font-size:calc(13px * var(--admin-font-scale,1));margin:8px 0 0}.browser-pagination{margin:14px 0 10px;font-size:calc(13px * var(--admin-font-scale,1));color:#526177}.browser-pagination>div{gap:8px;justify-content:flex-end}.browser-pagination label{display:flex;align-items:center;gap:5px}.browser-pagination select{width:65px;height:34px;padding:5px 7px}.browser-pagination .browser-button{min-height:34px;padding:5px 9px}.page-indicator{min-width:40px;text-align:center;font-variant-numeric:tabular-nums}.browser-readonly-note{margin-bottom:0}.browser-trend{padding:12px;border:1px solid #dfe6ef;border-radius:7px;margin-bottom:14px;background:#fbfcff}.browser-trend>header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:calc(13px * var(--admin-font-scale,1));color:#526177;margin-bottom:10px}.browser-trend strong{color:#30465e;font-weight:600}.trend-plot{display:flex;gap:8px;min-width:0}.trend-values{display:flex;flex-direction:column;justify-content:space-between;flex:none;width:48px;color:#596579;font-size:calc(13px * var(--admin-font-scale,1));text-align:right;overflow:hidden}.trend-plot svg{width:calc(100% - 56px);height:145px;overflow:visible;min-width:0}.trend-grid{fill:none;stroke:#e0e7f0;stroke-width:1}.trend-plot polyline{fill:none;stroke:#2b5db6;stroke-width:2;vector-effect:non-scaling-stroke}.trend-plot circle{fill:#2b5db6}.browser-trend>footer{display:flex;justify-content:space-between;gap:10px;margin-left:56px;color:#596579;font-size:calc(13px * var(--admin-font-scale,1))}.browser-trend>p{font-size:calc(13px * var(--admin-font-scale,1));color:#596579;margin:8px 0 0}.data-browser button:disabled,.data-browser input:disabled,.data-browser select:disabled{opacity:.55;cursor:default}.data-browser button:focus-visible{outline:2px solid #2b5db6;outline-offset:2px}.data-browser input:focus,.data-browser select:focus{outline:0;border-color:#2b5db6;box-shadow:0 0 0 2px #2b5db620}@media(max-width:1150px){.data-browser{padding:12px}.browser-records th,.browser-records td{padding-left:7px;padding-right:7px}.browser-records{font-size:calc(13px * var(--admin-font-scale,1))}.record-quality{padding:3px 4px;gap:4px}.col-object{width:22%}.col-field{width:22%}.col-value{width:20%}.col-time{width:23%}.col-quality{width:13%}}@media(max-width:600px){.browser-toolbar{align-items:flex-start}.browser-refresh{justify-content:flex-start}.browser-filters>label{flex-basis:150px}.browser-pagination>div{justify-content:flex-start}.browser-records th,.browser-records td{padding-left:4px;padding-right:4px}.record-quality{gap:3px;padding:3px}.col-object{width:20%}.col-field{width:20%}.col-value{width:18%}.col-time{width:27%}.col-quality{width:15%}}
</style>
