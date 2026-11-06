import test from 'node:test'
import assert from 'node:assert/strict'
import { createTooltipContext, tooltipBindingContext, tooltipPlaybackSelection, tooltipPathQuality, tooltipRuntimeValue, tooltipMetadataPath, mappedWidgetValue } from '../src/runtime/tooltipContext.js'

const devices = [{ id: 'a', name: '设备 A' }, { id: 'b', name: '设备 B', workshopName: '车间 B', lineName: '产线 B' }]
const point = (id, deviceId, value, quality = 'good') => ({ id, device_id: deviceId, category: 'analog', value_role: 'temp', label: '温度', unit: '°C', value, quality })

test('hover scope is isolated from navigation and never selects an overview rotation device', () => {
  const parent = { viewMode: 'factory', viewId: 'overview', deviceId: 'a', partId: 'selected', parameters: { order: 'A' } }
  const before = JSON.stringify(parent)
  const context = createTooltipContext({ device: devices[1], status: { quality: 'good' }, runtimeContext: parent })
  assert.equal(JSON.stringify(parent), before)
  assert.equal(context.deviceId, 'b')
  assert.equal(context.partId, '')
  assert.equal(context.viewId, 'overview')
  assert.equal(context.hover.device.workshopName, '车间 B')
  for (const data of [{ deviceScope: 'rotation' }, { deviceId: 'a' }, {}]) {
    const widget = { id: 't', data, content: { text: '{value}' } }, old = JSON.stringify(widget)
    const prepared = tooltipBindingContext(widget, context)
    assert.equal(prepared.widget.data.deviceId, 'b')
    assert.equal(prepared.widget.data.deviceScope, 'fixed')
    assert.equal(tooltipPlaybackSelection(data, context, devices).device.id, 'b')
    assert.equal(JSON.stringify(widget), old)
  }
  assert.equal(tooltipPlaybackSelection({}, createTooltipContext(), devices).device, null)
})

test('intentionally global data remains global and not pinned to hovered equipment', () => {
  const context = createTooltipContext({ device: devices[1] })
  const prepared = tooltipBindingContext({ data: { deviceScope: 'global', datasetId: 'orders' } }, context)
  assert.equal(prepared.widget.data.deviceScope, 'global')
  assert.equal(prepared.widget.data.deviceId, undefined)
  assert.equal(tooltipPlaybackSelection(prepared.widget.data, context, devices).device, null)
  const fixed = tooltipBindingContext({ data: { deviceScope: 'fixed', deviceId: 'a' } }, context)
  assert.equal(fixed.widget.data.deviceId, 'a')
  assert.equal(tooltipPlaybackSelection(fixed.widget.data, context, devices).device.id, 'a')
})

test('device semantic maps reject foreign and ambiguous points, preserve zeros and dynamic units', () => {
  const points = { one: point('one', 'b', 0), alias: point('one', 'b', 0), other: point('other', 'a', 999), unowned: { id: 'legacy', value: 888 } }
  const context = createTooltipContext({ device: devices[1], points })
  assert.equal(tooltipRuntimeValue(context, 'hover.device.pointMap.analog.temp.value'), 0)
  assert.equal(tooltipRuntimeValue(context, 'hover.device.pointMap.analog.temp.text'), '0 °C')
  assert.equal(tooltipRuntimeValue(context, 'hover.device.pointMap.analog.temp.name'), '温度')
  const ambiguous = createTooltipContext({ device: devices[1], points: { ...points, duplicate: point('two', 'b', 666) } })
  assert.equal(tooltipRuntimeValue(ambiguous, 'hover.device.pointMap.analog.temp.value'), undefined)
  const stale = createTooltipContext({ device: devices[1], points: [point('one', 'b', 777, 'stale')] })
  assert.equal(tooltipRuntimeValue(stale, 'hover.device.pointMap.analog.temp.value'), undefined)
  assert.equal(tooltipRuntimeValue(stale, 'hover.device.pointMap.analog.temp.name'), '温度')
})

test('metadata-only device points use current frame, not saved definition values', () => {
  const device = { ...devices[1], dataPoints: [{ id: 'p', category: 'analog', value_role: 'temp', display_name: '现场炉温', value: 999, unit: 'K' }] }
  const context = createTooltipContext({ device, status: { quality: 'good' }, frame: { analog: { temp: 0 } } })
  assert.equal(tooltipRuntimeValue(context, 'hover.device.pointMap.analog.temp.text'), '0 K')
  const missing = createTooltipContext({ device, status: { quality: 'good' }, frame: {} })
  assert.equal(tooltipRuntimeValue(missing, 'hover.device.pointMap.analog.temp.value'), undefined)
})

test('part values are limited to current device/part refs, all configured points remain editable', () => {
  const part = { id: 'fan', name: '风机', pointKeys: ['analog.temp'], group: '驱动', description: '部件说明' }
  const context = createTooltipContext({ kind: 'part', device: devices[1], part, points: [point('one', 'b', 0), point('other', 'a', 999)], runtimeContext: { inspectionStage: 'exploded' } })
  assert.equal(context.partId, 'fan')
  assert.equal(context.tooltipSelectedPart.points.length, 1)
  assert.equal(tooltipRuntimeValue(context, 'hover.part.points.0.text'), '0 °C')
  assert.equal(context.hover.part.hint, '点击部件查看完整详情')
  assert.equal(tooltipPathQuality(context, 'hover.part.points.9.value'), 'stale')
  assert.equal(tooltipRuntimeValue(context, 'hover.part.points.9.value'), undefined)
  const points = Array.from({ length: 5 }, (_, i) => ({ ...point(`p${i}`, 'b', i), value_role: `field${i}` }))
  assert.equal(createTooltipContext({ kind: 'part', device: devices[1], part: { id: 'fan', pointIds: points.map(p => p.id) }, points }).hover.part.points.length, 5)
})

test('bad/stale point values are withheld but part identity remains readable', () => {
  const context = createTooltipContext({ kind: 'part', device: devices[1], part: { id: 'fan', name: '风机', points: [point('one', 'b', 111, 'bad'), point('wrong', 'a', 999)] } })
  assert.equal(context.hover.part.points.length, 1)
  assert.equal(tooltipRuntimeValue(context, 'hover.part.points.0.value'), undefined)
  assert.equal(tooltipRuntimeValue(context, 'hover.part.name'), '风机')
  assert.equal(tooltipPathQuality(context, 'hover.part.name'), 'good')
})

test('part point indexes follow authored ID then semantic-key order independent of input ordering', () => {
  const p1 = { ...point('one', 'b', 10), value_role: 'first' }
  const p2 = { ...point('two', 'b', 20), value_role: 'second' }
  const p3 = { ...point('three', 'b', 30), value_role: 'third' }
  const extra = { ...point('extra', 'b', 40), value_role: 'extra' }
  const part = { id: 'fan', point_ids: ['two', 'one', 'two'], point_keys: ['analog.third', 'analog.first'], points: [extra, p1] }
  const inputs = [[p1, p2, p3], [p3, p2, p1], { z: p3, y: p1, x: p2 }, { x: p2, y: p1, z: p3 }]
  for (const points of inputs) {
    const context = createTooltipContext({ kind: 'part', device: devices[1], part, points })
    assert.deepEqual(context.hover.part.points.map(point => point.id), ['two', 'one', 'three', 'extra'])
    assert.equal(tooltipRuntimeValue(context, 'hover.part.points.0.value'), 20)
    assert.equal(tooltipRuntimeValue(context, 'hover.part.points.1.value'), 10)
  }
})

test('ambiguous semantic part references never choose by input order, while exact IDs remain valid', () => {
  const points = [point('one', 'b', 10), point('two', 'b', 20), point('foreign', 'a', 999)]
  for (const input of [points, [...points].reverse()]) {
    const byKey = createTooltipContext({ kind: 'part', device: devices[1], part: { id: 'fan', pointKeys: ['analog.temp'] }, points: input })
    assert.deepEqual(byKey.hover.part.points, [])
    const byId = createTooltipContext({ kind: 'part', device: devices[1], part: { id: 'fan', pointIds: ['two'], pointKeys: ['analog.temp'] }, points: input })
    assert.deepEqual(byId.hover.part.points.map(point => point.id), ['two'])
  }
})

test('value mappings accept zero, false and explicitly empty labels without losing fallback semantics', () => {
  assert.equal(mappedWidgetValue(0, [{ value: 0, text: '停机' }]), '停机')
  assert.equal(mappedWidgetValue(false, [{ value: false, text: '' }]), '')
  assert.equal(mappedWidgetValue('good', { good: '正常' }), '正常')
  assert.equal(mappedWidgetValue('missing', { good: '正常' }), undefined)
})

test('device data-status text requires current quality evidence and never infers health from lastSeen or process flags', () => {
  const statuses = [
    [{ quality: 'good', online: true, running: false, alarm: true }, '数据正常'],
    [{ quality: 'good' }, '数据正常'],
    [{ quality: 'bad', online: true, lastSeen: Date.now(), running: true }, '数据异常 / 未连接'],
    [{ quality: 'stale', online: false, lastSeen: Date.now() }, '数据已过期'],
    [{ quality: 'good', online: false, lastSeen: Date.now() }, '数据异常 / 未连接'],
    [{ quality: 'unknown', online: true, lastSeen: Date.now() }, '暂无实时数据'],
    [{ quality: 'connecting', lastSeen: Date.now() }, '暂无实时数据'],
    [{ lastSeen: Date.now(), running: true, alarm: false }, '暂无实时数据'],
    [{ online: true }, '暂无实时数据'],
    [{}, '暂无实时数据']
  ]
  for (const [status, expected] of statuses) {
    const context = createTooltipContext({ device: devices[1], status })
    assert.equal(tooltipRuntimeValue(context, 'hover.device.status'), expected, JSON.stringify(status))
    assert.equal(tooltipRuntimeValue(context, 'hover.device.name'), '设备 B')
  }
})

test('runtime binding repairs a frozen dynamic status with provenance without mutating the saved widget or static captions', () => {
  const widget = { id: 'status', type: 'text', content: { text: '永远正常', valueMap: [{value:'数据异常 / 未连接',text:'数据正常'}] },
    data: { mode: 'static' }, dynamicBinding: { mode: 'runtime', path: 'hover.device.status', deviceScope: 'current', readOnly: true } }
  const before = JSON.stringify(widget)
  const context = createTooltipContext({ device: devices[1], status: { quality: 'bad' } })
  const repaired = tooltipBindingContext(widget, context).widget
  assert.equal(repaired.data.mode, 'runtime')
  assert.equal(repaired.data.path, 'hover.device.status')
  assert.equal(repaired.data.deviceId, 'b')
  assert.equal(repaired.content.text, '{value}')
  assert.equal(JSON.stringify(widget), before)
  const label = { id: 'custom_caption', type: 'text', content: { text: '数据正常' }, data: { mode: 'static' } }
  assert.equal(tooltipBindingContext(label, context).widget.content.text, '数据正常')
  assert.equal(tooltipBindingContext(label, context).widget.data.mode, 'static')
  assert.equal(tooltipBindingContext(widget, {}).widget.data.mode, 'static', 'main-screen widgets are not tooltip migration targets')
})

test('nested point identity and units are linked metadata, while reading values and formatted data keep mapping support', () => {
  for (const prefix of ['hover.part.points.0', 'hover.device.pointMap.analog.temp']) {
    for (const field of ['name', 'label', 'id', 'unit']) assert.equal(tooltipMetadataPath(`${prefix}.${field}`), true)
    for (const field of ['value', 'text']) assert.equal(tooltipMetadataPath(`${prefix}.${field}`), false)
  }
  assert.equal(tooltipMetadataPath('hover.part.points.-1.name'), false)
  assert.equal(tooltipMetadataPath('hover.part.points.0.value.name'), false)
  assert.equal(tooltipMetadataPath('hover.device.pointMap.analog.temp.value.name'), false)
})

test('static nested point metadata with a residual source path restores its binding but a literal static point caption does not', () => {
  const context = createTooltipContext({ device: devices[1] })
  for (const path of ['hover.part.points.0.name', 'hover.device.pointMap.analog.temp.label', 'hover.part.points.0.id', 'hover.device.pointMap.analog.temp.unit']) {
    const widget = { id: 'custom_point_metadata', type: 'text', data: { mode: 'static', path },
      content: { text: '冻结点位信息', valueMap: [{ value: '现场名', text: '冻结点位信息' }] } }
    const before = JSON.stringify(widget)
    const result = tooltipBindingContext(widget, context).widget
    assert.equal(result.data.mode, 'runtime')
    assert.equal(result.data.path, path)
    assert.equal(result.content.text, '{value}')
    assert.equal(result.content.valueMap, undefined)
    assert.equal(JSON.stringify(widget), before)
  }
  const caption = { id: 'custom_point_caption', type: 'text', data: { mode: 'static' }, content: { text: '温度' } }
  assert.equal(tooltipBindingContext(caption, context).widget.data.mode, 'static')
  assert.equal(tooltipBindingContext(caption, context).widget.content.text, '温度')
})
