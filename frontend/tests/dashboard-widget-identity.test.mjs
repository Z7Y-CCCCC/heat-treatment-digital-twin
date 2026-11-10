import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, toRaw } from 'vue'
import { createWidgetInstanceRegistry, dashboardWidgetIdentityIssues, renameDashboardWidget, allocateNewWidgetIds } from '../../shared/dashboardWidgetIdentity.mjs'

const clone = value => JSON.parse(JSON.stringify(value))

test('instance keys distinguish duplicate objects without adding document properties, including raw/proxy access', () => {
  const raw = { widgets: [{ id: 'same' }, { id: 'same' }] }, before = JSON.stringify(raw)
  const doc = reactive(raw), registry = createWidgetInstanceRegistry(toRaw)
  assert.notEqual(registry.key(doc.widgets[0]), registry.key(doc.widgets[1]))
  assert.equal(registry.key(raw.widgets[0]), registry.key(doc.widgets[0]))
  assert.equal(registry.find(doc.widgets, registry.key(raw.widgets[1])), doc.widgets[1])
  assert.equal(JSON.stringify(raw), before)
})

test('identity write validation is read-only, exact, and groups duplicate indexes', () => {
  const doc = { widgets: [{ id: 'same' }, { id: 'same' }, { id: ' illegal ' }, { id: '' }, { id: 'a'.repeat(129) }] }
  const before = clone(doc), issues = dashboardWidgetIdentityIssues(doc)
  assert.deepEqual(issues.find(issue => issue.code === 'duplicate-widget-id').indexes, [0, 1])
  assert.equal(issues.filter(issue => issue.code === 'invalid-widget-id').length, 3)
  assert.deepEqual(doc, before)
})

test('explicit duplicate rename copies view show/hide/overrides while retaining all other instance content', () => {
  const doc = { widgets: [{ id: 'same', content: { value: 1 }, data: { pointId: 'a' }, frame: { x: 5 }, groupId: 'g' },
    { id: 'same', content: { value: 2 }, data: { pointId: 'b' }, frame: { x: 7 }, groupId: 'g' }],
    scene: { views: [{ componentState: { show: ['same', 'other'], hide: ['widget:same', 'group:g'],
      overrides: { same: { visible: false, nested: { color: 'red' } }, 'widget:same': { opacity: 0.2 }, other: { visible: true } } } }] } }
  const before = clone(doc), result = renameDashboardWidget(doc, doc.widgets[0], 'first')
  assert.equal(result.oldIdStillUsed, true)
  assert.deepEqual(doc.widgets[1], before.widgets[1])
  assert.deepEqual({ ...doc.widgets[0], id: 'same' }, before.widgets[0])
  const state = doc.scene.views[0].componentState
  assert.deepEqual(state.show, ['same', 'first', 'other'])
  assert.deepEqual(state.hide, ['widget:same', 'widget:first', 'group:g'])
  assert.deepEqual(state.overrides.first, state.overrides.same)
  assert.notEqual(state.overrides.first.nested, state.overrides.same.nested)
  assert.equal(state.overrides['widget:first'].opacity, 0.2)
  renameDashboardWidget(doc, doc.widgets[1], 'second')
  assert.deepEqual(state.show, ['second', 'first', 'other'])
  assert.deepEqual(state.hide, ['widget:second', 'widget:first', 'group:g'])
  assert.equal(Object.hasOwn(state.overrides, 'same'), false)
  assert.equal(state.overrides.second.visible, false)
  assert.deepEqual(dashboardWidgetIdentityIssues(doc), [])
})

test('invalid and already-owned explicit names fail atomically, with no silent normalization', () => {
  for (const id of ['', 'bad/name', ' same ', 'same', 'x'.repeat(129)]) {
    const doc = { widgets: [{ id: 'same' }, { id: 'same' }], scene: { views: [{ componentState: { show: ['same'], hide: [] } }] } }
    const before = clone(doc)
    assert.throws(() => renameDashboardWidget(doc, doc.widgets[0], id))
    assert.deepEqual(doc, before)
  }
})

test('new add/copy/HUD IDs are unique even with fixed timestamps, without rewriting existing objects', () => {
  const existing = [{ id: 'hud_factory_kpi' }, { id: 'hud_factory_kpi' }, { id: 'same' }, { id: 'same_2' }], before = clone(existing)
  const fresh = [{ id: 'hud_factory_kpi' }, { id: 'same' }, { id: 'same' }]
  allocateNewWidgetIds(existing, fresh)
  assert.deepEqual(fresh.map(widget => widget.id), ['hud_factory_kpi_2', 'same_3', 'same_4'])
  assert.deepEqual(existing, before)
  assert.throws(() => allocateNewWidgetIds(existing, [existing[0]]), /existing/)
})
