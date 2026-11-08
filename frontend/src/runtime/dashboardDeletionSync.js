// Only an explicit, factory-scoped backend deletion acknowledgement can enter
// this path. Missing directory entries are not deletion evidence.
import { cleanupDeletedDeviceContent } from '../../../shared/dashboardDeviceDeletion.mjs'
import { cacheFactoryDraft, listFactoryDrafts } from './factoryDraftCache.js'

export const DASHBOARD_DEVICE_DELETION_EVENT = 'digital-twin-dashboard-device-deletion'
const clone = value => JSON.parse(JSON.stringify(value))
const record = value => value && typeof value === 'object' && !Array.isArray(value)
const id = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value : ''
const ids = value => Array.isArray(value) && value.length <= 20000 ? [...new Set(value.map(id).filter(Boolean))] : []
const revision = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const safeStorage = () => { try { return globalThis.window?.localStorage } catch { return null } }

export function normalizeDashboardDeletionCleanup(value) {
  if (!record(value) || !id(value.factoryId) || !Array.isArray(value.deletedDeviceIds) || !Array.isArray(value.scenes) || value.scenes.length > 1000) return null
  const scenes = []
  for (const scene of value.scenes) {
    if (!record(scene) || !id(scene.sceneId)) return null
    const beforeRevision = revision(scene.beforeRevision), nextRevision = revision(scene.revision)
    if (beforeRevision === null || nextRevision === null || nextRevision < beforeRevision) return null
    scenes.push({ sceneId: scene.sceneId, beforeRevision, revision: nextRevision,
      removedWidgetIds: ids(scene.removedWidgetIds), removedViewIds: ids(scene.removedViewIds),
      removedTooltipTemplateIds: ids(scene.removedTooltipTemplateIds), updatedWidgetIds: ids(scene.updatedWidgetIds),
      removedTooltipWidgetIds: Array.isArray(scene.removedTooltipWidgetIds) ? scene.removedTooltipWidgetIds
        .filter(entry => record(entry) && id(entry.templateId)).map(entry => ({ templateId: entry.templateId, widgetIds: ids(entry.widgetIds) })) : [] })
  }
  if (new Set(scenes.map(scene => scene.sceneId)).size !== scenes.length) return null
  return { factoryId: value.factoryId, deletedDeviceIds: ids(value.deletedDeviceIds), scenes,
    ...(Array.isArray(value.remainingDeviceIds) && value.remainingDeviceIds.length <= 20000 && value.remainingDeviceIds.every(item => id(item)) ? { remainingDeviceIds: ids(value.remainingDeviceIds) } : {}),
    ...(id(value.id) ? { id: value.id } : {}), ...(typeof value.deletedAt === 'string' ? { deletedAt: value.deletedAt } : {}) }
}

export function dashboardDeletionAcknowledgementKey(cleanup) {
  return cleanup.id || JSON.stringify([cleanup.factoryId, cleanup.deletedDeviceIds,
    cleanup.scenes.map(scene => [scene.sceneId, scene.beforeRevision, scene.revision])])
}

export function dashboardDeletionRevision(current, scene) {
  const client = revision(current)
  if (!scene) return { revision: client, conflict: false, stale: false }
  if (client === null) return { revision: client, conflict: true, stale: false }
  if (client > scene.revision) return { revision: client, conflict: false, stale: true }
  if (client === scene.beforeRevision || client === scene.revision) return { revision: scene.revision, conflict: false, stale: false }
  // Another edit occurred between this client's base and the deletion. Keep
  // its edits and old CAS revision; advancing would overwrite that other edit.
  return { revision: client, conflict: true, stale: false }
}

export function reconcileDashboardDeletionPayload(payload, rawCleanup, { factoryId = payload?.factoryId || '', cleanupDocument = cleanupDeletedDeviceContent } = {}) {
  const cleanup = normalizeDashboardDeletionCleanup(rawCleanup)
  if (!cleanup || !payload?.document || !Array.isArray(payload.document.widgets) || String(factoryId) !== cleanup.factoryId) return { payload, changed: false, conflict: false, ignored: true }
  const sceneId = String(payload.sceneId || payload.document.sceneId || '')
  if (!sceneId) return { payload, changed: false, conflict: false, ignored: true }
  if (payload.sceneId && payload.document.sceneId && String(payload.sceneId) !== String(payload.document.sceneId)) return { payload, changed: false, conflict: false, ignored: true }
  const scene = cleanup.scenes.find(item => item.sceneId === sceneId)
  const originalRevision = payload.revision ?? payload.serverRevision
  const policy = dashboardDeletionRevision(originalRevision, scene)
  const key = dashboardDeletionAcknowledgementKey(cleanup)
  const processed = Array.isArray(payload.deletionAcknowledgements) ? payload.deletionAcknowledgements : []
  if (policy.stale || processed.includes(key)) return { payload, changed: false, conflict: !!payload.deletionConflict, ignored: true }
  const output = clone(payload)
  const options = { deviceIds: cleanup.deletedDeviceIds,
    ...(cleanup.remainingDeviceIds ? { existingDeviceIds: cleanup.remainingDeviceIds } : {}),
    ...(scene ? { confirmedRemovals: scene } : {}) }
  const transform = document => {
    const next = cleanupDocument(document, options).document
    if (scene && !policy.conflict && next.metadata && record(next.metadata)) next.metadata.revision = policy.revision
    return next
  }
  output.document = transform(output.document)
  if (output.baselineDocument && Array.isArray(output.baselineDocument.widgets)) output.baselineDocument = transform(output.baselineDocument)
  if (Array.isArray(output.history)) output.history = output.history.map(entry => record(entry) && entry.document && Array.isArray(entry.document.widgets)
    ? { ...entry, document: transform(entry.document) } : entry)
  if (scene && !policy.conflict) {
    if (Object.hasOwn(output, 'revision')) output.revision = policy.revision
    if (Object.hasOwn(output, 'serverRevision')) output.serverRevision = policy.revision
  }
  if (policy.conflict) output.deletionConflict = { factoryId: cleanup.factoryId, sceneId,
    originalRevision: policy.revision, beforeDeletionRevision: scene.beforeRevision, serverRevision: scene.revision }
  output.deletionAcknowledgements = [...processed.filter(item => typeof item === 'string'), key].slice(-100)
  const remaining = new Set(output.document.widgets.map(widget => String(widget.id)))
  if (Array.isArray(output.selectedIds)) output.selectedIds = output.selectedIds.filter(widgetId => remaining.has(String(widgetId)))
  if (cleanup.deletedDeviceIds.includes(String(output.editorDeviceId || ''))) output.editorDeviceId = ''
  const viewIds = new Set((output.document.scene?.views || []).map(view => String(view.id)))
  if (output.selectedViewId && !viewIds.has(String(output.selectedViewId))) output.selectedViewId = output.document.scene?.defaultViewId || ''
  return { payload: output, changed: JSON.stringify(output) !== JSON.stringify(payload),
    conflict: !!output.deletionConflict, ignored: false, cleanup }
}

export function reconcileDashboardDeletionHistory(payload, history, options = {}) {
  let current = payload, changed = false, conflict = !!payload?.deletionConflict
  // The backend retains 100 events plus one older-tombstone snapshot. Do not
  // discard the first real event merely because the snapshot was appended.
  for (const cleanup of Array.isArray(history) ? history.slice(-101) : []) {
    const result = reconcileDashboardDeletionPayload(current, cleanup, options)
    current = result.payload; changed ||= result.changed; conflict ||= result.conflict
  }
  return { payload: current, changed, conflict }
}

export function syncDashboardDeletionCaches(rawCleanup, { storage = safeStorage(), cleanupDocument = cleanupDeletedDeviceContent, trustedSceneIds = [] } = {}) {
  const cleanup = normalizeDashboardDeletionCleanup(rawCleanup)
  const report = { changedDrafts: 0, conflicts: 0, failures: 0 }
  if (!cleanup) return report
  const knownScenes = new Set([...cleanup.scenes.map(scene => scene.sceneId), ...ids(trustedSceneIds)])
  // The default active factory can be selected by the server while this
  // client still has an empty scope. Match those legacy drafts only by an
  // explicit payload owner or a globally unique scene confirmed by the server.
  const scopedDrafts = listFactoryDrafts(cleanup.factoryId)
  const unscopedDrafts = listFactoryDrafts('').filter(draft => {
    const payload = draft.payload
    if (!payload?.document || draft.type !== 'dashboard') return false
    const sceneId = String(payload.sceneId || payload.document.sceneId || '')
    return payload.factoryId ? payload.factoryId === cleanup.factoryId : knownScenes.has(sceneId)
  })
  for (const draft of [...scopedDrafts, ...unscopedDrafts]) {
    if (draft.type !== 'dashboard' || !draft.payload?.document) continue
    knownScenes.add(String(draft.payload.sceneId || draft.payload.document.sceneId || ''))
    try {
      const result = reconcileDashboardDeletionPayload(draft.payload, cleanup, { factoryId: cleanup.factoryId, cleanupDocument })
      if (result.changed) { cacheFactoryDraft(draft.factoryId, draft.editorId, draft.type, { ...result.payload, factoryId: cleanup.factoryId }); report.changedDrafts++ }
      if (result.conflict) report.conflicts++
    } catch { report.failures++ }
  }
  try {
    const keys = Array.from({ length: storage?.length || 0 }, (_, index) => storage.key(index))
    for (const key of keys) {
      if (!key?.startsWith('dashboard-designer-draft:')) continue
      try {
        const value = JSON.parse(storage.getItem(key) || 'null')
        if (!value?.document) continue
        const sceneId = String(value.sceneId || value.document.sceneId || key.slice('dashboard-designer-draft:'.length))
        // Older local records had no factory ID. A globally unique, confirmed
        // scene ID or its factory-scoped in-memory cache is required for them.
        if (value.factoryId ? value.factoryId !== cleanup.factoryId : !knownScenes.has(sceneId)) continue
        const result = reconcileDashboardDeletionPayload({ ...value, sceneId }, cleanup, { factoryId: cleanup.factoryId, cleanupDocument })
        if (result.changed) { storage.setItem(key, JSON.stringify({ ...result.payload, factoryId: cleanup.factoryId })); report.changedDrafts++ }
        if (result.conflict) report.conflicts++
      } catch { report.failures++ }
    }
  } catch { report.failures++ }
  return report
}

export function notifyDashboardDeviceDeletion(rawCleanup, { eventTarget = globalThis.window, ...options } = {}) {
  const cleanup = normalizeDashboardDeletionCleanup(rawCleanup)
  if (!cleanup) return false
  syncDashboardDeletionCaches(cleanup, options)
  const Event = eventTarget?.CustomEvent || globalThis.CustomEvent
  try { if (typeof Event === 'function') eventTarget?.dispatchEvent?.(new Event(DASHBOARD_DEVICE_DELETION_EVENT, { detail: cleanup })) } catch { /* The deletion is already committed; retain its successful API result. */ }
  return true
}
