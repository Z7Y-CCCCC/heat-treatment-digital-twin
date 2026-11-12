// A bounded DISPLAY-layout band, not a PLC position or mechanical reach claim.
// Compact templates allow up to 0.2 m, bounded by the original mechanism.
// Legacy layouts retain their 0.5 m presentation allowance until reapplied.
const fail = message => { throw Error(message) }
import {lineTemplateSpacingLimits} from './linePlacementTemplate.mjs'
export function lineAdjustmentBand(layout, rows, allowanceMeters = .5) {
  const t = layout?.placementTemplate
  if (!t) return null
  const units = layout.sceneUnitsPerMeter ?? 1, rail = layout.rails.find(row => row.id === t.railId)
  const primary = layout.lanes.find(row => row.id === t.primaryLaneId)
  if (!rail || !primary || !Number.isFinite(units) || units <= 0 || !Number.isFinite(allowanceMeters) || allowanceMeters <= 0) fail('微调范围缺少有效的导轨或设备线')
  for (const row of rows) if (['x','y','z','minX','maxX','minY','maxY','minZ','maxZ'].some(key => !Number.isFinite(row[key]))
    || ['X','Y','Z'].some(axis => row['max'+axis] <= row['min'+axis])) fail(`「${row.name || row.id}」外形未知，不能标为可微调区域`)
  const carts = rows.filter(row => row.railId === rail.id), gap = .6 * units
  const low = carts.length ? Math.min(...carts.map(row => Math.min(row.z, row.pathMinZ ?? row.z) + row.minZ)) : rail.offsetZ - .5 * units
  const high = carts.length ? Math.max(...carts.map(row => Math.max(row.z, row.pathMaxZ ?? row.z) + row.maxZ)) : rail.offsetZ + .5 * units
  const sign = t.primarySide === 'negative' ? -1 : 1
  let minimum = Math.max(2 * units, t.minimumDistance)
  const lanes = [[primary, sign]]
  if (t.kind === 'dual') {
    const secondary = layout.lanes.find(row => row.id === t.secondaryLaneId)
    if (!secondary) fail('第二条设备线不存在，不能标为可微调区域')
    // Legacy paired rows move symmetrically. The stricter side constrains both.
    lanes.push([secondary, -sign])
  }
  for (const [lane, side] of lanes) for (const row of rows.filter(row => row.laneId === lane.id)) {
    const relative = row.z - lane.offsetZ
    minimum = Math.max(minimum, side < 0 ? rail.offsetZ - low + gap + relative + row.maxZ : high - rail.offsetZ + gap - relative - row.minZ)
  }
  let reachMaximum=Infinity
  if(t.compact){const limits=lineTemplateSpacingLimits(layout,rows,lanes,rail,t.clearanceGapMeters??.15);minimum=Math.max(t.minimumDistance,Math.ceil((limits.minimum/units-1e-8)*20)/20*units);reachMaximum=limits.maximum;allowanceMeters=Math.min(allowanceMeters,.2)}
  else minimum = Math.ceil((minimum - 1e-8) * 10) / 10
  let maximum = Number(Math.min(minimum + allowanceMeters * units,reachMaximum).toFixed(6))
  if(maximum<minimum-1e-6)fail('这排设备距离不合适，请先点“进料面前后对齐”并重新选择布局模板')
  if (t.compact && (maximum < minimum || Math.fround(rail.offsetZ + sign * minimum) === Math.fround(rail.offsetZ + sign * maximum))) maximum = minimum
  const ends = [rail.offsetZ + sign * minimum, rail.offsetZ + sign * maximum]
  const minZ = Math.min(...ends), maxZ = Math.max(...ends)
  if (![minZ,maxZ].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)
      || !t.compact && Math.fround(minZ) === Math.fround(maxZ)) fail('当前坐标精度不足以表示微调范围')
  const currentDistance = (primary.offsetZ - rail.offsetZ) * sign
  return { laneId: primary.id, name: primary.name || primary.id, railId: rail.id, minZ, maxZ,
    minDistanceMeters: minimum / units, maxDistanceMeters: maximum / units,
    currentInside: currentDistance >= minimum - 1e-6 && currentDistance <= maximum + 1e-6,
    secondaryLaneId: t.kind === 'dual' ? t.secondaryLaneId : null }
}

export function clampLineAdjustment(z, band, step = .05) {
  if (!band || !Number.isFinite(z) || !Number.isFinite(step) || step <= 0) fail('设备线微调范围尚未检查')
  // Snap first, clamp last: a rounded coordinate must not cross the measured edge.
  return Number(Math.max(band.minZ, Math.min(band.maxZ, Math.round(z / step) * step)).toFixed(6))
}

export function lineAdjustmentBandStyle(band, bounds, length) {
  // Match linePreviewPercent's existing canvas margins exactly.
  const percent = (value, from, to) => Math.min(96, Math.max(4, (value - from) / (to - from) * 100))
  if (!band || !Number.isFinite(length) || length <= 0 || bounds.maxX <= bounds.minX || bounds.maxZ <= bounds.minZ) fail('画布微调范围坐标无效')
  const left = percent(-length / 2, bounds.minX, bounds.maxX), right = percent(length / 2, bounds.minX, bounds.maxX)
  const top = percent(band.minZ, bounds.minZ, bounds.maxZ), bottom = percent(band.maxZ, bounds.minZ, bounds.maxZ)
  // Include the whole 90px lane card at either end, not just its centre line.
  return { left: `calc(${left}% - 6px)`, width: `calc(${Math.max(8, right-left)}% + 38px)`,
    top: `calc(${top}% - 48px)`, height: `calc(${bottom-top}% + 96px)` }
}
