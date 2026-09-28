// Only serializable drafts live here. Editors may unmount without keeping their
// canvases, network subscriptions or component instances alive.
const drafts = new Map()
const copyDraft = value => JSON.parse(JSON.stringify(value))

function cacheKey(factoryId, editorId) {
  return `${String(factoryId || '')}\u0000${String(editorId || '')}`
}

export function readFactoryDraft(factoryId, editorId) {
  const payload = drafts.get(cacheKey(factoryId, editorId))?.payload
  return payload === undefined ? null : copyDraft(payload)
}

export function cacheFactoryDraft(factoryId, editorId, type, payload) {
  const key = cacheKey(factoryId, editorId)
  drafts.set(key, { factoryId: String(factoryId || ''), editorId, type, payload: copyDraft(payload) })
}

export function clearFactoryDraft(factoryId, editorId) {
  drafts.delete(cacheKey(factoryId, editorId))
}

export function listFactoryDrafts(factoryId) {
  return [...drafts.values()].filter(draft => draft.factoryId === String(factoryId || ''))
}

export function discardFactoryDrafts(factoryId) {
  for (const draft of listFactoryDrafts(factoryId)) {
    if (draft.type === 'dashboard' && draft.payload?.sceneId) {
      try { localStorage.removeItem(`dashboard-designer-draft:${draft.payload.sceneId}`) } catch { /* storage unavailable */ }
    }
    clearFactoryDraft(factoryId, draft.editorId)
  }
}

export async function saveFactoryDrafts(factoryId, adapters) {
  for (const draft of listFactoryDrafts(factoryId)) {
    const save = adapters[draft.type]
    if (typeof save !== 'function') throw new Error(`“${draft.editorId}”尚无跨页保存接口，已保留草稿且没有切换工厂`)
    await save(copyDraft(draft.payload))
    clearFactoryDraft(factoryId, draft.editorId)
    if (draft.type === 'dashboard' && draft.payload?.sceneId) {
      try { localStorage.removeItem(`dashboard-designer-draft:${draft.payload.sceneId}`) } catch { /* storage unavailable */ }
    }
  }
}
