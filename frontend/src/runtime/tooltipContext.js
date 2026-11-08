import { normalizePlayback } from '../../../shared/widgetPlayback.mjs'
import { isTooltipMetadataPath, restoreTooltipDynamicBinding } from '../../../shared/tooltipTemplates.mjs'

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const idOf = value => String(value ?? '')
const ownerOf = point => idOf(point?.device_id ?? point?.deviceId)
const pointKey = point => `${point.category || point.category_resolved || 'analog'}.${point.value_role || point.field_name || point.name || ''}`
const byPath = (source, path) => String(path || '').split('.').reduce((value, key) => value?.[key], source)
const usable = value => value !== null && value !== undefined && value !== ''
const good = quality => !quality || quality === 'good'

function normalizedPoint(point, status = {}) {
  const value = point.value
  const unit = String(point.unit || '')
  const quality = point.quality || status.quality || 'stale'
  const name = String(point.display_name || point.label || point.name || point.id || '')
  return { ...point, name, label: name, unit, quality,
    text: good(quality) && usable(value) ? `${value}${unit ? ` ${unit}` : ''}` : undefined }
}

export function deviceStatusText(status = {}) {
  if (status.quality === 'bad') return '数据异常 / 未连接'
  if (status.quality === 'stale') return '数据已过期'
  if (status.online === false) return '数据异常 / 未连接'
  // A saved/last-seen timestamp proves only that a frame existed, not that its
  // current connection or data quality is healthy. The acquisition store owns
  // freshness; do not invent another timer or infer health from process state.
  return status.quality === 'good' ? '数据正常' : '暂无实时数据'
}

/** A tooltip owns a data scope, never the application's selected/navigation scope. */
export function createTooltipContext({ kind = 'device', device, part, status, frame, points, runtimeContext } = {}) {
  const parent = object(runtimeContext), sourceDevice = object(device), sourcePart = object(part)
  const deviceId = idOf(sourceDevice.id)
  const sourceStatus = object(status), sourceFrame = object(frame)
  const rawPoints = Array.isArray(points) ? points : Object.values(object(points))
  // Object maps may contain aliases of one point. Ignore unowned global records.
  const owned = [...new Map(rawPoints.filter(point => point && deviceId && ownerOf(point) === deviceId)
    .map(point => [idOf(point.id || pointKey(point)), point])).values()]
  const pointMap = Object.create(null)
  const putPoint = point => {
    const [category, field, ...rest] = pointKey(point).split('.')
    if (!category || !field || rest.length || ['__proto__', 'constructor', 'prototype'].includes(category)
      || ['__proto__', 'constructor', 'prototype'].includes(field)) return
    const bucket = pointMap[category] || (pointMap[category] = Object.create(null))
    // Ambiguous semantic keys must not silently choose another configured point.
    bucket[field] = Object.hasOwn(bucket, field) ? null : normalizedPoint(point, sourceStatus)
  }
  for (const point of owned) putPoint(point)
  for (const definition of Array.isArray(sourceDevice.dataPoints) ? sourceDevice.dataPoints : []) {
    const key = pointKey(definition), [category, field, ...rest] = key.split('.')
    if (!category || !field || rest.length || Object.hasOwn(pointMap[category] || {}, field)) continue
    const value = sourceFrame[category]?.[field]
    putPoint({ ...definition, device_id: deviceId, value,
      quality: sourceFrame.quality?.[category]?.[field] || sourceStatus.quality || 'stale' })
  }
  const rawIds = sourcePart.pointIds || sourcePart.point_ids
  const rawKeys = sourcePart.pointKeys || sourcePart.point_keys
  const pointIds = (Array.isArray(rawIds) ? rawIds : []).map(idOf)
  const pointKeys = (Array.isArray(rawKeys) ? rawKeys : []).map(idOf)
  const nested = Array.isArray(sourcePart.points) ? sourcePart.points : []
  const nestedScoped = nested.filter(point => deviceId && point && (!ownerOf(point) || ownerOf(point) === deviceId))
  const identity = point => idOf(point.id || pointKey(point))
  const candidates = new Map(owned.map(point => [identity(point), point]))
  for (const point of nestedScoped) if (!candidates.has(identity(point))) candidates.set(identity(point), point)
  const available = [...candidates.values()], scopedPartPoints = [], seen = new Set()
  const appendPoint = point => {
    if (!point || seen.has(identity(point))) return
    seen.add(identity(point)); scopedPartPoints.push(point)
  }
  // Index-based template fields must mean the same point in the designer and
  // runtime regardless of database/dictionary insertion order. Follow authored
  // IDs first, then uniquely resolvable semantic keys, then explicit extras.
  for (const id of pointIds) appendPoint(available.find(point => idOf(point.id) === id))
  for (const key of pointKeys) {
    const matches = available.filter(point => pointKey(point) === key)
    if (matches.length === 1) appendPoint(matches[0])
  }
  // A caller may already have resolved a part's point records. Accept that
  // explicit nested scope, but never a record owned by a different device.
  for (const point of nestedScoped) appendPoint(candidates.get(identity(point)))
  const partPoints = scopedPartPoints.map(point => normalizedPoint(point, sourceStatus))
  const partId = kind === 'part' ? idOf(sourcePart.id) : ''
  const selectedPart = { ...sourcePart, id: partId, points: kind === 'part' ? partPoints : [],
    pointMap: Object.fromEntries(partPoints.map(point => [idOf(point.id), point])), stage: parent.inspectionStage || '' }
  const hoveredDevice = { ...sourceDevice, id: deviceId, name: String(sourceDevice.name || deviceId),
    modelName: String(sourceDevice.modelName || sourceDevice.model_type || ''),
    workshopName: String(sourceDevice.workshopName || ''), lineName: String(sourceDevice.lineName || ''),
    status: deviceStatusText(sourceStatus), quality: sourceStatus.quality || 'stale', online: sourceStatus.online, frame: sourceFrame, pointMap }
  const hoveredPart = { ...selectedPart, name: String(sourcePart.name || partId), group: String(sourcePart.group || ''),
    description: String(sourcePart.description || ''),
    hint: ['exploded', 'part'].includes(parent.inspectionStage) ? '点击部件查看完整详情' : '点击部件继续查看拆解结构' }
  return { ...parent, tooltipScope: true, tooltipTarget: true, tooltipKind: kind === 'part' ? 'part' : 'device', deviceId, partId,
    partName: hoveredPart.name, partDescription: hoveredPart.description, partPointIds: [...pointIds], partPointKeys: [...pointKeys],
    hover: { device: hoveredDevice, part: kind === 'part' ? hoveredPart : null }, tooltipSelectedPart: selectedPart }
}

/** Prepare a transient widget for existing readers without persisting sample IDs. */
export function tooltipBindingContext(widget, context = {}) {
  const raw = object(widget)
  if (!context.tooltipScope) return { widget: raw, sourceWidget: raw, runtimeContext: context, selectedPart: context.tooltipSelectedPart || {} }
  const source = restoreTooltipDynamicBinding(raw), data = object(source.data)
  const mode = normalizePlayback(data).deviceScope
  // Global and explicitly fixed sources are deliberate exceptions. Current
  // and rotation sources use the hover target, never another eligible device.
  const scopedData = mode === 'global' ? { ...data, deviceScope: 'global' }
    : data.deviceScope === 'fixed' && data.deviceId ? { ...data }
      : { ...data, deviceScope: 'fixed', deviceId: idOf(context.deviceId), rotationDeviceIds: [] }
  // The temporary fixed scope pins readers to the hover target; it is not an
  // authored fixed point reference. Keep the source separate so PLC role
  // resolution can distinguish current/rotation from deliberate fixed IDs.
  return { widget: { ...source, data: scopedData }, sourceWidget: source, runtimeContext: context, selectedPart: context.tooltipSelectedPart || {} }
}

/** Unlike normal overview playback, no eligible-device fallback is permitted. */
export function tooltipPlaybackSelection(binding, context, devices = []) {
  if (normalizePlayback(binding).deviceScope === 'global') return { device: null, index: 0, total: 0, mode: 'global' }
  const id = idOf(binding.deviceScope === 'fixed' && binding.deviceId ? binding.deviceId : context.deviceId)
  const device = id ? devices.find(item => idOf(item.id) === id) || (idOf(context.hover?.device?.id) === id ? context.hover.device : null) : null
  return { device, index: 0, total: device ? 1 : 0, mode: 'current' }
}

export function tooltipPathQuality(context, path) {
  if (!context?.tooltipScope || !String(path).startsWith('hover.')) return undefined
  const source = context.hover
  const partPoint = /^hover\.part\.points\.(\d+)\.(value|text)$/.exec(String(path))
  if (partPoint) return source?.part?.points?.[Number(partPoint[1])]?.quality || 'stale'
  const devicePoint = /^hover\.device\.pointMap\.([^.]*)\.([^.]*)\.(value|text)$/.exec(String(path))
  if (devicePoint) return source?.device?.pointMap?.[devicePoint[1]]?.[devicePoint[2]]?.quality || 'stale'
  if (String(path).startsWith('hover.device.frame.')) {
    const field = String(path).slice('hover.device.frame.'.length)
    return byPath(source?.device?.frame?.quality, field) || source?.device?.quality || 'stale'
  }
  return 'good'
}

export function tooltipRuntimeValue(context, path) {
  const quality = tooltipPathQuality(context, path)
  if (quality && quality !== 'good') return undefined
  return byPath({ hover: context?.hover }, path)
}

// Identity, association and connection metadata must retain their real meaning.
// Numeric point-code mappings remain configurable, but these strings must not
// be relabelled into an invented connection state or a different object name.
export function tooltipMetadataPath(path) {
  return isTooltipMetadataPath(path)
}

export function mappedWidgetValue(value, mappings) {
  if (Array.isArray(mappings)) {
    const mapping = mappings.find(item => item && String(item.value) === String(value))
    if (mapping && Object.hasOwn(mapping, 'text')) return String(mapping.text)
  } else if (mappings && typeof mappings === 'object' && Object.hasOwn(mappings, String(value))) return String(mappings[String(value)])
  return undefined
}
