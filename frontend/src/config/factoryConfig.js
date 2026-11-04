import { reactive, ref } from 'vue'
import { API_BASE } from '../runtime/backendEndpoint.js'
import { adminFetch as fetch } from '../runtime/adminSession.js'
import { deviceTransformPayload } from '../../../shared/deviceAuthoring.mjs'

// 全局响应式配置状态
const factoryConfig = reactive({
    factoryId: '',
    factories: [],
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
let configRequestId = 0
let configRequest = null

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
async function loadConfig(factoryId = '') {
    const requestId = ++configRequestId
    configRequest?.abort()
    const controller = new AbortController()
    configRequest = controller
    const timeout = setTimeout(() => controller.abort(), 10000)
    loading.value = true
    error.value = null
    try {
        const resp = await fetch(`${API_BASE}/config`, { signal: controller.signal, cache: 'no-store',
            ...(factoryId ? { headers: { 'X-Factory-ID': factoryId } } : {}) })
        if (!resp.ok) throw new Error(`配置加载失败: ${resp.status}`)
        const data = await resp.json()
        if (requestId !== configRequestId) return false
        if (!data || !Array.isArray(data.workshops) || (data.models != null && !Array.isArray(data.models))) {
            throw new Error('配置格式无效：车间或模型列表缺失')
        }
        const lines = data.workshops.flatMap(workshop => {
            if (!workshop || (workshop.lines != null && !Array.isArray(workshop.lines))) throw new Error('配置格式无效：产线列表无效')
            return workshop.lines || []
        })
        
        factoryConfig.factoryId = data.factoryId || ''
        factoryConfig.factories = data.factories || []
        factoryConfig.settings = data.settings || {}
        factoryConfig.workshops = data.workshops || []
        
        // 为了兼容性，我们可以从 workshops 拍平 lines，或者直接取 data.workshops 下挂载的 lines。
        // 由于 config.js 返回的是 workshops -> lines，我们把它拍平赋给 factoryConfig.lines 方便原有逻辑使用
        factoryConfig.lines = lines
        factoryConfig.models = data.models || []
        factoryConfig.templatePacks = data.templatePacks || []
        factoryConfig.platform = data.platform || {}
        factoryConfig.loaded = true
        
        console.log(`✅ 工厂配置加载完成: ${factoryConfig.workshops.length} 个车间, ${factoryConfig.lines.length} 条产线`)
        return true
    } catch (e) {
        if (requestId !== configRequestId) return false
        error.value = e.message
        console.error('❌ 加载工厂配置失败:', e)
        // A transient outage must retain the last valid scene. On first load the
        // empty state remains visible; configuration failures never invent devices.
        return false
    } finally {
        clearTimeout(timeout)
        if (requestId === configRequestId) {
            loading.value = false
            configRequest = null
        }
    }
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
    async getFactoryCollectionStatus(signal) { return readApiJson(await fetch(`${API_BASE}/factories/collection-status`, { cache: 'no-store', signal }), '读取工厂采集情况失败') },
    async searchFactoryPlace(countryCode, query) { return readApiJson(await fetch(`${API_BASE}/factories/place-search`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ countryCode, query }) }), '查询海外地点失败') },
    async createFactory(data) { return readApiJson(await fetch(`${API_BASE}/factories`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建工厂失败') },
    async updateFactory(id, data) { return readApiJson(await fetch(`${API_BASE}/factories/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存工厂失败') },
    async setFactoryCollection(id, enabled) { return readApiJson(await fetch(`${API_BASE}/factories/${pathId(id)}/collection`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled }) }), '保存采集开关失败') },
    async activateFactory(id) { return readApiJson(await fetch(`${API_BASE}/factories/${pathId(id)}/activate`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }), '切换运行工厂失败') },
    // PLC 协议能力清单
    async getPlcProtocols() { return readApiJson(await fetch(`${API_BASE}/plc/protocols`), '读取 PLC 协议清单失败') },
    // 车间
    async getWorkshops() { return (await fetch(`${API_BASE}/workshops`)).json() },
    async createWorkshop(data) { return readApiJson(await fetch(`${API_BASE}/workshops`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建车间失败') },
    async updateWorkshopGround(id, data) { return readApiJson(await fetch(`${API_BASE}/workshops/${pathId(id)}/ground`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存地面失败') },
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
    async getDeviceInspection(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/inspection`, { cache: 'no-store' }), '读取设备拆解布局失败', true) },
    async saveDeviceInspection(id, data) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/inspection`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设备拆解布局失败', true) },
    async createDevice(data) { return readApiJson(await fetch(`${API_BASE}/devices`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '创建设备失败') },
    async updateDevice(id, data) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设备失败') },
    async getDeviceDeletionImpact(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/deletion-impact`), '读取设备关联项失败') },
    async deleteDevice(id, confirmationName) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}`, { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ confirmationName }) }), '删除设备失败') },

    // 点位
    async getDataPoints(deviceId) {
        const suffix = deviceId && deviceId !== 'all' ? `?device_id=${encodeURIComponent(deviceId)}` : ''
        return (await fetch(`${API_BASE}/datapoints${suffix}`)).json()
    },
    async saveAlarmTexts(deviceId, points) { return readApiJson(await fetch(`${API_BASE}/datapoints/alarm-texts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_id: deviceId, points }) }), '保存报警文本失败') },
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
    async getDeviceAnimations(id) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/animations`), '读取设备动画失败') },
    async saveDeviceAnimations(id, body) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/animations`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }), '保存设备动画失败') },
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
    async getCollectorStatus(signal) { return readApiJson(await fetch(`${API_BASE}/collector/status`, { signal }), '读取采集状态失败') },
    async setCollectorMode(data) { return readApiJson(await fetch(`${API_BASE}/collector/mode`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }), '切换数据来源失败') },
    async saveSettings(data) { return readApiJson(await fetch(`${API_BASE}/settings`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存设置失败') },
    async uploadAppearanceImage(file) {
        const body = new FormData()
        body.append('image', file)
        return readApiJson(await fetch(`${API_BASE}/appearance-assets`, { method: 'POST', body }), '上传图片失败')
    },
    async getRuntimeSettings() { return readApiJson(await fetch(`${API_BASE}/system/runtime`), '读取运行配置失败') },
    async saveRuntimeSettings(data) { return readApiJson(await fetch(`${API_BASE}/system/runtime`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存运行配置失败') },
    async getCastDevices() { return readApiJson(await fetch(`${API_BASE}/system/cast/devices`), '读取局域网电视列表失败') },
    async refreshCastDevices() { return readApiJson(await fetch(`${API_BASE}/system/cast/refresh`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }), '搜索局域网电视失败') },
    async startCast(deviceId) { return readApiJson(await fetch(`${API_BASE}/system/cast/start`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ deviceId }) }), '投屏到电视失败') },
    async stopCast() { return readApiJson(await fetch(`${API_BASE}/system/cast/stop`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' }), '停止投屏失败') },
    async getNativePreviewStatus() { return readApiJson(await fetch(`${API_BASE}/native-preview/status`, { signal: AbortSignal.timeout(5000) }), '读取 Unity 实时预览状态失败') },
    async sendNativePreview(data) { return readApiJson(await fetch(`${API_BASE}/native-preview`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '推送 Unity 实时预览失败') },
    async getDatabaseConfig() { return (await fetch(`${API_BASE}/database/config`)).json() },
    async testDatabaseConfig(data) { return readApiJson(await fetch(`${API_BASE}/database/test`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '测试数据库连接失败') },
    async saveDatabaseConfig(data) { return readApiJson(await fetch(`${API_BASE}/database/config`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存数据库配置失败') },
    async getDataSources() { return readApiJson(await fetch(`${API_BASE}/data-sources`), '读取外部数据源失败') },
    async getDataSets() { return readApiJson(await fetch(`${API_BASE}/data-sources/datasets`, { cache: 'no-store' }), '读取数据集失败', true) },
    async saveDataSet(definition) { return readApiJson(await fetch(`${API_BASE}/data-sources/datasets`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(definition) }), '保存数据集失败', true) },
    async deleteDataSet(definition) { return readApiJson(await fetch(`${API_BASE}/data-sources/datasets/${pathId(definition.id)}`, { method: 'DELETE', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ revision: definition.revision }) }), '删除数据集失败', true) },
    async previewDataSet(input) { return readApiJson(await fetch(`${API_BASE}/data-sources/datasets/preview`, { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(input) }), '预览数据集失败', true) },
    async importDataSourceFile(file) {
        const form = new FormData(); form.append('dataFile', file);
        return readApiJson(await fetch(`${API_BASE}/data-sources/files`, { method: 'POST', body: form }), '导入数据文件失败')
    },
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
    async previewHttpDataSource(binding) { return readApiJson(await fetch(`${API_BASE}/data-sources/preview-http`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(binding) }), '预览接口数据失败') },
    async inspectHttpDataSource(binding) { return readApiJson(await fetch(`${API_BASE}/data-sources/inspect-http`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(binding) }), '读取接口字段失败') },
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
    async getLicenseHistory() { return readApiJson(await fetch(`${API_BASE}/license/history`, { cache: 'no-store' }), '读取激活记录失败') },
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
    async getModelInspection(id) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}/inspection`, { cache: 'no-store' }), '读取模型拆解布局失败', true) },
    async saveModelInspection(id, data) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}/inspection`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存模型拆解布局失败', true) },
    async updateDeviceTransforms(devices) { return readApiJson(await fetch(`${API_BASE}/devices/transforms`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ devices }) }), '保存设备组布局失败') },
    async updateDeviceTransform(id, data) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/transform`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(deviceTransformPayload(data)) }), '保存设备布局失败') },
    async updateDeviceMovement(id, movement, pointIds = []) { return readApiJson(await fetch(`${API_BASE}/devices/${pathId(id)}/movement`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ movement, pointIds }) }), '保存设备运动失败') },
    async updateLinePlacement(id, layout) { return readApiJson(await fetch(`${API_BASE}/lines/${pathId(id)}/placement`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transform: layout.transform, placementPending: layout.placementPending }) }), '保存产线位置失败') },
    async uploadModel(formData) { return readApiJson(await fetch(`${API_BASE}/models/upload`, { method: 'POST', body: formData }), '上传模型失败') },
    async updateModel(id, data) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存模型失败') },
    async getMotionActions(id) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}/motion-actions`, { cache: 'no-store' }), '读取工艺动作失败', true) },
    async saveMotionActions(id, data, preview = false) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}/motion-actions${preview ? '/preview' : ''}`, { method: preview ? 'POST' : 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), preview ? '准备动作预览失败' : '保存工艺动作失败') },
    async saveModelBindings(id, data) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}/bindings`, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) }), '保存动作动画失败') },
    async renameModel(id, name) { return readApiJson(await fetch(`${API_BASE}/models/${pathId(id)}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }), '保存模型名称失败') },
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
