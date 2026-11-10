import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { installBrowser, installSockets, json, settle } from './helpers.mjs'

test.mock.module('../src/runtime/adminSession.js', { namedExports: {
    adminFetch: (...args) => globalThis.fetch(...args), adminSession: {displayAuthenticated:true,permissions:{view:true},user:{username:'owned'}}
} })
const source = new URL('../src/views/DashboardOverlay.vue', import.meta.url)
const { descriptor } = parse(await readFile(source, 'utf8'))
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: source.pathname, id: 'overlay-resync' }).errors, [])
let code = compileScript(descriptor, { id: 'overlay-resync' }).content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const name = match[2]
    const resolved = name.endsWith('.vue') ? 'data:text/javascript,export default {}' : name.startsWith('.') ? new URL(name, source).href : import.meta.resolve(name)
    code = code.replace(match[0], `from ${JSON.stringify(resolved)}`)
}
const { default: Overlay } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Overlay.render = () => null

function fixture(t, { platform = {} } = {}) {
    const environment = installBrowser(t)
    const sockets = installSockets(environment.replace)
    window.dispatchEvent = () => {}
    window.requestAnimationFrame = () => 1
    window.cancelAnimationFrame = () => {}
    document.documentElement = { style: {} }
    document.body = { style: {} }
    let devices = [{ id: 'old', name: 'Old device' }], failure = false, visible = true
    const request = t.mock.method(globalThis, 'fetch', async url => {
        if (String(url).endsWith('/config')) return failure ? json({}, 503) : json({
            workshops: [{ id: 'w', devices: [{ id: 'unassigned', name: 'Unassigned' }], lines: [{ id: 'l', devices }] }],
            factoryId: 'factory_a', factories: [{ id: 'factory_a', enabled: visible }], settings: {}, models: [], platform
        })
        if (String(url).includes('/events')) return json([])
        return json({})
    })
    t.mock.method(console, 'log', () => {})
    t.mock.method(console, 'error', () => {})
    const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
    const instance = ref(null)
    const app = renderer.createApp({ render: () => h(Overlay, { ref: instance }) })
    const replacements = [], pushes = []
    app.provide(routerKey, { push(target) { pushes.push(target) }, replace(target) { replacements.push(target) } })
    app.provide(routeLocationKey, { query: {} })
    app.mount({})
    environment.beforeRestore(() => app.unmount())
    return { state: instance.value.$.setupState, sockets, request, replacements, pushes, replace: environment.replace, hide() { visible = false }, setDevices(next) { devices = next }, fail() { failure = true } }
}

test('explicit root return-button click works even when the automatic navigation shortcut is unavailable', async t => {
    const view = fixture(t); await settle()
    Object.assign(view.state.runtimeContext, { viewId: 'factory_overview', viewMode: 'factory', sceneReady: true })
    assert.equal(view.state.canNavigateToParentView, false)
    await view.state.returnToParentView()
    assert.equal(view.pushes.at(-1).path, '/group')
    assert.equal(view.state.parentReturnBusy, false)
})

test('solid-device Esc and the return button both ask native to restore the workshop entry, without a fixed-line detour', async t => {
    const views = [{ id:'factory_overview', mode:'factory', name:'全厂总览' }, { id:'workshop_overview', mode:'workshop', name:'车间总览' },
        { id:'line_overview', mode:'line', name:'产线视角' }, { id:'device_detail', mode:'device', parentViewId:'line_overview', name:'设备' }]
    const view = fixture(t, { platform: { document: { widgets:[], scene:{ defaultViewId:'factory_overview',views } } } }); await settle()
    view.replace('Element', class {})
    const returnOrigin = { factoryId:'factory_a',sceneId:'scene_a',viewMode:'workshop',viewId:'workshop_overview',workshopId:'original-workshop' }
    view.state.applyRuntimeContext({ factoryId:'factory_a',sceneId:'scene_a',viewMode:'device',viewId:'device_detail',deviceId:'device-one',inspectionStage:'solid',sceneReady:true,returnOrigin })
    assert.equal(view.state.parentViewName, '车间总览')
    const before = view.request.mock.callCount()
    let prevented = false
    view.state.handleOverlayKeydown({ key:'Escape',target:null,preventDefault(){ prevented=true },stopPropagation(){} })
    await settle()
    await view.state.activateControl({ id:'back',type:'return_button',events:[] })
    const writes = view.request.mock.calls.slice(before).filter(call => String(call.arguments[0]).endsWith('/native-preview/navigate'))
    assert.equal(prevented, true); assert.equal(writes.length, 2)
    for (const call of writes) {
        const body = JSON.parse(call.arguments[1].body)
        assert.equal(body.action, 'inspection_back'); assert.equal(body.viewId, 'device_detail')
        assert.deepEqual(body.focus, { mode:'device',deviceId:'device-one',inspectionStage:'solid' })
    }
    view.state.applyRuntimeContext({ factoryId:'factory_b',sceneId:'another-scene',viewMode:'factory',viewId:'factory_overview',sceneReady:true })
    assert.equal(view.state.runtimeContext.returnOrigin, null, 'stale entry must not leak into another factory')
})

test('failed device return does not pretend to navigate or fall back to a different line', async t => {
    const view = fixture(t); await settle()
    Object.assign(view.state.runtimeContext, { viewMode:'device',viewId:'device_detail',deviceId:'one',inspectionStage:'solid',sceneReady:true })
    t.mock.method(globalThis, 'fetch', async () => json({ success:true,sent:0 }))
    assert.equal(await view.state.returnToParentView(), false)
    assert.match(view.state.hierarchyError, /未执行返回/)
    assert.equal(view.state.runtimeContext.viewId, 'device_detail')
    assert.equal(view.state.parentReturnBusy, false)
})

test('hiding the displayed factory returns to the map without rebuilding the scene or changing acquisition', async t => {
    const view = fixture(t); await settle()
    const calls = view.request.mock.callCount()
    await view.state.handleRuntimeMessage({ type: 'configuration_changed', payload: { factoryId: 'factory_b', visibilityOnly: true, enabled: false } })
    assert.equal(view.replacements.length, 0)
    await view.state.handleRuntimeMessage({ type: 'configuration_changed', payload: { factoryId: 'factory_a', visibilityOnly: true, enabled: false } })
    assert.equal(view.replacements.at(-1).path, '/group')
    assert.equal(view.request.mock.callCount(), calls)
})

test('a hidden factory cannot reappear in the display on a full resync', async t => {
    const view = fixture(t); await settle(); view.hide()
    await view.state.handleRuntimeMessage({ type: 'realtime_resync_required' })
    assert.equal(view.replacements.at(-1).path, '/group')
})

test('production overlay resync replaces its device set and handles unassigned devices', async t => {
    const view = fixture(t)
    await settle()
    const store = view.state.dataStore
    assert.deepEqual(Object.keys(store.deviceStatusMap).sort(), ['old', 'unassigned'])
    view.sockets[0].emit('device_data', { furnace_id: 'old', status: { running: true } })
    view.setDevices([{ id: 'new', name: 'New device' }])
    await view.state.handleRuntimeMessage({ type: 'realtime_resync_required' })
    view.sockets[0].emit('device_data', { furnace_id: 'old', status: { running: true } })
    assert.deepEqual(Object.keys(store.deviceStatusMap).sort(), ['new', 'unassigned'])
    assert.equal(store.latestDeviceDataMap.has('old'), false)
    assert.equal(store.metrics.running_devices, 0)
})

test('ordinary configuration events update overlay devices while a failed release refresh retains them', async t => {
    const view = fixture(t)
    await settle()
    view.setDevices([{ id: 'configured', name: 'Configured device' }])
    await view.state.handleRuntimeMessage({ type: 'device_configuration_changed' })
    assert.equal('configured' in view.state.dataStore.deviceStatusMap, true)
    view.fail()
    await view.state.handleRuntimeMessage({ type: 'dashboard_release_changed' })
    assert.deepEqual(Object.keys(view.state.dataStore.deviceStatusMap).sort(), ['configured', 'unassigned'])
})

test('compact pointer updates do not reload config or replace part descriptors', async t => {
    const view=fixture(t);await settle()
    const state=view.state
    Object.assign(state.runtimeContext,{factoryId:'pit',deviceId:'one',viewId:'device_detail',viewMode:'device',sceneReady:true,
        inspectionEnabled:true,inspectionStage:'solid',inspectionParts:[{id:'shell',anchor:{visible:true,x:.5,y:.5}}]})
    const parts=state.runtimeContext.inspectionParts,count=view.request.mock.callCount()
    await state.handleRuntimeMessage({type:'inspection_hover_changed',payload:{factoryId:'pit',deviceId:'one',viewId:'device_detail',inspectionStage:'solid',
        inspectionHoveredPartId:'shell',inspectionHoverPointer:{x:.4,y:.3,visible:true}}})
    assert.equal(state.runtimeContext.inspectionHoveredPartId,'shell')
    assert.equal(state.runtimeContext.inspectionParts,parts)
    assert.equal(view.request.mock.callCount(),count)
})


test('overview hover uses compact state without config fetches and clears on factory/view changes', async t => {
    const view=fixture(t);await settle()
    const state=view.state
    Object.assign(state.runtimeContext,{factoryId:'pit',viewId:'factory_overview',viewMode:'factory',sceneReady:true})
    const calls=view.request.mock.callCount()
    await state.handleRuntimeMessage({type:'device_hover_changed',payload:{factoryId:'pit',viewId:'factory_overview',hoveredDeviceId:'old',deviceHoverPointer:{x:.3,y:.4,visible:true}}})
    assert.equal(state.tooltipTarget.device.name,'Old device')
    assert.equal(state.tooltipContext.hover.device.name,'Old device')
    assert.equal(view.request.mock.callCount(),calls)
    state.applyRuntimeContext({factoryId:'next',viewId:'factory_overview'})
    assert.equal(state.tooltipTarget,null)
    await state.handleRuntimeMessage({type:'device_hover_changed',payload:{factoryId:'pit',viewId:'factory_overview',hoveredDeviceId:'old',deviceHoverPointer:{x:.3,y:.4,visible:true}}})
    assert.equal(state.tooltipTarget,null)
})

test('full hierarchy navigation is not gated by the reference HUD layout migration flag', () => {
    const template=descriptor.template.content
    assert.match(template,/<nav class="overlay-hierarchy"/)
    assert.doesNotMatch(template,/<nav v-if="presentationDocument\?\.metadata\?\.referenceHud/)
    assert.doesNotMatch(template,/class="group-map-return"/)
})
