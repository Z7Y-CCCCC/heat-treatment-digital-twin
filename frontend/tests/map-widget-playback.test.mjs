import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import { installBrowser, json, settle } from './helpers.mjs'

test.mock.module('../src/runtime/adminSession.js', { namedExports: {
  adminFetch: (...args) => globalThis.fetch(...args),
  adminSession: { displayAuthenticated: true, permissions: { view: true }, user: { username: 'owned' } }
} })
const source = new URL('../src/views/MapSurfaceWidgets.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
let code = compileScript(descriptor, { id: 'map-widget-playback' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  const name = match[2]
  const resolved = name.endsWith('.vue') ? 'data:text/javascript,export default {}'
    : name.startsWith('.') ? new URL(name, source).href : import.meta.resolve(name)
  code = code.replace(match[0], `from ${JSON.stringify(resolved)}`)
}
const { default: Surface } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Surface.render = () => null

async function fixture(t) {
  const environment = installBrowser(t)
  t.mock.method(globalThis, 'setInterval', () => 1)
  t.mock.method(globalThis, 'clearInterval', () => {})
  t.mock.method(globalThis, 'fetch', async () => json({ values: {} }))
  const widget = { id: 'rotating', type: 'value', visible: true, runtimeTarget: 'overlay', data: {
    mode: 'runtime', path: 'device.analog.temperature', deviceScope: 'rotation', rotationIntervalMs: 2000
  } }
  const props = ref({ viewId: 'map_world', factoryId: 'owned', mapData: { code: 'world', level: 'world' },
    document: { sceneId: 'owned-scene', widgets: [widget], scene: { defaultViewId: 'map_world', views: [
      { id: 'map_world', mode: 'custom', componentState: { show: ['rotating'] } },
      { id: 'map_country', mode: 'custom', componentState: { show: ['rotating'] } }
    ] } }, config: { workshops: [{ id: 'w', name: '车间', lines: [{ id: 'l', name: '产线', devices: [
      { id: 'a', name: '炉 A' }, { id: 'b', name: '炉 B' }
    ] }] }] } })
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null)
  const app = renderer.createApp({ render: () => h(Surface, { ...props.value, ref: instance }) })
  app.mount({})
  environment.beforeRestore(() => app.unmount())
  await settle()
  return { props, widget, state: instance.value.$.setupState, app }
}

test('equivalent config polls preserve the map card hold and cached current-device values', async t => {
  const view = await fixture(t), clock = view.state.playbackController
  clock.setHovered(view.widget, true, 2500)
  view.state.values = { rotating: { deviceId: 'b', value: 222 } }
  view.props.value = JSON.parse(JSON.stringify(view.props.value))
  await nextTick(); await settle()
  assert.equal(clock.timeFor(view.widget, 20000), 2500)
  assert.equal(view.state.values.rotating.value, 222)
  clock.setHovered(view.widget, false, 20000)
  assert.equal(clock.timeFor(view.widget, 21499), 3999)
  assert.equal(clock.timeFor(view.widget, 21500), 4000)
})

test('real view, binding and device-catalog changes release held map playback state', async t => {
  const view = await fixture(t), clock = view.state.playbackController
  const update = async change => {
    clock.setHovered(view.widget, true, 2500)
    const next = JSON.parse(JSON.stringify(view.props.value)); change(next); view.props.value = next
    await nextTick(); await settle()
    assert.equal(clock.timeFor(view.widget, 20000), 20000)
  }
  await update(next => { next.viewId = 'map_country' })
  await update(next => { next.document.widgets[0].data.rotationIntervalMs = 4000 })
  await update(next => { next.config.workshops[0].lines[0].devices.push({ id: 'c', name: '炉 C' }) })
  clock.setHovered(view.widget, true, 2500)
  view.app.unmount()
  assert.equal(clock.timeFor(view.widget, 20000), 20000)
})
