// Group placement operates on one common delta, never independently clamps members.
const number = value => { const result = Number(value); if (!Number.isFinite(result)) throw new Error('设备位置无效'); return result }
const rounded = value => Number(value.toPrecision(15))
export function chooseLineDevices(ids, id, additive = false) {
  if (additive) return ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]
  return ids.includes(id) ? [...ids] : [id]
}
export function planLineGroupMove(rows, anchorId, desiredX, target, targets) {
  const anchor = rows.find(row => row.id === anchorId)
  if (!anchor || !target || rows.some(row => !row.binding)) throw new Error('所选设备没有有效的设备线或导轨')
  const dz = number(target.item.offsetZ) - number(anchor.binding.item.offsetZ)
  const placed = rows.map(row => {
    const binding = Math.abs(dz) < .00001 ? targets.find(candidate => candidate.type === row.binding.type && candidate.item.id === row.binding.item.id)
      : targets.find(candidate => candidate.type === row.binding.type && Math.abs(number(candidate.item.offsetZ) - number(row.binding.item.offsetZ) - dz) < .00001)
    if (!binding) throw new Error('没有匹配的设备线或导轨，不能整组放置')
    return { ...row, binding }
  })
  const min = Math.max(...placed.map(row => -number(row.binding.item.length) / 2 - number(row.x)))
  const max = Math.min(...placed.map(row => number(row.binding.item.length) / 2 - number(row.x)))
  if (min > max) throw new Error('设备组超出目标设备线长度')
  const delta = Math.min(max, Math.max(min, Math.round((number(desiredX) - number(anchor.x)) * 2) / 2))
  return placed.map(row => ({ ...row, x: rounded(number(row.x) + delta), z: rounded(number(row.z ?? (number(row.binding.item.offsetZ)-dz)) + dz) }))
}
export function spaceLineDevices(rows, gap, sceneUnitsPerMeter = 1) {
  if (rows.length < 2 || rows.some(row => !row.binding)) throw new Error('请先多选设备')
  const binding = rows[0].binding
  if (rows.some(row => row.binding.type !== binding.type || row.binding.item.id !== binding.item.id)) throw new Error('请在同一设备线或导轨内选择设备')
  const sorted = rows.slice().sort((a, b) => number(a.x) - number(b.x) || String(a.id).localeCompare(String(b.id)))
  if (gap === undefined && rows.length < 3) throw new Error('自动等间距至少需要三台设备')
  if (gap !== undefined && (typeof sceneUnitsPerMeter !== 'number' || !Number.isFinite(sceneUnitsPerMeter) || sceneUnitsPerMeter <= 0 || sceneUnitsPerMeter > 100000)) throw new Error('产线场景单位每米无效，请先在产线结构设置中校准')
  // A manual human field is in metres; selected positions and bounds remain
  // scene coordinates. Automatic equal spacing never rescales either endpoint.
  const spacing = gap === undefined ? (number(sorted.at(-1).x) - number(sorted[0].x)) / (rows.length - 1) : number(gap) * sceneUnitsPerMeter
  if (spacing <= 0) throw new Error('请填写大于零的设备中心间距')
  const positions = sorted.map((row, i) => ({ ...row, x: rounded(number(sorted[0].x) + i * spacing), z: number(row.z ?? binding.item.offsetZ) }))
  if (positions.some((row, i) => i > 0 && row.x <= positions[i - 1].x)) throw new Error('设备中心距低于当前场景坐标精度，请在产线结构中校准单位或调整已配置坐标')
  if (positions.some(row => Math.abs(row.x) > number(binding.item.length) / 2 + .000001)) throw new Error('间距超出设备线长度，请减小间距')
  return positions
}
