import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
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
    setPicking(value) { this.picking = value }
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
  f.vm.setDirection([0, 0, -1]); f.vm.togglePicking(); await nextTick()
  f.calls.previews[0].handlers.onSurface({ position: [4, 1.111, -9], nodeName: 'true_surface' })
  assert.deepEqual(f.vm.row, { position: [4, 1.111, -9], direction: [0, 0, -1], nodeName: 'true_surface' }); assert.equal(f.vm.picking, false)
  assert.match(f.vm.message, /送料基准高度/)
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
  const absent = await fixture(t, { props: { device: device('other') }, ports: empty() })
  absent.vm.setEnabled(true); assert.equal(absent.vm.row, null); assert.equal(absent.vm.effectivePort, null); assert.equal(absent.vm.dirty, false)
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
  const f = await fixture(t, { modelEdit: false, deviceEdit: true })
  const original = JSON.stringify(f.vm.draft); f.vm.setEnabled(false); f.vm.setDirection([0, 0, -1]); assert.equal(JSON.stringify(f.vm.draft), original); assert.equal(await f.vm.save(), false)
  const instance = await fixture(t, { modelEdit: true, deviceEdit: false, props: { device: device() } })
  instance.vm.setEnabled(true); assert.equal(instance.vm.row, null); assert.equal(await instance.vm.save(), false)
})

test('compiled UI has accessible labels, status/errors, explicit suggestions and independent viewport', () => {
  assert.match(source, /aria-label="进出料口 Y 送料高度"/); assert.match(source, /aria-label="进出料口送料高度偏移"/)
  assert.match(source, /focus-visible/); assert.match(source, /role="alert"/); assert.match(source, /role="status"/)
  assert.match(source, /ref="viewport"/); assert.match(source, /应用建议到草稿/); assert.match(source, /恢复模型默认/)
})
