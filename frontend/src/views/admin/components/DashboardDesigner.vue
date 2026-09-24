<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, onActivated, onDeactivated, reactive, ref, useId, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import WidgetRenderer from '../../../runtime/WidgetRenderer.vue'
import { applyReferenceHudLayout } from '../../../runtime/referenceHudLayout.js'
import { applyFactoryHudModules } from '../../../runtime/factoryHudModules.js'
import { applyVisibilityAction, matchesRule, widgetRuntimeVisible } from '../../../runtime/dashboardRules.js'
import ColorField from './ColorField.vue'
import {
  DASHBOARD_WIDGET_LIBRARY,
  DASHBOARD_WIDGET_PRESETS,
  DASHBOARD_VIEW_MODES,
  SYSTEM_WIDGET_TYPES,
  createDashboardWidget,
  createDashboardWidgetPreset,
  createDefaultDashboardViews,
  SYSTEM_WIDGET_LIBRARY,
  deepClone,
  normalizeDashboardDocument,
  systemWidgetDefinition,
  widgetTypeLabel
} from '../../../runtime/dashboardSchema.js'

const emit = defineEmits(['reload', 'preview-view'])

const viewportRef = ref(null)
const documentModel = ref(normalizeDashboardDocument())
const revision = ref(0)
const releases = ref([])
const currentRelease = ref(null)
const loading = ref(true)
const saving = ref(false)
const publishing = ref(false)
const status = reactive({ tone: 'info', text: '正在读取设计器...' })
const acceptanceReport = ref(null)
const acceptanceLoading = ref(false)
const zoom = ref(0.68)
const previewMode = ref(false)
const fullscreenActive = ref(false)
const designerShellRef = ref(null)
const inspectorTab = ref('content')
const selectedIds = ref([])
const guides = reactive({ x: [], y: [] })
const selectionBox = reactive({ active: false, x: 0, y: 0, width: 0, height: 0 })
const devices = ref([])
const points = ref([])
const workshops = ref([])
const lines = ref([])
const dataSources = ref([])
const databaseTables = ref([])
const databaseColumns = ref([])
const databaseMetadataLoading = ref(false)
const databasePreviewValues = reactive({})
const databaseTablesByDataset = reactive({})
const databaseColumnsByDataset = reactive({})
const previewContext = reactive({
  viewId: 'factory_overview', viewMode: 'factory', workshopId: '', lineId: '', deviceId: '',
  inspectionStage: '', partId: 'front_door_open', partName: '前门组件', partDescription: '部件参数与运行状态预览',
  partPointIds: [], partPointKeys: ['analog.temperature', 'doors.front_door_open']
})
const previewPartPoints = [
  { id: 'preview_temperature', label: '当前温度', name: '当前温度', value: 836.4, unit: '°C', quality: 'good' },
  { id: 'preview_speed', label: '运行转速', name: '运行转速', value: 1280, unit: 'rpm', quality: 'good' },
  { id: 'preview_interlock', label: '联锁状态', name: '联锁状态', value: '正常', unit: '', quality: 'good' }
]
const previewSelectedPart = computed(() => ({
  id: previewContext.partId,
  name: previewContext.partName,
  description: previewContext.partDescription,
  points: previewPartPoints,
  pointMap: Object.fromEntries(previewPartPoints.map(point => [point.id, point])),
  stage: previewContext.inspectionStage
}))
const previewGroupVisibility = reactive({})
const previewWidgetVisibility = reactive({})
const pointValues = ref({})
const history = ref([])
const historyIndex = ref(-1)
const lastSavedSnapshot = ref('')
const publishForm = reactive({ version: '', notes: '' })
const releaseDialog = ref(null)
const layersCollapsed = ref(false)
const canvasPreset = ref('1920x1080')
const selectedViewId = ref('factory_overview')
// This is an editor/preview context only. It lets the user choose which
// device's data is used while editing a device view without cloning widgets.
const editorDeviceId = ref('')
const viewInspectorTab = ref('camera')
const viewPanelCollapsed = ref(false)
const PANEL_LAYOUT_KEY = 'dashboard-designer-panel-layout-v1'
const panelLayout = reactive(readPanelLayout())
const panelId = useId()
const leftPanelId = `${panelId}-designer-left-panel`
const rightPanelId = `${panelId}-designer-right-panel`
let editorStateBeforeReload = null
let pointerOperation = null
let realtimeTimer = 0
let localPersistTimer = 0
let viewportObserver = null
let viewportFitFrame = 0
let manualZoom = false
let designerDisposed = false
let designerActive = true
let realtimeRequestSeq = 0
let realtimeInFlight = false
let viewPreviewTimer = 0

function readPanelLayout() {
  try {
    const stored = JSON.parse(localStorage.getItem(PANEL_LAYOUT_KEY) || '{}')
    return { leftCollapsed: stored?.leftCollapsed === true, rightCollapsed: stored?.rightCollapsed === true }
  } catch {
    return { leftCollapsed: false, rightCollapsed: false }
  }
}

async function toggleSidePanel(side) {
  const key = side === 'left' ? 'leftCollapsed' : 'rightCollapsed'
  panelLayout[key] = !panelLayout[key]
  await nextTick()
  // ResizeObserver refits automatic zoom; keep a manually chosen zoom level.
  if (manualZoom) centerCanvas()
}

function revealRightPanel() {
  if (!panelLayout.rightCollapsed) return
  panelLayout.rightCollapsed = false
  nextTick(() => {
    if (manualZoom) centerCanvas()
  })
}

watch(panelLayout, value => {
  try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(value)) }
  catch { /* Layout preferences must not affect editing when storage is unavailable. */ }
})

const backgroundColorPresets = [
  'transparent',
  'rgba(9, 22, 35, .35)',
  'rgba(9, 22, 35, .65)',
  'rgba(9, 22, 35, .82)',
  '#ffffff',
  '#1d1d1f',
  '#12344a',
  '#183c50'
]
const textColorPresets = ['#ffffff', '#dbeeff', '#68d5ff', '#45df9b', '#ffc45f', '#ff625f', '#1d1d1f', '#6e6e73']
const borderColorPresets = ['transparent', 'rgba(89, 178, 238, .18)', 'rgba(89, 178, 238, .35)', '#59b2ee', '#45df9b', '#ffc45f', '#ff625f', '#ffffff']
const chartPalettes = [
  { id: 'industrial', label: '工业蓝青', colors: ['#55c7ff', '#45df9b', '#ffc45f', '#ff6b78', '#8f9cff', '#64e0d2'] },
  { id: 'vivid', label: '鲜明对比', colors: ['#3478f6', '#ff9f0a', '#30d158', '#ff453a', '#bf5af2', '#64d2ff'] },
  { id: 'warm', label: '暖色生产', colors: ['#ffb340', '#ff7a45', '#ff5e68', '#ffd666', '#d89614', '#ff9c6e'] },
  { id: 'cool', label: '冷色科技', colors: ['#00c7be', '#64d2ff', '#5e5ce6', '#32ade6', '#40c8e0', '#7d7aff'] },
  { id: 'mono', label: '极简灰阶', colors: ['#f5f5f7', '#c7c7cc', '#8e8e93', '#636366', '#aeaeb2', '#d1d1d6'] }
]

const mockMetrics = reactive({
  current_output: 1260,
  daily_target: 1800,
  overall_oee: 86.5,
  energy_consumption: 4280,
  running_devices: 7,
  alarm_devices: 1,
  online_devices: 11,
  total_devices: 12
})
const mockEvents = ref([
  { id: 1, time: '10:26:18', title: '2# 多用炉温度到达设定值', level: 'info' },
  { id: 2, time: '10:24:03', title: '清洗机液位偏低', level: 'warning' },
  { id: 3, time: '10:21:42', title: '1# 多用炉通讯恢复', level: 'info' }
])
const mockTrend = ref([
  { time: '10:00', value: 782 }, { time: '10:05', value: 806 },
  { time: '10:10', value: 824 }, { time: '10:15', value: 836 },
  { time: '10:20', value: 842 }, { time: '10:25', value: 838 }
])
const mockBusinessData = reactive({
  readOnly: true,
  source: { connectionId: '排产系统只读库' },
  fetchedAt: '2026-08-30T10:26:18+08:00',
  sections: {
    batches: { available: true, rows: [
      { id: 1, batchNo: 'B-20260830-001', productName: '18CrNiMo7-6 齿轮', status: '执行中', progress: 68 },
      { id: 2, batchNo: 'B-20260830-002', productName: '42CrMo 轴类件', status: '待执行', progress: 0 }
    ] },
    compliance: { available: true, rows: [
      { deviceId: 'Furnace_01', signalName: '炉温', value: 836.4, recordTime: '10:25:40' },
      { deviceId: 'Furnace_01', signalName: '碳势', value: 0.88, recordTime: '10:25:40' }
    ] },
    oee: { available: true, rows: [
      { deviceId: 'Furnace_01', date: '2026-08-30', batchCount: 8, utilizationRate: 88.5 }
    ] },
    energy: { available: false, rows: [], message: '外部数据库未提供该类标准数据表' },
    maintenance: { available: false, rows: [], message: '外部数据库未提供该类标准数据表' }
  }
})
const mockDeviceStatus = reactive({
  Furnace_01: { name: '1# 多用炉', temp: 836, running: true, alarm: false, online: true, quality: 'good' },
  Furnace_02: { name: '2# 多用炉', temp: 821, running: true, alarm: false, online: true, quality: 'good' },
  Furnace_03: { name: '3# 多用炉', temp: '--', running: false, alarm: true, online: false, quality: 'bad' }
})

const canvas = computed(() => documentModel.value.canvas)
const views = computed(() => Array.isArray(documentModel.value.scene?.views) && documentModel.value.scene.views.length
  ? documentModel.value.scene.views
  : createDefaultDashboardViews())
const currentView = computed(() => views.value.find(view => view.id === selectedViewId.value) || views.value[0] || null)
const viewModeLabel = computed(() => DASHBOARD_VIEW_MODES.find(item => item.id === currentView.value?.mode)?.label || '自定义视角')
const collapsedViewIds = reactive(new Set())
const viewTreeRows = computed(() => {
  const allViews = views.value
  const byParent = new Map()
  const viewIds = new Set(allViews.map(view => view.id))
  byParent.set('', [])
  allViews.forEach(view => {
    const parentId = String(view.parentViewId || '')
    if (parentId && parentId !== view.id && viewIds.has(parentId)) {
      if (!byParent.has(parentId)) byParent.set(parentId, [])
      byParent.get(parentId).push(view)
    } else byParent.get('').push(view)
    if (!byParent.has(view.id)) byParent.set(view.id, [])
  })
  const roots = byParent.get('')
  const reachable = new Set()
  const markReachable = view => {
    if (!view || reachable.has(view.id)) return
    reachable.add(view.id)
    ;(byParent.get(view.id) || []).forEach(markReachable)
  }
  roots.forEach(markReachable)

  const rows = []
  const flattened = new Set()
  const flatten = (view, level) => {
    if (!view || flattened.has(view.id)) return
    flattened.add(view.id)
    const children = byParent.get(view.id) || []
    rows.push({ view, level, hasChildren: children.length > 0, collapsed: collapsedViewIds.has(view.id) })
    if (!collapsedViewIds.has(view.id)) children.forEach(child => flatten(child, level + 1))
  }
  roots.forEach(view => flatten(view, 0))
  // 关系配置不完整时，把孤立视角作为根节点展示，避免在树中丢失。
  allViews.filter(view => !reachable.has(view.id)).forEach(view => flatten(view, 0))
  return rows
})
const systemWidgetCards = computed(() => SYSTEM_WIDGET_LIBRARY
  .filter(definition => !['navigation', 'return_button'].includes(definition.type))
  .map(definition => {
  const widget = systemWidgets.value.find(item => item.type === definition.type) || {
    id: `widget_${definition.type}`,
    type: definition.type,
    title: definition.label,
    runtimeTarget: 'unity'
  }
  return {
    widget,
    definition,
    label: (widget.title && !/^\d+$/.test(String(widget.title).trim())) ? widget.title : definition.label
  }
  }))
const overlayWidgets = computed(() => documentModel.value.widgets
  // Navigation and return are designer-authored components. Their runtime
  // renderer is still the WebView layer, while other Unity system panels stay
  // outside the editable canvas.
  .filter(widget => ['navigation', 'return_button'].includes(widget.type) || (!SYSTEM_WIDGET_TYPES.has(widget.type) && widget.runtimeTarget !== 'unity'))
  .sort((left, right) => Number(left.zIndex || 0) - Number(right.zIndex || 0)))
const systemWidgets = computed(() => documentModel.value.widgets.filter(widget => !['navigation', 'return_button'].includes(widget.type) && (SYSTEM_WIDGET_TYPES.has(widget.type) || widget.runtimeTarget === 'unity')))
const viewComponentCandidates = computed(() => [
  // 导航和返回组件会进入画布；Unity 诊断面板、设备浮标等系统项仍不占画布。
  ...overlayWidgets.value.map(widget => ({ widget, id: widget.id, label: widget.title || widgetTypeLabel(widget.type), type: widget.type }))
].filter(item => item.widget.visible !== false && widgetMatchesCurrentView(item.widget)))
const viewComponents = computed(() => viewComponentCandidates.value.filter(item => widgetAllowedInCurrentView(item.widget)))
const hiddenViewComponents = computed(() => viewComponentCandidates.value.filter(item => !widgetAllowedInCurrentView(item.widget)))
const selectedWidgets = computed(() => documentModel.value.widgets.filter(widget => selectedIds.value.includes(widget.id)))
const selectedWidget = computed(() => selectedWidgets.value[selectedWidgets.value.length - 1] || null)
const currentViewUsesDevice = computed(() => ['device', 'device_part'].includes(String(currentView.value?.targetType || '').toLowerCase())
  || String(currentView.value?.mode || '').toLowerCase() === 'device')
const editorDevice = computed(() => devices.value.find(device => String(device.id) === String(editorDeviceId.value)) || null)
const designerVisibilityContext = computed(() => {
  const view = currentView.value
  const viewMode = view?.mode === 'custom' ? (view.targetType || 'factory') : (view?.mode || 'factory')
  return {
    ...previewContext,
    viewId: view?.id || previewContext.viewId || '',
    viewMode,
    workshopId: view?.targetType === 'workshop' ? String(view.targetId || '') : '',
    lineId: view?.targetType === 'line' ? String(view.targetId || '') : '',
    // A device is a real visibility context only while editing a device view.
    // This keeps device-specific widgets out of factory/workshop/line views.
    deviceId: currentViewUsesDevice.value
      ? String(editorDeviceId.value || previewContext.deviceId || devices.value[0]?.id || '')
      : '',
    inspectionStage: String(view?.metadata?.inspectionStage || previewContext.inspectionStage || ''),
    partId: String(previewContext.partId || ''),
    partName: String(previewContext.partName || '')
  }
})
const currentViewTargetLabel = computed(() => {
  const view = currentView.value
  if (!view) return '未选择视角'
  const targetType = String(view.targetType || view.mode || 'factory').toLowerCase()
  if (targetType === 'device') return editorDevice.value?.name || view.targetId || '当前预览设备'
  if (targetType === 'device_part') return `部件 ${view.targetId || '自动选择'} · ${editorDevice.value?.name || '当前预览设备'}`
  if (targetType === 'line') return lines.value.find(item => String(item.id) === String(view.targetId))?.name || view.targetId || '当前产线'
  if (targetType === 'workshop') return workshops.value.find(item => String(item.id) === String(view.targetId))?.name || view.targetId || '当前车间'
  return '全厂'
})
const designerScopeHint = computed(() => currentViewUsesDevice.value
  ? '画布和图层按当前设备视角 + 预览设备过滤；不匹配当前设备的组件不会显示。'
  : '这是公共视角，所有设备共用；画布和图层只按当前全厂、车间或产线视角过滤。')
const currentViewWidgets = computed(() => overlayWidgets.value.filter(widget => widgetAllowedInCurrentView(widget)))
const currentViewHiddenWidgets = computed(() => viewComponentCandidates.value.filter(item => !widgetAllowedInCurrentView(item.widget)))
const selectedCanvasWidgets = computed(() => selectedWidgets.value.filter(widget => widgetAllowedInCurrentView(widget)))
const selectedAllLocked = computed(() => selectedCanvasWidgets.value.length > 0 && selectedCanvasWidgets.value.every(widget => widget.locked))
const selectedHasUnlocked = computed(() => selectedCanvasWidgets.value.some(widget => !widget.locked))
const selectedBounds = computed(() => {
  const widgets = selectedCanvasWidgets.value
  if (!widgets.length) return null
  const left = Math.min(...widgets.map(widget => Number(widget.frame?.x || 0)))
  const top = Math.min(...widgets.map(widget => Number(widget.frame?.y || 0)))
  const right = Math.max(...widgets.map(widget => Number(widget.frame?.x || 0) + Number(widget.frame?.width || 0)))
  const bottom = Math.max(...widgets.map(widget => Number(widget.frame?.y || 0) + Number(widget.frame?.height || 0)))
  return { left, top, right, bottom }
})
const selectionActionsStyle = computed(() => {
  const bounds = selectedBounds.value
  if (!bounds) return { display: 'none' }
  const toolbarWidth = selectedCanvasWidgets.value.length > 1 ? 116 : 72
  const toolbarHeight = 36
  const gap = 8
  const inset = 8
  let left = bounds.right - toolbarWidth
  let top = bounds.top - toolbarHeight - gap
  if (top < inset) top = bounds.bottom + gap
  left = Math.max(inset, Math.min(canvas.value.width - toolbarWidth - inset, left))
  top = Math.max(inset, Math.min(canvas.value.height - toolbarHeight - inset, top))
  return { left: `${left}px`, top: `${top}px` }
})
const canUndo = computed(() => historyIndex.value > 0)
const canRedo = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1)
const isDirty = computed(() => JSON.stringify(documentModel.value) !== lastSavedSnapshot.value)
const currentReleaseId = computed(() => currentRelease.value?.id || releases.value.find(item => item.is_current)?.id || '')
const selectedBindingDeviceId = computed(() => {
  if (selectedWidget.value?.data?.deviceScope === 'current') {
    return String(editorDeviceId.value || previewContext.deviceId || devices.value[0]?.id || '')
  }
  return String(selectedWidget.value?.data?.deviceId || '')
})
const selectedDevicePoints = computed(() => points.value.filter(point =>
  String(point.device_id) === selectedBindingDeviceId.value
  && String(point.access_type || 'READ').toUpperCase() === 'READ'
))
const selectedDataSource = computed(() => dataSources.value.find(item => item.id === selectedWidget.value?.data?.connectionId) || null)
const groupOptions = computed(() => {
  const groups = new Map()
  documentModel.value.widgets.forEach(widget => {
    if (widget.groupId && !groups.has(widget.groupId)) groups.set(widget.groupId, widget.title || widget.groupId)
  })
  return [...groups.entries()].map(([id, label]) => ({ id, label }))
})
const eventWidgetOptions = computed(() => documentModel.value.widgets.map(widget => ({ id: widget.id, label: widget.title || widgetTypeLabel(widget.type) })))
const libraryGroups = computed(() => {
  const groups = new Map()
  DASHBOARD_WIDGET_LIBRARY.forEach(item => {
    if (!groups.has(item.group)) groups.set(item.group, [])
    groups.get(item.group).push(item)
  })
  return [...groups.entries()].map(([name, items]) => ({ name, items }))
})
const zoomPercent = computed(() => `${Math.round(zoom.value * 100)}%`)
function widgetMatchesCurrentView(widget) {
  const view = currentView.value
  if (!view) return false
  if (widget.visibility?.viewIds?.length && !widget.visibility.viewIds.includes(view.id)) return false
  const effectiveMode = view.mode === 'custom' ? (view.targetType || 'factory') : view.mode
  if (widget.visibility?.viewModes?.length && !widget.visibility.viewModes.includes(effectiveMode)) return false
  const visibility = widget.visibility || {}
  if (visibility.matchBoundDevice) {
    const deviceId = String(designerVisibilityContext.value.deviceId || '')
    const deviceScope = widget.data?.deviceScope === 'current' ? 'current' : 'fixed'
    if (!deviceId) return false
    if (deviceScope === 'fixed' && String(widget.data?.deviceId || '') !== deviceId) return false
  }
  // Device/view rules affect the editor list. Data-value rules are deliberately
  // left to preview mode so a changing live value cannot make a component
  // disappear while it is being edited.
  const contextRules = (visibility.rules || []).filter(rule => rule?.source !== 'data')
  if (!contextRules.length) return true
  const matches = contextRules.map(rule => matchesRule(rule, { context: designerVisibilityContext.value }))
  return visibility.ruleMode === 'any' ? matches.some(Boolean) : matches.every(Boolean)
}

function widgetAllowedInCurrentView(widget) {
  if (!widgetMatchesCurrentView(widget)) return false
  const view = currentView.value
  if (!view) return false
  const state = view.componentState || {}
  if (state.hide?.includes(widget.id) || state.hide?.includes(`group:${widget.groupId}`)) return false
  if (state.show?.length && !state.show.includes(widget.id) && !state.show.includes(`group:${widget.groupId}`)) return false
  return true
}
const canvasWidgets = computed(() => overlayWidgets.value.filter(widget => widgetAllowedInCurrentView(widget)).filter(widget => previewMode.value
  ? widgetRuntimeVisible(widget, {
      context: previewContext,
      dataValue: previewValueForWidget(widget),
      dataRecord: databasePreviewValues[widget.id] || null,
      groupVisibility: previewGroupVisibility,
      widgetVisibility: previewWidgetVisibility
    })
  : true))
const canvasTransformStyle = computed(() => ({
  width: `${canvas.value.width}px`,
  height: `${canvas.value.height}px`,
  transform: `scale(${zoom.value})`,
  background: canvas.value.background === 'transparent'
    ? 'radial-gradient(ellipse at 52% 44%, #333c57 0%, #1c2439 42%, #101624 80%)'
    : canvas.value.background
}))
const canvasOuterStyle = computed(() => ({
  width: `${canvas.value.width * zoom.value}px`,
  height: `${canvas.value.height * zoom.value}px`
}))

function setStatus(text, tone = 'info') {
  status.text = text
  status.tone = tone
}

async function runAcceptanceReport() {
  if (acceptanceLoading.value) return
  acceptanceLoading.value = true
  try {
    const result = await adminApi.getAcceptanceReport()
    if (result?.error) throw new Error(result.error)
    acceptanceReport.value = result
    if (result.displayReady) setStatus('运行检查通过：配置、采集器与 Unity 均已就绪', 'success')
    else if (result.configurationReady) setStatus('配置检查通过：等待 Unity 连接后即可展示', 'warning')
    else setStatus(`运行检查未通过：${(result.blockingFailures || []).join('、') || '请查看报告'}`, 'danger')
  } catch (error) {
    setStatus(error.message || '运行检查失败', 'danger')
  } finally {
    acceptanceLoading.value = false
  }
}

function snapshot(value = documentModel.value) {
  return JSON.stringify(value)
}

function resetHistory() {
  history.value = [{ document: deepClone(documentModel.value), label: '加载草稿' }]
  historyIndex.value = 0
}

function commitHistory(label = '编辑组件') {
  const serialized = snapshot()
  if (historyIndex.value >= 0 && JSON.stringify(history.value[historyIndex.value]?.document) === serialized) return
  history.value = history.value.slice(0, historyIndex.value + 1)
  history.value.push({ document: deepClone(documentModel.value), label })
  if (history.value.length > 80) history.value.shift()
  historyIndex.value = history.value.length - 1
  scheduleLocalPersist()
}

function applyHistory(index) {
  if (index < 0 || index >= history.value.length) return
  historyIndex.value = index
  documentModel.value = normalizeDashboardDocument(deepClone(history.value[index].document))
  selectedIds.value = selectedIds.value.filter(id => documentModel.value.widgets.some(widget => widget.id === id))
  scheduleLocalPersist()
}

function undo() { if (canUndo.value) applyHistory(historyIndex.value - 1) }
function redo() { if (canRedo.value) applyHistory(historyIndex.value + 1) }

function localDraftKey(sceneId = documentModel.value.sceneId) {
  return `dashboard-designer-draft:${sceneId}`
}

function readLocalDraft(sceneId, serverRevision) {
  try {
    const value = JSON.parse(localStorage.getItem(localDraftKey(sceneId)) || 'null')
    if (!value || Number(value.serverRevision) !== Number(serverRevision) || !value.document) return null
    return normalizeDashboardDocument(value.document)
  } catch {
    return null
  }
}

function persistLocalDraft() {
  window.clearTimeout(localPersistTimer)
  if (!documentModel.value?.sceneId || !isDirty.value) return
  try {
    localStorage.setItem(localDraftKey(), JSON.stringify({
      serverRevision: revision.value,
      savedAt: new Date().toISOString(),
      document: documentModel.value
    }))
  } catch {
    // 浏览器存储不可用时不影响服务端草稿。
  }
}

function scheduleLocalPersist() {
  window.clearTimeout(localPersistTimer)
  localPersistTimer = window.setTimeout(persistLocalDraft, 350)
}

function clearLocalDraft() {
  try { localStorage.removeItem(localDraftKey()) } catch { /* ignore */ }
}

function editorStateKey(sceneId = documentModel.value.sceneId) {
  return `dashboard-designer-state:${sceneId}`
}

function captureEditorState() {
  return {
    viewId: selectedViewId.value,
    editorDeviceId: editorDeviceId.value,
    selectedIds: [...selectedIds.value],
    inspectorTab: inspectorTab.value,
    viewInspectorTab: viewInspectorTab.value,
    layersCollapsed: layersCollapsed.value,
    viewPanelCollapsed: viewPanelCollapsed.value,
    collapsedViewIds: [...collapsedViewIds],
    zoom: zoom.value,
    manualZoom
  }
}

function persistEditorState(state = captureEditorState(), sceneId = documentModel.value.sceneId) {
  if (!sceneId) return
  try { localStorage.setItem(editorStateKey(sceneId), JSON.stringify({ ...state, savedAt: new Date().toISOString() })) }
  catch { /* UI state persistence must not affect editing. */ }
}

function readEditorState(sceneId) {
  try {
    const value = JSON.parse(localStorage.getItem(editorStateKey(sceneId)) || 'null')
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function rememberEditorState() {
  const state = captureEditorState()
  editorStateBeforeReload = state
  persistEditorState(state)
  return state
}

function restoreEditorState(state) {
  const viewIds = new Set(views.value.map(view => String(view.id)))
  const fallbackViewId = documentModel.value.scene?.defaultViewId || views.value[0]?.id || 'factory_overview'
  selectedViewId.value = state?.viewId && viewIds.has(String(state.viewId))
    ? String(state.viewId)
    : fallbackViewId
  if (state?.editorDeviceId !== undefined) editorDeviceId.value = String(state.editorDeviceId || '')
  if (state?.inspectorTab) inspectorTab.value = state.inspectorTab
  if (state?.viewInspectorTab) viewInspectorTab.value = state.viewInspectorTab
  if (typeof state?.layersCollapsed === 'boolean') layersCollapsed.value = state.layersCollapsed
  if (typeof state?.viewPanelCollapsed === 'boolean') viewPanelCollapsed.value = state.viewPanelCollapsed
  collapsedViewIds.clear()
  if (Array.isArray(state?.collapsedViewIds)) {
    state.collapsedViewIds.forEach(viewId => {
      if (viewIds.has(String(viewId))) collapsedViewIds.add(String(viewId))
    })
  }
  syncPreviewContextFromView()

  const widgetIds = new Set(currentViewWidgets.value.map(widget => String(widget.id)))
  selectedIds.value = Array.isArray(state?.selectedIds)
    ? state.selectedIds.map(id => String(id)).filter(id => widgetIds.has(id))
    : []
  if (state?.manualZoom && Number.isFinite(Number(state.zoom))) {
    zoom.value = Math.max(0.25, Math.min(1.5, Number(state.zoom)))
    manualZoom = true
  }
  editorStateBeforeReload = null
  persistEditorState()
  nextTick(() => { if (manualZoom) centerCanvas() })
}

async function loadDesigner({ allowLocal = true } = {}) {
  const pendingEditorState = editorStateBeforeReload
  loading.value = true
  try {
    const [designer, deviceRows, pointRows, dataSourceResult, workshopRows, lineRows] = await Promise.all([
      adminApi.getDashboardDesigner(),
      adminApi.getDevices(),
      adminApi.getDataPoints('all'),
      adminApi.getDataSources().catch(() => ({ connections: [] })),
      adminApi.getWorkshops().catch(() => []),
      adminApi.getLines().catch(() => [])
    ])
    if (designerDisposed) return
    if (designer?.error) throw new Error(designer.error)
    revision.value = Number(designer.revision || 0)
    const serverDocument = normalizeDashboardDocument(designer.document || {})
    const localDocument = allowLocal ? readLocalDraft(serverDocument.sceneId, revision.value) : null
    documentModel.value = applyFactoryHudModules(applyReferenceHudLayout(localDocument || serverDocument))
    releases.value = designer.releases || []
    currentRelease.value = designer.currentRelease || null
    devices.value = Array.isArray(deviceRows) ? deviceRows : []
    points.value = (Array.isArray(pointRows) ? pointRows : []).filter(point => String(point.access_type || 'READ').toUpperCase() === 'READ')
    // HTTP API sources currently support health checks only, not table/field or
    // business-data bindings. Keep legacy database entries without sourceType.
    dataSources.value = (Array.isArray(dataSourceResult?.connections) ? dataSourceResult.connections : [])
      .filter(source => source.sourceType !== 'http_api' && source.type !== 'http_api')
    workshops.value = Array.isArray(workshopRows) ? workshopRows : []
    lines.value = Array.isArray(lineRows) ? lineRows : []
    // The reference HUD is a presentation migration applied on load. Treat
    // that derived layout as the editor baseline so opening the designer does
    // not falsely report an unsaved change before the user edits anything.
    lastSavedSnapshot.value = snapshot(documentModel.value)
    resetHistory()
    const savedEditorState = pendingEditorState || readEditorState(serverDocument.sceneId)
    restoreEditorState(savedEditorState)
    setStatus(localDocument ? '已恢复本机未保存的编辑内容' : `草稿修订 ${revision.value}，运行中版本 ${designer.currentRelease?.version || '未发布'}`, localDocument ? 'warning' : 'success')
    await nextTick()
    fitCanvas('comfortable')
    await refreshRealtimePoints()
  } catch (error) {
    setStatus(error.message || '设计器加载失败', 'danger')
  } finally {
    loading.value = false
    scheduleCurrentViewPreview({ immediate: true })
  }
}

function syncPreviewContextFromView() {
  const view = currentView.value
  if (!view) return
  previewContext.viewId = view.id
  previewContext.viewMode = view.mode === 'custom' ? (view.targetType || 'factory') : view.mode
  if (currentViewUsesDevice.value) {
    editorDeviceId.value = view.targetType === 'device' && view.targetId
      ? String(view.targetId)
      : String(editorDeviceId.value || previewContext.deviceId || devices.value[0]?.id || '')
    previewContext.deviceId = editorDeviceId.value
  } else previewContext.deviceId = ''
  if (view.targetType === 'line') previewContext.lineId = view.targetId || previewContext.lineId || ''
  if (view.targetType === 'workshop') previewContext.workshopId = view.targetId || previewContext.workshopId || ''
  previewContext.inspectionStage = view.metadata?.inspectionStage || (view.id === 'device_detail' ? 'solid' : '')
  if (previewContext.viewMode !== 'device') previewContext.partId = ''
  if (previewContext.inspectionStage === 'part' && !previewContext.partId) {
    previewContext.partId = 'front_door_open'
    previewContext.partName = '前门组件'
    previewContext.partDescription = '前室升降门与驱动组件；运行时会替换为 Unity 当前选中的真实部件。'
  }
}

function emitCurrentViewPreview({ immediate = false } = {}) {
  if (designerDisposed || !designerActive || loading.value) return
  const view = currentView.value
  if (!view?.id) return
  emit('preview-view', {
    viewId: String(view.id),
    view: deepClone(view),
    immediate
  })
}

function scheduleCurrentViewPreview({ immediate = false } = {}) {
  window.clearTimeout(viewPreviewTimer)
  viewPreviewTimer = 0
  if (immediate) {
    emitCurrentViewPreview({ immediate: true })
    return
  }
  if (designerDisposed || !designerActive || loading.value) return
  viewPreviewTimer = window.setTimeout(() => {
    viewPreviewTimer = 0
    emitCurrentViewPreview()
  }, 45)
}

function updateEditorDevice() {
  editorDeviceId.value = String(editorDeviceId.value || '')
  if (editorDeviceId.value) previewContext.deviceId = editorDeviceId.value
  setStatus(`当前编辑设备：${editorDevice.value?.name || editorDeviceId.value || '未选择'}；组件数据将按绑定范围预览`, 'info')
  refreshRealtimePoints()
}

function toggleViewTreeNode(viewId) {
  if (collapsedViewIds.has(viewId)) collapsedViewIds.delete(viewId)
  else collapsedViewIds.add(viewId)
}

function selectView(viewId, { enterPreview = false } = {}) {
  if (!views.value.some(view => view.id === viewId)) return
  selectedViewId.value = viewId
  selectedIds.value = []
  syncPreviewContextFromView()
  scheduleCurrentViewPreview({ immediate: true })
  if (enterPreview) previewMode.value = true
}

function addView() {
  const index = views.value.length + 1
  const view = {
    id: `custom_view_${Date.now()}`,
    name: `自定义视角 ${index}`,
    mode: 'custom',
    targetType: 'factory',
    targetId: '',
    parentViewId: currentView.value?.id || 'factory_overview',
    returnViewId: currentView.value?.id || 'factory_overview',
    camera: { yaw: -39, pitch: 33, distanceScale: 1.08, transitionSeconds: .7, targetOffset: [0, 0, 0] },
    componentState: { show: [], hide: [], hideNonTargetDevices: false },
    metadata: {}
  }
  documentModel.value.scene.views.push(view)
  selectedViewId.value = view.id
  commitHistory('新增视角')
}

function duplicateView() {
  if (!currentView.value) return
  const copy = deepClone(currentView.value)
  copy.id = `${currentView.value.id}_copy_${Date.now()}`
  copy.name = `${currentView.value.name} 副本`
  documentModel.value.scene.views.push(copy)
  selectedViewId.value = copy.id
  commitHistory('复制视角')
}

function removeView() {
  if (!currentView.value || views.value.length <= 1) return setStatus('至少保留一个视角', 'warning')
  const removed = currentView.value.id
  const remainingViews = views.value.filter(view => view.id !== removed)
  const remainingIds = new Set(remainingViews.map(view => view.id))
  const fallbackParentId = remainingIds.has(String(currentView.value.parentViewId || ''))
    ? String(currentView.value.parentViewId)
    : ''
  const nextDefaultViewId = remainingIds.has(String(documentModel.value.scene.defaultViewId || ''))
    ? String(documentModel.value.scene.defaultViewId)
    : (remainingViews[0]?.id || '')
  // 删除视角时同步清理所有交叉引用，避免每个组件残留一个失效视角 ID，
  // 最终在保存/校验时被展开成成百条错误。
  documentModel.value.widgets.forEach(widget => {
    if (Array.isArray(widget.visibility?.viewIds)) {
      widget.visibility.viewIds = widget.visibility.viewIds.filter(viewId => remainingIds.has(String(viewId)))
    }
    if (Array.isArray(widget.events)) {
      widget.events = widget.events.map(event => {
        if (event?.action === 'switch_view' && event.viewId && !remainingIds.has(String(event.viewId))) {
          return { ...event, viewId: fallbackParentId || nextDefaultViewId }
        }
        return event
      })
    }
  })
  documentModel.value.scene.views = remainingViews.map(view => ({
    ...view,
    parentViewId: view.parentViewId === removed ? fallbackParentId : view.parentViewId,
    returnViewId: view.returnViewId === removed ? fallbackParentId : view.returnViewId
  }))
  documentModel.value.scene.defaultViewId = nextDefaultViewId
  selectedViewId.value = fallbackParentId || nextDefaultViewId
  syncPreviewContextFromView()
  commitHistory('删除视角')
}

function setDefaultView() {
  if (!currentView.value) return
  documentModel.value.scene.defaultViewId = currentView.value.id
  commitHistory('设置默认视角')
}

function updateViewTarget(view) {
  if (!view) return
  if (view.targetType === 'device' && !view.targetId) view.targetId = devices.value[0]?.id ? String(devices.value[0].id) : ''
  if (view.targetType === 'line' && !view.targetId) view.targetId = lines.value[0]?.id ? String(lines.value[0].id) : ''
  if (view.targetType === 'workshop' && !view.targetId) view.targetId = workshops.value[0]?.id ? String(workshops.value[0].id) : ''
  syncPreviewContextFromView()
  commitHistory('修改视角目标')
}

function toggleViewComponent(view, id, visible) {
  if (!view) return
  const state = view.componentState || (view.componentState = { show: [], hide: [], hideNonTargetDevices: false })
  state.show = Array.isArray(state.show) ? state.show : []
  state.hide = Array.isArray(state.hide) ? state.hide : []
  state.hide = state.hide.filter(item => item !== id)
  state.show = state.show.filter(item => item !== id)
  if (!visible) state.hide.push(id)
  else if (state.show.length) state.show.push(id)
  commitHistory(visible ? '视角显示组件' : '视角隐藏组件')
}

async function refreshRealtimePoints() {
  if (designerDisposed || !designerActive || realtimeInFlight) return
  const requestSeq = ++realtimeRequestSeq
  realtimeInFlight = true
  try {
    const result = await adminApi.getRealtimePointValues('all')
    if (designerDisposed || !designerActive || requestSeq !== realtimeRequestSeq) return
    if (result?.error || !Array.isArray(result?.points)) return
    const next = {}
    result.points.forEach(point => {
      next[String(point.id)] = point
      next[`${point.device_id}:${point.id}`] = point
    })
    pointValues.value = next
  } catch {
    // PLC 离线时设计器继续使用组件占位值。
  } finally {
    if (requestSeq === realtimeRequestSeq) realtimeInFlight = false
  }
}

function centerCanvas() {
  nextTick(() => {
    const scroll = viewportRef.value?.querySelector?.('.designer-canvas-scroll')
    if (!scroll) return
    scroll.scrollLeft = Math.max(0, (scroll.scrollWidth - scroll.clientWidth) / 2)
    // 画布较窄时上下居中；画布较高时从顶部开始，避免出现无法拖到的负空间。
    scroll.scrollTop = Math.max(0, (scroll.scrollHeight - scroll.clientHeight) / 2)
  })
}

function fitCanvas(mode = 'comfortable') {
  const viewport = viewportRef.value
  if (!viewport) return
  const scroll = viewport.querySelector('.designer-canvas-scroll')
  const availableWidth = Math.max(360, (scroll?.clientWidth || viewport.clientWidth) - 32)
  const availableHeight = Math.max(260, (scroll?.clientHeight || viewport.clientHeight) - 24)
  const widthFit = availableWidth / canvas.value.width
  const heightFit = availableHeight / canvas.value.height
  const containFit = Math.min(widthFit, heightFit)
  // 设计器首次打开采用“填满可视高度”的工作视角：典型的窄窗口会优先
  // 填满上下空间，并通过水平滚动查看画布两侧；宽窗口仍然完整显示画布。
  const viewportRatio = availableWidth / Math.max(1, availableHeight)
  const canvasRatio = canvas.value.width / Math.max(1, canvas.value.height)
  const comfortableFit = viewportRatio < canvasRatio ? heightFit : widthFit
  const fitted = mode === 'comfortable' ? comfortableFit : containFit
  zoom.value = Math.max(0.25, Math.min(1.5, fitted))
  manualZoom = false
  centerCanvas()
}

function setZoom(value) {
  zoom.value = Math.max(0.25, Math.min(1.5, Number(value)))
  manualZoom = true
}

function handleCanvasWheel(event) {
  // 保留 Ctrl/Command + 滚轮的浏览器惯例，普通滚轮才控制设计器画布。
  if (event.ctrlKey || event.metaKey) return
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return

  const scroll = event.currentTarget
  if (!scroll || typeof scroll.getBoundingClientRect !== 'function') return

  event.preventDefault()

  const previousZoom = zoom.value
  const zoomFactor = Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * 0.0015)
  const nextZoom = Math.max(0.25, Math.min(1.5, previousZoom * zoomFactor))
  if (nextZoom === previousZoom) return

  // 记录鼠标指向的画布内容位置，缩放后把同一个内容点留在鼠标下方。
  const stage = scroll.querySelector('.designer-canvas-stage')
  const stageRect = stage?.getBoundingClientRect?.()
  if (!stageRect) return
  const canvasX = (event.clientX - stageRect.left) / previousZoom
  const canvasY = (event.clientY - stageRect.top) / previousZoom

  zoom.value = nextZoom
  manualZoom = true

  nextTick(() => {
    if (!scroll.isConnected) return
    const nextStageRect = stage.getBoundingClientRect()
    const targetLeft = event.clientX - canvasX * nextZoom
    const targetTop = event.clientY - canvasY * nextZoom
    scroll.scrollLeft = Math.max(0, scroll.scrollLeft + nextStageRect.left - targetLeft)
    scroll.scrollTop = Math.max(0, scroll.scrollTop + nextStageRect.top - targetTop)
  })
}

function previewValueForWidget(widget) {
  const binding = widget.data || {}
  if (binding.mode === 'database') return databasePreviewValues[widget.id]?.value
  if (binding.mode === 'plc') {
    const isCurrentDevice = binding.deviceScope === 'current'
    const deviceId = isCurrentDevice
      ? selectedBindingDeviceId.value
      : String(binding.deviceId || '')
    if (isCurrentDevice) {
      if (!deviceId) return undefined
      const pointKey = String(binding.pointKey || binding.path || '')
      const separator = pointKey.indexOf('.')
      const category = separator > 0 ? pointKey.slice(0, separator) : ''
      const field = separator > 0 ? pointKey.slice(separator + 1) : pointKey
      const point = points.value.find(item => String(item.device_id) === deviceId
        && (!category || String(item.category || item.category_resolved || 'analog') === category)
        && String(item.value_role || item.field_name || item.name || '') === field)
      if (point) return pointValues.value[`${deviceId}:${point.id}`]?.value
      return pointValues.value[`${deviceId}:${binding.pointId}`]?.value
    }
    return pointValues.value[`${deviceId}:${binding.pointId}`]?.value ?? pointValues.value[binding.pointId]?.value
  }
  if (binding.mode === 'runtime') {
    const context = { context: previewContext, selectedPart: previewSelectedPart.value }
    return String(binding.path || '').split('.').reduce((current, key) => current?.[key], context)
  }
  return widget.content?.value
}

function canvasPointAt(clientX, clientY) {
  const rect = viewportRef.value?.querySelector?.('.designer-canvas-stage')?.getBoundingClientRect?.()
  if (!rect) return { x: 120, y: 120 }
  return {
    x: Math.max(0, Math.min(canvas.value.width, (clientX - rect.left) / zoom.value)),
    y: Math.max(0, Math.min(canvas.value.height, (clientY - rect.top) / zoom.value))
  }
}

function canvasPoint(event) {
  return canvasPointAt(event.clientX, event.clientY)
}

function snap(value) {
  const grid = Math.max(1, Number(canvas.value.gridSize || 10))
  return Math.round(value / grid) * grid
}

function widgetFrameStyle(widget) {
  return {
    left: `${widget.frame.x}px`,
    top: `${widget.frame.y}px`,
    width: `${widget.frame.width}px`,
    height: `${widget.frame.height}px`,
    zIndex: widget.zIndex,
    '--overlay-text-scale': Math.min(.48, (Number(widget.style?.fontSize) || 18) / Math.max(1, Number(widget.frame.height) || 40)),
    transform: `rotate(${widget.frame.rotation || 0}deg)`,
    opacity: widget.visible ? 1 : 0.32
  }
}

function layerWidgetTitle(widget) {
  const title = String(widget?.title || '').trim()
  const typeLabel = String(widgetTypeLabel(widget?.type) || '').trim()
  // 默认标题（例如“文本”）在图层很多时没有辨识度，退回稳定组件 ID；
  // 用户自定义过的标题则优先显示，和右侧属性面板保持一致。
  return title && title !== typeLabel ? title : String(widget?.id || typeLabel)
}

function layerWidgetDetail(widget) {
  const content = widget?.content || {}
  const binding = widget?.data || {}
  if (widget?.type === 'text') return String(content.text || '{value}')
  if (widget?.type === 'value') return String(content.label || binding.pointKey || binding.path || content.fallback || '{value}')
  if (widget?.type === 'status') return String(content.onText || binding.pointKey || binding.path || '状态值')
  if (binding.mode === 'plc') return String(binding.pointKey || binding.path || binding.pointId || 'PLC 只读点位')
  if (binding.mode === 'database') return String(binding.formula || binding.table || binding.connectionId || '数据库数据')
  if (binding.mode === 'runtime') return String(binding.path || '设备运行时数据')
  if (widget?.type === 'trend') return String(content.seriesName || '实时趋势')
  if (widget?.type === 'business_summary') return String(content.section || '业务摘要')
  if (widget?.type === 'image') return String(content.alt || content.url || '图片')
  return String(content.label || content.title || widget?.id || widgetTypeLabel(widget?.type))
}

function focusWidgetInCanvas(widget) {
  nextTick(() => {
    const scroll = viewportRef.value?.querySelector?.('.designer-canvas-scroll')
    if (!scroll) return
    const element = [...scroll.querySelectorAll('.designer-widget')]
      .find(item => item.dataset.widgetId === String(widget?.id || ''))
    if (!element) return

    const scrollRect = scroll.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    const padding = 28
    const visibleLeft = scrollRect.left + padding
    const visibleRight = scrollRect.right - padding
    const visibleTop = scrollRect.top + padding
    const visibleBottom = scrollRect.bottom - padding
    const alreadyVisible = elementRect.left >= visibleLeft
      && elementRect.right <= visibleRight
      && elementRect.top >= visibleTop
      && elementRect.bottom <= visibleBottom
    if (alreadyVisible) return

    const targetLeft = scroll.scrollLeft + (elementRect.left - scrollRect.left)
      - Math.max(0, (scroll.clientWidth - elementRect.width) / 2)
    const targetTop = scroll.scrollTop + (elementRect.top - scrollRect.top)
      - Math.max(0, (scroll.clientHeight - elementRect.height) / 2)
    scroll.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: 'smooth'
    })
  })
}

function selectWidget(widget, event = {}, { focusCanvas = false } = {}) {
  const groupIds = widget.groupId
    ? documentModel.value.widgets.filter(item => item.groupId === widget.groupId).map(item => item.id)
    : [widget.id]
  if (event.ctrlKey || event.metaKey) {
    const next = new Set(selectedIds.value)
    groupIds.forEach(id => next.has(id) ? next.delete(id) : next.add(id))
    selectedIds.value = [...next]
  } else if (!selectedIds.value.includes(widget.id) || groupIds.some(id => !selectedIds.value.includes(id))) {
    selectedIds.value = groupIds
  }
  if (selectedIds.value.length) revealRightPanel()
  if (focusCanvas) focusWidgetInCanvas(widget)
}

function clearSelection(event) {
  if (event.target === event.currentTarget || event.target.classList.contains('designer-canvas-stage')) selectedIds.value = []
}

function beginMarqueeSelection(event) {
  if (previewMode.value || event.button !== 0) return
  const point = canvasPoint(event)
  pointerOperation = {
    kind: 'marquee',
    startX: event.clientX,
    startY: event.clientY,
    startPoint: point,
    initialIds: [...selectedIds.value],
    additive: Boolean(event.ctrlKey || event.metaKey || event.shiftKey),
    moved: false
  }
  selectionBox.active = false
  event.preventDefault()
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', endPointerOperation, { once: true })
}

function addWidget(type, position = {}) {
  const widget = createDashboardWidget(type, documentModel.value.widgets.length, position)
  widget.frame.x = snap(Math.max(0, Math.min(canvas.value.width - widget.frame.width, widget.frame.x)))
  widget.frame.y = snap(Math.max(0, Math.min(canvas.value.height - widget.frame.height, widget.frame.y)))
  widget.zIndex = Math.max(0, ...documentModel.value.widgets.map(item => Number(item.zIndex || 0))) + 1
  documentModel.value.widgets.push(widget)
  // A dragged-in component belongs to the view where it was dropped. Keep
  // the membership in view state so deleting it later only affects that view.
  views.value.forEach(view => {
    const state = view.componentState || (view.componentState = { show: [], hide: [], hideNonTargetDevices: false })
    state.show = Array.isArray(state.show) ? state.show.filter(id => id !== widget.id) : []
    state.hide = Array.isArray(state.hide) ? state.hide.filter(id => id !== widget.id) : []
    if (view.id === currentView.value?.id) state.show.push(widget.id)
    else state.hide.push(widget.id)
  })
  selectedIds.value = [widget.id]
  inspectorTab.value = 'content'
  revealRightPanel()
  commitHistory(`添加${widgetTypeLabel(type)}`)
}

function addWidgetPreset(preset) {
  if (!preset?.id) return
  if (preset.id === 'factory_hud_modules') {
    const targetViewId = 'factory_hud_modules'
    const existing = views.value.find(view => view.id === targetViewId)
    if (existing) { selectView(targetViewId); return setStatus('已定位到工厂 HUD 方案', 'success') }
    if (views.value.length >= 50 || documentModel.value.widgets.length + 4 > 500) return setStatus('视角或组件数量已达上限，请先移除不用的内容', 'warning')
    const base = views.value.find(view => view.id === 'factory_overview') || views.value[0]
    const modules = createDashboardWidgetPreset(preset.id, { canvas: canvas.value, viewIds: [targetViewId], baseZ: 10 })
    // New view only: the currently published view and its authored widgets
    // remain intact until the user explicitly chooses and publishes this one.
    const view = deepClone(base)
    view.id = targetViewId
    view.name = '工厂总览 · HUD 方案'
    view.mode = 'factory'
    view.targetType = 'factory'
    view.targetId = ''
    view.parentViewId = base.id
    view.returnViewId = base.id
    view.metadata = { hudModules: true }
    view.componentState = { show: modules.map(widget => widget.id), hide: [], hideNonTargetDevices: false }
    documentModel.value.scene.views.push(view)
    documentModel.value.widgets.push(...modules)
    selectView(targetViewId)
    selectedIds.value = [modules[0].id]
    inspectorTab.value = 'content'
    revealRightPanel()
    commitHistory('加入工厂 HUD 方案')
    setStatus('已加入独立 HUD 方案视角；原布局未改动。可预览、编辑后保存并发布。', 'success')
    return
  }
  const groupId = preset.id === 'device_part_detail' ? 'group_device_part_detail' : `group_${preset.id}`
  const existing = documentModel.value.widgets.filter(widget => widget.groupId === groupId)
  const partViews = views.value.filter(view => view.id === 'device_part' || view.metadata?.inspectionStage === 'part')
  const targetViewId = partViews[0]?.id || 'device_part'
  if (existing.length) {
    selectView(targetViewId)
    selectedIds.value = existing.map(widget => widget.id)
    revealRightPanel()
    setStatus('部件详情面板已经存在，已为你定位到该组件组', 'warning')
    return
  }

  const previousOverlayIds = overlayWidgets.value.map(widget => widget.id)
  const baseZ = Math.max(0, ...documentModel.value.widgets.map(widget => Number(widget.zIndex || 0))) + 1
  const widgets = createDashboardWidgetPreset(preset.id, {
    canvas: canvas.value,
    baseZ,
    groupId,
    viewIds: partViews.map(view => view.id)
  })
  if (!widgets.length) return

  documentModel.value.widgets.push(...widgets)
  const createdIds = new Set(widgets.map(widget => widget.id))
  const detailView = views.value.find(view => view.id === 'device_detail')
  const inheritedState = detailView?.componentState ? deepClone(detailView.componentState) : { show: [], hide: [], hideNonTargetDevices: true }

  views.value.filter(view => ['device_xray', 'device_exploded'].includes(view.id)).forEach(view => {
    const state = view.componentState || (view.componentState = { show: [], hide: [], hideNonTargetDevices: false })
    if (!(state.show || []).length && !(state.hide || []).length) {
      view.componentState = { ...deepClone(inheritedState), hideNonTargetDevices: true }
    }
  })

  partViews.forEach(view => {
    const state = view.componentState || (view.componentState = { show: [], hide: [], hideNonTargetDevices: false })
    const inheritedHide = state.hide?.length ? state.hide : (inheritedState.hide || [])
    state.hide = [...new Set([...inheritedHide, ...previousOverlayIds])].filter(id => !createdIds.has(id))
    state.show = (state.show || []).filter(id => !createdIds.has(id))
    state.hideNonTargetDevices = true
  })

  selectView(targetViewId)
  selectedIds.value = widgets.map(widget => widget.id)
  inspectorTab.value = 'content'
  revealRightPanel()
  commitHistory(`加入${preset.label}`)
  setStatus('已生成部件详情面板：名称、说明和实时参数会随 Unity 选中部件自动切换', 'success')
}

function handleLibraryDragStart(event, type) {
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-dashboard-widget', type)
}

function handleCanvasDrop(event) {
  const type = event.dataTransfer.getData('application/x-dashboard-widget')
  if (!type) return
  const point = canvasPoint(event)
  addWidget(type, { x: point.x - 120, y: point.y - 60 })
}

function movableSelection(widget, event) {
  selectWidget(widget, event)
  const selected = documentModel.value.widgets.filter(item => selectedIds.value.includes(item.id) && !item.locked)
  return selected.length ? selected : (!widget.locked ? [widget] : [])
}

function beginMove(event, widget) {
  if (previewMode.value || event.button !== 0 || widget.locked) return
  const moving = movableSelection(widget, event)
  if (!moving.length) return
  event.preventDefault()
  const frames = new Map(moving.map(item => [item.id, deepClone(item.frame)]))
  pointerOperation = {
    kind: 'move',
    startX: event.clientX,
    startY: event.clientY,
    primaryId: widget.id,
    frames,
    before: snapshot()
  }
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', endPointerOperation, { once: true })
}

function beginResize(event, widget, direction) {
  if (previewMode.value || widget.locked) return
  selectWidget(widget)
  event.preventDefault()
  pointerOperation = {
    kind: 'resize',
    direction,
    startX: event.clientX,
    startY: event.clientY,
    primaryId: widget.id,
    frames: new Map([[widget.id, deepClone(widget.frame)]]),
    before: snapshot()
  }
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', endPointerOperation, { once: true })
}

function findWidget(id) {
  return documentModel.value.widgets.find(widget => widget.id === id)
}

function alignedPosition(frame, excludedIds) {
  const threshold = 7 / zoom.value
  const xCandidates = []
  const yCandidates = []
  const ownX = [frame.x, frame.x + frame.width / 2, frame.x + frame.width]
  const ownY = [frame.y, frame.y + frame.height / 2, frame.y + frame.height]
  documentModel.value.widgets.forEach(other => {
    if (excludedIds.has(other.id) || !other.visible || other.runtimeTarget === 'unity') return
    const targetX = [other.frame.x, other.frame.x + other.frame.width / 2, other.frame.x + other.frame.width]
    const targetY = [other.frame.y, other.frame.y + other.frame.height / 2, other.frame.y + other.frame.height]
    ownX.forEach((value, ownIndex) => targetX.forEach(target => {
      const diff = target - value
      if (Math.abs(diff) <= threshold) xCandidates.push({ diff, guide: target, score: Math.abs(diff), ownIndex })
    }))
    ownY.forEach((value, ownIndex) => targetY.forEach(target => {
      const diff = target - value
      if (Math.abs(diff) <= threshold) yCandidates.push({ diff, guide: target, score: Math.abs(diff), ownIndex })
    }))
  })
  xCandidates.sort((a, b) => a.score - b.score)
  yCandidates.sort((a, b) => a.score - b.score)
  guides.x = xCandidates[0] ? [xCandidates[0].guide] : []
  guides.y = yCandidates[0] ? [yCandidates[0].guide] : []
  return {
    x: snap(frame.x + (xCandidates[0]?.diff || 0)),
    y: snap(frame.y + (yCandidates[0]?.diff || 0))
  }
}

function handlePointerMove(event) {
  if (!pointerOperation) return
  if (pointerOperation.kind === 'marquee') {
    const distance = Math.hypot(
      event.clientX - pointerOperation.startX,
      event.clientY - pointerOperation.startY
    )
    if (distance < 4) return

    const start = pointerOperation.startPoint
    const current = canvasPointAt(event.clientX, event.clientY)
    const left = Math.min(start.x, current.x)
    const top = Math.min(start.y, current.y)
    const right = Math.max(start.x, current.x)
    const bottom = Math.max(start.y, current.y)
    selectionBox.active = true
    selectionBox.x = left
    selectionBox.y = top
    selectionBox.width = right - left
    selectionBox.height = bottom - top
    pointerOperation.moved = true

    const pickedIds = new Set()
    const viewWidgets = currentViewWidgets.value
    viewWidgets.forEach(widget => {
      const frame = widget.frame || {}
      const inside = Number(frame.x || 0) >= left
        && Number(frame.y || 0) >= top
        && Number(frame.x || 0) + Number(frame.width || 0) <= right
        && Number(frame.y || 0) + Number(frame.height || 0) <= bottom
      if (!inside) return
      if (widget.groupId) {
        viewWidgets.forEach(groupWidget => {
          if (groupWidget.groupId === widget.groupId) pickedIds.add(groupWidget.id)
        })
      } else {
        pickedIds.add(widget.id)
      }
    })

    const nextIds = pointerOperation.additive ? new Set(pointerOperation.initialIds) : new Set()
    pickedIds.forEach(id => nextIds.add(id))
    selectedIds.value = [...nextIds]
    return
  }
  const dx = (event.clientX - pointerOperation.startX) / zoom.value
  const dy = (event.clientY - pointerOperation.startY) / zoom.value
  if (pointerOperation.kind === 'move') {
    const primaryStart = pointerOperation.frames.get(pointerOperation.primaryId)
    if (!primaryStart) return
    const primaryWidget = findWidget(pointerOperation.primaryId)
    const raw = {
      ...primaryStart,
      x: Math.max(0, Math.min(canvas.value.width - primaryStart.width, primaryStart.x + dx)),
      y: Math.max(0, Math.min(canvas.value.height - primaryStart.height, primaryStart.y + dy))
    }
    const aligned = alignedPosition(raw, new Set(pointerOperation.frames.keys()))
    const alignedDx = aligned.x - primaryStart.x
    const alignedDy = aligned.y - primaryStart.y
    pointerOperation.frames.forEach((start, id) => {
      const target = findWidget(id)
      if (!target) return
      target.frame.x = Math.max(0, Math.min(canvas.value.width - start.width, start.x + alignedDx))
      target.frame.y = Math.max(0, Math.min(canvas.value.height - start.height, start.y + alignedDy))
    })
    if (primaryWidget) primaryWidget.frame = { ...primaryWidget.frame }
    return
  }

  const widget = findWidget(pointerOperation.primaryId)
  const start = pointerOperation.frames.get(pointerOperation.primaryId)
  if (!widget || !start) return
  const direction = pointerOperation.direction
  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height
  if (direction.includes('e')) right = Math.min(canvas.value.width, snap(right + dx))
  if (direction.includes('s')) bottom = Math.min(canvas.value.height, snap(bottom + dy))
  if (direction.includes('w')) left = Math.max(0, snap(left + dx))
  if (direction.includes('n')) top = Math.max(0, snap(top + dy))
  if (right - left < 60) direction.includes('w') ? left = right - 60 : right = left + 60
  if (bottom - top < 40) direction.includes('n') ? top = bottom - 40 : bottom = top + 40
  widget.frame = { ...widget.frame, x: left, y: top, width: right - left, height: bottom - top }
}

function endPointerOperation() {
  window.removeEventListener('pointermove', handlePointerMove)
  guides.x = []
  guides.y = []
  if (pointerOperation?.kind === 'marquee') {
    if (!pointerOperation.moved && !pointerOperation.additive) selectedIds.value = []
    selectionBox.active = false
    pointerOperation = null
    return
  }
  if (pointerOperation && pointerOperation.before !== snapshot()) commitHistory(pointerOperation.kind === 'move' ? '移动组件' : '缩放组件')
  pointerOperation = null
  selectionBox.active = false
}

function deleteSelected() {
  if (!selectedIds.value.length) return
  const removable = new Set(selectedIds.value.filter(id => {
    const widget = findWidget(id)
    return widget && widgetAllowedInCurrentView(widget) && !widget.locked
  }))
  if (!removable.size) return setStatus('锁定组件不能删除', 'warning')
  const state = currentView.value.componentState || (currentView.value.componentState = { show: [], hide: [], hideNonTargetDevices: false })
  state.show = (state.show || []).filter(id => !removable.has(id))
  state.hide = [...new Set([...(state.hide || []), ...removable])]
  selectedIds.value = selectedIds.value.filter(id => !removable.has(id))
  commitHistory('从当前视角移除组件')
  setStatus(`已从“${currentView.value.name}”移除 ${removable.size} 个组件，可在本视角恢复`, 'success')
}

function removeWidgetFromCurrentView(widget) {
  if (!widget || !currentView.value) return
  if (widget.locked) return setStatus('锁定组件不能从当前视角删除', 'warning')
  const state = currentView.value.componentState || (currentView.value.componentState = { show: [], hide: [], hideNonTargetDevices: false })
  state.show = (state.show || []).filter(id => id !== widget.id)
  state.hide = [...new Set([...(state.hide || []), widget.id])]
  selectedIds.value = selectedIds.value.filter(id => id !== widget.id)
  commitHistory(`从当前视角移除${widgetTypeLabel(widget.type)}`)
  setStatus(`已从“${currentView.value.name}”移除${widget.title || widgetTypeLabel(widget.type)}`, 'success')
}

function applyChartPalette() {
  const widget = selectedWidget.value
  if (!widget || !['trend', 'hud_chart_dock'].includes(widget.type)) return
  const palette = chartPalettes.find(item => item.id === widget.content.chartPalette) || chartPalettes[0]
  widget.content.lineColor = palette.colors[0]
  ensureDatabaseDatasets(widget).forEach((dataset, index) => {
    dataset.color = palette.colors[index % palette.colors.length]
  })
  widget.data.formulaColor = palette.colors[Math.min(widget.data.datasets.length, palette.colors.length - 1)]
  recordProperty('应用图表配色')
}

function copySelected() {
  const copies = selectedWidgets.value.filter(widget => !SYSTEM_WIDGET_TYPES.has(widget.type)).map((widget, index) => {
    const copy = deepClone(widget)
    copy.id = `${widget.id}_copy_${Date.now()}_${index}`
    copy.title = `${widget.title || widgetTypeLabel(widget.type)} 副本`
    copy.frame.x = Math.min(canvas.value.width - copy.frame.width, copy.frame.x + 24)
    copy.frame.y = Math.min(canvas.value.height - copy.frame.height, copy.frame.y + 24)
    copy.zIndex = Math.max(0, ...documentModel.value.widgets.map(item => Number(item.zIndex || 0))) + index + 1
    copy.groupId = ''
    return copy
  })
  if (!copies.length) return
  documentModel.value.widgets.push(...copies)
  // Copies are authored in the current view only. Without this membership
  // update a copied widget is stored globally but is invisible in a view that
  // already has an explicit component allow-list.
  const copiedIds = new Set(copies.map(widget => widget.id))
  views.value.forEach(view => {
    const state = view.componentState || (view.componentState = { show: [], hide: [], hideNonTargetDevices: false })
    state.show = (state.show || []).filter(id => !copiedIds.has(id))
    state.hide = (state.hide || []).filter(id => !copiedIds.has(id))
    if (view.id === currentView.value?.id) state.show.push(...copiedIds)
    else state.hide.push(...copiedIds)
  })
  selectedIds.value = copies.map(widget => widget.id)
  commitHistory('复制组件')
}

function toggleSelectedLock() {
  if (!selectedWidgets.value.length) return
  const next = !selectedWidgets.value.every(widget => widget.locked)
  selectedWidgets.value.forEach(widget => { widget.locked = next })
  commitHistory(next ? '锁定组件' : '解锁组件')
}

function groupSelected() {
  if (selectedWidgets.value.length < 2) return setStatus('至少选择两个组件才能组合', 'warning')
  const groupId = `group_${Date.now()}`
  selectedWidgets.value.forEach(widget => { widget.groupId = groupId })
  commitHistory('组合组件')
}

function ungroupSelected() {
  if (!selectedWidgets.value.some(widget => widget.groupId)) return
  selectedWidgets.value.forEach(widget => { widget.groupId = '' })
  commitHistory('取消组合')
}

function moveLayer(widget, mode) {
  const values = documentModel.value.widgets.map(item => Number(item.zIndex || 0))
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (mode === 'top') widget.zIndex = max + 1
  if (mode === 'bottom') widget.zIndex = min - 1
  if (mode === 'up') widget.zIndex = Number(widget.zIndex || 0) + 1
  if (mode === 'down') widget.zIndex = Number(widget.zIndex || 0) - 1
  commitHistory('调整图层')
}

function toggleLayerVisibility(widget) {
  widget.visible = !widget.visible
  commitHistory(widget.visible ? '显示组件' : '隐藏组件')
}

function toggleLayerLock(widget) {
  widget.locked = !widget.locked
  commitHistory(widget.locked ? '锁定组件' : '解锁组件')
}

function changeDeviceScope() {
  const widget = selectedWidget.value
  if (!widget) return
  widget.data.deviceScope = widget.data.deviceScope === 'fixed' ? 'fixed' : 'current'
  if (widget.data.deviceScope === 'current') {
    widget.data.deviceId = ''
    widget.visibility.matchBoundDevice = false
  } else {
    widget.data.deviceId = String(widget.data.deviceId || editorDeviceId.value || previewContext.deviceId || '')
    widget.visibility.matchBoundDevice = Boolean(widget.data.deviceId)
  }
  recordProperty('修改设备绑定范围')
}

function bindSelectedPoint() {
  const widget = selectedWidget.value
  if (!widget) return
  const point = points.value.find(item => String(item.id) === String(widget.data.pointId))
  if (!point) return
  if (String(point.access_type || 'READ').toUpperCase() !== 'READ') {
    widget.data.pointId = ''
    return setStatus('设计器只允许绑定 READ 点位', 'danger')
  }
  widget.data.mode = 'plc'
  const isCurrentDevice = widget.data.deviceScope === 'current'
  widget.data.deviceId = isCurrentDevice ? '' : String(point.device_id)
  widget.data.pointKey = `${point.category || point.category_resolved || 'analog'}.${point.value_role || point.field_name || point.name}`
  widget.data.path = `${point.category || point.category_resolved || 'analog'}.${point.value_role || point.field_name || point.name}`
  widget.data.unit = point.unit || ''
  widget.data.readOnly = true
  widget.visibility.matchBoundDevice = !isCurrentDevice && Boolean(widget.data.deviceId)
  commitHistory('绑定 PLC 只读点位')
}

async function loadDatabaseTables(connectionId = selectedWidget.value?.data?.connectionId) {
  databaseTables.value = []
  databaseColumns.value = []
  if (!connectionId) return
  databaseMetadataLoading.value = true
  try {
    const result = await adminApi.getDataSourceTables(connectionId)
    databaseTables.value = result.tables || []
  } catch (error) {
    setStatus(`读取数据库表失败：${error.message || error}`, 'danger')
  } finally {
    databaseMetadataLoading.value = false
  }
}

async function loadDatabaseColumns(connectionId = selectedWidget.value?.data?.connectionId, schema = selectedWidget.value?.data?.schema, table = selectedWidget.value?.data?.table) {
  databaseColumns.value = []
  if (!connectionId || !table) return
  databaseMetadataLoading.value = true
  try {
    const result = await adminApi.getDataSourceColumns(connectionId, schema || '', table)
    databaseColumns.value = result.columns || []
  } catch (error) {
    setStatus(`读取数据库字段失败：${error.message || error}`, 'danger')
  } finally {
    databaseMetadataLoading.value = false
  }
}

function createDatabaseDataset(index = 0, widget = selectedWidget.value) {
  const defaultList = ['trend', 'alarm_list', 'device_list', 'marquee'].includes(widget?.type)
  return {
    alias: String.fromCharCode(97 + Math.min(index, 25)),
    label: `数据项 ${String.fromCharCode(65 + Math.min(index, 25))}`,
    color: ['#55c7ff', '#45df9b', '#ffc45f', '#ff6b78'][index % 4],
    connectionId: dataSources.value[0]?.id || '', schema: '', table: '', field: '', timeField: '', orderBy: '',
    orderDirection: 'desc', valueMode: defaultList ? 'list' : 'latest', rowLimit: 50, refreshMs: 5000,
    contextField: '', contextKey: ''
  }
}

function ensureDatabaseDatasets(widget = selectedWidget.value) {
  if (!widget?.data) return []
  if (!Array.isArray(widget.data.datasets) || !widget.data.datasets.length) {
    widget.data.datasets = [{
      ...createDatabaseDataset(0, widget),
      connectionId: widget.data.connectionId || dataSources.value[0]?.id || '',
      schema: widget.data.schema || '', table: widget.data.table || '', field: widget.data.field || '',
      timeField: widget.data.timeField || '', orderBy: widget.data.orderBy || widget.data.timeField || '',
      orderDirection: widget.data.orderDirection || 'desc', valueMode: widget.data.valueMode || 'latest',
      rowLimit: widget.data.rowLimit || 50, refreshMs: widget.data.refreshMs || 5000
    }]
  }
  return widget.data.datasets
}

function datasetMetaKey(index, widget = selectedWidget.value) { return `${widget?.id || 'none'}:${index}` }
function datasetTables(index) { return databaseTablesByDataset[datasetMetaKey(index)] || [] }
function datasetColumns(index) { return databaseColumnsByDataset[datasetMetaKey(index)] || [] }

async function loadDatasetTables(dataset, index) {
  const key = datasetMetaKey(index)
  databaseTablesByDataset[key] = []
  databaseColumnsByDataset[key] = []
  if (!dataset?.connectionId) return
  databaseMetadataLoading.value = true
  try {
    const result = await adminApi.getDataSourceTables(dataset.connectionId)
    databaseTablesByDataset[key] = result.tables || []
  } catch (error) {
    setStatus(`读取数据库表失败：${error.message || error}`, 'danger')
  } finally { databaseMetadataLoading.value = false }
}

async function loadDatasetColumns(dataset, index) {
  const key = datasetMetaKey(index)
  databaseColumnsByDataset[key] = []
  if (!dataset?.connectionId || !dataset.table) return
  databaseMetadataLoading.value = true
  try {
    const result = await adminApi.getDataSourceColumns(dataset.connectionId, dataset.schema || '', dataset.table)
    databaseColumnsByDataset[key] = result.columns || []
  } catch (error) {
    setStatus(`读取数据库字段失败：${error.message || error}`, 'danger')
  } finally { databaseMetadataLoading.value = false }
}

async function changeDatasetConnection(dataset, index) {
  Object.assign(dataset, { schema: '', table: '', field: '', timeField: '', orderBy: '', contextField: '' })
  delete databasePreviewValues[selectedWidget.value?.id]
  await loadDatasetTables(dataset, index)
  recordProperty('选择数据库连接')
}

async function changeDatasetTable(dataset, index, value) {
  const [schema = '', table = ''] = String(value || '').split('\u0001')
  Object.assign(dataset, { schema, table, field: '', timeField: '', orderBy: '', contextField: '' })
  delete databasePreviewValues[selectedWidget.value?.id]
  await loadDatasetColumns(dataset, index)
  recordProperty('选择数据库表')
}

function datasetTableKey(dataset) { return dataset?.table ? `${dataset.schema || ''}\u0001${dataset.table}` : '' }

function addDatabaseDataset() {
  const datasets = ensureDatabaseDatasets()
  if (datasets.length >= 12) return setStatus('一个组件最多配置 12 个数据项', 'warning')
  datasets.push(createDatabaseDataset(datasets.length))
  commitHistory('添加数据项')
}

function removeDatabaseDataset(index) {
  const datasets = ensureDatabaseDatasets()
  if (datasets.length <= 1) return setStatus('至少保留一个数据项', 'warning')
  datasets.splice(index, 1)
  commitHistory('删除数据项')
  previewDatabaseBinding()
}

function bindDatabaseToDevice() {
  if (!selectedWidget.value) return
  selectedWidget.value.data.deviceScope = 'fixed'
  selectedWidget.value.visibility.matchBoundDevice = Boolean(selectedWidget.value.data.deviceId)
  recordProperty('设置设备详情适用范围')
}

function changeDatabaseScope() {
  const widget = selectedWidget.value
  if (!widget) return
  widget.data.deviceScope = widget.data.deviceScope === 'fixed' ? 'fixed' : 'current'
  if (widget.data.deviceScope === 'current') {
    widget.data.deviceId = ''
    widget.visibility.matchBoundDevice = false
    ensureDatabaseDatasets(widget).forEach(dataset => {
      if (!dataset.contextKey) dataset.contextKey = 'deviceId'
    })
  }
  recordProperty('修改数据库设备范围')
}

async function changeDatabaseConnection() {
  const widget = selectedWidget.value
  if (!widget) return
  Object.assign(widget.data, { schema: '', table: '', field: '', timeField: '', orderBy: '' })
  delete databasePreviewValues[widget.id]
  await loadDatabaseTables(widget.data.connectionId)
  recordProperty('选择数据库连接')
}

async function changeDatabaseTable(value) {
  const widget = selectedWidget.value
  if (!widget) return
  const [schema = '', table = ''] = String(value || '').split('\u0001')
  Object.assign(widget.data, { schema, table, field: '', timeField: '', orderBy: '' })
  delete databasePreviewValues[widget.id]
  await loadDatabaseColumns(widget.data.connectionId, schema, table)
  recordProperty('选择数据库表')
}

function databaseTableKey(data = selectedWidget.value?.data) {
  return data?.table ? `${data.schema || ''}\u0001${data.table}` : ''
}

async function previewDatabaseBinding(widget = selectedWidget.value, silent = false) {
  if (!widget || widget.data?.mode !== 'database') return
  const datasets = ensureDatabaseDatasets(widget)
  if (!datasets.length || datasets.some(dataset => !dataset.connectionId || !dataset.table || (dataset.valueMode !== 'count' && !dataset.field))) {
    if (!silent) setStatus('请先完整配置每个数据项的连接、表和字段', 'warning')
    return
  }
  try {
    const result = await adminApi.previewDataSource({ ...widget.data, context: { ...previewContext } })
    databasePreviewValues[widget.id] = result.result || {}
    if (!silent) setStatus(`数据预览：${result.result?.value ?? '空值'}`, 'success')
  } catch (error) {
    databasePreviewValues[widget.id] = { value: null, rows: [], quality: 'bad', error: error.message }
    if (!silent) setStatus(`数据预览失败：${error.message || error}`, 'danger')
  }
}

function changeBindingMode() {
  const widget = selectedWidget.value
  if (!widget) return
  widget.data.readOnly = true
  if (widget.data.mode === 'static') {
    widget.data.path = ''
    widget.data.source = ''
    widget.data.deviceId = ''
    widget.data.pointKey = ''
    widget.data.deviceScope = 'current'
    widget.visibility.matchBoundDevice = false
  }
  if (widget.data.mode !== 'runtime') {
    widget.data.path = widget.data.mode === 'static' ? '' : widget.data.path
  }
  if (widget.data.mode !== 'plc') {
    widget.data.pointId = ''
    widget.data.pointKey = ''
  }
  const usesExternalDatabase = ['database', 'business'].includes(widget.data.mode)
  if (!usesExternalDatabase) {
    widget.data.connectionId = ''
    widget.data.schema = ''
    widget.data.table = ''
    widget.data.field = ''
    widget.data.timeField = ''
    widget.data.orderBy = ''
  } else if (widget.data.mode === 'database') {
    const datasets = ensureDatabaseDatasets(widget)
    if (['trend', 'alarm_list', 'device_list', 'marquee'].includes(widget.type)) {
      datasets.forEach(dataset => { if (!dataset.table) dataset.valueMode = 'list' })
    }
    datasets.forEach((dataset, index) => loadDatasetTables(dataset, index))
  }
  if (widget.data.mode === 'business') {
    widget.data.schema = ''
    widget.data.table = ''
    widget.data.field = ''
    widget.data.timeField = ''
    widget.data.orderBy = ''
    widget.data.businessSection = widget.data.businessSection || widget.content.section || 'batches'
    widget.content.section = widget.data.businessSection
  }
  if (widget.data.mode === 'runtime' && !widget.data.path) widget.data.path = 'selectedPart.description'
  commitHistory('修改数据源')
}

function addCondition() {
  if (!selectedWidget.value) return
  selectedWidget.value.conditions.push({ operator: '>', value: 0, color: '#ff625f', background: 'rgba(255,98,95,.16)', animation: 'blink' })
  commitHistory('添加条件样式')
}

function addVisibilityRule() {
  if (!selectedWidget.value) return
  selectedWidget.value.visibility.rules.push({ source: 'context', path: 'viewMode', operator: '==', value: 'device' })
  commitHistory('添加显示条件')
}

function removeVisibilityRule(index) {
  selectedWidget.value?.visibility?.rules?.splice(index, 1)
  commitHistory('删除显示条件')
}

function removeCondition(index) {
  selectedWidget.value?.conditions.splice(index, 1)
  commitHistory('删除条件样式')
}

function addEvent() {
  if (!selectedWidget.value) return
  selectedWidget.value.events.push({ trigger: 'click', action: 'enter_device', deviceId: selectedWidget.value.data.deviceId || '' })
  commitHistory('添加点击事件')
}

function normalizeVisibilityEventTarget(event) {
  event.targetId = ''
  recordProperty('修改显隐目标')
}

function enterPreviewMode() {
  previewMode.value = true
  syncPreviewContextFromView()
  Object.keys(previewGroupVisibility).forEach(key => delete previewGroupVisibility[key])
  Object.keys(previewWidgetVisibility).forEach(key => delete previewWidgetVisibility[key])
  return Promise.all(overlayWidgets.value.filter(widget => widget.data?.mode === 'database').map(widget => previewDatabaseBinding(widget, true)))
}

async function toggleFullscreenPreview() {
  const shell = designerShellRef.value
  if (previewMode.value || fullscreenActive.value) {
    previewMode.value = false
    if (document.fullscreenElement === shell) {
      try { await document.exitFullscreen() } catch { /* browser may already be leaving fullscreen */ }
    }
    return
  }

  const previewReady = enterPreviewMode()
  if (!shell?.requestFullscreen) {
    setStatus('当前浏览器不支持全屏，已进入预览模式', 'warning')
    await previewReady
    return
  }
  try {
    await shell.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    setStatus('全屏权限未开启，已进入预览模式', 'warning')
  }
  await previewReady
}

function handleFullscreenChange() {
  fullscreenActive.value = document.fullscreenElement === designerShellRef.value
  if (!fullscreenActive.value) previewMode.value = false
}

function handlePreviewWidgetAction({ event }) {
  if (!previewMode.value || !event) return
  if (['set_visibility', 'toggle_visibility'].includes(event.action)) {
    applyVisibilityAction(event, { groupVisibility: previewGroupVisibility, widgetVisibility: previewWidgetVisibility })
    return
  }
  if (event.action === 'switch_view' && event.viewId) {
    selectView(event.viewId, { enterPreview: true })
    return
  }
  if (event.action === 'enter_device') {
    const target = views.value.find(view => view.mode === 'device')
    if (target) selectView(target.id, { enterPreview: true })
    Object.assign(previewContext, { viewMode: 'device', deviceId: event.deviceId || '' })
  }
  if (event.action === 'focus_factory') {
    const target = views.value.find(view => view.mode === 'factory')
    if (target) selectView(target.id, { enterPreview: true })
    Object.assign(previewContext, { viewMode: 'factory', workshopId: '', lineId: '', deviceId: '' })
  }
  if (event.action === 'focus_line') {
    const target = views.value.find(view => view.mode === 'line')
    if (target) selectView(target.id, { enterPreview: true })
    Object.assign(previewContext, { viewMode: 'line', lineId: event.lineId || '', deviceId: '' })
  }
  if (event.action === 'focus_workshop') {
    const target = views.value.find(view => view.mode === 'workshop')
    if (target) selectView(target.id, { enterPreview: true })
    Object.assign(previewContext, { viewMode: 'workshop', workshopId: event.workshopId || '', lineId: '', deviceId: '' })
  }
}

function removeEvent(index) {
  selectedWidget.value?.events.splice(index, 1)
  commitHistory('删除点击事件')
}

function applyCanvasPreset() {
  const [width, height] = canvasPreset.value.split('x').map(Number)
  if (!width || !height) return
  const oldWidth = canvas.value.width
  const oldHeight = canvas.value.height
  const scaleX = width / oldWidth
  const scaleY = height / oldHeight
  documentModel.value.widgets.forEach(widget => {
    widget.frame.x *= scaleX
    widget.frame.y *= scaleY
    widget.frame.width *= scaleX
    widget.frame.height *= scaleY
  })
  canvas.value.width = width
  canvas.value.height = height
  commitHistory('切换画布分辨率')
  nextTick(fitCanvas)
}

function applyPublishedRelease(release) {
  if (!release?.id) return
  const releaseId = String(release.id)
  const nextRelease = { ...release, is_current: 1 }
  releases.value = [
    nextRelease,
    ...releases.value.filter(item => String(item.id) !== releaseId)
  ].map(item => ({
    ...item,
    is_current: String(item.id) === releaseId ? 1 : 0
  }))
  currentRelease.value = nextRelease
}

async function saveDraft() {
  if (saving.value) return
  const editorState = rememberEditorState()
  saving.value = true
  try {
    documentModel.value.widgets.forEach(widget => { widget.data.readOnly = true })
    const result = await adminApi.saveDashboardDraft(documentModel.value.sceneId, documentModel.value, revision.value)
    if (result?.error) throw new Error(result.error)
    documentModel.value = normalizeDashboardDocument(result.document)
    revision.value = Number(result.revision || revision.value + 1)
    lastSavedSnapshot.value = snapshot()
    resetHistory()
    clearLocalDraft()
    restoreEditorState(editorState)
    setStatus(`草稿已保存，修订 ${revision.value}；现场仍运行已发布版本`, 'success')
    emit('reload')
  } catch (error) {
    setStatus(error.message || '草稿保存失败', 'danger')
    if (/修订|刷新/.test(error.message || '')) await loadDesigner({ allowLocal: true })
  } finally {
    saving.value = false
  }
}

async function publishVersion() {
  if (publishing.value) return
  rememberEditorState()
  if (isDirty.value) {
    await saveDraft()
    if (isDirty.value) return
  }
  publishing.value = true
  try {
    const result = await adminApi.publishDashboard(documentModel.value.sceneId, publishForm.version, publishForm.notes)
    if (result?.error) throw new Error(result.error)
    // 发布接口已经返回新版本信息。设计器当前内存中的文档就是刚刚保存
    // 的草稿，不需要再次请求草稿、设备、点位和数据源，避免整块画布闪回加载态。
    applyPublishedRelease(result.release)
    setStatus(`版本 ${result.release.version} 已发布，Unity 与数据层已收到更新`, 'success')
    emit('reload')
  } catch (error) {
    setStatus(error.message || '发布失败', 'danger')
  } finally {
    publishing.value = false
  }
}

function requestActivateRelease(release) {
  if (release.id === currentReleaseId.value) return
  releaseDialog.value = release
}

async function activateRelease() {
  const release = releaseDialog.value
  if (!release) return
  rememberEditorState()
  publishing.value = true
  try {
    const result = await adminApi.activateDashboardRelease(release.id)
    if (result?.error) throw new Error(result.error)
    releaseDialog.value = null
    setStatus(`已恢复发布版本 ${release.version}`, 'success')
    await loadDesigner({ allowLocal: true })
    emit('reload')
  } catch (error) {
    setStatus(error.message || '版本恢复失败', 'danger')
  } finally {
    publishing.value = false
  }
}

function recordProperty(label = '修改属性') {
  if (selectedWidget.value?.data) selectedWidget.value.data.readOnly = true
  commitHistory(label)
}

function nudgeSelected(dx, dy) {
  selectedWidgets.value.filter(widget => !widget.locked).forEach(widget => {
    widget.frame.x = Math.max(0, Math.min(canvas.value.width - widget.frame.width, widget.frame.x + dx))
    widget.frame.y = Math.max(0, Math.min(canvas.value.height - widget.frame.height, widget.frame.y + dy))
  })
  commitHistory('微调组件')
}

function handleKeydown(event) {
  const target = event.target
  if (target?.matches?.('input, textarea, select, [contenteditable="true"]')) return
  const ctrl = event.ctrlKey || event.metaKey
  if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); saveDraft(); return }
  if (ctrl && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
  if (ctrl && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
  if (ctrl && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); return }
  if (ctrl && event.key.toLowerCase() === 'g') { event.preventDefault(); event.shiftKey ? ungroupSelected() : groupSelected(); return }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); return }
  const step = event.shiftKey ? 10 : 1
  if (event.key === 'ArrowLeft') { event.preventDefault(); nudgeSelected(-step, 0) }
  if (event.key === 'ArrowRight') { event.preventDefault(); nudgeSelected(step, 0) }
  if (event.key === 'ArrowUp') { event.preventDefault(); nudgeSelected(0, -step) }
  if (event.key === 'ArrowDown') { event.preventDefault(); nudgeSelected(0, step) }
}

watch(documentModel, scheduleLocalPersist, { deep: true })
watch(currentView, () => {
  // Camera fields are edited with v-model.number. A deep watcher keeps every
  // view parameter on the same live-preview path, including target offsets and
  // future camera fields added to the schema.
  if (!loading.value) scheduleCurrentViewPreview()
}, { deep: true })
watch(
  [selectedViewId, editorDeviceId, selectedIds, inspectorTab, viewInspectorTab, layersCollapsed, viewPanelCollapsed, zoom, () => [...collapsedViewIds]],
  () => persistEditorState(),
  { deep: true }
)
watch(() => [selectedWidget.value?.id, selectedWidget.value?.data?.mode], async ([id, mode]) => {
  if (!id || mode !== 'database') return
  const datasets = ensureDatabaseDatasets(selectedWidget.value)
  await Promise.all(datasets.map(async (dataset, index) => {
    if (dataset.connectionId) await loadDatasetTables(dataset, index)
    if (dataset.connectionId && dataset.table) await loadDatasetColumns(dataset, index)
  }))
  await previewDatabaseBinding(selectedWidget.value, true)
})

function activateDesigner() {
  if (designerDisposed) return
  designerActive = true
  window.addEventListener('keydown', handleKeydown)
  if (!realtimeTimer) realtimeTimer = window.setInterval(refreshRealtimePoints, 3000)
  if (viewportRef.value) viewportObserver?.observe(viewportRef.value)
}

function deactivateDesigner() {
  scheduleCurrentViewPreview({ immediate: true })
  designerActive = false
  realtimeRequestSeq += 1
  realtimeInFlight = false
  persistLocalDraft()
  endPointerOperation()
  window.removeEventListener('keydown', handleKeydown)
  window.clearInterval(realtimeTimer)
  realtimeTimer = 0
  window.clearTimeout(localPersistTimer)
  window.clearTimeout(viewPreviewTimer)
  viewPreviewTimer = 0
  window.cancelAnimationFrame(viewportFitFrame)
  viewportObserver?.disconnect()
}

onMounted(() => {
  loadDesigner()
  viewportObserver = new ResizeObserver(() => {
    window.cancelAnimationFrame(viewportFitFrame)
    viewportFitFrame = window.requestAnimationFrame(() => {
      if (designerActive && !designerDisposed && !manualZoom) fitCanvas(previewMode.value ? 'all' : 'comfortable')
    })
  })
  document.addEventListener('fullscreenchange', handleFullscreenChange)
  activateDesigner()
})

onActivated(activateDesigner)
onDeactivated(deactivateDesigner)
onBeforeUnmount(() => {
  designerDisposed = true
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
  if (document.fullscreenElement === designerShellRef.value) document.exitFullscreen().catch(() => {})
  deactivateDesigner()
})
</script>

<template>
  <section ref="designerShellRef" class="dashboard-designer-shell" :class="{ 'is-preview': previewMode, 'is-fullscreen': fullscreenActive }">
    <header class="designer-toolbar">
      <div class="designer-brand">
        <span class="designer-brand-mark" aria-label="大屏设计器">D</span>
      </div>
      <div class="designer-toolbar-group">
        <button type="button" title="撤销 Ctrl+Z" :disabled="!canUndo" @click="undo">↶</button>
        <button type="button" title="重做 Ctrl+Y" :disabled="!canRedo" @click="redo">↷</button>
        <span class="toolbar-divider"></span>
        <button type="button" class="designer-icon-button" title="复制 Ctrl+C" aria-label="复制选中组件" :disabled="!selectedIds.length" @click="copySelected">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8" y="8" width="11" height="11" rx="1.5"></rect>
            <path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"></path>
          </svg>
        </button>
        <button type="button" class="designer-icon-button" title="从当前视角移除 Delete" aria-label="从当前视角移除选中组件" :disabled="!selectedIds.length" @click="deleteSelected">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path>
          </svg>
        </button>
        <button type="button" class="designer-icon-button" :title="selectedAllLocked ? '解锁选中组件' : '锁定选中组件'" :aria-label="selectedAllLocked ? '解锁选中组件' : '锁定选中组件'" :disabled="!selectedIds.length" @click="toggleSelectedLock">
          <svg v-if="selectedAllLocked" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="10" width="14" height="10" rx="2"></rect>
            <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path>
          </svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <rect x="5" y="10" width="14" height="10" rx="2"></rect>
            <path d="M8 10V7a4 4 0 0 1 7.2-2.4M12 14v3"></path>
          </svg>
        </button>
        <button type="button" title="组合 Ctrl+G" :disabled="selectedIds.length < 2" @click="groupSelected">组合</button>
        <button type="button" title="取消组合 Ctrl+Shift+G" :disabled="!selectedWidgets.some(item => item.groupId)" @click="ungroupSelected">解组</button>
      </div>
      <div class="designer-toolbar-group canvas-tools">
        <select v-model="canvasPreset" title="基准分辨率" @change="applyCanvasPreset">
          <option value="1920x1080">1920 × 1080</option>
          <option value="2560x1440">2560 × 1440</option>
          <option value="3840x2160">3840 × 2160</option>
          <option value="1366x768">1366 × 768</option>
        </select>
        <button type="button" @click="setZoom(zoom - .1)">−</button>
        <button type="button" class="zoom-label" title="完整适应画布" @click="fitCanvas('all')">{{ zoomPercent }}</button>
        <button type="button" @click="setZoom(zoom + .1)">＋</button>
      </div>
      <div class="designer-toolbar-actions">
        <RouterLink :to="{path:'/hud-preview',query:{embedded:$route.query.embedded}}" class="hud-review-link">同源场景预览</RouterLink>
        <select v-if="previewMode" :value="selectedViewId" title="模拟 Unity 当前视角" @change="selectView($event.target.value, { enterPreview: true })">
          <option v-for="view in views" :key="view.id" :value="view.id">{{ view.name }}</option>
        </select>
        <span class="toolbar-status" :class="status.tone" :title="status.text">{{ status.text }}</span>
        <button type="button" class="acceptance-button" :class="{ passed: acceptanceReport?.configurationReady }" :disabled="acceptanceLoading" :title="acceptanceReport ? `阻断项：${(acceptanceReport.blockingFailures || []).join('、') || '无'}` : '运行配置、数据与 Unity 检查'" @click="runAcceptanceReport">{{ acceptanceLoading ? '检查中…' : acceptanceReport?.displayReady ? '检查通过' : '运行检查' }}</button>
        <button
          type="button"
          class="fullscreen-button"
          :class="{ active: previewMode }"
          :aria-label="previewMode ? '退出全屏预览' : '全屏预览当前视角'"
          :title="previewMode ? '退出全屏预览（Esc）' : '全屏预览当前视角'"
          @click="toggleFullscreenPreview"
        >
          <svg v-if="!previewMode" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"></path></svg>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M21 15h-6v6"></path></svg>
        </button>
        <button type="button" class="save-button" :disabled="saving || !isDirty" @click="saveDraft">{{ saving ? '保存中...' : '保存草稿' }}</button>
        <button type="button" class="publish-button" :disabled="publishing || saving" @click="publishVersion">{{ publishing ? '发布中...' : '保存并发布' }}</button>
      </div>
    </header>

    <button
      v-if="fullscreenActive"
      type="button"
      class="fullscreen-exit-button"
      aria-label="退出全屏预览"
      title="退出全屏预览（Esc）"
      @click="toggleFullscreenPreview"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M21 15h-6v6"></path></svg>
    </button>

    <div class="designer-main" :class="{ 'is-left-panel-collapsed': panelLayout.leftCollapsed, 'is-right-panel-collapsed': panelLayout.rightCollapsed }">
      <aside :id="leftPanelId" v-show="!panelLayout.leftCollapsed" class="designer-left-panel" aria-label="视角与组件面板">
        <div class="view-panel-heading" @click="viewPanelCollapsed = !viewPanelCollapsed">
          <div><strong>视角编排</strong><small>Unity 镜头与组件状态</small></div><span>{{ viewPanelCollapsed ? '展开' : '收起' }}</span>
        </div>
        <div v-if="!viewPanelCollapsed" class="view-list">
          <div class="view-tree" role="tree" aria-label="视角层级">
            <div v-for="(row, rowIndex) in viewTreeRows" :key="row.view.id" class="view-tree-row" :class="{ root: row.level === 0, 'has-next': viewTreeRows[rowIndex + 1]?.view.parentViewId === row.view.id }" role="treeitem" :aria-level="row.level + 1" :aria-expanded="row.hasChildren ? !row.collapsed : undefined">
              <div class="view-tree-rail">
                <button type="button" class="view-tree-toggle" :class="{ empty: !row.hasChildren }" :aria-label="row.collapsed ? `展开${row.view.name}` : `收起${row.view.name}`" :disabled="!row.hasChildren" @click.stop="toggleViewTreeNode(row.view.id)">{{ row.hasChildren ? (row.collapsed ? '▸' : '▾') : '·' }}</button>
                <span v-if="viewTreeRows[rowIndex + 1]?.view.parentViewId === row.view.id" class="view-tree-connector-arrow" aria-hidden="true">↓</span>
              </div>
              <button type="button" class="view-tree-select" :class="{ active: selectedViewId === row.view.id }" :title="row.view.name" @click="selectView(row.view.id)">
                <span class="view-list-icon">{{ row.view.mode === 'device' ? '⌖' : row.view.mode === 'line' ? '≡' : row.view.mode === 'workshop' ? '⌂' : '◎' }}</span>
                <span><strong>{{ row.view.name }}</strong></span>
                <i v-if="documentModel.scene.defaultViewId === row.view.id" title="默认视角">●</i>
              </button>
            </div>
          </div>
          <div class="view-list-actions"><button type="button" @click="addView">＋ 新视角</button><button type="button" :disabled="!currentView" @click="duplicateView">复制</button></div>
        </div>
        <div class="designer-panel-heading"><strong>场景组件组</strong><small>一次加入完整交互区域</small></div>
        <div class="scene-preset-list">
          <button v-for="preset in DASHBOARD_WIDGET_PRESETS" :key="preset.id" type="button" @click="addWidgetPreset(preset)">
            <span>{{ preset.icon }}</span>
            <div><strong>{{ preset.label }}</strong><small>{{ preset.description }}</small></div>
            <em>{{ documentModel.widgets.some(widget => widget.groupId === `group_${preset.id}` || (preset.id === 'device_part_detail' && widget.groupId === 'group_device_part_detail')) ? '已加入' : '一键加入' }}</em>
          </button>
        </div>
        <div class="designer-panel-heading"><strong>单个组件</strong><small>拖到画布指定位置添加</small></div>
        <div class="component-library">
          <section v-for="group in libraryGroups" :key="group.name">
            <h4>{{ group.name }}</h4>
            <div class="component-grid">
              <button
                v-for="item in group.items"
                :key="item.type"
                type="button"
                draggable="true"
                 :title="item.description"
                 @dragstart="handleLibraryDragStart($event, item.type)"
               >
                <span>{{ item.icon }}</span><strong>{{ item.label }}</strong><small>{{ item.description }}</small>
              </button>
            </div>
          </section>
        </div>

        <div class="layer-heading" @click="layersCollapsed = !layersCollapsed">
          <strong>当前视角组件（{{ currentViewWidgets.length }}）</strong><span>{{ layersCollapsed ? '展开' : '收起' }}</span>
        </div>
        <div v-if="!layersCollapsed" class="layer-list">
          <button
            v-for="widget in [...currentViewWidgets].reverse()"
            :key="widget.id"
            type="button"
            :class="{ active: selectedIds.includes(widget.id), hidden: !widget.visible }"
            @click="selectWidget(widget, $event, { focusCanvas: true })"
          >
            <span class="layer-type">{{ widgetTypeLabel(widget.type).slice(0, 1) }}</span>
            <span class="layer-copy">
              <strong class="layer-name" :title="layerWidgetTitle(widget)">{{ layerWidgetTitle(widget) }}</strong>
              <small class="layer-value" :title="layerWidgetDetail(widget)">{{ layerWidgetDetail(widget) }}</small>
            </span>
            <i title="显示/隐藏" @click.stop="toggleLayerVisibility(widget)">{{ widget.visible ? '◉' : '○' }}</i>
            <i title="锁定/解锁" @click.stop="toggleLayerLock(widget)">{{ widget.locked ? '◆' : '◇' }}</i>
          </button>
          <p v-if="!currentViewWidgets.length">当前视角没有组件，从左侧拖入组件到画布</p>
          <details v-if="currentViewHiddenWidgets.length" class="layer-hidden-components">
            <summary>本视角已隐藏（{{ currentViewHiddenWidgets.length }}）</summary>
            <button v-for="item in currentViewHiddenWidgets" :key="`hidden-layer-${item.id}`" type="button" @click="toggleViewComponent(currentView, item.id, true)">
              <span class="layer-type">{{ widgetTypeLabel(item.type).slice(0, 1) }}</span>
              <span class="layer-copy"><strong class="layer-name">{{ layerWidgetTitle(item.widget) }}</strong><small class="layer-value">{{ layerWidgetDetail(item.widget) }}</small></span>
              <i title="恢复到当前视角">＋</i>
            </button>
          </details>
        </div>
        <details v-if="systemWidgetCards.length" class="system-widget-list" open>
          <summary>系统导航（{{ systemWidgetCards.length }}）</summary>
          <div v-for="card in systemWidgetCards" :key="card.widget.id" class="system-widget-card">
            <div class="system-widget-preview" :class="`preview-${card.definition.preview}`"><span>{{ card.definition.icon }}</span><i></i><b></b></div>
            <div><strong>{{ card.label }}</strong><small>{{ card.definition.description }}</small><em>大屏运行时</em></div>
          </div>
        </details>
      </aside>

      <div class="designer-panel-toggle-rail is-left">
        <button
          type="button"
          class="designer-panel-toggle"
          :class="{ 'is-collapsed': panelLayout.leftCollapsed }"
          :aria-expanded="!panelLayout.leftCollapsed"
          :aria-controls="leftPanelId"
          :aria-label="panelLayout.leftCollapsed ? '展开左侧面板' : '收起左侧面板'"
          :title="panelLayout.leftCollapsed ? '展开左侧视角与组件面板' : '收起左侧视角与组件面板'"
          @click="toggleSidePanel('left')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
        </button>
      </div>

      <main ref="viewportRef" class="designer-canvas" @dragover.prevent @drop.prevent="handleCanvasDrop" @pointerdown="clearSelection">
        <div class="designer-scope-bar">
          <div class="designer-scope-copy">
            <span>当前编辑对象</span>
            <strong>{{ currentView?.name || '未选择视角' }}</strong>
            <small>{{ viewModeLabel }} · {{ currentViewTargetLabel }}</small>
          </div>
          <label v-if="currentViewUsesDevice" class="designer-device-picker">
            <span>预览设备</span>
            <select v-model="editorDeviceId" @change="updateEditorDevice">
              <option value="">请选择设备</option>
              <option v-for="device in devices" :key="`preview-${device.id}`" :value="String(device.id)">{{ device.name || device.id }}（{{ device.id }}）</option>
            </select>
          </label>
          <div class="designer-scope-hint" :class="{ 'is-public': !currentViewUsesDevice }">{{ designerScopeHint }}</div>
        </div>
        <div v-if="loading" class="designer-loading"><span></span>正在加载草稿、点位与数据源...</div>
        <div v-else class="designer-canvas-scroll" @wheel="handleCanvasWheel">
          <div class="designer-canvas-spacer" :style="canvasOuterStyle">
            <div class="designer-canvas-stage" :style="canvasTransformStyle" @pointerdown.stop="beginMarqueeSelection">
              <div class="canvas-safe-area" :style="{ inset: `${canvas.safeArea}px` }"></div>
              <div v-for="x in guides.x" :key="`gx-${x}`" class="alignment-guide vertical" :style="{ left: `${x}px` }"></div>
              <div v-for="y in guides.y" :key="`gy-${y}`" class="alignment-guide horizontal" :style="{ top: `${y}px` }"></div>

              <article
                v-for="widget in canvasWidgets"
                :key="widget.id"
                class="designer-widget hud-widget"
                :class="{
                  ['widget-type-' + widget.type]: true,
                  'is-panel-heading': String(widget.content?.text || '').trim().startsWith('▸'),
                  selected: selectedIds.includes(widget.id),
                  locked: widget.locked,
                  hidden: !widget.visible,
                  grouped: !!widget.groupId
                }"
                :style="widgetFrameStyle(widget)"
                :data-widget-id="widget.id"
                @pointerdown.stop="beginMove($event, widget)"
                @click.stop="selectWidget(widget, $event)"
              >
                <WidgetRenderer
                  :widget="widget"
                  :metrics="mockMetrics"
                  :events="mockEvents"
                  :trend-points="mockTrend"
                  :device-status-map="mockDeviceStatus"
                  :point-values="pointValues"
                  :database-values="databasePreviewValues"
                  :business-data="mockBusinessData"
                  :runtime-context="previewContext"
                  :selected-part="previewSelectedPart"
                  :data-ready="true"
                  preview
                  overlay-mode
                  @action="handlePreviewWidgetAction"
                />
                <div v-if="!previewMode && selectedIds.includes(widget.id)" class="widget-selection-label">
                  {{ widget.title || widgetTypeLabel(widget.type) }} · {{ Math.round(widget.frame.width) }}×{{ Math.round(widget.frame.height) }}
                </div>
                <template v-if="!previewMode && selectedIds.includes(widget.id) && !widget.locked && selectedIds.length === 1">
                  <i v-for="direction in ['n','ne','e','se','s','sw','w','nw']" :key="direction" class="resize-handle" :class="direction" @pointerdown.stop="beginResize($event, widget, direction)"></i>
                </template>
              </article>

              <div
                v-if="!previewMode && selectionBox.active"
                class="designer-selection-box"
                :style="{
                  left: `${selectionBox.x}px`,
                  top: `${selectionBox.y}px`,
                  width: `${selectionBox.width}px`,
                  height: `${selectionBox.height}px`
                }"
                aria-hidden="true"
              ></div>

              <div
                v-if="!previewMode && selectedCanvasWidgets.length"
                class="selection-context-actions"
                :class="{ 'is-multi': selectedCanvasWidgets.length > 1 }"
                :style="selectionActionsStyle"
                @pointerdown.stop
                @click.stop
              >
                <span v-if="selectedCanvasWidgets.length > 1" class="selection-context-count">{{ selectedCanvasWidgets.length }}项</span>
                <button
                  type="button"
                  class="widget-delete-toggle"
                  aria-label="从当前视角删除选中组件"
                  :title="selectedHasUnlocked ? '从当前视角删除选中组件' : '锁定组件不能删除'"
                  :disabled="!selectedHasUnlocked"
                  @click="deleteSelected"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path>
                  </svg>
                </button>
                <button
                  type="button"
                  class="widget-lock-toggle"
                  :class="{ locked: selectedAllLocked }"
                  :aria-label="selectedAllLocked ? '解锁选中组件' : '锁定选中组件'"
                  :title="selectedAllLocked ? '解锁选中组件' : '锁定选中组件'"
                  @click="toggleSelectedLock"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="5" y="10" width="14" height="10" rx="2"></rect>
                    <path v-if="selectedAllLocked" d="M8 10V7a4 4 0 0 1 8 0v3"></path>
                    <path v-else d="M8 10V7a4 4 0 0 1 7.2-2.4"></path>
                    <path d="M12 14v3"></path>
                  </svg>
                </button>
              </div>

              <div v-if="!canvasWidgets.length" class="empty-canvas-hint">
                <strong>{{ overlayWidgets.length ? '当前视角没有可见组件' : '把组件拖到这里' }}</strong><span>画布为 {{ canvas.width }} × {{ canvas.height }}，运行时按屏幕等比缩放</span>
              </div>
            </div>
          </div>
        </div>
      </main>

      <div class="designer-panel-toggle-rail is-right">
        <button
          type="button"
          class="designer-panel-toggle"
          :class="{ 'is-collapsed': panelLayout.rightCollapsed }"
          :aria-expanded="!panelLayout.rightCollapsed"
          :aria-controls="rightPanelId"
          :aria-label="panelLayout.rightCollapsed ? '展开右侧面板' : '收起右侧面板'"
          :title="panelLayout.rightCollapsed ? '展开右侧属性配置面板' : '收起右侧属性配置面板'"
          @click="toggleSidePanel('right')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
        </button>
      </div>

      <aside :id="rightPanelId" v-show="!panelLayout.rightCollapsed" class="designer-right-panel" aria-label="属性配置面板">
        <template v-if="selectedWidget">
          <div class="selected-widget-heading">
            <div><span>{{ widgetTypeLabel(selectedWidget.type) }}</span><strong>{{ selectedWidget.title || selectedWidget.id }}</strong><small>{{ selectedWidget.id }}</small></div>
          </div>
          <nav class="inspector-tabs">
            <button v-for="tab in [{id:'content',label:'内容'},{id:'style',label:'样式'},{id:'data',label:'数据来源'},{id:'condition',label:'显示条件'},{id:'animation',label:'动画'},{id:'event',label:'事件'}]" :key="tab.id" type="button" :class="{ active: inspectorTab === tab.id }" @click="inspectorTab = tab.id">{{ tab.label }}</button>
          </nav>

          <div class="inspector-body">
            <section v-if="inspectorTab === 'content'" class="inspector-section">
              <label>组件标题<input v-model="selectedWidget.title" @change="recordProperty('修改标题')" /></label>
              <label v-if="selectedWidget.type === 'text'">文本内容<textarea v-model="selectedWidget.content.text" rows="5" @change="recordProperty('修改文本')"></textarea></label>
              <label v-if="selectedWidget.type === 'text'">文字对齐<select v-model="selectedWidget.content.align" @change="recordProperty()"><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option></select></label>
              <label v-if="selectedWidget.type === 'value'">字段名称<input v-model="selectedWidget.content.label" @change="recordProperty()" /></label>
              <label v-if="selectedWidget.type === 'value'">空值文字<input v-model="selectedWidget.content.fallback" @change="recordProperty()" /></label>
              <label v-if="selectedWidget.type === 'value'">展示形态<select v-model="selectedWidget.content.shape" @change="recordProperty()"><option value="card">数字卡片</option><option value="tile">数字翻牌</option><option value="gauge">仪表读数</option><option value="plain">纯数值</option></select></label>
              <template v-if="selectedWidget.type === 'status'">
                <label>开启文字<input v-model="selectedWidget.content.onText" @change="recordProperty()" /></label>
                <label>关闭文字<input v-model="selectedWidget.content.offText" @change="recordProperty()" /></label>
                <label>离线文字<input v-model="selectedWidget.content.unknownText" @change="recordProperty()" /></label>
                <label>展示形态<select v-model="selectedWidget.content.shape" @change="recordProperty()"><option value="lamp">状态灯</option><option value="badge">状态标签</option><option value="switch">状态开关</option></select></label>
              </template>
              <template v-if="selectedWidget.type === 'navigation'">
                <div class="readonly-banner compact"><span>独立组件</span>这是顶部导航状态组件；返回键是另一个独立组件，可分别移动、隐藏或锁定。</div>
                <label>项目文字<input v-model="selectedWidget.content.projectLabel" @change="recordProperty('修改导航项目文字')" /></label>
                <label>状态文字<input v-model="selectedWidget.content.statusText" @change="recordProperty('修改导航状态文字')" /></label>
              </template>
              <template v-if="selectedWidget.type === 'return_button'">
                <div class="readonly-banner compact"><span>独立组件</span>这是独立返回键组件；删除 / 隐藏不会影响顶部导航状态栏。</div>
              </template>
              <template v-if="selectedWidget.type === 'image'">
                <label>图片地址<input v-model="selectedWidget.content.url" placeholder="/uploads/... 或 https://..." @change="recordProperty()" /></label>
                <label>填充方式<select v-model="selectedWidget.content.fit" @change="recordProperty()"><option value="contain">完整显示</option><option value="cover">铺满裁切</option><option value="fill">拉伸填充</option></select></label>
                <label>替代文字<input v-model="selectedWidget.content.alt" @change="recordProperty()" /></label>
              </template>
              <template v-if="['alarm_list','device_list','hud_alarm_panel','hud_device_status'].includes(selectedWidget.type)">
                <label>最多显示<input v-model.number="selectedWidget.content.limit" type="number" min="1" max="100" @change="recordProperty()" /></label>
              </template>
              <template v-if="selectedWidget.type.startsWith('hud_')">
                <div class="readonly-banner compact"><span>共享 HUD 模块</span>内部为流式排版，背景不叠加；设计器和实时大屏使用同一个渲染器。</div>
                <label>英文眉题<input v-model="selectedWidget.content.eyebrow" @change="recordProperty('修改模块眉题')" /></label>
                <label v-if="selectedWidget.type === 'hud_device_status'" class="visibility-bound-device"><input v-model="selectedWidget.content.showTemperature" type="checkbox" @change="recordProperty()" /> 显示设备温度</label>
                <template v-if="selectedWidget.type === 'hud_kpi_panel'">
                  <label>圆环名称<input v-model="selectedWidget.content.chartLabel" @change="recordProperty()" /></label>
                  <label>圆环指标路径<input v-model="selectedWidget.content.chartPath" placeholder="metrics.overall_oee" @change="recordProperty()" /></label>
                  <div v-for="(item,index) in selectedWidget.content.items" :key="index" class="inspector-section">
                    <label>指标 {{ index + 1 }} 名称<input v-model="item.label" @change="recordProperty()" /></label>
                    <label>数据路径<input v-model="item.path" placeholder="metrics.total_devices" @change="recordProperty()" /></label>
                    <label>单位<input v-model="item.unit" @change="recordProperty()" /></label>
                  </div>
                </template>
                <template v-if="selectedWidget.type === 'hud_chart_dock'">
                  <label>读数名称<input v-model="selectedWidget.content.statLabel" @change="recordProperty()" /></label>
                  <label>读数单位<input v-model="selectedWidget.content.statUnit" @change="recordProperty()" /></label>
                </template>
              </template>
              <template v-if="selectedWidget.type === 'business_summary'">
                <label>业务区块<select v-model="selectedWidget.content.section" @change="selectedWidget.data.businessSection = selectedWidget.content.section; recordProperty('选择业务区块')"><option value="batches">批次与工艺执行</option><option value="compliance">温度 / 碳势合规</option><option value="oee">设备运行统计</option><option value="energy">单批次能耗</option><option value="maintenance">维护记录</option></select></label>
                <label>最多显示<input v-model.number="selectedWidget.content.limit" type="number" min="1" max="50" @change="recordProperty('修改业务记录数')" /></label>
                <label class="visibility-bound-device"><input v-model="selectedWidget.content.showSource" type="checkbox" @change="recordProperty('显示数据源')" /> 显示外部数据源</label>
              </template>
              <template v-if="['trend','hud_chart_dock'].includes(selectedWidget.type)">
                <label>图表形式<select v-model="selectedWidget.content.chartType" @change="recordProperty('修改图表形式')"><option value="line">折线图</option><option value="area">面积图</option><option value="bar">柱状图</option><option value="stackedBar">堆叠柱状图</option><option value="scatter">散点图</option><option value="pie">饼图</option><option value="donut">环形图</option><option value="gauge">仪表盘</option></select></label>
                <label>配色预设<select v-model="selectedWidget.content.chartPalette" @change="applyChartPalette"><option v-for="palette in chartPalettes" :key="palette.id" :value="palette.id">{{ palette.label }}</option></select></label>
                <label>图表名称<input v-model="selectedWidget.content.seriesName" @change="recordProperty()" /></label>
                <label>保留数据点<input v-model.number="selectedWidget.content.historyLength" type="number" min="8" max="600" @change="recordProperty()" /></label>
                <label class="visibility-bound-device"><input v-model="selectedWidget.content.showLegend" type="checkbox" @change="recordProperty('修改图例')" /> 显示多数据项图例</label>
                <label v-if="selectedWidget.content.showLegend">图例位置<select v-model="selectedWidget.content.legendPosition" @change="recordProperty('修改图例位置')"><option value="top">顶部</option><option value="bottom">底部</option><option value="right">右侧</option></select></label>
                <div class="property-grid two"><label class="visibility-bound-device"><input v-model="selectedWidget.content.showAxis" type="checkbox" @change="recordProperty('修改坐标轴')" /> 显示坐标轴</label><label class="visibility-bound-device"><input v-model="selectedWidget.content.showDataLabel" type="checkbox" @change="recordProperty('修改数据标签')" /> 显示数据标签</label></div>
                <template v-if="['line','area','scatter'].includes(selectedWidget.content.chartType)"><div class="property-grid two"><label class="visibility-bound-device"><input v-model="selectedWidget.content.smooth" type="checkbox" :disabled="selectedWidget.content.chartType === 'scatter'" @change="recordProperty('修改曲线')" /> 平滑曲线</label><label class="visibility-bound-device"><input v-model="selectedWidget.content.showSymbol" type="checkbox" @change="recordProperty('修改数据点')" /> 显示数据点</label></div><label>线宽<input v-model.number="selectedWidget.content.lineWidth" type="range" min="1" max="8" step="1" @change="recordProperty('修改线宽')" /><small class="field-hint">{{ selectedWidget.content.lineWidth || 2 }} px</small></label></template>
                <label v-if="selectedWidget.content.chartType === 'area'">面积透明度<input v-model.number="selectedWidget.content.areaOpacity" type="range" min="0.05" max="0.9" step="0.05" @change="recordProperty('修改面积透明度')" /><small class="field-hint">{{ Math.round((selectedWidget.content.areaOpacity ?? .2) * 100) }}%</small></label>
                <label v-if="['bar','stackedBar'].includes(selectedWidget.content.chartType)">柱体圆角<input v-model.number="selectedWidget.content.barRadius" type="range" min="0" max="20" step="1" @change="recordProperty('修改柱体圆角')" /><small class="field-hint">{{ selectedWidget.content.barRadius || 0 }} px</small></label>
                <label v-if="selectedWidget.content.chartType === 'donut'">内环比例<input v-model.number="selectedWidget.content.donutRatio" type="range" min="20" max="75" step="1" @change="recordProperty('修改内环')" /><small class="field-hint">{{ selectedWidget.content.donutRatio || 48 }}%</small></label>
                <div v-if="selectedWidget.content.chartType === 'gauge'" class="property-grid two"><label>最小值<input v-model.number="selectedWidget.content.min" type="number" @change="recordProperty()" /></label><label>最大值<input v-model.number="selectedWidget.content.max" type="number" @change="recordProperty()" /></label></div>
              </template>
              <template v-if="selectedWidget.type === 'marquee'">
                <label>滚动周期（秒）<input v-model.number="selectedWidget.content.speed" type="number" min="5" max="180" @change="recordProperty()" /></label>
                <label>事件条数<input v-model.number="selectedWidget.content.limit" type="number" min="1" max="200" @change="recordProperty()" /></label>
              </template>
              <div class="property-grid two">
                <label>X<input v-model.number="selectedWidget.frame.x" type="number" @change="recordProperty('修改位置')" /></label>
                <label>Y<input v-model.number="selectedWidget.frame.y" type="number" @change="recordProperty('修改位置')" /></label>
                <label>宽度<input v-model.number="selectedWidget.frame.width" type="number" min="20" @change="recordProperty('修改尺寸')" /></label>
                <label>高度<input v-model.number="selectedWidget.frame.height" type="number" min="20" @change="recordProperty('修改尺寸')" /></label>
                <label>旋转<input v-model.number="selectedWidget.frame.rotation" type="number" min="-360" max="360" @change="recordProperty()" /></label>
                <label>层级<input v-model.number="selectedWidget.zIndex" type="number" @change="recordProperty('修改层级')" /></label>
              </div>
              <div class="layer-actions"><button @click="moveLayer(selectedWidget,'top')">置顶</button><button @click="moveLayer(selectedWidget,'up')">上移</button><button @click="moveLayer(selectedWidget,'down')">下移</button><button @click="moveLayer(selectedWidget,'bottom')">置底</button></div>
            </section>

            <section v-else-if="inspectorTab === 'style'" class="inspector-section">
              <ColorField v-model="selectedWidget.style.background" label="背景颜色" :presets="backgroundColorPresets" @commit="recordProperty('修改样式')" />
              <ColorField v-model="selectedWidget.style.color" label="文字颜色" :presets="textColorPresets" @commit="recordProperty('修改样式')" />
              <ColorField v-if="selectedWidget.type === 'value'" v-model="selectedWidget.style.valueColor" label="数值颜色" :presets="textColorPresets" @commit="recordProperty('修改样式')" />
              <template v-if="selectedWidget.type === 'status'">
                <ColorField v-model="selectedWidget.style.onColor" label="正常 / 开启颜色" :presets="textColorPresets" @commit="recordProperty('修改样式')" />
                <ColorField v-model="selectedWidget.style.offColor" label="停止 / 关闭颜色" :presets="textColorPresets" @commit="recordProperty('修改样式')" />
                <ColorField v-model="selectedWidget.style.alarmColor" label="报警颜色" :presets="textColorPresets" @commit="recordProperty('修改样式')" />
              </template>
              <template v-if="['trend','hud_chart_dock','hud_kpi_panel'].includes(selectedWidget.type)">
                <ColorField v-model="selectedWidget.content.lineColor" label="曲线颜色" :presets="textColorPresets" @commit="recordProperty('修改样式')" />
                <ColorField v-model="selectedWidget.content.areaColor" label="曲线填充颜色" :presets="borderColorPresets" @commit="recordProperty('修改样式')" />
              </template>
              <ColorField v-model="selectedWidget.style.borderColor" label="边框颜色" :presets="borderColorPresets" @commit="recordProperty('修改样式')" />
              <div class="property-grid two">
                <label>圆角<input v-model.number="selectedWidget.style.borderRadius" type="number" min="0" max="80" @change="recordProperty('修改样式')" /></label>
                <label>字号<input v-model.number="selectedWidget.style.fontSize" type="number" min="10" max="120" @change="recordProperty('修改样式')" /></label>
                <label>内容透明度<input v-model.number="selectedWidget.style.opacity" type="number" min="0" max="1" step=".05" @change="recordProperty('修改样式')" /></label>
                <label>内边距<input v-model.number="selectedWidget.style.padding" type="number" min="0" max="100" @change="recordProperty('修改样式')" /></label>
              </div>
              <label class="panel-opacity-setting">
                <span>面板背景不透明度 <b>{{ Math.round(Number(selectedWidget.style.backgroundOpacity || 0) * 100) }}%</b><small>透光 {{ Math.round((1 - Number(selectedWidget.style.backgroundOpacity || 0)) * 100) }}%</small></span>
                <input v-model.number="selectedWidget.style.backgroundOpacity" type="range" min="0" max="1" step=".01" @change="recordProperty('修改面板透明度')" />
                <small class="field-hint">只调整底色，不会让文字、数字和图表变淡。大屏与设计器预览同步使用。</small>
              </label>
              <label>阴影<select v-model="selectedWidget.style.shadow" @change="recordProperty('修改样式')"><option value="none">无</option><option value="soft">柔和</option><option value="glow">发光</option><option value="strong">强调</option></select></label>
            </section>

            <section v-else-if="inspectorTab === 'data'" class="inspector-section">
              <div class="readonly-banner"><span>只读</span>所有外部数据源和 PLC 点位只用于展示，发布校验会拦截任何写入配置。</div>
              <label>数据来源<select v-model="selectedWidget.data.mode" @change="changeBindingMode"><option value="static">静态 / 组件默认数据</option><option value="plc">PLC 只读点位</option><option value="database">通用数据库连接</option><option value="business">排产业务只读适配层</option><option value="runtime">设备检查上下文</option></select></label>
              <template v-if="selectedWidget.data.mode === 'plc'">
                <label>设备范围<select v-model="selectedWidget.data.deviceScope" @change="changeDeviceScope"><option value="current">当前设备（跟随视角）</option><option value="fixed">指定设备</option></select></label>
                <p v-if="selectedWidget.data.deviceScope === 'current'" class="field-hint">同一个组件可用于所有设备，运行时自动读取当前视角设备的同名点位，不需要复制组件。</p>
                <label v-if="selectedWidget.data.deviceScope === 'fixed'">绑定设备<select v-model="selectedWidget.data.deviceId" @change="selectedWidget.data.pointId=''; selectedWidget.data.pointKey=''; recordProperty('选择设备')"><option value="">请选择设备</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{ device.name }}（{{ device.id }}）</option></select></label>
                <label>READ 点位<select v-model="selectedWidget.data.pointId" :disabled="!selectedBindingDeviceId" @change="bindSelectedPoint"><option value="">请选择只读点位</option><option v-for="point in selectedDevicePoints" :key="point.id" :value="String(point.id)">{{ point.label || point.name }} · {{ point.plc_tag || `DB${point.db_number}.${point.db_byte_offset}` }}</option></select></label>
                <div class="binding-summary" v-if="selectedWidget.data.pointId"><span>路径</span><code>{{ selectedWidget.data.path }}</code><span>实时值</span><strong>{{ previewValueForWidget(selectedWidget) ?? '--' }} {{ selectedWidget.data.unit }}</strong></div>
              </template>
              <template v-else-if="selectedWidget.data.mode === 'database'">
                <div class="section-action-heading"><div><strong>数据项</strong><small>每项可来自不同数据库和表，别名用于下方公式</small></div><button type="button" @click="addDatabaseDataset">＋ 数据项</button></div>
                <details v-for="(dataset, datasetIndex) in ensureDatabaseDatasets(selectedWidget)" :key="`${selectedWidget.id}-${datasetIndex}`" class="dataset-card" :open="datasetIndex === 0">
                  <summary><i :style="{background:dataset.color}"></i><strong>{{ dataset.alias.toUpperCase() }} · {{ dataset.label }}</strong><span>{{ dataset.table || '未选择表' }}</span></summary>
                  <div class="dataset-card-body">
                    <div class="property-grid two"><label>公式别名<input v-model="dataset.alias" placeholder="a" @change="dataset.alias = dataset.alias.replace(/[^a-zA-Z0-9_]/g,'_').toLowerCase(); recordProperty('修改数据别名')" /></label><label>图例名称<input v-model="dataset.label" @change="recordProperty('修改数据名称')" /></label></div>
                    <ColorField v-model="dataset.color" label="数据项颜色" :presets="textColorPresets" @commit="recordProperty('修改数据颜色')" />
                    <label>数据库连接<select v-model="dataset.connectionId" @change="changeDatasetConnection(dataset, datasetIndex)"><option value="">请选择连接</option><option v-for="source in dataSources" :key="source.id" :value="source.id">{{ source.name }} · {{ source.type }}</option></select></label>
                    <label>数据表<select :value="datasetTableKey(dataset)" :disabled="!dataset.connectionId || databaseMetadataLoading" @change="changeDatasetTable(dataset, datasetIndex, $event.target.value)"><option value="">{{ databaseMetadataLoading ? '正在读取...' : '请选择表' }}</option><option v-for="table in datasetTables(datasetIndex)" :key="`${table.schema}.${table.name}`" :value="`${table.schema || ''}\u0001${table.name}`">{{ table.schema ? `${table.schema}.` : '' }}{{ table.name }}</option></select></label>
                    <label v-if="dataset.valueMode !== 'count'">数值字段<select v-model="dataset.field" :disabled="!dataset.table" @change="recordProperty('选择数据字段'); previewDatabaseBinding()"><option value="">请选择字段</option><option v-for="column in datasetColumns(datasetIndex)" :key="column.name" :value="column.name">{{ column.name }} · {{ column.dataType }}</option></select></label>
                    <label>读取方式<select v-model="dataset.valueMode" @change="recordProperty('修改读取方式'); previewDatabaseBinding()"><option value="latest">最新一条</option><option value="first">第一条</option><option value="list">序列（图表 / 列表）</option><option value="count">记录数量</option><option value="sum">合计</option><option value="avg">平均值</option><option value="min">最小值</option><option value="max">最大值</option></select></label>
                    <template v-if="['latest','first','list'].includes(dataset.valueMode)"><label>时间 / 排序字段<select v-model="dataset.orderBy" @change="dataset.timeField=dataset.orderBy; recordProperty('修改排序')"><option value="">不指定</option><option v-for="column in datasetColumns(datasetIndex)" :key="`order-${column.name}`" :value="column.name">{{ column.name }}</option></select></label><label>排序方向<select v-model="dataset.orderDirection" @change="recordProperty('修改排序')"><option value="desc">新到旧</option><option value="asc">旧到新</option></select></label></template>
                    <div class="property-grid two"><label v-if="dataset.valueMode === 'list'">读取行数<input v-model.number="dataset.rowLimit" type="number" min="1" max="500" @change="recordProperty('修改读取行数')" /></label><label>刷新周期（秒）<input :value="Math.round(dataset.refreshMs/1000)" type="number" min="1" max="3600" @change="dataset.refreshMs=Math.max(1000,Number($event.target.value||5)*1000);recordProperty('修改刷新周期')" /></label></div>
                    <div class="dataset-context"><label>按当前对象过滤<select v-model="dataset.contextKey" @change="recordProperty('修改上下文过滤')"><option value="">不过滤</option><option value="deviceId">当前设备 ID</option><option value="partId">当前部件 ID</option><option value="lineId">当前产线 ID</option><option value="workshopId">当前车间 ID</option><option value="viewId">当前视角 ID</option></select></label><label v-if="dataset.contextKey">表中对应字段<select v-model="dataset.contextField" @change="recordProperty('修改上下文字段')"><option value="">请选择</option><option v-for="column in datasetColumns(datasetIndex)" :key="`context-${column.name}`" :value="column.name">{{ column.name }}</option></select></label></div>
                    <button v-if="ensureDatabaseDatasets(selectedWidget).length > 1" type="button" class="danger-link" @click="removeDatabaseDataset(datasetIndex)">删除这个数据项</button>
                  </div>
                </details>
                <label>计算公式（可选）<input v-model="selectedWidget.data.formula" placeholder="例如：(a / b) * 100" @change="recordProperty('修改计算公式'); previewDatabaseBinding()" /><small class="field-hint">仅支持别名、数字、+ − × ÷ 和括号，不执行 SQL 或脚本。</small></label>
                <div v-if="selectedWidget.data.formula" class="property-grid two"><label>计算结果名称<input v-model="selectedWidget.data.formulaLabel" @change="recordProperty()" /></label><ColorField v-model="selectedWidget.data.formulaColor" label="计算结果颜色" :presets="textColorPresets" @commit="recordProperty('修改计算颜色')" /></div>
                <label>设备范围<select v-model="selectedWidget.data.deviceScope" @change="changeDatabaseScope"><option value="current">当前设备（跟随视角）</option><option value="fixed">指定设备 / 所有设备通用</option></select></label>
                <label v-if="selectedWidget.data.deviceScope === 'fixed'">设备详情适用范围<select v-model="selectedWidget.data.deviceId" @change="bindDatabaseToDevice"><option value="">所有设备通用</option><option v-for="device in devices" :key="`db-${device.id}`" :value="String(device.id)">仅 {{ device.name }}（{{ device.id }}）</option></select><small class="field-hint">只有确实需要固定设备数据时才选择指定设备；通常选“当前设备”即可复用。</small></label>
                <p v-else class="field-hint">运行时按当前视角设备读取；一个组件即可覆盖多台设备。</p>
                <button type="button" class="inspector-preview-button" :disabled="databaseMetadataLoading" @click="previewDatabaseBinding()">刷新数据预览</button>
                <div v-if="databasePreviewValues[selectedWidget.id]" class="binding-summary"><span>预览值</span><strong>{{ databasePreviewValues[selectedWidget.id]?.value ?? '--' }} {{ selectedWidget.data.unit }}</strong><span>数据项</span><code>{{ databasePreviewValues[selectedWidget.id]?.series?.map(item => `${item.label}: ${item.value ?? '--'}`).join(' · ') || '--' }}</code><span>状态</span><strong>{{ databasePreviewValues[selectedWidget.id]?.error || '读取正常' }}</strong></div>
              </template>
              <template v-else-if="selectedWidget.data.mode === 'business'">
                <label>外部业务数据库<select v-model="selectedWidget.data.connectionId" @change="recordProperty('选择业务数据库')"><option value="">请选择只读连接</option><option v-for="source in dataSources" :key="`business-${source.id}`" :value="source.id">{{ source.name }} · {{ source.type }}</option></select></label>
                <label>业务区块<select v-model="selectedWidget.data.businessSection" @change="selectedWidget.content.section = selectedWidget.data.businessSection; recordProperty('选择业务区块')"><option value="batches">批次与工艺执行</option><option value="compliance">温度 / 碳势合规</option><option value="oee">设备运行统计</option><option value="energy">单批次能耗</option><option value="maintenance">维护记录</option></select></label>
                <div class="readonly-banner compact"><span>只读</span>运行时会按当前设备上下文读取外部数据库；没有标准表时显示“未提供”，不会写入排产系统。</div>
              </template>
              <template v-else-if="selectedWidget.data.mode === 'runtime'">
                <label>上下文路径<input v-model="selectedWidget.data.path" class="input" placeholder="selectedPart.description / selectedPart.name / context.inspectionStage" @change="recordProperty('修改检查上下文路径')" /></label>
                <p class="field-hint">可用字段：selectedPart.name、selectedPart.description、selectedPart.stage、selectedPart.points.0.value，以及 context.deviceId / context.inspectionStage。</p>
              </template>
              <div class="property-grid two">
                <label>单位<input v-model="selectedWidget.data.unit" @change="recordProperty('修改单位')" /></label>
                <label>小数位<input v-model.number="selectedWidget.data.decimals" type="number" min="0" max="8" @change="recordProperty('修改格式')" /></label>
              </div>
            </section>

            <section v-else-if="inspectorTab === 'condition'" class="inspector-section">
              <div class="section-action-heading"><div><strong>显隐规则</strong><small>可按当前对象或数据值决定组件出现 / 消失</small></div><button @click="addVisibilityRule">＋ 添加</button></div>
              <label v-if="selectedWidget.visibility.rules.length">多条规则<select v-model="selectedWidget.visibility.ruleMode" @change="recordProperty('修改显隐规则')"><option value="all">全部满足</option><option value="any">任意满足</option></select></label>
              <div v-for="(rule, index) in selectedWidget.visibility.rules" :key="`visible-${index}`" class="condition-card">
                <div class="property-grid two"><label>来源<select v-model="rule.source" @change="rule.path = rule.source === 'data' ? 'value' : 'viewMode'; recordProperty()"><option value="context">Unity 上下文</option><option value="data">组件数据值</option></select></label><label>字段<select v-if="rule.source === 'context'" v-model="rule.path" @change="recordProperty()"><option value="viewMode">当前视角</option><option value="viewId">当前视角 ID</option><option value="workshopId">车间 ID</option><option value="lineId">产线 ID</option><option value="deviceId">设备 ID</option><option value="inspectionStage">检查阶段</option><option value="partId">部件 ID</option><option value="partName">部件名称</option></select><input v-else v-model="rule.path" placeholder="value" @change="recordProperty()" /></label></div>
                <div class="property-grid two"><label>判断<select v-model="rule.operator" @change="recordProperty()"><option value="==">等于</option><option value="!=">不等于</option><option value=">">大于</option><option value=">=">大于等于</option><option value="<">小于</option><option value="<=">小于等于</option><option value="truthy">为真</option><option value="falsy">为假</option><option value="contains">包含</option></select></label><label>目标值<input v-model="rule.value" @change="recordProperty()" /></label></div>
                <button class="danger-link" @click="removeVisibilityRule(index)">删除显隐规则</button>
              </div>

              <div class="section-action-heading"><div><strong>条件样式</strong><small>按实时值切换颜色或闪烁</small></div><button @click="addCondition">＋ 添加</button></div>
              <div v-for="(condition, index) in selectedWidget.conditions" :key="index" class="condition-card">
                <div class="property-grid two"><label>判断<select v-model="condition.operator" @change="recordProperty()"><option value=">">大于</option><option value=">=">大于等于</option><option value="<">小于</option><option value="<=">小于等于</option><option value="==">等于</option><option value="!=">不等于</option><option value="truthy">为真</option><option value="falsy">为假</option></select></label><label>阈值<input v-model="condition.value" @change="recordProperty()" /></label></div>
                <ColorField v-model="condition.color" label="文字颜色" :presets="textColorPresets" @commit="recordProperty('修改条件颜色')" />
                <ColorField v-model="condition.background" label="背景颜色" :presets="backgroundColorPresets" @commit="recordProperty('修改条件颜色')" />
                <label>效果<select v-model="condition.animation" @change="recordProperty()"><option value="none">无</option><option value="blink">闪烁</option><option value="pulse">脉冲</option></select></label>
                <button class="danger-link" @click="removeCondition(index)">删除条件</button>
              </div>
              <p v-if="!selectedWidget.conditions.length" class="empty-inspector">尚未添加条件。组件会一直使用普通样式。</p>
            </section>

            <section v-else-if="inspectorTab === 'animation'" class="inspector-section">
              <label>进入/循环动画<select v-model="selectedWidget.animation.type" @change="recordProperty('修改动画')"><option value="none">无动画</option><option value="fadeIn">淡入</option><option value="slideUp">上滑进入</option><option value="pulse">轻微脉冲</option><option value="breathe">呼吸光</option><option value="float">上下浮动</option><option value="blink">闪烁</option></select></label>
              <div class="property-grid two"><label>时长（秒）<input v-model.number="selectedWidget.animation.duration" type="number" min=".1" max="60" step=".1" @change="recordProperty('修改动画')" /></label><label>延迟（秒）<input v-model.number="selectedWidget.animation.delay" type="number" min="0" max="60" step=".1" @change="recordProperty('修改动画')" /></label></div>
              <label>循环<select v-model="selectedWidget.animation.iteration" @change="recordProperty('修改动画')"><option value="1">播放一次</option><option value="2">播放两次</option><option value="infinite">持续循环</option></select></label>
            </section>

            <section v-else class="inspector-section">
              <div class="section-action-heading"><div><strong>交互事件</strong><small>导航、语音、链接和组件 / 分组显隐；始终禁止数据写入</small></div><button @click="addEvent">＋ 添加</button></div>
              <div v-for="(event, index) in selectedWidget.events" :key="index" class="condition-card">
                <label>触发<select v-model="event.trigger" @change="recordProperty()"><option value="click">单击</option><option value="doubleClick">双击</option></select></label>
                <label>动作<select v-model="event.action" @change="recordProperty()"><option value="enter_device">进入设备</option><option value="focus_factory">返回工厂总览</option><option value="focus_line">聚焦产线</option><option value="focus_workshop">聚焦车间</option><option value="switch_view">切换到指定视角</option><option value="set_visibility">显示 / 隐藏目标</option><option value="toggle_visibility">切换目标显隐</option><option value="play_voice">播放语音</option><option value="open_link">打开链接</option><option value="switch_scene">切换场景</option></select></label>
                <label v-if="event.action === 'enter_device'">设备<select v-model="event.deviceId" @change="recordProperty()"><option value="">请选择</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{ device.name }}</option></select></label>
                <label v-if="event.action === 'focus_line'">产线<select v-model="event.lineId" @change="recordProperty()"><option value="">当前设备所属产线</option><option v-for="line in lines" :key="line.id" :value="String(line.id)">{{ line.name }}</option></select></label>
                <label v-if="event.action === 'focus_workshop'">车间<select v-model="event.workshopId" @change="recordProperty()"><option value="">请选择</option><option v-for="workshop in workshops" :key="workshop.id" :value="String(workshop.id)">{{ workshop.name }}</option></select></label>
                <label v-if="event.action === 'switch_view'">目标视角<select v-model="event.viewId" @change="recordProperty('设置目标视角')"><option value="">请选择</option><option v-for="view in views" :key="view.id" :value="view.id">{{ view.name }} · {{ DASHBOARD_VIEW_MODES.find(item => item.id === view.mode)?.label || '自定义' }}</option></select></label>
                <template v-if="['set_visibility','toggle_visibility'].includes(event.action)">
                  <label>目标类型<select v-model="event.targetType" @change="normalizeVisibilityEventTarget(event)"><option value="group">组件分组</option><option value="widget">单个组件</option></select></label>
                  <label v-if="event.targetType === 'group'">目标分组<select v-model="event.targetId" @change="recordProperty()"><option value="">请选择分组</option><option v-for="group in groupOptions" :key="group.id" :value="group.id">{{ group.label }} · {{ group.id }}</option></select></label>
                  <label v-else>目标组件<select v-model="event.targetId" @change="recordProperty()"><option value="">请选择组件</option><option v-for="item in eventWidgetOptions" :key="item.id" :value="item.id">{{ item.label }}</option></select></label>
                  <label v-if="event.action === 'set_visibility'">目标状态<select v-model="event.visibility" @change="recordProperty()"><option value="show">显示</option><option value="hide">隐藏</option></select></label>
                </template>
                <label v-if="event.action === 'switch_scene'">场景 ID<input v-model="event.sceneId" @change="recordProperty()" /></label>
                <label v-if="event.action === 'play_voice'">语音文件<input v-model="event.audioUrl" placeholder="/uploads/audio/..." @change="recordProperty()" /></label>
                <label v-if="event.action === 'play_voice'">无文件时播报文字<textarea v-model="event.text" rows="2" @change="recordProperty()"></textarea></label>
                <label v-if="event.action === 'open_link'">链接地址<input v-model="event.url" placeholder="https://..." @change="recordProperty()" /></label>
                <button class="danger-link" @click="removeEvent(index)">删除事件</button>
              </div>
              <p v-if="!selectedWidget.events.length" class="empty-inspector">没有点击事件，组件只负责展示。</p>
            </section>
          </div>
        </template>

        <template v-else-if="currentView">
          <div class="selected-widget-heading view-inspector-heading">
            <div><span>视角配置 · {{ viewModeLabel }}</span><strong>{{ currentView.name }}</strong><small>{{ currentView.id }}</small></div>
            <button type="button" @click="setDefaultView">{{ documentModel.scene.defaultViewId === currentView.id ? '默认视角' : '设为默认' }}</button>
          </div>
          <nav class="inspector-tabs view-inspector-tabs">
            <button v-for="tab in [{id:'camera',label:'镜头'},{id:'components',label:'组件状态'},{id:'flow',label:'层级关系'}]" :key="tab.id" type="button" :class="{ active: viewInspectorTab === tab.id }" @click="viewInspectorTab = tab.id">{{ tab.label }}</button>
          </nav>
          <div class="inspector-body">
            <section v-if="viewInspectorTab === 'camera'" class="inspector-section">
              <label>视角名称<input v-model="currentView.name" @change="commitHistory('修改视角名称')" /></label>
              <div class="property-grid two"><label>类型<select v-model="currentView.mode" @change="commitHistory('修改视角类型'); syncPreviewContextFromView()"><option v-for="mode in DASHBOARD_VIEW_MODES" :key="mode.id" :value="mode.id">{{ mode.label }}</option></select></label><label>目标类型<select v-model="currentView.targetType" @change="updateViewTarget(currentView)"><option value="factory">全厂</option><option value="workshop">车间</option><option value="line">产线</option><option value="device">设备</option><option value="device_part">指定部件</option></select></label></div>
              <label v-if="currentView.targetType === 'workshop'">目标车间<select v-model="currentView.targetId" @change="updateViewTarget(currentView)"><option value="">自动按当前上下文</option><option v-for="workshop in workshops" :key="workshop.id" :value="String(workshop.id)">{{ workshop.name || workshop.id }}</option></select></label>
              <label v-if="currentView.targetType === 'line'">目标产线<select v-model="currentView.targetId" @change="updateViewTarget(currentView)"><option value="">自动按当前上下文</option><option v-for="line in lines" :key="line.id" :value="String(line.id)">{{ line.name || line.id }}</option></select></label>
              <label v-if="currentView.targetType === 'device'">目标设备<select v-model="currentView.targetId" @change="updateViewTarget(currentView)"><option value="">自动按当前上下文</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{ device.name || device.id }}</option></select></label>
              <label v-if="currentView.targetType === 'device_part'">部件 ID<input v-model="currentView.targetId" placeholder="如 front_door_open" @change="commitHistory('修改目标部件')" /></label>
              <div class="property-grid two"><label>水平角（°）<input v-model.number="currentView.camera.yaw" type="number" min="-360" max="360" step="1" @change="commitHistory('修改视角水平角')" /></label><label>俯仰角（°）<input v-model.number="currentView.camera.pitch" type="number" min="-89" max="89" step="1" @change="commitHistory('修改视角俯仰角')" /></label><label>距离比例<input v-model.number="currentView.camera.distanceScale" type="number" min=".1" max="10" step=".01" @change="commitHistory('修改视角距离')" /></label><label>过渡时间（秒）<input v-model.number="currentView.camera.transitionSeconds" type="number" min="0" max="10" step=".1" @change="commitHistory('修改视角过渡')" /></label></div>
              <div class="property-grid two"><label>目标偏移 X<input v-model.number="currentView.camera.targetOffset[0]" type="number" step=".1" @change="commitHistory('修改视角目标')" /></label><label>目标偏移 Y<input v-model.number="currentView.camera.targetOffset[1]" type="number" step=".1" @change="commitHistory('修改视角目标')" /></label><label>目标偏移 Z<input v-model.number="currentView.camera.targetOffset[2]" type="number" step=".1" @change="commitHistory('修改视角目标')" /></label></div>
              <label class="visibility-bound-device"><input v-model="currentView.camera.relativeToTarget" type="checkbox" @change="commitHistory('修改相机朝向参考')" /> 设备视角跟随设备朝向（适合不同设备旋转角度）</label>
              <button type="button" class="view-delete-button" @click="removeView" :disabled="views.length <= 1">删除当前视角</button>
            </section>
            <section v-else-if="viewInspectorTab === 'components'" class="inspector-section">
              <div class="readonly-banner"><span>所见即所得</span>下面列出当前视角画布中的组件；顶部导航状态和返回键是两个独立组件，可分别删除 / 隐藏 / 锁定。Unity 诊断面板、设备浮标等运行时系统项不占画布。取消勾选可暂时隐藏，隐藏后可在“已隐藏组件”中恢复。</div>
              <label class="visibility-bound-device"><input v-model="currentView.componentState.hideNonTargetDevices" type="checkbox" @change="commitHistory('修改目标设备显隐')" /> 只显示目标范围内的设备</label>
              <div v-if="viewComponents.length" class="view-component-list"><label v-for="item in viewComponents" :key="item.id"><input type="checkbox" checked @change="toggleViewComponent(currentView, item.id, $event.target.checked)" /><span>{{ item.label }}</span><small>{{ item.type === 'navigation' ? '顶部导航' : item.type === 'return_button' ? '返回键' : widgetTypeLabel(item.type) }}</small></label></div>
              <p v-else class="empty-inspector">当前视角还没有显示组件，请从左侧拖入组件到画布。</p>
              <details v-if="hiddenViewComponents.length" class="view-hidden-components">
                <summary>已隐藏组件（{{ hiddenViewComponents.length }}）</summary>
                <div class="view-component-list"><label v-for="item in hiddenViewComponents" :key="item.id"><input type="checkbox" :checked="false" @change="toggleViewComponent(currentView, item.id, $event.target.checked)" /><span>{{ item.label }}</span><small>{{ item.type === 'navigation' ? '顶部导航' : item.type === 'return_button' ? '返回键' : widgetTypeLabel(item.type) }}</small></label></div>
              </details>
            </section>
            <section v-else class="inspector-section">
              <label>返回上一级视角<select v-model="currentView.returnViewId" @change="commitHistory('修改返回视角')"><option value="">不返回</option><option v-for="view in views.filter(item => item.id !== currentView.id)" :key="view.id" :value="view.id">{{ view.name }}</option></select></label>
              <label>父级视角<select v-model="currentView.parentViewId" @change="commitHistory('修改父级视角')"><option value="">无</option><option v-for="view in views.filter(item => item.id !== currentView.id)" :key="view.id" :value="view.id">{{ view.name }}</option></select></label>
              <p class="visibility-hint">点击设备或组件时，可在右侧“事件”中选择“切换到指定视角”。返回按钮会优先使用这里配置的上一级视角。</p>
            </section>
          </div>
        </template>

        <template v-else>
          <div class="designer-panel-heading"><strong>画布设置</strong><small>未选择组件</small></div>
          <div class="inspector-body inspector-section">
            <label>大屏名称<input v-model="documentModel.name" @change="commitHistory('修改大屏名称')" /></label>
            <div class="property-grid two"><label>宽度<input v-model.number="canvas.width" type="number" min="320" max="7680" @change="commitHistory('修改画布')" /></label><label>高度<input v-model.number="canvas.height" type="number" min="180" max="4320" @change="commitHistory('修改画布')" /></label></div>
            <div class="property-grid two"><label>吸附网格<input v-model.number="canvas.gridSize" type="number" min="1" max="200" @change="commitHistory('修改画布')" /></label><label>安全边距<input v-model.number="canvas.safeArea" type="number" min="0" max="400" @change="commitHistory('修改画布')" /></label></div>
            <ColorField v-model="canvas.background" label="画布背景" :presets="backgroundColorPresets" @commit="commitHistory('修改画布')" />
            <ColorField v-model="documentModel.theme.accentColor" label="主题色" :presets="textColorPresets" @commit="commitHistory('修改主题')" />
          </div>
        </template>
      </aside>
    </div>

    <footer class="designer-statusbar">
      <span class="designer-status" :class="status.tone"><i></i>{{ status.text }}</span>
      <span>{{ documentModel.widgets.length }} 个组件 · {{ selectedIds.length }} 个已选</span>
      <span :class="{ dirty: isDirty }">{{ isDirty ? '有未保存修改' : '草稿已保存' }}</span>
      <div class="release-strip"><strong>发布记录</strong><button v-for="release in releases.slice(0, 5)" :key="release.id" type="button" :class="{ current: release.id === currentReleaseId }" @click="requestActivateRelease(release)">{{ release.version }}<small>{{ release.id === currentReleaseId ? '运行中' : '可恢复' }}</small></button></div>
    </footer>

    <Transition name="designer-dialog">
      <div v-if="releaseDialog" class="designer-dialog-backdrop" @click.self="releaseDialog = null">
        <div class="designer-dialog compact">
          <div class="dialog-icon restore">↶</div>
          <h3>恢复版本 {{ releaseDialog.version }}</h3>
          <p>现场运行画面会切换到该发布快照，当前草稿不会被覆盖。</p>
          <div><button type="button" @click="releaseDialog = null">取消</button><button class="primary" :disabled="publishing" @click="activateRelease">确认恢复</button></div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.dashboard-designer-shell { --panel:#0d1724; --panel2:#111f2f; --line:rgba(130,184,226,.16); --text:#eaf4ff; --muted:#8fa5ba; --accent:#42a5f5; display:flex; flex-direction:column; height:clamp(720px,calc(100vh - 150px),1080px); min-height:720px; overflow-x:auto; overflow-y:hidden; border:1px solid rgba(53,105,148,.26); border-radius:16px; color:var(--text); background:#08111c; box-shadow:0 22px 52px rgba(9,22,34,.18); scrollbar-color:#29445e #08111b; scrollbar-width:thin; font-family:var(--hud-font-text,"SF Pro Text","Inter","Segoe UI","PingFang SC","Microsoft YaHei UI",sans-serif); font-synthesis:none; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
.designer-toolbar { flex:0 0 58px; display:flex; align-items:center; gap:14px; min-width:1180px; padding:0 14px; border-bottom:1px solid var(--line); background:linear-gradient(180deg,#142335,#0d1927); }
.designer-brand { display:flex; align-items:center; gap:10px; width:42px; flex:0 0 42px; }
.designer-brand-mark { display:grid; place-items:center; width:34px; height:34px; border:1px solid rgba(87,190,255,.48); border-radius:10px; color:#8ddcff; background:linear-gradient(145deg,rgba(45,159,232,.24),rgba(23,67,105,.22)); box-shadow:inset 0 1px rgba(255,255,255,.08),0 0 24px rgba(66,165,245,.12); font-weight:800; }
.designer-brand strong,.designer-brand small { display:block; white-space:nowrap; }.designer-brand strong{font-size:13px}.designer-brand small{margin-top:2px;color:#7891a8;font-size:10px;letter-spacing:.04em}
.designer-toolbar-group,.designer-toolbar-actions,.canvas-tools { display:flex; align-items:center; gap:5px; }
.designer-toolbar button,.designer-toolbar select { height:32px; padding:0 10px; border:1px solid rgba(126,178,219,.18); border-radius:8px; color:#cfe2f1; background:rgba(12,28,43,.72); font-size:12px; cursor:pointer; transition:.15s ease; }
.designer-toolbar button:hover:not(:disabled),.designer-toolbar button.active { color:#fff; border-color:rgba(84,188,255,.46); background:rgba(43,123,181,.28); }.designer-toolbar button:disabled{opacity:.34;cursor:not-allowed}.designer-toolbar .zoom-label{min-width:58px}.toolbar-divider{width:1px;height:20px;margin:0 3px;background:var(--line)}
.canvas-tools { margin-left:auto; }.designer-toolbar-actions{margin-left:2px}.designer-toolbar .save-button{border-color:rgba(73,187,145,.28);color:#8ce6bf}.designer-toolbar .publish-button{border-color:rgba(66,165,245,.48);color:#fff;background:linear-gradient(135deg,#237abe,#155b91)}.designer-toolbar .acceptance-button{border-color:rgba(255,196,95,.38);color:#ffd88c}.designer-toolbar .acceptance-button.passed{border-color:rgba(69,223,155,.38);color:#8ce6bf}
.toolbar-status{display:block;max-width:230px;overflow:hidden;padding:6px 9px;border:1px solid var(--line);border-radius:7px;color:#879bad;background:rgba(255,255,255,.04);font-size:9px;white-space:nowrap;text-overflow:ellipsis}.toolbar-status.success{color:#45c98f}.toolbar-status.warning{color:#ffc45f}.toolbar-status.danger{color:#ff6864}
.designer-main {
  --designer-left-width: 236px;
  --designer-right-width: 310px;
  --designer-left-track: var(--designer-left-width);
  --designer-right-track: var(--designer-right-width);
  flex: 1; min-width: 0; min-height: 0; display: grid;
  grid-template-columns: var(--designer-left-track) 28px minmax(0, 1fr) 28px var(--designer-right-track);
  overflow: hidden;
}
.designer-main.is-left-panel-collapsed { --designer-left-track: 0px; }
.designer-main.is-right-panel-collapsed { --designer-right-track: 0px; }
.designer-main > .designer-left-panel { grid-area: 1 / 1; min-width: 0; }
.designer-main > .designer-canvas { grid-area: 1 / 3; }
.designer-main > .designer-right-panel { grid-area: 1 / 5; min-width: 0; }
.designer-panel-toggle-rail {
  grid-row: 1; display: flex; align-items: center; justify-content: center;
  min-width: 0; background: var(--panel2); border-inline: 1px solid var(--line);
}
.designer-panel-toggle-rail.is-left { grid-column: 2; }
.designer-panel-toggle-rail.is-right { grid-column: 4; }
.designer-panel-toggle {
  display: flex; align-items: center; justify-content: center;
  width: 26px; min-height: 48px; padding: 9px 3px;
  border: 1px solid var(--line); border-radius: 7px; background: var(--panel); color: var(--text);
  box-shadow: 0 2px 6px rgba(0, 0, 0, .06); cursor: pointer; font: inherit;
}
.designer-panel-toggle:hover { border-color: #8e8e93; background: #ededf0; color: #1d1d1f; }
.designer-panel-toggle:focus-visible { outline: 2px solid #1570ef; outline-offset: -2px; }
.designer-panel-toggle svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.designer-panel-toggle.is-collapsed svg { transform: rotate(180deg); }
.designer-left-panel,.designer-right-panel { min-height:0; overflow:auto; background:linear-gradient(180deg,#0d1927,#0a1420); scrollbar-color:#29445e transparent; }.designer-left-panel{border-right:1px solid var(--line)}.designer-right-panel{border-left:1px solid var(--line)}
.designer-panel-heading,.selected-widget-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:54px; padding:10px 14px; border-bottom:1px solid var(--line); }.designer-panel-heading strong{font-size:13px}.designer-panel-heading small{color:var(--muted);font-size:10px}
.scene-preset-list{padding:9px 10px;border-bottom:1px solid var(--line)}.scene-preset-list>button{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:9px;align-items:center;width:100%;padding:10px;border:1px solid rgba(89,178,238,.24);border-radius:10px;color:#e8f5ff;background:linear-gradient(145deg,rgba(27,70,102,.66),rgba(13,32,49,.72));text-align:left;cursor:pointer;transition:.15s}.scene-preset-list>button:hover{border-color:rgba(91,196,255,.52);transform:translateY(-1px);box-shadow:0 8px 24px rgba(0,10,20,.18)}.scene-preset-list>button>span{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;color:#bceaff;background:rgba(80,179,239,.18);font-size:17px}.scene-preset-list strong,.scene-preset-list small{display:block}.scene-preset-list strong{font-size:11px}.scene-preset-list small{display:-webkit-box;margin-top:3px;overflow:hidden;color:#7f9bb1;font-size:8px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}.scene-preset-list em{padding:3px 6px;border-radius:99px;color:#8ed8ff;background:rgba(73,167,224,.14);font-size:8px;font-style:normal;white-space:nowrap}
.component-library{padding:10px}.component-library section+section{margin-top:13px}.component-library h4{margin:0 0 7px;color:#718aa1;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.component-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.component-grid button{display:grid;grid-template-columns:28px 1fr;grid-template-rows:auto auto;gap:1px 7px;align-items:center;min-height:56px;padding:8px;border:1px solid rgba(112,168,213,.15);border-radius:9px;text-align:left;color:#dbeaf6;background:rgba(20,38,56,.58);cursor:grab;transition:.15s}.component-grid button:hover{border-color:rgba(75,183,255,.48);transform:translateY(-1px);background:rgba(34,79,112,.46)}.component-grid button>span{grid-row:1/3;display:grid;place-items:center;width:28px;height:28px;border-radius:7px;color:#75cdfc;background:rgba(54,155,220,.14);font-weight:800}.component-grid strong{font-size:11px}.component-grid small{overflow:hidden;color:#6f879d;font-size:8px;white-space:nowrap;text-overflow:ellipsis}
.layer-heading{display:flex;justify-content:space-between;padding:10px 13px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);color:#a9c0d4;font-size:11px;cursor:pointer}.layer-heading span{color:#668198}.layer-list{padding:7px}.layer-list>button{display:grid;grid-template-columns:24px minmax(0,1fr) 20px 20px;align-items:center;width:100%;min-height:34px;padding:3px 6px;border:1px solid transparent;border-radius:7px;color:#b9cada;background:transparent;text-align:left;cursor:pointer}.layer-list>button:hover{background:rgba(50,88,119,.22)}.layer-list>button.active{border-color:rgba(66,165,245,.36);background:rgba(47,128,188,.24);color:#fff}.layer-list>button.hidden{opacity:.52}.layer-type{display:grid;place-items:center;width:20px;height:20px;border-radius:5px;color:#75cdfc;background:#142a3d;font-size:10px;font-weight:800}.layer-name{overflow:hidden;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.layer-list i{font-style:normal;color:#7891a7;text-align:center}.layer-list p{padding:8px;color:#60788e;font-size:10px;text-align:center}.system-widget-list{margin:7px;border:1px solid var(--line);border-radius:8px;color:#8da5b9;font-size:10px}.system-widget-list summary{padding:8px;cursor:pointer}.system-widget-list>.system-widget-card{border-top:1px solid var(--line)}.system-widget-list small{color:#5e758a}
.designer-canvas{position:relative;min-width:0;min-height:0;overflow:hidden;background:#050b12}.designer-canvas-scroll{position:absolute;inset:0;overflow:auto;padding:42px;scrollbar-color:#28445f #08111b;scrollbar-width:thin}.designer-canvas-spacer{position:relative;margin:auto}.designer-canvas-stage{position:absolute;left:0;top:0;overflow:hidden;transform-origin:0 0;box-shadow:0 0 0 1px rgba(110,185,235,.24),0 24px 90px rgba(0,0,0,.52);background-size:40px 40px!important}.designer-canvas-stage::before{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(118,174,216,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(118,174,216,.04) 1px,transparent 1px);background-size:var(--grid,10px) var(--grid,10px)}.canvas-safe-area{position:absolute;border:1px dashed rgba(83,194,255,.18);pointer-events:none}.alignment-guide{position:absolute;z-index:9998;background:#ff4dca;box-shadow:0 0 8px rgba(255,77,202,.65);pointer-events:none}.alignment-guide.vertical{top:0;bottom:0;width:1px}.alignment-guide.horizontal{left:0;right:0;height:1px}
.designer-widget{position:absolute;box-sizing:border-box;min-width:20px;min-height:20px;transform-origin:center;cursor:move;user-select:none}.designer-widget::after{content:"";position:absolute;inset:-2px;border:1px solid transparent;pointer-events:none}.designer-widget:hover::after{border-color:rgba(75,188,255,.34)}.designer-widget.selected::after{border:2px solid #43b9ff;box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 16px rgba(53,180,255,.26)}.designer-widget.locked{cursor:not-allowed}.designer-widget.hidden{filter:grayscale(.5)}.designer-widget.grouped.selected::after{border-style:dashed}.designer-widget :deep(.widget-shell){width:100%;height:100%}.widget-selection-label{position:absolute;left:-2px;bottom:calc(100% + 5px);max-width:100%;padding:3px 7px;border-radius:5px;color:#dff4ff;background:#1677ae;font-size:9px;white-space:nowrap;pointer-events:none}.resize-handle{position:absolute;z-index:10000;width:10px;height:10px;border:2px solid #dff6ff;border-radius:2px;background:#168dca;box-shadow:0 1px 4px rgba(0,0,0,.5)}.resize-handle.n{left:50%;top:-6px;cursor:ns-resize}.resize-handle.ne{right:-6px;top:-6px;cursor:nesw-resize}.resize-handle.e{right:-6px;top:50%;cursor:ew-resize}.resize-handle.se{right:-6px;bottom:-6px;cursor:nwse-resize}.resize-handle.s{left:50%;bottom:-6px;cursor:ns-resize}.resize-handle.sw{left:-6px;bottom:-6px;cursor:nesw-resize}.resize-handle.w{left:-6px;top:50%;cursor:ew-resize}.resize-handle.nw{left:-6px;top:-6px;cursor:nwse-resize}.empty-canvas-hint,.designer-loading{position:absolute;inset:0;display:grid;place-content:center;gap:8px;color:#718aa1;text-align:center}.empty-canvas-hint strong{color:#b9d4e8;font-size:24px}.empty-canvas-hint span{font-size:13px}.designer-loading{z-index:5;background:#07111b;font-size:13px}.designer-loading span{justify-self:center;width:28px;height:28px;border:3px solid rgba(91,181,240,.18);border-top-color:#57b8f0;border-radius:50%;animation:designerSpin .8s linear infinite}
.selected-widget-heading{align-items:flex-start}.selected-widget-heading div{min-width:0}.selected-widget-heading span,.selected-widget-heading strong,.selected-widget-heading small{display:block}.selected-widget-heading span{color:#6fbfec;font-size:9px;text-transform:uppercase}.selected-widget-heading strong{margin-top:2px;overflow:hidden;font-size:13px;white-space:nowrap;text-overflow:ellipsis}.selected-widget-heading small{margin-top:2px;color:#617b91;font-size:9px}.selected-widget-heading button{padding:5px 8px;border:1px solid var(--line);border-radius:6px;color:#99b3c8;background:#112235;font-size:9px;cursor:pointer}.inspector-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding:7px;border-bottom:1px solid var(--line)}.inspector-tabs button{height:28px;border:0;border-radius:6px;color:#7891a6;background:transparent;font-size:9px;cursor:pointer}.inspector-tabs button.active{color:#dff4ff;background:rgba(50,136,198,.28)}.inspector-body{padding:12px}.inspector-section{display:grid;gap:11px}.inspector-section label{display:grid;gap:5px;color:#8da4b8;font-size:10px}.inspector-section input,.inspector-section select,.inspector-section textarea{box-sizing:border-box;width:100%;min-height:32px;padding:6px 8px;border:1px solid rgba(119,170,210,.18);border-radius:7px;outline:none;color:#e5f1fa;background:#0c1b2a;font:11px/1.35 inherit}.inspector-section textarea{resize:vertical}.inspector-section input:focus,.inspector-section select:focus,.inspector-section textarea:focus{border-color:rgba(66,165,245,.62);box-shadow:0 0 0 2px rgba(66,165,245,.1)}.property-grid{display:grid;gap:8px}.property-grid.two{grid-template-columns:1fr 1fr}.layer-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}.layer-actions button,.section-action-heading button{height:29px;border:1px solid var(--line);border-radius:6px;color:#9fc3dc;background:#102235;font-size:9px;cursor:pointer}.readonly-banner{padding:9px;border:1px solid rgba(69,209,158,.22);border-radius:8px;color:#8fc5b2;background:rgba(40,136,101,.1);font-size:9px;line-height:1.5}.readonly-banner span{display:inline-flex;margin-right:5px;padding:1px 5px;border-radius:4px;color:#b9ffe4;background:rgba(51,197,144,.18);font-weight:700}.binding-summary{display:grid;grid-template-columns:44px minmax(0,1fr);gap:5px 8px;padding:9px;border:1px solid var(--line);border-radius:8px;background:rgba(8,19,30,.54);font-size:9px}.binding-summary span{color:#718aa0}.binding-summary code{overflow:hidden;color:#8bcff7;text-overflow:ellipsis}.binding-summary strong{color:#fff}.section-action-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.section-action-heading strong,.section-action-heading small{display:block}.section-action-heading strong{font-size:11px}.section-action-heading small{margin-top:2px;color:#698198;font-size:8px}.condition-card{display:grid;gap:8px;padding:9px;border:1px solid var(--line);border-radius:9px;background:rgba(17,34,51,.55)}.danger-link{justify-self:end;border:0!important;color:#ff8c89!important;background:transparent!important;font-size:9px;cursor:pointer}.empty-inspector{padding:20px 8px;color:#657e93;font-size:10px;line-height:1.6;text-align:center}
.designer-statusbar{flex:0 0 42px;display:flex;align-items:center;gap:18px;min-width:1180px;padding:0 13px;border-top:1px solid var(--line);color:#6f899f;background:#0b1622;font-size:9px}.designer-status{display:flex;align-items:center;min-width:300px;color:#8fa9bd}.designer-status i{width:6px;height:6px;margin-right:6px;border-radius:50%;background:#5f7b91}.designer-status.success i{background:#48d79a;box-shadow:0 0 10px rgba(72,215,154,.5)}.designer-status.warning i{background:#ffc45f}.designer-status.danger i{background:#ff6864}.designer-statusbar .dirty{color:#ffc66e}.release-strip{display:flex;align-items:center;gap:5px;margin-left:auto}.release-strip strong{margin-right:3px;color:#7d96aa}.release-strip button{display:flex;align-items:center;gap:5px;height:27px;padding:0 7px;border:1px solid var(--line);border-radius:6px;color:#9bb3c7;background:#102031;font-size:9px;cursor:pointer}.release-strip button.current{border-color:rgba(68,211,156,.28);color:#9ee8c9}.release-strip small{color:#617b90;font-size:7px}
.designer-dialog-backdrop{position:fixed;inset:0;z-index:12000;display:grid;place-items:center;padding:20px;background:rgba(3,9,15,.68);backdrop-filter:blur(6px)}.designer-dialog{display:grid;gap:12px;width:min(430px,calc(100vw - 40px));padding:22px;border:1px solid rgba(89,171,227,.28);border-radius:16px;color:#eaf5ff;background:linear-gradient(155deg,#14283a,#0c1825);box-shadow:0 26px 90px rgba(0,0,0,.52)}.designer-dialog.compact{width:min(370px,calc(100vw - 40px));text-align:center}.dialog-icon{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;color:#8bd8ff;background:rgba(66,165,245,.16);font-size:20px}.designer-dialog.compact .dialog-icon{justify-self:center}.designer-dialog h3,.designer-dialog p{margin:0}.designer-dialog h3{font-size:17px}.designer-dialog p{color:#8fa8bc;font-size:11px;line-height:1.6}.designer-dialog label{display:grid;gap:6px;color:#9bb2c5;font-size:10px;text-align:left}.designer-dialog input,.designer-dialog textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid rgba(112,172,216,.22);border-radius:8px;color:#eef8ff;background:#091522;outline:none}.designer-dialog textarea{resize:vertical}.designer-dialog>div:last-child{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}.designer-dialog button{min-width:76px;height:32px;border:1px solid var(--line);border-radius:8px;color:#acc3d5;background:#102235;cursor:pointer}.designer-dialog button.primary{border-color:#2c87c9;color:#fff;background:linear-gradient(135deg,#278bd1,#176298)}.designer-dialog-enter-active,.designer-dialog-leave-active{transition:.16s ease}.designer-dialog-enter-from,.designer-dialog-leave-to{opacity:0}.designer-dialog-enter-from .designer-dialog,.designer-dialog-leave-to .designer-dialog{transform:translateY(8px) scale(.98)}
.is-preview .designer-left-panel,.is-preview .designer-right-panel{opacity:.42;pointer-events:none}.is-preview .designer-widget{cursor:default}.is-preview .canvas-safe-area{display:none}
.widget-canvas-actions{position:absolute;z-index:10001;top:-32px;right:-2px;display:flex;align-items:center;gap:4px}.widget-canvas-actions button{display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid rgba(255,255,255,.48);border-radius:8px;color:#fff;background:rgba(15,28,42,.94);box-shadow:0 3px 10px rgba(0,0,0,.3);cursor:pointer;transition:transform .16s ease,border-color .16s ease,background .16s ease}.widget-canvas-actions button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.widget-canvas-actions button:hover:not(:disabled){border-color:#fff;background:#1d1d1f;transform:translateY(-1px)}.widget-canvas-actions button:disabled{opacity:.42;cursor:not-allowed}.widget-lock-toggle.locked{border-color:rgba(255,196,95,.78);color:#ffe0a3;background:rgba(92,61,14,.94)}.widget-delete-toggle{border-color:rgba(255,127,120,.54)!important;color:#ffaaa4!important}.widget-delete-toggle:hover:not(:disabled){border-color:#ff8f88!important;background:#762d2a!important;color:#fff!important}
@keyframes designerSpin{to{transform:rotate(360deg)}}
@media(max-width:1400px){.designer-main{--designer-left-width:210px;--designer-right-width:280px}.designer-brand{width:42px;flex-basis:42px}.designer-toolbar{gap:8px}.designer-toolbar button{padding:0 7px}}

/* 与后台管理统一的黑白简约工作台；画布本身仍保持实际发布主题。 */
.dashboard-designer-shell{--panel:#fff;--panel2:#f5f5f7;--line:#dedee3;--text:#1d1d1f;--muted:#6e6e73;--accent:#1d1d1f;height:clamp(820px,calc(100vh - 112px),1120px);min-height:820px;border-color:#d7d7dc;color:#1d1d1f;background:#f0f0f2;box-shadow:0 18px 48px rgba(0,0,0,.08);scrollbar-color:#b8b8bd #ececef;font-size:13px}
.designer-main{--designer-left-width:246px;--designer-right-width:330px}
.designer-toolbar{flex-basis:62px;border-bottom-color:#dedee3;background:rgba(255,255,255,.94);box-shadow:0 1px 0 rgba(0,0,0,.035);backdrop-filter:blur(18px)}
.designer-brand-mark{border-color:#1d1d1f;color:#fff;background:#1d1d1f;box-shadow:none}.designer-brand strong{color:#1d1d1f;font-size:14px}.designer-brand small{color:#8e8e93;font-size:11px}
.designer-toolbar button,.designer-toolbar select{border-color:#d8d8dd;color:#3a3a3c;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.035);font-size:13px}
.designer-toolbar button:hover:not(:disabled),.designer-toolbar button.active{color:#000;border-color:#8e8e93;background:#f2f2f4}.designer-toolbar .save-button{border-color:#b7d8c4;color:#176b3a;background:#f5fbf7}.designer-toolbar .publish-button{border-color:#1d1d1f;color:#fff;background:#1d1d1f}.toolbar-divider{background:#dedee3}
.designer-left-panel,.designer-right-panel{background:#fff;scrollbar-color:#c5c5ca transparent}.designer-left-panel{border-right-color:#dedee3}.designer-right-panel{border-left-color:#dedee3}
.designer-panel-heading,.layer-heading,.selected-widget-heading,.inspector-tabs{border-color:#e5e5e7;background:#fff}.designer-panel-heading strong,.layer-heading strong,.selected-widget-heading strong{color:#1d1d1f}.designer-panel-heading strong{font-size:14px}.designer-panel-heading small,.layer-heading span,.selected-widget-heading span,.selected-widget-heading small{color:#8e8e93;font-size:11px}
.scene-preset-list{border-bottom-color:#e5e5e7;background:#fff}.scene-preset-list>button{border-color:#d8d8dd;color:#1d1d1f;background:linear-gradient(145deg,#f7f9fb,#eef3f7)}.scene-preset-list>button:hover{border-color:#8e8e93;box-shadow:0 8px 22px rgba(0,0,0,.08)}.scene-preset-list>button>span{color:#fff;background:#1d1d1f}.scene-preset-list small{color:#8e8e93;font-size:9px}.scene-preset-list em{color:#176b3a;background:#e7f4ec;font-size:9px}
.component-library section h4{color:#8e8e93;font-size:11px}.component-grid button{min-height:62px;border-color:#e2e2e5;color:#1d1d1f;background:#f8f8fa}.component-grid button:hover{border-color:#8e8e93;background:#fff;box-shadow:0 7px 20px rgba(0,0,0,.07)}.component-grid button>span{color:#fff;background:#1d1d1f}.component-grid strong{font-size:12px}.component-grid button small{color:#8e8e93;font-size:10px}
.layer-heading{font-size:12px}.layer-list>button{min-height:38px}.layer-list button{color:#515154;background:transparent}.layer-list button:hover{background:#f5f5f7}.layer-list button.active{color:#1d1d1f;background:#ededf0;border-color:#d7d7dc}.layer-type{color:#fff;background:#3a3a3c;font-size:11px}.layer-name{font-size:12px}.layer-list i{color:#6e6e73}.system-widget-list{border-color:#e5e5e7;color:#515154;background:#f8f8fa;font-size:11px}.system-widget-list summary{color:#515154}.system-widget-list small{color:#8e8e93;font-size:10px}
.designer-canvas{background:#e9e9ec}.designer-canvas-scroll{box-sizing:border-box;width:100%;height:100%;overflow:auto;padding:12px 16px;overscroll-behavior:contain;scrollbar-color:#a9a9af #e1e1e4}.designer-canvas-spacer{position:relative;flex:0 0 auto;margin:0 auto;box-shadow:0 18px 46px rgba(0,0,0,.18)}.designer-canvas-stage{transform-origin:top left;border:1px solid rgba(0,0,0,.36)}
.selected-widget-heading strong{font-size:14px}.selected-widget-heading button,.layer-actions button,.section-action-heading button{border-color:#d8d8dd;color:#3a3a3c;background:#fff;font-size:11px}.inspector-tabs button{height:34px;color:#8e8e93;font-size:12px}.inspector-tabs button.active{color:#fff;background:#1d1d1f}
.dataset-card{overflow:hidden;border:1px solid #dedee3;border-radius:10px;background:#f8f8fa}.dataset-card summary{display:grid;grid-template-columns:9px minmax(0,1fr) auto;align-items:center;gap:7px;padding:10px;cursor:pointer;list-style:none}.dataset-card summary::-webkit-details-marker{display:none}.dataset-card summary i{width:8px;height:8px;border-radius:50%}.dataset-card summary strong{overflow:hidden;color:#1d1d1f;font-size:12px;white-space:nowrap;text-overflow:ellipsis}.dataset-card summary span{max-width:100px;overflow:hidden;color:#8e8e93;font-size:10px;white-space:nowrap;text-overflow:ellipsis}.dataset-card-body{display:grid;gap:10px;padding:10px;border-top:1px solid #e2e2e5;background:#fff}.dataset-context{display:grid;gap:8px;padding:9px;border:1px dashed #d8d8dd;border-radius:8px;background:#fafafa}.field-hint{display:block;color:#8e8e93;font-size:10px;line-height:1.45}.toolbar-status{border-color:#dedee3;color:#6e6e73;background:#f8f8fa;font-size:10px}.toolbar-status.success{color:#176b3a;background:#f3faf6}.toolbar-status.warning{color:#936112;background:#fff9ed}.toolbar-status.danger{color:#b42318;background:#fff5f4}
.inspector-body{background:#fff}.inspector-section label{color:#515154;font-size:12px}.inspector-section input,.inspector-section select,.inspector-section textarea{min-height:36px;border-color:#d8d8dd;color:#1d1d1f;background:#fff;font-size:13px}.inspector-section input:focus,.inspector-section select:focus,.inspector-section textarea:focus{border-color:#86868b;box-shadow:0 0 0 3px rgba(0,0,0,.06)}
.readonly-banner{border-color:#d8eadf;color:#176b3a;background:#f3faf6;font-size:11px}.readonly-banner span{color:#176b3a;background:#e1f3e8}.binding-summary{border-color:#e2e2e5;background:#f7f7f8;font-size:11px}.binding-summary span{color:#8e8e93}.binding-summary code{color:#1d1d1f}.binding-summary strong{color:#1d1d1f}.condition-card{border-color:#e2e2e5;background:#f8f8fa}.section-action-heading strong{color:#1d1d1f;font-size:12px}.section-action-heading small,.empty-inspector{color:#8e8e93;font-size:10px}.danger-link{color:#b42318!important;font-size:11px}
.visibility-mode-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.visibility-mode-option{display:flex!important;grid-auto-flow:column;align-items:center;justify-content:center;gap:5px!important;min-height:36px;border:1px solid #dedee3;border-radius:8px;background:#f8f8fa;cursor:pointer}.visibility-mode-option input{width:auto!important;min-height:auto!important;padding:0!important;accent-color:#1d1d1f}.visibility-hint{margin:-3px 0 3px;color:#8e8e93;font-size:11px;line-height:1.5}.visibility-bound-device{display:flex!important;grid-auto-flow:column;align-items:center;justify-content:start;gap:7px!important;padding:9px;border:1px solid #e2e2e5;border-radius:8px;background:#f8f8fa}.visibility-bound-device input{width:auto!important;min-height:auto!important;accent-color:#1d1d1f}.inspector-preview-button{height:36px;border:1px solid #1d1d1f;border-radius:8px;color:#fff;background:#1d1d1f;font-size:12px;cursor:pointer}
.view-id-grid{display:grid;gap:5px;padding:7px;border:1px solid #e2e2e5;border-radius:8px;background:#f8f8fa}.view-id-grid label{display:flex!important;flex-direction:row;align-items:center;gap:6px!important;color:#515154;font-size:11px!important}.view-id-grid input{width:auto!important;min-height:auto!important;accent-color:#1d1d1f}.view-id-grid span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.designer-statusbar{flex-basis:46px;border-top-color:#dedee3;color:#6e6e73;background:#fff;font-size:11px}.designer-status{color:#515154}.release-strip strong{color:#6e6e73}.release-strip button{border-color:#dedee3;color:#515154;background:#f8f8fa;font-size:11px}.release-strip button.current{border-color:#9bc9ad;color:#176b3a;background:#f3faf6}.release-strip small{font-size:9px}
.designer-dialog-backdrop{background:rgba(0,0,0,.34)}.designer-dialog{border-color:#dedee3;color:#1d1d1f;background:#fff;box-shadow:0 28px 90px rgba(0,0,0,.24)}.dialog-icon{color:#fff;background:#1d1d1f}.designer-dialog p,.designer-dialog label{color:#6e6e73}.designer-dialog input,.designer-dialog textarea{border-color:#d8d8dd;color:#1d1d1f;background:#fff}.designer-dialog button{border-color:#d8d8dd;color:#3a3a3c;background:#f7f7f8}.designer-dialog button.primary{border-color:#1d1d1f;color:#fff;background:#1d1d1f}
.designer-loading{color:#515154;background:#f2f2f4}.designer-loading span{border-color:#d0d0d5;border-top-color:#1d1d1f}
.is-preview .designer-left-panel,.is-preview .designer-right-panel{opacity:.56}
.view-panel-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 12px;border-bottom:1px solid var(--line);cursor:pointer}.view-panel-heading strong,.view-panel-heading small{display:block}.view-panel-heading strong{font-size:13px}.view-panel-heading small{margin-top:3px;color:var(--muted);font-size:10px}.view-panel-heading>span{color:var(--muted);font-size:10px}
.view-list{padding:7px;border-bottom:1px solid var(--line)}.view-list>button{display:grid;grid-template-columns:26px minmax(0,1fr) 14px;gap:7px;align-items:center;width:100%;padding:8px 7px;border:1px solid transparent;border-radius:8px;text-align:left;color:var(--text);background:transparent;cursor:pointer}.view-list>button:hover{background:var(--panel2)}.view-list>button.active{border-color:#cfcfd4;background:#f0f0f2}.view-list-icon{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;color:#fff;background:#1d1d1f;font-size:13px}.view-list strong,.view-list small{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.view-list strong{font-size:12px}.view-list small{margin-top:2px;color:var(--muted);font-size:9px}.view-list i{color:#2e9d5b;font-style:normal;font-size:10px}.view-list-actions{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px}.view-list-actions button,.view-inspector-actions button{height:30px;border:1px solid #d8d8dd;border-radius:7px;color:#3a3a3c;background:#fff;font-size:11px;cursor:pointer}.view-list-actions button:first-child,.view-inspector-actions button:first-child{color:#fff;border-color:#1d1d1f;background:#1d1d1f}.view-list-actions button:disabled,.view-inspector-actions button:disabled{opacity:.45;cursor:not-allowed}.view-inspector-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.view-inspector-actions button:last-child{color:#b42318}.view-component-list{display:grid;gap:6px;max-height:360px;overflow:auto}.view-component-list label{display:grid!important;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:6px!important;padding:8px;border:1px solid #e2e2e5;border-radius:8px;background:#f8f8fa;cursor:pointer}.view-component-list input{width:auto!important;min-height:auto!important;accent-color:#1d1d1f}.view-component-list span{overflow:hidden;color:#1d1d1f;white-space:nowrap;text-overflow:ellipsis}.view-component-list small{color:#8e8e93;font-size:10px}
.view-tree{display:grid;gap:2px}.view-tree-row{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);align-items:stretch;min-width:0}.view-tree-rail{position:relative;display:flex;justify-content:center}.view-tree-row.has-next .view-tree-rail::before{content:'';position:absolute;z-index:0;top:50%;bottom:-50%;left:50%;border-left:1px solid #c8c8ce}.view-tree-connector-arrow{position:absolute;z-index:2;top:100%;left:50%;color:#8e8e93;background:#fff;font-size:11px;line-height:1;transform:translate(-50%,-50%)}.view-tree-toggle{position:relative;z-index:3;align-self:center;display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid #d8d8dd;border-radius:50%;color:#6e6e73;background:#fff;font-size:12px;line-height:1;cursor:pointer}.view-tree-toggle:hover:not(:disabled){color:#1d1d1f;border-color:#8e8e93;background:#f0f0f2}.view-tree-toggle.empty{width:8px;height:8px;border:0;color:transparent;background:#1d1d1f;cursor:default}.view-tree-select{position:relative;display:grid;grid-template-columns:26px minmax(0,1fr) 14px;gap:7px;align-items:center;min-width:0;flex:1;padding:8px 7px;border:1px solid transparent;border-radius:8px;text-align:left;color:#1d1d1f;background:transparent;cursor:pointer}.view-tree-select:hover{background:#f0f0f2}.view-tree-select.active{border-color:#cfcfd4;background:#f0f0f2}.view-tree-select>span:nth-child(2){min-width:0}.view-tree-select strong{display:block;overflow:visible;white-space:normal;text-overflow:clip;word-break:break-word;line-height:1.25}.view-tree-select .view-list-icon{align-self:center}
.view-hidden-components{border:1px solid #e2e2e5;border-radius:8px;background:#fafafa}.view-hidden-components summary{padding:9px;color:#6e6e73;font-size:11px;cursor:pointer}.view-hidden-components .view-component-list{padding:0 7px 7px;max-height:220px}.view-hidden-components .view-component-list label{background:#f3f3f5}
.system-widget-card{display:grid!important;grid-template-columns:58px minmax(0,1fr);gap:9px;align-items:center;min-width:0;padding:8px!important}.system-widget-card>div:last-child{display:block;min-width:0;padding:0;border:0}.system-widget-card strong,.system-widget-card small,.system-widget-card em{display:block;max-width:100%}.system-widget-card strong{overflow:hidden;color:#1d1d1f;font-size:11px;white-space:nowrap;text-overflow:ellipsis}.system-widget-card small{display:-webkit-box;margin-top:2px;overflow:hidden;color:#8e8e93;font-size:9px;line-height:1.35;-webkit-box-orient:vertical;-webkit-line-clamp:2}.system-widget-card em{margin-top:3px;overflow:hidden;color:#6e6e73;font-size:8px;font-style:normal;white-space:nowrap;text-overflow:ellipsis}.system-widget-preview{position:relative;box-sizing:border-box;width:58px;height:42px;min-width:0;overflow:hidden;padding:0!important;border:1px solid #d8d8dd!important;border-radius:8px;background:linear-gradient(145deg,#2d2d31,#111113)}.system-widget-preview span{position:absolute;left:6px;top:5px;color:#fff;font-size:13px;font-weight:700}.system-widget-preview i,.system-widget-preview b{position:absolute;display:block;border-radius:4px;background:rgba(255,255,255,.8)}.system-widget-preview i{left:7px;right:7px;bottom:9px;height:4px}.system-widget-preview b{left:7px;bottom:18px;width:28px;height:6px;background:#777}.system-widget-preview.preview-label{background:linear-gradient(145deg,#203b4c,#11161a)}.system-widget-preview.preview-label i{left:27px;bottom:16px;width:21px;height:16px;border:1px solid #6fd1ff;background:rgba(79,166,215,.25)}.system-widget-preview.preview-label b{left:15px;bottom:8px;width:4px;height:9px;border-radius:50%;background:#54d3a0}.system-widget-preview.preview-diagnostics{background:#f0f0f2}.system-widget-preview.preview-diagnostics span{color:#1d1d1f}.system-widget-preview.preview-diagnostics i{left:7px;right:7px;bottom:10px;background:#49a86e}.system-widget-preview.preview-diagnostics b{left:7px;bottom:19px;width:34px;background:#999}.system-widget-preview.preview-line{background:linear-gradient(145deg,#38404a,#15171b)}.system-widget-preview.preview-line i{left:8px;right:8px;bottom:9px;height:14px;border:1px solid #888;background:transparent}.system-widget-preview.preview-line b{left:13px;bottom:14px;width:7px;height:7px;border-radius:50%;background:#65d69c}
.view-delete-button{height:30px;border:1px solid #e1b8b5;border-radius:7px;color:#b42318;background:#fff;font-size:11px;cursor:pointer}.view-delete-button:disabled{opacity:.45;cursor:not-allowed}
@media(max-width:1500px){.dashboard-designer-shell{min-height:780px}.designer-main{--designer-left-width:226px;--designer-right-width:310px}.external-data-source-list{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* Keep both edge handles reachable on smaller windows, even with long toolbars. */
.designer-toolbar, .designer-statusbar { box-sizing: border-box; min-width: 0; flex: 0 0 auto; flex-wrap: wrap; row-gap: 8px; }

/* The editing context is intentionally visible above the canvas: users pick
   a view and a preview device first, while the document keeps one reusable
   widget instead of one copy per physical device. */
.designer-canvas { display:flex; flex-direction:column; }
.designer-scope-bar { flex:0 0 auto; display:flex; align-items:center; gap:16px; min-height:58px; box-sizing:border-box; padding:8px 16px; border-bottom:1px solid #e5e5e7; background:#fff; }
.designer-scope-copy { display:grid; min-width:190px; gap:2px; }
.designer-scope-copy span { color:#8e8e93; font-size:10px; }
.designer-scope-copy strong { color:#1d1d1f; font-size:14px; }
.designer-scope-copy small { overflow:hidden; color:#6e6e73; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.designer-device-picker { display:grid!important; grid-template-columns:auto minmax(150px,220px); align-items:center; gap:8px!important; margin-left:auto; color:#515154!important; font-size:11px!important; white-space:nowrap; }
.designer-device-picker select { min-height:32px; padding:5px 8px; border:1px solid #d8d8dd; border-radius:7px; color:#1d1d1f; background:#fff; font:12px inherit; }
.designer-scope-hint { max-width:330px; color:#8e8e93; font-size:10px; line-height:1.4; }
.designer-scope-hint.is-public { margin-left:auto; max-width:420px; }
.layer-hidden-components { margin:4px 7px 7px; border:1px solid #e2e2e5; border-radius:8px; background:#fafafa; }
.layer-hidden-components summary { padding:8px; color:#6e6e73; font-size:10px; cursor:pointer; }
.layer-hidden-components button { display:grid; grid-template-columns:24px minmax(0,1fr) 20px; align-items:center; width:100%; min-height:32px; padding:3px 6px; border:0; border-top:1px solid #ededee; color:#6e6e73; background:transparent; text-align:left; cursor:pointer; }
.layer-hidden-components button:hover { background:#f0f0f2; }
.layer-hidden-components button i { color:#176b3a; font-style:normal; text-align:center; }
.designer-canvas > .designer-canvas-scroll { position:relative; inset:auto; flex:1; min-height:0; height:auto; }
@media(max-width:1100px) { .designer-scope-bar { gap:9px; padding-inline:10px; } .designer-scope-hint { display:none; } .designer-device-picker { grid-template-columns:1fr; gap:3px!important; } }
.designer-toolbar { min-height: 62px; padding-block: 10px; }
.designer-toolbar-actions { flex-wrap: wrap; }

.fullscreen-button{display:grid!important;place-items:center;width:34px;padding:0!important}.fullscreen-button svg,.fullscreen-exit-button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.fullscreen-button.active{color:#fff!important;border-color:#1d1d1f!important;background:#1d1d1f!important}
.fullscreen-exit-button{position:fixed;z-index:13000;top:18px;right:18px;display:grid;place-items:center;width:38px;height:38px;padding:0;border:1px solid rgba(255,255,255,.6);border-radius:10px;color:#fff;background:rgba(15,23,31,.78);box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;backdrop-filter:blur(12px)}.fullscreen-exit-button:hover{background:rgba(29,29,31,.94);transform:translateY(-1px)}
.dashboard-designer-shell.is-fullscreen{width:100vw;height:100vh;min-height:100vh;border:0;border-radius:0;overflow:hidden;background:#e9e9ec}.dashboard-designer-shell.is-fullscreen .designer-toolbar,.dashboard-designer-shell.is-fullscreen .designer-left-panel,.dashboard-designer-shell.is-fullscreen .designer-right-panel,.dashboard-designer-shell.is-fullscreen .designer-panel-toggle-rail,.dashboard-designer-shell.is-fullscreen .designer-statusbar{display:none}.dashboard-designer-shell.is-fullscreen .designer-main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}.dashboard-designer-shell.is-fullscreen .designer-main>.designer-canvas{grid-area:1 / 1}.dashboard-designer-shell.is-fullscreen .designer-canvas-scroll{padding:0;display:grid;place-items:center}.dashboard-designer-shell.is-fullscreen .designer-canvas-spacer{margin:auto}.dashboard-designer-shell.is-fullscreen .designer-canvas-stage{box-shadow:none}
.dashboard-designer-shell.is-fullscreen .designer-canvas-stage::before{display:none}.dashboard-designer-shell.is-fullscreen .designer-canvas-stage{background:radial-gradient(ellipse at 52% 44%,#333c57 0%,#1c2439 42%,#101624 80%)!important}
.designer-statusbar { min-height: 42px; padding-block: 8px; }
.designer-status { min-width: 0; }

.designer-toolbar .designer-icon-button{display:grid;place-items:center;width:34px;padding:0}
.designer-toolbar .designer-icon-button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;transition:transform .16s ease}
.designer-toolbar .designer-icon-button:hover:not(:disabled) svg{transform:scale(1.08)}

/* The scroll viewport owns the free space. Auto margins center the canvas
   when it fits, while overflowing canvases still start at the scroll origin. */
.designer-canvas-scroll { display:flex; align-items:flex-start; justify-content:flex-start; }
.designer-canvas-scroll > .designer-canvas-spacer { margin:auto; }

/* Layer rows expose the same two identifiers users see in the inspector:
   the component title and its text/value/binding preview. */
.layer-list > button { min-height:48px; }
.layer-copy { display:grid; min-width:0; gap:2px; }
.layer-copy .layer-name { display:block; overflow:hidden; font-size:11px; line-height:1.25; text-overflow:ellipsis; white-space:nowrap; }
.layer-copy .layer-value { display:block; overflow:hidden; color:#8e8e93; font-size:10px; line-height:1.25; text-overflow:ellipsis; white-space:nowrap; }
.layer-hidden-components button { min-height:44px; }

/* Context actions stay beside the selection, but live in the stage's top
   layer instead of inside each widget's stacking context. Nearby widgets can
   no longer cover the delete/lock controls. */
.designer-selection-box { position:absolute; z-index:11000; box-sizing:border-box; border:1px solid #1570ef; border-radius:3px; background:rgba(21,112,239,.12); pointer-events:none; }
.selection-context-actions { position:absolute; z-index:2147483000; display:flex; align-items:center; gap:4px; min-height:36px; padding:3px; box-sizing:border-box; border:1px solid rgba(255,255,255,.56); border-radius:9px; color:#fff; background:rgba(15,28,42,.96); box-shadow:0 5px 16px rgba(0,0,0,.32); pointer-events:auto; }
.selection-context-actions button { display:grid; place-items:center; width:28px; height:28px; padding:0; border:1px solid rgba(255,255,255,.48); border-radius:8px; color:#fff; background:rgba(15,28,42,.94); cursor:pointer; transition:transform .16s ease,border-color .16s ease,background .16s ease; }
.selection-context-actions button svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.selection-context-actions button:hover:not(:disabled) { border-color:#fff; background:#1d1d1f; transform:translateY(-1px); }
.selection-context-actions button:disabled { opacity:.42; cursor:not-allowed; }
.selection-context-actions .selection-context-count { display:grid; place-items:center; min-width:32px; height:28px; padding:0 3px; color:#dff4ff; font-size:10px; font-weight:700; white-space:nowrap; }
.selection-context-actions .widget-lock-toggle.locked { border-color:rgba(255,196,95,.78); color:#ffe0a3; background:rgba(92,61,14,.94); }
.selection-context-actions .widget-delete-toggle { border-color:rgba(255,127,120,.54); color:#ffaaa4; }
.selection-context-actions .widget-delete-toggle:hover:not(:disabled) { border-color:#ff8f88; background:#762d2a; color:#fff; }

.panel-opacity-setting {
  gap: 7px !important;
  padding: 9px 10px;
  border: 1px solid rgba(89, 178, 238, .18);
  border-radius: 8px;
  background: rgba(8, 19, 30, .28);
}
.panel-opacity-setting > span {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.panel-opacity-setting > span b {
  margin-left: auto;
  color: #1d1d1f;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.panel-opacity-setting > span small {
  color: #2e9d5b;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}
.panel-opacity-setting input[type="range"] {
  min-height: 18px;
  padding: 0;
  border: 0;
  accent-color: #1d1d1f;
  background: transparent;
}
.panel-opacity-setting .field-hint {
  margin: 0;
}
</style>
