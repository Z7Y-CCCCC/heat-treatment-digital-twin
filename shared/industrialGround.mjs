export const MAX_GROUND_AREAS = 32
const number = (v, fallback = 0, min = -10000, max = 10000) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export function normalizeGround(value) {
  const source = object(value)
  return { version: 1, elevation: number(source.elevation, 0, -100, 100), areas: (Array.isArray(source.areas) ? source.areas : []).slice(0, MAX_GROUND_AREAS).map((area, i) => ({
    id: String(area?.id || `ground_${i}`).slice(0, 80), name: String(area?.name || '地面区域').slice(0, 60),
    x: number(area?.x), z: number(area?.z), width: number(area?.width, 8, .2, 5000), depth: number(area?.depth, 8, .2, 5000),
    elevation: number(area?.elevation, -2, -100, 100)
  })) }
}
export function validateGround(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.areas) || value.areas.length > MAX_GROUND_AREAS) throw new Error(`地面区域最多 ${MAX_GROUND_AREAS} 个`)
  const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
  if (!finite(value.elevation, -100, 100)) throw new Error('地面标高需为 -100 至 100 米')
  const ids = new Set()
  for (const area of value.areas) {
    if (!area || typeof area.id !== 'string' || !area.id || area.id.length > 80 || ids.has(area.id)) throw new Error('地面区域标识重复或无效')
    ids.add(area.id)
    if (!finite(area.x, -10000, 10000) || !finite(area.z, -10000, 10000) || !finite(area.width, .2, 5000) || !finite(area.depth, .2, 5000) || !finite(area.elevation, -100, 100)) throw new Error('区域尺寸或标高无效')
  }
  return normalizeGround(value)
}
export function normalizeDeviceGround(value) {
  const source = object(value)
  return { enabled: source.enabled === true, width: number(source.width, 8, .2, 500), depth: number(source.depth, 8, .2, 500), clearance: number(source.clearance, .5, 0, 20) }
}
function transformPoint(point, transform) {
  const t = object(transform), a = number(t.rotationY ?? t.rotation_y) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
  return { x: point.x * c - point.z * s + number(t.x), y: point.y + number(t.y), z: point.x * s + point.z * c + number(t.z) }
}
export function resolveGround(workshop) {
  const layout = object(workshop?.layout || workshop?.layout_json), ground = normalizeGround(layout.ground)
  const areas = [...ground.areas], entries = [...(workshop?.devices || []).map(device => ({ device, line: null })), ...(workshop?.lines || []).flatMap(line => (line.devices || []).map(device => ({ device, line })))]
  let automatic = 0
  for (const { device, line } of entries) {
    const setup = normalizeDeviceGround(object(device.instance_config).ground)
    if (!setup.enabled) continue
    if (++automatic > 64) continue
    let point = { x: number(device.pos_x), y: number(device.pos_y), z: number(device.pos_z) }
    const lineTransform = object(object(line?.layout || line?.layout_json).transform)
    let rotation = number(device.rotation_y)
    if (Math.abs(rotation) > Math.PI * 2 + .01) rotation *= Math.PI / 180
    if (device.coordinate_space === 'line_local' && line) { point = transformPoint(point, lineTransform); rotation += number(lineTransform.rotationY) * Math.PI / 180 }
    else if (device.coordinate_space !== 'workshop_local') {
      const t = object(layout.transform), a = -number(t.rotationY) * Math.PI / 180, x = point.x - number(t.x), z = point.z - number(t.z)
      point = { x: x * Math.cos(a) - z * Math.sin(a), y: point.y - number(t.y), z: x * Math.sin(a) + z * Math.cos(a) }
      rotation -= number(t.rotationY) * Math.PI / 180
    }
    if (Math.abs(point.y - ground.elevation) < .001) continue
    const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation)), width = setup.width * number(device.scale, 1, .001, 1000), depth = setup.depth * number(device.scale, 1, .001, 1000)
    areas.push({ id: `device:${device.id}`, name: device.name, x: point.x, z: point.z, width: c * width + s * depth + setup.clearance * 2, depth: s * width + c * depth + setup.clearance * 2, elevation: point.y })
  }
  return { ...ground, overflow: Math.max(0, automatic - 64), width: number(object(layout.size).width, 100, 10, 5000), depth: number(object(layout.size).depth, 80, 10, 5000), areas }
}

// Rectangular partitioning produces real openings and vertical retaining walls,
// not a second plane laid on top of the old floor. Later regions take priority.
export function buildGroundMesh(ground) {
  const hw = ground.width / 2, hd = ground.depth / 2
  const regions = ground.areas.map(a => ({ x0: Math.max(-hw, a.x - a.width / 2), x1: Math.min(hw, a.x + a.width / 2), z0: Math.max(-hd, a.z - a.depth / 2), z1: Math.min(hd, a.z + a.depth / 2), y: a.elevation })).filter(a => a.x1 > a.x0 && a.z1 > a.z0)
  const coordinates = values => [...new Set(values.map(v => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b)
  const xs = coordinates([-hw, hw, ...regions.flatMap(r => [r.x0, r.x1])]), zs = coordinates([-hd, hd, ...regions.flatMap(r => [r.z0, r.z1])])
  const heights = [], positions = [], indices = [], surface = []
  const quad = (points, top = false) => { const n = positions.length / 3; positions.push(...points.flat()); indices.push(n, n + 1, n + 2, n, n + 2, n + 3); if (top) surface.push(n) }
  for (let z = 0; z < zs.length - 1; z++) {
    heights[z] = []
    for (let x = 0; x < xs.length - 1; x++) {
      const mx = (xs[x] + xs[x + 1]) / 2, mz = (zs[z] + zs[z + 1]) / 2
      let y = ground.elevation
      for (const r of regions) if (mx >= r.x0 && mx < r.x1 && mz >= r.z0 && mz < r.z1) y = r.y
      heights[z][x] = y
      quad([[xs[x], y, zs[z]], [xs[x], y, zs[z + 1]], [xs[x + 1], y, zs[z + 1]], [xs[x + 1], y, zs[z]]], true)
    }
  }
  for (let z = 0; z < zs.length - 1; z++) for (let x = 0; x < xs.length - 1; x++) {
    const y = heights[z][x]
    if (x + 1 < xs.length - 1 && heights[z][x + 1] !== y) { const other = heights[z][x + 1]; quad([[xs[x + 1], y, zs[z]], [xs[x + 1], other, zs[z]], [xs[x + 1], other, zs[z + 1]], [xs[x + 1], y, zs[z + 1]]].reverse()) }
    if (z + 1 < zs.length - 1 && heights[z + 1][x] !== y) { const other = heights[z + 1][x]; quad([[xs[x], y, zs[z + 1]], [xs[x + 1], y, zs[z + 1]], [xs[x + 1], other, zs[z + 1]], [xs[x], other, zs[z + 1]]].reverse()) }
  }
  return { positions, indices, surface, xs, zs, heights }
}
