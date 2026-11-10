import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, reactive } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { createDashboardWidget, normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { installBrowser } from './helpers.mjs'

// Compile the actual SFC template, not a renderless setup stub. The in-memory
// host below emulates native input.value and Vue's real value patching without
// launching or operating a browser, app, production draft, or database.
const url = new URL('../src/views/admin/components/WidgetDataBindingEditor.vue', import.meta.url)
const descriptor = parse(await readFile(url, 'utf8')).descriptor
let code = compileScript(descriptor, { id: 'workflow-input-race', inlineTemplate: true }).content
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, source) => 'from ' + JSON.stringify(
  source.endsWith('.vue') ? 'data:text/javascript,export default {render:()=>null}'
    : source === 'vue' ? import.meta.resolve('vue') : new URL(source, url).href))
const Editor = (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default

function mountEditor(t, { mode = 'plc', refreshMs = 5000 } = {}) {
  const env = installBrowser(t)
  const makeNode = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null, value: '' })
  const remove = node => {
    if (!node.parent) return
    const siblings = node.parent.children, index = siblings.indexOf(node)
    if (index >= 0) siblings.splice(index, 1)
    node.parent = null
  }
  const patches = []
  const renderer = createRenderer({
    createElement: tag => makeNode(tag), createText: text => makeNode('#text', text),
    createComment: text => makeNode('#comment', text),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) {
      remove(node)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index >= 0 ? index : parent.children.length, 0, node)
      node.parent = parent
    },
    remove,
    patchProp(node, key, previous, next) {
      if (key === 'value') {
        patches.push({ tag: node.tag, before: node.value, next: String(next ?? '') })
        node.value = String(next ?? '')
      }
      node.props[key] = next
    }
  })
  const widget = reactive({ ...createDashboardWidget('hud_chart_dock'), id: 'input-race', data: {
    mode, bindingVersion: 2, deviceScope: 'rotation', rotationIntervalMs: 10000, refreshMs,
    pointId: 'a1', pointKey: 'analog.progress_a', datasetId: mode === 'dataset' ? 'process' : '',
    deviceBindings: [
      { deviceId: 'a', binding: { mode: 'plc', pointId: 'a1', pointKey: 'analog.progress_a', unit: '%' } },
      { deviceId: 'b', binding: { mode: 'plc', pointId: 'b1', pointKey: 'analog.progress_b', unit: '%' } }
    ]
  } })
  const devices = [{ id: 'a', name: 'A炉' }, { id: 'b', name: 'B炉' }]
  const points = [{ id: 'a1', device_id: 'a', plc_tag: 'DB101.DBD0', unit: '%' }, { id: 'b1', device_id: 'b', plc_tag: 'DB202.DBD64', unit: '%' }]
  const values = reactive({ 'a:a1': { id: 'a1', device_id: 'a', value: 0, quality: 'good' }, 'b:b1': { id: 'b1', device_id: 'b', value: 85, quality: 'good' } })
  const changes = [], root = makeNode('#root')
  const app = renderer.createApp({ render: () => h(Editor, { widget, devices, points, values, factoryId: 'factory_default',
    onChange: value => { changes.push(JSON.parse(JSON.stringify(value))); widget.data = value } }) })
  app.mount(root); env.beforeRestore(() => app.unmount())
  const all = () => {
    const result = []
    const visit = node => { result.push(node); node.children.forEach(visit) }
    visit(root); return result
  }
  const dispatch = (node, name) => {
    const handler = node.props[name], event = { target: node, currentTarget: node }
    for (const fn of Array.isArray(handler) ? handler : handler ? [handler] : []) fn(event)
  }
  const input = label => { const node = all().find(node => node.tag === 'input' && node.props['aria-label'] === label); assert.ok(node, label + ' rendered'); return node }
  const type = (node, value) => { node.value = String(value); dispatch(node, 'onInput') }
  const text = node => node.text + node.children.map(text).join('')
  const click = prefix => { const node = all().find(node => node.tag === 'button' && text(node).startsWith(prefix)); assert.ok(node, prefix + ' rendered'); dispatch(node, 'onClick') }
  const frame = async value => { values['a:a1'] = { id: 'a1', device_id: 'a', value, quality: 'good' }; await nextTick() }
  return { widget, input, type, dispatch, click, frame, patches, changes, all }
}

test('live PLC render between typing six seconds and blur cannot restore the ten-second model value', async t => {
  const f = mountEditor(t), input = f.input('每项显示秒数')
  f.type(input, '6'); await nextTick()
  await f.frame(1)
  assert.equal(input.value, '6', 'the actual compiled input must retain the user text through a live data repaint')
  f.dispatch(input, 'onChange'); await nextTick()
  assert.equal(f.widget.data.rotationIntervalMs, 6000)
  const document = normalizeDashboardDocument({ widgets: [JSON.parse(JSON.stringify(f.widget))] })
  assert.equal(document.widgets.find(widget => widget.id === 'input-race').data.rotationIntervalMs, 6000)
})

test('six-second rotation survives live renders, mode switches, and an actual normalized save/reopen', async t => {
  const f = mountEditor(t), input = f.input('每项显示秒数')
  f.type(input, '6'); f.dispatch(input, 'onChange'); await nextTick()
  const bindings = JSON.parse(JSON.stringify(f.widget.data.deviceBindings))
  for (let cycle = 0; cycle < 2; cycle++) {
    f.click('始终显示指定设备的数据'); await nextTick(); await f.frame(cycle + 1)
    f.click('显示当前查看设备的数据'); await nextTick(); await f.frame(cycle + 2)
    f.click('按清单轮播数据'); await nextTick()
    assert.equal(f.input('每项显示秒数').value, '6')
    assert.equal(f.widget.data.rotationIntervalMs, 6000)
    assert.deepEqual(JSON.parse(JSON.stringify(f.widget.data.deviceBindings)), bindings)
  }
  const saved = normalizeDashboardDocument({ widgets: [JSON.parse(JSON.stringify(f.widget))] })
  const reopened = normalizeDashboardDocument(JSON.parse(JSON.stringify(saved)))
  assert.equal(reopened.widgets.find(widget => widget.id === 'input-race').data.rotationIntervalMs, 6000)
})

test('a realtime repaint also cannot discard a typed two-second dataset refresh', async t => {
  const f = mountEditor(t, { mode: 'dataset' })
  const input = f.all().find(node => node.tag === 'input' && node.props.type === 'number' && node.props['aria-label'] !== '每项显示秒数')
  assert.ok(input, 'dataset refresh input rendered')
  f.type(input, '2'); await nextTick(); await f.frame(3)
  assert.equal(input.value, '2')
  f.dispatch(input, 'onChange'); await nextTick()
  assert.equal(f.widget.data.refreshMs, 2000)
  assert.equal(f.widget.data.rotationIntervalMs, 10000, 'refresh edits are independent of rotation')
})

test('empty and below-minimum intermediate edits survive live frames until a complete twelve-second value is entered', async t => {
  const f = mountEditor(t), input = f.input('每项显示秒数')
  for (const text of ['', '1']) {
    f.type(input, text); await nextTick(); await f.frame(text === '' ? 4 : 5)
    assert.equal(input.value, text)
    assert.equal(f.widget.data.rotationIntervalMs, 10000, 'an incomplete value cannot rewrite the saved valid interval')
  }
  f.type(input, '12'); await nextTick(); await f.frame(6)
  assert.equal(input.value, '12'); assert.equal(f.widget.data.rotationIntervalMs, 12000)
  f.dispatch(input, 'onChange'); await nextTick(); assert.equal(input.value, '12')
})

test('leaving a cleared field restores its last valid value rather than persisting a fabricated minimum', async t => {
  const f = mountEditor(t), input = f.input('每项显示秒数')
  f.type(input, '6'); await nextTick()
  f.type(input, ''); await nextTick(); await f.frame(7)
  assert.equal(input.value, ''); assert.equal(f.widget.data.rotationIntervalMs, 6000)
  f.dispatch(input, 'onChange'); await nextTick()
  assert.equal(input.value, '6'); assert.equal(f.widget.data.rotationIntervalMs, 6000)
})

test('out-of-range text is preserved during editing and bounded only when the native change is committed', async t => {
  const f = mountEditor(t), input = f.input('每项显示秒数')
  f.type(input, '9000'); await nextTick(); await f.frame(8)
  assert.equal(input.value, '9000'); assert.equal(f.widget.data.rotationIntervalMs, 10000)
  f.dispatch(input, 'onChange'); await nextTick()
  assert.equal(input.value, '3600'); assert.equal(f.widget.data.rotationIntervalMs, 3600000)
  f.type(input, '1'); await nextTick(); await f.frame(9)
  assert.equal(input.value, '1'); assert.equal(f.widget.data.rotationIntervalMs, 3600000)
  f.dispatch(input, 'onChange'); await nextTick()
  assert.equal(input.value, '2'); assert.equal(f.widget.data.rotationIntervalMs, 2000)
})

test('a fractional refresh edit is not overwritten or prematurely clamped by a live sample', async t => {
  const f = mountEditor(t, { mode: 'dataset' })
  const input = f.all().find(node => node.tag === 'input' && node.props.type === 'number' && node.props['aria-label'] !== '每项显示秒数')
  f.type(input, '0'); await nextTick(); await f.frame(10)
  assert.equal(input.value, '0'); assert.equal(f.widget.data.refreshMs, 5000)
  f.type(input, '0.5'); await nextTick(); await f.frame(11)
  assert.equal(input.value, '0.5'); assert.equal(f.widget.data.refreshMs, 500)
  f.dispatch(input, 'onChange'); await nextTick()
  assert.equal(input.value, '0.5'); assert.equal(f.widget.data.rotationIntervalMs, 10000)
})
