// A rail's spacing is measured in metres between the rail/lane centre lines.
// Authored offsets/lengths remain line-local scene coordinates. This calibration
// is not a transform scale or a claim that a model transfer port is reachable.
import { resolveLinePlacementTemplate } from './linePlacementTemplate.mjs'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
// Observe insertion/removal in reactive configuration objects while excluding
// inherited prototype values from the explicit saved-field contract.
const own = (value, key) => key in value && Object.prototype.hasOwnProperty.call(value, key)
const fail = message => { throw Object.assign(new Error(message), { code: 'LINE_RAIL_SPACING_INVALID' }) }
// Scene-unit calibration may make a valid metre distance much smaller than a
// fixed decimal quantum. Keep significant digits instead of erasing that gap.
const round = value => Number(value.toPrecision(15))
const validUnits = value => Number.isFinite(value) && value > 0 && value <= 100000
  && Number.isFinite(Math.fround(value)) && Math.fround(value) > 0
// Saved legacy movement strings use decimal/exponent syntax, not Number()'s
// extra hex/binary/octal forms. String.trim() supplies the ECMA whitespace set.
const decimalNumber = value => {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return NaN
  const text = value.trim()
  return /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) ? Number(text) : NaN
}
// Unity stores these declared coordinates and displacements as float32. A
// double-only gap is not a successful scene configuration: reject it without
// substituting a guessed position or an arbitrary minimum distance in metres.
const assertNativeTranslation = (origin, result, delta, message) => {
  const from = Math.fround(origin), to = Math.fround(result), displacement = Math.fround(delta)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(displacement)
    || delta !== 0 && (from === to || displacement === 0 || Math.sign(to - from) !== Math.sign(delta))) fail(message)
}

export function lineSceneUnitsPerMeter(layout = {}) {
  if (!object(layout)) fail('产线结构的场景单位配置格式无效，请在现有产线结构设置中校准')
  if (!own(layout, 'sceneUnitsPerMeter')) return 1
  const value = layout.sceneUnitsPerMeter
  if (typeof value !== 'number' || !validUnits(value)) fail('产线场景单位每米必须为大于 0、不超过 100000 且引擎可表示的有限正数，请在现有产线结构设置中校准')
  return value
}

const movementObject = movement => {
  let result
  try { result = typeof movement === 'string' ? JSON.parse(movement) : movement ?? {} }
  catch { fail('移动设置的场景单位配置无效，请在现有移动设置中校准') }
  if (!object(result)) fail('移动设置的场景单位配置无效，请在现有移动设置中校准')
  return result
}

export function movementSceneUnitsPerMeter(movement = {}) {
  const source = movementObject(movement), values = {}
  for (const key of ['sceneUnitsPerMeter', 'scene_units_per_meter']) {
    if (!own(source, key)) continue
    const units = decimalNumber(source[key])
    if (!validUnits(units)) fail(`移动设置的 ${key} 必须为大于 0、不超过 100000 且引擎可表示的有限场景单位每米，请在现有移动设置中校准`)
    values[key] = units
  }
  return values.sceneUnitsPerMeter ?? values.scene_units_per_meter ?? 1
}

// Contextual sources without an explicit movement calibration inherit their
// explicitly associated line. Nothing is materialised in a saved movement.
export function assertLineMovementUnits(movement, layout, name = '移动设备') {
  const source = movementObject(movement), lineUnits = lineSceneUnitsPerMeter(layout)
  if (!own(source, 'sceneUnitsPerMeter') && !own(source, 'scene_units_per_meter')) return lineUnits
  const units = movementSceneUnitsPerMeter(source)
  if (units !== lineUnits) fail(`「${name}」移动设置的场景单位每米 (${units}) 与产线结构 (${lineUnits}) 不一致，请在现有产线结构与移动设置中统一校准后保存`)
  return units
}

export function resolveLineRailSpacing(layout) {
  if (layout.placementTemplate !== undefined) return resolveLinePlacementTemplate(layout)
  const lanes = layout.lanes || [], units = lineSceneUnitsPerMeter(layout)
  return { ...layout, rails: (layout.rails || []).map(rail => {
    if (!own(rail, 'spacing') || rail.spacing === null || rail.spacing === undefined) {
      const { spacing, ...legacy } = rail
      return legacy
    }
    const value = rail.spacing, label = rail.name || rail.id || '小车导轨'
    if (!object(value) || Object.keys(value).some(key => !['laneId', 'distanceMeters', 'side'].includes(key))) fail(`「${label}」设备线间距设置格式无效`)
    if (typeof value.laneId !== 'string' || !value.laneId.trim()) fail(`「${label}」请选择关联设备线`)
    const matches = lanes.filter(lane => String(lane.id) === value.laneId)
    if (matches.length !== 1) fail(`「${label}」关联设备线不存在或编号重复，请重新选择`)
    if (typeof value.distanceMeters !== 'number' || !Number.isFinite(value.distanceMeters) || value.distanceMeters <= 0 || value.distanceMeters > 10000) fail(`「${label}」设备线与轨道中心距必须为大于 0、不超过 10000 的米数`)
    if (!['positive', 'negative'].includes(value.side)) fail(`「${label}」请选择导轨位于设备线的 +Z 或 −Z 侧`)
    const laneOffset = Number(matches[0].offsetZ), delta = (value.side === 'positive' ? 1 : -1) * value.distanceMeters * units
    const offsetZ = laneOffset + delta
    if (!Number.isFinite(offsetZ) || Math.abs(offsetZ) > 10000) fail(`「${label}」计算后的导轨偏移超出 ±10000 场景坐标范围`)
    const represented = round(offsetZ)
    if (offsetZ === laneOffset || represented === laneOffset || Math.sign(represented - laneOffset) !== Math.sign(delta)) fail(`「${label}」已配置的场景单位每米比例与坐标精度不足，正间距无法正确表示，请在现有产线结构设置中校准`)
    assertNativeTranslation(laneOffset, represented, delta, `「${label}」已配置的场景单位每米比例与坐标精度不足，Unity 坐标无法区分该正间距，请在现有产线结构设置中校准`)
    return { ...rail, spacing: { laneId: value.laneId, distanceMeters: value.distanceMeters, side: value.side }, offsetZ: represented }
  }) }
}

// User-field events deliberately materialise a constraint only when a lane is
// selected. Merely viewing/reopening an old layout never moves its rails.
export function editLineRailSpacing(layout, railId, field, value) {
  const next = { ...layout, rails: (layout.rails || []).map(rail => ({ ...rail, ...(rail.spacing ? { spacing: { ...rail.spacing } } : {}) })) }
  if (field === 'sceneUnitsPerMeter') {
    next.sceneUnitsPerMeter = decimalNumber(value)
    return resolveLineRailSpacing(next)
  }
  const rail = next.rails.find(item => String(item.id) === String(railId))
  if (!rail) fail('所选导轨不存在')
  if (field === 'laneId') {
    if (!value) { delete rail.spacing; return next }
    const lane = (next.lanes || []).find(item => String(item.id) === String(value))
    if (!lane) fail('所选设备线不存在')
    const difference = Number(rail.offsetZ) - Number(lane.offsetZ)
    if (!Number.isFinite(difference) || difference === 0) fail('设备线与导轨中心线重合，请先调整导轨偏移再设置间距')
    rail.spacing = { laneId: String(value), distanceMeters: Math.abs(difference) / lineSceneUnitsPerMeter(next), side: difference > 0 ? 'positive' : 'negative' }
  } else {
    if (!rail.spacing) fail('请先选择关联设备线')
    if (field === 'distanceMeters') rail.spacing.distanceMeters = Number(value)
    else if (field === 'side') rail.spacing.side = value
    else fail('不支持的设备线间距字段')
  }
  return resolveLineRailSpacing(next)
}

export function lineRailSpacingDeltas(before, after) {
  return (after.rails || []).map(rail => {
    const previous = Number((before.rails || []).find(old => String(old.id) === String(rail.id))?.offsetZ ?? rail.offsetZ)
    const next = Number(rail.offsetZ), delta = next - previous
    if (!Number.isFinite(delta)) fail('导轨位移无效')
    const represented = round(delta)
    assertNativeTranslation(previous, next, represented, '已配置的场景单位每米比例与导轨坐标精度不足，Unity 坐标无法区分非零导轨位移，导轨与移动配置均未保存')
    return { railId: rail.id, deltaZ: represented }
  })
    .filter(row => row.deltaZ !== 0)
}

// A track edit is a rigid translation of the carrier's configured geometry,
// never a change to its PLC IDs, mapping, speed or safety policy.
export function shiftRailMovement(instance, deltaZ, coordinateSpace = 'line_local') {
  if (!Number.isFinite(deltaZ)) fail('导轨位移无效')
  const source = typeof instance === 'string' ? JSON.parse(instance || '{}') : instance || {}
  const result = JSON.parse(JSON.stringify(source)), movement = result.movement
  if (deltaZ === 0 || !object(movement)) return result
  if (coordinateSpace !== 'line_local') {
    if (movement.enabled === true) fail('活动小车移动配置不是产线本地坐标，请先在设备编排中校准坐标后再改变导轨间距')
    return result
  }
  const valid = value => object(value) && ['x', 'y', 'z'].every(axis => typeof value[axis] === 'number' && Number.isFinite(value[axis]))
  if (movement.enabled === true) {
    if (!valid(movement.start) || !valid(movement.end) || Math.hypot(movement.end.x - movement.start.x, movement.end.z - movement.start.z) < .0001) fail('活动小车移动配置的轨道基准或方向无效，导轨与移动配置均未保存')
    if (movement.valueMode === 'station') {
      const stations = movement.stations, ids = new Set()
      if (!Array.isArray(stations) || stations.length === 0 || stations.some(station => {
        if (!object(station) || typeof station.value !== 'number' || !Number.isFinite(station.value) || ids.has(station.value) || !valid(station.position || station)) return true
        ids.add(station.value); return false
      })) fail('活动小车工位编号或坐标无效，导轨与移动配置均未保存')
    }
  }
  const shift = value => {
    if (!valid(value)) {
      if (movement.enabled === true) fail('活动小车移动配置的起终点或工位坐标无效，导轨与移动配置均未保存')
      return value
    }
    const translated = value.z + deltaZ
    if (!Number.isFinite(translated)) fail('计算后的移动坐标无效，导轨与移动配置均未保存')
    const represented = round(translated)
    if (translated === value.z || represented === value.z || Math.sign(represented - value.z) !== Math.sign(deltaZ)) fail('已配置的场景单位每米比例与移动坐标精度不足，非零导轨位移无法正确表示，导轨与移动配置均未保存')
    assertNativeTranslation(value.z, represented, deltaZ, '已配置的场景单位每米比例与移动坐标精度不足，Unity 坐标无法区分非零导轨位移，导轨与移动配置均未保存')
    return { ...value, z: represented }
  }
  if (movement.start !== undefined) movement.start = shift(movement.start)
  if (movement.end !== undefined) movement.end = shift(movement.end)
  if (Array.isArray(movement.stations)) movement.stations = movement.stations.map(station => {
    if (!object(station)) { if (movement.enabled === true) fail('活动小车工位配置无效'); return station }
    return station.position !== undefined ? { ...station, position: shift(station.position) } : shift(station)
  })
  return result
}
