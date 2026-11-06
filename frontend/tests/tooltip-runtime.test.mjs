import test from 'node:test'
import assert from 'node:assert/strict'
import { tooltipPlacement, tooltipHoverTarget, tooltipRequestContext, createTooltipReadScheduler } from '../src/runtime/tooltipRuntime.js'
import { createTooltipContext } from '../src/runtime/tooltipContext.js'

const devices = [
  { id: 'one', name: '设备一', workshopId: 'w', lineId: 'l' },
  { id: 'two', name: '设备二', workshopId: 'w', lineId: 'l' },
  { id: 'other', name: '其他车间', workshopId: 'outside', lineId: 'outside' }
]
const overview = () => ({ factoryId: 'f', viewId: 'factory_overview', viewMode: 'factory', sceneReady: true,
  workshopId: 'w', lineId: 'l', hoveredDeviceId: 'one', deviceHoverPointer: { visible: true, x: .5, y: .5 } })

test('tooltip layout follows cursor, flips above bottom edge and clamps authored card dimensions', () => {
  const result = tooltipPlacement({ width: 280, height: 230 }, { visible: true, x: .99, y: .98 }, { width: 1000, height: 800 })
  assert.deepEqual(result, { left: 708, top: 542, width: 280, height: 230, scale: 1, floating: true })
  const small = tooltipPlacement({ width: 900, height: 800 }, { visible: true, x: 1, y: 1 }, { width: 320, height: 200 })
  assert.ok(small.scale < 1)
  assert.ok(small.left + small.width <= 308)
  assert.ok(small.top + small.height <= 188)
  assert.equal(tooltipPlacement({}, { visible: false, x: .5, y: .5 }), null)
  assert.equal(tooltipPlacement({}, { visible: true, x: NaN, y: .5 }), null)
  assert.equal(tooltipPlacement({}, { visible: true, x: 2, y: .5 }), null)
  assert.deepEqual(tooltipPlacement({ width: 300, height: 240 }), { left: 0, top: 0, width: 300, height: 240, scale: 1, floating: false })
})

test('overview hover is scope checked and never falls back to selected or rotating device', () => {
  const context = overview()
  const before = JSON.stringify(context)
  assert.equal(tooltipHoverTarget(context, devices).device.id, 'one')
  assert.equal(JSON.stringify(context), before)
  for (const changes of [{ hoveredDeviceId: 'missing' }, { hoveredDeviceId: 'other' }, { sceneReady: false },
    { hoveredDeviceId: '' }, { viewMode: 'custom' }, { deviceHoverPointer: { visible: false } }]) {
    assert.equal(tooltipHoverTarget({ ...context, ...changes }, devices), null)
  }
})

test('part hover resolves all bound points, filters foreign owners and hides on leave', () => {
  const points = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`one:p${index}`, {
    id: `p${index}`, device_id: index === 5 ? 'two' : 'one', name: `点位${index}`, value: index
  }]))
  const context = { ...overview(), viewMode: 'device', deviceId: 'one', inspectionEnabled: true,
    inspectionHoveredPartId: 'fan', inspectionHoverPointer: { visible: true, x: .8, y: .4 },
    inspectionParts: [{ id: 'fan', name: '风机', pointIds: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], pointKeys: ['motors.speed'] }] }
  const target = tooltipHoverTarget(context, devices, points, () => points['one:p0'])
  assert.equal(target.kind, 'part')
  assert.equal(target.part.name, '风机')
  assert.equal(target.points.length, 5)
  assert.equal(tooltipHoverTarget({ ...context, inspectionHoveredPartId: '' }, devices, points), null)
  assert.equal(tooltipHoverTarget({ ...context, inspectionHoveredPartId: 'unknown' }, devices, points), null)
  assert.equal(tooltipHoverTarget({ ...context, inspectionHoverPointer: { visible: false } }, devices, points), null)
  const anchored = tooltipHoverTarget({ ...context, inspectionHoverPointer: { visible: false },
    inspectionParts: [{ id: 'fan', anchor: { visible: true, x: .3, y: .3 } }] }, devices, points)
  assert.ok(anchored.pointer.visible)
})

test('request context excludes cursor and live data, includes exact hovered device and part', () => {
  const context = createTooltipContext({ kind: 'part', device: devices[1], part: { id: 'fan' }, runtimeContext: overview() })
  const request = tooltipRequestContext(context, 'custom_tip')
  assert.equal(request.deviceId, 'two')
  assert.equal(request.partId, 'fan')
  assert.equal(request.tooltipTemplateId, 'custom_tip')
  assert.equal(request.tooltipTarget, true)
  assert.equal(Object.hasOwn(request, 'hover'), false)
  assert.equal(Object.hasOwn(request, 'deviceHoverPointer'), false)
})

test('tooltip reader ignores pointer moves, cancels obsolete objects and ignores their late response', async () => {
  let context = createTooltipContext({ kind: 'device', device: devices[0], runtimeContext: overview() })
  let templateId = 'tip'
  const values = {}, requests = []
  const widgets = [{ id: 'value', data: { mode: 'dataset', datasetId: 'set', datasetField: 'value', deviceScope: 'current', refreshMs: 5000 } }]
  const reader = createTooltipReadScheduler({
    context: () => context, templateId: () => templateId, widgets: () => widgets,
    devices: () => devices, parameters: () => ({}),
    put: (id, value) => { values[id] = value }, remove: id => { delete values[id] },
    read: (ids, ctx, params, now, signal) => new Promise(resolve => requests.push({ ids, ctx, signal, resolve }))
  })
  const old = reader.refresh(false, 1000)
  await Promise.resolve()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].ctx.deviceId, 'one')
  context = { ...context, deviceHoverPointer: { visible: true, x: .99, y: .1 } }
  const same = reader.refresh(false, 1100)
  assert.equal(requests.length, 1)
  context = createTooltipContext({ kind: 'device', device: devices[1], runtimeContext: overview() })
  const next = reader.refresh(false, 1200)
  await Promise.resolve()
  assert.equal(requests.length, 2)
  assert.ok(requests[0].signal.aborted)
  requests[1].resolve({ values: { value: { value: 22, deviceId: 'two', quality: 'good', refreshAfterMs: 5000 } } })
  await next
  requests[0].resolve({ values: { value: { value: 11, deviceId: 'one', quality: 'good' } } })
  await old; await same
  assert.equal(values.value.value, 22)
  await reader.refresh(false, 1300)
  assert.equal(requests.length, 2)
  templateId = 'other_tip'
  const changed = reader.refresh(false, 1400)
  await Promise.resolve()
  assert.equal(requests.length, 3)
  assert.equal(values.value, undefined)
  requests[2].resolve({ values: { value: { value: 33, deviceId: 'two', quality: 'good' } } })
  await changed
  reader.dispose()
})

test('part tooltip external readers preserve deliberate fixed/global sources without rotating current sources', async () => {
  const context = createTooltipContext({ kind: 'part', device: devices[0], part: { id: 'fan' },
    runtimeContext: { ...overview(), viewId: 'device_part', viewMode: 'device' } })
  const values = {}, widgets = [
    { id: 'hover', data: { mode: 'dataset', deviceScope: 'current', refreshMs: 1000 } },
    { id: 'fixed', data: { mode: 'database', deviceScope: 'fixed', deviceId: 'two', refreshMs: 1000 } },
    { id: 'global', data: { mode: 'http_api', deviceScope: 'global', refreshMs: 1000 } }
  ]
  let receivedContext
  const reader = createTooltipReadScheduler({ context: () => context, templateId: () => 'part_tip',
    widgets: () => widgets, devices: () => devices, parameters: () => ({}),
    put: (id, record) => { values[id] = record }, remove: id => { delete values[id] },
    read: async (_ids, ctx) => {
      receivedContext = ctx
      return { values: { hover: { value: 1, deviceId: 'one', quality: 'good' },
        fixed: { value: 2, deviceId: 'two', quality: 'good' }, global: { value: 3, deviceId: '', quality: 'good' } } }
    }
  })
  await reader.refresh(false, 1000)
  assert.equal(receivedContext.partId, 'fan')
  assert.equal(receivedContext.deviceId, 'one')
  assert.equal(values.hover.value, 1)
  assert.equal(values.fixed.value, 2)
  assert.equal(values.global.value, 3)
  reader.dispose()
})
