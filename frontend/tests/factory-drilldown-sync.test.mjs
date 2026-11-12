import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as Vue from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { routeLocationKey, routerKey } from 'vue-router'
import { installBrowser, deferred, json, settle } from './helpers.mjs'

test.mock.module('../src/runtime/adminSession.js', { namedExports: { adminFetch: (...args) => globalThis.fetch(...args) } })
const source = new URL('../src/views/FactoryDrilldown.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
// Exercise the production load/watch/event handlers without starting WebGL.
let code = compileScript(descriptor, { id: 'drilldown-sync' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const dependency = match[2]
    const resolved = dependency.endsWith('.vue') ? 'data:text/javascript,export default {}' : dependency.startsWith('.') ? new URL(dependency, source).href : import.meta.resolve(dependency)
    code = code.replace(match[0], `from ${JSON.stringify(resolved)}`)
}
// Vue mounted callbacks are intentionally inert in this isolated transport test.
// Node 26 adds a CJS interop marker, not a valid identifier for mock exports.
const vueExports = Object.fromEntries(Object.entries(Vue).filter(([name]) => name !== 'module.exports'))
test.mock.module('vue', { namedExports: { ...vueExports, onMounted() {} } })
const { default: Drilldown } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Drilldown.render = () => null

function fixture(t) {
    const environment = installBrowser(t)
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }) }
    document.createElement = () => canvas
    window.dispatchEvent = () => {}
    environment.replace('cancelAnimationFrame', () => {})
    const route = Vue.reactive({ query: { factoryId: 'factory_a' } })
    const renderer = Vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const instance = Vue.ref(null)
    const app = renderer.createApp({ render: () => Vue.h(Drilldown, { ref: instance }) })
    const replacements = []
    app.provide(routeLocationKey, route); app.provide(routerKey, { push() {}, replace(target) { replacements.push(target) } }); app.mount({})
    environment.beforeRestore(() => app.unmount())
    const directory = { factories: ['factory_a', 'factory_b'].map(id => ({ id, name: id, enabled: true })) }
    return { state: instance.value.$.setupState, route, directory, app, replacements }
}
const config = id => ({ factoryId: id, settings: {}, workshops: [{ id: `workshop_${id}`, lines: [] }] })

test('hidden street/campus views return to the map, rather than leaving a stale factory visible', async t => {
    const view = fixture(t)
    t.mock.method(globalThis, 'fetch', async url => json(String(url).endsWith('/factories') ? view.directory : config('factory_a')))
    await view.state.load()
    view.directory.factories[0].enabled = false
    await view.state.load()
    assert.equal(view.replacements.at(-1).path, '/group')
    assert.equal(view.replacements.at(-1).query.factoryId, undefined)
})

test('street/campus reloads saved configuration without a user refresh', async t => {
    const view = fixture(t)
    let payload = config('factory_a')
    const request = t.mock.method(globalThis, 'fetch', async url => json(String(url).endsWith('/factories') ? view.directory : payload))
    await view.state.load()
    payload = { ...config('factory_a'), settings: { site_scene_config: '{"streetTitle":"New title"}' } }
    view.state.scheduleConfigRefresh({ type: 'configuration_changed', payload: { factoryId: 'factory_a' } })
    await new Promise(resolve => setTimeout(resolve, 230)); await settle()
    assert.equal(view.state.config.settings.site_scene_config, payload.settings.site_scene_config)
    const count = request.mock.callCount()
    view.state.scheduleConfigRefresh({ payload: { factoryId: 'factory_b', resource: 'devices' } })
    await new Promise(resolve => setTimeout(resolve, 230))
    assert.equal(request.mock.callCount(), count, 'another factory must not trigger this campus load')
})

test('late old factory response cannot overwrite the selected factory', async t => {
    const view = fixture(t), old = deferred()
    let oldSignal
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (String(url).endsWith('/factories')) return json(view.directory)
        if (options.headers['X-Factory-ID'] === 'factory_a') { oldSignal = options.signal; return old.promise }
        return json(config('factory_b'))
    })
    const first = view.state.load()
    await settle()
    view.route.query.factoryId = 'factory_b'
    await Vue.nextTick()
    await view.state.load()
    assert.equal(oldSignal.aborted, true)
    old.resolve(json(config('factory_a'))); await first
    assert.equal(view.state.config.factoryId, 'factory_b')
    assert.equal(view.state.factory.id, 'factory_b')
})

test('unmount aborts config transport and cancels scheduled synchronization', async t => {
    const view = fixture(t), pending = deferred()
    let signal
    const request = t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return pending.promise })
    const loading = view.state.load()
    view.state.scheduleConfigRefresh({ payload: {} })
    view.app.unmount()
    assert.equal(signal.aborted, true)
    pending.resolve(json({})); await loading
    await new Promise(resolve => setTimeout(resolve, 230))
    assert.equal(request.mock.callCount(), 2)
})
