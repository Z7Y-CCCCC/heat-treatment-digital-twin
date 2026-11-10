import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, proxyRefs } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { deferred, installBrowser, settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/DataCatalogPicker.vue', import.meta.url)
const source = await readFile(url, 'utf8')
const { descriptor } = parse(source.replace('</script>', '\ndefineExpose({ catalog, loading, error, categoryId, tableId, chosenId, items, tables, chosen, current, load, choose, selectChoice })\n</script>'))
let compiled = compileScript(descriptor, { id: 'catalog-test' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  const name = match[2], target = name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name)
  compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: Picker } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Picker.render = () => null
const apiResult = (id = 'A') => ({ success: true, categories: [{ id: 'realtime', name: '实时采集' }], tables: [{ id: `plc-${id}`, name: `${id}多用炉 · 采集点位` }],
  items: [{ id: `temp-${id}`, tableId: `plc-${id}`, categoryId: 'realtime', label: '炉内温度', unit: '℃', type: 'number', objectScope: 'device', sourceType: 'plc', deviceName: `${id}多用炉`,
    binding: { mode: 'plc', pointId: `point-${id}`, deviceId: id, pointKey: 'analog.temp', deviceScope: 'fixed' }, tooltipBinding: { mode: 'plc', pointKey: 'analog.temp', deviceScope: 'current' } }] })

async function fixture(t, load, extra = {}) {
  const environment = installBrowser(t), emitted = [], calls = []
  t.mock.method(adminApi, 'getDataCenterCatalog', options => { calls.push(options); return load(options) })
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const root = {}, props = { factoryId: 'factory-A', deviceId: 'A', widgetType: 'text', ...extra }; let vm
  const render = async extraProps => { Object.assign(props, extraProps); const vnode = h(Picker, { ...props, onSelect: item => emitted.push(item) }); renderer.render(vnode, root); vm = proxyRefs(vnode.component.exposed); await nextTick(); await settle() }
  environment.beforeRestore(() => renderer.render(null, root))
  await render()
  return { get vm() { return vm }, emitted, calls, render, unmount: () => renderer.render(null, root), browser: environment.browser }
}

test('picker keeps the original binding until an explicit choice and carries source table identity', async t => {
  const binding = { mode: 'runtime', path: 'old.path' }, before = JSON.stringify(binding)
  const f = await fixture(t, async () => apiResult(), { binding })
  assert.equal(JSON.stringify(binding), before)
  assert.equal(f.emitted.length, 0)
  f.vm.chosenId = 'temp-A'; await nextTick()
  assert.equal(f.emitted.length, 0)
  f.vm.choose()
  assert.equal(f.emitted[0].tableName, 'A多用炉 · 采集点位')
  assert.equal(f.emitted[0].unit, '℃')
  assert.equal(f.calls[0].factoryId, 'factory-A')
  assert.equal(f.calls[0].previewDeviceId, 'A')
  assert.equal(f.calls[0].deviceId, undefined, 'ordinary canvases keep the full catalog, not only the preview device')
  assert.equal(JSON.stringify(binding), before)
  f.vm.categoryId = '不匹配'; await nextTick()
  assert.equal(f.vm.chosenId, '')
  assert.equal(f.vm.items.length, 0)
})

test('immediate row picker emits only a valid explicit field selection and readonly prevents selection', async t => {
  const f = await fixture(t, async () => apiResult(), { tooltip: true, immediate: true })
  assert.equal(f.emitted.length, 0)
  f.vm.selectChoice('temp-A'); await nextTick()
  assert.equal(f.emitted.filter(Boolean).length, 1)
  f.vm.selectChoice(''); await nextTick()
  assert.equal(f.emitted.includes(null), true, 'an explicit writable clear may clear the row')
  f.vm.selectChoice('temp-A'); await nextTick()
  await f.render({ disabled: true })
  const before=f.emitted.length
  f.vm.selectChoice(''); await nextTick(); f.vm.selectChoice('temp-A'); await nextTick(); f.vm.choose()
  assert.equal(f.emitted.length, before, 'readonly selections/clears cannot emit changes')
})

test('category and table menus remain sufficient to select data without search or changing the old binding', async t => {
  const A = apiResult('A'), B = apiResult('B')
  B.items[0].categoryId = 'business'
  const catalog = { success: true,
    categories: [...A.categories, { id: 'business', name: '生产业务' }, { id: 'empty', name: '空分类' }],
    tables: [...A.tables, ...B.tables], items: [...A.items, ...B.items] }
  const binding = { mode: 'runtime', path: 'old.path' }, before = JSON.stringify(binding)
  const f = await fixture(t, async () => catalog, { binding })
  assert.deepEqual(f.vm.items.map(item => item.id), ['temp-A', 'temp-B'])
  f.vm.tableId = 'plc-A'; f.vm.chosenId = 'temp-A'; await nextTick()
  assert.deepEqual(f.vm.items.map(item => item.id), ['temp-A'])
  f.vm.categoryId = 'business'; await nextTick()
  assert.equal(f.vm.tableId, '')
  assert.equal(f.vm.chosenId, '')
  assert.deepEqual(f.vm.tables.map(table => table.id), ['plc-B'])
  f.vm.tableId = 'plc-B'; f.vm.chosenId = 'temp-B'; await nextTick()
  assert.equal(f.emitted.length, 0)
  f.vm.choose()
  assert.equal(f.emitted[0].id, 'temp-B')
  assert.equal(f.emitted[0].binding.pointId, 'point-B')
  assert.equal(JSON.stringify(binding), before)
  f.vm.categoryId = 'empty'; await nextTick()
  assert.equal(f.vm.tableId, '')
  assert.equal(f.vm.chosenId, '')
  assert.deepEqual(f.vm.items, [])
  assert.deepEqual(f.vm.tables, [])
  assert.equal(f.emitted.length, 1)
})

test('factory/device transitions clear the old catalog immediately and reject a late previous response', async t => {
  const A = deferred(), B = deferred()
  const f = await fixture(t, ({ previewDeviceId }) => previewDeviceId === 'A' ? A.promise : B.promise)
  await f.render({ factoryId: 'factory-B', deviceId: 'B' })
  assert.equal(f.vm.loading, true)
  assert.equal(f.vm.items.length, 0)
  B.resolve(apiResult('B')); await settle()
  assert.deepEqual(f.vm.items.map(item => item.id), ['temp-B'])
  A.resolve(apiResult('A')); await settle()
  assert.deepEqual(f.vm.items.map(item => item.id), ['temp-B'])
  assert.equal(f.emitted.length, 0)
})

test('failed new scope cannot leave old source fields available and refresh/unmount clean listeners', async t => {
  const f = await fixture(t, async ({ previewDeviceId }) => previewDeviceId === 'A' ? apiResult('A') : { success: false, error: '无权访问工厂 B' })
  assert.equal(f.vm.items.length, 1)
  await f.render({ factoryId: 'factory-B', deviceId: 'B' })
  assert.match(f.vm.error, /无权访问/)
  assert.equal(f.vm.items.length, 0)
  assert.equal(f.browser.listeners.get('digital-twin-data-center-changed').size, 1)
  const pending = deferred(); t.mock.method(adminApi, 'getDataCenterCatalog', () => pending.promise)
  f.vm.load(); f.unmount()
  pending.resolve(apiResult('A')); await settle()
  assert.equal(f.vm.items.length, 0)
  assert.equal(f.browser.listeners.get('digital-twin-data-center-changed').size, 0)
  assert.equal(f.browser.listeners.get('digital-twin-data-sets-changed').size, 0)
})

test('picker template compiles with native labels, beginner copy and no technical field paths', () => {
  const parsed = parse(source).descriptor
  const script = compileScript(parsed, { id: 'catalog-compile' })
  assert.deepEqual(compileTemplate({ source: parsed.template.content, filename: 'DataCatalogPicker.vue', id: 'catalog-compile', compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  for (const label of ['数据用途分类', '选择数据表', '选择具体数据']) assert.ok(source.includes(label))
  assert.doesNotMatch(source, /搜索数据项|搜索中文名称|type="search"|\bquery\b/)
  assert.doesNotMatch(parsed.template.content, /<input\b/)
  assert.doesNotMatch(parsed.template.content, /jsonPath|pointKey|apiPath|connectionId/)
})

test('global-only picker lists only real global sources and cannot apply an unavailable device field',async t=>{
  const catalog=apiResult('A')
  catalog.tables.push({id:'global-energy',name:'工厂能耗表'})
  catalog.items.push({id:'factory-energy',tableId:'global-energy',categoryId:'realtime',label:'工厂耗电量',type:'number',unit:'kWh',objectScope:'factory',sourceType:'dataset',binding:{mode:'dataset',datasetId:'energy',datasetField:'value',deviceScope:'global'}})
  const f=await fixture(t,async()=>catalog,{globalOnly:true,widgetType:'hud_kpi_panel',binding:catalog.items[1].binding})
  assert.deepEqual(f.vm.items.map(item=>item.id),['factory-energy'])
  assert.equal(f.vm.chosenId,'factory-energy');assert.equal(f.vm.tableId,'global-energy')
  f.vm.selectChoice('temp-A');f.vm.choose();assert.equal(f.emitted.length,0)
  f.vm.selectChoice('factory-energy');f.vm.choose();assert.equal(f.emitted[0].binding.deviceScope,'global')
})
