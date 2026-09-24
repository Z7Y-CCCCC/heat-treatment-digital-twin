// 系统设置模块:连接设置、Unity 画质、桌面运行、引擎与 PLC 状态、数据库连接、数据库备份与整站灾备。
// loadSettings 是本模块的加载编排中心(顺带拉取运行配置、数据库配置与引擎状态)。
// 数据库/灾备的恢复与切换需要重载全站数据,这些跨模块的 load 函数通过参数惰性注入。

import { ref, reactive, computed, watch, nextTick, onScopeDispose } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { API_BASE } from '../../../runtime/backendEndpoint.js'
import { adminFetch as fetch } from '../../../runtime/adminSession.js'
import { normalizePlcOptions, normalizePlcProtocol } from '../../../config/plcProtocols.js'

function createDefaultNativeEnvironmentConfig() {
    return {
        version: 3,
        preset: 'neutral_factory',
        sceneBrightness: 1.05,
        ambientIntensity: 1.05,
        keyLightIntensity: 1.25,
        fillLightIntensity: 0.58,
        reflectionIntensity: 0.96,
        postExposure: 0.34,
        contrast: 1,
        saturation: 0,
        bloomIntensity: 0.02,
        vignetteIntensity: 0.02,
        fogEnabled: true,
        fogStart: 120,
        fogEnd: 430,
        showGrid: true,
        showBackdrop: false,
        showWalls: false,
        wallEditorWidth: 100,
        wallEditorDepth: 80,
        walls: [],
        skyColor: '#696969',
        horizonColor: '#464646',
        fogColor: '#565656',
        keyLightColor: '#F2F2F2',
        fillLightColor: '#EAEAEA',
        floorColor: '#5B5B5B',
        gridColor: '#777777',
        wallColor: '#5A5A5A',
        frameColor: '#9A9A9A'
    }
}

const NATIVE_ENVIRONMENT_PRESETS = [
    {
        value: 'neutral_factory',
        label: '中性真实厂房',
        tag: '现场监控',
        description: '开放式中性灰环境，导入厂房保留原始材质，默认不显示程序围墙，适合长时间运行和现场监控。',
        config: {
            ...createDefaultNativeEnvironmentConfig(),
            preset: 'neutral_factory',
            sceneBrightness: 1.05,
            ambientIntensity: 1.05,
            keyLightIntensity: 1.25,
            fillLightIntensity: 0.58,
            reflectionIntensity: 0.96,
            postExposure: 0.34,
            contrast: 1,
            saturation: 0,
            bloomIntensity: 0.02,
            vignetteIntensity: 0.02,
            fogStart: 120,
            fogEnd: 430,
            skyColor: '#696969',
            horizonColor: '#464646',
            fogColor: '#565656',
            floorColor: '#5B5B5B',
            gridColor: '#777777',
            wallColor: '#5A5A5A',
            frameColor: '#9A9A9A'
        }
    },
    {
        value: 'custom',
        label: '自定义参数',
        tag: '工程师配置',
        description: '工程师手动调整后的组合。',
        config: null
    }
]

const ACTIVE_NATIVE_ENVIRONMENT_PRESETS = new Set(['neutral_factory', 'custom'])

function normalizeEnvironmentColor(value, fallback) {
    const text = String(value || '').trim().toUpperCase()
    return /^#[0-9A-F]{6}$/.test(text) ? text : fallback
}

function normalizeOptionalEnvironmentColor(value) {
    const text = String(value || '').trim().toUpperCase()
    return /^#[0-9A-F]{6}$/.test(text) ? text : ''
}

function normalizeWallStyle(value) {
    const style = String(value || '').trim().toLowerCase()
    return ['solid', 'frame', 'solid_frame'].includes(style) ? style : 'solid_frame'
}

function normalizeWallSegment(value, index) {
    const source = value && typeof value === 'object' ? value : {}
    return {
        id: String(source.id || `wall_${index + 1}`).trim() || `wall_${index + 1}`,
        name: String(source.name || `围墙 ${index + 1}`).trim() || `围墙 ${index + 1}`,
        workshopId: String(source.workshopId || source.workshop_id || '').trim(),
        coordinateSpace: 'workshop_local',
        enabled: dashboardBoolean(source.enabled, true),
        style: normalizeWallStyle(source.style),
        x: dashboardNumber(source.x, 0, -1000, 1000),
        baseY: dashboardNumber(source.baseY, 0, -10, 50),
        z: dashboardNumber(source.z, 0, -1000, 1000),
        length: dashboardNumber(source.length, 30, 1, 500),
        height: dashboardNumber(source.height, 6, 0.5, 100),
        thickness: dashboardNumber(source.thickness, 0.3, 0.05, 5),
        rotationY: dashboardNumber(source.rotationY, 0, -180, 180),
        color: normalizeOptionalEnvironmentColor(source.color),
        frameColor: normalizeOptionalEnvironmentColor(source.frameColor)
    }
}

function normalizeNativeEnvironmentConfig(value) {
    const defaults = createDefaultNativeEnvironmentConfig()
    const source = parseDashboardSource(value)
    const fogStart = dashboardNumber(source.fogStart, defaults.fogStart, 0, 500)
    return {
        version: 3,
        preset: ACTIVE_NATIVE_ENVIRONMENT_PRESETS.has(String(source.preset || '').trim())
            ? String(source.preset).trim()
            : defaults.preset,
        sceneBrightness: dashboardNumber(source.sceneBrightness, defaults.sceneBrightness, 0.8, 1.6),
        ambientIntensity: dashboardNumber(source.ambientIntensity, defaults.ambientIntensity, 0.2, 2.5),
        keyLightIntensity: dashboardNumber(source.keyLightIntensity, defaults.keyLightIntensity, 0, 3),
        fillLightIntensity: dashboardNumber(source.fillLightIntensity, defaults.fillLightIntensity, 0, 2.5),
        reflectionIntensity: dashboardNumber(source.reflectionIntensity, defaults.reflectionIntensity, 0, 2),
        postExposure: dashboardNumber(source.postExposure, defaults.postExposure, -1.5, 2),
        contrast: dashboardNumber(source.contrast, defaults.contrast, -30, 30),
        saturation: dashboardNumber(source.saturation, defaults.saturation, -30, 30),
        bloomIntensity: dashboardNumber(source.bloomIntensity, defaults.bloomIntensity, 0, 1),
        vignetteIntensity: dashboardNumber(source.vignetteIntensity, defaults.vignetteIntensity, 0, 0.5),
        fogEnabled: dashboardBoolean(source.fogEnabled, defaults.fogEnabled),
        fogStart,
        fogEnd: dashboardNumber(source.fogEnd, defaults.fogEnd, fogStart + 10, 1000),
        showGrid: dashboardBoolean(source.showGrid, defaults.showGrid),
        showBackdrop: false,
        showWalls: dashboardBoolean(source.showWalls, defaults.showWalls),
        wallEditorWidth: dashboardNumber(source.wallEditorWidth, defaults.wallEditorWidth, 20, 1000),
        wallEditorDepth: dashboardNumber(source.wallEditorDepth, defaults.wallEditorDepth, 20, 1000),
        walls: (Array.isArray(source.walls) ? source.walls : []).slice(0, 64).map(normalizeWallSegment),
        skyColor: normalizeEnvironmentColor(source.skyColor, defaults.skyColor),
        horizonColor: normalizeEnvironmentColor(source.horizonColor, defaults.horizonColor),
        fogColor: normalizeEnvironmentColor(source.fogColor, defaults.fogColor),
        keyLightColor: normalizeEnvironmentColor(source.keyLightColor, defaults.keyLightColor),
        fillLightColor: normalizeEnvironmentColor(source.fillLightColor, defaults.fillLightColor),
        floorColor: normalizeEnvironmentColor(source.floorColor, defaults.floorColor),
        gridColor: normalizeEnvironmentColor(source.gridColor, defaults.gridColor),
        wallColor: normalizeEnvironmentColor(source.wallColor, defaults.wallColor),
        frameColor: normalizeEnvironmentColor(source.frameColor, defaults.frameColor)
    }
}

function dashboardNumber(value, fallback, minimum, maximum) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(maximum, Math.max(minimum, parsed))
}

function dashboardBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase())
}

function parseDashboardSource(value) {
    if (!value) return {}
    if (typeof value === 'object' && !Array.isArray(value)) return value
    try {
        const parsed = JSON.parse(String(value))
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
        return {}
    }
}

export function useSystemSettings({
    alert,
    confirm,
    loadWorkshops,
    loadLines,
    loadDevices,
    loadModels,
    loadPlatform,
    ensureComposerSelection,
    syncComposerDraftFromSelection,
    scheduleComposerPreview
}) {
    // ============ 连接设置 ============
    const defaultSettings = {
        factory_name: '',
        data_mode: 'integrated_plc',
        realtime_stale_ms: '6000',
        // 视角模式
        camera_mode: 'auto',
        native_quality_profile: 'auto'
    }
    const settings = reactive({ ...defaultSettings })
    const nativeEnvironmentConfig = reactive(createDefaultNativeEnvironmentConfig())
    const nativeEnvironmentSaving = ref(false)
    const nativeEnvironmentMessage = ref('')
    const nativeEnvironmentPresetOptions = NATIVE_ENVIRONMENT_PRESETS.map(({ value, label, tag, description, config }) => ({
        value,
        label,
        tag,
        description,
        preview: config ? {
            sceneBrightness: config.sceneBrightness,
            postExposure: config.postExposure,
            contrast: config.contrast,
            saturation: config.saturation,
            bloomIntensity: config.bloomIntensity,
            vignetteIntensity: config.vignetteIntensity,
            reflectionIntensity: config.reflectionIntensity,
            fogEnabled: config.fogEnabled,
            fogEnd: config.fogEnd,
            showGrid: config.showGrid,
            skyColor: config.skyColor,
            horizonColor: config.horizonColor,
            fogColor: config.fogColor,
            keyLightColor: config.keyLightColor,
            fillLightColor: config.fillLightColor,
            floorColor: config.floorColor,
            gridColor: config.gridColor,
            wallColor: config.wallColor,
            frameColor: config.frameColor
        } : null
    }))
    // ============ 桌面运行 ============
    const runtimeSettings = reactive({
        auto_start_enabled: true,
        auto_start_supported: false,
        packaged: false
    })
    const runtimeSaving = ref(false)
    const runtimeMessage = ref('')
    let runtimeRefreshTimer = null
    let runtimeSettingsDisposed = false
    let runtimeRequestSeq = 0
    let runtimeLoadInFlight = false
    let runtimeSavedSnapshot = { ...runtimeSettings }
    const runtimeEditableFields = new Set(['auto_start_enabled'])

    function applyRuntimePayload(result, expectedDraft = runtimeSavedSnapshot) {
        const next = {
            auto_start_enabled: result.auto_start_enabled !== false,
            auto_start_supported: result.auto_start_supported === true,
            packaged: result.packaged === true
        }
        for (const [key, value] of Object.entries(next)) {
            // Poll live status without overwriting a user's unsaved form edits.
            if (!runtimeEditableFields.has(key) || runtimeSettings[key] === expectedDraft[key]) runtimeSettings[key] = value
        }
        runtimeSavedSnapshot = next
    }

    async function loadRuntimeSettings({ silent = false } = {}) {
        if (runtimeSettingsDisposed || runtimeSaving.value || (silent && runtimeLoadInFlight)) return null
        const requestSeq = ++runtimeRequestSeq
        runtimeLoadInFlight = true
        try {
            const result = await adminApi.getRuntimeSettings()
            if (runtimeSettingsDisposed || requestSeq !== runtimeRequestSeq) return null
            if (result?.error) throw new Error(result.error)
            applyRuntimePayload(result)
            return result
        } catch (error) {
            if (!runtimeSettingsDisposed && requestSeq === runtimeRequestSeq && !silent) runtimeMessage.value = `运行配置读取失败：${error.message || error}`
            return null
        } finally {
            if (requestSeq === runtimeRequestSeq) runtimeLoadInFlight = false
        }
    }

    async function saveRuntimeSettings() {
        if (runtimeSaving.value || runtimeSettingsDisposed) return
        runtimeSaving.value = true
        runtimeRequestSeq += 1
        runtimeLoadInFlight = false
        runtimeMessage.value = '正在保存运行配置...'
        const submitted = { ...runtimeSettings }
        try {
            const result = await adminApi.saveRuntimeSettings({
                auto_start_enabled: submitted.auto_start_enabled
            })
            if (runtimeSettingsDisposed) return
            if (result?.error) throw new Error(result.error)
            applyRuntimePayload(result, submitted)
            runtimeMessage.value = '运行配置已保存。'
        } catch (error) {
            runtimeMessage.value = `运行配置保存失败：${error.message || error}`
        } finally {
            runtimeSaving.value = false
        }
    }

    function startRuntimeRefresh() {
        if (runtimeRefreshTimer) clearInterval(runtimeRefreshTimer)
        runtimeRefreshTimer = setInterval(() => loadRuntimeSettings({ silent: true }), 5000)
        runtimeRefreshTimer.unref?.()
    }

    function stopRuntimeRefresh() {
        if (runtimeRefreshTimer) clearInterval(runtimeRefreshTimer)
        runtimeRefreshTimer = null
        runtimeRequestSeq += 1
        runtimeLoadInFlight = false
    }

    onScopeDispose(() => {
        runtimeSettingsDisposed = true
        stopRuntimeRefresh()
    })

    async function loadSettings() {
        const s = await adminApi.getSettings()
        if (s.data_mode !== 'simulation') s.data_mode = 'integrated_plc'
        const normalizedEnvironment = normalizeNativeEnvironmentConfig(s.native_environment_config)
        for (const key of Object.keys(nativeEnvironmentConfig)) delete nativeEnvironmentConfig[key]
        Object.assign(nativeEnvironmentConfig, normalizedEnvironment)
        const loadedSettings = { ...s }
        delete loadedSettings.native_environment_config
        delete loadedSettings.native_dashboard_config
        // 旧版网页大屏配置仅保留在历史数据库中，不再进入后台表单或保存请求。
        delete loadedSettings.display_mode
        delete loadedSettings.render_profile
        delete loadedSettings.render_target_fps
        delete loadedSettings.render_scale
        delete loadedSettings.render_antialias
        delete loadedSettings.render_label_fps
        for (const key of Object.keys(settings)) delete settings[key]
        Object.assign(settings, defaultSettings, loadedSettings)
        if (!['auto', 'integrated_gpu', 'balanced', 'showcase'].includes(String(settings.native_quality_profile))) {
            settings.native_quality_profile = 'auto'
        }
        await loadRuntimeSettings({ silent: true })
        await loadDatabaseConfig()
        // 同时获取引擎状态
        loadEngineStatus()
    }

    const engineStatus = reactive({
        mode: null,
        plcStatus: { status: 'unknown', message: '未知' },
        collectorStatus: { status: 'unknown', message: '未知' }
    })
    const plcStatusLabels = {
        connected: '已连接',
        connecting: '连接中',
        retrying: '重连中',
        error: '异常',
        disabled: '未启用',
        no_points: '无点位',
        unconfigured: '未配置',
        unsupported: '暂不支持',
        stopped: '已停止',
        idle: '等待'
    }
    const plcStatusByDevice = computed(() => {
        const map = {}
        const statuses = engineStatus.plcStatus?.devices || []
        statuses.forEach(status => {
            map[status.deviceId] = status
        })
        return map
    })

    function formatPlcDeviceStatus(device) {
        if (!Number(device.plc_enabled || 0)) return '未启用'
        const status = plcStatusByDevice.value[device.id]
        if (!status) return device.plc_ip ? '等待采集' : '未配置'
        if (status.status === 'unconfigured' && device.plc_ip && !status.plc_ip) return '配置已更新'
        return plcStatusLabels[status.status] || status.status || '未知'
    }

    function formatPlcEndpoint(device) {
        if (!Number(device.plc_enabled || 0)) return '未启用'
        const status = plcStatusByDevice.value[device.id]
        if (status?.endpoint) return status.endpoint
        if (!device.plc_ip) return '未填写 IP'
        const protocol = normalizePlcProtocol(device.plc_protocol || 'S7')
        const options = normalizePlcOptions(protocol, device.plc_options)
        if (protocol === 'S7') return `S7 ${device.plc_ip}:${device.plc_port || 102} (Rack=${device.plc_rack ?? 0}, Slot=${device.plc_slot ?? 1})`
        if (protocol === 'MODBUS_TCP') return `Modbus TCP ${device.plc_ip}:${device.plc_port || 502} (Unit ID=${options.unitId})`
        if (protocol === 'OPC_UA') return `OPC UA ${device.plc_ip}:${device.plc_port || 4840}${options.endpointPath || ''}`
        return `${protocol} ${device.plc_ip}:${device.plc_port || 102}`
    }

    function formatPlcIntervals(status) {
        const intervals = status?.intervals || []
        return intervals.length ? intervals.map(ms => `${ms}ms`).join(' / ') : '-'
    }

    function formatPlcTime(value) {
        const timestamp = Number(value)
        if (!Number.isFinite(timestamp) || timestamp <= 0) return '-'
        return new Date(timestamp).toLocaleTimeString()
    }

    const databaseConfig = reactive({
        type: 'mysql',
        host: '127.0.0.1',
        port: 3307,
        user: 'root',
        password: '******',
        database: 'dongtai_daping',
        filename: '',
        encrypt: false,
        trustServerCertificate: true
    })
    const databaseTestStatus = ref('')
    const databaseSaving = ref(false)
    const databaseBackupBusy = ref(false)
    const databaseBackupPolicySaving = ref(false)
    const databaseBackupMessage = ref('')
    const databaseBackupPolicy = reactive({ retentionDays: 30 })
    const databaseBackupRetentionPresets = [7, 30, 90, 180, 365]
    const databaseBackupStatus = reactive({
        supported: false,
        automatic: false,
        intervalMs: 0,
        retention: 0,
        retentionDays: 30,
        retentionDaysMin: 1,
        retentionDaysMax: 3650,
        totalBackupBytes: 0,
        expiredCount: 0,
        newestBackup: null,
        oldestBackup: null,
        lastCleanup: null,
        directory: '',
        lastBackup: null,
        lastRecovery: null,
        backups: []
    })

    function assignDatabaseBackupStatus(status = {}) {
        Object.assign(databaseBackupStatus, status, { backups: status.backups || [] })
        const retentionDays = Number(status.retentionDays)
        if (Number.isFinite(retentionDays)) databaseBackupPolicy.retentionDays = retentionDays
    }
    const siteBackupFileInput = ref(null)
    const siteBackupBusy = ref(false)
    const siteBackupMessage = ref('')
    const siteBackupStatus = reactive({
        supported: false,
        retention: 0,
        externalCopyRequired: true,
        backups: []
    })
    const siteBackupConfig = reactive({
        autoEnabled: true,
        intervalHours: 24,
        mirrorDirectory: ''
    })
    const siteBackupConfigSaving = ref(false)
    const databaseDefaultPorts = {
        mysql: 3307,
        postgres: 5432,
        sqlserver: 1433
    }
    function defaultDataSourceDraft() {
        return {
            id: '', name: '', sourceType: 'database', type: 'mysql', host: '127.0.0.1', port: 3306,
            user: '', password: '', database: '', filename: '', defaultSchema: '',
            encrypt: false, trustServerCertificate: true, enabled: true, queryTimeoutMs: 8000,
            baseUrl: '', healthPath: '/health', method: 'GET', authType: 'none',
            apiKeyHeader: 'X-API-Key', apiKey: '', token: '', requestTimeoutMs: 8000
        }
    }
    const emptyDataSourceHealth = () => ({
        status: '', message: '', responseTimeMs: null, httpStatus: null, checkedAt: null
    })
    const dataSourceConnections = ref([])
    const dataSourceEditor = reactive(defaultDataSourceDraft())
    const dataSourceBusy = ref(false)
    const dataSourceMessage = ref('')
    const dataSourceTestHealth = reactive(emptyDataSourceHealth())
    let dataSourceTestFingerprint = ''
    let dataSourceHealthToken = ''
    let dataSourceSavedFingerprint = ''
    let dataSourceDraftVersion = 0
    let dataSourceEditorSession = 0
    let dataSourceEditorHydrating = false
    let dataSourceLoadSequence = 0
    const dataSourceBackupBusy = ref(false)
    const dataSourceBackupMessage = ref('')
    const dataSourceBackupConfig = reactive({
        autoEnabled: true,
        startupEnabled: true,
        scheduledEnabled: true,
        shutdownEnabled: true,
        intervalHours: 6,
        retention: 10,
        selectedConnectionIds: ['primary']
    })
    const dataSourceBackupStatus = reactive({
        running: false,
        connections: [],
        lastBackupRun: null,
        lastError: null
    })

    function dataSourcePayload(draft = dataSourceEditor) {
        const common = {
            id: draft.id, name: draft.name, sourceType: draft.sourceType,
            type: draft.sourceType === 'http_api' ? 'http_api' : draft.type, enabled: draft.enabled
        }
        // Only submit editable fields belonging to this source/auth type. In particular,
        // metadata and credentials from a previously selected source must never leak in.
        const fields = draft.sourceType === 'http_api'
            ? ['baseUrl', 'healthPath', 'method', 'authType', 'requestTimeoutMs', ...({
                api_key: ['apiKeyHeader', 'apiKey'], bearer: ['token'], basic: ['user', 'password']
            }[draft.authType] || [])]
            : ['host', 'port', 'user', 'password', 'database', 'filename', 'defaultSchema',
                'encrypt', 'trustServerCertificate', 'queryTimeoutMs']
        for (const field of fields) common[field] = draft[field]
        return common
    }

    function dataSourceDraftFingerprint() {
        return JSON.stringify(dataSourcePayload())
    }

    function dataSourceTimeoutError() {
        const timeout = Number(dataSourceEditor.sourceType === 'http_api'
            ? dataSourceEditor.requestTimeoutMs : dataSourceEditor.queryTimeoutMs)
        return Number.isInteger(timeout) && timeout >= 1000 && timeout <= 60000
            ? '' : '超时请输入 1000–60000 毫秒之间的整数。'
    }

    function clearDataSourceHealth() {
        Object.assign(dataSourceTestHealth, emptyDataSourceHealth())
        dataSourceTestFingerprint = ''
        dataSourceHealthToken = ''
    }

    function replaceDataSourceDraft(connection = {}) {
        dataSourceEditorHydrating = true
        try {
            const draft = defaultDataSourceDraft()
            for (const key of Object.keys(draft)) {
                if (connection[key] !== undefined && connection[key] !== null) draft[key] = connection[key]
            }
            draft.sourceType = connection.sourceType || (connection.type === 'http_api' ? 'http_api' : 'database')
            if (draft.sourceType === 'http_api') draft.type = 'http_api'
            for (const key of Object.keys(dataSourceEditor)) {
                if (!(key in draft)) delete dataSourceEditor[key]
            }
            Object.assign(dataSourceEditor, draft)
        } finally {
            dataSourceEditorHydrating = false
        }
        dataSourceDraftVersion += 1
        dataSourceEditorSession += 1
        clearDataSourceHealth()
        dataSourceSavedFingerprint = connection.id ? dataSourceDraftFingerprint() : ''
    }

    function resetDataSourceEditor() {
        replaceDataSourceDraft()
        dataSourceMessage.value = ''
    }

    function editDataSource(connection) {
        if (!connection || connection.primary) return
        replaceDataSourceDraft(connection)
        Object.assign(dataSourceTestHealth, emptyDataSourceHealth(), connection.health || {})
        dataSourceMessage.value = `正在编辑：${connection.name}`
    }

    async function loadDataSources({ silent = false, connectionsOnly = false } = {}) {
        if (runtimeSettingsDisposed) return
        const sequence = ++dataSourceLoadSequence
        try {
            const result = await adminApi.getDataSources()
            if (runtimeSettingsDisposed || sequence !== dataSourceLoadSequence) return
            if (result?.error || !Array.isArray(result?.connections)) throw new Error(result?.error || '后端没有返回数据源列表')
            dataSourceConnections.value = result.connections
            if (connectionsOnly) return
            Object.assign(dataSourceBackupConfig, result.backup || {})
            Object.assign(dataSourceBackupStatus, result.backupStatus || {}, {
                connections: result.backupStatus?.connections || []
            })
            if (dataSourceEditor.id && !dataSourceBusy.value && !dataSourceTestFingerprint
                && dataSourceDraftFingerprint() === dataSourceSavedFingerprint) {
                const current = dataSourceConnections.value.find(item => item.id === dataSourceEditor.id)
                if (current && JSON.stringify(dataSourcePayload(current)) === dataSourceSavedFingerprint) {
                    Object.assign(dataSourceTestHealth, emptyDataSourceHealth(), current.health || {})
                } else {
                    clearDataSourceHealth()
                    dataSourceMessage.value = '列表中的数据源配置已变更，请重新选择数据源。'
                }
            }
        } catch (e) {
            if (!silent && !runtimeSettingsDisposed && sequence === dataSourceLoadSequence) dataSourceMessage.value = `数据源读取失败：${e.message || e}`
        }
    }

    async function testExternalDataSource() {
        if (dataSourceBusy.value || runtimeSettingsDisposed) return
        const validationError = dataSourceTimeoutError()
        if (validationError) {
            clearDataSourceHealth()
            Object.assign(dataSourceTestHealth, { status: 'config_error', message: validationError })
            dataSourceMessage.value = validationError
            return
        }
        const submitted = dataSourcePayload()
        const fingerprint = dataSourceDraftFingerprint()
        const version = dataSourceDraftVersion
        let refreshSavedHealth = false
        clearDataSourceHealth()
        dataSourceBusy.value = true
        dataSourceMessage.value = submitted.sourceType === 'http_api'
            ? '正在测试接口健康度...'
            : '正在以只读方式测试数据库连接...'
        try {
            const result = await adminApi.testDataSource(submitted)
            if (runtimeSettingsDisposed || version !== dataSourceDraftVersion) return
            if (result?.health) {
                Object.assign(dataSourceTestHealth, emptyDataSourceHealth(), result.health)
                dataSourceTestFingerprint = fingerprint
                dataSourceHealthToken = result.healthToken || ''
                refreshSavedHealth = Boolean(submitted.id)
            }
            if (!result?.success) throw new Error(result?.error || result?.health?.message || '连接失败')
            dataSourceMessage.value = submitted.sourceType === 'http_api'
                ? '接口健康检查通过。'
                : '数据库连接成功，可读取数据库结构。'
        } catch (e) {
            if (runtimeSettingsDisposed || version !== dataSourceDraftVersion) return
            dataSourceMessage.value = `${submitted.sourceType === 'http_api' ? '接口检查失败' : '连接失败'}：${e.message || e}`
            if (!dataSourceTestHealth.status) Object.assign(dataSourceTestHealth, emptyDataSourceHealth(), {
                status: 'check_failed', message: dataSourceMessage.value
            })
        } finally {
            // The backend only persists a test when it still matches the saved
            // configuration. Re-read that authoritative list rather than copying
            // an unsaved draft's health onto its saved card.
            if (refreshSavedHealth && !runtimeSettingsDisposed && version === dataSourceDraftVersion) {
                await loadDataSources({ silent: true, connectionsOnly: true })
            }
            dataSourceBusy.value = false
        }
    }

    async function saveExternalDataSource() {
        if (dataSourceBusy.value || runtimeSettingsDisposed) return
        if (!String(dataSourceEditor.name || '').trim()) {
            dataSourceMessage.value = '请填写连接名称'
            return
        }
        const validationError = dataSourceTimeoutError()
        if (validationError) {
            dataSourceMessage.value = validationError
            return
        }
        dataSourceBusy.value = true
        dataSourceLoadSequence += 1
        dataSourceMessage.value = '正在保存外部数据源...'
        const submitted = dataSourcePayload()
        const fingerprint = dataSourceDraftFingerprint()
        const version = dataSourceDraftVersion
        const session = dataSourceEditorSession
        try {
            const testedCurrentDraft = dataSourceTestFingerprint
                && dataSourceTestFingerprint === fingerprint
            const result = await adminApi.saveDataSource({
                ...submitted,
                healthToken: testedCurrentDraft ? dataSourceHealthToken : ''
            })
            if (runtimeSettingsDisposed) return
            if (!result?.success) throw new Error(result?.error || '保存失败')
            dataSourceLoadSequence += 1
            if (Array.isArray(result.connections)) dataSourceConnections.value = result.connections
            Object.assign(dataSourceBackupConfig, result.backup || {})
            if (version === dataSourceDraftVersion) {
                if (result.connection) editDataSource(result.connection)
                else resetDataSourceEditor()
                dataSourceMessage.value = `已保存：${result.connection?.name || submitted.name}`
            } else if (session === dataSourceEditorSession) {
                // A new connection gets its server id even if the user kept typing while
                // saving, so the next save updates it instead of creating a duplicate.
                if (!dataSourceEditor.id && result.connection?.id) dataSourceEditor.id = result.connection.id
                dataSourceMessage.value = `已保存：${result.connection?.name || submitted.name}；当前表单还有未保存的修改。`
            }
        } catch (e) {
            if (!runtimeSettingsDisposed && session === dataSourceEditorSession) dataSourceMessage.value = `保存失败：${e.message || e}`
        } finally {
            dataSourceBusy.value = false
        }
    }

    async function removeExternalDataSource(connection) {
        if (!connection?.id || connection.primary || dataSourceBusy.value || runtimeSettingsDisposed) return
        if (!(await confirm(`删除外部数据源“${connection.name}”？已发布大屏中使用它的组件会显示离线。`))) return
        if (dataSourceBusy.value || runtimeSettingsDisposed) return
        dataSourceBusy.value = true
        dataSourceLoadSequence += 1
        try {
            const result = await adminApi.deleteDataSource(connection.id)
            if (runtimeSettingsDisposed) return
            if (!result?.success) throw new Error(result?.error || '删除失败')
            dataSourceLoadSequence += 1
            if (Array.isArray(result.connections)) dataSourceConnections.value = result.connections
            Object.assign(dataSourceBackupConfig, result.backup || {})
            if (dataSourceEditor.id === connection.id) resetDataSourceEditor()
            dataSourceMessage.value = `已删除：${connection.name}`
        } catch (e) {
            if (!runtimeSettingsDisposed) dataSourceMessage.value = `删除失败：${e.message || e}`
        } finally {
            dataSourceBusy.value = false
        }
    }

    async function saveDataSourceBackupConfiguration() {
        if (dataSourceBackupBusy.value || runtimeSettingsDisposed) return
        dataSourceBackupBusy.value = true
        dataSourceBackupMessage.value = '正在保存数据库自动备份配置...'
        try {
            const result = await adminApi.saveDataSourceBackupConfig({ ...dataSourceBackupConfig })
            if (!result?.success) throw new Error(result?.error || '保存失败')
            Object.assign(dataSourceBackupConfig, result.config || {})
            Object.assign(dataSourceBackupStatus, result.status || {}, { connections: result.status?.connections || [] })
            dataSourceBackupMessage.value = '数据库自动压缩备份配置已保存。'
        } catch (e) {
            dataSourceBackupMessage.value = `自动备份配置保存失败：${e.message || e}`
        } finally {
            dataSourceBackupBusy.value = false
        }
    }

    async function runSelectedDatabaseBackups(connectionId = '') {
        if (dataSourceBackupBusy.value || runtimeSettingsDisposed) return
        dataSourceBackupBusy.value = true
        dataSourceBackupMessage.value = connectionId ? '正在备份所选数据库...' : '正在备份所有已勾选数据库...'
        try {
            const result = await adminApi.runDataSourceBackups(connectionId)
            if (result?.error || !Array.isArray(result?.results)) throw new Error(result?.error || '后端没有返回备份结果')
            Object.assign(dataSourceBackupStatus, result.status || {}, { connections: result.status?.connections || [] })
            const failed = (result.results || []).filter(item => !item.success)
            dataSourceBackupMessage.value = failed.length
                ? `备份完成，但有 ${failed.length} 个连接失败：${failed.map(item => item.error).join('；')}`
                : '已完成数据库压缩备份。'
            await loadDatabaseBackups()
        } catch (e) {
            dataSourceBackupMessage.value = `数据库备份失败：${e.message || e}`
        } finally {
            dataSourceBackupBusy.value = false
        }
    }

    async function loadDatabaseConfig() {
        try {
            const config = await adminApi.getDatabaseConfig()
            Object.assign(databaseConfig, config)
            await Promise.all([loadDatabaseBackups(), loadSiteBackups(), loadDataSources()])
        } catch (e) {
            databaseTestStatus.value = '数据库配置读取失败'
        }
    }

    async function loadSiteBackups() {
        try {
            const status = await adminApi.getSiteBackups()
            if (status?.error) throw new Error(status.error)
            Object.assign(siteBackupStatus, status, { backups: status.backups || [] })
            if (status.config) Object.assign(siteBackupConfig, status.config)
        } catch (e) {
            siteBackupMessage.value = `整站灾备状态读取失败：${e.message || e}`
        }
    }

    async function saveSiteBackupConfiguration() {
        siteBackupConfigSaving.value = true
        siteBackupMessage.value = '正在保存自动灾备配置...'
        try {
            const result = await adminApi.saveSiteBackupConfig(siteBackupConfig)
            if (result?.error || !result?.success) throw new Error(result?.error || '后端没有返回成功状态')
            Object.assign(siteBackupConfig, result.config || {})
            Object.assign(siteBackupStatus, result.status || {}, { backups: result.status?.backups || [] })
            siteBackupMessage.value = siteBackupConfig.mirrorDirectory
                ? `自动灾备已保存，将同步到：${siteBackupConfig.mirrorDirectory}`
                : '自动灾备已保存；尚未配置外部目录，电脑丢失时本机副本无法使用。'
        } catch (e) {
            siteBackupMessage.value = `自动灾备配置保存失败：${e.message || e}`
        } finally {
            siteBackupConfigSaving.value = false
        }
    }

    function downloadSiteBackup(backup) {
        const link = document.createElement('a')
        link.href = adminApi.siteBackupDownloadUrl(backup.filename)
        link.download = backup.filename
        document.body.appendChild(link)
        link.click()
        link.remove()
    }

    async function exportSiteBackup() {
        siteBackupBusy.value = true
        siteBackupMessage.value = '正在生成整站灾备包并校验文件，请稍候...'
        try {
            const result = await adminApi.createSiteBackup()
            if (result?.error || !result?.success || !result.backup?.filename) {
                throw new Error(result?.error || '后端没有返回灾备文件')
            }
            Object.assign(siteBackupStatus, result.status || {}, { backups: result.status?.backups || [] })
            siteBackupMessage.value = `灾备包已生成：${result.backup.filename}。请选择 U 盘、移动硬盘或 NAS 保存。`
            downloadSiteBackup(result.backup)
        } catch (e) {
            siteBackupMessage.value = `整站灾备导出失败：${e.message || e}`
        } finally {
            siteBackupBusy.value = false
        }
    }

    function chooseSiteBackupFile() {
        if (!siteBackupFileInput.value) return
        siteBackupFileInput.value.value = ''
        siteBackupFileInput.value.click()
    }

    async function restoreSiteBackupFromFile(event) {
        const file = event.target.files?.[0]
        if (!file) return
        if (!(await confirm(
            `确定从“${file.name}”恢复整套现场？\n\n当前数据库和上传模型会先创建回滚副本，恢复后将以灾备包中的配置为准。`,
            { title: '恢复整站灾备', type: 'warning', confirmText: '校验并恢复' }
        ))) return

        siteBackupBusy.value = true
        siteBackupMessage.value = '正在校验灾备包并恢复数据库、现场配置和上传模型...'
        try {
            const result = await adminApi.restoreSiteBackup(file)
            if (result?.error || !result?.success) throw new Error(result?.error || '后端没有返回成功状态')
            Object.assign(siteBackupStatus, result.status || {}, { backups: result.status?.backups || [] })
            assignDatabaseBackupStatus(result.databaseStatus || {})
            await loadWorkshops()
            await Promise.all([loadLines(), loadDevices(), loadSettings(), loadModels(), loadPlatform()])
            ensureComposerSelection()
            syncComposerDraftFromSelection()
            await nextTick()
            scheduleComposerPreview()
            siteBackupMessage.value = `整站恢复完成：灾备时间 ${formatBackupTime(result.manifestCreatedAt)}，上传模型 ${result.uploadedFileCount || 0} 个。`
            await alert('现场配置、数据库和上传模型已恢复完成。', { title: '整站恢复成功', type: 'success' })
        } catch (e) {
            siteBackupMessage.value = `整站恢复失败：${e.message || e}`
            await alert(siteBackupMessage.value, { title: '整站恢复失败', type: 'danger' })
        } finally {
            siteBackupBusy.value = false
            event.target.value = ''
        }
    }

    async function loadDatabaseBackups() {
        try {
            const status = await adminApi.getDatabaseBackups()
            assignDatabaseBackupStatus(status)
        } catch (e) {
            databaseBackupMessage.value = `备份状态读取失败：${e.message || e}`
        }
    }

    function selectDatabaseBackupRetention(days) {
        databaseBackupPolicy.retentionDays = Number(days)
    }

    async function saveDatabaseBackupPolicy() {
        const minimum = Number(databaseBackupStatus.retentionDaysMin || 1)
        const maximum = Number(databaseBackupStatus.retentionDaysMax || 3650)
        const retentionDays = Number(databaseBackupPolicy.retentionDays)
        if (!Number.isInteger(retentionDays) || retentionDays < minimum || retentionDays > maximum) {
            databaseBackupMessage.value = `保留天数请输入 ${minimum}-${maximum} 之间的整数。`
            return
        }
        databaseBackupPolicySaving.value = true
        databaseBackupMessage.value = '正在保存保留策略并清理过期备份...'
        try {
            const result = await adminApi.saveDatabaseBackupPolicy({ retentionDays })
            if (!result?.success) throw new Error(result?.error || '保存失败')
            assignDatabaseBackupStatus(result.status || {})
            const deletedCount = Number(result.cleanup?.deletedCount || 0)
            const failedCount = Array.isArray(result.cleanup?.errors) ? result.cleanup.errors.length : 0
            databaseBackupMessage.value = failedCount
                ? `策略已保存，已清理 ${deletedCount} 份备份，另有 ${failedCount} 份清理失败。`
                : (deletedCount ? `策略已保存，已自动清理 ${deletedCount} 份过期备份。` : '备份保留策略已保存。')
        } catch (e) {
            databaseBackupMessage.value = `保留策略保存失败：${e.message || e}`
        } finally {
            databaseBackupPolicySaving.value = false
        }
    }

    async function createDatabaseBackup() {
        databaseBackupBusy.value = true
        databaseBackupMessage.value = '正在创建一致性备份...'
        try {
            const result = await adminApi.createDatabaseBackup()
            assignDatabaseBackupStatus(result.status || {})
            databaseBackupMessage.value = `备份完成：${result.backup?.filename || ''}`
        } catch (e) {
            databaseBackupMessage.value = `备份失败：${e.message || e}`
        } finally {
            databaseBackupBusy.value = false
        }
    }

    async function restoreDatabaseBackup(backup) {
        if (!(await confirm(`恢复备份 ${backup.filename}？当前数据库会先自动备份，然后数据引擎将重新启动。`))) return
        databaseBackupBusy.value = true
        databaseBackupMessage.value = '正在校验并恢复备份...'
        try {
            const result = await adminApi.restoreDatabaseBackup(backup.filename)
            assignDatabaseBackupStatus(result.status || {})
            databaseBackupMessage.value = `已恢复：${backup.filename}`
            await Promise.all([loadSettings(), loadWorkshops(), loadLines(), loadDevices(), loadModels(), loadPlatform()])
        } catch (e) {
            databaseBackupMessage.value = `恢复失败：${e.message || e}`
        } finally {
            databaseBackupBusy.value = false
        }
    }

    async function deleteDatabaseBackup(backup) {
        if (!backup?.filename) return
        if (!(await confirm(`确定删除备份 ${backup.filename}？删除后无法恢复。`))) return
        databaseBackupBusy.value = true
        databaseBackupMessage.value = '正在删除备份...'
        try {
            const result = await adminApi.deleteDatabaseBackup(backup.filename)
            if (!result?.success) throw new Error(result?.error || '删除失败')
            assignDatabaseBackupStatus(result.status || {})
            databaseBackupMessage.value = `已删除：${backup.filename}`
        } catch (e) {
            databaseBackupMessage.value = `删除失败：${e.message || e}`
        } finally {
            databaseBackupBusy.value = false
        }
    }

    function downloadDatabaseBackup(backup) {
        const link = document.createElement('a')
        link.href = adminApi.databaseBackupDownloadUrl(backup.filename)
        link.download = backup.filename
        document.body.appendChild(link)
        link.click()
        link.remove()
    }

    function formatBackupSize(bytes) {
        const value = Number(bytes || 0)
        if (value <= 0) return '0 KB'
        if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
        if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
        return `${(value / 1024 / 1024).toFixed(1)} MB`
    }

    function formatBackupTime(value) {
        const date = new Date(value || '')
        if (Number.isNaN(date.getTime())) return '-'
        const pad = number => String(number).padStart(2, '0')
        return `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    function formatBackupInterval(milliseconds) {
        const hours = Number(milliseconds || 0) / 3600000
        return hours >= 1 ? `${Number(hours.toFixed(1))} 小时` : `${Math.round(milliseconds / 60000)} 分钟`
    }

    async function testDatabaseConnection() {
        databaseTestStatus.value = '正在测试连接...'
        try {
            const result = await adminApi.testDatabaseConfig({ ...databaseConfig })
            databaseTestStatus.value = result.success ? '连接成功' : `连接失败：${result.error || '未知错误'}`
        } catch (e) {
            databaseTestStatus.value = `连接失败：${e.message || '后端服务不可用'}`
        }
    }

    async function saveDatabaseConnection() {
        if (!(await confirm('保存数据库连接后，后端会重新初始化数据库并重启数据引擎，确定继续吗？'))) return
        databaseSaving.value = true
        databaseTestStatus.value = '正在保存并重新连接...'
        try {
            const result = await adminApi.saveDatabaseConfig({ ...databaseConfig })
            if (!result.success) {
                databaseTestStatus.value = `保存失败：${result.error || '未知错误'}`
                return
            }
            Object.assign(databaseConfig, result.config || databaseConfig)
            databaseTestStatus.value = '保存成功，数据库已重新连接'
            await loadDatabaseBackups()
            await Promise.all([loadSettings(), loadWorkshops(), loadLines(), loadDevices(), loadModels(), loadPlatform()])
        } catch (e) {
            databaseTestStatus.value = `保存失败：${e.message || e}`
        } finally {
            databaseSaving.value = false
        }
    }

    watch(() => databaseConfig.type, (type, oldType) => {
        if (type === oldType) return
        if (type === 'sqlite') {
            databaseConfig.filename ||= 'backend/data/factory.db'
            return
        }
        if (!databaseConfig.port || databaseConfig.port === databaseDefaultPorts[oldType]) {
            databaseConfig.port = databaseDefaultPorts[type] || databaseConfig.port
        }
        databaseConfig.database ||= 'dongtai_daping'
    })

    watch(() => dataSourceEditor.type, (type, oldType) => {
        if (dataSourceEditorHydrating || dataSourceEditor.sourceType !== 'database') return
        if (type === oldType) return
        const ports = { mysql: 3306, postgres: 5432, sqlserver: 1433 }
        const schemas = { postgres: 'public', sqlserver: 'dbo' }
        const oldDefault = ports[oldType]
        if (type === 'sqlite') {
            dataSourceEditor.port = 0
            dataSourceEditor.defaultSchema = ''
            return
        }
        if (!dataSourceEditor.port || dataSourceEditor.port === oldDefault) dataSourceEditor.port = ports[type]
        if (!dataSourceEditor.defaultSchema || dataSourceEditor.defaultSchema === schemas[oldType]) {
            dataSourceEditor.defaultSchema = schemas[type] || ''
        }
    }, { flush: 'sync' })

    watch(() => dataSourceEditor.sourceType, (type, oldType) => {
        if (dataSourceEditorHydrating || type === oldType) return
        replaceDataSourceDraft({
            id: dataSourceEditor.id, name: dataSourceEditor.name,
            enabled: dataSourceEditor.enabled, sourceType: type
        })
        dataSourceSavedFingerprint = ''
        dataSourceMessage.value = '数据源类型已切换，请重新填写连接和认证信息。'
    }, { flush: 'sync' })

    watch(() => dataSourceEditor.authType, (type, oldType) => {
        if (dataSourceEditorHydrating || dataSourceEditor.sourceType !== 'http_api' || type === oldType) return
        Object.assign(dataSourceEditor, { apiKey: '', token: '', user: '', password: '' })
    }, { flush: 'sync' })

    watch(dataSourceDraftFingerprint, () => {
        if (dataSourceEditorHydrating) return
        dataSourceDraftVersion += 1
        const hadHealth = Boolean(dataSourceTestHealth.status)
        clearDataSourceHealth()
        if (hadHealth || dataSourceBusy.value) dataSourceMessage.value = '配置已变更，请重新测试。'
    }, { flush: 'sync' })

    async function loadEngineStatus() {
        try {
            const res = await fetch(`${API_BASE}/engine/status`)
            const data = await res.json()
            if (!res.ok || data?.error) throw new Error(data?.error || '读取引擎状态失败')
            Object.assign(engineStatus, data)
        } catch (e) {
            engineStatus.mode = null
            engineStatus.plcStatus = { status: 'error', message: '无法连接后端' }
        }
    }

    function formatEngineMode(mode) {
        const labels = {
            integrated_plc: '内置低延迟采集模式',
            simulation: '模拟模式'
        }
        return labels[mode] || '未启动'
    }

    async function saveSettings() {
        const result = await adminApi.saveSettings({
            data_mode: settings.data_mode,
            native_quality_profile: settings.native_quality_profile,
            native_environment_config: JSON.stringify(normalizeNativeEnvironmentConfig(nativeEnvironmentConfig))
        })
        if (result?.error) return alert(result.error, { title: '设置保存失败', type: 'danger' })
        if (!result?.success) return alert('设置保存失败：后端没有返回成功状态', { title: '设置保存失败', type: 'danger' })
        // 保存后自动重启数据引擎
        try {
            const response = await fetch(`${API_BASE}/engine/restart`, { method: 'POST' })
            const data = await response.json().catch(() => ({}))
            if (!response.ok || data.success === false) throw new Error(data.error || '数据引擎重启失败')
            alert('设置已保存，数据引擎正在重启。', { title: '保存成功', type: 'success' })
        } catch (e) {
            alert('设置已保存，但数据引擎重启失败，请手动重启后端服务', { title: '保存成功', type: 'warning' })
        }
        // 刷新引擎状态
        setTimeout(() => loadEngineStatus(), 2000)
    }

    async function saveNativeEnvironmentSettings({ silent = false, markCustom = false } = {}) {
        if (markCustom) nativeEnvironmentConfig.preset = 'custom'
        nativeEnvironmentSaving.value = true
        if (!silent) nativeEnvironmentMessage.value = '正在推送场景与光效配置到 Unity...'
        try {
            const normalized = normalizeNativeEnvironmentConfig(nativeEnvironmentConfig)
            const result = await adminApi.saveSettings({
                native_environment_config: JSON.stringify(normalized)
            })
            if (result?.error) throw new Error(result.error)
            if (!result?.success) throw new Error('后端没有返回成功状态')
            for (const key of Object.keys(nativeEnvironmentConfig)) delete nativeEnvironmentConfig[key]
            Object.assign(nativeEnvironmentConfig, normalized)
            nativeEnvironmentMessage.value = '场景与光效已保存，并实时应用到正在运行的 Unity。'
            return true
        } catch (error) {
            nativeEnvironmentMessage.value = `场景与光效保存失败：${error.message || error}`
            if (!silent) await alert(nativeEnvironmentMessage.value, { title: '保存失败', type: 'danger' })
            return false
        } finally {
            nativeEnvironmentSaving.value = false
        }
    }

    async function applyNativeEnvironmentPreset(preset) {
        const selected = NATIVE_ENVIRONMENT_PRESETS.find(item => item.value === preset)
        if (!selected?.config) return
        const next = normalizeNativeEnvironmentConfig({
            ...selected.config,
            preset: selected.value,
            showWalls: false,
            wallEditorWidth: nativeEnvironmentConfig.wallEditorWidth,
            wallEditorDepth: nativeEnvironmentConfig.wallEditorDepth,
            walls: nativeEnvironmentConfig.walls
        })
        for (const key of Object.keys(nativeEnvironmentConfig)) delete nativeEnvironmentConfig[key]
        Object.assign(nativeEnvironmentConfig, next)
        await saveNativeEnvironmentSettings({ silent: true })
    }

    function resetNativeEnvironmentConfig() {
        const defaults = {
            ...createDefaultNativeEnvironmentConfig(),
            showWalls: false,
            wallEditorWidth: nativeEnvironmentConfig.wallEditorWidth,
            wallEditorDepth: nativeEnvironmentConfig.wallEditorDepth,
            walls: nativeEnvironmentConfig.walls
        }
        for (const key of Object.keys(nativeEnvironmentConfig)) delete nativeEnvironmentConfig[key]
        Object.assign(nativeEnvironmentConfig, defaults)
        nativeEnvironmentMessage.value = '已恢复“中性真实厂房”默认值，围墙已关闭；点击“立即应用”后推送到 Unity。'
    }

    return {
        settings,
        nativeEnvironmentConfig,
        nativeEnvironmentSaving,
        nativeEnvironmentMessage,
        nativeEnvironmentPresetOptions,
        saveNativeEnvironmentSettings,
        applyNativeEnvironmentPreset,
        resetNativeEnvironmentConfig,
        runtimeSettings,
        runtimeSaving,
        runtimeMessage,
        loadRuntimeSettings,
        saveRuntimeSettings,
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
        dataSourceTestHealth,
        dataSourceBackupBusy,
        dataSourceBackupMessage,
        dataSourceBackupConfig,
        dataSourceBackupStatus,
        resetDataSourceEditor,
        editDataSource,
        loadDataSources,
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
    }
}
