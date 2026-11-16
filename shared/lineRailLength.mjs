// A single shared rail is a dependent layout dimension, not a second length
// the operator must maintain. Do not infer associations in legacy multi-rail
// layouts, or alter device positions / movement / PLC data here.
export function isLineRailLengthAutomatic(layout) {
  return layout?.rails?.length === 1 && layout?.lanes?.length > 0
}

export function syncLineRailLength(layout, occupiedLaneIds = []) {
  if (!isLineRailLengthAutomatic(layout)) return layout
  const occupied = new Set(occupiedLaneIds.map(String))
  const active = layout.lanes.filter(lane => occupied.has(String(lane.id)))
  // Before devices are assigned, the longest planned row provides a useful
  // scaffold. Once a row is occupied, an empty opposite row cannot extend it.
  const sources = active.length ? active : layout.lanes
  const lengths = sources.map(lane => Number(lane.length))
  if (lengths.some(length => !Number.isFinite(length) || length < 1)) throw Error('设备线长度无效，未同步小车导轨')
  const length = Math.max(...lengths)
  return { ...layout, rails: layout.rails.map(rail => ({ ...rail, length })) }
}
