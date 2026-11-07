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
  const environment = installBrowser(t), emitted = [], scopeChanges = []
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const root = {}, props = { ...initialProps }; let vm
  async function render(next = {}) { Object.assign(props, next); const vnode = h(Component, { ...props, onSelect: item => emitted.push(item), onClear: () => emitted.push({ type: 'clear' }), onScopeChange: scope => scopeChanges.push(scope) }); renderer.render(vnode, root); vm = vnode.component.setupState; await nextTick(); await settle() }
  environment.beforeRestore(() => renderer.render(null, root))
  await render()
  return { get vm() { return vm }, props, render, emitted, scopeChanges, environment, unmount: () => renderer.render(null, root) }
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

test('scope-only browsing emits workshop-wide and line ranges without selecting or changing the current device', async t => {
  const selected = [], f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly: true, requestDevice: async id => { selected.push(id); return true } })
  f.vm.toggle(); assert.equal(f.vm.open, true)
  assert.equal(f.vm.workshopId, 'w1'); assert.equal(f.vm.lineId, 'l1')
  assert.deepEqual(f.scopeChanges, [], 'opening may reveal the current path but must not filter the parent list')
  assert.equal(f.vm.chooseWorkshop('w2'), true); assert.equal(f.vm.lineId, '')
  assert.equal(f.vm.open, true, 'choosing a workshop keeps the menu open for an optional narrower line')
  assert.deepEqual(f.scopeChanges, [{ workshopId: 'w2', lineId: '' }])
  assert.equal(f.vm.chooseLine('l2'), true); assert.equal(f.vm.open, false)
  assert.deepEqual(f.scopeChanges, [{ workshopId: 'w2', lineId: '' }, { workshopId: 'w2', lineId: 'l2' }])
  assert.equal(await f.vm.chooseDevice('d2'), false)
  assert.equal(f.props.deviceId, 'd1'); assert.deepEqual(selected, [])
})

test('scope-only reopen and current-device changes retain the parent range including workshop-wide empty line', async t => {
  const f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly: true, scopeWorkshopId: 'w2', scopeLineId: '' })
  f.vm.toggle(); assert.equal(f.vm.workshopId, 'w2'); assert.equal(f.vm.lineId, '')
  assert.equal(f.vm.chooseLine('l2'), true)
  await f.render({ scopeLineId: 'l2' })
  f.vm.toggle(); assert.equal(f.vm.workshopId, 'w2'); assert.equal(f.vm.lineId, 'l2')
  await f.render({ deviceId: 'aux' })
  assert.equal(f.vm.workshopId, 'w2'); assert.equal(f.vm.lineId, 'l2', 'selection outside the navigation scope must not silently rewrite it')
  await f.render({ scopeLineId: '' })
  assert.equal(f.vm.lineId, '')
  f.vm.toggle(); f.vm.toggle(); assert.equal(f.vm.workshopId, 'w2'); assert.equal(f.vm.lineId, '')
  assert.deepEqual(f.scopeChanges, [{ workshopId: 'w2', lineId: 'l2' }], 'parent prop echoes and opening do not emit duplicate changes')
})

test('scope-only current factory resets to every device without switching factories or auto-selecting', async t => {
  const switches = [], selected = [], f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly: true, scopeWorkshopId: 'w2', scopeLineId: 'l2', requestFactorySwitch: input => { switches.push(input); return true }, requestDevice: id => selected.push(id) })
  f.vm.toggle(); assert.equal(await f.vm.chooseFactory('f1'), true)
  assert.equal(f.vm.workshopId, ''); assert.equal(f.vm.lineId, ''); assert.equal(f.vm.open, true)
  assert.deepEqual(f.scopeChanges, [{ workshopId: '', lineId: '' }])
  await f.render({ scopeWorkshopId: '', scopeLineId: '' })
  assert.equal(f.vm.workshopId, ''); assert.equal(f.vm.lineId, '')
  assert.equal(f.props.factoryId, 'f1'); assert.equal(f.props.deviceId, 'd1')
  assert.deepEqual(switches, []); assert.deepEqual(selected, [])
})

test('scope-only factory switch keeps the awaited parent guard and emits nothing on canceled, pending or accepted switches', async t => {
  const pending = deferred(), calls = [], f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly: true, scopeWorkshopId: 'w2', scopeLineId: '', requestFactorySwitch: input => { calls.push(input); return pending.promise } })
  f.vm.toggle(); const switching = f.vm.chooseFactory('f2')
  assert.equal(f.vm.switching, true)
  assert.equal(f.vm.chooseWorkshop('w1'), false); assert.equal(f.vm.chooseLine('l2'), false)
  assert.equal(await f.vm.chooseFactory('f1'), false, 'even local full-factory reset is blocked while the parent switch is pending')
  pending.resolve(false); assert.equal(await switching, false)
  assert.equal(f.vm.open, true); assert.equal(f.vm.workshopId, 'w2'); assert.equal(f.vm.lineId, '')
  assert.deepEqual(f.scopeChanges, []); assert.deepEqual(calls, [{ factoryId: 'f2', factoryName: '工厂二' }])
  await f.render({ requestFactorySwitch: async () => true })
  assert.equal(await f.vm.chooseFactory('f2'), true); assert.equal(f.vm.open, false)
  assert.equal(f.props.factoryId, 'f1'); assert.equal(f.props.deviceId, 'd1'); assert.deepEqual(f.scopeChanges, [])
})

test('scope-only invalid and disabled branches cannot emit; auxiliary devices remain filterable without a fourth column', async t => {
  const f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly: true, scopeWorkshopId: 'w1', scopeLineId: '' })
  f.vm.toggle()
  assert.equal(f.vm.chooseWorkshop('missing'), false); assert.equal(f.vm.chooseLine('l2'), false)
  assert.equal(f.vm.open, true); assert.deepEqual(f.scopeChanges, [])
  assert.equal(f.vm.chooseLine('__unassigned'), true)
  assert.deepEqual(f.scopeChanges, [{ workshopId: 'w1', lineId: '__unassigned' }])
  assert.equal(await f.vm.chooseDevice('aux'), false)
  await f.render({ disabled: true })
  assert.equal(f.vm.chooseWorkshop('w2'), false); assert.equal(f.vm.chooseLine('l1'), false)
  assert.equal(await f.vm.chooseFactory('f1'), false)
  assert.equal(f.scopeChanges.length, 1)
})

test('scope-only three-column menu clamps its smaller popover and still removes all listeners on unmount', async t => {
  const f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly: true })
  f.environment.browser.innerWidth = 900; f.environment.browser.innerHeight = 700
  f.vm.host = { getBoundingClientRect: () => ({ left: 320, top: 100, bottom: 150 }), contains: () => true }
  f.vm.toggle(); await nextTick()
  assert.equal(f.vm.menuStyle.width, '630px'); assert.equal(f.vm.menuStyle.left, '254px')
  f.environment.browser.innerWidth = 600
  for (const handler of f.environment.browser.listeners.get('resize')) handler()
  assert.equal(f.vm.menuStyle.width, '568px'); assert.equal(f.vm.menuStyle.left, '16px')
  f.unmount(); assert.equal(f.environment.browser.listeners.get('resize').size, 0); assert.equal(f.environment.browser.listeners.get('scroll').size, 0)
})

test('scope-only template removes the device column and explains the one lower-list selection entry while retaining four-level compatibility', () => {
  assert.match(hierarchy.source, /defineEmits\(\['scope-change'\]\)/)
  assert.match(hierarchy.source, /<section v-if="!scopeOnly"><h4>04 <span>设备<\/span>/)
  assert.match(hierarchy.source, /scopeOnly \? '按工厂车间产线选择范围' : '按工厂车间产线选择设备'/)
  assert.match(hierarchy.source, /选择工厂、车间或产线，具体设备在下方列表中选择/)
  assert.match(hierarchy.source, /@click="chooseLine\(line.id\)"/)
  assert.match(hierarchy.source, /\.hierarchy-columns\.scope-only\s*\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/)
  assert.match(hierarchy.source, /scopeWorkshopId: \{ type: String, default: '' \}, scopeLineId: \{ type: String, default: '' \}/)
  assert.doesNotMatch(hierarchy.source, /setFactoryScope|window\.location\.reload|loadConfig/)
})

for (const scopeOnly of [false, true]) test(`null JSON instance configuration stays reachable under unassigned ${scopeOnly ? 'scope-only' : 'full hierarchy'} branches`, async t => {
    const selected = [], f = await fixture(t, hierarchy.Component, { ...structure, scopeOnly, deviceId: 'null-instance', devices: [...structure.devices, { id: 'null-instance', name: '未分配设备', instance_config: 'null' }], requestDevice: id => { selected.push(id); return true } })
    f.vm.toggle()
    assert.equal(f.vm.workshopId, '__unassigned'); assert.equal(f.vm.lineId, '__unassigned')
    assert.deepEqual(f.vm.deviceOptions.map(device => device.id), ['null-instance'])
    assert.equal(f.vm.chooseLine('__unassigned'), true)
    if (scopeOnly) {
      assert.deepEqual(f.scopeChanges, [{ workshopId: '__unassigned', lineId: '__unassigned' }])
      assert.equal(await f.vm.chooseDevice('null-instance'), false); assert.deepEqual(selected, [])
    } else {
      assert.equal(await f.vm.chooseDevice('null-instance'), true); assert.deepEqual(selected, ['null-instance'])
      assert.deepEqual(f.scopeChanges, [])
    }
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
  assert.equal(f.vm.categoryId, 'live'); assert.equal(f.vm.tableId, 'plc', 'existing source restores its category and table without emitting')
  f.vm.changeCategory('business'); await nextTick(); assert.deepEqual(f.vm.items, [])
  f.vm.changeTable('mes'); await nextTick(); assert.deepEqual(f.vm.items.map(item => item.id), ['text'])
  f.vm.choose('text'); assert.equal(f.emitted[0].id, 'text')
  f.vm.choose('part'); f.vm.choose('disabled'); f.vm.choose('broken-source'); assert.equal(f.emitted.length, 1)
  await f.render({ disabled: true }); f.vm.choose('text'); assert.equal(f.emitted.length, 1)
})

test('missing dataItemId never falls back to an old point; category and table dropdowns filter without a search field', async t => {
  const f = await fixture(t, motionPicker.Component, { catalog, dataItemId: 'deleted-data', pointId: 'p1' })
  assert.equal(f.vm.selected, null)
  assert.deepEqual(f.vm.tables, []); assert.deepEqual(f.vm.items, [])
  f.vm.changeTable('mes'); assert.equal(f.vm.tableId, '', 'a table cannot be chosen before its category')
  f.vm.changeCategory('business'); f.vm.changeTable('mes'); await nextTick(); assert.deepEqual(f.vm.items.map(item => item.id), ['text'])
  f.vm.changeCategory('live'); await nextTick()
  assert.equal(f.vm.tableId, '', 'changing category always clears the table')
  assert.deepEqual(f.vm.items, [])
  f.vm.changeTable('plc'); await nextTick()
  assert.deepEqual(f.vm.items.map(item => item.id), ['plc-number', 'bool', 'internal'])
  assert.doesNotMatch(motionPicker.source, /搜索动作数据|搜索中文名称或单位|type="search"|\bquery\b/)
  assert.doesNotMatch(motionPicker.source, /全部分类|全部数据表|已绑定 ·/)
  assert.equal((parse(motionPicker.source).descriptor.template.content.match(/<select\b/g) || []).length, 3)
})

test('empty categories expose no fake tables or fields and browsing cannot alter the current binding', async t => {
  const emptyCatalog = { ...catalog, categories: [...catalog.categories, { id: 'empty', name: '空分类' }] }
  const f = await fixture(t, motionPicker.Component, { catalog: emptyCatalog, dataItemId: 'plc-number' })
  f.vm.changeCategory('empty'); await nextTick()
  assert.equal(f.vm.tableId, ''); assert.deepEqual(f.vm.tables, []); assert.deepEqual(f.vm.items, [])
  assert.match(f.vm.tablePlaceholder, /暂无.*数据表/)
  assert.equal(f.vm.selected.id, 'plc-number'); assert.equal(f.vm.selectedInScope, false); assert.deepEqual(f.emitted, [])
  f.vm.choose('plc-number'); f.vm.changeTable('plc'); assert.deepEqual(f.emitted, [])
  assert.equal(f.vm.tableId, '', 'a foreign table cannot bypass the empty category')
  f.vm.changeCategory(''); assert.equal(f.vm.tablePlaceholder, '请先选择分类')
  assert.equal(f.vm.selected.id, 'plc-number'); assert.deepEqual(f.emitted, [])
})

test('shared tables still require explicit re-selection after changing category, and cross-scope fields are rejected', async t => {
  const sharedCatalog = { ...catalog, items: [...catalog.items, { ...catalog.items[2], id: 'shared-text', tableId: 'plc' }] }
  const f = await fixture(t, motionPicker.Component, { catalog: sharedCatalog, dataItemId: 'plc-number' })
  f.vm.changeCategory('business'); await nextTick()
  assert.equal(f.vm.tableId, ''); assert.deepEqual(f.vm.items, [])
  f.vm.choose('shared-text'); assert.deepEqual(f.emitted, [])
  f.vm.changeTable('plc'); await nextTick(); assert.deepEqual(f.vm.items.map(item => item.id), ['shared-text'])
  f.vm.choose('plc-number'); assert.deepEqual(f.emitted, [])
  f.vm.choose('shared-text'); assert.equal(f.emitted[0].id, 'shared-text')
})

test('first-load orphan category/table references show explicit placeholders without changing the stored binding', async t => {
  for (const directory of [{ ...catalog, categories: [] }, { ...catalog, tables: [] }]) {
    const f = await fixture(t, motionPicker.Component, { catalog: directory, dataItemId: 'plc-number' })
    assert.equal(f.vm.tableId, ''); assert.equal(f.vm.selectedTable, undefined)
    assert.deepEqual(f.vm.items, []); assert.equal(f.vm.selected.id, 'plc-number'); assert.deepEqual(f.emitted, [])
    if (!directory.categories.length) { assert.equal(f.vm.categoryId, ''); assert.equal(f.vm.tablePlaceholder, '请先选择分类') }
    else assert.match(f.vm.tablePlaceholder, /暂无.*数据表/)
  }
})

test('catalog refresh preserves manual browsing and saved source identity; deleted tables clear only local scope', async t => {
  const f = await fixture(t, motionPicker.Component, { catalog, dataItemId: 'plc-number' })
  f.vm.changeCategory('business'); f.vm.changeTable('mes'); await nextTick()
  await f.render({ catalog: { ...catalog, items: catalog.items.map(item => ({ ...item, previewValue: 99 })) } })
  assert.equal(f.vm.categoryId, 'business'); assert.equal(f.vm.tableId, 'mes'); assert.equal(f.vm.selected.id, 'plc-number')
  assert.deepEqual(f.emitted, [])
  await f.render({ catalog: { ...catalog, tables: catalog.tables.filter(table => table.id !== 'mes') } })
  assert.equal(f.vm.tableId, ''); assert.deepEqual(f.vm.items, []); assert.equal(f.vm.selected.id, 'plc-number'); assert.deepEqual(f.emitted, [])
  await f.render({ catalog, dataItemId: 'text' })
  assert.equal(f.vm.categoryId, 'business'); assert.equal(f.vm.tableId, 'mes'); assert.equal(f.vm.selectedInScope, true)
  assert.deepEqual(f.emitted, [], 'binding props are echoed, never re-emitted as a constant or new selection')
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
