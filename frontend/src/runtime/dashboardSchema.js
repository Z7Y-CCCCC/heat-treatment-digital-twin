export const DASHBOARD_SCHEMA_VERSION = 3

export const DEFAULT_DASHBOARD_CANVAS = Object.freeze({
  width: 1920,
  height: 1080,
  gridSize: 10,
  background: 'transparent',
  safeArea: 24,
  legacyGrid: { columns: 24, rows: 12 }
})

export const SYSTEM_WIDGET_TYPES = new Set(['navigation', 'return_button', 'device_label', 'diagnostics', 'line_overview_cards'])
const SYSTEM_VIEW_COMPONENT_IDS = new Set([
  'widget_navigation', 'widget_return_button', 'widget_device_label', 'widget_diagnostics', 'widget_line_overview_cards',
  'navigation', 'return_button', 'device_label', 'diagnostics', 'line_overview_cards'
])

export const SYSTEM_WIDGET_LIBRARY = [
  // 其余三种旧 Unity OnGUI 组件仍保留在 SYSTEM_WIDGET_TYPES 中用于读取历史发布，
  // 但正式大屏已经由透明 Web 数据层接管，不再向设计器暴露。
  { type: 'navigation', label: '顶部导航状态', icon: '●', description: '顶部项目名称、连接状态和运行状态', preview: 'navigation' },
  { type: 'return_button', label: '返回键', icon: '‹', description: '返回当前视角的上一级视角', preview: 'return_button' }
]

export const DASHBOARD_VIEW_MODES = [
  { id: 'factory', label: '全厂总览', description: '查看全部车间、产线和设备' },
  { id: 'workshop', label: '车间视角', description: '聚焦一个车间及其产线' },
  { id: 'line', label: '产线视角', description: '聚焦一条产线及设备' },
  { id: 'device', label: '设备详情', description: '聚焦单台设备和详情组件' },
  { id: 'custom', label: '自定义视角', description: '按工程师设置的目标和组件状态展示' }
]

const DEFAULT_VIEW_DEFINITIONS = [
  { id: 'factory_overview', name: '全厂总览', mode: 'factory', targetType: 'factory', parentViewId: '', camera: { yaw: -39, pitch: 33, distanceScale: 1.08, transitionSeconds: .8 } },
  { id: 'workshop_overview', name: '车间视角', mode: 'workshop', targetType: 'workshop', parentViewId: 'factory_overview', camera: { yaw: -39, pitch: 36, distanceScale: 1.08, transitionSeconds: .7 } },
  { id: 'line_overview', name: '产线视角', mode: 'line', targetType: 'line', parentViewId: 'workshop_overview', camera: { yaw: -39, pitch: 33, distanceScale: 1.08, transitionSeconds: .65 } },
  { id: 'device_detail', name: '设备实体视角', mode: 'device', targetType: 'device', parentViewId: 'line_overview', camera: { yaw: 238, pitch: 19, distanceScale: 1.12, transitionSeconds: .55, relativeToTarget: true }, metadata: { inspectionStage: 'solid' } },
  { id: 'device_xray', name: '设备透视视角', mode: 'device', targetType: 'device', parentViewId: 'device_detail', camera: { yaw: 238, pitch: 19, distanceScale: 1.08, transitionSeconds: .65, relativeToTarget: true }, metadata: { inspectionStage: 'xray' } },
  { id: 'device_exploded', name: '设备拆解视角', mode: 'device', targetType: 'device', parentViewId: 'device_xray', camera: { yaw: 238, pitch: 22, distanceScale: 1.22, transitionSeconds: .7, relativeToTarget: true }, metadata: { inspectionStage: 'exploded' } },
  { id: 'device_part', name: '部件详情视角', mode: 'device', targetType: 'device_part', parentViewId: 'device_exploded', camera: { yaw: 238, pitch: 18, distanceScale: 1.35, transitionSeconds: .55, relativeToTarget: true }, metadata: { inspectionStage: 'part' } }
]

function normalizeDashboardView(source = {}, index = 0) {
  const fallback = DEFAULT_VIEW_DEFINITIONS[index] || DEFAULT_VIEW_DEFINITIONS[0]
  const camera = objectValue(source.camera, {})
  const componentState = objectValue(source.componentState || source.components, {})
  const allowedModes = new Set(DASHBOARD_VIEW_MODES.map(item => item.id))
  const mode = allowedModes.has(String(source.mode)) ? String(source.mode) : fallback.mode
  const parentValue = source.parentViewId ?? source.parent_view_id
  const returnValue = source.returnViewId ?? source.return_view_id
  return {
    id: String(source.id || fallback.id || `view_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_'),
    name: String(source.name || fallback.name || `视角 ${index + 1}`),
    mode,
    targetType: String(source.targetType || fallback.targetType || (mode === 'custom' ? 'factory' : mode)),
    targetId: String(source.targetId || source.target_id || ''),
    parentViewId: parentValue !== undefined ? String(parentValue) : String(fallback.parentViewId || ''),
    returnViewId: returnValue !== undefined
      ? String(returnValue)
      : String(parentValue !== undefined ? parentValue : fallback.parentViewId || ''),
    camera: {
      yaw: numberValue(camera.yaw, fallback.camera.yaw, -360, 360),
      pitch: numberValue(camera.pitch, fallback.camera.pitch, -89, 89),
      distanceScale: numberValue(camera.distanceScale, fallback.camera.distanceScale, .1, 10),
      transitionSeconds: numberValue(camera.transitionSeconds, fallback.camera.transitionSeconds, 0, 10),
      relativeToTarget: camera.relativeToTarget ?? fallback.camera.relativeToTarget ?? false,
      targetOffset: Array.isArray(camera.targetOffset) ? camera.targetOffset.slice(0, 3).map(item => numberValue(item, 0, -10000, 10000)) : [0, 0, 0]
    },
    componentState: {
      show: stringArray(componentState.show),
      hide: stringArray(componentState.hide),
      hideNonTargetDevices: !!componentState.hideNonTargetDevices
    },
    metadata: deepClone(objectValue(source.metadata, {}))
  }
}

export function createDefaultDashboardViews() {
  return DEFAULT_VIEW_DEFINITIONS.map((view, index) => normalizeDashboardView(view, index))
}

export function normalizeDashboardViews(scene = {}) {
  const source = objectValue(scene, {})
  const raw = Array.isArray(source.views) && source.views.length ? source.views : createDefaultDashboardViews()
  const existingIds = new Set(raw.map(view => String(view?.id || '')))
  const inspectionDefaults = createDefaultDashboardViews().filter(view => view.id.startsWith('device_') && !existingIds.has(view.id))
  const views = [...raw, ...inspectionDefaults].slice(0, 50).map((view, index) => normalizeDashboardView(view, index))
  const ids = new Set(views.map(view => view.id))
  const defaultViewId = ids.has(String(source.defaultViewId || '')) ? String(source.defaultViewId) : (views[0]?.id || 'factory_overview')

  // A broken parent reference used to leave a deep view in the tree while
  // Unity had nowhere valid to return. Keep the authored view, but repair the
  // navigation edge during normalization so Esc can always walk back safely.
  views.forEach(view => {
    if (view.parentViewId === view.id || (view.parentViewId && !ids.has(view.parentViewId))) view.parentViewId = ''
    if (view.returnViewId === view.id || (view.returnViewId && !ids.has(view.returnViewId))) {
      view.returnViewId = view.parentViewId || ''
    }
  })
  return { views, defaultViewId }
}

export const DASHBOARD_WIDGET_LIBRARY = [
  { type: 'text', label: '文本', icon: 'T', group: '基础', description: '标题、说明和动态文本' },
  { type: 'value', label: '数值', icon: '12', group: '基础', description: '任意数据源的数值与格式' },
  { type: 'status', label: '状态灯', icon: '●', group: '基础', description: '布尔状态、在线和报警' },
  { type: 'image', label: '图片', icon: '▧', group: '基础', description: '现场图片、Logo 和图标' },
  { type: 'navigation', label: '顶部导航状态', icon: '●', group: '导航', description: '独立的项目名称、连接状态和运行状态' },
  { type: 'return_button', label: '返回键', icon: '‹', group: '导航', description: '独立的上一级视角返回按钮' },
  { type: 'container', label: '容器', icon: '□', group: '布局', description: '透明卡片和区域分组' },
  { type: 'metrics', label: '指标组', icon: '▦', group: '数据', description: '多指标与环形图' },
  { type: 'business_summary', label: '业务摘要', icon: '▤', group: '数据', description: '只读显示排产批次、合规曲线、利用率、能耗和维护记录' },
  { type: 'trend', label: '通用图表', icon: '⌁', group: '数据', description: '折线、面积、柱状、饼图、环图和仪表盘' },
  { type: 'alarm_list', label: '报警表', icon: '!', group: '数据', description: '只读报警与事件履历' },
  { type: 'device_list', label: '设备列表', icon: '☷', group: '数据', description: '设备在线、运行和报警状态' },
  { type: 'marquee', label: '滚动消息', icon: '↔', group: '数据', description: '实时日志和报警滚动条' }
]

export const DASHBOARD_WIDGET_PRESETS = [
  {
    id: 'device_part_detail',
    label: '部件详情面板',
    icon: '▤',
    group: '设备检查',
    description: '生成右侧部件名称、说明和实时参数面板，并绑定设备检查上下文'
  }
]

const TYPE_DEFAULTS = {
  text: {
    size: [360, 120],
    title: '文本',
    content: { text: '双击右侧属性修改文本', tone: 'normal', align: 'left' },
    style: { background: 'rgba(14, 28, 43, .72)', color: '#eef7ff', fontSize: 24, borderColor: 'rgba(89, 178, 238, .25)', borderRadius: 12 }
  },
  value: {
    size: [300, 170],
    title: '设备参数',
    content: { label: '实时数值', fallback: '--', shape: 'card' },
    style: { background: 'rgba(14, 28, 43, .78)', color: '#ffffff', valueColor: '#68d5ff', fontSize: 42, borderColor: 'rgba(89, 178, 238, .32)', borderRadius: 14 }
  },
  status: {
    size: [260, 130],
    title: '设备状态',
    content: { onText: '正常', offText: '停止', unknownText: '离线', shape: 'lamp' },
    style: { background: 'rgba(14, 28, 43, .78)', color: '#eef7ff', onColor: '#45df9b', offColor: '#8394a5', alarmColor: '#ff625f', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  trend: {
    size: [520, 300],
    title: '实时趋势',
    content: {
      seriesName: '实时值', chartType: 'line', chartPalette: 'industrial',
      lineColor: '#55c7ff', areaColor: 'rgba(85,199,255,.18)', historyLength: 60,
      showLegend: true, legendPosition: 'top', showAxis: true, showDataLabel: false,
      smooth: true, showSymbol: false, lineWidth: 2, areaOpacity: .2,
      barRadius: 4, donutRatio: 48
    },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  alarm_list: {
    size: [520, 300],
    title: '报警履历',
    content: { limit: 6, showLevel: true, showTime: true },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(255, 131, 94, .24)', borderRadius: 14 }
  },
  device_list: {
    size: [420, 320],
    title: '设备列表',
    content: { limit: 12, layout: 'list', showTemperature: true },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  image: {
    size: [360, 220],
    title: '',
    content: { url: '', fit: 'contain', alt: '图片' },
    style: { background: 'rgba(10, 24, 38, .35)', borderColor: 'rgba(89, 178, 238, .18)', borderRadius: 12 }
  },
  container: {
    size: [640, 360],
    title: '分组容器',
    content: { showTitle: true },
    style: { background: 'rgba(8, 22, 36, .42)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .26)', borderRadius: 16 }
  },
  metrics: {
    size: [500, 300],
    title: '生产指标',
    content: { compact: true },
    style: { background: 'rgba(10, 24, 38, .82)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .28)', borderRadius: 14 }
  },
  business_summary: {
    size: [620, 340],
    title: '排产业务摘要',
    content: {
      section: 'batches',
      limit: 6,
      emptyText: '外部系统暂无记录',
      unavailableText: '外部数据库未提供该类标准数据表',
      showSource: true
    },
    style: { background: 'rgba(10, 24, 38, .84)', color: '#eef7ff', borderColor: 'rgba(89, 178, 238, .32)', borderRadius: 14 }
  },
  marquee: {
    size: [1080, 76],
    title: '实时消息',
    content: { speed: 30, limit: 20, eventWindowHours: 24 },
    style: { background: 'rgba(9, 22, 35, .8)', color: '#dbeeff', borderColor: 'rgba(89, 178, 238, .22)', borderRadius: 12 }
  },
  navigation: {
    size: [600, 42],
    title: '顶部导航状态',
    content: {
      showTitle: false,
      projectLabel: '热处理车间项目 · 南区热处理车间智能监控大屏',
      statusText: '模拟数据正常'
    },
    style: { background: 'transparent', color: '#eef7ff', borderColor: 'transparent', borderRadius: 0 }
  },
  return_button: {
    size: [42, 42],
    title: '返回键',
    content: { showTitle: false },
    style: { background: 'transparent', color: '#eef7ff', borderColor: 'transparent', borderRadius: 0 }
  }
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function numberValue(value, fallback, min = -Infinity, max = Infinity) {
  const next = Number(value)
  return Number.isFinite(next) ? Math.max(min, Math.min(max, next)) : fallback
}

function objectValue(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : []
}

function normalizeDatabaseDataset(source = {}, fallback = {}, index = 0) {
  const data = objectValue(source, {})
  const base = objectValue(fallback, {})
  const aliasFallback = String.fromCharCode(97 + Math.min(index, 25))
  const alias = String(data.alias || aliasFallback).replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase().slice(0, 32) || aliasFallback
  return {
    alias,
    label: String(data.label || `数据项 ${alias.toUpperCase()}`).slice(0, 100),
    color: String(data.color || ['#55c7ff', '#45df9b', '#ffc45f', '#ff6b78'][index % 4]).slice(0, 64),
    connectionId: String(data.connectionId || data.connection_id || base.connectionId || base.connection_id || ''),
    schema: String(data.schema || base.schema || ''),
    table: String(data.table || base.table || ''),
    field: String(data.field || base.field || ''),
    timeField: String(data.timeField || base.timeField || ''),
    orderBy: String(data.orderBy || data.timeField || base.orderBy || base.timeField || ''),
    orderDirection: String(data.orderDirection || base.orderDirection || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    valueMode: ['latest', 'first', 'list', 'count', 'sum', 'avg', 'min', 'max'].includes(data.valueMode || base.valueMode) ? (data.valueMode || base.valueMode) : 'latest',
    rowLimit: Math.round(numberValue(data.rowLimit ?? base.rowLimit, 50, 1, 500)),
    refreshMs: Math.round(numberValue(data.refreshMs ?? base.refreshMs, 5000, 1000, 3600000)),
    contextField: String(data.contextField || ''),
    contextKey: ['deviceId', 'lineId', 'workshopId', 'viewId', 'partId'].includes(data.contextKey) ? data.contextKey : ''
  }
}

function normalizeVisibility(source = {}) {
  const visibility = objectValue(source, {})
  const allowedModes = new Set(['factory', 'workshop', 'line', 'device', 'custom'])
  return {
    viewModes: stringArray(visibility.viewModes).filter(mode => allowedModes.has(mode)),
    viewIds: stringArray(visibility.viewIds),
    matchBoundDevice: !!visibility.matchBoundDevice,
    ruleMode: visibility.ruleMode === 'any' ? 'any' : 'all',
    rules: Array.isArray(visibility.rules) ? deepClone(visibility.rules).slice(0, 20) : []
  }
}

export function normalizeDashboardWidget(source = {}, canvas = DEFAULT_DASHBOARD_CANVAS, index = 0) {
  const type = source.type || source.widget_type || 'text'
  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.text
  const config = objectValue(source.content, objectValue(source.config, {}))
  const frame = objectValue(source.frame, {})
  const legacyColumns = canvas.legacyGrid?.columns || 24
  const legacyRows = canvas.legacyGrid?.rows || 12
  const hasCanonicalFrame = frame.width !== undefined || frame.height !== undefined
  const isLegacyNavigationSeed = type === 'navigation' && !hasCanonicalFrame
    && Number(source.x || 0) === 0 && Number(source.y || 0) === 0
    && Number(source.w || 0) === 5 && Number(source.h || 0) === 5
  const data = objectValue(source.data, objectValue(source.binding, {}))
  const requestedMode = String(data.mode || '')
  const normalizedMode = requestedMode === 'plc' || requestedMode === 'database' || requestedMode === 'runtime' || requestedMode === 'business'
    ? requestedMode
    : 'static'
  const resolvedDataMode = normalizedMode === 'static'
    ? (type === 'business_summary' ? 'business' : (data.connectionId || data.connection_id ? 'database' : (data.pointId || data.point_id ? 'plc' : 'static')))
    : normalizedMode
  const rawDeviceId = data.deviceId || data.device_id || ''
  const requestedDeviceScope = String(data.deviceScope || data.device_scope || '').toLowerCase()
  const deviceScope = requestedDeviceScope === 'current' || requestedDeviceScope === 'fixed'
    ? requestedDeviceScope
    : (rawDeviceId ? 'fixed' : 'current')
  const legacyDataset = normalizeDatabaseDataset(data, data, 0)
  const datasets = (Array.isArray(data.datasets) && data.datasets.length ? data.datasets : [legacyDataset])
    .slice(0, 12)
    .map((item, datasetIndex) => normalizeDatabaseDataset(item, legacyDataset, datasetIndex))
  const normalizedFrame = isLegacyNavigationSeed
    ? { x: 660, y: 18, width: 600, height: 42, rotation: 0 }
    : {
        x: hasCanonicalFrame ? numberValue(frame.x, 0) : numberValue(source.x, 0) / legacyColumns * canvas.width,
        y: hasCanonicalFrame ? numberValue(frame.y, 0) : numberValue(source.y, 0) / legacyRows * canvas.height,
        width: hasCanonicalFrame ? numberValue(frame.width, defaults.size[0], 20) : numberValue(source.w, defaults.size[0] / canvas.width * legacyColumns) / legacyColumns * canvas.width,
        height: hasCanonicalFrame ? numberValue(frame.height, defaults.size[1], 20) : numberValue(source.h, defaults.size[1] / canvas.height * legacyRows) / legacyRows * canvas.height,
        rotation: numberValue(frame.rotation, 0, -360, 360)
      }
  const normalizedStyle = {
    ...deepClone(defaults.style || {}),
    ...deepClone(source.style || source.config?.style || {})
  }
  // Keep panel background alpha separate from content opacity.  The latter
  // fades text/charts as well, while this value only controls the HUD glass
  // surface in overlay mode. Legacy documents without the field get a thin
  // glass default instead of inheriting their old opaque card background.
  normalizedStyle.backgroundOpacity = numberValue(
    normalizedStyle.backgroundOpacity,
    type === 'navigation' || type === 'return_button' ? 0 : 0.12,
    0,
    1
  )
  normalizedStyle.opacity = numberValue(normalizedStyle.opacity, 1, 0, 1)
  return {
    id: String(source.id || `widget_${type}_${index + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_'),
    type,
    title: String(source.title ?? defaults.title ?? ''),
    visible: source.visible !== false && source.visible !== 0,
    locked: !!source.locked,
    zIndex: Math.round(numberValue(source.zIndex ?? source.sort_order, index, -1000, 10000)),
    runtimeTarget: source.runtimeTarget || (SYSTEM_WIDGET_TYPES.has(type) ? 'unity' : 'overlay'),
    groupId: String(source.groupId || source.config?.__designer?.groupId || ''),
    frame: normalizedFrame,
    content: { ...deepClone(defaults.content || {}), ...deepClone(config) },
    style: normalizedStyle,
    data: {
      // 旧版无来源指标仍迁移为静态占位；新 runtime 模式只读取当前视角与部件上下文。
      mode: resolvedDataMode,
      deviceScope,
      deviceId: String(rawDeviceId),
      pointId: String(data.pointId || data.point_id || ''),
      pointKey: String(data.pointKey || data.point_key || ''),
      path: resolvedDataMode === 'static' ? '' : String(data.path || ''),
      source: resolvedDataMode === 'static' ? '' : String(data.source || ''),
      connectionId: String(data.connectionId || data.connection_id || ''),
      businessSection: ['batches', 'compliance', 'oee', 'energy', 'maintenance'].includes(String(data.businessSection || data.business_section))
        ? String(data.businessSection || data.business_section)
        : (['batches', 'compliance', 'oee', 'energy', 'maintenance'].includes(String(config.section)) ? String(config.section) : 'batches'),
      schema: String(data.schema || ''),
      table: String(data.table || ''),
      field: String(data.field || ''),
      timeField: String(data.timeField || ''),
      orderBy: String(data.orderBy || data.timeField || ''),
      orderDirection: String(data.orderDirection || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
      valueMode: ['latest', 'first', 'list', 'count', 'sum', 'avg', 'min', 'max'].includes(data.valueMode) ? data.valueMode : 'latest',
      rowLimit: Math.round(numberValue(data.rowLimit, 50, 1, 500)),
      refreshMs: Math.round(numberValue(data.refreshMs, 5000, 1000, 3600000)),
      datasets,
      formula: String(data.formula || '').slice(0, 256),
      formulaLabel: String(data.formulaLabel || '计算结果').slice(0, 100),
      formulaColor: String(data.formulaColor || '#45df9b').slice(0, 64),
      unit: String(data.unit || ''),
      decimals: Math.round(numberValue(data.decimals, 1, 0, 8)),
      readOnly: true
    },
    visibility: normalizeVisibility(source.visibility || source.config?.visibility),
    conditions: Array.isArray(source.conditions) ? deepClone(source.conditions) : deepClone(source.config?.conditions || []),
    animation: { type: 'none', duration: 1.2, delay: 0, iteration: 'infinite', ...deepClone(source.animation || source.config?.animation || {}) },
    events: Array.isArray(source.events) ? deepClone(source.events) : deepClone(source.config?.events || [])
  }
}

function navigationFrames(canvas = DEFAULT_DASHBOARD_CANVAS) {
  const width = Math.max(220, Math.min(600, Math.round(Number(canvas.width || 1920) * .32)))
  return {
    navigation: { x: Math.round((Number(canvas.width || 1920) - width) / 2), y: 18, width, height: 42, rotation: 0 },
    returnButton: { x: 20, y: 18, width: 42, height: 42, rotation: 0 }
  }
}

function ensureNavigationWidgets(rawWidgets, canvas) {
  const widgets = Array.isArray(rawWidgets) ? rawWidgets.slice(0, 500) : []
  const frames = navigationFrames(canvas)
  let navigationIndex = widgets.findIndex(widget => String(widget?.type || widget?.widget_type || '').toLowerCase() === 'navigation')
  let returnIndex = widgets.findIndex(widget => String(widget?.type || widget?.widget_type || '').toLowerCase() === 'return_button')
  const missingCount = (navigationIndex < 0 ? 1 : 0) + (returnIndex < 0 ? 1 : 0)
  if (widgets.length + missingCount > 500) {
    let removeCount = widgets.length + missingCount - 500
    for (let index = widgets.length - 1; index >= 0 && removeCount > 0; index -= 1) {
      const type = String(widgets[index]?.type || widgets[index]?.widget_type || '').toLowerCase()
      if (type === 'navigation' || type === 'return_button') continue
      widgets.splice(index, 1)
      removeCount -= 1
    }
    navigationIndex = widgets.findIndex(widget => String(widget?.type || widget?.widget_type || '').toLowerCase() === 'navigation')
    returnIndex = widgets.findIndex(widget => String(widget?.type || widget?.widget_type || '').toLowerCase() === 'return_button')
  }

  if (navigationIndex < 0) {
    widgets.push({
      id: 'widget_navigation',
      type: 'navigation',
      title: '顶部导航状态',
      frame: frames.navigation,
      content: { showTitle: false, projectLabel: '热处理车间项目 · 南区热处理车间智能监控大屏', statusText: '模拟数据正常' },
      style: { background: 'transparent', color: '#eef7ff', borderColor: 'transparent', borderRadius: 0 },
      runtimeTarget: 'unity',
      zIndex: 1000,
      visible: true
    })
  } else if (returnIndex < 0) {
    // The old navigation item represented both the status pill and the
    // return button. Once split, keep its text but give it the status frame.
    widgets[navigationIndex] = { ...widgets[navigationIndex], frame: frames.navigation, type: 'navigation' }
  }

  if (returnIndex < 0) {
    widgets.push({
      id: 'widget_return_button',
      type: 'return_button',
      title: '返回键',
      frame: frames.returnButton,
      content: { showTitle: false },
      style: { background: 'transparent', color: '#eef7ff', borderColor: 'transparent', borderRadius: 0 },
      runtimeTarget: 'unity',
      zIndex: 1001,
      visible: true
    })
  }
  return widgets
}

export function normalizeDashboardDocument(source = {}) {
  const canvas = {
    ...DEFAULT_DASHBOARD_CANVAS,
    ...objectValue(source.canvas, {}),
    legacyGrid: { ...DEFAULT_DASHBOARD_CANVAS.legacyGrid, ...objectValue(source.canvas?.legacyGrid, {}) }
  }
  canvas.width = Math.round(numberValue(canvas.width, 1920, 320, 7680))
  canvas.height = Math.round(numberValue(canvas.height, 1080, 180, 4320))
  canvas.gridSize = Math.round(numberValue(canvas.gridSize, 10, 1, 200))
  canvas.safeArea = Math.round(numberValue(canvas.safeArea, 24, 0, 400))
  const rawScene = objectValue(source.scene, {})
  const rawWidgets = Array.isArray(source.widgets) ? source.widgets : []
  const widgetSources = ensureNavigationWidgets(rawWidgets, canvas)
  const widgets = widgetSources.map((widget, index) => normalizeDashboardWidget(widget, canvas, index))
  const widgetIds = new Set(widgets.map(widget => widget.id))
  const groupIds = new Set(widgets.map(widget => widget.groupId).filter(Boolean))
  const targetExists = target => {
    const id = String(target || '')
    if (!id) return false
    if (id.startsWith('system:') || SYSTEM_VIEW_COMPONENT_IDS.has(id)) return true
    if (id.startsWith('group:')) return groupIds.has(id.slice('group:'.length))
    return widgetIds.has(id)
  }
  widgets.forEach(widget => {
    widget.events = (widget.events || []).filter(event => {
      if (!['set_visibility', 'toggle_visibility'].includes(event?.action)) return true
      if (event.targetType === 'widget') return widgetIds.has(event.targetId)
      if (event.targetType === 'group') return groupIds.has(event.targetId)
      return false
    })
  })
  const normalizedViews = normalizeDashboardViews(rawScene)
  const validViewIds = new Set(normalizedViews.views.map(view => view.id))
  widgets.forEach(widget => {
    if (Array.isArray(widget.visibility?.viewIds)) {
      widget.visibility.viewIds = widget.visibility.viewIds.filter(viewId => validViewIds.has(String(viewId)))
    }
    if (Array.isArray(widget.events)) {
      widget.events = widget.events.map(event => {
        if (event?.action === 'switch_view' && event.viewId && !validViewIds.has(String(event.viewId))) {
          return { ...event, viewId: normalizedViews.defaultViewId }
        }
        return event
      })
    }
  })
  normalizedViews.views = normalizedViews.views.map(view => ({
    ...view,
    componentState: {
      ...view.componentState,
      show: (view.componentState?.show || []).filter(targetExists),
      hide: (view.componentState?.hide || []).filter(targetExists)
    }
  }))
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    projectId: String(source.projectId || 'project_default'),
    sceneId: String(source.sceneId || 'scene_factory_overview'),
    name: String(source.name || source.scene?.name || '工厂总览'),
    canvas,
    theme: {
      preset: 'industrial_twin',
      fontFamily: 'Microsoft YaHei UI',
      accentColor: '#42a5f5',
      ...deepClone(source.theme || {})
    },
    scene: {
      ...deepClone(rawScene),
      ...normalizedViews
    },
    widgets,
    metadata: deepClone(source.metadata || {})
  }
}

export function createDashboardWidget(type, index = 0, position = {}) {
  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.text
  return normalizeDashboardWidget({
    id: `widget_${type}_${Date.now()}_${index}`,
    type,
    title: defaults.title,
    frame: {
      x: position.x ?? 120 + (index % 5) * 30,
      y: position.y ?? 120 + (index % 5) * 30,
      width: defaults.size[0],
      height: defaults.size[1],
      rotation: 0
    },
    content: defaults.content,
    style: defaults.style,
    zIndex: index,
    runtimeTarget: 'overlay'
  }, DEFAULT_DASHBOARD_CANVAS, index)
}

export function createDashboardWidgetPreset(presetId, options = {}) {
  if (presetId !== 'device_part_detail') return []

  const canvas = { ...DEFAULT_DASHBOARD_CANVAS, ...objectValue(options.canvas, {}) }
  const canvasWidth = Math.max(320, Number(canvas.width) || DEFAULT_DASHBOARD_CANVAS.width)
  const canvasHeight = Math.max(180, Number(canvas.height) || DEFAULT_DASHBOARD_CANVAS.height)
  const margin = Math.max(18, Math.round(Math.min(canvasWidth, canvasHeight) * .025))
  const panelWidth = Math.min(500, Math.max(380, canvasWidth * .28), canvasWidth - margin * 2)
  const panelHeight = Math.min(820, Math.max(560, canvasHeight * .76), canvasHeight - margin * 2)
  const panelX = Math.max(margin, canvasWidth - panelWidth - margin)
  const panelY = Math.max(margin, (canvasHeight - panelHeight) / 2)
  const padding = Math.max(18, Math.min(28, Math.round(panelWidth * .055)))
  const gap = Math.max(10, Math.min(16, Math.round(panelHeight * .02)))
  const innerWidth = panelWidth - padding * 2
  const nameHeight = Math.max(84, Math.min(116, Math.round(panelHeight * .14)))
  const descriptionHeight = Math.max(100, Math.min(150, Math.round(panelHeight * .18)))
  const footerHeight = Math.max(52, Math.min(70, Math.round(panelHeight * .09)))
  const metricsHeight = Math.max(180, panelHeight - padding * 2 - nameHeight - descriptionHeight - footerHeight - gap * 3)
  const baseZ = Math.max(0, Number(options.baseZ) || 0)
  const viewIds = stringArray(options.viewIds).length ? stringArray(options.viewIds) : ['device_part']
  const groupId = String(options.groupId || 'group_device_part_detail').replace(/[^a-zA-Z0-9_-]/g, '_')
  const visibility = {
    viewModes: ['device'],
    viewIds,
    matchBoundDevice: false,
    ruleMode: 'all',
    rules: [{ source: 'context', path: 'inspectionStage', operator: '==', value: 'part' }]
  }
  const pointItems = Array.from({ length: 6 }, (_, index) => ({
    label: `参数 ${index + 1}`,
    labelPath: `selectedPart.points.${index}.label`,
    path: `selectedPart.points.${index}.value`,
    unitPath: `selectedPart.points.${index}.unit`,
    decimals: 2
  }))
  const create = (source, offset) => normalizeDashboardWidget({
    ...source,
    groupId,
    visibility: deepClone(visibility),
    runtimeTarget: 'overlay',
    zIndex: baseZ + offset
  }, canvas, baseZ + offset)

  const innerX = panelX + padding
  const nameY = panelY + padding
  const descriptionY = nameY + nameHeight + gap
  const metricsY = descriptionY + descriptionHeight + gap
  const footerY = metricsY + metricsHeight + gap

  return [
    create({
      id: 'widget_device_part_panel',
      type: 'container',
      title: '部件详情面板',
      locked: true,
      frame: { x: panelX, y: panelY, width: panelWidth, height: panelHeight, rotation: 0 },
      content: { showTitle: false, previewLabel: '部件详情区域' },
      style: {
        background: 'linear-gradient(155deg, rgba(7, 22, 36, .94), rgba(9, 30, 48, .84))',
        color: '#eef7ff',
        borderColor: 'rgba(91, 193, 255, .35)',
        borderRadius: 20,
        padding: 0,
        shadow: 'strong'
      }
    }, 0),
    create({
      id: 'widget_device_part_name',
      type: 'text',
      title: '已选部件',
      frame: { x: innerX, y: nameY, width: innerWidth, height: nameHeight, rotation: 0 },
      content: { text: '{value}', align: 'left' },
      style: {
        background: 'rgba(20, 53, 78, .72)',
        color: '#ffffff',
        fontSize: 30,
        borderColor: 'rgba(101, 207, 255, .32)',
        borderRadius: 14,
        padding: 16,
        shadow: 'glow'
      },
      data: { mode: 'runtime', path: 'selectedPart.name', readOnly: true }
    }, 1),
    create({
      id: 'widget_device_part_description',
      type: 'text',
      title: '部件说明',
      frame: { x: innerX, y: descriptionY, width: innerWidth, height: descriptionHeight, rotation: 0 },
      content: { text: '{value}', align: 'left' },
      style: {
        background: 'rgba(10, 28, 44, .68)',
        color: '#cfe3f1',
        fontSize: 17,
        borderColor: 'rgba(101, 174, 220, .2)',
        borderRadius: 14,
        padding: 16,
        shadow: 'soft'
      },
      data: { mode: 'runtime', path: 'selectedPart.description', readOnly: true }
    }, 2),
    create({
      id: 'widget_device_part_metrics',
      type: 'metrics',
      title: '实时参数 / 运行状况',
      frame: { x: innerX, y: metricsY, width: innerWidth, height: metricsHeight, rotation: 0 },
      content: {
        layout: 'list',
        hideEmptyItems: true,
        emptyText: '该部件暂未关联实时点位',
        items: pointItems
      },
      style: {
        background: 'rgba(10, 28, 44, .76)',
        color: '#eef7ff',
        borderColor: 'rgba(89, 178, 238, .28)',
        borderRadius: 14,
        padding: 16,
        shadow: 'soft'
      },
      data: { mode: 'runtime', path: 'selectedPart.points.0.value', readOnly: true }
    }, 3),
    create({
      id: 'widget_device_part_id',
      type: 'text',
      title: '',
      frame: { x: innerX, y: footerY, width: innerWidth, height: footerHeight, rotation: 0 },
      content: { text: '部件编号  {value}', showTitle: false, align: 'left' },
      style: {
        background: 'rgba(10, 28, 44, .48)',
        color: '#86a8be',
        fontSize: 13,
        borderColor: 'rgba(89, 178, 238, .16)',
        borderRadius: 12,
        padding: 14
      },
      data: { mode: 'runtime', path: 'selectedPart.id', readOnly: true }
    }, 4)
  ]
}

export function widgetTypeLabel(type) {
  return DASHBOARD_WIDGET_LIBRARY.find(item => item.type === type)?.label
    || SYSTEM_WIDGET_LIBRARY.find(item => item.type === type)?.label
    || type
}

export function systemWidgetDefinition(type) {
  return SYSTEM_WIDGET_LIBRARY.find(item => item.type === type) || {
    type,
    label: 'Unity 运行组件',
    icon: '◇',
    description: '由 Unity 运行时管理的组件',
    preview: 'unknown'
  }
}
