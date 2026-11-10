import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive, toRaw } from 'vue'
import { createWidgetInstanceRegistry, dashboardWidgetIdentityIssues, renameDashboardWidget, allocateNewWidgetIds, prepareDashboardWidgetIdentities } from '../../shared/dashboardWidgetIdentity.mjs'
import { applyVisibilityAction, widgetRuntimeVisible } from '../src/runtime/dashboardRules.js'

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

test('explicit save preparation fixes every historical HUD instance without changing sources, frames, grouping or scoped view membership', () => {
  const ids = ['hud_factory_kpi', 'hud_factory_devices', 'hud_factory_alarms', 'hud_factory_trend']
  const doc = {
    widgets: ids.flatMap((id, index) => [0, 1].map(copy => ({ id, title: `${index}/${copy}`, type: 'value',
      content: { value: index * 10 + copy, fallback: '保留' }, data: { mode: 'plc', deviceId: `device_${copy}`, pointId: `${index}_${copy}` },
      frame: { x: index * 110 + copy, y: 25, width: 100, height: 100 }, groupId: 'authored_group',
      style: { viewOverrides: { workshop: { color: copy ? 'red' : 'blue' } } },
      visibility: { viewIds: [copy ? 'workshop' : 'factory'], rules: [{ source: 'context', path: 'online', operator: 'truthy' }] }, events: [] }))),
    scene: { defaultViewId: 'factory', views: [
      { id: 'factory', componentState: { show: ids, hide: ['group:keep'], overrides: { hud_factory_kpi: { opacity: .7 } } } },
      { id: 'workshop', componentState: { show: [], hide: ids } }
    ] },
    tooltipTemplates: { templates: [{ id: 'separate_scope', widgets: [{ id: ids[0] }, { id: 'same' }, { id: 'same' }] }] }
  }
  const before = clone(doc), result = prepareDashboardWidgetIdentities(doc)
  assert.equal(result.changed, true)
  assert.equal(result.changes.length, 4)
  assert.deepEqual(doc, before, 'preparation never mutates the input or a live configuration')
  assert.deepEqual(result.document.tooltipTemplates, before.tooltipTemplates, 'tooltip IDs have a separate template-local scope')
  assert.deepEqual(dashboardWidgetIdentityIssues(result.document), [])
  assert.equal(result.document.widgets.length, before.widgets.length)
  result.document.widgets.forEach((widget, index) => assert.deepEqual({ ...widget, id: before.widgets[index].id }, before.widgets[index]))
  assert.equal(result.document.scene.defaultViewId, before.scene.defaultViewId)
  for (const change of result.changes) {
    assert.equal(change.newId, `${change.oldId}_2`)
    assert.ok(result.document.scene.views[0].componentState.show.includes(change.oldId))
    assert.ok(result.document.scene.views[0].componentState.show.includes(change.newId))
    assert.ok(result.document.scene.views[1].componentState.hide.includes(change.oldId))
    assert.ok(result.document.scene.views[1].componentState.hide.includes(change.newId))
  }
  assert.deepEqual(result.document.scene.views[0].componentState.overrides.hud_factory_kpi_2, { opacity: .7 })
  assert.notEqual(result.document.scene.views[0].componentState.overrides.hud_factory_kpi_2, result.document.scene.views[0].componentState.overrides.hud_factory_kpi)
  const again = prepareDashboardWidgetIdentities(result.document)
  assert.equal(again.changed, false)
  assert.equal(again.document, result.document, 'a unique document has no re-keying or copy on later saves')
})

test('duplicate visibility event references retain broadcast and event order after unique allocation', () => {
  for (const action of ['set_visibility', 'toggle_visibility']) {
    const event = { trigger: 'click', action, targetType: 'widget', targetId: 'shared', visibility: 'hide' }
    const doc = { widgets: [{ id: 'shared', events: [] }, { id: 'shared', events: [] },
      { id: 'control', events: [event, { trigger: 'click', action: 'switch_view', viewId: 'other' }, event] }],
      scene: { views: [{ id: 'other', componentState: { show: ['shared'], hide: [] } }] } }
    const result = prepareDashboardWidgetIdentities(doc).document
    assert.deepEqual(result.widgets[2].events.map(item => item.targetId || item.viewId), ['shared', 'shared_2', 'other', 'shared', 'shared_2'])
    const originalState = { widgetVisibility: {}, groupVisibility: {} }, repairedState = { widgetVisibility: {}, groupVisibility: {} }
    for (let click = 0; click < 3; click++) {
      for (const item of doc.widgets[2].events) if (item.action === action) applyVisibilityAction(item, originalState)
      for (const item of result.widgets[2].events) if (item.action === action) applyVisibilityAction(item, repairedState)
      for (let index = 0; index < 2; index++) assert.equal(widgetRuntimeVisible(result.widgets[index], repairedState), widgetRuntimeVisible(doc.widgets[index], originalState))
    }
  }
})

test('repair reserves existing and dangling targets and respects the 128-character identity bound', () => {
  const long = 'x'.repeat(128)
  const doc = { widgets: [{ id: 'same' }, { id: 'same' }, { id: 'same_2' }, { id: long }, { id: long }],
    scene: { views: [{ componentState: { show: ['same_3'], hide: [], overrides: { same_4: { color: 'authored' } } } }] } }
  const prepared = prepareDashboardWidgetIdentities(doc)
  assert.equal(prepared.document.widgets[1].id, 'same_5')
  assert.equal(prepared.document.widgets[4].id.length, 128)
  assert.equal(prepared.document.widgets[4].id, 'x'.repeat(126) + '_2')
  assert.deepEqual(dashboardWidgetIdentityIssues(prepared.document), [])
  assert.deepEqual(prepared.document.scene.views[0].componentState.overrides.same_4, { color: 'authored' })
})

test('invalid identities and event fan-out beyond the persisted bound fail without any mutation', () => {
  const invalid = { widgets: [{ id: 'same' }, { id: 'same' }, { id: ' bad ' }] }
  const invalidBefore = clone(invalid)
  assert.throws(() => prepareDashboardWidgetIdentities(invalid), /组件标识不合法/)
  assert.deepEqual(invalid, invalidBefore)
  const overflow = { widgets: [{ id: 'same' }, { id: 'same' }, { id: 'control', title: '联动按钮',
    events: Array.from({ length: 7 }, () => ({ action: 'toggle_visibility', targetType: 'widget', targetId: 'same' })) }] }
  const overflowBefore = clone(overflow)
  assert.throws(() => prepareDashboardWidgetIdentities(overflow), /保留全部动作.*12.*未修改草稿/)
  assert.deepEqual(overflow, overflowBefore)
})
