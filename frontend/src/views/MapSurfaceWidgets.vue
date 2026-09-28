<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { adminFetch } from '../runtime/adminSession.js'
import { applyVisibilityAction, widgetRuntimeVisible } from '../runtime/dashboardRules.js'
import { MAP_SURFACE_VIEW_IDS } from '../runtime/dashboardSchema.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'

const props = defineProps({
  document: { type: Object, default: null },
  viewId: { type: String, required: true },
  factoryId: { type: String, default: '' },
  config: { type: Object, default: null },
  dataStore: { type: Object, default: null }
})
const emit = defineEmits(['navigate'])
const values = ref({})
const businessData = ref({ status: 'idle', readOnly: true, sections: {} })
const widgetVisibility = reactive({})
const groupVisibility = reactive({})
const currentView = computed(() => props.document?.scene?.views?.find(view => view.id === props.viewId))
const runtimeContext = computed(() => ({ viewId: props.viewId, viewMode: 'custom', factoryId: props.factoryId }))
const canvas = computed(() => props.document?.canvas || { width: 1920, height: 1080 })
const pointValues = computed(() => {
  const result = {}
  for (const workshop of props.config?.workshops || []) for (const line of workshop.lines || []) for (const device of line.devices || []) {
    const reading = props.dataStore?.deviceDataMap?.[device.id] || {}
    for (const point of device.dataPoints || []) {
      const category = point.category || 'analog'
      const field = point.value_role || point.name
      const value = reading?.[category]?.[field]
      const record = { ...point, value, device_id: device.id, quality: reading?.quality?.[category]?.[field] || 'bad' }
      result[String(point.id)] = record
      result[`${device.id}:${point.id}`] = record
    }
  }
  return result
})
const surfaceWidgets = computed(() => {
  if (!MAP_SURFACE_VIEW_IDS.has(props.viewId) || !currentView.value) return []
  const shown = new Set(currentView.value.componentState?.show || [])
  const hidden = new Set(currentView.value.componentState?.hide || [])
  return (props.document?.widgets || [])
    .filter(widget => widget.visible !== false && widget.visible !== 0 && widget.runtimeTarget !== 'unity')
    .filter(widget => !['device_label', 'diagnostics', 'line_overview_cards'].includes(widget.type))
    .filter(widget => (shown.has(widget.id) || (widget.groupId && shown.has(`group:${widget.groupId}`)))
      && !hidden.has(widget.id) && !(widget.groupId && hidden.has(`group:${widget.groupId}`)))
    .filter(widget => !widget.visibility?.viewIds?.length || widget.visibility.viewIds.includes(props.viewId))
    .filter(widget => !widget.visibility?.viewModes?.length || widget.visibility.viewModes.includes('custom'))
})
function valueForWidget(widget) {
  const binding = widget.data || {}
  if (binding.mode === 'database' || binding.mode === 'http_api') return values.value[widget.id]?.value
  if (binding.mode === 'plc') {
    const deviceId = String(binding.deviceId || '')
    const pointId = String(binding.pointId || '')
    return pointValues.value[`${deviceId}:${pointId}`]?.value ?? pointValues.value[pointId]?.value
  }
  if (binding.mode === 'runtime') {
    const source = { metrics: props.dataStore?.metrics || {}, events: props.dataStore?.events?.value || [], trendPoints: props.dataStore?.trendPoints?.value || [] }
    return String(binding.path || '').split('.').reduce((value, key) => value?.[key], source)
  }
  return widget.content?.value
}
const widgets = computed(() => surfaceWidgets.value
    .filter(widget => widgetRuntimeVisible(widget, {
      context: runtimeContext.value,
      dataValue: valueForWidget(widget),
      dataRecord: values.value[widget.id] || null,
      groupVisibility,
      widgetVisibility
    }))
    .sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0)))
function widgetFrame(widget) {
  const frame = widget.frame || {}
  return {
    left: `${Number(frame.x || 0) / Math.max(1, Number(canvas.value.width) || 1920) * 100}%`,
    top: `${Number(frame.y || 0) / Math.max(1, Number(canvas.value.height) || 1080) * 100}%`,
    width: `${Number(frame.width || 320) / Math.max(1, Number(canvas.value.width) || 1920) * 100}%`,
    height: `${Number(frame.height || 180) / Math.max(1, Number(canvas.value.height) || 1080) * 100}%`,
    zIndex: Number(widget.zIndex || 0),
    transform: `rotate(${Number(frame.rotation || 0)}deg)`
  }
}
function handleAction({ event }) {
  if (!event) return
  if (['set_visibility', 'toggle_visibility'].includes(event.action)) return applyVisibilityAction(event, { groupVisibility, widgetVisibility })
  if (event.action === 'switch_view' && MAP_SURFACE_VIEW_IDS.has(event.viewId)) return emit('navigate', event.viewId)
  if (event.action === 'open_link' && /^https?:\/\//i.test(event.url || '')) {
    if (window.chrome?.webview) window.chrome.webview.postMessage({ type: 'dashboard_action', action: 'open_link', url: event.url })
    else window.open(event.url, '_blank', 'noopener,noreferrer')
  }
}
function handleWidgetClick(widget) {
  if (widget.type !== 'return_button' || widget.events?.some(event => (event.trigger || 'click') === 'click')) return
  const parent = currentView.value?.parentViewId
  if (MAP_SURFACE_VIEW_IDS.has(parent)) emit('navigate', parent)
}
let timer = 0
let businessTimer = 0
let abort = null
let businessAbort = null
async function refreshValues() {
  if (!surfaceWidgets.value.some(widget => ['database', 'http_api'].includes(widget.data?.mode))) return
  abort?.abort()
  abort = new AbortController()
  try {
    const query = new URLSearchParams({ view_id: props.viewId })
    const response = await adminFetch(`${API_BASE}/data-sources/runtime-values?${query}`, {
      signal: abort.signal,
      ...(props.factoryId ? { headers: { 'X-Factory-ID': props.factoryId } } : {})
    })
    if (response.ok) values.value = (await response.json()).values || {}
  } catch (error) { if (error.name !== 'AbortError') values.value = {} }
}
async function refreshBusiness() {
  const widget = surfaceWidgets.value.find(item => item.type === 'business_summary' || item.data?.mode === 'business')
  if (!widget) return
  const connectionId = String(widget.data?.connectionId || widget.content?.connectionId || '').trim()
  if (!connectionId) {
    businessData.value = { status: 'unconfigured', readOnly: true, sections: {} }
    return
  }
  businessAbort?.abort()
  businessAbort = new AbortController()
  try {
    const params = new URLSearchParams({ connection_id: connectionId, limit: '200' })
    const response = await adminFetch(`${API_BASE}/business-data/snapshot?${params}`, {
      cache: 'no-store', signal: businessAbort.signal,
      ...(props.factoryId ? { headers: { 'X-Factory-ID': props.factoryId } } : {})
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.success === false) throw new Error(payload.error || '业务数据读取失败')
    businessData.value = { status: 'ready', readOnly: true, sections: payload.sections || {} }
  } catch (error) {
    if (error.name !== 'AbortError') businessData.value = { status: 'error', readOnly: true, sections: {} }
  }
}
watch(() => [props.viewId, props.document], () => { values.value = {}; void refreshValues(); void refreshBusiness() })
onMounted(() => { void refreshValues(); void refreshBusiness(); timer = window.setInterval(refreshValues, 15000); businessTimer = window.setInterval(refreshBusiness, 60000) })
onUnmounted(() => { window.clearInterval(timer); window.clearInterval(businessTimer); abort?.abort(); businessAbort?.abort() })
</script>

<template>
  <div v-if="widgets.length" class="map-surface-widget-layer" aria-label="已发布的地图画面组件">
    <div v-for="widget in widgets" :key="widget.id" class="map-surface-widget hud-widget" :style="widgetFrame(widget)" @pointerdown.stop @click.stop="handleWidgetClick(widget)">
      <WidgetRenderer :widget="widget" :metrics="dataStore?.metrics || {}" :events="dataStore?.events?.value || []"
        :trend-points="dataStore?.trendPoints?.value || []" :device-status-map="dataStore?.deviceStatusMap || {}"
        :device-data-map="dataStore?.deviceDataMap || {}" :point-values="pointValues" :database-values="values"
        :runtime-context="runtimeContext" :business-data="businessData" :data-ready="true" overlay-mode @action="handleAction" />
    </div>
  </div>
</template>

<style scoped>
.map-surface-widget-layer{position:absolute;inset:0;z-index:12;pointer-events:none}.map-surface-widget{position:absolute;box-sizing:border-box;min-width:1px;min-height:1px;pointer-events:auto;overflow:hidden}
</style>
