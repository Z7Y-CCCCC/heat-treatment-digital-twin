import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { cleanupDeletedDeviceContent, dashboardReferencedDeviceIds, collectDashboardDeviceIds } from '../../shared/dashboardDeviceDeletion.mjs'

const copy = value => JSON.parse(JSON.stringify(value))
const byId = (doc, id) => doc.widgets.find(widget => widget.id === id)
const rule = (value, extra = {}) => ({ source: 'context', path: 'deviceId', operator: '==', value, ...extra })
function widget(id, extra = {}) {
  return { id, type: 'text', title: '原标题', visible: true, locked: true, zIndex: 9, groupId: '',
    frame: { x: 15, y: 40, width: 340, height: 50, rotation: 0 },
    style: { color: '#eef7ff', background: '#101527', borderRadius: 18, fontSize: 21, padding: 8, surfaceSkin: 'inline' },
    content: { text: '{value}', customLabel: '不改正文' },
    data: { mode: 'runtime', deviceScope: 'current', deviceId: '', path: 'device.name', readOnly: true },
    visibility: { viewIds: [], viewModes: [], rules: [], ruleMode: 'all', matchBoundDevice: false },
    conditions: [{ operator: '==', value: 1, color: '#ff0000' }], events: [], animation: { type: 'none' }, ...extra }
}
function view(id, extra = {}) {
  return { id, mode: 'device', targetType: 'device', targetId: '', parentViewId: 'factory_overview', returnViewId: 'factory_overview',
    metadata: { inspectionStage: 'solid', custom: '保留' }, componentState: { show: [], hide: [] }, ...extra }
}
function fixture() {
  return { schemaVersion: 3, projectId: 'project', sceneId: 'scene', name: '原布局', metadata: { revision: 11, source: 'authored' },
    canvas: { width: 1920, height: 1080 }, theme: { accentColor: '#a2a7ed' }, parameters: [{ id: 'original' }],
    scene: { defaultViewId: 'factory_overview', layout: { original: true }, views: [
      view('factory_overview', { mode: 'factory', targetType: 'factory', parentViewId: '', returnViewId: '' }),
      view('device_shared'), view('private_dead', { targetId: 'dead', parentViewId: 'device_shared', returnViewId: 'device_shared' }),
      view('private_part', { targetType: 'device_part', targetId: 'part_a', parentViewId: 'private_dead', returnViewId: 'private_dead' }),
      view('other_device', { targetId: 'alive', parentViewId: 'private_part', returnViewId: 'private_part' }),
      view('global_child', { mode: 'factory', targetType: 'factory', targetId: 'factory', parentViewId: 'private_dead', returnViewId: 'private_dead' })
    ] },
    widgets: [widget('shared_current'), widget('shared_fixed', { data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'dead', pointId: 'point_dead', pointKey: 'analog.temp', readOnly: true } }),
      widget('private_caption', { data: { mode: 'static', deviceScope: 'current' }, visibility: { viewIds: ['device_shared'], rules: [rule('dead')], ruleMode: 'all' } }),
      widget('private_value', { visibility: { viewIds: ['device_shared'], rules: [rule('dead')], ruleMode: 'all' } }),
      widget('private_view_label', { visibility: { viewIds: ['private_dead'], rules: [] }, groupId: 'private_group' }),
      widget('other_label', { visibility: { viewIds: ['other_device'], rules: [] } }),
      widget('shared_any', { visibility: { viewIds: ['device_shared'], rules: [rule('dead'), rule('alive')], ruleMode: 'any' } }),
      widget('shared_rotation', { data: { mode: 'plc', deviceScope: 'rotation', rotationDeviceIds: ['dead', 'alive'], pointId: 'point_live', pointKey: 'analog.temp' } }),
      widget('shared_devices', { content: { text: '保持', deviceIds: ['alive', 'dead'] } }),
      widget('shared_events', { events: [
        { action: 'switch_view', viewId: 'device_shared', deviceId: 'dead' }, { action: 'switch_view', viewId: 'private_dead' },
        { action: 'set_visibility', targetType: 'widget', targetId: 'private_value' },
        { action: 'toggle_visibility', targetType: 'group', targetId: 'private_group' },
        { action: 'switch_view', viewId: 'other_device', deviceId: 'alive' }, { action: 'open_url', url: '/history/dead' }
      ] }),
      widget('cfg_param_dead_but_shared', { content: { text: '名称含 dead，不代表所有权' } })
    ],
    tooltipTemplates: { version: 1, defaults: { device: 'tooltip_default', part: 'tooltip_part' }, templates: [
      { id: 'tooltip_default', kind: 'device', name: '共享设备提示', widgets: [widget('hover_current', { data: { mode: 'runtime', deviceScope: 'current', path: 'hover.device.name' } })] },
      { id: 'tooltip_part', kind: 'part', name: '共享部件提示', widgets: [widget('hover_part', { data: { mode: 'runtime', deviceScope: 'current', path: 'hover.part.name' } })] }
    ] } }
}

test('deletes only proven private widgets and preserves fixed shared sources and generic templates', () => {
  const before = fixture(), { document, removedWidgetIds, removedViewIds } = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'], pointIds: ['point_dead'] })
  assert.deepEqual(removedWidgetIds, ['private_caption', 'private_value', 'private_view_label'])
  assert.deepEqual(removedViewIds, ['private_dead', 'private_part'])
  for (const id of ['shared_current', 'shared_fixed', 'other_label', 'cfg_param_dead_but_shared']) assert.deepEqual(byId(document, id), byId(before, id), id)
  assert.deepEqual(document.tooltipTemplates, before.tooltipTemplates)
  assert.deepEqual(document.metadata, before.metadata)
  assert.deepEqual(document.canvas, before.canvas)
  assert.deepEqual(document.parameters, before.parameters)
})

test('is non-mutating for frozen inputs and idempotent without normalization', () => {
  const before = fixture(), serialized = JSON.stringify(before)
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } }
  freeze(before)
  const first = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.equal(JSON.stringify(before), serialized)
  const second = cleanupDeletedDeviceContent(first.document, { deviceIds: ['dead'] })
  assert.equal(second.changed, false)
  assert.deepEqual(second.document, first.document)
  assert.deepEqual(second.removedWidgetIds, [])
  assert.deepEqual(cleanupDeletedDeviceContent(before, {}).document, before)
  assert.equal(cleanupDeletedDeviceContent(before, {}).changed, false)
})

test('static unbound labels and containers authored only through a private view allow-list are removed', () => {
  const before = fixture()
  before.widgets.push(widget('dragged_label'), widget('dragged_container', { type: 'container', visible: false }))
  for (const v of before.scene.views) {
    if (v.id === 'private_dead') v.componentState.show = ['dragged_label', 'dragged_container']
    else v.componentState.hide.push('dragged_label', 'dragged_container')
  }
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.ok(result.removedWidgetIds.includes('dragged_label'))
  assert.ok(result.removedWidgetIds.includes('dragged_container'))
})

test('type and group membership enforce private ownership but any surviving eligible view protects a shared widget', () => {
  const before = fixture()
  before.widgets.push(widget('group_label', { groupId: 'owned_group' }), widget('kept_elsewhere', { groupId: 'owned_group' }))
  for (const v of before.scene.views) {
    if (v.id === 'private_dead') v.componentState.show = ['group:owned_group']
    else v.componentState.hide.push('group:owned_group')
  }
  before.scene.views.find(v => v.id === 'global_child').componentState.hide = ['group_label']
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.ok(result.removedWidgetIds.includes('group_label'))
  assert.deepEqual(byId(result.document, 'kept_elsewhere'), byId(before, 'kept_elsewhere'))
})

test('positive device conditions are necessary in all mode, and every branch must be private in any mode', () => {
  const before = fixture()
  before.widgets.push(
    widget('all_private', { visibility: { rules: [rule('dead'), { source: 'data', path: 'value', operator: '>', value: 20 }], ruleMode: 'all' } }),
    widget('any_private', { visibility: { rules: [rule('dead'), rule('dead2')], ruleMode: 'any' } }),
    widget('any_broad', { visibility: { rules: [rule('dead'), { source: 'context', path: 'viewMode', operator: '==', value: 'device' }], ruleMode: 'any' } }),
    widget('negative', { visibility: { rules: [rule('dead', { operator: '!=' })], ruleMode: 'all' } }),
    widget('data_rule', { visibility: { rules: [rule('dead', { source: 'data' })], ruleMode: 'all' } }),
    widget('substring', { visibility: { rules: [rule('dead', { operator: 'contains' })], ruleMode: 'all' } })
  )
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead', 'dead2'] })
  assert.ok(result.removedWidgetIds.includes('all_private'))
  assert.ok(result.removedWidgetIds.includes('any_private'))
  assert.deepEqual(byId(result.document, 'any_broad').visibility.rules, [{ source: 'context', path: 'viewMode', operator: '==', value: 'device' }])
  for (const id of ['negative', 'data_rule', 'substring']) assert.deepEqual(byId(result.document, id), byId(before, id))
})

test('matchBoundDevice proves fixed private ownership, but current scope and independent fixed data do not', () => {
  const before = fixture()
  before.widgets.push(widget('matched_fixed', { data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'dead' }, visibility: { matchBoundDevice: true } }),
    widget('matched_current', { data: { mode: 'runtime', deviceScope: 'current', deviceId: 'dead' }, visibility: { matchBoundDevice: true } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.ok(result.removedWidgetIds.includes('matched_fixed'))
  assert.deepEqual(byId(result.document, 'matched_current'), byId(before, 'matched_current'))
  assert.deepEqual(byId(result.document, 'shared_fixed').data, byId(before, 'shared_fixed').data)
})

test('shared rules, device lists and rotation membership lose only deleted members', () => {
  const before = fixture(), result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.deepEqual(byId(result.document, 'shared_any').visibility.rules, [rule('alive')])
  assert.deepEqual(byId(result.document, 'shared_rotation').data.rotationDeviceIds, ['alive'])
  assert.equal(byId(result.document, 'shared_rotation').data.pointId, 'point_live')
  assert.deepEqual(byId(result.document, 'shared_devices').content.deviceIds, ['alive'])
  for (const id of result.updatedWidgetIds) for (const field of ['frame', 'style', 'type', 'title', 'zIndex', 'locked', 'conditions', 'animation']) {
    assert.deepEqual(byId(result.document, id)[field], byId(before, id)[field], id + '.' + field)
  }
})

test('HUD deviceActions loses only exact deleted keys and preserves every surviving action verbatim', () => {
  const before = fixture()
  byId(before, 'shared_devices').content.deviceActions = {
    dead: [{ action: 'switch_view', viewId: 'private_dead', deviceId: 'dead' }],
    alive: [{ action: 'switch_view', viewId: 'other_device', deviceId: 'alive', trigger: 'click', custom: { keep: true, deviceIds: ['dead', 'alive'] } },
      { action: 'open_url', url: '/history/dead' }, { action: 'switch_view', viewId: 'private_dead', deviceId: 'dead' }]
  }
  byId(before, 'shared_devices').content.arbitraryMap = { dead: '不是引用', alive: '保留' }
  byId(before, 'shared_devices').content.apiPayload = { deviceActions: { dead: ['unrecognized nested data'] } }
  const serialized = JSON.stringify(before)
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.deepEqual(byId(result.document, 'shared_devices').content.deviceActions, { alive: byId(before, 'shared_devices').content.deviceActions.alive })
  assert.deepEqual(byId(result.document, 'shared_devices').content.arbitraryMap, byId(before, 'shared_devices').content.arbitraryMap)
  assert.deepEqual(byId(result.document, 'shared_devices').content.apiPayload, byId(before, 'shared_devices').content.apiPayload)
  assert.equal(JSON.stringify(before), serialized)
  assert.ok(result.updatedWidgetIds.includes('shared_devices'))
  assert.deepEqual(cleanupDeletedDeviceContent(result.document, { deviceIds: ['dead'] }).document, result.document)
})

test('legacy content deviceActions and numeric map keys use exact string identity, not condition equality', () => {
  const before = fixture()
  before.widgets.push(widget('legacy_actions', { config: { deviceActions: { '1': ['remove'], '01': ['keep-alias'], alive: [] }, retained: true },
    data: { mode: 'runtime', deviceActions: { '1': ['unrecognized-binding-field'] } } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['1'], remainingDeviceIds: ['01', 'alive'] })
  assert.deepEqual(byId(result.document, 'legacy_actions').config.deviceActions, { '01': ['keep-alias'], alive: [] })
  assert.deepEqual(byId(result.document, 'legacy_actions').data, byId(before, 'legacy_actions').data)
  assert.equal(byId(result.document, 'legacy_actions').config.retained, true)
  assert.deepEqual(result.removedWidgetIds, [])
})

test('identity collector recognizes only formal content deviceActions keys, not arbitrary or nested map keys', () => {
  const before = fixture()
  before.widgets.push(widget('map_only_refs', { content: { deviceActions: { map_device: [], '01': [{ custom: 'keep' }] },
    arbitraryMap: { ignored_map_device: [] }, apiPayload: { deviceActions: { ignored_nested_device: [] } } },
    config: { deviceActions: { legacy_map_device: [] } }, data: { deviceActions: { ignored_binding_device: [] } } }))
  const found = dashboardReferencedDeviceIds(before)
  for (const id of ['map_device', '01', 'legacy_map_device']) assert.ok(found.includes(id))
  for (const id of ['ignored_map_device', 'ignored_nested_device', 'ignored_binding_device']) assert.ok(!found.includes(id))
})

test('exhausted explicit selections are disabled rather than falling back to all devices', () => {
  const before = fixture()
  before.widgets.push(widget('empty_rotation', { data: { mode: 'plc', deviceScope: 'rotation', rotationDeviceIds: ['dead'], pointKey: 'analog.temp' } }),
    widget('empty_device_list', { content: { deviceIds: ['dead'] } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.equal(byId(result.document, 'empty_rotation').visible, false)
  assert.equal(byId(result.document, 'empty_device_list').visible, false)
  assert.deepEqual(byId(result.document, 'empty_rotation').data.rotationDeviceIds, [])
  assert.equal(byId(result.document, 'empty_rotation').data.deviceScope, 'rotation')
  assert.deepEqual(result.emptyScopeWidgetIds, ['empty_rotation', 'empty_device_list'])
})

test('an exhausted component allow-list remains an empty view, never a global allow-all', () => {
  const before = fixture(), shared = before.scene.views.find(v => v.id === 'device_shared')
  shared.componentState = { show: ['private_caption'], hide: ['irrelevant_original'] }
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] }), current = result.document.scene.views.find(v => v.id === shared.id)
  assert.deepEqual(current.componentState.show, [])
  assert.ok(current.componentState.hide.includes('irrelevant_original'))
  for (const w of result.document.widgets) assert.ok(current.componentState.hide.includes(w.id))
  assert.ok(result.emptyScopeViewIds.includes('device_shared'))
})

test('explicit other-device and global descendants survive and reattach to the nearest surviving ancestor', () => {
  const before = fixture(); before.scene.defaultViewId = 'private_part'
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.deepEqual(result.removedViewIds, ['private_dead', 'private_part'])
  for (const id of ['other_device', 'global_child']) {
    const v = result.document.scene.views.find(item => item.id === id)
    assert.equal(v.parentViewId, 'device_shared'); assert.equal(v.returnViewId, 'device_shared')
    assert.deepEqual(v.metadata, before.scene.views.find(item => item.id === id).metadata)
  }
  assert.equal(result.document.scene.defaultViewId, 'device_shared')
  assert.ok(result.document.scene.views.some(v => v.id === 'device_shared' && v.targetId === ''))
})

test('view/widget/group overrides and navigation actions are pruned without remapping devices or changing text', () => {
  const before = fixture(), eventWidget = byId(before, 'shared_events')
  eventWidget.style.viewOverrides = { private_dead: { color: '#ff0000' }, other_device: { color: '#ffffff' } }
  before.scene.viewState = { private_dead: { selectedWidgetIds: ['private_value'] }, device_shared: { selectedWidgetIds: ['private_value', 'shared_current'], widgetVisibility: { private_value: false, shared_current: true } } }
  before.scene.views[0].widgetOverrides = { private_value: { frame: { x: 22 } }, shared_current: { color: 'white' } }
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.deepEqual(byId(result.document, 'shared_events').events, [{ action: 'switch_view', viewId: 'other_device', deviceId: 'alive' }, { action: 'open_url', url: '/history/dead' }])
  assert.deepEqual(byId(result.document, 'shared_events').style.viewOverrides, { other_device: { color: '#ffffff' } })
  assert.deepEqual(byId(result.document, 'shared_events').content, eventWidget.content)
  assert.deepEqual(result.document.scene.viewState, { device_shared: { selectedWidgetIds: ['shared_current'], widgetVisibility: { shared_current: true } } })
  assert.deepEqual(result.document.scene.views[0].widgetOverrides, { shared_current: { color: 'white' } })
})

test('only templates exclusively used by removed private views disappear; defaults, reusable libraries and surviving users remain', () => {
  const before = fixture(), privateView = before.scene.views.find(v => v.id === 'private_dead'), other = before.scene.views.find(v => v.id === 'other_device')
  const template = id => ({ id, kind: 'device', name: '原样', widgets: [widget(id + '_caption'), widget(id + '_value')] })
  before.tooltipTemplates.templates.push(template('tooltip_private'), template('tooltip_reused'), template('tooltip_library'))
  privateView.metadata.tooltipTemplates = { device: 'tooltip_private', part: 'tooltip_reused', originalDefault: 'tooltip_default' }
  other.metadata.tooltipTemplates = { device: 'tooltip_reused' }
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.deepEqual(result.removedTooltipTemplateIds, ['tooltip_private'])
  assert.deepEqual(result.removedTooltipWidgetIds, [{ templateId: 'tooltip_private', widgetIds: ['tooltip_private_caption', 'tooltip_private_value'] }])
  for (const id of ['tooltip_default', 'tooltip_part', 'tooltip_reused', 'tooltip_library']) {
    assert.deepEqual(result.document.tooltipTemplates.templates.find(t => t.id === id), before.tooltipTemplates.templates.find(t => t.id === id))
  }
})

test('retained templates remove proven private nested widgets while fixed shared hover bindings remain original', () => {
  const before = fixture(), template = before.tooltipTemplates.templates[0]
  template.widgets.push(widget('nested_private', { visibility: { rules: [rule('dead')], ruleMode: 'all' } }),
    widget('nested_fixed_shared', { data: { mode: 'plc', deviceScope: 'fixed', deviceId: 'dead', pointId: 'point_dead' } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'], pointIds: ['point_dead'] })
  assert.deepEqual(result.removedTooltipWidgetIds, [{ templateId: 'tooltip_default', widgetIds: ['nested_private'] }])
  assert.deepEqual(result.document.tooltipTemplates.templates[0].widgets.find(w => w.id === 'nested_fixed_shared'), template.widgets.find(w => w.id === 'nested_fixed_shared'))
})

test('point deletion alone cannot erase a device-private or shared component, and direct bindings remain intact', () => {
  const before = fixture(), result = cleanupDeletedDeviceContent(before, { deviceIds: [], pointIds: ['point_dead'] })
  assert.deepEqual(result.removedWidgetIds, [])
  assert.deepEqual(result.removedViewIds, [])
  assert.deepEqual(result.document, before)
})

test('confirmed server IDs prevent local unsaved changes from resurrecting deleted records and references', () => {
  const before = fixture()
  before.widgets.push(widget('local_changed_to_shared'))
  byId(before, 'shared_events').events.push({ action: 'toggle_visibility', targetType: 'widget', targetId: 'local_changed_to_shared' })
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'], confirmedRemovals: {
    removedWidgetIds: ['local_changed_to_shared'], removedViewIds: ['other_device'],
    removedTooltipWidgetIds: [{ templateId: 'tooltip_default', widgetIds: ['hover_current'] }]
  } })
  assert.ok(result.removedWidgetIds.includes('local_changed_to_shared'))
  assert.ok(result.removedWidgetIds.includes('other_label'))
  assert.ok(result.removedViewIds.includes('other_device'))
  assert.ok(!byId(result.document, 'shared_events').events.some(e => e.targetId === 'local_changed_to_shared'))
  assert.ok(!result.document.tooltipTemplates.templates[0].widgets.some(w => w.id === 'hover_current'))
})

test('explicit identity collector includes semantic paths, aliases and nested bindings but not captions or ID prefixes', () => {
  const before = fixture()
  before.widgets.push(widget('cfg_device_not_an_owner', { content: { text: 'unrelated_device_name' },
    data: { mode: 'runtime', path: 'deviceDataMap.path_device.analog.temp', datasets: [{ device_id: 'nested_device' }] } }))
  const found = dashboardReferencedDeviceIds(before)
  for (const id of ['dead', 'alive', 'path_device', 'nested_device']) assert.ok(found.includes(id))
  assert.ok(!found.includes('unrelated_device_name'))
  assert.ok(!found.includes('not_an_owner'))
  assert.deepEqual(collectDashboardDeviceIds(before), found)
})

test('numeric equality aliases are shared when any matching registered device survives', () => {
  const before = fixture()
  before.widgets.push(widget('numeric_one', { visibility: { rules: [rule('1')], ruleMode: 'all' } }),
    widget('numeric_any', { visibility: { rules: [rule('1'), rule('dead')], ruleMode: 'any' } }),
    widget('cart_111', { visibility: { rules: [rule('111')], ruleMode: 'all' } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['1', '111', 'dead'], remainingDeviceIds: ['01', 'alive'] })
  assert.ok(!result.removedWidgetIds.includes('numeric_one'))
  assert.ok(!result.removedWidgetIds.includes('numeric_any'))
  assert.deepEqual(byId(result.document, 'numeric_one'), byId(before, 'numeric_one'))
  assert.deepEqual(byId(result.document, 'numeric_any').visibility.rules, [rule('1')])
  assert.ok(result.removedWidgetIds.includes('cart_111'))
})

test('numeric conditions without a complete catalog are conservatively retained, while confirmations still remove original IDs', () => {
  const before = fixture()
  before.widgets.push(widget('numeric_one', { visibility: { rules: [rule('1')], ruleMode: 'all' } }))
  const unknown = cleanupDeletedDeviceContent(before, { deviceIds: ['1'] })
  assert.deepEqual(byId(unknown.document, 'numeric_one'), byId(before, 'numeric_one'))
  const knownEmpty = cleanupDeletedDeviceContent(before, { deviceIds: ['1'], remainingDeviceIds: [] })
  assert.ok(knownEmpty.removedWidgetIds.includes('numeric_one'))
  const confirmed = cleanupDeletedDeviceContent(before, { deviceIds: ['1'], confirmedRemovals: { removedWidgetIds: ['numeric_one'] } })
  assert.ok(confirmed.removedWidgetIds.includes('numeric_one'))
})

test('complete pre-deletion catalogs handle numeric aliases and fixed matchBoundDevice stays an exact identity filter', () => {
  const before = fixture()
  before.widgets.push(widget('numeric_alias', { visibility: { rules: [rule('01')], ruleMode: 'all' } }),
    widget('exact_fixed', { data: { mode: 'plc', deviceScope: 'fixed', deviceId: '1' }, visibility: { matchBoundDevice: true } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['1'], existingDeviceIds: ['1', '01', 'alive'] })
  assert.deepEqual(byId(result.document, 'numeric_alias'), byId(before, 'numeric_alias'))
  assert.ok(result.removedWidgetIds.includes('exact_fixed'))
})

test('default tooltip children do not inherit private ownership from main-canvas view allow-lists', () => {
  const before = fixture()
  for (const v of before.scene.views) {
    if (!['private_dead', 'private_part'].includes(v.id)) v.componentState.show = ['shared_current']
  }
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.deepEqual(result.document.tooltipTemplates, before.tooltipTemplates)
  assert.deepEqual(result.removedTooltipWidgetIds, [])
})

test('explicit global target children remain global despite a stale device mode and are reattached', () => {
  const before = fixture()
  before.scene.views.push(view('explicit_factory', { mode: 'device', targetType: 'factory', targetId: 'factory', parentViewId: 'private_dead', returnViewId: 'private_dead' }))
  before.widgets.push(widget('global_target_widget', { visibility: { viewIds: ['explicit_factory'], rules: [] } }))
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['dead'] })
  assert.ok(!result.removedViewIds.includes('explicit_factory'))
  assert.deepEqual(byId(result.document, 'global_target_widget'), byId(before, 'global_target_widget'))
  const retained = result.document.scene.views.find(v => v.id === 'explicit_factory')
  assert.equal(retained.parentViewId, 'device_shared')
})

const actualFile = new URL('../../output/maintenance/tianjin-style-postapply-scenes-1794047311972.json', import.meta.url)
test('Tianjin revision136 regression deletes 34 device-private elements and preserves final art and shared templates', { skip: !fs.existsSync(actualFile) }, () => {
  const before = JSON.parse(fs.readFileSync(actualFile, 'utf8')).scenes[0].document
  const result = cleanupDeletedDeviceContent(before, { deviceIds: ['Furnace_03'], pointIds: ['638'] })
  assert.equal(result.removedWidgetIds.length, 34)
  assert.ok(result.removedWidgetIds.includes('cfg_device_trend_Furnace_03'))
  assert.ok(result.removedWidgetIds.includes('cfg_param_Furnace_03_0_label'))
  assert.deepEqual(result.removedViewIds, [])
  assert.deepEqual(result.document.tooltipTemplates, before.tooltipTemplates)
  assert.deepEqual(byId(result.document, 'reference_hud_factory_trend').data.rotationDeviceIds, ['Furnace_02', 'Furnace_01'])
  assert.deepEqual(byId(result.document, 'reference_hud_factory_devices').content.deviceIds, ['Furnace_01', 'Furnace_02', 'h1', 'qxj', '111'])
  const oldActions = byId(before, 'reference_hud_factory_devices').content.deviceActions
  const expectedActions = Object.fromEntries(Object.entries(oldActions || {}).filter(([id]) => id !== 'Furnace_03'))
  assert.deepEqual(byId(result.document, 'reference_hud_factory_devices').content.deviceActions, expectedActions)
  assert.equal(result.updatedWidgetIds.length, 6)
  assert.deepEqual(byId(result.document, 'cfg_detail_trend_title').visibility.rules.map(r => r.value), ['Furnace_01', 'Furnace_02'])
  for (const after of result.document.widgets) {
    const old = byId(before, after.id)
    for (const field of ['frame', 'type', 'title', 'zIndex', 'locked', 'conditions', 'animation']) assert.deepEqual(after[field], old[field])
    assert.deepEqual(after.style, old.style)
  }
})
