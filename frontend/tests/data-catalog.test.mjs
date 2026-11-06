import test from 'node:test'
import assert from 'node:assert/strict'
import { catalogBinding, catalogItemUsable, catalogMatchesBinding, filterCatalogItems, catalogPreview } from '../src/runtime/dataCatalog.js'
import { addTooltipDataRow } from '../src/runtime/tooltipDataRows.js'
import { createTooltipTemplate, tooltipBackgroundWidget, restoreTooltipDynamicBinding } from '../../shared/tooltipTemplates.mjs'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'

const point = { id: 'real_temperature', label: '炉内温度', categoryId: 'realtime', tableId: 'plc-device', tableName: '1#多用炉 · 采集点位', deviceName: '1#多用炉', unit: '℃', sourceType: 'plc', type: 'number', objectScope: 'device',
  binding: { mode: 'plc', pointId: '7', deviceId: 'furnace1', deviceScope: 'fixed', pointKey: 'analog.temperature', path: 'analog.temperature', requireConfiguredPoint: true },
  tooltipBinding: { mode: 'plc', pointKey: 'analog.temperature', path: 'analog.temperature', deviceScope: 'current', requireConfiguredPoint: true } }
const name = { id: 'device_name', label: '设备名称', categoryId: 'device', tableId: 'devices', tableName: '设备资料', sourceType: 'internal', type: 'string', objectScope: 'device',
  binding: { mode: 'runtime', path: 'deviceInfo.name', deviceScope: 'current' }, tooltipBinding: { mode: 'runtime', path: 'hover.device.name', deviceScope: 'current' } }
const part = { ...name, id: 'part_name', label: '部件名称', objectScope: 'part', categoryId: 'parts', tooltipBinding: { mode: 'runtime', path: 'hover.part.name' } }
const table = { id: 'production_amount', label: '今日产量', categoryId: 'production', tableId: 'external', sourceType: 'dataset', type: 'number', objectScope: 'factory',
  binding: { mode: 'dataset', datasetId: 'dataset_REAL', datasetField: 'quantity', datasetMode: 'first', deviceScope: 'global' }, tooltipBinding: { mode: 'dataset', datasetId: 'dataset_REAL', datasetField: 'quantity', datasetMode: 'first', deviceScope: 'global' } }

test('catalog only returns supported actual bindings for the target widget and hover kind', () => {
  assert.equal(catalogItemUsable(point, { widgetType: 'trend' }), true)
  assert.equal(catalogItemUsable(name, { widgetType: 'trend' }), false)
  assert.equal(catalogItemUsable(point, { widgetType: 'container' }), false)
  assert.equal(catalogItemUsable(point, { tooltip: true, widgetType: 'container' }), false)
  assert.equal(catalogItemUsable(table, { widgetType: 'metrics' }), true)
  assert.equal(catalogItemUsable(point, { widgetType: 'metrics' }), false, 'a scalar PLC path cannot be used as a metric panel root')
  assert.equal(catalogItemUsable(point, { widgetType: 'text', mapContext: true }), false)
  assert.equal(catalogItemUsable(table, { widgetType: 'value', mapContext: true }), true)
  assert.equal(catalogItemUsable(part, { tooltip: true, kind: 'device' }), false)
  assert.equal(catalogItemUsable(part, { tooltip: true, kind: 'part' }), true)
  assert.equal(catalogItemUsable({ ...point, enabled: false }, { tooltip: true }), false)
  assert.equal(catalogItemUsable({ ...point, tooltipBinding: undefined }, { tooltip: true }), false)
})

test('hover point bindings always follow the semantic key and never the preview point/device', () => {
  const before = JSON.stringify(point)
  const binding = catalogBinding({ ...point, tooltipBinding: { ...point.binding, point_id: 'old' } }, { tooltip: true })
  assert.equal(binding.deviceId, '')
  assert.equal(binding.pointId, '')
  assert.equal(binding.point_id, '')
  assert.equal(binding.deviceScope, 'current')
  assert.equal(binding.requireConfiguredPoint, true)
  assert.equal(binding.pointKey, 'analog.temperature')
  assert.equal(binding.unit, '')
  assert.equal(binding.unitPath, 'hover.device.pointMap.analog.temperature.unit')
  assert.equal(JSON.stringify(point), before)
  assert.equal(catalogBinding({ ...point, tooltipBinding: { mode: 'plc' } }, { tooltip: true }), null)
  assert.equal(catalogBinding(name, { tooltip: true }).path, 'hover.device.name')
  assert.equal(catalogBinding({ ...name, tooltipBinding: name.binding }, { tooltip: true }), null)
  assert.equal(catalogBinding(table, { tooltip: true }).deviceScope, 'global', 'factory data tables must not pretend to be hovered device values')
})

test('catalog search is Chinese/category/table aware and never presents stale/false preview values', () => {
  assert.deepEqual(filterCatalogItems([point, name, table], { query: '多用炉', widgetType: 'text' }).map(item => item.id), [point.id])
  assert.deepEqual(filterCatalogItems([point, name, table], { categoryId: 'production', tableId: 'external', query: '产量' }).map(item => item.id), [table.id])
  assert.equal(catalogPreview({ ...point, previewValue: 900, quality: 'stale' }), '—')
  assert.equal(catalogPreview({ ...point, previewValue: 0, quality: 'good' }), '0 ℃')
  assert.equal(catalogPreview({ ...name, previewValue: false, quality: 'good' }), 'false')
  assert.equal(catalogMatchesBinding(point, point.binding), true)
  assert.equal(catalogMatchesBinding(point, { ...point.binding, deviceId: 'other' }), false)
  assert.equal(catalogMatchesBinding(point, point.tooltipBinding, { tooltip: true }), true)
  assert.equal(catalogMatchesBinding(table, { ...table.binding, datasetField: 'different' }), false)
})

for (const kind of ['device', 'part']) test(`new ${kind} data row keeps basic widgets/styles and moves the hint while growing only the background`, () => {
  const source = createTooltipTemplate(kind), original = JSON.stringify(source)
  const originalHint = source.widgets.find(widget => widget.title === '点击提示')
  const originalBackground = tooltipBackgroundWidget(source)
  const output = addTooltipDataRow(source, { item: point, label: '自定义温度标题', stamp: 100 })
  const { template } = output
  assert.equal(JSON.stringify(source), original, 'building the transaction is non-mutating')
  assert.equal(template.widgets.length, source.widgets.length + 3)
  assert.equal(template.canvas.width, source.canvas.width)
  assert.equal(template.canvas.height, source.canvas.height + 34)
  const left = template.widgets.find(widget => widget.id === output.selectedIds[0]), right = template.widgets.find(widget => widget.id === output.selectedIds[1]), divider = template.widgets.find(widget => widget.id === output.selectedIds[2])
  assert.equal(left.type, 'text'); assert.equal(left.content.text, '自定义温度标题'); assert.equal(left.data.mode, 'static')
  assert.equal(right.type, 'text'); assert.equal(right.content.text, '{value}{unit}'); assert.equal(right.data.mode, 'plc')
  assert.equal(right.data.pointKey, 'analog.temperature'); assert.equal(right.data.deviceId, ''); assert.equal(right.data.pointId, '')
  assert.equal(left.groupId, right.groupId); assert.equal(divider.groupId, right.groupId)
  assert.equal(left.frame.y, right.frame.y)
  assert.ok(left.frame.x + left.frame.width <= right.frame.x)
  assert.equal(divider.frame.y + 4, left.frame.y)
  assert.equal(template.widgets.find(widget => widget.id === originalHint.id).frame.y, originalHint.frame.y + 34)
  const background = tooltipBackgroundWidget(template)
  assert.equal(background.frame.height, template.canvas.height)
  assert.equal(background.style.background, originalBackground.style.background)
  const lastValue = source.widgets.filter(widget => widget.type === 'text' && widget.frame.x >= source.canvas.width * .35 && widget.data?.mode === 'runtime').at(-1)
  assert.equal(right.style.fontWeight, lastValue.style.fontWeight)
  for (const widget of source.widgets.filter(widget => widget !== originalHint && widget !== originalBackground)) {
    assert.deepEqual(template.widgets.find(item => item.id === widget.id).frame, widget.frame)
  }
  const saved = normalizeDashboardDocument({ tooltipTemplates: { templates: [template], defaults: { [kind]: template.id } } }).tooltipTemplates.templates.find(item => item.id === template.id)
  const savedLeft = saved.widgets.find(widget => widget.id === left.id), savedRight = saved.widgets.find(widget => widget.id === right.id)
  assert.equal(savedLeft.content.text, '自定义温度标题'); assert.equal(savedLeft.data.mode, 'static')
  assert.equal(savedRight.data.mode, 'plc'); assert.equal(savedRight.data.pointKey, 'analog.temperature')
  const repaired = restoreTooltipDynamicBinding({ ...savedRight, data: { mode: 'static' }, content: { text: '999' } }, saved)
  assert.equal(repaired.data.mode, 'plc'); assert.equal(repaired.content.text, '{value}{unit}')
})

test('row insertion validates limits up front and never partially alters a full or invalid template', () => {
  const source = createTooltipTemplate('device')
  source.canvas.height = 1080
  const before = JSON.stringify(source)
  assert.throws(() => addTooltipDataRow(source, { item: point }), /1080/)
  assert.equal(JSON.stringify(source), before)
  source.canvas.height = 230
  while (source.widgets.length < 78) source.widgets.push({ ...source.widgets.at(-1), id: `extra-${source.widgets.length}` })
  assert.throws(() => addTooltipDataRow(source, { item: point }), /80/)
  assert.throws(() => addTooltipDataRow(source, { item: part }), /当前悬停对象/)
})

test('adding a metadata row gives an editable left caption, but never authors the dynamic right value', () => {
  const source = createTooltipTemplate('device')
  const output = addTooltipDataRow(source, { item: name, label: '设备昵称', stamp: 200 })
  const right = output.template.widgets.find(widget => widget.id === output.selectedIds[1])
  assert.equal(right.content.text, '{value}')
  assert.equal(right.data.path, 'hover.device.name')
  assert.equal(right.dynamicField, undefined, 'a generic row may choose a different real data field')
  assert.equal(right.dynamicBinding.path, 'hover.device.name')
  const next = addTooltipDataRow(output.template, { item: table, label: '已接入产量', stamp: 201 })
  assert.equal(next.template.widgets.length, source.widgets.length + 6)
  assert.equal(next.template.canvas.height, source.canvas.height + 68)
})

test('custom tall rows push an already-overlapping footer below the inserted data row, without moving its preceding body', () => {
  const source = createTooltipTemplate('device'), hint = source.widgets.find(widget => widget.title === '点击提示')
  const last = source.widgets.find(widget => widget.id.endsWith('_line_value')), label = source.widgets.find(widget => widget.id.endsWith('_line_label'))
  last.frame.height = label.frame.height = 100
  source.widgets.push({ ...source.widgets.find(widget => widget.type === 'container' && widget.frame.height === 1), id: 'footer-line', frame: { x: 20, y: hint.frame.y - 4, width: 240, height: 1, rotation: 0 } })
  const output = addTooltipDataRow(source, { item: point, stamp: 300 }), next = output.template
  const value = next.widgets.find(widget => widget.id === output.selectedIds[1]), movedHint = next.widgets.find(widget => widget.id === hint.id)
  assert.equal(value.frame.height, 100)
  assert.ok(movedHint.frame.y >= value.frame.y + value.frame.height + 12)
  assert.ok(next.widgets.find(widget => widget.id === 'footer-line').frame.y >= value.frame.y + value.frame.height)
  assert.deepEqual(next.widgets.find(widget => widget.id === last.id).frame, last.frame)
  assert.ok(next.canvas.height >= movedHint.frame.y + movedHint.frame.height + 12)
})

test('long valid template identifiers preserve row uniqueness, and hint-less/hidden-body cards can still add independent rows', () => {
  const source = createTooltipTemplate('device', 'x'.repeat(128))
  source.widgets = source.widgets.filter(widget => widget.title !== '点击提示')
  source.widgets.find(widget => widget.title === '提示标题').visible = false
  const first = addTooltipDataRow(source, { item: point, stamp: 400 }), second = addTooltipDataRow(first.template, { item: point, stamp: 401 })
  assert.equal(second.template.widgets.length, source.widgets.length + 6)
  assert.equal(new Set(second.template.widgets.map(widget => widget.id)).size, second.template.widgets.length)
  assert.ok(second.template.widgets.filter(widget => widget.groupId).every(widget => widget.id.length <= 128 && widget.groupId.length <= 128))
  assert.notEqual(first.selectedIds[0], second.selectedIds[0])
})
