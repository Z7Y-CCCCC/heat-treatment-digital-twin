import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { deferred, installBrowser, settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/LoadingPortEditor.vue', import.meta.url)
const source = await readFile(url, 'utf8')
const { descriptor } = parse(source.replace(/import \{ LoadingPortPreview \} from [^\n]+/, 'const LoadingPortPreview = globalThis.__loadingPortPreview'))
const script = compileScript(descriptor, { id: 'loading-port-test' })
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'loading-port-test', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
let code = script.content
for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) code = code.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], url).href : import.meta.resolve(match[2]))}`)
const { default: Editor } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
Editor.render = () => null
const empty = () => ({ version: 1, inlet: null, outlet: null })
const port = () => ({ position: [10, 2, 3], direction: [1, 0, 0], nodeName: 'mouth' })
const ports = () => ({ ...empty(), inlet: port() })
const model = (id = 'm') => ({ id, name: `模型 ${id}`, file_path: `/${id}.glb`, metadata: { preserve: 123, loadingPorts: ports() } })
const device = (id = 'd') => ({ id, name: `设备 ${id}`, model_type: 'm', instance_config: { preserve: true, loadingPortOverrides: empty() } })
const modelResult = (id, config = ports()) => ({ success: true, model: { ...model(id), metadata: { preserve: 123, loadingPorts: structuredClone(config) } }, ports: structuredClone(config), revision: `revision-${id}` })
const deviceResult = (id, overrides = empty(), base = ports()) => ({ success: true, device: { ...device(id), instance_config: { preserve: true, loadingPortOverrides: structuredClone(overrides) } }, model: { ...model(), metadata: { preserve: 123, loadingPorts: structuredClone(base) } }, ports: base, overrides: structuredClone(overrides), revision: `revision-${id}` })

async function fixture(t, options = {}) {
  const env = installBrowser(t), before = { authenticated: adminSession.authenticated, pagePermissions: adminSession.pagePermissions }
  Object.assign(adminSession, { authenticated: true, pagePermissions: normalizePagePermissions({ models: { view: true, edit: options.modelEdit !== false }, devices: { view: true, edit: options.deviceEdit !== false } }) })
  t.after(() => Object.assign(adminSession, before))
  const calls = { modelLoads: [], deviceLoads: [], modelSaves: [], deviceSaves: [], previews: [], confirmations: [], events: [] }
  const api = {
    getModelLoadingPorts(id, request) { calls.modelLoads.push({ id, request }); return options.loadModel ? options.loadModel(id, request) : Promise.resolve(modelResult(id, options.ports || ports())) },
    getDeviceLoadingPorts(id, request) { calls.deviceLoads.push({ id, request }); return options.loadDevice ? options.loadDevice(id, request) : Promise.resolve(deviceResult(id, options.overrides || empty(), options.ports || ports())) },
    saveModelLoadingPorts(id, body, request) { calls.modelSaves.push({ id, body: structuredClone(body), request }); return options.saveModel ? options.saveModel(id, body) : Promise.resolve({ ...modelResult(id, body.ports), revision: 'saved' }) },
    saveDeviceLoadingPorts(id, body, request) { calls.deviceSaves.push({ id, body: structuredClone(body), request }); return options.saveDevice ? options.saveDevice(id, body) : Promise.resolve({ ...deviceResult(id, body.overrides, options.ports || ports()), revision: 'saved' }) }
  }
  for (const [key, fn] of Object.entries(api)) {
    if (typeof adminApi[key] === 'function') t.mock.method(adminApi, key, fn)
    else { const previous = Object.getOwnPropertyDescriptor(adminApi, key); Object.defineProperty(adminApi, key, { value: fn, configurable: true, writable: true }); t.after(() => previous ? Object.defineProperty(adminApi, key, previous) : delete adminApi[key]) }
  }
  class Preview {
    constructor(container, handlers) { this.handlers = handlers; calls.previews.push(this) }
    async load(record, request) { this.model = record; this.request = request; if (options.previewLoad) return options.previewLoad(record, request); return [{ id: 'mouth', name: 'mouth', path: 'mouth', meshCount: 1 }] }
    dispose() { this.disposed = true }
    setPorts(value, candidate, kind) { this.ports = value; this.suggestion = candidate; this.kind = kind }
    setPicking(value) { this.picking = value; (this.pickHistory ||= []).push(value) }
    selectNode(id) { this.selection = id }
    nodePoint(id, bottom) { return id ? { position: [5, bottom ? 1 : 7, 4], nodeName: id } : null }
    infer() { this.inferred = true; return options.suggestion === null ? null : options.suggestion || { position: [9, 1.25, 0], direction: [1, 0, 0], nodeName: 'mouth_frame' } }
  }
  env.replace('__loadingPortPreview', Preview)
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const root = {}, props = { model: model(), device: null, confirm: async text => { calls.confirmations.push(text); return options.confirm !== false }, onSaved: result => calls.events.push(result), ...options.props }
  let vnode
  const render = async (next = {}) => { Object.assign(props, next); vnode = h(Editor, { ...props }); renderer.render(vnode, root); await nextTick(); await settle() }
  env.beforeRestore(() => renderer.render(null, root))
  await render()
  const f = { get vm() { return vnode.component.setupState }, get exposed() { return vnode.component.exposed }, render, props, calls, unmount: () => renderer.render(null, root) }
  if (options.preview) { f.vm.viewport = {}; await f.vm.preparePreview(); await settle() }
  return f
}

test('loading an unconfigured model never infers, saves or changes metadata automatically', async t => {
  const f = await fixture(t, { ports: empty(), preview: true })
  assert.deepEqual(f.vm.draft, empty()); assert.equal(f.vm.dirty, false)
  assert.equal(f.calls.modelSaves.length, 0); assert.equal(f.calls.previews[0].inferred, undefined)
  assert.equal(f.vm.picking, true); assert.equal(f.calls.previews[0].picking, true)
  assert.equal(f.calls.modelLoads[0].request.signal.aborted, false)
  assert.equal(f.calls.previews[0].model.file_path, '/m.glb')
})

test('model save submits only revision and canonical ports, preserving metadata and raw Y', async t => {
  const f = await fixture(t), original = structuredClone(f.props.model)
  f.vm.draft.inlet.position = [5, 1.234, 8]; f.vm.draft.inlet.direction = [5, 0, 0]
  assert.equal(await f.exposed.savePending(), true)
  assert.deepEqual(f.calls.modelSaves[0].body, { revision: 'revision-m', ports: { ...ports(), inlet: { position: [5, 1.234, 8], direction: [1, 0, 0], nodeName: 'mouth' } } })
  assert.deepEqual(f.props.model, original); assert.equal(f.vm.dirty, false); assert.equal(f.vm.loaded.revision, 'saved'); assert.equal(f.calls.events.length, 1)
})

test('real surface picking retains exact local XYZ and existing horizontal direction', async t => {
  const f = await fixture(t, { preview: true })
  f.vm.setDirection([0, 0, -1]); await nextTick()
  f.calls.previews[0].handlers.onSurface({ position: [4, 1.111, -9], nodeName: 'true_surface', direction: [1, 0, 0] })
  assert.deepEqual(f.vm.row, { position: [4, 1.111, -9], direction: [0, 0, -1], nodeName: 'true_surface' }); assert.equal(f.vm.picking, true)
  assert.match(f.vm.message, /送料基准高度/)
  f.calls.previews[0].handlers.onSurface({ position: [6, 1.222, -8], nodeName: 'new_surface' })
  assert.deepEqual(f.vm.row.position, [6, 1.222, -8]); assert.deepEqual(f.vm.row.direction, [0, 0, -1])
  assert.equal(f.calls.modelSaves.length, 0, 'surface clicks only change a draft')
})

test('choosing either optional port immediately picks one point without enabling or fabricating an origin', async t => {
  const f = await fixture(t, { ports: empty(), preview: true }), runtime = f.calls.previews[0]
  f.vm.setEnabled(true); assert.deepEqual(f.vm.draft, empty()); assert.equal(f.vm.dirty, false)
  f.vm.activeKind = 'outlet'; await nextTick(); assert.equal(runtime.picking, true)
  runtime.handlers.onSurface({ position: [7, 1.75, 4], nodeName: 'outlet_edge', direction: [0, 0, -2] })
  assert.equal(f.vm.draft.inlet, null)
  assert.deepEqual(f.vm.draft.outlet, { position: [7, 1.75, 4], direction: [0, 0, -1], nodeName: 'outlet_edge' })
  assert.equal(f.calls.modelSaves.length, 0)
  f.vm.setEnabled(false); await nextTick(); assert.equal(f.vm.row, null); assert.equal(runtime.picking, true)
  runtime.handlers.onSurface({ position: [8, 1.875, 4], nodeName: 'outlet_lower_edge' })
  assert.deepEqual(f.vm.row.position, [8, 1.875, 4]); assert.equal(f.vm.picking, true)
  assert.equal(await f.vm.save(), true)
  assert.equal(f.calls.modelSaves[0].body.ports.inlet, null)
  assert.deepEqual(Object.keys(f.calls.modelSaves[0].body.ports.outlet).sort(), ['direction', 'nodeName', 'position'])
})

test('invalid point coordinates cannot create or replace a port, and missing surface direction keeps a compatible default', async t => {
  const f = await fixture(t, { ports: empty(), preview: true }), runtime = f.calls.previews[0]
  for (const position of [[1, 2], [1, '', 3], [1, Infinity, 3], [1, NaN, 3]]) runtime.handlers.onSurface({ position })
  assert.equal(f.vm.row, null); assert.equal(f.vm.dirty, false)
  runtime.handlers.onSurface({ position: [5, 2, 7], direction: [0, 1, 0] })
  assert.deepEqual(f.vm.row, { position: [5, 2, 7], direction: [1, 0, 0], nodeName: '' })
  assert.equal(f.calls.modelSaves.length, 0)
})

test('an unset peer copies the selected source position and node into its own draft, never saving automatically', async t => {
  const f = await fixture(t), before = structuredClone(f.props.model)
  f.vm.activeKind='outlet';await nextTick()
  assert.equal(f.vm.otherKind,'inlet');assert.equal(f.vm.canUseOtherPosition,true)
  assert.equal(f.vm.useOtherPosition(),true)
  assert.deepEqual(f.vm.draft.outlet,port());assert.notEqual(f.vm.draft.outlet.position,f.vm.draft.inlet.position)
  assert.notEqual(f.vm.draft.outlet.direction,f.vm.draft.inlet.direction)
  assert.equal(f.calls.modelSaves.length,0);assert.equal(f.vm.dirty,true);assert.match(f.vm.message,/与进料口相同.*保存后生效/)
  f.vm.draft.outlet.position[0]=7;assert.equal(f.vm.draft.inlet.position[0],10)
  assert.equal(f.vm.useOtherPosition(),true);assert.equal(await f.vm.save(),true)
  assert.deepEqual(f.calls.modelSaves[0].body.ports.outlet,port());assert.deepEqual(f.props.model,before)
})

test('same-position shortcuts work in both directions while preserving each existing target direction', async t => {
  const config={...ports(),outlet:{position:[-3,4,-5],direction:[0,0,-1],nodeName:'exit'}}
  const f=await fixture(t,{ports:config})
  assert.equal(f.vm.useOtherPosition(),true)
  assert.deepEqual(f.vm.draft.inlet,{position:[-3,4,-5],direction:[1,0,0],nodeName:'exit'})
  f.vm.draft.inlet.position=[5,1.5,8];f.vm.activeKind='outlet';await nextTick()
  assert.equal(f.vm.useOtherPosition(),true)
  assert.deepEqual(f.vm.draft.outlet,{position:[5,1.5,8],direction:[0,0,-1],nodeName:'exit'})
  assert.deepEqual(f.calls.modelSaves,[])
})

test('instance same-position copies effective peer XYZ relative to the target default and retains target yaw', async t => {
  const config={...ports(),outlet:{position:[-3,4,-5],direction:[0,0,-1],nodeName:'exit'}}
  const overrides={...empty(),inlet:{offset:[2,.5,-1],yawDegrees:90},outlet:{offset:[1,0,0],yawDegrees:30}}
  const f=await fixture(t,{props:{device:device()},ports:config,overrides})
  const source=structuredClone(f.vm.effectivePorts.inlet), original=structuredClone(f.props.model)
  f.vm.activeKind='outlet';await nextTick();assert.equal(f.vm.useOtherPosition(),true)
  assert.deepEqual(f.vm.draft.outlet,{offset:[15,-1.5,7],yawDegrees:30})
  assert.deepEqual(f.vm.effectivePort.position,source.position)
  assert.deepEqual(f.vm.draft.inlet,overrides.inlet);assert.deepEqual(f.vm.basePorts,config)
  assert.equal(f.calls.deviceSaves.length,0);assert.equal(await f.vm.save(),true)
  assert.deepEqual(f.calls.deviceSaves[0].body.overrides.outlet,{offset:[15,-1.5,7],yawDegrees:30})
  assert.equal(f.calls.modelSaves.length,0);assert.deepEqual(f.props.model,original)
})

test('same-position cannot fabricate missing sources or missing instance defaults', async t => {
  const absent=await fixture(t,{ports:empty()})
  assert.equal(absent.vm.otherPort,null);assert.equal(absent.vm.canUseOtherPosition,false)
  assert.equal(absent.vm.useOtherPosition(),false);assert.deepEqual(absent.vm.draft,empty())
  const instance=await fixture(t,{props:{device:device()}})
  instance.vm.activeKind='outlet';await nextTick()
  assert.ok(instance.vm.otherPort);assert.equal(instance.vm.basePort,null)
  assert.equal(instance.vm.canUseOtherPosition,false);assert.equal(instance.vm.useOtherPosition(),false)
  assert.equal(instance.vm.row,null);assert.deepEqual(instance.calls.deviceSaves,[])
})

test('same-position respects readonly, saving, conflict and pending-object guards', async t => {
  const readonly=await fixture(t,{modelEdit:false})
  readonly.vm.activeKind='outlet';await nextTick()
  assert.equal(readonly.vm.canUseOtherPosition,false);assert.equal(readonly.vm.useOtherPosition(),false)
  const f=await fixture(t);f.vm.activeKind='outlet';await nextTick()
  for(const [key,value] of [['saving',true],['loading',true],['conflict',true],['pendingContext',{key:'other'}]]) {
    f.vm[key]=value;assert.equal(f.vm.canUseOtherPosition,false);assert.equal(f.vm.useOtherPosition(),false)
    assert.equal(f.vm.draft.outlet,null);f.vm[key]=key==='pendingContext'?null:false
  }
  f.unmount();assert.equal(f.vm.useOtherPosition(),false);assert.equal(f.vm.draft.outlet,null)
})

test('routine reload is removed from the heading while contextual failure recovery remains accessible', () => {
  const template=descriptor.template.content
  const heading=template.slice(template.indexOf('<header class="editor-heading">'),template.indexOf('</header>'))
  assert.doesNotMatch(heading,/<button|重新读取/)
  assert.match(template,/v-if="conflict \|\| !draft"[^>]*@click="reloadConfig"/)
  assert.match(template,/读取最新配置.*重试读取/)
  assert.match(template,/v-if="otherPort"[^>]*class="same-position"[^>]*:disabled="!canUseOtherPosition"/)
  assert.match(template,/与\{\{ otherKindLabel \}\}同位置/)
})

test('discard after a CAS conflict retains the visible reload path and blocks stale-revision edits until reloaded', async t => {
  const f=await fixture(t,{saveModel:async()=>{throw Object.assign(new Error('changed elsewhere'),{status:409})}})
  f.vm.row.position[1]=8;assert.equal(await f.vm.save(),false)
  assert.equal(f.vm.conflict,true);assert.ok(f.vm.error)
  assert.equal(await f.vm.canLeave(),true)
  assert.equal(f.vm.dirty,false);assert.equal(f.vm.conflict,true);assert.match(f.vm.error,/读取最新配置/)
  f.vm.activeKind='outlet';await nextTick()
  assert.equal(f.vm.canUseOtherPosition,false);assert.equal(f.vm.useOtherPosition(),false)
  assert.equal(await f.vm.save(),false);assert.equal(f.calls.modelSaves.length,1)
  assert.equal(await f.vm.reloadConfig(),true);assert.equal(f.vm.conflict,false);assert.equal(f.vm.error,'')
  assert.equal(f.vm.canUseOtherPosition,true)
})

test('old preview callbacks cannot set a point after an object switch or after unmount', async t => {
  const f = await fixture(t, { ports: empty(), preview: true }), old = f.calls.previews[0]
  await f.render({ model: model('new') }); await settle()
  const latest = f.calls.previews.at(-1); assert.notEqual(latest, old); assert.equal(old.disposed, true)
  old.handlers.onSurface({ position: [99, 99, 99] })
  assert.equal(f.vm.row, null); assert.equal(f.vm.dirty, false)
  latest.handlers.onSurface({ position: [8, 1.25, 3] }); assert.deepEqual(f.vm.row.position, [8, 1.25, 3])
  const before = JSON.parse(JSON.stringify(f.vm.draft)); f.unmount(); latest.handlers.onSurface({ position: [9, 9, 9] })
  assert.deepEqual(f.vm.draft, before)
})

test('a loading preview cannot emit edits and becomes continuously pickable only after the model is ready', async t => {
  const pending = deferred(), f = await fixture(t, { ports: empty(), previewLoad: () => pending.promise })
  f.vm.viewport = {}; const work = f.vm.preparePreview(); await nextTick()
  const runtime = f.calls.previews[0]; assert.ok(runtime); assert.equal(f.vm.previewLoading, true); assert.equal(f.vm.picking, false)
  runtime.handlers.onSurface({ position: [8, 8, 8] }); assert.equal(f.vm.row, null)
  pending.resolve([{ id: 'mouth', name: 'mouth', path: 'mouth', meshCount: 1 }]); await work; await nextTick()
  assert.equal(runtime.picking, true)
  runtime.handlers.onSurface({ position: [4, 1.25, 2] }); assert.deepEqual(f.vm.row.position, [4, 1.25, 2])
})

test('node selection is nonmutating; center/bottom helpers explicitly warn they are not feed height', async t => {
  const f = await fixture(t, { preview: true })
  f.vm.selectedNode = 'mouth'; await nextTick(); assert.equal(f.vm.dirty, false); assert.equal(f.calls.previews[0].selection, 'mouth')
  f.vm.useNode(false); assert.equal(f.vm.row.position[1], 7); assert.match(f.vm.message, /不代表送料高度/)
  f.vm.useNode(true); assert.equal(f.vm.row.position[1], 1); assert.match(f.vm.message, /不一定是送料轨道高度/)
})

test('structure suggestions require explicit application and save, including on absent ports', async t => {
  const f = await fixture(t, { ports: empty(), preview: true })
  f.vm.readSuggestion(); assert.equal(f.vm.dirty, false); assert.equal(f.vm.row, null); assert.equal(f.calls.modelSaves.length, 0)
  assert.equal(f.vm.suggestion.position[1], 1.25)
  f.vm.applySuggestion(); assert.equal(f.vm.dirty, true); assert.equal(f.vm.row.nodeName, 'mouth_frame')
  assert.equal(await f.exposed.savePending(), true); assert.equal(f.calls.modelSaves[0].body.ports.inlet.position[1], 1.25)
  f.vm.activeKind = 'outlet'; await nextTick(); assert.equal(f.vm.suggestion, null)
})

test('direction angle uses Three Y-positive rotation and invalid empty numeric inputs cannot save', async t => {
  const f = await fixture(t)
  f.vm.setAngle(90); assert.ok(Math.abs(f.vm.row.direction[0]) < 1e-10); assert.equal(f.vm.row.direction[2], -1)
  const old = [...f.vm.row.direction]; f.vm.setAngle(''); assert.deepEqual(f.vm.row.direction, old); assert.match(f.vm.error, /有限数字/)
  f.vm.row.position[1] = ''; assert.equal(f.vm.validation.valid, false); assert.equal(await f.vm.save(), false); assert.equal(f.calls.modelSaves.length, 0)
})

test('instance mode applies offsets and yaw to model defaults without saving model metadata', async t => {
  const f = await fixture(t, { props: { device: device() }, preview: true }), original = structuredClone(f.props.model)
  assert.equal(f.vm.row, null); assert.deepEqual(f.vm.effectivePort, port())
  f.vm.setEnabled(true); f.vm.row.offset = [1, .25, -2]; f.vm.row.yawDegrees = 90
  assert.deepEqual(f.vm.effectivePort.position, [11, 2.25, 1]); assert.ok(Math.abs(f.vm.effectivePort.direction[0]) < 1e-10); assert.equal(f.vm.effectivePort.direction[2], -1)
  assert.equal(await f.exposed.savePending(), true); assert.deepEqual(f.calls.deviceSaves[0].body, { revision: 'revision-d', overrides: { ...empty(), inlet: { offset: [1, .25, -2], yawDegrees: 90 } } })
  assert.equal(f.calls.modelSaves.length, 0); assert.deepEqual(f.props.model, original); assert.equal(f.vm.dirty, false)
})

test('instance restore is a null override and an absent model port can never be fabricated', async t => {
  const overrides = { ...empty(), inlet: { offset: [1, 2, 3], yawDegrees: 30 } }
  const f = await fixture(t, { props: { device: device() }, overrides })
  f.vm.setEnabled(false); assert.deepEqual(f.vm.effectivePort, port()); assert.equal(await f.vm.save(), true)
  assert.equal(f.calls.deviceSaves[0].body.overrides.inlet, null)
  const absent = await fixture(t, { props: { device: device('other') }, ports: empty(), preview: true })
  absent.vm.setEnabled(true); assert.equal(absent.vm.row, null); assert.equal(absent.vm.effectivePort, null); assert.equal(absent.vm.dirty, false)
  assert.equal(absent.vm.picking, false)
  absent.calls.previews[0].handlers.onSurface({ position: [1, 2, 3] }); assert.equal(absent.vm.row, null)
  assert.equal(absent.vm.usePoint({ position: [1, 2, 3] }), false); assert.match(absent.vm.message, /可以跳过/)
  assert.equal(absent.calls.deviceSaves.length, 0)
})

test('device surface clicks directly calculate local offset and preserve default or existing override direction', async t => {
  const f = await fixture(t, { props: { device: device() }, preview: true }), runtime = f.calls.previews[0]
  assert.equal(f.vm.row, null); assert.equal(runtime.picking, true)
  runtime.handlers.onSurface({ position: [12, 2.5, 1], nodeName: 'unused_in_override', direction: [0, 0, -1] })
  assert.deepEqual(f.vm.row, { offset: [2, .5, -2], yawDegrees: 0 })
  assert.deepEqual(f.vm.effectivePort.position, [12, 2.5, 1]); assert.deepEqual(f.vm.effectivePort.direction, port().direction)
  f.vm.row.yawDegrees = 45
  const direction = [...f.vm.effectivePort.direction]
  runtime.handlers.onSurface({ position: [13, 2.75, -1], direction: [-1, 0, 0] })
  assert.deepEqual(f.vm.row, { offset: [3, .75, -4], yawDegrees: 45 }); assert.deepEqual(f.vm.effectivePort.direction, direction)
  assert.equal(await f.vm.save(), true); assert.equal(f.calls.modelSaves.length, 0)
  assert.deepEqual(f.calls.deviceSaves[0].body, { revision: 'revision-d', overrides: { ...empty(), inlet: { offset: [3, .75, -4], yawDegrees: 45 } } })
  assert.deepEqual(f.props.model.metadata.loadingPorts, ports())
  f.vm.setEnabled(false); await nextTick(); assert.deepEqual(f.vm.effectivePort, port()); assert.equal(runtime.picking, true)
  runtime.handlers.onSurface({ position: [11, 2.125, 3] }); assert.deepEqual(f.vm.row, { offset: [1, .125, 0], yawDegrees: 0 })
})

test('busy saves suspend clicks and resume automatic picking, while conflicts and pending object switches stay protected', async t => {
  const pending = deferred(), f = await fixture(t, { preview: true, saveModel: () => pending.promise }), runtime = f.calls.previews[0]
  runtime.handlers.onSurface({ position: [10, 3, 3] }); const work = f.vm.save(); await nextTick()
  assert.equal(runtime.picking, false); runtime.handlers.onSurface({ position: [88, 88, 88] }); assert.deepEqual(f.vm.row.position, [10, 3, 3])
  pending.resolve({ ...modelResult('m', { ...ports(), inlet: { ...port(), position: [10, 3, 3] } }), revision: 'saved' })
  assert.equal(await work, true); await nextTick(); assert.equal(runtime.picking, true)
  runtime.handlers.onSurface({ position: [10, 4, 3] }); await f.render({ model: model('other') })
  assert.equal(runtime.picking, false); runtime.handlers.onSurface({ position: [77, 77, 77] }); assert.deepEqual(f.vm.row.position, [10, 4, 3])
  const conflicted = await fixture(t, { preview: true, saveModel: async () => ({ success: false, status: 409 }) })
  conflicted.vm.row.position[1] = 9; assert.equal(await conflicted.vm.save(), false); await nextTick()
  assert.equal(conflicted.vm.picking, false)
  conflicted.calls.previews[0].handlers.onSurface({ position: [66, 66, 66] }); assert.equal(conflicted.vm.row.position[1], 9)
  conflicted.vm.setEnabled(false); assert.equal(conflicted.vm.row.position[1], 9, 'clearing cannot bypass a CAS conflict')
})

test('CAS conflicts and ordinary failures retain drafts, old revision and failed success responses', async t => {
  const f = await fixture(t, { saveModel: async () => { throw Object.assign(Error('配置版本冲突'), { status: 409 }) } })
  f.vm.row.position[1] = 99; assert.equal(await f.vm.save(), false); assert.equal(f.vm.row.position[1], 99); assert.equal(f.vm.loaded.revision, 'revision-m'); assert.equal(f.vm.dirty, true); assert.equal(f.vm.conflict, true); assert.equal(f.calls.events.length, 0)
  const failed = await fixture(t, { saveModel: async () => ({ success: false, error: '网络故障' }) })
  failed.vm.row.position[1] = 66; assert.equal(await failed.vm.save(), false); assert.equal(failed.vm.row.position[1], 66); assert.match(failed.vm.error, /草稿已保留/)
})

test('returned CAS errors retain structured code/status and block retries until reload, regardless of wording', async t => {
  for (const failure of [
    { success: false, code: 'LOADING_PORT_CONFLICT', error: '配置已更新' },
    { success: false, status: 409, error: '请求无法完成' }
  ]) {
    const f = await fixture(t, { saveModel: async () => failure })
    f.vm.row.position[1] = 99
    assert.equal(await f.vm.save(), false); assert.equal(f.vm.conflict, true); assert.equal(f.vm.dirty, true)
    assert.equal(f.vm.row.position[1], 99); assert.equal(f.vm.loaded.revision, 'revision-m'); assert.equal(f.calls.events.length, 0)
    assert.match(f.vm.error, /其他管理员修改/)
    assert.equal(await f.vm.save(), false); assert.equal(f.calls.modelSaves.length, 1, 'CAS retry must wait for an explicit reload')
    assert.equal(await f.vm.reloadConfig(), true); assert.equal(f.vm.conflict, false); assert.equal(f.vm.dirty, false)
  }
  const ordinary = await fixture(t, { saveModel: async () => ({ success: false, status: 503, code: 'SERVICE_UNAVAILABLE', error: '配置版本检查服务正在维护' }) })
  ordinary.vm.row.position[1] = 7; assert.equal(await ordinary.vm.save(), false); assert.equal(ordinary.vm.conflict, false, 'ordinary errors must not be classified by message text')
})

test('model changes abort old reads and late responses cannot replace the latest model', async t => {
  const first = deferred()
  const f = await fixture(t, { loadModel: id => id === 'm' ? first.promise : Promise.resolve(modelResult(id)) })
  await f.render({ model: model('new') }); assert.equal(f.calls.modelLoads[0].request.signal.aborted, true)
  first.resolve(modelResult('m')); await settle(); assert.equal(f.vm.loaded.model.id, 'new'); assert.equal(f.vm.context.model.id, 'new')
})

test('exposed busy tracks configuration reads and writes for parent navigation guards', async t => {
  const reading = deferred(), writing = deferred()
  const f = await fixture(t, { loadModel: () => reading.promise, saveModel: () => writing.promise })
  assert.equal(f.exposed.busy.value, true)
  reading.resolve(modelResult('m')); await settle(); assert.equal(f.exposed.busy.value, false)
  f.vm.row.position[1] = 8; const work = f.vm.save(); assert.equal(f.exposed.busy.value, true)
  writing.resolve({ ...modelResult('m', { ...ports(), inlet: { ...port(), position: [10, 8, 3] } }), revision: 'saved' })
  assert.equal(await work, true); assert.equal(f.exposed.busy.value, false)
})

test('dirty identity changes preserve the current object and draft until an explicit discard', async t => {
  const f = await fixture(t, { confirm: false })
  f.vm.row.position[1] = 7; await f.render({ model: model('other') })
  assert.equal(f.vm.context.model.id, 'm'); assert.equal(f.vm.pendingContext.model.id, 'other'); assert.equal(f.vm.row.position[1], 7); assert.equal(f.calls.modelLoads.length, 1)
  assert.equal(await f.exposed.canLeave(), false); assert.equal(f.vm.dirty, true)
  assert.equal(f.exposed.discardPending(), true); await settle(); assert.equal(f.vm.loaded.model.id, 'other'); assert.equal(f.vm.dirty, false)
})

test('accepted leave discards only after confirmation; duplicate saves and switching during save bind the old identity', async t => {
  const f = await fixture(t); f.vm.row.position[1] = 7
  assert.equal(await f.exposed.canLeave(), true); assert.equal(f.vm.dirty, false); assert.equal(f.calls.confirmations.length, 1)
  const pending = deferred(), saving = await fixture(t, { saveModel: () => pending.promise })
  saving.vm.row.position[1] = 8; const work = saving.vm.save(); assert.equal(await saving.vm.save(), false)
  await saving.render({ model: model('other') }); assert.equal(await saving.exposed.canLeave(), false); assert.equal(saving.calls.modelSaves[0].id, 'm')
  pending.resolve({ ...modelResult('m', { ...ports(), inlet: { ...port(), position: [10, 8, 3] } }), revision: 'saved' }); assert.equal(await work, true); await settle()
  assert.equal(saving.calls.events[0].model.id, 'm'); assert.equal(saving.vm.loaded.model.id, 'other')
})

test('accepting a pending object switch loads it exactly once after the discard confirmation', async t => {
  const f = await fixture(t)
  f.vm.row.position[1] = 8; await f.render({ model: model('other') })
  await f.vm.acceptPendingContext(); await settle()
  assert.equal(f.vm.context.model.id, 'other'); assert.equal(f.calls.modelLoads.length, 2)
})

test('unmount cancels requests and disposes preview; late saves never emit', async t => {
  const pending = deferred(), f = await fixture(t, { preview: true, saveModel: () => pending.promise })
  f.vm.row.position[1] = 9; const work = f.vm.save(); f.unmount()
  assert.equal(f.calls.modelSaves[0].request.signal.aborted, true); assert.equal(f.calls.previews[0].request.signal.aborted, true); assert.equal(f.calls.previews[0].disposed, true)
  pending.resolve(modelResult('m')); assert.equal(await work, false); assert.equal(f.calls.events.length, 0)
})

test('model and instance permissions are separate and readonly handlers cannot make edits', async t => {
  const f = await fixture(t, { modelEdit: false, deviceEdit: true, preview: true })
  const original = JSON.stringify(f.vm.draft); f.vm.setEnabled(false); f.vm.setDirection([0, 0, -1]); assert.equal(JSON.stringify(f.vm.draft), original); assert.equal(await f.vm.save(), false)
  assert.equal(f.vm.picking, false); f.calls.previews[0].handlers.onSurface({ position: [1, 2, 3] }); assert.equal(JSON.stringify(f.vm.draft), original)
  const instance = await fixture(t, { modelEdit: true, deviceEdit: false, props: { device: device() } })
  instance.vm.setEnabled(true); assert.equal(instance.vm.row, null); assert.equal(await instance.vm.save(), false)
})

test('compiled UI has accessible labels, status/errors, explicit suggestions and independent viewport', () => {
  assert.match(source, /aria-label="进出料口 Y 送料高度"/); assert.match(source, /aria-label="进出料口送料高度偏移"/)
  assert.match(source, /focus-visible/); assert.match(source, /role="alert"/); assert.match(source, /role="status"/)
  assert.match(source, /ref="viewport"/); assert.match(source, /应用建议到草稿/); assert.match(source, /恢复模型默认/)
  const ordinary = descriptor.template.content.slice(descriptor.template.content.indexOf('<div class="config-panel">'), descriptor.template.content.indexOf('<details class="advanced-panel">'))
  assert.doesNotMatch(ordinary, /v-model\.number|type="checkbox"|type="number"|node-assistant|direction-buttons/)
  assert.match(ordinary, /单个送料基准点|单点/); assert.match(ordinary, /可跳过/); assert.match(ordinary, /重新选点/); assert.match(ordinary, /清除选点/); assert.match(ordinary, /保存配置/)
  assert.doesNotMatch(descriptor.template.content, /<details[^>]*\sopen(?:\s|>)/)
  assert.doesNotMatch(descriptor.template.content, /取消表面定位|点击模型表面定位/)
  const fonts = [...descriptor.styles[0].content.matchAll(/font-size:calc\((\d+)px \* var\(--admin-font-scale,\s*1\)\)/g)].map(match => Number(match[1]))
  assert.equal(descriptor.styles[0].scoped, true); assert.ok(fonts.length >= 15); assert.ok(fonts.every(size => size >= 13))
  assert.match(descriptor.styles[0].content, /loading-port-editor\{[^}]*font-size:calc\(15px/)
})

test('point-picking guidance stays outside the canvas so it cannot hide the model upper edge', () => {
  const template = descriptor.template.content
  assert.ok(template.indexOf('class="pick-tip"') < template.indexOf('class="preview-stage"'))
  const stage = template.slice(template.indexOf('class="preview-stage"'), template.indexOf('class="preview-caption"'))
  assert.doesNotMatch(stage, /class="pick-tip"/)
  const compiled = compileStyle({ source: descriptor.styles[0].content, filename: url.pathname, id: 'data-v-loading-port-test' })
  assert.deepEqual(compiled.errors, [])
  let tipStyle
  compiled.rawResult.root.walkRules(rule => { if (rule.selector === '.pick-tip') tipStyle = rule })
  assert.ok(tipStyle)
  const values = Object.fromEntries(tipStyle.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  assert.equal(values.position, undefined, 'guidance must occupy normal flow, not cover model geometry')
  assert.equal(values['pointer-events'], 'none')
})

test('narrow editor containers stack full-width preview below controls even inside a wide admin window', () => {
  const compiled = compileStyle({ source: descriptor.styles[0].content, filename: url.pathname, id: 'data-v-loading-port-test' })
  assert.deepEqual(compiled.errors, [])
  let rootStyle, container, fallback
  compiled.rawResult.root.walkRules(rule => { if (rule.selector === '.loading-port-editor') rootStyle = rule })
  compiled.rawResult.root.walkAtRules('container', rule => { if (rule.params === 'loading-port-editor (max-width:850px)') container = rule })
  compiled.rawResult.root.walkAtRules('media', rule => { if (rule.params === '(max-width:850px)') fallback = rule })
  const values = rule => Object.fromEntries(rule.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))
  assert.equal(values(rootStyle)['container-type'], 'inline-size')
  assert.equal(values(rootStyle)['container-name'], 'loading-port-editor')
  assert.ok(container, '629px content in a 1024px window must use actual component width')
  assert.ok(fallback, 'retain the window-based fallback for older browsers')
  for (const responsive of [container, fallback]) {
    const rules = new Map(responsive.nodes.filter(node => node.type === 'rule').map(rule => [rule.selector, values(rule)]))
    assert.equal(rules.get('.editor-body')['grid-template-columns'], 'minmax(0,1fr)')
    assert.equal(rules.get('.editor-body').flex, 'none', 'stacked body must grow naturally so save controls stay reachable')
    assert.equal(rules.get('.config-panel')['border-right'], '0')
    assert.equal(rules.get('.preview-stage')['min-height'], '400px')
    assert.equal(rules.get('.preview-panel')['min-height'], '460px')
    for (const style of rules.values()) assert.notEqual(style.overflow, 'hidden', 'do not clip natural vertical scrolling')
  }
  assert.equal(values(rootStyle).height, undefined)
  assert.doesNotMatch(descriptor.template.content, /<details[^>]*\sopen(?:\s|>)/)
})
