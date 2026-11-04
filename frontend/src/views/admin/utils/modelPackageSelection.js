export const MAX_PACKAGE_SELECTION = 32

export function modelPackageActions(model) {
  let metadata = model?.metadata || {}
  try { if (typeof metadata === 'string') metadata = JSON.parse(metadata) } catch { metadata = {} }
  const clips = Array.isArray(model?.motion_package?.actions) ? model.motion_package.actions : []
  const parts = Array.isArray(metadata?.partBindings) ? metadata.partBindings : []
  return [...clips.map((a, i) => ({ id: `clip:${a.id || i}`, name: a.label || a.name || a.id || `动作 ${i + 1}` })),
    ...parts.map((a, i) => ({ id: `part:${a.id || i}`, name: a.name || a.node_name || a.id || `部件 ${i + 1}` }))]
}

export function toggleModelSelection(ids, id, limit = MAX_PACKAGE_SELECTION) {
  if (ids.includes(id)) return ids.filter(value => value !== id)
  if (ids.length >= limit) throw new Error(`一次最多选择 ${limit} 个模型`)
  return [...ids, id]
}

// Process one file at a time: bounded memory, isolated failures, and no replay
// of completed imports when retrying the failed rows of a partially saved batch.
export async function runPackageQueue(rows, run, { eligible = () => true, stopped = () => false } = {}) {
  const results = []
  for (const row of rows) {
    if (stopped()) break
    if (!eligible(row)) continue
    try { results.push({ row, value: await run(row) }) }
    catch (error) { results.push({ row, error }); if (error.name === 'AbortError') break }
  }
  return results
}
