const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))

export function inspectionHoverDetails(context, pointValues, resolvePointKey) {
    if (context?.viewMode !== 'device' || !context.inspectionEnabled || !context.inspectionHoveredPartId) return null
    const part = (Array.isArray(context.inspectionParts) ? context.inspectionParts : [])
        .find(item => item.id === context.inspectionHoveredPartId)
    if (!part?.anchor?.visible || !Number.isFinite(Number(part.anchor.x)) || !Number.isFinite(Number(part.anchor.y))) return null
    const deviceId = String(context.deviceId || '')
    const byId = (Array.isArray(part.pointIds) ? part.pointIds : [])
        .map(id => pointValues[`${deviceId}:${id}`] || pointValues[String(id)])
    const byKey = (Array.isArray(part.pointKeys) ? part.pointKeys : [])
        .map(key => resolvePointKey(deviceId, key))
    const points = [...new Map([...byId, ...byKey].filter(Boolean)
        .map((point, index) => [String(point.id || `${point.category || ''}.${point.value_role || point.name || index}`), point])).values()]
    return {
        ...part,
        points: points.slice(0, 3),
        style: {
            left: `${(clamp(Number(part.anchor.x) + .025, .025, .72) * 100).toFixed(2)}%`,
            top: `${(clamp(Number(part.anchor.y) - .055, .14, .76) * 100).toFixed(2)}%`
        }
    }
}

export function inspectionPointText(point) {
    if (point?.value === null || point?.value === undefined || point.value === '') return '暂无实时值'
    return `${point.value}${point.unit ? ` ${point.unit}` : ''}`
}
