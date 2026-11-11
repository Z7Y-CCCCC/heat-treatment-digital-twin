import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, reactive, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { installBrowser, deferred, settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/AssetHierarchyBar.vue', import.meta.url)
const { descriptor } = parse(await readFile(url, 'utf8'))
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: url.pathname, id: 'hierarchy' }).errors, [])
let compiled = compileScript(descriptor, { id: 'hierarchy' }).content
compiled = compiled.replace(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/\.\.\/\.\.\/(?:config\/factoryConfig|runtime\/factoryScope)\.js['"]/g,
  'const {$1} = globalThis.__assetHierarchyFixture')
compiled = compiled.replace("from 'vue'", `from ${JSON.stringify(import.meta.resolve('vue'))}`)
let fixtureId = 0
async function fixture(t, options = {}) {
  const { browser, beforeRestore } = installBrowser(t)
  const writes = []
  browser.location = { reload: () => writes.push('reload') }
  const listFactories = options.listFactories || (async () => ({ activeFactoryId: 'f1', factories: [
    { id: 'f1', name: '当前工厂', enabled: true }, { id: 'f2', name: '另一个工厂', enabled: true }
  ] }))
  globalThis.__assetHierarchyFixture = { adminApi: { listFactories }, getFactoryScope: () => 'f1',
    setFactoryScope: id => writes.push(id), FACTORY_DIRECTORY_CHANGE_EVENT: 'factory-directory' }
  const { default: Component } = await import(`data:text/javascript;base64,${Buffer.from(compiled + '\n// fixture ' + fixtureId++).toString('base64')}`)
  delete globalThis.__assetHierarchyFixture
  Component.render = () => null
  const props = reactive({ workshops: [{ id: 'w1', name: '第一车间' }], lines: [{ id: 'l1', workshop_id: 'w1', name: '第一产线' }],
    devices: [{ id: 'd1', name: '多用炉', line_id: 'l1' }], requestSwitch: async () => false, ...options.props })
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null)
  const app = renderer.createApp({ render: () => h(Component, { ...props, ref: instance }) })
  app.mount({})
  beforeRestore(() => app.unmount())
  await settle()
  return { state: instance.value.$.setupState, props, writes }
}

test('factory card keeps workshop, line and device context available in its tooltip', async t => {
  const { state, props } = await fixture(t)
  assert.equal(state.currentFactory.name, '当前工厂')
  assert.deepEqual(state.hierarchy.map(({ level, name }) => [level, name]), [['车间', '全部'], ['产线', '全部'], ['设备', '全部']])
  props.deviceId = 'd1'
  await settle()
  assert.deepEqual(state.hierarchy.map(p => p.name), ['第一车间', '第一产线', '多用炉'])
  props.devices[0].name = '更新后的设备名称'
  await settle()
  assert.equal(state.hierarchy[2].name, '更新后的设备名称')
  assert.equal(state.scopeTitle, '当前工厂\n车间：第一车间\n产线：第一产线\n设备：更新后的设备名称')
  assert.equal(state.factoryLabel, '当前工厂')
})

test('unnamed and workshop-level devices do not pretend to select every device or production line', async t => {
  const { state, props } = await fixture(t, { props: { deviceId: 'aux', workshopId: 'w1', devices: [{ id: 'aux', line_id: null }] } })
  assert.deepEqual(state.hierarchy.map(p => p.name), ['第一车间', '未分配', 'aux'])
  props.deviceId = ''
  await settle()
  assert.deepEqual(state.hierarchy.map(p => p.name), ['第一车间', '全部', '全部'])
})

test('factory switching still waits for draft approval and restores a cancelled selection', async t => {
  const response = deferred()
  const { state, props, writes } = await fixture(t, { props: { requestSwitch: () => response.promise } })
  state.toggleMenu()
  const pending = state.changeFactory('f2')
  assert.equal(state.switching, true)
  assert.equal(state.open, false)
  assert.equal(state.factoryLabel, '正在切换…')
  assert.deepEqual(writes, [])
  response.resolve(false)
  await pending
  assert.equal(state.factoryId, 'f1')
  assert.deepEqual(writes, [])
  props.requestSwitch = async args => { assert.deepEqual(args, { factoryId: 'f2', factoryName: '另一个工厂' }); return true }
  await settle()
  await state.changeFactory('f2')
  assert.deepEqual(writes, ['f2', 'reload'])
  assert.equal(state.factoryId, 'f2')
})

test('switching errors retain the current scope and successful directory refresh clears stale errors', async t => {
  const { state, writes } = await fixture(t, { props: { requestSwitch: async () => { throw new Error('草稿尚未保存') } } })
  await state.changeFactory('f2')
  assert.equal(state.error, '草稿尚未保存')
  assert.equal(state.switching, false)
  assert.equal(state.factoryId, 'f1')
  assert.deepEqual(writes, [])
  await state.reloadFactories()
  assert.equal(state.error, '')
})

test('reference-style factory card has a custom listbox with selected markers instead of native dropdown styling', () => {
  assert.doesNotMatch(descriptor.template.content, /资产归属|asset-hierarchy-heading|asset-hierarchy-note|此处只|适用层级/)
  assert.match(descriptor.template.content, /aria-label="当前编辑工厂"/)
  assert.match(descriptor.template.content, /当前工厂 \/ 区域/)
  assert.match(descriptor.template.content, /asset-factory-icon/)
  assert.match(descriptor.template.content, /asset-factory-dot/)
  assert.match(descriptor.template.content, /:title="scopeTitle"/)
  assert.match(descriptor.template.content, /:aria-busy="switching"/)
  assert.match(descriptor.template.content, /role="combobox"/)
  assert.match(descriptor.template.content, /role="listbox"/)
  assert.match(descriptor.template.content, /:aria-selected="factory.id === factoryId"/)
  assert.match(descriptor.template.content, /asset-factory-selected-mark/)
  assert.doesNotMatch(descriptor.template.content, /<select/)
  assert.doesNotMatch(descriptor.template.content, /<ol|asset-hierarchy-path/)
  const css = descriptor.styles.map(style => style.content).join('')
  assert.match(css, /width:340px;max-width:100%/)
  assert.match(css, /min-height:52px/)
  assert.match(css, /:focus-visible/)
  assert.match(css, /text-overflow:ellipsis;white-space:nowrap/)
})

test('custom factory menu supports keyboard navigation, escape, tab and invalid selections safely', async t => {
  const { state, writes } = await fixture(t)
  const key = key => state.keydown({ key, preventDefault() {}, stopPropagation() {} })
  key('ArrowDown')
  assert.equal(state.open, true)
  assert.equal(state.highlightedIndex, 0)
  assert.match(state.activeOptionId, /-0$/)
  key('ArrowDown')
  assert.equal(state.highlightedIndex, 1)
  key('ArrowDown')
  assert.equal(state.highlightedIndex, 0)
  key('End')
  assert.equal(state.highlightedIndex, 1)
  key('Home')
  assert.equal(state.highlightedIndex, 0)
  key('Escape')
  assert.equal(state.open, false)
  assert.equal(state.activeOptionId, undefined)
  state.toggleMenu()
  key('Tab')
  assert.equal(state.open, false)
  await state.changeFactory('unknown')
  await state.changeFactory('f1')
  assert.deepEqual(writes, [])
})

test('factory menu uses actual counts and closes on outside interaction', async t => {
  const { state } = await fixture(t)
  assert.equal(state.factorySummary({ workshopCount: 2, lineCount: 3, deviceCount: 12 }), '2 个车间 · 3 条产线 · 12 台设备')
  assert.equal(state.factorySummary({}), '独立工厂配置')
  state.toggleMenu()
  state.outside({ target: {} })
  assert.equal(state.open, false)
})

test('factory card lives in the top toolbar rather than the scrolling content', async () => {
  const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  const header = panel.slice(panel.indexOf('<header class="admin-header"'), panel.indexOf('</header>', panel.indexOf('<header class="admin-header"')))
  const main = panel.slice(panel.indexOf('<main ref="adminContentRef"'))
  assert.match(header, /admin-factory-switch-slot[\s\S]*<AssetHierarchyBar/)
  assert.doesNotMatch(main, /<AssetHierarchyBar/)
  assert.equal((panel.match(/<AssetHierarchyBar/g) || []).length, 1)
})
