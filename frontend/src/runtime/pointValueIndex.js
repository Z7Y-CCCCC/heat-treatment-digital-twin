// Stable presentation identities: a PLC scan for one device must not replace
// every other point prop and rerender all dashboard cards. No sampling, clock
// rewriting or throttling: every supplied observation is applied in order.
export function createPointValueIndex(wrap = value => value) {
  const records = wrap({}), devices = new Map()
  const path = (value, key) => String(key || '').split('.').reduce((v, k) => v?.[k], value)
  let pointVisits = 0
  function update(rows) {
    const retained = new Set(rows.map(row => String(row.id)))
    for (const [id, cache] of devices) if (!retained.has(id)) {
      for (const key of cache.keys) delete records[key]
      devices.delete(id)
    }
    for (const row of rows) {
      const id = String(row.id), frame = row.frame || null, quality = row.quality || 'bad'
      let cache = devices.get(id)
      const definitionsChanged = !cache || cache.revision !== row.revision || cache.points !== row.points
      if (!definitionsChanged && cache.frame === frame && cache.quality === quality) continue
      if (definitionsChanged) {
        if (cache) for (const key of cache.keys) delete records[key]
        cache = { revision: row.revision, points: row.points, keys: [], entries: [] }
        for (const point of row.points || []) {
          const record = wrap({ ...point }), keys = [String(point.id), `${id}:${point.id}`]
          for (const key of keys) { records[key] = record; cache.keys.push(key) }
          cache.entries.push({ point, record })
        }
        devices.set(id, cache)
      }
      for (const { point, record } of cache.entries) {
        pointVisits++
        const category = point.category || point.category_resolved || 'analog', field = point.value_role || point.name
        record.value = path(frame, `${category}.${field}`)
        record.quality = path(frame, `quality.${category}.${field}`) || quality
        record.device_id = row.id
        record.lastReadAt = frame?.pointMeta?.[`${category}.${field}`]?.lastReadAt || frame?.timestamp || null
      }
      cache.frame = frame; cache.quality = quality
    }
    return records
  }
  return { records, update, get pointVisits() { return pointVisits } }
}
