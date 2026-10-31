// Display codes are aliases only. Never write them back into model references.
function displayHash(id) {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < id.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(id.charCodeAt(i))) * 0x100000001b3n)
  hash = BigInt.asUintN(64, (hash ^ (hash >> 33n)) * 0xff51afd7ed558ccdn)
  hash = BigInt.asUintN(64, (hash ^ (hash >> 33n)) * 0xc4ceb9fe1a85ec53n)
  hash ^= hash >> 33n
  return hash.toString(16).padStart(16, '0').toUpperCase()
}
export function buildModelDisplayIds(ids, hash = displayHash) {
  const entries = [...new Set(ids.map(String))].sort().map(id => ({ id, hash: hash(id) }))
  const buckets = new Map()
  for (const entry of entries) {
    const prefix = entry.hash.slice(0, 8)
    if (!buckets.has(prefix)) buckets.set(prefix, [])
    buckets.get(prefix).push(entry)
  }
  return new Map(entries.map(entry => {
    const candidates = buckets.get(entry.hash.slice(0, 8))
    let size = 8
    while (size < 16 && candidates.some(other => other.id !== entry.id && other.hash.slice(0, size) === entry.hash.slice(0, size))) size += 2
    const peers = candidates.filter(other => other.hash === entry.hash)
    return [entry.id, `M-${entry.hash.slice(0, size)}${peers.length > 1 ? `-${peers.findIndex(other => other.id === entry.id) + 1}` : ''}`]
  }))
}
export function createShortModelId(existingIds = [], random = globalThis.crypto) {
  const used = new Set(existingIds.map(String))
  for (let attempt = 0; attempt < 32; attempt++) {
    const bytes = random.getRandomValues(new Uint8Array(6))
    const id = `m_${Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')}`
    if (!used.has(id)) return id
  }
  throw new Error('无法生成未使用的模型 ID，请重试')
}
