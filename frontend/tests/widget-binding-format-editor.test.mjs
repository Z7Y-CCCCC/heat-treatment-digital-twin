import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { compileScript, compileStyle, parse } from 'vue/compiler-sfc'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { DEFAULT_METRIC_ITEMS } from '../src/runtime/widgetContentConfig.js'
import { bindingForDevice } from '../../shared/widgetBindingWorkflow.mjs'

// Actual SFC template and native value patches in a memory host. No browser,
// production draft, cookies, database, or acquisition settings are touched.
const componentUrl = new URL('../src/views/admin/components/WidgetDataBindingEditor.vue', import.meta.url)
const componentSource = await readFile(componentUrl, 'utf8')
const descriptor = parse(componentSource).descriptor
let code = compileScript(descriptor, { id: 'binding-format-editor', inlineTemplate: true }).content
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, source) => 'from ' + JSON.stringify(
  source.endsWith('.vue') ? 'data:text/javascript,export default {render:()=>null}'
    : source === 'vue' ? import.meta.resolve('vue') : new URL(source, componentUrl).href))
const Editor = (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default
const clone = value => JSON.parse(JSON.stringify(value))
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } return value }
const devices = [{ id: 'a', name: 'A炉' }, { id: 'b', name: 'B炉' }]
const points = [{ id: 'a1', device_id: 'a', plc_tag: 'DB101.DBD0', unit: '℃' }, { id: 'b1', device_id: 'b', plc_tag: 'DB202.DBD0', unit: 'bar' }]

function makeWidget(overrides = {}) {
  return { id: 'format-fixture', type: 'value', content: {}, data: {
    mode: 'plc', bindingVersion: 2, deviceScope: 'rotation', unit: 'stale-top-unit', decimals: 1,
    rotationIntervalMs: 12000, rotationDeviceIds: ['a', 'b'], deviceBindings: [
      { deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', pointKey: 'analog.temp', unit: '℃', decimals: 2, catalogItemId: 'point-a' } },
      { deviceId: 'b', binding: { mode: 'plc', pointId: 'b1', pointKey: 'analog.pressure', unit: 'bar', unitPath: 'device.unit', decimals: 3, catalogItemId: 'point-b' } }
    ]
  }, ...overrides }
}

function mount(t, widget, props = {}) {
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Source configuration does not acquire data') })
  const node = (tag, text = '') => ({ tag, text, props: {}, value: '', children: [], parent: null })
  const remove = child => {
    if (!child.parent) return
    const siblings = child.parent.children, index = siblings.indexOf(child)
    if (index >= 0) siblings.splice(index, 1)
    child.parent = null
  }
  const patches = []
  const renderer = createRenderer({
    createElement: tag => node(tag), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (child, text) => { child.text = text }, setElementText: (child, text) => { child.text = text; child.children = [] },
    parentNode: child => child.parent,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    remove,
    insert(child, parent, anchor) {
      remove(child)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index >= 0 ? index : parent.children.length, 0, child); child.parent = parent
    },
    patchProp(child, key, previous, next) {
      if (key === 'value') { patches.push({ label: child.props['aria-label'], before: child.value, next: String(next ?? '') }); child.value = String(next ?? '') }
      child.props[key] = next
    }
  })
  const root = node('root'), changes = [], events = []
  const values = reactive({ 'a:a1': { id: 'a1', device_id: 'a', value: 12, quality: 'good' }, 'b:b1': { id: 'b1', device_id: 'b', value: 2, quality: 'good' } })
  const app = renderer.createApp({ render: () => h(Editor, {
    widget, devices, points, values, factoryId: 'factory-fixture',
    onChange: value => { changes.push(value); if (!Object.isFrozen(widget)) widget.data = value },
    onMetricLabel: value => events.push({ type: 'metric-label', value }),
    onMetricLabelSource: value => events.push({ type: 'metric-label-source', value }),
    onMetricFormat: value => events.push({ type: 'metric-format', value }),
    onMetricSelect: value => events.push({ type: 'metric-select', value }),
    onAddMetric: () => events.push({ type: 'add-metric' }), onRemoveMetric: value => events.push({ type: 'remove-metric', value }),
    ...props
  }) })
  app.mount(root); t.after(() => app.unmount())
  const all = () => { const result = []; const visit = child => { result.push(child); child.children.forEach(visit) }; visit(root); return result }
  const field = label => { const child = all().find(child => child.props['aria-label'] === label); assert.ok(child, 'Actual control rendered: ' + label); return child }
  const dispatch = (child, key) => { const event = { target: child, currentTarget: child }; for (const fn of [].concat(child.props[key] || [])) fn(event) }
  const type = (child, value) => { child.value = String(value); dispatch(child, 'onInput') }
  const change = (child, value) => { if (value !== undefined) child.value = String(value); dispatch(child, 'onChange') }
  const text = child => child.text + child.children.map(text).join('')
  const button = label => { const child = all().find(child => child.tag === 'button' && text(child) === label); assert.ok(child, label + ' rendered'); return child }
  const frame = async value => { values['b:b1'] = { id: 'b1', device_id: 'b', value, quality: 'good' }; await nextTick() }
  return { widget, field, all, dispatch, type, change, button, frame, changes, events, patches, text: () => text(root), fetches: () => fetches }
}

function savedWidget(widget) {
  const saved = normalizeDashboardDocument({ widgets: [clone(widget)] })
  return normalizeDashboardDocument(clone(saved)).widgets.find(item => item.id === widget.id)
}

test('normal static metrics controls show the exact four displayed defaults without materializing or acquiring them', async t => {
  const widget = freeze({ id: 'default-metrics', type: 'metrics', content: {}, data: { mode: 'static' } }), before = JSON.stringify(widget)
  const f = mount(t, widget)
  for (let index = 0; index < 4; index++) {
    assert.equal(f.field(`指标 ${index + 1} 名称`).value, DEFAULT_METRIC_ITEMS[index].label)
    assert.equal(f.field(`指标 ${index + 1} 数据字段`).value, DEFAULT_METRIC_ITEMS[index].path)
  }
  assert.equal(f.field('指标 2 单位').value, '%')
  assert.equal(f.events.length, 0); assert.equal(f.changes.length, 0); assert.equal(f.fetches(), 0)
  assert.doesNotMatch(f.text(), /当前只显示固定内容/)
  assert.ok(f.all().filter(child=>child.tag==='button' && child.props['aria-pressed'] !== undefined).every(child=>child.props['aria-pressed']===false), 'a static primary does not claim that the four global metric fields use the current-device button')
  assert.equal(JSON.stringify(widget), before); assert.equal(Object.hasOwn(widget.content, 'items'), false)
  assert.doesNotMatch(componentSource, /WidgetSourceTrace|数据与内容来源/)
  assert.deepEqual(compileStyle({ source: descriptor.styles[0].content, filename: 'WidgetDataBindingEditor.vue', id: 'binding-format-editor', scoped: true }).errors, [])
})

test('an explicit empty metrics list stays empty rather than acquiring the four implicit defaults', t => {
  const widget = freeze({ id: 'empty-metrics', type: 'metrics', content: { items: [] }, data: { mode: 'static' } })
  const f = mount(t, widget)
  assert.equal(f.all().filter(child => child.props['aria-label']?.match(/^指标 \d+ 名称$/)).length, 0)
  assert.match(f.text(), /面板指标（0）/)
  assert.deepEqual(widget.content.items, [])
})

test('per-device controls display the real row unit, unit path, and decimals instead of stale top-level fields', t => {
  const f = mount(t, reactive(makeWidget()))
  assert.equal(f.field('设备 a 主数据单位').value, '℃')
  assert.equal(f.field('设备 b 主数据单位').value, 'bar')
  assert.equal(f.field('设备 b 主数据单位字段').value, 'device.unit')
  assert.equal(f.field('设备 b 主数据小数位').value, '3')
  assert.equal(f.changes.length, 0)
})

test('typing a unit is preserved across an actual PLC repaint and committed only on change', async t => {
  const f = mount(t, reactive(makeWidget())), input = f.field('设备 b 主数据单位')
  f.type(input, 'h'); await nextTick(); await f.frame(3)
  assert.equal(input.value, 'h'); assert.equal(f.widget.data.deviceBindings[1].binding.unit, 'bar')
  assert.equal(f.changes.length, 0)
  f.change(input); await nextTick()
  assert.equal(f.widget.data.deviceBindings[1].binding.unit, 'h')
  assert.equal(f.widget.data.deviceBindings[1].binding.unitPath, '')
  assert.equal(f.changes.length, 1)
})

test('a normal unit edit changes one actual row and preserves other sources, timing, ordering, and saved metadata', async t => {
  const f = mount(t, reactive(makeWidget())), other = clone(f.widget.data.deviceBindings[0]), before = clone(f.widget.data)
  const input = f.field('设备 b 主数据单位')
  f.type(input, 'kPa'); f.change(input); await nextTick()
  assert.deepEqual(clone(f.widget.data.deviceBindings[0]), other)
  assert.equal(f.widget.data.unit, before.unit); assert.equal(f.widget.data.decimals, before.decimals)
  assert.equal(f.widget.data.rotationIntervalMs, before.rotationIntervalMs)
  assert.deepEqual(clone(f.widget.data.rotationDeviceIds), before.rotationDeviceIds)
  const reopened = savedWidget(f.widget)
  assert.equal(reopened.data.deviceBindings[1].binding.unit, 'kPa')
  assert.equal(reopened.data.deviceBindings[1].binding.unitPath, '')
  assert.equal(reopened.data.deviceBindings[1].binding.catalogItemId, 'point-b')
  assert.deepEqual(reopened.data.deviceBindings[0].binding, savedWidget(makeWidget()).data.deviceBindings[0].binding)
})

test('an explicitly selected existing unit field replaces the row override and survives normalized save/reopen', async t => {
  const f = mount(t, reactive(makeWidget())), input = f.field('设备 b 主数据单位字段')
  f.type(input, 'selectedPart.points.1.unit'); await nextTick(); await f.frame(4)
  assert.equal(input.value, 'selectedPart.points.1.unit'); assert.equal(f.widget.data.deviceBindings[1].binding.unit, 'bar')
  f.change(input); await nextTick()
  const row = savedWidget(f.widget).data.deviceBindings[1]
  assert.equal(row.binding.unit, ''); assert.equal(row.binding.unitPath, 'selectedPart.points.1.unit')
  assert.equal(row.binding.pointId, 'b1')
})

test('clearing a device unit field overrides a nonempty top-level path immediately before any save normalization', async t => {
  const widget = reactive(makeWidget())
  widget.data.unitPath = 'metrics.staleUnit'
  const f = mount(t, widget), other = clone(widget.data.deviceBindings[0])
  const unit = f.field('设备 b 主数据单位')
  f.type(unit, 'kPa'); f.change(unit); await nextTick()
  assert.equal(Object.hasOwn(widget.data.deviceBindings[1].binding, 'unitPath'), true)
  assert.equal(widget.data.deviceBindings[1].binding.unitPath, '')
  assert.equal(bindingForDevice(widget.data, 'b').unitPath, '', 'the emitted row must mask the top-level path before normalization can fill defaults')
  assert.equal(widget.data.unitPath, 'metrics.staleUnit')
  const path = f.field('设备 b 主数据单位字段')
  f.type(path, 'selectedPart.points.1.unit'); f.change(path); await nextTick()
  assert.equal(bindingForDevice(widget.data, 'b').unitPath, 'selectedPart.points.1.unit')
  f.type(path, ''); f.change(path); await nextTick()
  assert.equal(Object.hasOwn(widget.data.deviceBindings[1].binding, 'unitPath'), true)
  assert.equal(bindingForDevice(widget.data, 'b').unitPath, '', 'clearing the unit-field control must not restore a hidden inherited path')
  assert.equal(widget.data.unitPath, 'metrics.staleUnit')
  assert.deepEqual(clone(widget.data.deviceBindings[0]), other)
})

test('per-device decimals persist and the explicit inheritance choice removes only the row override', async t => {
  const f = mount(t, reactive(makeWidget())), select = f.field('设备 b 主数据小数位')
  f.change(select, 4); await nextTick()
  assert.equal(savedWidget(f.widget).data.deviceBindings[1].binding.decimals, 4)
  f.change(select, ''); await nextTick()
  assert.equal(Object.hasOwn(f.widget.data.deviceBindings[1].binding, 'decimals'), false)
  assert.equal(Object.hasOwn(savedWidget(f.widget).data.deviceBindings[1].binding, 'decimals'), false)
  assert.equal(f.widget.data.decimals, 1)
  assert.equal(f.widget.data.deviceBindings[0].binding.decimals, 2)
})

test('global normal unit and decimal controls edit the true binding without replacing retained device assignments', async t => {
  const widget = reactive(makeWidget({ data: { mode: 'dataset', datasetId: 'factory-energy', datasetField: 'value', datasetMode: 'sum', bindingVersion: 2,
    deviceScope: 'global', unit: 'kWh', decimals: 2, unitPath: 'dataset.unit', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', unit: '℃' } }] } }))
  const f = mount(t, widget), retained = clone(widget.data.deviceBindings)
  const input = f.field('主数据单位')
  assert.equal(input.value, 'kWh')
  f.type(input, 'MWh'); f.change(input); f.change(f.field('主数据小数位'), 3); await nextTick()
  assert.equal(widget.data.unit, 'MWh'); assert.equal(widget.data.unitPath, ''); assert.equal(widget.data.decimals, 3)
  assert.deepEqual(clone(widget.data.deviceBindings), retained)
  assert.equal(widget.data.datasetId, 'factory-energy'); assert.equal(widget.data.datasetMode, 'sum')
  assert.equal(savedWidget(widget).data.decimals, 3)
})

test('missing rows have disabled normal format controls and cannot fabricate a binding through a dispatched event', t => {
  const widget = reactive(makeWidget({ data: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', deviceBindings: [{ deviceId: 'a', binding: null }] } }))
  const f = mount(t, widget)
  for (const label of ['设备 a 主数据单位', '设备 a 主数据单位字段', '设备 a 主数据小数位']) {
    assert.equal(f.field(label).props.disabled, true); f.change(f.field(label), label.endsWith('小数位') ? 2 : 'h')
  }
  assert.equal(f.changes.length, 0); assert.equal(widget.data.deviceBindings[0].binding, null)
})

test('read-only normal fields cannot commit data or metric changes even when handlers are dispatched', async t => {
  const widget = reactive(makeWidget({ type: 'hud_kpi_panel', content: { items: [{ label: '压力', unit: 'legacy', binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'current', deviceBindings: [{ deviceId: 'b', binding: { mode: 'plc', pointId: 'b1', unit: 'bar' } }] } }] } }))
  const before = JSON.stringify(widget), f = mount(t, widget, { disabled: true })
  for (const label of ['设备 b 主数据单位', '设备 b 指标 1 名称', '设备 b 指标 1 单位', '设备 b 指标 1 小数位', '设备 b 指标 1 名称来源']) {
    const input = f.field(label); assert.equal(input.props.disabled, true); f.type(input, 'edited'); f.change(input, label.endsWith('小数位') ? 4 : 'edited')
  }
  await nextTick()
  assert.equal(f.events.length, 0); assert.equal(f.changes.length, 0); assert.equal(JSON.stringify(widget), before)
})

test('metric labels are editable normal controls and preserve an uncommitted edit through PLC repaint', async t => {
  const widget = reactive(makeWidget({ type: 'hud_kpi_panel', content: { items: [{ label: '压力', binding: { mode: 'runtime', deviceScope: 'global', path: 'metrics.current_output' } }] } }))
  const before = JSON.stringify(widget), f = mount(t, widget), input = f.field('设备 b 指标 1 名称')
  assert.equal(input.props.disabled, false)
  f.type(input, '累计压力'); await nextTick(); await f.frame(5)
  assert.equal(input.value, '累计压力'); assert.equal(f.events.length, 0)
  f.change(input); await nextTick()
  assert.deepEqual(f.events, [{ type: 'metric-label', value: { index: 0, value: '累计压力' } }])
  assert.equal(JSON.stringify(widget), before, 'the child emits a user action, not a props mutation')
})

test('existing label paths are real normal fields and changing back to a fixed name is an explicit request', async t => {
  const widget = freeze({ id: 'path-label', type: 'metrics', data: { mode: 'static' }, content: { items: [{ label: '回退名称', labelPath: 'deviceInfo.name', path: 'metrics.current_output' }] } })
  const f = mount(t, widget)
  assert.equal(f.field('指标 1 名称来源').value, 'field'); assert.equal(f.field('指标 1 名称').value, 'deviceInfo.name')
  f.change(f.field('指标 1 名称来源'), 'fixed'); await nextTick()
  assert.deepEqual(f.events[0], { type: 'metric-label-source', value: { index: 0, source: 'fixed', labelPath: '' } })
  assert.equal(f.field('指标 1 名称').value, '回退名称')
  assert.equal(widget.content.items[0].labelPath, 'deviceInfo.name')
})

test('metric unit and field edits emit the exact effective device and clear the explicitly replaced source', async t => {
  const widget = freeze(makeWidget({ type: 'hud_kpi_panel', content: { items: [{ label: '压力', unit: 'stale-item', unitPath: 'old.metadata.unit', decimals: 2,
    binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'current', unit: 'stale-metric-top', deviceBindings: [{ deviceId: 'b', binding: { mode: 'plc', pointId: 'b1', unit: 'bar', unitPath: 'device.unit' } }] } }] } }))
  const f = mount(t, widget)
  assert.equal(f.field('设备 b 指标 1 单位').value, 'bar')
  assert.equal(f.field('设备 b 指标 1 单位字段').value, 'old.metadata.unit')
  const unit = f.field('设备 b 指标 1 单位')
  f.type(unit, 'kPa'); await nextTick(); await f.frame(6); assert.equal(unit.value, 'kPa'); f.change(unit)
  const path = f.field('设备 b 指标 1 单位字段'); f.type(path, 'selectedPart.points.0.unit'); f.change(path)
  f.change(f.field('设备 b 指标 1 小数位'), 4); f.change(f.field('设备 b 指标 1 小数位'), '')
  assert.deepEqual(f.events, [
    { type: 'metric-format', value: { index: 0, deviceId: 'b', unit: 'kPa', unitPath: '' } },
    { type: 'metric-format', value: { index: 0, deviceId: 'b', unitPath: 'selectedPart.points.0.unit', unit: '' } },
    { type: 'metric-format', value: { index: 0, deviceId: 'b', decimals: 4 } },
    { type: 'metric-format', value: { index: 0, deviceId: 'b', decimals: '' } }
  ])
  assert.equal(widget.content.items[0].binding.deviceBindings[0].binding.unit, 'bar')
})

test('a missing metric assignment disables unit configuration without guessing another device source', t => {
  const widget = freeze(makeWidget({ type: 'hud_kpi_panel', content: { items: [{ label: '压力', binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'current', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', unit: '℃' } }] } }] } }))
  const f = mount(t, widget), input = f.field('设备 b 指标 1 单位')
  assert.equal(input.props.disabled, true); f.change(input, 'bar')
  assert.equal(f.events.length, 0); assert.equal(widget.content.items[0].binding.deviceBindings.length, 1)
})

test('default metric data-field selection emits an explicit real runtime binding without mutating or replacing the other defaults', t => {
  const widget = freeze({ id: 'source-defaults', type: 'metrics', content: {}, data: { mode: 'static' } })
  const before = JSON.stringify(DEFAULT_METRIC_ITEMS), f = mount(t, widget)
  f.change(f.field('指标 2 数据字段'), 'metrics.overall_oee')
  assert.deepEqual(f.events, [{ type: 'metric-select', value: { index: 1, deviceId: '', item: {
    label: '完成进度', unit: '%', binding: { mode: 'runtime', path: 'metrics.overall_oee', deviceScope: 'global', readOnly: true }
  } } }])
  assert.equal(JSON.stringify(DEFAULT_METRIC_ITEMS), before); assert.equal(Object.hasOwn(widget.content, 'items'), false)
  assert.equal(f.fetches(), 0)
})

test('default metric addition and removal remain parent-owned explicit actions rather than replacing the hidden defaults on mount', t => {
  const widget = freeze({ id: 'add-defaults', type: 'metrics', content: {}, data: { mode: 'static' } }), f = mount(t, widget)
  f.dispatch(f.button('＋ 添加指标'), 'onClick')
  f.dispatch(f.button('删除这个指标'), 'onClick')
  assert.deepEqual(f.events, [{ type: 'add-metric' }, { type: 'remove-metric', value: 0 }])
  assert.equal(Object.hasOwn(widget.content, 'items'), false); assert.equal(DEFAULT_METRIC_ITEMS.length, 4)
})

test('static primary edits an independent fixed metric using its real device and persists the emitted format without guessing a current device', async t => {
  const widget = reactive(makeWidget({ type: 'hud_kpi_panel', data: { mode: 'static' }, content: { items: [{ label: '压力', unit: 'fallback-only', unitPath: 'old.item.unit',
    binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', unitPath: 'old.top.unit', deviceBindings: [
      { deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', pointKey: 'analog.pressure', unit: 'bar', unitPath: 'old.row.unit' } },
      { deviceId: 'b', binding: { mode: 'plc', pointId: 'b1', pointKey: 'analog.pressure', unit: 'other-row' } }
    ] }
  }] } }))
  const events = [], other = clone(widget.content.items[0].binding.deviceBindings[1])
  const f = mount(t, widget, { onMetricFormat: payload => {
    events.push(payload)
    const item = widget.content.items[payload.index], row = item.binding.deviceBindings.find(row => row.deviceId === payload.deviceId)
    assert.ok(row, 'the emitted identity must target the configured device, not an empty/current fallback')
    row.binding.unit = payload.unit; row.binding.unitPath = payload.unitPath; item.unit = payload.unit; item.unitPath = ''
  } })
  assert.equal(f.field('指标 1 数据范围').value, 'fixed'); assert.equal(f.field('指标 1 指定设备').value, 'a')
  const unit = f.field('指标 1 单位')
  assert.equal(unit.props.disabled, false); assert.equal(unit.value, 'bar')
  f.type(unit, 'kPa'); f.change(unit); await nextTick()
  assert.deepEqual(events, [{ index: 0, deviceId: 'a', unit: 'kPa', unitPath: '' }])
  assert.equal(bindingForDevice(widget.content.items[0].binding, 'a').unit, 'kPa')
  assert.equal(bindingForDevice(widget.content.items[0].binding, 'a').unitPath, '', 'the correct device changes immediately before normalized save')
  const saved = savedWidget(widget).content.items[0]
  assert.equal(saved.binding.deviceBindings[0].binding.unit, 'kPa')
  assert.equal(saved.binding.deviceBindings[0].binding.unitPath, '')
  assert.equal(saved.binding.deviceBindings[0].binding.pointId, 'a1')
  assert.deepEqual(clone(widget.content.items[0].binding.deviceBindings[1]), other)
  const unresolved = reactive(makeWidget({ type: 'hud_kpi_panel', data: { mode: 'static' }, content: { items: [{ label: '未指定当前设备', binding: {
    mode: 'plc', bindingVersion: 2, deviceScope: 'current', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', unit: 'bar' } }]
  } }] } }))
  const missing = mount(t, unresolved)
  assert.equal(missing.field('指标 1 指定设备').value, '')
  for (const label of ['指标 1 单位', '指标 1 单位字段', '指标 1 小数位']) {
    assert.equal(missing.field(label).props.disabled, true)
    missing.change(missing.field(label), label.endsWith('小数位') ? 2 : 'h')
  }
  assert.equal(missing.events.length, 0); assert.equal(unresolved.content.items[0].binding.deviceScope, 'current')
})

test('unbinding a global primary leaves one metric configuration and keeps all explicit display-mode choices usable', async t => {
  const widget = reactive(makeWidget({ type: 'hud_kpi_panel', data: { mode: 'runtime', bindingVersion: 2, deviceScope: 'global', path: 'metrics.current_output', deviceBindings: [] },
    content: { items: [{ label: '独立压力', unit: 'fallback-only', binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a',
      deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', pointKey: 'analog.pressure', unit: 'bar' } }] } }] } }))
  const f = mount(t, widget), metricBefore = clone(widget.content.items[0])
  const units = () => f.all().filter(child => child.tag === 'input' && child.props['aria-label'] === '指标 1 单位')
  assert.equal(units().length, 1)
  f.dispatch(f.button('取消主数据绑定（保留指标来源）'), 'onClick'); await nextTick()
  assert.equal(widget.data.mode, 'static'); assert.equal(widget.data.deviceScope, 'global')
  assert.equal(units().length, 1, 'the retained global scope must not render a duplicate global metric branch alongside static metrics')
  assert.equal(units()[0].value, 'bar'); assert.equal(f.field('指标 1 指定设备').value, 'a')
  const modes = () => f.all().filter(child => child.tag === 'button' && child.props['aria-pressed'] !== undefined)
  assert.equal(modes().length, 3); assert.ok(modes().every(child => child.props['aria-pressed'] === false))
  for (const [index, mode] of ['current', 'fixed', 'rotation'].entries()) {
    f.dispatch(modes()[index], 'onClick'); await nextTick()
    assert.equal(widget.data.deviceScope, mode); assert.equal(widget.data.mode, 'plc')
    assert.ok(widget.data.deviceBindings.every(row => row.binding === null), 'a display-mode choice must not guess the primary point from the independent metric')
    f.dispatch(f.button('取消主数据绑定（保留指标来源）'), 'onClick'); await nextTick()
    assert.equal(widget.data.mode, 'static'); assert.equal(units().length, 1)
  }
  assert.deepEqual(clone(widget.content.items[0]), metricBefore)
})
