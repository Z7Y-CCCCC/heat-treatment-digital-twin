import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { installBrowser, installSockets, json, settle } from './helpers.mjs'

// These are compiled real SFCs and real Vue effects, with an in-memory renderer.
// The test never launches a browser, application or collector. Optional frozen
// source replay is evidence only; ordinary CI always reads the current checkout.
const repository = fileURLToPath(new URL('../../', import.meta.url))
const baselineDirectory = process.env.TOOLTIP_BASELINE_DIR || ''
const output = process.env.TOOLTIP_WORKLOAD_OUTPUT || ''
const usedSources = [], modules = new Map()
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
function sourceAt(relative) {
  const original = path.join(repository, relative)
  const frozen = baselineDirectory && path.join(baselineDirectory, relative)
  const actual = frozen && existsSync(frozen) ? frozen : original
  const source = readFileSync(actual, 'utf8')
  usedSources.push({ original, actual, sha256:createHash('sha256').update(source).digest('hex') })
  return source
}
function imports(code, relative) {
  return code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => {
    if (!name.startsWith('.')) return `from ${JSON.stringify(import.meta.resolve(name))}`
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), name))
    if (name.endsWith('.vue')) return `from ${JSON.stringify(['frontend/src/runtime/TooltipSurface.vue', 'frontend/src/runtime/WidgetRenderer.vue'].includes(resolved)
      ? sfc(resolved) : moduleUrl('export default { render: () => null }'))}`
    // Replay the frozen tooltip helpers as well, while resolving their unchanged
    // dependencies from the canonical checkout rather than output directories.
    if (['frontend/src/runtime/tooltipRuntime.js', 'frontend/src/runtime/tooltipContext.js'].includes(resolved)) {
      if (baselineDirectory) {
        if (!modules.has(resolved)) modules.set(resolved, moduleUrl(imports(sourceAt(resolved), resolved)))
        return `from ${JSON.stringify(modules.get(resolved))}`
      }
      sourceAt(resolved) // Record the actual canonical helper SHA before it is imported.
    }
    return `from ${JSON.stringify(new URL(`../../${resolved}`, import.meta.url).href)}`
  })
}
function sfc(relative) {
  if (modules.has(relative)) return modules.get(relative)
  let source = sourceAt(relative)
  const kind = relative.endsWith('DashboardOverlay.vue') ? 'overlay' : relative.endsWith('TooltipSurface.vue') ? 'surface' : 'widget'
  source = source.replace('<script setup>', `<script setup>\nimport { onBeforeUpdate as observeWorkloadUpdate } from 'vue'\nobserveWorkloadUpdate(() => { if (globalThis.__tooltipWorkload) globalThis.__tooltipWorkload.updates.${kind}++ })`)
  if (kind === 'overlay') source = source.replace('</script>', '\ndefineExpose({ runtimeContext, handleRuntimeMessage, tooltipContext, pointValues, playbackDevices, playbackNow, dataStore })\n</script>')
  const descriptor = parse(source, { filename:relative }).descriptor
  let code = compileScript(descriptor, { id:`tooltip-workload-${kind}`, inlineTemplate:true }).content
  // CSS transition hooks require a real DOM. Keep the real Vue/SFC subtree,
  // props, effects and content transition component, but disable only its CSS
  // hooks in this memory host (no browser/CSS-frame timing is being measured).
  if (kind === 'widget') code = code.replace('_createVNode(_Transition, { name: "widget-data-fade" }',
    '_createVNode(_Transition, { name: "widget-data-fade", css: false }')
  const url = moduleUrl(imports(code, relative)); modules.set(relative, url)
  return url
}
test.mock.module('../src/runtime/adminSession.js', { namedExports:{
  adminFetch:(...args) => globalThis.fetch(...args),
  adminSession:{ displayAuthenticated:true, permissions:{ view:true }, user:{ username:'fixture' } }
} })
const { default:Overlay } = await import(sfc('frontend/src/views/DashboardOverlay.vue'))

function memoryNode(type, text = '') {
  const node = { type, text, nodeType:type.startsWith('#') ? type === '#text' ? 3 : 8 : 1,
    children:[], props:{}, parent:null, clientWidth:1600, clientHeight:900, style:{} }
  node.matches = selector => selector === '[data-overlay-hit="true"]' ? node.props['data-overlay-hit'] === 'true'
    : selector === '.widget-shell' && String(node.props.class || '').split(' ').includes('widget-shell')
  node.querySelectorAll = selector => node.children.flatMap(child => [...(child.matches?.(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  node.querySelector = selector => node.querySelectorAll(selector)[0] || null
  node.closest = selector => node.matches(selector) ? node : node.parent?.closest(selector) || null
  node.getBoundingClientRect = () => ({ left:0, top:0, width:200, height:80 })
  return node
}

test('real overlay native-pointer workload does not rerender the HUD, input maps or tooltip content', async t => {
  t.mock.timers.enable({ apis:['Date', 'setInterval', 'setTimeout'], now:100000 })
  const environment = installBrowser(t), sockets = installSockets(environment.replace)
  const measurement = { updates:{ overlay:0, surface:0, widget:0 }, styles:{ host:0, tooltipWidget:0, canvas:0, hud:0 },
    scheduledRegionFrames:0, contextReplacements:0, pointMapReplacements:0, deviceMapReplacements:0, requests:0 }
  environment.replace('__tooltipWorkload', measurement)
  environment.replace('Node', { ELEMENT_NODE:1, TEXT_NODE:3 })
  environment.replace('CustomEvent', class { constructor(type) { this.type = type } })
  const frames = new Map(), observers = [], mutations = []
  let frameId = 0
  window.requestAnimationFrame = callback => { measurement.scheduledRegionFrames++; frames.set(++frameId, callback); return frameId }
  window.cancelAnimationFrame = id => frames.delete(id)
  window.innerWidth = 1600; window.innerHeight = 900; window.dispatchEvent = () => {}
  window.getComputedStyle = element => ({ display:'block', visibility:'visible', opacity:'1', ...element.props.style })
  document.documentElement = { style:{} }; document.body = { style:{} }; document.querySelectorAll = () => []
  environment.replace('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  environment.replace('MutationObserver', class {
    constructor(callback) { this.callback = callback; observers.push(this) }
    observe(root) { this.root = root } disconnect() { this.root = null }
  })
  const fixtureDocument = {
    scene:{ defaultViewId:'factory_overview', views:[{ id:'factory_overview', mode:'factory', metadata:{ tooltipTemplates:{ device:'configured-tip' } } }] },
    widgets:Array.from({ length:24 }, (_, index) => ({ id:`hud-${index}`, type:'text', frame:{ x:0, y:index * 20, width:200, height:20 },
      content:{ text:`配置内容 ${index}` }, data:{ mode:'static' } })),
    tooltipTemplates:{ defaults:{ device:'configured-tip' }, templates:[{ id:'configured-tip', kind:'device', canvas:{ width:240, height:180 },
      widgets:Array.from({ length:24 }, (_, index) => ({ id:`tip-${index}`, type:'text', frame:{ x:0, y:index * 6, width:220, height:20 },
        content:{ text:'{value}' }, data:{ mode:'runtime', path:'hover.device.name' } })) }] }
  }
  const definitions = Array.from({ length:100 }, (_, index) => ({ id:`point-${index}`, category:'analog', name:`temp${index}` }))
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).endsWith('/config')) return json({ factoryId:'factory_a', factories:[{ id:'factory_a', enabled:true }], settings:{}, models:[],
      workshops:[{ id:'w', lines:[{ id:'l', devices:[{ id:'a', name:'炉 A', dataPoints:definitions }, { id:'b', name:'炉 B', dataPoints:definitions }] }] }], platform:{ document:fixtureDocument } })
    if (String(url).includes('/events')) return json([])
    return json({ status:'ok', readiness:{ displayReady:true, failures:[] }, components:{} })
  })
  t.mock.method(console, 'log', () => {}); t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {})
  const renderer = createRenderer({
    createElement:type => memoryNode(type), createText:value => memoryNode('#text', value), createComment:value => memoryNode('#comment', value),
    setText:(node, value) => node.text = value,
    setElementText:(node, value) => { node.text = value; node.children = [] },
    parentNode:node => node.parent, nextSibling:node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    patchProp:(node, key, _previous, value) => {
      if (key === 'style') {
        const classes = String(node.props.class || '')
        if (classes.includes('tooltip-surface-widget')) measurement.styles.tooltipWidget++
        else if (classes.includes('tooltip-surface-canvas')) measurement.styles.canvas++
        else if (classes.includes('tooltip-surface')) measurement.styles.host++
        else if (classes.includes('overlay-widget')) measurement.styles.hud++
      }
      node.props[key] = value
    },
    insert(node, parent, anchor = null) {
      if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node)
      node.parent = parent; const index = parent.children.indexOf(anchor)
      if (index < 0) parent.children.push(node); else parent.children.splice(index, 0, node)
      mutations.push({ target:parent, addedNodes:[node], removedNodes:[] })
    },
    remove(node) {
      if (!node.parent) return
      mutations.push({ target:node.parent, addedNodes:[], removedNodes:[node] })
      node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null
    }
  })
  const instance = ref(null), root = memoryNode('root')
  const app = renderer.createApp({ render:() => h(Overlay, { ref:instance }) })
  app.provide(routerKey, { push() {}, replace() {} }); app.provide(routeLocationKey, { query:{} })
  app.mount(root); environment.beforeRestore(() => app.unmount())
  await settle(); t.mock.timers.tick(2000); await settle(); await nextTick()
  function flushGeometry() {
    const changed = mutations.splice(0)
    for (const observer of observers) if (observer.root) observer.callback(changed)
    for (const [id, callback] of [...frames]) { frames.delete(id); callback() }
  }
  flushGeometry()
  const state = instance.value
  Object.assign(state.runtimeContext, { factoryId:'factory_a', viewId:'factory_overview', viewMode:'factory', sceneReady:true })
  state.dataStore.deviceDataMap.a = { analog:Object.fromEntries(definitions.map((point, index) => [point.name, index])), quality:{} }
  await state.handleRuntimeMessage({ type:'device_hover_changed', payload:{ factoryId:'factory_a', viewId:'factory_overview',
    hoveredDeviceId:'a', deviceHoverPointer:{ visible:true, x:.2, y:.3 } } })
  await nextTick(); flushGeometry()
  assert.equal(state.tooltipContext.hover.device.name, '炉 A')
  assert.ok(root.querySelectorAll('.widget-shell').length >= 48, 'both authored HUD and real configured tooltip widgets are mounted')
  const before = JSON.parse(JSON.stringify(measurement)), contexts = new Set([state.tooltipContext])
  const points = state.pointValues, devices = state.playbackDevices, clock = state.playbackNow
  const requestCount = globalThis.fetch.mock.callCount()
  for (let index = 0; index < 120; index++) {
    await state.handleRuntimeMessage({ type:'device_hover_changed', payload:{ factoryId:'factory_a', viewId:'factory_overview',
      hoveredDeviceId:'a', deviceHoverPointer:{ visible:true, x:.2 + (index + 1) / 500, y:.3 } } })
    await nextTick(); flushGeometry()
    contexts.add(state.tooltipContext)
    if (state.pointValues !== points) measurement.pointMapReplacements++
    if (state.playbackDevices !== devices) measurement.deviceMapReplacements++
  }
  measurement.contextReplacements = contexts.size - 1
  measurement.requests = globalThis.fetch.mock.callCount() - requestCount
  const result = { variant:baselineDirectory ? 'frozen-baseline' : 'current', frames:120, authoredHudWidgets:24, authoredTooltipWidgets:24,
    configuredDevices:2, configuredPointDefinitionsPerDevice:100,
    updates:Object.fromEntries(Object.keys(measurement.updates).map(key => [key, measurement.updates[key] - before.updates[key]])),
    stylePatches:Object.fromEntries(Object.keys(measurement.styles).map(key => [key, measurement.styles[key] - before.styles[key]])),
    scheduledRegionFrames:measurement.scheduledRegionFrames - before.scheduledRegionFrames,
    contextReplacements:measurement.contextReplacements, pointMapReplacements:measurement.pointMapReplacements,
    deviceMapReplacements:measurement.deviceMapReplacements, requests:measurement.requests, clockUnchanged:state.playbackNow === clock,
    sourceEvidence:usedSources, scope:'Real compiled SFCs and Vue in-memory renderer; test-only update counters and css:false on content transitions; no browser/CSS-frame/physical-site latency or user-feel measurement.' }
  if (output) { mkdirSync(path.dirname(output), { recursive:true }); writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`) }
  assert.equal(result.requests, 0); assert.equal(result.clockUnchanged, true)
  assert.equal(result.pointMapReplacements, 0); assert.equal(result.deviceMapReplacements, 0)
  if (baselineDirectory) {
    assert.equal(result.updates.overlay, 120, 'the frozen source reproduces whole-overlay cursor fanout')
    assert.equal(result.contextReplacements, 120)
    assert.ok(result.stylePatches.tooltipWidget >= 120 * 24)
  } else {
    assert.equal(result.updates.overlay, 0, 'actual full overlay render effect must not subscribe to pointer samples')
    assert.equal(result.contextReplacements, 0)
    assert.equal(result.updates.widget, 0, 'neither HUD nor configured tooltip widget content is cursor driven')
    assert.equal(result.updates.surface, 120)
    assert.equal(result.stylePatches.host, 120)
    assert.equal(result.stylePatches.tooltipWidget, 0); assert.equal(result.stylePatches.canvas, 0); assert.equal(result.stylePatches.hud, 0)
    assert.equal(result.scheduledRegionFrames, 0)
  }
  assert.equal(sockets.length, 1)
})
