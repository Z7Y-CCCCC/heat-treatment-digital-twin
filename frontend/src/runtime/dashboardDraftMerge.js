// Three-way merge of JSON dashboard drafts. Never guess a base for legacy
// drafts: their first explicit resolution must retain a recoverable copy.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const serverMetadata = new Set(['revision', 'updatedAt', 'publishedAt', 'version', 'source'])

function equal(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equal(item, b[index]))
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

export function mergeDashboardDrafts(baseline, local, server) {
  const conflicts = []
  const prepare = document => {
    if (!document) return undefined
    const next = copy(document)
    if (record(next.metadata)) for (const key of serverMetadata) {
      if (Object.hasOwn(server.metadata || {}, key)) next.metadata[key] = copy(server.metadata[key])
      else delete next.metadata[key]
    }
    return next
  }
  const merge = (base, ours, theirs, path = '') => {
    if (path.startsWith('metadata.') && serverMetadata.has(path.slice(9))) return copy(theirs)
    if (equal(ours, theirs)) return copy(theirs)
    if (equal(ours, base)) return copy(theirs)
    if (equal(theirs, base)) return copy(ours)
    if (record(base) && record(ours) && record(theirs)) {
      const result = {}
      for (const key of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
        const value = merge(base[key], ours[key], theirs[key], path ? `${path}.${key}` : key)
        if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
      }
      return result
    }
    const keyed = value => Array.isArray(value) && value.every(item => record(item) && typeof item.id === 'string' && item.id)
      && new Set(value.map(item => item.id)).size === value.length
    if ([base, ours, theirs].every(keyed)) {
      const maps = [base, ours, theirs].map(items => new Map(items.map(item => [item.id, item])))
      // Stable-ID collections may contain independent additions/deletions.
      // Conflicting reorders are explicit rather than silently changing z-order.
      const common = base.filter(item => maps[1].has(item.id) && maps[2].has(item.id)).map(item => item.id)
      const commonIds = new Set(common)
      const order = items => items.map(item => item.id).filter(id => commonIds.has(id))
      const ourOrder = order(ours), theirOrder = order(theirs)
      if (!equal(ourOrder, common) && !equal(theirOrder, common) && !equal(ourOrder, theirOrder)) conflicts.push(`${path}（排列顺序）`)
      const preferred = !equal(ourOrder, common) ? ours : theirs
      const ids = [...new Set([...preferred, ...ours, ...theirs].map(item => item.id))]
      return ids.map(id => merge(...maps.map(map => map.get(id)), `${path}[${id}]`)).filter(item => item !== undefined)
    }
    conflicts.push(path || '整份草稿（缺少旧版基线）')
    return copy(ours)
  }
  return { document: merge(prepare(baseline), prepare(local), server), conflicts }
}
