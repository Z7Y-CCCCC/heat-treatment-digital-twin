import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { installBrowser, installSockets, json, settle } from './helpers.mjs'
import { WidgetClockKey } from '../src/runtime/widgetPlayback.js'

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

function fixture(t, { platform = {}, settings = {}, native = false, realMount = false } = {}) {
    const environment = installBrowser(t)
    const sockets = installSockets(environment.replace)
    const progress=[],messages=[]
    window.dispatchEvent = event => progress.push(event.detail)
    if(native){window.__DIGITAL_TWIN_NATIVE_LOADING__=true;window.chrome={webview:{addEventListener(){},removeEventListener(){},postMessage:m=>messages.push(m)}}}
    if(realMount){
        environment.replace('ResizeObserver',class {observe(){}disconnect(){}})
        environment.replace('MutationObserver',class {observe(){}disconnect(){}})
    }
    window.requestAnimationFrame = () => 1
    window.cancelAnimationFrame = () => {}
    document.documentElement = { style: {} }
    document.body = { style: {} }
    let devices = [{ id: 'old', name: 'Old device' }], failure = false, visible = true
    const request = t.mock.method(globalThis, 'fetch', async url => {
        if (String(url).endsWith('/config')) return failure ? json({}, 503) : json({
            workshops: [{ id: 'w', devices: [{ id: 'unassigned', name: 'Unassigned' }], lines: [{ id: 'l', devices }] }],
            factoryId: 'factory_a', factories: [{ id: 'factory_a', enabled: visible }], settings, models: [], platform
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
    if(realMount)instance.value.$.setupState.rootRef={querySelectorAll:()=>[]}
    environment.beforeRestore(() => app.unmount())
    return { state: instance.value.$.setupState, provides: instance.value.$.provides, sockets, request, replacements, pushes, progress, messages, replace: environment.replace, hide() { visible = false }, setDevices(next) { devices = next }, setConfig(next) { settings=next.settings;platform=next.platform }, fail() { failure = true } }
}

test('mounted native overlay keeps the cover after web setup and consumes real scene progress before sending ready once',async t=>{
    t.mock.timers.enable({apis:['Date','setInterval','setTimeout'],now:100000})
    const view=fixture(t,{native:true,realMount:true})
    await settle();t.mock.timers.tick(1000);await settle()
    assert.equal(view.state.startupLoading,true)
    assert.equal(view.messages.filter(m=>m.type==='overlay_ready').length,0)
    const context=(progress,sequence,sceneReady=false)=>({factoryId:'factory_a',viewId:'factory_overview',sceneReady,
        startupLoading:{loadId:'native-load',sequence,progress,step:'井式炉',detail:'精确拾取索引 64/120'}})
    await view.state.handleRuntimeMessage({type:'dashboard_context_changed',payload:context(44,1)})
    assert.equal(view.state.startupProgress,44);assert.match(view.state.startupStep,/64\/120/)
    await view.state.handleRuntimeMessage({type:'dashboard_context_changed',payload:{sceneReady:true}})
    assert.equal(view.state.startupLoading,true,'legacy UI fallback must not finish native loading')
    await view.state.handleRuntimeMessage({type:'dashboard_context_changed',payload:context(100,2,true)})
    assert.equal(view.state.startupLoading,false)
    assert.deepEqual(view.messages.filter(m=>m.type==='overlay_ready'),[{type:'overlay_ready',pageReady:true,nativeSceneReady:true,loadId:'native-load'}])
    assert.ok(view.progress.every(p=>p.source==='native'),'web 8/31/67 must not overwrite model progress')
    assert.equal(view.progress.at(-1).progress,100)
})

test('returning from designer revalidates the published navigation sources and factory name once, without publishing drafts', async t => {
    const navigation=content=>({document:{widgets:[{id:'nav',type:'navigation',content}],scene:{views:[]}}})
    const view=fixture(t,{settings:{factory_name:'天津工厂'},platform:navigation({projectLabel:'天津工厂',statusText:'实时采集异常'})})
    await settle();const state=view.state
    state.startupLoading=false;state.hostConnected=true
    assert.equal(state.navigationCopy(state.navigationWidgets[0]).projectLabel,'天津工厂')
    state.handleHostMessage({data:{type:'overlay_host_state',visible:false}})
    view.setConfig({settings:{factory_name:'天津智能生产运行中心'},platform:navigation({projectLabel:'天津工厂',statusText:'实时采集异常',projectLabelSource:'factory',statusTextSource:'collection'})})
    const before=view.request.mock.callCount()
    state.handleHostMessage({data:{type:'overlay_host_state',visible:true}})
    await settle()
    assert.equal(state.navigationCopy(state.navigationWidgets[0]).projectLabel,'天津智能生产运行中心')
    assert.equal(state.navigationCopy(state.navigationWidgets[0]).statusText,state.dataStore.plcStatusText.value)
    const reads=()=>view.request.mock.calls.slice(before).filter(c=>String(c.arguments[0]).endsWith('/config'))
    assert.equal(reads().length,1)
    assert.equal(reads()[0].arguments[1].headers['X-Factory-ID'],'factory_a')
    state.handleHostMessage({data:{type:'overlay_host_state',visible:true}});await settle()
    assert.equal(reads().length,1,'ordinary host context ticks must not poll the full configuration')
    assert.ok(!view.request.mock.calls.slice(before).some(c=>/platform\/(releases|designer\/draft)/.test(String(c.arguments[0]))))
})

test('live overlay provides one shared clock without ticking scalar props in the HUD template', async t => {
    const view = fixture(t); await settle()
    const clock = view.provides[WidgetClockKey]
    assert.ok(clock && typeof clock.value === 'number')
    clock.value = 123456; assert.equal(view.state.playbackNow, 123456)
    assert.doesNotMatch(descriptor.template.content, /:playback-now\s*=/,
        'forwarding the raw ticking scalar would force every HUD card to re-render')
})

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

test('native device pointer sweeps preserve overlay content/input-map identities without clock ticks or HTTP', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 })
    const view = fixture(t); await settle()
    const state = view.state
    Object.assign(state.runtimeContext, { factoryId:'pit', viewId:'factory_overview', viewMode:'factory', sceneReady:true })
    const hover = x => ({ type:'device_hover_changed', payload:{ factoryId:'pit', viewId:'factory_overview',
        hoveredDeviceId:'old', deviceHoverPointer:{ x, y:.4, visible:true } } })
    await state.handleRuntimeMessage(hover(.2)); await nextTick()
    const content = state.tooltipContext, target = state.tooltipContentTarget, points = state.pointValues
    const devices = state.playbackDevices, calls = view.request.mock.callCount(), clock = state.playbackNow
    for (let index = 0; index < 120; index++) {
        const x = .2 + index / 500
        const pending = state.handleRuntimeMessage(hover(x))
        assert.equal(state.getTooltipPointer().x, x, 'position is available before awaiting the message promise')
        await pending; await nextTick()
        assert.equal(state.tooltipContext, content, 'pointermove must not normalize all owned point maps')
        assert.equal(state.tooltipContentTarget, target)
        assert.equal(state.pointValues, points)
        assert.equal(state.playbackDevices, devices)
    }
    assert.equal(view.request.mock.callCount(), calls)
    assert.equal(state.playbackNow, clock)
    assert.equal(state.tooltipContext.hover.device.name, 'Old device')
    assert.equal(state.runtimeContext.deviceId, '', 'hover must not replace the selected navigation device')
    assert.match(descriptor.template.content, /:pointer-source="getTooltipPointer"/)
    assert.doesNotMatch(descriptor.template.content, /:pointer="tooltipTarget\.pointer"|v-if="tooltipTarget &&/)
})

test('part pointer sweeps keep owned descriptors/readings stable and reject late previous-device or view samples', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 })
    const view = fixture(t); await settle()
    const state = view.state
    state.applyRuntimeContext({ factoryId:'pit', viewId:'device_detail', viewMode:'device', deviceId:'old', sceneReady:true,
        inspectionEnabled:true, inspectionStage:'exploded', inspectionParts:[{ id:'shell', name:'外壳' }] })
    const hover = (x, changes = {}) => ({ type:'inspection_hover_changed', payload:{ factoryId:'pit', viewId:'device_detail',
        deviceId:'old', inspectionStage:'exploded', inspectionHoveredPartId:'shell',
        inspectionHoverPointer:{ x, y:.4, visible:true }, ...changes } })
    await state.handleRuntimeMessage(hover(.2)); await nextTick()
    const content = state.tooltipContext, target = state.tooltipContentTarget, parts = state.runtimeContext.inspectionParts
    const points = state.pointValues, calls = view.request.mock.callCount(), clock = state.playbackNow
    for (let index = 0; index < 120; index++) {
        const x = .2 + index / 500
        const pending = state.handleRuntimeMessage(hover(x))
        assert.equal(state.getTooltipPointer().x, x)
        await pending; await nextTick()
        assert.equal(state.tooltipContext, content)
        assert.equal(state.tooltipContentTarget, target)
        assert.equal(state.pointValues, points)
        assert.equal(state.runtimeContext.inspectionParts, parts)
    }
    for (const changes of [{ deviceId:'unassigned' }, { viewId:'old_view' }, { inspectionStage:'xray' }]) {
        await state.handleRuntimeMessage(hover(.99, changes))
        assert.notEqual(state.getTooltipPointer().x, .99, 'obsolete native scope cannot move the current tooltip')
        assert.equal(state.tooltipContext, content)
    }
    assert.equal(view.request.mock.callCount(), calls)
    assert.equal(state.playbackNow, clock)
    await state.handleRuntimeMessage(hover(.4, { inspectionHoveredPartId:'', inspectionHoverPointer:{ visible:false } }))
    assert.equal(state.tooltipContentTarget, null)
    assert.equal(state.getTooltipPointer(), null)
})
