// A held station number is an endpoint observation, not current travel or
// docking feedback. Apply this only to the explicitly selected new meaning;
// historical current/target/unspecified configurations keep their behaviour.
export function isLastConfirmedMotion(movement) {
    return movement?.stationInputMeaning === 'last-confirmed'
}

export function isActualMovingFeedback(point, deviceId) {
    return String(point?.access_type || 'READ').toUpperCase() === 'READ'
        && String(point?.data_type || '').toUpperCase() === 'BOOL'
        && (point?.device_id === undefined || String(point.device_id) === String(deviceId))
}

export function lastConfirmedMotionError(movement, points, deviceId) {
    if (!isLastConfirmedMotion(movement)) return ''
    if (movement.valueMode !== 'station') return '最后到位工位只适用于工位编号模式'
    if (movement.simulationEnabled === true || movement.simulation_enabled === true) return '最后到位工位不支持移动估算，请重新选择该数据含义以关闭运动细节模拟'
    if (movement.smoothingMs > 0 || movement.smoothing_ms > 0) return '最后到位工位不支持视觉过渡，请重新选择该数据含义以将平滑时间设为 0'
    const pointId = movement.startActionPointId ?? movement.start_action_point_id
    if (String(pointId ?? '').trim() && points !== undefined) {
        const point = (Array.isArray(points) ? points : []).find(item => String(item.id) === String(pointId))
        if (!point || !isActualMovingFeedback(point, deviceId)) return '最后到位工位的实际移动状态反馈必须是本设备只读 BOOL，请解除原开始命令绑定或重新选择'
    }
    return ''
}
