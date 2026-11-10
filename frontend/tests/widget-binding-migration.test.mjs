import test from 'node:test'
import assert from 'node:assert/strict'
import { layoutProjection, acquisitionProjection, explicitPointMappings } from '../../tools/widget-binding-workflow-live-migration.mjs'

test('reviewed binding migration can change only sources, bound rings and event filters', () => {
  const before = { metadata: { revision: 1 }, scene: { views: [{ id: 'overview' }] }, widgets: [
    { id: 'panel', frame: { x: 10, y: 20, width: 300, height: 200 }, style: { color: 'purple' }, data: { mode: 'runtime', path: 'device.temperature' }, content: { title: '温度', items: [{ label: '运行时间', path: 'device.hours' }] } }
  ], tooltipTemplates: { device: { widgets: [{ id: 'tip', content: { text: '保留' }, data: { path: 'device.id' } }] } } }
  const migrated = structuredClone(before)
  migrated.metadata.revision++
  migrated.widgets[0].data = { bindingVersion: 2, deviceBindings: [{ deviceId: 'a', binding: { pointId: 'p1' } }] }
  migrated.widgets[0].content.useBoundRing = true
  migrated.widgets[0].content.items[0].binding = { bindingVersion: 2, deviceBindings: [] }
  migrated.widgets[0].content.eventFilters = { scope: 'factory' }
  assert.deepEqual(layoutProjection(before), layoutProjection(migrated))
  for (const mutate of [document => document.widgets[0].frame.x++, document => document.widgets[0].content.items[0].label = '错误标签', document => document.widgets[0].style.color = 'red', document => document.scene.views[0].id = 'other', document => document.tooltipTemplates.device.widgets[0].content.text = '替换']) {
    const wrong = structuredClone(migrated)
    mutate(wrong)
    assert.notDeepEqual(layoutProjection(before), layoutProjection(wrong))
  }
  assert.equal(before.widgets[0].data.mode, 'runtime', 'projection must not mutate its source')
})

test('acquisition proof covers every configuration field and ignores only live quality', () => {
  const before = { sourceMode: 'integrated_plc', devices: [{ id: 'a', plc_ip: '127.0.0.1', plc_rack: 0, plc_options: '{"rack":0}', pos_x: 15, instance_config: '{}' }], points: [{ id: 'p1', device_id: 'a', plc_tag: 'DB1.DBD16', scale: 2, offset: 3, expression: 'x+1', alarm_condition: 'high', quality: 'good' }] }
  const after = structuredClone(before)
  after.points[0].quality = 'stale'
  assert.deepEqual(acquisitionProjection(before), acquisitionProjection(after))
  for (const mutate of [snapshot => snapshot.devices[0].plc_ip = '127.0.0.2', snapshot => snapshot.devices[0].plc_options = '{}', snapshot => snapshot.points[0].scale = 1, snapshot => snapshot.points[0].expression = 'x', snapshot => snapshot.sourceMode = 'external']) {
    const wrong = structuredClone(after)
    mutate(wrong)
    assert.notDeepEqual(acquisitionProjection(before), acquisitionProjection(wrong))
  }
})

test('live mapping proof uses exact owned READ points, preserves zero and does not promote stale values', () => {
  const document = { widgets: [{ id: 'panel', data: { deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'p1' } }] }, content: { items: [{ label: '耗电量', binding: { deviceBindings: [{ deviceId: 'b', binding: { mode: 'plc', pointId: 'p2' } }] } }] } }] }
  const points = [{ id: 'p1', device_id: 'a', plc_tag: 'DB1.DBD16', value: 0, quality: 'good', access_type: 'READ' }, { id: 'p2', device_id: 'b', plc_tag: 'DB8.DBD40', value: 100, quality: 'stale', access_type: 'READ' }]
  const mappings = explicitPointMappings(document, points)
  assert.equal(mappings[0].value, 0)
  assert.equal(mappings[1].value, null)
  assert.equal(mappings[1].address, 'DB8.DBD40')
  assert.equal(mappings[1].metric, '耗电量')
  assert.throws(() => explicitPointMappings(document, [{ ...points[0], device_id: 'b' }, points[1]]), /different device/)
  assert.throws(() => explicitPointMappings(document, [{ ...points[0], access_type: 'WRITE' }, points[1]]), /read-only/)
  assert.throws(() => explicitPointMappings(document, [points[0]]), /Missing exact configured point/)
})
