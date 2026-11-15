import { deviceLocalToWorld, parentToLocalPoint, normalizeWorkshopLayout, parseSpatialObject, deviceRotationRadians } from '../../../utils/spatialLayout.js'

export const TRANSFORM_KEYS = ['pos_x', 'pos_y', 'pos_z', 'rotation_y']
export const transformValues = device => Object.fromEntries(TRANSFORM_KEYS.map(key => [key, Number(device[key] || 0)]))
export function workshopYawFromQuaternion(q, before, parentYaw = 0) {
  // Euler.y folds back beyond 90 degrees in XYZ order. Extract the horizontal
  // forward direction, then unwrap relative to the gesture's original yaw.
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
  const reference = deviceRotationRadians(before), delta = yaw - reference - parentYaw
  return reference + Math.atan2(Math.sin(delta), Math.cos(delta))
}
export function workshopFrame(device, workshop, line) {
  const origin = deviceLocalToWorld({ ...device, pos_x: 0, pos_y: 0, pos_z: 0, rotation_y: 0 }, workshop, line)
  return { ...origin, yaw: origin.rotationY }
}
export function workshopWorldToLocal(point, device, workshop, line) {
  if (device.coordinate_space === 'line_local' && line) return parentToLocalPoint(parentToLocalPoint(point, normalizeWorkshopLayout(workshop?.layout || workshop?.layout_json).transform), parseSpatialObject(line.layout || line.layout_json).transform)
  if (device.coordinate_space === 'workshop_local') return parentToLocalPoint(point, normalizeWorkshopLayout(workshop?.layout || workshop?.layout_json).transform)
  return { x: point.x, y: point.y, z: point.z }
}
export function constrainWorkshopTransform(before, candidate, { mode = 'translate', spatial = false, cart = false, binding, units = 1, step = .1 } = {}) {
  const next = transformValues(before)
  if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(step) || step <= 0) throw Error('移动步长或产线单位无效')
  if (mode === 'rotate') {
    if (!Number.isFinite(candidate.rotation_y)) throw Error('设备朝向无效')
    const angle = deviceRotationRadians(before.rotation_y), delta = candidate.rotation_y - angle
    next.rotation_y = angle + Math.round(delta / (Math.PI / 180)) * Math.PI / 180
    return next
  }
  for (const axis of ['x', 'y', 'z']) {
    const key = 'pos_' + axis
    if (!Number.isFinite(candidate[key])) throw Error('设备位置无效')
    const allowed = axis === 'x' || !cart && (spatial || !binding && axis === 'z')
    if (allowed) next[key] = Number((next[key] + Math.round((candidate[key] - next[key]) / (step * units)) * step * units).toFixed(9))
  }
  if (binding && Number.isFinite(binding.item.length)) next.pos_x = Math.max(-binding.item.length / 2, Math.min(binding.item.length / 2, next.pos_x))
  return next
}

// Source-checked gesture history: never undo unrelated form edits or a reload.
export class WorkshopTransformHistory {
  constructor(limit = 80) { this.limit = limit; this.undo = []; this.redo = [] }
  push(id, before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) return
    this.undo.push({ id, before: JSON.parse(JSON.stringify(before)), after: JSON.parse(JSON.stringify(after)) }); this.undo = this.undo.slice(-this.limit); this.redo = []
  }
  take(redo, current) {
    const from = redo ? this.redo : this.undo, entry = from.at(-1)
    if (!entry) return null
    if (JSON.stringify(current(entry.id)) !== JSON.stringify(redo ? entry.before : entry.after)) { this.clear(); return null }
    from.pop(); (redo ? this.undo : this.redo).push(entry)
    return { id: entry.id, value: structuredClone(redo ? entry.after : entry.before) }
  }
  clear() { this.undo = []; this.redo = [] }
}
