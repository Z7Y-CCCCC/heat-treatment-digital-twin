import { registerSimpleMotionEditorCases } from './simple-motion-editor-cases.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createRenderer, h, nextTick, proxyRefs, ref } from 'vue'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import { adminApi } from '../src/config/factoryConfig.js'
import { editLineRailSpacing } from '../../shared/lineRailSpacing.mjs'
import { normalizeLineLayout } from '../src/views/admin/utils/lineLayout.js'
import { installBrowser, settle } from './helpers.mjs'
import { cacheFactoryDraft, discardFactoryDrafts, listFactoryDrafts, saveFactoryDrafts } from '../src/runtime/factoryDraftCache.js'
import { simpleMotionError } from '../src/views/admin/utils/mobileMotionPolicy.js'
import { simpleMovementPayload } from '../src/views/admin/utils/simpleMotionDraft.js'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { validateMovementConfig } = require('./services/movementConfig.js')
const clone = value => JSON.parse(JSON.stringify(value))
test('movement form omits migration paragraphs and performance self-description', async () => {
  const source = await readFile(new URL('../src/views/admin/components/MobileDeviceMotion.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /本页已统一|旧设置未改动|不会把旧当前位置|低延迟策略|下一次渲染周期之外/)
})
async function component(path, expose = '') {
  const url = new URL(path, import.meta.url)
  let source = await readFile(url, 'utf8')
  if (expose) source = source.includes('defineExpose({') ? source.replace('defineExpose({', `defineExpose({ ${expose},`) : source.replace('</script>', `defineExpose({ ${expose} })\n</script>`)
  source = source.replace(/import \{ permissionDirective as vPermission \} from [^\n]+/, 'const vPermission = {}')
    .replace(/import \{ canAdminPage \} from [^\n]+/, 'const canAdminPage = () => true')
    .replace(/import \{LineSimulationScene\} from [^\n]+/, 'const LineSimulationScene = class { constructor() { throw Error("Field testing must not create a browser/WebGL renderer") } }')
  let code = compileScript(parse(source).descriptor, { id: 'motion-fields-memory', inlineTemplate: true }).content
  code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(name.endsWith('.vue') ? 'data:text/javascript,export default {render:()=>null}' : name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name))}`)
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default
}
const Mobile = await component('../src/views/admin/components/MobileDeviceMotion.vue', 'motion, errorMessage, message, loadDevice')
const Planner = await component('../src/views/admin/components/LinePlannerControls.vue')
const Sequence = await component('../src/views/admin/components/LineEquipmentSequence.vue', 'selectedIds')

// A Vue memory renderer only: no browser, real DOM, canvas, WebGL or UI driver.
function memoryHost(t) {
  const env = installBrowser(t)
  env.replace('Document', class {})
  env.replace('ShadowRoot', class {})
  env.replace('ResizeObserver', class { observe() {} disconnect() {} })
  env.browser.innerHeight = 900; env.browser.innerWidth = 1200
  t.mock.method(globalThis, 'fetch', async () => { throw Error('No live configuration/network access belongs in these field tests') })
  const node = (type, text = '') => {
    const listeners = new Map()
    return { type, tagName: type.toUpperCase(), text, props: {}, children: [], parent: null, _displayValue: '', checked: false, selected: false, style: {},
      get value() { return String(this.type === 'select' ? this.options.find(option => option.selected)?._value ?? this._displayValue : this._displayValue) },
      set value(value) { this._displayValue = String(value ?? ''); if (this.type === 'select') this.options.forEach(option => { option.selected = String(option._value) === String(value) }) },
      getRootNode: () => document, getBoundingClientRect: () => ({ top: 10, bottom: 46, left: 10, width: 560, height: 36 }),
      focus() { document.activeElement = this }, blur() { document.activeElement = null },
      contains(target) { return target === this || this.children.some(child => child.contains(target)) },
      querySelector() { return this.children[0] || null }, querySelectorAll() { return this.children },
      addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) },
      removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(item => item !== fn)) },
      getAttribute(name) { return this.props[name] }, setAttribute(name, value) { this.props[name] = value }, removeAttribute(name) { delete this.props[name] },
      get options() { return this.children.filter(child => child.type === 'option') },
      get selectedIndex() { return this.options.findIndex(option => option.selected) }, set selectedIndex(index) { this.options.forEach((option, i) => { option.selected = i === index }) },
      dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event) },
      fire(name, value) {
        if (this.type === 'select') this.options.forEach(option => { option.selected = String(option._value) === String(value) })
        if (typeof value === 'boolean') this.checked = value; else if (value !== undefined) this.value = String(value)
        const event = { target: this, currentTarget: this, type: name, stopPropagation() {}, preventDefault() {} }
        for (const fn of listeners.get(name) || []) fn(event)
        const handler = this.props['on' + name[0].toUpperCase() + name.slice(1)]
        for (const fn of Array.isArray(handler) ? handler : handler ? [handler] : []) fn(event)
      }
    }
  }
  const root = node('root'), body = node('body')
  const remove = child => { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child); child.parent = null }
  const renderer = createRenderer({ createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (child, value) => { child.text = value }, setElementText: (child, value) => { child.text = value; child.children = [] },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null, remove,
    insert(child, parent, anchor) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child) },
    patchProp(child, key, _old, value) { child.props[key] = value; if (key === 'value') { child.value = String(value ?? ''); child._value = value } else if (key === 'checked') child.checked = !!value },
    querySelector: name => name === 'body' ? body : null
  })
  const all = (child = root) => [child, ...child.children.flatMap(item => all(item))]
  const elements = () => [...all(root), ...all(body)]
  const field = label => { const found = elements().filter(child => child.props['aria-label'] === label); assert.equal(found.length, 1, 'Expected one real field: ' + label); return found[0] }
  return { root, renderer, elements, field, beforeRestore: env.beforeRestore }
}
const settled = async () => { await nextTick(); await settle(); await nextTick() }
const originalMovement = () => ({ enabled: true, currentPositionPointId: 'PLC_POS', startActionPointId: 'PLC_RUN', valueMode: 'station', smoothingMs: 100,
  simulationEnabled: true, speedMode: 'auto', maxSpeed: 2, acceleration: 1, sceneUnitsPerMeter: 3.2,
  start: { x: -20, y: 0, z: .5 }, end: { x: -10, y: 0, z: .5 }, stations: [{ value: 1, label: '现场工位', anchorDeviceId: 'station', position: { x: -21, y: 0, z: .5 } }] })
async function fixture(t, movement = originalMovement(), lineLayout, points) {
  discardFactoryDrafts('')
  const host = memoryHost(t), initialConfig = { role: 'transfer_cart', railLineId: 'L', railId: 'r', custom: { preserved: true },
    animationBindings: { version: 1, staleMs: 7200, diagnosticLogging: true, diagnosticIntervalSeconds: 4, bindings: [{ actionId: 'clip:feed', enabled: true, pointId: 'PLC_FEED' }] }, movement }
  const station = { id: 'station', name: '炉 A', line_id: 'L', coordinate_space: 'line_local', pos_x: -21, pos_y: 0, pos_z: 4, instance_config: { laneLineId: 'L', laneId: 'lane', stationNumber: 1 } }
  let saved = { id: 'cart', name: '料车', line_id: 'L', model_type: 'transfer_cart', coordinate_space: 'line_local', pos_x: -20, pos_y: 0, pos_z: 0,
    instance_config: clone(initialConfig), ...(lineLayout === undefined ? {} : { lineLayout: clone(lineLayout) }), dataPoints: points || [{ id: 'PLC_POS', data_type: 'INT', access_type: 'READ' }, { id: 'PLC_RUN', data_type: 'BOOL', access_type: 'READ' }] }
  const saves = []
  t.mock.method(adminApi, 'getDevice', async id => { assert.equal(id, 'cart'); return clone(saved) })
  t.mock.method(adminApi, 'updateDeviceMovement', async (id, next, pointIds, expected) => {
    assert.equal(id, 'cart'); validateMovementConfig(next); saves.push({ movement: clone(next), pointIds: clone(pointIds), expected: clone(expected) })
    if (JSON.stringify(expected) !== JSON.stringify(saved.instance_config.movement ?? null)) return { error: '移动配置或导轨间距已更新，请重新读取后保存', status: 409 }
    saved.instance_config.movement = clone(next); return { success: true }
  })
  let app, vm
  const mount = async () => { app = host.renderer.createApp({ setup: () => () => h(Mobile, { devices: [saved, station], ref: value => { vm = value } }) }); app.mount(host.root); await settled() }
  await mount(); host.beforeRestore(() => { app.unmount(); discardFactoryDrafts('') })
  const save = async () => { const button = host.elements().find(child => child.type === 'button' && child.props.onClick && child.props.class?.includes('btn-primary')); assert.ok(button); button.fire('click'); await settled() }
  return { ...host, saves, get vm() { return vm }, get saved() { return saved }, save, async reopen() { app.unmount(); await mount() },
    externallyShift() { saved.instance_config.movement.start.z += 3; saved.instance_config.movement.end.z += 3; saved.instance_config.movement.stations.forEach(station => { station.position.z += 3 }) } }
}


const sourceChoices = () => [
  { id: 'PLC_POS', data_type: 'WORD', access_type: 'READ', device_id: 'cart' },
  { id: 'PLC_COMMAND', label: '开始命令', data_type: 'WORD', access_type: 'READ', device_id: 'cart' },
  { id: 'PLC_RUN', label: '实际移动状态反馈', data_type: 'BOOL', access_type: 'READ', device_id: 'cart' },
  { id: 'PLC_WRITE', data_type: 'BOOL', access_type: 'WRITE', device_id: 'cart' },
  { id: 'PLC_OTHER', data_type: 'BOOL', access_type: 'READ', device_id: 'another-device' }
]
async function parentMobileDraftSaver(api) {
  const source = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
  const ast = parseJavaScript(source, { sourceType: 'module' })
  let handler
  const walk = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ObjectProperty' && node.key?.value === 'mobile-motion') handler = node.value
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value)
  }
  walk(ast); assert.equal(handler?.type, 'ArrowFunctionExpression')
  return new Function('adminApi', 'simpleMotionError', 'simpleMovementPayload', 'parseInstanceConfig', `return (${source.slice(handler.start, handler.end)})`)(
    api, simpleMotionError, simpleMovementPayload, value => typeof value === 'string' ? JSON.parse(value) : value || {})
}
registerSimpleMotionEditorCases({test,assert,fixture,clone,originalMovement,sourceChoices,settled,parentMobileDraftSaver,installBrowser,discardFactoryDrafts,cacheFactoryDraft,saveFactoryDrafts,listFactoryDrafts})
test('actual rail fields configure persisted lane/distance/side in their existing popup and respect a disabled editor', async t => {
  const host = memoryHost(t), layout = ref(normalizeLineLayout({ lanes: [{ id: 'lane', name: '设备线', offsetZ: -2, length: 60 }], rails: [{ id: 'rail', name: '小车导轨', offsetZ: 2, length: 60 }] })), busy = ref(false), emitted = [], errors = []
  const app = host.renderer.createApp({ setup: () => () => h(Planner, { lines: [{ id: 'L', name: '产线' }], selectedId: 'L', layout: layout.value, draft: {}, busy: busy.value,
    onChangeRailSpacing: value => { emitted.push(value); try { layout.value = normalizeLineLayout(editLineRailSpacing(layout.value, value.railId, value.field, value.value)) } catch (error) { errors.push(error.message) } } }) })
  app.mount(host.root); host.beforeRestore(() => app.unmount()); host.field('管理小车导轨').fire('click'); await settled()
  host.field('小车导轨 关联设备线').fire('change', 'lane'); await settled()
  assert.equal(host.field('小车导轨 偏移Z').props.disabled, true)
  host.field('小车导轨 设备线与轨道中心距（米）').fire('change', '1.75'); await settled()
  host.field('小车导轨 相对设备线方向').fire('change', 'negative'); await settled()
  assert.deepEqual(layout.value.rails[0].spacing, { laneId: 'lane', distanceMeters: 1.75, side: 'negative' }); assert.equal(layout.value.rails[0].offsetZ, -3.75)
  layout.value = normalizeLineLayout(JSON.stringify(layout.value)); await settled()
  assert.equal(host.field('小车导轨 设备线与轨道中心距（米）').value, '1.75'); assert.equal(host.field('小车导轨 相对设备线方向').value, 'negative')
  host.field('小车导轨 设备线与轨道中心距（米）').fire('change', '0'); await settled()
  assert.equal(layout.value.rails[0].spacing.distanceMeters, 1.75); assert.equal(host.field('小车导轨 设备线与轨道中心距（米）').value, '1.75', 'Rejection restores the visible real field as well as the model'); assert.equal(errors.length, 1)
  busy.value = true; await settled(); const before = JSON.stringify(layout.value)
  host.field('小车导轨 设备线与轨道中心距（米）').fire('change', '99'); await settled(); assert.equal(JSON.stringify(layout.value), before); assert.equal(emitted.length, 4)
})

test('real movement API carries an optional unnormalised CAS snapshot and preserves older callers', async t => {
  installBrowser(t); const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ success: true }), { status: 200 }) })
  const baseline = { enabled: false, legacy_key: 'preserve' }
  await adminApi.updateDeviceMovement('cart', { enabled: false }, [], baseline)
  await adminApi.updateDeviceMovement('cart', { enabled: false }, [])
  assert.deepEqual(bodies[0].expectedMovement, baseline); assert.equal(Object.hasOwn(bodies[1], 'expectedMovement'), false)
})

test('site preview fields show saved real transfer tolerances instead of editable values that the runtime ignores', async t => {
  const host = memoryHost(t)
  const cart = { id: 'cart', name: '料车', line_id: 'L', model_type: 'photo_transfer_cart_v6', instance_config: { animationBindings: { transferLink: { enabled: true, heightToleranceMeters: .12, lateralToleranceMeters: .23, angleToleranceDegrees: 7 } } } }
  const devices = ref([cart, { id: 'station', name: '炉体', line_id: 'L', model_type: 'station' }])
  const models = [{ id: 'photo_transfer_cart_v6', file_path: '/isolated.glb' }, { id: 'station', file_path: '/isolated.glb' }]
  let vm
  const app = host.renderer.createApp({ setup: () => () => h(Sequence, { devices: devices.value, models, lines: [{ id: 'L', name: '产线' }], ref: value => { vm = value } }) })
  app.mount(host.root); host.beforeRestore(() => app.unmount()); vm.selectedIds = ['cart', 'station']
  host.field('联动预览排布').fire('change', 'site'); await settled()
  assert.equal(host.field('模拟预览高度公差（米）').value, '.12'.replace(/^\./, '0.'))
  assert.equal(host.field('模拟预览横向公差（米）').value, '0.23'); assert.equal(host.field('模拟预览角度公差（度）').value, '7')
  assert.equal(host.field('模拟预览高度公差（米）').props.disabled, true)
  const before = JSON.stringify(devices.value)
  host.field('模拟预览高度公差（米）').fire('input', '0.9'); await settled()
  assert.equal(JSON.stringify(devices.value), before, 'Saved tolerances are changed only in the real transfer configuration editor')
  devices.value[0].instance_config.animationBindings.transferLink.enabled = false; await settled()
  assert.equal(host.field('模拟预览高度公差（米）').props.disabled, false)
  host.field('模拟预览高度公差（米）').fire('input', '0.8'); await settled()
  assert.equal(host.field('模拟预览高度公差（米）').value, '0.8')
})

test('changed Vue controls and responsive styles compile without a browser', async () => {
  for (const path of ['../src/views/admin/components/MobileDeviceMotion.vue', '../src/views/admin/components/LinePlannerControls.vue', '../src/views/admin/components/LineEquipmentSequence.vue', '../src/views/AdminPanel.vue']) {
    const url = new URL(path, import.meta.url), { descriptor, errors } = parse(await readFile(url, 'utf8')); assert.deepEqual(errors, [])
    assert.doesNotThrow(() => compileScript(descriptor, { id: 'motion-compile', inlineTemplate: true }))
    for (const style of descriptor.styles.filter(style => !style.src)) assert.deepEqual(compileStyle({ source: style.content, filename: path, id: 'motion-compile', scoped: style.scoped }).errors, [])
  }
})
