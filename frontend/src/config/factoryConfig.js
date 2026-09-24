import { reactive, ref } from 'vue'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { adminFetch as fetch } from '../runtime/adminSession.js'

// 全局响应式配置状态
const factoryConfig = reactive({
    settings: {},
    workshops: [],
    lines: [],
    models: [],
    templatePacks: [],
    platform: {},
    loaded: false
})

const loading = ref(false)
const error = ref(null)

async function readApiJson(resp, fallbackMessage = '请求失败', preserveFailureDetails = false) {
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok) return {
        ...(preserveFailureDetails ? { ...data, success: false } : {}),
        error: data.error || `${fallbackMessage}: ${resp.status}`
    }
    return data
}

function pathId(id) {
    return encodeURIComponent(String(id))
}

/**
 * 从后端拉取完整工厂配置
 */
async function loadConfig() {
    loading.value = true
    error.value = null
    try {
        const resp = await fetch(`${API_BASE}/config`)
        if (!resp.ok) throw new Error(`配置加载失败: ${resp.status}`)
        const data = await resp.json()
        
        factoryConfig.settings = data.settings || {}
        factoryConfig.workshops = data.workshops || []
        
        // 为了兼容性，我们可以从 workshops 拍平 lines，或者直接取 data.workshops 下挂载的 lines。
        // 由于 config.js 返回的是 workshops -> lines，我们把它拍平赋给 factoryConfig.lines 方便原有逻辑使用
        factoryConfig.lines = factoryConfig.workshops.flatMap(ws => ws.lines)
        factoryConfig.models = data.models || []
        factoryConfig.templatePacks = data.templatePacks || []
        factoryConfig.platform = data.platform || {}
        factoryConfig.loaded = true
        
        console.log(`✅ 工厂配置加载完成: ${factoryConfig.workshops.length} 个车间, ${factoryConfig.lines.length} 条产线`)
    } catch (e) {
        error.value = e.message
        console.error('❌ 加载工厂配置失败:', e)
        // 回退到默认配置
        useFallbackConfig()
    } finally {
        loading.value = false
    }
}

/**
 * 当后端不可用时的回退配置
 */
function useFallbackConfig() {
    factoryConfig.settings = {
        factory_name: '智能热处理数字孪生控制中心',
        data_mode: 'integrated_plc'
    }
    
    const lineNames = ['A 产线', 'B 产线', 'C 产线', 'D 产线']
    const fallbackLines = lineNames.map((name, li) => {
        const lineId = `line_${String.fromCharCode(97 + li)}`
        const devices = []
        for (let di = 0; di < 5; di++) {
            const globalIdx = li * 5 + di
            devices.push({
                id: `Furnace_${String(globalIdx + 1).padStart(2, '0')}`,
                name: `${globalIdx + 1}# 多用炉`,
                line_id: lineId,
                model_type: 'builtin_furnace',
                model_file: null,
                pos_x: (di - 2) * 14,
                pos_y: 0,
                pos_z: 0,
                rotation_y: 0,
                scale: 1.0,
                coordinate_space: 'line_local',
                sort_order: di,
                dataPoints: []
            })
        }
        return {
            id: lineId,
            name,
            workshop_id: 'ws_1',
            sort_order: li,
            layout: {
                version: 2,
                coordinateSpace: 'workshop_local',
                transform: { x: 0, y: 0, z: 24 - li * 16, rotationY: 0 },
                flowDirection: 'right',
                lanes: [{ id: 'lane_1', name: '设备线 1', type: 'device_lane', offsetZ: 0, length: 60, sort_order: 0 }],
                rails: []
            },
            devices
        }
    })
    
    factoryConfig.workshops = [{
        id: 'ws_1',
        name: '默认车间 1',
        sort_order: 0,
        layout: {
            version: 2,
            coordinateSpace: 'factory_world',
            transform: { x: 0, y: 0, z: -24, rotationY: 0 },
            size: { width: 100, depth: 100, height: 8 },
            boundary: { enabled: true }
        },
        lines: fallbackLines
    }]
    factoryConfig.lines = fallbackLines
    
    factoryConfig.models = []
    factoryConfig.templatePacks = []
    factoryConfig.platform = {
        activeProject: { id: 'project_default', name: '离线演示项目' },
        activeScene: {
            id: 'scene_factory_overview',
            name: '工厂总览',
            camera: { mode: 'auto', staleMs: 6000 },
            theme: { preset: 'industrial_twin' }
        },
        widgets: [
            { id: 'widget_navigation', widget_type: 'navigation', title: '层级导航', visible: 1 },
            { id: 'widget_metrics', widget_type: 'metrics', title: '生产指标', visible: 1, config: { compact: true } },
            { id: 'widget_trend', widget_type: 'trend', title: '历史趋势', visible: 1, config: { metric: 'avg_temp' } },
            { id: 'widget_alarms', widget_type: 'alarm_list', title: '报警履历', visible: 1, config: { limit: 5 } },
            { id: 'widget_marquee', widget_type: 'marquee', title: '实时日志', visible: 1, config: { speed: 30, limit: 20, eventWindowHours: 24 } }
        ]
    }
    factoryConfig.loaded = true
    console.warn('⚠️ 使用回退配置（后端不可用）')
}

/**
 * Vue Composable：在组件中使用配置
 */
export function useFactoryConfig() {
    return {
        config: factoryConfig,
        loading,
        error,
        loadConfig,

        // 便捷方法
        getWorkshops: () => factoryConfig.workshops,
        getLines: () => factoryConfig.lines,
        getDevicesByLine: (lineId) => {
            const line = factoryConfig.lines.find(l => l.id === lineId)
            return line ? line.devices : []
        },
        getAllDevices: () => factoryConfig.lines.flatMap(l => l.devices),
        getPlatform: () => factoryConfig.platform,
        getTemplatePacks: () => factoryConfig.templatePacks,
        getSetting: (key, defaultValue = '') => factoryConfig.settings[key] || defaultValue,
        getFactoryName: () => factoryConfig.settings.factory_name || '智能热处理数字孪生控制中心'
    }
}

// Admin API helpers
export const adminApi = {
    // 集团/工厂层级
    async listFactories() { return readApiJson(await fetch(`${API_BASE}/factories`), '读取工厂列表失败') },
    async createFactory(data) { return readApiJson(await fetch(`${API_BASE}/factories`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建工厂失败') },
    async updateFactory(id, data) { return readApiJson(await fetch(`${API_BASE}/factories/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存工厂失败') },
    async activateFactory(id) { return readApiJson(await fetch(`${API_BASE}/factories/${pathId(id)}/activate`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }), '切换运行工厂失败') },
    // PLC 协议能力清单
    async getPlcProtocols() { return readApiJson(await fetch(`${API_BASE}/plc/protocols`), '读取 PLC 协议清单失败') },
    // 车间
    async getWorkshops() { return (await fetch(`${API_BASE}/workshops`)).json() },
    async createWorkshop(data) { return readApiJson(await fetch(`${API_BASE}/workshops`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建车间失败') },
    async updateWorkshop(id, data) { return readApiJson(await fetch(`${API_BASE}/workshops/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存车间失败') },
    async getWorkshopDeletionImpact(id) { return readApiJson(await fetch(`${API_BASE}/workshops/${pathId(id)}/deletion-impact`), '读取车间关联项失败') },
    async deleteWorkshop(id, confirmationName) { return readApiJson(await fetch(`${API_BASE}/workshops/${pathId(id)}`, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ confirmationName }) }), '删除车间失败') },

    // 产线
    async getLines() { return (await fetch(`${API_BASE}/lines`)).json() },
    async createLine(data) { return readApiJson(await fetch(`${API_BASE}/lines`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建产线失败') },
    async updateLine(id, data) { return readApiJson(await fetch(`${API_BASE}/lines/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存产线失败') },
    async getLineDeletionImpact(id) { return readApiJson(await fetch(`${API_BASE}/lines/${pathId(id)}/deletion-impact`), '读取产线关联项失败') },
    async deleteLine(id, confirmationName) { return readApiJson(await fetch(`${API_BASE}/lines/${pathId(id)}`, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ confirmationName }) }), '删除产线失败') },

    // 设备
    async getDevices(lineId) { 
        const url = lineId ? `${API_BASE}/devices?line_id=${encodeURIComponent(lineId)}` : `${API_BASE}/devices`
        return (await fetch(url)).json() 
    },
    async getDevice(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`), '读取设备失败') },
    async createDevice(data) { return readApiJson(await fetch(`${API_BASE}/devices`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建设备失败') },
    async updateDevice(id, data) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设备失败') },
    async getDeviceDeletionImpact(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/deletion-impact`), '读取设备关联项失败') },
    async deleteDevice(id, confirmationName) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ confirmationName }) }), '删除设备失败') },

    // 点位
    async getDataPoints(deviceId) {
        const suffix = deviceId && deviceId !== 'all' ? `?device_id=${encodeURIComponent(deviceId)}` : ''
        return (await fetch(`${API_BASE}/datapoints${suffix}`)).json()
    },
    async saveDataPointsBatch(deviceId, points) { 
        return readApiJson(await fetch(`${API_BASE}/datapoints/batch`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ device_id: deviceId, points }) }), '保存点位失败')
    },
    async syncDataPoints(deviceId, points) {
        return readApiJson(await fetch(`${API_BASE}/datapoints/sync`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ device_id: deviceId, points }) }), '保存点位失败')
    },
    async getRealtimePointValues(deviceId) {
        const suffix = deviceId && deviceId !== 'all' ? `?device_id=${encodeURIComponent(deviceId)}` : ''
        return readApiJson(await fetch(`${API_BASE}/plc/points/realtime${suffix}`), '读取实时点位失败')
    },
    async deleteDataPoint(id) { return readApiJson(await fetch(`${API_BASE}/datapoints/${pathId(id)}`, { method: 'DELETE' }), '删除点位失败') },

    // 点位语音
    async getSystemVoices() {
        return readApiJson(await fetch(`${API_BASE}/voice/voices`), '读取系统语音失败')
    },
    async generateVoiceFile(data) {
        return readApiJson(await fetch(`${API_BASE}/voice/generate`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(data)
        }), '生成语音文件失败')
    },
    async uploadVoiceFile(file) {
        const formData = new FormData()
        formData.append('audioFile', file)
        return readApiJson(await fetch(`${API_BASE}/voice/upload`, { method: 'POST', body: formData }), '上传语音文件失败')
    },

    // 设置
    async getSettings() { return (await fetch(`${API_BASE}/settings`)).json() },
    async saveSettings(data) { return readApiJson(await fetch(`${API_BASE}/settings`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设置失败') },
    async getRuntimeSettings() { return readApiJson(await fetch(`${API_BASE}/system/runtime`), '读取运行配置失败') },
    async saveRuntimeSettings(data) { return readApiJson(await fetch(`${API_BASE}/system/runtime`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存运行配置失败') },
    async getCastDevices() { return readApiJson(await fetch(`${API_BASE}/system/cast/devices`), '读取局域网电视列表失败') },
    async refreshCastDevices() { return readApiJson(await fetch(`${API_BASE}/system/cast/refresh`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }), '搜索局域网电视失败') },
    async startCast(deviceId) { return readApiJson(await fetch(`${API_BASE}/system/cast/start`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ deviceId }) }), '投屏到电视失败') },
    async stopCast() { return readApiJson(await fetch(`${API_BASE}/system/cast/stop`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }), '停止投屏失败') },
    async getNativePreviewStatus() { return readApiJson(await fetch(`${API_BASE}/native-preview/status`), '读取 Unity 实时预览状态失败') },
    async sendNativePreview(data) { return readApiJson(await fetch(`${API_BASE}/native-preview`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '推送 Unity 实时预览失败') },
    async getDatabaseConfig() { return (await fetch(`${API_BASE}/database/config`)).json() },
    async testDatabaseConfig(data) { return readApiJson(await fetch(`${API_BASE}/database/test`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '测试数据库连接失败') },
    async saveDatabaseConfig(data) { return readApiJson(await fetch(`${API_BASE}/database/config`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存数据库配置失败') },
    async getDataSources() { return readApiJson(await fetch(`${API_BASE}/data-sources`), '读取外部数据源失败') },
    async testDataSource(data) { return readApiJson(await fetch(`${API_BASE}/data-sources/test`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '测试外部数据源失败', true) },
    async saveDataSource(data) {
        const id = data?.id
        const url = id ? `${API_BASE}/data-sources/connections/${pathId(id)}` : `${API_BASE}/data-sources/connections`
        return readApiJson(await fetch(url, { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存外部数据源失败')
    },
    async deleteDataSource(id) { return readApiJson(await fetch(`${API_BASE}/data-sources/connections/${pathId(id)}`, { method: 'DELETE' }), '删除数据源连接失败') },
    async getDataSourceTables(id) { return readApiJson(await fetch(`${API_BASE}/data-sources/connections/${pathId(id)}/tables`), '读取数据库表失败') },
    async getDataSourceColumns(id, schema, table) {
        const params = new URLSearchParams({ schema: schema || '', table: table || '' })
        return readApiJson(await fetch(`${API_BASE}/data-sources/connections/${pathId(id)}/columns?${params}`), '读取数据库字段失败')
    },
    async previewDataSource(binding) { return readApiJson(await fetch(`${API_BASE}/data-sources/preview`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(binding) }), '预览数据失败') },
    async getDataSourceBackupStatus() { return readApiJson(await fetch(`${API_BASE}/data-sources/backups/status`), '读取数据库自动备份配置失败') },
    async saveDataSourceBackupConfig(config) { return readApiJson(await fetch(`${API_BASE}/data-sources/backups/config`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) }), '保存数据库自动备份配置失败') },
    async runDataSourceBackups(connectionId = '') { return readApiJson(await fetch(`${API_BASE}/data-sources/backups/run`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ connectionId }) }), '创建数据库备份失败') },
    async getRuntimeDataSourceValues(sceneId = '') {
        const suffix = sceneId ? `?scene_id=${encodeURIComponent(sceneId)}` : ''
        return readApiJson(await fetch(`${API_BASE}/data-sources/runtime-values${suffix}`), '读取外部数据库数据失败')
    },
    // 排产系统业务数据只读适配层
    async getBusinessDataManifest(connectionId = '') {
        const suffix = connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : ''
        return readApiJson(await fetch(`${API_BASE}/business-data/manifest${suffix}`), '读取业务数据契约失败')
    },
    async getBusinessDataSnapshot(connectionId = '', options = {}) {
        const params = new URLSearchParams({ ...(connectionId ? { connection_id: connectionId } : {}), ...options })
        const suffix = params.toString() ? `?${params}` : ''
        return readApiJson(await fetch(`${API_BASE}/business-data/snapshot${suffix}`), '读取业务数据快照失败')
    },
    async getBusinessBatches(connectionId = '', options = {}) {
        const params = new URLSearchParams({ ...(connectionId ? { connection_id: connectionId } : {}), ...options })
        const suffix = params.toString() ? `?${params}` : ''
        return readApiJson(await fetch(`${API_BASE}/business-data/batches${suffix}`), '读取批次数据失败')
    },
    async getBusinessBatchDetail(id, connectionId = '') {
        const suffix = connectionId ? `?connection_id=${encodeURIComponent(connectionId)}` : ''
        return readApiJson(await fetch(`${API_BASE}/business-data/batches/${pathId(id)}${suffix}`), '读取批次详情失败')
    },
    async getBusinessCompliance(connectionId = '', options = {}) {
        const params = new URLSearchParams({ ...(connectionId ? { connection_id: connectionId } : {}), ...options })
        const suffix = params.toString() ? `?${params}` : ''
        return readApiJson(await fetch(`${API_BASE}/business-data/compliance${suffix}`), '读取温度碳势曲线失败')
    },
    async getBusinessOee(connectionId = '', options = {}) {
        const params = new URLSearchParams({ ...(connectionId ? { connection_id: connectionId } : {}), ...options })
        const suffix = params.toString() ? `?${params}` : ''
        return readApiJson(await fetch(`${API_BASE}/business-data/oee${suffix}`), '读取设备统计失败')
    },
    async getHeatTreatmentTemplateLibrary(category = '') {
        const suffix = category ? `?category=${encodeURIComponent(category)}` : ''
        return readApiJson(await fetch(`${API_BASE}/template-library${suffix}`), '读取热处理模板库失败')
    },
    async getAcceptanceReport() { return readApiJson(await fetch(`${API_BASE}/acceptance-report`, { cache: 'no-store' }), '读取自动验收报告失败') },
    async getLicenseStatus() { return readApiJson(await fetch(`${API_BASE}/license`, { cache: 'no-store' }), '读取离线授权状态失败') },
    async getLicenseContract() { return readApiJson(await fetch(`${API_BASE}/license/contract`, { cache: 'no-store' }), '读取许可证契约失败') },
    async installLicense(license) {
        return readApiJson(await fetch(`${API_BASE}/license`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ license })
        }), '安装离线许可证失败')
    },
    async getReleaseStatus() { return readApiJson(await fetch(`${API_BASE}/release`, { cache: 'no-store' }), '读取发布状态失败') },
    async getDatabaseBackups() { return readApiJson(await fetch(`${API_BASE}/database/backups`), '读取数据库备份失败') },
    async saveDatabaseBackupPolicy(config) { return readApiJson(await fetch(`${API_BASE}/database/backups/config`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(config) }), '保存备份保留策略失败') },
    async createDatabaseBackup() { return readApiJson(await fetch(`${API_BASE}/database/backups`, { method: 'POST' }), '创建数据库备份失败') },
    async restoreDatabaseBackup(filename) { return readApiJson(await fetch(`${API_BASE}/database/backups/${pathId(filename)}/restore`, { method: 'POST' }), '恢复数据库备份失败') },
    async deleteDatabaseBackup(filename) { return readApiJson(await fetch(`${API_BASE}/database/backups/${pathId(filename)}`, { method: 'DELETE' }), '删除数据库备份失败') },
    databaseBackupDownloadUrl(filename) { return `${API_BASE}/database/backups/${pathId(filename)}/download` },
    async getSiteBackups() { return readApiJson(await fetch(`${API_BASE}/site-backups`), '读取整站灾备状态失败') },
    async getSiteBackupConfig() { return readApiJson(await fetch(`${API_BASE}/site-backups/config`), '读取整站灾备配置失败') },
    async saveSiteBackupConfig(config) { return readApiJson(await fetch(`${API_BASE}/site-backups/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }), '保存整站灾备配置失败') },
    async createSiteBackup() { return readApiJson(await fetch(`${API_BASE}/site-backups/export`, { method: 'POST' }), '导出整站灾备失败') },
    async restoreSiteBackup(file) {
        const formData = new FormData()
        formData.append('backup', file)
        return readApiJson(await fetch(`${API_BASE}/site-backups/import`, { method: 'POST', body: formData }), '恢复整站灾备失败')
    },
    siteBackupDownloadUrl(filename) { return `${API_BASE}/site-backups/${pathId(filename)}/download` },

    // 模型
    async getModels() { return (await fetch(`${API_BASE}/models`)).json() },
    async uploadModel(formData) { return readApiJson(await fetch(`${API_BASE}/models/upload`, { method: 'POST', body: formData }), '上传模型失败') },
    async updateModel(id, data) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存模型失败') },
    async deleteModel(id) {
        const resp = await fetch(`${API_BASE}/models/${pathId(id)}`, { method: 'DELETE' })
        const data = await resp.json().catch(() => ({}))
        return resp.ok ? data : { error: data.error || `删除失败: ${resp.status}` }
    },

    // 平台编排
    async getPlatform() { return (await fetch(`${API_BASE}/platform`)).json() },
    async getDashboardDesigner(sceneId = '') {
        const suffix = sceneId ? `?scene_id=${encodeURIComponent(sceneId)}` : ''
        return readApiJson(await fetch(`${API_BASE}/platform/designer${suffix}`), '读取大屏设计器失败')
    },
    async saveDashboardDraft(sceneId, document, expectedRevision) {
        return readApiJson(await fetch(`${API_BASE}/platform/designer/draft`, {
            method: 'PUT',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ sceneId, document, expectedRevision })
        }), '保存大屏草稿失败')
    },
    async publishDashboard(sceneId, version = '', notes = '') {
        return readApiJson(await fetch(`${API_BASE}/platform/releases`, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ sceneId, version, notes })
        }), '发布大屏版本失败')
    },
    async activateDashboardRelease(id) {
        return readApiJson(await fetch(`${API_BASE}/platform/releases/${pathId(id)}/activate`, { method: 'POST' }), '恢复发布版本失败')
    },
    async deleteDashboardRelease(id) {
        return readApiJson(await fetch(`${API_BASE}/platform/releases/${pathId(id)}`, { method: 'DELETE' }), '删除发布版本失败')
    },
    async updateScene(id, data) { return readApiJson(await fetch(`${API_BASE}/platform/scenes/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存场景失败') },
    async createWidget(data) { return readApiJson(await fetch(`${API_BASE}/platform/widgets`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建组件失败') },
    async updateWidget(id, data) { return readApiJson(await fetch(`${API_BASE}/platform/widgets/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存组件失败') },
    async deleteWidget(id) { return readApiJson(await fetch(`${API_BASE}/platform/widgets/${pathId(id)}`, { method: 'DELETE' }), '删除组件失败') },
    async getEvents(limit = 50) { return (await fetch(`${API_BASE}/platform/events?limit=${limit}`)).json() },
    async createEvent(data) { return (await fetch(`${API_BASE}/platform/events`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) })).json() },
}
