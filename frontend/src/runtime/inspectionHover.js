const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))

export function pointerTooltipStyle(pointer, viewport = {}) {
    const width = Number(viewport.width) > 0 ? Number(viewport.width) : 1920
    const height = Number(viewport.height) > 0 ? Number(viewport.height) : 1080
    const cardWidth = Math.max(220, Math.min(280, width * .24))
    const above = pointer.y > .65
    return {
        left: `${clamp(pointer.x * width + 16, 12, Math.max(12, width - cardWidth - 12)).toFixed(2)}px`,
        top: `${clamp(pointer.y * height + (above ? -12 : 16), 12, height - 12).toFixed(2)}px`,
        transform: above ? 'translateY(-100%)' : 'none'
    }
}

export function applyInspectionHover(context, payload) {
    if (!payload || context?.viewMode !== 'device' || !context.inspectionEnabled || context.sceneReady === false) return false
    for (const key of ['factoryId', 'deviceId', 'viewId', 'inspectionStage']) {
        if (String(payload[key] || '') !== String(context[key] || '')) return false
    }
    const id = String(payload.inspectionHoveredPartId || '')
    if (id && !context.inspectionParts?.some(part => part.id === id)) return false
    context.inspectionHoveredPartId = id
    context.inspectionHoverPointer = payload.inspectionHoverPointer || { visible: false }
    return true
}

export function inspectionHoverDetails(context, pointValues, resolvePointKey, viewport = {}) {
    if (context?.viewMode !== 'device' || !context.inspectionEnabled || !context.inspectionHoveredPartId) return null
    const part = (Array.isArray(context.inspectionParts) ? context.inspectionParts : [])
        .find(item => item.id === context.inspectionHoveredPartId)
    if (!part) return null
    const pointer = context.inspectionHoverPointer
    const followsPointer = pointer?.visible === true && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
    if (!followsPointer && (!part.anchor?.visible || !Number.isFinite(Number(part.anchor.x)) || !Number.isFinite(Number(part.anchor.y)))) return null
    const deviceId = String(context.deviceId || '')
    const byId = (Array.isArray(part.pointIds) ? part.pointIds : [])
        .map(id => pointValues[`${deviceId}:${id}`] || pointValues[String(id)])
    const byKey = (Array.isArray(part.pointKeys) ? part.pointKeys : [])
        .map(key => resolvePointKey(deviceId, key))
    const points = [...new Map([...byId, ...byKey].filter(Boolean)
        .map((point, index) => [String(point.id || `${point.category || ''}.${point.value_role || point.name || index}`), point])).values()]
    const width = Number(viewport.width) > 0 ? Number(viewport.width) : 1920
    const height = Number(viewport.height) > 0 ? Number(viewport.height) : 1080
    const cardWidth = Math.max(220, Math.min(280, width * .24))
    const above = followsPointer && pointer.y > .65
    return {
        ...part,
        points: points.slice(0, 3),
        style: followsPointer ? {
            left: `${clamp(pointer.x * width + 16, 12, Math.max(12, width - cardWidth - 12)).toFixed(2)}px`,
            top: `${clamp(pointer.y * height + (above ? -12 : 16), 12, height - 12).toFixed(2)}px`,
            transform: above ? 'translateY(-100%)' : 'none'
        } : {
            left: `${(clamp(Number(part.anchor.x) + .025, .025, .72) * 100).toFixed(2)}%`,
            top: `${(clamp(Number(part.anchor.y) - .055, .14, .76) * 100).toFixed(2)}%`
        }
    }
}

export function inspectionPointText(point) {
    if (point?.value === null || point?.value === undefined || point.value === '') return '暂无实时值'
    return `${point.value}${point.unit ? ` ${point.unit}` : ''}`
}
