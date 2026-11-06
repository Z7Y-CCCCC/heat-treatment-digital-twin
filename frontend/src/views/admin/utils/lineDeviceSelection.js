// Group placement operates on one common delta, never independently clamps members.
const number = value => { const result = Number(value); if (!Number.isFinite(result)) throw new Error('设备位置无效'); return result }
const rounded = value => Number(value.toFixed(6))
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
export function spaceLineDevices(rows, gap) {
  if (rows.length < 2 || rows.some(row => !row.binding)) throw new Error('请先多选设备')
  const binding = rows[0].binding
  if (rows.some(row => row.binding.type !== binding.type || row.binding.item.id !== binding.item.id)) throw new Error('请在同一设备线或导轨内选择设备')
  const sorted = rows.slice().sort((a, b) => number(a.x) - number(b.x) || String(a.id).localeCompare(String(b.id)))
  if (gap === undefined && rows.length < 3) throw new Error('自动等间距至少需要三台设备')
  const spacing = gap === undefined ? (number(sorted.at(-1).x) - number(sorted[0].x)) / (rows.length - 1) : number(gap)
  if (spacing <= 0) throw new Error('请填写大于零的设备中心间距')
  const positions = sorted.map((row, i) => ({ ...row, x: rounded(number(sorted[0].x) + i * spacing), z: number(row.z ?? binding.item.offsetZ) }))
  if (positions.some(row => Math.abs(row.x) > number(binding.item.length) / 2 + .000001)) throw new Error('间距超出设备线长度，请减小间距')
  return positions
}
