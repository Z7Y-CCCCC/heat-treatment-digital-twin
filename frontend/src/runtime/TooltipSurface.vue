<script setup>
import { computed, inject, onBeforeUnmount, reactive, shallowReactive, watch } from 'vue'
import WidgetRenderer from './WidgetRenderer.vue'
import { tooltipBindingContext } from './tooltipContext.js'
import { createTooltipReadScheduler, tooltipPlacement } from './tooltipRuntime.js'
import { widgetRuntimeVisible } from './dashboardRules.js'
import { API_BASE } from './backendEndpoint.js'
import { adminFetch } from './adminSession.js'
import { WidgetClockKey } from './widgetPlayback.js'

const props = defineProps({
  template: { type: Object, required: true }, context: { type: Object, default: () => ({}) },
  pointer: { type: Object, default: null }, viewport: { type: Object, default: () => ({}) },
  pointerSource: { type: Function, default: null },
  preview: Boolean, databaseValues: { type: Object, default: () => ({}) },
  metrics: { type: Object, default: () => ({}) }, events: { type: Array, default: () => [] },
  trendPoints: { type: Array, default: () => [] }, deviceStatusMap: { type: Object, default: () => ({}) },
  deviceDataMap: { type: Object, default: () => ({}) }, pointValues: { type: Object, default: () => ({}) },
  deviceCatalog: { type: Array, default: () => [] }, parameters: { type: Object, default: () => ({}) },
  parameterDefinitions: { type: Array, default: () => [] }, playbackNow: { type: Number, default: undefined },
  dataReady: { type: Boolean, default: true }
})
const sharedClock = inject(WidgetClockKey, null)
const initialClock = Date.now()
const clockNow = computed(() => props.playbackNow ?? sharedClock?.value ?? initialClock)
const remoteValues = reactive({})
const widgetRenderers = shallowReactive({})
function setWidgetRenderer(id, renderer) {
  if (renderer) widgetRenderers[id] = renderer
  else delete widgetRenderers[id]
}
defineExpose({ getRenderedText: id => widgetRenderers[id]?.getRenderedText?.() })
const records = computed(() => ({ ...remoteValues, ...props.databaseValues }))
// A stable provider is observed here, not by DashboardOverlay's render effect.
// A missing LIVE pointer hides the card; only an omitted preview pointer means
// an inline canvas. No animation/API/100 ms business clock gates placement.
const placement = computed(() => tooltipPlacement(props.template.canvas,
  props.pointerSource ? props.pointerSource() || { visible: false } : props.pointer, props.viewport))
const surfaceVisible = computed(() => Boolean(placement.value))
const surfaceScale = computed(() => placement.value?.scale || 1)
const widgets = computed(() => (props.template.widgets || []).filter(widget => widgetRuntimeVisible(widget, {
  context: props.context, dataValue: records.value[widget.id]?.value, dataRecord: records.value[widget.id]
})).map(widget => tooltipBindingContext(widget, props.context)))
const hostStyle = computed(() => {
  const p = placement.value
  return p ? { position: p.floating ? 'absolute' : 'relative', left: '0px', top: '0px',
    transform: p.floating ? `translate3d(${p.left}px, ${p.top}px, 0)` : 'none',
    willChange: p.floating ? 'transform' : undefined,
    width: `${p.width}px`, height: `${p.height}px` } : {}
})
const canvasStyle = computed(() => ({ width: `${props.template.canvas?.width || 280}px`,
  height: `${props.template.canvas?.height || 230}px`, transform: `scale(${surfaceScale.value})`,
  background: props.template.canvas?.background || 'transparent' }))
// Reactive readings still update their own WidgetRenderer effects. Keep the
// content vnode/style/ref tree out of cursor-only placement renders; changed
// scope, template, records, preview and explicit playback inputs invalidate it.
const contentMemo = computed(() => [widgets.value, records.value, canvasStyle.value,
  props.metrics, props.events, props.trendPoints, props.deviceStatusMap, props.deviceDataMap,
  props.pointValues, props.deviceCatalog, props.parameters, props.parameterDefinitions,
  props.playbackNow, props.preview, props.dataReady])
function elementStyle(widget) {
  const frame = widget.frame || {}
  return { left: `${frame.x || 0}px`, top: `${frame.y || 0}px`, width: `${frame.width || 20}px`,
    height: `${frame.height || 1}px`, zIndex: widget.zIndex || 0, transform: `rotate(${frame.rotation || 0}deg)`,
    '--tooltip-element-font-size': `${widget.style?.fontSize || 12}px`,
    '--tooltip-element-font-weight': widget.style?.fontWeight || 400,
    '--tooltip-element-border-width': `${widget.style?.borderWidth ?? 1}px` }
}
const reader = createTooltipReadScheduler({
  context: () => props.context, templateId: () => props.template.id,
  parameters: () => props.parameters, devices: () => props.deviceCatalog,
  widgets: () => props.preview || !surfaceVisible.value ? [] : props.template.widgets || [],
  put: (id, record) => { remoteValues[id] = record }, remove: id => { delete remoteValues[id] },
  read: async (ids, context, parameters, now, signal) => {
    const query = new URLSearchParams({ tooltip_template_id: context.tooltipTemplateId,
      view_id: context.viewId, workshop_id: context.workshopId, line_id: context.lineId,
      device_id: context.deviceId, part_id: context.partId, parameters: JSON.stringify(parameters),
      widget_ids: ids.join(','), playback_at: String(now) })
    const response = await adminFetch(`${API_BASE}/data-sources/runtime-values?${query}`, { signal })
    if (!response.ok) throw new Error('提示数据连接暂不可用')
    return response.json()
  }
})
watch(() => [props.preview, surfaceVisible.value, props.template.id, props.context.factoryId, props.context.viewId,
  props.context.deviceId, props.context.partId, props.parameters, props.template.widgets?.map(widget => [widget.id, widget.data])],
() => { void reader.refresh(false, clockNow.value) }, { deep: true, immediate: true, flush: 'sync' })
// Poll the reader on the real surface clock without forwarding its ticking
// value through the tooltip/card vnode tree. Hidden/preview cards neither poll
// nor keep obsolete in-flight values alive; the scope watcher reconciles them.
watch(() => !props.preview && surfaceVisible.value ? clockNow.value : null,
  now => { if (now !== null) void reader.refresh(false, now) })
onBeforeUnmount(() => reader.dispose())
</script>

<template>
  <aside v-if="placement" class="tooltip-surface" :class="{ 'tooltip-surface-preview': preview }" :style="hostStyle"
    :aria-label="template.kind === 'part' ? '悬停部件详情' : '悬停设备详情'" :data-tooltip-template-id="template.id">
    <div v-memo="contentMemo" class="tooltip-surface-canvas" :style="canvasStyle">
      <div v-for="entry in widgets" :key="entry.widget.id" class="tooltip-surface-widget"
        :data-tooltip-widget-id="entry.widget.id" :style="elementStyle(entry.widget)">
        <WidgetRenderer :ref="renderer => setWidgetRenderer(entry.widget.id, renderer)" :widget="entry.sourceWidget" :runtime-context="entry.runtimeContext" :selected-part="entry.selectedPart"
          :metrics="metrics" :events="events" :trend-points="trendPoints" :device-status-map="deviceStatusMap"
          :device-data-map="deviceDataMap" :point-values="pointValues" :database-values="records"
          :device-catalog="deviceCatalog" :parameters="parameters" :parameter-definitions="parameterDefinitions"
          :playback-now="playbackNow" :interactive="false" :preview="preview" :data-ready="dataReady" />
      </div>
    </div>
  </aside>
</template>

<style scoped>
.tooltip-surface{z-index:1005;pointer-events:none;user-select:none;margin:0;padding:0;border:0;background:transparent;transition:none}
.tooltip-surface-canvas{position:relative;transform-origin:top left;overflow:hidden}
.tooltip-surface-widget{position:absolute;box-sizing:border-box;transform-origin:center;pointer-events:none}
.tooltip-surface-widget :deep(.widget-shell){font-size:var(--tooltip-element-font-size);font-weight:var(--tooltip-element-font-weight);border-width:var(--tooltip-element-border-width);font-family:var(--hud-font-text,"Segoe UI","Microsoft YaHei UI",sans-serif)}
.tooltip-surface-widget :deep(.value-widget-body strong){font-size:var(--tooltip-element-font-size);font-weight:var(--tooltip-element-font-weight);text-shadow:none}
.tooltip-surface-widget :deep(.value-widget-body){gap:0}
.tooltip-surface-widget :deep(.widget-device-heading){display:none}
</style>
