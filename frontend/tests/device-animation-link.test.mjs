import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { adminSession } from '../src/runtime/adminSession.js'
import { cacheFactoryDraft, readFactoryDraft, discardFactoryDrafts } from '../src/runtime/factoryDraftCache.js'
import { deferred, installBrowser, settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/DeviceAnimationLink.vue', import.meta.url), source = await readFile(url, 'utf8')
const { descriptor } = parse(source.replace(/import \{ createDashboardDataStore \} from [^\n]+/, 'const createDashboardDataStore = () => globalThis.__motionUiStore'))
const script = compileScript(descriptor, { id: 'motion-ui-test' })
let compiled = script.content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  const name = match[2], target = name.endsWith('.vue') ? 'data:text/javascript,export default {render:()=>null}' : name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name)
  compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Component.render = () => null
const template = compileTemplate({ source: descriptor.template.content, filename: 'DeviceAnimationLink.vue', id: 'motion-ui-test', compilerOptions: { bindingMetadata: script.bindings } })
assert.deepEqual(template.errors, [])
const templateCode = template.code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
const { render: actualTemplate } = await import(`data:text/javascript;base64,${Buffer.from(templateCode).toString('base64')}`)
const TemplateComponent = { ...Component, render: actualTemplate }
const actions = [{ id: 'clip:door', label: '炉门', kind: 'clip', mode: 'position' }, { id: 'clip:fan', label: '风机', kind: 'clip', mode: 'running' }]
const animation = id => ({ deviceId: id, revision: `revision-${id}`, modelId: 'm', actions, dataItems: directory(id).items.map(item => ({ ...item, motionReady: true, motionError: '' })), config: { version: 1, staleMs: 5000, bindings: [] } })
const pointRows = id => [{ id: `${id}-temp`, device_id: id, name: '炉温', category: 'analog', value_role: 'temp', data_type: 'REAL', access_type: 'READ' }, { id: `${id}-bool`, device_id: id, name: '运行反馈', category: 'status', value_role: 'running', data_type: 'BOOL', access_type: 'READ' }, ...['extended', 'retracted'].map(side => ({ id: `${id}-${side}`, device_id: id, name: side === 'extended' ? '推料到位' : '退回到位', category: 'mechanisms', value_role: side, data_type: 'BOOL', access_type: 'READ' }))]
const directory = id => ({ success: true, categories: [{ id: 'realtime', name: '实时采集' }], tables: [{ id: 'real', name: '设备资料与采集' }, { id: 'external', name: '已接入 MES 数据表' }], items: [
  { id: `temp-${id}`, tableId: 'real', label: '炉温', type: 'number', unit: '℃', sourceType: 'plc', objectScope: 'device', enabled: true, binding: { mode: 'plc', deviceId: id, pointId: `${id}-temp`, pointKey: 'analog.temp' } },
  { id: `bool-${id}`, tableId: 'real', label: '运行反馈', type: 'boolean', sourceType: 'plc', objectScope: 'device', enabled: true, binding: { mode: 'plc', deviceId: id, pointId: `${id}-bool`, pointKey: 'status.running' } },
  { id: `name-${id}`, tableId: 'real', label: '设备名称', type: 'string', sourceType: 'internal', objectScope: 'device', enabled: true, binding: { mode: 'runtime', path: 'deviceInfo.name' } },
  { id: `mes-${id}`, tableId: 'external', label: 'MES 运行状态', type: 'string', sourceType: 'dataset', objectScope: 'device', enabled: true, binding: { mode: 'dataset', datasetId: 'MES', datasetField: 'status' } },
  { id: 'unavailable-part', type: 'string', sourceType: 'internal', objectScope: 'part', enabled: true, binding: { mode: 'runtime', path: 'selectedPart.name' } },
  ...['extended', 'retracted'].map(side => ({ id: `${side}-${id}`, tableId: 'real', label: side === 'extended' ? '推料到位' : '退回到位', type: 'boolean', sourceType: 'plc', objectScope: 'device', enabled: true, endpointReady: true, binding: { mode: 'plc', deviceId: id, pointId: `${id}-${side}`, pointKey: `mechanisms.${side}` } }))
] })

// Native controls rendered by the actual compiled SFC, entirely in memory.
// This is not a browser/Computer Use session and every API is mocked below.
function memoryHost() {
  const makeNode = (tag, text = '') => ({ tag, text, props: {}, children: [], parent: null, value: '', checked: false, listeners: new Map(),
    get options() { return this.children.filter(node => node.tag === 'option') },
    addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler) },
    removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler) },
    getRootNode() { let node = this; while (node.parent) node = node.parent; return node },
    setAttribute(key, value) { this.props[key] = value }, removeAttribute(key) { delete this.props[key] } })
  const root = makeNode('#root')
  const remove = node => { if (node.parent) { const siblings = node.parent.children, index = siblings.indexOf(node); if (index >= 0) siblings.splice(index, 1); node.parent = null } }
  const renderer = createRenderer({
    createElement: tag => makeNode(tag), createText: text => makeNode('#text', text), createComment: text => makeNode('#comment', text),
    setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] || null,
    insert(node, parent, anchor) { remove(node); const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index >= 0 ? index : parent.children.length, 0, node); node.parent = parent },
    remove, querySelector: () => root,
    patchProp(node, key, _previous, value) { node.props[key] = value; if (key === 'value') { node._value = value; node.value = String(value ?? '') } else if (key === 'disabled') node.disabled = value === '' || value === true; else if (key === 'type') node.type = value }
  })
  const nodes = () => { const result = []; const visit = node => { result.push(node); node.children.forEach(visit) }; visit(root); return result }
  const text = node => node.text + node.children.map(text).join('')
  const click = async label => { const node = nodes().find(node => node.tag === 'button' && text(node) === label); assert.ok(node, `${label} rendered by the actual template`); assert.notEqual(node.disabled, true); await node.props.onClick?.({ target: node, currentTarget: node }); await nextTick(); await settle() }
  const control = label => { const node = nodes().find(node => node.props['aria-label'] === label); assert.ok(node, `${label} rendered by the actual template`); return node }
  const dispatch = async (node, name) => {
    assert.notEqual(node.disabled, true, `${node.props['aria-label']} disabled`)
    for (let parent = node.parent; parent; parent = parent.parent) assert.notEqual(parent.tag === 'fieldset' && parent.disabled, true, 'owning fieldset disabled')
    const event = { type: name, target: node, currentTarget: node }
    for (const handler of node.listeners.get(name) || []) await handler(event)
    await node.props[`on${name[0].toUpperCase()}${name.slice(1)}`]?.(event)
    await nextTick(); await settle()
  }
  const input = async (label, value) => { const node = control(label); node.value = String(value); await dispatch(node, 'input') }
  const toggle = async (label, checked) => { const node = control(label); node.checked = checked; await dispatch(node, 'change') }
  return { renderer, root, nodes, text, click, control, input, toggle }
}

async function fixture(t, overrides = {}) {
  const environment = installBrowser(t), previous = { authenticated: adminSession.authenticated, pagePermissions: adminSession.pagePermissions }
  adminSession.authenticated = true; adminSession.pagePermissions = { 'model-animations': { view: true, edit: true } }
  t.after(() => { Object.assign(adminSession, previous); discardFactoryDrafts('factory-motion-test') })
  const store = { wsConnected: ref(false), connect() {}, dispose() { this.disposed = true }, setDeviceDataHandler(handler) { this.handler = handler }, setMotionInputHandler(handler) { this.motionHandler = handler } }
  environment.replace('__motionUiStore', store)
  if (overrides.template) { environment.replace('Document', class {}); environment.replace('ShadowRoot', class {}) }
  environment.replace('fetch', () => { throw Error('Unexpected network request: device animation fixture APIs must remain mocked') })
  const calls = { loads: [], catalogs: [], saves: [] }
  t.mock.method(adminApi, 'getDeviceAnimations', id => { calls.loads.push(id); return overrides.load ? overrides.load(id) : Promise.resolve(animation(id)) })
  t.mock.method(adminApi, 'getDataPoints', async id => pointRows(id))
  t.mock.method(adminApi, 'getDataCenterCatalog', options => { calls.catalogs.push(options); return overrides.catalog ? overrides.catalog(options) : Promise.resolve(directory(options.deviceId)) })
  t.mock.method(adminApi, 'saveDeviceAnimations', (id, body) => { calls.saves.push({ id, body }); return overrides.save ? overrides.save(id, body) : Promise.resolve({ success: true, ...animation(id), revision: 'saved', config: structuredClone(body.config) }) })
  const host = memoryHost(), { renderer, root } = host
  const props = { factoryId: 'factory-motion-test', devices: [{ id: 'a', name: 'A', model_type: 'm' }, { id: 'b', name: 'B', model_type: 'm' }], models: [{ id: 'm', name: '设备模型' }], confirm: async () => true, ...overrides.props }; let vm, exposed
  async function render(next = {}) { Object.assign(props, next); const vnode = h(overrides.template ? TemplateComponent : Component, { ...props }); renderer.render(vnode, root); vm = vnode.component.setupState; exposed = vnode.component.exposed; await nextTick(); await settle() }
  environment.beforeRestore(() => renderer.render(null, root))
  await render()
  return { get vm() { return vm }, get exposed() { return exposed }, props, calls, store, host, render, unmount: () => renderer.render(null, root) }
}

test('animation setup reads a device-scoped prepared directory and retains source types without part-context fields', async t => {
  const f = await fixture(t)
  assert.equal(f.vm.selectedId, 'a')
  assert.deepEqual(f.calls.catalogs[0], { deviceId: 'a', factoryId: 'factory-motion-test' })
  assert.deepEqual(new Set(f.vm.availableDataItems.map(item => item.sourceType)), new Set(['internal', 'plc', 'dataset']))
  assert.equal(f.vm.availableDataItems.some(item => item.objectScope === 'part'), false)
  assert.equal(f.vm.dirty, false)
})

test('server motion capabilities filter context-dependent data without hiding or rewriting an invalid existing binding', async t => {
  const f = await fixture(t, { load: async id => {
    const data = animation(id)
    data.dataItems.find(item => item.id === `mes-${id}`).motionReady = false
    data.dataItems.find(item => item.id === `mes-${id}`).motionError = '此数据表需要视角上下文，设备动作无法读取'
    data.config.bindings = [{ actionId: 'clip:door', enabled: true, dataItemId: `mes-${id}`, pointId: `${id}-bool`, trigger: { mode: 'condition', operator: 'eq', value: '运行中', hysteresis: 0 }, inputMin: 0, inputMax: 1 }]
    return data
  } })
  assert.equal(f.vm.availableDataItems.some(item => item.id === 'mes-a'), false)
  assert.equal(f.vm.row.dataItemId, 'mes-a'); assert.equal(f.vm.row.pointId, 'a-bool')
  assert.equal(f.vm.sourceType, 'string', 'missing prepared source cannot infer its type from a legacy BOOL point')
  assert.match(f.vm.saveProblem, /视角上下文/)
  f.vm.chooseDataItem(directory('a').items.find(item => item.id === 'mes-a'))
  assert.equal(f.vm.row.dataItemId, 'mes-a'); assert.equal(f.vm.dirty, false)
  assert.equal(await f.vm.save(), false); assert.equal(f.calls.saves.length, 0)
})

test('disabled missing prepared bindings still warn; explicit clear disables the action and saves without a legacy fallback', async t => {
  const f = await fixture(t, { load: async id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [{ actionId: 'clip:door', enabled: false, dataItemId: 'deleted-source', pointId: `${id}-bool`, trigger: { mode: 'condition', operator: 'eq', value: '运行中', hysteresis: 0 }, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }] } }) })
  assert.match(f.vm.currentProblem, /解除绑定/)
  assert.match(f.vm.saveProblem, /不可用/)
  assert.equal(await f.vm.save(), false)
  f.vm.clearDataItem()
  assert.equal(f.vm.row.enabled, false); assert.equal(f.vm.row.dataItemId, ''); assert.equal(f.vm.row.pointId, '')
  assert.deepEqual(f.vm.row.trigger, { mode: 'range', operator: 'gt', value: 0, hysteresis: 0 })
  assert.equal(f.vm.saveProblem, ''); assert.equal(await f.vm.save(), true)
  const cleared = f.calls.saves[0].body.config.bindings[0]
  assert.equal(cleared.enabled, false); assert.equal(cleared.dataItemId, ''); assert.equal(cleared.pointId, '')
  assert.equal(f.vm.dirty, false)
})

test('missing capability is not assumed executable and refreshed capabilities preserve draft while detecting configuration changes', async t => {
  let refresh = false
  const f = await fixture(t, { load: async id => {
    const data = animation(id)
    if (!refresh) data.dataItems = data.dataItems.filter(item => item.id !== `mes-${id}`)
    else data.revision = 'externally-updated'
    return data
  } })
  assert.equal(f.vm.availableDataItems.some(item => item.id === 'mes-a'), false)
  assert.match(f.vm.catalog.items.find(item => item.id === 'mes-a').motionError, /能力未读取/)
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); f.vm.row.enabled = true; f.vm.row.inputMax = 250
  const before = JSON.stringify(f.vm.draft)
  refresh = true; await f.vm.refreshCatalog()
  assert.equal(f.vm.availableDataItems.some(item => item.id === 'mes-a'), true)
  assert.equal(JSON.stringify(f.vm.draft), before)
  assert.equal(f.vm.loaded.revision, 'revision-a', 'refresh must not update revision while retaining an older config')
  assert.match(f.vm.saveProblem, /重新读取/); assert.equal(await f.vm.save(), false)
  assert.equal(f.calls.loads.length, 2); assert.equal(f.calls.saves.length, 0)
})

test('canonical range-only trigger returned by server stays valid and clean after saving', async t => {
  const f = await fixture(t, { save: async (id, body) => {
    const config = structuredClone(body.config)
    config.bindings[0].trigger = { mode: 'range' }
    return { success: true, ...animation(id), revision: 'saved', config }
  } })
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); f.vm.row.enabled = true
  assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.vm.row.trigger, { mode: 'range' })
  assert.equal(f.vm.saveProblem, ''); assert.equal(f.vm.dirty, false)
})

test('boolean and text data use typed conditions, never numeric ranges or incompatible operators', async t => {
  const f = await fixture(t)
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'bool-a'))
  assert.equal(f.vm.row.dataItemId, 'bool-a'); assert.equal(f.vm.row.pointId, '')
  assert.equal(f.vm.row.trigger.mode, 'condition'); assert.equal(f.vm.row.trigger.value, true)
  f.vm.changeTriggerMode('range'); assert.equal(f.vm.row.trigger.mode, 'condition')
  f.vm.changeOperator('gt'); assert.equal(f.vm.row.trigger.operator, 'eq')
  f.vm.changeThreshold('false'); assert.equal(f.vm.row.trigger.value, false)
  assert.equal(f.vm.sourceType, 'boolean')
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'mes-a'))
  f.vm.changeThreshold('运行中'); assert.equal(f.vm.row.trigger.value, '运行中')
  assert.equal(f.vm.row.trigger.mode, 'condition'); assert.equal(f.vm.sourceType, 'string')
  f.vm.row.enabled = true
  assert.equal(await f.exposed.savePending(), true)
  assert.equal(f.calls.saves[0].body.config.bindings[0].dataItemId, 'mes-a')
  assert.deepEqual(f.calls.saves[0].body.config.bindings[0].trigger, { mode: 'condition', operator: 'eq', value: '运行中', hysteresis: 0 })
  assert.equal(f.vm.dirty, false)
})

test('numeric position uses range mapping; numeric running defaults to a condition and supports nonnegative hysteresis', async t => {
  const f = await fixture(t), item = f.vm.availableDataItems.find(item => item.id === 'temp-a')
  f.vm.chooseDataItem(item); assert.equal(f.vm.row.trigger.mode, 'range')
  f.vm.row.enabled = true; f.vm.row.inputMin = 500; f.vm.row.inputMax = 100
  assert.match(f.vm.saveProblem, /下限/)
  f.vm.row.inputMin = 100; f.vm.row.inputMax = 500
  f.vm.changeTriggerMode('condition'); f.vm.changeOperator('gte'); f.vm.changeThreshold('350')
  assert.equal(f.vm.row.trigger.value, 350)
  f.vm.row.trigger.hysteresis = 5; assert.equal(f.vm.saveProblem, '')
  f.vm.changeOperator('eq'); assert.equal(f.vm.row.trigger.hysteresis, 0)
  f.vm.activeId = 'clip:fan'; f.vm.chooseDataItem(item)
  assert.equal(f.vm.row.trigger.mode, 'condition'); assert.equal(f.vm.row.trigger.operator, 'gt')
})

test('old owned BOOL point bindings remain compatible and display equivalent typed conditions', async t => {
  const f = await fixture(t, { load: async id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [{ actionId: 'clip:door', enabled: true, pointId: `${id}-bool`, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }] } }) })
  assert.equal(f.vm.row.pointId, 'a-bool'); assert.equal(f.vm.row.dataItemId, '')
  assert.equal(f.vm.selectedSource.id, 'bool-a')
  assert.equal(f.vm.row.trigger.mode, 'condition'); assert.equal(f.vm.row.trigger.value, true)
  assert.equal(f.vm.dirty, false)
})

test('animation handlers obey edit permissions, preserving readonly data, trigger and save state', async t => {
  const f = await fixture(t), before = JSON.stringify(f.vm.draft)
  adminSession.pagePermissions['model-animations'].edit = false
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); f.vm.changeTriggerMode('condition'); f.vm.changeOperator('gt'); f.vm.changeThreshold('400')
  assert.equal(JSON.stringify(f.vm.draft), before)
  assert.equal(await f.vm.save(), false); assert.equal(f.calls.saves.length, 0)
  f.vm.clearDataItem(); assert.equal(JSON.stringify(f.vm.draft), before)
})

test('device navigation confirms unsaved changes and does not lose a canceled draft', async t => {
  const f = await fixture(t, { props: { confirm: async () => false } })
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); await nextTick()
  const before = JSON.stringify(f.vm.draft)
  assert.equal(await f.vm.choose('b'), false)
  assert.equal(f.vm.selectedId, 'a'); assert.equal(JSON.stringify(f.vm.draft), before)
  await f.render({ confirm: async () => true }); assert.equal(await f.vm.choose('b'), true); await settle()
  assert.equal(f.vm.selectedId, 'b'); assert.equal(f.vm.loaded.deviceId, 'b')
  assert.ok(readFactoryDraft('factory-motion-test', 'animation:a'))
})

test('manual reload confirms discarded changes; cancel preserves draft and accept clears only the current factory/device cache', async t => {
  const prompts = [], f = await fixture(t, { props: { confirm: async prompt => { prompts.push(prompt); return false } } })
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); f.vm.row.enabled = true; await nextTick()
  const before = JSON.stringify(f.vm.draft), cached = readFactoryDraft('factory-motion-test', 'animation:a')
  cacheFactoryDraft('factory-motion-test', 'animation:b', 'device-animations', { deviceId: 'b', revision: 'other-device', config: { bindings: [] } })
  assert.equal(await f.exposed.reloadConfig(), false)
  assert.deepEqual(prompts, ['重新读取将放弃当前设备未保存的修改，继续？'])
  assert.equal(JSON.stringify(f.vm.draft), before); assert.equal(f.vm.selectedId, 'a')
  assert.deepEqual(readFactoryDraft('factory-motion-test', 'animation:a'), cached)
  assert.equal(f.calls.loads.length, 1)
  await f.render({ confirm: async () => true }); assert.equal(await f.exposed.reloadConfig(), true); await nextTick()
  assert.equal(f.vm.selectedId, 'a'); assert.equal(f.vm.dirty, false); assert.equal(f.calls.loads.length, 2)
  assert.equal(readFactoryDraft('factory-motion-test', 'animation:a'), null)
  assert.equal(readFactoryDraft('factory-motion-test', 'animation:b').revision, 'other-device')
})

test('pending manual reload approval cannot discard an old factory draft after scope changes', async t => {
  const approval = deferred(), f = await fixture(t, { props: { confirm: () => approval.promise } })
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); await nextTick()
  const cached = readFactoryDraft('factory-motion-test', 'animation:a'), reloading = f.exposed.reloadConfig()
  await f.render({ factoryId: 'factory-other' })
  approval.resolve(true); assert.equal(await reloading, false)
  assert.deepEqual(readFactoryDraft('factory-motion-test', 'animation:a'), cached)
  assert.equal(f.calls.loads.length, 1); assert.equal(f.vm.loaded, null)
})

test('all bindings validate numeric metadata before save, including hidden condition ranges and disabled/unbound rows', async t => {
  const f = await fixture(t)
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'bool-a'))
  assert.equal(f.vm.row.trigger.mode, 'condition'); assert.equal(f.vm.row.enabled, false)
  const valid = { inputMin: 0, inputMax: 1, speed: 1, transitionSeconds: 1 }
  for (const [changes, pattern] of [[{ inputMin: '' }, /有效数值/], [{ inputMax: Infinity }, /有效数值/], [{ inputMin: 3, inputMax: 2 }, /下限必须小于上限/], [{ inputMax: 1e13 }, /不能超过/], [{ speed: '' }, /动画速度/], [{ speed: .01 }, /动画速度/], [{ speed: 11 }, /动画速度/], [{ transitionSeconds: '' }, /过渡时间/], [{ transitionSeconds: -1 }, /过渡时间/], [{ transitionSeconds: 61 }, /过渡时间/]]) {
    Object.assign(f.vm.row, valid, changes)
    assert.match(f.vm.saveProblem, pattern); assert.equal(await f.vm.save(), false)
  }
  Object.assign(f.vm.row, valid); f.vm.clearDataItem(); f.vm.row.speed = ''
  assert.equal(f.vm.row.enabled, false); assert.equal(f.vm.row.dataItemId, '')
  assert.match(f.vm.saveProblem, /动画速度/); assert.equal(await f.vm.save(), false)
  Object.assign(f.vm.row, valid); assert.equal(f.vm.saveProblem, '')
  assert.equal(f.calls.saves.length, 0)
})

test('discardPending clears the factory-owned cache and unmount cannot resurrect the discarded draft', async t => {
  const f = await fixture(t)
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); await nextTick()
  assert.ok(readFactoryDraft('factory-motion-test', 'animation:a'))
  f.exposed.discardPending(); await nextTick()
  assert.equal(f.vm.dirty, false); assert.equal(readFactoryDraft('factory-motion-test', 'animation:a'), null)
  f.unmount(); assert.equal(readFactoryDraft('factory-motion-test', 'animation:a'), null)
})

test('a factory change rejects pending responses and does not apply previous-factory devices or drafts', async t => {
  const pending = deferred(), f = await fixture(t, { load: () => pending.promise })
  await f.render({ factoryId: 'factory-other' })
  pending.resolve(animation('a')); await settle()
  assert.equal(f.vm.scopeValid, false)
  assert.equal(f.vm.loaded, null); assert.equal(f.vm.draft, null); assert.equal(f.vm.selectedId, '')
  assert.equal(await f.vm.save(), false); assert.equal(f.calls.saves.length, 0)
})

test('missing prepared source never falls back to an old point and an unsaved new source shows pending-save health', async t => {
  const f = await fixture(t)
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); f.vm.row.enabled = true
  assert.equal(f.vm.stateFor('clip:door').reason, '新绑定待保存')
  f.vm.row.dataItemId = 'deleted-item'; f.vm.row.pointId = 'a-temp'
  assert.match(f.vm.saveProblem, /可用/)
  assert.equal(await f.vm.save(), false)
  assert.equal(f.calls.saves.length, 0)
})

test('save replies preserve newer local edits made during the request and leave them in the correct factory cache', async t => {
  const pending = deferred(), f = await fixture(t, { save: () => pending.promise })
  f.vm.chooseDataItem(f.vm.availableDataItems[0]); f.vm.row.enabled = true; f.vm.changeTriggerMode('condition'); f.vm.changeThreshold('250')
  const saving = f.vm.save(); f.vm.row.trigger.value = 300
  const body = f.calls.saves[0].body
  pending.resolve({ success: true, ...animation('a'), revision: 'saved', config: body.config })
  assert.equal(await saving, true); await nextTick()
  assert.equal(f.vm.row.trigger.value, 300); assert.equal(f.vm.dirty, true)
  assert.equal(readFactoryDraft('factory-motion-test', 'animation:a').config.bindings[0].trigger.value, 300)
})

test('motion-only broadcasts update prepared inputs without refreshing legacy PLC observations and reject foreign factories', async t => {
  const f = await fixture(t, { load: async id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [
    { actionId: 'clip:door', enabled: true, pointId: `${id}-temp`, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 0 },
    { actionId: 'clip:fan', enabled: true, pointId: '', dataItemId: `bool-${id}`, trigger: { mode: 'condition', operator: 'eq', value: true, hysteresis: 0 }, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 0 }
  ] } }) })
  const stamp = Date.now()
  f.store.handler({ furnace_id: 'a', factory_id: 'other-factory', timestamp: stamp, analog: { temp: 1 } })
  assert.deepEqual(f.vm.states, {})
  f.store.handler({ furnace_id: 'a', factory_id: 'factory-motion-test', timestamp: stamp, analog: { temp: .25 }, pointMeta: { 'analog.temp': { id: 'a-temp', timestamp: stamp } }, quality: { analog: { temp: 'good' } }, status: { online: true, quality: 'good' }, motionInputs: { 'clip:fan': { dataItemId: 'bool-a', value: true, quality: 'good', timestamp: stamp, staleMs: 5000 } } })
  const legacyAt = f.vm.states['clip:door'].receivedAt
  assert.equal(f.vm.states['clip:door'].position, .25)
  assert.equal(f.vm.states['clip:fan'].running, true)
  f.store.motionHandler({ furnace_id: 'a', factoryId: 'factory-motion-test', motionInputOnly: true, timestamp: stamp + 20, motionInputs: { 'clip:fan': { dataItemId: 'bool-a', value: false, quality: 'good', timestamp: stamp + 20, staleMs: 5000 } } })
  assert.equal(f.vm.states['clip:fan'].running, false)
  assert.equal(f.vm.states['clip:door'].receivedAt, legacyAt)
  assert.equal(f.vm.states['clip:door'].position, .25)
  assert.equal(f.vm.states['clip:fan'].usable, true)
  f.store.motionHandler({ furnace_id: 'a', factoryId: 'factory-motion-test', motionInputOnly: true, timestamp: stamp + 30, motionInputs: { 'clip:fan': { dataItemId: 'foreign-data-id', value: true, quality: 'good', timestamp: stamp + 30, staleMs: 5000 } } })
  assert.equal(f.vm.states['clip:fan'].usable, false)
  assert.equal(f.vm.states['clip:door'].receivedAt, legacyAt)
})

test('two existing boolean feedback items drive a position action and survive save without becoming ordinary constants', async t => {
  const f = await fixture(t)
  f.vm.changeTriggerMode('endpoints')
  assert.equal(f.vm.endpointMode, true); assert.equal(f.vm.sourceType, 'boolean')
  assert.equal(f.vm.saveProblem, '', 'disabled empty endpoint pair is a valid unfinished configuration')
  f.vm.row.enabled = true
  assert.match(f.vm.saveProblem, /推料到位.*退回到位/)
  f.vm.chooseEndpointData('extended', f.vm.endpointDataItems.find(item => item.id === 'extended-a'))
  assert.match(f.vm.saveProblem, /两个数据项/)
  f.vm.chooseEndpointData('retracted', f.vm.endpointDataItems.find(item => item.id === 'retracted-a'))
  assert.equal(f.vm.saveProblem, '')
  assert.equal(f.vm.stateFor('clip:door').reason, '新绑定待保存')
  assert.equal(f.vm.row.dataItemId, ''); assert.equal(f.vm.row.pointId, '')
  assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.saves[0].body.config.bindings[0].trigger, { mode: 'endpoints', extended: { dataItemId: 'extended-a' }, retracted: { dataItemId: 'retracted-a' } })
  assert.equal(f.vm.dirty, false)
  assert.equal(f.vm.feedbackLabel(f.vm.row), '推料到位 / 退回到位')
})

test('endpoint controls reject running actions, numeric data and shared physical feedback, while explicit clear disables the whole pair', async t => {
  const f = await fixture(t)
  f.vm.activeId = 'clip:fan'; const before = JSON.stringify(f.vm.row)
  f.vm.changeTriggerMode('endpoints'); assert.equal(JSON.stringify(f.vm.row), before)
  f.vm.activeId = 'clip:door'; f.vm.changeTriggerMode('endpoints')
  f.vm.chooseEndpointData('extended', f.vm.availableDataItems.find(item => item.id === 'temp-a'))
  assert.equal(f.vm.row.trigger.extended.dataItemId, '')
  const item = f.vm.endpointDataItems.find(item => item.id === 'extended-a')
  f.vm.chooseEndpointData('extended', item); f.vm.chooseEndpointData('retracted', item)
  assert.match(f.vm.saveProblem, /不能使用同一个/)
  assert.equal(await f.vm.save(), false)
  f.vm.row.enabled = true; f.vm.clearDataItem()
  assert.equal(f.vm.row.enabled, false); assert.equal(f.vm.row.trigger.mode, 'range')
  assert.equal(f.vm.row.dataItemId, ''); assert.equal(f.vm.saveProblem, '')
})

test('endpoint capability errors remain visible and cannot be bypassed by a generic boolean motion-ready item', async t => {
  const f = await fixture(t, { load: async id => {
    const data = animation(id), item = data.dataItems.find(item => item.id === `extended-${id}`)
    item.endpointReady = false; item.endpointError = '该数据表未明确关联当前设备'
    data.config.bindings = [{ actionId: 'clip:door', enabled: true, trigger: { mode: 'endpoints', extended: { dataItemId: `extended-${id}` }, retracted: { dataItemId: `retracted-${id}` } }, inputMin: 0, inputMax: 1, speed: 1, invert: false, transitionSeconds: 1 }]
    return data
  } })
  assert.equal(f.vm.availableDataItems.some(item => item.id === 'extended-a'), true)
  assert.equal(f.vm.endpointDataItems.some(item => item.id === 'extended-a'), false)
  assert.match(f.vm.saveProblem, /未明确关联当前设备/)
  assert.equal(await f.vm.save(), false)
})

test('motion-only endpoint frames use independent prepared feedback even with no top-level single dataItemId', async t => {
  const f = await fixture(t, { load: async id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [{ actionId: 'clip:door', enabled: true, trigger: { mode: 'endpoints', extended: { dataItemId: `extended-${id}` }, retracted: { dataItemId: `retracted-${id}` } }, inputMin: 0, inputMax: 1, speed: 1, invert: false, transitionSeconds: 0 }] } }) })
  const send = (extended, retracted) => { const timestamp = Date.now(); f.store.motionHandler({ furnace_id: 'a', factoryId: 'factory-motion-test', motionInputOnly: true, timestamp, motionInputs: { 'clip:door': { quality: 'good', endpointFeedback: { extended: { dataItemId: 'extended-a', value: extended, quality: 'good', timestamp }, retracted: { dataItemId: 'retracted-a', value: retracted, quality: 'good', timestamp } } } } }) }
  send(false, true); assert.equal(f.vm.states['clip:door'].position, 0); assert.equal(f.vm.states['clip:door'].reason, '退回到位')
  send(false, false); assert.equal(f.vm.states['clip:door'].position, 0); assert.equal(f.vm.states['clip:door'].reason, '等待到位反馈')
  send(true, false); assert.equal(f.vm.states['clip:door'].position, 1); assert.equal(f.vm.states['clip:door'].reason, '推料到位')
  send(true, true); assert.equal(f.vm.states['clip:door'].position, 1); assert.equal(f.vm.states['clip:door'].reason, '到位反馈冲突')
})

test('retired custom clips are not selectable or monitored; explicit confirmed save disables but preserves their stored fields', async t => {
  const retired = { actionId: 'clip:user_legacy', enabled: true, pointId: 'removed-point', dataItemId: 'removed-source', trigger: { mode: 'condition', operator: 'eq', value: true, hysteresis: 0 }, inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }
  const data = id => ({ ...animation(id), actions: [{ id: retired.actionId, kind: 'clip', mode: 'position', label: '旧自定义动画' }, ...actions], config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } })
  const confirmations = []
  const f = await fixture(t, { load: async id => data(id), save: async (id, body) => ({ success: true, ...data(id), config: structuredClone(body.config), revision: 'saved' }), props: { confirm: async text => { confirmations.push(text); return false } } })
  assert.equal(f.vm.activeId, 'clip:door')
  assert.equal(f.vm.selectableActions.some(action => action.id === retired.actionId), false)
  assert.equal(f.vm.resolvedBindings.some(binding => binding.actionId === retired.actionId), false)
  assert.deepEqual(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId), retired)
  assert.equal(f.vm.dirty, false); assert.equal(f.vm.retirementPending, true); assert.equal(f.vm.saveProblem, '')
  assert.equal(f.calls.saves.length, 0, 'reading a retired binding never writes to the server')
  assert.equal(await f.vm.save(), false); assert.equal(f.calls.saves.length, 0)
  assert.match(confirmations[0], /停用旧动画绑定.*保留动作定义和历史数据/)
  await f.render({ confirm: async () => true })
  assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === retired.actionId), { ...retired, enabled: false })
  assert.equal(f.vm.retirementPending, false); assert.equal(f.vm.dirty, false)
})

test('missing retired package definitions remain preservable and can be disabled without blocking current part bindings', async t => {
  const retired = { actionId: 'clip:user_missing', enabled: true, pointId: 'removed-point', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }
  const data = id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } })
  const f = await fixture(t, { load: async id => data(id), save: async (id, body) => ({ success: true, ...data(id), revision: 'saved', config: structuredClone(body.config) }) })
  assert.equal(f.vm.retirementPending, true)
  assert.equal(f.vm.draft.bindings.filter(binding => binding.actionId === retired.actionId).length, 1)
  f.vm.chooseDataItem(directory('a').items[0]); f.vm.row.enabled = true
  assert.equal(await f.vm.save(), true)
  assert.deepEqual(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === retired.actionId), { ...retired, enabled: false })
  assert.equal(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === 'clip:door').dataItemId, 'temp-a')
})

test('retirement save rebases hidden disabled history while preserving newer visible edits', async t => {
  const pending = deferred(), retired = { actionId: 'clip:user_legacy', enabled: true, pointId: 'removed', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }
  const data = id => ({ ...animation(id), actions: [{ id: retired.actionId, kind: 'clip', mode: 'position' }, ...actions], config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } })
  const f = await fixture(t, { load: async id => data(id), save: () => pending.promise })
  f.vm.chooseDataItem(directory('a').items[0])
  const saving = f.vm.save(); await settle()
  f.vm.row.inputMax = 9
  pending.resolve({ success: true, ...data('a'), revision: 'saved', config: structuredClone(f.calls.saves[0].body.config) })
  assert.equal(await saving, true)
  assert.equal(f.vm.row.inputMax, 9); assert.equal(f.vm.dirty, true)
  assert.equal(f.vm.retirementPending, false)
  assert.equal(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId).enabled, false)
  assert.equal(readFactoryDraft('factory-motion-test', 'animation:a').config.bindings.find(binding => binding.actionId === 'clip:door').inputMax, 9)
})

test('pending retirement confirmation cannot save another device and canceled approvals keep old bindings intact', async t => {
  const approval = deferred(), retired = { actionId: 'clip:user_legacy', enabled: true, pointId: 'removed', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }
  const f = await fixture(t, { load: async id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } }), props: { confirm: () => approval.promise } })
  const saving = f.vm.save()
  f.vm.selectedId = 'b'; await settle()
  approval.resolve(true)
  assert.equal(await saving, false); assert.equal(f.calls.saves.length, 0)
  assert.equal(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId).enabled, true)
})

test('actual SFC action list excludes the full process cycle without creating a new binding or hiding ordinary parts and clips', async t => {
  const available = [...actions, { id: 'part:process_cycle', kind: 'part', mode: 'position', label: '工艺部件位移' },
    { id: 'part:user_part', kind: 'part', mode: 'position', label: '普通部件动作' },
    { id: 'clip:process_cycle_extra', kind: 'clip', mode: 'position', label: '独立普通片段' }]
  const payload = { ...animation('a'), actions: [{ id: 'clip:process_cycle', kind: 'clip', mode: 'position', label: '完整工艺循环' }, ...available] }
  const before = JSON.stringify(payload), f = await fixture(t, { template: true, load: async () => structuredClone(payload) })
  const list = f.host.nodes().find(node => node.props['aria-label'] === '可绑定动作')
  assert.ok(list, 'the actual SFC action list is rendered in memory')
  assert.deepEqual(list.children.filter(node => node.tag === 'button').map(node => f.host.text(node.children.find(child => child.tag === 'span'))), available.map(action => action.label))
  assert.equal(f.vm.selectableActions.some(action => action.id === 'clip:process_cycle'), false)
  assert.equal(f.vm.draft.bindings.some(binding => binding.actionId === 'clip:process_cycle'), false)
  assert.equal(f.vm.resolvedBindings.some(binding => binding.actionId === 'clip:process_cycle'), false)
  assert.equal(f.vm.retirementPending, false); assert.equal(f.vm.dirty, false)
  assert.equal(f.calls.saves.length, 0, 'opening a model with an archived cycle cannot create or disable a binding')
  assert.equal(JSON.stringify(payload), before)
})

test('actual SFC identifies an enabled saved full cycle and only an explicitly confirmed save disables its preserved history', async t => {
  const retired = { actionId: 'clip:process_cycle', enabled: true, pointId: 'removed-cycle-point', dataItemId: 'removed-cycle-source',
    trigger: { mode: 'condition', operator: 'eq', value: '旧工艺', hysteresis: 0 }, inputMin: null, inputMax: null, invert: false, speed: null, transitionSeconds: null }
  const payload = { ...animation('a'), actions: [{ id: retired.actionId, kind: 'clip', mode: 'position', label: '完整工艺循环' }, ...actions], config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } }
  const confirmations = [], before = JSON.stringify(payload)
  const f = await fixture(t, { template: true, load: async () => structuredClone(payload), props: { confirm: async message => { confirmations.push(message); return false } } })
  assert.equal(f.vm.activeId, 'clip:door'); assert.equal(f.vm.saveProblem, '')
  assert.equal(f.vm.retirementPending, true); assert.equal(f.vm.dirty, false)
  assert.deepEqual(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId), retired)
  assert.match(f.host.text(f.host.root), /完整工艺循环绑定.*确认停用.*历史配置保留/)
  assert.doesNotMatch(f.host.text(f.host.root), /旧自定义动画/)
  await f.host.click('保存并同步')
  assert.equal(f.calls.saves.length, 0)
  assert.match(confirmations[0], /完整工艺循环已从可绑定动作中移除.*停用旧动画绑定.*保留动作定义和历史数据/)
  assert.deepEqual(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId), retired)
  const timestamp = Date.now()
  f.store.motionHandler({ furnace_id: 'a', factoryId: 'factory-motion-test', motionInputOnly: true, timestamp,
    motionInputs: { 'clip:process_cycle': { dataItemId: retired.dataItemId, value: true, quality: 'good', timestamp } } })
  assert.equal(f.vm.states['clip:process_cycle'], undefined, 'removed cycles are not monitored by the configuration page')
  await f.render({ confirm: async () => true })
  await f.host.click('保存并同步')
  assert.deepEqual(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === retired.actionId), { ...retired, enabled: false })
  assert.deepEqual(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId), { ...retired, enabled: false })
  assert.equal(f.vm.retirementPending, false); assert.equal(f.vm.dirty, false)
  assert.equal(JSON.stringify(payload), before, 'reading or explicitly disabling cannot rewrite the source snapshot')
})

test('actual SFC retains a disabled full-cycle row without adding trigger/source defaults and lets ordinary actions save unchanged history', async t => {
  const retired = { actionId: 'clip:process_cycle', enabled: false, pointId: 'removed', inputMin: null, inputMax: null, invert: true, speed: null, transitionSeconds: null }
  const payload = { ...animation('a'), actions: [{ id: retired.actionId, kind: 'clip', mode: 'position', label: '完整工艺循环' }, ...actions], config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } }
  const confirmations = [], f = await fixture(t, { template: true, load: async () => structuredClone(payload), props: { confirm: async message => { confirmations.push(message); return false } } })
  const row = f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId)
  assert.deepEqual(row, retired); assert.equal(Object.hasOwn(row, 'trigger'), false); assert.equal(Object.hasOwn(row, 'dataItemId'), false)
  assert.equal(f.vm.retirementPending, false); assert.equal(f.vm.saveProblem, '')
  assert.equal(f.calls.saves.length, 0)
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a')); f.vm.row.enabled = true; await nextTick()
  await f.host.click('保存并同步')
  assert.deepEqual(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === retired.actionId), retired)
  assert.equal(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === 'clip:door').enabled, true)
  assert.deepEqual(confirmations, [], 'an already disabled archive is preserved, not re-enabled or newly approved')
  assert.deepEqual(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId), retired)
})

test('actual SFC preserves an orphan full-cycle history row and can explicitly disable it without recreating the missing action', async t => {
  const retired = { actionId: 'clip:process_cycle', enabled: true, pointId: 'removed-cycle-point', inputMin: 0, inputMax: 1, invert: false, speed: 1, transitionSeconds: 1 }
  const payload = { ...animation('a'), config: { version: 1, staleMs: 5000, bindings: [structuredClone(retired)] } }
  const f = await fixture(t, { template: true, load: async () => structuredClone(payload) })
  assert.equal(f.vm.loaded.actions.some(action => action.id === retired.actionId), false)
  assert.equal(f.vm.draft.bindings.filter(binding => binding.actionId === retired.actionId).length, 1)
  assert.deepEqual(f.vm.draft.bindings.find(binding => binding.actionId === retired.actionId), retired)
  assert.equal(f.vm.retirementPending, true); assert.equal(f.vm.saveProblem, '')
  assert.match(f.host.text(f.host.root), /完整工艺循环绑定.*历史配置保留/)
  await f.host.click('保存并同步')
  const saved = f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === retired.actionId)
  assert.deepEqual(saved, { ...retired, enabled: false })
  assert.equal(Object.hasOwn(saved, 'dataItemId'), false); assert.equal(Object.hasOwn(saved, 'trigger'), false)
  assert.equal(f.vm.loaded.actions.some(action => action.id === retired.actionId), false)
  assert.equal(f.vm.selectableActions.some(action => action.id === retired.actionId), false)
})

test('actual SFC uses the shared kind-aware retirement rule and does not retire genuine part actions with legacy-looking ids', async t => {
  const parts = [{ id: 'clip:process_cycle', kind: 'part', mode: 'position', label: '合法部件动作' },
    { id: 'clip:user_legitimate', kind: 'part', mode: 'running', label: '合法运转部件' }]
  const f = await fixture(t, { template: true, load: async id => ({ ...animation(id), actions: [...parts, ...actions] }),
    save: async (id, body) => ({ success: true, ...animation(id), actions: [...parts, ...actions], revision: 'saved', config: structuredClone(body.config) }) })
  const list = f.host.nodes().find(node => node.props['aria-label'] === '可绑定动作')
  assert.deepEqual(list.children.filter(node => node.tag === 'button').map(node => f.host.text(node.children.find(child => child.tag === 'span'))), [...parts, ...actions].map(action => action.label))
  assert.equal(f.vm.retirementPending, false); assert.equal(f.vm.activeId, parts[0].id)
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a')); f.vm.row.enabled = true; await nextTick()
  await f.host.click('保存并同步')
  assert.equal(f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === parts[0].id).enabled, true)
  assert.equal(f.vm.retirementPending, false); assert.equal(f.vm.dirty, false)
  assert.match(source, /import \{ isRetiredMotionAction \} from ['"]\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/motionActionAvailability\.mjs['"]/)
  assert.doesNotMatch(source, /const isRetiredAction\s*=|startsWith\(['"]clip:user_['"]\)/)
})

test('device-animation template compiles with a scrollable part configuration and no retired direct-point entry', () => {
  const parsed = parse(source).descriptor, script = compileScript(parsed, { id: 'motion-compile' })
  assert.deepEqual(compileTemplate({ source: parsed.template.content, filename: 'DeviceAnimationLink.vue', id: 'motion-compile', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  assert.ok(source.includes('DeviceHierarchyPicker'))
  assert.ok(source.includes('MotionDataPicker'))
  assert.ok(source.includes('新绑定待保存'))
  assert.doesNotMatch(source, /兼容旧配置 · 采集点位直连|aria-label="联动采集点位"|function selectPoint\(/)
  assert.match(source, /class="link-config" role="region" aria-label="部件动作联动配置" tabindex="0"/)
  assert.ok(source.includes('MotionEndpointPicker'))
  assert.doesNotMatch(source, /MotionLinkPreview|link-preview|previewMode|testValue|previewBindings|本页试动作|跟随采集|试动作进度|测试两端未到位/)
  assert.match(source, /\.link-content\{[^}]*grid-template-columns:minmax\(0,1fr\)/)
  assert.match(source, /class="health-connection" role="status"/)
  assert.doesNotMatch(source, /setFactoryScope|window\.location\.reload/)
})

test('configuration-only page keeps monitoring saved feedback without constructing a WebGL preview', async t => {
  const f = await fixture(t, { load: async id => ({ ...animation(id), config: { version: 1, staleMs: 5000, bindings: [{ actionId: 'clip:door', enabled: true, trigger: { mode: 'endpoints', extended: { dataItemId: `extended-${id}` }, retracted: { dataItemId: `retracted-${id}` } }, inputMin: 0, inputMax: 1, speed: 1, invert: false, transitionSeconds: 0 }] } }) })
  const timestamp = Date.now()
  f.vm.section = 'health'
  f.store.motionHandler({ furnace_id: 'a', factoryId: 'factory-motion-test', motionInputOnly: true, motionInputs: { 'clip:door': { quality: 'good', endpointFeedback: { extended: { dataItemId: 'extended-a', value: true, quality: 'good', timestamp }, retracted: { dataItemId: 'retracted-a', value: false, quality: 'good', timestamp } } } } })
  assert.equal(f.vm.stateFor('clip:door').reason, '推料到位')
  assert.equal(f.vm.stateFor('clip:door').usable, true)
  assert.equal(f.vm.dirty, false)
  assert.equal(f.calls.saves.length, 0)
  assert.equal('runtime' in f.vm, false)
  assert.equal('frame' in f.vm, false)
  f.unmount()
  assert.equal(f.store.disposed, true)
})

test('hierarchy relocates through a deferred target without duplicating the selector or changing device selection guards', async t => {
  const template = parse(source).descriptor.template.content
  assert.equal((template.match(/<DeviceHierarchyPicker\b/g) || []).length, 1)
  assert.match(source, /devicePickerTarget: \{ type: String, default: '' \}/)
  assert.match(template, /<aside class="link-devices">\s*<Teleport defer :to="devicePickerTarget \|\| 'body'" :disabled="!devicePickerTarget">/)
  assert.match(template, /:factory-id="factory" :device-id="selectedId" :disabled="busy \|\| !scopeValid" :request-factory-switch="requestFactorySwitch" scope-only/)
  assert.match(template, /:scope-workshop-id="deviceRange.workshopId" :scope-line-id="deviceRange.lineId" @scope-change="filterDeviceRange"/)
  assert.doesNotMatch(template, /:request-device="choose"/)
  assert.match(template, /<\/Teleport>\s*<input v-model="query"[^>]*aria-label="搜索联动设备"[\s\S]*?<div class="link-device-list">/)
  const f = await fixture(t, { props: { devicePickerTarget: '#owned-heading-picker', confirm: async () => false } })
  assert.equal(f.vm.selectedId, 'a'); assert.equal(f.vm.dirty, false)
  f.vm.row.enabled = true
  assert.equal(await f.vm.choose('b'), false)
  assert.equal(f.vm.selectedId, 'a'); assert.equal(f.vm.dirty, true)
  await f.render({ devicePickerTarget: '' })
  assert.equal(f.vm.selectedId, 'a'); assert.equal(f.vm.dirty, true)
  assert.equal(f.calls.saves.length, 0)
  f.unmount(); assert.equal(f.store.disposed, true)
})

test('three-level scope filters the single device list without selecting a device, modifying its draft or making a request', async t => {
  const f = await fixture(t, { props: {
    workshops: [{ id: 'w1' }, { id: 'w2' }],
    lines: [{ id: 'l1', workshop_id: 'w1' }, { id: 'l2', workshop_id: 'w1' }, { id: 'l3', workshop_id: 'w2' }],
    devices: [{ id: 'a', name: '一号炉', line_id: 'l1' }, { id: 'b', name: '二号炉', line_id: 'l2' }, { id: 'c', name: '另一车间炉', line_id: 'l3' },
      { id: 'aux', name: '辅助设备', instance_config: '{"workshop_id":"w1"}' }, { id: 'orphan', name: '未分配设备', line_id: 'deleted', instance_config: 'null' }],
    confirm: async () => false
  } })
  const initialLoads = f.calls.loads.length
  f.vm.row.enabled = true
  const draft = JSON.stringify(f.vm.draft)
  assert.equal(f.vm.filterDeviceRange({ workshopId: 'w1', lineId: '' }), true)
  assert.deepEqual(f.vm.options.map(row => row.id), ['a', 'b', 'aux'])
  assert.equal(f.vm.filterDeviceRange({ workshopId: 'w1', lineId: 'l2' }), true)
  assert.deepEqual(f.vm.options.map(row => row.id), ['b'])
  assert.equal(f.vm.selectedId, 'a'); assert.equal(JSON.stringify(f.vm.draft), draft)
  assert.equal(f.calls.loads.length, initialLoads); assert.equal(f.calls.saves.length, 0)
  assert.equal(await f.vm.choose('b'), false, 'the below-list choice still confirms the dirty device')
  assert.equal(f.vm.selectedId, 'a'); assert.equal(JSON.stringify(f.vm.draft), draft)
  f.vm.query = '一号'; assert.deepEqual(f.vm.options, [], 'search cannot leak a device outside the selected line')
  f.vm.query = ''
  assert.equal(f.vm.filterDeviceRange({ workshopId: 'w1', lineId: '__unassigned' }), true)
  assert.deepEqual(f.vm.options.map(row => row.id), ['aux'])
  assert.equal(f.vm.filterDeviceRange({ workshopId: '__unassigned', lineId: '__unassigned' }), true)
  assert.deepEqual(f.vm.options.map(row => row.id), ['orphan'])
  assert.equal(f.vm.filterDeviceRange({ workshopId: '', lineId: '' }), true)
  assert.equal(f.vm.options.length, 5)
})

test('device list rejects invalid or pending scope changes without changing the current filter', async t => {
  const f = await fixture(t, { props: { workshops: [{ id: 'w1' }, { id: 'w2' }], lines: [{ id: 'l1', workshop_id: 'w1' }] } })
  assert.equal(f.vm.filterDeviceRange({ workshopId: 'w1', lineId: 'l1' }), true)
  const current = { ...f.vm.deviceRange }
  for (const range of [{ workshopId: '', lineId: 'l1' }, { workshopId: 'missing', lineId: '' }, { workshopId: 'w2', lineId: 'l1' }]) {
    assert.equal(f.vm.filterDeviceRange(range), false); assert.deepEqual(f.vm.deviceRange, current)
  }
  f.vm.busy = true
  assert.equal(f.vm.filterDeviceRange({ workshopId: '', lineId: '' }), false); assert.deepEqual(f.vm.deviceRange, current)
  f.vm.busy = false
  f.unmount()
  assert.equal(f.vm.filterDeviceRange({ workshopId: '', lineId: '' }), false)
})

test('actual numeric feedback control manually saves 200ms, reloads it and restores the retained transition when set to zero', async t => {
  let stored
  const payload = id => ({ ...animation(id), ...(stored ? { revision: 'saved', config: structuredClone(stored) } : {}) })
  const f = await fixture(t, { template: true, load: async id => payload(id), save: async (id, body) => {
    stored = structuredClone(body.config)
    for (const binding of stored.bindings) if (binding.trigger?.mode === 'range') binding.trigger = { mode: 'range' }
    return { success: true, ...payload(id) }
  } })
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a')); await nextTick()
  assert.equal(f.vm.row.feedbackSmoothingMs, 0); assert.equal(f.vm.feedbackPosition, true); assert.equal(f.vm.feedbackEnabled, false)
  const smoothing = f.host.control('数值反馈平滑毫秒')
  assert.equal(smoothing.props.type, 'number'); assert.equal(smoothing.props.min, '0'); assert.equal(smoothing.props.max, '1000'); assert.equal(smoothing.props.step, 'any')
  await f.host.toggle('启用动作联动', true)
  await f.host.input('动作过渡秒数', '2')
  await f.host.input('数值反馈平滑毫秒', '200')
  assert.equal(f.vm.row.feedbackSmoothingMs, 200, 'actual Vue .number input receives a number, not a descriptive label')
  assert.equal(f.vm.feedbackEnabled, true); assert.equal(f.vm.row.transitionSeconds, 2)
  assert.equal(f.host.control('动作过渡秒数').disabled, true)
  assert.match(f.host.text(f.host.root), /原全行程过渡（保留，不叠加）/)
  assert.match(f.host.text(f.host.root), /0 保留原还原与过渡设置/)
  await f.host.click('保存并同步')
  const saved = f.calls.saves[0].body.config.bindings.find(binding => binding.actionId === 'clip:door')
  assert.equal(saved.feedbackSmoothingMs, 200); assert.equal(saved.transitionSeconds, 2); assert.equal(saved.dataItemId, 'temp-a')
  assert.equal(saved.enabled, true); assert.equal(f.vm.dirty, false)
  await f.host.click('重新读取')
  assert.equal(f.vm.row.feedbackSmoothingMs, 200); assert.equal(f.vm.row.transitionSeconds, 2); assert.equal(f.vm.row.dataItemId, 'temp-a')
  assert.equal(f.vm.dirty, false); assert.equal(f.host.control('数值反馈平滑毫秒').value, 200)
  assert.equal(f.host.control('动作过渡秒数').disabled, true)
  await f.host.input('数值反馈平滑毫秒', '0')
  assert.equal(f.vm.feedbackEnabled, false); assert.equal(f.vm.row.transitionSeconds, 2)
  assert.equal(f.host.control('动作过渡秒数').disabled, false)
  await f.host.click('保存并同步'); await f.host.click('重新读取')
  assert.equal(f.vm.row.feedbackSmoothingMs, 0); assert.equal(f.vm.row.transitionSeconds, 2); assert.equal(f.vm.dirty, false)
  assert.equal(f.calls.saves[1].body.config.bindings.find(binding => binding.actionId === 'clip:door').feedbackSmoothingMs, 0)
})

test('numeric smoothing control is not exposed or enabled for BOOL, text, condition, endpoints or running actions', async t => {
  const f = await fixture(t, { template: true })
  const visible = () => f.host.nodes().some(node => node.props['aria-label'] === '数值反馈平滑毫秒')
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a')); await nextTick()
  assert.equal(visible(), true); await f.host.input('数值反馈平滑毫秒', '200')
  f.vm.changeTriggerMode('condition'); await nextTick()
  assert.equal(visible(), false); assert.equal(f.vm.feedbackEnabled, false); assert.equal(f.host.control('动作过渡秒数').disabled, false)
  for (const id of ['bool-a', 'mes-a']) {
    f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === id)); await nextTick()
    assert.equal(visible(), false); assert.equal(f.vm.feedbackEnabled, false)
    assert.equal(f.vm.row.feedbackSmoothingMs, 200, 'hidden authored setting is preserved, not applied to a different source type')
    assert.equal(f.host.control('动作过渡秒数').disabled, false)
  }
  f.vm.changeTriggerMode('endpoints'); await nextTick()
  assert.equal(visible(), false); assert.equal(f.vm.feedbackEnabled, false); assert.equal(f.vm.endpointMode, true)
  assert.equal(f.host.control('动作过渡秒数').disabled, false)
  f.vm.activeId = 'clip:fan'; f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a'))
  f.vm.changeTriggerMode('range'); await nextTick()
  assert.equal(visible(), false); assert.equal(f.vm.feedbackEnabled, false)
  assert.ok(f.host.control('动作运行速度')); assert.equal(f.host.nodes().some(node => node.props['aria-label'] === '动作过渡秒数'), false)
})

test('actual smoothing input rejects invalid ranges or an empty value before saving even for a disabled action', async t => {
  const f = await fixture(t, { template: true })
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a')); await nextTick()
  assert.equal(f.vm.row.enabled, false)
  for (const value of ['-1', '1001', '']) {
    await f.host.input('数值反馈平滑毫秒', value)
    assert.match(f.vm.saveProblem, /数值反馈平滑.*有效数值/)
    assert.equal(await f.vm.save(), false)
  }
  assert.equal(f.calls.saves.length, 0)
  await f.host.input('数值反馈平滑毫秒', '.5')
  assert.equal(f.vm.row.feedbackSmoothingMs, .5); assert.equal(f.vm.saveProblem, '')
})

test('actual smoothing field obeys existing edit permission and cannot be manually changed in readonly mode', async t => {
  const f = await fixture(t, { template: true })
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'temp-a')); await nextTick()
  const before = JSON.stringify(f.vm.draft)
  adminSession.pagePermissions['model-animations'].edit = false; await nextTick()
  assert.equal(f.host.control('数值反馈平滑毫秒').disabled, true)
  await assert.rejects(f.host.input('数值反馈平滑毫秒', '200'), /disabled/)
  assert.equal(JSON.stringify(f.vm.draft), before)
  assert.equal(await f.vm.save(), false); assert.equal(f.calls.saves.length, 0)
})

test('existing model part actions all remain visible and bindable, with no inter-device settings entry', async t => {
  const packages = JSON.parse(await readFile(new URL('../../shared/motionPackages.json', import.meta.url), 'utf8'))
  const modelActions = packages.models.cad_multipurpose_furnace_082000.actions.map(action => ({ ...action, id: 'clip:' + action.id, kind: 'clip' }))
  const legacy = { enabled: true, actionId: 'clip:removed', driveNodeName: 'removed-node', extension: 'keep historical data' }
  const f = await fixture(t, { template: true, load: async id => ({ ...animation(id), actions: modelActions, config: { ...animation(id).config, transferLink: legacy } }) })
  assert.equal(f.vm.selectableActions.length, 9)
  for (const action of modelActions.filter(action => action.id !== 'clip:process_cycle')) {
    assert.ok(f.host.nodes().some(node => node.tag === 'button' && f.host.text(node).includes(action.label)), action.label)
    assert.ok(f.vm.draft.bindings.some(binding => binding.actionId === action.id))
  }
  assert.doesNotMatch(f.host.text(f.host.root), /进出料联动|承料移动节点|交接校准|高级：设备间/)
  assert.doesNotMatch(source, /TransferLinkSettings|advanced-device-transfer/)
  assert.equal(Object.hasOwn(f.vm.draft, 'transferLink'), false)
  assert.equal(f.vm.dirty, false, 'reading legacy metadata does not invent a change')
  f.vm.chooseDataItem(f.vm.availableDataItems.find(item => item.id === 'bool-a')); await nextTick()
  assert.equal(await f.vm.save(), true, f.vm.error)
  assert.equal(Object.hasOwn(f.calls.saves[0].body.config, 'transferLink'), false, 'normal save never edits the removed settings')
  assert.deepEqual(legacy, { enabled: true, actionId: 'clip:removed', driveNodeName: 'removed-node', extension: 'keep historical data' })
})
