import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dashboardDeletionRevision, normalizeDashboardDeletionCleanup, reconcileDashboardDeletionPayload,
  reconcileDashboardDeletionHistory, syncDashboardDeletionCaches, notifyDashboardDeviceDeletion, DASHBOARD_DEVICE_DELETION_EVENT } from '../src/runtime/dashboardDeletionSync.js'
import { cacheFactoryDraft, readFactoryDraft, clearFactoryDraft } from '../src/runtime/factoryDraftCache.js'

const copy = value => JSON.parse(JSON.stringify(value))
function document() {
  return { sceneId: 'scene-one', metadata: { revision: 5, author: 'Ethan' }, scene: { defaultViewId: 'overview', views: [
    { id: 'overview', mode: 'factory' }, { id: 'device', mode: 'device', targetId: '' },
    { id: 'private-view', mode: 'device', targetType: 'device', targetId: 'gone', parentViewId: 'device' }
  ] }, widgets: [
    { id: 'private-caption', type: 'text', content: { text: '专属标题' }, data: { mode: 'static', value: '原有标题' },
      style: { color: '#eef7ff', surfaceSkin: 'inline' }, frame: { x: 1, y: 2, width: 3, height: 4 },
      visibility: { viewIds: ['device'], rules: [{ source: 'context', path: 'deviceId', operator: '==', value: 'gone' }] } },
    { id: 'private-source', type: 'text', content: { text: '{value}' }, data: { mode: 'plc', pointId: '638', deviceId: 'gone' },
      visibility: { viewIds: ['private-view'] } },
    { id: 'shared-fixed', type: 'trend', data: { mode: 'plc', pointId: '638', deviceId: 'gone', deviceScope: 'fixed' },
      content: { text: '共享曲线，不可按绑定直接删除' }, visibility: { viewIds: ['overview'] } },
    { id: 'shared-title', type: 'text', content: { text: '原公共标题' }, style: { color: '#eef7ff', surfaceSkin: 'glass' },
      frame: { x: 22, y: 33, width: 44, height: 55 }, data: { mode: 'static', value: '不变' }, visibility: { viewIds: ['overview'] } }
  ], tooltipTemplates: { templates: [{ id: 'shared-tooltip', widgets: [
    { id: 'hover-value', type: 'text', data: { deviceScope: 'current', path: 'hover.device.temperature' } }
  ] }] } }
}
function acknowledgement(factoryId = 'factory-one', beforeRevision = 5, nextRevision = 6) {
  return { id: `delete-${factoryId}-${beforeRevision}`, factoryId, deletedDeviceIds: ['gone'], scenes: [{ sceneId: 'scene-one', beforeRevision, revision: nextRevision,
    removedWidgetIds: ['private-caption', 'private-source'], removedViewIds: ['private-view'], removedTooltipTemplateIds: [], removedTooltipWidgetIds: [], updatedWidgetIds: [] }] }
}
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial)); return {
    get length() { return data.size }, key: index => [...data.keys()][index], getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key)
  }
}

test('deletion revision rebases only the acknowledged base and keeps gaps or newer revisions safe', () => {
  const scene = acknowledgement().scenes[0]
  assert.deepEqual(dashboardDeletionRevision(5, scene), { revision: 6, conflict: false, stale: false })
  assert.deepEqual(dashboardDeletionRevision(6, scene), { revision: 6, conflict: false, stale: false })
  assert.deepEqual(dashboardDeletionRevision(4, scene), { revision: 4, conflict: true, stale: false })
  assert.deepEqual(dashboardDeletionRevision(9, scene), { revision: 9, conflict: false, stale: true })
  assert.deepEqual(dashboardDeletionRevision(undefined, scene), { revision: null, conflict: true, stale: false })
})

test('confirmed private removals preserve unrelated unsaved values, data, styles and every undo snapshot', () => {
  const baseline = document(), edited = copy(baseline)
  edited.widgets.find(w => w.id === 'shared-title').content.text = '尚未保存的新标题'
  edited.widgets.push({ id: 'local-private', type: 'text', content: { text: '仅本机新增' }, visibility: { rules: [{ source: 'context', path: 'deviceId', value: 'gone' }] } })
  const payload = { factoryId: 'factory-one', revision: 5, document: edited, baselineDocument: baseline,
    history: [{ label: '原画面', document: baseline }, { label: '修改标题', document: edited }],
    selectedIds: ['private-caption', 'shared-title'], selectedViewId: 'private-view', editorDeviceId: 'gone' }
  const original = copy(payload), result = reconcileDashboardDeletionPayload(payload, acknowledgement())
  assert.equal(result.changed, true); assert.equal(result.conflict, false); assert.equal(result.payload.revision, 6)
  assert.equal(result.payload.document.metadata.revision, 6)
  assert.deepEqual(payload, original, 'input editor objects are never mutated')
  assert.deepEqual(result.payload.document.widgets.map(w => w.id), ['shared-fixed', 'shared-title'])
  assert.equal(result.payload.document.widgets.find(w => w.id === 'shared-title').content.text, '尚未保存的新标题')
  assert.equal(result.payload.baselineDocument.widgets.find(w => w.id === 'shared-title').content.text, '原公共标题')
  assert.deepEqual(result.payload.document.widgets.find(w => w.id === 'shared-fixed'), original.document.widgets.find(w => w.id === 'shared-fixed'))
  assert.deepEqual(result.payload.document.tooltipTemplates, original.document.tooltipTemplates)
  assert.deepEqual(result.payload.selectedIds, ['shared-title']); assert.equal(result.payload.editorDeviceId, '')
  assert.equal(result.payload.selectedViewId, 'overview')
  for (const entry of result.payload.history) assert.ok(!entry.document.widgets.some(w => /private/.test(w.id)), 'Undo cannot resurrect a deleted owner')
  assert.deepEqual(result.payload.history.map(entry => entry.label), ['原画面', '修改标题'])
})

test('a confirmed server ID cannot survive a local unsaved change that made its rule shared', () => {
  const input = document(); input.widgets[0].visibility = { viewIds: ['overview'] }
  const result = reconcileDashboardDeletionPayload({ factoryId: 'factory-one', revision: 5, document: input }, acknowledgement())
  assert.ok(!result.payload.document.widgets.some(w => w.id === 'private-caption'))
})

test('revision conflicts remove confirmed owned content but retain the old CAS revision and all unrelated local edits', () => {
  const input = document(); input.widgets.find(w => w.id === 'shared-title').content.text = '必须保留'
  const result = reconcileDashboardDeletionPayload({ factoryId: 'factory-one', serverRevision: 2, document: input }, acknowledgement())
  assert.equal(result.conflict, true); assert.equal(result.payload.serverRevision, 2)
  assert.deepEqual(result.payload.deletionConflict, { factoryId: 'factory-one', sceneId: 'scene-one', originalRevision: 2, beforeDeletionRevision: 5, serverRevision: 6 })
  assert.equal(result.payload.document.widgets.find(w => w.id === 'shared-title').content.text, '必须保留')
  assert.ok(!result.payload.document.widgets.some(w => w.id === 'private-source'))
})

test('an older acknowledgement cannot rewrite a newer editor and duplicate delivery is idempotent', () => {
  const input = { factoryId: 'factory-one', revision: 9, document: document() }
  const stale = reconcileDashboardDeletionPayload(input, acknowledgement())
  assert.equal(stale.ignored, true); assert.equal(stale.payload, input)
  const first = reconcileDashboardDeletionPayload({ ...input, revision: 5 }, acknowledgement())
  const duplicate = reconcileDashboardDeletionPayload(first.payload, acknowledgement())
  assert.equal(duplicate.changed, false); assert.equal(duplicate.payload, first.payload)
})

test('backend history can rebase contiguous deletion-only revisions without dropping local edits', () => {
  const input = document(), first = acknowledgement(), second = acknowledgement('factory-one', 6, 7)
  second.id = 'second'; second.deletedDeviceIds = ['other']; second.scenes[0].removedWidgetIds = []; second.scenes[0].removedViewIds = []
  const result = reconcileDashboardDeletionHistory({ factoryId: 'factory-one', revision: 5, document: input }, [first, second])
  assert.equal(result.payload.revision, 7); assert.equal(result.conflict, false)
  assert.equal(result.payload.document.metadata.revision, 7)
  assert.deepEqual(result.payload.document.widgets.map(w => w.id), ['shared-fixed', 'shared-title'])
})

test('a scene untouched on the server still removes its locally added private component without advancing revision', () => {
  const cleanup = acknowledgement(); cleanup.scenes = []
  const result = reconcileDashboardDeletionPayload({ factoryId: 'factory-one', revision: 5, document: document() }, cleanup)
  assert.equal(result.payload.revision, 5); assert.equal(result.conflict, false)
  assert.ok(!result.payload.document.widgets.some(w => w.id === 'private-source'))
})

test('successful explicit deletion synchronizes unmounted caches and legacy local records, never another factory', t => {
  const factory = 'cache-owner'; const cleanup = acknowledgement(factory)
  cacheFactoryDraft(factory, 'dashboard:scene-one', 'dashboard', { sceneId: 'scene-one', revision: 5, document: document() })
  cacheFactoryDraft('other-factory', 'dashboard:scene-one', 'dashboard', { sceneId: 'scene-one', revision: 5, document: document() })
  cacheFactoryDraft(factory, 'settings', 'setting', { document: { title: '其他设置' } })
  t.after(() => { clearFactoryDraft(factory, 'dashboard:scene-one'); clearFactoryDraft(factory, 'settings'); clearFactoryDraft('other-factory', 'dashboard:scene-one') })
  const storage = memoryStorage({
    'dashboard-designer-draft:scene-one': JSON.stringify({ serverRevision: 5, document: document() }),
    'dashboard-designer-draft:other': JSON.stringify({ factoryId: 'other-factory', serverRevision: 5, document: { ...document(), sceneId: 'other' } }),
    'other-setting': '不改动'
  })
  const other = storage.getItem('dashboard-designer-draft:other'), report = syncDashboardDeletionCaches(cleanup, { storage })
  assert.equal(report.changedDrafts, 2); assert.equal(report.failures, 0)
  assert.equal(readFactoryDraft(factory, 'dashboard:scene-one').revision, 6)
  assert.equal(readFactoryDraft('other-factory', 'dashboard:scene-one').revision, 5)
  assert.deepEqual(readFactoryDraft(factory, 'settings'), { document: { title: '其他设置' } })
  const local = JSON.parse(storage.getItem('dashboard-designer-draft:scene-one'))
  assert.equal(local.serverRevision, 6); assert.equal(local.factoryId, factory)
  assert.ok(!local.document.widgets.some(w => w.id === 'private-caption'))
  assert.equal(storage.getItem('dashboard-designer-draft:other'), other)
  assert.equal(storage.getItem('other-setting'), '不改动')
})

test('malformed local cache data and blocked storage do not discard another draft or fail the server deletion', t => {
  const factory = 'broken-storage-owner'; cacheFactoryDraft(factory, 'dashboard:scene-one', 'dashboard', { sceneId: 'scene-one', revision: 5, document: document() })
  t.after(() => clearFactoryDraft(factory, 'dashboard:scene-one'))
  const report = syncDashboardDeletionCaches(acknowledgement(factory), { storage: { get length() { throw Error('disabled') } } })
  assert.equal(report.changedDrafts, 1); assert.equal(report.failures, 1)
  const malformed = memoryStorage({ 'dashboard-designer-draft:scene-one': '{broken' })
  assert.equal(syncDashboardDeletionCaches(acknowledgement(factory), { storage: malformed }).failures, 1)
  assert.equal(malformed.getItem('dashboard-designer-draft:scene-one'), '{broken')
})

test('missing metadata is never a deletion signal and factory-mismatched acknowledgements are ignored', () => {
  const input = { factoryId: 'factory-one', revision: 5, document: document() }
  for (const value of [null, {}, { devices: [] }, { factoryId: 'factory-one', scenes: [] }]) assert.equal(normalizeDashboardDeletionCleanup(value), null)
  const different = reconcileDashboardDeletionPayload(input, acknowledgement('wrong-factory'))
  assert.equal(different.payload, input); assert.equal(different.changed, false)
  const malformed = acknowledgement(); malformed.scenes[0].beforeRevision = null
  assert.equal(normalizeDashboardDeletionCleanup(malformed), null)
  const mismatched = { factoryId: 'factory-one', revision: 5, sceneId: 'different-scene', document: document() }
  assert.equal(reconcileDashboardDeletionPayload(mismatched, acknowledgement()).payload, mismatched)
})

test('a missing client revision keeps content and cannot fabricate a new server base', () => {
  const input = { factoryId: 'factory-one', document: document() }
  const result = reconcileDashboardDeletionPayload(input, acknowledgement())
  assert.equal(result.conflict, true); assert.equal(result.payload.revision, undefined)
  assert.equal(result.payload.document.metadata.revision, 5, 'the old metadata is not replaced with a guessed or null revision')
})

test('only a complete explicit remaining-device catalogue is forwarded to the ownership classifier', () => {
  const cleanup = acknowledgement(); cleanup.remainingDeviceIds = ['01']
  let observed
  reconcileDashboardDeletionPayload({ factoryId: 'factory-one', revision: 5, document: document() }, cleanup,
    { cleanupDocument: (input, options) => { observed = options; return { document: copy(input) } } })
  assert.deepEqual(observed.existingDeviceIds, ['01'])
  cleanup.remainingDeviceIds = [{}]
  assert.equal(normalizeDashboardDeletionCleanup(cleanup).remainingDeviceIds, undefined)
})

test('the notification carries only a valid explicit acknowledgement and failed delete endpoints do not dispatch', async () => {
  const events = [], eventTarget = { CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail } }, dispatchEvent: event => events.push(event) }
  assert.equal(notifyDashboardDeviceDeletion({}, { eventTarget, storage: null }), false)
  assert.equal(notifyDashboardDeviceDeletion(acknowledgement(), { eventTarget, storage: null }), true)
  assert.equal(events.length, 1); assert.equal(events[0].type, DASHBOARD_DEVICE_DELETION_EVENT)
  assert.deepEqual(events[0].detail.deletedDeviceIds, ['gone'])
  const source = await readFile(new URL('../src/config/factoryConfig.js', import.meta.url), 'utf8')
  for (const method of ['deleteDevice', 'deleteLine', 'deleteWorkshop']) {
    const body = source.match(new RegExp(`async ${method}\\([^]*?\\n    },`))?.[0]
    assert.ok(body); assert.match(body, /if \(result\?\.success === true\) notifyDashboardDeviceDeletion\(result\.dashboardCleanup\)/)
  }
  assert.equal(notifyDashboardDeviceDeletion(acknowledgement(), { eventTarget: { CustomEvent: eventTarget.CustomEvent, dispatchEvent() { throw Error('failed local listener') } }, storage: null }), true)
})

test('default active-factory caches require an explicit owner or a server-confirmed scene', t => {
  const cleanup = acknowledgement('default-owner'), editorId = 'dashboard:scene-one'
  cacheFactoryDraft('', editorId, 'dashboard', { sceneId: 'scene-one', revision: 5, document: document() })
  cacheFactoryDraft('', 'dashboard:unrelated', 'dashboard', { sceneId: 'unrelated', revision: 5, document: { ...document(), sceneId: 'unrelated' } })
  t.after(() => { clearFactoryDraft('', editorId); clearFactoryDraft('', 'dashboard:unrelated') })
  const unrelated = readFactoryDraft('', 'dashboard:unrelated')
  assert.equal(syncDashboardDeletionCaches(cleanup, { storage: null }).changedDrafts, 1)
  assert.equal(readFactoryDraft('', editorId).factoryId, 'default-owner')
  assert.equal(readFactoryDraft('', editorId).revision, 6)
  assert.deepEqual(readFactoryDraft('', 'dashboard:unrelated'), unrelated)
  cleanup.id = 'old-tombstone'; cleanup.scenes = []
  cacheFactoryDraft('', editorId, 'dashboard', { sceneId: 'scene-one', revision: 2, document: document() })
  assert.equal(syncDashboardDeletionCaches(cleanup, { storage: null }).changedDrafts, 0, 'no guessed default factory')
  assert.equal(syncDashboardDeletionCaches(cleanup, { storage: null, trustedSceneIds: ['scene-one'] }).changedDrafts, 1)
  assert.equal(readFactoryDraft('', editorId).revision, 2, 'a tombstone snapshot cannot advance CAS')
})

test('all 100 real deletion events remain in order when the backend appends an older tombstone snapshot', () => {
  const input = { factoryId: 'factory-one', revision: 5, document: document() }
  const events = Array.from({ length: 100 }, (_, index) => {
    const cleanup = acknowledgement('factory-one', index + 5, index + 6)
    if (index) { cleanup.deletedDeviceIds = []; cleanup.scenes[0].removedWidgetIds = []; cleanup.scenes[0].removedViewIds = [] }
    return cleanup
  })
  events.push({ id: 'tombstone-snapshot', factoryId: 'factory-one', deletedDeviceIds: [], remainingDeviceIds: [], scenes: [] })
  const result = reconcileDashboardDeletionHistory(input, events)
  assert.equal(result.conflict, false); assert.equal(result.payload.revision, 105)
  assert.ok(!result.payload.document.widgets.some(widget => widget.id === 'private-caption'))
})
