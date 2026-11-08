import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { buildDeviceDirectory, deviceDirectorySelection } from '../src/views/admin/utils/deviceDirectory.js'

const sourceUrl = new URL('../src/views/admin/components/DeviceManagementBrowser.vue', import.meta.url)
const source = await readFile(sourceUrl, 'utf8'), { descriptor } = parse(source)
let compiled = compileScript(descriptor, { id: 'device-management-browser' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) compiled = compiled.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], sourceUrl).href : import.meta.resolve(match[2]))}`)
const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Component.render = () => null
const workshops = [{ id: 'w1', name: '热处理车间', sort_order: 1 }, { id: 'w2', name: '装配车间', sort_order: 2 }, { id: 'w0', name: '空车间', sort_order: 3 }]
const lines = [{ id: 'l1', name: '热处理一线', workshop_id: 'w1' }, { id: 'l2', name: '装配线', workshop_id: 'w2' }, { id: 'empty', name: '预留线', workshop_id: 'w1' }]
const devices = [{ id: 'd1', name: '1# 多用炉', line_id: 'l1', sort_order: 1 }, { id: 'd2', name: '装配机', line_id: 'l2', sort_order: 2 },
  { id: 'cart1', name: '1# 小车', line_id: 'l1', model_type: 'transfer_cart', sort_order: 3 },
  { id: 'fan', name: '车间风机', instance_config: JSON.stringify({ role: 'auxiliary', workshop_id: 'w1' }), sort_order: 4 },
  { id: 'orphan', name: '待分配炉', line_id: 'removed-line', instance_config: 'null', sort_order: 5 }]
const input = { workshops, lines, devices }, directory = buildDeviceDirectory(input)

test('workshops > lines > fixed/auxiliary is a read-only projection with exact counts', () => {
  const snapshot = JSON.stringify(input), d = buildDeviceDirectory(input)
  assert.equal(d.root.count, 5); assert.equal(d.root.fixedCount, 3); assert.equal(d.root.auxiliaryCount, 2)
  const workshop = d.root.children.find(node => node.workshopId === 'w1'), line = workshop.children.find(node => node.lineId === 'l1')
  assert.equal(workshop.count, 3); assert.equal(line.count, 2)
  assert.deepEqual(line.children.map(node => [node.label, node.count]), [['固定设备', 1], ['辅助设备', 1]])
  assert.deepEqual(line.children[0].rows.map(row => row.device.id), ['d1']); assert.deepEqual(line.children[1].rows.map(row => row.device.id), ['cart1'])
  assert.equal(JSON.stringify(input), snapshot)
})

test('workshop-level auxiliaries and orphan devices remain selectable, never silently assigned', () => {
  const local = directory.root.children.find(node => node.workshopId === 'w1').children.find(node => !node.lineId)
  assert.equal(local.label, '车间级设备'); assert.deepEqual(local.rows.map(row => row.device.id), ['fan'])
  const unknown = directory.root.children.find(node => !node.workshopId)
  assert.equal(unknown.label, '未分配车间'); assert.deepEqual(unknown.rows.map(row => row.device.id), ['orphan'])
  assert.match(unknown.rows[0].path, /未分配车间 \/ 未分配产线 \/ 待分配炉/)
  assert.equal(unknown.children[0].children[0].count, 1)
})

test('a valid auxiliary workshop takes precedence over a conflicting reference line without duplicating it', () => {
  const d = buildDeviceDirectory({ ...input, devices: [{ id: 'cross', line_id: 'l2', instance_config: { role: 'auxiliary', workshop_id: 'w1' } }] })
  assert.equal(d.root.count, 1); assert.equal(d.rows[0].workshopId, 'w1'); assert.equal(d.rows[0].lineId, '')
  assert.equal(d.root.children.find(node => node.workshopId === 'w2').count, 0)
})

test('numeric IDs, malformed metadata and missing workshop parents are handled', () => {
  const d = buildDeviceDirectory({ workshops: [{ id: 1, name: '一车间' }], lines: [{ id: 2, workshop_id: 1, name: '一线' }, { id: 3, workshop_id: 'gone', name: '未归属线' }],
    devices: [{ id: 7, line_id: 2, instance_config: '{oops' }, { id: 8, line_id: 3 }, { id: 9, instance_config: '{"sceneObject":true,"workshopId":1}' }] })
  assert.equal(d.root.count, 3); assert.equal(d.rows[0].workshopId, '1'); assert.equal(d.rows[0].lineId, '2')
  const unknown = d.root.children.find(node => node.workshopId === '')
  assert.equal(unknown.children.find(node => node.lineId === '3').count, 1)
  assert.equal(d.root.children.find(node => node.workshopId === '1').children.find(node => !node.lineId).count, 1)
})

test('default is first populated category, empty categories remain explicitly empty', () => {
  assert.equal(deviceDirectorySelection(directory).label, '固定设备'); assert.deepEqual(deviceDirectorySelection(directory).rows.map(row => row.device.id), ['d1'])
  const emptyLine = directory.root.children[0].children.find(node => node.lineId === 'empty')
  assert.equal(deviceDirectorySelection(directory, emptyLine.children[0].key).count, 0)
  assert.equal(deviceDirectorySelection(directory, 'deleted-node').key, directory.defaultKey)
  const empty = buildDeviceDirectory(); assert.equal(deviceDirectorySelection(empty).key, 'all'); assert.equal(empty.root.count, 0)
})

async function mounted(t, props = input) {
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const root = {}; let vm; const current = { ...props, factoryId: 'f1' }
  async function render(next = {}) { Object.assign(current, next); const vnode = h(Component, { ...current }); renderer.render(vnode, root); vm = vnode.component.setupState; await nextTick(); await nextTick() }
  t.after(() => renderer.render(null, root)); await render()
  return { get vm() { return vm }, render }
}

test('browsing selects only one content region and scrolling returns to top on scope changes', async t => {
  const f = await mounted(t)
  assert.equal(f.vm.selected.rows.length, 1)
  const workshop = f.vm.directory.root.children.find(node => node.workshopId === 'w2')
  f.vm.tableScroll = { scrollTop: 456 }; f.vm.choose(workshop)
  assert.deepEqual(f.vm.selected.rows.map(row => row.device.id), ['d2']); assert.equal(f.vm.tableScroll.scrollTop, 0)
  assert.equal(f.vm.expanded.has(workshop.key), true)
  f.vm.choose(f.vm.directory.root); assert.equal(f.vm.selected.count, 5)
})

test('catalog refresh preserves selection and user collapses; deletion or factory switch chooses a valid scope', async t => {
  const f = await mounted(t), selectedKey = f.vm.selected.key, lineKey = f.vm.selected.parentKey
  f.vm.toggle(f.vm.directory.nodeByKey.get(lineKey)); assert.equal(f.vm.expanded.has(lineKey), false)
  await f.render({ devices: devices.map(device => ({ ...device, plc_enabled: 1 })) })
  assert.equal(f.vm.selected.key, selectedKey); assert.equal(f.vm.expanded.has(lineKey), false)
  await f.render({ lines: lines.filter(line => line.id !== 'l1'), devices: devices.filter(device => device.line_id !== 'l1') })
  assert.notEqual(f.vm.selected.key, selectedKey); assert.equal(f.vm.selected.count, 1)
  f.vm.choose(f.vm.directory.root); await f.render({ factoryId: 'f2', workshops: [{ id: 'w-new', name: '新车间' }], lines: [], devices: [] })
  assert.equal(f.vm.selected.label, '新车间'); assert.equal(f.vm.selected.count, 0)
})

test('single table, overflow boundaries, native navigation and existing CRUD permissions compile', async () => {
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: sourceUrl.pathname, id: 'device-directory', compilerOptions: { bindingMetadata: compileScript(descriptor, { id: 'device-directory' }).bindings } }).errors, [])
  assert.equal((source.match(/<table\b/g) || []).length, 1); assert.match(source, /设备分类导航/)
  assert.match(source, /device-directory-tree\{[^}]*overflow:auto/); assert.match(source, /device-directory-table-scroll\{[^}]*overflow:auto/)
  assert.match(source, /:title="row.path"/); assert.doesNotMatch(source, /type="search"|placeholder=".*搜索/)
  const admin = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  assert.match(admin, /<DeviceManagementBrowser[^>]*:key="dataCenterFactoryId"/)
  assert.match(admin, /@click="openEditDevice\(d\)"[^>]*v-permission="\{ page: controlPermissionPage, action: 'edit' \}"/)
  assert.match(admin, /@click="deleteDevice\(d.id\)"[^>]*v-permission="\{ page: controlPermissionPage, action: 'delete' \}"/)
  assert.doesNotMatch(admin.slice(admin.indexOf('<!-- ======== 设备管理 ========'), admin.indexOf('<!-- ======== 设备运动配置 ========')), /v-for="line in lines"[^>]*class="device-group"/)
})

test('only one heading/add-device entry remains and typography stays readable at all sizes', async () => {
  const admin = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  const area = admin.slice(admin.indexOf('<!-- ======== 设备管理 ========'), admin.indexOf('<!-- ======== 设备运动配置 ========'))
  assert.equal((area.match(/@click="openCreateDevice"/g) || []).length, 1)
  assert.equal((area.match(/>\+ 添加设备</g) || []).length, 1)
  assert.doesNotMatch(area, /<h2>设备管理<\/h2>|管理所有设备，包括设备名称/)
  assert.equal((source.match(/<h2>设备管理<\/h2>/g) || []).length, 1)
  const sizes = [...source.matchAll(/font-size:calc\((\d+)px \* var\(--admin-font-scale,1\)\)/g)].map(match => Number(match[1]))
  assert.ok(sizes.length >= 20); assert.ok(sizes.every(value => value >= 12))
  assert.equal((source.match(/font-size:/g) || []).length, sizes.length, 'every declared size obeys reading settings')
  assert.match(source, /\.directory-node\{[^}]*font-size:calc\(14px/)
  assert.match(source, /\.directory-device-name\{[^}]*font-size:calc\(14px/)
  assert.doesNotMatch(source, /\.directory-model-(?:column|cell)[^{]*\{[^}]*display:none/)
  assert.doesNotMatch(source, /\.device-directory-table th:nth-child\(2\)\{[^}]*display:none/)
  assert.match(source, /@media\(max-width:850px\)\{\.device-directory-table\{min-width:570px/)
  const luminance = hex => { const colors = hex.match(/\w\w/g).map(value => { const c = parseInt(value, 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4 }); return colors[0] * .2126 + colors[1] * .7152 + colors[2] * .0722 }
  for (const [foreground, background] of [['52637a','ffffff'], ['52637a','f7f9fc'], ['1f5dc2','e7effe'], ['2c425c','ffffff'], ['526f9b','edf3fc'], ['176c63','e8f5f2']]) {
    const a = luminance(foreground), b = luminance(background); assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05) >= 4.5, `${foreground} on ${background} meets normal-text contrast`)
  }
})
