export function summarizeDeviceConnections(engineStatus = {}, devices = []) {
    const plcStatus = engineStatus.plcStatus || {}
    if (String(engineStatus.mode || '').toLowerCase() === 'simulation') {
        const status = plcStatus.status || engineStatus.collectorStatus?.status || 'unknown'
        const running = ['simulating', 'connected'].includes(status)
        const total = Math.max(0, Number(engineStatus.collectorStatus?.devices) || devices.length)
        return {
            total,
            online: running ? total : 0,
            tone: running ? 'is-online' : ['error', 'stopped'].includes(status) ? 'is-offline' : 'is-unknown',
            label: running ? `模拟运行 · ${total} 台设备` : status === 'stopped' ? '模拟已停止' : status === 'error' ? '模拟运行异常' : '模拟启动中',
            detail: plcStatus.message || engineStatus.collectorStatus?.message || '模拟模式（不连接现场 PLC）'
        }
    }

    const statuses = Array.isArray(plcStatus.devices) ? plcStatus.devices : []
    const fallbackTotal = devices.filter(device => Number(device.plc_enabled || 0) > 0).length
    const total = statuses.length || fallbackTotal
    const online = statuses.filter(status => status.status === 'connected').length
    const connecting = statuses.filter(status => ['connecting', 'retrying'].includes(status.status)).length
    return {
        total,
        online,
        tone: total <= 0 ? 'is-unknown' : online === total ? 'is-online' : (online > 0 || connecting > 0) ? 'is-partial' : 'is-offline',
        label: total > 0 ? `设备 ${online}/${total} 在线` : '设备状态未知',
        detail: plcStatus.message || '尚未取得设备连接状态'
    }
}
