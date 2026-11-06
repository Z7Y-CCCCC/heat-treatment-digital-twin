const text = value => String(value ?? '').trim()
const lower = value => text(value).toLowerCase()
const deviceId = value => text(value?.deviceId ?? value?.id)
const timestamp = value => {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
const count = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : null
const unique = rows => {
    const map = new Map()
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = deviceId(row)
        if (id && !map.has(id)) map.set(id, row)
    }
    return map
}
const pendingStates = new Set(['unknown', 'idle', 'starting', 'connecting', 'retrying', 'pending'])
const stoppedStates = new Set(['error', 'stopped', 'offline', 'unavailable', 'recovering', 'unresponsive'])

function latestDeviceStatuses(rows) {
    const map = new Map()
    for (const row of Array.isArray(rows) ? rows : []) {
        const id = deviceId(row)
        if (!id) continue
        const previous = map.get(id)
        const rowTime = timestamp(row.timestamp ?? row.observedAt ?? row.lastReadAt) || 0
        const previousTime = timestamp(previous?.timestamp ?? previous?.observedAt ?? previous?.lastReadAt) || 0
        // Duplicate IDs must not inflate totals. On an ambiguous tie,
        // preserve a reported failure instead of turning it green by order.
        const good = value => ['connected', 'simulating'].includes(lower(value?.status)) && !['bad', 'stale', 'unknown', 'empty'].includes(lower(value?.quality))
        if (!previous || rowTime > previousTime || rowTime === previousTime && !good(row)) map.set(id, row)
    }
    return map
}

export function summarizeDeviceConnections(engineStatus = {}, devices = [], options = {}) {
    const now = Number(options.now) || Date.now()
    const mode = lower(engineStatus.mode)
    const simulation = mode === 'simulation'
    const modeLabel = mode === 'external' ? '外部接口' : simulation ? '模拟运行' : mode === 'integrated_plc' ? '现场采集' : '设备连接'
    const plcStatus = engineStatus.plcStatus || {}, collector = engineStatus.collectorStatus || {}
    if (mode === 'external') return { total: 0, online: 0, offline: 0, pending: 0, tone: 'is-unknown', label: '外部接口', modeLabel,
        detail: '按组件配置读取数据', deviceRows: [] }

    const catalog = unique(devices)
    const hasDeviceStatuses = Array.isArray(plcStatus.devices)
    const statuses = latestDeviceStatuses(plcStatus.devices)
    const configured = count(engineStatus.configuredDevices)
    const candidates = catalog.size ? [...catalog.values()] : [...statuses.values()]
    // Simulation intentionally includes this factory's non-PLC equipment;
    // the real simulator does not filter it by plc_enabled.
    const targets = simulation && configured === 0 ? [] : candidates.filter(device => simulation
        || (catalog.size ? Number(device.plc_enabled || 0) > 0 : lower(device.status) !== 'disabled'))
    const aggregateStates = [lower(plcStatus.status), lower(collector.status)].filter(Boolean)
    const processState = lower(engineStatus.process?.status)
    const globalFailure = aggregateStates.find(state => stoppedStates.has(state))
        || (processState && !['running', 'starting', 'idle'].includes(processState) ? processState : '')
    const observedAt = timestamp(engineStatus.observedAt)
    const heartbeat = timestamp(engineStatus.process?.lastHeartbeatAt)
    const observationExpired = observedAt !== null && (now - observedAt > 15000 || now - observedAt < -5000)
    const heartbeatExpired = heartbeat !== null && (now - heartbeat > (Number(engineStatus.process?.heartbeatTimeoutMs) || 15000) || now - heartbeat < -5000)
    const processPending = ['starting', 'idle'].includes(processState)
    const aggregateRunning = aggregateStates.some(state => ['simulating', 'connected'].includes(state))
    const samples = count(collector.devices)
    const aggregateTotal = configured ?? samples ?? targets.length
    const total = targets.length || (!hasDeviceStatuses && !catalog.size ? aggregateTotal : 0)
    const aggregateOnline = simulation && !hasDeviceStatuses && aggregateRunning && !globalFailure && !observationExpired && !heartbeatExpired && !processPending
        ? Math.min(total, samples ?? (aggregateStates.includes('simulating') ? total : 0)) : 0
    // A legacy aggregate count can prove all catalogued targets are covered,
    // but cannot identify which N of M targets have actually been read.
    const aggregateCoversAll = aggregateOnline > 0 && aggregateOnline === total
    const deviceRows = targets.map(device => {
        const id = deviceId(device), status = statuses.get(id)
        const rawStatus = lower(status?.status) || 'unknown'
        const quality = lower(status?.quality) || 'unknown'
        const lastReadAt = timestamp(status?.lastReadAt)
        const intervals = (Array.isArray(status?.intervals) ? status.intervals : []).map(Number).filter(Number.isFinite)
        const freshnessMs = Math.max(6000, Number(status?.freshnessMs || status?.offlineAfterMs) || 0,
            ...(simulation ? [] : [15000]), ...intervals.map(value => value * 3))
        const fresh = lastReadAt !== null && now - lastReadAt >= -5000 && now - lastReadAt <= freshnessMs
        let connected = false, state = 'pending', actualStatus = rawStatus
        if (globalFailure || observationExpired || heartbeatExpired) {
            state = 'offline'; actualStatus = globalFailure || 'stale'
        } else if (processPending) {
            actualStatus = 'starting'
        } else if (status) {
            connected = ['connected', 'simulating'].includes(rawStatus) && quality === 'good' && fresh
            if (connected) state = 'connected'
            else if (['bad', 'stale'].includes(quality) || lastReadAt !== null && !fresh
                || !pendingStates.has(rawStatus) && !['connected', 'simulating'].includes(rawStatus)) state = 'offline'
        } else if (!hasDeviceStatuses && aggregateCoversAll) {
            connected = true; state = 'connected'; actualStatus = 'connected'
        }
        return { id, name: text(device.name || device.deviceName || status?.deviceName || status?.name) || id,
            connected, state, tone: connected ? 'is-online' : state === 'offline' ? 'is-offline' : 'is-unknown',
            status: actualStatus, quality: connected ? 'good' : quality, lastReadAt }
    })
    const online = deviceRows.length && hasDeviceStatuses ? deviceRows.filter(row => row.connected).length : aggregateOnline
    const offline = deviceRows.filter(row => row.state === 'offline').length
    const pending = deviceRows.filter(row => row.state === 'pending').length
    const knownUnavailable = Boolean(globalFailure || observationExpired || heartbeatExpired || offline === total && total > 0)
    const tone = total <= 0 ? 'is-unknown' : online === total ? 'is-online' : online > 0 ? 'is-partial'
        : knownUnavailable ? 'is-offline' : offline > 0 ? 'is-partial' : 'is-unknown'
    const stopped = aggregateStates.includes('stopped')
    const label = simulation ? stopped ? '模拟已停止' : globalFailure ? '模拟运行异常' : aggregateRunning
        ? `模拟运行 · ${total} 台设备` : '模拟启动中' : total > 0 ? `设备 ${online}/${total} 在线` : '设备状态未知'
    return { total, online, offline, pending, tone, label, modeLabel,
        detail: observationExpired || heartbeatExpired ? '设备连接状态已过期' : plcStatus.message || collector.message || (simulation ? '模拟模式（不连接现场 PLC）' : '尚未取得设备连接状态'),
        deviceRows }
}
