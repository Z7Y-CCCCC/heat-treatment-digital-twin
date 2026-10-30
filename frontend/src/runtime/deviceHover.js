import { DEVICE_TOOLTIP_FIELDS, normalizeDeviceTooltip } from '../../../shared/deviceTooltip.mjs'
import { pointerTooltipStyle } from './inspectionHover.js'

export function tooltipDevices(workshops = [], models = []) {
    const result = new Map()
    for (const workshop of workshops) {
        const add = (device, line) => result.set(String(device.id), { ...device,
            workshopId: String(workshop.id), workshopName: workshop.name || String(workshop.id),
            lineId: String(line?.id || device.line_id || ''), lineName: line?.name || '未分配产线',
            modelName: models.find(model => String(model.id) === String(device.model_type))?.name || device.model_type || '未配置模型' })
        for (const device of workshop.devices || []) add(device, null)
        for (const line of workshop.lines || []) for (const device of line.devices || []) add(device, line)
    }
    return [...result.values()]
}
const pointerValid = pointer => pointer?.visible === true && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
    && pointer.x >= 0 && pointer.x <= 1 && pointer.y >= 0 && pointer.y <= 1
function inScope(context, device) {
    return device && (!context.workshopId || String(context.workshopId) === device.workshopId)
        && (!context.lineId || String(context.lineId) === device.lineId)
}
export function applyDeviceHover(context, payload, devices) {
    if (!payload || context.sceneReady === false || !['factory', 'workshop', 'line'].includes(context.viewMode)) return false
    for (const key of ['factoryId', 'viewId']) if (String(payload[key] || '') !== String(context[key] || '')) return false
    const id = String(payload.hoveredDeviceId || '')
    if (id && (!inScope(context, devices.find(device => String(device.id) === id)) || !pointerValid(payload.deviceHoverPointer))) return false
    context.hoveredDeviceId = id
    context.deviceHoverPointer = id ? { ...payload.deviceHoverPointer } : { visible: false }
    return true
}
export function deviceHoverDetails(context, view, devices, statusMap = {}, frameMap = {}, viewport = {}) {
    const options = normalizeDeviceTooltip(view?.metadata?.deviceTooltip)
    if (!options.enabled || context.sceneReady === false || !['factory', 'workshop', 'line'].includes(context.viewMode)
        || !context.hoveredDeviceId || !pointerValid(context.deviceHoverPointer)) return null
    const device = devices.find(device => String(device.id) === context.hoveredDeviceId)
    if (!inScope(context, device)) return null
    const status = statusMap[device.id] || {}, frame = frameMap[device.id] || {}
    const values = { name: device.name || device.id, id: device.id, model: device.modelName,
        workshop: device.workshopName, line: device.lineName,
        status: !status.lastSeen ? '暂无实时数据' : status.quality === 'stale' ? '数据已过期' : status.quality === 'bad' ? '数据异常 / 未连接' : '数据正常' }
    const rows = options.fields.filter(key => key !== 'name').map(key => ({ key, label: DEVICE_TOOLTIP_FIELDS.find(field => field.id === key).label, value: values[key] || '未配置' }))
    for (const key of options.pointKeys) {
        const [category, field] = key.split('.')
        const point = (device.dataPoints || []).find(point => (point.category || point.category_resolved || 'analog') === category && (point.value_role || point.name) === field)
        // Never borrow a point from another device with the same semantic key.
        if (!point) continue
        const value = frame[category]?.[field], quality = frame.quality?.[category]?.[field] || status.quality
        rows.push({ key, label: point.display_name || point.label || point.name || key,
            value: value === null || value === undefined || value === '' ? '暂无实时值' : `${value}${point.unit ? ` ${point.unit}` : ''}`,
            quality: quality === 'bad' ? '数据异常' : quality === 'stale' ? '已过期' : '' })
    }
    const style = pointerTooltipStyle(context.deviceHoverPointer, viewport)
    const height = Number(viewport.height) > 0 ? Number(viewport.height) : 1080
    const estimatedHeight = Math.min(height - 24, 80 + rows.length * 30 + (options.description ? 72 : 0) + (options.showHint ? 24 : 0))
    style.top = `${Math.max(12, Math.min(height - estimatedHeight - 12, context.deviceHoverPointer.y * height + 16)).toFixed(2)}px`
    style.transform = 'none'
    return { title: options.title, name: options.fields.includes('name') ? values.name : '', description: options.description,
        rows, showHint: options.showHint, style }
}
