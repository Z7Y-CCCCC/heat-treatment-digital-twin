import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, proxyRefs, reactive } from 'vue'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'
import { createTooltipTemplate } from '../../shared/tooltipTemplates.mjs'
import { deferred, installBrowser, settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/TooltipTemplateEditor.vue', import.meta.url)
const source = await readFile(url, 'utf8')
const testSource = source
  .replace(/import \{ adminApi \} from [^\n]+/, `const adminApi = { getDeviceInspection: async () => ({ inspection: { parts: [] } }), get previewDataSet() { return globalThis.__tooltipDataPreview } }`)
  .replace('</script>', '\ndefineExpose({ actualPoints, context, dataPreviewContext, template, templateId, kind, selectedIds, previewDeviceId, previewPartId, previewValues, previewSurfaceRef, selectedTextPreview, selectedTextSource, selectedTextFormat, selectedMode, selectedLinkedMetadata, selectedSystemMetadata, bindingSources, repairDynamicBindings, changeSource, changeBoundText, choosePoint, selectWidget, addWidget, beginPointer, pointerMove, pointerEnd, geometryChanged, templateGeometryChanged, beginCanvasResize, canvasResizeKey, backgroundWidget, newTemplate, copySelected, keys, toggleWidgetLock, deleteWidget, addingDataRow, dataRowLabel, dataRowItem, chooseCatalogData, chooseRowData, confirmDataRow })\n</script>')
const { descriptor } = parse(testSource)
let compiled = compileScript(descriptor, { id: 'tooltip-editor-test' }).content
  .replace(/from (['"])(vue)\1/g, (_, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
  .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, name) => `from ${JSON.stringify(new URL(name, url).href)}`)
  .replace(/from (["'])([^"']+\.vue)\1/g, `from 'data:text/javascript,export default {}'`)
const { default: Editor } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Editor.render = () => null
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
async function fixture(t, extra = {}) {
  const environment = installBrowser(t), changes = [], notices = []
  const deviceTemplate = createTooltipTemplate('device')
  const document = reactive({ tooltipTemplates: { defaults: { device: deviceTemplate.id }, templates: [deviceTemplate] }, parameters: [] })
  const props = { document, views: [{ id: 'factory', name: '全厂', mode: 'factory', metadata: {} }],
    devices: [{ id: 'b', name: '设备 B' }], points: [], pointValues: {}, ...extra }
  const renderer = createRenderer({
    createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (element, value) => element.text = value,
    setElementText: (element, value) => { element.text = value; element.children = [] },
    parentNode: element => element.parent,
    nextSibling: element => element.parent?.children[element.parent.children.indexOf(element) + 1] || null,
    patchProp: (element, key, previous, value) => element.props[key] = value,
    insert(element, parent) { element.parent = parent; parent.children.push(element) },
    remove(element) { if (element?.parent) element.parent.children = element.parent.children.filter(child => child !== element) }
  })
  const root = node('root'); let vm
  const render = async extra => {
    Object.assign(props, extra)
    const vnode = h(Editor, { ...props, onChange: label => changes.push(label), onNotice: message => notices.push(message) })
    renderer.render(vnode, root)
    vm = proxyRefs(vnode.component.exposed)
    await nextTick(); await nextTick()
  }
  environment.beforeRestore(() => renderer.render(null, root))
  await render()
  return { get vm() { return vm }, props, changes, notices, render, environment }
}

test('tooltip preview never treats definition examples or foreign/unowned aliases as current readings', async t => {
  const definition = { id: 'p', device_id: 'b', category: 'analog', value_role: 'temp', value: 999, quality: 'good' }
  const f = await fixture(t, { points: [definition], deviceStatusMap: { b: { quality: 'good' } } })
  assert.equal(f.vm.actualPoints[0].value, null)
  assert.equal(f.vm.actualPoints[0].quality, 'stale')
  await f.render({ pointValues: { p: { id: 'p', device_id: 'a', value: 888, quality: 'good' } } })
  assert.equal(f.vm.actualPoints[0].value, null)
  await f.render({ pointValues: { p: { id: 'p', value: 777, quality: 'good' } } })
  assert.equal(f.vm.actualPoints[0].value, null)
  await f.render({ pointValues: { p: { id: 'p', device_id: 'b', value: 0, quality: 'good' } } })
  assert.equal(f.vm.actualPoints[0].value, 0)
})

test('switching a point source clears stale identifiers and preserves only common formatting', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  f.vm.selectedIds = [widget.id]
  widget.data = { mode: 'plc', pointId: 'old', point_id: 'older', pointKey: 'analog.temp', requireConfiguredPoint: true, unit: 'K', decimals: 2, deviceId: 'fixed', datasetId: 'obsolete', path: 'analog.temp' }
  await nextTick()
  f.vm.changeSource('runtime')
  assert.equal(widget.data.path, 'hover.device.name')
  assert.equal(widget.data.pointId, undefined)
  assert.equal(widget.data.point_id, undefined)
  assert.equal(widget.data.pointKey, undefined)
  assert.equal(widget.data.requireConfiguredPoint, undefined)
  assert.equal(widget.data.datasetId, undefined)
  assert.equal(widget.data.unit, 'K')
  assert.equal(widget.data.decimals, 2)
  assert.equal(widget.data.deviceId, '')
  assert.equal(widget.content.text, '{value}{unit}')
  const boundSnapshot = JSON.stringify(widget), beforeChanges = f.changes.length
  f.vm.changeSource('static')
  assert.equal(widget.data.path, 'hover.device.name')
  assert.equal(widget.data.mode, 'runtime')
  assert.equal(JSON.stringify(widget), boundSnapshot)
  assert.equal(f.changes.length, beforeChanges)
  assert.equal(f.notices.length, 1)
})

test('group dragging clamps one shared delta and save/undo shortcuts finish pointer edits', async t => {
  const f = await fixture(t), first = f.vm.template.widgets.find(widget => widget.type === 'text')
  const second = { ...first, id: 'second', frame: { x: 80, y: 20, width: 20, height: 20 } }
  first.frame = { x: 10, y: 20, width: 20, height: 20 }
  f.vm.template.canvas.width = 180; f.vm.template.widgets = [first, second]
  f.vm.selectedIds = [first.id, second.id]
  await nextTick()
  f.vm.beginPointer({ clientX: 0, clientY: 0, button: 0, stopPropagation() {}, preventDefault() {} }, first)
  f.vm.pointerMove({ clientX: 150, clientY: 0 })
  assert.equal(second.frame.x - first.frame.x, 70)
  assert.equal(second.frame.x + second.frame.width, 180)
  const before = f.changes.length
  f.vm.keys({ target: { matches: () => false }, ctrlKey: true, key: 's' })
  assert.equal(f.changes.length, before + 1)
  f.vm.pointerMove({ clientX: 0, clientY: 0 })
  assert.equal(second.frame.x + second.frame.width, 180)
})

const pointerEvent = (extra = {}) => ({ clientX: 0, clientY: 0, button: 0, stopPropagation() {}, preventDefault() {}, ...extra })
async function selectionFixture(t) {
  const f = await fixture(t), original = f.vm.template.widgets.find(widget => widget.type === 'text')
  const widgets = [0, 1, 2].map(index => ({ ...original, id: `selection-${index}`, groupId: '', locked: false,
    frame: { x: 8 + index * 40, y: 20, width: 24, height: 20, rotation: 0 } }))
  f.vm.template.widgets = widgets
  await nextTick()
  return { f, widgets: f.vm.template.widgets }
}

test('tooltip canvas Ctrl/Meta clicks add and remove selection once without editing geometry or history', async t => {
  const { f, widgets: [first, second, third] } = await selectionFixture(t)
  const before = JSON.stringify(f.vm.template.widgets)
  const click = (widget, extra) => { f.vm.beginPointer(pointerEvent(extra), widget); f.vm.pointerEnd() }
  click(first)
  click(second, { ctrlKey: true })
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id])
  click(third, { metaKey: true })
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id, third.id])
  click(second, { ctrlKey: true })
  assert.deepEqual(f.vm.selectedIds, [first.id, third.id])
  click(first, { metaKey: true }); click(third, { ctrlKey: true })
  assert.deepEqual(f.vm.selectedIds, [])
  assert.equal(JSON.stringify(f.vm.template.widgets), before)
  assert.equal(f.changes.length, 0)
  assert.match(source, /@click="selectWidget\(widget\.id, \$event\)"/)
  const hitbox = source.match(/<div v-for="widget in template\.widgets"[^>]*>/)?.[0]
  assert.match(hitbox, /@pointerdown="beginPointer\(\$event, widget\)"/)
  assert.doesNotMatch(hitbox, /@click/)
})

test('tooltip plain click on another widget replaces selection and Shift keeps additive selection', async t => {
  const { f, widgets: [first, second, third] } = await selectionFixture(t)
  f.vm.selectWidget(first.id)
  f.vm.selectWidget(second.id, { ctrlKey: true })
  f.vm.beginPointer(pointerEvent({ shiftKey: true }), third); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id, third.id])
  // A layer click explicitly focuses its element; a drag on an already
  // selected canvas member instead retains the multi-selection.
  f.vm.selectWidget(first.id)
  assert.deepEqual(f.vm.selectedIds, [first.id])
  f.vm.selectWidget(second.id, { ctrlKey: true })
  f.vm.beginPointer(pointerEvent(), third); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [third.id])
  assert.equal(f.changes.length, 0)
})

test('tooltip Ctrl selection toggles a complete group atomically and completes partial groups', async t => {
  const { f, widgets: [first, second, third] } = await selectionFixture(t)
  first.groupId = second.groupId = 'paired'
  f.vm.selectWidget(third.id)
  f.vm.selectWidget(second.id, { ctrlKey: true })
  assert.deepEqual(new Set(f.vm.selectedIds), new Set([third.id, first.id, second.id]))
  f.vm.beginPointer(pointerEvent({ ctrlKey: true }), first); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [third.id])
  f.vm.selectedIds = [third.id, first.id]
  f.vm.selectWidget(first.id, { metaKey: true })
  assert.deepEqual(new Set(f.vm.selectedIds), new Set([third.id, first.id, second.id]))
  f.vm.selectWidget(first.id, { metaKey: true })
  assert.deepEqual(f.vm.selectedIds, [third.id])
})

test('tooltip dragging an already selected member moves unlocked selections together and commits once', async t => {
  const { f, widgets: [first, second, third] } = await selectionFixture(t)
  third.locked = true
  f.vm.selectWidget(first.id); f.vm.selectWidget(second.id, { ctrlKey: true }); f.vm.selectWidget(third.id, { ctrlKey: true })
  const before = [first, second, third].map(widget => ({ ...widget.frame }))
  f.vm.beginPointer(pointerEvent(), second)
  f.vm.pointerMove({ clientX: 24, clientY: 12 })
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id, third.id])
  for (const [index, widget] of [first, second].entries()) {
    assert.equal(widget.frame.x - before[index].x, 16)
    assert.equal(widget.frame.y - before[index].y, 8)
  }
  assert.deepEqual(third.frame, before[2])
  assert.equal(f.changes.length, 0)
  f.vm.pointerEnd(); f.vm.pointerEnd()
  assert.deepEqual(f.changes, ['拖动悬停组件'])
})

test('tooltip Ctrl deselection and locked anchors cannot accidentally drag the remaining selection', async t => {
  const { f, widgets: [first, second, third] } = await selectionFixture(t)
  f.vm.selectedIds = [first.id, second.id]
  const before = JSON.stringify(f.vm.template.widgets)
  f.vm.beginPointer(pointerEvent({ ctrlKey: true }), second)
  f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [first.id])
  third.locked = true
  f.vm.beginPointer(pointerEvent({ ctrlKey: true }), third)
  f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [first.id, third.id])
  third.locked = false
  assert.equal(JSON.stringify(f.vm.template.widgets), before)
  f.vm.beginPointer(pointerEvent({ ctrlKey: true }), third); f.vm.pointerEnd()
  f.vm.beginPointer(pointerEvent({ ctrlKey: true }), first)
  f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [])
  assert.equal(JSON.stringify(f.vm.template.widgets), before)
  assert.equal(f.changes.length, 0)
})

test('tooltip resize handles do not Ctrl-toggle and secondary clicks do not change selection', async t => {
  const { f, widgets: [first, second] } = await selectionFixture(t)
  f.vm.selectedIds = [first.id, second.id]
  f.vm.beginPointer(pointerEvent({ button: 2, ctrlKey: true }), first)
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id])
  f.vm.beginPointer(pointerEvent({ ctrlKey: true }), first, true)
  f.vm.pointerMove({ clientX: 24, clientY: 12 }); f.vm.pointerEnd()
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id])
  assert.equal(first.frame.width, 40); assert.equal(first.frame.height, 28)
  assert.equal(second.frame.width, 24); assert.equal(second.frame.height, 20)
})

test('readonly permissions block source/geometry/pointer mutations and canvas bounds match saved schema', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  f.vm.selectedIds = [widget.id]; await nextTick()
  const old = JSON.stringify(widget)
  await f.render({ readonly: true })
  f.vm.changeSource('plc'); f.vm.choosePoint('p'); f.vm.geometryChanged()
  f.vm.beginPointer({ clientX: 0, clientY: 0, button: 0, stopPropagation() {}, preventDefault() {} }, widget)
  f.vm.pointerMove({ clientX: 100, clientY: 100 })
  assert.equal(JSON.stringify(widget), old)
  assert.equal(f.changes.length, 0)
  await f.render({ readonly: false })
  f.vm.template.canvas.width = 1000; f.vm.template.canvas.height = 1200; f.vm.geometryChanged()
  assert.equal(f.vm.template.canvas.width, 960); assert.equal(f.vm.template.canvas.height, 1080)
})

test('template width and height inputs resize the background without moving or scaling foreground fields', async t => {
  const f = await fixture(t), foreground = f.vm.template.widgets.filter(widget => widget.id !== f.vm.template.backgroundWidgetId)
  const before = JSON.stringify(foreground)
  f.vm.template.canvas.width = 360; f.vm.template.canvas.height = 312
  f.vm.templateGeometryChanged()
  assert.deepEqual(f.vm.backgroundWidget.frame, { x: 0, y: 0, width: 360, height: 312, rotation: 0 })
  assert.equal(JSON.stringify(foreground), before)
  // Shrinking is also a canvas operation, not an automatic rearrangement.
  f.vm.template.canvas.height = 120
  f.vm.templateGeometryChanged()
  assert.equal(f.vm.backgroundWidget.frame.height, 120)
  assert.equal(JSON.stringify(foreground), before)
})

test('dragging a full background corner grows beyond the old canvas and commits both sizes once', async t => {
  const f = await fixture(t), background = f.vm.backgroundWidget
  const before = { ...f.vm.template.canvas }, foreground = JSON.stringify(f.vm.template.widgets.filter(widget => widget !== background))
  const event = { clientX: 0, clientY: 0, button: 0, stopPropagation() {}, preventDefault() {} }
  f.vm.beginPointer(event, background, true)
  f.vm.pointerMove({ clientX: 60, clientY: 90 })
  assert.equal(f.vm.template.canvas.width, before.width + 40)
  assert.equal(f.vm.template.canvas.height, before.height + 60)
  assert.equal(background.frame.width, f.vm.template.canvas.width)
  assert.equal(background.frame.height, f.vm.template.canvas.height)
  assert.equal(JSON.stringify(f.vm.template.widgets.filter(widget => widget !== background)), foreground)
  assert.equal(f.changes.length, 0)
  f.vm.pointerEnd()
  assert.equal(f.changes.length, 1)
  assert.equal(f.changes[0], '调整悬停模板尺寸')
})

test('canvas bottom handle changes height only, clamps globally and supports keyboard increments', async t => {
  const f = await fixture(t), before = { ...f.vm.template.canvas }
  const event = { clientX: 0, clientY: 0, button: 0, stopPropagation() {}, preventDefault() {} }
  f.vm.beginCanvasResize(event, 'height')
  f.vm.pointerMove({ clientX: 9000, clientY: 90 }); f.vm.pointerEnd()
  assert.equal(f.vm.template.canvas.width, before.width)
  assert.equal(f.vm.template.canvas.height, before.height + 60)
  assert.equal(f.vm.backgroundWidget.frame.height, before.height + 60)
  f.vm.beginCanvasResize(event, 'height'); f.vm.pointerMove({ clientX: 0, clientY: 9000 }); f.vm.pointerEnd()
  assert.equal(f.vm.template.canvas.height, 1080)
  f.vm.beginCanvasResize(event, 'height'); f.vm.pointerMove({ clientX: 0, clientY: -9000 }); f.vm.pointerEnd()
  assert.equal(f.vm.template.canvas.height, 80)
  f.vm.canvasResizeKey({ key: 'ArrowDown', stopPropagation() {}, preventDefault() {} })
  assert.equal(f.vm.template.canvas.height, 84)
  assert.equal(f.vm.backgroundWidget.frame.height, 84)
  assert.match(source, /aria-label="调整悬停模板高度"/)
})

test('ordinary container resize and background move/locked resize do not resize the template', async t => {
  const f = await fixture(t), background = f.vm.backgroundWidget, before = JSON.stringify(f.vm.template.canvas)
  const area = { ...JSON.parse(JSON.stringify(background)), id: 'ordinary_area', title: '独立区域', frame: { x: 20, y: 20, width: 40, height: 30, rotation: 0 }, zIndex: 100 }
  f.vm.template.widgets.push(area)
  const event = { clientX: 0, clientY: 0, button: 0, stopPropagation() {}, preventDefault() {} }
  f.vm.beginPointer(event, area, true); f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  assert.equal(area.frame.height, 70)
  assert.equal(JSON.stringify(f.vm.template.canvas), before)
  const changes = f.changes.length
  f.vm.beginPointer(event, background); f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  assert.equal(background.frame.x, 0); assert.equal(background.frame.y, 0)
  assert.equal(f.changes.length, changes)
  background.locked = true
  f.vm.beginPointer(event, background, true); f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  assert.equal(JSON.stringify(f.vm.template.canvas), before)
  assert.equal(f.changes.length, changes)
  await f.render({ readonly: true })
  f.vm.beginCanvasResize(event); f.vm.pointerMove({ clientX: 60, clientY: 60 }); f.vm.pointerEnd()
  f.vm.canvasResizeKey({ key: 'ArrowDown', stopPropagation() {}, preventDefault() {} })
  f.vm.templateGeometryChanged()
  assert.equal(JSON.stringify(f.vm.template.canvas), before)
  assert.equal(f.changes.length, changes)
})

test('copying templates remaps their background but copying/deleting an element does not promote a replacement', async t => {
  const f = await fixture(t), originalId = f.vm.template.backgroundWidgetId
  f.vm.newTemplate(true); await nextTick(); await nextTick()
  assert.notEqual(f.vm.template.backgroundWidgetId, originalId)
  assert.equal(f.vm.backgroundWidget.id, f.vm.template.backgroundWidgetId)
  const background = f.vm.backgroundWidget, marker = background.id
  f.vm.selectedIds = [marker]; await nextTick()
  f.vm.copySelected(); await nextTick()
  assert.equal(f.vm.template.backgroundWidgetId, marker)
  f.vm.deleteWidget(background); await nextTick()
  assert.equal(f.vm.template.backgroundWidgetId, '')
  assert.equal(f.vm.backgroundWidget, null)
})

test('numeric labels are authored separately from text format, and all mutations share parent history', () => {
  assert.match(source, /v-model="selected\.content\.text"/)
  assert.match(source, /@change="changeBoundText\(\$event\)"/)
  assert.match(source, /v-model="selected\.content\.label" aria-label="悬停数值标签"/)
  assert.match(source, /emit\('change', label\)/)
  assert.doesNotMatch(source, /tooltip-element-hitbox\.selected\{[^}]*z-index/)
})

test('object fields and live data have no static source option and cannot be frozen as custom text', async t => {
  const f = await fixture(t), [widget, sibling] = f.vm.template.widgets.filter(widget => widget.type === 'text')
  f.vm.selectedIds = [widget.id, sibling.id]
  const wording = '当前部件的完整说明。\n第二行 · 0 rpm'
  f.vm.previewSurfaceRef = { getRenderedText: id => id === widget.id ? wording : '其他元素' }
  const bindings = [
    ...['hover.device.status', 'hover.device.name', 'hover.device.id', 'hover.device.modelName', 'hover.device.workshopName', 'hover.device.lineName',
      'hover.part.description', 'hover.part.group', 'hover.part.hint'].map(path => ({ mode: 'runtime', path, readOnly: true })),
    { mode: 'plc', pointKey: 'analog.temp', requireConfiguredPoint: true, unit: '°C', readOnly: true },
    { mode: 'dataset', datasetId: 'power', datasetField: 'reading', readOnly: true }
  ]
  for (const binding of bindings) {
    widget.data = binding
    widget.content = { ...widget.content, text: '{value}', lines: ['{value}'], datasetTextMode: 'template', valueMap: [{ value: 1, text: '运行' }] }
    await nextTick()
    const before = JSON.stringify(widget), otherBefore = JSON.stringify(sibling), beforeChanges = f.changes.length, beforeNotices = f.notices.length
    assert.equal(f.vm.selectedTextPreview, wording)
    assert.equal(f.vm.bindingSources.some(item => item.id === 'static'), false, binding.path || binding.mode)
    f.vm.changeSource('static')
    assert.equal(JSON.stringify(widget), before, binding.path || binding.mode)
    assert.equal(JSON.stringify(sibling), otherBefore)
    assert.deepEqual(f.vm.selectedIds, [widget.id, sibling.id])
    assert.equal(f.changes.length, beforeChanges)
    assert.equal(f.notices.length, beforeNotices + 1)
  }
  assert.doesNotMatch(source, /改为自定义文字|tooltip-custom-text-button/)
  assert.match(source, /aria-label="悬停文字当前显示"[^>]*readonly/)
})

test('genuine fixed copy stays directly editable and can still be deliberately bound to a source', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  f.vm.selectedIds = [widget.id]
  f.vm.previewSurfaceRef = { getRenderedText: () => '不应替换原文' }
  widget.content.text = '保留原文\n原有换行'
  await nextTick()
  assert.equal(f.vm.bindingSources.some(item => item.id === 'static'), true)
  f.vm.changeSource('static')
  assert.equal(widget.content.text, '保留原文\n原有换行')
  widget.content.text = '用户直接修改的固定标题'
  assert.equal(widget.data.mode, 'static')
  assert.equal(widget.content.text, '用户直接修改的固定标题')
  f.vm.changeSource('runtime')
  assert.equal(widget.data.mode, 'runtime')
  assert.equal(widget.content.text, '{value}{unit}')
  assert.equal(widget.data.path, 'hover.device.name')
})

test('missing preview data does not allow a dynamic field to become fixed copy', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  widget.data = { mode: 'runtime', path: 'hover.device.name', readOnly: true }
  widget.content.text = '{value}'
  f.vm.selectedIds = [widget.id]
  await nextTick()
  assert.equal(f.vm.selectedTextPreview, undefined)
  const before = JSON.stringify(widget)
  f.vm.changeSource('static')
  assert.equal(JSON.stringify(widget), before)
  assert.equal(widget.content.text, '{value}')
  assert.equal(f.changes.length, 0)
})

test('point data format rejects literal replacement but keeps multiline prefixes and the live value token', async t => {
  const f = await fixture(t), [widget, sibling] = f.vm.template.widgets.filter(widget => widget.type === 'text')
  widget.data = { mode: 'runtime', path: 'hover.device.pointMap.analog.temp.value', readOnly: true }
  widget.content = { ...widget.content, text: '旧格式', lines: ['说明：{value}', '批次 {parameters.batch}'] }
  f.vm.selectedIds = [widget.id, sibling.id]
  await nextTick()
  const oldFormat = '说明：{value}\n批次 {parameters.batch}', before = JSON.stringify(widget), siblingBefore = JSON.stringify(sibling)
  assert.equal(f.vm.selectedTextFormat, oldFormat)
  for (const value of ['强行写死的数据正常', '', '{unit}', '{parameters.batch}']) {
    const event = { target: { value } }, beforeNotices = f.notices.length
    f.vm.changeBoundText(event)
    assert.equal(event.target.value, oldFormat)
    assert.equal(JSON.stringify(widget), before)
    assert.equal(f.changes.length, 0)
    assert.equal(f.notices.length, beforeNotices + 1)
  }
  const validFormat = '部件资料：{value}\n单位 {unit} · 批次 {parameters.batch}'
  f.vm.changeBoundText({ target: { value: validFormat } })
  assert.equal(widget.content.text, validFormat)
  assert.equal(widget.content.lines, undefined)
  assert.equal(widget.data.mode, 'runtime')
  assert.equal(widget.data.path, 'hover.device.pointMap.analog.temp.value')
  assert.equal(JSON.stringify(sibling), siblingBefore)
  assert.deepEqual(f.vm.selectedIds, [widget.id, sibling.id])
  assert.equal(f.changes.length, 1)
})

test('legacy frozen status is repaired before inspector classification without changing captions or geometry', async t => {
  const legacy = createTooltipTemplate('device')
  const status = legacy.widgets.find(widget => widget.id.endsWith('_status_value'))
  const label = legacy.widgets.find(widget => widget.id.endsWith('_status_label'))
  delete status.dynamicBinding
  status.data = { mode: 'static', readOnly: true }
  status.content.text = '数据正常'
  status.content.lines = ['永远正常']
  status.content.valueMap = [{ value: '数据异常 / 未连接', text: '数据正常' }]
  status.frame = { ...status.frame, width: 150, height: 28 }
  status.style.fontSize = 17
  label.content.text = '自定义数据状态标题'
  const document = reactive({ tooltipTemplates: { defaults: { device: legacy.id }, templates: [legacy] } })
  const f = await fixture(t, { document })
  const repaired = f.vm.template.widgets.find(widget => widget.id === status.id)
  f.vm.selectedIds = [status.id]; await nextTick()
  assert.equal(f.vm.selectedMode, 'runtime')
  assert.equal(f.vm.selectedLinkedMetadata, true)
  assert.equal(repaired.data.path, 'hover.device.status')
  assert.equal(repaired.content.text, '{value}')
  assert.equal(repaired.content.lines, undefined)
  assert.equal(repaired.content.valueMap, undefined)
  assert.equal(repaired.frame.width, 150)
  assert.equal(repaired.style.fontSize, 17)
  assert.equal(f.vm.template.widgets.find(widget => widget.id === label.id).content.text, '自定义数据状态标题')
  assert.equal(f.vm.bindingSources.some(item => item.id === 'static'), false)
  assert.equal(f.changes.length, 0)
})

test('status and association metadata cannot change display text or source even through inspector handlers', async t => {
  const f = await fixture(t)
  for (const key of ['status_value', 'workshop_value', 'line_value', 'name']) {
    const widget = f.vm.template.widgets.find(widget => widget.id.endsWith(`_${key}`))
    f.vm.selectedIds = [widget.id]; await nextTick()
    assert.equal(f.vm.selectedLinkedMetadata, true)
    const before = JSON.stringify(widget), changes = f.changes.length
    for (const format of ['强行固定', '前缀 {value}', '{value}']) {
      const event = { target: { value: format } }
      f.vm.changeBoundText(event)
      assert.equal(event.target.value, '{value}')
      assert.equal(JSON.stringify(widget), before)
    }
    f.vm.changeSource('static'); f.vm.changeSource('dataset')
    assert.equal(JSON.stringify(widget), before)
    assert.equal(f.changes.length, changes)
  }
})

test('copied dynamic layers retain provenance and cannot be frozen after losing their original id', async t => {
  const f = await fixture(t), source = f.vm.template.widgets.find(widget => widget.id.endsWith('_status_value'))
  f.vm.selectedIds = [source.id]; await nextTick()
  f.vm.copySelected()
  const copy = f.vm.template.widgets.find(widget => widget.id === f.vm.selectedIds[0])
  assert.ok(copy.id.includes('_copy_'))
  assert.equal(copy.dynamicBinding.path, 'hover.device.status')
  copy.title = '我的新图层名称'
  copy.data = { mode: 'static', readOnly: true }
  copy.content.text = '一直正常'
  await nextTick()
  assert.equal(copy.data.mode, 'runtime')
  assert.equal(copy.data.path, 'hover.device.status')
  assert.equal(copy.content.text, '{value}')
  assert.equal(f.vm.selectedLinkedMetadata, true)
  assert.equal(f.vm.selectedSystemMetadata, true)
})

test('new generic text can choose a real dynamic source without unlocking its current data value', async t => {
  const f = await fixture(t)
  f.vm.addWidget('text'); await nextTick()
  const widget = f.vm.template.widgets.find(widget => widget.id === f.vm.selectedIds[0])
  assert.equal(f.vm.selectedMode, 'static')
  f.vm.changeSource('runtime'); await nextTick()
  assert.equal(f.vm.selectedLinkedMetadata, true)
  assert.equal(f.vm.selectedSystemMetadata, false)
  widget.data.path = 'hover.device.workshopName'; await nextTick()
  assert.equal(widget.data.path, 'hover.device.workshopName')
  const before = JSON.stringify(widget)
  f.vm.changeBoundText({ target: { value: '自定义车间 {value}' } })
  f.vm.changeSource('static')
  assert.equal(JSON.stringify(widget), before)
  f.vm.changeSource('dataset')
  assert.equal(widget.data.mode, 'dataset', 'choosing another real source is still supported for generic data elements')
})

test('readonly blocks dynamic format/source changes without touching selection or history', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  widget.data = { mode: 'runtime', path: 'hover.device.status', readOnly: true }
  widget.content.text = '{value}'
  f.vm.selectedIds = [widget.id]
  await f.render({ readonly: true })
  const before = JSON.stringify(widget), beforeNotices = f.notices.length
  f.vm.changeBoundText({ target: { value: '状态：{value}' } })
  f.vm.changeSource('static')
  f.vm.changeSource('plc')
  assert.equal(JSON.stringify(widget), before)
  assert.equal(f.changes.length, 0)
  assert.equal(f.notices.length, beforeNotices)
  assert.deepEqual(f.vm.selectedIds, [widget.id])
})

test('undo-style document replacements retain the selected text, while changing template clears it', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  f.vm.selectedIds = [widget.id]
  await nextTick()
  const restored = JSON.parse(JSON.stringify(f.props.document))
  restored.tooltipTemplates.templates[0].widgets.find(item => item.id === widget.id).content.text = '撤销恢复的文案'
  await f.render({ document: restored })
  assert.deepEqual(f.vm.selectedIds, [widget.id])
  const copy = createTooltipTemplate('device', 'tooltip_other')
  const switched = JSON.parse(JSON.stringify(restored))
  switched.tooltipTemplates.templates.push(copy)
  await f.render({ document: switched })
  f.vm.templateId = copy.id
  await nextTick(); await nextTick()
  assert.deepEqual(f.vm.selectedIds, [])
})

test('dataset preview context and results remain stable across live frames but clear on target/parameter changes', async t => {
  const f = await fixture(t, { devices: [{ id: 'b', name: 'B' }, { id: 'c', name: 'C' }], parameters: { batch: 'one' },
    points: [{ id: 'p', device_id: 'b', category: 'analog', value_role: 'temp' }],
    pointValues: { p: { id: 'p', device_id: 'b', value: 10, quality: 'good' } }, deviceDataMap: { b: { analog: { temp: 10 } } } })
  const firstContext = f.vm.dataPreviewContext
  f.vm.previewValues.value = { value: 123, rows: [], quality: 'good' }
  await f.render({ deviceDataMap: { b: { analog: { temp: 20 } } }, deviceStatusMap: { b: { quality: 'good', lastSeen: 'new' } },
    pointValues: { p: { id: 'p', device_id: 'b', value: 20, quality: 'good' } }, playbackNow: 2000 })
  assert.equal(f.vm.dataPreviewContext, firstContext)
  assert.equal(f.vm.previewValues.value?.value, 123)
  assert.equal('hover' in f.vm.dataPreviewContext, false)
  f.vm.previewDeviceId = 'c'; await nextTick(); await nextTick()
  assert.equal(f.vm.dataPreviewContext.deviceId, 'c')
  assert.equal(f.vm.previewValues.value, undefined)
  f.vm.previewValues.value = { value: 456, rows: [], quality: 'good' }
  await f.render({ parameters: { batch: 'two' } })
  assert.equal(f.vm.previewValues.value, undefined)
  assert.equal(f.vm.dataPreviewContext.parameters.batch, 'two')
  await f.render({ document: { ...f.props.document, tooltipTemplates: { ...f.props.document.tooltipTemplates,
    templates: [...f.props.document.tooltipTemplates.templates, createTooltipTemplate('part')] } },
    views: [...f.props.views, { id: 'part_view', name: '部件', mode: 'device', metadata: {} }] })
  f.vm.kind = 'part'; await nextTick(); await nextTick()
  f.vm.previewPartId = 'part_a'; await nextTick(); await nextTick()
  f.vm.previewValues.value = { value: 789, rows: [], quality: 'good' }
  f.vm.previewPartId = 'part_b'; await nextTick(); await nextTick()
  assert.equal(f.vm.dataPreviewContext.partId, 'part_b')
  assert.equal(f.vm.previewValues.value, undefined)
})

test('switching text to a dataset uses authored template mode and retains per-field format', async t => {
  const f = await fixture(t), widget = f.vm.template.widgets.find(widget => widget.type === 'text')
  f.vm.selectedIds = [widget.id]; await nextTick()
  f.vm.changeSource('dataset')
  assert.equal(widget.content.datasetTextMode, 'template')
  assert.equal(widget.content.text, '{value}{unit}')
  assert.equal(widget.data.deviceScope, 'current')
})

test('canvas lock/delete icons affect only the clicked element and commit parent history once', async t => {
  const f = await fixture(t), [first, second] = f.vm.template.widgets.filter(widget => widget.type === 'text')
  first.locked = false; second.locked = false
  f.vm.selectedIds = [first.id, second.id]; await nextTick()
  f.vm.toggleWidgetLock(first)
  assert.equal(first.locked, true)
  assert.equal(second.locked, false)
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id])
  assert.equal(f.changes.length, 1)
  assert.match(f.changes[0], /锁定/)
  const before = f.vm.template.widgets.length
  f.vm.deleteWidget(first)
  assert.equal(f.vm.template.widgets.length, before)
  assert.equal(f.changes.length, 1)
  f.vm.toggleWidgetLock(first)
  assert.equal(first.locked, false)
  assert.equal(f.changes.length, 2)
  f.vm.deleteWidget(first)
  assert.equal(f.vm.template.widgets.length, before - 1)
  assert.equal(f.vm.template.widgets.some(widget => widget.id === first.id), false)
  assert.equal(f.vm.template.widgets.some(widget => widget.id === second.id), true)
  assert.deepEqual(f.vm.selectedIds, [second.id])
  assert.equal(f.changes.length, 3)
  assert.match(f.changes.at(-1), /删除/)
})

test('canvas element icon actions obey readonly permissions without changing selection or history', async t => {
  const f = await fixture(t), [first, second] = f.vm.template.widgets.filter(widget => widget.type === 'text')
  first.locked = false; second.locked = true
  f.vm.selectedIds = [first.id, second.id]; await nextTick()
  const before = JSON.stringify(f.vm.template)
  await f.render({ readonly: true })
  f.vm.toggleWidgetLock(first); f.vm.toggleWidgetLock(second)
  f.vm.deleteWidget(first); f.vm.deleteWidget(second)
  assert.equal(JSON.stringify(f.vm.template), before)
  assert.deepEqual(f.vm.selectedIds, [first.id, second.id])
  assert.equal(f.changes.length, 0)
})

test('canvas selection decorations appear above the tooltip without blocking unrelated element hitboxes', async () => {
  const styles = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), id: 'tooltip-editor-hitlayers' })
  assert.deepEqual(styles.errors, [])
  const css = selector => {
    const result = {}
    styles.rawResult.root.walkRules(rule => {
      if (rule.selector.split(',').map(value => value.trim()).includes(selector)) rule.walkDecls(declaration => result[declaration.prop] = declaration.value)
    })
    assert.ok(Object.keys(result).length, `Missing CSS selector: ${selector}`)
    return result
  }
  const interaction = css('.tooltip-interaction-layer'), selection = css('.tooltip-selection-layer')
  const surfaceSource = await readFile(new URL('../src/runtime/TooltipSurface.vue', import.meta.url), 'utf8')
  const surfaceZ = Number(surfaceSource.match(/\.tooltip-surface\{[^}]*z-index:(\d+)/)?.[1])
  assert.ok(Number(interaction['z-index']) > surfaceZ)
  assert.ok(Number(selection['z-index']) > Number(interaction['z-index']))
  assert.equal(interaction['pointer-events'], 'none')
  assert.equal(selection['pointer-events'], 'none')
  assert.equal(css('.tooltip-interaction-layer .tooltip-element-hitbox')['pointer-events'], 'auto')
  assert.equal(css('.tooltip-selection-frame')['pointer-events'], 'none')
  assert.equal(css('.tooltip-element-actions')['pointer-events'], 'auto')
  assert.equal(css('.tooltip-selection-frame .tooltip-resize-handle')['pointer-events'], 'auto')
  assert.equal(css('.tooltip-interaction-layer .tooltip-element-hitbox.selected')['outline'], 'none')
  assert.match(source, /v-for="widget in selectedWidgets"[^>]*class="tooltip-selection-frame"/)
  assert.match(source, /:data-tooltip-selection-id="widget.id"/)
  assert.doesNotMatch(source, /tooltip-element-hitbox\.selected\{[^}]*z-index/)
})

test('lock/delete are per-element accessible icon controls, not top toolbar text actions', () => {
  const toolbar = source.slice(source.indexOf('<div class="tooltip-local-toolbar"'), source.indexOf('<div class="tooltip-canvas-viewport"'))
  assert.doesNotMatch(toolbar, /锁定\s*\/\s*解锁|删除元素|@click="lock"|@click="deleteSelected"/)
  assert.match(source, /class="tooltip-element-actions" @pointerdown\.stop @click\.stop/)
  assert.match(source, /class="tooltip-element-lock"[^>]*:disabled="readonly"[^>]*:aria-label=/)
  assert.match(source, /@click="toggleWidgetLock\(widget\)"/)
  assert.match(source, /class="tooltip-element-delete"[^>]*:disabled="readonly \|\| widget.locked"[^>]*:aria-label=/)
  assert.match(source, /@click="deleteWidget\(widget\)"/)
})

const catalogTemperature = { id: 'temp-real', label: '炉内温度', unit: '℃', objectScope: 'device', sourceType: 'plc',
  tooltipBinding: { mode: 'plc', pointKey: 'analog.temperature', deviceScope: 'current', requireConfiguredPoint: true } }
test('quick row uses an editable caption plus a live semantic point, and commits exactly one undo step', async t => {
  const f = await fixture(t), before = JSON.stringify(f.vm.template), count = f.vm.template.widgets.length
  const height = f.vm.template.canvas.height
  f.vm.addingDataRow = true
  f.vm.chooseRowData(catalogTemperature)
  assert.equal(f.vm.dataRowLabel, '炉内温度')
  f.vm.dataRowLabel = '自定义温度标题'
  f.vm.confirmDataRow(); await nextTick()
  assert.deepEqual(f.changes, ['添加悬停数据行'])
  assert.equal(f.vm.template.widgets.length, count + 3)
  assert.equal(f.vm.template.canvas.height, height + 34)
  const [leftId, rightId] = f.vm.selectedIds
  const left = f.vm.template.widgets.find(widget => widget.id === leftId), right = f.vm.template.widgets.find(widget => widget.id === rightId)
  assert.equal(left.data.mode, 'static'); assert.equal(left.content.text, '自定义温度标题')
  assert.equal(right.data.mode, 'plc'); assert.equal(right.data.pointKey, 'analog.temperature'); assert.equal(right.data.unit, '')
  assert.equal(right.data.unitPath, 'hover.device.pointMap.analog.temperature.unit')
  assert.equal(right.data.deviceId, ''); assert.equal(right.data.pointId, '')
  assert.equal(f.vm.addingDataRow, false)
  const document = reactive(JSON.parse(JSON.stringify(f.props.document)))
  document.tooltipTemplates.templates[0] = JSON.parse(before)
  await f.render({ document })
  assert.equal(f.vm.template.widgets.length, count, 'parent undo can restore the original template in one step')
  assert.equal(f.vm.template.canvas.height, height)
})

test('catalog selection replaces generic sources without allowing protected system metadata to change', async t => {
  const f = await fixture(t)
  const system = f.vm.template.widgets.find(widget => widget.data.path === 'hover.device.status')
  f.vm.selectedIds = [system.id]
  const before = JSON.stringify(system)
  f.vm.chooseCatalogData(catalogTemperature)
  assert.equal(JSON.stringify(system), before)
  assert.equal(f.changes.length, 0)
  f.vm.addWidget('text')
  const generic = f.vm.template.widgets.find(widget => widget.id === f.vm.selectedIds[0])
  f.vm.chooseCatalogData(catalogTemperature); await nextTick()
  assert.equal(generic.data.mode, 'plc')
  assert.equal(generic.content.text, '{value}{unit}')
  assert.equal(generic.data.unit, '')
  assert.equal(generic.data.unitPath, 'hover.device.pointMap.analog.temperature.unit')
  assert.equal(generic.data.deviceId, '')
  const afterBinding = JSON.stringify(generic), count = f.changes.length
  f.vm.changeSource('static')
  assert.equal(JSON.stringify(generic), afterBinding)
  assert.equal(f.changes.length, count)
})

test('readonly or over-height quick row never changes the template or creates no-op undo history', async t => {
  const f = await fixture(t, { readonly: true })
  const before = JSON.stringify(f.vm.template)
  f.vm.chooseRowData(catalogTemperature); f.vm.confirmDataRow()
  assert.equal(JSON.stringify(f.vm.template), before); assert.equal(f.changes.length, 0)
  await f.render({ readonly: false })
  f.vm.template.canvas.height = 1080
  const full = JSON.stringify(f.vm.template)
  f.vm.confirmDataRow()
  assert.equal(JSON.stringify(f.vm.template), full); assert.equal(f.changes.length, 0)
  assert.match(f.notices.at(-1), /1080/)
})

test('copied quick-row templates preserve independent row groups instead of combining all rows', async t => {
  const f = await fixture(t)
  f.vm.chooseRowData(catalogTemperature); f.vm.confirmDataRow(); await nextTick()
  await new Promise(resolve => setTimeout(resolve, 2))
  f.vm.chooseRowData(catalogTemperature); f.vm.confirmDataRow(); await nextTick()
  const groups = new Set(f.vm.template.widgets.map(widget => widget.groupId).filter(Boolean))
  assert.equal(groups.size, 2)
  f.vm.newTemplate(true); await nextTick()
  const copied = new Set(f.vm.template.widgets.map(widget => widget.groupId).filter(Boolean))
  assert.equal(copied.size, 2)
  assert.ok([...copied].every(id => !groups.has(id)))
  for (const id of copied) assert.equal(f.vm.template.widgets.filter(widget => widget.groupId === id).length, 3)
})

test('quick-row selection clears when the preview object changes, so it cannot reuse a stale item', async t => {
  const f = await fixture(t, { devices: [{ id: 'b' }, { id: 'c' }] })
  f.vm.chooseRowData(catalogTemperature)
  assert.equal(f.vm.dataRowItem.id, 'temp-real')
  f.vm.previewDeviceId = 'c'; await nextTick()
  assert.equal(f.vm.dataRowItem, null)
  const before = JSON.stringify(f.vm.template)
  f.vm.confirmDataRow()
  assert.equal(JSON.stringify(f.vm.template), before)
  assert.equal(f.changes.length, 0)
  f.vm.chooseRowData(catalogTemperature); f.vm.chooseRowData(null)
  assert.equal(f.vm.dataRowItem, null)
})

test('prepared data-table previews load automatically, keep target identity and reject a late previous device', async t => {
  const f = await fixture(t, { devices: [{ id: 'b', name: '设备 B' }, { id: 'c', name: '设备 C' }] })
  const B = deferred(), C = deferred(), calls = []
  f.environment.replace('__tooltipDataPreview', input => { calls.push(input); return input.context.deviceId === 'b' ? B.promise : C.promise })
  f.vm.addWidget('text')
  const id = f.vm.selectedIds[0]
  f.vm.chooseCatalogData({ id: 'table-field', label: '实际产量', objectScope: 'device', unit: '件', tooltipBinding: { mode: 'dataset', datasetId: 'prepared', datasetField: 'quantity', deviceScope: 'current' } })
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].context.deviceId, 'b')
  f.vm.previewDeviceId = 'c'; await settle()
  assert.equal(calls.length, 2)
  C.resolve({ result: { value: 0, rows: [{ quantity: 0 }], quality: 'good' } }); await settle()
  assert.equal(f.vm.previewValues[id].value, 0)
  assert.equal(f.vm.previewValues[id].deviceId, 'c')
  B.resolve({ result: { value: 999, rows: [], quality: 'good' } }); await settle()
  assert.equal(f.vm.previewValues[id].value, 0)
  await f.render({ deviceDataMap: { c: { analog: { temperature: 888 } } } })
  assert.equal(calls.length, 2, 'live frame updates must not restart prepared-table previews')
})

test('factory-table previews retain the global scope and clear device/part filters automatically', async t => {
  const f = await fixture(t), calls = []
  f.environment.replace('__tooltipDataPreview', async input => { calls.push(input); return { result: { value: 50, rows: [], quality: 'good' } } })
  f.vm.addWidget('text')
  const id = f.vm.selectedIds[0]
  f.vm.chooseCatalogData({ id: 'global-field', label: '工厂实际产量', objectScope: 'factory', tooltipBinding: { mode: 'dataset', datasetId: 'global', datasetField: 'quantity', deviceScope: 'global' } })
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binding.deviceScope, 'global')
  for (const field of ['deviceId', 'partId', 'workshopId', 'lineId']) assert.equal(calls[0].context[field], '')
  assert.equal(f.vm.previewValues[id].deviceId, '')
  assert.equal(f.vm.previewValues[id].value, 50)
})
