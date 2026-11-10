// 点位实时监视模块:实时点位值轮询、分页、设备状态汇总与自动刷新。
// 独立读取实时接口(不依赖点位映射的编辑态),仅依赖注入的 devices 列表。

import { ref, reactive, computed, watch, onScopeDispose } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'

const UNASSIGNED_WORKSHOP = '__unassigned_workshop__'
const WORKSHOP_DEVICES = '__workshop_devices__'
const categoryLabels = { analog: '模拟量', status: '运行状态', digital: '开关量', gas: '气体流量', motors: '电机／风扇', mechanisms: '机构动作', energy: '能耗', alarm: '报警', temperature: '温度', production: '生产', other: '未分类' }
const pointCategory = point => String(point.category || point.category_resolved || 'other')

export function usePointMonitor({ devices, workshops = ref([]), lines = ref([]), storedAdminUiState = {} }) {
    const selectedDeviceForMonitor = ref(storedAdminUiState.selectedDeviceForMonitor || 'all')
    const realtimePointRows = ref([])
    const realtimePointDeviceStatus = ref(null)
    const pointMonitorFilters = reactive({ workshopId: 'all', lineId: 'all', category: 'all', quality: 'all', query: '' })
    const monitorDeviceMap = computed(() => new Map(devices.value.map(device => [String(device.id), device])))
    const monitorLineMap = computed(() => new Map(lines.value.map(line => [String(line.id), line])))
    const monitorWorkshopMap = computed(() => new Map(workshops.value.map(workshop => [String(workshop.id), workshop])))

    function monitorWorkshopId(device = {}) {
        let config = device.instance_config || {}
        if (typeof config === 'string') {
            try { config = JSON.parse(config) || {} } catch { config = {} }
        }
        return String(config?.workshop_id || config?.workshopId || device.workshop_id
            || monitorLineMap.value.get(String(device.line_id))?.workshop_id || '')
    }

    const pointMonitorWorkshops = computed(() => {
        const options = new Map(workshops.value.map(workshop => [String(workshop.id), { id: String(workshop.id), name: workshop.name || String(workshop.id) }]))
        for (const device of devices.value) {
            const id = monitorWorkshopId(device) || UNASSIGNED_WORKSHOP
            if (!options.has(id)) options.set(id, { id, name: id === UNASSIGNED_WORKSHOP ? '未分配车间' : `车间 ${id}` })
        }
        return [...options.values()]
    })
    const workshopMonitorDevices = computed(() => devices.value.filter(device => pointMonitorFilters.workshopId === 'all'
        || (monitorWorkshopId(device) || UNASSIGNED_WORKSHOP) === pointMonitorFilters.workshopId))
    const pointMonitorLines = computed(() => {
        const options = new Map(lines.value.filter(line => pointMonitorFilters.workshopId === 'all'
            || String(line.workshop_id || UNASSIGNED_WORKSHOP) === pointMonitorFilters.workshopId)
            .map(line => [String(line.id), { id: String(line.id), name: line.name || String(line.id), workshopName: monitorWorkshopMap.value.get(String(line.workshop_id))?.name || '' }]))
        for (const device of workshopMonitorDevices.value) {
            const id = String(device.line_id || WORKSHOP_DEVICES)
            if (!options.has(id)) options.set(id, { id, name: id === WORKSHOP_DEVICES ? '车间级设备（无产线）' : `产线 ${id}`, workshopName: '' })
        }
        return [...options.values()]
    })
    const pointMonitorDevices = computed(() => workshopMonitorDevices.value.filter(device => pointMonitorFilters.lineId === 'all'
        || String(device.line_id || WORKSHOP_DEVICES) === pointMonitorFilters.lineId))
    const scopedMonitorDevices = computed(() => pointMonitorDevices.value.filter(device => selectedDeviceForMonitor.value === 'all'
        || String(device.id) === String(selectedDeviceForMonitor.value)))
    const scopedRealtimePointRows = computed(() => {
        const ids = new Set(scopedMonitorDevices.value.map(device => String(device.id)))
        return realtimePointRows.value.filter(point => ids.has(String(point.device_id)))
    })
    const pointMonitorCategories = computed(() => {
        const categories = new Set(scopedRealtimePointRows.value.map(pointCategory))
        if (pointMonitorFilters.category !== 'all') categories.add(pointMonitorFilters.category)
        return [...categories].map(id => ({ id, name: categoryLabels[id] || id }))
    })
    const filteredRealtimePointRows = computed(() => {
        const terms = String(pointMonitorFilters.query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
        return scopedRealtimePointRows.value.filter(point => {
            if (pointMonitorFilters.category !== 'all' && pointCategory(point) !== pointMonitorFilters.category) return false
            if (pointMonitorFilters.quality === 'abnormal' && point.quality === 'good') return false
            if (!['all', 'abnormal'].includes(pointMonitorFilters.quality) && point.quality !== pointMonitorFilters.quality) return false
            if (!terms.length) return true
            const device = monitorDeviceMap.value.get(String(point.device_id)) || {}
            const line = monitorLineMap.value.get(String(device.line_id)) || {}
            const workshop = monitorWorkshopMap.value.get(monitorWorkshopId(device)) || {}
            const text = [point.id, point.label, point.name, point.value_role, point.plc_address, point.plc_tag,
                point.alarm_text, point.description, point.data_type, point.unit, point.device_name,
                device.name, device.id, line.name, workshop.name, categoryLabels[pointCategory(point)] || pointCategory(point)]
                .filter(value => value != null).join(' ').toLocaleLowerCase()
            return terms.every(term => text.includes(term))
        })
    })
    const hasPointMonitorFilters = computed(() => selectedDeviceForMonitor.value !== 'all'
        || Object.entries(pointMonitorFilters).some(([key, value]) => key === 'query' ? String(value).trim() : value !== 'all'))

    function resetPointMonitorFilters() {
        Object.assign(pointMonitorFilters, { workshopId: 'all', lineId: 'all', category: 'all', quality: 'all', query: '' })
        selectedDeviceForMonitor.value = 'all'
    }

    watch(() => pointMonitorFilters.workshopId, () => {
        pointMonitorFilters.lineId = 'all'
        selectedDeviceForMonitor.value = 'all'
    }, { flush: 'sync' })
    watch(() => pointMonitorFilters.lineId, () => { selectedDeviceForMonitor.value = 'all' }, { flush: 'sync' })

    // ============ 点位实时监视表格分页状态 ============
    const monitorCurrentPage = ref(1)
    const monitorPageSize = ref(20)

    const totalMonitorPages = computed(() => {
        if (monitorPageSize.value <= 0) return 1
        return Math.max(1, Math.ceil(filteredRealtimePointRows.value.length / monitorPageSize.value))
    })

    const paginatedRealtimePointRows = computed(() => {
        if (monitorPageSize.value <= 0) {
            return filteredRealtimePointRows.value
        }
        const start = (monitorCurrentPage.value - 1) * monitorPageSize.value
        return filteredRealtimePointRows.value.slice(start, start + monitorPageSize.value)
    })

    const displayedMonitorPageNumbers = computed(() => {
        const total = totalMonitorPages.value
        const current = monitorCurrentPage.value
        if (total <= 7) {
            return Array.from({ length: total }, (_, i) => i + 1)
        }
        const pages = []
        let start = Math.max(1, current - 2)
        let end = Math.min(total, current + 2)
        if (current <= 3) {
            end = 5
        } else if (current >= total - 2) {
            start = total - 4
        }
        for (let i = start; i <= end; i++) {
            pages.push(i)
        }
        return pages
    })

    watch(totalMonitorPages, (maxPages) => {
        if (monitorCurrentPage.value > maxPages) {
            monitorCurrentPage.value = maxPages
        }
    })

    watch([selectedDeviceForMonitor, monitorPageSize, () => JSON.stringify(pointMonitorFilters)], () => {
        monitorCurrentPage.value = 1
    })
    const realtimePointDeviceStatuses = ref([])
    const realtimePointSnapshotAt = ref(null)
    const realtimePointLoading = ref(false)
    const realtimePointError = ref('')
    const pointMonitorAutoRefresh = ref(storedAdminUiState.pointMonitorAutoRefresh !== false)
    const pointMonitorRefreshIntervalMs = 1000
    let pointMonitorTimer = null
    let realtimePointRequestSeq = 0
    let realtimePointInFlight = false
    const selectedMonitorDevice = computed(() => monitorDeviceMap.value.get(String(selectedDeviceForMonitor.value)) || null)
    const isAllPointMonitorMode = computed(() => selectedDeviceForMonitor.value === 'all')
    const pointMonitorStatusSummary = computed(() => {
        if (!isAllPointMonitorMode.value) return realtimePointDeviceStatus.value
        const ids = new Set(scopedMonitorDevices.value.map(device => String(device.id)))
        const statuses = (realtimePointDeviceStatuses.value || []).filter(status => ids.has(String(status.deviceId ?? status.device_id ?? status.id)))
        const total = ids.size
        const online = statuses.filter(status => status.quality === 'good' || status.status === 'connected').length
        const bad = statuses.filter(status => status.quality === 'bad' || ['error', 'unconfigured', 'unsupported', 'disabled'].includes(status.status)).length
        const scope = pointMonitorFilters.lineId !== 'all' ? pointMonitorLines.value.find(line => line.id === pointMonitorFilters.lineId)?.name
            : pointMonitorFilters.workshopId !== 'all' ? pointMonitorWorkshops.value.find(workshop => workshop.id === pointMonitorFilters.workshopId)?.name : '全部设备'
        return {
            status: online === total && total > 0 ? 'connected' : bad > 0 ? 'error' : 'idle',
            message: `${scope || '当前范围'}：${online}/${total} 在线`,
            endpoint: scope || '当前范围',
            lastError: bad > 0 ? `${bad} 台设备离线或未配置` : ''
        }
    })

    function ensurePointMonitorDevice() {
        if (selectedDeviceForMonitor.value === 'all' || pointMonitorDevices.value.some(device => String(device.id) === String(selectedDeviceForMonitor.value))) return
        selectedDeviceForMonitor.value = 'all'
    }

    function pointRuntimeKey(point) {
        return `${point.device_id || ''}:${point.id || point.name || ''}`
    }

    function mergeRealtimePointRows(nextRows = []) {
        const existing = new Map(realtimePointRows.value.map(row => [row.__runtimeKey || pointRuntimeKey(row), row]))
        const merged = nextRows.map((row) => {
            const key = pointRuntimeKey(row)
            const current = existing.get(key)
            if (current) {
                Object.assign(current, row, { __runtimeKey: key })
                return current
            }
            return { ...row, __runtimeKey: key }
        })
        realtimePointRows.value = merged
    }

    async function loadRealtimePointValues(options = {}) {
        const silent = !!options.silent
        ensurePointMonitorDevice()
        if (!selectedDeviceForMonitor.value) {
            realtimePointRows.value = []
            realtimePointDeviceStatus.value = null
            realtimePointSnapshotAt.value = null
            return
        }
        if (realtimePointInFlight && silent) return

        const requestSeq = ++realtimePointRequestSeq
        realtimePointInFlight = true
        if (!silent) {
            realtimePointLoading.value = true
            realtimePointError.value = ''
        }
        try {
            const requestedDevice = selectedDeviceForMonitor.value
            const result = await adminApi.getRealtimePointValues(requestedDevice)
            if (requestSeq !== realtimePointRequestSeq || String(requestedDevice) !== String(selectedDeviceForMonitor.value)) return
            if (result?.error) {
                if (!silent || !realtimePointRows.value.length) realtimePointError.value = result.error
                return
            }
            mergeRealtimePointRows(result.points || [])
            realtimePointDeviceStatus.value = result.deviceStatus || null
            realtimePointDeviceStatuses.value = result.deviceStatuses || []
            realtimePointSnapshotAt.value = result.snapshotTimestamp || null
            realtimePointError.value = ''
        } catch (e) {
            if (requestSeq !== realtimePointRequestSeq) return
            if (!silent || !realtimePointRows.value.length) realtimePointError.value = e.message || '读取实时点位失败'
        } finally {
            if (requestSeq === realtimePointRequestSeq) {
                realtimePointInFlight = false
                realtimePointLoading.value = false
            }
        }
    }

    function startPointMonitor() {
        stopPointMonitor()
        ensurePointMonitorDevice()
        loadRealtimePointValues({ silent: realtimePointRows.value.length > 0 })
        if (pointMonitorAutoRefresh.value) {
            pointMonitorTimer = setInterval(() => loadRealtimePointValues({ silent: true }), pointMonitorRefreshIntervalMs)
        }
    }

    function stopPointMonitor() {
        realtimePointRequestSeq += 1
        realtimePointInFlight = false
        realtimePointLoading.value = false
        if (pointMonitorTimer) {
            clearInterval(pointMonitorTimer)
            pointMonitorTimer = null
        }
    }

    onScopeDispose(stopPointMonitor)

    return {
        selectedDeviceForMonitor,
        pointMonitorFilters,
        pointMonitorWorkshops,
        pointMonitorLines,
        pointMonitorDevices,
        pointMonitorCategories,
        scopedRealtimePointRows,
        filteredRealtimePointRows,
        hasPointMonitorFilters,
        resetPointMonitorFilters,
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
    }
}
