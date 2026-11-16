import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { loadingPortRegionFromSurfaces } from '../src/three/loadingPortRegion.js'
import { installBrowser, settle } from './helpers.mjs'

async function memoryComponent(name, replacements = []) {
  const url = new URL(`../src/views/admin/components/${name}.vue`, import.meta.url)
  const source = await readFile(url, 'utf8')
  let replaced = source
  for (const [pattern, value] of replacements) replaced = replaced.replace(pattern, value)
  const { descriptor } = parse(replaced)
  const script = compileScript(descriptor, { id: name })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: name, compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({ source: style.content, filename: url.pathname, id: name }).errors, [])
  let code = script.content
  for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) code = code.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], url).href : import.meta.resolve(match[2]))}`)
  const { default: component } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  component.render = () => null
  return { component, source }
}
const editor = await memoryComponent('LoadingPortEditor', [[/import \{ LoadingPortPreview \} from [^\n]+/, 'const LoadingPortPreview = globalThis.__loadingPortPreview']])
const workspace = await memoryComponent('LoadingPortWorkspace', [[/import LoadingPortEditor from [^\n]+/, 'const LoadingPortEditor = {}'], [/import DockingCalibration from [^\n]+/, 'const DockingCalibration = {}']])
const empty = () => ({ version: 1, inlet: null, outlet: null })
const snapshot = value => JSON.parse(JSON.stringify(value))
const basePort = () => loadingPortRegionFromSurfaces(
  { position: [-.865, 1.22, -.6], surfaceNormal: [-1, 0, 0], nodeName: 'mouth' },
  { position: [-.865, 2.22, .6], surfaceNormal: [-1, 0, 0], nodeName: 'mouth' }
)
const ports = () => ({ version: 1, inlet: basePort(), outlet: basePort() })
const legacyPorts = () => ({ version: 1, inlet: { position: [-.865, 1.22, 0], direction: [-1, 0, 0], nodeName: 'mouth' }, outlet: { position: [.865, 1.22, 0], direction: [1, 0, 0], nodeName: 'mouth' } })
const changedRegion = () => loadingPortRegionFromSurfaces(
  { position: [1, .75, 2], surfaceNormal: [0, 0, 1], nodeName: 'mouth' },
  { position: [2, 1.75, 2], surfaceNormal: [0, 0, 1], nodeName: 'mouth' }
)
const model = () => ({ id: 'm', name: '备料台型号', metadata: { preserve: 'model-metadata', loadingPorts: ports() } })
const overrides = () => ({ version: 1, inlet: { offset: [0, .02422951, .02012465], yawDegrees: -180, region: basePort().region }, outlet: { offset: [.1, .2, .3], yawDegrees: 35 } })
const device = (id = 'bl2', value = overrides()) => ({ id, name: id === 'bl2' ? '2号备料台' : id, model_type: 'm', instance_config: { preserve: 'device-extra', loadingPortOverrides: value } })
const signals = () => ({ version: 1, inletPointId: 'in', outletPointId: 'out' })
const cart = () => ({ version: 1, kind: 'rotating', presentation: 'model', turntableNodeName: 'Upper' })

async function mount(t, component, initialProps) {
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const root = {}, props = { ...initialProps }
  let vnode
  const render = async (changes = {}) => { Object.assign(props, changes); vnode = h(component, { ...props }); renderer.render(vnode, root); await nextTick(); await settle() }
  t.after(() => renderer.render(null, root))
  await render()
  return { get vm() { return vnode.component.setupState }, get exposed() { return vnode.component.exposed }, props, render }
}
async function editorFixture(t, options = {}) {
  const env = installBrowser(t), before = { authenticated: adminSession.authenticated, pagePermissions: adminSession.pagePermissions }
  Object.assign(adminSession, { authenticated: true, pagePermissions: normalizePagePermissions({ models: { view: true, edit: true }, devices: { view: true, edit: options.edit !== false } }) })
  t.after(() => Object.assign(adminSession, before))
  env.replace('__loadingPortPreview', class {})
  const calls = { modelSaves: [], deviceSaves: [], confirmations: [] }
  const base = options.ports || ports(), modelRecord = config => ({ ...model(), metadata: { ...model().metadata, loadingPorts: structuredClone(config || base) } })
  const result = (id = 'bl2', value = options.overrides || overrides(), boundSignals = signals(), transfer = cart()) => ({ success: true, device: device(id, structuredClone(value)), model: modelRecord(), ports: structuredClone(base), overrides: structuredClone(value), revision: 'revision-device', signals: structuredClone(boundSignals), signalPoints: options.missingPoints ? [] : [{ id: 'in' }, { id: 'out' }, { id: 'in-new' }], cartSupported: true, cartTransfer: structuredClone(transfer) })
  t.mock.method(adminApi, 'getDeviceLoadingPorts', async id => result(id))
  t.mock.method(adminApi, 'getModelLoadingPorts', async () => ({ success: true, model: modelRecord(), ports: structuredClone(base), revision: 'revision-model' }))
  t.mock.method(adminApi, 'saveModelLoadingPorts', async (id, body) => { calls.modelSaves.push({ id, body: structuredClone(body) }); return { success: true, model: modelRecord(body.ports), ports: structuredClone(body.ports), revision: 'saved-model' } })
  t.mock.method(adminApi, 'saveDeviceLoadingPorts', async (id, body) => { calls.deviceSaves.push({ id, body: structuredClone(body) }); return { ...result(id, body.overrides, body.signals || signals(), body.cartTransfer || cart()), revision: 'saved' } })
  const f = await mount(t, editor.component, { model: model(), device: device(), confirm: async message => { calls.confirmations.push(message); return options.confirm !== false }, ...options.props })
  return { ...f, get vm() { return f.vm }, calls }
}

test('model region is the same actual opening for devices with only legacy offsets/yaw, without read-time writes', async t => {
  const old = overrides(); delete old.inlet.region
  const f = await editorFixture(t, { overrides: old }), before = snapshot(f.vm.draft)
  assert.deepEqual(f.vm.effectivePorts, ports()); assert.equal(f.vm.row.yawDegrees, -180)
  assert.equal(f.vm.hasDirectionOverride, false); assert.equal(f.vm.restoreModelDirection(), false)
  assert.equal(f.vm.dirty, false); assert.deepEqual(f.vm.draft, before)
  assert.equal(f.calls.deviceSaves.length, 0); assert.equal(f.calls.modelSaves.length, 0)
  const instanceGeometry = snapshot(f.vm.effectivePorts)
  await f.render({ device: null }); assert.deepEqual(f.vm.effectivePorts, instanceGeometry)
})

test('explicit device region is itself the actual opening and cannot be shifted by old scalar metadata or model edits', async t => {
  const own = changedRegion(), old = overrides(); old.inlet.region = own.region
  const f = await editorFixture(t, { overrides: old }), before = snapshot(f.vm.draft)
  assert.deepEqual(f.vm.effectivePort, own); assert.equal(f.vm.restoreModelDirection(), false)
  const changedBase = basePort(); changedBase.position[0] += 5; changedBase.region.corners.forEach(point => { point[0] += 5 })
  f.vm.loaded.model.metadata.loadingPorts.inlet = changedBase
  assert.deepEqual(f.vm.basePort.position, changedBase.position)
  assert.deepEqual(f.vm.effectivePort, own); assert.deepEqual(f.vm.draft, before); assert.equal(f.vm.dirty, false)
  assert.equal(f.calls.deviceSaves.length, 0)
})

test('a newly drawn model region survives late point/suggestion helpers and saves exactly as the actual port', async t => {
  const f = await editorFixture(t, { props: { device: null } }), candidate = changedRegion()
  assert.equal(f.vm.useRegion(candidate), true); const before = snapshot(f.vm.draft)
  assert.equal(f.vm.usePoint({ position: [9, 9, 9], direction: [1, 0, 0] }), false)
  f.vm.suggestion = legacyPorts().inlet; f.vm.applySuggestion(); assert.deepEqual(f.vm.draft, before)
  assert.deepEqual(f.vm.effectivePort, candidate); assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.modelSaves, [{ id: 'm', body: { revision: 'revision-model', ports: before } }]); assert.equal(f.calls.deviceSaves.length, 0)
})

test('explicit device-region draft/save keeps the real region and peer, signals and cart without sending unchanged bindings', async t => {
  const f = await editorFixture(t, { confirm: false }), original = snapshot(f.vm.draft), candidate = changedRegion()
  const modelBefore = snapshot(f.vm.loaded.model)
  assert.equal(f.vm.useRegion(candidate), true); const drawn = snapshot(f.vm.draft)
  assert.equal(f.vm.usePoint({ position: [9, 9, 9] }), false); assert.deepEqual(f.vm.draft, drawn)
  assert.deepEqual(f.vm.effectivePort, candidate); assert.deepEqual(f.vm.draft.outlet, original.outlet)
  assert.equal(await f.vm.canLeave(), false); assert.deepEqual(f.vm.draft, drawn); assert.equal(f.calls.deviceSaves.length, 0)
  assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.deviceSaves, [{ id: 'bl2', body: { revision: 'revision-device', overrides: drawn } }]); assert.equal(f.calls.modelSaves.length, 0)
  assert.deepEqual(f.vm.loaded.model, modelBefore); assert.deepEqual(f.vm.signalDraft, signals()); assert.deepEqual(f.vm.cartDraft, cart())
})

test('untouched unavailable site bindings do not force a region edit to rebind PLC points', async t => {
  const f = await editorFixture(t, { missingPoints: true })
  assert.equal(f.vm.useRegion(changedRegion()), true); assert.equal(f.vm.saveProblem, '')
  assert.equal(await f.vm.save(), true); assert.deepEqual(Object.keys(f.calls.deviceSaves[0].body).sort(), ['overrides', 'revision'])
})

test('explicit signal/cart changes retain their fields, while changing then restoring them never writes defaults', async t => {
  const f = await editorFixture(t)
  f.vm.signalDraft.inletPointId = 'in-new'; f.vm.cartDraft.turntableNodeName = 'Upper-new'
  assert.equal(f.vm.useRegion(changedRegion()), true); assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.deviceSaves[0].body.signals, { ...signals(), inletPointId: 'in-new' })
  assert.deepEqual(f.calls.deviceSaves[0].body.cartTransfer, { ...cart(), turntableNodeName: 'Upper-new' })
  const unchanged = await editorFixture(t)
  unchanged.vm.signalDraft.inletPointId = 'in-new'; unchanged.vm.signalDraft.inletPointId = 'in'
  unchanged.vm.cartDraft.turntableNodeName = 'Upper-new'; unchanged.vm.cartDraft.turntableNodeName = 'Upper'
  unchanged.vm.useRegion(changedRegion()); assert.equal(await unchanged.vm.save(), true)
  assert.deepEqual(Object.keys(unchanged.calls.deviceSaves[0].body).sort(), ['overrides', 'revision'])
})

test('legacy point direction compatibility remains advanced-only and preserves its narrow save contract', async t => {
  const old = overrides(); delete old.inlet.region
  const f = await editorFixture(t, { ports: legacyPorts(), overrides: old }), before = snapshot(f.vm.draft)
  assert.equal(f.vm.hasDirectionOverride, true); assert.equal(f.vm.restoreModelDirection(), true)
  const expected = structuredClone(before); expected.inlet.yawDegrees = 0
  assert.deepEqual(f.vm.draft, expected); assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.deviceSaves[0].body, { revision: 'revision-device', overrides: expected }); assert.equal(f.calls.modelSaves.length, 0)
})

test('real-region editing respects permissions/busy/context guards and a null model port remains unconfigured', async t => {
  const readonly = await editorFixture(t, { edit: false }), unchanged = snapshot(readonly.vm.draft)
  assert.equal(readonly.vm.useRegion(changedRegion()), false); assert.deepEqual(readonly.vm.draft, unchanged)
  const f = await editorFixture(t), before = snapshot(f.vm.draft)
  for (const key of ['loading', 'saving', 'conflict']) {
    f.vm[key] = true; assert.equal(f.vm.useRegion(changedRegion()), false); assert.deepEqual(f.vm.draft, before); f.vm[key] = false
  }
  for (const key of ['workspaceBusy', 'dockingPreview']) {
    await f.render({ [key]: true }); assert.equal(f.vm.useRegion(changedRegion()), false); assert.deepEqual(f.vm.draft, before); await f.render({ [key]: false })
  }
  f.vm.pendingContext = { key: 'm:other', model: model(), device: device('other') }
  assert.equal(f.vm.useRegion(changedRegion()), false); assert.deepEqual(f.vm.draft, before); f.vm.pendingContext = null
  const missing = await editorFixture(t, { ports: empty() }), missingBefore = snapshot(missing.vm.draft)
  assert.equal(missing.vm.effectivePort, null); assert.equal(missing.vm.useRegion(changedRegion()), false); assert.deepEqual(missing.vm.draft, missingBefore)
  assert.equal(missing.calls.deviceSaves.length, 0)
})

test('model workspace keeps device selection for region/signals and routes it through both draft guards', async t => {
  const devices = [device(), device('inherited', empty()), { ...device('other-model'), model_type: 'other' }, device('string-config')]
  devices[3].instance_config = JSON.stringify(devices[3].instance_config)
  const f = await mount(t, workspace.component, { model: model(), devices, confirm: () => false })
  assert.deepEqual(f.vm.candidates.map(item => item.id), ['bl2', 'inherited', 'string-config'])
  f.vm.editor = { busy: false, dirty: true, discardPending: () => { throw new Error('declined draft must remain') } }
  assert.equal(await f.vm.chooseDevice('bl2'), false); assert.equal(f.vm.deviceId, '')
  const guards = []
  f.vm.editor = { busy: false, canLeave: () => { guards.push('editor'); return true } }
  f.vm.calibration = { busy: false, canLeave: () => { guards.push('calibration'); return false } }
  assert.equal(await f.vm.chooseDevice('bl2'), false); assert.equal(f.vm.deviceId, '')
  f.vm.calibration.canLeave = () => true
  assert.equal(await f.vm.chooseDevice('bl2'), true); assert.equal(f.vm.selectedDevice.id, 'bl2')
  assert.deepEqual(guards, ['editor', 'calibration', 'editor'])
})

test('ordinary UI shows the actual region without override warnings or extra direction buttons', () => {
  const normalPanel = editor.source.slice(editor.source.indexOf('<div class="config-panel">'), editor.source.indexOf('<details class="advanced-panel">'))
  assert.doesNotMatch(normalPanel, /当前料口来源|方向叠加|port-source-summary|restoreModelDirection|型号默认|相对微调/)
  assert.doesNotMatch(workspace.source, /port-source-note|overrideDevices|不是某台设备实际|模型默认料口位置/)
  assert.match(normalPanel, /框选区域保存后就是实际料口/); assert.match(normalPanel, /effectivePort\.position\[1\]/)
  assert.match(workspace.source, /<option value="">模型料口位置<\/option>/); assert.match(workspace.source, /实际料口与进出料信号/)
  const advanced = editor.source.slice(editor.source.indexOf('<details class="advanced-panel">'))
  assert.match(advanced, /row && !effectivePort\?\.region/); assert.match(advanced, /旧单点方向沿用模型/)
})
