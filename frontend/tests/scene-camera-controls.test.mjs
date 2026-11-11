import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, reactive, ref, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { deferred, installBrowser, settle } from './helpers.mjs'

const url = new URL('../src/components/SceneCameraControls.vue', import.meta.url)
const source = await readFile(url, 'utf8'), { descriptor } = parse(source)
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'camera-controls' }).errors, [])
let compiled = compileScript(descriptor, { id: 'camera-controls' }).content.replace(/^import EdgeFoldTab from .+$/m, 'const EdgeFoldTab = {}')
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) compiled=compiled.replace(match[0],`from ${JSON.stringify(match[2].startsWith('.')?new URL(match[2],url).href:import.meta.resolve(match[2]))}`)
const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Component.render = () => null
async function fixture(t, initial = {}) {
  const environment = installBrowser(t), actions = [], geometry = []
  const props = reactive({ available: true, requestAction: async action => { actions.push(action); return true }, ...initial })
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null), app = renderer.createApp({ render: () => h(Component, { ...props, ref: instance, onGeometryChange: () => geometry.push(true) }) })
  app.mount({}); environment.beforeRestore(() => app.unmount()); await settle()
  return { state: instance.value.$.setupState, props, actions, geometry, environment, unmount: () => app.unmount() }
}
test('small camera control expands on click and all actions work without wheel input', async t => {
  const f = await fixture(t)
  assert.equal(f.state.open, false); f.state.toggle(); await settle()
  assert.equal(f.state.open, true); assert.ok(f.geometry.length)
  for (const action of ['zoomIn', 'zoomOut', 'rotateLeft', 'rotateRight', 'fit']) assert.equal(await f.state.run(action), true)
  assert.deepEqual(f.actions, ['zoomIn', 'zoomOut', 'rotateLeft', 'rotateRight', 'fit'])
  assert.equal(f.state.open, true)
  assert.match(source, /data-overlay-hit="true"/)
  assert.match(source, /right:max\(6px/)
  assert.match(source, /bottom:max\(6px/)
  assert.match(source, /'is-hidden': hidden/)
  assert.match(source, /无需滚轮/)
  assert.doesNotMatch(source, /@wheel|setInterval/)
})
test('not-ready, unknown and overlapping camera commands are blocked', async t => {
  const response = deferred(), actions = []
  const f = await fixture(t, { available: false, requestAction: action => { actions.push(action); return response.promise } })
  assert.equal(await f.state.run('zoomIn'), false)
  f.props.available = true; await nextTick()
  assert.equal(await f.state.run('delete'), false)
  const pending = f.state.run('zoomIn'); assert.equal(f.state.pending, true)
  assert.equal(await f.state.run('zoomIn'), false)
  response.resolve(true); assert.equal(await pending, true); assert.equal(f.state.pending, false)
  assert.deepEqual(actions, ['zoomIn'])
})
test('command errors remain visible and retries clear them', async t => {
  const f = await fixture(t, { requestAction: async () => { throw new Error('Unity 未连接') } })
  f.state.toggle(); assert.equal(await f.state.run('fit'), false)
  assert.equal(f.state.error, 'Unity 未连接'); assert.equal(f.state.open, true)
  f.props.requestAction = async () => true; await nextTick()
  assert.equal(await f.state.run('fit'), true); assert.equal(f.state.error, '')
})
test('Escape closes only this panel before dashboard navigation; outside click closes and listeners are removed', async t => {
  const f = await fixture(t); let prevented = false, stopped = false
  f.state.toggle(); f.state.escape({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() {}, stopImmediatePropagation() { stopped = true } })
  assert.equal(f.state.open, false); assert.equal(prevented, true); assert.equal(stopped, true)
  f.state.toggle(); f.state.outside({ target: {} }); assert.equal(f.state.open, false)
  f.unmount()
  assert.equal(f.environment.browser.listeners.get('keydown').size, 0)
  assert.equal(await f.state.run('zoomIn'), false)
})
