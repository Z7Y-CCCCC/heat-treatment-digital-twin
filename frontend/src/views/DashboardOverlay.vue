<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useFactoryConfig } from '../config/factoryConfig.js'
import { createDashboardDataStore } from '../runtime/DataStore.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { createVoiceAnnouncer } from '../runtime/VoiceAnnouncer.js'
import { resolveBackendAssetUrl } from '../three/ModelFactory.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'
import { applyReferenceHudLayout } from '../runtime/referenceHudLayout.js'
import { fitHudCanvas } from '../runtime/hudPresentation.js'
import { applyVisibilityAction, widgetRuntimeVisible } from '../runtime/dashboardRules.js'

const rootRef = ref(null)
let overlayDisposed = false
const overlayRequests = new AbortController()
const voiceAnnouncer = createVoiceAnnouncer()
let previousDocumentBackground = ''
let previousBodyBackground = ''
let databaseRequestSeq = 0
let businessRequestSeq = 0
let databaseInFlight = false
let businessInFlight = false
const selectedWidgetId = ref('')
const hostConnected = ref(false)
const standalonePreview = ref(false)
const overlayViewport = reactive({ width: 1920, height: 1080 })
const parentReturnBusy = ref(false)
const childNavigationEntered = ref(false)
const inspectionCommandError = ref('')
let inspectionProgressTimer = null
let pendingInspectionProgress = null
const databaseValues = reactive({})
const businessData = reactive({
    status: 'idle',
    readOnly: true,
    source: { connectionId: '' },
    fetchedAt: null,
    sections: {}
})
const runtimeContext = reactive({
    viewId: 'factory_overview', viewMode: 'factory', sceneReady: false, sceneId: '', workshopId: '', lineId: '', deviceId: '',
    inspectionStage: '', partId: '', partName: '', partDescription: '', partPointIds: [], partPointKeys: [], partDetailViewId: '',
    inspectionEnabled: false, inspectionProgress: 0, inspectionAnimating: false, inspectionPhase: '', inspectionIsolated: false,
    inspectionLabelsEnabled: false, inspectionLeaderLines: false, inspectionHoveredPartId: '', inspectionIssues: [], inspectionParts: []
})
const groupVisibility = reactive({})
const widgetVisibility = reactive({})

const dataStore = createDashboardDataStore({
    metricsRefreshIntervalMs: 5000,
    eventsRefreshIntervalMs: 5000,
    trendUpdateIntervalMs: 3000
})

const {
    config,
    loadConfig,
    getPlatform,
    getWorkshops
} = useFactoryConfig()

const modelLoadErrors = ref([])
let modelProbeTimer = 0
let modelProbeGeneration = 0

function configuredModelDevices() {
    return (getWorkshops() || []).flatMap(workshop => (workshop.lines || []).flatMap(line =>
        (line.devices || []).map(device => ({
            ...device,
            lineName: line.name || line.id || '',
            workshopName: workshop.name || workshop.id || ''
        }))
    ))
}

async function probeConfiguredModels() {
    if (overlayDisposed) return
    const generation = ++modelProbeGeneration
    const devices = configuredModelDevices()
    const models = Array.isArray(config.models) ? config.models : []
    const groups = new Map()

    for (const device of devices) {
        const modelType = String(device.model_type || '').trim()
        if (!modelType || modelType === 'builtin_furnace' || modelType === 'transfer_cart') continue
        const model = models.find(item => String(item.id) === modelType)
        const key = modelType || `missing:${device.id}`
        if (!groups.has(key)) groups.set(key, { modelType, model, devices: [] })
        groups.get(key).devices.push(device)
    }

    const checked = await Promise.all([...groups.values()].map(async group => {
        if (!group.model) {
            return { group, reason: `未找到模型资产：${group.modelType}`, url: '' }
        }
        if (!group.model.file_path) {
            return { group, reason: `模型资产未配置文件：${group.model.id}`, url: '' }
        }

        const url = resolveBackendAssetUrl(group.model.file_path)
        try {
            const response = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: overlayRequests.signal })
            if (!response.ok) return { group, reason: `HTTP ${response.status} ${response.statusText || '请求失败'}`, url }
            return null
        } catch (error) {
            return { group, reason: error?.message || '模型文件请求失败', url }
        }
    }))

    if (overlayDisposed || generation !== modelProbeGeneration) return
    modelLoadErrors.value = checked
        .filter(Boolean)
        .flatMap(item => item.group.devices.map(device => ({
            deviceId: String(device.id || ''),
            deviceName: device.name || device.id || '未命名设备',
            modelName: item.group.model?.name || item.group.modelType,
            reason: item.reason,
            url: item.url
        })))
        .slice(0, 12)
}

const CONFIG_ONLY_WIDGET_TYPES = new Set([
    'device_label',
    'diagnostics',
    'line_overview_cards',
    'navigation',
    'return_button'
])

const platform = computed(() => getPlatform() || {})
const presentationDocument = computed(() => applyReferenceHudLayout(platform.value.document))
const dashboardViews = computed(() => {
    const views = presentationDocument.value?.scene?.views || platform.value.activeScene?.views || []
    return Array.isArray(views) && views.length
        ? views
        : [{ id: 'factory_overview', name: '全厂总览', mode: 'factory', targetType: 'factory', returnViewId: '' }]
})
const currentView = computed(() => dashboardViews.value.find(view => view.id === runtimeContext.viewId)
    || dashboardViews.value.find(view => view.mode === runtimeContext.viewMode)
    || dashboardViews.value[0])
const defaultViewId = computed(() => presentationDocument.value?.scene?.defaultViewId
    || platform.value.activeScene?.defaultViewId
    || 'factory_overview')
const canNavigateToParentView = computed(() => {
    const targetType = String(currentView.value?.targetType || '').toLowerCase()
    const mode = String(runtimeContext.viewMode || currentView.value?.mode || targetType || 'factory').toLowerCase()
    const isDeviceView = mode === 'device' || targetType === 'device' || targetType === 'device_part'
        || ['xray', 'exploded', 'part'].includes(String(runtimeContext.inspectionStage || '').toLowerCase())
    // The native host can publish the inspection context a few frames after
    // entering a part view. A known device/inspection view is still safely
    // returnable during that hand-off.
    if (runtimeContext.sceneReady === false && !isDeviceView) return false
    if (!isDeviceView && (mode === 'factory' || runtimeContext.viewId === defaultViewId.value)) return false
    if (isDeviceView && runtimeContext.inspectionStage && runtimeContext.inspectionStage !== 'solid') return true
    if (isDeviceView && targetType === 'device_part') return true
    if (!currentView.value?.returnViewId && !currentView.value?.parentViewId) {
        // Older/custom documents may not have a return edge. Keep the
        // standard hierarchy available as a safe runtime fallback.
        return isDeviceView || ['line', 'workshop'].includes(mode)
    }
    if (isDeviceView) return Boolean(runtimeContext.deviceId || currentView.value?.targetId || runtimeContext.partId)
    if (mode === 'line') return Boolean(runtimeContext.lineId || currentView.value?.targetId)
    if (mode === 'workshop') return Boolean(runtimeContext.workshopId || currentView.value?.targetId)
    return true
})
// The return control must follow the actual navigation context. Depending on
// a transient "this WebView saw the click" flag made it disappear when Unity
// entered a deep view first or delivered its context update a frame later.
const canReturnToParentView = computed(() => canNavigateToParentView.value)

function parentViewIdForCurrent() {
    const configured = currentView.value?.returnViewId || currentView.value?.parentViewId
    if (configured) return configured
    const targetType = String(currentView.value?.targetType || '').toLowerCase()
    const mode = String(runtimeContext.viewMode || currentView.value?.mode || targetType || '').toLowerCase()
    if (targetType === 'device_part') return 'device_exploded'
    if (mode === 'device' || targetType === 'device') return 'line_overview'
    if (mode === 'line') return 'workshop_overview'
    if (mode === 'workshop') return 'factory_overview'
    return ''
}

function runtimeContextIsRoot() {
    const configuredMode = dashboardViews.value.find(view => view.id === runtimeContext.viewId)?.mode
    const mode = String(runtimeContext.viewMode || configuredMode || 'factory').toLowerCase()
    return mode === 'factory' || runtimeContext.viewId === defaultViewId.value
}

function applyRuntimeContext(payload, { userNavigation = false } = {}) {
    if (overlayDisposed) return
    if (!payload || typeof payload !== 'object') return
    const previousDataContext = [runtimeContext.viewId, runtimeContext.workshopId, runtimeContext.lineId, runtimeContext.deviceId, runtimeContext.partId].join('|')
    Object.assign(runtimeContext, payload)
    nextTick(scheduleRegionReport)
    if (!Object.prototype.hasOwnProperty.call(payload, 'sceneReady')) runtimeContext.sceneReady = true
    const nextDataContext = [runtimeContext.viewId, runtimeContext.workshopId, runtimeContext.lineId, runtimeContext.deviceId, runtimeContext.partId].join('|')
    if (previousDataContext !== nextDataContext) {
        refreshDatabaseValues(true)
        refreshBusinessData(true)
    }

    if (runtimeContextIsRoot()) {
        childNavigationEntered.value = false
        return
    }

    // 启动时后端可能短暂重放上次的下级视角。只有本次会话中用户
    // 主动点击了导航组件才显示返回键，历史上下文不能触发它。
    if (userNavigation && runtimeContext.sceneReady !== false) {
        childNavigationEntered.value = true
    }
}
const parentViewName = computed(() => {
    if (runtimeContext.inspectionStage === 'part') return '设备拆解视角'
    if (runtimeContext.inspectionStage === 'exploded') return '设备透视视角'
    if (runtimeContext.inspectionStage === 'xray') return '设备实体视角'
    const parentId = parentViewIdForCurrent()
    return dashboardViews.value.find(view => view.id === parentId)?.name || '上一级视角'
})
function viewComponentVisible(type, id = `widget_${type}`) {
    const state = currentView.value?.componentState || {}
    const candidates = [id, type, `system:${type}`].filter(Boolean)
    if (candidates.some(candidate => state.hide?.includes(candidate))) return false
    if (state.show?.length && !candidates.some(candidate => state.show.includes(candidate))) return false
    return true
}
const dashboardCanvas = computed(() => presentationDocument.value?.canvas || platform.value.canvas || {
    width: 1920,
    height: 1080,
    legacyGrid: { columns: 24, rows: 12 }
})
const grid = computed(() => ({
    columns: Math.max(1, Number(platform.value.activeScene?.layout?.grid?.columns) || 24),
    rows: Math.max(1, Number(platform.value.activeScene?.layout?.grid?.rows) || 12)
}))
const allConfiguredWidgets = computed(() => {
    const configured = Array.isArray(presentationDocument.value?.widgets)
        ? presentationDocument.value.widgets
        : (Array.isArray(platform.value.widgets) ? platform.value.widgets : [])
    return configured
        .filter(widget => !CONFIG_ONLY_WIDGET_TYPES.has(widget.type || widget.widget_type))
        .sort((left, right) => Number(left.zIndex ?? left.sort_order ?? 0) - Number(right.zIndex ?? right.sort_order ?? 0))
})
const navigationWidget = computed(() => {
    const configured = Array.isArray(presentationDocument.value?.widgets)
        ? presentationDocument.value.widgets
        : (Array.isArray(platform.value.widgets) ? platform.value.widgets : [])
    return configured.find(widget => (widget.type || widget.widget_type) === 'navigation') || null
})
const returnButtonWidget = computed(() => {
    const configured = Array.isArray(presentationDocument.value?.widgets)
        ? presentationDocument.value.widgets
        : (Array.isArray(platform.value.widgets) ? platform.value.widgets : [])
    return configured.find(widget => (widget.type || widget.widget_type) === 'return_button') || null
})
const navigationEnabled = computed(() => {
    const widget = navigationWidget.value
    if (widget && (widget.visible === false || widget.visible === 0)) return false
    return viewComponentVisible('navigation', widget?.id || 'widget_navigation')
})
const returnButtonEnabled = computed(() => {
    const widget = returnButtonWidget.value
    if (widget && (widget.visible === false || widget.visible === 0)) return false
    return viewComponentVisible('return_button', widget?.id || 'widget_return_button')
})
const navigationStyle = computed(() => {
    const widget = navigationWidget.value
    if (widget?.frame) return widgetStyle(widget)
    // Keep the legacy runtime position until a document containing the
    // navigation component has been normalized by the designer/backend.
    return { left: '34.38%', top: '1.67%', width: '31.25%', height: '3.89%' }
})
const returnButtonStyle = computed(() => {
    const widget = returnButtonWidget.value
    if (widget?.frame) return widgetStyle(widget)
    return { left: '1.04%', top: '1.67%', width: '2.19%', height: '3.89%' }
})
const configuredWidgets = computed(() => allConfiguredWidgets.value
    .filter(widget => widget.visible !== 0 && widget.visible !== false)
    .filter(widget => widget.runtimeTarget !== 'unity'))
const widgets = computed(() => {
    return configuredWidgets.value.filter(widget => {
    const state = currentView.value?.componentState || {}
    const groupId = widget.groupId ? `group:${widget.groupId}` : ''
    if (state.hide?.includes(widget.id) || (groupId && state.hide?.includes(groupId))) return false
    if (state.show?.length && !state.show.includes(widget.id) && (!groupId || !state.show.includes(groupId))) return false
    return true
    }).filter(widget => widgetRuntimeVisible(widget, {
    context: runtimeContext,
    dataValue: runtimeValueForWidget(widget),
    dataRecord: widget.data?.mode === 'database' ? databaseValues[widget.id] : null,
    groupVisibility,
    widgetVisibility
    }))
})
const businessWidgets = computed(() => configuredWidgets.value.filter(widget => {
    const type = widget.type || widget.widget_type
    return type === 'business_summary' || widget.data?.mode === 'business'
}))

function getByPath(source, path) {
    if (!path) return undefined
    return String(path).split('.').reduce((current, key) => current?.[key], source)
}

const pointValues = computed(() => {
    const result = {}
    for (const workshop of getWorkshops() || []) {
        for (const line of workshop.lines || []) {
            for (const device of line.devices || []) {
                const frame = dataStore.deviceDataMap[device.id] || {}
                for (const point of device.dataPoints || []) {
                    const category = point.category || 'analog'
                    const field = point.value_role || point.name
                    const value = getByPath(frame, `${category}.${field}`)
                    const quality = getByPath(frame, `quality.${category}.${field}`) || dataStore.deviceStatusMap[device.id]?.quality || 'bad'
                    const record = { ...point, value, quality, device_id: device.id }
                    result[String(point.id)] = record
                    result[`${device.id}:${point.id}`] = record
                }
            }
        }
    }
    return result
})

function pointForContextKey(deviceId, key) {
    const value = String(key || '').trim()
    if (!value) return null
    const separator = value.indexOf('.')
    const category = separator > 0 ? value.slice(0, separator) : ''
    const field = separator > 0 ? value.slice(separator + 1) : value
    for (const workshop of getWorkshops() || []) {
        for (const line of workshop.lines || []) {
            const device = (line.devices || []).find(item => String(item.id) === String(deviceId))
            if (!device) continue
            const point = (device.dataPoints || []).find(item => {
                const pointCategory = String(item.category || item.category_resolved || 'analog')
                const pointField = String(item.value_role || item.name || '')
                return (!category || pointCategory === category) && pointField === field
            })
            if (point) return pointValues.value[`${deviceId}:${point.id}`] || null
        }
    }
    return null
}

const selectedPart = computed(() => {
    const deviceId = String(runtimeContext.deviceId || '')
    const pointIds = Array.isArray(runtimeContext.partPointIds) ? runtimeContext.partPointIds : []
    const pointKeys = Array.isArray(runtimeContext.partPointKeys) ? runtimeContext.partPointKeys : []
    const resolvedPoints = [
        ...pointIds.map(id => pointValues.value[`${deviceId}:${id}`] || pointValues.value[String(id)]).filter(Boolean),
        ...pointKeys.map(key => pointForContextKey(deviceId, key)).filter(Boolean)
    ]
    const points = [...new Map(resolvedPoints.map((point, index) => [String(point.id || `${point.category || ''}.${point.value_role || point.name || index}`), point])).values()]
    const pointMap = Object.fromEntries(points.map((point, index) => [String(point.id || index), point]))
    return {
        id: runtimeContext.partId || '',
        name: runtimeContext.partName || '',
        description: runtimeContext.partDescription || '',
        points,
        pointMap,
        stage: runtimeContext.inspectionStage || ''
    }
})

async function sendInspectionCommand(inspection) {
    if (overlayDisposed || !runtimeContext.deviceId) return
    inspectionCommandError.value = ''
    try {
        const response = await fetch(`${API_BASE}/native-preview/navigate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: overlayRequests.signal,
            body: JSON.stringify({ action: 'inspection', focus: { mode: 'device', deviceId: runtimeContext.deviceId }, inspection })
        })
        const result = await response.json()
        if (!response.ok || !result.success || !result.sent) throw new Error(result.error || 'Unity 运行端未连接，操作未执行')
    } catch (error) { if (!overlayDisposed && error.name !== 'AbortError') inspectionCommandError.value = error.message }
}

function handleInspectionCommand(command) {
    if (command.command !== 'progress') {
        clearTimeout(inspectionProgressTimer)
        inspectionProgressTimer = null
        pendingInspectionProgress = null
        return sendInspectionCommand(command)
    }
    pendingInspectionProgress = command
    if (inspectionProgressTimer) return
    inspectionProgressTimer = setTimeout(() => {
        inspectionProgressTimer = null
        const next = pendingInspectionProgress
        pendingInspectionProgress = null
        if (next) sendInspectionCommand(next)
    }, 60)
}

function runtimeValueForWidget(widget) {
    const binding = widget?.data || widget?.binding || {}
    if (binding.mode === 'database') return databaseValues[widget.id]?.value
    if (binding.mode === 'plc' || binding.pointId || binding.point_id) {
        const pointId = String(binding.pointId || binding.point_id || '')
        const isCurrentDevice = binding.deviceScope === 'current'
        const deviceId = String(isCurrentDevice ? runtimeContext.deviceId : (binding.deviceId || binding.device_id || ''))
        if (isCurrentDevice && !deviceId) return undefined
        if (isCurrentDevice && deviceId) {
            const semanticPoint = pointForContextKey(deviceId, binding.pointKey || binding.path)
            if (semanticPoint) return semanticPoint.value
            // Never fall back to the unqualified point id for a current-device
            // binding: ids may belong to another device and would show stale
            // data in the wrong equipment view.
            return pointValues.value[`${deviceId}:${pointId}`]?.value
        }
        return pointValues.value[`${deviceId}:${pointId}`]?.value ?? pointValues.value[pointId]?.value
    }
    if (binding.mode === 'runtime') {
        const context = {
            metrics: dataStore.metrics,
            events: dataStore.events.value,
            trendPoints: dataStore.trendPoints.value,
            deviceStatusMap: dataStore.deviceStatusMap,
            deviceDataMap: dataStore.deviceDataMap,
            context: runtimeContext,
            selectedPart: selectedPart.value
        }
        return getByPath(context, binding.path || binding.source)
    }
    return widget?.content?.value
}

const projectName = computed(() => platform.value.activeProject?.name || '热处理数字孪生')
const sceneName = computed(() => platform.value.activeScene?.name || '工厂总览')
const navigationProjectLabel = computed(() => navigationWidget.value?.content?.projectLabel || `${projectName.value} · ${sceneName.value}`)
const navigationStatusText = computed(() => navigationWidget.value?.content?.statusText || dataStore.plcStatusText.value)

let resizeObserver = null
let mutationObserver = null
let regionFrame = 0
let regionMotionUntil = 0
let refreshTimer = 0
let selectionTimer = 0
let lastRegionSignature = ''

function postHostMessage(message) {
    if (overlayDisposed || !window.chrome?.webview) return
    window.chrome.webview.postMessage(message)
}

function widgetStyle(widget) {
    if (widget.frame) {
        const canvasWidth = Math.max(1, Number(dashboardCanvas.value.width) || 1920)
        const canvasHeight = Math.max(1, Number(dashboardCanvas.value.height) || 1080)
        return {
            left: `${Number(widget.frame.x || 0) / canvasWidth * 100}%`,
            top: `${Number(widget.frame.y || 0) / canvasHeight * 100}%`,
            width: `${Number(widget.frame.width || 320) / canvasWidth * 100}%`,
            height: `${Number(widget.frame.height || 180) / canvasHeight * 100}%`,
            zIndex: Number(widget.zIndex || 0),
            '--overlay-text-scale': Math.min(.48, (Number(widget.style?.fontSize) || 18) / Math.max(1, Number(widget.frame.height) || 40)),
            transform: `rotate(${Number(widget.frame.rotation || 0)}deg)`
        }
    }
    const columns = grid.value.columns
    const rows = grid.value.rows
    const x = Math.max(0, Math.min(columns, Number(widget.x) || 0))
    const y = Math.max(0, Math.min(rows, Number(widget.y) || 0))
    const width = Math.max(1, Math.min(columns - x || 1, Number(widget.w) || 4))
    const height = Math.max(1, Math.min(rows - y || 1, Number(widget.h) || 2))
    return {
        left: `${x / columns * 100}%`,
        top: `${y / rows * 100}%`,
        width: `${width / columns * 100}%`,
        height: `${height / rows * 100}%`
    }
}

function scheduleRegionReport() {
    if (overlayDisposed || regionFrame) return
    if (rootRef.value) {
        overlayViewport.width = rootRef.value.clientWidth || 1920
        overlayViewport.height = rootRef.value.clientHeight || 1080
    }
    regionFrame = window.requestAnimationFrame(() => {
        regionFrame = 0
        reportInteractionRegions()
        if (performance.now() < regionMotionUntil) scheduleRegionReport()
    })
}

function trackHoverMotion() {
    // ResizeObserver cannot see transforms. Track the complete 220ms
    // transition (including leave/re-entry) and one settled frame.
    regionMotionUntil = performance.now() + 280
    scheduleRegionReport()
}

function reportInteractionRegions() {
    const root = rootRef.value
    if (!root) return
    const regions = [...root.querySelectorAll('[data-overlay-hit="true"]')]
        .map(element => {
            const style = window.getComputedStyle(element)
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) return null
            // The outer slot intentionally keeps a small layout gutter. Only
            // the rendered shell needs a native hit-test region; including the
            // gutter makes transparent WebView2 margins visible on scaled
            // displays.
            const target = element.querySelector('.widget-shell') || element
            const targetStyle = window.getComputedStyle(target)
            const rect = target.getBoundingClientRect()
            if (rect.width < 1 || rect.height < 1) return null
            return {
                // Preserve subpixel edges until the host converts to pixels.
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
                radius: Math.max(
                    Number.parseFloat(targetStyle.borderTopLeftRadius) || 0,
                    Number.parseFloat(targetStyle.borderTopRightRadius) || 0,
                    Number.parseFloat(targetStyle.borderBottomRightRadius) || 0,
                    Number.parseFloat(targetStyle.borderBottomLeftRadius) || 0
                )
            }
        })
        .filter(Boolean)

    const viewport = {
        width: Math.max(1, window.innerWidth),
        height: Math.max(1, window.innerHeight),
        devicePixelRatio: window.devicePixelRatio || 1
    }
    const signature = JSON.stringify({ viewport, regions })
    if (signature === lastRegionSignature) return
    lastRegionSignature = signature

    postHostMessage({
        type: 'overlay_regions',
        viewport,
        regions
    })
}

function selectWidget(widgetId) {
    selectedWidgetId.value = widgetId
    window.clearTimeout(selectionTimer)
    selectionTimer = window.setTimeout(() => {
        selectedWidgetId.value = ''
        scheduleRegionReport()
    }, 900)
}

function registerConfiguredDevices() {
    for (const workshop of getWorkshops() || []) {
        for (const line of workshop.lines || []) {
            for (const device of line.devices || []) dataStore.registerDevice(device)
        }
    }
}

function eventQueryConfig() {
    const marqueeWidget = widgets.value.find(widget => (widget.type || widget.widget_type) === 'marquee')
    const alarmWidget = widgets.value.find(widget => (widget.type || widget.widget_type) === 'alarm_list')
    const marquee = marqueeWidget?.content || marqueeWidget?.config || {}
    const alarms = alarmWidget?.content || alarmWidget?.config || {}
    return {
        limit: marquee.limit || alarms.limit || 20,
        eventWindowHours: marquee.eventWindowHours ?? marquee.windowHours ?? 24,
        eventType: marquee.eventType || marquee.event_type || ''
    }
}

async function focusNativeScene(mode, event = {}) {
    const configuredView = viewFor(mode, event.viewId)
    const focus = navigationFocus(mode, event, configuredView)
    const inspectionStage = mode === 'device' ? inspectionStageForView(configuredView) : ''
    if (inspectionStage) focus.inspectionStage = inspectionStage
    const nextContext = {
        viewId: configuredView?.id || event.viewId || runtimeContext.viewId,
        viewMode: mode,
        deviceId: mode === 'device' ? focus.deviceId : '',
        lineId: mode === 'line' ? focus.lineId : (mode === 'device' ? runtimeContext.lineId : ''),
        workshopId: mode === 'workshop' ? focus.workshopId : (['line', 'device'].includes(mode) ? runtimeContext.workshopId : '')
        ,inspectionStage, partId: ''
    }
    try {
        const response = await fetch(`${API_BASE}/native-preview/navigate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'view',
                source: 'dashboard_overlay',
                viewId: configuredView?.id || event.viewId || '',
                focus
            })
        })
        if (response.ok) applyRuntimeContext(nextContext, { userNavigation: true })
        return response.ok
    } catch {
        // Unity 不在线时不影响数据组件本身。
        return false
    }
}

function viewFor(mode, viewId = '') {
    return dashboardViews.value.find(view => view.id === viewId)
        || dashboardViews.value.find(view => view.mode === mode)
        || dashboardViews.value[0]
}

function inspectionStageForView(view) {
    const stage = String(view?.metadata?.inspectionStage || '').toLowerCase()
    return ['solid', 'xray', 'exploded', 'part'].includes(stage) ? stage : ''
}

// A generic authored view (such as “产线视角”) normally has no fixed target.
// Keep the target inherited from the current navigation context, otherwise a
// device -> line -> workshop return loses the line/workshop it should focus.
function navigationFocus(mode, event = {}, view = null) {
    const targetType = String(view?.targetType || '').toLowerCase()
    return {
        mode,
        deviceId: event.deviceId
            || (targetType === 'device' ? view?.targetId : '')
            || (mode === 'device' ? runtimeContext.deviceId : '')
            || '',
        lineId: event.lineId
            || (targetType === 'line' ? view?.targetId : '')
            || (mode === 'line' ? runtimeContext.lineId : '')
            || '',
        workshopId: event.workshopId
            || (targetType === 'workshop' ? view?.targetId : '')
            || (mode === 'workshop' ? runtimeContext.workshopId : '')
            || ''
    }
}

async function focusNativeView(viewId, event = {}) {
    const view = viewFor(event.mode || 'factory', viewId)
    const mode = view?.mode === 'custom' ? (view.targetType || 'factory') : (view?.mode || event.mode || 'factory')
    const focus = navigationFocus(mode, event, view)
    const inspectionStage = mode === 'device' ? inspectionStageForView(view) : ''
    if (inspectionStage) focus.inspectionStage = inspectionStage
    const nextContext = {
        viewId: view?.id || viewId || runtimeContext.viewId,
        viewMode: mode,
        deviceId: mode === 'device' ? focus.deviceId : '',
        lineId: mode === 'line' ? focus.lineId : (mode === 'device' ? runtimeContext.lineId : ''),
        workshopId: mode === 'workshop' ? focus.workshopId : (['line', 'device'].includes(mode) ? runtimeContext.workshopId : '')
        ,inspectionStage, partId: ''
    }
    try {
        const response = await fetch(API_BASE + '/native-preview/navigate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'view',
                source: 'dashboard_overlay',
                viewId: view?.id || viewId || '',
                focus
            })
        })
        if (response.ok) applyRuntimeContext(nextContext, { userNavigation: true })
        return response.ok
    } catch {
        return false
    }
}

async function returnToParentView() {
    if (!canNavigateToParentView.value || parentReturnBusy.value) return
    parentReturnBusy.value = true
    try {
        const targetType = String(currentView.value?.targetType || '').toLowerCase()
        const mode = String(runtimeContext.viewMode || currentView.value?.mode || targetType || '').toLowerCase()
        const isDeviceView = mode === 'device' || targetType === 'device' || targetType === 'device_part'
        if (isDeviceView && runtimeContext.inspectionStage && runtimeContext.inspectionStage !== 'solid') {
            const response = await fetch(`${API_BASE}/native-preview/navigate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // viewId makes this idempotent if Unity and the WebView happen
                // to receive the same Escape key during a focus transition.
                body: JSON.stringify({
                    action: 'inspection_back',
                    source: 'dashboard_overlay',
                    viewId: runtimeContext.viewId,
                    focus: { mode: 'device', deviceId: runtimeContext.deviceId }
                })
            })
            if (!response.ok) return false
            return
        }
        const parentId = parentViewIdForCurrent()
        if (parentId) await focusNativeView(parentId)
    } finally {
        parentReturnBusy.value = false
    }
}

function isEditableKeyboardTarget(target) {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]'))
}

function handleOverlayKeydown(event) {
    if (event.key !== 'Escape' && event.code !== 'Escape') return
    if (event.defaultPrevented || event.isComposing) return
    if (isEditableKeyboardTarget(event.target) || !canNavigateToParentView.value) return
    event.preventDefault()
    event.stopPropagation()
    void returnToParentView()
}

function playVoice(event) {
    voiceAnnouncer.preview({ mode: 'auto', audio_url: event.audioUrl || '', text: event.text || '' }).catch(() => {})
}

function handleWidgetAction({ event }) {
    if (!event) return
    if (['set_visibility', 'toggle_visibility'].includes(event.action)) {
        applyVisibilityAction(event, { groupVisibility, widgetVisibility })
        scheduleRegionReport()
        return
    }
    if (event.action === 'enter_device') return focusNativeScene('device', event)
    if (event.action === 'focus_factory') return focusNativeScene('factory', event)
    if (event.action === 'focus_line') return focusNativeScene('line', event)
    if (event.action === 'focus_workshop') return focusNativeScene('workshop', event)
    if (event.action === 'switch_view' && event.viewId) return focusNativeView(event.viewId, event)
    if (event.action === 'play_voice') return playVoice(event)
    if (event.action === 'open_link' && /^https?:\/\//i.test(event.url || '')) {
        if (window.chrome?.webview) postHostMessage({ type: 'dashboard_action', action: 'open_link', url: event.url })
        else window.open(event.url, '_blank', 'noopener,noreferrer')
    }
    if (event.action === 'switch_scene' && event.sceneId) {
        fetch(`${API_BASE}/platform/scenes/${encodeURIComponent(event.sceneId)}/activate-latest-release`, { method: 'POST' }).catch(() => {})
    }
}

async function handleRuntimeMessage(message) {
    if (overlayDisposed) return
    if (message?.type === 'dashboard_context_changed') {
        const payload = message.payload || {}
        applyRuntimeContext(payload)
        scheduleRegionReport()
        return
    }
    if (message?.type === 'dashboard_release_changed') {
        await loadConfig()
        if (overlayDisposed) return
        probeConfiguredModels()
        runtimeContext.sceneId = platform.value.activeScene?.id || runtimeContext.sceneId
        runtimeContext.viewId = presentationDocument.value?.scene?.defaultViewId || platform.value.activeScene?.defaultViewId || runtimeContext.viewId
        runtimeContext.viewMode = dashboardViews.value.find(view => view.id === runtimeContext.viewId)?.mode || 'factory'
        dataStore.setEventQueryOptions(eventQueryConfig())
        await Promise.all([refreshDatabaseValues(true), refreshBusinessData(true)])
        await nextTick()
        scheduleRegionReport()
    }
}

function handleHostMessage(event) {
    if (event.data?.type !== 'overlay_host_state') return
    hostConnected.value = event.data.visible !== false
    if (event.data.context) {
        applyRuntimeContext(event.data.context)
    }
    scheduleRegionReport()
}

async function refreshDatabaseValues(force = false) {
    if (overlayDisposed || (!force && databaseInFlight)) return
    if (!force && !configuredWidgets.value.some(widget => widget.data?.mode === 'database')) return
    const requestSeq = ++databaseRequestSeq
    databaseInFlight = true
    try {
        const query = new URLSearchParams({
            view_id: runtimeContext.viewId || '',
            workshop_id: runtimeContext.workshopId || '',
            line_id: runtimeContext.lineId || '',
            device_id: runtimeContext.deviceId || '',
            part_id: runtimeContext.partId || ''
        })
        const response = await fetch(`${API_BASE}/data-sources/runtime-values?${query}`, { signal: overlayRequests.signal })
        if (!response.ok) return
        const payload = await response.json()
        if (overlayDisposed || requestSeq !== databaseRequestSeq) return
        const next = payload.values || {}
        Object.keys(databaseValues).forEach(key => { if (!(key in next)) delete databaseValues[key] })
        Object.assign(databaseValues, next)
    } catch {
        // 外部数据库短暂离线时保留上一次画面，质量状态由后端结果更新。
    } finally {
        if (requestSeq === databaseRequestSeq) databaseInFlight = false
    }
}

function emptyBusinessSections(message) {
    return Object.fromEntries(['batches', 'compliance', 'oee', 'energy', 'maintenance'].map(key => [key, {
        available: false,
        rows: [],
        errorCode: 'NOT_CONFIGURED',
        message
    }]))
}

async function refreshBusinessData(force = false) {
    if (overlayDisposed || (!force && businessInFlight)) return
    const requestSeq = ++businessRequestSeq
    businessInFlight = false
    if (!businessWidgets.value.length) return
    const connectionId = String(businessWidgets.value.find(widget => widget.data?.connectionId)?.data?.connectionId
        || businessWidgets.value.find(widget => widget.content?.connectionId)?.content?.connectionId || '').trim()
    if (!connectionId) {
        businessData.status = 'unconfigured'
        businessData.source = { connectionId: '' }
        businessData.fetchedAt = null
        businessData.sections = emptyBusinessSections('请在设计器中为业务摘要组件配置外部只读数据库连接')
        return
    }
    businessInFlight = true
    businessData.status = 'loading'
    try {
        const params = new URLSearchParams({ connection_id: connectionId, limit: '200' })
        if (runtimeContext.deviceId) params.set('device_id', runtimeContext.deviceId)
        const response = await fetch(`${API_BASE}/business-data/snapshot?${params.toString()}`, { cache: 'no-store', signal: overlayRequests.signal })
        const payload = await response.json().catch(() => ({}))
        if (overlayDisposed || requestSeq !== businessRequestSeq) return
        if (!response.ok || payload.success === false) throw new Error(payload.error || `业务数据读取失败：${response.status}`)
        businessData.status = 'ready'
        businessData.readOnly = payload.readOnly !== false
        businessData.source = payload.source || { connectionId }
        businessData.fetchedAt = payload.fetchedAt || new Date().toISOString()
        businessData.sections = payload.sections || {}
    } catch (error) {
        if (overlayDisposed || requestSeq !== businessRequestSeq) return
        businessData.status = 'error'
        businessData.source = { connectionId }
        businessData.fetchedAt = null
        businessData.sections = emptyBusinessSections(error.message || '外部业务数据读取失败')
    } finally {
        if (requestSeq === businessRequestSeq) businessInFlight = false
    }
}

onMounted(async () => {
    standalonePreview.value = !window.chrome?.webview
    previousDocumentBackground = document.documentElement.style.background
    previousBodyBackground = document.body.style.background
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    scheduleRegionReport()
    window.chrome?.webview?.addEventListener('message', handleHostMessage)
    window.addEventListener('keydown', handleOverlayKeydown, true)

    await loadConfig()
    if (overlayDisposed) return
    probeConfiguredModels()
    runtimeContext.sceneId = platform.value.activeScene?.id || ''
    runtimeContext.viewId = presentationDocument.value?.scene?.defaultViewId || platform.value.activeScene?.defaultViewId || 'factory_overview'
    runtimeContext.viewMode = dashboardViews.value.find(view => view.id === runtimeContext.viewId)?.mode || 'factory'
    if (!window.chrome?.webview) runtimeContext.sceneReady = true
    registerConfiguredDevices()
    dataStore.setEventQueryOptions(eventQueryConfig())
    dataStore.setMessageHandler(handleRuntimeMessage)
    dataStore.connect()
    await Promise.all([
        dataStore.refreshEvents(true),
        dataStore.refreshMetrics(true),
        dataStore.refreshHealth(true),
        refreshDatabaseValues(true),
        refreshBusinessData(true)
    ])

    await nextTick()
    if (overlayDisposed || !rootRef.value) return
    resizeObserver = new ResizeObserver(scheduleRegionReport)
    resizeObserver.observe(rootRef.value)
    for (const element of rootRef.value.querySelectorAll('[data-overlay-hit="true"]')) {
        resizeObserver.observe(element)
    }
    // Text/attribute updates are frequent in the live dashboard. They do not
    // change the native hit rectangles, so observing them makes WebView2
    // repeatedly recalculate its window region and can produce compositor
    // flashes. ResizeObserver handles geometry changes; MutationObserver is
    // limited to structural changes so newly mounted hit targets are picked up.
    mutationObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes || []) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue
                if (node.matches?.('[data-overlay-hit="true"]')) resizeObserver.observe(node)
                node.querySelectorAll?.('[data-overlay-hit="true"]').forEach(element => resizeObserver.observe(element))
            }
        }
        scheduleRegionReport()
    })
    mutationObserver.observe(rootRef.value, { childList: true, subtree: true })
    window.addEventListener('resize', scheduleRegionReport)
    refreshTimer = window.setInterval(() => {
        dataStore.refreshEvents()
        dataStore.refreshMetrics()
        dataStore.refreshHealth()
        refreshDatabaseValues()
        refreshBusinessData()
    }, 5000)
    modelProbeTimer = window.setInterval(probeConfiguredModels, 15000)

    hostConnected.value = true
    postHostMessage({ type: 'overlay_ready' })
    scheduleRegionReport()
})

onUnmounted(() => {
    overlayDisposed = true
    clearTimeout(inspectionProgressTimer)
    modelProbeGeneration += 1
    overlayRequests.abort()
    voiceAnnouncer.dispose()
    document.documentElement.style.background = previousDocumentBackground
    document.body.style.background = previousBodyBackground
    if (regionFrame) window.cancelAnimationFrame(regionFrame)
    window.clearInterval(refreshTimer)
    window.clearInterval(modelProbeTimer)
    window.clearTimeout(selectionTimer)
    lastRegionSignature = ''
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    window.removeEventListener('resize', scheduleRegionReport)
    window.removeEventListener('keydown', handleOverlayKeydown, true)
    window.chrome?.webview?.removeEventListener('message', handleHostMessage)
    dataStore.dispose()
})
</script>

<template>
    <div ref="rootRef" class="dashboard-overlay-root" :class="{ 'is-scene-ready': runtimeContext.sceneReady !== false, 'standalone-preview': standalonePreview }">
        <div class="overlay-canvas" :class="{ 'is-reference-canvas': presentationDocument?.metadata?.referenceHud === 1 && runtimeContext.viewId === 'factory_overview' }" :style="presentationDocument?.metadata?.referenceHud === 1 && runtimeContext.viewId === 'factory_overview' ? fitHudCanvas(dashboardCanvas, overlayViewport) : undefined">
            <div v-if="navigationEnabled" class="overlay-navigation" :style="navigationStyle">
                <button
                    type="button"
                    class="overlay-status"
                    :class="{ online: dataStore.health.readiness.displayReady && hostConnected }"
                    data-overlay-hit="true"
                    :title="`后端：${dataStore.health.components.backend?.status || '未知'}；数据库：${dataStore.health.components.database?.status || '未知'}；Unity：${dataStore.health.components.unity?.status || '未知'}；数据：${dataStore.health.components.dataEngine?.fresh ? '新鲜' : '未就绪'}`"
                    @click="selectWidget('overlay-status')"
                >
                    <span class="overlay-status-dot"></span>
                    <span>{{ navigationProjectLabel }}</span>
                    <strong>{{ navigationStatusText }}</strong>
                </button>
            </div>

            <div v-if="returnButtonEnabled" class="overlay-return-widget" :style="returnButtonStyle">
                <button
                    type="button"
                    v-if="canReturnToParentView"
                    class="overlay-line-return"
                    :class="{ 'is-busy': parentReturnBusy }"
                    :disabled="parentReturnBusy"
                    :aria-label="`返回${parentViewName}`"
                    :title="`返回${parentViewName}`"
                    data-overlay-hit="true"
                    @pointerdown.stop
                    @click.stop="returnToParentView"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M15.25 4.75 8 12l7.25 7.25" />
                    </svg>
                </button>
            </div>

            <div
                v-if="modelLoadErrors.length"
                class="overlay-model-errors"
                role="alert"
                data-overlay-hit="true"
                @pointerdown.stop
            >
                <strong>模型未加载（当前显示占位几何体）</strong>
                <div v-for="error in modelLoadErrors.slice(0, 4)" :key="`${error.deviceId}-${error.url}`" class="overlay-model-error-item">
                    <span>{{ error.deviceName }}（{{ error.deviceId }}）</span>
                    <small>{{ error.modelName }} · {{ error.reason }}</small>
                    <code v-if="error.url">{{ error.url }}</code>
                </div>
                <em v-if="modelLoadErrors.length > 4">还有 {{ modelLoadErrors.length - 4 }} 个模型未加载</em>
            </div>

            <div
                v-for="widget in widgets"
                :key="widget.id"
                class="overlay-widget hud-widget"
                @pointerenter="trackHoverMotion"
                @pointerleave="trackHoverMotion"
                :class="[
                    `widget-type-${widget.type || widget.widget_type}`,
                    { 'is-panel-heading': String(widget.content?.text || '').trim().startsWith('▸') },
                    { 'is-selected': selectedWidgetId === widget.id }
                ]"
                :style="widgetStyle(widget)"
                data-overlay-hit="true"
                @pointerdown.stop
                @click="selectWidget(widget.id)"
            >
                <WidgetRenderer
                    :widget="widget"
                    :metrics="dataStore.metrics"
                    :events="dataStore.events.value"
                    :trend-points="dataStore.trendPoints.value"
                    :device-status-map="dataStore.deviceStatusMap"
        :device-data-map="dataStore.deviceDataMap"
        :point-values="pointValues"
                    :database-values="databaseValues"
                    :business-data="businessData"
                    :runtime-context="runtimeContext"
                    :selected-part="selectedPart"
                    overlay-mode
                    :preview="true"
                    :data-ready="dataStore.health.readiness.displayReady === true"
                    @action="handleWidgetAction"
                />
            </div>
        </div>
    </div>
</template>

<style>
html,
body,
#app {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: transparent !important;
}

.dashboard-overlay-root,
.dashboard-overlay-root * {
    box-sizing: border-box;
}

.dashboard-overlay-root {
    position: fixed;
    inset: 0;
    overflow: hidden;
    color: #eef7ff;
    background: transparent;
    pointer-events: none;
    user-select: none;
    font-family: var(--hud-font-text, "SF Pro Text", "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", sans-serif);
    font-synthesis: none;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    --overlay-ink: #061321;
    --overlay-ink-deep: #020b16;
    --overlay-blue: #6bd4ff;
    --overlay-cyan: #55c7ff;
    --overlay-violet: #8b8bff;
    --overlay-green: #49df9d;
    --overlay-warm: #ffc45f;
    --overlay-muted: #8ea7ba;
}

/* In a normal desktop build Unity supplies the scene below this transparent
   layer. The browser route has no host scene, so give it a proper art-directed
   canvas for review and designer preview instead of falling back to white. */
.dashboard-overlay-root.standalone-preview {
    background:
        radial-gradient(ellipse at 52% 44%, #333c57 0%, #1c2439 42%, #101624 80%);
}

.dashboard-overlay-root.standalone-preview::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: .34;
    background:
        linear-gradient(rgba(107, 212, 255, .045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(107, 212, 255, .045) 1px, transparent 1px),
        radial-gradient(ellipse at 50% 50%, transparent 22%, rgba(0, 5, 14, .42) 100%);
    background-size: 44px 44px, 44px 44px, 100% 100%;
}

.dashboard-overlay-root.standalone-preview::after {
    content: "";
    position: absolute;
    inset: 3.6%;
    pointer-events: none;
    border: 1px solid rgba(107, 212, 255, .13);
    border-radius: 16px;
    box-shadow: inset 0 0 70px rgba(42, 119, 173, .08);
}

/* Keep the browser-only review surface in the same 16:9 composition as the
   reference dashboard. The hosted Unity overlay remains full-canvas. */
.dashboard-overlay-root.standalone-preview .overlay-canvas {
    inset: auto;
    top: 50%;
    left: 50%;
    width: min(100%, 177.7778vh);
    height: min(100%, 56.25vw);
    aspect-ratio: 16 / 9;
    transform: translate(-50%, -50%);
}

.overlay-canvas {
    position: absolute;
    inset: 0;
    opacity: 1;
    isolation: isolate;
}
.overlay-canvas.is-reference-canvas {
    inset: auto;
    top: 50%;
    left: 50%;
    transform-origin: center;
}
.dashboard-overlay-root.is-scene-ready .overlay-canvas { opacity: 1; }

/* A restrained vignette makes the information layer read as one instrument
   panel while leaving the center of the Unity scene open and bright. */
.overlay-canvas::before,
.overlay-canvas::after {
    content: "";
    position: absolute;
    pointer-events: none;
}

.overlay-canvas::before {
    inset: 0;
    z-index: 0;
    background:
        radial-gradient(ellipse at 50% 42%, transparent 22%, rgba(2, 9, 19, .06) 65%, rgba(2, 8, 18, .34) 100%),
        linear-gradient(180deg, rgba(2, 12, 24, .42), transparent 19%, transparent 78%, rgba(2, 9, 20, .34));
}

.overlay-canvas::after {
    inset: 22px;
    z-index: 0;
    border: 1px solid rgba(112, 196, 238, .11);
    border-radius: 18px;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .025);
}

.overlay-navigation {
    position: absolute;
    pointer-events: none;
}

.overlay-return-widget {
    position: absolute;
    pointer-events: none;
}

.overlay-line-return {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 35;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 1px solid rgba(105, 195, 240, 0.36);
    border-radius: 11px;
    color: rgba(255, 255, 255, 0.94);
    background: linear-gradient(145deg, rgba(18, 51, 77, .94), rgba(3, 16, 30, .92));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .1), inset 0 -10px 22px rgba(0, 5, 16, .22);
    -webkit-font-smoothing: antialiased;
    -webkit-backface-visibility: hidden;
    backface-visibility: hidden;
    will-change: transform;
    pointer-events: auto;
    cursor: pointer;
    transition: transform 160ms ease, border-color 160ms ease, background 160ms ease, opacity 160ms ease;
}

.overlay-line-return:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: rgba(107, 212, 255, .78);
    background: linear-gradient(145deg, rgba(31, 81, 114, .96), rgba(5, 25, 44, .94));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .16), inset 0 0 20px rgba(85, 199, 255, .14);
}

.overlay-line-return:active:not(:disabled) { transform: translateY(0) scale(0.97); }
.overlay-line-return:focus-visible { outline: 2px solid rgba(99, 196, 255, 0.92); outline-offset: 2px; }
.overlay-line-return:disabled { opacity: 0.62; cursor: wait; }
.overlay-line-return svg {
    width: 20px;
    height: 20px;
    overflow: visible;
    fill: none;
    stroke: #ffffff !important;
    stroke-width: 2.15;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 160ms ease;
}
.overlay-line-return svg path { stroke: #ffffff !important; fill: none !important; }
.overlay-line-return:hover:not(:disabled) svg { transform: translateX(-1px); }
.overlay-line-return.is-busy svg { animation: overlayReturnPulse 700ms ease-in-out infinite alternate; }

.overlay-status {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: 30;
    min-height: 34px;
    max-width: min(620px, 56vw);
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 14px;
    transform: translateX(-50%);
    border: 1px solid rgba(166, 179, 221, .16);
    border-radius: 4px;
    color: #d3e9f7;
    background: rgba(19, 25, 43, .45);
    box-shadow: inset 0 1px 0 rgba(209, 221, 255, .06);
    letter-spacing: .025em;
    pointer-events: auto;
    cursor: pointer;
    outline: none;
    -webkit-tap-highlight-color: transparent;
    transition: transform 180ms cubic-bezier(.22, 1, .36, 1), border-color 180ms ease, box-shadow 180ms ease, background 180ms ease;
}

.overlay-status:hover { transform: translateX(-50%) translateY(-1px); border-color: rgba(107, 212, 255, .72); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .14), inset 0 0 20px rgba(85, 199, 255, .14); }
.overlay-status:active { transform: translateX(-50%) scale(.985); }
.overlay-status:focus-visible { outline: 2px solid rgba(99, 196, 255, 0.92); outline-offset: 2px; }

.overlay-status span,
.overlay-status strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.overlay-status span { font-size: 11px; font-weight: 600; }
.overlay-status strong { color: var(--overlay-warm); font-size: 10px; font-weight: 700; letter-spacing: .06em; }
.overlay-status-dot {
    width: 8px;
    height: 8px;
    flex: 0 0 8px;
    border-radius: 50%;
    background: #df6666;
    box-shadow: 0 0 0 4px rgba(223, 102, 102, 0.12);
}
.overlay-status.online .overlay-status-dot {
    background: #4fd29a;
    box-shadow: 0 0 0 4px rgba(79, 210, 154, 0.12), 0 0 14px rgba(79, 210, 154, 0.48);
}

.overlay-model-errors {
    position: absolute;
    left: 50%;
    bottom: 22px;
    z-index: 34;
    width: min(720px, 70vw);
    max-height: min(32vh, 260px);
    display: grid;
    gap: 7px;
    padding: 14px 16px;
    transform: translateX(-50%);
    overflow: auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
    pointer-events: auto;
    color: #fff2ef;
    background: linear-gradient(135deg, rgba(91, 30, 27, .96), rgba(53, 18, 23, .96));
    border: 1px solid rgba(255, 173, 159, .66);
    border-left: 4px solid #ff725f;
    border-radius: 12px;
    box-shadow: 0 16px 38px rgba(17, 5, 8, .36);
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 190, 178, .8) rgba(255, 255, 255, .1);
}
.overlay-model-errors::-webkit-scrollbar { width: 10px; }
.overlay-model-errors::-webkit-scrollbar-track { background: rgba(255, 255, 255, .08); border-radius: 999px; }
.overlay-model-errors::-webkit-scrollbar-thumb { background: rgba(255, 190, 178, .82); border: 2px solid rgba(91, 30, 27, .94); border-radius: 999px; }
.overlay-model-errors > strong { color: #ffd3cc; font-size: 14px; }
.overlay-model-error-item { display: grid; gap: 2px; padding-top: 7px; border-top: 1px solid rgba(255, 255, 255, .14); }
.overlay-model-error-item span { color: #fff5f2; font-size: 12px; font-weight: 700; }
.overlay-model-error-item small,
.overlay-model-error-item code,
.overlay-model-errors > em { color: #ffdcd5; font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }
.overlay-model-error-item code { font-family: SFMono-Regular, Consolas, Monaco, monospace; }
</style>
