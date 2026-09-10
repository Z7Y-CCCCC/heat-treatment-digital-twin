<script setup>
import { ref, reactive, onMounted, onUnmounted, onActivated, onDeactivated, computed, watch, nextTick } from 'vue'
import * as THREE from 'three'
import QRCode from 'qrcode'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { adminApi } from '../config/factoryConfig.js'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { SceneRuntime } from '../runtime/SceneRuntime.js'
import { RENDER_PROFILE_OPTIONS, normalizeRenderSettings } from '../runtime/renderConfig.js'
import { createVoiceAnnouncer, normalizeVoiceRule, parseVoiceConfig } from '../runtime/VoiceAnnouncer.js'
import WidgetRenderer from '../runtime/WidgetRenderer.vue'
import { createDeviceModel, resolveBackendAssetUrl } from '../three/ModelFactory.js'
import {
    DEFAULT_DEVICE_LABEL_CONFIG,
    DEFAULT_DIAGNOSTIC_CONFIG,
    DEFAULT_LINE_OVERVIEW_CONFIG,
    buildDiagnosticGroups,
    normalizeDeviceLabelConfig
} from '../runtime/uiConfig.js'
import {
    sortByOrder,
    numberOrDefault,
    clampNumber,
    isBlank,
    optionalNumber,
    parseInstanceConfig,
    parseEditableInstanceConfig,
    stringifyInstanceConfigForEdit,
    isAuxiliaryDeviceConfig
} from './admin/utils/common.js'
import {
    makeLineLayoutItem,
    defaultLineLayout,
    normalizeLineLayoutItems,
    normalizeLineLayout,
    serializeLineLayout,
    normalizeLineRecord
} from './admin/utils/lineLayout.js'
import { useAppDialog } from './admin/composables/useAppDialog.js'
import { useSystemSettings } from './admin/composables/useSystemSettings.js'
import { useCastDevices } from './admin/composables/useCastDevices.js'
import { usePointMonitor } from './admin/composables/usePointMonitor.js'
import { useDataPoints } from './admin/composables/useDataPoints.js'
import { formatPointValue, formatQualityLabel, formatPointTime } from './admin/utils/points.js'
import NativeEnvironmentSettings from './admin/components/NativeEnvironmentSettings.vue'
import DashboardDesigner from './admin/components/DashboardDesigner.vue'
import { normalizeWorkshopLayout } from '../utils/spatialLayout.js'
import {
    PLC_PROTOCOL_OPTIONS,
    getPlcAddressHint,
    getPlcAddressPlaceholder,
    getPlcProtocolDefinition,
    normalizePlcOptions,
    normalizePlcProtocol
} from '../config/plcProtocols.js'

defineOptions({ name: 'AdminPanel' })

const ADMIN_UI_STATE_KEY = 'digital_twin_admin_ui_state_v1'
const isUnityEmbedded = new URLSearchParams(window.location.search).get('embedded') === 'unity'
const unityHostState = reactive({ attached: true, maximized: false, dockReady: false, adminVisible: true })
let unityHostDragActive = false
let unityHostDragTarget = 'admin'
let unityHostDragStartX = 0
let unityHostDragStartY = 0
const UNITY_NATIVE_MOVE_THRESHOLD = 5

function postUnityHostMessage(message) {
    window.chrome?.webview?.postMessage(message)
}

function handleUnityHostMessage(event) {
    if (event.data?.type !== 'host_state') return
    unityHostState.attached = event.data.attached !== false
    unityHostState.maximized = event.data.maximized === true
    unityHostState.dockReady = event.data.dockReady === true
    unityHostState.adminVisible = event.data.adminVisible !== false
}

function requestUnityHostAction(action) {
    postUnityHostMessage({ type: 'host_action', action })
}

function handleUnityChromeDoubleClick(event) {
    if (event.button !== 0) return
    if (event.target?.closest?.('.unity-browser-tab, .unity-window-actions')) return
    unityHostDragActive = false
    requestUnityHostAction('maximize')
}

function beginUnityHostDrag(event, target = 'admin') {
    if (event.button !== 0) return
    if (!unityHostState.attached) {
        postUnityHostMessage({
            type: 'host_drag_start',
            target: 'admin',
            screenX: Math.round(event.screenX),
            screenY: Math.round(event.screenY)
        })
        return
    }
    unityHostDragActive = true
    unityHostDragTarget = target
    unityHostDragStartX = event.screenX
    unityHostDragStartY = event.screenY
    event.currentTarget?.setPointerCapture?.(event.pointerId)
    if (target === 'dashboard') return
    postUnityHostMessage({
        type: 'host_drag_start',
        target,
        screenX: Math.round(event.screenX),
        screenY: Math.round(event.screenY)
    })
}

function continueUnityHostDrag(event) {
    if (!unityHostDragActive) return
    if (unityHostDragTarget === 'dashboard') {
        const deltaX = event.screenX - unityHostDragStartX
        const deltaY = event.screenY - unityHostDragStartY
        if ((deltaX * deltaX) + (deltaY * deltaY) < UNITY_NATIVE_MOVE_THRESHOLD * UNITY_NATIVE_MOVE_THRESHOLD) return
        unityHostDragActive = false
        event.currentTarget?.releasePointerCapture?.(event.pointerId)
        postUnityHostMessage({
            type: 'host_window_move_start',
            screenX: Math.round(event.screenX),
            screenY: Math.round(event.screenY)
        })
        return
    }
    postUnityHostMessage({ type: 'host_drag_move', screenX: Math.round(event.screenX), screenY: Math.round(event.screenY) })
}

function endUnityHostDrag(event) {
    if (!unityHostDragActive) return
    const target = unityHostDragTarget
    unityHostDragActive = false
    unityHostDragTarget = 'admin'
    if (target === 'dashboard') return
    postUnityHostMessage({
        type: 'host_drag_end',
        screenX: Math.round(event?.screenX || 0),
        screenY: Math.round(event?.screenY || 0)
    })
}

if (isUnityEmbedded) {
    onMounted(() => {
        window.chrome?.webview?.addEventListener('message', handleUnityHostMessage)
        postUnityHostMessage({ type: 'host_action', action: 'state' })
    })
    onUnmounted(() => window.chrome?.webview?.removeEventListener('message', handleUnityHostMessage))
}

function closeAdminPanel() {
    if (isUnityEmbedded && window.chrome?.webview) {
        requestUnityHostAction('close_window')
        return
    }
    window.location.assign('/')
}

function showUnityDashboard() {
    requestUnityHostAction('show_dashboard')
}

function showUnityAdmin() {
    requestUnityHostAction('show_admin')
}

function reloadAdminPage() {
    if (isUnityEmbedded && window.chrome?.webview) {
        requestUnityHostAction('reload_page')
        return
    }
    window.location.reload()
}

function loadAdminUiState() {
    try {
        return JSON.parse(localStorage.getItem(ADMIN_UI_STATE_KEY) || '{}')
    } catch (e) {
        return {}
    }
}

const storedAdminUiState = loadAdminUiState()

const PLATFORM_SUBPAGES = [
    { key: 'designer', label: '大屏设计器', description: '拖拽组件、绑定数据并发布画面' },
    { key: 'scene', label: '项目与场景', description: '项目归属与场景基础信息' },
    { key: 'environment', label: '场景与光效', description: 'Unity 灯光、后处理、围墙与空间' }
]
const SETTINGS_SUBPAGES = [
    { key: 'runtime', label: '运行与投屏', description: '自启动、电视投屏与本地运行服务' },
    { key: 'database', label: '数据库与备份', description: '连接、外部数据源、备份与恢复' },
    { key: 'performance', label: '客户端性能', description: 'Unity 画质与旧 Web 兼容参数' },
    { key: 'data', label: '数据通路', description: 'PLC 实时采集或离线模拟模式' },
    { key: 'license', label: '授权与版本', description: '离线许可证、有效期与发布信息' }
]

function restoreSubpage(value, options, fallback) {
    return options.some(option => option.key === value) ? value : fallback
}

// 当前选中的 Tab
const activeTab = ref(storedAdminUiState.activeTab || 'composer')
const platformSubpage = ref(restoreSubpage(storedAdminUiState.platformSubpage, PLATFORM_SUBPAGES, 'designer'))
const settingsSubpage = ref(restoreSubpage(storedAdminUiState.settingsSubpage, SETTINGS_SUBPAGES, 'runtime'))
const adminContentRef = ref(null)
const isAdminNavCollapsed = ref(!!storedAdminUiState.isAdminNavCollapsed)
const isFactoryMenuOpen = ref(true)
const isDataMenuOpen = ref(true)
const isLegacyWebRenderSettingsOpen = ref(false)
const isExternalDataSourcesOpen = ref(!!storedAdminUiState.isExternalDataSourcesOpen)
const isAlarmConfigOpen = ref(!!storedAdminUiState.isAlarmConfigOpen)

async function selectPlatformSubpage(key) {
    if (!PLATFORM_SUBPAGES.some(option => option.key === key)) return
    platformSubpage.value = key
    await nextTick()
    adminContentRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
    if (key === 'designer') {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }
}

async function selectSettingsSubpage(key) {
    if (!SETTINGS_SUBPAGES.some(option => option.key === key)) return
    settingsSubpage.value = key
    await nextTick()
    adminContentRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

const navIconPaths = {
    composer: ['M4 5h16v14H4z', 'M8 9h8', 'M8 13h5', 'M16 13h1', 'M8 17h8'],
    factory: ['M4 20V9l4-3 4 3 4-3 4 3v11', 'M8 20v-6h3v6', 'M16 20v-6h3v6', 'M12 20V9'],
    workshops: ['M4 20V8l8-4 8 4v12', 'M8 20v-8h8v8', 'M10 8h4'],
    lines: ['M4 7h5', 'M15 7h5', 'M9 7c2 0 4 10 6 10', 'M4 17h5', 'M15 17h5'],
    devices: ['M6 8h12v8H6z', 'M9 8V5h6v3', 'M9 19h6', 'M12 16v3'],
    models: ['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
    platform: ['M5 5h6v6H5z', 'M13 5h6v6h-6z', 'M5 13h6v6H5z', 'M13 13h6v6h-6z'],
    data: ['M4 7h16', 'M4 12h16', 'M4 17h16', 'M7 7v10', 'M17 7v10'],
    points: ['M5 12h4', 'M15 12h4', 'M9 12a3 3 0 1 0 6 0a3 3 0 0 0-6 0', 'M12 5V3', 'M12 21v-2'],
    settings: ['M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z', 'M12 2v3', 'M12 19v3', 'M4.93 4.93l2.12 2.12', 'M16.95 16.95l2.12 2.12', 'M2 12h3', 'M19 12h3', 'M4.93 19.07l2.12-2.12', 'M16.95 7.05l2.12-2.12']
}

const { appDialog, openAppDialog, closeAppDialog, alert, confirm } = useAppDialog()

const {
    defaultSettings,
    settings,
    renderProfileOptions,
    resolvedRenderSettings,
    selectedRenderProfile,
    nativeEnvironmentConfig,
    nativeEnvironmentSaving,
    nativeEnvironmentMessage,
    nativeEnvironmentPresetOptions,
    saveNativeEnvironmentSettings,
    applyNativeEnvironmentPreset,
    resetNativeEnvironmentConfig,
    runtimeSettings,
    runtimeStatus,
    runtimeSaving,
    runtimeMessage,
    runtimeQrDataUrl,
    firstCastPairingUrl,
    refreshRuntimeQr,
    loadRuntimeSettings,
    saveRuntimeSettings,
    rotateCastPin,
    copyCastUrl,
    startRuntimeRefresh,
    stopRuntimeRefresh,
    loadSettings,
    engineStatus,
    plcStatusLabels,
    plcStatusByDevice,
    formatPlcDeviceStatus,
    formatPlcEndpoint,
    formatPlcIntervals,
    formatPlcTime,
    databaseConfig,
    databaseTestStatus,
    databaseSaving,
    databaseBackupBusy,
    databaseBackupPolicySaving,
    databaseBackupMessage,
    databaseBackupPolicy,
    databaseBackupRetentionPresets,
    databaseBackupStatus,
    dataSourceConnections,
    dataSourceEditor,
    dataSourceBusy,
    dataSourceMessage,
    dataSourceBackupBusy,
    dataSourceBackupConfig,
    dataSourceBackupStatus,
    resetDataSourceEditor,
    editDataSource,
    testExternalDataSource,
    saveExternalDataSource,
    removeExternalDataSource,
    saveDataSourceBackupConfiguration,
    runSelectedDatabaseBackups,
    siteBackupFileInput,
    siteBackupBusy,
    siteBackupMessage,
    siteBackupStatus,
    siteBackupConfig,
    siteBackupConfigSaving,
    loadDatabaseConfig,
    loadSiteBackups,
    saveSiteBackupConfiguration,
    downloadSiteBackup,
    exportSiteBackup,
    chooseSiteBackupFile,
    restoreSiteBackupFromFile,
    loadDatabaseBackups,
    selectDatabaseBackupRetention,
    saveDatabaseBackupPolicy,
    createDatabaseBackup,
    restoreDatabaseBackup,
    deleteDatabaseBackup,
    downloadDatabaseBackup,
    formatBackupSize,
    formatBackupTime,
    formatBackupInterval,
    testDatabaseConnection,
    saveDatabaseConnection,
    loadEngineStatus,
    formatEngineMode,
    saveSettings
} = useSystemSettings({
    alert,
    confirm,
    loadWorkshops: (...args) => loadWorkshops(...args),
    loadLines: (...args) => loadLines(...args),
    loadDevices: (...args) => loadDevices(...args),
    loadModels: (...args) => loadModels(...args),
    loadPlatform: (...args) => loadPlatform(...args),
    ensureComposerSelection: (...args) => ensureComposerSelection(...args),
    syncComposerDraftFromSelection: (...args) => syncComposerDraftFromSelection(...args),
    scheduleComposerPreview: (...args) => scheduleComposerPreview(...args)
})

const {
    castState,
    castBusyDeviceId,
    castMessage,
    castingDeviceId,
    castingDeviceName,
    deviceLabel: castDeviceLabel,
    deviceSubtitle: castDeviceSubtitle,
    sessionStateLabel: castSessionStateLabel,
    loadCastDevices,
    refreshCastDevices,
    startCast,
    stopCast,
    startCastRefresh,
    stopCastRefresh
} = useCastDevices({ alert, confirm })

function getDbStatusBadgeClass(statusText) {
    if (!statusText) return ''
    if (statusText.includes('成功')) return 'status-success'
    if (statusText.includes('失败')) return 'status-error'
    if (statusText.includes('正在') || statusText.includes('中')) return 'status-loading'
    return 'status-info'
}

// ============ 车间管理 ============
const workshops = ref([])
const templatePacks = ref([])
const licenseStatus = reactive({
    status: 'loading',
    reason: '正在读取授权状态…',
    configured: false,
    valid: false,
    enforce: false,
    licenseId: null,
    customer: null,
    issuedAt: null,
    expiresAt: null,
    features: []
})
const licenseText = ref('')
const licenseBusy = ref(false)
const licenseMessage = ref('')
const releaseStatus = reactive({
    mode: 'offline_signed_package',
    current: { productVersion: '—', configurationVersion: '—', buildCommit: 'unknown' },
    contract: { signatureRequired: true, sha256Required: true, downgradeRejected: true, rollback: '' }
})
const newWorkshop = reactive({ id: '', name: '' })
const selectedWorkshopEditorId = ref(storedAdminUiState.selectedWorkshopEditorId || '')
const workshopSavingId = ref('')
const workshopManagementSteps = [
    { key: 'list', number: '01', title: '车间列表', description: '新增、选择与管理车间' },
    { key: 'space', number: '02', title: '空间与边界', description: '设置世界位置和车间尺寸' },
    { key: 'layout', number: '03', title: '产线布局', description: '按比例拖动并查看产线间距' }
]
const workshopManagementStep = ref(
    workshopManagementSteps.some(step => step.key === storedAdminUiState.workshopManagementStep)
        ? storedAdminUiState.workshopManagementStep
        : 'list'
)
const workshopMapStageRef = ref(null)
const workshopMapPendingGhostRef = ref(null)
const workshopMapSelectedLineId = ref(storedAdminUiState.workshopMapSelectedLineId || '')
const workshopMapDraggingLineId = ref('')
const workshopMapPendingDragLineId = ref('')
const workshopMapPendingDropReady = ref(false)
const workshopMapPlacementHintLineId = ref('')
const workshopMapSaving = ref(false)
let workshopMapDragState = null
let workshopMapPendingDragState = null
let workshopMapPendingGhostFrame = 0
let workshopMapPendingGhostPosition = { x: 0, y: 0 }

function normalizeWorkshopRecord(workshop) {
    const layout = normalizeWorkshopLayout(workshop?.layout || workshop?.layout_json)
    return { ...workshop, layout, layout_json: JSON.stringify(layout) }
}

function getWorkshopLayout(workshop) {
    if (!workshop) return normalizeWorkshopLayout(null)
    if (!workshop.layout || typeof workshop.layout !== 'object') {
        workshop.layout = normalizeWorkshopLayout(workshop.layout_json)
    }
    return workshop.layout
}

const selectedWorkshopEditor = computed(() => (
    workshops.value.find(workshop => workshop.id === selectedWorkshopEditorId.value)
    || workshops.value[0]
    || null
))

async function loadWorkshops() {
    workshops.value = (await adminApi.getWorkshops()).map(normalizeWorkshopRecord)
    if (!workshops.value.some(workshop => workshop.id === selectedWorkshopEditorId.value)) {
        selectedWorkshopEditorId.value = workshops.value[0]?.id || ''
    }
    if (!workshops.value.length) workshopManagementStep.value = 'list'
}

async function loadTemplatePacks() {
    const result = await adminApi.getHeatTreatmentTemplateLibrary()
    templatePacks.value = Array.isArray(result?.packs) ? result.packs : []
}

async function loadLicenseStatus() {
    try {
        Object.assign(licenseStatus, await adminApi.getLicenseStatus())
    } catch (error) {
        licenseStatus.status = 'error'
        licenseStatus.reason = error.message || '读取授权状态失败'
    }
}

async function loadReleaseStatus() {
    try {
        Object.assign(releaseStatus, await adminApi.getReleaseStatus())
    } catch (error) {
        releaseStatus.mode = 'unavailable'
        releaseStatus.contract = { ...releaseStatus.contract, rollback: error.message || '读取发布状态失败' }
    }
}

function licenseStatusLabel(status) {
    return {
        valid: '有效',
        not_enforced: '未强制',
        not_configured: '未配置',
        unverified: '待验证',
        expired: '已过期',
        not_yet_valid: '尚未生效',
        machine_mismatch: '安装实例不匹配',
        invalid: '无效',
        loading: '读取中…',
        error: '读取失败'
    }[status] || status || '未知'
}

async function installLicenseFromText() {
    if (!licenseText.value.trim()) {
        licenseMessage.value = '请粘贴交付方提供的许可证 JSON。'
        return
    }
    let license
    try {
        license = JSON.parse(licenseText.value)
    } catch (error) {
        licenseMessage.value = '许可证不是有效 JSON，请检查复制内容。'
        return
    }
    licenseBusy.value = true
    licenseMessage.value = '正在校验签名并安装许可证…'
    try {
        Object.assign(licenseStatus, await adminApi.installLicense(license))
        licenseMessage.value = `许可证已安装：${licenseStatus.customer || licenseStatus.licenseId || '未命名客户'}`
        licenseText.value = ''
    } catch (error) {
        licenseMessage.value = error.message || '许可证安装失败'
    } finally {
        licenseBusy.value = false
    }
}

function selectWorkshopManagementStep(step) {
    if (!workshopManagementSteps.some(item => item.key === step)) return
    if (step !== 'list' && !selectedWorkshopEditor.value) return
    workshopManagementStep.value = step
    if (step === 'space') {
        nextTick(() => scheduleNativeScenePreview({ source: 'spatial', includeLayout: true }))
    }
    if (step === 'layout') {
        ensureWorkshopMapLineSelection()
        nextTick(() => scheduleNativeScenePreview({ source: 'spatial', includeLayout: true }))
    }
}

async function createWorkshop() {
    if (!newWorkshop.id || !newWorkshop.name) return alert('请填写车间ID和名称')
    const layout = normalizeWorkshopLayout(null)
    const previousWorkshop = sortByOrder(workshops.value)[workshops.value.length - 1]
    if (previousWorkshop) {
        const previousLayout = getWorkshopLayout(previousWorkshop)
        layout.transform.x = numberOrDefault(previousLayout.transform.x, 0)
            + numberOrDefault(previousLayout.size.width, 100) * 0.5
            + layout.size.width * 0.5
            + 20
    }
    const result = await adminApi.createWorkshop({
        id: newWorkshop.id,
        name: newWorkshop.name,
        sort_order: workshops.value.length,
        layout
    })
    if (result?.error) return alert(result.error, { title: '新增车间失败', type: 'danger' })
    if (!result?.success) return alert('新增车间失败：后端没有返回成功状态', { title: '新增车间失败', type: 'danger' })
    const createdId = newWorkshop.id
    const createdName = newWorkshop.name
    newWorkshop.id = ''
    newWorkshop.name = ''
    await loadWorkshops()
    selectedWorkshopEditorId.value = createdId
    selectWorkshopManagementStep('space')
    await alert(`车间「${createdName}」已创建`, { title: '新增成功', type: 'success' })
}

async function requestNamedDeletionConfirmation(typeLabel, id, loadImpact) {
    let impact
    try {
        impact = await loadImpact(id)
    } catch (error) {
        await alert(error.message || `无法读取${typeLabel}关联项`, { title: '删除前检查失败', type: 'danger' })
        return null
    }
    const targetName = String(impact?.name || '')
    if (!targetName) {
        await alert(`${typeLabel}名称为空，无法执行名称确认删除`, { title: '无法删除', type: 'danger' })
        return null
    }
    const associationCount = Number(impact?.associationCount || 0)
    const accepted = await confirm(
        associationCount > 0
            ? `此操作不可撤销，共有 ${associationCount} 个关联项会被一并删除。`
            : '此操作不可撤销，当前没有需要一并删除的关联项。',
        {
            title: `永久删除${typeLabel}「${targetName}」`,
            type: 'danger',
            confirmText: '永久删除',
            details: Array.isArray(impact?.associations) ? impact.associations : [],
            verificationText: targetName,
            verificationLabel: `请输入${typeLabel}名称“${targetName}”确认删除`
        }
    )
    return accepted ? { impact, targetName } : null
}

async function deleteWorkshop(id) {
    const confirmation = await requestNamedDeletionConfirmation('车间', id, adminApi.getWorkshopDeletionImpact)
    if (!confirmation) return
    let result
    try {
        result = await adminApi.deleteWorkshop(id, confirmation.targetName)
    } catch (error) {
        return alert(error.message || '删除车间失败', { title: '删除车间失败', type: 'danger' })
    }
    if (result?.error) return alert(result.error, { title: '删除车间失败', type: 'danger' })
    if (!result?.success) return alert('删除车间失败：后端没有返回成功状态', { title: '删除车间失败', type: 'danger' })
    await loadWorkshops()
    await loadLines()
    await loadDevices()
    workshopManagementStep.value = 'list'
    await alert(`车间「${confirmation.targetName}」已删除`, { title: '删除成功', type: 'success' })
}

function previewWorkshopSpatialLayout() {
    scheduleNativeScenePreview({ source: 'spatial', includeLayout: true })
}

async function saveWorkshopSpatialLayout(workshop = selectedWorkshopEditor.value) {
    if (!workshop) return
    workshopSavingId.value = workshop.id
    try {
        const layout = normalizeWorkshopLayout(getWorkshopLayout(workshop))
        workshop.layout = layout
        workshop.layout_json = JSON.stringify(layout)
        const result = await adminApi.updateWorkshop(workshop.id, {
            name: workshop.name,
            sort_order: workshop.sort_order,
            layout,
            layout_json: workshop.layout_json
        })
        if (result?.error) return alert(result.error, { title: '保存车间空间失败', type: 'danger' })
        await loadWorkshops()
        await reloadSavedNativeScenePreview('spatial')
        await alert(`车间「${workshop.name}」的世界位置和边界已保存`, { title: '保存成功', type: 'success' })
    } finally {
        workshopSavingId.value = ''
    }
}

// ============ 产线管理 ============
const lines = ref([])
const newLine = reactive({ id: '', name: '', workshop_id: '' })
const selectedLineEditorId = ref(storedAdminUiState.selectedLineEditorId || '')
const savedLineLayoutSnapshots = ref({})
const savedLinePlacementSnapshots = ref({})
const placedLines = computed(() => lines.value.filter(line => !isLinePlacementPending(line)))
const isLinePlannerEditorCollapsed = ref(!!storedAdminUiState.isLinePlannerEditorCollapsed)
const isLineDevicePoolCollapsed = ref(!!storedAdminUiState.isLineDevicePoolCollapsed)
const lineDevicePoolDock = reactive({
    x: Number.isFinite(Number(storedAdminUiState.lineDevicePoolDockX)) ? Number(storedAdminUiState.lineDevicePoolDockX) : 28,
    y: Number.isFinite(Number(storedAdminUiState.lineDevicePoolDockY)) ? Number(storedAdminUiState.lineDevicePoolDockY) : 26,
    moving: false,
    moved: false
})
const linePreviewStageRef = ref(null)
const lineLayoutSaving = ref(false)
const lineFlowMenuLaneId = ref('')
let linePreviewDragState = null
let lineDeviceDragState = null
let lineDevicePoolMoveState = null
const lineDeviceSavingId = ref('')
const lineFlowDirectionOptions = [
    { value: 'right', label: '向右' },
    { value: 'left', label: '向左' },
    { value: 'none', label: '隐藏' }
]
const lineDeviceDrag = reactive({
    active: false,
    deviceId: '',
    x: 0,
    z: 0,
    left: 0,
    top: 0,
    targetType: '',
    targetId: '',
    targetName: '',
    alignActive: false,
    alignX: 0,
    alignLeft: 0,
    canDrop: false,
    message: ''
})

const nativeScenePreviewSessionId = globalThis.crypto?.randomUUID?.()
    || `admin-${Date.now()}-${Math.random().toString(16).slice(2)}`
const nativeScenePreviewStatus = ref('正在检测 Unity...')
const nativeScenePreviewConnected = ref(false)
const nativeScenePreviewBusy = ref(false)
const nativeScenePreviewChecked = ref(false)
const nativeScenePreviewStatusClass = computed(() => ({
    'is-online': nativeScenePreviewConnected.value,
    'is-busy': nativeScenePreviewBusy.value,
    'is-checking': !nativeScenePreviewChecked.value && !nativeScenePreviewBusy.value,
    'is-offline': nativeScenePreviewChecked.value && !nativeScenePreviewConnected.value && !nativeScenePreviewBusy.value
}))
const nativeSceneHeaderLabel = computed(() => {
    if (nativeScenePreviewBusy.value) return 'Unity 同步中'
    if (!nativeScenePreviewChecked.value) return 'Unity 检测中'
    return nativeScenePreviewConnected.value ? 'Unity 已连接' : 'Unity 未连接'
})
const deviceConnectionSummary = computed(() => {
    const statuses = Array.isArray(engineStatus.plcStatus?.devices)
        ? engineStatus.plcStatus.devices
        : []
    const fallbackTotal = devices.value.filter(device => Number(device.plc_enabled || 0) > 0).length
    const total = statuses.length || fallbackTotal
    const online = statuses.filter(status => status.status === 'connected').length
    const connecting = statuses.filter(status => ['connecting', 'retrying'].includes(status.status)).length
    const tone = total <= 0
        ? 'is-unknown'
        : online === total
            ? 'is-online'
            : (online > 0 || connecting > 0)
                ? 'is-partial'
                : 'is-offline'
    return {
        total,
        online,
        tone,
        label: total > 0 ? `设备 ${online}/${total} 在线` : '设备状态未知',
        detail: engineStatus.plcStatus?.message || '尚未取得设备连接状态'
    }
})
let nativeScenePreviewTimer = null
let nativeScenePreviewStatusTimer = null
let nativeScenePreviewSequence = 0
let nativeScenePreviewPending = null

function nativePreviewDevicePayload(device, override = null) {
    const source = override?.id === device?.id ? { ...device, ...override } : (device || {})
    return {
        id: source.id,
        name: source.name,
        line_id: source.line_id || '',
        model_type: source.model_type || 'builtin_furnace',
        pos_x: numberOrDefault(source.pos_x, 0),
        pos_y: numberOrDefault(source.pos_y, 0),
        pos_z: numberOrDefault(source.pos_z, 0),
        rotation_y: numberOrDefault(source.rotation_y, 0),
        scale: Math.max(0.0001, numberOrDefault(source.scale, 1)),
        coordinate_space: source.coordinate_space || (source.line_id ? 'line_local' : 'workshop_local'),
        instance_config: parseInstanceConfig(source.instance_config)
    }
}

function buildNativePreviewFocus(source = activeTab.value) {
    if (source === 'lines') {
        return {
            mode: 'line',
            workshopId: selectedLineEditor.value?.workshop_id || '',
            lineId: selectedLineEditor.value?.id || '',
            deviceId: ''
        }
    }
    if (source === 'spatial') {
        return {
            mode: 'workshop',
            workshopId: selectedWorkshopEditor.value?.id || '',
            lineId: '',
            deviceId: ''
        }
    }
    const mode = composerPreviewMode.value || 'line'
    return {
        mode,
        workshopId: selectedComposerWorkshop.value?.id || '',
        lineId: selectedComposerLineId.value || '',
        deviceId: mode === 'device' ? (selectedComposerDeviceId.value || '') : ''
    }
}

function buildNativePreviewDevices(source, override = null) {
    const sourceDevices = source === 'composer' ? composerPreviewDevices.value : devices.value
    const pendingLineIds = new Set(
        lines.value.filter(isLinePlacementPending).map(line => String(line.id))
    )
    return sourceDevices
        .filter(device => {
            const config = parseInstanceConfig(device?.instance_config)
            return !pendingLineIds.has(String(device?.line_id || ''))
                && !pendingLineIds.has(String(config.laneLineId || ''))
                && !pendingLineIds.has(String(config.railLineId || ''))
        })
        .map(device => nativePreviewDevicePayload(device, override))
}

function buildNativePreviewLines() {
    return placedLines.value.map(line => ({
        id: line.id,
        workshop_id: line.workshop_id,
        layout: normalizeLineLayout(getLineLayout(line))
    }))
}

function buildNativePreviewWorkshops() {
    return workshops.value.map(workshop => ({
        id: workshop.id,
        layout: normalizeWorkshopLayout(getWorkshopLayout(workshop))
    }))
}

async function refreshNativeScenePreviewStatus() {
    try {
        const result = await adminApi.getNativePreviewStatus()
        if (result?.error) {
            nativeScenePreviewConnected.value = false
            nativeScenePreviewStatus.value = 'Unity 实时连接检测失败'
            return
        }
        nativeScenePreviewConnected.value = Number(result.unityClients || 0) > 0
        nativeScenePreviewStatus.value = nativeScenePreviewConnected.value
            ? `Unity 实时同步已连接 · ${result.unityClients} 个客户端`
            : 'Unity 未运行，修改暂未发送'
    } catch (error) {
        nativeScenePreviewConnected.value = false
        nativeScenePreviewStatus.value = 'Unity 实时连接检测失败'
    } finally {
        nativeScenePreviewChecked.value = true
    }
}

async function refreshAdminConnectionStatus() {
    await Promise.allSettled([
        refreshNativeScenePreviewStatus(),
        loadEngineStatus()
    ])
}

async function sendNativeScenePreview(payload, { quiet = false } = {}) {
    const sequence = ++nativeScenePreviewSequence
    nativeScenePreviewBusy.value = true
    if (!quiet) nativeScenePreviewStatus.value = '正在实时应用到 Unity...'
    try {
        const result = await adminApi.sendNativePreview({
            sessionId: nativeScenePreviewSessionId,
            sequence,
            ...payload
        })
        if (sequence !== nativeScenePreviewSequence) return result
        if (result?.error) {
            nativeScenePreviewConnected.value = false
            nativeScenePreviewStatus.value = `Unity 实时同步失败：${result.error}`
            return result
        }
        nativeScenePreviewConnected.value = Number(result.unityClients || 0) > 0
        nativeScenePreviewStatus.value = nativeScenePreviewConnected.value
            ? '已实时应用到 Unity（尚未保存）'
            : 'Unity 未运行；启动后再次调整即可实时同步'
        return result
    } catch (error) {
        if (sequence === nativeScenePreviewSequence) {
            nativeScenePreviewConnected.value = false
            nativeScenePreviewStatus.value = `Unity 实时同步失败：${error?.message || '后端不可用'}`
        }
        return { error: error?.message || '后端不可用' }
    } finally {
        if (sequence === nativeScenePreviewSequence) nativeScenePreviewBusy.value = false
    }
}

function scheduleNativeScenePreview({ source = activeTab.value, includeLayout = false, deviceOverride } = {}) {
    if (!['composer', 'lines', 'spatial'].includes(source)) return
    nativeScenePreviewPending = {
        source,
        includeLayout: includeLayout || nativeScenePreviewPending?.includeLayout || false,
        deviceOverride: deviceOverride === undefined
            ? (nativeScenePreviewPending?.deviceOverride || null)
            : deviceOverride
    }
    if (nativeScenePreviewTimer) clearTimeout(nativeScenePreviewTimer)
    nativeScenePreviewTimer = setTimeout(() => {
        const pending = nativeScenePreviewPending
        nativeScenePreviewPending = null
        nativeScenePreviewTimer = null
        if (!pending) return
        sendNativeScenePreview({
            action: 'apply',
            source: pending.source,
            includeLayout: pending.includeLayout,
            devices: buildNativePreviewDevices(pending.source, pending.deviceOverride),
            lines: pending.includeLayout ? buildNativePreviewLines() : [],
            workshops: pending.includeLayout ? buildNativePreviewWorkshops() : [],
            focus: buildNativePreviewFocus(pending.source)
        }, { quiet: true })
    }, 90)
}

async function restoreSavedNativeScenePreview() {
    if (nativeScenePreviewTimer) clearTimeout(nativeScenePreviewTimer)
    nativeScenePreviewTimer = null
    nativeScenePreviewPending = null
    await sendNativeScenePreview({
        action: 'reset',
        source: activeTab.value,
        includeLayout: true,
        focus: buildNativePreviewFocus(activeTab.value)
    })
}

async function reloadSavedNativeScenePreview(source = activeTab.value) {
    await sendNativeScenePreview({
        action: 'reload',
        source,
        focus: buildNativePreviewFocus(source)
    }, { quiet: true })
}

function sendNativePreviewCameraAction(cameraAction) {
    return sendNativeScenePreview({
        action: 'camera',
        source: 'composer',
        cameraAction,
        focus: buildNativePreviewFocus('composer')
    }, { quiet: true })
}

function ensureSelectedLineEditor() {
    if (!lines.value.length) {
        selectedLineEditorId.value = ''
        return
    }
    if (!selectedLineEditorId.value || !lines.value.some(line => line.id === selectedLineEditorId.value)) {
        selectedLineEditorId.value = sortByOrder(lines.value)[0]?.id || ''
    }
}

async function loadLines() {
    const result = await adminApi.getLines()
    const normalizedLines = (Array.isArray(result) ? result : []).map(normalizeLineRecord)
    lines.value = normalizedLines
    savedLineLayoutSnapshots.value = Object.fromEntries(
        normalizedLines.map(line => [line.id, lineLayoutSnapshot(line)])
    )
    savedLinePlacementSnapshots.value = Object.fromEntries(
        normalizedLines.map(line => [line.id, linePlacementSnapshot(line)])
    )
    if (lines.value.length === 0 && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
    ensureSelectedLineEditor()
}

async function createLine() {
    if (!newLine.id || !newLine.name || !newLine.workshop_id) return alert('请填写产线ID、名称和所属车间')
    const layout = defaultLineLayout()
    const siblingLines = sortByOrder(lines.value.filter(line => line.workshop_id === newLine.workshop_id))
    layout.placementPending = siblingLines.length > 0
    const result = await adminApi.createLine({
        id: newLine.id,
        name: newLine.name,
        workshop_id: newLine.workshop_id,
        layout_json: serializeLineLayout(layout),
        sort_order: lines.value.length
    })
    if (result?.error) return alert(result.error, { title: '新增产线失败', type: 'danger' })
    if (!result?.success) return alert('新增产线失败：后端没有返回成功状态', { title: '新增产线失败', type: 'danger' })
    const createdName = newLine.name
    const placementPending = layout.placementPending
    selectedLineEditorId.value = newLine.id
    newLine.id = ''
    newLine.name = ''
    await loadLines()
    await alert(
        placementPending
            ? `产线「${createdName}」已创建，位置暂定。请点击“产线在车间中的位置”前往布局画布手动放置。`
            : `产线「${createdName}」已创建，并已默认放置在车间中心。`,
        { title: '新增成功', type: 'success' }
    )
}

async function deleteLine(id) {
    const confirmation = await requestNamedDeletionConfirmation('产线', id, adminApi.getLineDeletionImpact)
    if (!confirmation) return
    let result
    try {
        result = await adminApi.deleteLine(id, confirmation.targetName)
    } catch (error) {
        return alert(error.message || '删除产线失败', { title: '删除产线失败', type: 'danger' })
    }
    if (result?.error) return alert(result.error, { title: '删除产线失败', type: 'danger' })
    if (!result?.success) return alert('删除产线失败：后端没有返回成功状态', { title: '删除产线失败', type: 'danger' })
    await loadLines()
    await loadDevices()
    await alert(`产线「${confirmation.targetName}」已删除`, { title: '删除成功', type: 'success' })
}

// ============ 设备管理 ============
const devices = ref([])
const savedDeviceLayoutSnapshots = ref({})
const showDeviceForm = ref(false)
const editingDeviceWorkshopId = ref('')
function defaultPlcConnectionConfig() {
    return {
        plc_enabled: 0,
        plc_protocol: 'S7',
        plc_ip: '',
        plc_port: 102,
        plc_options: {},
        plc_rack: 0,
        plc_slot: 1,
        plc_timeout: 5000,
        plc_retry_interval: 10000,
        plc_max_retries: 0
    }
}
const editingDevice = reactive({
    id: '', name: '', line_id: '', model_type: 'builtin_furnace', model_file: '', template_id: '', instance_config: '{}',
    pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1.0, coordinate_space: 'line_local', sort_order: 0,
    ...defaultPlcConnectionConfig()
})
const editingDeviceInspectionMode = ref('inherit')
const editingDeviceInspectionJson = ref('{}')
const isEditMode = ref(false)
const plcProtocolOptions = PLC_PROTOCOL_OPTIONS
const editingPlcProtocolDefinition = computed(() => getPlcProtocolDefinition(editingDevice.plc_protocol))
const editingPlcOptions = computed(() => normalizePlcOptions(editingDevice.plc_protocol, editingDevice.plc_options))
const editingPlcUsesRackSlot = computed(() => normalizePlcProtocol(editingDevice.plc_protocol) === 'S7')
const editingPlcUsesModbusOptions = computed(() => normalizePlcProtocol(editingDevice.plc_protocol) === 'MODBUS_TCP')
const editingPlcUsesOpcUaOptions = computed(() => normalizePlcProtocol(editingDevice.plc_protocol) === 'OPC_UA')

function setEditingPlcProtocol(protocol) {
    const normalized = normalizePlcProtocol(protocol)
    const definition = getPlcProtocolDefinition(normalized)
    const previousDefinition = getPlcProtocolDefinition(editingDevice.plc_protocol)
    editingDevice.plc_protocol = normalized
    if (!editingDevice.plc_port || Number(editingDevice.plc_port) === Number(previousDefinition.defaultPort)) {
        editingDevice.plc_port = definition.defaultPort
    }
    editingDevice.plc_options = normalizePlcOptions(normalized, editingDevice.plc_options)
}

function plcEndpointFieldLabel() {
    return normalizePlcProtocol(editingDevice.plc_protocol) === 'OPC_UA' ? '服务器地址 / IP' : 'PLC IP'
}

function plcEndpointPlaceholder() {
    return normalizePlcProtocol(editingDevice.plc_protocol) === 'OPC_UA' ? '192.168.1.20 或 opc.tcp://...' : '192.168.1.10'
}

function plcOptionValue(key, fallback = '') {
    return editingPlcOptions.value[key] ?? fallback
}

function setPlcOption(key, value) {
    editingDevice.plc_options = { ...editingPlcOptions.value, [key]: value }
}

function syncEditingDeviceInspectionState() {
    const inspection = parseInstanceConfig(editingDevice.instance_config).inspection
    if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) {
        editingDeviceInspectionMode.value = 'inherit'
        editingDeviceInspectionJson.value = '{}'
        return
    }
    if (inspection.enabled === false && Object.keys(inspection).length === 1) {
        editingDeviceInspectionMode.value = 'disabled'
        editingDeviceInspectionJson.value = JSON.stringify(inspection, null, 2)
        return
    }
    editingDeviceInspectionMode.value = 'override'
    editingDeviceInspectionJson.value = JSON.stringify(inspection, null, 2)
}

function copyModelInspectionToDevice() {
    const model = models.value.find(item => item.id === editingDevice.model_type)
    const inspection = parseModelMetadata(model).inspection
    if (!inspection || typeof inspection !== 'object') {
        return alert('当前模型还没有拆解检查配置，请先到“模型库 → 拆解检查”中配置')
    }
    editingDeviceInspectionMode.value = 'override'
    editingDeviceInspectionJson.value = JSON.stringify(normalizeModelInspection(inspection), null, 2)
}

async function loadDevices() {
    devices.value = await adminApi.getDevices()
    savedDeviceLayoutSnapshots.value = Object.fromEntries(
        devices.value.map(device => [device.id, deviceLayoutSnapshot(device)])
    )
}

function openCreateDevice() {
    isEditMode.value = false
    editingDeviceWorkshopId.value = workshops.value[0]?.id || ''
    Object.assign(editingDevice, { 
        id: '', name: '', line_id: placedLines.value[0]?.id || '',
        model_type: 'builtin_furnace', model_file: '', template_id: '', instance_config: '{}',
        pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0, scale: 1.0, coordinate_space: 'line_local', sort_order: devices.value.length,
        ...defaultPlcConnectionConfig()
    })
    syncEditingDeviceInspectionState()
    showDeviceForm.value = true
}

function openEditDevice(d) {
    isEditMode.value = true
    const normalized = normalizeDeviceConfig(d)
    Object.assign(editingDevice, { ...defaultPlcConnectionConfig(), ...normalized, line_id: normalized.line_id || '' })
    editingDeviceWorkshopId.value = getDeviceWorkshopId(editingDevice) || workshops.value[0]?.id || ''
    syncEditingDeviceInspectionState()
    showDeviceForm.value = true
}

async function saveDevice() {
    if (!editingDevice.id || !editingDevice.name) {
        return alert('请填写设备ID和名称')
    }
    const isAuxiliary = isAuxiliaryDeviceConfig(editingDevice)
    if (!isAuxiliary && !editingDevice.line_id) {
        return alert('普通设备必须选择所属产线')
    }
    if (isAuxiliary && !editingDeviceWorkshopId.value) {
        return alert('辅助设备必须选择所在车间')
    }

    let parsedInstanceConfig = {}
    try {
        parsedInstanceConfig = parseEditableInstanceConfig(editingDevice.instance_config)
    } catch (e) {
        return alert('实例配置 JSON 格式不正确')
    }
    if (!isAuxiliary) {
        if (editingDeviceInspectionMode.value === 'inherit') {
            delete parsedInstanceConfig.inspection
        } else if (editingDeviceInspectionMode.value === 'disabled') {
            parsedInstanceConfig.inspection = { enabled: false }
        } else {
            let inspectionOverride
            try {
                inspectionOverride = JSON.parse(editingDeviceInspectionJson.value || '{}')
            } catch (e) {
                return alert('设备拆解覆盖 JSON 格式不正确')
            }
            if (!inspectionOverride || typeof inspectionOverride !== 'object' || Array.isArray(inspectionOverride)) {
                return alert('设备拆解覆盖必须是 JSON 对象')
            }
            parsedInstanceConfig.inspection = inspectionOverride
        }
    }
    const payload = buildDevicePayloadForSave({ ...editingDevice, instance_config: parsedInstanceConfig }, editingDeviceWorkshopId.value)
    let result
    if (isEditMode.value) {
        result = await adminApi.updateDevice(editingDevice.id, payload)
    } else {
        result = await adminApi.createDevice(payload)
    }
    if (result?.error) return alert(result.error, { title: '设备保存失败', type: 'danger' })
    if (!result?.success) return alert('设备保存失败：后端没有返回成功状态', { title: '设备保存失败', type: 'danger' })
    showDeviceForm.value = false
    await loadDevices()
    setTimeout(() => loadEngineStatus(), 800)
    await alert(`设备「${payload.name}」已保存`, { title: '保存成功', type: 'success' })
}

async function deleteDevice(id) {
    const confirmation = await requestNamedDeletionConfirmation('设备', id, adminApi.getDeviceDeletionImpact)
    if (!confirmation) return
    let result
    try {
        result = await adminApi.deleteDevice(id, confirmation.targetName)
    } catch (error) {
        return alert(error.message || '删除设备失败', { title: '删除失败', type: 'danger' })
    }
    if (result?.error) return alert(result.error, { title: '删除失败', type: 'danger' })
    if (!result?.success) return alert('删除失败：后端没有返回成功状态', { title: '删除失败', type: 'danger' })
    await loadDevices()
    setTimeout(() => loadEngineStatus(), 800)
    await alert(`设备「${confirmation.targetName}」已删除`, { title: '删除成功', type: 'success' })
}

const {
    selectedDeviceForMonitor,
    realtimePointRows,
    realtimePointDeviceStatus,
    monitorCurrentPage,
    monitorPageSize,
    totalMonitorPages,
    paginatedRealtimePointRows,
    displayedMonitorPageNumbers,
    realtimePointDeviceStatuses,
    realtimePointSnapshotAt,
    realtimePointLoading,
    realtimePointError,
    pointMonitorAutoRefresh,
    pointMonitorRefreshIntervalMs,
    selectedMonitorDevice,
    isAllPointMonitorMode,
    pointMonitorStatusSummary,
    ensurePointMonitorDevice,
    loadRealtimePointValues,
    startPointMonitor,
    stopPointMonitor
} = usePointMonitor({ devices, storedAdminUiState })

const {
    selectedDeviceForPoints,
    dataPoints,
    isPointsDirty,
    showPointAdvancedFields,
    loadedPointDeviceIds,
    alarmTextImportRaw,
    alarmTextFileInput,
    selectedVoicePointIndex,
    voiceFileInput,
    voiceUploadTarget,
    systemVoices,
    systemVoicesLoaded,
    systemVoicesLoading,
    voiceGeneratingRuleId,
    voiceUploadingRuleId,
    voiceTriggerOptions,
    selectedVoicePoint,
    pointUsageOptions,
    pointsCurrentPage,
    pointsPageSize,
    totalPointPages,
    paginatedDataPoints,
    displayedPageNumbers,
    pointDataTypes,
    alarmRecordRoleMeta,
    isAllPointsMode,
    normalizePointUsage,
    pointDisplayName,
    normalizeLoadedPoint,
    pointVoiceRules,
    enabledVoiceRuleCount,
    voiceRuleId,
    defaultVoiceText,
    addVoiceRule,
    removeVoiceRule,
    loadSystemVoices,
    openVoiceConfig,
    closeVoiceConfig,
    updateVoiceCooldown,
    voiceRuleNeedsThreshold,
    voiceRuleDeviceName,
    fillVoiceTemplate,
    previewVoiceRule,
    generateVoiceFile,
    selectVoiceFile,
    handleVoiceFileChange,
    loadDataPoints,
    addDataPoint,
    addAlarmTriggerPoint,
    removeDataPoint,
    markPointsDirty,
    isBoolPoint,
    getPointAddressPlaceholder,
    getPointAddressTitle,
    autoConvertPlcTagForDataType,
    getPlcDuplicateWarning,
    getPlcAddressWarning,
    handlePointDataTypeChange,
    composePlcAddressFromParts,
    toInternalPointName,
    inferPointCategory,
    setPointUsage,
    formatPointUsage,
    isTextPointType,
    getAlarmPointNumber,
    currentAlarmTriggerPoints,
    alarmRecordPointStatus,
    getNextAlarmPointIndex,
    parseAlarmText,
    parsedAlarmTextEntries,
    alarmTextImportSummary,
    fillAlarmTextTemplate,
    triggerAlarmTextFileSelect,
    handleAlarmTextFileChange,
    applyAlarmTextImport,
    ensureAlarmRecordPoints,
    validatePointRows,
    buildDataPointPayload,
    saveAllPoints,
    copyPointsFrom,
    syncToLine
} = useDataPoints({
    devices,
    alert,
    confirm,
    storedAdminUiState,
    loadEngineStatus,
    selectedDeviceForMonitor,
    loadRealtimePointValues
})

function formatModelName(modelType) {
    const model = availableModelOptions.value.find(item => item.id === modelType)
    return model?.name || modelType || '未设置'
}

// ============ 模型管理 ============
const models = ref([])
const modelPreviewRef = ref(null)
const modelFileInputRef = ref(null)
const selectedModelFile = ref(null)
const MODEL_LIBRARY_STEPS = [
    { key: 'library', label: '模型资产', description: '选择已有模型并查看交付状态' },
    { key: 'import', label: '导入模型', description: '上传 GLB / GLTF 并填写基础信息' },
    { key: 'optimization', label: '优化与验收', description: '优化材质、规范并发布模型' },
    { key: 'inspection', label: '拆解检查', description: '配置外壳、关键部件、镜头与点位上下文' },
    { key: 'bindings', label: '部位绑定', description: '把模型节点绑定到实时点位' }
]
const modelLibraryStep = ref(
    MODEL_LIBRARY_STEPS.some(step => step.key === storedAdminUiState.modelLibraryStep)
        ? storedAdminUiState.modelLibraryStep
        : 'library'
)
const selectedPreviewModelId = ref(storedAdminUiState.selectedPreviewModelId || '')
const modelPreviewStatus = ref('选择模型文件后在这里预览')
const modelUploading = ref(false)
const isModelPreviewActive = ref(false)
const defaultModelAssetSpec = {
    version: '1.0.0',
    device_family: '',
    unit: 'm',
    axis_rule: 'Y-up / Z-forward',
    max_triangles: 200000,
    max_nodes: 800,
    max_texture_size: 2048,
    lod_policy: 'LOD0 必须可用，LOD1/LOD2 可选',
    node_naming_rule: 'role_part_action，例如 fan_rear_rotate、door_front_lift、valve_gas_01',
    delivery_status: 'draft',
    owner: '',
    notes: ''
}
const defaultModelOptimization = {
    mode: 'auto',
    mergeStatic: true,
    instanceRepeated: true,
    preserveAnimated: true,
    materialEnhancement: 'auto',
    contactShadow: true,
    environmentIntensity: 0.85
}
const defaultModelInspection = {
    enabled: true,
    shell: { node_paths: [], node_names: [], opacity: 0.18, wireframe: false },
    solid: { view_id: '', camera: { yaw: 238, pitch: 19, distance_scale: 1.12, target_offset: [0, 0, 0] } },
    xray: { view_id: '', camera: { yaw: 238, pitch: 19, distance_scale: 1.08, target_offset: [0, .2, 0] } },
    exploded: { view_id: '', camera: { yaw: 238, pitch: 22, distance_scale: 1.22, target_offset: [0, .35, 0] } },
    animation_duration: .72,
    parts: []
}
const modelWorkflowStepLabels = {
    imported: '导入',
    parsed: '解析',
    specified: '规范',
    bound: '绑定',
    accepted: '验收',
    released: '发布'
}

function createDefaultModelMetadata() {
    return {
        batchable: true,
        optimization: { ...defaultModelOptimization },
        inspection: JSON.parse(JSON.stringify(defaultModelInspection)),
        assetSpec: { ...defaultModelAssetSpec },
        partBindings: [],
        acceptance: {
            status: 'draft',
            checked_at: '',
            checks: []
        },
        release: {
            version: '0.1.0',
            status: 'draft',
            published_at: ''
        }
    }
}

function defaultModelMetadataText() {
    return JSON.stringify(createDefaultModelMetadata(), null, 2)
}

const modelImportForm = reactive({
    id: '',
    name: '',
    default_scale: 1,
    metadata: defaultModelMetadataText()
})
const fallbackModelOptions = [
    { id: 'builtin_furnace', name: '内置炉子' },
    { id: 'box_atmosphere_furnace', name: '箱式气氛多用炉' },
    { id: 'transfer_cart', name: '轨道料车 / 取料小车' }
]
const availableModelOptions = computed(() => {
    const merged = new Map(fallbackModelOptions.map(model => [model.id, model]))
    models.value.forEach(model => merged.set(model.id, { ...model }))
    return Array.from(merged.values())
})

const selectedModelFileSizeText = computed(() => {
    if (!selectedModelFile.value) return ''
    const mb = selectedModelFile.value.size / 1024 / 1024
    return `${mb.toFixed(mb >= 10 ? 1 : 2)} MB`
})

let modelPreviewRuntime = null
let modelPreviewSource = null
let modelPreviewModel = null
let selectedModelObjectUrl = ''
let modelPreviewNodeMap = new Map()
let modelPreviewSelectionBox = null
let modelPreviewHighlightState = null
let modelPreviewRootObject = null
let modelPreviewAnimationState = null

const modelPreviewNodes = ref([])
const modelPreviewStats = reactive({
    loaded: false,
    nodeCount: 0,
    meshCount: 0,
    triangleCount: 0,
    materialCount: 0,
    textureCount: 0,
    maxTextureSize: 0,
    bounds: { x: 0, y: 0, z: 0 }
})
const modelPartBindings = ref([])
const modelAssetSpec = reactive({ ...defaultModelAssetSpec })
const modelOptimization = reactive({ ...defaultModelOptimization })
const modelInspection = reactive(JSON.parse(JSON.stringify(defaultModelInspection)))
const modelInspectionParts = ref([])
const selectedInspectionPartIndex = ref(-1)
const inspectionPreviewStage = ref('solid')
const inspectionPreviewState = ref(null)
const inspectionShellNodePath = ref('')
const inspectionShellEntries = computed(() => {
    const paths = Array.isArray(modelInspection.shell?.node_paths) ? modelInspection.shell.node_paths : []
    const names = Array.isArray(modelInspection.shell?.node_names) ? modelInspection.shell.node_names : []
    const entries = paths.map((path, index) => ({
        key: `path:${path}`,
        path,
        name: names[index] || ''
    }))
    const representedNames = new Set(entries.map(entry => entry.name).filter(Boolean))
    names.forEach((name) => {
        if (!name || representedNames.has(name)) return
        entries.push({ key: `name:${name}`, path: '', name })
    })
    return entries
})
const inspectionPartForm = reactive({
    id: '', name: '', node_path: '', node_name: '', description: '',
    explode_x: 0, explode_y: 0, explode_z: 0,
    point_keys_text: '', detail_view_id: ''
})
const selectedModelNodePath = ref('')
const modelNodeSearchText = ref('')
const showOnlyBindableNodes = ref(true)
const selectedModelBindingIndex = ref(-1)
const previewModelBindingIndex = ref(-1)
const modelBindingSaving = ref(false)
const modelBindingStatus = ref('')
const modelBindingForm = reactive({
    id: '',
    name: '',
    node_path: '',
    source_group: 'analog',
    source_key: '',
    action: 'rotate_speed',
    axis: 'y',
    input_min: 0,
    input_max: 100,
    output_min: 0,
    output_max: 90,
    speed_factor: 0.10472,
    on_color: '#00ff88',
    off_color: '#666666',
    invert: false
})
const modelSourceGroups = [
    { value: 'analog', label: '模拟量' },
    { value: 'motors', label: '电机' },
    { value: 'doors', label: '炉门' },
    { value: 'gas', label: '气体' },
    { value: 'mechanisms', label: '机构' },
    { value: 'status', label: '状态' }
]
const modelBindingActions = [
    { value: 'rotate_speed', label: '按转速连续旋转' },
    { value: 'rotate_angle', label: '按数值转角' },
    { value: 'translate', label: '按数值平移' },
    { value: 'visibility', label: '按布尔显示' },
    { value: 'color', label: '按布尔变色' }
]
const modelBindingAxes = [
    { value: 'x', label: 'X' },
    { value: 'y', label: 'Y' },
    { value: 'z', label: 'Z' }
]
const filteredModelPreviewNodes = computed(() => {
    const keyword = String(modelNodeSearchText.value || '').trim().toLowerCase()
    return modelPreviewNodes.value.filter((node) => {
        if (showOnlyBindableNodes.value && Number(node.meshCount || 0) <= 0) return false
        if (!keyword) return true
        const haystack = `${node.displayName || ''} ${node.name || ''} ${node.path || ''}`.toLowerCase()
        return haystack.includes(keyword)
    })
})
const selectedModelNodeInfo = computed(() => {
    if (!selectedModelNodePath.value) return null
    const node = modelPreviewNodes.value.find(item => item.path === selectedModelNodePath.value)
    if (!node) return null
    const target = modelPreviewNodeMap.get(node.path)
    let sizeText = ''
    if (target) {
        const box = new THREE.Box3().setFromObject(target)
        if (!box.isEmpty()) {
            const size = box.getSize(new THREE.Vector3())
            sizeText = `${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`
        }
    }
    return {
        ...node,
        sizeText
    }
})
const modelNodeNameTranslations = {
    complex_box_atmosphere_multipurpose_furnace_low_poly_merged_by_material: '箱式气氛多用炉低模（按材质合并）',
    merged_warm_light_gray_shell: '浅灰炉体外壳',
    merged_dark_heat_resistant_panel: '深色耐热面板',
    merged_hot_rear_chamber_glow: '后室高温发光区',
    merged_amber_observation_glass: '琥珀色观察窗',
    merged_safety_yellow_gas_pipe: '安全黄色气体管路',
    merged_black_lift_door: '黑色升降炉门',
    merged_brushed_steel_motor: '拉丝钢电机',
    merged_industrial_blue_quench_tank: '工业蓝淬火油槽',
    merged_dark_quench_oil: '深色淬火油',
    merged_dark_steel_rail: '深色钢轨',
    merged_active_green_components: '绿色运行部件'
}
const modelNodeTokenTranslations = {
    complex: '复杂',
    box: '箱式',
    atmosphere: '气氛',
    multipurpose: '多用',
    furnace: '炉',
    low: '低',
    poly: '多边形',
    merged: '合并',
    by: '按',
    material: '材质',
    warm: '暖色',
    light: '浅',
    gray: '灰',
    shell: '外壳',
    dark: '深色',
    heat: '热',
    resistant: '耐',
    panel: '面板',
    hot: '高温',
    rear: '后室',
    chamber: '炉室',
    glow: '发光区',
    amber: '琥珀色',
    observation: '观察',
    glass: '玻璃',
    safety: '安全',
    yellow: '黄色',
    gas: '气体',
    pipe: '管路',
    black: '黑色',
    lift: '升降',
    door: '门',
    brushed: '拉丝',
    steel: '钢',
    motor: '电机',
    industrial: '工业',
    blue: '蓝色',
    quench: '淬火',
    tank: '油槽',
    oil: '油',
    rail: '轨道',
    active: '运行',
    green: '绿色',
    components: '部件'
}
const modelNodeTypeTranslations = {
    Object3D: '对象组',
    Group: '分组',
    Mesh: '网格',
    SkinnedMesh: '蒙皮网格',
    Bone: '骨骼',
    Scene: '场景',
    PerspectiveCamera: '透视相机',
    OrthographicCamera: '正交相机'
}

function resolveModelBindingTarget(binding) {
    if (!binding) return null
    if (binding.node_path && modelPreviewNodeMap.has(binding.node_path)) return modelPreviewNodeMap.get(binding.node_path)
    const nodeName = String(binding.node_name || binding.nodeName || '').trim()
    if (!nodeName) return null
    for (const target of modelPreviewNodeMap.values()) {
        if (target?.name === nodeName) return target
    }
    return null
}

function countUnresolvedModelBindings() {
    return modelPartBindings.value.filter(binding => !resolveModelBindingTarget(binding)).length
}

const activePreviewModel = computed(() => getActivePreviewModel())
// A packaged built-in GLB is still a real configurable asset. Only procedural
// placeholders (which have no model file) must remain read-only.
const canEditModelBindings = computed(() => !!activePreviewModel.value?.file_path)

function modelLibraryStepRequiresModel(step) {
    return step === 'optimization' || step === 'inspection' || step === 'bindings'
}

async function selectModelLibraryStep(step) {
    if (!MODEL_LIBRARY_STEPS.some(item => item.key === step)) return
    if (modelLibraryStepRequiresModel(step) && !activePreviewModel.value) return
    modelLibraryStep.value = step
    await nextTick()
    await renderSelectedModelPreview()
}

const modelOptimizationEstimate = computed(() => {
    if (modelOptimization.mode === 'off') return '已关闭：模型将按原始节点逐个渲染'
    const meshes = Math.max(0, Number(modelPreviewStats.meshCount) || 0)
    const materials = Math.max(1, Number(modelPreviewStats.materialCount) || 1)
    const bindings = Math.max(0, modelPartBindings.value.length)
    const estimatedStaticParts = modelOptimization.mergeStatic
        ? Math.min(Math.max(0, meshes - bindings), materials)
        : Math.max(0, meshes - bindings)
    const estimatedCalls = estimatedStaticParts + bindings
    return `预计单台从约 ${meshes || '-'} 个网格压到约 ${estimatedCalls || '-'} 个静态/活动渲染组；同型多台会进一步共享静态绘制`
})
const modelAcceptanceChecks = computed(() => {
    const model = activePreviewModel.value
    const maxTriangles = Number(modelAssetSpec.max_triangles || defaultModelAssetSpec.max_triangles)
    const maxNodes = Number(modelAssetSpec.max_nodes || defaultModelAssetSpec.max_nodes)
    const maxTextureSize = Number(modelAssetSpec.max_texture_size || defaultModelAssetSpec.max_texture_size)
    const checks = [
        {
            id: 'uploaded_glb',
            label: '上传模型文件',
            required: true,
            passed: !!model?.file_path && !model?.is_builtin,
            detail: model?.file_path || '内置模型不能作为现场交付资产'
        },
        {
            id: 'preview_loaded',
            label: '预览可加载',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.meshCount > 0,
            detail: `${modelPreviewStats.meshCount} 个网格 / ${modelPreviewStats.nodeCount} 个节点`
        },
        {
            id: 'triangle_budget',
            label: '三角面预算',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.triangleCount <= maxTriangles,
            detail: `${formatModelNumber(modelPreviewStats.triangleCount)} / ${formatModelNumber(maxTriangles)}`
        },
        {
            id: 'node_budget',
            label: '节点数量预算',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.nodeCount <= maxNodes,
            detail: `${modelPreviewStats.nodeCount} / ${maxNodes}`
        },
        {
            id: 'texture_budget',
            label: '贴图尺寸预算',
            required: true,
            passed: modelPreviewStats.loaded && modelPreviewStats.maxTextureSize <= maxTextureSize,
            detail: modelPreviewStats.textureCount
                ? `${modelPreviewStats.textureCount} 张贴图，最大 ${modelPreviewStats.maxTextureSize}px`
                : '未检测到贴图'
        },
        {
            id: 'binding_nodes',
            label: '绑定节点可解析',
            required: true,
            passed: countUnresolvedModelBindings() === 0,
            detail: countUnresolvedModelBindings() === 0
                ? `${modelPartBindings.value.length} 条绑定`
                : `${countUnresolvedModelBindings()} 条绑定找不到节点`
        },
        {
            id: 'binding_keys',
            label: '绑定点位字段完整',
            required: true,
            passed: modelPartBindings.value.every(binding => binding.source_group && binding.source_key),
            detail: modelPartBindings.value.length ? '字段完整' : '暂无动作绑定'
        },
        {
            id: 'interactive_parts',
            label: '存在可动部位',
            required: false,
            passed: modelPartBindings.value.length > 0,
            detail: modelPartBindings.value.length ? `${modelPartBindings.value.length} 个可动部位` : '静态模型，仅可展示'
        }
    ]
    return checks
})
const modelAcceptanceSummary = computed(() => {
    const required = modelAcceptanceChecks.value.filter(item => item.required)
    const passed = required.filter(item => item.passed)
    const warnings = modelAcceptanceChecks.value.filter(item => !item.required && !item.passed)
    return {
        passed: passed.length,
        required: required.length,
        warnings: warnings.length,
        ready: required.length > 0 && passed.length === required.length
    }
})
const canAcceptModelAsset = computed(() => !!activePreviewModel.value && canEditModelBindings.value && modelAcceptanceSummary.value.ready)
const canPublishModelAsset = computed(() => canAcceptModelAsset.value && modelAssetSpec.delivery_status === 'accepted')
const modelAssetWorkflow = computed(() => {
    const model = activePreviewModel.value
    return [
        {
            id: 'imported',
            label: modelWorkflowStepLabels.imported,
            passed: !!model?.file_path && !model?.is_builtin,
            detail: model?.file_path ? '文件已入库' : '等待上传'
        },
        {
            id: 'parsed',
            label: modelWorkflowStepLabels.parsed,
            passed: modelPreviewStats.loaded && modelPreviewStats.meshCount > 0,
            detail: modelPreviewStats.loaded ? `${modelPreviewStats.nodeCount} 节点` : '等待预览'
        },
        {
            id: 'specified',
            label: modelWorkflowStepLabels.specified,
            passed: !!modelAssetSpec.device_family && !!modelAssetSpec.node_naming_rule,
            detail: modelAssetSpec.device_family || '未设置设备类型'
        },
        {
            id: 'bound',
            label: modelWorkflowStepLabels.bound,
            passed: modelPartBindings.value.length > 0,
            optional: true,
            detail: modelPartBindings.value.length ? `${modelPartBindings.value.length} 条动作` : '可先静态交付'
        },
        {
            id: 'accepted',
            label: modelWorkflowStepLabels.accepted,
            passed: ['accepted', 'released'].includes(modelAssetSpec.delivery_status),
            detail: modelAcceptanceSummary.value.ready ? '检查通过' : `${modelAcceptanceSummary.value.passed}/${modelAcceptanceSummary.value.required}`
        },
        {
            id: 'released',
            label: modelWorkflowStepLabels.released,
            passed: modelAssetSpec.delivery_status === 'released',
            detail: modelAssetSpec.version || '未发布'
        }
    ]
})
const modelReleaseHistory = computed(() => {
    const metadata = parseModelMetadata(activePreviewModel.value)
    const history = metadata.release?.history
    return Array.isArray(history) ? [...history].reverse() : []
})

async function loadModels() {
    models.value = await adminApi.getModels()
    if (selectedPreviewModelId.value && !getActivePreviewModel()) {
        selectedPreviewModelId.value = ''
        modelPreviewModel = null
        if (modelLibraryStepRequiresModel(modelLibraryStep.value)) modelLibraryStep.value = 'library'
    }
    const selected = getActivePreviewModel()
    if (selected && !modelPreviewModel) {
        modelPreviewModel = selected
        loadModelBindingState(selected)
    }
}

function makeModelIdFromFileName(fileName) {
    return fileName.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')
}

function stripModelNodeIndex(name) {
    return String(name || '').replace(/#\d+$/, '')
}

function translateModelNodeName(rawName) {
    const cleanName = stripModelNodeIndex(rawName)
    if (!cleanName) return '未命名节点'
    if (modelNodeNameTranslations[cleanName]) return modelNodeNameTranslations[cleanName]

    const words = cleanName
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .split(/[_\-\s]+/)
        .filter(Boolean)
    const translated = words.map(word => modelNodeTokenTranslations[word.toLowerCase()] || word)
    return translated.join('')
}

function formatModelNodeType(type) {
    return modelNodeTypeTranslations[type] || type || '节点'
}

function formatMeshCount(count) {
    const nextCount = Number(count) || 0
    return nextCount > 0 ? `${nextCount} 个网格` : '无网格'
}

function formatModelNumber(value) {
    const number = Number(value) || 0
    if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`
    return String(Math.round(number))
}

function formatModelBounds(bounds) {
    if (!bounds) return '-'
    return `${Number(bounds.x || 0).toFixed(2)} x ${Number(bounds.y || 0).toFixed(2)} x ${Number(bounds.z || 0).toFixed(2)}`
}

function formatAssetStatus(status) {
    const labels = {
        draft: '草稿',
        review: '待验收',
        accepted: '验收通过',
        released: '已发布'
    }
    return labels[status] || status || '草稿'
}

function getModelAssetStatus(model) {
    const metadata = parseModelMetadata(model)
    return metadata.assetSpec?.delivery_status || metadata.acceptance?.status || metadata.release?.status || 'draft'
}

function getModelBindingCount(model) {
    const metadata = parseModelMetadata(model)
    return Array.isArray(metadata.partBindings) ? metadata.partBindings.length : 0
}

function formatModelNodeOption(node) {
    return `${node.displayName || translateModelNodeName(node.name)} · ${formatModelNodeType(node.type)} · ${formatMeshCount(node.meshCount)}`
}

function formatModelBindingAction(actionValue) {
    return modelBindingActions.find(action => action.value === actionValue)?.label || actionValue || '未设置'
}

function formatModelSourceGroup(groupValue) {
    return modelSourceGroups.find(group => group.value === groupValue)?.label || groupValue || '未设置'
}

function formatModelAxis(axisValue) {
    return modelBindingAxes.find(axis => axis.value === axisValue)?.label || axisValue || '-'
}

function formatModelBindingPartName(binding) {
    if (binding?.name) return binding.name
    const node = modelPreviewNodes.value.find(item => item.path === binding?.node_path)
    if (node) return node.displayName || node.name
    const lastPathSegment = String(binding?.node_path || '').split('/').pop()
    return translateModelNodeName(lastPathSegment)
}

function getModelBindingPreviewLabel(binding) {
    return `${formatModelBindingAction(binding?.action)} · ${formatModelAxis(binding?.axis)} 轴`
}

function toPreviewNumber(value, fallback = 0) {
    if (typeof value === 'boolean') return value ? 1 : 0
    const next = Number(value)
    return Number.isFinite(next) ? next : fallback
}

function toPreviewBool(value) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return ['1', 'true', 'on', 'open', 'running', 'yes'].includes(value.toLowerCase())
    return !!value
}

function clampPreview01(value) {
    return Math.max(0, Math.min(1, value))
}

function mapPreviewRange(value, inMin, inMax, outMin, outMax) {
    const span = inMax - inMin
    const t = Math.abs(span) < 1e-6 ? 0 : clampPreview01((value - inMin) / span)
    return outMin + (outMax - outMin) * t
}

function normalizePreviewAxis(axis) {
    return ['x', 'y', 'z'].includes(axis) ? axis : 'y'
}

function disposeThreeObject(object) {
    if (!object) return
    object.traverse?.((child) => {
        if (child.element?.parentNode) child.element.parentNode.removeChild(child.element)
        if (child.geometry) child.geometry.dispose()
        const material = child.material
        if (Array.isArray(material)) {
            material.forEach(mat => mat.dispose?.())
        } else if (material) {
            material.dispose?.()
        }
    })
}

function disposeModelPreview(options = {}) {
    restoreInspectionPreviewStage()
    clearModelPreviewAnimation()
    if (modelPreviewRuntime) {
        cancelAnimationFrame(modelPreviewRuntime.frameId)
        modelPreviewRuntime.resizeObserver?.disconnect?.()
        modelPreviewRuntime.controls?.dispose?.()
        disposeThreeObject(modelPreviewRuntime.scene)
        modelPreviewRuntime.renderer?.dispose?.()
        const canvas = modelPreviewRuntime.renderer?.domElement
        if (canvas?.parentNode) canvas.parentNode.removeChild(canvas)
        modelPreviewRuntime = null
    }
    isModelPreviewActive.value = false
    modelPreviewNodes.value = []
    resetModelPreviewStats()
    if (options.revokeObjectUrl && selectedModelObjectUrl) {
        URL.revokeObjectURL(selectedModelObjectUrl)
        selectedModelObjectUrl = ''
    }
    modelPreviewNodeMap = new Map()
    modelPreviewSelectionBox = null
    modelPreviewHighlightState = null
    modelPreviewRootObject = null
    previewModelBindingIndex.value = -1
}

function fitPreviewCamera(camera, controls, object) {
    const box = new THREE.Box3().setFromObject(object)
    if (box.isEmpty()) {
        camera.position.set(4, 3, 6)
        controls.target.set(0, 0, 0)
        controls.update()
        return
    }

    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z, 1)
    const distance = maxDim * 1.75
    camera.near = Math.max(0.01, maxDim / 100)
    camera.far = Math.max(1000, maxDim * 20)
    camera.position.set(center.x + distance * 0.72, center.y + distance * 0.58, center.z + distance)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
}

function modelNodeSegment(object, index) {
    const rawName = object.name || object.type || 'Object3D'
    return `${String(rawName).replace(/\//g, '_')}#${index}`
}

function collectModelPreviewNodes(root) {
    const nodes = []
    const map = new Map()
    const walk = (object, parentPath) => {
        object.children.forEach((child, index) => {
            const path = parentPath ? `${parentPath}/${modelNodeSegment(child, index)}` : modelNodeSegment(child, index)
            const meshCount = countMeshes(child)
            const rawName = child.name || child.type || `Node ${nodes.length + 1}`
            nodes.push({
                path,
                name: rawName,
                displayName: translateModelNodeName(rawName),
                type: child.type || 'Object3D',
                meshCount
            })
            map.set(path, child)
            walk(child, path)
        })
    }
    walk(root, '')
    return { nodes, map }
}

function countMeshes(object) {
    let count = 0
    object.traverse?.((child) => {
        if (child.isMesh) count += 1
    })
    return count
}

function resetModelPreviewStats() {
    Object.assign(modelPreviewStats, {
        loaded: false,
        nodeCount: 0,
        meshCount: 0,
        triangleCount: 0,
        materialCount: 0,
        textureCount: 0,
        maxTextureSize: 0,
        bounds: { x: 0, y: 0, z: 0 }
    })
}

function collectModelPreviewStats(root) {
    const stats = {
        loaded: !!root,
        nodeCount: 0,
        meshCount: 0,
        triangleCount: 0,
        materialCount: 0,
        textureCount: 0,
        maxTextureSize: 0,
        bounds: { x: 0, y: 0, z: 0 }
    }
    const materials = new Set()
    const textures = new Set()
    root?.traverse?.((child) => {
        stats.nodeCount += 1
        if (!child.isMesh) return
        stats.meshCount += 1
        const geometry = child.geometry
        if (geometry) {
            if (geometry.index) {
                stats.triangleCount += Math.floor(geometry.index.count / 3)
            } else if (geometry.attributes?.position) {
                stats.triangleCount += Math.floor(geometry.attributes.position.count / 3)
            }
        }
        const materialList = Array.isArray(child.material) ? child.material : [child.material]
        materialList.filter(Boolean).forEach((material) => {
            materials.add(material)
            Object.values(material).forEach((value) => {
                if (!value?.isTexture || textures.has(value)) return
                textures.add(value)
                const image = value.image
                const width = Number(image?.width || 0)
                const height = Number(image?.height || 0)
                stats.maxTextureSize = Math.max(stats.maxTextureSize, width, height)
            })
        })
    })
    const box = new THREE.Box3().setFromObject(root)
    if (!box.isEmpty()) {
        const size = box.getSize(new THREE.Vector3())
        stats.bounds = { x: size.x, y: size.y, z: size.z }
    }
    stats.materialCount = materials.size
    stats.textureCount = textures.size
    Object.assign(modelPreviewStats, stats)
    return stats
}

function clearModelPreviewSelectionBox() {
    if (!modelPreviewSelectionBox || !modelPreviewRuntime?.scene) return
    modelPreviewRuntime.scene.remove(modelPreviewSelectionBox)
    modelPreviewSelectionBox.geometry?.dispose?.()
    modelPreviewSelectionBox.material?.dispose?.()
    modelPreviewSelectionBox = null
}

function restoreModelPreviewHighlight() {
    if (!modelPreviewHighlightState) return
    modelPreviewHighlightState.materials.forEach((entry) => {
        const material = entry.material
        if (!material) return
        if (entry.color && material.color) material.color.copy(entry.color)
        if (entry.emissive && material.emissive) material.emissive.copy(entry.emissive)
        material.opacity = entry.opacity
        material.transparent = entry.transparent
        material.depthWrite = entry.depthWrite
        material.needsUpdate = true
    })
    modelPreviewHighlightState = null
}

function restoreInspectionPreviewStage() {
    const state = inspectionPreviewState.value
    if (!state) return
    restorePreviewAnimationMaterials(state.materials || [])
    ;(state.targets || []).forEach((entry) => {
        if (!entry.target) return
        entry.target.position.copy(entry.position)
        entry.target.visible = entry.visible
    })
    inspectionPreviewState.value = null
}

function resolveInspectionPreviewTarget(part = {}) {
    if (part.node_path && modelPreviewNodeMap.has(part.node_path)) return modelPreviewNodeMap.get(part.node_path)
    const name = String(part.node_name || '')
    if (!name) return null
    for (const target of modelPreviewNodeMap.values()) {
        if (target?.name === name) return target
    }
    return null
}

function inspectionShellPreviewTargets() {
    const targets = []
    ;(modelInspection.shell?.node_paths || []).forEach((path) => {
        const target = modelPreviewNodeMap.get(path)
        if (target && !targets.includes(target)) targets.push(target)
    })
    ;(modelInspection.shell?.node_names || []).forEach((name) => {
        for (const target of modelPreviewNodeMap.values()) {
            if (target?.name === name && !targets.includes(target)) targets.push(target)
        }
    })
    if (!targets.length) {
        for (const target of modelPreviewNodeMap.values()) {
            const name = String(target?.name || '').toLowerCase()
            if (['shell', 'housing', 'casing', 'outer', 'enclosure', '外壳', '炉体'].some(token => name.includes(token))) targets.push(target)
        }
    }
    return targets
}

function applyInspectionPreviewStage(stage = 'solid') {
    inspectionPreviewStage.value = stage
    if (!modelPreviewRootObject) return
    clearModelPreviewAnimation()
    clearModelPreviewSelectionBox()
    restoreModelPreviewHighlight()
    restoreInspectionPreviewStage()

    const shellTargets = inspectionShellPreviewTargets()
    const partTargets = modelInspectionParts.value
        .map(part => ({ part, target: resolveInspectionPreviewTarget(part) }))
        .filter(entry => entry.target)
    const targets = [...new Set([...shellTargets, ...partTargets.map(entry => entry.target)])]
        .map(target => ({ target, position: target.position.clone(), visible: target.visible }))
    const materials = previewMaterialEntries(modelPreviewRootObject)
    inspectionPreviewState.value = { targets, materials }

    if (stage === 'xray') {
        const opacity = Number(modelInspection.shell?.opacity ?? .18)
        shellTargets.forEach((target) => collectPreviewMeshes(target).forEach((mesh) => {
            const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            list.filter(Boolean).forEach((material) => {
                material.transparent = true
                material.opacity = opacity
                material.depthWrite = false
                material.needsUpdate = true
            })
        }))
    } else if (stage === 'exploded') {
        shellTargets.forEach(target => { target.visible = false })
        partTargets.forEach(({ part, target }) => {
            const offset = normalizeInspectionVector(part.explode_offset)
            target.position.add(new THREE.Vector3(offset[0], offset[1], offset[2]))
        })
    }
    fitPreviewCamera(modelPreviewRuntime.camera, modelPreviewRuntime.controls, modelPreviewRootObject)
}

function collectPreviewMeshes(object) {
    const meshes = []
    object?.traverse?.((child) => {
        if (child.isMesh) meshes.push(child)
    })
    return meshes
}

function previewMaterialEntries(root) {
    const entries = []
    const seen = new Set()
    collectPreviewMeshes(root).forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            if (seen.has(material.uuid)) return
            seen.add(material.uuid)
            entries.push({
                material,
                color: material.color?.clone?.() || null,
                emissive: material.emissive?.clone?.() || null,
                opacity: material.opacity,
                transparent: material.transparent,
                depthWrite: material.depthWrite
            })
        })
    })
    return entries
}

function applyModelPreviewHighlight(target) {
    restoreModelPreviewHighlight()
    const root = modelPreviewRootObject
    if (!root || !target) return

    const targetMeshes = new Set(collectPreviewMeshes(target))
    const entries = previewMaterialEntries(root)
    modelPreviewHighlightState = { materials: entries }
    entries.forEach((entry) => {
        const material = entry.material
        if (!material) return
        material.transparent = true
        material.opacity = 0.16
        material.depthWrite = false
        material.needsUpdate = true
    })
    targetMeshes.forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            material.transparent = false
            material.opacity = 1
            material.depthWrite = true
            if (material.color) material.color.set('#f0b000')
            if (material.emissive) material.emissive.set('#6a3b00')
            material.needsUpdate = true
        })
    })
}

function capturePreviewAnimationMaterials(target) {
    const entries = []
    const seen = new Set()
    collectPreviewMeshes(target).forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            if (seen.has(material.uuid)) return
            seen.add(material.uuid)
            entries.push({
                material,
                color: material.color?.clone?.() || null,
                emissive: material.emissive?.clone?.() || null,
                opacity: material.opacity,
                transparent: material.transparent,
                depthWrite: material.depthWrite
            })
        })
    })
    return entries
}

function restorePreviewAnimationMaterials(entries = []) {
    entries.forEach((entry) => {
        const material = entry.material
        if (!material) return
        if (entry.color && material.color) material.color.copy(entry.color)
        if (entry.emissive && material.emissive) material.emissive.copy(entry.emissive)
        material.opacity = entry.opacity
        material.transparent = entry.transparent
        material.depthWrite = entry.depthWrite
        material.needsUpdate = true
    })
}

function applyPreviewColorToTarget(target, colorValue) {
    const color = new THREE.Color(colorValue)
    collectPreviewMeshes(target).forEach((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        materials.filter(Boolean).forEach((material) => {
            if (material.color) material.color.copy(color)
            if (material.emissive) material.emissive.copy(color)
            material.needsUpdate = true
        })
    })
}

function clearModelPreviewAnimation() {
    if (!modelPreviewAnimationState) return
    const { target, basePosition, baseRotation, baseVisible, materials } = modelPreviewAnimationState
    if (target) {
        target.position.copy(basePosition)
        target.rotation.copy(baseRotation)
        target.visible = baseVisible
    }
    restorePreviewAnimationMaterials(materials)
    modelPreviewAnimationState = null
}

function startModelPreviewAnimation(binding, target) {
    clearModelPreviewAnimation()
    if (!binding || !target) return
    modelPreviewAnimationState = {
        binding: normalizeModelBinding(binding),
        target,
        axis: normalizePreviewAxis(binding.axis),
        basePosition: target.position.clone(),
        baseRotation: target.rotation.clone(),
        baseVisible: target.visible,
        materials: capturePreviewAnimationMaterials(target),
        elapsed: 0
    }
}

function updateModelPreviewAnimation(delta) {
    if (!modelPreviewAnimationState) return
    const state = modelPreviewAnimationState
    const { binding, target, axis } = state
    state.elapsed += delta
    const action = binding.action || 'rotate_speed'

    if (action === 'rotate_speed') {
        const previewRpm = Math.max(
            12,
            Math.abs(toPreviewNumber(binding.input_max, 100)) || Math.abs(toPreviewNumber(binding.output_max, 90)) || 60
        )
        const factor = Number.isFinite(Number(binding.speed_factor)) ? Number(binding.speed_factor) : (Math.PI * 2 / 60)
        target.rotation[axis] += delta * previewRpm * factor
        return
    }

    const wave = (Math.sin(state.elapsed * Math.PI * 1.15) + 1) / 2
    const inputMin = toPreviewNumber(binding.input_min, 0)
    const inputMax = toPreviewNumber(binding.input_max, 100)
    const simulatedValue = inputMin + (inputMax - inputMin) * wave

    if (action === 'rotate_angle') {
        const angleDeg = mapPreviewRange(
            simulatedValue,
            inputMin,
            inputMax,
            toPreviewNumber(binding.output_min, 0),
            toPreviewNumber(binding.output_max, 90)
        )
        target.rotation[axis] = state.baseRotation[axis] + THREE.MathUtils.degToRad(angleDeg)
        return
    }

    if (action === 'translate') {
        const offset = mapPreviewRange(
            simulatedValue,
            inputMin,
            inputMax,
            toPreviewNumber(binding.output_min, 0),
            toPreviewNumber(binding.output_max, 1)
        )
        target.position[axis] = state.basePosition[axis] + offset
        return
    }

    if (action === 'visibility') {
        const visible = Math.floor(state.elapsed / 0.75) % 2 === 0
        target.visible = binding.invert ? !visible : visible
        return
    }

    if (action === 'color') {
        const on = toPreviewBool(Math.floor(state.elapsed / 0.75) % 2)
        applyPreviewColorToTarget(target, on ? (binding.on_color || '#00ff88') : (binding.off_color || '#666666'))
    }
}

function focusPreviewCameraOnNode(target) {
    if (!target || !modelPreviewRuntime?.camera || !modelPreviewRuntime?.controls) return
    const targetBox = new THREE.Box3().setFromObject(target)
    if (targetBox.isEmpty()) return

    const rootBox = modelPreviewRootObject ? new THREE.Box3().setFromObject(modelPreviewRootObject) : targetBox
    const targetCenter = targetBox.getCenter(new THREE.Vector3())
    const targetSize = targetBox.getSize(new THREE.Vector3())
    const rootSize = rootBox.getSize(new THREE.Vector3())
    const targetDim = Math.max(targetSize.x, targetSize.y, targetSize.z, 0.08)
    const rootDim = Math.max(rootSize.x, rootSize.y, rootSize.z, targetDim)
    const distance = Math.max(targetDim * 4.2, rootDim * 0.18)

    const camera = modelPreviewRuntime.camera
    const controls = modelPreviewRuntime.controls
    const currentDirection = camera.position.clone().sub(controls.target)
    if (currentDirection.lengthSq() < 0.001) currentDirection.set(0.8, 0.55, 1)
    currentDirection.normalize()
    camera.near = Math.max(0.01, targetDim / 100)
    camera.far = Math.max(1000, rootDim * 20)
    camera.position.copy(targetCenter).add(currentDirection.multiplyScalar(distance))
    camera.lookAt(targetCenter)
    camera.updateProjectionMatrix()
    controls.target.copy(targetCenter)
    controls.update()
}

function highlightPreviewNode(path) {
    selectedModelNodePath.value = path || ''
    clearModelPreviewAnimation()
    clearModelPreviewSelectionBox()
    restoreModelPreviewHighlight()
    if (!path || !modelPreviewRuntime?.scene) return
    const target = modelPreviewNodeMap.get(path)
    if (!target) return
    if (modelPreviewRuntime.controls) modelPreviewRuntime.controls.autoRotate = false
    applyModelPreviewHighlight(target)
    modelPreviewSelectionBox = new THREE.BoxHelper(target, 0xffb000)
    modelPreviewSelectionBox.name = 'model_preview_selected_part'
    modelPreviewRuntime.scene.add(modelPreviewSelectionBox)
    focusPreviewCameraOnNode(target)
}

function findPreviewNodePathByTarget(target) {
    for (const [path, object] of modelPreviewNodeMap.entries()) {
        if (object === target) return path
    }
    return ''
}

function highlightPreviewTarget(target) {
    const path = findPreviewNodePathByTarget(target)
    selectedModelNodePath.value = path
    clearModelPreviewAnimation()
    clearModelPreviewSelectionBox()
    restoreModelPreviewHighlight()
    if (!target || !modelPreviewRuntime?.scene) return
    if (modelPreviewRuntime.controls) modelPreviewRuntime.controls.autoRotate = false
    applyModelPreviewHighlight(target)
    modelPreviewSelectionBox = new THREE.BoxHelper(target, 0xffb000)
    modelPreviewSelectionBox.name = 'model_preview_selected_part'
    modelPreviewRuntime.scene.add(modelPreviewSelectionBox)
    focusPreviewCameraOnNode(target)
}

function resetModelPreviewCamera() {
    if (!modelPreviewRuntime?.camera || !modelPreviewRuntime?.controls || !modelPreviewRootObject) return
    fitPreviewCamera(modelPreviewRuntime.camera, modelPreviewRuntime.controls, modelPreviewRootObject)
    modelPreviewRuntime.controls.autoRotate = false
}

function createModelPreviewRuntime(container) {
    const rect = container.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width || 420))
    const height = Math.max(1, Math.round(rect.height || 320))
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf3f4f5)

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000)
    camera.position.set(4, 3, 6)

    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance'
    })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.className = 'model-preview-canvas'
    container.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.7

    scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8582, 1.45))
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.1)
    keyLight.position.set(6, 9, 7)
    scene.add(keyLight)
    const fillLight = new THREE.DirectionalLight(0xfff0d6, 0.75)
    fillLight.position.set(-7, 4, -5)
    scene.add(fillLight)

    const grid = new THREE.GridHelper(10, 10, 0xb6bec1, 0xd5dadc)
    grid.position.y = -0.01
    scene.add(grid)

    const runtime = {
        scene,
        camera,
        renderer,
        controls,
        frameId: 0,
        resizeObserver: null,
        updatables: [],
        lastFrameTime: performance.now()
    }
    const render = (now = performance.now()) => {
        const delta = Math.min((now - runtime.lastFrameTime) / 1000, 0.1)
        runtime.lastFrameTime = now
        runtime.updatables.forEach((object) => {
            if (object.visible !== false && object.update) object.update(delta)
        })
        updateModelPreviewAnimation(delta)
        controls.update()
        renderer.render(scene, camera)
        runtime.frameId = requestAnimationFrame(render)
    }
    runtime.frameId = requestAnimationFrame(render)

    if (typeof ResizeObserver !== 'undefined') {
        runtime.resizeObserver = new ResizeObserver(() => {
            const nextRect = container.getBoundingClientRect()
            const nextWidth = Math.max(1, Math.round(nextRect.width || width))
            const nextHeight = Math.max(1, Math.round(nextRect.height || height))
            camera.aspect = nextWidth / nextHeight
            camera.updateProjectionMatrix()
            renderer.setSize(nextWidth, nextHeight)
        })
        runtime.resizeObserver.observe(container)
    }

    return runtime
}

async function renderModelPreview(source) {
    modelPreviewSource = source
    await nextTick()
    const container = modelPreviewRef.value
    if (!container || !source?.url) return

    disposeModelPreview()
    const runtime = createModelPreviewRuntime(container)
    modelPreviewRuntime = runtime
    isModelPreviewActive.value = true
    modelPreviewStatus.value = `正在加载：${source.label}`

    try {
        const loader = new GLTFLoader()
        const gltf = await loader.loadAsync(source.url)
        if (modelPreviewSource !== source || modelPreviewRuntime !== runtime) {
            disposeThreeObject(gltf.scene)
            return
        }

        const root = gltf.scene || gltf.scenes?.[0]
        if (!root) throw new Error('模型文件中没有可显示的场景')
        root.traverse((child) => {
            if (!child.isMesh) return
            child.castShadow = false
            child.receiveShadow = false
        })
        runtime.scene.add(root)
        modelPreviewRootObject = root
        const { nodes, map } = collectModelPreviewNodes(root)
        modelPreviewNodes.value = nodes
        modelPreviewNodeMap = map
        collectModelPreviewStats(root)
        fitPreviewCamera(runtime.camera, runtime.controls, root)
        if (modelBindingForm.node_path) highlightPreviewNode(modelBindingForm.node_path)
        if (modelLibraryStep.value === 'inspection') applyInspectionPreviewStage(inspectionPreviewStage.value)
        const box = new THREE.Box3().setFromObject(root)
        const size = box.getSize(new THREE.Vector3())
        modelPreviewStatus.value = `预览：${source.label} | 尺寸 ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)}`
    } catch (e) {
        modelPreviewStatus.value = `预览失败：${e.message || e}`
    }
}

async function renderBuiltinModelPreview(model) {
    const source = { builtinId: model.id, label: model.name || model.id }
    modelPreviewSource = source
    await nextTick()
    const container = modelPreviewRef.value
    if (!container) return

    disposeModelPreview()
    const runtime = createModelPreviewRuntime(container)
    modelPreviewRuntime = runtime
    isModelPreviewActive.value = true
    modelPreviewStatus.value = `正在生成：${source.label}`

    try {
        const previewDevice = {
            id: `preview_${model.id}`,
            name: model.name || model.id,
            model_type: model.id,
            model_file: null,
            instance_config: '{}',
            pos_x: 0,
            pos_y: 0,
            pos_z: 0,
            rotation_y: 0,
            scale: Number(model.default_scale || 1)
        }
        const deviceModel = await createDeviceModel(previewDevice, [model])
        if (modelPreviewSource !== source || modelPreviewRuntime !== runtime) {
            disposeThreeObject(deviceModel)
            return
        }

        deviceModel.name = `${model.id}_preview_root`
        deviceModel.position.set(0, 0, 0)
        deviceModel.rotation.set(0, 0, 0)
        deviceModel.scale.setScalar(Number(model.default_scale || 1))
        deviceModel.setLabelVisible?.(false)
        runtime.scene.add(deviceModel)
        runtime.updatables.push(deviceModel)
        modelPreviewRootObject = deviceModel

        const { nodes, map } = collectModelPreviewNodes(deviceModel)
        modelPreviewNodes.value = nodes
        modelPreviewNodeMap = map
        collectModelPreviewStats(deviceModel)
        fitPreviewCamera(runtime.camera, runtime.controls, deviceModel)
        if (modelBindingForm.node_path) highlightPreviewNode(modelBindingForm.node_path)
        if (modelLibraryStep.value === 'inspection') applyInspectionPreviewStage(inspectionPreviewStage.value)
        const box = new THREE.Box3().setFromObject(deviceModel)
        const size = box.getSize(new THREE.Vector3())
        modelPreviewStatus.value = `预览：${source.label} | 尺寸 ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} | 内置程序化模型`
    } catch (e) {
        modelPreviewStatus.value = `内置模型预览失败：${e.message || e}`
    }
}

function getActivePreviewModel() {
    if (!selectedPreviewModelId.value) return null
    return models.value.find(model => model.id === selectedPreviewModelId.value)
        || fallbackModelOptions.find(model => model.id === selectedPreviewModelId.value)
        || modelPreviewModel
}

async function renderSelectedModelPreview() {
    if (activeTab.value !== 'models') return

    if (selectedModelFile.value && selectedModelObjectUrl) {
        await renderModelPreview({ url: selectedModelObjectUrl, label: selectedModelFile.value.name })
        return
    }

    const model = getActivePreviewModel()
    if (!model) {
        disposeModelPreview()
        modelPreviewSource = null
        modelPreviewStatus.value = '选择模型文件后在这里预览'
        return
    }

    if (!model.file_path) {
        await renderBuiltinModelPreview(model)
        return
    }

    await renderModelPreview({
        url: resolveBackendAssetUrl(model.file_path),
        label: model.name || model.id
    })
}

function parseModelMetadata(model) {
    if (!model?.metadata) return {}
    if (typeof model.metadata === 'object') return { ...model.metadata }
    try {
        return JSON.parse(model.metadata)
    } catch (e) {
        return {}
    }
}

function normalizeModelAssetSpec(spec = {}) {
    return {
        ...defaultModelAssetSpec,
        ...(spec || {}),
        max_triangles: Number(spec.max_triangles ?? defaultModelAssetSpec.max_triangles),
        max_nodes: Number(spec.max_nodes ?? defaultModelAssetSpec.max_nodes),
        max_texture_size: Number(spec.max_texture_size ?? defaultModelAssetSpec.max_texture_size)
    }
}

function normalizeModelOptimization(optimization = {}) {
    return {
        ...defaultModelOptimization,
        ...(optimization || {}),
        mode: ['auto', 'off'].includes(optimization?.mode) ? optimization.mode : defaultModelOptimization.mode,
        mergeStatic: optimization?.mergeStatic ?? optimization?.merge_static ?? defaultModelOptimization.mergeStatic,
        instanceRepeated: optimization?.instanceRepeated ?? optimization?.instance_repeated ?? defaultModelOptimization.instanceRepeated,
        preserveAnimated: true,
        materialEnhancement: ['auto', 'original'].includes(optimization?.materialEnhancement || optimization?.material_enhancement)
            ? (optimization.materialEnhancement || optimization.material_enhancement)
            : defaultModelOptimization.materialEnhancement,
        contactShadow: optimization?.contactShadow ?? optimization?.contact_shadow ?? defaultModelOptimization.contactShadow,
        environmentIntensity: Math.max(0, Math.min(2, Number(
            optimization?.environmentIntensity
            ?? optimization?.environment_intensity
            ?? defaultModelOptimization.environmentIntensity
        )))
    }
}

function normalizeInspectionVector(value, fallback = [0, 0, 0]) {
    const source = Array.isArray(value) ? value : fallback
    return [0, 1, 2].map(index => Number(source[index] ?? fallback[index] ?? 0) || 0)
}

function normalizeInspectionCamera(camera = {}, fallback = {}) {
    return {
        yaw: Number(camera.yaw ?? fallback.yaw ?? 238),
        pitch: Number(camera.pitch ?? fallback.pitch ?? 19),
        distance_scale: Number(camera.distance_scale ?? camera.distanceScale ?? fallback.distance_scale ?? 1.12),
        target_offset: normalizeInspectionVector(camera.target_offset || camera.targetOffset, fallback.target_offset || [0, 0, 0])
    }
}

function normalizeInspectionPart(part = {}, index = 0) {
    const explode = normalizeInspectionVector(part.explode_offset || part.explodeOffset)
    return {
        id: String(part.id || `part_${index + 1}`),
        name: String(part.name || part.node_name || part.nodeName || `部件 ${index + 1}`),
        node_path: String(part.node_path || part.nodePath || ''),
        node_name: String(part.node_name || part.nodeName || ''),
        explode_offset: explode,
        label_offset: normalizeInspectionVector(part.label_offset || part.labelOffset, [0, .35, 0]),
        description: String(part.description || ''),
        point_ids: Array.isArray(part.point_ids || part.pointIds) ? [...(part.point_ids || part.pointIds)].map(String) : [],
        point_keys: Array.isArray(part.point_keys || part.pointKeys) ? [...(part.point_keys || part.pointKeys)].map(String) : [],
        detail_view_id: String(part.detail_view_id || part.detailViewId || '')
    }
}

function normalizeModelInspection(inspection = {}) {
    const shell = inspection.shell || {}
    const normalizeStage = (source, fallback) => ({
        view_id: String(source?.view_id ?? source?.viewId ?? fallback.view_id ?? ''),
        camera: normalizeInspectionCamera(source?.camera || {}, fallback.camera)
    })
    return {
        enabled: inspection.enabled !== false,
        shell: {
            node_paths: Array.isArray(shell.node_paths || shell.nodePaths) ? [...(shell.node_paths || shell.nodePaths)].map(String) : [],
            node_names: Array.isArray(shell.node_names || shell.nodeNames) ? [...(shell.node_names || shell.nodeNames)].map(String) : [],
            opacity: Math.max(.03, Math.min(.95, Number(shell.opacity ?? defaultModelInspection.shell.opacity))),
            wireframe: !!shell.wireframe
        },
        solid: normalizeStage(inspection.solid, defaultModelInspection.solid),
        xray: normalizeStage(inspection.xray, defaultModelInspection.xray),
        exploded: normalizeStage(inspection.exploded, defaultModelInspection.exploded),
        animation_duration: Math.max(.05, Math.min(5, Number(inspection.animation_duration ?? inspection.animationDuration ?? .72))),
        parts: (Array.isArray(inspection.parts) ? inspection.parts : []).map(normalizeInspectionPart)
    }
}

function loadModelInspectionState(model) {
    const metadata = parseModelMetadata(model)
    const normalized = normalizeModelInspection(metadata.inspection || {})
    Object.assign(modelInspection, normalized)
    modelInspection.shell = normalized.shell
    modelInspection.solid = normalized.solid
    modelInspection.xray = normalized.xray
    modelInspection.exploded = normalized.exploded
    modelInspectionParts.value = normalized.parts
    modelInspection.parts = modelInspectionParts.value
    selectedInspectionPartIndex.value = -1
    inspectionPreviewStage.value = 'solid'
    resetInspectionPartForm()
}

function resetInspectionPartForm() {
    Object.assign(inspectionPartForm, {
        id: '', name: '', node_path: selectedModelNodePath.value || '', node_name: '',
        description: '', explode_x: 0, explode_y: 0, explode_z: 0,
        point_keys_text: '', detail_view_id: ''
    })
    selectedInspectionPartIndex.value = -1
}

function editInspectionPart(index) {
    const part = modelInspectionParts.value[index]
    if (!part) return
    const explode = normalizeInspectionVector(part.explode_offset)
    Object.assign(inspectionPartForm, {
        id: part.id,
        name: part.name,
        node_path: part.node_path,
        node_name: part.node_name,
        description: part.description,
        explode_x: explode[0],
        explode_y: explode[1],
        explode_z: explode[2],
        point_keys_text: (part.point_keys || []).join(', '),
        detail_view_id: part.detail_view_id || ''
    })
    selectedInspectionPartIndex.value = index
    selectPreviewNode(part.node_path)
}

function saveInspectionPartDraft() {
    const path = inspectionPartForm.node_path || selectedModelNodePath.value
    const node = modelPreviewNodes.value.find(item => item.path === path)
    if (!path && !inspectionPartForm.node_name) return alert('请先选择模型部件节点')
    const part = normalizeInspectionPart({
        id: inspectionPartForm.id || `part_${Date.now()}`,
        name: inspectionPartForm.name || node?.displayName || node?.name,
        node_path: path,
        node_name: inspectionPartForm.node_name || node?.name || '',
        explode_offset: [inspectionPartForm.explode_x, inspectionPartForm.explode_y, inspectionPartForm.explode_z],
        description: inspectionPartForm.description,
        point_keys: String(inspectionPartForm.point_keys_text || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
        detail_view_id: inspectionPartForm.detail_view_id
    }, selectedInspectionPartIndex.value)
    if (selectedInspectionPartIndex.value >= 0) modelInspectionParts.value.splice(selectedInspectionPartIndex.value, 1, part)
    else modelInspectionParts.value.push(part)
    modelInspection.parts = modelInspectionParts.value
    resetInspectionPartForm()
    applyInspectionPreviewStage('exploded')
}

function removeInspectionPart(index) {
    modelInspectionParts.value.splice(index, 1)
    modelInspection.parts = modelInspectionParts.value
    resetInspectionPartForm()
    applyInspectionPreviewStage(inspectionPreviewStage.value)
}

function addInspectionShellNode() {
    const path = inspectionShellNodePath.value || selectedModelNodePath.value
    const node = modelPreviewNodes.value.find(item => item.path === path)
    if (!path || !node) return alert('请先选择外壳节点')
    modelInspection.shell.node_paths = [...new Set([...(modelInspection.shell.node_paths || []), path])]
    modelInspection.shell.node_names = [...new Set([...(modelInspection.shell.node_names || []), node.name])]
    inspectionShellNodePath.value = ''
    applyInspectionPreviewStage('xray')
}

function removeInspectionShellNode(index) {
    const entry = typeof index === 'number' ? inspectionShellEntries.value[index] : index
    if (!entry) return
    const pathIndex = entry.path ? modelInspection.shell.node_paths.indexOf(entry.path) : -1
    const nameIndex = entry.name ? modelInspection.shell.node_names.indexOf(entry.name) : -1
    if (pathIndex >= 0) modelInspection.shell.node_paths.splice(pathIndex, 1)
    if (nameIndex >= 0) modelInspection.shell.node_names.splice(nameIndex, 1)
    applyInspectionPreviewStage(inspectionPreviewStage.value)
}

function selectInspectionShellNode(entry) {
    const node = modelPreviewNodes.value.find(item => (
        (entry?.path && item.path === entry.path)
        || (entry?.name && item.name === entry.name)
    ))
    selectPreviewNode(node?.path || entry?.path || '')
}

function loadModelAssetSpec(model) {
    const metadata = parseModelMetadata(model)
    Object.assign(modelAssetSpec, normalizeModelAssetSpec(metadata.assetSpec || metadata.asset_spec || {}))
    Object.assign(modelOptimization, normalizeModelOptimization(
        metadata.optimization || (metadata.batchable === false ? { mode: 'off' } : {})
    ))
}

function makeAcceptanceSnapshot(status = modelAssetSpec.delivery_status || 'draft') {
    return {
        status,
        checked_at: new Date().toISOString(),
        stats: {
            nodeCount: modelPreviewStats.nodeCount,
            meshCount: modelPreviewStats.meshCount,
            triangleCount: modelPreviewStats.triangleCount,
            materialCount: modelPreviewStats.materialCount,
            textureCount: modelPreviewStats.textureCount,
            maxTextureSize: modelPreviewStats.maxTextureSize,
            bounds: modelPreviewStats.bounds
        },
        checks: modelAcceptanceChecks.value.map(item => ({
            id: item.id,
            label: item.label,
            required: item.required,
            passed: item.passed,
            detail: item.detail
        }))
    }
}

function normalizeSaveOverrides(overrides = {}) {
    if (!overrides || typeof overrides !== 'object') return {}
    if (typeof overrides.preventDefault === 'function') return {}
    return overrides
}

function buildCurrentModelMetadata(model, overrides = {}) {
    overrides = normalizeSaveOverrides(overrides)
    const metadata = parseModelMetadata(model)
    const normalizedPartBindings = dedupeModelBindings(modelPartBindings.value)
    const assetSpec = normalizeModelAssetSpec({
        ...(metadata.assetSpec || {}),
        ...modelAssetSpec,
        ...(overrides.assetSpec || {})
    })
    const existingRelease = metadata.release || {}
    const release = {
        version: overrides.releaseVersion || assetSpec.version || existingRelease.version || '0.1.0',
        status: overrides.releaseStatus || assetSpec.delivery_status || existingRelease.status || 'draft',
        published_at: overrides.publishedAt || existingRelease.published_at || '',
        history: Array.isArray(existingRelease.history) ? existingRelease.history : []
    }
    return {
        ...metadata,
        schema_version: 1,
        batchable: metadata.batchable ?? true,
        optimization: normalizeModelOptimization(modelOptimization),
        inspection: normalizeModelInspection(modelInspection),
        assetSpec,
        partBindings: normalizedPartBindings,
        acceptance: overrides.acceptance || makeAcceptanceSnapshot(assetSpec.delivery_status),
        release,
        runtime: {
            ...(metadata.runtime || {}),
            enableGenericBindings: normalizedPartBindings.length > 0
        }
    }
}

async function persistModelMetadata(model, metadata, successMessage) {
    const result = await adminApi.updateModel(model.id, {
        name: model.name,
        tags: model.tags,
        default_scale: model.default_scale,
        metadata: JSON.stringify(metadata)
    })
    if (result.error) throw new Error(result.error)
    if (!result.success) throw new Error('后端没有返回成功状态')
    await loadModels()
    const updated = models.value.find(item => item.id === model.id) || result.model || model
    modelPreviewModel = updated
    selectedPreviewModelId.value = updated.id
    loadModelBindingState(updated)
    modelBindingStatus.value = successMessage
    return updated
}

function normalizeModelBinding(binding = {}) {
    return {
        id: binding.id || `binding_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name: binding.name || '',
        node_path: binding.node_path || '',
        node_name: binding.node_name || '',
        source_group: binding.source_group || binding.category || 'analog',
        source_key: binding.source_key || binding.value_role || binding.key || '',
        action: binding.action || 'rotate_speed',
        axis: binding.axis || 'y',
        input_min: Number(binding.input_min ?? 0),
        input_max: Number(binding.input_max ?? 100),
        output_min: Number(binding.output_min ?? 0),
        output_max: Number(binding.output_max ?? 90),
        speed_factor: Number(binding.speed_factor ?? 0.10472),
        on_color: binding.on_color || '#00ff88',
        off_color: binding.off_color || '#666666',
        invert: !!binding.invert
    }
}

function getModelBindingSignature(binding = {}) {
    const normalized = normalizeModelBinding(binding)
    const nodeIdentity = String(normalized.node_path || normalized.node_name || '').trim()
    const sourceIdentity = `${normalized.source_group}.${normalized.source_key}`.trim()
    if (!nodeIdentity || !normalized.source_key) return ''
    return [
        nodeIdentity,
        sourceIdentity,
        normalized.action,
        normalized.axis
    ].join('|').toLowerCase()
}

function dedupeModelBindings(bindings = []) {
    const result = []
    const indexBySignature = new Map()
    bindings.map(normalizeModelBinding).forEach((binding) => {
        const signature = getModelBindingSignature(binding)
        if (!signature) {
            result.push(binding)
            return
        }
        if (indexBySignature.has(signature)) {
            result[indexBySignature.get(signature)] = binding
            return
        }
        indexBySignature.set(signature, result.length)
        result.push(binding)
    })
    return result
}

function upsertModelBinding(binding, editingIndex = -1) {
    const signature = getModelBindingSignature(binding)
    let duplicateCount = 0
    const nextBindings = modelPartBindings.value
        .map(normalizeModelBinding)
        .filter((item, index) => {
            if (index === editingIndex) return false
            if (signature && getModelBindingSignature(item) === signature) {
                duplicateCount += 1
                return false
            }
            return true
        })
    nextBindings.push(binding)
    modelPartBindings.value = dedupeModelBindings(nextBindings)
    return duplicateCount
}

function resetModelBindingForm() {
    Object.assign(modelBindingForm, normalizeModelBinding({
        id: '',
        name: '',
        node_path: selectedModelNodePath.value || '',
        source_group: 'analog',
        source_key: '',
        action: 'rotate_speed',
        axis: 'y'
    }))
    selectedModelBindingIndex.value = -1
}

function loadModelBindingState(model) {
    loadModelAssetSpec(model)
    loadModelInspectionState(model)
    const metadata = parseModelMetadata(model)
    const rawBindings = Array.isArray(metadata.partBindings)
        ? metadata.partBindings.map(normalizeModelBinding)
        : []
    modelPartBindings.value = dedupeModelBindings(rawBindings)
    selectedModelNodePath.value = ''
    modelBindingStatus.value = model?.file_path
        ? `已读取 ${modelPartBindings.value.length} 条部位绑定${rawBindings.length !== modelPartBindings.value.length ? `，已合并 ${rawBindings.length - modelPartBindings.value.length} 条重复绑定` : ''}`
        : '内置程序化模型不可编辑部位绑定'
    resetModelBindingForm()
}

function selectPreviewNode(path) {
    selectedModelNodePath.value = path || ''
    modelBindingForm.node_path = path || ''
    const node = modelPreviewNodes.value.find(item => item.path === path)
    if (node && !modelBindingForm.name) modelBindingForm.name = node.displayName || node.name
    if (modelLibraryStep.value === 'inspection') {
        inspectionPartForm.node_path = path || ''
        inspectionPartForm.node_name = node?.name || ''
        if (node && !inspectionPartForm.name) inspectionPartForm.name = node.displayName || node.name
    }
    highlightPreviewNode(path)
}

function editModelBinding(index) {
    const binding = modelPartBindings.value[index]
    if (!binding) return
    Object.assign(modelBindingForm, normalizeModelBinding(binding))
    selectedModelBindingIndex.value = index
    previewModelBinding(index)
}

async function removeModelBinding(index) {
    const binding = modelPartBindings.value[index]
    if (!binding) return
    const bindingName = formatModelBindingPartName(binding)
    if (!(await confirm(`确定删除部位绑定「${bindingName}」？\n\n删除后会立即保存到模型资产。`, { title: '删除部位绑定', type: 'warning' }))) return

    const previousBindings = modelPartBindings.value.map(item => normalizeModelBinding(item))
    const previousPreviewIndex = previewModelBindingIndex.value
    const previousEditingIndex = selectedModelBindingIndex.value

    if (previewModelBindingIndex.value === index) {
        clearModelPreviewAnimation()
        previewModelBindingIndex.value = -1
    } else if (previewModelBindingIndex.value > index) {
        previewModelBindingIndex.value -= 1
    }
    modelPartBindings.value.splice(index, 1)
    if (selectedModelBindingIndex.value === index) resetModelBindingForm()
    else if (selectedModelBindingIndex.value > index) selectedModelBindingIndex.value -= 1
    modelBindingStatus.value = `正在删除并保存「${bindingName}」...`

    const saved = await saveModelPartBindings({
        showAlert: false,
        successMessage: `已删除部位绑定「${bindingName}」`
    })
    if (saved) {
        await alert(`部位绑定「${bindingName}」已删除并保存`, { title: '删除成功', type: 'success' })
        return
    }

    modelPartBindings.value = previousBindings
    previewModelBindingIndex.value = previousPreviewIndex
    selectedModelBindingIndex.value = previousEditingIndex
    modelBindingStatus.value = `删除失败，已恢复「${bindingName}」`
}

function previewModelBinding(index) {
    const binding = modelPartBindings.value[index]
    if (!binding) return
    const normalized = normalizeModelBinding(binding)
    const target = resolveModelBindingTarget(normalized)
    previewModelBindingIndex.value = index

    if (!target) {
        clearModelPreviewAnimation()
        modelBindingStatus.value = `无法预览「${formatModelBindingPartName(normalized)}」：模型节点未解析到，请检查节点路径或节点名称`
        return
    }

    highlightPreviewTarget(target)
    startModelPreviewAnimation(normalized, target)
    modelBindingStatus.value = `正在预览「${formatModelBindingPartName(normalized)}」：${getModelBindingPreviewLabel(normalized)}`
}

function saveModelBindingDraft() {
    if (!modelBindingForm.node_path) return alert('请先选择模型部位节点')
    if (!modelBindingForm.source_key) return alert('请填写点位字段，例如 rear_fan_rpm / front_door_open / valve_1_flow')

    const binding = normalizeModelBinding({
        ...modelBindingForm,
        id: modelBindingForm.id || `binding_${Date.now()}`
    })
    const duplicateCount = upsertModelBinding(binding, selectedModelBindingIndex.value)
    modelBindingStatus.value = duplicateCount
        ? `绑定已更新，并合并 ${duplicateCount} 条重复项，保存后生效`
        : (selectedModelBindingIndex.value >= 0 ? '绑定已更新，保存后生效' : '绑定已加入，保存后生效')
    resetModelBindingForm()
}

async function saveModelPartBindings(options = {}) {
    const model = activePreviewModel.value
    const showAlert = options.showAlert !== false
    if (!model?.id || !canEditModelBindings.value) return false

    modelBindingSaving.value = true
    modelBindingStatus.value = '正在保存部位绑定...'
    try {
        modelPartBindings.value = dedupeModelBindings(modelPartBindings.value)
        const metadata = buildCurrentModelMetadata(model)
        const successMessage = options.successMessage || `已保存 ${modelPartBindings.value.length} 条部位绑定`
        await persistModelMetadata(model, metadata, successMessage)
        if (showAlert) await alert(successMessage, { title: '保存成功', type: 'success' })
        return true
    } catch (e) {
        const message = `保存失败：${e.message || e}`
        modelBindingStatus.value = message
        if (showAlert) await alert(message, { title: '保存失败', type: 'danger' })
        return false
    } finally {
        modelBindingSaving.value = false
    }
}

async function saveModelInspection() {
    const model = activePreviewModel.value
    if (!model?.id || !canEditModelBindings.value) return false
    modelBindingSaving.value = true
    modelBindingStatus.value = '正在保存拆解检查配置...'
    try {
        modelInspection.parts = modelInspectionParts.value.map(normalizeInspectionPart)
        const metadata = buildCurrentModelMetadata(model)
        await persistModelMetadata(model, metadata, `已保存 ${modelInspectionParts.value.length} 个关键部件和 ${inspectionShellEntries.value.length} 个外壳节点`)
        await alert('拆解检查配置已保存，Unity 重新加载后生效', { title: '保存成功', type: 'success' })
        return true
    } catch (e) {
        modelBindingStatus.value = `保存失败：${e.message || e}`
        await alert(modelBindingStatus.value, { title: '保存失败', type: 'danger' })
        return false
    } finally {
        modelBindingSaving.value = false
    }
}

async function saveModelAssetSpec(overrides = {}) {
    overrides = normalizeSaveOverrides(overrides)
    const model = activePreviewModel.value
    if (!model?.id || !canEditModelBindings.value) return

    modelBindingSaving.value = true
    modelBindingStatus.value = '正在保存模型资产规范...'
    try {
        const metadata = buildCurrentModelMetadata(model, overrides)
        await persistModelMetadata(model, metadata, overrides.successMessage || '模型资产规范已保存')
    } catch (e) {
        modelBindingStatus.value = `保存失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

async function submitModelAssetReview() {
    modelAssetSpec.delivery_status = 'review'
    await saveModelAssetSpec({
        assetSpec: { delivery_status: 'review' },
        releaseStatus: 'review',
        successMessage: '模型已提交待验收'
    })
}

async function markModelAssetAccepted() {
    if (!canAcceptModelAsset.value) return
    modelAssetSpec.delivery_status = 'accepted'
    await saveModelAssetSpec({
        assetSpec: {
            delivery_status: 'accepted'
        },
        acceptance: makeAcceptanceSnapshot('accepted'),
        releaseStatus: 'accepted',
        successMessage: '模型已标记为验收通过'
    })
}

async function publishModelAsset() {
    if (!canPublishModelAsset.value) return
    const model = activePreviewModel.value
    if (!model?.id) return

    const now = new Date().toISOString()
    modelAssetSpec.delivery_status = 'released'
    modelBindingSaving.value = true
    modelBindingStatus.value = '正在发布模型资产...'
    try {
        const metadata = buildCurrentModelMetadata(model, {
            assetSpec: { delivery_status: 'released' },
            acceptance: makeAcceptanceSnapshot('released'),
            releaseStatus: 'released',
            releaseVersion: modelAssetSpec.version || '1.0.0',
            publishedAt: now
        })
        const releaseRecord = {
            id: `release_${Date.now()}`,
            version: metadata.release.version,
            status: 'released',
            published_at: now,
            stats: metadata.acceptance?.stats || {},
            snapshot: {
                schema_version: metadata.schema_version,
                assetSpec: metadata.assetSpec,
                optimization: metadata.optimization,
                inspection: metadata.inspection,
                partBindings: metadata.partBindings,
                acceptance: metadata.acceptance,
                runtime: metadata.runtime
            }
        }
        metadata.release.history = [...(metadata.release.history || []), releaseRecord]
        await persistModelMetadata(model, metadata, `模型已发布：${metadata.release.version}`)
    } catch (e) {
        modelBindingStatus.value = `发布失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

async function restoreModelRelease(record) {
    const model = activePreviewModel.value
    if (!model?.id || !record?.snapshot) return

    const now = new Date().toISOString()
    modelBindingSaving.value = true
    modelBindingStatus.value = '正在恢复发布版本...'
    try {
        const current = parseModelMetadata(model)
        const history = Array.isArray(current.release?.history) ? current.release.history : []
        const snapshot = record.snapshot
        const restoredBindings = Array.isArray(snapshot.partBindings)
            ? snapshot.partBindings.map(binding => normalizeModelBinding(binding))
            : []
        const restoredSpec = normalizeModelAssetSpec({
            ...(snapshot.assetSpec || {}),
            delivery_status: 'released'
        })
        const restoredOptimization = normalizeModelOptimization(snapshot.optimization || current.optimization || {})
        const restoredInspection = normalizeModelInspection(snapshot.inspection || current.inspection || {})
        const metadata = {
            ...current,
            schema_version: snapshot.schema_version || 1,
            assetSpec: restoredSpec,
            optimization: restoredOptimization,
            inspection: restoredInspection,
            partBindings: restoredBindings,
            acceptance: snapshot.acceptance || makeAcceptanceSnapshot('released'),
            runtime: {
                ...(current.runtime || {}),
                ...(snapshot.runtime || {}),
                enableGenericBindings: restoredBindings.length > 0
            },
            release: {
                ...(current.release || {}),
                version: record.version || restoredSpec.version || current.release?.version || '1.0.0',
                status: 'released',
                published_at: now,
                history: [
                    ...history,
                    {
                        id: `rollback_${Date.now()}`,
                        version: record.version || restoredSpec.version || '1.0.0',
                        status: 'rollback',
                        restored_from: record.id,
                        published_at: now,
                        stats: snapshot.acceptance?.stats || {},
                        snapshot
                    }
                ]
            }
        }
        Object.assign(modelAssetSpec, restoredSpec)
        Object.assign(modelOptimization, restoredOptimization)
        Object.assign(modelInspection, restoredInspection)
        modelInspectionParts.value = restoredInspection.parts
        modelPartBindings.value = restoredBindings
        await persistModelMetadata(model, metadata, `已恢复发布版本：${metadata.release.version}`)
    } catch (e) {
        modelBindingStatus.value = `恢复失败：${e.message || e}`
    } finally {
        modelBindingSaving.value = false
    }
}

function resetModelImportForm(file) {
    const modelId = makeModelIdFromFileName(file.name)
    modelImportForm.id = modelId
    modelImportForm.name = file.name.replace(/\.[^.]+$/, '')
    modelImportForm.default_scale = 1
    const metadata = createDefaultModelMetadata()
    metadata.assetSpec.device_family = modelImportForm.name
    Object.assign(modelAssetSpec, metadata.assetSpec)
    Object.assign(modelOptimization, metadata.optimization)
    Object.assign(modelInspection, normalizeModelInspection(metadata.inspection))
    modelInspectionParts.value = []
    modelImportForm.metadata = JSON.stringify(metadata, null, 2)
}

async function selectModelFile(event) {
    const file = event.target.files[0]
    if (!file) return
    modelLibraryStep.value = 'import'
    selectedPreviewModelId.value = ''
    modelPreviewModel = null
    modelPartBindings.value = []
    modelInspectionParts.value = []
    modelBindingStatus.value = '待上传模型可先预览节点，上传入库后再保存部位绑定'
    resetModelBindingForm()
    selectedModelFile.value = file
    resetModelImportForm(file)
    if (selectedModelObjectUrl) URL.revokeObjectURL(selectedModelObjectUrl)
    selectedModelObjectUrl = URL.createObjectURL(file)
    await renderSelectedModelPreview()
}

function clearSelectedModelFile() {
    selectedModelFile.value = null
    selectedPreviewModelId.value = ''
    modelPreviewModel = null
    modelPartBindings.value = []
    modelBindingStatus.value = ''
    Object.assign(modelAssetSpec, { ...defaultModelAssetSpec })
    Object.assign(modelOptimization, { ...defaultModelOptimization })
    resetModelBindingForm()
    modelImportForm.id = ''
    modelImportForm.name = ''
    modelImportForm.default_scale = 1
    modelImportForm.metadata = defaultModelMetadataText()
    if (modelFileInputRef.value) modelFileInputRef.value.value = ''
    disposeModelPreview({ revokeObjectUrl: true })
    modelPreviewStatus.value = '选择模型文件后在这里预览'
    modelPreviewSource = null
}

async function uploadModel() {
    const file = selectedModelFile.value
    if (!file) return alert('请先选择模型文件')
    if (!modelImportForm.id || !modelImportForm.name) return alert('请填写模型 ID 和名称')
    try {
        JSON.parse(modelImportForm.metadata || '{}')
    } catch (e) {
        return alert('元数据 JSON 格式不正确')
    }

    const fd = new FormData()
    fd.append('modelFile', file)
    fd.append('id', modelImportForm.id)
    fd.append('name', modelImportForm.name)
    fd.append('default_scale', Number(modelImportForm.default_scale) || 1)
    fd.append('metadata', modelImportForm.metadata || '{}')

    modelUploading.value = true
    try {
        const result = await adminApi.uploadModel(fd)
        if (result?.error) return alert(result.error, { title: '上传模型失败', type: 'danger' })
        if (!result?.success) return alert('上传模型失败：后端没有返回成功状态', { title: '上传模型失败', type: 'danger' })
        const uploadedId = modelImportForm.id
        const uploadedName = modelImportForm.name
        clearSelectedModelFile()
        await loadModels()
        const uploadedModel = models.value.find(model => model.id === uploadedId)
        if (uploadedModel) await previewExistingModel(uploadedModel)
        await selectModelLibraryStep('optimization')
        modelPreviewStatus.value = `已上传：${uploadedName}`
        await alert(`模型「${uploadedName}」已上传`, { title: '上传成功', type: 'success' })
    } finally {
        modelUploading.value = false
    }
}

async function previewExistingModel(model) {
    selectedModelFile.value = null
    modelPreviewModel = model
    if (modelFileInputRef.value) modelFileInputRef.value.value = ''
    if (selectedModelObjectUrl) {
        URL.revokeObjectURL(selectedModelObjectUrl)
        selectedModelObjectUrl = ''
    }
    selectedPreviewModelId.value = model.id
    loadModelBindingState(model)
    modelPreviewSource = model.file_path
        ? { url: resolveBackendAssetUrl(model.file_path), label: model.name || model.id }
        : null
    await renderSelectedModelPreview()
}

async function deleteModel(id) {
    const target = models.value.find(model => model.id === id) || { id }
    const targetName = target.name || target.id
    if (!(await confirm(`确定删除模型「${targetName}」？\n\n如果已有设备正在使用此模型，系统会拒绝删除。`))) return

    try {
        const result = await adminApi.deleteModel(id)
        if (result?.error) throw new Error(result.error)

        if (selectedPreviewModelId.value === id) {
            selectedPreviewModelId.value = ''
            modelPreviewModel = null
            modelPartBindings.value = []
            Object.assign(modelAssetSpec, { ...defaultModelAssetSpec })
            resetModelBindingForm()
            disposeModelPreview({ revokeObjectUrl: true })
            if (modelLibraryStepRequiresModel(modelLibraryStep.value)) modelLibraryStep.value = 'library'
        }

        await loadModels()
        modelPreviewStatus.value = result?.fileDeleted
            ? `已删除模型和文件：${targetName}`
            : `已删除模型记录：${targetName}`
        modelBindingStatus.value = modelPreviewStatus.value
        await alert(modelPreviewStatus.value, { title: '删除成功', type: 'success' })
    } catch (e) {
        const message = `删除失败：${e.message || e}`
        modelPreviewStatus.value = message
        modelBindingStatus.value = message
        alert(message)
    }
}

// ============ 现场编排器 ============
const platform = ref({ scenes: [], widgets: [], activeScene: null, activeProject: null })
const selectedWidgetPreviewId = ref(storedAdminUiState.selectedWidgetPreviewId || '')
const widgetPreviewHover = reactive({
    visible: false,
    id: '',
    x: 0,
    y: 0
})
const widgetTypeOptions = [
    { value: 'navigation', label: '导航' },
    { value: 'metrics', label: '指标' },
    { value: 'trend', label: '趋势' },
    { value: 'alarm_list', label: '报警列表' },
    { value: 'marquee', label: '跑马灯' },
    { value: 'text', label: '文本' },
    { value: 'device_label', label: '设备浮标配置' },
    { value: 'diagnostics', label: '诊断面板配置' },
    { value: 'line_overview_cards', label: '产线设备卡片配置' }
]
const showCreateWidgetModal = ref(false)
const newWidget = reactive({
    id: '',
    widget_type: 'text',
    title: '自定义文本',
    x: 8,
    y: 1,
    w: 6,
    h: 2,
    sort_order: 10,
    visible: true,
    configText: '{\n  "text": "现场提示 {value}",\n  "tone": "normal"\n}',
    bindingText: '{\n  "path": "metrics.current_output"\n}'
})

function openCreateWidgetModal() {
    newWidget.widget_type = 'text'
    newWidget.id = `widget_${Date.now().toString(36)}`
    newWidget.title = '自定义组件'
    newWidget.x = 8
    newWidget.y = 1
    newWidget.w = 6
    newWidget.h = 2
    newWidget.sort_order = (platform.value.widgets?.length || 0) + 1
    newWidget.visible = true
    applyNewWidgetDefaults()
    showCreateWidgetModal.value = true
}

async function handleCreateWidgetSubmit() {
    await createWidget()
    showCreateWidgetModal.value = false
}

function formatJsonForEditor(value) {
    return JSON.stringify(value || {}, null, 2)
}

function parseJsonText(value) {
    if (!value) return {}
    if (typeof value === 'object') return value
    return JSON.parse(value)
}

function safeParseJsonText(value, fallback = {}) {
    try {
        return parseJsonText(value || '{}')
    } catch (e) {
        return fallback
    }
}

function isEmptyJson(value) {
    try {
        const parsed = parseJsonText(value)
        return !parsed || (typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0)
    } catch (e) {
        return false
    }
}

function getWidgetDefaultConfig(type) {
    const presets = {
        navigation: { mode: 'hierarchy' },
        metrics: {
            chart: 'oee',
            chartLabel: 'OEE',
            chartPath: 'metrics.overall_oee',
            items: [
                { label: '今日产出', path: 'metrics.current_output' },
                { label: '完成进度', path: 'metrics.progress_percent', unit: '%' },
                { label: '能耗估算', path: 'metrics.energy_consumption' },
                { label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' }
            ]
        },
        trend: { seriesName: '平均温度', timeField: 'time', valueField: 'value', lineColor: '#f0b35a' },
        alarm_list: { limit: 5 },
        marquee: { speed: 30, limit: 20, eventWindowHours: 24 },
        text: { text: '现场提示 {value}', tone: 'normal' },
        device_label: DEFAULT_DEVICE_LABEL_CONFIG,
        diagnostics: DEFAULT_DIAGNOSTIC_CONFIG,
        line_overview_cards: DEFAULT_LINE_OVERVIEW_CONFIG
    }
    return presets[type] || {}
}

function getWidgetDefaultBinding(type) {
    const presets = {
        navigation: { source: 'workshops' },
        metrics: { source: 'metrics' },
        trend: { source: 'trendPoints' },
        alarm_list: { source: 'events' },
        marquee: { source: 'events' },
        text: { path: 'metrics.current_output' },
        device_label: {},
        diagnostics: {},
        line_overview_cards: {}
    }
    return presets[type] || {}
}

function normalizeWidgetEditor(widget) {
    const config = {
        ...getWidgetDefaultConfig(widget.widget_type),
        ...(parseJsonText(widget.config || {}) || {})
    }
    const binding = {
        ...getWidgetDefaultBinding(widget.widget_type),
        ...(isEmptyJson(widget.binding) ? {} : (parseJsonText(widget.binding || {}) || {}))
    }
    return {
        ...widget,
        visible: !!widget.visible,
        configText: formatJsonForEditor(config),
        bindingText: formatJsonForEditor(binding)
    }
}

const widgetPreviewMetrics = reactive({
    current_output: 128,
    daily_target: 200,
    progress_percent: 64,
    overall_oee: 82.4,
    energy_consumption: 3260,
    online_devices: 9,
    total_devices: 10,
    running_devices: 7,
    alarm_devices: 1
})
const widgetPreviewDeviceData = reactive({
    furnace_id: 'Furnace_01',
    name: '1# 多用炉',
    analog: {
        actual_temp: 836,
        setpoint_temp: 880,
        actual_carbon: 0.88,
        setpoint_carbon: 0.9
    },
    motors: {
        rear_fan: true,
        front_fan: true,
        rear_fan_speed: 960,
        front_fan_speed: 720,
        oil_stir_1: true,
        oil_stir_2: true,
        oil_stir_3: false,
        oil_stir_4: true,
        oil_stir_1_speed: 520,
        oil_stir_2_speed: 536,
        oil_stir_3_speed: 0,
        oil_stir_4_speed: 580
    },
    doors: {
        front_door_open: true,
        middle_door_open: false
    },
    status: {
        running: true,
        alarm: false
    },
    gas: {
        valve_1_on: true,
        valve_1_flow: 12.5,
        valve_2_on: false,
        valve_2_flow: 0,
        valve_3_on: true,
        valve_3_flow: 8.2
    },
    quality: {
        analog: { actual_temp: 'good', setpoint_temp: 'good', actual_carbon: 'good', setpoint_carbon: 'good' },
        motors: { rear_fan: 'good', front_fan: 'good' },
        doors: { front_door_open: 'good', middle_door_open: 'good' },
        status: { running: 'good', alarm: 'good' }
    }
})
const widgetPreviewEvents = ref([
    { id: 'preview_alarm_1', time: '09:42:18', title: '2# 多用炉前门未到位', level: 'warning' },
    { id: 'preview_alarm_2', time: '09:38:06', title: '油槽搅拌转速偏低', level: 'critical' },
    { id: 'preview_alarm_3', time: '09:30:11', title: '后室温度进入保温段', level: 'info' }
])
const widgetPreviewTrendPoints = ref([
    { time: '09:00', value: 760 },
    { time: '09:05', value: 782 },
    { time: '09:10', value: 801 },
    { time: '09:15', value: 816 },
    { time: '09:20', value: 806 },
    { time: '09:25', value: 823 }
])
const previewableWidgetTypes = new Set(['metrics', 'trend', 'alarm_list', 'marquee', 'text'])
const standalonePreviewWidgetTypes = new Set(['diagnostics', 'device_label', 'line_overview_cards'])
const widgetTypeLabelMap = computed(() => Object.fromEntries(widgetTypeOptions.map(item => [item.value, item.label])))
const widgetPreviewGrid = computed(() => ({
    columns: Number(platform.value.activeScene?.layout?.grid?.columns || 24),
    rows: Number(platform.value.activeScene?.layout?.grid?.rows || 12)
}))
const livePreviewWidgets = computed(() => {
    const widgets = Array.isArray(platform.value.widgets) ? platform.value.widgets : []
    return widgets
        .map(widget => ({
            ...widget,
            visible: widget.visible !== 0 && widget.visible !== false,
            config: {
                ...getWidgetDefaultConfig(widget.widget_type),
                ...safeParseJsonText(widget.configText, {})
            },
            binding: {
                ...getWidgetDefaultBinding(widget.widget_type),
                ...safeParseJsonText(widget.bindingText, {})
            }
        }))
        .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0))
})
const dashboardPreviewWidgets = computed(() => livePreviewWidgets.value.filter(widget => !standalonePreviewWidgetTypes.has(widget.widget_type)))
const visiblePreviewWidgets = computed(() => livePreviewWidgets.value.filter(widget => widget.visible))
const selectedPreviewWidget = computed(() => livePreviewWidgets.value.find(widget => widget.id === selectedWidgetPreviewId.value) || visiblePreviewWidgets.value[0] || livePreviewWidgets.value[0] || null)
const hoveredPreviewWidget = computed(() => livePreviewWidgets.value.find(widget => widget.id === widgetPreviewHover.id) || null)
const widgetPreviewPopoverStyle = computed(() => ({
    left: `${widgetPreviewHover.x}px`,
    top: `${widgetPreviewHover.y}px`
}))
const widgetPreviewDiagnosticGroups = computed(() => {
    const config = hoveredPreviewWidget.value?.widget_type === 'diagnostics'
        ? hoveredPreviewWidget.value.config
        : DEFAULT_DIAGNOSTIC_CONFIG
    return buildDiagnosticGroups(widgetPreviewDeviceData, config).slice(0, 4)
})

function getAdminWidgetGridStyle(widget) {
    const columns = widgetPreviewGrid.value.columns || 24
    const rows = widgetPreviewGrid.value.rows || 12
    const x = Number.isFinite(Number(widget.x)) ? Number(widget.x) : 0
    const y = Number.isFinite(Number(widget.y)) ? Number(widget.y) : 0
    const w = Number.isFinite(Number(widget.w)) ? Number(widget.w) : 4
    const h = Number.isFinite(Number(widget.h)) ? Number(widget.h) : 2
    return {
        left: `${Math.max(0, Math.min(columns, x)) / columns * 100}%`,
        top: `${Math.max(0, Math.min(rows, y)) / rows * 100}%`,
        width: `${Math.max(1, Math.min(columns, w)) / columns * 100}%`,
        height: `${Math.max(1, Math.min(rows, h)) / rows * 100}%`
    }
}

function selectWidgetPreview(widget) {
    selectedWidgetPreviewId.value = widget?.id || ''
}

function moveWidgetPreviewPopover(event) {
    if (shouldSuppressWidgetPreview(event)) {
        hideWidgetPreview()
        return
    }
    const width = 560
    const height = 420
    const margin = 16
    const viewportWidth = window.innerWidth || 1280
    const viewportHeight = window.innerHeight || 720
    const nextX = event.clientX + 18 + width > viewportWidth
        ? event.clientX - width - 18
        : event.clientX + 18
    let nextY = event.clientY - height - 18
    if (nextY < margin) nextY = margin
    if (nextY + height > viewportHeight - margin) nextY = viewportHeight - height - margin
    widgetPreviewHover.x = Math.max(margin, nextX)
    widgetPreviewHover.y = Math.max(margin, nextY)
}

function showWidgetPreview(widget, event) {
    if (shouldSuppressWidgetPreview(event)) {
        hideWidgetPreview()
        return
    }
    widgetPreviewHover.visible = true
    widgetPreviewHover.id = widget?.id || ''
    moveWidgetPreviewPopover(event)
}

function hideWidgetPreview() {
    widgetPreviewHover.visible = false
    widgetPreviewHover.id = ''
}

function shouldSuppressWidgetPreview(event) {
    return !!event?.target?.closest?.('.widget-action-cell')
}

function isDashboardGridPreview(widget) {
    return !!widget && !standalonePreviewWidgetTypes.has(widget.widget_type)
}

function getWidgetFocusCanvasStyle(widget) {
    const columns = widgetPreviewGrid.value.columns || 24
    const rows = widgetPreviewGrid.value.rows || 12
    const x = Number.isFinite(Number(widget?.x)) ? Number(widget.x) : 0
    const y = Number.isFinite(Number(widget?.y)) ? Number(widget.y) : 0
    const w = Math.max(1, Number.isFinite(Number(widget?.w)) ? Number(widget.w) : 4)
    const h = Math.max(1, Number.isFinite(Number(widget?.h)) ? Number(widget.h) : 2)
    const centerX = clampNumber((x + w / 2) / columns, 0, 1)
    const centerY = clampNumber((y + h / 2) / rows, 0, 1)
    const scale = clampNumber(Math.min((columns * 0.58) / w, (rows * 0.58) / h), 1.1, 2.2)
    const translateX = 50 - centerX * 100 * scale
    const translateY = 50 - centerY * 100 * scale
    return {
        transform: `translate(${translateX}%, ${translateY}%) scale(${scale})`
    }
}

function getWidgetPreviewModeLabel(widget) {
    if (!widget) return ''
    if (widget.widget_type === 'diagnostics') return '设备详情态：点击设备后出现'
    if (widget.widget_type === 'device_label') return '3D 设备浮标态'
    if (widget.widget_type === 'line_overview_cards') return '产线视角态'
    return '大屏总览网格态'
}

function formatPreviewTemplate(template, data = {}) {
    return String(template || '').replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '')
}

function getDeviceLabelPreviewConfig(widget) {
    return normalizeDeviceLabelConfig(widget?.config || DEFAULT_DEVICE_LABEL_CONFIG)
}

function getDeviceLabelPreviewTitle(widget) {
    const config = getDeviceLabelPreviewConfig(widget)
    if (config.showTitle === false) return ''
    return formatPreviewTemplate(config.titleTemplate || '{name}', { name: '1# 多用炉', id: 'Furnace_01' }) || '1# 多用炉'
}

function getDeviceLabelPreviewStyle(widget) {
    const style = getDeviceLabelPreviewConfig(widget).style || {}
    return {
        minWidth: style.minWidth,
        padding: style.padding,
        fontSize: style.fontSize,
        background: style.background,
        borderColor: style.borderColor,
        '--device-label-title-color': style.titleColor,
        '--device-label-text-color': style.textColor,
        '--device-label-value-color': style.valueColor
    }
}

function getWidgetPlacementText(widget) {
    if (!widget) return ''
    return `位置 ${widget.x ?? 0},${widget.y ?? 0} / 尺寸 ${widget.w ?? 1}x${widget.h ?? 1}`
}

function getWidgetPreviewDescription(widget) {
    if (!widget) return '未选择组件'
    if (previewableWidgetTypes.has(widget.widget_type)) return '该组件会显示在大屏总览网格中'
    if (widget.widget_type === 'navigation') return '导航组件在大屏左侧显示层级结构'
    if (widget.widget_type === 'device_label') return '设备浮标配置影响 3D 模型上方铭牌，不属于面板网格'
    if (widget.widget_type === 'diagnostics') return '诊断面板在点击设备后出现，不属于总览画面'
    if (widget.widget_type === 'line_overview_cards') return '产线设备卡片在产线视角出现，不属于工厂总览面板'
    return '当前组件暂无专用预览'
}

function applyWidgetDefaults(widget) {
    widget.configText = formatJsonForEditor(getWidgetDefaultConfig(widget.widget_type))
    widget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(widget.widget_type))
}

function applyNewWidgetDefaults() {
    newWidget.configText = formatJsonForEditor(getWidgetDefaultConfig(newWidget.widget_type))
    newWidget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(newWidget.widget_type))
}

async function loadPlatform() {
    const data = await adminApi.getPlatform()
    platform.value = {
        ...data,
        widgets: (data.widgets || []).map(normalizeWidgetEditor)
    }
    if (!selectedWidgetPreviewId.value || !platform.value.widgets.some(widget => widget.id === selectedWidgetPreviewId.value)) {
        selectedWidgetPreviewId.value = platform.value.widgets[0]?.id || ''
    }
}

async function saveActiveScene() {
    const scene = platform.value.activeScene
    if (!scene) return
    if (!scene.camera || typeof scene.camera !== 'object') scene.camera = {}
    if (!scene.theme || typeof scene.theme !== 'object') scene.theme = {}
    const result = await adminApi.updateScene(scene.id, {
        name: scene.name,
        scene_type: scene.scene_type,
        layout: scene.layout,
        camera: scene.camera,
        theme: scene.theme,
        is_active: true,
        sort_order: scene.sort_order
    })
    if (result?.error) return alert(result.error, { title: '场景保存失败', type: 'danger' })
    if (!result?.success) return alert('场景保存失败：后端没有返回成功状态', { title: '场景保存失败', type: 'danger' })
    await alert('场景名称已保存', { title: '保存成功', type: 'success' })
    await loadPlatform()
}

async function saveWidget(widget) {
    if (!widget) return alert('没有选中可保存的组件', { title: '保存组件失败', type: 'danger' })
    let parsedConfig = {}
    let parsedBinding = {}
    try {
        parsedConfig = parseJsonText(widget.configText || '{}')
        parsedBinding = parseJsonText(widget.bindingText || '{}')
    } catch (e) {
        return alert('组件配置或绑定 JSON 格式不正确')
    }
    const result = await adminApi.updateWidget(widget.id, {
        widget_type: widget.widget_type,
        title: widget.title,
        config: parsedConfig,
        binding: parsedBinding,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        sort_order: widget.sort_order,
        visible: !!widget.visible
    })
    if (result?.error) return alert(result.error)
    if (!result?.success) return alert('组件保存失败，请检查后端服务状态')
    alert('组件布局已保存')
    await loadPlatform()
}

function saveSelectedPreviewWidget() {
    const widget = platform.value.widgets.find(item => item.id === selectedPreviewWidget.value?.id)
    return saveWidget(widget)
}

async function createWidget() {
    if (!platform.value.activeScene) return alert('当前没有可用场景')
    if (!newWidget.id || !newWidget.widget_type) return alert('请填写组件 ID 和类型')
    let parsedConfig = {}
    let parsedBinding = {}
    try {
        parsedConfig = parseJsonText(newWidget.configText || '{}')
        parsedBinding = parseJsonText(newWidget.bindingText || '{}')
    } catch (e) {
        return alert('组件配置或绑定 JSON 格式不正确')
    }
    const result = await adminApi.createWidget({
        id: newWidget.id,
        scene_id: platform.value.activeScene.id,
        widget_type: newWidget.widget_type,
        title: newWidget.title,
        config: parsedConfig,
        binding: parsedBinding,
        x: newWidget.x,
        y: newWidget.y,
        w: newWidget.w,
        h: newWidget.h,
        sort_order: newWidget.sort_order,
        visible: !!newWidget.visible
    })
    if (result?.error) return alert(result.error, { title: '新增组件失败', type: 'danger' })
    if (!result?.success) return alert('新增组件失败：后端没有返回成功状态', { title: '新增组件失败', type: 'danger' })
    newWidget.id = `widget_text_${Date.now()}`
    await loadPlatform()
    await alert('组件已新增', { title: '新增成功', type: 'success' })
}

async function deleteWidget(id) {
    if (!(await confirm(`确定删除组件 ${id}？`))) return
    const result = await adminApi.deleteWidget(id)
    if (result?.error) return alert(result.error, { title: '删除组件失败', type: 'danger' })
    if (!result?.success) return alert('删除组件失败：后端没有返回成功状态', { title: '删除组件失败', type: 'danger' })
    await loadPlatform()
    await alert(`组件「${id}」已删除`, { title: '删除成功', type: 'success' })
}

// ============ 左编辑 / 右预览现场编排器 ============
const composerPreviewRef = ref(null)
const composerPreviewShellRef = ref(null)
const composerLayoutPanelRef = ref(null)
const selectedComposerLineId = ref('')
const selectedComposerDeviceId = ref('')
const composerPreviewMode = ref('line')
const composerPreviewStatus = ref('等待加载预览')
const composerSaving = ref(false)
const composerBulkSaving = ref(false)
const isComposerPreviewWide = ref(false)
const composerRotationPresets = [0, 90, 180, 270]
const composerRotationNudges = [-5, -1, 1, 5]
const composerLayoutPanelPosition = reactive({ left: null, top: 76 })
const composerDraft = reactive({
    id: '',
    name: '',
    line_id: '',
    model_type: 'builtin_furnace',
    model_file: '',
    template_id: '',
    instance_config: '{}',
    pos_x: 0,
    pos_y: 0,
    pos_z: 0,
    rotation_y: 0,
    scale: 1,
    coordinate_space: 'line_local',
    sort_order: 0
})

let composerRuntime = null
let composerPreviewTimer = null
let composerPreviewSeq = 0
let composerResizeObserver = null
let composerDragActive = false
let composerPreviewBuilding = false
let composerPreviewQueued = false
let composerPreviewWatchdogTimer = null
let composerPreviewRetryTimer = null
let composerPreviewFailureCount = 0
let composerLayoutPanelDrag = null

function getDeviceDefaultInstanceConfig(device = {}) {
    const config = parseInstanceConfig(device.instance_config)
    const modelType = device.model_type || 'builtin_furnace'
    const caption = device.name || device.id || ''

    if (modelType === 'transfer_cart' || config.role === 'transfer_cart') {
        return {
            role: 'transfer_cart',
            workshop_id: getDeviceWorkshopId(device) || workshops.value[0]?.id || '',
            caption: caption || '料车',
            animationProfile: 'transfer_cart',
            scaleMultiplier: 1
        }
    }

    if (modelType === 'builtin_furnace' || modelType === 'box_atmosphere_furnace' || modelType.includes('furnace')) {
        return {
            caption: caption || '多用炉',
            animationProfile: 'furnace',
            dataProfile: 'heat_treatment',
            scaleMultiplier: 1,
            labelY: 3.3,
            statusLightY: 2.8
        }
    }

    return {
        caption,
        animationProfile: 'static',
        scaleMultiplier: 1
    }
}

function getDeviceWorkshopId(device) {
    const config = parseInstanceConfig(device?.instance_config)
    return config.workshop_id
        || config.workshopId
        || lines.value.find(line => line.id === device?.line_id)?.workshop_id
        || ''
}

function buildDevicePayloadForSave(device, workshopId) {
    const payload = { ...device }
    payload.plc_protocol = normalizePlcProtocol(payload.plc_protocol || 'S7')
    payload.plc_options = normalizePlcOptions(payload.plc_protocol, payload.plc_options)
    const isAuxiliary = isAuxiliaryDeviceConfig(payload)
    const config = parseInstanceConfig(payload.instance_config)

    if (isAuxiliary) {
        config.role = payload.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary')
        config.workshop_id = workshopId || getDeviceWorkshopId(payload) || workshops.value[0]?.id || ''
        payload.line_id = payload.line_id || null
    } else {
        delete config.workshop_id
        delete config.workshopId
        if (config.role === 'auxiliary' || config.role === 'transfer_cart') delete config.role
    }

    payload.coordinate_space = payload.line_id ? 'line_local' : 'workshop_local'
    payload.instance_config = JSON.stringify(config, null, 2)
    return payload
}

function normalizeDeviceConfig(device) {
    const defaultInstanceConfig = getDeviceDefaultInstanceConfig(device)
    return {
        ...device,
        pos_x: numberOrDefault(device.pos_x, 0),
        pos_y: numberOrDefault(device.pos_y, 0),
        pos_z: numberOrDefault(device.pos_z, 0),
        rotation_y: numberOrDefault(device.rotation_y, 0),
        scale: numberOrDefault(device.scale, 1),
        coordinate_space: device.coordinate_space || (device.line_id ? 'line_local' : 'workshop_local'),
        sort_order: numberOrDefault(device.sort_order, 0),
        plc_protocol: normalizePlcProtocol(device.plc_protocol || 'S7'),
        plc_options: normalizePlcOptions(device.plc_protocol || 'S7', device.plc_options),
        instance_config: stringifyInstanceConfigForEdit(device.instance_config, defaultInstanceConfig)
    }
}

const selectedComposerLine = computed(() => placedLines.value.find(line => line.id === selectedComposerLineId.value))
const selectedComposerDevice = computed(() => devices.value.find(device => device.id === selectedComposerDeviceId.value))
const composerLayoutPanelStyle = computed(() => composerLayoutPanelPosition.left === null
    ? { right: '18px', top: `${composerLayoutPanelPosition.top}px` }
    : { left: `${composerLayoutPanelPosition.left}px`, top: `${composerLayoutPanelPosition.top}px` })
const composerPreviewDevices = computed(() => devices.value.map(device => {
    const source = device.id === composerDraft.id ? { ...device, ...composerDraft } : device
    return normalizeDeviceConfig(source)
}))
const selectedComposerWorkshop = computed(() => workshops.value.find(ws => ws.id === selectedComposerLine.value?.workshop_id))
const selectedComposerDevices = computed(() => sortByOrder(composerPreviewDevices.value.filter(device => {
    return device.line_id === selectedComposerLineId.value && !isAuxiliaryDeviceConfig(device)
})))
const selectedComposerAuxDevices = computed(() => sortByOrder(composerPreviewDevices.value.filter(device => {
    return isAuxiliaryDeviceConfig(device) && getDeviceWorkshopId(device) === selectedComposerWorkshop.value?.id
})))
const composerStats = computed(() => ({
    workshops: workshops.value.length,
    lines: placedLines.value.length,
    devices: devices.value.length,
    selectedLineDevices: selectedComposerDevices.value.length
}))
const composerRotationDegrees = computed(() => formatComposerRotationDegrees(composerDraft.rotation_y))

const composerWorkshops = computed(() => sortByOrder(workshops.value).map(workshop => ({
    ...workshop,
    devices: sortByOrder(composerPreviewDevices.value.filter(device => {
        return isAuxiliaryDeviceConfig(device) && getDeviceWorkshopId(device) === workshop.id
    })),
    lines: sortByOrder(placedLines.value.filter(line => line.workshop_id === workshop.id)).map(line => ({
        ...line,
        devices: sortByOrder(composerPreviewDevices.value.filter(device => {
            return device.line_id === line.id && !isAuxiliaryDeviceConfig(device)
        }))
    }))
})))

function getComposerLineIndex(lineId) {
    let index = 0
    for (const ws of composerWorkshops.value) {
        for (const line of ws.lines || []) {
            if (line.id === lineId) return index
            index += 1
        }
    }
    return -1
}

function getComposerWorkshopIndex(workshopId) {
    return composerWorkshops.value.findIndex(ws => ws.id === workshopId)
}

function ensureComposerSelection() {
    if (!placedLines.value.length) {
        selectedComposerLineId.value = ''
        selectedComposerDeviceId.value = ''
        return
    }
    if (!selectedComposerLineId.value || !placedLines.value.some(line => line.id === selectedComposerLineId.value)) {
        selectedComposerLineId.value = sortByOrder(placedLines.value)[0]?.id || ''
    }
    const selectableDevices = [...selectedComposerDevices.value, ...selectedComposerAuxDevices.value]
    if (!selectableDevices.some(device => device.id === selectedComposerDeviceId.value)) {
        selectedComposerDeviceId.value = ''
    }
}

function syncComposerDraftFromSelection() {
    const device = selectedComposerDevice.value
    if (!device) {
        Object.assign(composerDraft, {
            id: '',
            name: '',
            line_id: selectedComposerLineId.value || '',
            model_type: 'builtin_furnace',
            model_file: '',
            template_id: '',
            instance_config: '{}',
            pos_x: 0,
            pos_y: 0,
            pos_z: 0,
            rotation_y: 0,
            scale: 1,
            coordinate_space: 'line_local',
            sort_order: 0
        })
        return
    }
    Object.assign(composerDraft, normalizeDeviceConfig(device))
}

function selectComposerLine(lineId) {
    selectedComposerLineId.value = lineId
    selectedComposerDeviceId.value = ''
    composerPreviewMode.value = 'line'
}

function selectComposerDevice(deviceId) {
    if (selectedComposerDeviceId.value === deviceId) {
        clearComposerDeviceSelection()
        return
    }
    selectedComposerDeviceId.value = deviceId
    composerPreviewMode.value = 'device'
}

function selectComposerDeviceFromPreview(deviceId) {
    if (!devices.value.some(device => device.id === deviceId)) return
    selectedComposerDeviceId.value = deviceId
    composerPreviewMode.value = 'device'
}

function clearComposerDeviceSelection() {
    selectedComposerDeviceId.value = ''
    if (composerPreviewMode.value === 'device') composerPreviewMode.value = 'line'
    composerPreviewStatus.value = '已取消设备选择'
}

function moveComposerLayoutPanel(event) {
    if (!composerLayoutPanelDrag) return
    event.preventDefault()
    const shell = composerPreviewShellRef.value
    const panel = composerLayoutPanelRef.value
    if (!shell || !panel) return
    const shellRect = shell.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const minimumTop = 66
    const maximumLeft = Math.max(8, shellRect.width - panelRect.width - 8)
    const maximumTop = Math.max(minimumTop, shellRect.height - panelRect.height - 46)
    composerLayoutPanelPosition.left = Math.max(8, Math.min(maximumLeft, event.clientX - shellRect.left - composerLayoutPanelDrag.offsetX))
    composerLayoutPanelPosition.top = Math.max(minimumTop, Math.min(maximumTop, event.clientY - shellRect.top - composerLayoutPanelDrag.offsetY))
}

function finishComposerLayoutPanelDrag() {
    composerLayoutPanelDrag = null
    window.removeEventListener('pointermove', moveComposerLayoutPanel)
    window.removeEventListener('pointerup', finishComposerLayoutPanelDrag)
    window.removeEventListener('pointercancel', finishComposerLayoutPanelDrag)
}

function startComposerLayoutPanelDrag(event) {
    if (event.button !== 0) return
    const shell = composerPreviewShellRef.value
    const panel = composerLayoutPanelRef.value
    if (!shell || !panel) return
    event.preventDefault()
    event.stopPropagation()
    const shellRect = shell.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    composerLayoutPanelPosition.left = panelRect.left - shellRect.left
    composerLayoutPanelPosition.top = panelRect.top - shellRect.top
    composerLayoutPanelDrag = {
        offsetX: event.clientX - panelRect.left,
        offsetY: event.clientY - panelRect.top
    }
    window.addEventListener('pointermove', moveComposerLayoutPanel, { passive: false })
    window.addEventListener('pointerup', finishComposerLayoutPanelDrag)
    window.addEventListener('pointercancel', finishComposerLayoutPanelDrag)
}

function nudgeComposerDevice(dx, dz) {
    if (isComposerTransferCart(composerDraft.id)) {
        snapComposerTransferCartToRail({
            x: numberOrDefault(composerDraft.pos_x, 0) + dx,
            y: composerDraft.pos_y,
            z: numberOrDefault(composerDraft.pos_z, 0) + dz
        })
        return
    }
    composerDraft.pos_x = numberOrDefault(composerDraft.pos_x, 0) + dx
    composerDraft.pos_z = numberOrDefault(composerDraft.pos_z, 0) + dz
}

function radiansToDegrees(value) {
    const degrees = numberOrDefault(value, 0) * 180 / Math.PI
    const normalized = ((degrees % 360) + 360) % 360
    return Math.abs(normalized - 360) < 0.0001 ? 0 : normalized
}

function degreesToRadians(value) {
    return normalizeComposerAngle(numberOrDefault(value, 0) * Math.PI / 180)
}

function formatComposerRotationDegrees(value) {
    const degrees = radiansToDegrees(value)
    return Number.isInteger(Number(degrees.toFixed(1)))
        ? `${Math.round(degrees)}°`
        : `${degrees.toFixed(1)}°`
}

function setComposerRotationDegrees(degrees) {
    composerDraft.rotation_y = degreesToRadians(degrees)
}

function nudgeComposerRotationDegrees(delta) {
    setComposerRotationDegrees(radiansToDegrees(composerDraft.rotation_y) + delta)
}

function isComposerTransferCart(deviceId) {
    const device = composerPreviewDevices.value.find(item => item.id === deviceId)
    const config = parseInstanceConfig(device?.instance_config)
    return device?.model_type === 'transfer_cart' || config.role === 'transfer_cart'
}

function updateComposerDraftPositionFromDrag(deviceId, position) {
    const device = composerPreviewDevices.value.find(item => item.id === deviceId)
        || devices.value.find(item => item.id === deviceId)
    if (!device) return

    if (selectedComposerDeviceId.value !== deviceId) {
        selectedComposerDeviceId.value = deviceId
    }
    if (composerDraft.id !== deviceId) {
        Object.assign(composerDraft, normalizeDeviceConfig(device))
    }

    if (isComposerTransferCart(deviceId)) {
        snapComposerTransferCartToRail(position)
        return
    }

    composerDraft.pos_x = roundComposerNumber(position.x, 2)
    composerDraft.pos_y = roundComposerNumber(position.y ?? composerDraft.pos_y, 2)
    composerDraft.pos_z = roundComposerNumber(position.z, 2)
}

function handleComposerDeviceDragStart(deviceId) {
    if (!isComposerTransferCart(deviceId)) return
    composerDragActive = true
    if (selectedComposerDeviceId.value !== deviceId) {
        selectedComposerDeviceId.value = deviceId
    }
    composerPreviewStatus.value = '正在拖动料车，松手后点击保存生效'
}

function handleComposerDeviceDrag(deviceId, position) {
    if (!isComposerTransferCart(deviceId)) return
    composerDragActive = true
    updateComposerDraftPositionFromDrag(deviceId, position)
}

function handleComposerDeviceDragEnd(deviceId, position, _device, meta = {}) {
    if (!isComposerTransferCart(deviceId)) {
        composerDragActive = false
        return
    }
    if (!meta.moved) {
        composerDragActive = false
        return
    }
    updateComposerDraftPositionFromDrag(deviceId, position)
    composerPreviewStatus.value = '料车位置已调整，点击保存设备布局后写入数据库'
    setTimeout(() => {
        composerDragActive = false
    }, 0)
}

function roundComposerNumber(value, digits = 3) {
    const next = Number(value)
    if (!Number.isFinite(next)) return 0
    return Number(next.toFixed(digits))
}

function normalizeComposerAngle(value) {
    const fullTurn = Math.PI * 2
    const angle = ((numberOrDefault(value, 0) % fullTurn) + fullTurn) % fullTurn
    return roundComposerNumber(angle > Math.PI ? angle - fullTurn : angle, 4)
}

async function flipSelectedComposerLine() {
    const lineDevices = selectedComposerDevices.value
    if (!lineDevices.length) return alert('当前产线没有设备可调转')
    const lineName = selectedComposerLine.value?.name || selectedComposerLineId.value
    if (!(await confirm(`确定调转 ${lineName} 的整体朝向吗？这会镜像位置、旋转设备并反转排序。`))) return

    const xValues = lineDevices.map(device => numberOrDefault(device.pos_x, 0))
    const zValues = lineDevices.map(device => numberOrDefault(device.pos_z, 0))
    const spreadX = Math.max(...xValues) - Math.min(...xValues)
    const spreadZ = Math.max(...zValues) - Math.min(...zValues)
    const mirrorAxis = spreadX >= spreadZ ? 'pos_x' : 'pos_z'
    const mirrorCenter = mirrorAxis === 'pos_x'
        ? (Math.min(...xValues) + Math.max(...xValues)) / 2
        : (Math.min(...zValues) + Math.max(...zValues)) / 2
    const sortedDevices = sortByOrder(lineDevices)
    const sortOrders = sortedDevices
        .map(device => numberOrDefault(device.sort_order, 0))
        .sort((a, b) => a - b)

    composerBulkSaving.value = true
    try {
        const results = await Promise.all(sortedDevices.map((device, index) => {
            const nextDevice = normalizeDeviceConfig(device)
            nextDevice[mirrorAxis] = roundComposerNumber((mirrorCenter * 2) - numberOrDefault(nextDevice[mirrorAxis], 0))
            nextDevice.rotation_y = normalizeComposerAngle(numberOrDefault(nextDevice.rotation_y, 0) + Math.PI)
            nextDevice.sort_order = sortOrders[sortOrders.length - 1 - index] ?? nextDevice.sort_order
            return adminApi.updateDevice(nextDevice.id, nextDevice)
        }))
        const failed = results.find(result => result?.error || !result?.success)
        if (failed) {
            return alert(failed.error || '产线调转失败：后端没有返回成功状态', { title: '产线调转失败', type: 'danger' })
        }
        await loadDevices()
        composerPreviewMode.value = 'line'
        composerPreviewStatus.value = `${lineName} 已完成整体反向`
        await reloadSavedNativeScenePreview('composer')
        await alert(`${lineName} 已完成整体反向`, { title: '调转成功', type: 'success' })
    } finally {
        composerBulkSaving.value = false
    }
}

function resizeComposerPreview(delay = 0) {
    if (delay > 0) {
        setTimeout(() => resizeComposerPreview(), delay)
        return
    }
    nextTick(() => {
        composerRuntime?.sceneManager?.onWindowResize?.()
    })
}

function resizeComposerPreviewAfterLayout() {
    resizeComposerPreview()
    resizeComposerPreview(160)
    resizeComposerPreview(320)
}

function toggleAdminNavCollapsed() {
    isAdminNavCollapsed.value = !isAdminNavCollapsed.value
    resizeComposerPreviewAfterLayout()
}

function selectAdminTab(tabKey) {
    activeTab.value = tabKey
    resizeComposerPreviewAfterLayout()
}

function toggleComposerPreviewWide() {
    isComposerPreviewWide.value = !isComposerPreviewWide.value
    resizeComposerPreviewAfterLayout()
    setTimeout(() => focusComposerPreview(), 180)
}

function controlComposerCamera(action) {
    composerRuntime?.controlCamera(action)
    sendNativePreviewCameraAction(action)
}

function fitComposerPreview() {
    if (!composerRuntime?.isRenderSurfaceHealthy?.()) {
        composerPreviewFailureCount = 0
        scheduleComposerPreview(0)
        return
    }
    resizeComposerPreviewAfterLayout()
    focusComposerPreview()
    sendNativePreviewCameraAction('fit')
}

function disconnectComposerResizeObserver() {
    if (!composerResizeObserver) return
    composerResizeObserver.disconnect()
    composerResizeObserver = null
}

function connectComposerResizeObserver(container) {
    disconnectComposerResizeObserver()
    if (!container || typeof ResizeObserver === 'undefined') return
    composerResizeObserver = new ResizeObserver(() => resizeComposerPreview())
    composerResizeObserver.observe(container)
}

function stopComposerPreviewWatchdog() {
    if (!composerPreviewWatchdogTimer) return
    clearInterval(composerPreviewWatchdogTimer)
    composerPreviewWatchdogTimer = null
}

function startComposerPreviewWatchdog() {
    stopComposerPreviewWatchdog()
    composerPreviewWatchdogTimer = setInterval(() => {
        if (activeTab.value !== 'composer' || composerPreviewBuilding) return
        if (composerRuntime?.isRenderSurfaceHealthy?.()) return
        composerPreviewStatus.value = '预览画面已中断，正在自动恢复...'
        scheduleComposerPreview(0)
    }, 1500)
}

function disposeActiveComposerRuntime() {
    disconnectComposerResizeObserver()
    if (!composerRuntime) return
    composerRuntime.dispose()
    composerRuntime = null
}

function disposeComposerPreview() {
    composerPreviewSeq += 1
    composerPreviewQueued = false
    stopComposerPreviewWatchdog()
    disconnectComposerResizeObserver()
    if (composerPreviewTimer) {
        clearTimeout(composerPreviewTimer)
        composerPreviewTimer = null
    }
    if (composerPreviewRetryTimer) {
        clearTimeout(composerPreviewRetryTimer)
        composerPreviewRetryTimer = null
    }
    disposeActiveComposerRuntime()
}

function scheduleComposerPreview(delay = 220) {
    if (activeTab.value !== 'composer') return
    if (composerDragActive) return
    if (composerPreviewBuilding) {
        composerPreviewQueued = true
        return
    }
    if (composerPreviewTimer) clearTimeout(composerPreviewTimer)
    composerPreviewTimer = setTimeout(() => {
        composerPreviewTimer = null
        renderComposerPreview()
    }, Math.max(0, delay))
}

function focusComposerPreview() {
    if (!composerRuntime) return
    if (composerPreviewMode.value === 'factory') {
        composerRuntime.flyToFactory()
        return
    }
    if (composerPreviewMode.value === 'workshop') {
        const workshopIndex = getComposerWorkshopIndex(selectedComposerWorkshop.value?.id)
        if (workshopIndex >= 0) composerRuntime.flyToWorkshop(workshopIndex)
        return
    }
    if (composerPreviewMode.value === 'device' && selectedComposerDeviceId.value) {
        const model = composerRuntime.furnaces.get(selectedComposerDeviceId.value)
        if (model) composerRuntime.sceneManager?.flyToDevice(model)
        return
    }
    const lineIndex = getComposerLineIndex(selectedComposerLineId.value)
    if (lineIndex >= 0) composerRuntime.flyToLine(lineIndex)
}

async function renderComposerPreview() {
    if (activeTab.value !== 'composer' || !composerPreviewRef.value) return
    if (composerPreviewBuilding) {
        composerPreviewQueued = true
        return
    }
    composerPreviewBuilding = true
    composerPreviewQueued = false
    const token = ++composerPreviewSeq
    composerPreviewStatus.value = '正在刷新预览...'
    stopComposerPreviewWatchdog()
    disconnectComposerResizeObserver()
    disposeActiveComposerRuntime()
    await nextTick()
    const container = composerPreviewRef.value
    if (!container || token !== composerPreviewSeq) {
        composerPreviewBuilding = false
        return
    }
    let runtime = null
    try {
        runtime = new SceneRuntime(container, {
            workshops: composerWorkshops.value,
            models: models.value || [],
            cameraMode: '4level',
            renderOptions: {
                profile: 'layout-editor',
                targetFps: 24,
                renderScale: 0.8,
                antialias: true,
                labelFps: 6,
                lightweight: true,
                environment: false
            },
            onLevelChange: () => {},
            onDeviceSelect: deviceId => {
                selectComposerDeviceFromPreview(deviceId)
            },
            onDeviceRegistered: () => {},
            interactionOptions: {
                enableDeviceDrag: true,
                canDragDevice: deviceId => isComposerTransferCart(deviceId),
                onDeviceDragStart: handleComposerDeviceDragStart,
                onDeviceDrag: handleComposerDeviceDrag,
                onDeviceDragEnd: handleComposerDeviceDragEnd
            }
        })
        if (token !== composerPreviewSeq || activeTab.value !== 'composer') {
            runtime.dispose()
            return
        }
        await runtime.start()
        if (token !== composerPreviewSeq || activeTab.value !== 'composer' || !composerPreviewRef.value) {
            runtime.dispose()
            return
        }
        composerRuntime = runtime
        connectComposerResizeObserver(container)
        resizeComposerPreview()
        focusComposerPreview()
        await new Promise(resolve => setTimeout(resolve, 80))
        if (!runtime.isRenderSurfaceHealthy()) {
            throw new Error('渲染画布未正确连接')
        }
        composerPreviewFailureCount = 0
        composerPreviewStatus.value = '预览已同步'
        startComposerPreviewWatchdog()
    } catch (e) {
        if (composerRuntime === runtime) composerRuntime = null
        runtime?.dispose()
        if (token === composerPreviewSeq && activeTab.value === 'composer') {
            composerPreviewFailureCount += 1
            composerPreviewStatus.value = `预览加载失败：${e.message || e}`
            if (composerPreviewFailureCount <= 3) {
                if (composerPreviewRetryTimer) clearTimeout(composerPreviewRetryTimer)
                const retryDelay = Math.min(3200, 500 * (2 ** (composerPreviewFailureCount - 1)))
                composerPreviewRetryTimer = setTimeout(() => {
                    composerPreviewRetryTimer = null
                    scheduleComposerPreview(0)
                }, retryDelay)
            }
        }
    } finally {
        composerPreviewBuilding = false
        if (composerPreviewQueued && activeTab.value === 'composer') {
            composerPreviewQueued = false
            scheduleComposerPreview(80)
        }
    }
}

function updateComposerPreviewFromDraft() {
    if (activeTab.value !== 'composer') return
    const updated = composerRuntime?.updateDeviceLayout?.(
        composerWorkshops.value,
        composerDraft.id,
        models.value || []
    )
    if (updated && composerRuntime?.isRenderSurfaceHealthy?.()) {
        composerPreviewStatus.value = '预览已同步'
        return
    }
    scheduleComposerPreview()
}

async function saveComposerDevice() {
    if (!composerDraft.id) return alert('请先选择设备')
    if (isComposerTransferCart(composerDraft.id)) {
        if (!composerRailOptions.value.length) return alert('请先在产线管理中为当前车间添加小车导轨')
        if (!parseInstanceConfig(composerDraft.instance_config).railId) {
            snapComposerTransferCartToRail({ x: composerDraft.pos_x, y: composerDraft.pos_y, z: composerDraft.pos_z })
        }
    }
    const parsedInstanceConfig = {
        ...getDeviceDefaultInstanceConfig(composerDraft),
        ...parseInstanceConfig(composerDraft.instance_config)
    }
    composerSaving.value = true
    try {
        const payload = buildDevicePayloadForSave(
            { ...composerDraft, instance_config: parsedInstanceConfig },
            getDeviceWorkshopId(composerDraft) || selectedComposerWorkshop.value?.id || workshops.value[0]?.id || ''
        )
        const result = await adminApi.updateDevice(composerDraft.id, payload)
        if (result?.error) return alert(result.error, { title: '设备布局保存失败', type: 'danger' })
        if (!result?.success) return alert('设备布局保存失败：后端没有返回成功状态', { title: '设备布局保存失败', type: 'danger' })
        await loadDevices()
        if (payload.line_id) selectedComposerLineId.value = payload.line_id
        selectedComposerDeviceId.value = composerDraft.id
        await reloadSavedNativeScenePreview('composer')
        await alert('设备布局已保存', { title: '保存成功', type: 'success' })
    } finally {
        composerSaving.value = false
    }
}

watch(selectedComposerLineId, () => {
    ensureComposerSelection()
    scheduleNativeScenePreview({ source: 'composer' })
})

watch(selectedComposerDeviceId, () => {
    syncComposerDraftFromSelection()
    scheduleNativeScenePreview({ source: 'composer' })
})

watch(composerPreviewMode, () => {
    focusComposerPreview()
    scheduleNativeScenePreview({ source: 'composer' })
})

watch(composerDraft, () => {
    updateComposerPreviewFromDraft()
    if (activeTab.value === 'composer') scheduleNativeScenePreview({ source: 'composer' })
}, { deep: true })

watch([lines, devices, selectedLineEditorId], () => {
    if (activeTab.value === 'lines') {
        scheduleNativeScenePreview({ source: 'lines', includeLayout: true })
    }
}, { deep: true })

watch([selectedWorkshopEditorId, lines], () => {
    ensureWorkshopMapLineSelection()
}, { deep: true })

watch(() => composerDraft.line_id, (lineId) => {
    if (lineId && selectedComposerLineId.value !== lineId) {
        selectedComposerLineId.value = lineId
    }
})

watch(() => editingDevice.model_type, (nextModelType, prevModelType) => {
    if (isAuxiliaryDeviceConfig(editingDevice)) {
        editingDeviceWorkshopId.value ||= workshops.value[0]?.id || ''
        if (prevModelType && prevModelType !== nextModelType) {
            editingDevice.line_id = ''
        }
        if (editingDevice.line_id && !deviceFormLines.value.some(line => line.id === editingDevice.line_id)) {
            editingDevice.line_id = ''
        }
    } else if (!editingDevice.line_id) {
        editingDevice.line_id = lines.value[0]?.id || ''
    }
})

watch(editingDeviceWorkshopId, () => {
    if (!isAuxiliaryDeviceConfig(editingDevice)) return
    if (editingDevice.line_id && !deviceFormLines.value.some(line => line.id === editingDevice.line_id)) {
        editingDevice.line_id = ''
    }
})

watch([workshops, lines, devices, models], () => {
    ensureComposerSelection()
    scheduleComposerPreview()
}, { deep: true })

watch(activeTab, async (tab) => {
    if (tab === 'composer') {
        ensureComposerSelection()
        if (!composerDraft.id || composerDraft.id !== selectedComposerDeviceId.value) {
            syncComposerDraftFromSelection()
        }
        await nextTick()
        startComposerPreviewWatchdog()
        scheduleComposerPreview()
        scheduleNativeScenePreview({ source: 'composer' })
    } else {
        disposeComposerPreview()
    }
    if (tab === 'lines') {
        await nextTick()
        scheduleNativeScenePreview({ source: 'lines', includeLayout: true })
    }
    if (tab === 'workshops') {
        ensureWorkshopMapLineSelection()
        await nextTick()
        scheduleNativeScenePreview({ source: 'spatial', includeLayout: true })
    }
    if (tab === 'models') {
        if (modelLibraryStepRequiresModel(modelLibraryStep.value) && !activePreviewModel.value) {
            modelLibraryStep.value = 'library'
        }
        await nextTick()
        await renderSelectedModelPreview()
    } else {
        disposeModelPreview()
    }
    if (tab === 'point-monitor') {
        startPointMonitor()
    } else {
        stopPointMonitor()
    }
    if (tab === 'points' && dataPoints.value.length === 0) {
        loadDataPoints()
    }
})

watch(selectedDeviceForMonitor, () => {
    if (activeTab.value === 'point-monitor') startPointMonitor()
})

watch(pointMonitorAutoRefresh, () => {
    if (activeTab.value === 'point-monitor') startPointMonitor()
})

watch([
    activeTab,
    platformSubpage,
    settingsSubpage,
    isAdminNavCollapsed,
    selectedDeviceForPoints,
    showPointAdvancedFields,
    selectedDeviceForMonitor,
    pointMonitorAutoRefresh,
    selectedLineEditorId,
    selectedWorkshopEditorId,
    workshopManagementStep,
    workshopMapSelectedLineId,
    modelLibraryStep,
    selectedPreviewModelId,
    selectedWidgetPreviewId,
    isLinePlannerEditorCollapsed,
    isLineDevicePoolCollapsed,
    isExternalDataSourcesOpen,
    isAlarmConfigOpen,
    () => lineDevicePoolDock.x,
    () => lineDevicePoolDock.y
], () => {
    localStorage.setItem(ADMIN_UI_STATE_KEY, JSON.stringify({
        activeTab: activeTab.value,
        platformSubpage: platformSubpage.value,
        settingsSubpage: settingsSubpage.value,
        isAdminNavCollapsed: isAdminNavCollapsed.value,
        selectedDeviceForPoints: selectedDeviceForPoints.value,
        showPointAdvancedFields: showPointAdvancedFields.value,
        selectedDeviceForMonitor: selectedDeviceForMonitor.value,
        pointMonitorAutoRefresh: pointMonitorAutoRefresh.value,
        selectedLineEditorId: selectedLineEditorId.value,
        selectedWorkshopEditorId: selectedWorkshopEditorId.value,
        workshopManagementStep: workshopManagementStep.value,
        workshopMapSelectedLineId: workshopMapSelectedLineId.value,
        modelLibraryStep: modelLibraryStep.value,
        selectedPreviewModelId: selectedPreviewModelId.value,
        selectedWidgetPreviewId: selectedWidgetPreviewId.value,
        isLinePlannerEditorCollapsed: isLinePlannerEditorCollapsed.value,
        isLineDevicePoolCollapsed: isLineDevicePoolCollapsed.value,
        isExternalDataSourcesOpen: isExternalDataSourcesOpen.value,
        isAlarmConfigOpen: isAlarmConfigOpen.value,
        lineDevicePoolDockX: lineDevicePoolDock.x,
        lineDevicePoolDockY: lineDevicePoolDock.y
    }))
})

// ============ 生命周期 ============
onMounted(async () => {
    window.addEventListener('beforeunload', handleUnsavedCanvasBeforeUnload)
    await loadWorkshops()
    await Promise.all([loadLines(), loadDevices(), loadSettings(), loadModels(), loadPlatform(), loadTemplatePacks(), loadLicenseStatus(), loadReleaseStatus()])
    startRuntimeRefresh()
    loadCastDevices({ silent: true })
    startCastRefresh()
    if (!newLine.workshop_id && workshops.value.length > 0) {
        newLine.workshop_id = workshops.value[0].id
    }
    selectedDeviceForMonitor.value ||= 'all'
    selectedDeviceForPoints.value ||= 'all'
    if (selectedDeviceForMonitor.value !== 'all' && !devices.value.some(device => device.id === selectedDeviceForMonitor.value)) {
        selectedDeviceForMonitor.value = 'all'
    }
    if (selectedDeviceForPoints.value !== 'all' && !devices.value.some(device => device.id === selectedDeviceForPoints.value)) {
        selectedDeviceForPoints.value = 'all'
    }
    if (activeTab.value === 'points') await loadDataPoints()
    ensureComposerSelection()
    syncComposerDraftFromSelection()
    await nextTick()
    scheduleComposerPreview()
    if (activeTab.value === 'composer') startComposerPreviewWatchdog()
    await refreshAdminConnectionStatus()
    nativeScenePreviewStatusTimer = setInterval(refreshAdminConnectionStatus, 3000)
    if (activeTab.value === 'composer') scheduleNativeScenePreview({ source: 'composer' })
    if (activeTab.value === 'lines') scheduleNativeScenePreview({ source: 'lines', includeLayout: true })
    if (activeTab.value === 'workshops') {
        ensureWorkshopMapLineSelection()
        scheduleNativeScenePreview({ source: 'spatial', includeLayout: true })
    }
    if (activeTab.value === 'models') await renderSelectedModelPreview()
})

onActivated(async () => {
    await nextTick()
    if (activeTab.value === 'composer') {
        startComposerPreviewWatchdog()
        scheduleComposerPreview()
    }
    if (!nativeScenePreviewStatusTimer) {
        refreshAdminConnectionStatus()
        nativeScenePreviewStatusTimer = setInterval(refreshAdminConnectionStatus, 3000)
    }
    if (activeTab.value === 'models') await renderSelectedModelPreview()
    if (activeTab.value === 'point-monitor') startPointMonitor()
})

onDeactivated(() => {
    if (nativeScenePreviewStatusTimer) clearInterval(nativeScenePreviewStatusTimer)
    nativeScenePreviewStatusTimer = null
    finishLinePreviewDrag()
    finishWorkshopMapLineDrag()
    finishWorkshopPendingLineDrag()
    cancelLineDeviceDrag()
    cancelLineDevicePoolMove()
    finishComposerLayoutPanelDrag()
    stopPointMonitor()
    disposeComposerPreview()
    disposeModelPreview()
})

onUnmounted(() => {
    window.removeEventListener('beforeunload', handleUnsavedCanvasBeforeUnload)
    if (nativeScenePreviewTimer) clearTimeout(nativeScenePreviewTimer)
    if (nativeScenePreviewStatusTimer) clearInterval(nativeScenePreviewStatusTimer)
    nativeScenePreviewTimer = null
    nativeScenePreviewStatusTimer = null
    stopRuntimeRefresh()
    stopCastRefresh()
    finishLinePreviewDrag()
    finishWorkshopMapLineDrag()
    finishWorkshopPendingLineDrag()
    cancelLineDeviceDrag()
    cancelLineDevicePoolMove()
    finishComposerLayoutPanelDrag()
    stopPointMonitor()
    disposeComposerPreview()
    disposeModelPreview({ revokeObjectUrl: true })
})

// 设备按产线分组
const devicesByLine = computed(() => {
    const map = {}
    devices.value.forEach(d => {
        if (isAuxiliaryDeviceConfig(d)) return
        if (!map[d.line_id]) map[d.line_id] = []
        map[d.line_id].push(d)
    })
    return map
})

const auxiliaryDevices = computed(() => devices.value.filter(device => isAuxiliaryDeviceConfig(device)))

const deviceFormLines = computed(() => {
    if (!isAuxiliaryDeviceConfig(editingDevice)) return lines.value
    if (!editingDeviceWorkshopId.value) return lines.value
    return lines.value.filter(line => line.workshop_id === editingDeviceWorkshopId.value)
})

const lineMemberDevicesByLine = computed(() => {
    const map = {}
    devices.value.forEach(d => {
        if (isAuxiliaryDeviceConfig(d)) return
        if (!map[d.line_id]) map[d.line_id] = []
        map[d.line_id].push(d)
    })
    return map
})

const selectedLineEditor = computed(() => {
    return lines.value.find(line => line.id === selectedLineEditorId.value) || lines.value[0] || null
})

const selectedLineLayout = computed(() => {
    return selectedLineEditor.value ? getLineLayout(selectedLineEditor.value) : defaultLineLayout()
})

const selectedLineEditorWorkshopName = computed(() => {
    const line = selectedLineEditor.value
    return workshops.value.find(workshop => workshop.id === line?.workshop_id)?.name || line?.workshop_id || ''
})

const selectedLineEditorDevices = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return []
    return sortByOrder(devices.value.filter(device => {
        if (isAuxiliaryDeviceConfig(device)) return false
        return resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'lane'
    }))
})

const selectedLineTotalDeviceCount = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return 0
    return (lineMemberDevicesByLine.value[line.id] || []).length
})

const selectedLineEditorCarts = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return []
    return sortByOrder(devices.value.filter(device => {
        if (!isAuxiliaryDeviceConfig(device)) return false
        return resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'rail'
    }))
})

const selectedLineWorkshopDevices = computed(() => {
    const line = selectedLineEditor.value
    if (!line?.workshop_id) return []
    return sortByOrder(devices.value.filter(device => getDeviceWorkshopId(device) === line.workshop_id))
})

const selectedLineDevicePool = computed(() => {
    const line = selectedLineEditor.value
    if (!line) return []
    return sortByOrder(devices.value.filter(device => {
        if (isAuxiliaryDeviceConfig(device)) {
            if (getDeviceWorkshopId(device) !== line.workshop_id) return false
            const config = parseInstanceConfig(device.instance_config)
            if (config.railLineId && config.railLineId !== line.id) return false
            return resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type !== 'rail'
        }
        return device.line_id === line.id
            && resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type !== 'lane'
    }))
})

function getLineLayout(line) {
    if (!line) return defaultLineLayout()
    if (line.layout && typeof line.layout === 'object' && Array.isArray(line.layout.lanes) && Array.isArray(line.layout.rails)) {
        return line.layout
    }
    const layout = normalizeLineLayout(line.layout || line.layout_json)
    line.layout = layout
    line.layout_json = JSON.stringify(layout)
    return layout
}

function stableSnapshotValue(value) {
    if (Array.isArray(value)) return value.map(stableSnapshotValue)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, stableSnapshotValue(value[key])])
    )
}

function snapshotJson(value) {
    return JSON.stringify(stableSnapshotValue(value))
}

function isLinePlacementPending(line) {
    return !!line && getLineLayout(line).placementPending === true
}

function lineLayoutSnapshot(line) {
    return snapshotJson(normalizeLineLayout(getLineLayout(line)))
}

function linePlacementSnapshot(line) {
    const layout = normalizeLineLayout(getLineLayout(line))
    return snapshotJson({
        placementPending: layout.placementPending,
        transform: layout.transform
    })
}

function deviceLayoutSnapshot(device) {
    const config = parseInstanceConfig(device?.instance_config)
    const lineIds = [
        device?.line_id,
        config.laneLineId,
        config.railLineId
    ].filter(Boolean).map(String)
    return {
        lineIds: [...new Set(lineIds)].sort(),
        serialized: snapshotJson({
            id: device?.id || '',
            line_id: device?.line_id || '',
            pos_x: numberOrDefault(device?.pos_x, 0),
            pos_y: numberOrDefault(device?.pos_y, 0),
            pos_z: numberOrDefault(device?.pos_z, 0),
            rotation_y: numberOrDefault(device?.rotation_y, 0),
            scale: numberOrDefault(device?.scale, 1),
            coordinate_space: device?.coordinate_space || '',
            instance_config: config
        })
    }
}

function lineHasUnsavedDeviceLayout(line) {
    if (!line?.id) return false
    const lineId = String(line.id)
    const currentSnapshots = Object.fromEntries(devices.value.map(device => [device.id, deviceLayoutSnapshot(device)]))
    const candidateIds = new Set()
    Object.entries(currentSnapshots).forEach(([deviceId, snapshot]) => {
        if (snapshot.lineIds.includes(lineId)) candidateIds.add(deviceId)
    })
    Object.entries(savedDeviceLayoutSnapshots.value).forEach(([deviceId, snapshot]) => {
        if (snapshot?.lineIds?.includes(lineId)) candidateIds.add(deviceId)
    })
    return [...candidateIds].some(deviceId => (
        currentSnapshots[deviceId]?.serialized !== savedDeviceLayoutSnapshots.value[deviceId]?.serialized
    ))
}

function lineHasUnsavedLayout(line) {
    if (!line?.id) return false
    return lineLayoutSnapshot(line) !== savedLineLayoutSnapshots.value[line.id]
        || lineHasUnsavedDeviceLayout(line)
}

const dirtyLineIds = computed(() => lines.value.filter(lineHasUnsavedLayout).map(line => line.id))
const lineLayoutDirty = computed(() => lineHasUnsavedLayout(selectedLineEditor.value))

function handleUnsavedCanvasBeforeUnload(event) {
    if (!dirtyLineIds.value.length) return
    event.preventDefault()
    event.returnValue = ''
}

function syncLineLayout(line, layout) {
    if (!line) return
    const normalized = normalizeLineLayout(layout)
    line.layout = normalized
    line.layout_json = JSON.stringify(normalized)
}

function touchLineLayout(line) {
    if (!line) return
    line.layout_json = JSON.stringify(normalizeLineLayout(line.layout), null, 2)
}

function selectLineEditor(lineId) {
    selectedLineEditorId.value = lineId
    lineFlowMenuLaneId.value = ''
}

function toggleLinePlannerEditor() {
    isLinePlannerEditorCollapsed.value = !isLinePlannerEditorCollapsed.value
}

function toggleLineDevicePool() {
    isLineDevicePoolCollapsed.value = !isLineDevicePoolCollapsed.value
}

function setSelectedLineFlowDirection(direction) {
    const line = selectedLineEditor.value
    if (!line) return
    const layout = getLineLayout(line)
    layout.flowDirection = ['right', 'left', 'none'].includes(direction) ? direction : 'right'
    touchLineLayout(line)
}

function toggleLineFlowMenu(laneId) {
    lineFlowMenuLaneId.value = lineFlowMenuLaneId.value === laneId ? '' : laneId
}

function setLineFlowDirectionFromCanvas(direction) {
    setSelectedLineFlowDirection(direction)
    lineFlowMenuLaneId.value = ''
}

function lineFlowDirectionClass() {
    return `direction-${selectedLineLayout.value.flowDirection || 'right'}`
}

function lineDevicePoolDockStyle() {
    return {
        left: `${lineDevicePoolDock.x}px`,
        bottom: `${lineDevicePoolDock.y}px`
    }
}

function clampLineDevicePoolDock(x, y, state) {
    const padding = 12
    const maxX = Math.max(padding, state.hostWidth - state.dockWidth - padding)
    const maxY = Math.max(padding, state.hostHeight - state.dockHeight - padding)
    return {
        x: Math.min(maxX, Math.max(padding, x)),
        y: Math.min(maxY, Math.max(padding, y))
    }
}

function startLineDevicePoolMove(event) {
    if (event.button !== 0) return
    if (event.target.closest?.('.line-device-pool-chip, .line-device-pool-close')) return
    const dock = event.currentTarget.closest?.('.line-device-pool-dock')
    const host = event.currentTarget.closest?.('.line-planner-preview')
    if (!dock || !host) return
    event.stopPropagation()

    const dockRect = dock.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    lineDevicePoolMoveState = {
        startX: event.clientX,
        startY: event.clientY,
        startDockX: lineDevicePoolDock.x,
        startDockY: lineDevicePoolDock.y,
        dockWidth: dockRect.width,
        dockHeight: dockRect.height,
        hostWidth: hostRect.width,
        hostHeight: hostRect.height
    }
    lineDevicePoolDock.moving = true
    lineDevicePoolDock.moved = false
    document.body.classList.add('line-preview-dragging')
    window.addEventListener('pointermove', handleLineDevicePoolMove)
    window.addEventListener('pointerup', finishLineDevicePoolMove, { once: true })
}

function handleLineDevicePoolMove(event) {
    const state = lineDevicePoolMoveState
    if (!state) return
    const deltaX = event.clientX - state.startX
    const deltaY = event.clientY - state.startY
    const next = clampLineDevicePoolDock(
        state.startDockX + deltaX,
        state.startDockY - deltaY,
        state
    )
    lineDevicePoolDock.x = Math.round(next.x)
    lineDevicePoolDock.y = Math.round(next.y)
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
        lineDevicePoolDock.moved = true
    }
}

function finishLineDevicePoolMove() {
    lineDevicePoolMoveState = null
    lineDevicePoolDock.moving = false
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDevicePoolMove)
    window.setTimeout(() => {
        lineDevicePoolDock.moved = false
    }, 0)
}

function cancelLineDevicePoolMove() {
    lineDevicePoolMoveState = null
    lineDevicePoolDock.moving = false
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDevicePoolMove)
}

function handleLineDevicePoolTabClick() {
    if (lineDevicePoolDock.moved) {
        lineDevicePoolDock.moved = false
        return
    }
    toggleLineDevicePool()
}

function addLineLayoutItem(type) {
    const line = selectedLineEditor.value
    if (!line) return
    const layout = getLineLayout(line)
    const collection = type === 'rail' ? layout.rails : layout.lanes
    const item = makeLineLayoutItem(type, collection.length)
    const usedOffsets = [...layout.lanes, ...layout.rails].map(entry => numberOrDefault(entry.offsetZ, 0))
    let nextOffset = item.offsetZ
    while (usedOffsets.some(offset => Math.abs(offset - nextOffset) < 2.5)) {
        nextOffset += 6
    }
    item.offsetZ = nextOffset
    const lengthSource = collection[collection.length - 1] || layout.lanes[0] || layout.rails[0]
    item.length = numberOrDefault(lengthSource?.length, 60)
    collection.push(item)
    collection.forEach((item, index) => { item.sort_order = index })
    touchLineLayout(line)
}

function removeLineLayoutItem(type, itemId) {
    const line = selectedLineEditor.value
    if (!line) return
    const layout = getLineLayout(line)
    const key = type === 'rail' ? 'rails' : 'lanes'
    if (key === 'lanes' && layout.lanes.length <= 1) {
        alert('至少保留一条设备线')
        return
    }
    layout[key] = layout[key].filter(item => item.id !== itemId)
    layout[key].forEach((item, index) => { item.sort_order = index })
    syncLineLayout(line, layout)
}

async function saveSelectedLineLayout() {
    const line = selectedLineEditor.value
    if (!line) return
    lineLayoutSaving.value = true
    try {
        const layout = normalizeLineLayout(getLineLayout(line))
        line.layout = layout
        line.layout_json = JSON.stringify(layout, null, 2)
        const boundDeviceIds = syncLineBoundDevicesToLayout(line)
        const result = await adminApi.updateLine(line.id, {
            name: line.name,
            workshop_id: line.workshop_id,
            sort_order: line.sort_order,
            layout,
            layout_json: line.layout_json
        })
        if (result?.error) return alert(result.error, { title: '保存产线结构失败', type: 'danger' })
        const deviceResult = await saveLineBoundDevices(boundDeviceIds, line)
        if (deviceResult?.error) {
            await loadDevices()
            return alert(`${deviceResult.device?.name || deviceResult.device?.id || '设备'} 保存失败：${deviceResult.error}`, { title: '设备位置保存失败', type: 'danger' })
        }
        await loadLines()
        await loadDevices()
        await reloadSavedNativeScenePreview('lines')
        return alert(deviceResult?.saved ? `产线结构已保存，${deviceResult.saved} 台设备位置已同步` : '产线结构已保存', { type: 'success' })
    } finally {
        lineLayoutSaving.value = false
    }
}

async function resetSelectedLineLayout() {
    const selectedId = selectedLineEditor.value?.id || ''
    finishLinePreviewDrag()
    cancelLineDeviceDrag()
    await Promise.all([loadLines(), loadDevices()])
    if (selectedId && lines.value.some(line => line.id === selectedId)) {
        selectedLineEditorId.value = selectedId
    }
    await reloadSavedNativeScenePreview('lines')
}

function getLineBaseZ(lineId) {
    const line = lines.value.find(item => item.id === lineId)
    if (Number(getLineLayout(line)?.version || 0) >= 2) return 0
    const lineIndex = sortByOrder(lines.value).findIndex(line => line.id === lineId)
    return lineIndex >= 0 ? -lineIndex * 16 : 0
}

function resolveDeviceLayoutTarget(device, line = selectedLineEditor.value, options = {}) {
    if (!device || !line) return null
    const layout = getLineLayout(line)
    const config = parseInstanceConfig(device.instance_config)
    const allowFallback = options.allowFallback !== false

    if (isAuxiliaryDeviceConfig(device)) {
        if (config.railLineId === line.id && config.railId) {
            const rail = layout.rails.find(item => item.id === config.railId)
            if (rail) return { type: 'rail', item: rail, explicit: true }
        }
        if (allowFallback && (config.railLineId === line.id || device.line_id === line.id) && layout.rails.length) {
            const baseZ = getLineBaseZ(line.id)
            const relativeZ = numberOrDefault(device.pos_z, baseZ) - baseZ
            const rail = [...layout.rails]
                .sort((a, b) => Math.abs(numberOrDefault(a.offsetZ, 0) - relativeZ) - Math.abs(numberOrDefault(b.offsetZ, 0) - relativeZ))[0]
            if (rail) return { type: 'rail', item: rail, explicit: false }
        }
        return null
    }

    if (config.laneLineId === line.id && config.laneId) {
        const lane = layout.lanes.find(item => item.id === config.laneId)
        if (lane) return { type: 'lane', item: lane, explicit: true }
    }

    if (allowFallback && device.line_id === line.id && layout.lanes.length) {
        const baseZ = getLineBaseZ(line.id)
        const relativeZ = numberOrDefault(device.pos_z, baseZ) - baseZ
        const lane = [...layout.lanes]
            .sort((a, b) => Math.abs(numberOrDefault(a.offsetZ, 0) - relativeZ) - Math.abs(numberOrDefault(b.offsetZ, 0) - relativeZ))[0]
        if (lane) return { type: 'lane', item: lane, explicit: false }
    }

    return null
}

function getDevicesBoundToLayoutItem(type, itemId, line = selectedLineEditor.value, sourceDevices = devices.value) {
    if (!line || !itemId) return []
    return sourceDevices.filter(device => {
        const target = resolveDeviceLayoutTarget(device, line, { allowFallback: false })
        return target?.type === type && target.item?.id === itemId
    })
}

function buildDeviceLayoutBindingPatch(device, type, item, line) {
    const config = {
        ...parseInstanceConfig(device.instance_config)
    }
    const halfLength = Math.max(1, numberOrDefault(item.length, 60) / 2)
    const nextX = roundLineLayoutValue(Math.min(halfLength, Math.max(-halfLength, numberOrDefault(device.pos_x, 0))), 0.5)
    const nextZ = roundLineLayoutValue(getLineBaseZ(line.id) + numberOrDefault(item.offsetZ, 0), 0.5)

    if (type === 'rail') {
        config.role = device.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary')
        config.workshop_id = line.workshop_id
        config.railLineId = line.id
        config.railId = item.id
        config.railName = item.name
        delete config.laneLineId
        delete config.laneId
        delete config.laneName
    } else {
        config.laneLineId = line.id
        config.laneId = item.id
        config.laneName = item.name
        delete config.railLineId
        delete config.railId
        delete config.railName
        delete config.workshop_id
        delete config.workshopId
        if (config.role === 'auxiliary' || config.role === 'transfer_cart') delete config.role
    }

    return {
        line_id: line.id,
        coordinate_space: 'line_local',
        pos_x: nextX,
        pos_z: nextZ,
        instance_config: JSON.stringify(config, null, 2)
    }
}

function patchBoundDevicesForLayoutItem(type, itemId, item, line = selectedLineEditor.value, deviceIds = null) {
    if (!line || !item) return []
    const boundIds = new Set(deviceIds || getDevicesBoundToLayoutItem(type, itemId, line).map(device => device.id))
    if (!boundIds.size) return []
    devices.value = devices.value.map(device => {
        if (!boundIds.has(device.id)) return device
        return {
            ...device,
            ...buildDeviceLayoutBindingPatch(device, type, item, line)
        }
    })
    return [...boundIds]
}

function syncLineBoundDevicesToLayout(line = selectedLineEditor.value) {
    if (!line) return []
    const layout = getLineLayout(line)
    const sourceDevices = [...devices.value]
    const patches = new Map()

    layout.lanes.forEach(lane => {
        getDevicesBoundToLayoutItem('lane', lane.id, line, sourceDevices).forEach(device => {
            patches.set(device.id, buildDeviceLayoutBindingPatch(device, 'lane', lane, line))
        })
    })

    layout.rails.forEach(rail => {
        getDevicesBoundToLayoutItem('rail', rail.id, line, sourceDevices).forEach(device => {
            patches.set(device.id, buildDeviceLayoutBindingPatch(device, 'rail', rail, line))
        })
    })

    if (!patches.size) return []
    devices.value = devices.value.map(device => patches.has(device.id) ? { ...device, ...patches.get(device.id) } : device)
    return [...patches.keys()]
}

async function saveLineBoundDevices(deviceIds, line = selectedLineEditor.value) {
    const ids = [...new Set(deviceIds || [])]
    if (!ids.length) return { success: true, saved: 0 }

    try {
        for (const deviceId of ids) {
            const device = getLineDeviceById(deviceId)
            if (!device) continue
            lineDeviceSavingId.value = device.id
            const payload = buildDevicePayloadForSave(device, getDeviceWorkshopId(device) || line?.workshop_id)
            const result = await adminApi.updateDevice(device.id, payload)
            if (result?.error) return { error: result.error, device }
        }
        return { success: true, saved: ids.length }
    } finally {
        lineDeviceSavingId.value = ''
    }
}

function getDeviceRelativeZOnLine(device, line = selectedLineEditor.value) {
    const target = resolveDeviceLayoutTarget(device, line, { allowFallback: true })
    if (target) return numberOrDefault(target.item.offsetZ, 0)
    return numberOrDefault(device.pos_z, 0) - getLineBaseZ(line?.id)
}

function linePreviewBounds(line) {
    const layout = getLineLayout(line)
    const baseZ = getLineBaseZ(line?.id)
    const lineDevices = line?.id === selectedLineEditor.value?.id
        ? selectedLineEditorDevices.value
        : devices.value.filter(device => !isAuxiliaryDeviceConfig(device) && resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'lane')
    const carts = line?.id === selectedLineEditor.value?.id
        ? selectedLineEditorCarts.value
        : devices.value.filter(device => isAuxiliaryDeviceConfig(device) && resolveDeviceLayoutTarget(device, line, { allowFallback: false })?.type === 'rail')
    const allX = [...lineDevices, ...carts].map(device => Number(device.pos_x)).filter(Number.isFinite)
    const allZ = [
        0,
        ...layout.lanes.map(item => Number(item.offsetZ)),
        ...layout.rails.map(item => Number(item.offsetZ)),
        ...lineDevices.map(device => getDeviceRelativeZOnLine(device, line)),
        ...carts.map(device => getDeviceRelativeZOnLine(device, line))
    ].filter(Number.isFinite)
    const maxHalfLength = Math.max(24, ...[...layout.lanes, ...layout.rails].map(item => numberOrDefault(item.length, 60) / 2), ...allX.map(Math.abs)) + 6
    const minZ = Math.min(-8, ...allZ) - 4
    const maxZ = Math.max(8, ...allZ) + 4
    return { minX: -maxHalfLength, maxX: maxHalfLength, minZ, maxZ, baseZ }
}

function linePreviewPercent(value, min, max) {
    if (max === min) return 50
    return Math.min(96, Math.max(4, ((value - min) / (max - min)) * 100))
}

function linePreviewItemStyle(item, line = selectedLineEditor.value) {
    const bounds = linePreviewBounds(line)
    const length = Math.max(1, numberOrDefault(item.length, 60))
    const left = linePreviewPercent(-length / 2, bounds.minX, bounds.maxX)
    const right = linePreviewPercent(length / 2, bounds.minX, bounds.maxX)
    const top = linePreviewPercent(numberOrDefault(item.offsetZ, 0), bounds.minZ, bounds.maxZ)
    return {
        left: `${left}%`,
        width: `${Math.max(8, right - left)}%`,
        top: `${top}%`
    }
}

function linePreviewDeviceStyle(device, line = selectedLineEditor.value) {
    const bounds = linePreviewBounds(line)
    return {
        left: `${linePreviewPercent(numberOrDefault(device.pos_x, 0), bounds.minX, bounds.maxX)}%`,
        top: `${linePreviewPercent(getDeviceRelativeZOnLine(device, line), bounds.minZ, bounds.maxZ)}%`
    }
}

function roundLineLayoutValue(value, step = 0.5) {
    const next = Number(value)
    if (!Number.isFinite(next)) return 0
    return Number((Math.round(next / step) * step).toFixed(2))
}

function findLineLayoutItem(type, itemId) {
    const layout = selectedLineLayout.value
    const collection = type === 'rail' ? layout.rails : layout.lanes
    return collection.find(item => item.id === itemId) || null
}

function previewClientYToZ(clientY, state) {
    const percent = (clientY - state.rect.top) / Math.max(1, state.rect.height)
    return state.bounds.minZ + percent * (state.bounds.maxZ - state.bounds.minZ)
}

function previewDeltaXToUnits(clientX, state) {
    const deltaPx = clientX - state.startX
    return deltaPx / Math.max(1, state.rect.width) * (state.bounds.maxX - state.bounds.minX)
}

function previewClientXToUnits(clientX, state) {
    const percent = (clientX - state.rect.left) / Math.max(1, state.rect.width)
    return state.bounds.minX + percent * (state.bounds.maxX - state.bounds.minX)
}

function startLinePreviewDrag(type, itemId, mode, event) {
    if (!selectedLineEditor.value || event.button !== 0) return
    const item = findLineLayoutItem(type, itemId)
    const stage = event.currentTarget.closest?.('.line-preview-stage')
    if (!item || !stage) return
    event.preventDefault()
    event.stopPropagation()

    linePreviewDragState = {
        type,
        itemId,
        mode,
        rect: stage.getBoundingClientRect(),
        bounds: linePreviewBounds(selectedLineEditor.value),
        startX: event.clientX,
        startY: event.clientY,
        startOffsetZ: numberOrDefault(item.offsetZ, 0),
        startLength: Math.max(1, numberOrDefault(item.length, 60)),
        boundDeviceIds: getDevicesBoundToLayoutItem(type, itemId, selectedLineEditor.value).map(device => device.id)
    }
    document.body.classList.add('line-preview-dragging')
    window.addEventListener('pointermove', handleLinePreviewDrag)
    window.addEventListener('pointerup', finishLinePreviewDrag, { once: true })
}

function handleLinePreviewDrag(event) {
    const state = linePreviewDragState
    if (!state || !selectedLineEditor.value) return
    const item = findLineLayoutItem(state.type, state.itemId)
    if (!item) return

    if (state.mode === 'move') {
        item.offsetZ = roundLineLayoutValue(previewClientYToZ(event.clientY, state), 0.5)
    } else {
        const deltaUnits = previewDeltaXToUnits(event.clientX, state)
        const signedDelta = state.mode === 'resize-left' ? -deltaUnits : deltaUnits
        item.length = Math.max(4, roundLineLayoutValue(state.startLength + signedDelta * 2, 0.5))
    }
    patchBoundDevicesForLayoutItem(state.type, state.itemId, item, selectedLineEditor.value, state.boundDeviceIds)
    touchLineLayout(selectedLineEditor.value)
}

function finishLinePreviewDrag() {
    if (selectedLineEditor.value) touchLineLayout(selectedLineEditor.value)
    linePreviewDragState = null
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLinePreviewDrag)
}

function resetLineDeviceDrag() {
    Object.assign(lineDeviceDrag, {
        active: false,
        deviceId: '',
        x: 0,
        z: 0,
        left: 0,
        top: 0,
        targetType: '',
        targetId: '',
        targetName: '',
        alignActive: false,
        alignX: 0,
        alignLeft: 0,
        canDrop: false,
        message: ''
    })
}

function getLineDeviceById(deviceId) {
    return devices.value.find(device => device.id === deviceId) || null
}

function getLineDropTargets(device) {
    const layout = selectedLineLayout.value
    return isAuxiliaryDeviceConfig(device)
        ? layout.rails.map(item => ({ type: 'rail', item }))
        : layout.lanes.map(item => ({ type: 'lane', item }))
}

function findNearestLineDropTarget(device, z) {
    const targets = getLineDropTargets(device)
    if (!targets.length) return null
    return targets
        .map(target => ({
            ...target,
            distance: Math.abs(numberOrDefault(target.item.offsetZ, 0) - z)
        }))
        .sort((a, b) => a.distance - b.distance)[0]
}

function findLineDropTargetFromPoint(device, event) {
    const element = document.elementFromPoint(event.clientX, event.clientY)
    const targetElement = element?.closest?.('[data-line-target-type][data-line-target-id]')
    if (!targetElement) return null
    const type = targetElement.dataset.lineTargetType
    const itemId = targetElement.dataset.lineTargetId
    const item = findLineLayoutItem(type, itemId)
    if (!item) return null
    if (isAuxiliaryDeviceConfig(device) && type !== 'rail') return null
    if (!isAuxiliaryDeviceConfig(device) && type !== 'lane') return null
    return { type, item }
}

function linePreviewItemClass(type, item) {
    const isTarget = lineDeviceDrag.active
        && lineDeviceDrag.targetType === type
        && lineDeviceDrag.targetId === item.id
    const device = getLineDeviceById(lineDeviceDrag.deviceId)
    const compatible = device
        ? (isAuxiliaryDeviceConfig(device) ? type === 'rail' : type === 'lane')
        : false
    return {
        'drop-compatible': lineDeviceDrag.active && compatible,
        'drop-target': isTarget
    }
}

function lineDeviceDragGhostStyle() {
    return {
        left: `${lineDeviceDrag.left}%`,
        top: `${lineDeviceDrag.top}%`
    }
}

function lineAlignmentGuideStyle() {
    return {
        left: `${lineDeviceDrag.alignLeft}%`
    }
}

function findLineDeviceAlignment(deviceId, x, bounds) {
    const candidates = [...selectedLineEditorDevices.value, ...selectedLineEditorCarts.value]
        .filter(device => device.id !== deviceId)
        .map(device => numberOrDefault(device.pos_x, 0))
        .filter(Number.isFinite)
    if (!candidates.length) return null

    const snapDistance = Math.max(0.8, (bounds.maxX - bounds.minX) * 0.012)
    const nearest = candidates
        .map(value => ({ value, distance: Math.abs(value - x) }))
        .sort((a, b) => a.distance - b.distance)[0]
    if (!nearest || nearest.distance > snapDistance) return null
    return {
        x: nearest.value,
        left: linePreviewPercent(nearest.value, bounds.minX, bounds.maxX)
    }
}

function startLineDeviceDrag(deviceId, event) {
    if (!selectedLineEditor.value || event.button !== 0) return
    const device = getLineDeviceById(deviceId)
    const stage = linePreviewStageRef.value || event.currentTarget.closest?.('.line-preview-stage')
    if (!device || !stage) return
    event.preventDefault()
    event.stopPropagation()

    const rect = stage.getBoundingClientRect()
    const bounds = linePreviewBounds(selectedLineEditor.value)
    try {
        event.currentTarget?.setPointerCapture?.(event.pointerId)
    } catch (e) {
        // 浏览器可能在按钮快速拖出时拒绝捕获，忽略即可。
    }
    lineDeviceDragState = { deviceId, rect, bounds, pointerTarget: event.currentTarget, pointerId: event.pointerId }
    Object.assign(lineDeviceDrag, {
        active: true,
        deviceId,
        x: numberOrDefault(device.pos_x, 0),
        z: numberOrDefault(device.pos_z, 0) - bounds.baseZ,
        left: linePreviewPercent(numberOrDefault(device.pos_x, 0), bounds.minX, bounds.maxX),
        top: linePreviewPercent(numberOrDefault(device.pos_z, 0) - bounds.baseZ, bounds.minZ, bounds.maxZ),
        targetType: '',
        targetId: '',
        targetName: '',
        alignActive: false,
        alignX: 0,
        alignLeft: 0,
        canDrop: false,
        message: ''
    })
    document.body.classList.add('line-preview-dragging')
    window.addEventListener('pointermove', handleLineDeviceDrag)
    window.addEventListener('pointerup', finishLineDeviceDrag, { once: true })
    handleLineDeviceDrag(event)
}

function handleLineDeviceDrag(event) {
    const state = lineDeviceDragState
    if (!state || !selectedLineEditor.value) return
    const device = getLineDeviceById(state.deviceId)
    if (!device) return
    const insideStage = event.clientX >= state.rect.left
        && event.clientX <= state.rect.right
        && event.clientY >= state.rect.top
        && event.clientY <= state.rect.bottom
    let x = previewClientXToUnits(event.clientX, state)
    const z = previewClientYToZ(event.clientY, state)
    const elementTarget = findLineDropTargetFromPoint(device, event)
    const target = elementTarget || (insideStage ? findNearestLineDropTarget(device, z) : null)
    const targetZ = target ? numberOrDefault(target.item.offsetZ, 0) : z
    const alignment = insideStage ? findLineDeviceAlignment(state.deviceId, x, state.bounds) : null
    if (alignment) x = alignment.x

    lineDeviceDrag.x = x
    lineDeviceDrag.z = targetZ
    lineDeviceDrag.left = linePreviewPercent(x, state.bounds.minX, state.bounds.maxX)
    lineDeviceDrag.top = linePreviewPercent(targetZ, state.bounds.minZ, state.bounds.maxZ)
    lineDeviceDrag.targetType = target?.type || ''
    lineDeviceDrag.targetId = target?.item?.id || ''
    lineDeviceDrag.targetName = target?.item?.name || ''
    lineDeviceDrag.alignActive = !!alignment
    lineDeviceDrag.alignX = alignment?.x || 0
    lineDeviceDrag.alignLeft = alignment?.left || 0
    lineDeviceDrag.canDrop = !!target
    lineDeviceDrag.message = target
        ? `放到 ${target.item.name}`
        : insideStage
            ? (isAuxiliaryDeviceConfig(device) ? '当前产线没有小车导轨' : '当前产线没有设备线')
            : '拖回预览区域后松手'
    scheduleNativeScenePreview({
        source: 'lines',
        includeLayout: true,
        deviceOverride: insideStage ? {
            id: device.id,
            pos_x: x,
            pos_z: state.bounds.baseZ + targetZ
        } : null
    })
}

async function finishLineDeviceDrag(event) {
    if (lineDeviceDragState && event) {
        handleLineDeviceDrag(event)
    }
    const drag = { ...lineDeviceDrag }
    try {
        lineDeviceDragState?.pointerTarget?.releasePointerCapture?.(lineDeviceDragState.pointerId)
    } catch (e) {
        // 指针可能已被浏览器释放，忽略即可。
    }
    lineDeviceDragState = null
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDeviceDrag)
    resetLineDeviceDrag()
    if (!drag.active || !drag.canDrop) {
        scheduleNativeScenePreview({ source: 'lines', includeLayout: true, deviceOverride: null })
        if (drag.active && drag.message) alert(drag.message, { type: 'warning' })
        return
    }
    await placeLineDeviceOnTarget(drag)
}

function cancelLineDeviceDrag() {
    try {
        lineDeviceDragState?.pointerTarget?.releasePointerCapture?.(lineDeviceDragState.pointerId)
    } catch (e) {
        // 指针可能已被浏览器释放，忽略即可。
    }
    lineDeviceDragState = null
    document.body.classList.remove('line-preview-dragging')
    window.removeEventListener('pointermove', handleLineDeviceDrag)
    resetLineDeviceDrag()
}

function patchDeviceLocally(deviceId, patch) {
    devices.value = devices.value.map(device => device.id === deviceId ? { ...device, ...patch } : device)
}

async function placeLineDeviceOnTarget(drag) {
    const line = selectedLineEditor.value
    const device = getLineDeviceById(drag.deviceId)
    if (!line || !device) return
    const target = findLineLayoutItem(drag.targetType, drag.targetId)
    if (!target) return alert('目标线不存在，可能已经被删除', { type: 'warning' })

    const halfLength = Math.max(1, numberOrDefault(target.length, 60) / 2)
    const nextX = roundLineLayoutValue(Math.min(halfLength, Math.max(-halfLength, drag.x)), 0.5)
    const nextZ = roundLineLayoutValue(getLineBaseZ(line.id) + numberOrDefault(target.offsetZ, 0), 0.5)
    const config = {
        ...parseInstanceConfig(device.instance_config)
    }

    if (drag.targetType === 'rail') {
        config.role = device.model_type === 'transfer_cart' ? 'transfer_cart' : (config.role || 'auxiliary')
        config.workshop_id = line.workshop_id
        config.railLineId = line.id
        config.railId = target.id
        config.railName = target.name
        delete config.laneLineId
        delete config.laneId
        delete config.laneName
    } else {
        config.laneLineId = line.id
        config.laneId = target.id
        config.laneName = target.name
        delete config.railLineId
        delete config.railId
        delete config.railName
    }

    const patch = {
        line_id: line.id,
        coordinate_space: 'line_local',
        pos_x: nextX,
        pos_z: nextZ,
        instance_config: JSON.stringify(config, null, 2)
    }
    patchDeviceLocally(device.id, patch)
    lineDeviceSavingId.value = device.id
    try {
        const payload = buildDevicePayloadForSave({ ...device, ...patch, instance_config: config }, line.workshop_id)
        const result = await adminApi.updateDevice(device.id, payload)
        if (result?.error) {
            await loadDevices()
            return alert(result.error, { title: '设备归位失败', type: 'danger' })
        }
        await loadDevices()
        await reloadSavedNativeScenePreview('lines')
    } finally {
        lineDeviceSavingId.value = ''
    }
}

async function removeDeviceFromLineCanvas(device) {
    const line = selectedLineEditor.value
    if (!line || !device) return
    const config = {
        ...parseInstanceConfig(device.instance_config)
    }

    if (isAuxiliaryDeviceConfig(device)) {
        config.workshop_id = config.workshop_id || getDeviceWorkshopId(device) || line.workshop_id
        delete config.railLineId
        delete config.railId
        delete config.railName
    } else {
        delete config.laneLineId
        delete config.laneId
        delete config.laneName
    }

    const patch = {
        line_id: isAuxiliaryDeviceConfig(device) ? (device.line_id || null) : line.id,
        instance_config: JSON.stringify(config, null, 2)
    }
    patchDeviceLocally(device.id, patch)
    lineDeviceSavingId.value = device.id
    try {
        const payload = buildDevicePayloadForSave({ ...device, ...patch, instance_config: config }, line.workshop_id)
        const result = await adminApi.updateDevice(device.id, payload)
        if (result?.error) {
            await loadDevices()
            return alert(result.error, { title: '移出画布失败', type: 'danger' })
        }
        await loadDevices()
        await reloadSavedNativeScenePreview('lines')
    } finally {
        lineDeviceSavingId.value = ''
    }
}

function getWorkshopRailOptions(workshopId) {
    return sortByOrder(lines.value)
        .filter(line => line.workshop_id === workshopId)
        .flatMap(line => getLineLayout(line).rails.map(rail => ({
            ...rail,
            lineId: line.id,
            lineName: line.name,
            workshopId: line.workshop_id,
            worldZ: getLineBaseZ(line.id) + numberOrDefault(rail.offsetZ, 0)
        })))
}

const composerRailOptions = computed(() => {
    const workshopId = selectedComposerWorkshop.value?.id || getDeviceWorkshopId(composerDraft)
    return workshopId ? getWorkshopRailOptions(workshopId) : []
})

function updateComposerDraftInstanceConfig(patch) {
    const config = {
        ...getDeviceDefaultInstanceConfig(composerDraft),
        ...parseInstanceConfig(composerDraft.instance_config),
        ...patch
    }
    if (config.mirrorX === false) delete config.mirrorX
    composerDraft.instance_config = JSON.stringify(config, null, 2)
}

const composerDraftMirrorX = computed({
    get: () => !!parseInstanceConfig(composerDraft.instance_config).mirrorX,
    set: (value) => updateComposerDraftInstanceConfig({ mirrorX: !!value })
})

function toggleComposerMirrorX() {
    composerDraftMirrorX.value = !composerDraftMirrorX.value
}

function railOptionKey(rail) {
    return `${rail.lineId}::${rail.id}`
}

function findRailOptionByKey(key) {
    return composerRailOptions.value.find(rail => railOptionKey(rail) === key) || null
}

function applyRailBindingToComposerDraft(rail) {
    if (!rail) return
    const halfLength = numberOrDefault(rail.length, 60) / 2
    const nextX = Math.min(halfLength, Math.max(-halfLength, numberOrDefault(composerDraft.pos_x, 0)))
    composerDraft.pos_x = roundComposerNumber(nextX, 2)
    composerDraft.pos_z = roundComposerNumber(rail.worldZ, 2)
    composerDraft.line_id = rail.lineId
    updateComposerDraftInstanceConfig({
        role: 'transfer_cart',
        workshop_id: rail.workshopId,
        railLineId: rail.lineId,
        railId: rail.id,
        railName: rail.name
    })
}

const composerDraftRailKey = computed({
    get: () => {
        const config = parseInstanceConfig(composerDraft.instance_config)
        if (!config.railLineId || !config.railId) return ''
        return `${config.railLineId}::${config.railId}`
    },
    set: (value) => {
        const rail = findRailOptionByKey(value)
        if (rail) applyRailBindingToComposerDraft(rail)
    }
})

function findNearestComposerRail(position) {
    if (!composerRailOptions.value.length) return null
    const config = parseInstanceConfig(composerDraft.instance_config)
    const selectedRail = config.railLineId && config.railId
        ? findRailOptionByKey(`${config.railLineId}::${config.railId}`)
        : null
    if (selectedRail) return selectedRail
    const z = numberOrDefault(position?.z, numberOrDefault(composerDraft.pos_z, 0))
    return [...composerRailOptions.value].sort((a, b) => Math.abs(a.worldZ - z) - Math.abs(b.worldZ - z))[0] || null
}

function snapComposerTransferCartToRail(position = {}) {
    const config = parseInstanceConfig(composerDraft.instance_config)
    if (composerDraft.model_type !== 'transfer_cart' && config.role !== 'transfer_cart') return
    const rail = findNearestComposerRail(position)
    if (!rail) return
    const halfLength = numberOrDefault(rail.length, 60) / 2
    const x = numberOrDefault(position.x, numberOrDefault(composerDraft.pos_x, 0))
    composerDraft.pos_x = roundComposerNumber(Math.min(halfLength, Math.max(-halfLength, x)), 2)
    composerDraft.pos_y = roundComposerNumber(position.y ?? composerDraft.pos_y, 2)
    composerDraft.pos_z = roundComposerNumber(rail.worldZ, 2)
    if (composerDraft.line_id !== rail.lineId) composerDraft.line_id = rail.lineId
    updateComposerDraftInstanceConfig({
        role: 'transfer_cart',
        workshop_id: rail.workshopId,
        railLineId: rail.lineId,
        railId: rail.id,
        railName: rail.name
    })
}

// 产线按车间分组
const linesByWorkshop = computed(() => {
    const map = {}
    lines.value.forEach(l => {
        if (!map[l.workshop_id]) map[l.workshop_id] = []
        map[l.workshop_id].push(l)
    })
    return map
})

const selectedWorkshopMapLines = computed(() => sortByOrder(
    lines.value.filter(line => line.workshop_id === selectedWorkshopEditor.value?.id)
))

const placedWorkshopMapLines = computed(() => (
    selectedWorkshopMapLines.value.filter(line => !isLinePlacementPending(line))
))

const pendingWorkshopMapLines = computed(() => (
    selectedWorkshopMapLines.value.filter(isLinePlacementPending)
))

const activePendingWorkshopMapLine = computed(() => (
    pendingWorkshopMapLines.value.find(line => line.id === workshopMapPendingDragLineId.value)
    || null
))

const workshopMapDirty = computed(() => selectedWorkshopMapLines.value.some(line => (
    linePlacementSnapshot(line) !== savedLinePlacementSnapshots.value[line.id]
)))

const selectedWorkshopMapLine = computed(() => (
    placedWorkshopMapLines.value.find(line => line.id === workshopMapSelectedLineId.value)
    || placedWorkshopMapLines.value[0]
    || null
))

function ensureWorkshopMapLineSelection() {
    const available = placedWorkshopMapLines.value
    if (!available.some(line => line.id === workshopMapSelectedLineId.value)) {
        workshopMapSelectedLineId.value = available[0]?.id || ''
    }
}

function workshopLineFootprint(line) {
    const layout = getLineLayout(line)
    const tracks = [
        ...layout.lanes.map(item => ({ ...item, type: 'lane', bandWidth: 4 })),
        ...layout.rails.map(item => ({ ...item, type: 'rail', bandWidth: 3 }))
    ]
    const sourceTracks = tracks.length ? tracks : [{ id: 'default', type: 'lane', offsetZ: 0, length: 60, bandWidth: 4 }]
    const length = Math.max(1, ...sourceTracks.map(item => numberOrDefault(item.length, 60)))
    const minZ = Math.min(...sourceTracks.map(item => numberOrDefault(item.offsetZ, 0) - item.bandWidth / 2))
    const maxZ = Math.max(...sourceTracks.map(item => numberOrDefault(item.offsetZ, 0) + item.bandWidth / 2))
    return {
        length: roundLineLayoutValue(length, 0.1),
        width: roundLineLayoutValue(Math.max(6, maxZ - minZ), 0.1),
        minZ,
        maxZ,
        tracks: sourceTracks
    }
}

function workshopLineRotatedBounds(line) {
    const footprint = workshopLineFootprint(line)
    const angle = numberOrDefault(getLineLayout(line).transform.rotationY, 0) * Math.PI / 180
    return {
        width: Math.abs(footprint.length * Math.cos(angle)) + Math.abs(footprint.width * Math.sin(angle)),
        depth: Math.abs(footprint.length * Math.sin(angle)) + Math.abs(footprint.width * Math.cos(angle))
    }
}

function workshopMapLineStyle(line) {
    const workshop = selectedWorkshopEditor.value
    if (!workshop) return {}
    const workshopLayout = getWorkshopLayout(workshop)
    const width = Math.max(10, numberOrDefault(workshopLayout.size.width, 100))
    const depth = Math.max(10, numberOrDefault(workshopLayout.size.depth, 80))
    const lineLayout = getLineLayout(line)
    const footprint = workshopLineFootprint(line)
    const centerX = ((numberOrDefault(lineLayout.transform.x, 0) + width / 2) / width) * 100
    const centerZ = ((numberOrDefault(lineLayout.transform.z, 0) + depth / 2) / depth) * 100
    return {
        left: `${centerX}%`,
        top: `${centerZ}%`,
        width: `${Math.min(160, Math.max(4, footprint.length / width * 100))}%`,
        height: `${Math.min(160, Math.max(7, footprint.width / depth * 100))}%`,
        transform: `translate(-50%, -50%) rotate(${numberOrDefault(lineLayout.transform.rotationY, 0)}deg)`
    }
}

function workshopMapTrackStyle(track, line) {
    const footprint = workshopLineFootprint(line)
    const top = ((numberOrDefault(track.offsetZ, 0) - footprint.minZ) / Math.max(0.1, footprint.maxZ - footprint.minZ)) * 100
    const width = Math.min(100, Math.max(6, numberOrDefault(track.length, 60) / footprint.length * 100))
    return {
        left: `${(100 - width) / 2}%`,
        top: `${Math.min(96, Math.max(4, top))}%`,
        width: `${width}%`
    }
}

function workshopMapLineOutside(line) {
    const workshop = selectedWorkshopEditor.value
    if (!workshop || isLinePlacementPending(line)) return false
    const size = getWorkshopLayout(workshop).size
    const transform = getLineLayout(line).transform
    const bounds = workshopLineRotatedBounds(line)
    return Math.abs(numberOrDefault(transform.x, 0)) + bounds.width / 2 > numberOrDefault(size.width, 100) / 2
        || Math.abs(numberOrDefault(transform.z, 0)) + bounds.depth / 2 > numberOrDefault(size.depth, 80) / 2
}

const selectedWorkshopMapMetrics = computed(() => {
    const workshop = selectedWorkshopEditor.value
    const line = selectedWorkshopMapLine.value
    if (!workshop || !line) return null
    const size = getWorkshopLayout(workshop).size
    const transform = getLineLayout(line).transform
    const bounds = workshopLineRotatedBounds(line)
    const centerX = numberOrDefault(transform.x, 0)
    const centerZ = numberOrDefault(transform.z, 0)
    const boundary = {
        left: centerX - bounds.width / 2 + numberOrDefault(size.width, 100) / 2,
        right: numberOrDefault(size.width, 100) / 2 - centerX - bounds.width / 2,
        top: centerZ - bounds.depth / 2 + numberOrDefault(size.depth, 80) / 2,
        bottom: numberOrDefault(size.depth, 80) / 2 - centerZ - bounds.depth / 2
    }
    const nearest = placedWorkshopMapLines.value
        .filter(item => item.id !== line.id)
        .map(item => {
            const otherTransform = getLineLayout(item).transform
            const otherBounds = workshopLineRotatedBounds(item)
            const gapX = Math.max(0, Math.abs(centerX - numberOrDefault(otherTransform.x, 0)) - (bounds.width + otherBounds.width) / 2)
            const gapZ = Math.max(0, Math.abs(centerZ - numberOrDefault(otherTransform.z, 0)) - (bounds.depth + otherBounds.depth) / 2)
            return { line: item, distance: Math.sqrt(gapX * gapX + gapZ * gapZ), overlaps: gapX === 0 && gapZ === 0 }
        })
        .sort((a, b) => a.distance - b.distance)[0] || null
    return {
        boundary: Object.fromEntries(Object.entries(boundary).map(([key, value]) => [key, roundLineLayoutValue(value, 0.1)])),
        nearest: nearest ? { ...nearest, distance: roundLineLayoutValue(nearest.distance, 0.1) } : null
    }
})

function selectWorkshopMapLine(line) {
    if (!line?.id || isLinePlacementPending(line)) return
    workshopMapSelectedLineId.value = line.id
    selectedLineEditorId.value = line.id
}

function finishWorkshopPendingLineDrag() {
    const state = workshopMapPendingDragState
    workshopMapPendingDragState = null
    workshopMapPendingDragLineId.value = ''
    workshopMapPendingDropReady.value = false
    if (workshopMapPendingGhostFrame) cancelAnimationFrame(workshopMapPendingGhostFrame)
    workshopMapPendingGhostFrame = 0
    window.removeEventListener('pointermove', moveWorkshopPendingLineDrag)
    window.removeEventListener('pointerup', endWorkshopPendingLineDrag)
    window.removeEventListener('pointercancel', finishWorkshopPendingLineDrag)
    document.body.classList.remove('workshop-pending-line-dragging')
    if (state?.captureTarget?.hasPointerCapture?.(state.pointerId)) {
        state.captureTarget.releasePointerCapture(state.pointerId)
    }
    return state
}

function updateWorkshopPendingLineGhost(clientX, clientY) {
    workshopMapPendingGhostPosition = { x: clientX, y: clientY }
    if (workshopMapPendingGhostFrame) return
    workshopMapPendingGhostFrame = requestAnimationFrame(() => {
        workshopMapPendingGhostFrame = 0
        const ghost = workshopMapPendingGhostRef.value
        if (!ghost) return
        const { x, y } = workshopMapPendingGhostPosition
        ghost.style.transform = `translate3d(${Math.round(x + 14)}px, ${Math.round(y + 14)}px, 0)`
    })
}

function isWorkshopPendingLineDropPoint(clientX, clientY) {
    const stage = workshopMapStageRef.value
    if (!stage || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false
    const rect = stage.getBoundingClientRect()
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false
    const hitTarget = document.elementFromPoint(clientX, clientY)
    return !hitTarget?.closest?.('.workshop-line-placement-dock')
}

function moveWorkshopPendingLineDrag(event) {
    const state = workshopMapPendingDragState
    if (!state || event.pointerId !== state.pointerId) return
    const distance = Math.hypot(event.clientX - state.startClientX, event.clientY - state.startClientY)
    if (distance >= 8) state.moved = true
    workshopMapPendingDropReady.value = state.moved && isWorkshopPendingLineDropPoint(event.clientX, event.clientY)
    updateWorkshopPendingLineGhost(event.clientX, event.clientY)
    event.preventDefault()
}

function placePendingWorkshopMapLine(lineId, clientX, clientY) {
    const line = pendingWorkshopMapLines.value.find(item => item.id === lineId)
    const stage = workshopMapStageRef.value
    const workshop = selectedWorkshopEditor.value
    if (!line || !stage || !workshop) return false

    const rect = stage.getBoundingClientRect()
    const workshopSize = getWorkshopLayout(workshop).size
    const workshopWidth = Math.max(10, numberOrDefault(workshopSize.width, 100))
    const workshopDepth = Math.max(10, numberOrDefault(workshopSize.depth, 80))
    const bounds = workshopLineRotatedBounds(line)
    if (bounds.width > workshopWidth || bounds.depth > workshopDepth) {
        alert(
            `「${line.name}」占地 ${roundLineLayoutValue(bounds.width, 0.1)} × ${roundLineLayoutValue(bounds.depth, 0.1)} 米，超过当前车间边界。请先缩短产线结构或扩大车间。`,
            { title: '暂时无法放置', type: 'danger' }
        )
        return false
    }

    const pointerX = Number.isFinite(clientX) ? clientX : rect.left + rect.width / 2
    const pointerY = Number.isFinite(clientY) ? clientY : rect.top + rect.height / 2
    const rawX = ((pointerX - rect.left) / Math.max(1, rect.width) - 0.5) * workshopWidth
    const rawZ = ((pointerY - rect.top) / Math.max(1, rect.height) - 0.5) * workshopDepth
    const limitX = Math.max(0, (workshopWidth - bounds.width) / 2)
    const limitZ = Math.max(0, (workshopDepth - bounds.depth) / 2)
    const layout = getLineLayout(line)
    layout.transform.x = roundLineLayoutValue(Math.min(limitX, Math.max(-limitX, rawX)), 0.5)
    layout.transform.z = roundLineLayoutValue(Math.min(limitZ, Math.max(-limitZ, rawZ)), 0.5)
    layout.placementPending = false
    touchLineLayout(line)
    workshopMapPlacementHintLineId.value = ''
    selectWorkshopMapLine(line)
    scheduleNativeScenePreview({ source: 'spatial', includeLayout: true })
    return true
}

function endWorkshopPendingLineDrag(event) {
    const state = workshopMapPendingDragState
    if (!state || event.pointerId !== state.pointerId) return
    const canDrop = state.moved && isWorkshopPendingLineDropPoint(event.clientX, event.clientY)
    const lineId = state.lineId
    const clientX = event.clientX
    const clientY = event.clientY
    finishWorkshopPendingLineDrag()
    if (canDrop) placePendingWorkshopMapLine(lineId, clientX, clientY)
}

function startWorkshopPendingLineDrag(event, line) {
    if (event.button !== 0 || !line?.id || !isLinePlacementPending(line)) return
    finishWorkshopPendingLineDrag()
    event.preventDefault()
    event.stopPropagation()
    const captureTarget = event.currentTarget
    workshopMapPendingDragState = {
        lineId: line.id,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
        captureTarget
    }
    workshopMapPendingDragLineId.value = line.id
    workshopMapPlacementHintLineId.value = line.id
    workshopMapPendingDropReady.value = false
    document.body.classList.add('workshop-pending-line-dragging')
    captureTarget?.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointermove', moveWorkshopPendingLineDrag, { passive: false })
    window.addEventListener('pointerup', endWorkshopPendingLineDrag)
    window.addEventListener('pointercancel', finishWorkshopPendingLineDrag)
    updateWorkshopPendingLineGhost(event.clientX, event.clientY)
}

async function openLinePlacement(line) {
    if (!line?.id || !line.workshop_id) return
    selectedWorkshopEditorId.value = line.workshop_id
    workshopMapPlacementHintLineId.value = line.id
    selectAdminTab('workshops')
    selectWorkshopManagementStep('layout')
    await nextTick()
    adminContentRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

function previewWorkshopMapLine(line = selectedWorkshopMapLine.value) {
    if (!line || isLinePlacementPending(line)) return
    touchLineLayout(line)
    scheduleNativeScenePreview({ source: 'spatial', includeLayout: true })
}

function moveWorkshopMapLine(event) {
    const state = workshopMapDragState
    if (!state) return
    const line = lines.value.find(item => item.id === state.lineId)
    if (!line) return finishWorkshopMapLineDrag()
    const layout = getLineLayout(line)
    const bounds = workshopLineRotatedBounds(line)
    const deltaX = (event.clientX - state.clientX) / Math.max(1, state.stageWidth) * state.workshopWidth
    const deltaZ = (event.clientY - state.clientY) / Math.max(1, state.stageHeight) * state.workshopDepth
    const limitX = Math.max(0, (state.workshopWidth - bounds.width) / 2)
    const limitZ = Math.max(0, (state.workshopDepth - bounds.depth) / 2)
    layout.transform.x = roundLineLayoutValue(Math.min(limitX, Math.max(-limitX, state.startX + deltaX)), 0.5)
    layout.transform.z = roundLineLayoutValue(Math.min(limitZ, Math.max(-limitZ, state.startZ + deltaZ)), 0.5)
    previewWorkshopMapLine(line)
}

function finishWorkshopMapLineDrag() {
    if (!workshopMapDragState) return
    workshopMapDragState = null
    workshopMapDraggingLineId.value = ''
    window.removeEventListener('pointermove', moveWorkshopMapLine)
    window.removeEventListener('pointerup', finishWorkshopMapLineDrag)
    window.removeEventListener('pointercancel', finishWorkshopMapLineDrag)
    document.body.style.userSelect = ''
}

function startWorkshopMapLineDrag(event, line) {
    if (event.button !== 0 || !line || isLinePlacementPending(line)) return
    const stage = workshopMapStageRef.value
    const workshop = selectedWorkshopEditor.value
    if (!stage || !workshop) return
    event.preventDefault()
    selectWorkshopMapLine(line)
    const rect = stage.getBoundingClientRect()
    const workshopSize = getWorkshopLayout(workshop).size
    const transform = getLineLayout(line).transform
    finishWorkshopMapLineDrag()
    workshopMapDragState = {
        lineId: line.id,
        clientX: event.clientX,
        clientY: event.clientY,
        startX: numberOrDefault(transform.x, 0),
        startZ: numberOrDefault(transform.z, 0),
        stageWidth: rect.width,
        stageHeight: rect.height,
        workshopWidth: Math.max(10, numberOrDefault(workshopSize.width, 100)),
        workshopDepth: Math.max(10, numberOrDefault(workshopSize.depth, 80))
    }
    workshopMapDraggingLineId.value = line.id
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', moveWorkshopMapLine)
    window.addEventListener('pointerup', finishWorkshopMapLineDrag)
    window.addEventListener('pointercancel', finishWorkshopMapLineDrag)
}

async function saveWorkshopMapLayout() {
    const workshop = selectedWorkshopEditor.value
    const targetLines = placedWorkshopMapLines.value
    if (!workshop || !targetLines.length) return
    workshopMapSaving.value = true
    try {
        for (const line of targetLines) {
            const layout = normalizeLineLayout(getLineLayout(line))
            const result = await adminApi.updateLine(line.id, {
                name: line.name,
                workshop_id: line.workshop_id,
                sort_order: line.sort_order,
                layout,
                layout_json: JSON.stringify(layout)
            })
            if (result?.error || !result?.success) throw new Error(result?.error || `${line.name} 保存失败`)
        }
        await loadLines()
        ensureWorkshopMapLineSelection()
        await reloadSavedNativeScenePreview('spatial')
        await alert(`${workshop.name} 的 ${targetLines.length} 条产线位置已保存`, { title: '布局保存成功', type: 'success' })
    } catch (error) {
        await alert(error.message || '保存车间产线布局失败', { title: '保存失败', type: 'danger' })
    } finally {
        workshopMapSaving.value = false
    }
}

async function resetWorkshopMapLayout() {
    finishWorkshopMapLineDrag()
    finishWorkshopPendingLineDrag()
    workshopMapPlacementHintLineId.value = ''
    await loadLines()
    ensureWorkshopMapLineSelection()
    await reloadSavedNativeScenePreview('spatial')
}

function openSelectedWorkshopLineEditor() {
    const line = selectedWorkshopMapLine.value
    if (!line) return
    selectedLineEditorId.value = line.id
    selectAdminTab('lines')
}

const factoryTabs = [
    { key: 'workshops', label: '车间管理', icon: 'workshops' },
    { key: 'lines', label: '产线管理', icon: 'lines' },
    { key: 'devices', label: '设备管理', icon: 'devices' }
]
const factoryTabKeys = factoryTabs.map(tab => tab.key)
const dataTabs = [
    { key: 'points', label: '点位映射', icon: 'points' },
    { key: 'point-monitor', label: '点位监视', icon: 'points' }
]
const dataTabKeys = dataTabs.map(tab => tab.key)
const mainTabs = [
    { key: 'composer', label: '现场编排器', icon: 'composer' },
    { key: 'models', label: '模型库', icon: 'models' },
    { key: 'platform', label: '组件配置', icon: 'platform' },
    { key: 'settings', label: '系统设置', icon: 'settings' }
]

const adminSetupFlow = [
    { key: 'system', label: '系统', tab: 'settings', settingsSubpage: 'database', description: '确认数据库、运行服务与数据通路' },
    { key: 'workshop', label: '车间', tab: 'workshops', description: '建立车间并确定空间范围' },
    { key: 'line', label: '产线', tab: 'lines', description: '创建产线、设备线与导轨结构' },
    { key: 'model', label: '模型', tab: 'models', description: '导入并验收设备 3D 模型' },
    { key: 'device', label: '设备', tab: 'devices', description: '创建设备并关联产线和模型' },
    { key: 'composer', label: '编排', tab: 'composer', description: '调整设备位置、朝向与缩放' },
    { key: 'points', label: '点位', tab: 'points', description: '配置 PLC 点位名称、地址与周期' },
    { key: 'screen', label: '画面', tab: 'platform', platformSubpage: 'designer', description: '设计组件、绑定数据并发布画面' },
    { key: 'verify', label: '验收', tab: 'point-monitor', description: '检查实时值、数据质量与连接状态' }
]

async function openAdminSetupStep(step) {
    if (!step?.tab) return
    if (factoryTabKeys.includes(step.tab)) isFactoryMenuOpen.value = true
    if (dataTabKeys.includes(step.tab)) isDataMenuOpen.value = true
    if (step.settingsSubpage) settingsSubpage.value = step.settingsSubpage
    if (step.platformSubpage) platformSubpage.value = step.platformSubpage
    selectAdminTab(step.tab)
    await nextTick()
    adminContentRef.value?.scrollTo({ top: 0, behavior: 'smooth' })
    if (step.tab === 'platform' && step.platformSubpage === 'designer') {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }
}
</script>

<template>
    <div class="admin-container" :class="{ 'unity-embedded': isUnityEmbedded, 'unity-dashboard-tab': isUnityEmbedded && unityHostState.attached && !unityHostState.adminVisible, 'nav-collapsed': isAdminNavCollapsed, 'composer-active': activeTab === 'composer', 'line-planner-active': activeTab === 'lines' }">
        <div
            v-if="isUnityEmbedded"
            class="unity-window-chrome"
            :class="{ 'is-dock-ready': unityHostState.dockReady }"
            @pointerdown="beginUnityHostDrag($event, 'dashboard')"
            @pointermove="continueUnityHostDrag"
            @pointerup="endUnityHostDrag"
            @pointercancel="endUnityHostDrag"
            @lostpointercapture="endUnityHostDrag"
            @dblclick="handleUnityChromeDoubleClick"
        >
            <div
                class="unity-tab-strip"
            >
                <button
                    v-if="unityHostState.attached"
                    type="button"
                    class="unity-browser-tab unity-screen-tab"
                    :class="{ 'is-active': !unityHostState.adminVisible }"
                    title="实时大屏"
                    @pointerdown.stop="beginUnityHostDrag($event, 'dashboard')"
                    @pointermove.stop="continueUnityHostDrag"
                    @pointerup.stop="endUnityHostDrag"
                    @pointercancel.stop="endUnityHostDrag"
                    @lostpointercapture.stop="endUnityHostDrag"
                    @click="showUnityDashboard"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
                        <path d="M8 20h8M12 16.5V20" />
                    </svg>
                    <span>实时大屏</span>
                </button>

                <div
                    class="unity-browser-tab unity-admin-tab"
                    :class="{ 'is-active': !unityHostState.attached || unityHostState.adminVisible }"
                    role="tab"
                    aria-selected="true"
                    title="后台管理"
                    @pointerdown.stop="beginUnityHostDrag($event, 'admin')"
                    @pointermove.stop="continueUnityHostDrag"
                    @pointerup.stop="endUnityHostDrag"
                    @pointercancel.stop="endUnityHostDrag"
                    @lostpointercapture.stop="endUnityHostDrag"
                    @click="showUnityAdmin"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h7M15 17h5" />
                        <circle cx="16" cy="7" r="2" />
                        <circle cx="8" cy="12" r="2" />
                        <circle cx="13" cy="17" r="2" />
                    </svg>
                    <span>后台管理</span>
                    <i class="unity-tab-online" aria-hidden="true"></i>
                </div>

            </div>

            <div class="unity-window-actions" @pointerdown.stop>
                <button
                    type="button"
                    class="unity-window-action"
                    title="刷新页面"
                    aria-label="刷新页面"
                    @click="reloadAdminPage"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M19 8a7.5 7.5 0 1 0 .8 6.8" />
                        <path d="M19 4v4h-4" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="unity-window-action"
                    title="最小化"
                    aria-label="最小化窗口"
                    @click="requestUnityHostAction('minimize')"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M5 16.5h14" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="unity-window-action"
                    :title="unityHostState.maximized ? '还原' : '最大化'"
                    :aria-label="unityHostState.maximized ? '还原窗口' : '最大化窗口'"
                    @click="requestUnityHostAction('maximize')"
                >
                    <svg v-if="unityHostState.maximized" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="7" y="5" width="11" height="11" rx="1" />
                        <path d="M7 9H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
                    </svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="5" y="5" width="14" height="14" rx="1.5" />
                    </svg>
                </button>
                <button
                    type="button"
                    class="unity-window-action is-close"
                    title="关闭软件"
                    aria-label="关闭软件"
                    @click="closeAdminPanel"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                </button>
            </div>
        </div>
        <!-- 顶部标题栏 -->
        <header class="admin-header">
            <div class="header-logo-section">
                <span class="header-logo-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                        <path d="M4 19V7l8-4 8 4v12" />
                        <path d="M8 19v-7h8v7" />
                        <path d="M10 8h4" />
                    </svg>
                </span>
                <h1>数字孪生后台配置管理</h1>
            </div>
            <nav class="admin-setup-flow" aria-label="推荐配置顺序">
                <span class="admin-setup-flow-title">配置顺序</span>
                <div class="admin-setup-flow-track">
                    <template v-for="(step, index) in adminSetupFlow" :key="step.key">
                        <button
                            type="button"
                            class="admin-setup-step"
                            :class="{ active: activeTab === step.tab }"
                            :aria-current="activeTab === step.tab ? 'step' : undefined"
                            :aria-label="`第 ${index + 1} 步：${step.label}，${step.description}`"
                            :title="`${index + 1}. ${step.label} · ${step.description}`"
                            @click="openAdminSetupStep(step)"
                        >
                            <span class="admin-setup-step-index">{{ index + 1 }}</span>
                            <span class="admin-setup-step-label">{{ step.label }}</span>
                        </button>
                        <span v-if="index < adminSetupFlow.length - 1" class="admin-setup-flow-connector" aria-hidden="true"></span>
                    </template>
                </div>
            </nav>
            <div class="admin-connection-strip" aria-label="系统连接状态" aria-live="polite">
                <span
                    class="admin-connection-pill"
                    :class="nativeScenePreviewStatusClass"
                    :title="nativeScenePreviewStatus"
                >
                    <i aria-hidden="true"></i>
                    {{ nativeSceneHeaderLabel }}
                </span>
                <span
                    class="admin-connection-pill"
                    :class="deviceConnectionSummary.tone"
                    :title="deviceConnectionSummary.detail"
                >
                    <i aria-hidden="true"></i>
                    {{ deviceConnectionSummary.label }}
                </span>
            </div>
        </header>

        <div class="admin-body">
            <!-- 左侧 Tab 导航 -->
            <nav class="admin-nav">
                <button
                    v-for="tab in mainTabs.slice(0, 1)"
                    :key="tab.key"
                    type="button"
                    class="nav-item"
                    :class="{ active: activeTab === tab.key }"
                    :title="tab.label"
                    @click="selectAdminTab(tab.key)"
                >
                    <span class="nav-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                        </svg>
                    </span>
                    <span class="nav-label">{{ tab.label }}</span>
                </button>
                <div class="nav-group" :class="{ active: factoryTabKeys.includes(activeTab), open: isFactoryMenuOpen }">
                    <button
                        type="button"
                        class="nav-item nav-group-toggle"
                        :class="{ active: factoryTabKeys.includes(activeTab) }"
                        title="工厂建模"
                        @click="isFactoryMenuOpen = !isFactoryMenuOpen"
                    >
                        <span class="nav-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <path v-for="(path, index) in navIconPaths.factory" :key="index" :d="path" />
                            </svg>
                        </span>
                        <span class="nav-label">工厂建模</span>
                        <span class="nav-chevron">⌄</span>
                    </button>
                    <Transition name="nav-submenu">
                        <div v-if="isFactoryMenuOpen || isAdminNavCollapsed" class="nav-submenu">
                            <button
                                v-for="tab in factoryTabs"
                                :key="tab.key"
                                type="button"
                                class="nav-item nav-subitem"
                                :class="{ active: activeTab === tab.key }"
                                :title="tab.label"
                                @click="selectAdminTab(tab.key)"
                            >
                                <span class="nav-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24">
                                        <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                                    </svg>
                                </span>
                                <span class="nav-label">{{ tab.label }}</span>
                            </button>
                        </div>
                    </Transition>
                </div>
                <div class="nav-group" :class="{ active: dataTabKeys.includes(activeTab), open: isDataMenuOpen }">
                    <button
                        type="button"
                        class="nav-item nav-group-toggle"
                        :class="{ active: dataTabKeys.includes(activeTab) }"
                        title="数据采集"
                        @click="isDataMenuOpen = !isDataMenuOpen"
                    >
                        <span class="nav-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                                <path v-for="(path, index) in navIconPaths.data" :key="index" :d="path" />
                            </svg>
                        </span>
                        <span class="nav-label">数据采集</span>
                        <span class="nav-chevron">⌄</span>
                    </button>
                    <Transition name="nav-submenu">
                        <div v-if="isDataMenuOpen || isAdminNavCollapsed" class="nav-submenu">
                            <button
                                v-for="tab in dataTabs"
                                :key="tab.key"
                                type="button"
                                class="nav-item nav-subitem"
                                :class="{ active: activeTab === tab.key }"
                                :title="tab.label"
                                @click="selectAdminTab(tab.key)"
                            >
                                <span class="nav-icon" aria-hidden="true">
                                    <svg viewBox="0 0 24 24">
                                        <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                                    </svg>
                                </span>
                                <span class="nav-label">{{ tab.label }}</span>
                            </button>
                        </div>
                    </Transition>
                </div>
                <button
                    v-for="tab in mainTabs.slice(1)"
                    :key="tab.key"
                    type="button"
                    class="nav-item"
                    :class="{ active: activeTab === tab.key }"
                    :title="tab.label"
                    @click="selectAdminTab(tab.key)"
                >
                    <span class="nav-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24">
                            <path v-for="(path, index) in navIconPaths[tab.icon]" :key="index" :d="path" />
                        </svg>
                    </span>
                    <span class="nav-label">{{ tab.label }}</span>
                </button>
            </nav>
            <button
                class="nav-collapse-btn"
                type="button"
                :title="isAdminNavCollapsed ? '展开导航' : '收起导航'"
                :aria-label="isAdminNavCollapsed ? '展开导航' : '收起导航'"
                @click="toggleAdminNavCollapsed"
            >
                <span class="nav-collapse-icon">{{ isAdminNavCollapsed ? '›' : '‹' }}</span>
            </button>

            <!-- 右侧内容区 -->
            <main ref="adminContentRef" class="admin-content">
                <Transition name="tab-switch" mode="out-in">
                    <div :key="activeTab" class="tab-transition-host">

                <!-- ======== 现场编排器 ======== -->
                <div v-if="activeTab === 'composer'" class="tab-content composer-tab" :class="{ 'preview-wide': isComposerPreviewWide }">
                    <section class="composer-editor">
                        <div class="composer-section">
                            <h2>现场编排器</h2>
                            <p class="desc">这里现在直接控制正在运行的 Unity。左侧调整会实时生效，右侧 Web 画面仅用于快速选取和操作定位。</p>
                            <div class="native-live-row">
                                <button type="button" class="btn btn-sm" @click="restoreSavedNativeScenePreview">恢复已保存布局</button>
                            </div>
                            <div class="composer-stat-grid">
                                <div><span>车间</span><strong>{{ composerStats.workshops }}</strong></div>
                                <div><span>产线</span><strong>{{ composerStats.lines }}</strong></div>
                                <div><span>设备</span><strong>{{ composerStats.devices }}</strong></div>
                                <div><span>当前线</span><strong>{{ composerStats.selectedLineDevices }}</strong></div>
                            </div>
                        </div>

                        <div class="composer-section">
                            <h3>产线选择</h3>
                            <select v-model="selectedComposerLineId" class="input composer-select">
                                <option v-for="line in placedLines" :key="line.id" :value="line.id">
                                    {{ workshops.find(w => w.id === line.workshop_id)?.name || line.workshop_id }} / {{ line.name }}
                                </option>
                            </select>
                            <div class="composer-line-list">
                                <button
                                    v-for="line in placedLines"
                                    :key="line.id"
                                    class="line-pill"
                                    :class="{ active: selectedComposerLineId === line.id }"
                                    @click="selectComposerLine(line.id)"
                                >
                                    <span>{{ line.name }}</span>
                                    <em>{{ (lineMemberDevicesByLine[line.id] || []).length }} 台</em>
                                </button>
                            </div>
                            <div class="composer-action-row">
                                <button class="btn btn-sm" type="button" @click="flipSelectedComposerLine" :disabled="composerBulkSaving || !selectedComposerDevices.length">
                                    产线反向
                                </button>
                            </div>
                        </div>

                        <div class="composer-section">
                            <h3>设备列表</h3>
                            <div class="composer-device-list" v-if="selectedComposerDevices.length">
                                <button
                                    v-for="device in selectedComposerDevices"
                                    :key="device.id"
                                    class="device-pill"
                                    :class="{ active: selectedComposerDeviceId === device.id }"
                                    :aria-pressed="selectedComposerDeviceId === device.id"
                                    :title="selectedComposerDeviceId === device.id ? '点击取消选中' : '选择并编辑设备'"
                                    @click="selectComposerDevice(device.id)"
                                >
                                    <strong>{{ device.name }}</strong>
                                    <span>X {{ device.pos_x }} / Z {{ device.pos_z }} <i v-if="selectedComposerDeviceId === device.id" class="device-pill-cancel">×</i></span>
                                </button>
                            </div>
                            <div v-else class="composer-empty">当前产线还没有设备</div>
                        </div>

                        <div class="composer-section" v-if="selectedComposerAuxDevices.length">
                            <h3>辅助设备</h3>
                            <div class="composer-device-list">
                                <button
                                    v-for="device in selectedComposerAuxDevices"
                                    :key="device.id"
                                    class="device-pill"
                                    :class="{ active: selectedComposerDeviceId === device.id }"
                                    :aria-pressed="selectedComposerDeviceId === device.id"
                                    :title="selectedComposerDeviceId === device.id ? '点击取消选中' : '选择并编辑设备'"
                                    @click="selectComposerDevice(device.id)"
                                >
                                    <strong>{{ device.name }}</strong>
                                    <span>X {{ device.pos_x }} / Z {{ device.pos_z }} <i v-if="selectedComposerDeviceId === device.id" class="device-pill-cancel">×</i></span>
                                </button>
                            </div>
                        </div>

                        <Teleport defer to="#composer-preview-floating-host">
                        <div ref="composerLayoutPanelRef" class="composer-section composer-form composer-device-layout-float" v-if="composerDraft.id" :style="composerLayoutPanelStyle" @pointerdown.stop>
                            <div class="composer-device-layout-float-header" @pointerdown="startComposerLayoutPanelDrag">
                                <div><span>设备布局</span><strong>{{ composerDraft.name }}</strong></div>
                                <button type="button" title="取消选中" aria-label="取消选中设备" @pointerdown.stop @click.stop="clearComposerDeviceSelection">×</button>
                            </div>
                            <div class="composer-device-layout-float-body">
                            <label>设备名称<input v-model="composerDraft.name" class="input" /></label>
                            <label>{{ isAuxiliaryDeviceConfig(composerDraft) ? '参考产线' : '所属产线' }}
                                <select v-model="composerDraft.line_id" class="input">
                                    <option v-if="isAuxiliaryDeviceConfig(composerDraft)" value="">不挂产线，作为车间级设备</option>
                                    <option v-for="line in lines" :key="line.id" :value="line.id">{{ line.name }}</option>
                                </select>
                            </label>
                            <label>模型
                                <select v-model="composerDraft.model_type" class="input">
                                    <option v-for="m in availableModelOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
                                </select>
                            </label>
                            <div class="composer-grid-3">
                                <label>X<input v-model.number="composerDraft.pos_x" type="number" class="input" /></label>
                                <label>Y<input v-model.number="composerDraft.pos_y" type="number" class="input" /></label>
                                <label>Z<input v-model.number="composerDraft.pos_z" type="number" class="input" /></label>
                            </div>
                            <div class="composer-rotation-control">
                                <div class="composer-control-header">
                                    <span>朝向</span>
                                    <strong>{{ composerRotationDegrees }}</strong>
                                </div>
                                <div class="composer-rotation-presets">
                                    <button
                                        v-for="degrees in composerRotationPresets"
                                        :key="degrees"
                                        type="button"
                                        class="btn btn-sm"
                                        :class="{ active: composerRotationDegrees === `${degrees}°` }"
                                        @click="setComposerRotationDegrees(degrees)"
                                    >{{ degrees }}°</button>
                                </div>
                                <div class="composer-rotation-nudges">
                                    <button
                                        v-for="delta in composerRotationNudges"
                                        :key="delta"
                                        type="button"
                                        class="btn btn-sm"
                                        @click="nudgeComposerRotationDegrees(delta)"
                                    >{{ delta > 0 ? `+${delta}°` : `${delta}°` }}</button>
                                </div>
                            </div>
                            <div class="composer-mirror-control">
                                <div>
                                    <strong>左右镜像</strong>
                                    <span>同型号设备左右相反时使用，只影响当前实例</span>
                                </div>
                                <button
                                    type="button"
                                    class="btn btn-sm"
                                    :class="{ active: composerDraftMirrorX }"
                                    @click="toggleComposerMirrorX"
                                >
                                    {{ composerDraftMirrorX ? '已镜像' : '未镜像' }}
                                </button>
                            </div>
                            <label v-if="isComposerTransferCart(composerDraft.id)">小车导轨
                                <select v-model="composerDraftRailKey" class="input">
                                    <option value="" disabled>选择小车导轨</option>
                                    <option v-for="rail in composerRailOptions" :key="railOptionKey(rail)" :value="railOptionKey(rail)">
                                        {{ rail.lineName }} / {{ rail.name }}
                                    </option>
                                </select>
                            </label>
                            <div class="composer-grid-2">
                                <label>缩放<input v-model.number="composerDraft.scale" type="number" step="0.05" min="0.1" class="input" /></label>
                                <label>排序<input v-model.number="composerDraft.sort_order" type="number" class="input" /></label>
                            </div>
                            <div class="nudge-pad">
                                <button class="btn" @click="nudgeComposerDevice(0, -2)">上移</button>
                                <button class="btn" @click="nudgeComposerDevice(-2, 0)">左移</button>
                                <button class="btn" @click="nudgeComposerDevice(2, 0)">右移</button>
                                <button class="btn" @click="nudgeComposerDevice(0, 2)">下移</button>
                            </div>
                            <button class="btn btn-primary composer-save" @click="saveComposerDevice" :disabled="composerSaving">
                                {{ composerSaving ? '保存中...' : '保存设备布局' }}
                            </button>
                            <small class="native-live-help">位置、朝向、缩放、镜像和模型切换会先实时显示在 Unity；点击保存后才写入数据库。</small>
                            </div>
                        </div>
                        </Teleport>
                    </section>

                    <section ref="composerPreviewShellRef" class="composer-preview">
                        <div class="composer-preview-toolbar">
                            <div>
                                <strong>{{ selectedComposerWorkshop?.name || '未选择车间' }}</strong>
                                <span>{{ selectedComposerLine?.name || '未选择产线' }}</span>
                            </div>
                            <div class="preview-mode-buttons">
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'factory' }" @click="composerPreviewMode = 'factory'">总览</button>
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'workshop' }" @click="composerPreviewMode = 'workshop'">车间</button>
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'line' }" @click="composerPreviewMode = 'line'">产线</button>
                                <button class="btn btn-sm" :class="{ active: composerPreviewMode === 'device' }" :disabled="!selectedComposerDeviceId" @click="composerPreviewMode = 'device'">设备</button>
                            </div>
                            <div class="preview-camera-buttons">
                                <button class="btn btn-sm" type="button" title="适配当前视图" @click="fitComposerPreview">适配</button>
                                <button class="btn btn-sm btn-icon" type="button" title="放大视角" @click="controlComposerCamera('zoomIn')">+</button>
                                <button class="btn btn-sm btn-icon" type="button" title="缩小视角" @click="controlComposerCamera('zoomOut')">-</button>
                                <button class="btn btn-sm btn-icon" type="button" title="向左旋转" @click="controlComposerCamera('rotateLeft')">↺</button>
                                <button class="btn btn-sm btn-icon" type="button" title="向右旋转" @click="controlComposerCamera('rotateRight')">↻</button>
                                <button class="btn btn-sm preview-wide-btn" type="button" @click="toggleComposerPreviewWide">
                                    {{ isComposerPreviewWide ? '恢复编辑' : '放大预览' }}
                                </button>
                            </div>
                        </div>
                        <div ref="composerPreviewRef" class="composer-preview-stage"></div>
                        <div id="composer-preview-floating-host" class="composer-preview-floating-host"></div>
                        <div class="composer-preview-footer">
                            <span>{{ composerPreviewStatus }} · Web 操作辅助</span>
                        </div>
                    </section>
                </div>

                <!-- ======== 车间管理 ======== -->
                <div v-if="activeTab === 'workshops'" class="tab-content workshop-management-tab">
                    <div class="workshop-management-heading">
                        <div>
                            <h2>车间管理</h2>
                            <p class="desc">先建立车间，再定义空间边界，最后在比例画布上安排多条产线。</p>
                        </div>
                        <span v-if="selectedWorkshopEditor" class="workshop-current-chip">当前：{{ selectedWorkshopEditor.name }}</span>
                    </div>

                    <nav class="workshop-step-nav" aria-label="车间配置步骤">
                        <button
                            v-for="step in workshopManagementSteps"
                            :key="step.key"
                            type="button"
                            :class="{ active: workshopManagementStep === step.key }"
                            :disabled="step.key !== 'list' && !selectedWorkshopEditor"
                            @click="selectWorkshopManagementStep(step.key)"
                        >
                            <span class="workshop-step-number">{{ step.number }}</span>
                            <span class="workshop-step-copy">
                                <strong>{{ step.title }}</strong>
                                <small>{{ step.description }}</small>
                            </span>
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                        </button>
                    </nav>

                    <template v-if="workshopManagementStep === 'list'">
                        <div class="spatial-rule-banner">
                            <strong>统一空间层级</strong>
                            <span>工厂世界 → 车间（世界位置/边界）→ 产线（车间局部位置）→ 设备（产线局部位置）；围墙直接使用车间局部坐标。</span>
                        </div>

                        <div class="form-row workshop-create-row">
                            <input v-model="newWorkshop.id" placeholder="车间ID（如 ws_a）" class="input" />
                            <input v-model="newWorkshop.name" placeholder="车间名称（如 压铸车间）" class="input" />
                            <button @click="createWorkshop" class="btn btn-primary">+ 添加车间</button>
                        </div>

                        <table class="data-table">
                            <thead>
                                <tr><th>ID</th><th>名称</th><th>世界位置</th><th>车间边界</th><th>产线数量</th><th>操作</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="ws in workshops" :key="ws.id" :class="{ 'row-selected': selectedWorkshopEditor?.id === ws.id }">
                                    <td><code>{{ ws.id }}</code></td>
                                    <td>{{ ws.name }}</td>
                                    <td>X {{ getWorkshopLayout(ws).transform.x }} / Z {{ getWorkshopLayout(ws).transform.z }} / {{ getWorkshopLayout(ws).transform.rotationY }}°</td>
                                    <td>{{ getWorkshopLayout(ws).size.width }} × {{ getWorkshopLayout(ws).size.depth }} 米</td>
                                    <td>{{ (linesByWorkshop[ws.id] || []).length }} 条</td>
                                    <td>
                                        <button @click="deleteWorkshop(ws.id)" class="btn btn-danger btn-sm">删除</button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </template>

                    <template v-else-if="workshopManagementStep === 'space' && selectedWorkshopEditor">
                        <div class="workshop-step-context">
                            <button type="button" class="workshop-back-button" title="返回车间列表" @click="selectWorkshopManagementStep('list')">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                            </button>
                            <label>编辑车间
                                <select v-model="selectedWorkshopEditorId" class="input">
                                    <option v-for="workshop in workshops" :key="workshop.id" :value="workshop.id">{{ workshop.name }}</option>
                                </select>
                            </label>
                            <span>{{ getWorkshopLayout(selectedWorkshopEditor).size.width }} × {{ getWorkshopLayout(selectedWorkshopEditor).size.depth }} 米</span>
                        </div>

                        <section v-if="selectedWorkshopEditor" class="workshop-spatial-editor">
                            <div class="workshop-spatial-heading">
                                <div>
                                    <h3>{{ selectedWorkshopEditor.name }} · 空间定义</h3>
                                    <p>世界位置决定整个车间在工厂中的位置；宽度和深度会成为下一步产线布局画布的真实边界。</p>
                                </div>
                                <div class="line-native-actions">
                                    <button type="button" class="btn" @click="restoreSavedNativeScenePreview">撤销未保存预览</button>
                                    <button type="button" class="btn btn-primary" :disabled="workshopSavingId === selectedWorkshopEditor.id" @click="saveWorkshopSpatialLayout()">
                                        {{ workshopSavingId === selectedWorkshopEditor.id ? '保存中...' : '保存车间空间' }}
                                    </button>
                                </div>
                            </div>
                            <div class="workshop-spatial-grid" @input="previewWorkshopSpatialLayout" @change="previewWorkshopSpatialLayout">
                                <label>车间世界 X（米）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).transform.x" type="number" step="0.5" class="input" /></label>
                                <label>车间世界 Y（米）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).transform.y" type="number" step="0.1" class="input" /></label>
                                <label>车间世界 Z（米）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).transform.z" type="number" step="0.5" class="input" /></label>
                                <label>车间朝向（°）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).transform.rotationY" type="number" min="-180" max="180" step="1" class="input" /></label>
                                <label>车间宽度 X（米）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).size.width" type="number" min="10" max="5000" step="1" class="input" /></label>
                                <label>车间深度 Z（米）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).size.depth" type="number" min="10" max="5000" step="1" class="input" /></label>
                                <label>参考高度（米）<input v-model.number="getWorkshopLayout(selectedWorkshopEditor).size.height" type="number" min="1" max="200" step="0.5" class="input" /></label>
                                <label class="workshop-boundary-toggle"><input v-model="getWorkshopLayout(selectedWorkshopEditor).boundary.enabled" type="checkbox" /> 启用车间地面与边界</label>
                            </div>
                            <div class="workshop-step-footer">
                                <span>下一步将在 {{ getWorkshopLayout(selectedWorkshopEditor).size.width }} × {{ getWorkshopLayout(selectedWorkshopEditor).size.depth }} 米范围内按比例展示产线。</span>
                                <button type="button" class="btn btn-primary" @click="selectWorkshopManagementStep('layout')">查看产线布局</button>
                            </div>
                        </section>
                    </template>

                    <template v-else-if="selectedWorkshopEditor">
                        <div class="workshop-step-context">
                            <button type="button" class="workshop-back-button" title="返回空间设置" @click="selectWorkshopManagementStep('space')">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
                            </button>
                            <label>查看车间
                                <select v-model="selectedWorkshopEditorId" class="input">
                                    <option v-for="workshop in workshops" :key="workshop.id" :value="workshop.id">{{ workshop.name }}</option>
                                </select>
                            </label>
                            <span>
                                画布 {{ getWorkshopLayout(selectedWorkshopEditor).size.width }} × {{ getWorkshopLayout(selectedWorkshopEditor).size.depth }} 米
                                · {{ placedWorkshopMapLines.length }} 条已放置
                                <template v-if="pendingWorkshopMapLines.length"> · {{ pendingWorkshopMapLines.length }} 条待放置</template>
                            </span>
                        </div>

                        <section class="workshop-map-shell">
                            <div class="workshop-map-toolbar">
                                <div>
                                    <h3>{{ selectedWorkshopEditor.name }} · 产线平面布局</h3>
                                    <p>每个产线块按真实长度与宽度同比例绘制。拖动即可调整 X / Z，自动以 0.5 米吸附并限制在车间边界内。</p>
                                </div>
                                <div class="line-native-actions">
                                    <button type="button" class="btn" :disabled="workshopMapSaving || !workshopMapDirty" @click="resetWorkshopMapLayout">放弃修改</button>
                                    <button type="button" class="btn btn-primary" :disabled="workshopMapSaving || !workshopMapDirty || !placedWorkshopMapLines.length" @click="saveWorkshopMapLayout">
                                        {{ workshopMapSaving ? '保存中...' : '保存全部产线位置' }}
                                    </button>
                                </div>
                            </div>

                            <div v-if="workshopMapDirty" class="canvas-save-reminder" role="status">
                                <span class="canvas-save-reminder-dot"></span>
                                <div>
                                    <strong>产线布局尚未保存</strong>
                                    <span>刚才的放置或拖动只在当前画布中生效，请保存后再离开。</span>
                                </div>
                                <div class="canvas-save-reminder-actions">
                                    <button type="button" class="btn btn-sm" :disabled="workshopMapSaving" @click="resetWorkshopMapLayout">放弃修改</button>
                                    <button type="button" class="btn btn-primary btn-sm" :disabled="workshopMapSaving" @click="saveWorkshopMapLayout">
                                        {{ workshopMapSaving ? '保存中...' : '立即保存布局' }}
                                    </button>
                                </div>
                            </div>

                            <div class="workshop-map-layout">
                                <div class="workshop-map-board">
                                    <div class="workshop-map-dimension workshop-map-dimension-x">X 方向 · {{ getWorkshopLayout(selectedWorkshopEditor).size.width }} 米</div>
                                    <div class="workshop-map-dimension workshop-map-dimension-z">Z 方向 · {{ getWorkshopLayout(selectedWorkshopEditor).size.depth }} 米</div>
                                    <div
                                        ref="workshopMapStageRef"
                                        class="workshop-map-stage"
                                        :class="{
                                            'pending-drag-active': workshopMapPendingDragLineId,
                                            'pending-drop-active': workshopMapPendingDropReady
                                        }"
                                    >
                                        <span class="workshop-map-axis workshop-map-axis-x"></span>
                                        <span class="workshop-map-axis workshop-map-axis-z"></span>
                                        <span class="workshop-map-origin">0, 0</span>
                                        <article
                                            v-for="line in placedWorkshopMapLines"
                                            :key="line.id"
                                            class="workshop-map-line"
                                            :class="{
                                                selected: selectedWorkshopMapLine?.id === line.id,
                                                dragging: workshopMapDraggingLineId === line.id,
                                                outside: workshopMapLineOutside(line)
                                            }"
                                            :style="workshopMapLineStyle(line)"
                                            tabindex="0"
                                            @click.stop="selectWorkshopMapLine(line)"
                                            @pointerdown="startWorkshopMapLineDrag($event, line)"
                                            @keydown.enter="selectWorkshopMapLine(line)"
                                        >
                                            <header>
                                                <strong>{{ line.name }}</strong>
                                                <span>{{ workshopLineFootprint(line).length }} × {{ workshopLineFootprint(line).width }} m</span>
                                            </header>
                                            <span
                                                v-for="track in workshopLineFootprint(line).tracks"
                                                :key="`${track.type}-${track.id}`"
                                                class="workshop-map-track"
                                                :class="track.type"
                                                :style="workshopMapTrackStyle(track, line)"
                                            ></span>
                                        </article>
                                        <aside v-if="pendingWorkshopMapLines.length" class="workshop-line-placement-dock" @click.stop>
                                            <header>
                                                <div>
                                                    <strong>待放置产线</strong>
                                                    <span>按住卡片拖入画布</span>
                                                </div>
                                                <b>{{ pendingWorkshopMapLines.length }}</b>
                                            </header>
                                            <div class="workshop-line-placement-list">
                                                <div
                                                    v-for="line in pendingWorkshopMapLines"
                                                    :key="line.id"
                                                    class="workshop-line-placement-card"
                                                    :class="{
                                                        attention: workshopMapPlacementHintLineId === line.id,
                                                        dragging: workshopMapPendingDragLineId === line.id
                                                    }"
                                                    :title="`拖动「${line.name}」到画布中的目标位置`"
                                                    @pointerdown="startWorkshopPendingLineDrag($event, line)"
                                                    @lostpointercapture="finishWorkshopPendingLineDrag"
                                                >
                                                    <span class="workshop-line-placement-handle">⠿</span>
                                                    <span class="workshop-line-placement-copy">
                                                        <strong>{{ line.name }}</strong>
                                                        <small>{{ workshopLineFootprint(line).length }} × {{ workshopLineFootprint(line).width }} 米</small>
                                                    </span>
                                                    <em>拖入</em>
                                                </div>
                                            </div>
                                        </aside>
                                        <div v-if="!placedWorkshopMapLines.length" class="workshop-map-empty">
                                            <strong>{{ pendingWorkshopMapLines.length ? '把待放置产线拖进来' : '这个车间还没有产线' }}</strong>
                                            <span>{{ pendingWorkshopMapLines.length ? '从右上角工具浮标拖动卡片，松手后自动限制在车间边界内。' : '先到产线管理新增产线，再返回这里安排空间位置。' }}</span>
                                            <button v-if="!pendingWorkshopMapLines.length" type="button" class="btn btn-primary" @click="selectAdminTab('lines')">前往产线管理</button>
                                        </div>
                                    </div>
                                    <div class="workshop-map-legend">
                                        <span><i class="lane"></i>设备线</span>
                                        <span><i class="rail"></i>小车导轨</span>
                                        <span><i class="center"></i>车间中心轴</span>
                                    </div>
                                </div>

                                <aside class="workshop-map-inspector">
                                    <template v-if="selectedWorkshopMapLine">
                                        <label class="workshop-map-line-select">当前产线
                                            <select v-model="workshopMapSelectedLineId" class="input">
                                                <option v-for="line in placedWorkshopMapLines" :key="line.id" :value="line.id">{{ line.name }}</option>
                                            </select>
                                        </label>
                                        <div class="workshop-map-footprint-card">
                                            <span>实际占地</span>
                                            <strong>{{ workshopLineFootprint(selectedWorkshopMapLine).length }} × {{ workshopLineFootprint(selectedWorkshopMapLine).width }} 米</strong>
                                            <small>{{ getLineLayout(selectedWorkshopMapLine).lanes.length }} 条设备线 · {{ getLineLayout(selectedWorkshopMapLine).rails.length }} 条导轨</small>
                                        </div>
                                        <div class="workshop-map-input-grid" @input="previewWorkshopMapLine()" @change="previewWorkshopMapLine()">
                                            <label>相对车间 X<input v-model.number="getLineLayout(selectedWorkshopMapLine).transform.x" type="number" step="0.5" class="input" /></label>
                                            <label>相对车间 Z<input v-model.number="getLineLayout(selectedWorkshopMapLine).transform.z" type="number" step="0.5" class="input" /></label>
                                            <label>离地 Y<input v-model.number="getLineLayout(selectedWorkshopMapLine).transform.y" type="number" step="0.1" class="input" /></label>
                                            <label>朝向<input v-model.number="getLineLayout(selectedWorkshopMapLine).transform.rotationY" type="number" min="-180" max="180" step="1" class="input" /></label>
                                        </div>
                                        <div v-if="selectedWorkshopMapMetrics" class="workshop-map-metrics">
                                            <h4>距车间边界</h4>
                                            <div class="workshop-map-metric-grid">
                                                <span>左<strong>{{ selectedWorkshopMapMetrics.boundary.left }} m</strong></span>
                                                <span>右<strong>{{ selectedWorkshopMapMetrics.boundary.right }} m</strong></span>
                                                <span>前<strong>{{ selectedWorkshopMapMetrics.boundary.top }} m</strong></span>
                                                <span>后<strong>{{ selectedWorkshopMapMetrics.boundary.bottom }} m</strong></span>
                                            </div>
                                            <p v-if="selectedWorkshopMapMetrics.nearest" :class="{ danger: selectedWorkshopMapMetrics.nearest.overlaps }">
                                                {{ selectedWorkshopMapMetrics.nearest.overlaps ? '与' : '最近' }}「{{ selectedWorkshopMapMetrics.nearest.line.name }}」
                                                {{ selectedWorkshopMapMetrics.nearest.overlaps ? '发生占地重叠' : `间隔约 ${selectedWorkshopMapMetrics.nearest.distance} 米` }}
                                            </p>
                                            <p v-else>当前车间只有这一条产线。</p>
                                        </div>
                                        <button type="button" class="btn workshop-line-detail-button" @click="openSelectedWorkshopLineEditor">编辑这条产线的轨道与设备</button>
                                    </template>
                                    <div v-else class="workshop-map-inspector-empty">选择一条产线后可精确调整。</div>
                                </aside>
                            </div>
                        </section>
                    </template>
                    <div v-else class="workshop-loading-state">正在加载车间空间与产线布局...</div>
                </div>

                <!-- ======== 产线管理 ======== -->
                <div v-if="activeTab === 'lines'" class="tab-content line-planner-tab">
                    <div class="line-planner-shell">
                        <div class="line-planner-header">
                            <div>
                                <h2>产线结构管理</h2>
                                <p class="desc">拖动设备线、导轨和设备时会实时改变 Unity 场景；保存后固化到数据库。</p>
                            </div>
                            <div class="line-native-actions">
                                <button type="button" class="btn" :disabled="!lineLayoutDirty || lineLayoutSaving" @click="resetSelectedLineLayout">放弃画布修改</button>
                                <button class="btn btn-primary" @click="saveSelectedLineLayout" :disabled="lineLayoutSaving || !selectedLineEditor">
                                    {{ lineLayoutSaving ? '保存中...' : '保存产线结构' }}
                                </button>
                            </div>
                        </div>

                        <div class="line-planner-guidance">
                            <div class="line-planner-steps">
                                <span class="active">1 选择产线</span>
                                <span>2 实时调整 Unity 设备线 / 导轨</span>
                                <span>3 保存并固化现场布局</span>
                            </div>

                            <div v-if="lineLayoutDirty" class="canvas-save-reminder line-canvas-save-reminder" role="status">
                                <span class="canvas-save-reminder-dot"></span>
                                <div>
                                    <strong>产线结构尚未保存</strong>
                                    <span>轨道、设备线或设备位置已经改变；实时预览不等于写入数据库。</span>
                                </div>
                                <div class="canvas-save-reminder-actions">
                                    <button type="button" class="btn btn-sm" :disabled="lineLayoutSaving" @click="resetSelectedLineLayout">放弃修改</button>
                                    <button type="button" class="btn btn-primary btn-sm" :disabled="lineLayoutSaving" @click="saveSelectedLineLayout">
                                        {{ lineLayoutSaving ? '保存中...' : '立即保存产线' }}
                                    </button>
                                </div>
                            </div>
                        </div>

                        <div class="line-planner-layout" :class="{ 'editor-collapsed': isLinePlannerEditorCollapsed }">
                            <section class="line-planner-editor">
                                <div class="line-editor-panel">
                                    <div class="line-panel-title">
                                        <strong>新增产线</strong>
                                        <span>结构先建，设备后摆</span>
                                    </div>
                                    <div class="line-create-row">
                                        <input v-model="newLine.id" placeholder="产线ID，如 line_e" class="input" />
                                        <input v-model="newLine.name" placeholder="产线名称，如 E 产线" class="input" />
                                        <select v-model="newLine.workshop_id" class="input">
                                            <option value="" disabled>选择所属车间</option>
                                            <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                                        </select>
                                        <button @click="createLine" class="btn btn-primary">+ 添加产线</button>
                                    </div>
                                </div>

                                <div class="line-editor-panel">
                                    <div class="line-panel-title">
                                        <strong>产线列表</strong>
                                        <span>{{ lines.length }} 条</span>
                                    </div>
                                    <div class="line-selector-list">
                                        <div
                                            v-for="line in lines"
                                            :key="line.id"
                                            class="line-card"
                                            :class="{ active: selectedLineEditorId === line.id }"
                                        >
                                            <button type="button" class="line-card-select" @click="selectLineEditor(line.id)">
                                                <strong>{{ line.name }}</strong>
                                                <span>
                                                    {{ workshops.find(w => w.id === line.workshop_id)?.name || line.workshop_id }} · {{ (lineMemberDevicesByLine[line.id] || []).length }} 台设备
                                                    <em v-if="isLinePlacementPending(line)" class="line-card-status pending">待布局</em>
                                                    <em v-else-if="dirtyLineIds.includes(line.id)" class="line-card-status dirty">未保存</em>
                                                </span>
                                            </button>
                                            <div class="line-card-fields" v-if="selectedLineEditorId === line.id">
                                                <input v-model="line.name" class="input input-sm" placeholder="产线名称" />
                                                <select v-model="line.workshop_id" class="input input-sm">
                                                    <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                                                </select>
                                                <input v-model.number="line.sort_order" type="number" class="input input-sm" title="排序" />
                                                <button class="btn btn-danger btn-sm" type="button" @click="deleteLine(line.id)">删除</button>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <div v-if="selectedLineEditor" class="line-structure-editor">
                                    <div class="line-structure-section">
                                        <div class="line-structure-title">
                                            <strong>设备线</strong>
                                            <button class="btn btn-sm" type="button" @click="addLineLayoutItem('lane')">+ 设备线</button>
                                        </div>
                                        <div class="line-layout-row" v-for="lane in selectedLineLayout.lanes" :key="lane.id">
                                            <input v-model="lane.name" class="input input-sm" />
                                            <label>偏移Z<input v-model.number="lane.offsetZ" type="number" class="input input-sm" /></label>
                                            <label>长度<input v-model.number="lane.length" type="number" min="1" class="input input-sm" /></label>
                                            <button class="btn btn-danger btn-sm" type="button" @click="removeLineLayoutItem('lane', lane.id)">删除</button>
                                        </div>
                                    </div>

                                    <div class="line-structure-section">
                                        <div class="line-structure-title">
                                            <strong>小车导轨</strong>
                                            <button class="btn btn-sm" type="button" @click="addLineLayoutItem('rail')">+ 小车导轨</button>
                                        </div>
                                        <div class="line-layout-row" v-for="rail in selectedLineLayout.rails" :key="rail.id">
                                            <input v-model="rail.name" class="input input-sm" />
                                            <label>偏移Z<input v-model.number="rail.offsetZ" type="number" class="input input-sm" /></label>
                                            <label>长度<input v-model.number="rail.length" type="number" min="1" class="input input-sm" /></label>
                                            <button class="btn btn-danger btn-sm" type="button" @click="removeLineLayoutItem('rail', rail.id)">删除</button>
                                        </div>
                                        <div v-if="!selectedLineLayout.rails.length" class="composer-empty">当前产线还没有小车导轨</div>
                                    </div>
                                </div>
                            </section>

                            <section class="line-planner-preview">
                                <button
                                    class="line-editor-float-toggle"
                                    type="button"
                                    :class="{ collapsed: isLinePlannerEditorCollapsed }"
                                    :title="isLinePlannerEditorCollapsed ? '展开左侧配置' : '收起左侧配置'"
                                    @click="toggleLinePlannerEditor"
                                >
                                    {{ isLinePlannerEditorCollapsed ? '›' : '‹' }}
                                </button>
                                <div class="line-preview-toolbar">
                                    <div>
                                        <strong>{{ selectedLineEditor?.name || '未选择产线' }}</strong>
                                        <span>{{ selectedLineEditorWorkshopName }}</span>
                                    </div>
                                    <div class="line-preview-metrics">
                                        <span>{{ selectedLineLayout.lanes.length }} 条设备线</span>
                                        <span>{{ selectedLineLayout.rails.length }} 条导轨</span>
                                        <span>{{ selectedLineEditorDevices.length }}/{{ selectedLineTotalDeviceCount }} 台设备</span>
                                    </div>
                                </div>
                                <div ref="linePreviewStageRef" class="line-preview-stage" v-if="selectedLineEditor">
                                    <div class="line-preview-legend">
                                        <span><i class="legend-lane"></i>设备线</span>
                                        <span><i class="legend-rail"></i>小车导轨</span>
                                        <span><i class="legend-device"></i>设备</span>
                                        <span><i class="legend-cart"></i>小车</span>
                                    </div>
                                    <div class="line-preview-axis axis-x">X 方向</div>
                                    <div class="line-preview-axis axis-z">Z 偏移</div>
                                    <div
                                        v-if="lineDeviceDrag.active && lineDeviceDrag.alignActive"
                                        class="line-align-guide"
                                        :style="lineAlignmentGuideStyle()"
                                    ></div>
                                    <div
                                        v-for="lane in selectedLineLayout.lanes"
                                        :key="lane.id"
                                        class="line-map-item line-map-lane"
                                        :class="linePreviewItemClass('lane', lane)"
                                        :style="linePreviewItemStyle(lane)"
                                        data-line-target-type="lane"
                                        :data-line-target-id="lane.id"
                                        title="拖动调整设备线偏移，拖左右把手调整长度"
                                        @pointerdown="startLinePreviewDrag('lane', lane.id, 'move', $event)"
                                    >
                                        <span>{{ lane.name }}</span>
                                        <i
                                            v-if="selectedLineLayout.flowDirection !== 'none'"
                                            class="line-map-flow-arrow"
                                            :class="lineFlowDirectionClass()"
                                        ></i>
                                        <i class="line-map-handle handle-left" @pointerdown.stop="startLinePreviewDrag('lane', lane.id, 'resize-left', $event)"></i>
                                        <i class="line-map-handle handle-right" @pointerdown.stop="startLinePreviewDrag('lane', lane.id, 'resize-right', $event)"></i>
                                        <span class="line-map-flow-settings" @pointerdown.stop @click.stop>
                                            <button
                                                type="button"
                                                class="line-map-flow-settings-trigger"
                                                :class="{ active: lineFlowMenuLaneId === lane.id }"
                                                :aria-expanded="lineFlowMenuLaneId === lane.id"
                                                title="设置产线方向"
                                                @click.stop="toggleLineFlowMenu(lane.id)"
                                            >
                                                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>
                                            </button>
                                            <span v-if="lineFlowMenuLaneId === lane.id" class="line-map-flow-menu" role="menu">
                                                <button
                                                    v-for="option in lineFlowDirectionOptions"
                                                    :key="option.value"
                                                    type="button"
                                                    role="menuitem"
                                                    :class="{ active: selectedLineLayout.flowDirection === option.value }"
                                                    @click.stop="setLineFlowDirectionFromCanvas(option.value)"
                                                >
                                                    {{ option.label }}
                                                </button>
                                            </span>
                                        </span>
                                    </div>
                                    <div
                                        v-for="rail in selectedLineLayout.rails"
                                        :key="rail.id"
                                        class="line-map-item line-map-rail"
                                        :class="linePreviewItemClass('rail', rail)"
                                        :style="linePreviewItemStyle(rail)"
                                        data-line-target-type="rail"
                                        :data-line-target-id="rail.id"
                                        title="拖动调整小车导轨偏移，拖左右把手调整长度"
                                        @pointerdown="startLinePreviewDrag('rail', rail.id, 'move', $event)"
                                    >
                                        <span>{{ rail.name }}</span>
                                        <i class="line-map-handle handle-left" @pointerdown.stop="startLinePreviewDrag('rail', rail.id, 'resize-left', $event)"></i>
                                        <i class="line-map-handle handle-right" @pointerdown.stop="startLinePreviewDrag('rail', rail.id, 'resize-right', $event)"></i>
                                    </div>
                                    <div
                                        v-for="device in selectedLineEditorDevices"
                                        :key="device.id"
                                        class="line-map-device"
                                        :class="{ saving: lineDeviceSavingId === device.id }"
                                        :style="linePreviewDeviceStyle(device)"
                                        title="拖到设备线重新归位"
                                        @pointerdown="startLineDeviceDrag(device.id, $event)"
                                    >
                                        <strong>{{ device.name }}</strong>
                                        <small>{{ formatModelName(device.model_type) }}</small>
                                        <button
                                            type="button"
                                            class="line-map-remove"
                                            title="从画布移出，回到设备池"
                                            @pointerdown.stop
                                            @click.stop="removeDeviceFromLineCanvas(device)"
                                        >
                                            移出
                                        </button>
                                    </div>
                                    <div
                                        v-for="cart in selectedLineEditorCarts"
                                        :key="cart.id"
                                        class="line-map-device line-map-cart"
                                        :class="{ saving: lineDeviceSavingId === cart.id }"
                                        :style="linePreviewDeviceStyle(cart)"
                                        title="拖到小车导轨重新归位"
                                        @pointerdown="startLineDeviceDrag(cart.id, $event)"
                                    >
                                        <strong>{{ cart.name }}</strong>
                                        <small>{{ formatModelName(cart.model_type) }}</small>
                                        <button
                                            type="button"
                                            class="line-map-remove"
                                            title="从画布移出，回到设备池"
                                            @pointerdown.stop
                                            @click.stop="removeDeviceFromLineCanvas(cart)"
                                        >
                                            移出
                                        </button>
                                    </div>
                                    <div
                                        v-if="lineDeviceDrag.active"
                                        class="line-map-device line-device-ghost"
                                        :class="{ 'line-map-cart': isAuxiliaryDeviceConfig(getLineDeviceById(lineDeviceDrag.deviceId) || {}) }"
                                        :style="lineDeviceDragGhostStyle()"
                                    >
                                        <strong>{{ getLineDeviceById(lineDeviceDrag.deviceId)?.name || '设备' }}</strong>
                                        <small>{{ lineDeviceDrag.message }}</small>
                                    </div>
                                    <div v-if="!selectedLineEditorDevices.length && !selectedLineEditorCarts.length" class="line-preview-empty-state">
                                        当前产线还没有设备，保存结构后到现场编排器摆放设备
                                    </div>
                                </div>
                                <div v-else class="line-preview-stage line-preview-empty">请先创建或选择一条产线</div>
                                <div
                                    class="line-device-pool-dock"
                                    v-if="selectedLineEditor && selectedLineDevicePool.length"
                                    :class="{ collapsed: isLineDevicePoolCollapsed }"
                                    :style="lineDevicePoolDockStyle()"
                                >
                                    <button
                                        v-if="isLineDevicePoolCollapsed"
                                        type="button"
                                        class="line-device-pool-tab"
                                        @pointerdown="startLineDevicePoolMove"
                                        @click="handleLineDevicePoolTabClick"
                                    >
                                        <span class="line-device-pool-grip" aria-hidden="true"></span>
                                        设备池 {{ selectedLineDevicePool.length }}
                                    </button>
                                    <div v-else class="line-device-pool">
                                        <div class="line-device-pool-title" @pointerdown="startLineDevicePoolMove">
                                            <span class="line-device-pool-grip" aria-hidden="true"></span>
                                            <strong>车间设备池</strong>
                                            <span>拖到设备线或小车导轨</span>
                                        </div>
                                        <button
                                        v-for="device in selectedLineDevicePool"
                                        :key="device.id"
                                        type="button"
                                        draggable="false"
                                        class="line-device-pool-chip"
                                            :class="{ cart: isAuxiliaryDeviceConfig(device), saving: lineDeviceSavingId === device.id }"
                                            @pointerdown="startLineDeviceDrag(device.id, $event)"
                                        >
                                            <strong>{{ device.name }}</strong>
                                            <span>{{ formatModelName(device.model_type) }}</span>
                                        </button>
                                        <button
                                            type="button"
                                            class="line-device-pool-close"
                                            title="收起设备池"
                                            @click="toggleLineDevicePool"
                                        >
                                            收起
                                        </button>
                                    </div>
                                </div>
                            </section>
                        </div>
                    </div>
                    <h2>产线管理</h2>
                    <p class="desc">管理工厂车间的产线划分。每条产线可包含多台设备。</p>

                    <div class="form-row">
                        <input v-model="newLine.id" placeholder="产线ID（如 line_e）" class="input" />
                        <input v-model="newLine.name" placeholder="产线名称（如 E 产线）" class="input" />
                        <select v-model="newLine.workshop_id" class="input" style="min-width: 150px">
                            <option value="" disabled>选择所属车间</option>
                            <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                        </select>
                        <button @click="createLine" class="btn btn-primary">+ 添加产线</button>
                    </div>

                    <table class="data-table">
                        <thead>
                            <tr><th>ID</th><th>名称</th><th>所属车间</th><th>设备数量</th><th>操作</th></tr>
                        </thead>
                        <tbody>
                            <tr v-for="line in lines" :key="line.id">
                                <td><code>{{ line.id }}</code></td>
                                <td>{{ line.name }}</td>
                                <td>{{ workshops.find(w => w.id === line.workshop_id)?.name || line.workshop_id }}</td>
                                <td>{{ (lineMemberDevicesByLine[line.id] || []).length }} 台</td>
                                <td>
                                    <button @click="deleteLine(line.id)" class="btn btn-danger btn-sm">删除</button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- ======== 设备管理 ======== -->
                <div v-if="activeTab === 'devices'" class="tab-content">
                    <h2>设备管理</h2>
                    <p class="desc">管理所有设备，包括设备名称、所属产线、使用模型和数据连接。</p>

                    <section v-if="templatePacks.length" class="template-pack-library">
                        <div class="template-pack-library-heading">
                            <div>
                                <strong>热处理数字孪生标准包</strong>
                                <small>设备模型、只读点位、展示报警和部件绑定的可复用蓝图</small>
                            </div>
                            <span class="template-pack-readonly">只读蓝图</span>
                        </div>
                        <div class="template-pack-grid">
                            <article v-for="pack in templatePacks" :key="pack.id" class="template-pack-card">
                                <div class="template-pack-card-top">
                                    <strong>{{ pack.name }}</strong>
                                    <code>v{{ pack.version }}</code>
                                </div>
                                <p>{{ pack.description }}</p>
                                <div class="template-pack-stats">
                                    <span>{{ pack.pointPack?.length || 0 }} 个点位</span>
                                    <span>{{ pack.alarmRules?.length || 0 }} 条报警</span>
                                    <span>{{ pack.partBindings?.length || 0 }} 个部件</span>
                                </div>
                            </article>
                        </div>
                    </section>

                    <button @click="openCreateDevice" class="btn btn-primary" style="margin-bottom:20px">+ 添加设备</button>

                    <!-- 设备表单弹窗 -->
                    <Transition name="modal-fade">
                        <div v-if="showDeviceForm" class="modal-overlay" @click.self="showDeviceForm = false">
                            <div class="modal-box">
                            <h3>{{ isEditMode ? '编辑设备' : '新增设备' }}</h3>
                            <div class="form-grid">
                                <label>设备 ID<input v-model="editingDevice.id" :disabled="isEditMode" class="input" placeholder="如 Furnace_21" /></label>
                                <label>设备名称<input v-model="editingDevice.name" class="input" placeholder="如 21# 多用炉" /></label>
                                <label v-if="isAuxiliaryDeviceConfig(editingDevice)">所在车间
                                    <select v-model="editingDeviceWorkshopId" class="input">
                                        <option v-for="ws in workshops" :key="ws.id" :value="ws.id">{{ ws.name }}</option>
                                    </select>
                                </label>
                                <label>{{ isAuxiliaryDeviceConfig(editingDevice) ? '参考产线（可选）' : '所属产线' }}
                                    <select v-model="editingDevice.line_id" class="input">
                                        <option v-if="isAuxiliaryDeviceConfig(editingDevice)" value="">不挂产线，作为车间级设备</option>
                                        <option v-for="l in deviceFormLines" :key="l.id" :value="l.id">{{ l.name }}</option>
                                    </select>
                                </label>
                                <label>使用模型
                                    <select v-model="editingDevice.model_type" class="input">
                                        <option v-for="m in availableModelOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
                                    </select>
                                </label>
                                <label>设备模板
                                    <select v-model="editingDevice.template_id" class="input">
                                        <option value="">不使用模板</option>
                                        <option v-for="tpl in platform.deviceTemplates || []" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
                                    </select>
                                </label>
                                <div v-if="!isAuxiliaryDeviceConfig(editingDevice)" class="form-section wide-form-section">
                                    <div class="form-section-header">
                                        <strong>设备逐层检查</strong>
                                        <span>型号通常共用模型库配置；只有少数设备结构不同或不允许拆解时才需要覆盖。</span>
                                    </div>
                                    <label>配置策略
                                        <select v-model="editingDeviceInspectionMode" class="input">
                                            <option value="inherit">使用模型默认配置（推荐）</option>
                                            <option value="disabled">仅此设备禁用逐层检查</option>
                                            <option value="override">仅此设备使用自定义覆盖</option>
                                        </select>
                                    </label>
                                    <template v-if="editingDeviceInspectionMode === 'override'">
                                        <div class="device-inspection-override-toolbar">
                                            <span>覆盖内容会与模型配置合并；数组字段会以本设备内容为准。</span>
                                            <button class="btn btn-sm" type="button" @click="copyModelInspectionToDevice">复制当前模型配置</button>
                                        </div>
                                        <label class="wide-form-section">拆解检查覆盖 JSON
                                            <textarea v-model="editingDeviceInspectionJson" class="input model-metadata" rows="8" spellcheck="false"></textarea>
                                        </label>
                                    </template>
                                </div>
                                <div class="form-section wide-form-section">
                                    <div class="form-section-header">
                                        <strong>PLC 连接配置</strong>
                                        <span>每台设备可以连接不同 PLC；料车等辅助设备可保持未启用。</span>
                                    </div>
                                    <label class="inline-check">
                                        <input v-model="editingDevice.plc_enabled" type="checkbox" :true-value="1" :false-value="0" />
                                        启用此设备直连 PLC 采集
                                    </label>
                                    <div class="form-grid compact-form-grid" v-if="Number(editingDevice.plc_enabled || 0)">
                                        <label>协议
                                            <select :value="editingDevice.plc_protocol" class="input" @change="setEditingPlcProtocol($event.target.value)">
                                                <option v-for="protocol in plcProtocolOptions" :key="protocol.value" :value="protocol.value">{{ protocol.label }}</option>
                                            </select>
                                        </label>
                                        <label>{{ plcEndpointFieldLabel() }}
                                            <input v-model="editingDevice.plc_ip" class="input" :placeholder="plcEndpointPlaceholder()" />
                                        </label>
                                        <label>端口
                                            <input v-model.number="editingDevice.plc_port" type="number" class="input" :placeholder="String(editingPlcProtocolDefinition.defaultPort)" />
                                        </label>
                                        <label v-if="editingPlcUsesRackSlot">Rack
                                            <input v-model.number="editingDevice.plc_rack" type="number" class="input" placeholder="0" />
                                        </label>
                                        <label v-if="editingPlcUsesRackSlot">Slot
                                            <input v-model.number="editingDevice.plc_slot" type="number" class="input" placeholder="1" />
                                        </label>
                                        <template v-if="editingPlcUsesModbusOptions">
                                            <label>Unit ID
                                                <input :value="plcOptionValue('unitId', 1)" @input="setPlcOption('unitId', Number($event.target.value))" type="number" min="1" max="247" class="input" placeholder="1" />
                                            </label>
                                            <label>地址基准
                                                <select :value="plcOptionValue('addressBase', 1)" @change="setPlcOption('addressBase', Number($event.target.value))" class="input">
                                                    <option :value="1">1（常见，HR40001 从 1 开始）</option>
                                                    <option :value="0">0（部分网关从 0 开始）</option>
                                                </select>
                                            </label>
                                            <label>字节序
                                                <select :value="plcOptionValue('byteOrder', 'BE')" @change="setPlcOption('byteOrder', $event.target.value)" class="input">
                                                    <option value="BE">大端（标准）</option>
                                                    <option value="LE">小端</option>
                                                </select>
                                            </label>
                                            <label>字序（32/64 位）
                                                <select :value="plcOptionValue('wordOrder', 'BE')" @change="setPlcOption('wordOrder', $event.target.value)" class="input">
                                                    <option value="BE">高字在前</option>
                                                    <option value="LE">低字在前</option>
                                                </select>
                                            </label>
                                        </template>
                                        <template v-if="editingPlcUsesOpcUaOptions">
                                            <label>Endpoint 路径（可选）
                                                <input :value="plcOptionValue('endpointPath', '')" @input="setPlcOption('endpointPath', $event.target.value)" class="input" placeholder="/UA/Server" />
                                            </label>
                                            <label>安全模式
                                                <select :value="plcOptionValue('securityMode', 'None')" @change="setPlcOption('securityMode', $event.target.value)" class="input">
                                                    <option value="None">None（匿名/明文）</option>
                                                    <option value="Sign">Sign</option>
                                                    <option value="SignAndEncrypt">SignAndEncrypt</option>
                                                </select>
                                            </label>
                                            <label v-if="plcOptionValue('securityMode', 'None') !== 'None'">安全策略
                                                <select :value="plcOptionValue('securityPolicy', 'Basic256Sha256')" @change="setPlcOption('securityPolicy', $event.target.value)" class="input">
                                                    <option value="Basic256Sha256">Basic256Sha256</option>
                                                    <option value="Aes128_Sha256_RsaOaep">Aes128-Sha256-RsaOaep</option>
                                                    <option value="Aes256_Sha256_RsaPss">Aes256-Sha256-RsaPss</option>
                                                </select>
                                            </label>
                                            <label>用户名（可选）
                                                <input :value="plcOptionValue('username', '')" @input="setPlcOption('username', $event.target.value)" class="input" placeholder="匿名留空" />
                                            </label>
                                            <label>密码（可选）
                                                <input :value="plcOptionValue('password', '')" @input="setPlcOption('password', $event.target.value)" type="password" class="input" placeholder="匿名留空" />
                                            </label>
                                            <label class="inline-check" style="align-self:end">
                                                <input :checked="plcOptionValue('trustServerCertificate', false)" @change="setPlcOption('trustServerCertificate', $event.target.checked)" type="checkbox" />
                                                调试时自动信任服务器证书
                                            </label>
                                        </template>
                                        <label>连接超时(ms)
                                            <input v-model.number="editingDevice.plc_timeout" type="number" class="input" placeholder="5000" />
                                        </label>
                                        <label>重连间隔(ms)
                                            <input v-model.number="editingDevice.plc_retry_interval" type="number" class="input" placeholder="10000" />
                                        </label>
                                        <label>最大重试次数
                                            <input v-model.number="editingDevice.plc_max_retries" type="number" class="input" placeholder="0 表示一直重试" />
                                        </label>
                                        <p class="plc-protocol-hint" style="grid-column:1 / -1">
                                            {{ editingPlcProtocolDefinition.addressHint }} 点位地址请在“PLC 点位映射”中按所选协议填写；当前采集器为只读模式，不会向 PLC 写入。
                                        </p>
                                    </div>
                                </div>
                            </div>
                            <div class="modal-actions">
                                <button @click="saveDevice" class="btn btn-primary">保存</button>
                                <button @click="showDeviceForm = false" class="btn">取消</button>
                            </div>
                            </div>
                        </div>
                    </Transition>

                    <!-- 设备列表 -->
                    <div v-for="line in lines" :key="line.id" class="device-group">
                        <h3 class="group-title">{{ line.name }}</h3>
                        <table class="data-table">
                            <thead>
                                <tr><th>ID</th><th>名称</th><th>模型</th><th>PLC</th><th>操作</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="d in (devicesByLine[line.id] || [])" :key="d.id">
                                    <td><code>{{ d.id }}</code></td>
                                    <td>{{ d.name }}</td>
                                    <td class="model-name-cell">
                                        <strong>{{ formatModelName(d.model_type) }}</strong>
                                        <small>{{ d.model_type }}</small>
                                    </td>
                                    <td>
                                        <span class="plc-status-pill" :class="'plc-' + (plcStatusByDevice[d.id]?.status || (Number(d.plc_enabled || 0) ? 'idle' : 'disabled'))">
                                            {{ formatPlcDeviceStatus(d) }}
                                        </span>
                                        <small>{{ formatPlcEndpoint(d) }}</small>
                                        <div class="plc-meta-lines" v-if="Number(d.plc_enabled || 0)">
                                            <span>上次连接：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastConnectedAt) }}</span>
                                            <span>最近读取：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastReadAt) }}</span>
                                        </div>
                                    </td>
                                    <td>
                                        <button @click="openEditDevice(d)" class="btn btn-sm">编辑</button>
                                        <button @click="deleteDevice(d.id)" class="btn btn-danger btn-sm">删除</button>
                                    </td>
                                </tr>
                                <tr v-if="! (devicesByLine[line.id] || []).length">
                                    <td colspan="5" style="text-align:center;color:#888">暂无设备</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="device-group" v-if="auxiliaryDevices.length">
                        <h3 class="group-title">辅助设备 / 料车</h3>
                        <table class="data-table">
                            <thead>
                                <tr><th>ID</th><th>名称</th><th>车间</th><th>模型</th><th>PLC</th><th>操作</th></tr>
                            </thead>
                            <tbody>
                                <tr v-for="d in auxiliaryDevices" :key="d.id">
                                    <td><code>{{ d.id }}</code></td>
                                    <td>{{ d.name }}</td>
                                    <td>{{ workshops.find(w => w.id === getDeviceWorkshopId(d))?.name || getDeviceWorkshopId(d) || '未设置' }}</td>
                                    <td class="model-name-cell">
                                        <strong>{{ formatModelName(d.model_type) }}</strong>
                                        <small>{{ d.model_type }}</small>
                                    </td>
                                    <td>
                                        <span class="plc-status-pill" :class="'plc-' + (plcStatusByDevice[d.id]?.status || (Number(d.plc_enabled || 0) ? 'idle' : 'disabled'))">
                                            {{ formatPlcDeviceStatus(d) }}
                                        </span>
                                        <small>{{ formatPlcEndpoint(d) }}</small>
                                        <div class="plc-meta-lines" v-if="Number(d.plc_enabled || 0)">
                                            <span>上次连接：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastConnectedAt) }}</span>
                                            <span>最近读取：{{ formatPlcTime(plcStatusByDevice[d.id]?.lastReadAt) }}</span>
                                        </div>
                                    </td>
                                    <td>
                                        <button @click="openEditDevice(d)" class="btn btn-sm">编辑</button>
                                        <button @click="deleteDevice(d.id)" class="btn btn-danger btn-sm">删除</button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ======== 模型库 ======== -->
                <div v-if="activeTab === 'models'" class="tab-content">
                    <h2>3D 模型库</h2>
                    <p class="desc">按资产选择、导入、优化验收和部位绑定的顺序管理模型；切换步骤时当前模型和未保存表单会继续保留。</p>

                    <div class="secondary-page-nav-shell model-step-nav-shell">
                        <nav class="secondary-page-nav" aria-label="模型库操作步骤">
                            <button
                                v-for="(step, index) in MODEL_LIBRARY_STEPS"
                                :key="step.key"
                                type="button"
                                class="secondary-page-nav-item"
                                :class="{ active: modelLibraryStep === step.key }"
                                :disabled="modelLibraryStepRequiresModel(step.key) && !activePreviewModel"
                                :aria-current="modelLibraryStep === step.key ? 'step' : undefined"
                                @click="selectModelLibraryStep(step.key)"
                            >
                                <span class="secondary-page-number">{{ String(index + 1).padStart(2, '0') }}</span>
                                <span class="secondary-page-copy">
                                    <strong>{{ step.label }}</strong>
                                    <small>{{ step.description }}</small>
                                </span>
                                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.75 5.25 5.25-5.25 5.25" /></svg>
                            </button>
                        </nav>
                    </div>

                    <div class="model-library-layout">
                        <section class="model-library-main">
                            <section v-show="modelLibraryStep === 'import'" class="model-library-step-panel">
                                <div class="model-step-heading">
                                    <div><h3>导入新模型</h3><p>支持 GLB / GLTF。选择文件后可先在右侧检查模型，再决定是否上传入库。</p></div>
                                    <span>可选步骤</span>
                                </div>
                            <div class="upload-area">
                                <label class="btn btn-primary" style="cursor:pointer">
                                    📂 选择 .glb/.gltf 文件
                                    <input ref="modelFileInputRef" type="file" accept=".glb,.gltf" @change="selectModelFile" hidden />
                                </label>
                                <span v-if="selectedModelFile" class="model-file-chip">{{ selectedModelFile.name }} · {{ selectedModelFileSizeText }}</span>
                            </div>

                            <div v-if="selectedModelFile" class="model-import-form">
                                <label>模型 ID<input v-model="modelImportForm.id" class="input" /></label>
                                <label>模型名称<input v-model="modelImportForm.name" class="input" /></label>
                                <label>默认缩放<input v-model.number="modelImportForm.default_scale" type="number" min="0.01" step="0.05" class="input" /></label>
                                <label class="model-metadata-field">元数据 JSON<textarea v-model="modelImportForm.metadata" class="input model-metadata"></textarea></label>
                                <div class="model-import-actions">
                                    <button class="btn btn-primary" type="button" @click="uploadModel" :disabled="modelUploading">
                                        {{ modelUploading ? '上传中...' : '上传并入库' }}
                                    </button>
                                    <button class="btn" type="button" @click="clearSelectedModelFile" :disabled="modelUploading">取消</button>
                                </div>
                            </div>
                            </section>

                            <section v-show="modelLibraryStep === 'library'" class="model-library-step-panel">
                                <div class="model-step-heading">
                                    <div><h3>已有模型资产</h3><p>先选择需要查看或配置的模型，再进入优化验收或部位绑定。</p></div>
                                    <span>{{ models.length }} 个模型</span>
                                </div>
                            <table class="data-table model-table">
                                <thead>
                                    <tr><th>ID</th><th>名称</th><th>交付状态</th><th>绑定数</th><th>文件路径</th><th>操作</th></tr>
                                </thead>
                                <tbody>
                                    <tr
                                        v-for="m in models"
                                        :key="m.id"
                                        :class="{ active: selectedPreviewModelId === m.id }"
                                        @click="previewExistingModel(m)"
                                    >
                                        <td><code>{{ m.id }}</code></td>
                                        <td>{{ m.name }}</td>
                                        <td><span class="asset-status-pill" :class="'asset-status-' + getModelAssetStatus(m)">{{ formatAssetStatus(getModelAssetStatus(m)) }}</span></td>
                                        <td>{{ getModelBindingCount(m) }}</td>
                                        <td>{{ m.file_path || '（内置）' }}</td>
                                        <td>
                                            <button v-if="!m.is_builtin" @click.stop="deleteModel(m.id)" class="btn btn-danger btn-sm">删除</button>
                                            <span v-else style="color:#888">系统内置</span>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                                <div v-if="activePreviewModel" class="model-selection-actions">
                                    <div><span>当前模型</span><strong>{{ activePreviewModel.name || activePreviewModel.id }}</strong></div>
                                    <button class="btn" type="button" @click="selectModelLibraryStep('optimization')">优化与验收</button>
                                    <button class="btn" type="button" @click="selectModelLibraryStep('inspection')">拆解检查</button>
                                    <button class="btn btn-primary" type="button" @click="selectModelLibraryStep('bindings')">部位绑定</button>
                                </div>
                            </section>

                            <section v-if="activePreviewModel" v-show="modelLibraryStep === 'optimization'" class="model-asset-governance model-library-step-panel">
                                <div class="model-binding-header">
                                    <div>
                                        <h3>模型资产规范</h3>
                                        <p>当前状态：<span class="asset-status-pill" :class="'asset-status-' + modelAssetSpec.delivery_status">{{ formatAssetStatus(modelAssetSpec.delivery_status) }}</span></p>
                                    </div>
                                    <div class="model-governance-actions">
                                        <button class="btn" type="button" @click="saveModelAssetSpec" :disabled="!canEditModelBindings || modelBindingSaving">保存规范</button>
                                        <button class="btn" type="button" @click="submitModelAssetReview" :disabled="!canEditModelBindings || modelBindingSaving">提交验收</button>
                                        <button class="btn btn-primary" type="button" @click="markModelAssetAccepted" :disabled="!canAcceptModelAsset || modelBindingSaving">标记验收通过</button>
                                        <button class="btn btn-primary" type="button" @click="publishModelAsset" :disabled="!canPublishModelAsset || modelBindingSaving">发布模型</button>
                                    </div>
                                </div>

                                <div class="model-workflow-rail">
                                    <div
                                        v-for="(step, index) in modelAssetWorkflow"
                                        :key="step.id"
                                        class="model-workflow-step"
                                        :class="{ passed: step.passed, optional: step.optional && !step.passed }"
                                    >
                                        <strong>{{ index + 1 }}</strong>
                                        <span>{{ step.label }}</span>
                                        <small>{{ step.detail }}</small>
                                    </div>
                                </div>

                                <div class="model-stats-strip">
                                    <span>节点 {{ modelPreviewStats.nodeCount }}</span>
                                    <span>网格 {{ modelPreviewStats.meshCount }}</span>
                                    <span>三角面 {{ formatModelNumber(modelPreviewStats.triangleCount) }}</span>
                                    <span>材质 {{ modelPreviewStats.materialCount }}</span>
                                    <span>贴图 {{ modelPreviewStats.textureCount }}</span>
                                    <span>尺寸 {{ formatModelBounds(modelPreviewStats.bounds) }}</span>
                                </div>

                                <template v-if="canEditModelBindings">
                                    <div class="model-optimization-panel">
                                        <div class="model-release-header">
                                            <strong>通用模型优化</strong>
                                            <span>保留三角面和点位动画，主要降低 draw call 并改善 PBR 观感</span>
                                        </div>
                                        <div class="model-spec-form model-optimization-form">
                                            <label>优化策略
                                                <select v-model="modelOptimization.mode" class="input">
                                                    <option value="auto">自动优化（推荐）</option>
                                                    <option value="off">关闭，使用模型原始结构</option>
                                                </select>
                                            </label>
                                            <label>无贴图材质
                                                <select v-model="modelOptimization.materialEnhancement" class="input" :disabled="modelOptimization.mode === 'off'">
                                                    <option value="auto">自动识别金属 / 油漆 / 橡胶</option>
                                                    <option value="original">保持原始材质参数</option>
                                                </select>
                                            </label>
                                            <label>环境反射强度
                                                <input v-model.number="modelOptimization.environmentIntensity" type="number" min="0" max="2" step="0.05" class="input" :disabled="modelOptimization.mode === 'off'" />
                                            </label>
                                            <label class="checkbox-line"><input v-model="modelOptimization.mergeStatic" type="checkbox" :disabled="modelOptimization.mode === 'off'" /> 静态网格按材质合并</label>
                                            <label class="checkbox-line"><input v-model="modelOptimization.instanceRepeated" type="checkbox" :disabled="modelOptimization.mode === 'off'" /> 同型多台实例化</label>
                                            <label class="checkbox-line"><input v-model="modelOptimization.contactShadow" type="checkbox" :disabled="modelOptimization.mode === 'off'" /> 低成本接触阴影</label>
                                        </div>
                                        <p class="model-optimization-estimate">{{ modelOptimizationEstimate }}。骨骼、Morph 或单网格多材质等不适合的模型会自动回退，不会强行破坏。</p>
                                    </div>

                                    <div class="model-spec-form">
                                        <label>资产版本<input v-model="modelAssetSpec.version" class="input" /></label>
                                        <label>设备类型<input v-model="modelAssetSpec.device_family" class="input" placeholder="如 箱式气氛多用炉" /></label>
                                        <label>尺寸单位
                                            <select v-model="modelAssetSpec.unit" class="input">
                                                <option value="m">m</option>
                                                <option value="mm">mm</option>
                                            </select>
                                        </label>
                                        <label>坐标规范<input v-model="modelAssetSpec.axis_rule" class="input" /></label>
                                        <label>最大三角面<input v-model.number="modelAssetSpec.max_triangles" type="number" min="1000" step="1000" class="input" /></label>
                                        <label>最大节点数<input v-model.number="modelAssetSpec.max_nodes" type="number" min="1" step="10" class="input" /></label>
                                        <label>最大贴图尺寸<input v-model.number="modelAssetSpec.max_texture_size" type="number" min="256" step="256" class="input" /></label>
                                        <label>交付状态
                                            <select v-model="modelAssetSpec.delivery_status" class="input">
                                                <option value="draft">草稿</option>
                                                <option value="review">待验收</option>
                                                <option value="accepted">验收通过</option>
                                                <option value="released">已发布</option>
                                            </select>
                                        </label>
                                        <label class="wide-form-section">节点命名规则<input v-model="modelAssetSpec.node_naming_rule" class="input" /></label>
                                        <label class="wide-form-section">LOD 策略<input v-model="modelAssetSpec.lod_policy" class="input" /></label>
                                        <label class="wide-form-section">交付备注<textarea v-model="modelAssetSpec.notes" class="input model-metadata"></textarea></label>
                                    </div>

                                    <div class="model-acceptance-summary" :class="{ ready: modelAcceptanceSummary.ready }">
                                        必检 {{ modelAcceptanceSummary.passed }}/{{ modelAcceptanceSummary.required }}
                                        <span v-if="modelAcceptanceSummary.warnings">，提示 {{ modelAcceptanceSummary.warnings }} 项</span>
                                    </div>
                                    <div class="model-acceptance-grid">
                                        <div
                                            v-for="check in modelAcceptanceChecks"
                                            :key="check.id"
                                            class="model-acceptance-item"
                                            :class="{ passed: check.passed, warning: !check.required && !check.passed }"
                                        >
                                            <strong>{{ check.passed ? '通过' : (check.required ? '未过' : '提示') }}</strong>
                                            <span>{{ check.label }}</span>
                                            <small>{{ check.detail }}</small>
                                        </div>
                                    </div>

                                    <div class="model-release-history">
                                        <div class="model-release-header">
                                            <strong>发布记录</strong>
                                            <span>{{ modelReleaseHistory.length ? `共 ${modelReleaseHistory.length} 次` : '暂无发布快照' }}</span>
                                        </div>
                                        <table class="data-table" v-if="modelReleaseHistory.length">
                                            <thead>
                                                <tr><th>版本</th><th>状态</th><th>时间</th><th>三角面</th><th>绑定</th><th>操作</th></tr>
                                            </thead>
                                            <tbody>
                                                <tr v-for="release in modelReleaseHistory" :key="release.id">
                                                    <td>{{ release.version }}</td>
                                                    <td>{{ release.status === 'rollback' ? '回滚' : '发布' }}</td>
                                                    <td>{{ release.published_at || '-' }}</td>
                                                    <td>{{ formatModelNumber(release.stats?.triangleCount) }}</td>
                                                    <td>{{ release.snapshot?.partBindings?.length || 0 }}</td>
                                                    <td>
                                                        <button class="btn btn-sm" type="button" @click="restoreModelRelease(release)" :disabled="modelBindingSaving || !release.snapshot">恢复此版</button>
                                                    </td>
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </template>
                            </section>

                            <section v-if="activePreviewModel" v-show="modelLibraryStep === 'inspection'" class="model-binding-editor model-library-step-panel model-inspection-editor">
                                <div class="model-binding-header">
                                    <div>
                                        <h3>设备逐层检查配置</h3>
                                        <p>这里定义实体、透明外壳、拆解部件和部件详情所需的数据；同型号设备默认复用，设备实例仍可覆盖。</p>
                                    </div>
                                    <button class="btn btn-primary" type="button" @click="saveModelInspection" :disabled="!canEditModelBindings || modelBindingSaving">
                                        {{ modelBindingSaving ? '保存中...' : '保存拆解配置' }}
                                    </button>
                                </div>

                                <template v-if="canEditModelBindings">
                                    <div class="inspection-stage-toolbar">
                                        <label class="inline-check"><input v-model="modelInspection.enabled" type="checkbox" /> 启用逐层设备检查</label>
                                        <button type="button" :class="{ active: inspectionPreviewStage === 'solid' }" @click="applyInspectionPreviewStage('solid')">1 实体</button>
                                        <button type="button" :class="{ active: inspectionPreviewStage === 'xray' }" @click="applyInspectionPreviewStage('xray')">2 透视</button>
                                        <button type="button" :class="{ active: inspectionPreviewStage === 'exploded' }" @click="applyInspectionPreviewStage('exploded')">3 拆解</button>
                                    </div>

                                    <div class="model-inspection-settings">
                                        <label>透明外壳浓度<input v-model.number="modelInspection.shell.opacity" type="range" min=".03" max=".8" step=".01" @input="applyInspectionPreviewStage('xray')" /><small>{{ Math.round(modelInspection.shell.opacity * 100) }}%</small></label>
                                        <label>拆解动画（秒）<input v-model.number="modelInspection.animation_duration" type="number" min=".05" max="5" step=".05" class="input" /></label>
                                        <label class="inline-check"><input v-model="modelInspection.shell.wireframe" type="checkbox" /> 透视阶段强调线框色</label>
                                    </div>

                                    <div class="inspection-config-card">
                                        <div class="model-release-header"><strong>外壳节点</strong><span>只有这些节点会透明或隐藏，内部部件保持不透明</span></div>
                                        <div class="inspection-node-picker">
                                            <select v-model="inspectionShellNodePath" class="input">
                                                <option value="">选择模型节点作为外壳</option>
                                                <option v-for="node in filteredModelPreviewNodes" :key="'shell-' + node.path" :value="node.path">{{ formatModelNodeOption(node) }}</option>
                                            </select>
                                            <button class="btn" type="button" @click="addInspectionShellNode">加入外壳</button>
                                        </div>
                                        <div class="inspection-node-chips">
                                            <button v-for="entry in inspectionShellEntries" :key="entry.key" type="button" @click="selectInspectionShellNode(entry)">
                                                <span>{{ entry.name || entry.path }}</span><i @click.stop="removeInspectionShellNode(entry)">×</i>
                                            </button>
                                            <small v-if="!inspectionShellEntries.length">未指定时运行端会按 shell / housing / 外壳等名称尝试识别。</small>
                                        </div>
                                    </div>

                                    <div class="inspection-camera-grid">
                                        <div v-for="stage in [{key:'solid',label:'实体镜头'},{key:'xray',label:'透视镜头'},{key:'exploded',label:'拆解镜头'}]" :key="stage.key" class="inspection-config-card">
                                            <div class="model-release-header"><strong>{{ stage.label }}</strong><span>{{ modelInspection[stage.key].view_id || '使用模型默认镜头' }}</span></div>
                                            <label>低代码视角 ID<input v-model="modelInspection[stage.key].view_id" class="input" :placeholder="stage.key === 'solid' ? 'device_detail' : 'device_' + stage.key" /></label>
                                            <div class="property-grid three">
                                                <label>水平角<input v-model.number="modelInspection[stage.key].camera.yaw" type="number" class="input" /></label>
                                                <label>俯仰角<input v-model.number="modelInspection[stage.key].camera.pitch" type="number" class="input" /></label>
                                                <label>距离比例<input v-model.number="modelInspection[stage.key].camera.distance_scale" type="number" min=".1" max="10" step=".01" class="input" /></label>
                                            </div>
                                        </div>
                                    </div>

                                    <div class="inspection-config-card">
                                        <div class="model-release-header"><strong>关键部件</strong><span>拆解后可以点击，并把部件上下文交给右侧低代码组件</span></div>
                                        <div class="model-binding-form inspection-part-form">
                                            <label class="model-node-picker">模型节点
                                                <select v-model="inspectionPartForm.node_path" class="input" @change="selectPreviewNode(inspectionPartForm.node_path)">
                                                    <option value="">选择关键部件节点</option>
                                                    <option v-for="node in filteredModelPreviewNodes" :key="'part-' + node.path" :value="node.path">{{ formatModelNodeOption(node) }}</option>
                                                </select>
                                            </label>
                                            <label>部件 ID<input v-model="inspectionPartForm.id" class="input" placeholder="如 front_door" /></label>
                                            <label>显示名称<input v-model="inspectionPartForm.name" class="input" placeholder="如 前门驱动组件" /></label>
                                            <label>详情视角 ID<input v-model="inspectionPartForm.detail_view_id" class="input" placeholder="留空使用 device_part" /></label>
                                            <label>拆解偏移 X<input v-model.number="inspectionPartForm.explode_x" type="number" step=".1" class="input" /></label>
                                            <label>拆解偏移 Y<input v-model.number="inspectionPartForm.explode_y" type="number" step=".1" class="input" /></label>
                                            <label>拆解偏移 Z<input v-model.number="inspectionPartForm.explode_z" type="number" step=".1" class="input" /></label>
                                            <label class="wide-form-section">部件介绍<textarea v-model="inspectionPartForm.description" class="input" rows="2" placeholder="点击部件后显示在右侧详情中"></textarea></label>
                                            <label class="wide-form-section">实时点位键<textarea v-model="inspectionPartForm.point_keys_text" class="input" rows="2" placeholder="motors.rear_fan_speed, analog.temperature"></textarea><small class="field-hint">使用“分组.字段”，多个用逗号或换行分隔；运行时会自动匹配当前设备点位。</small></label>
                                            <div class="model-binding-actions">
                                                <button class="btn btn-primary" type="button" @click="saveInspectionPartDraft">{{ selectedInspectionPartIndex >= 0 ? '更新部件' : '加入部件' }}</button>
                                                <button class="btn" type="button" @click="resetInspectionPartForm">清空表单</button>
                                            </div>
                                        </div>

                                        <table class="data-table model-binding-table">
                                            <thead><tr><th>部件</th><th>节点</th><th>拆解偏移</th><th>点位键</th><th>操作</th></tr></thead>
                                            <tbody>
                                                <tr v-for="(part, index) in modelInspectionParts" :key="part.id" @click="selectPreviewNode(part.node_path)">
                                                    <td><strong>{{ part.name }}</strong><small>{{ part.id }}</small></td>
                                                    <td><code>{{ part.node_name || part.node_path }}</code></td>
                                                    <td>{{ part.explode_offset.join(' / ') }}</td>
                                                    <td>{{ (part.point_keys || []).join(', ') || '未绑定' }}</td>
                                                    <td><button class="btn btn-sm" type="button" @click.stop="editInspectionPart(index)">编辑</button><button class="btn btn-danger btn-sm" type="button" @click.stop="removeInspectionPart(index)">删除</button></td>
                                                </tr>
                                                <tr v-if="!modelInspectionParts.length"><td colspan="5" style="text-align:center;color:#888">暂无关键部件；可先从右侧预览解析出的节点中选择。</td></tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </template>
                                <div class="model-binding-status">{{ modelBindingStatus }}</div>
                            </section>

                            <section v-if="activePreviewModel" v-show="modelLibraryStep === 'bindings'" class="model-binding-editor model-library-step-panel">
                                <div class="model-binding-header">
                                    <div>
                                        <h3>部位与点位绑定</h3>
                                        <p>{{ canEditModelBindings ? '选择模型节点，把 PLC 实时点位映射成旋转、平移、显隐或变色动作。' : '内置程序化模型不可编辑部位绑定，请使用上传的完整 GLB/GLTF 模型。' }}</p>
                                    </div>
                                    <button class="btn btn-primary" type="button" @click="saveModelPartBindings" :disabled="!canEditModelBindings || modelBindingSaving">
                                        {{ modelBindingSaving ? '保存中...' : '保存绑定' }}
                                    </button>
                                </div>

                                <template v-if="canEditModelBindings">
                                    <div class="model-binding-form">
                                        <label class="model-node-picker">模型部位
                                            <div class="model-node-tools">
                                                <input v-model="modelNodeSearchText" class="input" placeholder="搜索节点名称 / 路径" />
                                                <span class="inline-toggle node-filter-toggle">
                                                    <input v-model="showOnlyBindableNodes" type="checkbox" />
                                                    只看可绑定网格
                                                </span>
                                            </div>
                                            <select v-model="selectedModelNodePath" class="input" @change="selectPreviewNode(selectedModelNodePath)">
                                                <option value="">选择右侧预览解析出的节点</option>
                                                <option v-for="node in filteredModelPreviewNodes" :key="node.path" :value="node.path">
                                                    {{ formatModelNodeOption(node) }}
                                                </option>
                                            </select>
                                            <small class="field-hint">当前显示 {{ filteredModelPreviewNodes.length }} / {{ modelPreviewNodes.length }} 个节点。若列表全是 bolt、chain 这类名字，说明模型导出时节点命名还没按资产规范整理。</small>
                                        </label>
                                        <label>绑定名称<input v-model="modelBindingForm.name" class="input" placeholder="如 后室循环风扇" /></label>
                                        <label>数据分组
                                            <select v-model="modelBindingForm.source_group" class="input">
                                                <option v-for="group in modelSourceGroups" :key="group.value" :value="group.value">{{ group.label }}</option>
                                            </select>
                                        </label>
                                        <label>点位字段<input v-model="modelBindingForm.source_key" class="input" placeholder="如 rear_fan_rpm" /></label>
                                        <label>动作
                                            <select v-model="modelBindingForm.action" class="input">
                                                <option v-for="action in modelBindingActions" :key="action.value" :value="action.value">{{ action.label }}</option>
                                            </select>
                                        </label>
                                        <label>轴向
                                            <select v-model="modelBindingForm.axis" class="input">
                                                <option v-for="axis in modelBindingAxes" :key="axis.value" :value="axis.value">{{ axis.label }}</option>
                                            </select>
                                        </label>
                                        <label>输入最小<input v-model.number="modelBindingForm.input_min" type="number" class="input" /></label>
                                        <label>输入最大<input v-model.number="modelBindingForm.input_max" type="number" class="input" /></label>
                                        <label>输出最小<input v-model.number="modelBindingForm.output_min" type="number" class="input" /></label>
                                        <label>输出最大<input v-model.number="modelBindingForm.output_max" type="number" class="input" /></label>
                                        <label>转速系数<input v-model.number="modelBindingForm.speed_factor" type="number" step="0.001" class="input" /></label>
                                        <label>反向
                                            <select v-model="modelBindingForm.invert" class="input">
                                                <option :value="false">否</option>
                                                <option :value="true">是</option>
                                            </select>
                                        </label>
                                        <label>开启颜色<input v-model="modelBindingForm.on_color" type="color" class="input color-input" /></label>
                                        <label>关闭颜色<input v-model="modelBindingForm.off_color" type="color" class="input color-input" /></label>
                                        <div class="model-binding-actions">
                                            <button class="btn btn-primary" type="button" @click="saveModelBindingDraft">
                                                {{ selectedModelBindingIndex >= 0 ? '更新此绑定' : '加入绑定列表' }}
                                            </button>
                                            <button class="btn" type="button" @click="resetModelBindingForm">清空表单</button>
                                        </div>
                                    </div>

                                    <table class="data-table model-binding-table">
                                        <thead>
                                            <tr><th>部位</th><th>点位</th><th>动作</th><th>轴</th><th>操作</th></tr>
                                        </thead>
                                        <tbody>
                                            <tr
                                                v-for="(binding, index) in modelPartBindings"
                                                :key="binding.id"
                                                class="model-binding-row"
                                                :class="{ active: previewModelBindingIndex === index }"
                                                @click="previewModelBinding(index)"
                                            >
                                                <td>{{ formatModelBindingPartName(binding) }}</td>
                                                <td><code>{{ formatModelSourceGroup(binding.source_group) }}.{{ binding.source_key }}</code></td>
                                                <td>{{ formatModelBindingAction(binding.action) }}</td>
                                                <td>{{ formatModelAxis(binding.axis) }}</td>
                                                <td>
                                                    <button class="btn btn-sm" type="button" @click.stop="editModelBinding(index)">编辑</button>
                                                    <button class="btn btn-danger btn-sm" type="button" @click.stop="removeModelBinding(index)">删除</button>
                                                </td>
                                            </tr>
                                            <tr v-if="!modelPartBindings.length">
                                                <td colspan="5" style="text-align:center;color:#888">暂无部位绑定</td>
                                            </tr>
                                        </tbody>
                                    </table>
                                    <div class="model-binding-bottom-actions">
                                        <span>修改绑定后请保存；删除操作会自动保存。</span>
                                        <button class="btn btn-primary" type="button" @click="saveModelPartBindings" :disabled="modelBindingSaving">
                                            {{ modelBindingSaving ? '保存中...' : '保存绑定' }}
                                        </button>
                                    </div>
                                </template>
                                <div class="model-binding-status">{{ modelBindingStatus }}</div>
                            </section>
                        </section>

                        <aside class="model-preview-panel">
                            <div class="model-preview-header">
                                <div class="model-preview-title">
                                    <strong>模型预览</strong>
                                    <span>{{ selectedModelFile ? '待上传模型' : selectedPreviewModelId || '未选择' }}</span>
                                </div>
                                <span class="model-preview-mode-badge">{{ modelLibraryStep === 'inspection' ? '拆解预览' : modelLibraryStep === 'bindings' ? '绑定预览' : '模型预览' }}</span>
                            </div>
                            <div ref="modelPreviewRef" class="model-preview-stage">
                                <div v-if="!isModelPreviewActive" class="model-preview-empty">选择文件或点击模型列表</div>
                                <div v-if="selectedModelNodeInfo" class="model-preview-node-card">
                                    <strong>{{ selectedModelNodeInfo.displayName || selectedModelNodeInfo.name }}</strong>
                                    <span>{{ formatModelNodeType(selectedModelNodeInfo.type) }} · {{ formatMeshCount(selectedModelNodeInfo.meshCount) }}</span>
                                    <small>{{ selectedModelNodeInfo.path }}</small>
                                </div>
                                <button v-if="isModelPreviewActive" class="model-preview-reset" type="button" @click="resetModelPreviewCamera">看全模型</button>
                            </div>
                            <div class="model-preview-footer">
                                <div>{{ modelPreviewStatus }}</div>
                                <div v-if="selectedModelNodeInfo" class="model-preview-selected-text">
                                    已选：{{ selectedModelNodeInfo.displayName || selectedModelNodeInfo.name }}
                                    <template v-if="selectedModelNodeInfo.sizeText"> · 尺寸 {{ selectedModelNodeInfo.sizeText }}</template>
                                </div>
                            </div>
                        </aside>
                    </div>
                </div>

                <!-- ======== 画面组件配置 ======== -->
                <div v-if="activeTab === 'platform'" class="tab-content">
                    <h2>画面组件配置</h2>
                    <p class="desc">管理当前项目、场景、组件布局和发布版本。工程师后续通过这里调整画面，不再改源码。</p>

                    <div class="secondary-page-nav-shell">
                        <nav class="secondary-page-nav" aria-label="画面组件设置分类">
                            <button
                                v-for="(item, index) in PLATFORM_SUBPAGES"
                                :key="item.key"
                                type="button"
                                class="secondary-page-nav-item"
                                :class="{ active: platformSubpage === item.key }"
                                :aria-current="platformSubpage === item.key ? 'page' : undefined"
                                @click="selectPlatformSubpage(item.key)"
                            >
                                <span class="secondary-page-number">{{ String(index + 1).padStart(2, '0') }}</span>
                                <span class="secondary-page-copy">
                                    <strong>{{ item.label }}</strong>
                                    <small>{{ item.description }}</small>
                                </span>
                                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.75 5.25 5.25-5.25 5.25" /></svg>
                            </button>
                        </nav>
                    </div>

                    <div v-show="platformSubpage === 'designer'" class="secondary-page-panel secondary-page-panel-designer">
                        <DashboardDesigner class="platform-designer-primary" @reload="loadPlatform" />
                    </div>

                    <div v-show="platformSubpage === 'scene'" v-if="platform.activeProject" class="settings-section secondary-page-panel">
                        <h3 class="section-title">项目与当前场景</h3>
                        <p class="scene-basic-note">这里只管理场景的基础身份信息。大屏名称、主题和多级视角请在“大屏设计器”中配置；灯光与环境请在“场景与光效”中配置。</p>
                        <div class="settings-grid" v-if="platform.activeScene">
                            <label>项目名称
                                <input :value="platform.activeProject.name" disabled class="input" />
                            </label>
                            <label>场景名称
                                <input v-model="platform.activeScene.name" class="input" />
                            </label>
                        </div>
                        <button @click="saveActiveScene" class="btn btn-primary" style="margin-top:16px;">保存场景名称</button>
                    </div>

                    <div v-show="platformSubpage === 'environment'" class="secondary-page-panel">
                        <NativeEnvironmentSettings
                            :config="nativeEnvironmentConfig"
                            :saving="nativeEnvironmentSaving"
                            :message="nativeEnvironmentMessage"
                            :preset-options="nativeEnvironmentPresetOptions"
                            :workshops="workshops"
                            :lines="lines"
                            :devices="devices"
                            @save="saveNativeEnvironmentSettings($event || {})"
                            @apply-preset="applyNativeEnvironmentPreset"
                            @reset="resetNativeEnvironmentConfig"
                        />
                    </div>

                    <div v-if="false" class="settings-section" style="margin-top:24px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                            <h3 class="section-title" style="margin: 0;">组件布局</h3>
                            <button @click="openCreateWidgetModal" class="btn btn-primary">+ 添加新组件</button>
                        </div>
                        <div class="widget-layout-editor">
                            <div class="widget-layout-form">
                                <div class="table-scroll">
                                    <table class="data-table platform-table widget-layout-table">
                                        <thead>
                                            <tr>
                                                <th>显示</th><th>ID</th><th>类型</th><th>标题</th>
                                                <th>左</th><th>上</th><th>宽</th><th>高</th><th>排序</th><th>配置 JSON</th><th>绑定 JSON</th><th>操作</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr
                                                v-for="widget in platform.widgets"
                                                :key="widget.id"
                                                class="widget-layout-row"
                                                :class="{ active: selectedWidgetPreviewId === widget.id }"
                                                @click="selectWidgetPreview(widget)"
                                                @mouseenter="showWidgetPreview(widget, $event)"
                                                @mousemove="moveWidgetPreviewPopover($event)"
                                                @mouseleave="hideWidgetPreview"
                                            >
                                                <td><input v-model="widget.visible" type="checkbox" /></td>
                                                <td><code>{{ widget.id }}</code></td>
                                                <td>
                                                    <select v-model="widget.widget_type" @change="applyWidgetDefaults(widget)" class="input input-sm">
                                                        <option v-for="type in widgetTypeOptions" :key="type.value" :value="type.value">{{ type.label }}</option>
                                                    </select>
                                                </td>
                                                <td><input v-model="widget.title" class="input input-sm" /></td>
                                                <td><input v-model.number="widget.x" type="number" class="input input-sm coord-input" /></td>
                                                <td><input v-model.number="widget.y" type="number" class="input input-sm coord-input" /></td>
                                                <td><input v-model.number="widget.w" type="number" class="input input-sm coord-input" /></td>
                                                <td><input v-model.number="widget.h" type="number" class="input input-sm coord-input" /></td>
                                                <td><input v-model.number="widget.sort_order" type="number" class="input input-sm coord-input" /></td>
                                                <td class="widget-editor-cell">
                                                    <button type="button" @click.stop="widget.configText = formatJsonForEditor(getWidgetDefaultConfig(widget.widget_type))" class="btn btn-sm widget-default-btn">默认</button>
                                                    <textarea v-model="widget.configText" class="input widget-json widget-json-large" spellcheck="false"></textarea>
                                                </td>
                                                <td class="widget-editor-cell">
                                                    <button type="button" @click.stop="widget.bindingText = formatJsonForEditor(getWidgetDefaultBinding(widget.widget_type))" class="btn btn-sm widget-default-btn">默认</button>
                                                    <textarea v-model="widget.bindingText" class="input widget-json widget-json-large" spellcheck="false"></textarea>
                                                </td>
                                                <td class="widget-action-cell" @mouseenter.stop="hideWidgetPreview" @mousemove.stop="hideWidgetPreview">
                                                    <button @click.stop="saveWidget(widget)" class="btn btn-primary btn-sm">保存</button>
                                                    <button @click.stop="deleteWidget(widget.id)" class="btn btn-danger btn-sm">删除</button>
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                        <Teleport to="body">
                            <div
                                v-if="widgetPreviewHover.visible && hoveredPreviewWidget"
                                class="widget-preview-popover"
                                :style="widgetPreviewPopoverStyle"
                            >
                                <div class="widget-live-preview-header">
                                    <div>
                                        <strong>实时预览</strong>
                                        <span>{{ hoveredPreviewWidget.title || hoveredPreviewWidget.id }}</span>
                                    </div>
                                    <small>{{ getWidgetPreviewModeLabel(hoveredPreviewWidget) }}</small>
                                </div>
                                <div class="widget-hover-preview-stage">
                                    <template v-if="isDashboardGridPreview(hoveredPreviewWidget)">
                                        <div class="widget-hover-preview-canvas" :style="getWidgetFocusCanvasStyle(hoveredPreviewWidget)">
                                            <div
                                                v-for="previewWidget in dashboardPreviewWidgets"
                                                :key="previewWidget.id"
                                                class="widget-preview-slot"
                                                :class="{ active: hoveredPreviewWidget.id === previewWidget.id, hidden: !previewWidget.visible }"
                                                :style="getAdminWidgetGridStyle(previewWidget)"
                                            >
                                                <WidgetRenderer
                                                    v-if="previewWidget.visible && previewableWidgetTypes.has(previewWidget.widget_type)"
                                                    :widget="previewWidget"
                                                    :metrics="widgetPreviewMetrics"
                                                    :events="widgetPreviewEvents"
                                                    :trend-points="widgetPreviewTrendPoints"
                                                />
                                                <div v-else class="widget-preview-placeholder">
                                                    <strong>{{ previewWidget.title || previewWidget.id }}</strong>
                                                    <span>{{ widgetTypeLabelMap[previewWidget.widget_type] || previewWidget.widget_type }}</span>
                                                    <small>{{ previewWidget.visible ? getWidgetPreviewDescription(previewWidget) : '当前已隐藏' }}</small>
                                                </div>
                                            </div>
                                        </div>
                                    </template>
                                    <div v-else-if="hoveredPreviewWidget.widget_type === 'diagnostics'" class="widget-device-detail-preview">
                                        <div class="widget-device-card">
                                            <div class="device-card-header">
                                                <strong>1# 多用炉</strong>
                                                <span>点击设备后的诊断面板</span>
                                            </div>
                                            <div class="diagnostic-preview-grid">
                                                <div v-for="group in widgetPreviewDiagnosticGroups" :key="group.title" class="diagnostic-preview-group">
                                                    <strong>{{ group.title }}</strong>
                                                    <div v-for="row in group.rows.slice(0, 3)" :key="row.label" class="diagnostic-preview-row">
                                                        <span>{{ row.label }}</span>
                                                        <b>{{ row.value }}<small v-if="row.unit"> {{ row.unit }}</small></b>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div v-else-if="hoveredPreviewWidget.widget_type === 'device_label'" class="widget-device-label-preview">
                                        <div class="mock-device-block"></div>
                                        <div class="mock-device-label" :style="getDeviceLabelPreviewStyle(hoveredPreviewWidget)">
                                            <strong v-if="getDeviceLabelPreviewTitle(hoveredPreviewWidget)">{{ getDeviceLabelPreviewTitle(hoveredPreviewWidget) }}</strong>
                                            <span>温度：836 °C</span>
                                            <span>碳势：0.88 %</span>
                                        </div>
                                        <small>设备浮标配置不会占用大屏面板网格</small>
                                    </div>
                                    <div v-else-if="hoveredPreviewWidget.widget_type === 'line_overview_cards'" class="widget-line-card-preview">
                                        <div v-for="index in 4" :key="index" class="mock-line-card">
                                            <strong>{{ index }}# 多用炉</strong>
                                            <span>温度 {{ 820 + index * 8 }} °C</span>
                                            <span>碳势 0.8{{ index }} %</span>
                                        </div>
                                    </div>
                                    <div v-else class="widget-preview-empty">当前组件暂无专用预览</div>
                                </div>
                                <div class="widget-live-preview-footer">
                                    <span>{{ getWidgetPreviewDescription(hoveredPreviewWidget) }}</span>
                                    <small>{{ getWidgetPlacementText(hoveredPreviewWidget) }}</small>
                                </div>
                            </div>
                        </Teleport>
                        </div>
                    </div>

                    <!-- 新增组件弹窗 -->
                    <Transition name="modal-fade">
                        <div v-if="showCreateWidgetModal" class="modal-overlay" @click.self="showCreateWidgetModal = false">
                            <div class="modal-box widget-create-modal" style="max-width: 620px;">
                                <div class="modal-header">
                                    <h3>新增画面组件</h3>
                                    <button class="modal-close-icon-btn" @click="showCreateWidgetModal = false" title="关闭">
                                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                                            <path d="M3 3l10 10M13 3l-10 10"/>
                                        </svg>
                                    </button>
                                </div>
                                <div class="form-grid" style="grid-template-columns: 1fr 1fr; gap: 14px;">
                                    <label>组件 ID
                                        <input v-model="newWidget.id" class="input" placeholder="如 widget_text_notice" />
                                    </label>
                                    <label>组件类型
                                        <select v-model="newWidget.widget_type" @change="applyNewWidgetDefaults" class="input">
                                            <option v-for="type in widgetTypeOptions.filter(item => item.value !== 'navigation')" :key="type.value" :value="type.value">{{ type.label }}</option>
                                        </select>
                                    </label>
                                    <label style="grid-column: span 2;">组件标题
                                        <input v-model="newWidget.title" class="input" placeholder="如 生产指标概览" />
                                    </label>
                                    <div class="form-section" style="grid-column: span 2; margin: 4px 0 0;">
                                        <div class="form-section-header">
                                            <strong>栅格位置与尺寸</strong>
                                            <span>网格列数与行数配置</span>
                                        </div>
                                        <div class="form-grid compact-form-grid" style="grid-template-columns: repeat(4, 1fr); gap: 10px;">
                                            <label>左 (X)<input v-model.number="newWidget.x" type="number" class="input" placeholder="0" /></label>
                                            <label>上 (Y)<input v-model.number="newWidget.y" type="number" class="input" placeholder="0" /></label>
                                            <label>宽 (W)<input v-model.number="newWidget.w" type="number" class="input" placeholder="6" /></label>
                                            <label>高 (H)<input v-model.number="newWidget.h" type="number" class="input" placeholder="4" /></label>
                                        </div>
                                    </div>
                                    <label style="grid-column: span 2;">组件配置 JSON
                                        <textarea v-model="newWidget.configText" class="input widget-json-textarea" placeholder="配置 JSON" spellcheck="false" style="height: 90px; font-family: SFMono-Regular, Consolas, monospace; font-size: 12px;"></textarea>
                                    </label>
                                    <label style="grid-column: span 2;">数据绑定 JSON
                                        <textarea v-model="newWidget.bindingText" class="input widget-json-textarea" placeholder="数据绑定 JSON" spellcheck="false" style="height: 70px; font-family: SFMono-Regular, Consolas, monospace; font-size: 12px;"></textarea>
                                    </label>
                                </div>
                                <div class="modal-actions" style="margin-top: 20px; display: flex; justify-content: flex-end; gap: 12px;">
                                    <button @click="showCreateWidgetModal = false" class="btn">取消</button>
                                    <button @click="handleCreateWidgetSubmit" class="btn btn-primary">确定添加</button>
                                </div>
                            </div>
                        </div>
                    </Transition>

                    <div v-if="false" class="settings-section" style="margin-top:24px;">
                        <h3 class="section-title">发布版本</h3>
                        <table class="data-table">
                            <thead><tr><th>版本</th><th>当前</th><th>发布时间</th></tr></thead>
                            <tbody>
                                <tr v-for="release in platform.releases" :key="release.id">
                                    <td>{{ release.version }}</td>
                                    <td>{{ release.is_current ? '是' : '否' }}</td>
                                    <td>{{ release.created_at }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- ======== 点位映射 ======== -->
                <div v-if="activeTab === 'points'" class="tab-content">
                    <h2>PLC 点位映射</h2>
                    <p class="desc">为每台设备配置 PLC 点位名称、地址和采集周期。用户只需要维护现场点位，系统会自动生成大屏和模型绑定需要的内部标识。</p>

                    <div class="form-row" style="margin-bottom:20px; align-items: flex-end;">
                        <div>
                            <label style="font-size:12px; color:#86868b; display:block; margin-bottom:5px;">筛选设备</label>
                            <select v-model="selectedDeviceForPoints" @change="loadDataPoints" class="input" style="width:250px">
                                <option value="all">全部设备</option>
                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                            </select>
                        </div>
                        <div v-if="selectedDeviceForPoints" style="display:flex; gap:10px; margin-left: 20px;">
                            <button @click="alert('点表导入会做成模板校验后批量导入，当前请先手动配置关键点位。', { title: '点表导入', type: 'info' })" class="btn">导入点表</button>
                            <div v-if="!isAllPointsMode" style="position: relative; display: inline-block;">
                                <select @change="copyPointsFrom($event.target.value); $event.target.value=''" class="input" style="width: 180px;">
                                    <option value="">从其他设备复制...</option>
                                    <option v-for="d in devices.filter(x => x.id !== selectedDeviceForPoints)" :key="d.id" :value="d.id">复制自: {{ d.name }}</option>
                                </select>
                            </div>
                            <button v-if="!isAllPointsMode" @click="syncToLine" class="btn">应用到同产线</button>
                        </div>
                    </div>

                    <div v-if="selectedDeviceForPoints">
                        <div class="point-toolbar">
                            <button @click="showPointAdvancedFields = !showPointAdvancedFields" class="btn btn-sm">
                                {{ showPointAdvancedFields ? '收起换算字段' : '显示换算字段' }}
                            </button>
                        </div>
                        <div class="table-scroll">
                            <table class="data-table points-table" :class="{ 'points-table-advanced': showPointAdvancedFields }">
                                <thead>
                                    <tr>
                                        <th v-if="isAllPointsMode">设备</th>
                                        <th>点位名称</th><th>点位用途</th><th>数据类型</th><th>PLC 地址</th>
                                        <th>采集周期(ms)</th><th>读写</th>
                                        <th v-if="showPointAdvancedFields" title="PLC 原始值乘以这个数，常用于把整数缩放成工程值">换算倍率</th>
                                        <th v-if="showPointAdvancedFields" title="倍率换算后再加上的修正值，常用于传感器零点校准">偏移修正</th>
                                        <th v-if="showPointAdvancedFields" title="控制画面显示的小数位，例如 0、0.0、0.00">显示小数</th>
                                        <th>单位</th><th>报警说明</th><th>语音播报</th><th></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr v-for="(p, idx) in paginatedDataPoints" :key="p.name || p.plc_tag || idx">
                                        <td v-if="isAllPointsMode">
                                            <select v-model="p.device_id" @change="markPointsDirty" class="input input-sm device-point-select">
                                                <option value="">选择设备</option>
                                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                                            </select>
                                        </td>
                                        <td><input v-model="p.label" @input="markPointsDirty" class="input input-sm point-name-input" placeholder="实际温度 / bj1" /></td>
                                        <td>
                                            <select v-model="p.__usage" @change="setPointUsage(p, p.__usage)" class="input input-sm point-usage-input">
                                                <option v-for="item in pointUsageOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
                                            </select>
                                        </td>
                                        <td>
                                            <select v-model="p.data_type" @change="handlePointDataTypeChange(p)" class="input input-sm point-datatype-select">
                                                <option v-for="type in pointDataTypes" :key="type.value" :value="type.value">{{ type.label }}</option>
                                            </select>
                                        </td>
                                        <td class="plc-address-td">
                                            <div class="plc-address-wrap">
                                                <input v-model="p.plc_tag" @input="markPointsDirty" 
                                                       class="input input-sm plc-address-input" 
                                                       :class="{ 'has-warning': !!getPlcAddressWarning(p), 'has-duplicate': !!getPlcDuplicateWarning(p) }"
                                                       :title="getPlcDuplicateWarning(p) || getPlcAddressWarning(p) || getPointAddressTitle(p)"
                                                       :placeholder="getPointAddressPlaceholder(p)" />
                                                <span v-if="getPlcDuplicateWarning(p)" class="plc-warning-icon plc-duplicate-icon" :title="getPlcDuplicateWarning(p)">
                                                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                                                        <rect x="1" y="1" width="10" height="10" rx="2" stroke="#ff3b30" stroke-width="1.3" fill="rgba(255, 59, 48, 0.1)"/>
                                                        <rect x="5" y="5" width="10" height="10" rx="2" stroke="#ff3b30" stroke-width="1.3" fill="rgba(255, 59, 48, 0.1)"/>
                                                    </svg>
                                                </span>
                                                <span v-else-if="getPlcAddressWarning(p)" class="plc-warning-icon" :title="getPlcAddressWarning(p)">
                                                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
                                                        <path d="M8 1.85L14.4 13.35C14.52 13.56 14.37 13.8 14.13 13.8H1.87C1.63 13.8 1.48 13.56 1.6 13.35L8 1.85Z" fill="rgba(255, 149, 0, 0.16)" stroke="#ff9500" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                                                        <line x1="8" y1="6" x2="8" y2="9.3" stroke="#ff9500" stroke-width="1.5" stroke-linecap="round"/>
                                                        <circle cx="8" cy="11.5" r="0.8" fill="#ff9500"/>
                                                    </svg>
                                                </span>
                                            </div>
                                        </td>
                                        <td><input v-model.number="p.sample_interval_ms" @input="markPointsDirty" type="number" min="100" step="50" class="input input-sm sample-input" placeholder="1000" /></td>
                                        <td>
                                            <select v-model="p.access_type" @change="markPointsDirty" class="input input-sm access-input">
                                                <option value="READ">读</option>
                                                <option value="READ_WRITE">读写</option>
                                                <option value="WRITE">仅写</option>
                                            </select>
                                        </td>
                                        <td v-if="showPointAdvancedFields"><input v-model.number="p.scale" @input="markPointsDirty" type="number" step="0.001" class="input input-sm number-input" placeholder="1" title="PLC 原始值乘以这个数，例如原始值 253、倍率 0.1，得到 25.3" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model.number="p.offset" @input="markPointsDirty" type="number" step="0.001" class="input input-sm number-input" placeholder="0" title="倍率换算后再加上的修正值，例如传感器整体偏低 2 度就填 2" /></td>
                                        <td v-if="showPointAdvancedFields"><input v-model="p.display_format" @input="markPointsDirty" class="input input-sm unit-input" placeholder="如 0.0" title="控制画面显示的小数位，例如 0 表示整数，0.0 表示 1 位小数，0.00 表示 2 位小数" /></td>
                                        <td><input v-model="p.unit" @input="markPointsDirty" class="input input-sm unit-input" :disabled="isBoolPoint(p)" :placeholder="isBoolPoint(p) ? '无' : '°C'" /></td>
                                        <td>
                                            <input v-if="normalizePointUsage(p) === 'alarm_trigger'" v-model="p.alarm_text" @input="markPointsDirty" class="input input-sm alarm-text-input" placeholder="报警说明" />
                                            <span v-else class="muted-cell">-</span>
                                        </td>
                                        <td>
                                            <button @click="openVoiceConfig(p)" class="btn btn-sm voice-config-button" :class="{ configured: enabledVoiceRuleCount(p) > 0 }">
                                                {{ enabledVoiceRuleCount(p) > 0 ? `${enabledVoiceRuleCount(p)} 条` : '配置' }}
                                            </button>
                                        </td>
                                        <td><button @click="removeDataPoint(p)" class="btn btn-danger btn-sm">✕</button></td>
                                    </tr>
                                    <tr v-if="dataPoints.length === 0">
                                        <td :colspan="(showPointAdvancedFields ? 13 : 10) + (isAllPointsMode ? 1 : 0)" style="text-align:center; padding: 20px; color: #86868b;">暂无点位配置，请手动添加或从其他设备复制。</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>

                        <div v-if="dataPoints.length > 0" class="points-pagination-bar">
                            <div class="pagination-info">
                                <span>共 <strong>{{ dataPoints.length }}</strong> 条点位</span>
                                <span v-if="pointsPageSize > 0">，第 <strong>{{ pointsCurrentPage }}</strong> / <strong>{{ totalPointPages }}</strong> 页</span>
                            </div>

                            <div class="pagination-controls">
                                <div class="page-size-selector">
                                    <span class="selector-label">每页显示：</span>
                                    <select v-model.number="pointsPageSize" class="input input-sm page-size-select">
                                        <option :value="10">10 条/页</option>
                                        <option :value="20">20 条/页</option>
                                        <option :value="50">50 条/页</option>
                                        <option :value="100">100 条/页</option>
                                        <option :value="200">200 条/页</option>
                                        <option :value="0">显示全部</option>
                                    </select>
                                </div>

                                <div v-if="pointsPageSize > 0 && totalPointPages > 1" class="pagination-nav-btns">
                                    <button @click="pointsCurrentPage = 1" :disabled="pointsCurrentPage === 1" class="btn btn-sm pagination-btn" title="首页">«</button>
                                    <button @click="pointsCurrentPage--" :disabled="pointsCurrentPage <= 1" class="btn btn-sm pagination-btn" title="上一页">‹</button>
                                    
                                    <button v-for="page in displayedPageNumbers" :key="page" 
                                            @click="pointsCurrentPage = page" 
                                            class="btn btn-sm pagination-btn page-num-btn" 
                                            :class="{ active: pointsCurrentPage === page }">
                                        {{ page }}
                                    </button>

                                    <button @click="pointsCurrentPage++" :disabled="pointsCurrentPage >= totalPointPages" class="btn btn-sm pagination-btn" title="下一页">›</button>
                                    <button @click="pointsCurrentPage = totalPointPages" :disabled="pointsCurrentPage === totalPointPages" class="btn btn-sm pagination-btn" title="末页">»</button>
                                </div>
                            </div>
                        </div>

                        <Transition name="modal-fade">
                            <div v-if="selectedVoicePoint" class="modal-overlay" @click.self="closeVoiceConfig">
                                <div class="modal-box voice-config-modal">
                                    <div class="voice-modal-header">
                                        <div>
                                            <h3>点位语音播报</h3>
                                            <p>{{ voiceRuleDeviceName(selectedVoicePoint) }} / {{ pointDisplayName(selectedVoicePoint) || '未命名点位' }}</p>
                                        </div>
                                        <button @click="closeVoiceConfig" class="btn btn-sm modal-close-icon-btn" title="关闭">✕</button>
                                    </div>

                                    <div class="voice-config-help">
                                        <strong>推荐：</strong>普通报警点使用“0→1”，恢复提示使用“1→0”；温度、压力等模拟量使用“向上/向下跨过阈值”。
                                        文字转语音可以带 <code>{设备}</code>、<code>{点位}</code>、<code>{值}</code>、<code>{单位}</code>；生成的 WAV 是固定内容，更适合要求声音完全一致的现场。
                                    </div>

                                    <div v-if="pointVoiceRules(selectedVoicePoint).length === 0" class="voice-empty-state">
                                        当前点位还没有语音规则。
                                    </div>

                                    <div v-for="(rule, ruleIndex) in pointVoiceRules(selectedVoicePoint)" :key="rule.id" class="voice-rule-card">
                                        <div class="voice-rule-card-header">
                                            <label class="inline-check">
                                                <input v-model="rule.enabled" type="checkbox" @change="markPointsDirty" />
                                                启用第 {{ ruleIndex + 1 }} 条规则
                                            </label>
                                            <button @click="removeVoiceRule(selectedVoicePoint, ruleIndex)" class="btn btn-danger btn-sm rule-delete-icon-btn" title="删除规则">
                                                <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
                                                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                                                    <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                                                </svg>
                                            </button>
                                        </div>

                                        <div class="voice-rule-grid">
                                            <label>触发方式
                                                <select v-model="rule.trigger" @change="markPointsDirty" class="input">
                                                    <option v-for="item in voiceTriggerOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
                                                </select>
                                            </label>
                                            <label v-if="voiceRuleNeedsThreshold(rule)">触发阈值
                                                <input v-model.number="rule.threshold" @input="markPointsDirty" type="number" step="0.001" class="input" placeholder="例如 850" />
                                            </label>
                                            <label>播放方式
                                                <select v-model="rule.mode" @change="markPointsDirty" class="input">
                                                    <option value="auto">自动（文件优先，无则转语音）</option>
                                                    <option value="tts">系统文字转语音</option>
                                                    <option value="file">固定语音文件</option>
                                                </select>
                                            </label>
                                            <label>系统声音
                                                <select v-model="rule.voice_name" @change="markPointsDirty" class="input">
                                                    <option value="">系统默认声音</option>
                                                    <option v-for="voice in systemVoices" :key="voice.name" :value="voice.name">{{ voice.name }}（{{ voice.culture || '系统' }}）</option>
                                                </select>
                                            </label>
                                            <label>冷却时间（秒）
                                                <input :value="Number(rule.cooldown_ms || 0) / 1000" @input="updateVoiceCooldown(rule, $event.target.value)" type="number" min="0" max="3600" step="1" class="input" />
                                            </label>
                                            <label>语速（0.5-2）
                                                <input v-model.number="rule.rate" @input="markPointsDirty" type="number" min="0.5" max="2" step="0.1" class="input" />
                                            </label>
                                            <label>音量（0-1）
                                                <input v-model.number="rule.volume" @input="markPointsDirty" type="number" min="0" max="1" step="0.1" class="input" />
                                            </label>
                                            <label class="inline-check voice-startup-check">
                                                <input v-model="rule.announce_on_start" type="checkbox" @change="markPointsDirty" />
                                                <span>软件启动时若条件成立，也播报一次</span>
                                            </label>
                                        </div>

                                        <label class="voice-text-label">播报文字
                                            <textarea v-model="rule.text" @input="markPointsDirty" class="input voice-rule-text" placeholder="例如：{设备} 循环风扇冷却水流量低，请检查。"></textarea>
                                        </label>

                                        <div class="voice-file-row">
                                            <div class="voice-file-path">
                                                <span>语音文件</span>
                                                <code>{{ rule.audio_url || '未生成或上传（当前使用系统文字转语音）' }}</code>
                                            </div>
                                            <div class="voice-rule-actions">
                                                <button @click="previewVoiceRule(rule, selectedVoicePoint)" class="btn">测试播报</button>
                                                <button @click="generateVoiceFile(rule, selectedVoicePoint)" class="btn btn-primary" :disabled="voiceGeneratingRuleId === rule.id">
                                                    {{ voiceGeneratingRuleId === rule.id ? '生成中...' : '生成 WAV' }}
                                                </button>
                                                <button @click="selectVoiceFile(selectedVoicePointIndex, ruleIndex)" class="btn" :disabled="voiceUploadingRuleId === rule.id">
                                                    {{ voiceUploadingRuleId === rule.id ? '上传中...' : '上传语音文件' }}
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                    <div class="modal-actions voice-modal-actions">
                                        <button @click="addVoiceRule(selectedVoicePoint)" class="btn btn-primary">+ 添加播报规则</button>
                                        <button @click="closeVoiceConfig" class="btn">完成配置</button>
                                    </div>
                                    <input ref="voiceFileInput" type="file" accept=".wav,.mp3,.ogg,.m4a,audio/*" style="display:none" @change="handleVoiceFileChange" />
                                </div>
                            </div>
                        </Transition>

                        <div style="margin-top:15px;display:flex; justify-content: space-between; align-items: center;">
                            <div style="display:flex; gap:10px; flex-wrap:wrap;">
                                <button @click="addDataPoint('normal')" class="btn">+ 添加点位</button>
                            </div>
                            <div style="display:flex; align-items: center; gap: 15px;">
                                <span v-if="isPointsDirty" style="color: #ff9500; font-size: 13px;">存在未保存的修改</span>
                                <button @click="saveAllPoints" class="btn btn-primary" :disabled="!isPointsDirty && dataPoints.length > 0">{{ isAllPointsMode ? '保存全部设备配置' : '保存当前设备配置' }}</button>
                            </div>
                        </div>

                        <section class="alarm-config-card" :class="{ open: isAlarmConfigOpen }">
                            <button
                                type="button"
                                class="alarm-config-header"
                                :aria-expanded="isAlarmConfigOpen"
                                @click="isAlarmConfigOpen = !isAlarmConfigOpen"
                            >
                                <div>
                                    <h3>报警点位与报警文本</h3>
                                    <p>按排产软件习惯，报警触发点位建议命名为 bj1、bj2、bj3...，报警说明可粘贴 <code>1 =&gt; "报警内容"</code> 格式，也可以一行一条按顺序导入。</p>
                                </div>
                                <span class="alarm-config-header-actions">
                                    <span class="alarm-config-count">{{ alarmTextImportSummary }}</span>
                                    <svg class="collapse-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
                                </span>
                            </button>

                            <Transition name="section-collapse">
                                <div v-show="isAlarmConfigOpen" class="collapsible-section-body">
                                    <div class="alarm-record-status">
                                        <div v-for="item in alarmRecordPointStatus.slice(0, 3)" :key="item.role" :class="{ configured: item.configured }">
                                            <span>{{ item.label }}</span>
                                            <strong>{{ item.configured ? '已配置' : '未配置' }}</strong>
                                        </div>
                                    </div>

                                    <div class="alarm-import-layout">
                                        <textarea v-model="alarmTextImportRaw" class="input alarm-textarea" placeholder="例如：
1 => &quot;循环风扇冷却水流量低故障&quot;,
2 => &quot;油搅拌1不运行&quot;,
3 => &quot;内推链电机空开跌落&quot;," />
                                        <div class="alarm-import-side">
                                            <button @click="fillAlarmTextTemplate" class="btn" :disabled="isAllPointsMode">生成当前报警模板</button>
                                            <button @click="triggerAlarmTextFileSelect" class="btn" :disabled="isAllPointsMode">导入文本文件</button>
                                            <button @click="applyAlarmTextImport" class="btn btn-primary" :disabled="isAllPointsMode">匹配到报警点位</button>
                                            <input ref="alarmTextFileInput" type="file" accept=".txt,.csv" style="display:none" @change="handleAlarmTextFileChange" />
                                            <div class="alarm-preview">
                                                <strong>解析预览</strong>
                                                <div v-if="parsedAlarmTextEntries.length === 0" class="muted-cell">暂无可解析文本</div>
                                                <div v-for="entry in parsedAlarmTextEntries.slice(0, 8)" :key="entry.number">
                                                    bj{{ entry.number }}：{{ entry.text }}
                                                </div>
                                                <div v-if="parsedAlarmTextEntries.length > 8" class="muted-cell">还有 {{ parsedAlarmTextEntries.length - 8 }} 条...</div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </Transition>
                        </section>
                    </div>
                </div>

                <!-- ======== 点位实时监视 ======== -->
                <div v-if="activeTab === 'point-monitor'" class="tab-content">
                    <h2>PLC 点位实时监视</h2>
                    <p class="desc">查看已配置 PLC 点位的实时值、质量、标准地址和最近读取时间。这里读取的是后端采集缓存，不会因为刷新页面而强行插队读取 PLC。</p>

                    <div class="form-row point-monitor-toolbar">
                        <div>
                            <label style="font-size:12px; color:#86868b; display:block; margin-bottom:5px;">筛选设备</label>
                            <select v-model="selectedDeviceForMonitor" class="input" style="width:280px">
                                <option value="all">全部设备</option>
                                <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }} ({{ d.id }})</option>
                            </select>
                        </div>
                        <button @click="loadRealtimePointValues" class="btn" :disabled="realtimePointLoading">
                            {{ realtimePointLoading ? '读取中...' : '读取最新缓存' }}
                        </button>
                        <label class="inline-toggle">
                            <input v-model="pointMonitorAutoRefresh" type="checkbox" />
                            自动刷新
                        </label>
                    </div>

                    <div class="point-monitor-status">
                        <div>
                            <span class="status-label">监视范围</span>
                            <span class="plc-status-pill" :class="'plc-' + (pointMonitorStatusSummary?.status || 'idle')">
                                {{ isAllPointMonitorMode ? pointMonitorStatusSummary.message : (plcStatusLabels[realtimePointDeviceStatus?.status] || formatPlcDeviceStatus(selectedMonitorDevice || {})) }}
                            </span>
                        </div>
                        <div>
                            <span class="status-label">端点</span>
                            <strong>{{ isAllPointMonitorMode ? '全部设备' : (realtimePointDeviceStatus?.endpoint || (selectedMonitorDevice ? formatPlcEndpoint(selectedMonitorDevice) : '-')) }}</strong>
                        </div>
                        <div>
                            <span class="status-label">页面刷新周期</span>
                            <strong>{{ pointMonitorAutoRefresh ? `${pointMonitorRefreshIntervalMs}ms` : '手动刷新' }}</strong>
                        </div>
                        <div>
                            <span class="status-label">PLC采集周期</span>
                            <strong>按每行配置执行</strong>
                        </div>
                        <div>
                            <span class="status-label">最近数据快照</span>
                            <strong>{{ formatPointTime(realtimePointSnapshotAt) }}</strong>
                        </div>
                    </div>

                    <div v-if="realtimePointError" class="inline-error">{{ realtimePointError }}</div>

                    <div class="table-scroll">
                        <table class="data-table realtime-points-table">
                            <thead>
                                <tr>
                                    <th>设备</th>
                                    <th>点位名称</th>
                                    <th>点位用途</th>
                                    <th>当前值</th>
                                    <th>质量</th>
                                    <th>PLC 标准地址</th>
                                    <th>数据类型</th>
                                    <th>采集周期</th>
                                    <th>报警说明</th>
                                    <th>最近读取</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="point in paginatedRealtimePointRows" :key="point.__runtimeKey">
                                    <td>{{ point.device_name || point.device_id || '-' }}</td>
                                    <td>{{ pointDisplayName(point) || '-' }}</td>
                                    <td>{{ formatPointUsage(point) }}</td>
                                    <td class="point-value-cell">{{ formatPointValue(point) }}</td>
                                    <td>
                                        <span class="point-quality-pill" :class="'quality-' + (point.quality || 'bad')">
                                            {{ formatQualityLabel(point.quality) }}
                                        </span>
                                    </td>
                                    <td>{{ point.plc_address || point.plc_tag || '-' }}</td>
                                    <td>{{ point.data_type || '-' }}</td>
                                    <td>{{ point.sample_interval_ms || '-' }}ms</td>
                                    <td>{{ point.alarm_text || '-' }}</td>
                                    <td>{{ formatPointTime(point.lastReadAt) }}</td>
                                </tr>
                                <tr v-if="!realtimePointRows.length">
                                    <td colspan="10" style="text-align:center; padding: 22px; color:#86868b;">暂无点位，先到“点位映射”里配置 PLC 地址。</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div v-if="realtimePointRows.length > 0" class="points-pagination-bar">
                        <div class="pagination-info">
                            <span>共 <strong>{{ realtimePointRows.length }}</strong> 条点位</span>
                            <span v-if="monitorPageSize > 0">，第 <strong>{{ monitorCurrentPage }}</strong> / <strong>{{ totalMonitorPages }}</strong> 页</span>
                        </div>

                        <div class="pagination-controls">
                            <div class="page-size-selector">
                                <span class="selector-label">每页显示：</span>
                                <select v-model.number="monitorPageSize" class="input input-sm page-size-select">
                                    <option :value="10">10 条/页</option>
                                    <option :value="20">20 条/页</option>
                                    <option :value="50">50 条/页</option>
                                    <option :value="100">100 条/页</option>
                                    <option :value="200">200 条/页</option>
                                    <option :value="0">显示全部</option>
                                </select>
                            </div>

                            <div v-if="monitorPageSize > 0 && totalMonitorPages > 1" class="pagination-nav-btns">
                                <button @click="monitorCurrentPage = 1" :disabled="monitorCurrentPage === 1" class="btn btn-sm pagination-btn" title="首页">«</button>
                                <button @click="monitorCurrentPage--" :disabled="monitorCurrentPage <= 1" class="btn btn-sm pagination-btn" title="上一页">‹</button>
                                
                                <button v-for="page in displayedMonitorPageNumbers" :key="page" 
                                        @click="monitorCurrentPage = page" 
                                        class="btn btn-sm pagination-btn page-num-btn" 
                                        :class="{ active: monitorCurrentPage === page }">
                                    {{ page }}
                                </button>

                                <button @click="monitorCurrentPage++" :disabled="monitorCurrentPage >= totalMonitorPages" class="btn btn-sm pagination-btn" title="下一页">›</button>
                                <button @click="monitorCurrentPage = totalMonitorPages" :disabled="monitorCurrentPage === totalMonitorPages" class="btn btn-sm pagination-btn" title="末页">»</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- ======== 系统设置 ======== -->
                <div v-if="activeTab === 'settings'" class="tab-content">
                    <h2>系统设置</h2>
                    <p class="desc">配置大屏渲染性能、数据通路、PLC 连接参数和通信方式。</p>

                    <div class="secondary-page-nav-shell">
                        <nav class="secondary-page-nav" aria-label="系统设置分类">
                            <button
                                v-for="(item, index) in SETTINGS_SUBPAGES"
                                :key="item.key"
                                type="button"
                                class="secondary-page-nav-item"
                                :class="{ active: settingsSubpage === item.key }"
                                :aria-current="settingsSubpage === item.key ? 'page' : undefined"
                                @click="selectSettingsSubpage(item.key)"
                            >
                                <span class="secondary-page-number">{{ String(index + 1).padStart(2, '0') }}</span>
                                <span class="secondary-page-copy">
                                    <strong>{{ item.label }}</strong>
                                    <small>{{ item.description }}</small>
                                </span>
                                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.75 5.25 5.25-5.25 5.25" /></svg>
                            </button>
                        </nav>
                    </div>

                    <!-- 引擎运行状态 -->
                    <div class="engine-status-card" :class="'status-' + engineStatus.plcStatus?.status">
                        <div class="engine-status-header">
                            <span class="engine-dot"></span>
                            <strong>数据引擎状态</strong>
                        </div>
                        <div class="engine-status-body">
                            <span>运行模式：{{ formatEngineMode(engineStatus.mode) }}</span>
                            <span>数据状态：{{ engineStatus.plcStatus?.message || '未知' }}</span>
                            <span v-if="engineStatus.collectorStatus?.lastFrameAt">最近帧：{{ new Date(engineStatus.collectorStatus.lastFrameAt).toLocaleTimeString() }}</span>
                        </div>
                    </div>

                    <div v-show="settingsSubpage === 'license'" class="settings-section secondary-page-panel license-settings-panel">
                        <div class="license-heading-row">
                            <div>
                                <h3 class="section-title">离线许可证</h3>
                                <p class="desc">许可证只在本机校验，不上传客户信息；强制授权开启后，许可证失效会保护配置写入。</p>
                            </div>
                            <span class="license-status-pill" :class="`license-${licenseStatus.status}`">
                                {{ licenseStatusLabel(licenseStatus.status) }}
                            </span>
                        </div>
                        <div class="license-summary-grid">
                            <div><span>客户</span><strong>{{ licenseStatus.customer || '未配置' }}</strong></div>
                            <div><span>许可证编号</span><strong>{{ licenseStatus.licenseId || '—' }}</strong></div>
                            <div><span>有效期</span><strong>{{ licenseStatus.expiresAt ? formatBackupTime(licenseStatus.expiresAt) : '—' }}</strong></div>
                            <div><span>强制授权</span><strong>{{ licenseStatus.enforce ? '已开启' : '未开启（开发/演示）' }}</strong></div>
                        </div>
                        <div class="release-status-card">
                            <div><span>当前程序版本</span><strong>{{ releaseStatus.current?.productVersion || '—' }}</strong></div>
                            <div><span>配置版本</span><strong>{{ releaseStatus.current?.configurationVersion || '—' }}</strong></div>
                            <div><span>升级模式</span><strong>{{ releaseStatus.mode === 'offline_signed_package' ? '离线签名包' : '不可用' }}</strong></div>
                            <p>升级包必须通过签名和 SHA-256 校验，低版本包会被拒绝；现场先导出整站灾备，再安装升级包，失败时按回滚说明恢复。</p>
                        </div>
                        <p class="license-reason" :class="{ warning: !licenseStatus.valid && licenseStatus.enforce }">{{ licenseStatus.reason }}</p>
                        <div class="license-install-card">
                            <label>安装或替换许可证 JSON
                                <textarea v-model="licenseText" class="input license-textarea" rows="8" spellcheck="false" placeholder="粘贴交付方提供的签名许可证 JSON"></textarea>
                            </label>
                            <div class="form-row license-actions">
                                <button type="button" class="btn btn-primary" :disabled="licenseBusy || !licenseText.trim()" @click="installLicenseFromText">
                                    {{ licenseBusy ? '校验中…' : '校验并安装' }}
                                </button>
                                <button type="button" class="btn" :disabled="licenseBusy" @click="loadLicenseStatus">刷新状态</button>
                            </div>
                            <p v-if="licenseMessage" class="database-backup-message">{{ licenseMessage }}</p>
                        </div>
                    </div>

                    <div class="settings-form settings-form-wide">

                        <!-- ===== 数据库部署配置 ===== -->
                        <div v-show="settingsSubpage === 'database'" class="settings-section secondary-page-panel">
                            <h3 class="section-title">主业务数据库</h3>
                            <div class="settings-grid">
                                <label>数据库类型
                                    <select v-model="databaseConfig.type" class="input">
                                        <option value="mysql">MySQL / MariaDB</option>
                                        <option value="postgres">PostgreSQL</option>
                                        <option value="sqlserver">SQL Server</option>
                                        <option value="sqlite">SQLite（仅离线应急 / 迁移交换）</option>
                                    </select>
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">数据库名
                                    <input v-model="databaseConfig.database" class="input" placeholder="dongtai_daping" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">主机
                                    <input v-model="databaseConfig.host" class="input" placeholder="127.0.0.1" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">端口
                                    <input v-model.number="databaseConfig.port" type="number" class="input" placeholder="3307" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">用户名
                                    <input v-model="databaseConfig.user" class="input" placeholder="root" />
                                </label>
                                <label v-if="databaseConfig.type !== 'sqlite'">密码
                                    <input v-model="databaseConfig.password" type="password" class="input" placeholder="留空或输入新密码" />
                                </label>
                                <label v-if="databaseConfig.type === 'sqlite'" style="grid-column: 1 / -1">SQLite 文件
                                    <input v-model="databaseConfig.filename" class="input" placeholder="backend/data/factory.db" />
                                </label>
                                <label v-if="databaseConfig.type === 'sqlserver'">
                                    <span><input v-model="databaseConfig.encrypt" type="checkbox" /> 启用加密连接</span>
                                </label>
                                <label v-if="databaseConfig.type === 'sqlserver'">
                                    <span><input v-model="databaseConfig.trustServerCertificate" type="checkbox" /> 信任服务器证书</span>
                                </label>
                            </div>
                            <p v-if="databaseConfig.type === 'mysql'" class="database-production-notice">
                                正式生产模式：设备配置、报警记录和长期历史数据统一保存在 MySQL / MariaDB，适合持续查询、统计与扩容。
                            </p>
                            <p v-else-if="databaseConfig.type === 'sqlite'" class="database-local-only-notice">
                                SQLite 只建议用于离线应急、迁移交换或临时演示，不再作为正式现场的长期主数据库。
                            </p>
                            <div class="form-row" style="margin-top:16px; margin-bottom:0; display:flex; align-items:center; gap:12px;">
                                <button @click="testDatabaseConnection" class="btn">测试连接</button>
                                <button @click="saveDatabaseConnection" class="btn btn-primary" :disabled="databaseSaving">保存数据库连接</button>
                                <span v-if="databaseTestStatus" class="db-status-badge" :class="getDbStatusBadgeClass(databaseTestStatus)">
                                    <span class="db-status-dot"></span>
                                    {{ databaseTestStatus }}
                                </span>
                            </div>

                            <div class="external-data-source-manager" :class="{ open: isExternalDataSourcesOpen }">
                                <div class="external-data-source-heading">
                                    <button
                                        type="button"
                                        class="external-data-source-toggle"
                                        :aria-expanded="isExternalDataSourcesOpen"
                                        @click="isExternalDataSourcesOpen = !isExternalDataSourcesOpen"
                                    >
                                        <span>
                                            <strong>外部只读数据库连接</strong>
                                            <small>用于大屏组件取数，不接管对方数据库，也不会执行新增、修改或删除。</small>
                                        </span>
                                        <span class="external-data-source-toggle-status">
                                            {{ dataSourceConnections.filter(item => !item.primary).length }} 个连接
                                            <svg class="collapse-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
                                        </span>
                                    </button>
                                    <button type="button" class="btn btn-small" @click="resetDataSourceEditor(); isExternalDataSourcesOpen = true">＋ 新建连接</button>
                                </div>

                                <Transition name="section-collapse">
                                    <div v-show="isExternalDataSourcesOpen" class="collapsible-section-body">
                                        <div class="external-data-source-list">
                                            <button
                                                v-for="connection in dataSourceConnections.filter(item => !item.primary)"
                                                :key="connection.id"
                                                type="button"
                                                class="external-data-source-card"
                                                :class="{ active: dataSourceEditor.id === connection.id }"
                                                @click="editDataSource(connection)"
                                            >
                                                <span class="external-data-source-icon">DB</span>
                                                <span><strong>{{ connection.name }}</strong><small>{{ connection.type }} · {{ connection.database || connection.filename }}</small></span>
                                                <em>{{ connection.enabled ? '启用' : '停用' }}</em>
                                            </button>
                                            <p v-if="!dataSourceConnections.some(item => !item.primary)" class="empty-hint">尚未添加外部数据源。添加后，设计器里可直接选择“连接 → 表 → 字段”。</p>
                                        </div>

                                        <div class="external-data-source-editor">
                                            <label>连接名称<input v-model="dataSourceEditor.name" class="input" placeholder="例如：MES 生产数据库" /></label>
                                            <label>数据库类型
                                                <select v-model="dataSourceEditor.type" class="input">
                                                    <option value="mysql">MySQL / MariaDB</option>
                                                    <option value="postgres">PostgreSQL</option>
                                                    <option value="sqlserver">SQL Server</option>
                                                    <option value="sqlite">SQLite 文件</option>
                                                </select>
                                            </label>
                                            <label v-if="dataSourceEditor.type !== 'sqlite'">主机<input v-model="dataSourceEditor.host" class="input" placeholder="127.0.0.1" /></label>
                                            <label v-if="dataSourceEditor.type !== 'sqlite'">端口<input v-model.number="dataSourceEditor.port" type="number" class="input" /></label>
                                            <label v-if="dataSourceEditor.type !== 'sqlite'">数据库名<input v-model="dataSourceEditor.database" class="input" /></label>
                                            <label v-if="dataSourceEditor.type !== 'sqlite'">默认 Schema<input v-model="dataSourceEditor.defaultSchema" class="input" placeholder="PostgreSQL: public / SQL Server: dbo" /></label>
                                            <label v-if="dataSourceEditor.type !== 'sqlite'">只读账号<input v-model="dataSourceEditor.user" class="input" /></label>
                                            <label v-if="dataSourceEditor.type !== 'sqlite'">密码<input v-model="dataSourceEditor.password" type="password" class="input" /></label>
                                            <label v-else class="external-data-source-wide">SQLite 文件<input v-model="dataSourceEditor.filename" class="input" placeholder="完整 .db 文件路径" /></label>
                                            <label>查询超时（毫秒）<input v-model.number="dataSourceEditor.queryTimeoutMs" type="number" min="1000" max="60000" class="input" /></label>
                                            <label class="checkbox-line"><input v-model="dataSourceEditor.enabled" type="checkbox" /> 启用此连接</label>
                                        </div>
                                        <div class="external-data-source-actions">
                                            <button type="button" class="btn" :disabled="dataSourceBusy" @click="testExternalDataSource">测试只读连接</button>
                                            <button type="button" class="btn btn-primary" :disabled="dataSourceBusy" @click="saveExternalDataSource">保存连接</button>
                                            <button v-if="dataSourceEditor.id" type="button" class="btn btn-danger" :disabled="dataSourceBusy" @click="removeExternalDataSource({ ...dataSourceEditor })">删除</button>
                                            <span v-if="dataSourceMessage">{{ dataSourceMessage }}</span>
                                        </div>
                                    </div>
                                </Transition>
                            </div>

                            <div class="database-backup-panel database-auto-backup-panel">
                                <div class="database-backup-header">
                                    <div>
                                        <strong>数据库自动压缩备份（仅防断电或数据库损坏）</strong>
                                        <p>先选择需要保护的数据库，再分别决定软件启动、持续运行和正常退出时是否生成备份；默认全部开启。</p>
                                    </div>
                                    <button type="button" class="btn" :disabled="dataSourceBackupBusy" @click="runSelectedDatabaseBackups()">立即备份已选</button>
                                </div>
                                <div class="database-backup-trigger-grid">
                                    <label class="database-backup-trigger-card" :class="{ active: dataSourceBackupConfig.startupEnabled }">
                                        <input v-model="dataSourceBackupConfig.startupEnabled" type="checkbox" />
                                        <span class="database-backup-trigger-index">01</span>
                                        <span class="database-backup-trigger-copy">
                                            <strong>软件启动</strong>
                                            <small>每次启动完成后立即生成 startup 备份</small>
                                        </span>
                                        <span class="database-backup-trigger-switch" aria-hidden="true"><i></i></span>
                                    </label>
                                    <label class="database-backup-trigger-card" :class="{ active: dataSourceBackupConfig.scheduledEnabled }">
                                        <input v-model="dataSourceBackupConfig.scheduledEnabled" type="checkbox" />
                                        <span class="database-backup-trigger-index">02</span>
                                        <span class="database-backup-trigger-copy">
                                            <strong>持续运行</strong>
                                            <small>软件不退出时，按下方间隔自动生成 scheduled 备份</small>
                                        </span>
                                        <span class="database-backup-trigger-switch" aria-hidden="true"><i></i></span>
                                    </label>
                                    <label class="database-backup-trigger-card" :class="{ active: dataSourceBackupConfig.shutdownEnabled }">
                                        <input v-model="dataSourceBackupConfig.shutdownEnabled" type="checkbox" />
                                        <span class="database-backup-trigger-index">03</span>
                                        <span class="database-backup-trigger-copy">
                                            <strong>正常退出</strong>
                                            <small>完全退出程序前生成 shutdown 备份；最小化到托盘不会触发</small>
                                        </span>
                                        <span class="database-backup-trigger-switch" aria-hidden="true"><i></i></span>
                                    </label>
                                </div>
                                <div class="database-auto-backup-controls">
                                    <label>持续运行备份间隔（小时）<input v-model.number="dataSourceBackupConfig.intervalHours" type="number" min="1" max="168" class="input input-small" :disabled="!dataSourceBackupConfig.scheduledEnabled" /></label>
                                    <label>外部连接保留份数<input v-model.number="dataSourceBackupConfig.retention" type="number" min="1" max="100" class="input input-small" /></label>
                                    <button type="button" class="btn btn-small" :disabled="dataSourceBackupBusy" @click="saveDataSourceBackupConfiguration">保存备份规则</button>
                                </div>
                                <div class="database-backup-protection-note">
                                    <span>按需保护</span>
                                    <div><strong>手动备份、整站导出、恢复前安全备份</strong><small>这些操作由用户主动发起；恢复前回滚备份始终保留，避免恢复失败后无法撤回。</small></div>
                                </div>
                                <div class="database-backup-source-grid">
                                    <label v-for="connection in dataSourceConnections" :key="`backup-${connection.id}`" class="database-backup-source-option">
                                        <input v-model="dataSourceBackupConfig.selectedConnectionIds" type="checkbox" :value="connection.id" />
                                        <span><strong>{{ connection.name }}</strong><small>{{ connection.type }} · {{ connection.database || connection.filename }}</small></span>
                                    </label>
                                </div>
                                <p v-if="dataSourceBackupStatus.lastError" class="database-recovery-notice">最近自动备份存在失败：{{ dataSourceBackupStatus.lastError.error }}</p>
                            </div>

                            <div v-if="databaseBackupStatus.supported" class="database-backup-panel">
                                <div class="database-backup-header">
                                    <div>
                                        <strong>主业务数据库备份与恢复</strong>
                                        <p>{{ databaseBackupStatus.type === 'mysql' ? '使用一致性 mysqldump 并 gzip 压缩。' : '使用 SQLite 一致性文件备份。' }}启动、持续运行和正常退出规则由上方分别控制。</p>
                                    </div>
                                    <button @click="runSelectedDatabaseBackups('primary')" class="btn" :disabled="databaseBackupBusy || dataSourceBackupBusy">立即备份主库</button>
                                </div>
                                <div class="database-retention-card">
                                    <div class="database-retention-heading">
                                        <div class="database-retention-icon" aria-hidden="true">
                                            <svg viewBox="0 0 24 24">
                                                <path d="M12 7v5l3 2" />
                                                <circle cx="12" cy="12" r="8" />
                                            </svg>
                                        </div>
                                        <div>
                                            <strong>备份保留策略</strong>
                                            <span>超过期限自动清理，至少保留最近一份有效备份。</span>
                                        </div>
                                        <em>当前 {{ databaseBackupStatus.retentionDays || 30 }} 天</em>
                                    </div>
                                    <div class="database-retention-controls">
                                        <div class="database-retention-presets" aria-label="常用保留天数">
                                            <button
                                                v-for="days in databaseBackupRetentionPresets"
                                                :key="days"
                                                type="button"
                                                :class="{ active: Number(databaseBackupPolicy.retentionDays) === days }"
                                                :aria-pressed="Number(databaseBackupPolicy.retentionDays) === days"
                                                @click="selectDatabaseBackupRetention(days)"
                                            >
                                                {{ days }} 天
                                            </button>
                                        </div>
                                        <label class="database-retention-custom">
                                            <span>自定义</span>
                                            <span class="database-retention-input">
                                                <input
                                                    v-model.number="databaseBackupPolicy.retentionDays"
                                                    type="number"
                                                    :min="databaseBackupStatus.retentionDaysMin || 1"
                                                    :max="databaseBackupStatus.retentionDaysMax || 3650"
                                                    step="1"
                                                    inputmode="numeric"
                                                />
                                                <em>天</em>
                                            </span>
                                        </label>
                                        <button
                                            type="button"
                                            class="btn btn-primary database-retention-save"
                                            :disabled="databaseBackupPolicySaving"
                                            @click="saveDatabaseBackupPolicy"
                                        >
                                            {{ databaseBackupPolicySaving ? '保存中…' : '保存策略' }}
                                        </button>
                                    </div>
                                    <div class="database-retention-stats">
                                        <div><span>现有备份</span><strong>{{ databaseBackupStatus.backups.length }} 份</strong></div>
                                        <div><span>占用空间</span><strong>{{ formatBackupSize(databaseBackupStatus.totalBackupBytes) }}</strong></div>
                                        <div><span>最早备份</span><strong>{{ formatBackupTime(databaseBackupStatus.oldestBackup?.createdAt) }}</strong></div>
                                        <div><span>最新备份</span><strong>{{ formatBackupTime(databaseBackupStatus.newestBackup?.createdAt) }}</strong></div>
                                    </div>
                                </div>
                                <p v-if="databaseBackupStatus.lastBackupError" class="database-recovery-notice">
                                    最近一次自动备份失败：{{ databaseBackupStatus.lastBackupError.error }}
                                </p>
                                <p v-if="databaseBackupStatus.lastRecovery" class="database-recovery-notice">
                                    最近恢复：{{ formatBackupTime(databaseBackupStatus.lastRecovery.recoveredAt) }}，
                                    来源 {{ databaseBackupStatus.lastRecovery.source }}
                                </p>
                                <p v-if="databaseBackupMessage" class="database-backup-message">{{ databaseBackupMessage }}</p>
                                <p class="database-local-only-notice">
                                    这些备份仍保存在当前电脑内，电脑丢失或硬盘损坏时无法使用；整机灾难请使用下方“整站灾备”。
                                </p>
                                <div class="database-backup-list">
                                    <div v-for="backup in databaseBackupStatus.backups" :key="backup.filename" class="database-backup-row">
                                        <div>
                                            <strong>{{ backup.filename }}</strong>
                                            <span>{{ formatBackupTime(backup.createdAt) }} · {{ formatBackupSize(backup.size) }}</span>
                                        </div>
                                        <span class="backup-validity" :class="backup.valid ? 'is-valid' : 'is-invalid'">
                                            {{ backup.valid ? '校验通过' : '已损坏' }}
                                        </span>
                                        <button @click="downloadDatabaseBackup(backup)" class="btn btn-small" :disabled="!backup.valid">下载</button>
                                        <button @click="restoreDatabaseBackup(backup)" class="btn btn-small" :disabled="databaseBackupBusy || !backup.valid">恢复</button>
                                        <button @click="deleteDatabaseBackup(backup)" class="btn btn-small btn-danger backup-delete-button" :disabled="databaseBackupBusy">删除</button>
                                    </div>
                                    <div v-if="databaseBackupStatus.backups.length === 0" class="empty-hint">暂无备份</div>
                                </div>
                            </div>
                            <div v-else-if="databaseConfig.type === 'mysql'" class="database-backup-panel">
                                <p class="database-local-only-notice">
                                    MySQL 已连接，但未找到 mysqldump/mysql 客户端工具，自动备份暂不可用。请安装 MySQL 客户端工具，或在服务环境配置 MYSQLDUMP_PATH、MYSQL_CLIENT_PATH 后重启软件。
                                </p>
                            </div>

                            <div v-if="siteBackupStatus.supported" class="site-backup-panel">
                                <div class="site-backup-header">
                                    <div>
                                        <strong>整站灾备（防电脑丢失）</strong>
                                        <p>一个 ZIP 包含一致性数据库、全部现场配置和所有上传模型，可在新电脑安装软件后直接导入复原。</p>
                                    </div>
                                    <div class="site-backup-actions">
                                        <button @click="exportSiteBackup" class="btn btn-primary" :disabled="siteBackupBusy">导出整站备份</button>
                                        <button @click="chooseSiteBackupFile" class="btn" :disabled="siteBackupBusy">从整站备份恢复</button>
                                        <input ref="siteBackupFileInput" class="site-backup-file-input" type="file" accept=".zip,application/zip" @change="restoreSiteBackupFromFile" />
                                    </div>
                                </div>
                                <p class="site-backup-external-notice">
                                    导出包含数据库数据及外部数据源连接凭据，属于敏感文件。请保存到受控的 U 盘、移动硬盘或 NAS；只留在现场电脑上仍无法防止整机丢失。
                                </p>
                                <div class="site-backup-auto-config">
                                    <label class="site-backup-auto-toggle">
                                        <input v-model="siteBackupConfig.autoEnabled" type="checkbox" />
                                        自动整站备份
                                    </label>
                                    <label>间隔（小时）
                                        <input v-model.number="siteBackupConfig.intervalHours" class="input input-small" type="number" min="1" max="168" />
                                    </label>
                                    <label class="site-backup-mirror-field">外部备份目录（U 盘 / NAS）
                                        <input v-model="siteBackupConfig.mirrorDirectory" class="input" placeholder="例如 E:\\数字孪生备份 或 \\\\NAS\\factory-backup" />
                                    </label>
                                    <button type="button" class="btn btn-small" :disabled="siteBackupConfigSaving" @click="saveSiteBackupConfiguration">保存自动灾备</button>
                                </div>
                                <p v-if="siteBackupStatus.lastAutomaticBackup" class="database-backup-message">
                                    最近自动备份：{{ siteBackupStatus.lastAutomaticBackup.filename }}
                                    <span v-if="siteBackupStatus.lastAutomaticBackup.mirror">（已同步外部目录）</span>
                                </p>
                                <p v-if="siteBackupStatus.lastError" class="database-recovery-notice">
                                    灾备提醒：{{ siteBackupStatus.lastError.error }}
                                </p>
                                <p v-if="siteBackupMessage" class="database-backup-message">{{ siteBackupMessage }}</p>
                                <div v-if="siteBackupStatus.backups.length" class="site-backup-history">
                                    <span>本机最近生成</span>
                                    <button
                                        v-for="backup in siteBackupStatus.backups.slice(0, 3)"
                                        :key="backup.filename"
                                        type="button"
                                        class="site-backup-history-item"
                                        :disabled="siteBackupBusy"
                                        @click="downloadSiteBackup(backup)"
                                    >
                                        <strong>{{ backup.filename }}</strong>
                                        <small>{{ formatBackupTime(backup.createdAt) }} · {{ formatBackupSize(backup.size) }} · 重新保存</small>
                                    </button>
                                </div>
                            </div>
                        </div>

                        <!-- ===== 运行与投屏 ===== -->
                        <div v-show="settingsSubpage === 'runtime'" class="settings-section runtime-settings-section secondary-page-panel">
                            <h3 class="section-title">运行与投屏</h3>

                            <!-- 主路径：像手机投屏一样，直接选局域网里的电视 -->
                            <section class="cast-device-panel">
                                <div class="cast-panel-heading">
                                    <div>
                                        <strong>局域网电视</strong>
                                        <p>电脑与电视连接同一路由器后，可直接搜索支持 DLNA / 多屏互动的电视并投送 Unity 大屏。</p>
                                    </div>
                                    <div class="cast-panel-actions">
                                        <span class="runtime-badge" :class="castState.casting ? 'is-supported' : 'is-muted'">
                                            {{ castState.casting ? `投屏中 · ${castingDeviceName}` : (!castState.loaded ? '正在检测投屏服务' : `待机 · ${castState.devices.length} 台可投`) }}
                                        </span>
                                        <button
                                            class="btn btn-small"
                                            type="button"
                                            :disabled="castState.scanning"
                                            @click="refreshCastDevices"
                                        >
                                            {{ castState.scanning ? '搜索中...' : '搜索电视' }}
                                        </button>
                                    </div>
                                </div>

                                <div v-if="castState.casting" class="cast-active-banner">
                                    <div>
                                        <strong>{{ castSessionStateLabel(castState.session) }} · 「{{ castingDeviceName }}」</strong>
                                        <small>
                                            {{ castState.session?.deviceAddress }} ·
                                            {{ castState.session?.viewers ? `已连接 ${castState.session.viewers} 路视频流` : '电视尚未拉取画面' }}
                                            <template v-if="castState.session?.retryCount"> · 已自动重试 {{ castState.session.retryCount }} 次</template>
                                        </small>
                                    </div>
                                    <button
                                        class="btn btn-small btn-danger"
                                        type="button"
                                        :disabled="Boolean(castBusyDeviceId)"
                                        @click="stopCast"
                                    >停止投屏</button>
                                </div>

                                <p v-if="castState.loaded && castState.ffmpegChecked && !castState.ffmpegAvailable" class="cast-warning">
                                    内置投屏编码器没有准备好，电视投屏按钮暂时不可用。正式安装包会自动内置；开发环境请在
                                    <code>desktop</code> 目录执行 <code>npm run prepare:ffmpeg</code>，等待几秒后重新搜索。
                                    <template v-if="castState.ffmpegError">检测结果：{{ castState.ffmpegError }}。</template>
                                    在此之前可以先用下方的网页投屏。
                                </p>

                                <ul v-if="castState.devices.length" class="cast-device-list">
                                    <li v-for="device in castState.devices" :key="device.id" class="cast-device-row" :class="{ 'is-active': castingDeviceId === device.id }">
                                        <span class="cast-device-icon" aria-hidden="true">
                                            <svg viewBox="0 0 24 24">
                                                <rect x="2.5" y="4" width="19" height="13" rx="2" />
                                                <path d="M8 20.5h8M12 17.5v3" />
                                            </svg>
                                        </span>
                                        <span class="cast-device-text">
                                            <strong>{{ castDeviceLabel(device) }}</strong>
                                            <small>{{ castDeviceSubtitle(device) }}</small>
                                        </span>
                                        <button
                                            v-if="castingDeviceId === device.id"
                                            class="btn btn-small btn-danger"
                                            type="button"
                                            :disabled="Boolean(castBusyDeviceId)"
                                            @click="stopCast"
                                        >停止投屏</button>
                                        <button
                                            v-else
                                            class="btn btn-small btn-primary"
                                            type="button"
                                            :disabled="Boolean(castBusyDeviceId) || !castState.loaded || castState.ffmpegChecking || !castState.ffmpegAvailable"
                                            @click="startCast(device)"
                                        >{{ castBusyDeviceId === device.id ? '连接中...' : '投屏' }}</button>
                                    </li>
                                </ul>
                                <div v-else-if="!castState.loaded" class="cast-empty">
                                    <strong>正在检查投屏服务</strong>
                                    <span>正在读取编码器状态和局域网电视列表...</span>
                                </div>
                                <div v-else class="cast-empty">
                                    <strong>还没有搜到电视</strong>
                                    <span>请确认：电视已开机并与本机连接同一路由器；电视设置里的“DLNA / 多屏互动”已打开；公司网络没有禁用组播。然后点“搜索电视”。</span>
                                </div>

                                <p v-if="castMessage" class="runtime-message">{{ castMessage }}</p>
                                <p v-if="castState.loaded && castState.interfaces.length" class="runtime-help">
                                    当前扫描网卡：{{ castState.interfaces.map(item => `${item.name} ${item.address}`).join(' · ') }}
                                </p>
                                <p v-if="castState.ignoredCount" class="runtime-help">已自动排除 {{ castState.ignoredCount }} 个本机或虚拟媒体设备。</p>
                                <p v-if="castState.castError" class="runtime-error">{{ castState.castError }}</p>
                                <p v-else-if="castState.error && !castState.devices.length" class="runtime-help">{{ castState.error }}</p>
                            </section>

                            <div class="runtime-settings-grid">
                                <section class="runtime-card">
                                    <div class="runtime-card-heading">
                                        <div>
                                            <strong>Windows 登录后自动启动</strong>
                                            <p>现场电脑登录 Windows 后自动打开大屏和本地数据服务。</p>
                                        </div>
                                        <span class="runtime-badge" :class="runtimeSettings.auto_start_supported ? 'is-supported' : 'is-muted'">
                                            {{ runtimeSettings.auto_start_supported ? '安装版可用' : '开发版不注册' }}
                                        </span>
                                    </div>
                                    <label class="runtime-toggle-row">
                                        <input v-model="runtimeSettings.auto_start_enabled" type="checkbox" :disabled="!runtimeSettings.auto_start_supported" />
                                        <span class="runtime-toggle-track"><span></span></span>
                                        <span>{{ runtimeSettings.auto_start_enabled ? '已开启' : '已关闭' }}</span>
                                    </label>
                                    <p class="runtime-help">
                                        安装版保存后由桌面程序立即同步到 Windows 登录项；开发环境只保存配置，不会修改当前电脑的自启动项。
                                    </p>
                                </section>

                                <section class="runtime-card cast-runtime-card">
                                    <div class="runtime-card-heading">
                                        <div>
                                            <strong>网页投屏（备选）</strong>
                                            <p>给不支持 DLNA、但自带浏览器的电视用：电视扫码或输入网址即可打开大屏。</p>
                                        </div>
                                        <span class="runtime-badge" :class="runtimeStatus.running ? 'is-supported' : 'is-muted'">
                                            {{ runtimeStatus.running ? `运行中 · ${runtimeStatus.clients || 0} 台` : '未运行' }}
                                        </span>
                                    </div>
                                    <label class="runtime-toggle-row">
                                        <input v-model="runtimeSettings.lan_display_enabled" type="checkbox" />
                                        <span class="runtime-toggle-track"><span></span></span>
                                        <span>{{ runtimeSettings.lan_display_enabled ? '已开启' : '已关闭' }}</span>
                                    </label>
                                    <div class="runtime-inline-fields">
                                        <label>端口
                                            <input v-model.number="runtimeSettings.lan_display_port" class="input" type="number" min="1024" max="65535" />
                                        </label>
                                        <label>投屏码
                                            <input :value="runtimeSettings.lan_display_pin" class="input runtime-pin-input" readonly />
                                        </label>
                                        <button class="btn btn-small" type="button" @click="rotateCastPin" :disabled="runtimeSaving">重新生成</button>
                                    </div>
                                </section>
                            </div>

                            <details class="runtime-cast-panel runtime-cast-fallback">
                                <summary>
                                    <span>电视浏览器入口（二维码 / 网址）</span>
                                    <button class="btn btn-primary" type="button" @click.prevent.stop="saveRuntimeSettings" :disabled="runtimeSaving">
                                        {{ runtimeSaving ? '保存中...' : '保存运行配置' }}
                                    </button>
                                </summary>
                                <div class="runtime-cast-header">
                                    <div>
                                        <p v-if="runtimeStatus.running">用电视浏览器打开下方地址，或扫描二维码；首次连接输入 6 位投屏码。</p>
                                        <p v-else>开启“网页投屏”并保存后，这里会显示局域网地址和二维码。</p>
                                    </div>
                                </div>
                                <div v-if="runtimeStatus.running" class="runtime-cast-content">
                                    <div v-if="runtimeQrDataUrl" class="runtime-qr-block">
                                        <img :src="runtimeQrDataUrl" alt="局域网投屏二维码" />
                                        <small>扫码直达大屏</small>
                                    </div>
                                    <div class="runtime-url-block">
                                        <div v-for="url in (runtimeStatus.pairingUrls.length ? runtimeStatus.pairingUrls : runtimeStatus.urls)" :key="url" class="runtime-url-row">
                                            <code>{{ url }}</code>
                                            <button class="btn btn-small" type="button" @click="copyCastUrl(url)">复制</button>
                                        </div>
                                        <p class="runtime-help">电脑与电视必须在同一局域网；电视需要现代浏览器和 WebGL。完全没有浏览器、也不支持 DLNA 的电视仍需 HDMI、Miracast 接收器或电视盒子。</p>
                                    </div>
                                </div>
                                <p v-if="runtimeStatus.error" class="runtime-error">{{ runtimeStatus.error }}</p>
                                <p v-if="runtimeMessage" class="runtime-message">{{ runtimeMessage }}</p>
                            </details>
                        </div>

                        <!-- ===== Unity 原生客户端画质 ===== -->
                        <div v-show="settingsSubpage === 'performance'" class="settings-section secondary-page-panel">
                            <h3 class="section-title">Unity 原生客户端画质</h3>
                            <div class="settings-grid">
                                <label>现场电脑画质档位
                                    <select v-model="settings.native_quality_profile" class="input">
                                        <option value="auto">自动识别（推荐）</option>
                                        <option value="integrated_gpu">核显稳定档</option>
                                        <option value="balanced">均衡专业档</option>
                                        <option value="showcase">展示高画质档</option>
                                    </select>
                                </label>
                                <label>模型几何策略
                                    <div class="input render-setting-readonly">始终保留导入模型完整几何</div>
                                </label>
                            </div>
                            <div class="mode-hint render-profile-hint">
                                <template v-if="settings.native_quality_profile === 'integrated_gpu'">
                                    <p><strong>核显稳定档：</strong>降低内部渲染分辨率、附加灯阴影和反射开销，模型面数与贴图内容不变。</p>
                                </template>
                                <template v-else-if="settings.native_quality_profile === 'balanced'">
                                    <p><strong>均衡专业档：</strong>完整 PBR、4× MSAA、专业后处理与中距离阴影，适合开发机和普通独显。</p>
                                </template>
                                <template v-else-if="settings.native_quality_profile === 'showcase'">
                                    <p><strong>展示高画质档：</strong>更高内部渲染比例、远距离阴影与反射，适合展厅高性能电脑。</p>
                                </template>
                                <template v-else>
                                    <p><strong>自动识别：</strong>按显卡名称和显存选择档位；工程师也可在客户端按 F1 / F2 / F3 临时切换。</p>
                                </template>
                                <p>保存后通过 WebSocket 实时切换画质，无需按 F5；所有档位都不会自动减面。场景光效与大屏组件请在“组件配置”页面调整。</p>
                            </div>
                        </div>

                        <!-- ===== 渲染性能 ===== -->
                        <div v-show="settingsSubpage === 'performance'" class="settings-section legacy-web-render-section secondary-page-panel" :class="{ open: isLegacyWebRenderSettingsOpen }">
                            <div class="legacy-web-render-heading">
                                <h3 class="section-title">旧 Web 大屏渲染性能（过渡保留）</h3>
                                <button
                                    type="button"
                                    class="btn btn-small legacy-web-render-toggle icon-only"
                                    :aria-expanded="isLegacyWebRenderSettingsOpen"
                                    :aria-label="isLegacyWebRenderSettingsOpen ? '收起旧 Web 渲染设置' : '显示旧 Web 渲染设置'"
                                    :title="isLegacyWebRenderSettingsOpen ? '收起设置' : '显示设置'"
                                    @click="isLegacyWebRenderSettingsOpen = !isLegacyWebRenderSettingsOpen"
                                >
                                    <svg viewBox="0 0 20 20" aria-hidden="true">
                                        <path d="M5.75 7.75 10 12l4.25-4.25" />
                                    </svg>
                                </button>
                            </div>

                            <Transition name="legacy-render-collapse">
                                <div v-if="isLegacyWebRenderSettingsOpen" class="legacy-web-render-body">
                                    <div class="settings-grid">
                                        <label>性能档位
                                            <select v-model="settings.render_profile" class="input">
                                                <option v-for="profile in renderProfileOptions" :key="profile.value" :value="profile.value">
                                                    {{ profile.label }}
                                                </option>
                                            </select>
                                        </label>
                                        <label>当前生效参数
                                            <div class="input render-setting-readonly">
                                                {{ resolvedRenderSettings.targetFps }} FPS / {{ Math.round(resolvedRenderSettings.renderScale * 100) }}% 分辨率
                                            </div>
                                        </label>
                                    </div>

                                    <div class="mode-hint render-profile-hint">
                                        <p><strong>{{ selectedRenderProfile?.label }}：</strong>{{ selectedRenderProfile?.description }}</p>
                                        <p>浮标刷新 {{ resolvedRenderSettings.labelFps }} FPS；抗锯齿{{ resolvedRenderSettings.antialias ? '开启' : '关闭' }}。保存后刷新大屏页面生效。</p>
                                    </div>

                                    <div v-if="settings.render_profile === 'custom'" class="settings-grid render-custom-grid">
                                        <label>目标帧率 (15-144 FPS)
                                            <input v-model.number="settings.render_target_fps" type="number" min="15" max="144" step="1" class="input" />
                                        </label>
                                        <label>渲染分辨率倍率 (0.5-1.5)
                                            <input v-model.number="settings.render_scale" type="number" min="0.5" max="1.5" step="0.05" class="input" />
                                        </label>
                                        <label>3D 浮标刷新率 (1-30 FPS)
                                            <input v-model.number="settings.render_label_fps" type="number" min="1" max="30" step="1" class="input" />
                                        </label>
                                        <label>抗锯齿
                                            <span class="checkbox-line"><input v-model="settings.render_antialias" type="checkbox" /> 启用 WebGL 抗锯齿</span>
                                        </label>
                                    </div>
                                </div>
                            </Transition>
                        </div>

                        <!-- ===== 数据通路选择 ===== -->
                        <div v-show="settingsSubpage === 'data'" class="settings-section secondary-page-panel">
                            <h3 class="section-title">数据通路模式</h3>
                            <label>选择数据采集方式
                                <select v-model="settings.data_mode" class="input">
                                    <option value="integrated_plc">内置低延迟采集（推荐）</option>
                                    <option value="simulation">模拟数据（离线演示用）</option>
                                </select>
                            </label>
                            <div class="mode-hint">
                                <template v-if="settings.data_mode === 'integrated_plc'">
                                    <p><strong>推荐主链路：</strong>PLC → 大屏后端内置采集器 → WebSocket → 前台 3D。</p>
                                    <p style="color:#86868b; font-size:12px;">PLC 连接参数在“设备管理”里按设备配置，变量采集周期在“点位映射”里按点位配置。</p>
                                </template>
                                <template v-else>
                                    <p><strong>模拟模式：</strong>系统自动生成随机数据，无需连接任何外部设备。</p>
                                    <p style="color:#86868b; font-size:12px;">适用于离线演示、功能验收。数据为程序模拟生成。</p>
                                </template>
                            </div>
                        </div>

                        <button
                            v-if="settingsSubpage === 'performance' || settingsSubpage === 'data'"
                            @click="saveSettings"
                            class="btn btn-primary secondary-page-save"
                        >保存当前参数</button>
                    </div>
                </div>

                    </div>
                </Transition>

            </main>
        </div>

        <Teleport to="body">
            <div
                v-if="activePendingWorkshopMapLine"
                ref="workshopMapPendingGhostRef"
                class="workshop-pending-line-ghost"
                :class="{ 'can-drop': workshopMapPendingDropReady }"
                aria-hidden="true"
            >
                <span class="workshop-line-placement-handle">⠿</span>
                <span class="workshop-line-placement-copy">
                    <strong>{{ activePendingWorkshopMapLine.name }}</strong>
                    <small>{{ workshopLineFootprint(activePendingWorkshopMapLine).length }} × {{ workshopLineFootprint(activePendingWorkshopMapLine).width }} 米</small>
                </span>
                <em>{{ workshopMapPendingDropReady ? '松开放置' : '拖到画布' }}</em>
            </div>
        </Teleport>

        <Transition name="dialog-fade">
            <div v-if="appDialog.visible" class="app-dialog-overlay" @click.self="appDialog.showCancel ? closeAppDialog(false) : null">
                <section class="app-dialog" :class="'dialog-' + appDialog.type" role="dialog" aria-modal="true">
                    <div class="app-dialog-mark"></div>
                    <div class="app-dialog-body">
                        <h3>{{ appDialog.title }}</h3>
                        <p>{{ appDialog.message }}</p>
                        <div v-if="appDialog.details.length" class="app-dialog-details">
                            <div v-for="item in appDialog.details" :key="item.key || item.label">
                                <span>{{ item.label }}</span>
                                <strong>{{ item.count }} 项</strong>
                            </div>
                        </div>
                        <label v-if="appDialog.verificationText" class="app-dialog-verification">
                            <span>{{ appDialog.verificationLabel || '请输入名称以确认删除' }}</span>
                            <input
                                v-model="appDialog.verificationInput"
                                class="input"
                                autocomplete="off"
                                spellcheck="false"
                                :placeholder="appDialog.verificationText"
                                @keydown.enter.prevent="closeAppDialog(true)"
                            />
                            <small>需要输入：<strong>{{ appDialog.verificationText }}</strong></small>
                        </label>
                    </div>
                    <div class="app-dialog-actions">
                        <button v-if="appDialog.showCancel" type="button" class="btn" @click="closeAppDialog(false)">
                            {{ appDialog.cancelText }}
                        </button>
                        <button
                            type="button"
                            class="btn btn-primary"
                            :disabled="!!appDialog.verificationText && appDialog.verificationInput !== appDialog.verificationText"
                            @click="closeAppDialog(true)"
                        >
                            {{ appDialog.confirmText }}
                        </button>
                    </div>
                </section>
            </div>
        </Transition>
    </div>
</template>

<style scoped>
* { box-sizing: border-box; }

.admin-container {
    width: 100%; height: 100%; min-width: 0; min-height: 0;
    background: #f5f5f7; color: #1d1d1f;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column;
    overflow: hidden;
}
.unity-window-chrome {
    height: 46px;
    flex: 0 0 46px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 6px 0 8px;
    color: #344054;
    background: linear-gradient(180deg, #edf2f7 0%, #dfe7ef 100%);
    border-bottom: 1px solid #cbd5df;
    box-shadow: 0 2px 8px rgba(31, 50, 68, 0.14);
    cursor: grab;
    touch-action: none;
    user-select: none;
    z-index: 500;
}
.unity-window-chrome:active { cursor: grabbing; }
.unity-tab-strip {
    min-width: 0;
    flex: 1;
    align-self: stretch;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    overflow: hidden;
}
.unity-browser-tab {
    height: 35px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    border: 1px solid transparent;
    border-bottom: 0;
    border-radius: 10px 10px 0 0;
    color: #475467;
    font-family: inherit;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
}
.unity-browser-tab svg,
.unity-window-action svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.unity-screen-tab {
    background: transparent;
    cursor: grab;
    touch-action: none;
    transition: color 0.16s ease, background 0.16s ease;
}
.unity-screen-tab:active { cursor: grabbing; }
.unity-screen-tab:hover {
    color: #175cd3;
    background: rgba(255, 255, 255, 0.58);
}
.unity-admin-tab {
    min-width: 178px;
    background: transparent;
    cursor: grab;
    touch-action: none;
    position: relative;
    transition: color 0.16s ease, background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.unity-admin-tab:hover { background: rgba(255, 255, 255, 0.58); }
.unity-admin-tab:active { cursor: grabbing; }
.unity-browser-tab.is-active {
    color: #172b3f;
    background: #f8fafc;
    border-color: #cbd5df;
    box-shadow: 0 -1px 4px rgba(27, 45, 63, 0.08);
}
.unity-browser-tab.is-active::after {
    content: '';
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: -1px;
    height: 2px;
    background: #f8fafc;
}
.unity-screen-tab { position: relative; }
.admin-container.unity-dashboard-tab .unity-screen-tab.is-active {
    margin-bottom: 4px;
    border-bottom: 1px solid #cbd5df;
    border-radius: 10px;
    box-shadow: 0 1px 5px rgba(27, 45, 63, 0.14);
}
.admin-container.unity-dashboard-tab .unity-screen-tab.is-active::after {
    display: none;
}
.unity-admin-tab > svg { color: #1570ef; }
.unity-window-chrome.is-dock-ready .unity-admin-tab {
    border-color: #6ce9a6;
    box-shadow: 0 -1px 0 #6ce9a6, 0 0 0 3px rgba(18, 183, 106, 0.1);
}
.unity-tab-online {
    width: 7px;
    height: 7px;
    margin-left: auto;
    border-radius: 50%;
    background: #12b76a;
    box-shadow: 0 0 0 3px rgba(18, 183, 106, 0.12);
}
.unity-window-actions {
    height: 35px;
    display: flex;
    align-items: center;
    align-self: flex-start;
    margin-top: -6px;
    margin-left: 8px;
}
.unity-window-action {
    width: 40px;
    height: 32px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 7px;
    color: #475467;
    background: transparent;
    cursor: pointer;
    transition: color 0.16s ease, background 0.16s ease;
}
.unity-window-action:hover {
    color: #172b3f;
    background: rgba(75, 98, 120, 0.13);
}
.unity-window-action.is-close:hover {
    color: #fff;
    background: #e5484d;
}
.admin-container.unity-embedded.line-planner-active {
    height: 100vh;
    min-height: 0;
    overflow: hidden;
}
.admin-container.unity-dashboard-tab .admin-header,
.admin-container.unity-dashboard-tab .admin-body {
    display: none;
}
.admin-container.line-planner-active {
    height: 100vh;
    min-height: 0;
    overflow: hidden;
}

.admin-header {
    display: flex; justify-content: space-between; align-items: center; gap: 18px;
    flex: 0 0 auto;
    height: 64px; padding: 0 32px; background: rgba(255, 255, 255, 0.85);
    border-bottom: 1px solid rgba(0, 0, 0, 0.08); z-index: 100;
}
.header-logo-section {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    min-width: 0;
}
.header-logo-mark {
    width: 30px;
    height: 30px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: #ffffff;
    color: #1d1d1f;
}
.header-logo-mark svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.admin-header h1 { margin: 0; font-size: 19px; color: #1d1d1f; font-weight: 600; letter-spacing: -0.2px; }
.admin-setup-flow {
    display: flex;
    flex: 1 1 860px;
    align-items: center;
    justify-content: center;
    min-width: 0;
    max-width: 1080px;
    min-height: 44px;
    padding: 4px 9px 4px 13px;
    gap: 9px;
    background: rgba(246, 247, 249, .92);
    border: 1px solid rgba(0, 0, 0, .07);
    border-radius: 18px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .85);
}
.admin-setup-flow-title {
    flex: 0 0 auto;
    color: #86868b;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: .06em;
    white-space: nowrap;
}
.admin-setup-flow-track {
    display: flex;
    flex: 1;
    align-items: center;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
}
.admin-setup-flow-track::-webkit-scrollbar { display: none; }
.admin-setup-step {
    appearance: none;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    min-height: 36px;
    padding: 5px 9px;
    gap: 7px;
    color: #66686c;
    background: transparent;
    border: 0;
    border-radius: 11px;
    cursor: pointer;
    font-family: inherit;
    transition: color .18s ease, background .18s ease, box-shadow .18s ease, transform .18s ease;
}
.admin-setup-step:hover {
    color: #1d1d1f;
    background: rgba(255, 255, 255, .9);
    box-shadow: 0 2px 8px rgba(0, 0, 0, .07);
    transform: translateY(-1px);
}
.admin-setup-step:focus-visible {
    outline: 2px solid rgba(0, 113, 227, .38);
    outline-offset: 1px;
}
.admin-setup-step.active {
    color: #005eb8;
    background: #ffffff;
    box-shadow: 0 3px 10px rgba(0, 71, 145, .12), 0 0 0 1px rgba(0, 113, 227, .09);
}
.admin-setup-step-index {
    display: inline-grid;
    width: 23px;
    height: 23px;
    flex: 0 0 23px;
    place-items: center;
    color: #777a7f;
    background: #e6e8eb;
    border-radius: 50%;
    font-size: 12px;
    font-weight: 750;
    line-height: 1;
}
.admin-setup-step.active .admin-setup-step-index {
    color: #ffffff;
    background: linear-gradient(145deg, #0a84ff, #0066cc);
    box-shadow: 0 2px 6px rgba(0, 102, 204, .3);
}
.admin-setup-step-label {
    font-size: 14px;
    font-weight: 650;
    line-height: 1;
    white-space: nowrap;
}
.admin-setup-flow-connector {
    position: relative;
    flex: 1 1 18px;
    min-width: 6px;
    max-width: 22px;
    height: 1px;
    margin: 0 1px;
    background: #cfd3d8;
}
.admin-setup-flow-connector::after {
    content: '';
    position: absolute;
    right: 0;
    top: -2px;
    width: 4px;
    height: 4px;
    border-top: 1px solid #aeb4bc;
    border-right: 1px solid #aeb4bc;
    transform: rotate(45deg);
}
.admin-connection-strip {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
    margin-left: 0;
}
.admin-connection-pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 5px 11px;
    border: 1px solid transparent;
    border-radius: 999px;
    color: #515154;
    background: #f3f4f6;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
}
.admin-connection-pill i {
    width: 7px;
    height: 7px;
    flex: 0 0 7px;
    border-radius: 50%;
    background: currentColor;
}
.admin-connection-pill.is-online { color: #176b3a; background: #e8f7ee; border-color: #bfe6cd; }
.admin-connection-pill.is-busy,
.admin-connection-pill.is-checking { color: #17628a; background: #eaf5fb; border-color: #bedfed; }
.admin-connection-pill.is-partial { color: #8a5a0f; background: #fff7df; border-color: #ead29b; }
.admin-connection-pill.is-offline { color: #9b3b32; background: #fff0ee; border-color: #efc4bf; }
.admin-connection-pill.is-unknown { color: #667085; background: #f2f4f7; border-color: #dfe3e8; }
@media (max-width: 1380px) {
    .admin-header { gap: 10px; padding-right: 20px; padding-left: 20px; }
    .admin-setup-flow { padding-left: 7px; gap: 0; }
    .admin-setup-flow-title { display: none; }
    .admin-setup-step { padding-right: 7px; padding-left: 7px; }
    .admin-setup-flow-connector { flex-basis: 8px; max-width: 12px; }
}
.admin-body { display: flex; flex: 1; min-height: 0; overflow: hidden; position: relative; }
.admin-container.line-planner-active .admin-body {
    min-height: 0;
    overflow: hidden;
}

.admin-nav {
    width: 250px; background: rgba(245, 245, 247, 0.6);
    border-right: 1px solid rgba(0, 0, 0, 0.08);
    padding: 18px 12px 24px; overflow-y: auto; overflow-x: hidden;
    display: flex; flex-direction: column; gap: 4px;
    transition: width 0.22s ease, padding 0.22s ease;
}
.nav-item {
    appearance: none;
    border: 0;
    width: 100%;
    padding: 10px 16px; cursor: pointer; font-size: 14px; color: #434345;
    font-weight: 500; border-radius: 10px;
    transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1); position: relative;
    display: flex; align-items: center; gap: 10px;
    background: transparent;
    font-family: inherit;
    text-align: left;
}
.nav-collapse-btn {
    appearance: none;
    position: absolute;
    left: calc(250px - 18px);
    top: 50%;
    z-index: 30;
    width: 36px;
    height: 44px;
    padding: 0;
    transform: translateY(-50%);
    justify-content: center;
    display: flex;
    align-items: center;
    color: #6e6e73;
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 9px;
    cursor: pointer;
    transition: left 0.22s ease, background 0.2s ease, color 0.2s ease;
}
.nav-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.nav-group-toggle .nav-chevron {
    margin-left: auto;
    color: #86868b;
    font-size: 13px;
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.nav-group.open .nav-chevron {
    transform: rotate(180deg);
}
.nav-submenu {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-left: 16px;
    max-height: 180px;
    transform-origin: top;
}
.nav-submenu-enter-active,
.nav-submenu-leave-active {
    overflow: hidden;
    transition:
        max-height 240ms cubic-bezier(0.22, 1, 0.36, 1),
        opacity 160ms ease,
        transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.nav-submenu-enter-from,
.nav-submenu-leave-to {
    max-height: 0;
    opacity: 0;
    transform: translateY(-6px);
}
.nav-subitem {
    min-height: 38px;
    padding-top: 8px;
    padding-bottom: 8px;
    font-size: 13px;
}
.nav-collapse-btn:hover,
.nav-item:hover { color: #1d1d1f; background: rgba(0, 0, 0, 0.04); }
.nav-item.active {
    color: #ffffff; background: #111827;
    box-shadow: 0 4px 12px rgba(17, 24, 39, 0.18); font-weight: 600;
}
.nav-item.active::after { display: none; }
.nav-icon,
.nav-collapse-icon {
    width: 20px;
    min-width: 20px;
    height: 20px;
    text-align: center;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
}
.nav-icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.nav-collapse-icon {
    font-size: 22px;
}
.nav-label {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.admin-container.nav-collapsed .admin-nav {
    width: 68px;
    padding: 16px 8px 24px;
    align-items: center;
}
.admin-container.nav-collapsed .nav-item {
    justify-content: center;
    padding: 10px;
    width: 44px;
}
.admin-container.nav-collapsed .nav-collapse-btn {
    left: calc(68px - 18px);
}
.admin-container.nav-collapsed .nav-group,
.admin-container.nav-collapsed .nav-submenu {
    align-items: center;
    padding-left: 0;
}
.admin-container.nav-collapsed .nav-collapse-btn {
    height: 44px;
}
.admin-container.nav-collapsed .nav-label,
.admin-container.nav-collapsed .nav-chevron {
    display: none;
}

.admin-content {
    flex: 1 1 auto; min-width: 0; min-height: 0; padding: 32px 32px 72px; overflow: auto;
    overscroll-behavior: contain; scrollbar-gutter: stable; background: #f5f5f7;
}
.admin-container.composer-active .admin-content {
    padding: 14px 16px 16px;
}
.admin-container.line-planner-active .admin-content {
    padding: 10px 12px 12px;
    overflow-y: auto;
    overflow-x: hidden;
}

.tab-transition-host {
    position: relative;
    min-height: 100%;
}
.tab-switch-enter-active,
.tab-switch-leave-active {
    transition: opacity 150ms ease, transform 210ms cubic-bezier(0.22, 1, 0.36, 1);
}
.tab-switch-enter-from {
    opacity: 0;
    transform: translateY(8px);
}
.tab-switch-leave-to {
    opacity: 0;
    transform: translateY(-4px);
}

.tab-content {
    background: #ffffff; padding: 32px; border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.03), 0 1px 2px rgba(0, 0, 0, 0.02);
    border: 1px solid rgba(0, 0, 0, 0.04);
    min-height: calc(100% - 10px);
}
.tab-content h2 { margin: 0 0 6px 0; font-size: 24px; color: #1d1d1f; font-weight: 600; letter-spacing: -0.5px; }
.desc { color: #86868b; font-size: 14px; margin-bottom: 28px; }
.secondary-page-nav-shell {
    position: sticky;
    top: -32px;
    z-index: 24;
    margin: 0 0 24px;
    padding: 8px;
    background: rgba(245, 245, 247, 0.9);
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 15px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.045);
    backdrop-filter: blur(18px) saturate(1.15);
}
.secondary-page-nav {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 7px;
}
.secondary-page-nav-item {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) 16px;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 64px;
    padding: 10px 12px;
    color: #3a3a3c;
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid rgba(0, 0, 0, 0.055);
    border-radius: 10px;
    text-align: left;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.018);
    transition: color 160ms ease, background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}
.secondary-page-nav-item:hover {
    color: #1d1d1f;
    background: #ffffff;
    border-color: rgba(0, 0, 0, 0.11);
    box-shadow: 0 5px 16px rgba(0, 0, 0, 0.055);
    transform: translateY(-1px);
}
.secondary-page-nav-item.active {
    color: #ffffff;
    background: #1d1d1f;
    border-color: #1d1d1f;
    box-shadow: 0 8px 18px rgba(29, 29, 31, 0.17);
}
.secondary-page-number {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    color: #6e6e73;
    background: #f2f2f4;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
}
.secondary-page-nav-item.active .secondary-page-number {
    color: #1d1d1f;
    background: #ffffff;
}
.secondary-page-copy {
    min-width: 0;
}
.secondary-page-copy strong,
.secondary-page-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.secondary-page-copy strong {
    font-size: 13px;
    font-weight: 650;
}
.secondary-page-copy small {
    margin-top: 3px;
    color: #86868b;
    font-size: 10px;
    font-weight: 500;
}
.secondary-page-nav-item.active .secondary-page-copy small {
    color: rgba(255, 255, 255, 0.68);
}
.secondary-page-nav-item svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.58;
}
.secondary-page-panel {
    animation: secondary-page-in 180ms cubic-bezier(0.22, 1, 0.36, 1);
}
.secondary-page-panel-designer {
    min-width: 0;
}
.secondary-page-save {
    margin-top: 0;
    padding: 10px 30px;
    font-size: 15px;
}
@keyframes secondary-page-in {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: translateY(0); }
}

.line-planner-tab {
    height: 100%;
    min-height: calc(100vh - 86px);
    padding: 0;
    overflow: visible;
    background: #f2f4f6;
}
.line-planner-tab > h2,
.line-planner-tab > .desc,
.line-planner-tab > .form-row,
.line-planner-tab > .data-table {
    display: none;
}
.line-planner-shell {
    height: 100%;
    min-height: calc(100vh - 86px);
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
}
.line-planner-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 72px;
    padding: 16px 22px;
    background: #ffffff;
    border-bottom: 1px solid rgba(25, 33, 38, 0.08);
}
.line-planner-header h2 {
    margin: 0 0 4px;
    font-size: 22px;
    color: #172027;
    letter-spacing: 0;
}
.line-planner-header .desc { margin: 0; color: #6b737a; }
.line-native-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
}
.line-planner-guidance {
    background: #f8fafb;
    border-bottom: 1px solid rgba(25, 33, 38, 0.07);
}
.line-planner-steps {
    display: flex;
    gap: 8px;
    padding: 10px 22px;
    background: #f8fafb;
    border-bottom: 0;
}
.line-planner-steps span {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    padding: 0 10px;
    color: #687179;
    background: #eef1f4;
    border: 1px solid rgba(25, 33, 38, 0.06);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
}
.line-planner-steps .active {
    color: #ffffff;
    background: #1e4f6b;
    border-color: #1e4f6b;
}
.line-planner-layout {
    position: relative;
    height: 100%;
    min-height: calc(100vh - 220px);
    display: grid;
    grid-template-columns: minmax(380px, 440px) minmax(0, 1fr);
    transition: grid-template-columns 0.22s ease;
    overflow: visible;
}
.line-planner-layout.editor-collapsed {
    grid-template-columns: minmax(0, 1fr);
}
.line-planner-layout.editor-collapsed .line-planner-editor {
    display: none;
}
.line-planner-editor {
    min-width: 0;
    align-self: stretch;
    height: 100%;
    max-height: none;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px;
    background: #f5f7f8;
    border-right: 1px solid rgba(25, 33, 38, 0.08);
}
/* The embedded host adds a 46px window-chrome strip above the header, so every
   viewport-relative height in this tab has that much less room to work with. */
.admin-container.unity-embedded .line-planner-tab,
.admin-container.unity-embedded .line-planner-shell {
    min-height: calc(100vh - 132px);
}
.admin-container.unity-embedded .line-planner-layout {
    min-height: calc(100vh - 266px);
}
.admin-container.unity-embedded .line-planner-editor {
    max-height: none;
}
.line-editor-panel,
.line-basic-grid,
.line-structure-section {
    margin-bottom: 14px;
    padding: 14px;
    background: #ffffff;
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 8px;
}
.line-panel-title,
.line-structure-title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
}
.line-panel-title strong,
.line-structure-title strong {
    flex: 0 0 auto;
    color: #172027;
    font-size: 15px;
}
.line-panel-title span {
    min-width: 0;
    color: #77818a;
    font-size: 12px;
    line-height: 1.45;
    text-align: right;
    overflow-wrap: anywhere;
}
.line-create-row,
.line-selector-list,
.line-structure-editor,
.line-structure-section {
    display: grid;
    gap: 10px;
}
.line-create-row .btn {
    min-height: 38px;
}
.line-card {
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 8px;
    background: #f8fafb;
    overflow: hidden;
}
.line-card.active {
    background: #eef5f8;
    border-color: #3e7da0;
    box-shadow: inset 3px 0 0 #245c7a;
}
.line-card-select {
    width: 100%;
    min-height: 42px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 11px;
    color: #172027;
    background: transparent;
    border: 0;
    cursor: pointer;
    text-align: left;
}
.line-card-select strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
}
.line-card-select span {
    color: #77818a;
    font-size: 12px;
    white-space: nowrap;
}
.line-card-status {
    display: inline-flex;
    margin-left: 5px;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 10px;
    font-style: normal;
    font-weight: 800;
    vertical-align: 1px;
}
.line-card-status.pending { color: #9a4f00; background: #fff0d5; }
.line-card-status.dirty { color: #b42318; background: #fee4e2; }
.line-card-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
    gap: 8px;
    padding: 0 10px 10px 13px;
}
.line-card-fields .input {
    min-width: 0;
    height: 32px;
    padding: 5px 8px;
}
.line-card-fields .btn {
    width: 100%;
    padding: 7px 0;
}
.line-basic-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
}
.line-basic-grid label,
.line-layout-row label {
    display: grid;
    gap: 6px;
    min-width: 0;
    color: #4d5861;
    font-size: 12px;
    font-weight: 600;
}
.line-basic-grid .btn {
    grid-column: 2;
    justify-self: end;
    align-self: end;
}
.line-structure-section {
    min-width: 0;
    margin-bottom: 0;
    overflow: hidden;
}
.line-placement-pending-card {
    display: flex;
    width: 100%;
    min-height: 104px;
    padding: 16px;
    align-items: center;
    gap: 14px;
    color: #713b00;
    text-align: left;
    background: linear-gradient(135deg, #fffaf0, #fff1d2);
    border: 1px solid #f5b544;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(181, 105, 0, .11);
    cursor: pointer;
    transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
}
.line-placement-pending-card:hover {
    border-color: #dc8b00;
    box-shadow: 0 11px 28px rgba(181, 105, 0, .18);
    transform: translateY(-1px);
}
.line-placement-pending-icon {
    display: grid;
    flex: 0 0 46px;
    width: 46px;
    height: 46px;
    place-items: center;
    color: #fff;
    background: #e58b00;
    border-radius: 13px;
    box-shadow: 0 7px 16px rgba(205, 116, 0, .24);
}
.line-placement-pending-icon svg { width: 25px; height: 25px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.line-placement-pending-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 6px; }
.line-placement-pending-copy strong { color: #6b3500; font-size: 15px; }
.line-placement-pending-copy small { color: #936222; font-size: 11px; line-height: 1.55; }
.line-placement-pending-action { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 6px; color: #9a5500; font-size: 12px; font-weight: 800; }
.line-placement-pending-action b { font-size: 17px; }
.line-structure-title .btn {
    background: #eef1f4;
    color: #245c7a;
}
.line-flow-hint {
    min-width: 0;
    color: #77818a;
    font-size: 12px;
    line-height: 1.45;
    text-align: right;
    overflow-wrap: anywhere;
}
.line-flow-controls {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
}
.line-flow-btn {
    min-height: 34px;
    color: #46545e;
    background: #eef1f4;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 700;
}
.line-flow-btn:hover {
    background: #ffffff;
}
.line-flow-btn.active {
    color: #ffffff;
    background: #245c7a;
    border-color: #245c7a;
}
.line-layout-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 92px 92px 60px;
    gap: 8px;
    align-items: end;
    padding: 8px;
    background: #f8fafb;
    border: 1px solid rgba(25, 33, 38, 0.06);
    border-radius: 8px;
}
.line-layout-row .input {
    min-width: 0;
    height: 32px;
    padding: 5px 8px;
}
.line-layout-row .btn {
    width: 60px;
    min-width: 60px;
    padding: 7px 0;
}
.line-planner-preview {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    background: #e6ebef;
}
.line-editor-float-toggle {
    appearance: none;
    position: absolute;
    left: -18px;
    top: 50%;
    z-index: 20;
    width: 36px;
    height: 48px;
    padding: 0;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #50616c;
    background: rgba(255,255,255,.92);
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 10px;
    box-shadow: 0 8px 22px rgba(38, 50, 58, .14);
    cursor: pointer;
    font-size: 24px;
    line-height: 1;
}
.line-editor-float-toggle:hover {
    color: #1e4f6b;
    background: #ffffff;
}
.line-editor-float-toggle.collapsed {
    left: 12px;
}
.line-preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 62px;
    padding: 12px 18px;
    color: #172027;
    background: #ffffff;
    border-bottom: 1px solid rgba(25, 33, 38, 0.08);
}
.line-preview-toolbar strong,
.line-preview-toolbar span {
    display: block;
}
.line-preview-toolbar strong {
    font-size: 17px;
}
.line-preview-toolbar span {
    color: #6b737a;
    font-size: 12px;
}
.line-preview-metrics {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
}
.line-preview-metrics span {
    min-height: 26px;
    padding: 5px 9px;
    color: #3d474f;
    background: #f0f3f5;
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 999px;
    font-weight: 600;
}
.line-preview-stage {
    position: relative;
    align-self: stretch;
    height: 100%;
    min-height: clamp(620px, calc(100vh - 240px), 860px);
    margin: 12px;
    overflow: hidden;
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 8px;
    background:
        linear-gradient(rgba(68, 82, 91, .07) 1px, transparent 1px),
        linear-gradient(90deg, rgba(68, 82, 91, .07) 1px, transparent 1px),
        #edf2f4;
    background-size: 34px 34px;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.62);
}
.line-preview-stage::before {
    content: '';
    position: absolute;
    inset: 26px;
    border: 1px dashed rgba(74, 90, 100, 0.22);
    border-radius: 8px;
    pointer-events: none;
}
.line-preview-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: #66727c;
}
.line-preview-legend {
    position: absolute;
    right: 18px;
    top: 14px;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    max-width: 520px;
}
.line-preview-legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 24px;
    padding: 4px 8px;
    color: #44515a;
    background: rgba(255,255,255,.82);
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
}
.line-preview-legend i {
    width: 14px;
    height: 6px;
    border-radius: 999px;
}
.legend-lane { background: #98b7c9; }
.legend-rail { background: #c9953e; }
.legend-device { background: #596873; }
.legend-cart { background: #d4a43c; }
.line-preview-axis {
    position: absolute;
    z-index: 4;
    color: #66727c;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0;
}
.axis-x {
    left: 34px;
    bottom: 18px;
}
.axis-z {
    left: 18px;
    top: 44px;
    writing-mode: vertical-rl;
}
.line-align-guide {
    position: absolute;
    top: 28px;
    bottom: 28px;
    z-index: 7;
    width: 0;
    transform: translateX(-50%);
    border-left: 1px dashed rgba(28, 91, 126, 0.72);
    pointer-events: none;
}
.line-align-guide::before,
.line-align-guide::after {
    content: '';
    position: absolute;
    left: -4px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #2b7197;
    box-shadow: 0 0 0 3px rgba(43, 113, 151, 0.12);
}
.line-align-guide::before {
    top: 0;
}
.line-align-guide::after {
    bottom: 0;
}
.line-map-item {
    position: absolute;
    transform: translateY(-50%);
    display: flex;
    align-items: flex-start;
    padding: 8px 12px;
    color: #26323a;
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
    border-radius: 8px;
    cursor: grab;
    touch-action: none;
    user-select: none;
}
.line-map-item:active {
    cursor: grabbing;
}
.line-map-lane {
    height: 72px;
    background: rgba(117, 154, 176, 0.22);
    border: 1px solid rgba(70, 113, 139, 0.35);
}
.line-map-item.drop-compatible {
    outline: 1px dashed rgba(36, 92, 122, 0.38);
    outline-offset: 4px;
}
.line-map-item.drop-target {
    background: rgba(80, 149, 186, 0.30);
    border-color: rgba(36, 92, 122, 0.72);
    box-shadow: 0 0 0 4px rgba(36, 92, 122, 0.10);
}
.line-map-lane::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    top: 50%;
    height: 2px;
    transform: translateY(-50%);
    background: rgba(36, 92, 122, 0.42);
}
.line-map-flow-arrow {
    position: absolute;
    top: 50%;
    right: 18px;
    z-index: 2;
    width: 48px;
    height: 0;
    transform: translateY(-50%);
    border-top: 2px solid rgba(30, 79, 107, 0.78);
    pointer-events: none;
}
.line-map-flow-arrow::after {
    content: '';
    position: absolute;
    right: -1px;
    top: -5px;
    width: 8px;
    height: 8px;
    border-top: 2px solid rgba(30, 79, 107, 0.78);
    border-right: 2px solid rgba(30, 79, 107, 0.78);
    transform: rotate(45deg);
}
.line-map-flow-arrow.direction-left {
    left: 18px;
    right: auto;
}
.line-map-flow-arrow.direction-left::after {
    left: -1px;
    right: auto;
    transform: rotate(-135deg);
}
.line-map-rail {
    height: 30px;
    align-items: center;
    color: #6b4a0f;
    background: rgba(201, 149, 62, 0.18);
    border: 1px solid rgba(169, 113, 31, 0.45);
}
.line-map-rail.drop-target {
    background: rgba(209, 153, 55, 0.26);
    border-color: rgba(152, 107, 36, 0.78);
    box-shadow: 0 0 0 4px rgba(152, 107, 36, 0.11);
}
.line-map-rail::before,
.line-map-rail::after {
    content: '';
    position: absolute;
    left: 10px;
    right: 10px;
    height: 3px;
    background: #986b24;
    border-radius: 999px;
}
.line-map-rail::before { top: 9px; }
.line-map-rail::after { bottom: 9px; }
.line-map-rail span {
    position: relative;
    z-index: 1;
    padding: 2px 7px;
    background: rgba(255,255,255,.76);
    border-radius: 999px;
}
.line-map-handle {
    position: absolute;
    top: 50%;
    z-index: 3;
    width: 12px;
    height: 34px;
    transform: translateY(-50%);
    border-radius: 999px;
    background: rgba(255,255,255,.88);
    border: 1px solid rgba(25, 33, 38, 0.22);
    box-shadow: 0 2px 6px rgba(25, 33, 38, 0.12);
    cursor: ew-resize;
}
.line-map-handle::before {
    content: '';
    position: absolute;
    left: 50%;
    top: 8px;
    bottom: 8px;
    width: 2px;
    transform: translateX(-50%);
    background: rgba(36, 92, 122, 0.45);
    border-radius: 999px;
}
.handle-left { left: -6px; }
.handle-right { right: -6px; }
.line-map-flow-settings {
    position: absolute;
    top: -22px;
    right: -5px;
    z-index: 8;
    display: block;
    width: 24px;
    height: 24px;
    padding: 0 !important;
    background: transparent !important;
    border-radius: 7px !important;
}
.line-map-flow-settings-trigger {
    display: grid;
    width: 24px;
    height: 24px;
    padding: 0;
    place-items: center;
    color: #3c5968;
    background: rgba(255,255,255,.94);
    border: 1px solid rgba(25, 33, 38, 0.22);
    border-radius: 7px;
    box-shadow: 0 3px 8px rgba(25, 33, 38, 0.16);
    cursor: pointer;
    touch-action: manipulation;
}
.line-map-flow-settings-trigger:hover,
.line-map-flow-settings-trigger.active {
    color: #ffffff;
    background: #245c7a;
    border-color: #245c7a;
}
.line-map-flow-settings-trigger svg {
    width: 15px;
    height: 15px;
    fill: currentColor;
}
.line-map-flow-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 12;
    display: grid;
    gap: 3px;
    min-width: 82px;
    padding: 5px;
    background: rgba(255,255,255,.98);
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 9px;
    box-shadow: 0 10px 24px rgba(25, 33, 38, 0.2);
}
.line-map-flow-menu button {
    min-height: 27px;
    padding: 4px 8px;
    color: #42535d;
    background: transparent;
    border: 0;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
    white-space: nowrap;
}
.line-map-flow-menu button:hover,
.line-map-flow-menu button.active {
    color: #174e6b;
    background: #e9f3f8;
}
.line-preview-dragging,
.line-preview-dragging * {
    cursor: grabbing !important;
    user-select: none !important;
}
.line-map-device {
    position: absolute;
    width: 126px;
    min-height: 54px;
    transform: translate(-50%, -50%);
    display: grid;
    gap: 2px;
    align-content: center;
    padding: 8px 10px;
    color: #f7fafb;
    background: linear-gradient(180deg, #6c7a84, #46535c);
    border: 1px solid rgba(25, 33, 38, 0.18);
    border-radius: 6px;
    box-shadow: 0 12px 24px rgba(38, 50, 58, .20);
    text-align: left;
    cursor: grab;
    touch-action: none;
    user-select: none;
}
.line-map-device::before {
    content: '';
    position: absolute;
    left: 8px;
    top: 8px;
    bottom: 8px;
    width: 4px;
    background: #9fb0ba;
    border-radius: 999px;
}
.line-map-device strong,
.line-map-device small {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 10px;
}
.line-map-device strong {
    font-size: 12px;
}
.line-map-device small {
    color: rgba(255,255,255,.72);
    font-size: 11px;
}
.line-map-remove {
    position: absolute;
    right: 6px;
    top: 6px;
    z-index: 4;
    min-width: 38px;
    height: 24px;
    padding: 0 8px;
    color: #ffffff;
    background: rgba(23, 32, 39, 0.70);
    border: 1px solid rgba(255,255,255,0.22);
    border-radius: 999px;
    opacity: 0;
    transform: translateY(-3px);
    transition: opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
    cursor: pointer;
    font-size: 11px;
    font-weight: 700;
}
.line-map-device:hover .line-map-remove,
.line-map-remove:focus-visible {
    opacity: 1;
    transform: translateY(0);
}
.line-map-remove:hover {
    background: rgba(137, 45, 45, 0.88);
}
.line-map-device.saving {
    opacity: .62;
    pointer-events: none;
}
.line-map-cart {
    color: #33240a;
    background: linear-gradient(180deg, #e2ba5f, #c8912e);
}
.line-map-cart::before {
    background: #765115;
}
.line-map-cart small {
    color: rgba(51,36,10,.72);
}
.line-device-ghost {
    z-index: 8;
    opacity: .88;
    pointer-events: none;
    box-shadow: 0 18px 42px rgba(38, 50, 58, .28);
}
.line-device-pool-dock {
    position: absolute;
    left: 28px;
    bottom: 26px;
    z-index: 18;
    max-width: min(760px, calc(100% - 56px));
    pointer-events: none;
}
.line-device-pool-dock.collapsed {
    max-width: none;
}
.line-device-pool-tab {
    pointer-events: auto;
    min-height: 38px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: #ffffff;
    background: #245c7a;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 999px;
    box-shadow: 0 12px 28px rgba(38, 50, 58, .20);
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
}
.line-device-pool-dock:not(.collapsed) .line-device-pool-title {
    cursor: move;
    touch-action: none;
}
.line-device-pool-dock.collapsed .line-device-pool-tab {
    cursor: move;
    touch-action: none;
}
.line-device-pool-grip {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    opacity: .62;
    background:
        radial-gradient(currentColor 1px, transparent 1.5px) 0 0 / 6px 6px,
        radial-gradient(currentColor 1px, transparent 1.5px) 3px 3px / 6px 6px;
}
.line-device-pool {
    pointer-events: auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    max-width: 100%;
    padding: 10px 12px;
    overflow: visible;
    background: rgba(255,255,255,.94);
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(38, 50, 58, .18);
    backdrop-filter: blur(10px);
}
.line-device-pool-title {
    min-width: 120px;
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr);
    gap: 2px;
    padding-right: 8px;
    border-right: 1px solid rgba(25, 33, 38, 0.08);
}
.line-device-pool-title .line-device-pool-grip {
    grid-row: 1 / 3;
    align-self: center;
    color: #66727c;
}
.line-device-pool-title strong {
    color: #172027;
    font-size: 13px;
}
.line-device-pool-title span {
    color: #6b737a;
    font-size: 11px;
    white-space: nowrap;
}
.line-device-pool-chip {
    min-width: 118px;
    max-width: 150px;
    min-height: 46px;
    display: grid;
    gap: 2px;
    align-content: center;
    padding: 7px 10px;
    color: #34434c;
    background: #eef2f4;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 8px;
    cursor: grab;
    text-align: left;
    touch-action: none;
}
.line-device-pool-close {
    min-width: 52px;
    height: 34px;
    padding: 0 10px;
    color: #50616c;
    background: #edf1f3;
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
}
.line-device-pool-close:hover {
    color: #1e4f6b;
    background: #ffffff;
}
.line-device-pool-chip.cart {
    color: #5f4311;
    background: #f4e5bd;
    border-color: rgba(152, 107, 36, 0.25);
}
.line-device-pool-chip.saving {
    opacity: .58;
    pointer-events: none;
}
.line-device-pool-chip strong,
.line-device-pool-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.line-device-pool-chip strong {
    font-size: 12px;
}
.line-device-pool-chip span {
    color: currentColor;
    opacity: .72;
    font-size: 11px;
}
.line-preview-empty-state {
    position: absolute;
    left: 50%;
    bottom: 26px;
    transform: translateX(-50%);
    padding: 8px 12px;
    color: #596873;
    background: rgba(255,255,255,.82);
    border: 1px solid rgba(25, 33, 38, 0.08);
    border-radius: 8px;
    font-size: 12px;
    font-weight: 600;
}

.composer-tab {
    height: calc(100vh - 94px);
    padding: 0;
    display: grid;
    grid-template-columns: minmax(300px, 340px) minmax(0, 1fr);
    overflow: hidden;
    background: #eef0f1;
}
.composer-tab.preview-wide {
    grid-template-columns: minmax(0, 1fr);
}
.composer-tab.preview-wide .composer-editor {
    display: none;
}

.composer-editor {
    min-width: 0;
    overflow-y: auto;
    padding: 18px;
    background: #fbfbfd;
    border-right: 1px solid rgba(0, 0, 0, 0.08);
}

.composer-section {
    padding: 16px;
    margin-bottom: 12px;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.025);
}

.composer-section h2 { font-size: 22px; }
.composer-section h3 { margin: 0 0 12px; font-size: 15px; color: #1d1d1f; }
.composer-section .desc { margin-bottom: 16px; line-height: 1.5; }
.native-live-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 14px;
}
.native-live-help {
    display: block;
    color: #6e6e73;
    font-size: 11px;
    line-height: 1.5;
}

.composer-stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.composer-stat-grid div {
    padding: 10px;
    background: #f5f5f7;
    border-radius: 8px;
}

.composer-stat-grid span {
    display: block;
    color: #86868b;
    font-size: 12px;
}

.composer-stat-grid strong {
    display: block;
    margin-top: 4px;
    color: #1d1d1f;
    font-size: 18px;
}

.composer-select { width: 100%; margin-bottom: 12px; }
.composer-line-list, .composer-device-list { display: grid; gap: 8px; }
.composer-action-row {
    display: grid;
    gap: 8px;
    margin-top: 10px;
}

.line-pill, .device-pill {
    width: 100%;
    border: 1px solid rgba(0, 0, 0, 0.08);
    background: #f7f7f9;
    color: #1d1d1f;
    border-radius: 10px;
    padding: 10px 12px;
    cursor: pointer;
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    transition: all 0.18s ease;
}

.line-pill:hover, .device-pill:hover { background: #ffffff; border-color: rgba(0, 113, 227, 0.28); }
.line-pill.active, .device-pill.active {
    background: rgba(0, 113, 227, 0.08);
    border-color: rgba(0, 113, 227, 0.45);
    box-shadow: inset 3px 0 0 #0071e3;
}

.line-pill em, .device-pill span {
    color: #86868b;
    font-style: normal;
    font-size: 12px;
}

.device-pill {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px;
}

.device-pill strong {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}

.device-pill-cancel {
    display: inline-grid;
    width: 18px;
    height: 18px;
    margin-left: 6px;
    place-items: center;
    color: #ffffff;
    background: #0071e3;
    border-radius: 50%;
    font-size: 14px;
    font-style: normal;
    line-height: 1;
    vertical-align: -2px;
}

.composer-empty {
    padding: 14px;
    color: #86868b;
    background: #f5f5f7;
    border-radius: 8px;
    text-align: center;
}

.composer-form {
    display: grid;
    gap: 12px;
}

.composer-form label {
    display: grid;
    gap: 7px;
    min-width: 0;
    color: #515154;
    font-size: 13px;
    font-weight: 500;
}

.composer-form .input {
    width: 100%;
    min-width: 0;
}

.composer-grid-3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(58px, 1fr));
    gap: 8px;
}

.composer-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
}

.composer-grid-3 .input {
    padding-left: 9px;
    padding-right: 9px;
}

.composer-rotation-control {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: #f7f8fa;
}

.composer-control-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: #515154;
    font-size: 13px;
    font-weight: 600;
}

.composer-control-header strong {
    color: #1d1d1f;
    font-size: 16px;
}

.composer-rotation-presets,
.composer-rotation-nudges {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 6px;
}

.composer-rotation-presets .btn,
.composer-rotation-nudges .btn {
    min-width: 0;
    padding: 8px 6px;
}

.composer-rotation-presets .btn.active {
    color: #ffffff;
    background: #0071e3;
}

.composer-mirror-control {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 10px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 10px;
    background: #f7f8fa;
}
.composer-mirror-control strong {
    display: block;
    color: #1d1d1f;
    font-size: 13px;
}
.composer-mirror-control span {
    display: block;
    margin-top: 3px;
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
}
.composer-mirror-control .btn.active {
    color: #ffffff;
    background: #1f7a4d;
}

.nudge-pad {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
}

.composer-save { width: 100%; padding: 11px 16px; }

.composer-preview {
    position: relative;
    min-width: 0;
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) 38px;
    background: #15191b;
}

.composer-preview-floating-host {
    position: absolute;
    inset: 0;
    z-index: 24;
    overflow: hidden;
    pointer-events: none;
}

.composer-device-layout-float {
    position: absolute;
    z-index: 1;
    display: flex;
    flex-direction: column;
    width: min(326px, calc(100% - 36px));
    max-height: calc(100% - 122px);
    margin: 0;
    padding: 0;
    gap: 0;
    overflow: hidden;
    pointer-events: auto;
    background: rgba(255, 255, 255, .96);
    border: 1px solid rgba(0, 0, 0, .12);
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, .24), 0 2px 8px rgba(0, 0, 0, .1);
    backdrop-filter: blur(20px) saturate(1.15);
}

.composer-device-layout-float-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 54px;
    padding: 9px 10px 9px 15px;
    border-bottom: 1px solid rgba(0, 0, 0, .08);
    cursor: grab;
    touch-action: none;
    user-select: none;
}

.composer-device-layout-float-header:active { cursor: grabbing; }
.composer-device-layout-float-header span {
    display: block;
    color: #86868b;
    font-size: 11px;
}
.composer-device-layout-float-header strong {
    display: block;
    max-width: 230px;
    margin-top: 1px;
    overflow: hidden;
    color: #1d1d1f;
    font-size: 14px;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.composer-device-layout-float-header button {
    display: grid;
    width: 30px;
    height: 30px;
    padding: 0;
    place-items: center;
    color: #515154;
    background: #ececf0;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
}
.composer-device-layout-float-header button:hover { color: #ffffff; background: #ff453a; }
.composer-device-layout-float-body {
    display: grid;
    min-height: 0;
    padding: 14px;
    gap: 12px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
}

.composer-preview-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 58px;
    padding: 8px 18px;
    background: #ffffff;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

.composer-preview-toolbar strong {
    display: block;
    color: #1d1d1f;
    font-size: 15px;
}

.composer-preview-toolbar span {
    color: #86868b;
    font-size: 12px;
}

.preview-mode-buttons {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.preview-mode-buttons .btn.active {
    background: #1d1d1f;
    color: #ffffff;
}
.preview-camera-buttons {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.btn-icon {
    width: 30px;
    padding-left: 0;
    padding-right: 0;
    text-align: center;
}
.preview-wide-btn {
    min-width: 76px;
}

.composer-preview-stage {
    position: relative;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: #9ba29f;
    touch-action: none;
}

.composer-preview-stage canvas {
    display: block;
}

.composer-preview-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 18px;
    color: #b7bebc;
    background: #171b1d;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 12px;
}

.composer-preview-stage :deep(.furnace-label),
.composer-preview-stage :deep(.factory-guide-label) {
    color: #f4f7f6;
    background: rgba(18, 22, 24, .84);
    border: 1px solid rgba(242, 184, 91, .35);
    box-shadow: 0 8px 18px rgba(0,0,0,.32);
    pointer-events: none;
    font-size: 12px;
}

.composer-preview-stage :deep(.furnace-label) {
    min-width: 132px;
    padding: 8px 10px;
}

.composer-preview-stage :deep(.factory-guide-label) {
    min-width: 108px;
    padding: 7px 10px 8px;
    border-left: 3px solid #e0ad4f;
}

/* 表单元素 */
.input {
    border: 1px solid rgba(0, 0, 0, 0.15); padding: 8px 12px; border-radius: 8px; font-size: 14px; outline: none;
    transition: all 0.2s cubic-bezier(0.25, 0.8, 0.25, 1); background: #fbfbfd; color: #1d1d1f;
}
.input::placeholder { color: #86868b; }
.input:hover { border-color: rgba(0, 0, 0, 0.3); }
.input:focus {
    border-color: #0071e3; background: #ffffff;
    box-shadow: 0 0 0 4px rgba(0, 113, 227, 0.15);
}
.input:disabled {
    background: #e8e8ed; color: #86868b; border-color: rgba(0, 0, 0, 0.05);
    cursor: not-allowed;
}
.input-sm { padding: 5px 10px; font-size: 13px; border-radius: 6px; }

.form-row { display: flex; gap: 12px; align-items: center; margin-bottom: 28px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 24px 0; }
.form-grid label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #515154; font-weight: 500; }
.wide-form-section { grid-column: 1 / -1; }
.form-section {
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #fbfbfd;
    padding: 16px;
}
.form-section-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
    margin-bottom: 14px;
}
.form-section-header strong { color: #1d1d1f; font-size: 14px; }
.form-section-header span { color: #86868b; font-size: 12px; line-height: 1.5; }
.inline-check {
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center;
    gap: 8px !important;
    margin-bottom: 12px;
}
.compact-form-grid {
    margin: 12px 0 0;
    gap: 14px;
}

.settings-form { max-width: 700px; display: flex; flex-direction: column; gap: 28px; }
.settings-form-wide { max-width: 1080px; }
.settings-form label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #515154; font-weight: 500; }

/* 按钮 */
.btn {
    padding: 8px 16px; border: none; border-radius: 8px;
    background: #e8e8ed; color: #0066cc; cursor: pointer; font-size: 14px;
    font-weight: 500; transition: color 160ms ease, background-color 160ms ease, box-shadow 180ms ease, transform 140ms ease;
}
.btn:not(:disabled):hover { background: #d8d8dd; color: #0055b3; transform: translateY(-1px); }
.btn:not(:disabled):active { transform: translateY(0) scale(0.98); }
.btn:disabled { background: #f5f5f7; color: #a1a1a6; cursor: not-allowed; }
.btn-primary { background: #0071e3; color: #ffffff; }
.btn-primary:not(:disabled):hover { background: #0077ed; color: #ffffff; }
.btn-danger { background: rgba(255, 59, 48, 0.1); color: #ff3b30; }
.btn-danger:not(:disabled):hover { background: rgba(255, 59, 48, 0.2); color: #ff3b30; }
.btn-sm { padding: 5px 12px; font-size: 12px; border-radius: 6px; }

button:enabled:active {
    filter: brightness(0.96);
}

/* 表格 */
.data-table { width: 100%; border-collapse: collapse; margin-bottom: 28px; font-size: 14px; }
.data-table th {
    text-align: left; padding: 14px 18px; background: #f5f5f7;
    border-bottom: 1px solid rgba(0, 0, 0, 0.05); color: #515154; font-weight: 600; font-size: 13px;
}
.data-table td {
    padding: 16px 18px; border-bottom: 1px solid rgba(0, 0, 0, 0.04); color: #1d1d1f;
    vertical-align: top;
}
.points-table td {
    vertical-align: middle;
}
.data-table tbody tr { transition: background-color 0.2s ease; }
.data-table tbody tr:hover { background: rgba(0, 0, 0, 0.015); }
.data-table code {
    color: #b01a68; background: rgba(176, 26, 104, 0.06); border: none;
    padding: 2px 8px; border-radius: 4px; font-family: SFMono-Regular, Consolas, Monaco, monospace; font-size: 12px;
}

.table-scroll {
    width: 100%; max-height: clamp(320px, calc(100dvh - 360px), 720px); overflow: auto; border-radius: 12px;
    border: 1px solid rgba(0, 0, 0, 0.06); background: #ffffff; margin-bottom: 20px;
    overscroll-behavior: contain; scrollbar-gutter: stable both-edges;
}
.table-scroll .data-table { margin-bottom: 0; }
.table-scroll .data-table thead th {
    position: sticky;
    top: 0;
    z-index: 3;
    box-shadow: 0 1px 0 rgba(0, 0, 0, 0.05);
}
.table-scroll::-webkit-scrollbar {
    height: 12px;
    width: 12px;
}
.table-scroll::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.04);
    border-radius: 8px;
}
.table-scroll::-webkit-scrollbar-thumb {
    background: rgba(120, 120, 128, 0.45);
    border-radius: 8px;
    border: 2px solid transparent;
    background-clip: content-box;
}
.table-scroll::-webkit-scrollbar-thumb:hover {
    background: #007aff;
    background-clip: content-box;
}
.point-toolbar {
    display: flex;
    justify-content: flex-end;
    margin: 0 0 10px;
}
.points-table { min-width: 960px; }
.points-table.points-table-advanced { min-width: 1420px; }
.points-table td { padding: 10px 6px; }
.points-table .input-sm { width: 100%; }
.points-table .number-input { width: 90px; }
.points-table .bit-input { width: 64px; }
.points-table .sample-input { width: 110px; }
.points-table .access-input { width: 86px; }
.points-table .point-name-input { min-width: 150px; }
.points-table .point-usage-input { min-width: 88px; width: 95px; }
.points-table .point-datatype-select { min-width: 128px; width: 135px; }
.points-table .plc-address-input { min-width: 110px; width: 120px; }
.plc-address-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 100%;
}
.plc-address-wrap .plc-address-input.has-warning {
    border-color: #ff9500 !important;
    background-color: rgba(255, 149, 0, 0.05) !important;
    padding-right: 26px;
}
.plc-address-wrap .plc-address-input.has-duplicate {
    border-color: #ff3b30 !important;
    background-color: rgba(255, 59, 48, 0.05) !important;
    padding-right: 26px;
}
.plc-warning-icon {
    position: absolute;
    right: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: help;
    user-select: none;
    line-height: 1;
}
.points-table .expression-input { min-width: 150px; }
.points-table .unit-input { width: 80px; }
.points-table .alarm-text-input { min-width: 180px; }
.points-table .device-point-select { min-width: 180px; }
.points-pagination-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding: 12px 16px;
    margin-top: 10px;
    background: #f8f9fa;
    border: 1px solid #e5e5ea;
    border-radius: 10px;
    font-size: 13px;
    color: #48484a;
}
.pagination-info {
    display: flex;
    align-items: center;
    gap: 4px;
}
.pagination-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
}
.page-size-selector {
    display: flex;
    align-items: center;
    gap: 6px;
}
.page-size-select {
    width: 110px;
    height: 30px;
    padding: 2px 8px;
    font-size: 13px;
}
.pagination-nav-btns {
    display: flex;
    align-items: center;
    gap: 4px;
}
.pagination-btn {
    min-width: 30px;
    height: 30px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    border-radius: 6px;
    border: 1px solid #d1d1d6;
    background: #ffffff;
    color: #1d1d1f;
    cursor: pointer;
    transition: all 0.15s ease;
}
.pagination-btn:hover:not(:disabled) {
    background: #f2f2f7;
    border-color: #c7c7cc;
}
.pagination-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}
.pagination-btn.page-num-btn.active {
    background: #0071e3;
    color: #ffffff;
    border-color: #0071e3;
    font-weight: 600;
}
.voice-config-button { min-width: 70px; white-space: nowrap; }
.voice-config-button.configured {
    color: #116a38;
    border-color: rgba(52, 199, 89, 0.34);
    background: rgba(52, 199, 89, 0.10);
}
.voice-config-modal { width: min(1040px, calc(100vw - 48px)); }
.voice-modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 16px;
}
.voice-modal-header h3 { margin-bottom: 6px; }
.voice-modal-header p { margin: 0; color: #6e6e73; font-size: 13px; }
.voice-config-help {
    padding: 12px 14px;
    margin-bottom: 16px;
    color: #515154;
    background: #f5f7fa;
    border: 1px solid rgba(0, 113, 227, 0.12);
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.7;
}
.voice-config-help code { color: #7d2358; }
.voice-empty-state {
    padding: 28px;
    margin-bottom: 16px;
    text-align: center;
    color: #86868b;
    border: 1px dashed rgba(0, 0, 0, 0.16);
    border-radius: 12px;
}
.voice-rule-card {
    padding: 18px;
    margin-bottom: 16px;
    background: #fbfbfd;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 14px;
}
.voice-rule-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    margin-bottom: 14px;
}
.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    width: 100%;
}
.modal-header h3 {
    margin: 0 !important;
}
.modal-close-icon-btn {
    position: absolute;
    top: 20px;
    right: 20px;
    width: 32px;
    height: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: none;
    background: rgba(0, 0, 0, 0.05);
    color: #86868b;
    cursor: pointer;
    transition: all 0.18s ease;
}
.modal-close-icon-btn:hover {
    background: rgba(0, 0, 0, 0.12);
    color: #1d1d1f;
    transform: scale(1.08);
}
.modal-close-icon-btn:active {
    transform: scale(0.95);
}
.rule-delete-icon-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: #ff3b30;
    background: rgba(255, 59, 48, 0.1);
    border: 1px solid rgba(255, 59, 48, 0.18);
    cursor: pointer;
    transition: all 0.18s ease;
}
.rule-delete-icon-btn:hover {
    background: #ff3b30;
    color: #ffffff;
    border-color: #ff3b30;
}
.voice-rule-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
}
.voice-rule-grid select,
.voice-rule-grid input {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    text-overflow: ellipsis;
}
.voice-rule-grid > label,
.voice-text-label {
    display: grid;
    gap: 6px;
    color: #515154;
    font-size: 12px;
}
.voice-startup-check {
    grid-column: span 2;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding-top: 14px;
    white-space: nowrap;
}
.voice-rule-text {
    width: 100%;
    min-height: 74px;
    margin-top: 6px;
    resize: vertical;
    line-height: 1.55;
}
.voice-file-row {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-top: 14px;
}
.voice-file-path {
    min-width: 0;
    display: grid;
    gap: 5px;
    color: #6e6e73;
    font-size: 12px;
}
.voice-file-path code {
    max-width: 520px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #515154;
}
.voice-rule-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.voice-modal-actions { justify-content: space-between; }
.muted-cell { color: #86868b; font-size: 12px; }
.alarm-config-card {
    margin-top: 18px;
    padding: 18px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
}
.alarm-config-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    text-align: left;
    cursor: pointer;
}
.alarm-config-card.open .alarm-config-header { margin-bottom: 14px; }
.alarm-config-header h3 { margin: 0 0 6px; font-size: 16px; color: #1d1d1f; }
.alarm-config-header p { margin: 0; color: #6e6e73; font-size: 13px; line-height: 1.6; }
.alarm-config-header-actions { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 9px; }
.alarm-config-count {
    white-space: nowrap;
    padding: 6px 10px;
    border-radius: 999px;
    background: #f5f5f7;
    color: #515154;
    font-size: 12px;
}
.collapse-chevron { width: 18px; height: 18px; fill: none; stroke: #6e6e73; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; transition: transform 180ms ease; }
.alarm-config-card.open .collapse-chevron,
.external-data-source-manager.open .collapse-chevron { transform: rotate(180deg); }
.section-collapse-enter-active,
.section-collapse-leave-active { transition: opacity 170ms ease, transform 170ms ease; }
.section-collapse-enter-from,
.section-collapse-leave-to { opacity: 0; transform: translateY(-6px); }
.alarm-record-status {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-bottom: 14px;
}
.alarm-record-status > div {
    padding: 10px 12px;
    border-radius: 8px;
    background: #f5f5f7;
    color: #6e6e73;
    display: flex;
    justify-content: space-between;
    font-size: 13px;
}
.alarm-record-status > div.configured {
    background: #eef7f1;
    color: #1f7a3a;
}
.alarm-import-layout {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) 260px;
    gap: 14px;
}
.alarm-textarea {
    min-height: 170px;
    resize: vertical;
    line-height: 1.6;
    font-family: Consolas, "Microsoft YaHei", monospace;
}
.alarm-import-side {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.alarm-preview {
    flex: 1;
    min-height: 80px;
    padding: 10px 12px;
    border-radius: 8px;
    background: #f5f5f7;
    color: #515154;
    font-size: 12px;
    line-height: 1.7;
    overflow: auto;
}
.plc-status-table { min-width: 980px; margin-bottom: 0; }
.point-monitor-toolbar {
    align-items: flex-end;
    gap: 12px;
    margin-bottom: 18px;
}
.inline-toggle {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 38px;
    padding: 0 12px;
    color: #515154;
    font-size: 13px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    background: #fbfbfd;
}
.point-monitor-status {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 18px;
}
.point-monitor-status > div {
    min-width: 0;
    display: grid;
    gap: 8px;
    padding: 14px;
    background: #fbfbfd;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 10px;
}
.point-monitor-status strong {
    min-width: 0;
    color: #1d1d1f;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.status-label {
    color: #86868b;
    font-size: 12px;
}
.inline-error {
    margin-bottom: 14px;
    padding: 10px 12px;
    color: #9f1d17;
    background: rgba(255, 59, 48, 0.08);
    border: 1px solid rgba(255, 59, 48, 0.16);
    border-radius: 8px;
    font-size: 13px;
    white-space: pre-line;
}
.realtime-points-table { min-width: 1180px; margin-bottom: 0; }
.point-value-cell {
    color: #111827;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}
.point-quality-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 52px;
    min-height: 24px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    border: 1px solid rgba(0, 0, 0, 0.06);
}
.quality-good { color: #1b6b3a; background: rgba(52, 199, 89, 0.12); border-color: rgba(52, 199, 89, 0.22); }
.quality-stale { color: #7a4b00; background: rgba(255, 204, 0, 0.16); border-color: rgba(255, 204, 0, 0.28); }
.quality-bad { color: #9f1d17; background: rgba(255, 59, 48, 0.12); border-color: rgba(255, 59, 48, 0.24); }
.model-name-cell {
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    gap: 4px;
}
.model-name-cell strong {
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
}
.model-name-cell small {
    color: #86868b;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 11px;
    line-height: 1.4;
}
.plc-status-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 64px;
    min-height: 24px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    color: #515154;
    background: #e8e8ed;
    border: 1px solid rgba(0, 0, 0, 0.06);
}
.plc-status-pill + small {
    display: block;
    margin-top: 6px;
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
    max-width: 260px;
}
.plc-meta-lines {
    display: grid;
    gap: 2px;
    margin-top: 6px;
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
}
.plc-connected { color: #1b6b3a; background: rgba(52, 199, 89, 0.12); border-color: rgba(52, 199, 89, 0.24); }
.plc-connecting, .plc-idle { color: #6c5800; background: rgba(255, 204, 0, 0.14); border-color: rgba(255, 204, 0, 0.24); }
.plc-retrying, .plc-no_points, .plc-unconfigured { color: #8a4b0f; background: rgba(255, 149, 0, 0.13); border-color: rgba(255, 149, 0, 0.24); }
.plc-error, .plc-unsupported { color: #9f1d17; background: rgba(255, 59, 48, 0.12); border-color: rgba(255, 59, 48, 0.24); }
.plc-disabled, .plc-stopped { color: #6e6e73; background: #f5f5f7; }
.widget-layout-editor {
    display: block;
}
.widget-layout-form {
    min-width: 0;
}
.widget-layout-row {
    cursor: pointer;
}
.widget-layout-row.active {
    background: rgba(0, 113, 227, 0.08);
    box-shadow: inset 3px 0 0 #0071e3;
}
.widget-preview-popover {
    position: fixed;
    width: 560px;
    max-width: calc(100vw - 32px);
    overflow: hidden;
    border: 1px solid rgba(66, 165, 245, 0.32);
    border-radius: 14px;
    background: #10161b;
    box-shadow: 0 22px 60px rgba(8, 15, 20, 0.36);
    z-index: 9999;
    pointer-events: none;
}
.widget-live-preview {
    position: sticky;
    top: 16px;
    min-width: 0;
    overflow: hidden;
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 12px;
    background: #10161b;
    box-shadow: 0 18px 42px rgba(25, 33, 38, 0.16);
}
.widget-live-preview-header,
.widget-live-preview-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    color: #dfe7ec;
    background: #151d23;
    border-bottom: 1px solid rgba(255,255,255,0.08);
}
.widget-live-preview-header strong {
    display: block;
    font-size: 14px;
}
.widget-live-preview-header span,
.widget-live-preview-header small,
.widget-live-preview-footer span {
    color: #9eabb5;
    font-size: 12px;
}
.widget-live-preview-footer {
    border-top: 1px solid rgba(255,255,255,0.08);
    border-bottom: 0;
}
.widget-hover-preview-stage {
    position: relative;
    height: 310px;
    overflow: hidden;
    background:
        linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        radial-gradient(circle at 50% 34%, rgba(80, 115, 128, 0.26), transparent 48%),
        #0f151a;
}
.widget-hover-preview-canvas {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
    transition: transform .16s ease;
}
.widget-live-preview-stage {
    position: relative;
    aspect-ratio: 16 / 9;
    min-height: 360px;
    overflow: hidden;
    background:
        linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px) 0 0 / calc(100% / 24) calc(100% / 12),
        radial-gradient(circle at 50% 34%, rgba(80, 115, 128, 0.26), transparent 48%),
        #0f151a;
}
.widget-preview-slot {
    position: absolute;
    min-width: 90px;
    min-height: 56px;
    padding: 5px;
    overflow: hidden;
    border: 1px solid rgba(120, 176, 205, 0.18);
    border-radius: 8px;
    cursor: pointer;
    transition: border-color .15s ease, box-shadow .15s ease, opacity .15s ease;
}
.widget-preview-slot.active {
    border-color: #42a5f5;
    box-shadow: 0 0 0 2px rgba(66, 165, 245, .32), 0 12px 30px rgba(0,0,0,.28);
    z-index: 5;
}
.widget-preview-slot.hidden {
    opacity: .45;
    border-style: dashed;
}
.widget-preview-placeholder {
    width: 100%;
    height: 100%;
    display: grid;
    align-content: center;
    gap: 5px;
    padding: 10px;
    color: #dfe7ec;
    background: rgba(21, 29, 35, .88);
    border-radius: 6px;
}
.widget-preview-placeholder strong,
.widget-preview-placeholder span,
.widget-preview-placeholder small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.widget-preview-placeholder strong { font-size: 13px; }
.widget-preview-placeholder span { color: #9fd3f2; font-size: 12px; }
.widget-preview-placeholder small { color: #9eabb5; font-size: 11px; }
.widget-preview-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: #9eabb5;
    font-size: 13px;
}
.widget-preview-slot :deep(.widget-shell) {
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px;
    color: #e8ecef;
    background: rgba(22, 29, 35, .9);
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 7px;
}
.widget-preview-slot :deep(.widget-title) {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
    color: #e8ecef;
    font-size: 12px;
    font-weight: 700;
}
.widget-preview-slot :deep(.widget-title i) {
    width: 3px;
    height: 13px;
    border-radius: 999px;
    background: #42a5f5;
}
.widget-preview-slot :deep(.metrics-layout) {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(96px, 38%) minmax(0, 1fr);
    gap: 8px;
}
.widget-preview-slot :deep(.widget-chart) {
    min-height: 0;
    height: 100%;
}
.widget-preview-slot :deep(.metric-list),
.widget-preview-slot :deep(.alarm-list) {
    min-height: 0;
    overflow: hidden;
}
.widget-preview-slot :deep(.metric-row) {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 0;
    color: #aeb7bf;
    font-size: 11px;
}
.widget-preview-slot :deep(.metric-row strong) {
    color: #fff;
}
.widget-preview-slot :deep(.alarm-list) {
    margin: 0;
    padding: 0;
    list-style: none;
}
.widget-preview-slot :deep(.alarm-list li) {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr) 52px;
    gap: 6px;
    align-items: center;
    min-height: 26px;
    color: #cbd5dc;
    font-size: 11px;
}
.widget-preview-slot :deep(.alarm-txt) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.widget-preview-slot :deep(.rank),
.widget-preview-slot :deep(.tag) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 20px;
    border-radius: 999px;
    background: rgba(255,255,255,.08);
}
.widget-preview-slot :deep(.tag) {
    font-size: 10px;
}
.widget-preview-slot :deep(.critical) { color: #ff8a80; }
.widget-preview-slot :deep(.warning) { color: #ffd180; }
.widget-preview-slot :deep(.info) { color: #9ad4f5; }
.widget-preview-slot :deep(.marquee-content-wrap) {
    flex: 1;
    min-height: 0;
    overflow: hidden;
}
.widget-preview-slot :deep(.marquee-content) {
    display: flex;
    height: 100%;
    align-items: center;
    white-space: nowrap;
    animation: marqueeRoll 30s linear infinite;
}
.widget-preview-slot :deep(.marquee-item) {
    margin-right: 32px;
    color: #d2d8dc;
    font-size: 12px;
}
.widget-preview-slot :deep(.text-widget-body) {
    flex: 1;
    display: grid;
    align-content: center;
    gap: 6px;
    color: #e8ecef;
    font-size: 14px;
    line-height: 1.45;
}
.widget-preview-slot :deep(.text-widget-body p) {
    margin: 0;
}
.widget-device-detail-preview,
.widget-device-label-preview,
.widget-line-card-preview {
    position: absolute;
    inset: 14px;
    display: grid;
    place-items: center;
}
.widget-device-card {
    width: min(500px, 100%);
    min-height: 246px;
    padding: 16px;
    border: 1px solid rgba(66, 165, 245, 0.24);
    border-radius: 14px;
    color: #e8ecef;
    background:
        linear-gradient(135deg, rgba(66,165,245,.13), transparent 32%),
        rgba(17, 25, 31, .94);
    box-shadow: 0 18px 40px rgba(0,0,0,.28);
}
.device-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
}
.device-card-header strong {
    font-size: 16px;
}
.device-card-header span {
    color: #9fd3f2;
    font-size: 12px;
}
.diagnostic-preview-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}
.diagnostic-preview-group {
    min-height: 84px;
    padding: 10px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius: 10px;
    background: rgba(255,255,255,.035);
}
.diagnostic-preview-group > strong {
    display: block;
    margin-bottom: 8px;
    color: #fff;
    font-size: 12px;
}
.diagnostic-preview-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 3px 0;
    color: #aeb7bf;
    font-size: 11px;
}
.diagnostic-preview-row b {
    color: #f6fbff;
    font-weight: 700;
}
.diagnostic-preview-row small {
    color: #91a3af;
    font-weight: 500;
}
.widget-device-label-preview {
    place-items: center;
    color: #dfe7ec;
}
.mock-device-block {
    width: 210px;
    height: 118px;
    border: 1px solid rgba(255,255,255,.14);
    border-radius: 12px;
    background: linear-gradient(135deg, #343d42, #151a1d);
    box-shadow: inset 0 -24px 0 rgba(0,0,0,.28), 0 20px 45px rgba(0,0,0,.26);
}
.mock-device-label {
    position: absolute;
    top: 32px;
    left: 50%;
    display: grid;
    gap: 4px;
    min-width: 150px;
    padding: 10px 12px;
    border: 1px solid rgba(240, 179, 90, .48);
    border-radius: 8px;
    color: #f7fbff;
    background: rgba(20, 25, 29, .88);
    transform: translateX(-50%);
}
.mock-device-label strong {
    color: var(--device-label-title-color, #f2b85b);
}
.mock-device-label span {
    color: var(--device-label-text-color, #b7c4cc);
    font-size: 12px;
}
.mock-device-label span::first-letter {
    color: var(--device-label-value-color, #fff);
}
.widget-device-label-preview > small {
    position: absolute;
    bottom: 16px;
    color: #9eabb5;
}
.widget-line-card-preview {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    place-items: stretch;
}
.mock-line-card {
    display: grid;
    align-content: center;
    gap: 8px;
    padding: 14px;
    border: 1px solid rgba(66, 165, 245, .22);
    border-radius: 12px;
    color: #e8ecef;
    background: rgba(18, 26, 32, .9);
}
.mock-line-card strong {
    color: #fff;
}
.mock-line-card span {
    color: #aeb7bf;
    font-size: 12px;
}
@keyframes marqueeRoll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
.platform-table { min-width: 1920px; }
.widget-layout-table {
    border-collapse: separate;
    border-spacing: 0;
}
.widget-layout-table th:last-child,
.widget-layout-table .widget-action-cell {
    position: sticky;
    right: 0;
    width: 104px;
    min-width: 104px;
    text-align: center;
    background: #ffffff;
    box-shadow: -10px 0 18px rgba(0, 0, 0, 0.06);
    z-index: 2;
}
.widget-layout-table th:last-child {
    background: #f5f5f7;
    z-index: 3;
}
.widget-layout-table tbody tr:hover .widget-action-cell {
    background: #fbfbfd;
}
.widget-action-cell .btn {
    display: block;
    width: 54px;
    margin: 0 auto;
}
.widget-action-cell .btn + .btn {
    margin-top: 8px;
}
.coord-input { width: 70px; }
.widget-editor-cell {
    min-width: 320px;
    vertical-align: top;
}
.widget-default-btn {
    margin-bottom: 8px;
}
.widget-json {
    width: 260px; height: 72px; font-family: SFMono-Regular, Consolas, Monaco, monospace; font-size: 12px;
    resize: vertical; border-radius: 6px; background: #f5f5f7; border: 1px solid rgba(0,0,0,0.08);
}
.widget-json-large {
    width: 300px;
    min-height: 150px;
    line-height: 1.45;
}
.widget-create-row {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start;
    padding: 20px; margin-top: 20px; border: 1px dashed rgba(0, 0, 0, 0.15);
    background: #fbfbfd; border-radius: 12px;
}

.device-group { margin-bottom: 44px; }
.group-title { color: #1d1d1f; font-size: 17px; margin-bottom: 18px; font-weight: 600; padding-left: 12px; border-left: 4px solid #0071e3; }

/* 弹窗 */
.modal-overlay {
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0, 0, 0, 0.3);
    display: flex; justify-content: center; align-items: center; z-index: 1000;
}
.modal-box {
    background: rgba(255, 255, 255, 0.96);
    border-radius: 20px; box-shadow: 0 30px 70px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.04);
    padding: 32px; width: min(760px, calc(100vw - 48px)); max-height: 85vh; overflow-y: auto;
    border: 1px solid rgba(255, 255, 255, 0.4);
    scrollbar-width: thin;
    scrollbar-color: rgba(120, 120, 128, 0.3) transparent;
}
.modal-box::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}
.modal-box::-webkit-scrollbar-track {
    background: transparent;
}
.modal-box::-webkit-scrollbar-thumb {
    background: rgba(120, 120, 128, 0.3);
    border-radius: 6px;
}
.modal-box::-webkit-scrollbar-thumb:hover {
    background: rgba(120, 120, 128, 0.55);
}
.modal-fade-enter-active,
.modal-fade-leave-active {
    transition: opacity 180ms ease, backdrop-filter 180ms ease;
}
.modal-fade-enter-active .modal-box,
.modal-fade-leave-active .modal-box {
    transition: opacity 180ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.modal-fade-enter-from,
.modal-fade-leave-to {
    opacity: 0;
    backdrop-filter: blur(0);
}
.modal-fade-enter-from .modal-box,
.modal-fade-leave-to .modal-box {
    opacity: 0;
    transform: translateY(18px) scale(0.96);
}
.modal-box h3 { color: #1d1d1f; margin: 0 0 24px 0; font-size: 20px; font-weight: 600; }
.modal-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 32px; border-top: 1px solid rgba(0, 0, 0, 0.08); padding-top: 20px; }

.app-dialog-overlay {
    position: fixed;
    inset: 0;
    z-index: 3000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(17, 24, 39, 0.28);
    backdrop-filter: blur(10px);
}
.app-dialog {
    width: min(440px, calc(100vw - 40px));
    display: grid;
    grid-template-columns: 4px 1fr;
    gap: 0 18px;
    padding: 20px;
    color: #1d1d1f;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 14px;
    box-shadow: 0 24px 70px rgba(17, 24, 39, 0.22), 0 2px 6px rgba(17, 24, 39, 0.08);
}
.dialog-fade-enter-active,
.dialog-fade-leave-active {
    transition: opacity 160ms ease, backdrop-filter 180ms ease;
}
.dialog-fade-enter-active .app-dialog,
.dialog-fade-leave-active .app-dialog {
    transition: opacity 160ms ease, transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
.dialog-fade-enter-from,
.dialog-fade-leave-to {
    opacity: 0;
    backdrop-filter: blur(0);
}
.dialog-fade-enter-from .app-dialog,
.dialog-fade-leave-to .app-dialog {
    opacity: 0;
    transform: translateY(12px) scale(0.97);
}
.app-dialog-mark {
    grid-row: 1 / span 2;
    width: 4px;
    border-radius: 999px;
    background: #0071e3;
}
.dialog-success .app-dialog-mark { background: #34c759; }
.dialog-warning .app-dialog-mark { background: #ff9500; }
.dialog-danger .app-dialog-mark { background: #ff3b30; }
.app-dialog-body h3 {
    margin: 0 0 8px;
    color: #1d1d1f;
    font-size: 17px;
    font-weight: 700;
}
.app-dialog-body p {
    margin: 0;
    color: #515154;
    font-size: 14px;
    line-height: 1.55;
    white-space: pre-line;
}
.app-dialog-details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 14px;
}
.app-dialog-details > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    padding: 9px 11px;
    background: #f5f5f7;
    border: 1px solid #e7e7ea;
    border-radius: 9px;
}
.app-dialog-details span { color: #6e6e73; font-size: 12px; }
.app-dialog-details strong { color: #1d1d1f; font-size: 13px; white-space: nowrap; }
.app-dialog-verification {
    display: grid;
    gap: 7px;
    margin-top: 16px;
    color: #515154;
    font-size: 12px;
}
.app-dialog-verification .input { width: 100%; }
.app-dialog-verification small { color: #86868b; font-size: 11px; }
.app-dialog-verification small strong { color: #1d1d1f; user-select: all; }
.dialog-danger .app-dialog-actions .btn-primary { border-color: #d92d20; background: #d92d20; }
.dialog-danger .app-dialog-actions .btn-primary:disabled { border-color: #d9d9dd; background: #d9d9dd; }
.app-dialog-actions {
    grid-column: 2;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
}

.upload-area {
    margin-bottom: 28px; padding: 32px; border: 2px dashed rgba(0, 0, 0, 0.1);
    border-radius: 16px; text-align: center; background: #fbfbfd;
    transition: border-color 0.25s ease;
}
.upload-area:hover { border-color: #0071e3; }
.model-library-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(360px, 420px);
    gap: 24px;
    align-items: start;
}
.model-library-main {
    min-width: 0;
}
.model-step-nav-shell .secondary-page-nav-item:disabled { color: #a1a1a6; background: rgba(248, 248, 250, .72); border-color: rgba(0, 0, 0, .035); box-shadow: none; cursor: not-allowed; opacity: .62; transform: none; }
.model-step-nav-shell .secondary-page-nav-item:disabled:hover { color: #a1a1a6; background: rgba(248, 248, 250, .72); border-color: rgba(0, 0, 0, .035); box-shadow: none; transform: none; }
.model-library-step-panel { animation: secondary-page-in 180ms cubic-bezier(.22, 1, .36, 1); }
.model-step-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; padding-bottom: 14px; border-bottom: 1px solid rgba(0, 0, 0, .07); }
.model-step-heading h3 { margin: 0; color: #1d1d1f; font-size: 17px; }
.model-step-heading p { margin: 5px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.model-step-heading > span { flex: 0 0 auto; padding: 5px 9px; color: #6e6e73; background: #f2f2f4; border-radius: 999px; font-size: 10px; }
.model-selection-actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; margin-top: 14px; padding: 12px; background: #f7f7f9; border: 1px solid rgba(0, 0, 0, .055); border-radius: 10px; }
.model-selection-actions > div { display: flex; min-width: 0; margin-right: auto; flex-direction: column; gap: 2px; }
.model-selection-actions span { color: #86868b; font-size: 10px; }
.model-selection-actions strong { overflow: hidden; color: #1d1d1f; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.model-library-layout .upload-area {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
}
.model-file-chip {
    color: #515154;
    background: #eef0f2;
    border-radius: 999px;
    padding: 6px 12px;
    font-size: 12px;
}
.model-import-form {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 14px;
    padding: 16px;
    margin-bottom: 24px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #fbfbfd;
}
.model-import-form label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 13px;
    color: #515154;
    font-weight: 500;
}
.model-metadata-field {
    grid-column: 1 / -1;
}
.model-metadata {
    min-height: 76px;
    resize: vertical;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 12px;
}
.model-import-actions {
    grid-column: 1 / -1;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}
.model-table tbody tr {
    cursor: pointer;
}
.model-table tbody tr.active {
    background: rgba(0, 113, 227, 0.08);
    box-shadow: inset 3px 0 0 #0071e3;
}
.asset-status-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 64px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 12px;
    color: #515154;
    background: #eef0f2;
}
.asset-status-review {
    color: #7a4b00;
    background: #fff0cc;
}
.asset-status-accepted {
    color: #11613a;
    background: #dff6ea;
}
.asset-status-released {
    color: #0b4f8a;
    background: #dceeff;
}
.model-asset-governance {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #ffffff;
}
.model-asset-governance.model-library-step-panel,
.model-binding-editor.model-library-step-panel { margin-top: 0; }
.model-governance-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.model-workflow-rail {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
}
.model-workflow-step {
    min-height: 64px;
    display: grid;
    grid-template-columns: 24px 1fr;
    gap: 2px 8px;
    align-items: center;
    padding: 8px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 8px;
    background: #f6f7f8;
}
.model-workflow-step strong {
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: #707074;
    background: #e5e7ea;
    font-size: 12px;
}
.model-workflow-step span {
    color: #1d1d1f;
    font-size: 13px;
    font-weight: 700;
}
.model-workflow-step small {
    grid-column: 2;
    min-width: 0;
    overflow: hidden;
    color: #86868b;
    font-size: 12px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.model-workflow-step.passed {
    border-color: rgba(17, 97, 58, 0.25);
    background: #f1faf5;
}
.model-workflow-step.passed strong {
    color: #ffffff;
    background: #1b7f4f;
}
.model-workflow-step.optional {
    border-color: rgba(240, 179, 90, 0.35);
    background: #fffaf0;
}
.model-stats-strip {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 14px;
}
.model-stats-strip span {
    min-height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px 8px;
    border-radius: 8px;
    background: #f5f6f7;
    color: #515154;
    font-size: 12px;
    white-space: nowrap;
}
.model-spec-form {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 14px;
}
.model-spec-form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #515154;
    font-size: 12px;
    font-weight: 500;
}
.model-spec-form .wide-form-section {
    grid-column: 1 / -1;
}
.model-optimization-panel {
    margin-bottom: 16px;
    padding: 14px;
    border: 1px solid rgba(0, 113, 227, 0.18);
    border-radius: 10px;
    background: linear-gradient(135deg, rgba(0, 113, 227, 0.055), rgba(255, 255, 255, 0.96));
}
.model-optimization-form {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-bottom: 8px;
}
.model-optimization-form .checkbox-line {
    min-height: 38px;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.78);
}
.model-optimization-estimate {
    margin: 0;
    color: #5e5e63;
    font-size: 12px;
    line-height: 1.55;
}
.model-acceptance-summary {
    margin: 4px 0 10px;
    color: #7a4b00;
    font-size: 13px;
    font-weight: 600;
}
.model-acceptance-summary.ready {
    color: #11613a;
}
.model-acceptance-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
}
.model-acceptance-item {
    min-height: 74px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px;
    border: 1px solid rgba(217, 96, 96, 0.35);
    border-radius: 8px;
    background: #fff7f7;
}
.model-acceptance-item.passed {
    border-color: rgba(17, 97, 58, 0.25);
    background: #f2fbf6;
}
.model-acceptance-item.warning {
    border-color: rgba(240, 179, 90, 0.35);
    background: #fffaf0;
}
.model-acceptance-item strong {
    color: #1d1d1f;
    font-size: 12px;
}
.model-acceptance-item span {
    color: #515154;
    font-size: 13px;
    font-weight: 600;
}
.model-acceptance-item small {
    color: #86868b;
    font-size: 12px;
    line-height: 1.35;
}
.model-release-history {
    margin-top: 14px;
}
.model-release-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: #515154;
    font-size: 13px;
}
.model-release-header strong {
    color: #1d1d1f;
    font-size: 14px;
}
.model-binding-editor {
    margin-top: 18px;
    padding: 18px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: #ffffff;
}
.model-binding-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 16px;
}
.model-binding-header h3 {
    margin: 0 0 5px;
    color: #1d1d1f;
    font-size: 16px;
}
.model-binding-header p {
    margin: 0;
    color: #68686d;
    font-size: 12px;
    line-height: 1.5;
}
.inspection-stage-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    padding: 10px;
    background: #f7f7f9;
    border: 1px solid rgba(0, 0, 0, .06);
    border-radius: 10px;
}
.inspection-stage-toolbar .inline-check { margin-right: auto; }
.inspection-stage-toolbar > button {
    min-height: 34px;
    padding: 0 13px;
    color: #515154;
    background: #fff;
    border: 1px solid #d9d9de;
    border-radius: 8px;
    cursor: pointer;
}
.inspection-stage-toolbar > button.active { color: #fff; background: #1d1d1f; border-color: #1d1d1f; }
.model-inspection-settings {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 14px;
}
.model-inspection-settings > label,
.inspection-config-card > label,
.inspection-camera-grid label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #515154;
    font-size: 12px;
}
.model-inspection-settings input[type="range"] { width: 100%; }
.inspection-config-card {
    min-width: 0;
    margin-bottom: 14px;
    padding: 14px;
    background: #fbfbfd;
    border: 1px solid rgba(0, 0, 0, .07);
    border-radius: 10px;
}
.inspection-node-picker { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.inspection-node-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
.inspection-node-chips > button { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 6px 8px; color: #344054; background: #fff; border: 1px solid #d9d9de; border-radius: 999px; cursor: pointer; }
.inspection-node-chips span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.inspection-node-chips i { color: #d92d20; font-style: normal; }
.inspection-node-chips small { color: #86868b; }
.inspection-camera-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.inspection-camera-grid .inspection-config-card { display: grid; gap: 10px; }
.property-grid.three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.inspection-part-form .wide-form-section { grid-column: 1 / -1; }
.device-inspection-override-toolbar { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px; color: #667085; font-size: 12px; }
.model-binding-table td > strong,
.model-binding-table td > small { display: block; }
.model-binding-table td > small { margin-top: 3px; color: #86868b; }
.model-binding-form {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    margin-bottom: 16px;
}
.model-binding-form label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: #515154;
    font-size: 12px;
    font-weight: 500;
}
.model-binding-form label:first-child {
    grid-column: span 2;
}

.model-node-picker {
    min-width: 0;
}
.model-node-tools {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
}
.node-filter-toggle {
    min-height: 38px;
    white-space: nowrap;
    background: #ffffff;
}
.field-hint {
    color: #86868b;
    font-size: 11px;
    line-height: 1.45;
}
.color-input {
    height: 38px;
    padding: 4px;
}
.model-binding-actions {
    grid-column: 1 / -1;
    display: flex;
    gap: 10px;
    justify-content: flex-end;
}
.model-binding-table {
    margin-bottom: 10px;
}
.model-binding-table td {
    padding-top: 10px;
    padding-bottom: 10px;
}
.model-binding-row {
    cursor: pointer;
}
.model-binding-row:hover {
    background: rgba(0, 113, 227, 0.04);
}
.model-binding-row.active {
    background: rgba(0, 113, 227, 0.08);
    box-shadow: inset 3px 0 0 #0071e3;
}
.model-binding-bottom-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 10px 0 8px;
    padding: 12px 14px;
    color: #68686d;
    background: #fbfbfd;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 10px;
    font-size: 12px;
}
.model-binding-status {
    min-height: 18px;
    color: #68686d;
    font-size: 12px;
}
.model-preview-panel {
    position: sticky;
    top: 0;
    min-width: 0;
    border: 1px solid rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    overflow: hidden;
    background: #ffffff;
}
.model-preview-header {
    min-height: 54px;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}
.model-preview-title {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.model-preview-title strong {
    color: #1d1d1f;
    font-size: 15px;
}
.model-preview-title span {
    color: #86868b;
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.model-preview-mode-badge { flex: 0 0 auto; padding: 6px 9px; color: #515154; background: #f0f2f4; border: 1px solid rgba(0, 0, 0, .07); border-radius: 8px; font-size: 11px; font-weight: 600; }
.model-preview-stage {
    position: relative;
    height: 360px;
    min-width: 0;
    background: #f3f4f5;
    overflow: hidden;
}
.model-preview-node-card {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 2;
    max-width: min(360px, calc(100% - 88px));
    display: grid;
    gap: 4px;
    padding: 10px 12px;
    color: #172027;
    background: rgba(255, 255, 255, 0.88);
    border: 1px solid rgba(25, 33, 38, 0.10);
    border-radius: 10px;
    box-shadow: 0 10px 28px rgba(25, 33, 38, 0.12);
    backdrop-filter: blur(10px);
    pointer-events: none;
}
.model-preview-node-card strong,
.model-preview-node-card small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.model-preview-node-card strong {
    font-size: 13px;
}
.model-preview-node-card span {
    color: #4b5a64;
    font-size: 12px;
}
.model-preview-node-card small {
    color: #7c858c;
    font-family: SFMono-Regular, Consolas, Monaco, monospace;
    font-size: 11px;
}
.model-preview-reset {
    position: absolute;
    right: 12px;
    top: 12px;
    z-index: 3;
    height: 32px;
    padding: 0 10px;
    color: #23323b;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(25, 33, 38, 0.12);
    border-radius: 999px;
    box-shadow: 0 8px 22px rgba(25, 33, 38, 0.12);
    cursor: pointer;
    font-size: 12px;
    font-weight: 700;
}
.model-preview-reset:hover {
    background: #ffffff;
}
.model-preview-canvas {
    display: block;
    width: 100%;
    height: 100%;
}
.model-preview-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #86868b;
    font-size: 13px;
    pointer-events: none;
}
.model-preview-footer {
    min-height: 42px;
    padding: 10px 14px;
    color: #515154;
    background: #fbfbfd;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
    font-size: 12px;
    line-height: 1.45;
}
.model-preview-selected-text {
    margin-top: 4px;
    color: #1d5f7c;
    font-weight: 600;
}

/* 连接设置专属样式 */
.settings-section {
    padding: 24px; background: #fbfbfd; border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 12px; margin-bottom: 24px;
}
.section-title {
    margin: 0 0 20px 0; font-size: 16px; color: #1d1d1f; font-weight: 600;
    padding-bottom: 12px; border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}
.scene-basic-note { margin: -8px 0 18px; padding: 11px 13px; color: #6e6e73; background: #f5f5f7; border-radius: 9px; font-size: 12px; line-height: 1.55; }
.legacy-web-render-section {
    padding-top: 18px;
    padding-bottom: 18px;
    overflow: hidden;
    transition: border-color 180ms ease, background-color 180ms ease, box-shadow 180ms ease;
}
.legacy-web-render-section.open {
    border-color: rgba(0, 113, 227, 0.16);
    background: #ffffff;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.035);
}
.legacy-web-render-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
}
.legacy-web-render-heading .section-title {
    margin: 0;
    padding: 0;
    border-bottom: 0;
}
.legacy-web-render-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: 9px;
    color: #1d1d1f;
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}
.legacy-web-render-toggle:hover {
    color: #0066cc;
    background: #f5f9ff;
    border-color: rgba(0, 102, 204, 0.22);
}
.legacy-web-render-toggle svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 180ms ease;
}
.legacy-web-render-section.open .legacy-web-render-toggle svg {
    transform: rotate(180deg);
}
.legacy-web-render-body {
    margin-top: 18px;
    padding-top: 20px;
    border-top: 1px solid rgba(0, 0, 0, 0.06);
}
.legacy-render-collapse-enter-active,
.legacy-render-collapse-leave-active {
    transition: opacity 160ms ease, transform 160ms ease;
}
.legacy-render-collapse-enter-from,
.legacy-render-collapse-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
.settings-grid label { display: flex; flex-direction: column; gap: 8px; font-size: 13px; color: #515154; font-weight: 500; }
.render-setting-readonly { display: flex; align-items: center; color: #1d1d1f; background: #f5f5f7; }
.render-profile-hint { margin-top: 16px; }
.render-profile-hint p { margin: 4px 0; }
.render-custom-grid { margin-top: 18px; padding-top: 18px; border-top: 1px solid #e5e5e7; }
.checkbox-line { display: flex; align-items: center; gap: 8px; min-height: 38px; font-weight: 400; }
.database-production-notice { margin: 16px 0 0; padding: 11px 13px; color: #173f2b; background: #edf8f1; border-left: 3px solid #24834f; font-size: 13px; line-height: 1.55; }
.license-settings-panel { margin-bottom: 18px; }
.license-heading-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.license-heading-row .section-title { margin-bottom: 4px; }
.license-status-pill { flex: 0 0 auto; padding: 6px 11px; color: #5b5b60; background: #f1f1f3; border: 1px solid #dedee3; border-radius: 999px; font-size: 11px; font-weight: 700; }
.license-status-pill.license-valid { color: #1f6b3b; background: #edf8f1; border-color: #bfe4ca; }
.license-status-pill.license-not_enforced { color: #6a5517; background: #fff8df; border-color: #ead58a; }
.license-status-pill.license-invalid,.license-status-pill.license-expired,.license-status-pill.license-machine_mismatch,.license-status-pill.license-error { color: #9b2c2c; background: #fff1f1; border-color: #efc6c6; }
.license-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 18px; }
.license-summary-grid > div { min-width: 0; padding: 12px 13px; background: #f7f7f8; border: 1px solid #e6e6e9; border-radius: 10px; }
.license-summary-grid span,.license-summary-grid strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.license-summary-grid span { color: #86868b; font-size: 10px; }
.license-summary-grid strong { margin-top: 5px; color: #27272a; font-size: 12px; }
.release-status-card { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 12px; padding: 12px 13px; background: #f7f7f8; border: 1px solid #e6e6e9; border-radius: 10px; }
.release-status-card > div { min-width: 0; }
.release-status-card span,.release-status-card strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.release-status-card span { color: #86868b; font-size: 10px; }
.release-status-card strong { margin-top: 4px; color: #27272a; font-size: 12px; }
.release-status-card p { grid-column: 1 / -1; margin: 2px 0 0; color: #6e6e73; font-size: 11px; line-height: 1.45; }
.license-reason { margin: 12px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.5; }
.license-reason.warning { color: #a33a2b; }
.license-install-card { margin-top: 18px; padding: 14px; background: #fafafa; border: 1px solid #e5e5e7; border-radius: 12px; }
.license-install-card label { display: flex; flex-direction: column; gap: 7px; color: #515154; font-size: 12px; }
.license-textarea { width: 100%; min-height: 150px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.45; }
.license-actions { margin-top: 11px; margin-bottom: 0; }
@media (max-width: 820px) { .license-summary-grid,.release-status-card { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.external-data-source-manager { margin-top: 24px; padding: 16px; background: #fff; border: 1px solid #e2e2e5; border-radius: 10px; transition: border-color 180ms ease, box-shadow 180ms ease; }
.external-data-source-manager.open { border-color: #d5d5da; box-shadow: 0 8px 24px #00000008; }
.external-data-source-heading { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.external-data-source-heading strong { color: #1d1d1f; font-size: 14px; }
.external-data-source-toggle { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 0; color: inherit; background: transparent; border: 0; text-align: left; cursor: pointer; }
.external-data-source-toggle > span:first-child { min-width: 0; }
.external-data-source-toggle strong,.external-data-source-toggle small { display: block; }
.external-data-source-toggle small { margin-top: 5px; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.external-data-source-toggle-status { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 8px; color: #6e6e73; font-size: 11px; white-space: nowrap; }
.external-data-source-manager .collapsible-section-body { padding-top: 2px; }
.external-data-source-list { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; margin-top: 16px; }
.external-data-source-card { display: grid; grid-template-columns: 34px minmax(0,1fr) auto; align-items: center; gap: 10px; min-width: 0; padding: 12px; color: #1d1d1f; background: #fff; border: 1px solid #e2e2e5; border-radius: 10px; text-align: left; cursor: pointer; transition: border-color 160ms ease,box-shadow 160ms ease,transform 160ms ease; }
.external-data-source-card:hover,.external-data-source-card.active { border-color: #8e8e93; box-shadow: 0 8px 24px #0000000d; transform: translateY(-1px); }
.external-data-source-icon { display: grid; place-items: center; width: 34px; height: 34px; color: #fff; background: #1d1d1f; border-radius: 9px; font-size: 10px; font-weight: 700; }
.external-data-source-card > span:nth-child(2) { min-width: 0; }
.external-data-source-card strong,.external-data-source-card small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.external-data-source-card strong { font-size: 12px; }.external-data-source-card small { margin-top: 3px; color: #6e6e73; font-size: 10px; }
.external-data-source-card em { color: #24834f; font-size: 10px; font-style: normal; }
.external-data-source-editor { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 12px 18px; margin-top: 16px; padding: 16px; background: #f7f7f8; border: 1px solid #e5e5e7; border-radius: 10px; }
.external-data-source-editor label { display: flex; flex-direction: column; gap: 6px; color: #515154; font-size: 12px; font-weight: 500; }
.external-data-source-editor .checkbox-line { flex-direction: row; align-items: center; align-self: end; }
.external-data-source-wide { grid-column: 1/-1; }
.external-data-source-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.external-data-source-actions span { color: #515154; font-size: 12px; }
.database-auto-backup-panel { padding: 18px; background: #f7f7f8; border: 1px solid #e2e2e5; border-radius: 10px; }
.database-backup-trigger-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; margin-top: 16px; }
.database-backup-trigger-card { position: relative; display: grid; grid-template-columns: 34px minmax(0,1fr) 38px; align-items: center; gap: 10px; min-width: 0; min-height: 82px; padding: 12px; color: #515154; background: #fff; border: 1px solid #dedee3; border-radius: 12px; cursor: pointer; transition: border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease,transform 160ms ease; }
.database-backup-trigger-card:hover { border-color: #b8b8bd; box-shadow: 0 7px 20px #0000000d; transform: translateY(-1px); }
.database-backup-trigger-card.active { color: #1d1d1f; background: #fff; border-color: #a8a8ad; box-shadow: inset 0 0 0 1px #00000008,0 8px 22px #0000000b; }
.database-backup-trigger-card > input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.database-backup-trigger-index { display: grid; place-items: center; width: 34px; height: 34px; color: #8e8e93; background: #f2f2f4; border-radius: 9px; font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; transition: color 160ms ease,background-color 160ms ease; }
.database-backup-trigger-card.active .database-backup-trigger-index { color: #fff; background: #1d1d1f; }
.database-backup-trigger-copy { min-width: 0; }
.database-backup-trigger-copy strong,.database-backup-trigger-copy small { display: block; }
.database-backup-trigger-copy strong { color: inherit; font-size: 12px; }
.database-backup-trigger-copy small { margin-top: 4px; color: #86868b; font-size: 10px; line-height: 1.45; }
.database-backup-trigger-switch { position: relative; width: 36px; height: 22px; background: #d1d1d6; border-radius: 999px; box-shadow: inset 0 0 0 1px #0000000a; transition: background-color 160ms ease; }
.database-backup-trigger-switch i { position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; background: #fff; border-radius: 50%; box-shadow: 0 1px 3px #0003; transition: transform 160ms ease; }
.database-backup-trigger-card.active .database-backup-trigger-switch { background: #1d1d1f; }
.database-backup-trigger-card.active .database-backup-trigger-switch i { transform: translateX(14px); }
.database-auto-backup-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-top: 14px; }
.database-auto-backup-controls > label:not(.checkbox-line) { display: flex; flex-direction: column; gap: 5px; color: #515154; font-size: 12px; }
.database-auto-backup-controls .input-small { width: 100px; }
.database-auto-backup-controls input:disabled { color: #a1a1a6; background: #ececef; cursor: not-allowed; }
.database-backup-protection-note { display: grid; grid-template-columns: auto minmax(0,1fr); align-items: center; gap: 11px; margin-top: 14px; padding: 11px 12px; background: #fff; border: 1px solid #e5e5e7; border-radius: 10px; }
.database-backup-protection-note > span { padding: 5px 8px; color: #fff; background: #1d1d1f; border-radius: 999px; font-size: 9px; font-weight: 700; white-space: nowrap; }
.database-backup-protection-note strong,.database-backup-protection-note small { display: block; }
.database-backup-protection-note strong { color: #353537; font-size: 11px; }
.database-backup-protection-note small { margin-top: 3px; color: #86868b; font-size: 10px; line-height: 1.45; }
.database-backup-source-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 8px; margin-top: 14px; }
.database-backup-source-option { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 10px 12px; background: #fff; border: 1px solid #e5e5e7; border-radius: 8px; cursor: pointer; }
.database-backup-source-option input { accent-color: #1d1d1f; }
.database-backup-source-option span { min-width: 0; }.database-backup-source-option strong,.database-backup-source-option small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.database-backup-source-option strong { color: #1d1d1f; font-size: 12px; }.database-backup-source-option small { margin-top: 2px; color: #8e8e93; font-size: 10px; }
.database-backup-panel { margin-top: 22px; padding-top: 20px; border-top: 1px solid #e5e5e7; }
.database-backup-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.database-backup-header p { margin: 6px 0 0; color: #6e6e73; font-size: 13px; line-height: 1.6; }
.database-retention-card { margin-top: 16px; overflow: hidden; background: linear-gradient(180deg,#fafafa 0%,#f5f5f7 100%); border: 1px solid #dedee2; border-radius: 14px; box-shadow: 0 8px 24px #00000008; }
.database-retention-heading { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 12px; padding: 14px 16px 12px; }
.database-retention-icon { display: grid; place-items: center; width: 36px; height: 36px; color: #fff; background: #1d1d1f; border-radius: 10px; box-shadow: 0 4px 10px #0000001f; }
.database-retention-icon svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.database-retention-heading > div:nth-child(2) { min-width: 0; }
.database-retention-heading strong,.database-retention-heading span { display: block; }
.database-retention-heading strong { color: #1d1d1f; font-size: 13px; }
.database-retention-heading span { margin-top: 3px; color: #77777c; font-size: 11px; line-height: 1.45; }
.database-retention-heading > em { padding: 5px 9px; color: #3a3a3c; background: #fff; border: 1px solid #dfdfe3; border-radius: 999px; font-size: 11px; font-style: normal; white-space: nowrap; }
.database-retention-controls { display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: end; gap: 12px; padding: 0 16px 14px; }
.database-retention-presets { display: grid; grid-template-columns: repeat(5,minmax(58px,1fr)); gap: 3px; min-width: 0; padding: 3px; background: #e8e8eb; border-radius: 10px; }
.database-retention-presets button { min-height: 34px; padding: 5px 8px; color: #636366; background: transparent; border: 0; border-radius: 8px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; transition: color 150ms ease,background-color 150ms ease,box-shadow 150ms ease,transform 150ms ease; }
.database-retention-presets button:hover { color: #1d1d1f; }
.database-retention-presets button.active { color: #1d1d1f; background: #fff; box-shadow: 0 1px 4px #0000001a; transform: translateY(-1px); }
.database-retention-custom { display: flex; flex-direction: column; gap: 5px; color: #6e6e73; font-size: 10px; font-weight: 500; }
.database-retention-input { display: grid; grid-template-columns: 72px auto; align-items: center; min-height: 40px; overflow: hidden; background: #fff; border: 1px solid #d9d9de; border-radius: 9px; transition: border-color 150ms ease,box-shadow 150ms ease; }
.database-retention-input:focus-within { border-color: #8e8e93; box-shadow: 0 0 0 3px #0000000d; }
.database-retention-input input { width: 72px; height: 38px; padding: 0 4px 0 11px; color: #1d1d1f; background: transparent; border: 0; outline: 0; font: inherit; font-size: 13px; font-weight: 600; }
.database-retention-input em { padding-right: 10px; color: #86868b; font-size: 11px; font-style: normal; }
.database-retention-save { min-height: 40px; white-space: nowrap; }
.database-retention-stats { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border-top: 1px solid #e2e2e5; background: #fff; }
.database-retention-stats > div { min-width: 0; padding: 11px 14px; border-right: 1px solid #ededee; }
.database-retention-stats > div:last-child { border-right: 0; }
.database-retention-stats span,.database-retention-stats strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.database-retention-stats span { color: #8e8e93; font-size: 10px; }
.database-retention-stats strong { margin-top: 4px; color: #353537; font-size: 11px; font-weight: 600; }
.database-recovery-notice { margin: 14px 0 0; padding: 10px 12px; background: #fff8e6; border-left: 3px solid #c68a00; color: #5c4300; font-size: 13px; }
.database-local-only-notice { margin: 14px 0 0; padding: 10px 12px; background: #fff8e6; border-left: 3px solid #c68a00; color: #5c4300; font-size: 13px; line-height: 1.55; }
.database-backup-message { margin: 12px 0 0; color: #515154; font-size: 13px; }
.database-backup-list { margin-top: 14px; border-top: 1px solid #e5e5e7; }
.database-backup-row { display: grid; grid-template-columns: minmax(280px, 1fr) auto auto auto auto; align-items: center; gap: 10px; min-height: 58px; padding: 8px 0; border-bottom: 1px solid #ededee; }
.database-backup-row > div { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.database-backup-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.database-backup-row span { color: #6e6e73; font-size: 12px; }
.backup-validity { white-space: nowrap; }
.backup-validity.is-valid { color: #16713a; }
.backup-validity.is-invalid { color: #b42318; }
.btn-small { min-height: 32px; padding: 5px 10px; font-size: 12px; }
.site-backup-panel { margin-top: 26px; padding-top: 24px; border-top: 1px solid #d7d7da; }
.site-backup-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.site-backup-header p { max-width: 720px; margin: 6px 0 0; color: #515154; font-size: 13px; line-height: 1.6; }
.site-backup-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
.site-backup-file-input { display: none; }
.site-backup-external-notice { margin: 16px 0 0; padding: 12px 14px; color: #173f2b; background: #edf8f1; border-left: 3px solid #24834f; font-size: 13px; line-height: 1.55; }
.site-backup-auto-config { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin-top: 14px; padding: 12px 14px; background: #f7f7f8; border: 1px solid #e1e1e4; border-radius: 8px; }
.site-backup-auto-config label { display: flex; flex-direction: column; gap: 5px; color: #515154; font-size: 12px; }
.site-backup-auto-toggle { flex-direction: row !important; align-items: center; padding-bottom: 8px; color: #1d1d1f !important; }
.site-backup-mirror-field { flex: 1 1 360px; min-width: 260px; }
.site-backup-auto-config .input-small { width: 90px; }
.site-backup-history { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px 14px; align-items: start; margin-top: 16px; padding-top: 14px; border-top: 1px solid #e5e5e7; }
.site-backup-history > span { padding-top: 8px; color: #6e6e73; font-size: 12px; }
.site-backup-history-item { grid-column: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; width: 100%; min-width: 0; padding: 8px 10px; color: #1d1d1f; background: transparent; border: 1px solid transparent; border-radius: 6px; text-align: left; cursor: pointer; transition: background-color 160ms ease, border-color 160ms ease; }
.site-backup-history-item:hover:not(:disabled) { background: #f5f5f7; border-color: #e2e2e5; }
.site-backup-history-item strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.site-backup-history-item small { flex: 0 0 auto; color: #6e6e73; font-size: 11px; }
.runtime-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.runtime-card { min-width: 0; padding: 18px; background: #ffffff; border: 1px solid #e5e5e7; border-radius: 10px; }
.runtime-card-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.runtime-card-heading strong { color: #1d1d1f; font-size: 14px; }
.runtime-card-heading p { margin: 6px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.runtime-badge { flex: 0 0 auto; padding: 4px 8px; border-radius: 999px; font-size: 11px; white-space: nowrap; }
.runtime-badge.is-supported { color: #176b3a; background: #e8f7ee; }
.runtime-badge.is-muted { color: #6e6e73; background: #f0f0f2; }
.runtime-toggle-row { display: inline-flex !important; flex-direction: row !important; align-items: center; gap: 9px !important; margin-top: 16px; color: #1d1d1f !important; font-size: 13px !important; cursor: pointer; }
.runtime-toggle-row input { position: absolute; opacity: 0; pointer-events: none; }
.runtime-toggle-track { position: relative; width: 38px; height: 22px; flex: 0 0 auto; border-radius: 999px; background: #c7c7cc; transition: background-color 160ms ease; }
.runtime-toggle-track span { position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 3px #0003; transition: transform 160ms ease; }
.runtime-toggle-row input:checked + .runtime-toggle-track { background: #24834f; }
.runtime-toggle-row input:checked + .runtime-toggle-track span { transform: translateX(16px); }
.runtime-toggle-row input:disabled + .runtime-toggle-track { opacity: .55; }
.runtime-help { margin: 12px 0 0; color: #86868b; font-size: 12px; line-height: 1.55; }
.runtime-inline-fields { display: grid; grid-template-columns: minmax(100px, .8fr) minmax(120px, 1fr) auto; align-items: end; gap: 10px; margin-top: 16px; }
.runtime-inline-fields label { display: flex; flex-direction: column; gap: 6px; color: #515154; font-size: 12px; font-weight: 500; }
.runtime-pin-input { letter-spacing: 3px; font-family: SFMono-Regular, Consolas, Monaco, monospace; font-weight: 700; }
.runtime-cast-panel { margin-top: 16px; padding: 18px; background: #f5f9fb; border: 1px solid #dcebf1; border-radius: 10px; }
.runtime-cast-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.runtime-cast-header strong { color: #1d1d1f; font-size: 14px; }
.runtime-cast-header p { margin: 6px 0 0; color: #515154; font-size: 12px; line-height: 1.55; }
.runtime-cast-content { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 18px; align-items: center; margin-top: 16px; }
.runtime-qr-block { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px; background: #ffffff; border-radius: 8px; }
.runtime-qr-block img { display: block; width: 180px; height: 180px; image-rendering: pixelated; }
.runtime-qr-block small { color: #6e6e73; font-size: 11px; }
.runtime-url-block { min-width: 0; }
.runtime-url-row { display: flex; align-items: center; gap: 8px; min-width: 0; margin-bottom: 8px; }
.runtime-url-row code { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 8px 10px; color: #1d4c62; background: #ffffff; border: 1px solid #dcebf1; border-radius: 6px; font-size: 11px; white-space: nowrap; }
.runtime-error { margin: 14px 0 0; padding: 9px 11px; color: #8a1c14; background: #fff0ee; border-left: 3px solid #c9372c; font-size: 12px; line-height: 1.5; }
.runtime-message { margin: 14px 0 0; color: #176b3a; font-size: 12px; line-height: 1.5; }

/* 局域网电视发现与一键投屏 */
.cast-device-panel { margin-bottom: 16px; padding: 18px; background: #ffffff; border: 1px solid #d7e5ec; border-radius: 10px; }
.cast-panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cast-panel-heading strong { color: #1d1d1f; font-size: 15px; }
.cast-panel-heading p { max-width: 620px; margin: 6px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.cast-panel-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; }
.cast-active-banner { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 14px; padding: 12px 14px; background: #e8f7ee; border: 1px solid #b6e3c8; border-radius: 8px; }
.cast-active-banner strong { display: block; color: #14653a; font-size: 13px; }
.cast-active-banner small { display: block; margin-top: 4px; color: #3f7a5b; font-size: 11px; }
.cast-warning { margin: 14px 0 0; padding: 10px 12px; color: #7a4a06; background: #fff8ea; border-left: 3px solid #e0a338; font-size: 12px; line-height: 1.6; }
.cast-warning code { padding: 1px 5px; background: rgba(0, 0, 0, .05); border-radius: 4px; font-size: 11px; }
.cast-device-list { margin: 14px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.cast-device-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 13px; background: #f8fafb; border: 1px solid #e3eaee; border-radius: 8px; }
.cast-device-row.is-active { background: #eef8f2; border-color: #b6e3c8; }
.cast-device-icon { display: inline-flex; width: 34px; height: 34px; align-items: center; justify-content: center; color: #2f6d8c; background: #ffffff; border: 1px solid #dbe6ec; border-radius: 8px; }
.cast-device-icon svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.cast-device-text { min-width: 0; }
.cast-device-text strong { display: block; color: #1d1d1f; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cast-device-text small { display: block; margin-top: 3px; color: #86868b; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cast-empty { display: grid; gap: 7px; margin-top: 14px; padding: 20px 16px; color: #6e6e73; text-align: center; background: #f8fafb; border: 1px dashed #d3dde3; border-radius: 8px; }
.cast-empty strong { color: #344054; font-size: 13px; }
.cast-empty span { margin: 0 auto; max-width: 620px; font-size: 12px; line-height: 1.6; }
.runtime-cast-fallback > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; color: #1d1d1f; font-size: 14px; font-weight: 600; cursor: pointer; }
.runtime-cast-fallback > summary::-webkit-details-marker { display: none; }
.runtime-cast-fallback > summary > span::before { content: '▸ '; color: #6e6e73; }
.runtime-cast-fallback[open] > summary > span::before { content: '▾ '; }
.runtime-cast-fallback[open] > summary { margin-bottom: 12px; }
.mode-hint { margin-top: 16px; padding: 16px 20px; background: rgba(0, 102, 204, 0.03); border: 1px solid rgba(0, 102, 204, 0.1); border-radius: 8px; }
.mode-hint p { margin: 6px 0; font-size: 13px; color: #434345; line-height: 1.6; }
.mode-hint code { background: rgba(0, 0, 0, 0.04); padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #1d1d1f; }
.required { color: #ff3b30; font-weight: bold; margin-left: 2px; }

/* 引擎状态卡片 */
.engine-status-card {
    max-width: 700px; padding: 20px 24px; border-radius: 14px; margin-bottom: 28px;
    border: 1px solid rgba(0, 0, 0, 0.06); background: #ffffff;
    display: flex; flex-direction: column; gap: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.02);
}
.engine-status-header { display: flex; align-items: center; gap: 10px; font-size: 15px; color: #1d1d1f; font-weight: 600; }
.engine-dot { width: 10px; height: 10px; border-radius: 50%; background: #8e8e93; display: inline-block; flex-shrink: 0; }
.engine-status-body { display: flex; flex-wrap: wrap; gap: 10px 32px; font-size: 13px; color: #515154; }
.status-connected .engine-dot, .status-simulating .engine-dot, .status-heartbeat .engine-dot { background: #34c759; box-shadow: 0 0 8px rgba(52, 199, 89, 0.6); }
.status-connected, .status-simulating, .status-heartbeat { border-color: rgba(52, 199, 89, 0.15); background: rgba(52, 199, 89, 0.05); }
.status-error .engine-dot, .status-unconfigured .engine-dot { background: #ff3b30; box-shadow: 0 0 8px rgba(255, 59, 48, 0.6); }
.status-error, .status-unconfigured { border-color: rgba(255, 59, 48, 0.15); background: rgba(255, 59, 48, 0.05); }
.status-connecting .engine-dot, .status-retrying .engine-dot, .status-waiting .engine-dot { background: #ff9500; box-shadow: 0 0 8px rgba(255, 149, 0, 0.6); animation: pulse 1.5s infinite; }
.status-connecting, .status-retrying, .status-waiting { border-color: rgba(255, 149, 0, 0.15); background: rgba(255, 149, 0, 0.05); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

@media (max-width: 1180px) {
    .secondary-page-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .runtime-settings-grid { grid-template-columns: 1fr; }
    .runtime-cast-content { grid-template-columns: 1fr; }
    .runtime-qr-block { justify-self: start; }
    .model-library-layout {
        grid-template-columns: 1fr;
    }
    .model-preview-panel {
        position: relative;
    }
    .model-workflow-rail,
    .model-stats-strip,
    .model-acceptance-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .model-spec-form {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .database-retention-controls { grid-template-columns: minmax(0,1fr) auto; }
    .database-retention-presets { grid-column: 1 / -1; }
    .database-retention-stats { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .database-retention-stats > div:nth-child(2) { border-right: 0; }
    .database-retention-stats > div:nth-child(-n+2) { border-bottom: 1px solid #ededee; }
    .database-backup-row {
        grid-template-columns: minmax(220px, 1fr) auto auto auto;
    }
    .site-backup-header { flex-direction: column; }
    .site-backup-actions { justify-content: flex-start; }
    .backup-validity {
        grid-column: 1 / -1;
        grid-row: 2;
    }
    .device-group {
        overflow-x: auto;
    }
    .device-group .data-table {
        min-width: 840px;
    }
    .device-group .data-table td:last-child {
        white-space: nowrap;
    }
    .voice-rule-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .voice-file-row { align-items: stretch; flex-direction: column; }
    .voice-rule-actions { justify-content: flex-start; }
}

@media (max-width: 900px) {
    .database-backup-trigger-grid { grid-template-columns: 1fr; }
    .database-retention-heading { grid-template-columns: auto minmax(0,1fr); }
    .database-retention-heading > em { grid-column: 2; justify-self: start; }
    .database-retention-controls { grid-template-columns: 1fr; }
    .database-retention-presets { grid-column: auto; grid-template-columns: repeat(5,minmax(48px,1fr)); }
    .database-retention-custom { width: 112px; }
    .database-retention-save { justify-self: start; }
    .secondary-page-nav-item { min-height: 58px; }
    .admin-header { padding: 0 16px; }
    .admin-header h1 { font-size: 16px; }
    .admin-connection-strip { gap: 6px; margin-left: 10px; }
    .admin-connection-pill { padding: 5px 8px; font-size: 11px; }
    .admin-container.line-planner-active .admin-content {
        padding: 8px;
    }
    .line-planner-header {
        align-items: stretch;
        flex-direction: column;
        gap: 10px;
        padding: 14px;
    }
    .line-native-actions {
        justify-content: flex-start;
    }
    .line-planner-steps {
        overflow-x: auto;
        padding: 8px 14px;
        scrollbar-width: thin;
    }
    .line-planner-steps span {
        flex: 0 0 auto;
    }
    .line-planner-layout {
        min-height: 0;
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto auto;
    }
    .line-planner-editor {
        max-height: none;
        overflow: visible;
        border-right: 0;
    }
    .line-planner-preview {
        min-height: 640px;
    }
    .line-editor-float-toggle {
        left: 12px;
        top: 12px;
        transform: none;
    }
    .line-preview-toolbar {
        align-items: flex-start;
        flex-direction: column;
    }
    .line-preview-metrics {
        justify-content: flex-start;
    }
}

@media (max-width: 520px) {
    .secondary-page-nav-shell { margin-right: -12px; margin-left: -12px; border-radius: 0; }
    .secondary-page-nav { display: flex; overflow-x: auto; padding-bottom: 2px; scrollbar-width: thin; }
    .secondary-page-nav-item { flex: 0 0 min(250px, 78vw); }
    .secondary-page-copy small { display: none; }
    .admin-container.line-planner-active .admin-nav {
        width: 68px;
        flex: 0 0 68px;
        padding: 16px 8px 24px;
        align-items: center;
    }
    .admin-container.line-planner-active .nav-item {
        justify-content: center;
        width: 44px;
        padding: 10px;
    }
    .admin-container.line-planner-active .nav-group,
    .admin-container.line-planner-active .nav-submenu {
        align-items: center;
        padding-left: 0;
    }
    .admin-container.line-planner-active .nav-label,
    .admin-container.line-planner-active .nav-chevron {
        display: none;
    }
    .admin-container.line-planner-active .nav-collapse-btn {
        left: 50px;
    }
    .line-transform-grid,
    .line-card-fields,
    .line-flow-controls {
        grid-template-columns: 1fr;
    }
    .line-layout-row {
        grid-template-columns: minmax(0, 1fr) 82px;
    }
    .line-layout-row .btn {
        grid-column: 1 / -1;
        width: 100%;
    }
}

@media (prefers-reduced-motion: reduce) {
    .nav-item,
    .nav-collapse-btn,
    .nav-chevron,
    .nav-submenu-enter-active,
    .nav-submenu-leave-active,
    .tab-switch-enter-active,
    .tab-switch-leave-active,
    .modal-fade-enter-active,
    .modal-fade-leave-active,
    .modal-fade-enter-active .modal-box,
    .modal-fade-leave-active .modal-box,
    .dialog-fade-enter-active,
    .dialog-fade-leave-active,
    .dialog-fade-enter-active .app-dialog,
    .dialog-fade-leave-active .app-dialog,
    .secondary-page-nav-item,
    .secondary-page-panel,
    .btn,
    .input {
        transition-duration: 1ms !important;
        animation-duration: 1ms !important;
    }
}
.db-status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
    transition: all 0.2s ease;
}
.db-status-badge.status-success {
    color: #1b6b3a;
    background: rgba(52, 199, 89, 0.12);
    border: 1px solid rgba(52, 199, 89, 0.25);
}
.db-status-badge.status-success .db-status-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #34c759;
}
.db-status-badge.status-error {
    color: #9f1d17;
    background: rgba(255, 59, 48, 0.12);
    border: 1px solid rgba(255, 59, 48, 0.25);
}
.db-status-badge.status-error .db-status-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #ff3b30;
}
.db-status-badge.status-loading {
    color: #0071e3;
    background: rgba(0, 113, 227, 0.1);
    border: 1px solid rgba(0, 113, 227, 0.22);
}
.db-status-badge.status-loading .db-status-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #0071e3;
    animation: db-dot-pulse 1s infinite alternate;
}
.db-status-badge.status-info {
    color: #515154;
    background: #e8e8ed;
    border: 1px solid rgba(0, 0, 0, 0.08);
}
.db-status-badge.status-info .db-status-dot {
    width: 6px; height: 6px; border-radius: 50%; background: #86868b;
}
@keyframes db-dot-pulse {
    0% { opacity: 0.3; transform: scale(0.8); }
    100% { opacity: 1; transform: scale(1.25); }
}
.workshop-management-tab { --workshop-accent: #1d1d1f; }
.workshop-management-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.workshop-management-heading h2 { margin-bottom: 6px; }
.workshop-current-chip { flex: 0 0 auto; padding: 7px 12px; color: #515154; background: #f5f5f7; border: 1px solid #e5e5e7; border-radius: 999px; font-size: 12px; }
.workshop-step-nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 18px 0; padding: 8px; background: #f5f5f7; border: 1px solid #e6e6e8; border-radius: 16px; }
.workshop-step-nav > button { display: flex; align-items: center; min-width: 0; padding: 12px 13px; color: #515154; text-align: left; background: #fff; border: 1px solid #e8e8ed; border-radius: 12px; cursor: pointer; transition: color .18s ease, background .18s ease, border-color .18s ease, box-shadow .18s ease, transform .18s ease; }
.workshop-step-nav > button:hover:not(:disabled) { border-color: #c7c7cc; box-shadow: 0 7px 20px rgba(0, 0, 0, .06); transform: translateY(-1px); }
.workshop-step-nav > button.active { color: #fff; background: #1d1d1f; border-color: #1d1d1f; box-shadow: 0 8px 22px rgba(0, 0, 0, .16); }
.workshop-step-nav > button:disabled { opacity: .45; cursor: not-allowed; }
.workshop-step-number { display: grid; flex: 0 0 34px; width: 34px; height: 34px; margin-right: 11px; place-items: center; color: #6e6e73; background: #f5f5f7; border-radius: 9px; font-size: 11px; font-weight: 700; }
.workshop-step-nav > button.active .workshop-step-number { color: #1d1d1f; background: #fff; }
.workshop-step-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
.workshop-step-copy strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.workshop-step-copy small { overflow: hidden; color: #86868b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workshop-step-nav > button.active small { color: #c7c7cc; }
.workshop-step-nav svg { flex: 0 0 17px; width: 17px; height: 17px; margin-left: 8px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
.spatial-rule-banner { display: flex; align-items: center; gap: 14px; margin: 14px 0; padding: 13px 15px; color: #475467; background: #f0f7fa; border: 1px solid #cfe2ea; border-radius: 9px; font-size: 12px; line-height: 1.55; }
.spatial-rule-banner strong { flex: 0 0 auto; color: #175f7b; }
.data-table tr.row-selected td { background: #f2f8fb; }
.data-table td .btn + .btn { margin-left: 6px; }
.workshop-create-row { margin-bottom: 14px; }
.workshop-step-context { display: flex; align-items: center; gap: 12px; margin: 6px 0 14px; padding: 10px 12px; color: #6e6e73; background: #f8f8fa; border: 1px solid #e5e5e7; border-radius: 12px; font-size: 12px; }
.workshop-step-context label { display: flex; align-items: center; gap: 8px; color: #3a3a3c; font-weight: 600; }
.workshop-step-context .input { width: auto; min-width: 180px; height: 34px; }
.workshop-back-button { display: grid; flex: 0 0 34px; width: 34px; height: 34px; padding: 0; place-items: center; color: #1d1d1f; background: #fff; border: 1px solid #d9d9de; border-radius: 50%; cursor: pointer; transition: background .16s ease, transform .16s ease; }
.workshop-back-button:hover { background: #ececf0; transform: translateX(-1px); }
.workshop-back-button svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
.workshop-spatial-editor { margin-top: 0; padding: 20px; background: #f8fafb; border: 1px solid #dce5eb; border-radius: 14px; }
.workshop-spatial-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.workshop-spatial-heading h3 { margin: 0; color: #1d2939; font-size: 16px; }
.workshop-spatial-heading p { max-width: 720px; margin: 6px 0 0; color: #667085; font-size: 12px; line-height: 1.55; }
.workshop-spatial-grid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
.workshop-spatial-grid > label, .line-transform-grid > label { display: flex; flex-direction: column; gap: 6px; color: #475467; font-size: 12px; font-weight: 500; }
.workshop-spatial-grid .workshop-boundary-toggle { flex-direction: row; align-items: center; min-height: 38px; padding: 8px 10px; align-self: end; background: #fff; border: 1px solid #d0d5dd; border-radius: 7px; }
.workshop-boundary-toggle input { accent-color: #176b8b; }
.workshop-step-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 18px; padding-top: 16px; color: #667085; border-top: 1px solid #e3e7eb; font-size: 12px; }
.canvas-save-reminder { position: relative; z-index: 12; display: flex; align-items: center; gap: 12px; margin: 12px 16px; padding: 12px 14px; overflow: hidden; color: #7a2e0e; background: linear-gradient(90deg, #fff4e8, #fff9ef); border: 1px solid #f79009; border-radius: 11px; box-shadow: 0 8px 24px rgba(181, 71, 8, .12); }
.canvas-save-reminder::before { position: absolute; top: 0; bottom: 0; left: 0; width: 5px; content: ''; background: #f04438; }
.canvas-save-reminder-dot { flex: 0 0 10px; width: 10px; height: 10px; margin-left: 2px; background: #f04438; border-radius: 50%; box-shadow: 0 0 0 5px rgba(240, 68, 56, .12); animation: canvas-save-pulse 1.8s ease-in-out infinite; }
.canvas-save-reminder > div:not(.canvas-save-reminder-actions) { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.canvas-save-reminder strong { color: #8a2c12; font-size: 13px; }
.canvas-save-reminder span { font-size: 11px; line-height: 1.45; }
.canvas-save-reminder-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; }
.canvas-save-reminder-actions .btn { min-height: 32px; }
.line-canvas-save-reminder { margin-top: 0; margin-bottom: 12px; }
@keyframes canvas-save-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.75); opacity: .72; } }
.workshop-map-shell { overflow: hidden; background: #fff; border: 1px solid #e5e5e7; border-radius: 16px; box-shadow: 0 10px 34px rgba(0, 0, 0, .055); }
.workshop-map-toolbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 20px; border-bottom: 1px solid #e8e8ed; }
.workshop-map-toolbar h3 { margin: 0; color: #1d1d1f; font-size: 16px; }
.workshop-map-toolbar p { max-width: 760px; margin: 6px 0 0; color: #6e6e73; font-size: 12px; line-height: 1.55; }
.workshop-map-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; min-height: 620px; background: #f5f7f8; }
.workshop-map-board { position: relative; min-width: 0; padding: 42px 28px 44px 54px; }
.workshop-map-dimension { position: absolute; z-index: 2; color: #6e6e73; font-size: 11px; font-weight: 600; letter-spacing: .02em; }
.workshop-map-dimension-x { top: 18px; left: 54px; right: 28px; text-align: center; }
.workshop-map-dimension-z { top: 50%; left: 12px; transform: translateY(-50%) rotate(-90deg); white-space: nowrap; }
.workshop-map-stage { position: relative; overflow: hidden; width: 100%; height: clamp(500px, 62vh, 680px); background-color: #eef3f5; background-image: linear-gradient(rgba(92, 119, 132, .095) 1px, transparent 1px), linear-gradient(90deg, rgba(92, 119, 132, .095) 1px, transparent 1px), linear-gradient(rgba(92, 119, 132, .12) 1px, transparent 1px), linear-gradient(90deg, rgba(92, 119, 132, .12) 1px, transparent 1px); background-position: center; background-size: 20px 20px, 20px 20px, 100px 100px, 100px 100px; border: 1px solid #bfcdd3; border-radius: 12px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.7), inset 0 0 34px rgba(37, 70, 84, .045); touch-action: none; }
.workshop-map-stage.pending-drag-active { border-color: rgba(229, 139, 0, .72); box-shadow: inset 0 0 0 2px rgba(245, 158, 11, .15), 0 0 0 3px rgba(245, 158, 11, .08); }
.workshop-map-stage.pending-drop-active { border-color: #e58b00; box-shadow: inset 0 0 0 4px rgba(245, 158, 11, .28), 0 0 0 5px rgba(245, 158, 11, .14); }
.workshop-map-stage.pending-drag-active .workshop-line-placement-dock { backdrop-filter: none; }
.workshop-map-stage::before { position: absolute; inset: 13px; content: ''; border: 1px dashed rgba(66, 95, 108, .22); border-radius: 7px; pointer-events: none; }
.workshop-map-axis { position: absolute; z-index: 0; background: rgba(29, 29, 31, .22); pointer-events: none; }
.workshop-map-axis-x { top: 50%; right: 0; left: 0; height: 1px; }
.workshop-map-axis-z { top: 0; bottom: 0; left: 50%; width: 1px; }
.workshop-map-origin { position: absolute; z-index: 1; top: calc(50% + 6px); left: calc(50% + 7px); color: #86868b; font-size: 10px; pointer-events: none; }
.workshop-map-line { position: absolute; z-index: 3; overflow: hidden; min-width: 46px; min-height: 42px; padding: 0; color: #244654; background: rgba(173, 202, 214, .74); border: 1px solid #82a8b9; border-radius: 9px; box-shadow: 0 6px 18px rgba(40, 68, 81, .14); cursor: grab; transform-origin: center; touch-action: none; transition: box-shadow .16s ease, border-color .16s ease, background .16s ease; }
.workshop-map-line:hover { z-index: 4; border-color: #4b8198; box-shadow: 0 9px 22px rgba(40, 68, 81, .2); }
.workshop-map-line.selected { z-index: 5; color: #fff; background: rgba(35, 78, 97, .9); border-color: #173f51; box-shadow: 0 0 0 3px rgba(0, 113, 227, .22), 0 10px 26px rgba(24, 59, 75, .26); }
.workshop-map-line.dragging { cursor: grabbing; transition: none; }
.workshop-map-line.outside { border-color: #ff3b30; box-shadow: 0 0 0 3px rgba(255, 59, 48, .2); }
.workshop-map-line header { position: absolute; z-index: 2; top: 5px; right: 7px; left: 7px; display: flex; align-items: center; justify-content: space-between; gap: 8px; pointer-events: none; }
.workshop-map-line header strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workshop-map-line header span { flex: 0 0 auto; font-size: 9px; opacity: .75; }
.workshop-map-track { position: absolute; z-index: 1; height: 3px; border-radius: 999px; pointer-events: none; transform: translateY(-50%); }
.workshop-map-track.lane { background: #4d91ad; box-shadow: 0 0 0 2px rgba(89, 146, 169, .16); }
.workshop-map-track.rail { height: 2px; background: #bd842b; box-shadow: 0 -3px #bd842b, 0 3px #bd842b; }
.workshop-map-line.selected .workshop-map-track.lane { background: #8dd9f3; }
.workshop-map-line.selected .workshop-map-track.rail { background: #ffd36a; box-shadow: 0 -3px #ffd36a, 0 3px #ffd36a; }
.workshop-line-placement-dock { position: absolute; z-index: 9; top: 14px; right: 14px; width: min(230px, calc(100% - 28px)); max-height: calc(100% - 28px); overflow: hidden; color: #364152; background: rgba(255, 255, 255, .96); border: 1px solid rgba(229, 139, 0, .42); border-radius: 13px; box-shadow: 0 13px 34px rgba(48, 57, 66, .2); backdrop-filter: blur(10px); }
.workshop-line-placement-dock > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 12px; background: linear-gradient(135deg, #fff8e8, #fff1cc); border-bottom: 1px solid #f5d390; }
.workshop-line-placement-dock > header div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.workshop-line-placement-dock > header strong { color: #704000; font-size: 12px; }
.workshop-line-placement-dock > header span { color: #9a6a21; font-size: 10px; }
.workshop-line-placement-dock > header b { display: grid; flex: 0 0 26px; width: 26px; height: 26px; place-items: center; color: #fff; background: #dd8400; border-radius: 8px; font-size: 11px; }
.workshop-line-placement-list { display: grid; max-height: 260px; padding: 8px; overflow-y: auto; gap: 7px; }
.workshop-line-placement-card { display: flex; min-width: 0; padding: 9px 8px; align-items: center; gap: 8px; color: #344054; background: #fff; border: 1px solid #e5e7eb; border-radius: 9px; box-shadow: 0 3px 9px rgba(16, 24, 40, .05); cursor: grab; user-select: none; touch-action: none; transition: border-color .16s ease, box-shadow .16s ease, transform .16s ease, opacity .16s ease; }
.workshop-line-placement-card:hover, .workshop-line-placement-card.attention { border-color: #e58b00; box-shadow: 0 0 0 3px rgba(229, 139, 0, .13), 0 7px 16px rgba(91, 56, 0, .1); transform: translateY(-1px); }
.workshop-line-placement-card.dragging { opacity: .48; cursor: grabbing; }
.workshop-line-placement-handle { flex: 0 0 auto; color: #b36a00; font-size: 19px; line-height: 1; }
.workshop-line-placement-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.workshop-line-placement-copy strong { overflow: hidden; color: #344054; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workshop-line-placement-copy small { color: #98a2b3; font-size: 9px; }
.workshop-line-placement-card em { flex: 0 0 auto; color: #9a5500; font-size: 9px; font-style: normal; font-weight: 800; }
.workshop-pending-line-ghost { position: fixed; z-index: 10000; top: 0; left: 0; display: flex; width: 220px; min-width: 0; padding: 10px 10px; align-items: center; gap: 8px; color: #344054; background: rgba(255, 255, 255, .98); border: 1px solid #e5a12f; border-radius: 10px; box-shadow: 0 15px 38px rgba(91, 56, 0, .24); pointer-events: none; user-select: none; opacity: .92; will-change: transform; }
.workshop-pending-line-ghost.can-drop { color: #17542f; border-color: #12b76a; box-shadow: 0 0 0 4px rgba(18, 183, 106, .13), 0 15px 38px rgba(19, 78, 47, .22); }
.workshop-pending-line-ghost em { flex: 0 0 auto; color: #9a5500; font-size: 9px; font-style: normal; font-weight: 800; }
.workshop-pending-line-ghost.can-drop em { color: #087443; }
:global(body.workshop-pending-line-dragging),
:global(body.workshop-pending-line-dragging *) { cursor: grabbing !important; user-select: none !important; }
.workshop-map-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 8px; color: #6e6e73; text-align: center; }
.workshop-map-empty strong { color: #1d1d1f; font-size: 16px; }
.workshop-map-empty span { margin-bottom: 8px; font-size: 12px; }
.workshop-map-legend { position: absolute; right: 28px; bottom: 12px; display: flex; gap: 14px; color: #6e6e73; font-size: 10px; }
.workshop-map-legend span { display: flex; align-items: center; gap: 5px; }
.workshop-map-legend i { display: block; width: 18px; height: 3px; border-radius: 999px; background: #4d91ad; }
.workshop-map-legend i.rail { height: 2px; background: #bd842b; box-shadow: 0 -3px #bd842b, 0 3px #bd842b; }
.workshop-map-legend i.center { height: 1px; background: rgba(29, 29, 31, .35); }
.workshop-map-inspector { padding: 18px; background: #fff; border-left: 1px solid #e5e5e7; }
.workshop-map-line-select, .workshop-map-input-grid label { display: flex; flex-direction: column; gap: 6px; color: #515154; font-size: 11px; font-weight: 600; }
.workshop-map-line-select .input { width: 100%; }
.workshop-map-footprint-card { display: flex; margin: 14px 0; padding: 14px; flex-direction: column; gap: 4px; color: #6e6e73; background: #f5f5f7; border-radius: 11px; }
.workshop-map-footprint-card span { font-size: 10px; text-transform: uppercase; }
.workshop-map-footprint-card strong { color: #1d1d1f; font-size: 18px; }
.workshop-map-footprint-card small { font-size: 10px; }
.workshop-map-input-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.workshop-map-input-grid .input { width: 100%; min-width: 0; box-sizing: border-box; }
.workshop-map-metrics { margin-top: 16px; padding-top: 14px; border-top: 1px solid #e8e8ed; }
.workshop-map-metrics h4 { margin: 0 0 10px; color: #1d1d1f; font-size: 12px; }
.workshop-map-metric-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.workshop-map-metric-grid span { display: flex; justify-content: space-between; gap: 6px; padding: 8px; color: #86868b; background: #f8f8fa; border-radius: 7px; font-size: 10px; }
.workshop-map-metric-grid strong { color: #3a3a3c; }
.workshop-map-metrics p { margin: 10px 0 0; padding: 9px; color: #3b6d46; background: #eef8f0; border-radius: 7px; font-size: 10px; line-height: 1.45; }
.workshop-map-metrics p.danger { color: #b42318; background: #fff0ef; }
.workshop-line-detail-button { width: 100%; margin-top: 14px; }
.workshop-map-inspector-empty { display: grid; height: 100%; min-height: 240px; place-items: center; color: #86868b; font-size: 12px; text-align: center; }
.workshop-loading-state { display: grid; min-height: 280px; margin-top: 14px; place-items: center; color: #667085; background: #f8fafb; border: 1px dashed #cfd8df; border-radius: 14px; font-size: 13px; }
.line-transform-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 12px; }
.line-transform-grid .input { width: 100%; min-width: 0; box-sizing: border-box; }
.template-pack-library { margin: 18px 0 20px; padding: 16px; border: 1px solid #dfe4ea; border-radius: 14px; background: linear-gradient(135deg, #f8fbfd, #f4f7fa); }
.template-pack-library-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.template-pack-library-heading strong, .template-pack-library-heading small { display: block; }
.template-pack-library-heading strong { color: #1d2939; font-size: 15px; }
.template-pack-library-heading small { margin-top: 4px; color: #667085; font-size: 11px; }
.template-pack-readonly { flex: 0 0 auto; padding: 5px 9px; color: #175cd3; background: #eff8ff; border: 1px solid #b2ddff; border-radius: 999px; font-size: 10px; font-weight: 600; }
.template-pack-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.template-pack-card { min-width: 0; padding: 12px; border: 1px solid #e4e7ec; border-radius: 10px; background: #fff; }
.template-pack-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.template-pack-card-top strong { min-width: 0; overflow: hidden; color: #344054; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.template-pack-card-top code { flex: 0 0 auto; color: #98a2b3; font-size: 9px; }
.template-pack-card p { min-height: 34px; margin: 8px 0; color: #667085; font-size: 10px; line-height: 1.55; }
.template-pack-stats { display: flex; flex-wrap: wrap; gap: 6px; color: #475467; font-size: 10px; }
.template-pack-stats span { padding: 4px 6px; border-radius: 5px; background: #f2f4f7; }
@media (max-width: 1180px) {
    .workshop-spatial-heading { flex-direction: column; }
    .workshop-spatial-grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
    .workshop-map-layout { grid-template-columns: minmax(0, 1fr); }
    .workshop-map-inspector { border-top: 1px solid #e5e5e7; border-left: 0; }
    .workshop-map-toolbar { flex-direction: column; }
}
@media (max-width: 720px) {
    .workshop-management-heading, .workshop-step-footer { align-items: flex-start; flex-direction: column; }
    .workshop-step-nav { display: flex; overflow-x: auto; }
    .workshop-step-nav > button { flex: 0 0 230px; }
    .workshop-step-context { align-items: flex-start; flex-wrap: wrap; }
    .spatial-rule-banner { align-items: flex-start; flex-direction: column; }
    .workshop-spatial-grid, .line-transform-grid { grid-template-columns: 1fr; }
    .workshop-map-board { padding-right: 14px; padding-left: 38px; }
    .workshop-map-toolbar { padding: 15px; }
    .canvas-save-reminder { align-items: flex-start; flex-wrap: wrap; margin-right: 10px; margin-left: 10px; }
    .canvas-save-reminder-actions { width: 100%; padding-left: 24px; justify-content: flex-end; }
    .line-placement-pending-card { align-items: flex-start; }
    .line-placement-pending-action { display: none; }
    .workshop-line-placement-dock { top: 10px; right: 10px; width: min(220px, calc(100% - 20px)); }
    .template-pack-grid { grid-template-columns: 1fr; }
}
</style>
