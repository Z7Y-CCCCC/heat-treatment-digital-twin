import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, proxyRefs, reactive } from 'vue'
import { parse, compileScript, compileStyle } from 'vue/compiler-sfc'
import { createTooltipTemplate } from '../../shared/tooltipTemplates.mjs'
import { installBrowser } from './helpers.mjs'

const url = new URL('../src/views/admin/components/TooltipTemplateEditor.vue', import.meta.url)
const source = await readFile(url, 'utf8')
const testSource = source
  .replace(/import \{ adminApi \} from [^\n]+/, `const adminApi = { getDeviceInspection: async () => ({ inspection: { parts: [] } }) }`)
  .replace('</script>', '\ndefineExpose({ diagnosticTarget, diagnosticWidget, diagnosticStyle, diagnosticViewportRef, diagnosticFrameRef, focusDiagnostic, clearDiagnosticFocus, kind, templateId, template, selectedIds, inspectorTab, selectWidget, chooseTemplate, zoom })\n</script>')
const { descriptor } = parse(testSource)
const compiled = compileScript(descriptor, { id: 'tooltip-diagnostic-test' }).content
  .replace(/from (['"])(vue)\1/g, (_, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
  .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, _quote, name) => `from ${JSON.stringify(new URL(name, url).href)}`)
  .replace(/from (["'])([^"']+\.vue)\1/g, `from 'data:text/javascript,export default {}'`)
const { default: Editor } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Editor.render = () => null
const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
const tick = async () => { for (let index = 0; index < 4; index++) await nextTick() }
const copy = value => JSON.parse(JSON.stringify(value))

async function fixture(t, extra = {}) {
  const environment = installBrowser(t), changes = [], notices = [], scrolls = [], ancestorScrolls = []
  const device = createTooltipTemplate('device', 'device-diagnostic')
  const part = createTooltipTemplate('part', 'part-diagnostic')
  const duplicate = part.widgets.find(widget => widget.type === 'text')
  duplicate.id = 'same-nested-id'
  duplicate.frame = { x: 19, y: 702, width: 125, height: 29, rotation: 17 }
  duplicate.locked = true; duplicate.visible = false
  const other = part.widgets.find(widget => widget.type === 'text' && widget !== duplicate)
  other.id = 'other-part-widget'
  const deviceText = device.widgets.find(widget => widget.type === 'text')
  deviceText.id = duplicate.id
  const document = reactive({ widgets: [{ id: duplicate.id, type: 'text', content: { text: 'main canvas' } }],
    tooltipTemplates: { defaults: { device: device.id, part: part.id }, templates: [device, part] }, parameters: [] })
  const props = { document, views: [], devices: [], points: [], readonly: true, ...extra }
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
  const render = async values => {
    Object.assign(props, values)
    const vnode = h(Editor, { ...props, onChange: label => changes.push(label), onNotice: message => notices.push(message) })
    renderer.render(vnode, root)
    vm = proxyRefs(vnode.component.exposed)
    await tick()
  }
  environment.beforeRestore(() => renderer.render(null, root))
  await render()
  vm.diagnosticViewportRef = { scrollLeft: 20, scrollTop: 30, clientWidth: 500, clientHeight: 300,
    getBoundingClientRect: () => ({ left: 100, top: 200 }), scrollTo: options => scrolls.push(options) }
  vm.diagnosticFrameRef = { getBoundingClientRect: () => ({ left: 1600, top: 2400, width: 200, height: 60 }),
    scrollIntoView: options => ancestorScrolls.push(options) }
  return { get vm() { return vm }, document, render, changes, notices, scrolls, ancestorScrolls,
    device, part, duplicate, other, unmount: () => renderer.render(null, root) }
}
const focus = (f, sequence = 1, values = {}) => ({ isTooltip: true, templateId: f.part.id, widgetId: f.duplicate.id, sequence, ...values })

test('tooltip diagnostics focus the exact part template and locked hidden nested widget without changing authoring', async t => {
  const f = await fixture(t), before = copy(f.document)
  await f.render({ diagnosticFocus: focus(f) })
  assert.equal(f.vm.kind, 'part')
  assert.equal(f.vm.templateId, f.part.id)
  assert.deepEqual(f.vm.selectedIds, [f.duplicate.id])
  assert.equal(f.vm.inspectorTab, 'data')
  assert.equal(f.vm.diagnosticWidget.id, f.duplicate.id)
  assert.equal(f.vm.diagnosticTarget.templateId, f.part.id)
  assert.deepEqual(copy(f.document), before)
  assert.deepEqual(f.changes, [])
  assert.equal(f.scrolls.length, 1)
  assert.deepEqual(f.scrolls[0], { left: 1370, top: 2110, behavior: 'auto' })
  assert.deepEqual(f.ancestorScrolls, [{ block: 'nearest', inline: 'nearest', behavior: 'auto' }])
})

test('red diagnostic geometry follows the exact frame and stays at least 2.5 screen pixels despite browser border quantization', async t => {
  const f = await fixture(t)
  await f.render({ diagnosticFocus: focus(f) })
  assert.equal(f.vm.diagnosticStyle.left, '19px')
  assert.equal(f.vm.diagnosticStyle.top, '702px')
  assert.equal(f.vm.diagnosticStyle.width, '125px')
  assert.equal(f.vm.diagnosticStyle.height, '29px')
  assert.equal(f.vm.diagnosticStyle.transform, 'rotate(17deg)')
  assert.equal(f.vm.diagnosticStyle.opacity, 1)
  for (const zoom of [.5, .75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5]) {
    f.vm.zoom = zoom
    const border = parseFloat(f.vm.diagnosticStyle['--diagnostic-border-width'])
    assert.equal(border, Math.ceil(2.5 / zoom))
    assert.ok(Math.floor(border) * zoom >= 2.5)
    assert.ok(border * zoom < 2.5 + zoom)
    assert.equal(parseFloat(f.vm.diagnosticStyle['--diagnostic-font-size']) * zoom, 11)
  }
})

test('repeated location requests scroll again while matching a duplicate ID in another template never wins', async t => {
  const f = await fixture(t)
  await f.render({ diagnosticFocus: focus(f, 1) })
  await f.render({ diagnosticFocus: focus(f, 2) })
  assert.equal(f.scrolls.length, 2)
  assert.equal(f.ancestorScrolls.length, 2)
  assert.equal(f.vm.diagnosticTarget.sequence, 2)
  assert.equal(f.vm.templateId, f.part.id)
  await f.render({ diagnosticFocus: focus(f, 3, { templateId: f.device.id }) })
  assert.equal(f.vm.kind, 'device')
  assert.equal(f.vm.templateId, f.device.id)
  assert.equal(f.vm.diagnosticWidget.id, f.duplicate.id)
  assert.equal(f.scrolls.length, 3)
  assert.equal(f.ancestorScrolls.length, 3)
})

test('null, main-canvas requests and unknown exact template/widget identities clear the red frame without changing selection', async t => {
  const f = await fixture(t)
  let sequence = 0
  for (const bad of [null, { isTooltip: false }, { isTooltip: true, templateId: 'missing', widgetId: 'same-nested-id' },
    { isTooltip: true, templateId: 'part-diagnostic', widgetId: 'unknown' }]) {
    await f.render({ diagnosticFocus: focus(f, ++sequence) })
    await f.render({ diagnosticFocus: bad })
    assert.equal(f.vm.diagnosticTarget, null)
    assert.equal(f.vm.diagnosticWidget, null)
    assert.deepEqual(f.vm.selectedIds, [f.duplicate.id])
    assert.equal(f.scrolls.length, sequence)
  }
})

test('choosing another element, template or kind clears only transient diagnostic focus', async t => {
  const f = await fixture(t), before = copy(f.document)
  let sequence = 0
  for (const action of [f => f.vm.selectWidget(f.other.id), f => f.vm.chooseTemplate(f.device.id), f => { f.vm.kind = 'device' }]) {
    await f.render({ diagnosticFocus: focus(f, ++sequence) })
    action(f); await tick()
    assert.equal(f.vm.diagnosticTarget, null)
    assert.equal(f.vm.diagnosticWidget, null)
    assert.deepEqual(copy(f.document), before)
    assert.deepEqual(f.changes, [])
  }
})

test('removing a diagnostic target clears its frame and undo/reinsertion does not auto-restore an old location request', async t => {
  const f = await fixture(t)
  await f.render({ diagnosticFocus: focus(f) })
  const owner = f.document.tooltipTemplates.templates.find(item => item.id === f.part.id)
  const widget = owner.widgets.find(item => item.id === f.duplicate.id)
  owner.widgets = owner.widgets.filter(item => item.id !== widget.id)
  await tick()
  assert.equal(f.vm.diagnosticTarget, null)
  owner.widgets.push(widget); await tick()
  assert.equal(f.vm.diagnosticTarget, null)
  assert.equal(f.scrolls.length, 1)
})

test('latest asynchronous diagnostic request wins and manual template changes or unmount cancel pending requests', async t => {
  const f = await fixture(t)
  const first = f.vm.focusDiagnostic(focus(f, 1))
  const second = f.vm.focusDiagnostic(focus(f, 2, { templateId: f.device.id }))
  await Promise.all([first, second]); await tick()
  assert.equal(f.vm.diagnosticTarget.sequence, 2)
  assert.equal(f.vm.diagnosticTarget.templateId, f.device.id)
  assert.equal(f.scrolls.length, 1)
  const pending = f.vm.focusDiagnostic(focus(f, 3))
  f.vm.chooseTemplate(f.device.id)
  await pending; await tick()
  assert.equal(f.vm.diagnosticTarget, null)
  assert.equal(f.scrolls.length, 1)
  assert.equal(f.ancestorScrolls.length, 1)
  const disposed = f.vm.focusDiagnostic(focus(f, 4))
  f.unmount(); await disposed
  assert.equal(f.scrolls.length, 1)
  assert.equal(f.ancestorScrolls.length, 1)
})

test('tooltip markup supplies a separate red dashed pointer-transparent layer without replacing normal blue selection', () => {
  const css = compileStyle({ source: descriptor.styles[0].content, id: 'tooltip-diagnostic-test', scoped: true })
  assert.deepEqual(css.errors, [])
  assert.match(source, /class="tooltip-diagnostic-frame"/)
  assert.match(source, /data-tooltip-diagnostic-widget-id="diagnosticWidget.id"/)
  assert.match(source, /data-tooltip-diagnostic-template-id="template.id"/)
  assert.match(css.code, /\.tooltip-diagnostic-frame[^}]*dashed #ff4d4f[^}]*pointer-events:none/)
  assert.match(css.code, /\.tooltip-diagnostic-layer[^}]*z-index:4000[^}]*pointer-events:none/)
  assert.doesNotMatch(css.code.match(/\.tooltip-diagnostic[^}]+}/g)?.join('') || '', /animation:|box-shadow:/)
  assert.match(css.code, /\.tooltip-selection-frame[^}]*solid #51bfff/)
})
