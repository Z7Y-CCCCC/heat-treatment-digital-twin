// 点位实时监视模块:实时点位值轮询、分页、设备状态汇总与自动刷新。
// 独立读取实时接口(不依赖点位映射的编辑态),仅依赖注入的 devices 列表。

import { ref, computed, watch, onScopeDispose } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'

export function usePointMonitor({ devices, storedAdminUiState }) {
    const selectedDeviceForMonitor = ref(storedAdminUiState.selectedDeviceForMonitor || 'all')
    const realtimePointRows = ref([])
    const realtimePointDeviceStatus = ref(null)

    // ============ 点位实时监视表格分页状态 ============
    const monitorCurrentPage = ref(1)
    const monitorPageSize = ref(20)

    const totalMonitorPages = computed(() => {
        if (monitorPageSize.value <= 0) return 1
        return Math.max(1, Math.ceil(realtimePointRows.value.length / monitorPageSize.value))
    })

    const paginatedRealtimePointRows = computed(() => {
        if (monitorPageSize.value <= 0) {
            return realtimePointRows.value
        }
        const start = (monitorCurrentPage.value - 1) * monitorPageSize.value
        return realtimePointRows.value.slice(start, start + monitorPageSize.value)
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

    watch([selectedDeviceForMonitor, monitorPageSize], () => {
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
    const selectedMonitorDevice = computed(() => devices.value.find(d => d.id === selectedDeviceForMonitor.value) || null)
    const isAllPointMonitorMode = computed(() => selectedDeviceForMonitor.value === 'all')
    const pointMonitorStatusSummary = computed(() => {
        if (!isAllPointMonitorMode.value) return realtimePointDeviceStatus.value
        const statuses = realtimePointDeviceStatuses.value || []
        const total = devices.value.length
        const online = statuses.filter(status => status.quality === 'good' || status.status === 'connected').length
        const bad = statuses.filter(status => status.quality === 'bad' || ['error', 'unconfigured', 'unsupported', 'disabled'].includes(status.status)).length
        return {
            status: online === total && total > 0 ? 'connected' : bad > 0 ? 'error' : 'idle',
            message: `全部设备：${online}/${total} 在线`,
            endpoint: '全部设备',
            lastError: bad > 0 ? `${bad} 台设备离线或未配置` : ''
        }
    })

    function ensurePointMonitorDevice() {
        if (selectedDeviceForMonitor.value === 'all' || devices.value.some(device => device.id === selectedDeviceForMonitor.value)) return
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
            const result = await adminApi.getRealtimePointValues(selectedDeviceForMonitor.value)
            if (requestSeq !== realtimePointRequestSeq) return
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
