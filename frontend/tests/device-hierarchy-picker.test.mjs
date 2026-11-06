import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { deferred, installBrowser, settle } from './helpers.mjs'

async function component(name) {
  const url = new URL(`../src/views/admin/components/${name}.vue`, import.meta.url), source = await readFile(url, 'utf8'), { descriptor } = parse(source)
  let compiled = compileScript(descriptor, { id: name }).content
  for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) compiled = compiled.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], url).href : import.meta.resolve(match[2]))}`)
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
  Component.render = () => null
  return { Component, source }
}
const hierarchy = await component('DeviceHierarchyPicker'), motionPicker = await component('MotionDataPicker')
async function fixture(t, Component, initialProps = {}) {
  const environment = installBrowser(t), emitted = []
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const root = {}, props = { ...initialProps }; let vm
  async function render(next = {}) { Object.assign(props, next); const vnode = h(Component, { ...props, onSelect: item => emitted.push(item), onClear: () => emitted.push({ type: 'clear' }) }); renderer.render(vnode, root); vm = vnode.component.setupState; await nextTick(); await settle() }
  environment.beforeRestore(() => renderer.render(null, root))
  await render()
  return { get vm() { return vm }, props, render, emitted, environment, unmount: () => renderer.render(null, root) }
}
const structure = { factoryId: 'f1', deviceId: 'd1', factories: [{ id: 'f1', name: '工厂一' }, { id: 'f2', name: '工厂二' }], workshops: [{ id: 'w1', name: '热处理车间' }, { id: 'w2', name: '装配车间' }],
  lines: [{ id: 'l1', name: '热处理一线', workshop_id: 'w1' }, { id: 'l2', name: '装配线', workshop_id: 'w2' }], devices: [{ id: 'd1', name: '一号炉', line_id: 'l1' }, { id: 'd2', name: '装配机', line_id: 'l2' }, { id: 'aux', name: '辅助风机', instance_config: JSON.stringify({ workshop_id: 'w1' }) }] }

test('hierarchy reveals the current factory/workshop/line/device and browsing does not select until the final device', async t => {
  const calls = [], f = await fixture(t, hierarchy.Component, { ...structure, requestDevice: async id => { calls.push(id); return true } })
  f.vm.toggle(); assert.equal(f.vm.open, true)
  assert.equal(f.vm.currentFactory.name, '工厂一'); assert.equal(f.vm.workshopId, 'w1'); assert.equal(f.vm.lineId, 'l1')
  assert.deepEqual(f.vm.deviceOptions.map(device => device.id), ['d1'])
  f.vm.chooseWorkshop('w2'); assert.equal(f.vm.lineId, 'l2'); assert.deepEqual(calls, [])
  assert.equal(await f.vm.chooseDevice('d2'), true); assert.deepEqual(calls, ['d2']); assert.equal(f.vm.open, false)
})

test('auxiliary/orphan devices remain reachable through explicit unassigned branches without fake source values', async t => {
  const f = await fixture(t, hierarchy.Component, { ...structure, deviceId: 'aux' })
  f.vm.toggle(); assert.equal(f.vm.workshopId, 'w1'); assert.equal(f.vm.lineId, '__unassigned')
  assert.deepEqual(f.vm.deviceOptions.map(device => device.id), ['aux'])
  await f.render({ devices: [...structure.devices, { id: 'orphan', line_id: 'deleted-line' }], deviceId: 'orphan' })
  assert.equal(f.vm.workshopId, '__unassigned'); assert.equal(f.vm.lineId, '__unassigned')
  assert.deepEqual(f.vm.deviceOptions.map(device => device.id), ['orphan'])
})

test('factory changes only invoke the awaited parent workflow; canceled approval cannot change scope or current device', async t => {
  const pending = deferred(), calls = [], f = await fixture(t, hierarchy.Component, { ...structure, requestFactorySwitch: input => { calls.push(input); return pending.promise } })
  f.vm.toggle(); const switching = f.vm.chooseFactory('f2')
  assert.equal(f.vm.switching, true); assert.equal(f.props.factoryId, 'f1')
  assert.equal(await f.vm.chooseFactory('f2'), false, 'double switches are blocked')
  pending.resolve(false); assert.equal(await switching, false)
  assert.deepEqual(calls, [{ factoryId: 'f2', factoryName: '工厂二' }])
  assert.equal(f.props.factoryId, 'f1'); assert.equal(f.props.deviceId, 'd1'); assert.equal(f.vm.open, true)
  await f.render({ requestFactorySwitch: async () => true }); assert.equal(await f.vm.chooseFactory('f2'), true)
  assert.equal(f.vm.open, false)
  assert.doesNotMatch(hierarchy.source, /setFactoryScope|window\.location\.reload|loadConfig/)
})

test('device selection honors cancellation/disabled state and factory or device callback errors stay visible', async t => {
  const f = await fixture(t, hierarchy.Component, { ...structure, requestDevice: async () => false, requestFactorySwitch: async () => { throw Error('草稿未保存') } })
  f.vm.toggle(); assert.equal(await f.vm.chooseDevice('d1'), false); assert.equal(f.vm.open, true)
  assert.equal(await f.vm.chooseFactory('f2'), false); assert.match(f.vm.error, /草稿/)
  await f.render({ disabled: true }); assert.equal(await f.vm.chooseDevice('d1'), false); assert.equal(await f.vm.chooseFactory('f2'), false)
  assert.equal(f.environment.browser.listeners.has('digital-twin-factory-scope-changed'), false, 'component does not install global scope handlers')
})

test('hierarchy popover clamps inside a narrow viewport and removes resize/scroll listeners when closed by unmount', async t => {
  const f = await fixture(t, hierarchy.Component, { ...structure })
  f.environment.browser.innerWidth = 900; f.environment.browser.innerHeight = 700
  f.vm.host = { getBoundingClientRect: () => ({ left: 320, top: 100, bottom: 150 }), contains: () => true }
  f.vm.toggle(); await nextTick()
  assert.equal(f.vm.menuStyle.width, '750px')
  assert.equal(f.vm.menuStyle.left, '134px')
  assert.ok(Number.parseFloat(f.vm.menuStyle.left) + Number.parseFloat(f.vm.menuStyle.width) <= 900 - 16)
  assert.ok(Number.parseFloat(f.vm.menuStyle.top) + Number.parseFloat(f.vm.menuStyle.maxHeight) <= 700 - 16)
  f.environment.browser.innerWidth = 600
  for (const handler of f.environment.browser.listeners.get('resize')) handler()
  assert.equal(f.vm.menuStyle.width, '568px'); assert.equal(f.vm.menuStyle.left, '16px')
  f.unmount()
  assert.equal(f.environment.browser.listeners.get('resize').size, 0)
  assert.equal(f.environment.browser.listeners.get('scroll').size, 0)
})

const catalog = { categories: [{ id: 'live', name: '实时采集' }, { id: 'business', name: '生产业务' }], tables: [{ id: 'plc', name: '本设备采集' }, { id: 'mes', name: 'MES 数据表' }], items: [
  { id: 'plc-number', tableId: 'plc', categoryId: 'live', label: '炉温', type: 'number', unit: '℃', objectScope: 'device', binding: { mode: 'plc', pointId: 'p1' } },
  { id: 'bool', tableId: 'plc', categoryId: 'live', label: '运行反馈', type: 'boolean', objectScope: 'device', binding: { mode: 'plc', pointId: 'p2' } },
  { id: 'text', tableId: 'mes', categoryId: 'business', label: '订单状态', type: 'string', objectScope: 'device', binding: { mode: 'dataset', datasetId: 'D', datasetField: 'state' } },
  { id: 'internal', tableId: 'plc', categoryId: 'live', label: '设备名称', type: 'string', objectScope: 'device', binding: { mode: 'runtime', path: 'deviceInfo.name' } },
  { id: 'part', type: 'string', objectScope: 'part', binding: { mode: 'runtime' } }, { id: 'disabled', type: 'number', enabled: false, binding: { mode: 'dataset' } }, { id: 'broken-source', type: 'number', sourceReady: false, binding: { mode: 'dataset' } }
].map(item => ({ ...item, motionReady: true, motionError: '' })) }
test('motion data picker offers typed device PLC/internal/prepared table sources and rejects unavailable or part-context fields', async t => {
  const f = await fixture(t, motionPicker.Component, { catalog, pointId: 'p1' })
  assert.deepEqual(f.vm.availableItems.map(item => item.id), ['plc-number', 'bool', 'text', 'internal'])
  assert.equal(f.vm.selected.id, 'plc-number', 'legacy owned point is shown without silently replacing its binding')
  f.vm.categoryId = 'business'; await nextTick(); assert.deepEqual(f.vm.items.map(item => item.id), ['text'])
  f.vm.choose('text'); assert.equal(f.emitted[0].id, 'text')
  f.vm.choose('part'); f.vm.choose('disabled'); f.vm.choose('broken-source'); assert.equal(f.emitted.length, 1)
  await f.render({ disabled: true }); f.vm.choose('text'); assert.equal(f.emitted.length, 1)
})

test('missing dataItemId never falls back to a compatible old point, and Chinese search keeps table distinctions', async t => {
  const f = await fixture(t, motionPicker.Component, { catalog, dataItemId: 'deleted-data', pointId: 'p1' })
  assert.equal(f.vm.selected, null)
  f.vm.query = 'MES'; await nextTick(); assert.deepEqual(f.vm.items.map(item => item.id), ['text'])
  f.vm.query = '℃'; await nextTick(); assert.deepEqual(f.vm.items.map(item => item.id), ['plc-number'])
})

test('motion selector accepts only affirmative server capability and shows the repair reason for a disabled existing source', async t => {
  const blocked = { ...catalog, items: catalog.items.map(item => item.id === 'text' ? { ...item, motionReady: false, motionError: '此设备没有所属产线，无法满足数据表映射' } : item.id === 'internal' ? { ...item, motionReady: undefined } : item) }
  const f = await fixture(t, motionPicker.Component, { catalog: blocked, dataItemId: 'text', pointId: 'p1' })
  assert.equal(f.vm.selected, null)
  assert.match(f.vm.unavailable.motionError, /所属产线/)
  assert.equal(f.vm.availableItems.some(item => ['text', 'internal'].includes(item.id)), false)
  f.vm.choose('text'); f.vm.choose('internal'); assert.deepEqual(f.emitted, [])
})

test('explicit unbind is available independently of source readiness but readonly and pending requests cannot clear it', async t => {
  const f = await fixture(t, motionPicker.Component, { catalog, dataItemId: 'removed-source' })
  f.vm.clear(); assert.deepEqual(f.emitted, [{ type: 'clear' }])
  await f.render({ busy: true }); f.vm.clear(); assert.equal(f.emitted.length, 1)
  await f.render({ busy: false, disabled: true }); f.vm.clear(); assert.equal(f.emitted.length, 1)
  assert.match(motionPicker.source, /解除动作数据绑定/)
  assert.match(motionPicker.source, /同时停用此动作/)
})

for (const { source } of [hierarchy, motionPicker]) test('new motion selectors compile with accessible native controls and beginner-facing labels', () => {
  const { descriptor } = parse(source), script = compileScript(descriptor, { id: 'selector-compile' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'Selector.vue', id: 'selector-compile', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  assert.match(source, /aria-label=/)
})
