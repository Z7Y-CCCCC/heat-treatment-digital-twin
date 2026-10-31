import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as Vue from 'vue'
import * as Three from 'three'
import { parse, compileScript } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { deferred, installBrowser, installSockets, json, settle } from './helpers.mjs'

const mounted = []
test.mock.module('vue', { namedExports: { ...Vue, onMounted: callback => mounted.push(callback) } })
class Renderer {
    domElement = {}; shadowMap = {}
    setPixelRatio() {} setSize() {} setRenderTarget() {} clear() {} render() {} dispose() {}
}
class Controls extends Three.EventDispatcher {
    target = new Three.Vector3()
    update() { return false } dispose() {}
}
class Pass { dispose() {} }
class Composer { setPixelRatio() {} setSize() {} addPass() {} render() {} dispose() {} }
test.mock.module('three', { namedExports: { ...Three, WebGLRenderer: Renderer } })
test.mock.module('three/examples/jsm/controls/OrbitControls.js', { namedExports: { OrbitControls: Controls } })
test.mock.module('three/examples/jsm/postprocessing/EffectComposer.js', { namedExports: { EffectComposer: Composer } })
for (const name of ['RenderPass', 'SSAOPass', 'OutputPass']) test.mock.module(`three/examples/jsm/postprocessing/${name}.js`, { namedExports: { [name]: Pass } })
test.mock.module('../src/runtime/adminSession.js', { namedExports: {
    adminFetch: (...args) => globalThis.fetch(...args), adminSession: Vue.reactive({}), refreshAdminSession: async () => {}, canOpenAdmin: () => false,
    startAdminSessionTracking() {}, stopAdminSessionTracking() {}, changeAdminPassword() {}, listAdminAccounts() {},
    addAdminAccount() {}, activateAdminAccount() {}, logoutCurrentAdminAccount() {}
} })

async function component(name) {
    const source = new URL(`../src/views/${name}.vue`, import.meta.url)
    const { descriptor } = parse(await readFile(source, 'utf8'))
    let code = compileScript(descriptor, { id: name }).content
    for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
        const dependency = match[2]
        const resolved = dependency.endsWith('.vue') ? 'data:text/javascript,export default {}' : dependency.startsWith('.') ? new URL(dependency, source).href : import.meta.resolve(dependency)
        code = code.replace(match[0], `from ${JSON.stringify(resolved)}`)
    }
    const { default: View } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
    View.render = () => null
    return View
}
const views = await Promise.all(['GroupOverview', 'FactoryHudPreview'].map(component))

for (let index = 0; index < views.length; index++) test(`${['map', 'HUD'][index]} startup cannot recreate timers or listeners after unmount during config loading`, async t => {
    mounted.length = 0
    const environment = installBrowser(t)
    installSockets(environment.replace)
    environment.replace('devicePixelRatio', 1)
    environment.replace('requestAnimationFrame', () => 1)
    environment.replace('cancelAnimationFrame', () => {})
    environment.replace('ResizeObserver', class { observe() {} disconnect() {} })
    window.dispatchEvent = () => {}
    let activeTimers = new Set()
    const setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval
    t.mock.method(globalThis, 'setInterval', (...args) => { const timer = setInterval(...args); activeTimers.add(timer); return timer })
    t.mock.method(globalThis, 'clearInterval', timer => { activeTimers.delete(timer); clearInterval(timer) })
    t.after(() => { for (const timer of activeTimers) clearInterval(timer) })
    const pending = deferred()
    let requestSignal
    t.mock.method(globalThis, 'fetch', (_url, options) => { requestSignal = options.signal; return pending.promise })
    const renderer = Vue.createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const instance = Vue.ref(null)
    const app = renderer.createApp({ render: () => Vue.h(views[index], { ref: instance }) })
    app.provide(routerKey, { push() {}, replace() {} })
    app.provide(routeLocationKey, { query: {} })
    app.mount({})
    const state = instance.value.$.setupState, host = { clientWidth: 1920, clientHeight: 1080, appendChild() {} }
    if (index === 0) state.mapHost = host
    else { state.sceneHost = host; state.artboard = host }
    const starting = Promise.all(mounted.map(callback => callback()))
    await settle()
    assert.ok(requestSignal, 'production mounted hook must reach config transport')
    app.unmount()
    assert.equal(requestSignal.aborted, true)
    pending.resolve(json({ workshops: [], models: [], settings: {} }))
    await starting
    assert.equal(activeTimers.size, 0, 'late mounted continuation recreated an interval')
    assert.equal(document.listeners.get('visibilitychange')?.size || 0, 0)
    assert.equal(window.listeners.get('keydown')?.size || 0, 0)
})
