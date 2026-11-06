import { createWidgetReadScheduler } from './widgetReadScheduler.js'
import { tooltipBindingContext } from './tooltipContext.js'

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const validPointer = pointer => pointer?.visible === true && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)
  && pointer.x >= 0 && pointer.x <= 1 && pointer.y >= 0 && pointer.y <= 1
const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback

// The floating host owns placement; the authored children keep local coordinates.
export function tooltipPlacement(canvas = {}, pointer = null, viewport = {}) {
  const width = number(canvas.width, 280), height = number(canvas.height, 230)
  if (!pointer) return { left: 0, top: 0, width, height, scale: 1, floating: false }
  if (!validPointer(pointer)) return null
  const vw = number(viewport.width, 1920), vh = number(viewport.height, 1080)
  const margin = Math.min(12, vw / 8, vh / 8)
  const scale = Math.min(1, Math.max(1, vw - margin * 2) / width, Math.max(1, vh - margin * 2) / height)
  const renderedWidth = width * scale, renderedHeight = height * scale
  const x = pointer.x * vw, y = pointer.y * vh
  const above = y + 16 + renderedHeight > vh - margin
  return { left: clamp(x + 16, margin, Math.max(margin, vw - renderedWidth - margin)),
    top: clamp(above ? y - renderedHeight - 12 : y + 16, margin, Math.max(margin, vh - renderedHeight - margin)),
    width: renderedWidth, height: renderedHeight, scale, floating: true }
}

function scopedDevice(context, devices, id) {
  return devices.find(device => String(device.id) === String(id)
    && (!context.workshopId || String(device.workshopId || device.workshop_id || '') === String(context.workshopId))
    && (!context.lineId || String(device.lineId || device.line_id || '') === String(context.lineId))) || null
}

// Never replace the selected/navigation object just to render a hover card.
export function tooltipHoverTarget(context = {}, devices = [], pointValues = {}, resolvePointKey = () => null) {
  if (context.sceneReady === false) return null
  if (context.viewMode === 'device' && context.inspectionEnabled && context.inspectionHoveredPartId) {
    const device = devices.find(item => String(item.id) === String(context.deviceId))
    const part = context.inspectionParts?.find(item => String(item.id) === String(context.inspectionHoveredPartId))
    if (!device || !part) return null
    const cursor = context.inspectionHoverPointer
    const pointer = validPointer(cursor) ? { ...cursor } : part.anchor?.visible === true
      && Number.isFinite(Number(part.anchor.x)) && Number.isFinite(Number(part.anchor.y))
      ? { visible: true, x: clamp(Number(part.anchor.x) + .025, 0, 1), y: clamp(Number(part.anchor.y) - .055, 0, 1) } : null
    if (!pointer) return null
    const byId = (part.pointIds || part.point_ids || []).map(id => pointValues[`${device.id}:${id}`] || pointValues[String(id)])
    const byKey = (part.pointKeys || part.point_keys || []).map(key => resolvePointKey(String(device.id), key))
    const points = [...new Map([...byId, ...byKey].filter(point => point
      && (!point.device_id || String(point.device_id) === String(device.id)))
      .map((point, index) => [String(point.id || `${point.category || ''}.${point.value_role || point.name || index}`), point])).values()]
    return { kind: 'part', device, part: { ...part, points }, points, pointer }
  }
  if (!['factory', 'workshop', 'line'].includes(context.viewMode) || !context.hoveredDeviceId || !validPointer(context.deviceHoverPointer)) return null
  const device = scopedDevice(context, devices, context.hoveredDeviceId)
  return device ? { kind: 'device', device, part: null, points: pointValues, pointer: { ...context.deviceHoverPointer } } : null
}

// Exclude pointer/live readings from the request key: a pointermove never means a DB query.
export function tooltipRequestContext(context = {}, templateId = '') {
  return { ...Object.fromEntries(['factoryId', 'viewId', 'viewMode', 'workshopId', 'lineId', 'deviceId', 'partId']
    .map(key => [key, String(context[key] || '')])), tooltipScope: true, tooltipTarget: true, tooltipTemplateId: String(templateId) }
}

export function createTooltipReadScheduler(hooks) {
  return createWidgetReadScheduler({ ...hooks,
    context: () => tooltipRequestContext(hooks.context(), hooks.templateId()),
    widgets: () => hooks.widgets().map(widget => tooltipBindingContext(widget, hooks.context()).widget)
  })
}
