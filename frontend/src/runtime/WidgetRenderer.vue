<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { splitHudKpiValue } from './hudPresentation.js'

const HUD_FONT_TEXT = 'SF Pro Text, Inter Variable, Inter, Noto Sans SC Variable, Segoe UI, PingFang SC, Microsoft YaHei UI, sans-serif'
const HUD_FONT_NUMBER = 'SF Pro Display, Inter Variable, Inter, Segoe UI, Bahnschrift, sans-serif'

const props = defineProps({
  widget: { type: Object, default: () => ({ type: 'metrics', title: '' }) },
  metrics: { type: Object, default: () => ({}) },
  events: { type: Array, default: () => [] },
  trendPoints: { type: Array, default: () => [] },
  deviceStatusMap: { type: Object, default: () => ({}) },
  deviceDataMap: { type: Object, default: () => ({}) },
  pointValues: { type: Object, default: () => ({}) },
  databaseValues: { type: Object, default: () => ({}) },
  businessData: { type: Object, default: () => ({}) },
  runtimeContext: { type: Object, default: () => ({}) },
  selectedPart: { type: Object, default: () => ({}) },
  overlayMode: { type: Boolean, default: false },
  preview: { type: Boolean, default: false },
  dataReady: { type: Boolean, default: true },
  showContainerPlaceholder: { type: Boolean, default: false }
})

const emit = defineEmits(['action'])
const chartRef = ref(null)
const localTrend = ref([])
let chart = null
let chartResizeObserver = null
let widgetDisposed = false

function getByPath(source, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => current?.[key], source)
}

function objectValue(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

const type = computed(() => props.widget.type || props.widget.widget_type || 'text')
const content = computed(() => objectValue(props.widget.content, objectValue(props.widget.config, {})))
const widgetStyle = computed(() => objectValue(props.widget.style, objectValue(props.widget.config?.style, {})))
const dataBinding = computed(() => objectValue(props.widget.data, objectValue(props.widget.binding, {})))
const conditions = computed(() => Array.isArray(props.widget.conditions) ? props.widget.conditions : (Array.isArray(props.widget.config?.conditions) ? props.widget.config.conditions : []))
const animation = computed(() => objectValue(props.widget.animation, objectValue(props.widget.config?.animation, { type: 'none' })))
const widgetEvents = computed(() => Array.isArray(props.widget.events) ? props.widget.events : (Array.isArray(props.widget.config?.events) ? props.widget.config.events : []))
const widgetTitle = computed(() => props.widget.title || content.value.title || '')
const overlayMode = computed(() => props.overlayMode === true)

const progressPercent = computed(() => {
  const target = Number(props.metrics.daily_target || props.metrics.dailyTarget || 1)
  const output = Number(props.metrics.current_output || props.metrics.currentOutput || 0)
  return Math.max(0, Math.min(100, target ? (output / target) * 100 : 0)).toFixed(1)
})

const dataContext = computed(() => ({
  metrics: props.metrics,
  events: props.events,
  trendPoints: props.trendPoints,
  deviceStatusMap: props.deviceStatusMap,
  deviceDataMap: props.deviceDataMap,
  points: props.pointValues,
  context: props.runtimeContext,
  selectedPart: props.selectedPart
}))

function getWidgetValue(path) {
  if (path === 'metrics.progress_percent') return progressPercent.value
  return getByPath(dataContext.value, path)
}

const pointRecord = computed(() => {
  const pointId = String(dataBinding.value.pointId || dataBinding.value.point_id || '')
  const deviceId = String(dataBinding.value.deviceId || dataBinding.value.device_id || '')
  return props.pointValues[`${deviceId}:${pointId}`] || props.pointValues[pointId] || null
})
const databaseRecord = computed(() => props.databaseValues[String(props.widget.id || '')] || null)
const businessSection = computed(() => dataBinding.value.businessSection || content.value.section || 'batches')
const businessSectionMeta = computed(() => objectValue(props.businessData?.sections?.[businessSection.value], {}))
const businessRows = computed(() => Array.isArray(businessSectionMeta.value.rows)
  ? businessSectionMeta.value.rows.slice(0, Math.max(1, Number(content.value.limit || 6)))
  : [])
const businessSectionLabel = computed(() => ({
  batches: '批次与工艺执行',
  compliance: '温度 / 碳势合规',
  oee: '设备运行统计',
  energy: '单批次能耗',
  maintenance: '维护记录'
}[businessSection.value] || '外部业务数据'))
const businessUnavailable = computed(() => businessSectionMeta.value.available === false)
const businessLoading = computed(() => ['idle', 'loading'].includes(String(props.businessData?.status || 'idle')))

const dataDrivenWidget = computed(() => {
  if (['metrics', 'trend', 'alarm_list', 'marquee', 'device_list', 'business_summary'].includes(type.value)) return true
  const binding = dataBinding.value
  return Boolean(binding.mode || binding.path || binding.source || binding.pointId || binding.point_id)
})
const dataPending = computed(() => {
  if (!overlayMode.value || !dataDrivenWidget.value) return false
  if (type.value === 'business_summary') return businessLoading.value
  return props.dataReady !== true
})

function firstBusinessValue(row, keys = []) {
  for (const key of keys) {
    const value = row?.[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return '--'
}

function businessRowTitle(row) {
  if (businessSection.value === 'batches') return firstBusinessValue(row, ['batchNo', 'batchName', 'id'])
  if (businessSection.value === 'compliance') return firstBusinessValue(row, ['signalName', 'signalId', 'deviceId'])
  if (businessSection.value === 'oee') return firstBusinessValue(row, ['deviceId', 'date'])
  return firstBusinessValue(row, ['recordTime', 'batchId', 'id', 'name', 'orderNo'])
}

function businessRowSubtitle(row) {
  if (businessSection.value === 'batches') return [row?.productName, row?.status].filter(Boolean).join(' · ') || '工艺批次'
  if (businessSection.value === 'compliance') return [row?.deviceId, row?.recordTime].filter(Boolean).join(' · ') || '归档信号'
  if (businessSection.value === 'oee') return [row?.date, row?.batchCount != null ? `批次 ${row.batchCount}` : ''].filter(Boolean).join(' · ')
  return firstBusinessValue(row, ['description', 'status', 'message', 'recordTime'])
}

function businessRowValue(row) {
  if (businessSection.value === 'batches') {
    const progress = Number(row?.progress)
    return Number.isFinite(progress) ? `${progress.toFixed(0)}%` : firstBusinessValue(row, ['status', 'currentStep'])
  }
  if (businessSection.value === 'compliance') {
    const value = row?.value ?? row?.rawValue
    return value === null || value === undefined || value === '' ? '--' : `${value}`
  }
  if (businessSection.value === 'oee') {
    const value = row?.utilizationRate
    return value === null || value === undefined ? '--' : `${Number(value).toFixed(1)}%`
  }
  return firstBusinessValue(row, ['energy', 'energyKwh', 'value', 'status'])
}

const boundValue = computed(() => {
  const binding = dataBinding.value
  if (binding.mode === 'database') return databaseRecord.value?.value ?? content.value.value
  if (binding.mode === 'plc' || binding.pointId || binding.point_id) {
    if (pointRecord.value && pointRecord.value.value !== undefined) return pointRecord.value.value
    const deviceId = binding.deviceId || binding.device_id
    const deviceData = props.deviceDataMap[deviceId]
    const fromDevice = getByPath(deviceData, binding.path)
    if (fromDevice !== undefined) return fromDevice
    const fromStatus = getByPath(props.deviceStatusMap[deviceId], binding.path)
    if (fromStatus !== undefined) return fromStatus
    return content.value.value
  }
  const path = binding.path || binding.source
  if (path) return getWidgetValue(path)
  return content.value.value
})

const boundQuality = computed(() => {
  if (dataBinding.value.mode === 'database') return databaseRecord.value?.quality || (databaseRecord.value?.error ? 'bad' : 'stale')
  const binding = dataBinding.value
  const deviceId = binding.deviceId || binding.device_id
  const quality = pointRecord.value?.quality
    || getByPath(props.deviceDataMap[deviceId]?.quality, binding.path)
    || props.deviceStatusMap[deviceId]?.quality
  if (quality) return quality
  return !props.preview && (binding.mode === 'plc' || binding.pointId || binding.point_id) ? 'stale' : 'good'
})

function numericValue(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function boundedDecimals(value, fallback = 1) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(8, Math.trunc(number))) : fallback
}

function formatValue(value = boundValue.value) {
  if (value === undefined || value === null || value === '') return content.value.fallback ?? '--'
  if (typeof value === 'boolean') return value ? (content.value.onText || '正常') : (content.value.offText || '停止')
  const number = Number(value)
  if (Number.isFinite(number)) {
    const decimals = boundedDecimals(dataBinding.value.decimals ?? 1)
    return number.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  }
  return String(value)
}

function conditionMatches(condition, value) {
  const operator = condition?.operator || '=='
  const target = condition?.value
  const number = numericValue(value)
  const targetNumber = numericValue(target)
  if (operator === 'truthy') return !!value
  if (operator === 'falsy') return !value
  if (operator === '==') return String(value) === String(target) || (number !== null && targetNumber !== null && number === targetNumber)
  if (operator === '!=') return !conditionMatches({ ...condition, operator: '==' }, value)
  if (number === null || targetNumber === null) return false
  if (operator === '>') return number > targetNumber
  if (operator === '>=') return number >= targetNumber
  if (operator === '<') return number < targetNumber
  if (operator === '<=') return number <= targetNumber
  return false
}

const activeCondition = computed(() => conditions.value.find(condition => conditionMatches(condition, boundValue.value)) || null)
const conditionAnimation = computed(() => activeCondition.value?.animation || 'none')
const animationType = computed(() => conditionAnimation.value !== 'none' ? conditionAnimation.value : (animation.value.type || 'none'))
const animationClass = computed(() => animationType.value === 'none' ? '' : `widget-animation-${animationType.value}`)

function cssSize(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback
  return typeof value === 'number' ? `${value}px` : String(value)
}

const shellStyle = computed(() => {
  const style = widgetStyle.value
  const condition = activeCondition.value || {}
  const configuredBackgroundOpacity = Number(style.backgroundOpacity)
  const backgroundOpacity = Number.isFinite(configuredBackgroundOpacity)
    ? Math.max(0, Math.min(1, configuredBackgroundOpacity))
    : 0.12
  const subtleOpacity = Math.max(0, Math.min(1, backgroundOpacity * 0.72))
  const brandOpacity = Math.max(0, Math.min(1, backgroundOpacity * 1.25))
  const marqueeOpacity = Math.max(0, Math.min(1, backgroundOpacity * 1.1))
  const glassBackground = `linear-gradient(135deg, rgba(16, 24, 48, ${backgroundOpacity}) 0%, rgba(10, 14, 28, ${backgroundOpacity * 0.5}) 100%)`
  const subtleGlassBackground = `linear-gradient(135deg, rgba(22, 30, 58, ${subtleOpacity}) 0%, rgba(12, 16, 34, ${subtleOpacity * 0.45}) 100%)`
  const brandBackground = `linear-gradient(105deg, rgba(18, 23, 43, ${brandOpacity}) 0%, rgba(14, 18, 36, ${brandOpacity * 0.38}) 70%, transparent 100%)`
  const marqueeBackground = `rgba(12, 16, 32, ${marqueeOpacity})`
  const shadows = {
    none: 'none',
    soft: '0 14px 34px rgba(0,8,18,.24)',
    glow: '0 0 28px rgba(67,184,255,.24)',
    strong: '0 18px 48px rgba(0,6,14,.42)'
  }
  return {
    // The Unity overlay uses one controlled glass palette. Keep configured
    // condition colors for active states, but do not let legacy flat panel
    // colors flatten the runtime HUD.
    background: overlayMode.value ? glassBackground : (condition.background || style.background),
    color: condition.color || style.color,
    borderColor: overlayMode.value ? condition.borderColor : (condition.borderColor || style.borderColor),
    borderRadius: overlayMode.value ? undefined : cssSize(style.borderRadius, undefined),
    opacity: style.opacity ?? 1,
    padding: overlayMode.value ? undefined : cssSize(style.padding, undefined),
    fontSize: overlayMode.value ? undefined : cssSize(style.fontSize, undefined),
    // Keep the already-migrated label/value hierarchy in authoring pixels.
    // The canvas scales once; brand and KPI rules own their separate sizes.
    '--hud-text-size': overlayMode.value && type.value === 'text' ? cssSize(style.fontSize) : undefined,
    // CSS custom properties are the single source of truth for HUD surfaces.
    // This lets the designer change only the panel alpha while keeping the
    // text, values and charts fully opaque.
    '--hud-panel-opacity': overlayMode.value ? backgroundOpacity : undefined,
    '--hud-glass-bg': overlayMode.value ? glassBackground : undefined,
    '--hud-glass-bg-subtle': overlayMode.value ? subtleGlassBackground : undefined,
    '--hud-brand-bg': overlayMode.value ? brandBackground : undefined,
    '--hud-marquee-bg': overlayMode.value ? marqueeBackground : undefined,
    '--hud-title-bg': overlayMode.value ? `rgba(129, 140, 248, ${Math.min(0.1, backgroundOpacity * 0.65)})` : undefined,
    '--hud-navigation-bg': overlayMode.value ? `linear-gradient(180deg, rgba(18, 35, 53, ${Math.min(0.86, backgroundOpacity * 1.8)}) 0%, rgba(8, 20, 34, ${Math.min(0.78, backgroundOpacity * 1.35)}) 100%)` : undefined,
    '--hud-return-bg': overlayMode.value ? `rgba(29, 29, 31, ${Math.min(0.96, backgroundOpacity * 1.8)})` : undefined,
    boxShadow: overlayMode.value ? undefined : (shadows[style.shadow] || style.boxShadow),
    '--widget-value-color': condition.color || style.valueColor || '#67d2ff',
    '--widget-on-color': style.onColor || '#49df9d',
    '--widget-off-color': style.offColor || '#7c8d9d',
    '--widget-alarm-color': style.alarmColor || '#ff625f',
    '--widget-line-color': content.value.lineColor || '#55c7ff',
    animationDuration: `${Number(animation.value.duration || 1.2)}s`,
    animationDelay: `${Number(animation.value.delay || 0)}s`,
    animationIterationCount: animation.value.iteration || 'infinite'
  }
})

const metricItems = computed(() => {
  const items = Array.isArray(content.value.items) ? content.value.items : [
    { label: '今日产出', path: 'metrics.current_output' },
    { label: '完成进度', path: 'metrics.progress_percent', unit: '%' },
    { label: '能耗估算', path: 'metrics.energy_consumption' },
    { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }
  ]
  return items.map(item => {
    const rawValue = getWidgetValue(item.path)
    const suffix = item.suffixPath ? getWidgetValue(item.suffixPath) : undefined
    const dynamicLabel = item.labelPath ? getWidgetValue(item.labelPath) : undefined
    const dynamicUnit = item.unitPath ? getWidgetValue(item.unitPath) : undefined
    const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== ''
    const decimals = Number(item.decimals)
    const formattedValue = hasValue && typeof rawValue === 'number' && Number.isFinite(decimals)
      ? rawValue.toLocaleString(undefined, { minimumFractionDigits: boundedDecimals(decimals), maximumFractionDigits: boundedDecimals(decimals) })
      : (hasValue ? String(rawValue) : (item.fallback ?? '--'))
    return {
      label: dynamicLabel || item.label || item.path || '指标',
      value: item.suffixPath
        ? `${formattedValue}${item.separator || ''}${suffix ?? '--'}${dynamicUnit ?? item.unit ?? ''}`
        : `${formattedValue}${dynamicUnit ?? item.unit ?? ''}`,
      hasValue
    }
  }).filter(item => overlayMode.value || content.value.hideEmptyItems !== true || item.hasValue)
})

const eventRows = computed(() => {
  if (dataBinding.value.mode === 'database' && Array.isArray(databaseRecord.value?.rows)) return databaseRecord.value.rows
  const source = dataBinding.value.source || dataBinding.value.path
  const bound = source ? getWidgetValue(source) : null
  return Array.isArray(bound) ? bound : props.events
})

const trendRows = computed(() => {
  if (dataBinding.value.mode === 'database' && Array.isArray(databaseRecord.value?.rows)) return databaseRecord.value.rows
  const source = dataBinding.value.source
  const bound = source ? getWidgetValue(source) : null
  if (Array.isArray(bound)) return bound
  if (dataBinding.value.mode === 'plc' || dataBinding.value.pointId) return localTrend.value
  return props.trendPoints
})

const chartSeries = computed(() => {
  const recordSeries = databaseRecord.value?.series
  if (dataBinding.value.mode === 'database' && Array.isArray(recordSeries) && recordSeries.length) {
    return recordSeries.map((series, index) => ({
      id: series.id || `series_${index + 1}`,
      name: series.label || series.id || `数据项 ${index + 1}`,
      color: series.color || ['#55c7ff', '#45df9b', '#ffc45f', '#ff6b78'][index % 4],
      value: series.value,
      rows: Array.isArray(series.rows) ? series.rows : []
    }))
  }
  return [{
    id: 'value',
    name: content.value.seriesName || widgetTitle.value || '趋势',
    color: content.value.lineColor || '#55c7ff',
    value: boundValue.value,
    rows: trendRows.value
  }]
})
const hasTrendData = computed(() => chartSeries.value.some(series => Array.isArray(series.rows) && series.rows.length > 0))

const textLines = computed(() => {
  const rawText = Array.isArray(content.value.lines) ? content.value.lines.join('\n') : (content.value.text || content.value.label || '')
  const fallback = rawText || widgetTitle.value || '文本组件'
  return String(fallback).replaceAll('{value}', formatValue()).split('\n').filter(Boolean)
})
const isHudKpi = computed(() => overlayMode.value && type.value === 'text' && textLines.value.length === 2 && textLines.value[0].startsWith('今日'))
const hudKpiValue = computed(() => splitHudKpiValue(textLines.value[1]))

const statusState = computed(() => {
  if (boundQuality.value === 'bad') return 'unknown'
  const value = boundValue.value
  if (typeof value === 'string') {
    const normalized = value.toLowerCase()
    if (['true', '1', 'on', 'running', 'online', 'normal', '正常', '运行'].includes(normalized)) return 'on'
    if (['false', '0', 'off', 'stopped', 'offline', '停止', '离线'].includes(normalized)) return 'off'
  }
  if (value === undefined || value === null || value === '') return 'unknown'
  return Number(value) !== 0 || value === true ? 'on' : 'off'
})

const statusText = computed(() => {
  if (statusState.value === 'unknown') return content.value.unknownText || '离线'
  return statusState.value === 'on' ? (content.value.onText || '正常') : (content.value.offText || '停止')
})

const deviceRows = computed(() => Object.entries(props.deviceStatusMap)
  .map(([id, value]) => ({ id, ...value }))
  .slice(0, Number(content.value.limit || 12)))

function resizeChart() { chart?.resize() }
function disposeChart() { if (chart) { chart.dispose(); chart = null } }

// Apply the overlay art direction to every supported chart without changing
// samples, axes ranges, bindings or the designer's non-overlay preview.
function presentChart(option) {
  if (overlayMode.value) {
    const palette = ['#8995f5', '#71cbd8', '#a59ae1', '#69c2aa', '#e2b775', '#e77f98']
    option.backgroundColor = 'transparent'
    option.color = palette
    option.textStyle = { fontFamily: HUD_FONT_TEXT, color: '#98a1b9' }
    if (option.legend) option.legend = { ...option.legend, icon: 'circle', itemWidth: 5, itemHeight: 5, textStyle: { color: '#969fb6', fontSize: 10, fontFamily: HUD_FONT_TEXT } }
    if (option.tooltip) option.tooltip = { ...option.tooltip, backgroundColor: 'rgba(20,24,41,.96)', borderColor: 'rgba(150,162,214,.24)', padding: 10, textStyle: { color: '#e4e8f5', fontSize: 12, fontFamily: HUD_FONT_TEXT } }
    for (const axis of [option.xAxis, option.yAxis].filter(Boolean)) {
      axis.axisLabel = { ...axis.axisLabel, color: '#8590aa', fontSize: 10, fontFamily: HUD_FONT_TEXT, hideOverlap: true }
      axis.axisTick = { show: false }
      axis.axisLine = { show: false }
      if (axis.splitLine) axis.splitLine = { lineStyle: { color: 'rgba(173,185,224,.09)', type: 'dashed' } }
    }
    for (const [index, series] of option.series.entries()) {
      const color = palette[index % palette.length]
      if (['line', 'bar', 'scatter'].includes(series.type)) {
        series.lineStyle = { color, width: 1.4 }
        series.itemStyle = { ...series.itemStyle, color, borderRadius: series.type === 'bar' ? [2, 2, 0, 0] : 0 }
        series.symbolSize = 4
        if (series.type === 'bar') series.barMaxWidth = 12
        if (series.areaStyle) series.areaStyle = { opacity: 1, color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: 'rgba(137,149,245,.22)' }, { offset: 1, color: 'rgba(137,149,245,0)' }]
        } }
      } else if (series.type === 'pie') {
        const ring = Array.isArray(series.radius) && series.radius[0] !== '0%'
        if (ring) series.radius = ['73%', '81%']
        if (series.silent) series.label = { ...series.label, fontSize: 11, fontWeight: 400, fontFamily: HUD_FONT_TEXT, lineHeight: 17 }
        series.itemStyle = { borderColor: 'transparent', borderWidth: 1 }
        series.labelLine = { length: 8, length2: 6, lineStyle: { color: '#606d8d' } }
        series.data = series.data.map((item, i) => ({ ...item, itemStyle: { ...item.itemStyle, color: series.silent && i === 1 ? 'rgba(143,155,204,.14)' : palette[i % palette.length] } }))
      } else if (series.type === 'gauge') {
        series.startAngle = 180
        series.endAngle = 0
        series.center = ['50%', '70%']
        series.progress = { show: true, width: 4, itemStyle: { color } }
        series.axisLine = { lineStyle: { width: 4, color: [[1, 'rgba(143,155,204,.15)']] } }
        series.pointer = { show: false }
        series.axisLabel = { color: '#8590aa', distance: 8, fontSize: 8, fontFamily: HUD_FONT_TEXT, formatter: value => value === series.min || value === series.max ? String(value) : '' }
        series.splitLine = { length: 4, distance: -8, lineStyle: { color: '#687493', width: 1 } }
        series.detail = { ...series.detail, color: '#edf0fa', fontSize: 22, fontFamily: HUD_FONT_NUMBER, fontWeight: 600, offsetCenter: [0, '-12%'] }
      }
    }
  }
  chart.setOption(option, true, true)
}

function renderChart() {
  if (widgetDisposed) return
  if (!['trend', 'metrics'].includes(type.value)) { disposeChart(); return }
  if (type.value === 'metrics' && content.value.layout === 'list') { disposeChart(); return }
  if (!chartRef.value) return
  if (!chart) chart = echarts.init(chartRef.value)
  if (type.value === 'trend') {
    const timeField = content.value.timeField || 'time'
    const valueField = content.value.valueField || 'value'
    const chartType = content.value.chartType || 'line'
    const sourceSeries = chartSeries.value
    const legendPosition = content.value.legendPosition || 'top'
    const legend = {
      show: content.value.showLegend !== false && sourceSeries.length > 1,
      orient: legendPosition === 'right' ? 'vertical' : 'horizontal',
      top: legendPosition === 'bottom' ? undefined : (legendPosition === 'right' ? 'middle' : 0),
      bottom: legendPosition === 'bottom' ? 0 : undefined,
      right: legendPosition === 'right' ? 0 : undefined,
      textStyle: { color: '#9fb5c6', fontSize: 10, fontFamily: HUD_FONT_TEXT }
    }
    const common = {
      animation: !props.preview,
      color: sourceSeries.map(series => series.color),
      tooltip: { trigger: ['pie', 'donut', 'gauge'].includes(chartType) ? 'item' : 'axis', backgroundColor: 'rgba(8,20,32,.94)', borderColor: 'rgba(86,181,238,.3)', textStyle: { color: '#fff', fontFamily: HUD_FONT_TEXT } },
      legend
    }
    if (chartType === 'pie' || chartType === 'donut') {
      presentChart({ ...common, series: [{
        type: 'pie', radius: chartType === 'donut' ? [`${Number(content.value.donutRatio ?? 48)}%`, '76%'] : ['0%', '76%'], center: ['50%', '55%'],
        label: { show: content.value.showDataLabel !== false, color: '#dcebf6', fontFamily: HUD_FONT_TEXT, formatter: '{b}\n{c}' },
        itemStyle: { borderColor: 'rgba(8,20,32,.8)', borderWidth: 2 },
        data: sourceSeries.map(series => ({ name: series.name, value: Number(series.value) || 0, itemStyle: { color: series.color } }))
      }] })
      return
    }
    if (chartType === 'gauge') {
      const minimum = Number(content.value.min ?? 0)
      const maximum = Number(content.value.max ?? 100)
      presentChart({ ...common, series: [{
        type: 'gauge', min: minimum, max: maximum, radius: '88%', center: ['50%', '58%'],
        progress: { show: true, width: 13 }, axisLine: { lineStyle: { width: 13 } }, axisTick: { show: false }, splitLine: { length: 8 },
        axisLabel: { color: '#829bae', distance: 18, fontSize: 9, fontFamily: HUD_FONT_TEXT }, pointer: { width: 4 },
        detail: { color: '#eef7ff', fontSize: 18, fontFamily: HUD_FONT_NUMBER, fontWeight: 600, offsetCenter: [0, '64%'], formatter: `{value}${dataBinding.value.unit || ''}` },
        data: [{ value: Number(boundValue.value) || 0, name: content.value.seriesName || widgetTitle.value }]
      }] })
      return
    }
    const rowsForAxis = sourceSeries.find(series => series.rows.length)?.rows || []
    const isBar = ['bar', 'stackedBar'].includes(chartType)
    presentChart({
      ...common,
      grid: { left: content.value.showAxis === false ? 12 : 45, right: legendPosition === 'right' && legend.show ? 90 : 18, bottom: legendPosition === 'bottom' && legend.show ? 34 : 28, top: legendPosition === 'top' && legend.show ? 30 : 18 },
      xAxis: { show: content.value.showAxis !== false, type: 'category', boundaryGap: isBar, data: rowsForAxis.map(point => point[timeField]), axisLine: { lineStyle: { color: 'rgba(180,215,238,.18)' } }, axisLabel: { color: '#8fa6b8' } },
      yAxis: { show: content.value.showAxis !== false, type: 'value', axisLabel: { color: '#8fa6b8' }, splitLine: { lineStyle: { color: 'rgba(180,215,238,.08)' } } },
      series: sourceSeries.map(series => ({
        name: series.name,
        type: isBar ? 'bar' : (chartType === 'scatter' ? 'scatter' : 'line'),
        stack: chartType === 'stackedBar' ? 'total' : undefined,
        smooth: !isBar && chartType !== 'scatter' && content.value.smooth !== false,
        showSymbol: chartType === 'scatter' || content.value.showSymbol === true,
        symbolSize: chartType === 'scatter' ? 8 : 5,
        lineStyle: { color: series.color, width: Number(content.value.lineWidth || 2) },
        itemStyle: { color: series.color, borderRadius: isBar ? Number(content.value.barRadius ?? 4) : 0 },
        label: { show: content.value.showDataLabel === true, color: '#dcebf6', fontFamily: HUD_FONT_TEXT, position: isBar ? 'top' : 'top' },
        areaStyle: chartType === 'area' ? { color: series.color, opacity: Number(content.value.areaOpacity ?? .2) } : undefined,
        data: series.rows.map(point => point[valueField])
      }))
    })
    return
  }
  const chartPath = content.value.chartPath || 'metrics.overall_oee'
  const chartValue = Number(getWidgetValue(chartPath) || 0)
  presentChart({
    animation: !props.preview,
    series: [{
      type: 'pie', radius: ['64%', '82%'], silent: true,
      label: { show: true, position: 'center', formatter: `${chartValue.toFixed(1)}%\n${content.value.chartLabel || 'OEE'}`, color: '#eaf6ff', fontFamily: HUD_FONT_TEXT, fontSize: 15, fontWeight: 600 },
      itemStyle: { borderColor: '#12202d', borderWidth: 2 },
      data: [
        { value: chartValue, itemStyle: { color: content.value.chartColor || '#4fd09a' } },
        { value: Math.max(0, 100 - chartValue), itemStyle: { color: 'rgba(122,151,171,.2)' } }
      ]
    }]
  })
}

function triggerEvents(trigger, domEvent) {
  widgetEvents.value.filter(event => (event.trigger || 'click') === trigger).forEach(event => emit('action', { event, widget: props.widget, domEvent }))
}

watch(boundValue, value => {
  if (!(dataBinding.value.mode === 'plc' || dataBinding.value.pointId || dataBinding.value.point_id)) return
  const number = numericValue(value)
  if (number === null || boundQuality.value !== 'good') return
  const now = new Date().toLocaleTimeString().slice(0, 8)
  localTrend.value = [...localTrend.value, { time: now, value: number }].slice(-Math.max(8, Number(content.value.historyLength || 60)))
})

watch(() => [dataBinding.value.mode, dataBinding.value.deviceId || dataBinding.value.device_id, dataBinding.value.pointId || dataBinding.value.point_id, dataBinding.value.path], () => { localTrend.value = [] })

watch(chartRef, element => {
  disposeChart()
  chartResizeObserver?.disconnect()
  if (element) chartResizeObserver?.observe(element)
  nextTick(renderChart)
})

watch(() => [props.widget, props.metrics, props.trendPoints, props.events, props.databaseValues, props.businessData, localTrend.value], () => nextTick(renderChart), { deep: true })

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    chartResizeObserver = new ResizeObserver(resizeChart)
    if (chartRef.value) chartResizeObserver.observe(chartRef.value)
  }
  nextTick(renderChart)
  window.addEventListener('resize', resizeChart)
})
onUnmounted(() => {
  widgetDisposed = true
  window.removeEventListener('resize', resizeChart)
  chartResizeObserver?.disconnect()
  chartResizeObserver = null
  disposeChart()
})
</script>

<template>
  <div
    class="widget-shell industrial-panel"
    :class="[
      `widget-kind-${type}`,
      { 'overlay-mode': overlayMode },
      { 'hud-brand': overlayMode && widget.id === 'heat_header_brand' },
      { 'hud-ring-only': overlayMode && widget.id === 'reference_oee_ring' },
      { 'text-is-kpi': isHudKpi },
      { 'hud-heading': overlayMode && type === 'text' && textLines[0]?.trim().startsWith('▸') },
      { 'text-is-state': overlayMode && type === 'text' && textLines.length === 1 && ['正常', '运行中', '在线', '报警', '离线', '停止', '待机'].includes(textLines[0]) },
      { 'data-pending': dataPending },
      animationClass,
      `quality-${boundQuality}`,
      { interactive: widgetEvents.length > 0 }
    ]"
    :style="shellStyle"
    @click="triggerEvents('click', $event)"
    @dblclick="triggerEvents('doubleClick', $event)"
  >
    <div v-if="widgetTitle && content.showTitle !== false && !['image', 'navigation', 'return_button'].includes(type)" class="widget-title"><i></i><span>{{ widgetTitle }}</span></div>

    <Transition name="widget-data-fade">
      <div v-if="dataPending" key="data-loading" class="widget-data-placeholder" aria-live="polite">
        <span class="widget-skeleton-line is-wide"></span>
        <span class="widget-skeleton-line"></span>
        <span class="widget-skeleton-line is-short"></span>
        <small>正在接收实时数据</small>
      </div>
    </Transition>

    <template v-if="type === 'navigation'">
      <div class="navigation-widget-preview">
        <div class="navigation-preview-status">
          <span class="navigation-preview-dot"></span>
          <span>{{ content.projectLabel || '热处理车间项目 · 南区热处理车间智能监控大屏' }}</span>
          <strong>{{ content.statusText || '模拟数据正常' }}</strong>
        </div>
      </div>
    </template>

    <template v-else-if="type === 'return_button'">
      <div class="return-button-widget-preview" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M15.25 4.75 8 12l7.25 7.25" /></svg>
      </div>
    </template>

    <template v-else-if="type === 'metrics'">
      <div class="metrics-layout" :class="{ 'list-only': content.layout === 'list' }"><div v-if="content.layout !== 'list'" ref="chartRef" class="widget-chart"></div><div class="metric-list"><div v-for="item in metricItems" :key="item.label" class="metric-row"><span>{{ item.label }}</span><strong>{{ item.value }}</strong></div><p v-if="!metricItems.length" class="metric-empty">{{ content.emptyText || '暂无指标数据' }}</p></div></div>
    </template>

    <template v-else-if="type === 'trend'">
      <div ref="chartRef" class="widget-chart trend-chart"></div>
      <div v-if="!dataPending && !hasTrendData" class="widget-data-empty">暂无趋势数据</div>
    </template>

    <template v-else-if="type === 'alarm_list'">
      <ul class="alarm-list"><li v-for="(event, index) in eventRows.slice(0, content.limit || 5)" :key="event.id || index"><span class="rank" :class="event.level">{{ index + 1 }}</span><span class="alarm-txt"><small v-if="content.showTime !== false">{{ event.time || event.occurred_at || '--' }}</small>{{ event.msg || event.title || event.message }}</span><span v-if="content.showLevel !== false" class="tag" :class="event.level">{{ event.level || 'info' }}</span></li></ul>
    </template>

    <template v-else-if="type === 'business_summary'">
      <div class="business-summary">
        <div class="business-toolbar"><span>{{ businessSectionLabel }}</span><small v-if="content.showSource !== false">{{ businessData?.source?.connectionId || '未配置只读连接' }}</small></div>
        <div v-if="businessLoading" class="business-empty"><strong>正在读取外部业务数据</strong><small>组件已就位，数据到达后自动更新</small></div>
        <div v-else-if="businessUnavailable" class="business-empty"><strong>{{ businessSectionMeta.message || content.unavailableText || '外部数据库未提供该类标准数据表' }}</strong><small>本组件只读展示，不会创建或修改排产数据</small></div>
        <div v-else-if="!businessRows.length" class="business-empty"><strong>{{ content.emptyText || '外部系统暂无记录' }}</strong><small>{{ businessData?.fetchedAt ? `最近读取 ${businessData.fetchedAt}` : '等待外部数据库读取' }}</small></div>
        <div v-else class="business-rows"><div v-for="(row, index) in businessRows" :key="row.id || row.batchNo || `${businessSection}-${index}`" class="business-row"><span><strong>{{ businessRowTitle(row) }}</strong><small>{{ businessRowSubtitle(row) }}</small></span><b>{{ businessRowValue(row) }}</b></div></div>
      </div>
    </template>

    <template v-else-if="type === 'marquee'">
      <div class="marquee-content-wrap"><div class="marquee-content" :style="{ animationDuration: (content.speed || 30) + 's' }"><template v-for="copy in 2" :key="copy"><span v-for="(event,index) in eventRows" :key="`${copy}-${event.id || index}`" class="marquee-item" :class="event.level">[{{ event.time || event.occurred_at || '--' }}] {{ event.msg || event.title || event.message }}</span></template></div></div>
    </template>

    <template v-else-if="type === 'text'">
      <div v-if="isHudKpi" class="text-widget-body hud-kpi-body">
        <p class="hud-kpi-label">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path v-if="widget.id === 'energy_value'" d="m11.4 1.8-7 9h5l-.8 7.4 7-10h-5z"/><path v-else d="M3 17V9h3v8zm5.5 0V3h3v14zm5.5 0V6h3v11z"/></svg>
          <span>{{ textLines[0] }}</span>
        </p>
        <p class="hud-kpi-value"><span>{{ hudKpiValue.value }}</span><small v-if="hudKpiValue.unit">{{ hudKpiValue.unit }}</small></p>
      </div>
      <div v-else class="text-widget-body" :style="{ textAlign: content.align || 'left' }"><p v-for="(line,index) in textLines" :key="index">{{ line }}</p></div>
    </template>

    <template v-else-if="type === 'value'">
      <div class="value-widget-body" :class="`shape-${content.shape || 'card'}`"><span>{{ content.label || widgetTitle }}</span><strong>{{ formatValue() }}<small v-if="dataBinding.unit">{{ dataBinding.unit }}</small></strong><em v-if="boundQuality !== 'good'">{{ boundQuality === 'bad' ? '离线' : '数据延迟' }}</em></div>
    </template>

    <template v-else-if="type === 'status'">
      <div class="status-widget-body" :class="[`state-${statusState}`, `shape-${content.shape || 'lamp'}`]"><span class="status-lamp"><i></i></span><div><small>{{ content.label || widgetTitle }}</small><strong>{{ statusText }}</strong></div></div>
    </template>

    <template v-else-if="type === 'device_list'">
      <div class="device-list"><div v-for="device in deviceRows" :key="device.id" class="device-list-row" :class="[`quality-${device.quality || 'bad'}`, { alarm: device.alarm }]"><i></i><span><strong>{{ device.name || device.id }}</strong><small>{{ device.online ? (device.running ? '运行中' : '在线待机') : '通讯离线' }}</small></span><b v-if="content.showTemperature !== false">{{ device.temp ?? '--' }}<small> °C</small></b></div><p v-if="!deviceRows.length">等待设备实时数据</p></div>
    </template>

    <template v-else-if="type === 'image'">
      <img v-if="content.url" class="image-widget" :src="content.url" :alt="content.alt || widgetTitle" :style="{ objectFit: content.fit || 'contain' }" />
      <div v-else class="image-placeholder"><span>▧</span><strong>选择图片</strong><small>在右侧内容属性填写地址</small></div>
    </template>

    <template v-else-if="type === 'container'">
      <div v-if="showContainerPlaceholder" class="container-placeholder"><span></span><small>{{ content.previewLabel || '容器区域' }}</small></div>
    </template>

    <template v-else>
      <div class="unknown-widget"><strong>{{ widgetTitle || type }}</strong><small>该组件由 {{ widget.runtimeTarget || 'Unity' }} 运行时处理</small></div>
    </template>
  </div>
</template>

<style scoped>
 .widget-shell{box-sizing:border-box;position:relative;width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:14px;border:1px solid rgba(91,169,219,.24);border-radius:14px;color:#edf7ff;background:rgba(10,24,38,.82);box-shadow:0 14px 34px rgba(0,8,18,.22);font-family:"SF Pro Text","Inter","Segoe UI Variable","Segoe UI","PingFang SC","Microsoft YaHei UI",sans-serif;font-synthesis:none;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;transition:border-color .18s,filter .18s,transform .18s,opacity .42s ease}.widget-shell.interactive{cursor:pointer}.widget-shell.quality-bad{filter:saturate(.72)}
 .widget-shell.data-pending> :not(.widget-title):not(.widget-data-placeholder){opacity:.18;filter:blur(1.2px);transition:opacity .42s ease,filter .42s ease}
 .widget-data-placeholder{position:absolute;z-index:4;inset:34px 12px 10px;display:grid;align-content:center;justify-items:center;gap:9px;pointer-events:none}
 .widget-skeleton-line{width:62%;height:8px;border-radius:99px;background:linear-gradient(90deg,rgba(141,160,207,.12),rgba(190,202,238,.35),rgba(141,160,207,.12));background-size:220% 100%;animation:widgetSkeletonShimmer 1.8s ease-in-out infinite}.widget-skeleton-line.is-wide{width:82%;height:10px}.widget-skeleton-line.is-short{width:42%;height:6px}.widget-data-placeholder small{margin-top:2px;color:rgba(187,201,231,.62);font-size:10px;letter-spacing:.04em}.widget-data-empty{position:absolute;inset:50% 0 auto;transform:translateY(-50%);color:rgba(167,183,214,.72);font-size:11px;text-align:center;pointer-events:none}.widget-data-fade-enter-active,.widget-data-fade-leave-active{transition:opacity .38s ease,transform .38s ease}.widget-data-fade-enter-from,.widget-data-fade-leave-to{opacity:0;transform:translateY(3px)}
 .widget-shell.overlay-mode{background:transparent;border-color:transparent;box-shadow:none}
 .widget-kind-navigation,.widget-kind-return_button{overflow:visible;padding:0;border-color:transparent!important;border-radius:0;background:transparent!important;box-shadow:none!important}
 .navigation-widget-preview{position:relative;width:100%;height:100%;min-height:42px;pointer-events:none}
 .navigation-preview-status{position:absolute;top:0;left:50%;display:flex;align-items:center;gap:9px;max-width:56%;min-height:34px;padding:7px 14px;transform:translateX(-50%);border:1px solid rgba(128,185,232,.28);border-radius:999px;color:#c8d8e6;background:linear-gradient(180deg,rgba(18,35,53,.86),rgba(8,20,34,.78));box-shadow:0 12px 32px rgba(0,8,18,.22);white-space:nowrap}
 .navigation-preview-status>span:not(.navigation-preview-dot){overflow:hidden;text-overflow:ellipsis;font-size:12px;font-weight:600}
 .navigation-preview-status strong{color:#f5b95e;font-size:11px;font-weight:600}
 .navigation-preview-dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:#4fd29a;box-shadow:0 0 0 4px rgba(79,210,154,.12),0 0 14px rgba(79,210,154,.48)}
 .return-button-widget-preview{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(255,255,255,.14);border-radius:10px;color:rgba(255,255,255,.94);background:rgba(29,29,31,.96);box-shadow:0 8px 24px rgba(0,0,0,.24);pointer-events:none}
 .return-button-widget-preview svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.15;stroke-linecap:round;stroke-linejoin:round}
.widget-title{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:22px;margin-bottom:8px;color:inherit;font-size:13px;font-weight:700;letter-spacing:.02em}.widget-title i{width:3px;height:14px;border-radius:99px;background:var(--widget-line-color,#55c7ff);box-shadow:0 0 12px color-mix(in srgb,var(--widget-line-color,#55c7ff) 55%,transparent)}.widget-title span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.metrics-layout{flex:1;min-height:0;display:grid;grid-template-columns:minmax(110px,38%) minmax(0,1fr);gap:12px}.metrics-layout.list-only{display:block}.widget-chart{width:100%;height:100%;min-height:80px}.trend-chart{flex:1}.metric-list{min-height:0;display:grid;align-content:center;gap:3px;overflow:hidden}.list-only .metric-list{height:100%;align-content:start;gap:0}.metric-row{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:26px;padding:3px 0;border-bottom:1px solid rgba(175,214,239,.07);color:#91a7b9;font-size:11px}.list-only .metric-row{min-height:42px;padding:7px 2px;font-size:12px}.metric-row strong{color:#f1f8fd;font-size:13px}.list-only .metric-row strong{font-size:15px}.metric-empty{display:grid;place-items:center;min-height:100%;margin:0;color:#71899d;font-size:11px;text-align:center}
.alarm-list{flex:1;min-height:0;margin:0;padding:0;overflow:hidden;list-style:none}.alarm-list li{display:grid;grid-template-columns:25px minmax(0,1fr) auto;gap:8px;align-items:center;min-height:31px;border-bottom:1px solid rgba(174,214,240,.07);font-size:10px}.rank,.tag{display:grid;place-items:center;min-height:20px;padding:0 5px;border-radius:6px;color:#91bdd8;background:rgba(74,141,185,.12)}.rank.warning,.tag.warning{color:#ffd080;background:rgba(255,176,52,.12)}.rank.critical,.tag.critical{color:#ff8c88;background:rgba(255,94,89,.12)}.alarm-txt{min-width:0;overflow:hidden;color:#d0dfeb;text-overflow:ellipsis;white-space:nowrap}.alarm-txt small{margin-right:7px;color:#6f899d}.tag{font-size:8px;text-transform:uppercase}
.marquee-content-wrap{flex:1;min-height:0;overflow:hidden}.marquee-content{display:flex;align-items:center;width:max-content;height:100%;white-space:nowrap;animation:widgetMarquee linear infinite}.marquee-item{margin-right:42px;color:inherit;font-size:12px}.marquee-item.warning{color:#ffd080}.marquee-item.critical{color:#ff8c88}
.text-widget-body{flex:1;min-height:0;display:grid;align-content:center;gap:5px;overflow:hidden;color:inherit;line-height:1.5}.text-widget-body p{margin:0;white-space:pre-wrap}
.value-widget-body{flex:1;min-height:0;display:grid;align-content:center;gap:6px}.value-widget-body>span{color:#8ea7ba;font-size:12px}.value-widget-body strong{color:var(--widget-value-color);font-size:clamp(24px,3vw,48px);font-weight:800;line-height:1.05;text-shadow:0 0 20px color-mix(in srgb,var(--widget-value-color) 24%,transparent)}.value-widget-body strong small{margin-left:7px;color:#9fb3c3;font-size:.34em;font-weight:500}.value-widget-body em{color:#ffb05c;font-size:9px;font-style:normal}.value-widget-body.shape-tile strong{letter-spacing:.08em;font-family:Consolas,monospace}.value-widget-body.shape-plain{align-content:center;text-align:center}.value-widget-body.shape-gauge::before{content:"";position:absolute;right:14px;bottom:14px;width:56px;height:56px;border:7px solid rgba(91,184,237,.12);border-top-color:var(--widget-value-color);border-radius:50%}
.status-widget-body{flex:1;min-height:0;display:flex;align-items:center;gap:13px}.status-lamp{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:rgba(116,142,162,.1)}.status-lamp i{width:18px;height:18px;border-radius:50%;background:var(--widget-off-color);box-shadow:0 0 0 6px color-mix(in srgb,var(--widget-off-color) 12%,transparent),0 0 15px color-mix(in srgb,var(--widget-off-color) 30%,transparent)}.state-on .status-lamp i{background:var(--widget-on-color);box-shadow:0 0 0 6px color-mix(in srgb,var(--widget-on-color) 12%,transparent),0 0 18px color-mix(in srgb,var(--widget-on-color) 50%,transparent)}.state-unknown .status-lamp i{background:var(--widget-alarm-color)}.status-widget-body div{display:grid;gap:3px}.status-widget-body small{color:#829bae;font-size:10px}.status-widget-body strong{font-size:20px}.status-widget-body.shape-badge .status-lamp{width:24px;height:24px}.status-widget-body.shape-badge .status-lamp i{width:10px;height:10px}.status-widget-body.shape-switch .status-lamp{width:52px;height:26px;border-radius:99px;justify-content:start;padding:4px}.status-widget-body.shape-switch .status-lamp i{width:18px;height:18px;box-shadow:none;transition:.2s}.status-widget-body.shape-switch.state-on .status-lamp{justify-content:end;background:color-mix(in srgb,var(--widget-on-color) 22%,transparent)}
.device-list{flex:1;min-height:0;overflow:hidden}.device-list-row{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:9px;align-items:center;min-height:37px;border-bottom:1px solid rgba(174,214,240,.07)}.device-list-row>i{width:7px;height:7px;border-radius:50%;background:#45d797;box-shadow:0 0 9px rgba(69,215,151,.45)}.device-list-row.quality-bad>i{background:#75899a;box-shadow:none}.device-list-row.alarm>i{background:#ff625f;box-shadow:0 0 10px rgba(255,98,95,.55)}.device-list-row span{min-width:0}.device-list-row span strong,.device-list-row span small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.device-list-row span strong{font-size:10px}.device-list-row span small{margin-top:2px;color:#728ca1;font-size:8px}.device-list-row>b{color:#dcebf6;font-size:11px}.device-list-row>b small{color:#728ca1;font-size:8px}.device-list>p{display:grid;place-items:center;height:100%;margin:0;color:#71899d;font-size:10px}
.business-summary{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}.business-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;color:#b7d6e8;font-size:11px}.business-toolbar span{font-weight:700}.business-toolbar small{max-width:48%;overflow:hidden;color:#6f899d;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.business-rows{min-height:0;overflow:hidden}.business-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;min-height:40px;padding:5px 7px;border-bottom:1px solid rgba(174,214,240,.07)}.business-row span{min-width:0}.business-row strong,.business-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.business-row strong{color:#e4f2fb;font-size:11px}.business-row small{margin-top:3px;color:#71899d;font-size:9px}.business-row b{color:#67d2ff;font-size:13px;font-weight:700}.business-empty{flex:1;display:grid;place-content:center;gap:8px;padding:12px;text-align:center;color:#8aa3b4}.business-empty strong{color:#b8d3e3;font-size:11px}.business-empty small{color:#6f899d;font-size:9px;line-height:1.5}
.image-widget{width:100%;height:100%;display:block}.image-placeholder,.unknown-widget,.container-placeholder{flex:1;display:grid;place-content:center;gap:5px;text-align:center;color:#71899d}.image-placeholder>span{font-size:30px;color:#61bce9}.image-placeholder strong,.unknown-widget strong{color:#b8d2e4}.image-placeholder small,.unknown-widget small,.container-placeholder small{font-size:9px}.container-placeholder span{width:58px;height:32px;border:1px dashed rgba(91,184,237,.35);border-radius:7px;justify-self:center}.unknown-widget{border:1px dashed rgba(100,164,207,.24);border-radius:8px}
.widget-animation-fadeIn{animation-name:widgetFadeIn;animation-fill-mode:both}.widget-animation-slideUp{animation-name:widgetSlideUp;animation-fill-mode:both}.widget-animation-pulse{animation-name:widgetPulse;animation-timing-function:ease-in-out}.widget-animation-breathe{animation-name:widgetBreathe;animation-timing-function:ease-in-out}.widget-animation-float{animation-name:widgetFloat;animation-timing-function:ease-in-out}.widget-animation-blink{animation-name:widgetBlink;animation-timing-function:steps(2,end)}
@keyframes widgetMarquee{to{transform:translateX(-50%)}}@keyframes widgetFadeIn{from{opacity:0}to{opacity:1}}@keyframes widgetSlideUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}@keyframes widgetPulse{50%{transform:scale(1.018)}}@keyframes widgetBreathe{50%{filter:brightness(1.14);box-shadow:0 0 30px rgba(63,182,255,.22)}}@keyframes widgetFloat{50%{transform:translateY(-5px)}}@keyframes widgetBlink{50%{opacity:.45}}@keyframes widgetSkeletonShimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}
</style>
<style src="./hudWidgets.css"></style>
