// Perspective frustum fit for all eight corners, including negative elevations.
export function fitCameraBox(bounds, { fov = 42, aspect = 1, direction = [.08, .6, .5], margin = 1.12 } = {}) {
    const normalize = v => { const length = Math.hypot(...v); return v.map(n => n / length) }
    const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0)
    const forward = normalize(direction)
    const right = normalize([forward[2], 0, -forward[0]])
    const up = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]]
    const center = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2]
    const tangent = Math.tan(fov * Math.PI / 360), horizontal = tangent * Math.max(.1, aspect)
    let distance = 10
    for (const x of [bounds.minX, bounds.maxX]) for (const y of [bounds.minY, bounds.maxY]) for (const z of [bounds.minZ, bounds.maxZ]) {
        const corner = [x - center[0], y - center[1], z - center[2]]
        distance = Math.max(distance, dot(corner, forward) + Math.abs(dot(corner, right)) * margin / horizontal,
            dot(corner, forward) + Math.abs(dot(corner, up)) * margin / tangent)
    }
    return { target: center, position: center.map((n, i) => n + forward[i] * distance) }
}
