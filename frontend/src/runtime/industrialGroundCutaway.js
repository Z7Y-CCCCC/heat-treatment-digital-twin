// View-only excavation: saved ground and equipment transforms stay unchanged.
// Actual triangles are removed, so drawing, outlines and picking agree.
const EPS = 1e-7
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
const area = polygon => polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]; return sum + p[0] * q[1] - q[0] * p[1] }, 0) / 2
const bounds = points => ({ x0: Math.min(...points.map(p => p[0])), x1: Math.max(...points.map(p => p[0])), z0: Math.min(...points.map(p => p[1])), z1: Math.max(...points.map(p => p[1])) })
const overlaps = (a, b) => a.x1 > b.x0 + EPS && b.x1 > a.x0 + EPS && a.z1 > b.z0 + EPS && b.z1 > a.z0 + EPS
function hull(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const half = values => { const result = []; for (const p of values) { while (result.length > 1 && cross(result.at(-2), result.at(-1), p) <= EPS) result.pop(); result.push(p) }; return result }
  return [...half(sorted).slice(0, -1), ...half(sorted.slice().reverse()).slice(0, -1)]
}
function clip(polygon, a, b, inside) {
  const result = []
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length], dp = cross(a, b, p), dq = cross(a, b, q)
    const keepP = inside ? dp >= -EPS : dp <= EPS, keepQ = inside ? dq >= -EPS : dq <= EPS
    if (keepP) result.push(p)
    if (keepP !== keepQ) { const t = dp / (dp - dq); result.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]) }
  }
  return result.filter((p, i) => i === 0 || Math.hypot(p[0] - result[i - 1][0], p[1] - result[i - 1][1]) > EPS)
}
function subtract(subject, cut) {
  if (!overlaps(bounds(subject), cut.bounds)) return [subject]
  let remaining = subject
  const pieces = []
  for (let i = 0; i < cut.points.length && remaining.length >= 3; i++) {
    const a = cut.points[i], b = cut.points[(i + 1) % cut.points.length]
    const outside = clip(remaining, a, b, false)
    if (outside.length >= 3 && Math.abs(area(outside)) > EPS) pieces.push(outside)
    remaining = clip(remaining, a, b, true)
  }
  return pieces
}

// Merge the resolved lower cells, not the raw areas: overlaps and platforms
// can fill a pit, in which case there must be no phantom excavation.
function groundRectangles(mesh, include) {
  const result = [], active = new Map()
  for (let z = 0; z < mesh.heights.length; z++) {
    const next = new Map(), row = mesh.heights[z]
    for (let x = 0; x < row.length;) {
      const y = row[x], start = x++
      while (x < row.length && row[x] === y) x++
      if (!include(y)) continue
      const key = `${mesh.xs[start]}:${mesh.xs[x]}:${y}`
      const rectangle = active.get(key) || { x0: mesh.xs[start], x1: mesh.xs[x], z0: mesh.zs[z], z1: mesh.zs[z], y }
      if (!active.has(key)) result.push(rectangle)
      rectangle.z1 = mesh.zs[z + 1]; next.set(key, rectangle)
    }
    active.clear(); for (const [key, value] of next) active.set(key, value)
  }
  return result
}

export const groundPitRectangles = (mesh, elevation) => groundRectangles(mesh, y => y < elevation - EPS)

// Global X/Z partitioning splits even distant coplanar tiles. Merge those
// tiles and collinear walls once, before interactive view clipping; 64 pits
// must not require tens of thousands of polygon subtractions on every orbit.
export function simplifyGroundMesh(mesh) {
  const positions = [], indices = [], surface = [], tops = new Set(mesh.surface), walls = new Map()
  const quad = (points, top = false) => {
    const n = positions.length / 3
    positions.push(...points.flat()); indices.push(n, n + 1, n + 2, n, n + 2, n + 3)
    if (top) surface.push(n)
  }
  for (const r of groundRectangles(mesh, () => true)) quad([[r.x0, r.y, r.z0], [r.x0, r.y, r.z1], [r.x1, r.y, r.z1], [r.x1, r.y, r.z0]], true)
  for (let n = 0; n < mesh.positions.length / 3; n += 4) {
    if (tops.has(n)) continue
    const p = Array.from({ length: 4 }, (_, i) => mesh.positions.slice((n + i) * 3, (n + i + 1) * 3)), [a, b, c] = p
    const axis = a[0] === b[0] && b[0] === c[0] ? 0 : 2, span = axis === 0 ? 2 : 0
    const normal = axis === 0 ? (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]) : (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    const lo = Math.min(...p.map(v => v[1])), hi = Math.max(...p.map(v => v[1])), sign = Math.sign(normal), key = `${axis}:${a[axis]}:${lo}:${hi}:${sign}`
    if (!walls.has(key)) walls.set(key, { axis, coordinate: a[axis], lo, hi, sign, spans: [] })
    walls.get(key).spans.push([Math.min(...p.map(v => v[span])), Math.max(...p.map(v => v[span]))])
  }
  for (const { axis, coordinate: v, lo, hi, sign, spans } of walls.values()) {
    const merged = []
    for (const s of spans.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1)
      if (previous && s[0] <= previous[1] + EPS) previous[1] = Math.max(previous[1], s[1]); else merged.push(s.slice())
    }
    for (const [a, b] of merged) {
      const points = axis === 0 ? [[v, lo, a], [v, hi, a], [v, hi, b], [v, lo, b]] : [[a, lo, v], [b, lo, v], [b, hi, v], [a, hi, v]]
      quad(sign < 0 ? points.reverse() : points)
    }
  }
  return { ...mesh, positions, indices, surface }
}

function aperture(pit, y, camera) {
  if (y <= pit.y + EPS) return null // retain the pit bottom
  const corners = [[pit.x0, pit.z0], [pit.x1, pit.z0], [pit.x1, pit.z1], [pit.x0, pit.z1]]
  let projected
  if (camera.orthographic) {
    const direction = camera.direction
    if (!direction || direction.y >= -EPS) return null
    const distance = (y - pit.y) / -direction.y
    projected = corners.map(p => [p[0] - direction.x * distance, p[1] - direction.z * distance])
  } else {
    if (camera.y <= y + EPS) return null
    const t = (y - camera.y) / (pit.y - camera.y)
    projected = corners.map(p => [camera.x + (p[0] - camera.x) * t, camera.z + (p[1] - camera.z) * t])
  }
  const points = hull([...corners, ...projected])
  return points.length >= 3 ? { points, bounds: bounds(points) } : null
}

export function buildGroundCutaway(mesh, elevation, camera, pits = groundPitRectangles(mesh, elevation)) {
  if (!pits.length) return mesh
  const positions = [], indices = [], surfaces = new Set(mesh.surface), cutsByHeight = new Map()
  const add = (points, top = false) => {
    const n = positions.length / 3
    positions.push(...points.flat())
    for (let i = 1; i + 1 < points.length; i++) indices.push(n, n + (top ? i + 1 : i), n + (top ? i : i + 1))
  }
  for (let n = 0; n < mesh.positions.length / 3; n += 4) {
    const points = Array.from({ length: 4 }, (_, i) => mesh.positions.slice((n + i) * 3, (n + i + 1) * 3))
    if (surfaces.has(n)) {
      const y = points[0][1]
      if (!cutsByHeight.has(y)) cutsByHeight.set(y, pits.map(pit => aperture(pit, y, camera)).filter(Boolean))
      let pieces = [points.map(p => [p[0], p[2]]).reverse()]
      const rectangle = bounds(pieces[0])
      for (const cut of cutsByHeight.get(y)) {
        if (!overlaps(rectangle, cut.bounds)) continue
        pieces = pieces.flatMap(piece => subtract(piece, cut))
        if (!pieces.length) break
      }
      for (const piece of pieces) if (piece.length >= 3 && Math.abs(area(piece)) > EPS) add(piece.map(p => [p[0], y, p[1]]), true)
    } else {
      // Retaining-wall normals face the lower side. Remove only the exterior
      // front faces of pits; keep the rear/side boundary and raised platforms.
      if (Math.min(...points.map(p => p[1])) < elevation - EPS) {
        const a = points[0], b = points[1], c = points[2]
        const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1])
        const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        const dx = camera.orthographic ? -camera.direction.x : camera.x - (a[0] + c[0]) / 2
        const dz = camera.orthographic ? -camera.direction.z : camera.z - (a[2] + c[2]) / 2
        if (nx * dx + nz * dz < -EPS) continue
      }
      add(points)
    }
  }
  return { positions, indices }
}
