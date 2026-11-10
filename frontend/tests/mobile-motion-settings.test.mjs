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
import { isLastConfirmedMotion, lastConfirmedMotionError } from '../src/views/admin/utils/mobileMotionPolicy.js'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { validateMovementConfig } = require('./services/movementConfig.js')
const clone = value => JSON.parse(JSON.stringify(value))
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

test('actual mobile fields save and reopen stale policy, diagnostics, calibration, input meaning and unclamped station coordinates', async t => {
  const f = await fixture(t), initial = clone(f.saved.instance_config)
  assert.equal(f.field('工位编号数据含义').value, '', 'Legacy reopening never selects a new input meaning')
  assert.equal(f.field('移动数据过期阈值（毫秒）').value, '7200')
  f.field('工位编号数据含义').fire('change', 'current'); f.field('移动数据过期阈值（毫秒）').fire('input', '2300')
  f.field('启用移动运行诊断记录').fire('change', false); await settled()
  assert.equal(f.field('开启移动运动细节模拟').props.disabled, true)
  f.field('工位 1 X 坐标').fire('input', '-7'); f.field('工位 1 X 坐标').fire('change', '-7')
  f.field('移动轨道基准 Y').fire('input', '1.25'); f.field('移动轨道基准 Y').fire('change', '1.25')
  await f.save()
  assert.equal(f.saves.length, 1); const saved = f.saves[0].movement
  assert.equal(saved.stationInputMeaning, 'current'); assert.equal(saved.staleMs, 2300); assert.equal(saved.diagnosticLogging, false)
  assert.equal(saved.diagnosticIntervalSeconds, 4); assert.equal(saved.sceneUnitsPerMeter, 3.2)
  assert.deepEqual(saved.stations[0].position, { x: -7, y: 1.25, z: .5 }, 'Do not clamp X=-7 to hidden legacy endpoint X=-10')
  assert.equal(saved.start.y, 1.25); assert.equal(saved.end.y, 1.25)
  assert.deepEqual(f.saves[0].pointIds, ['PLC_POS', 'PLC_RUN']); assert.deepEqual(f.saves[0].expected, initial.movement)
  assert.deepEqual(f.saved.instance_config.animationBindings, initial.animationBindings); assert.deepEqual(f.saved.instance_config.custom, initial.custom)
  await f.reopen()
  assert.equal(f.field('工位编号数据含义').value, 'current'); assert.equal(f.field('移动数据过期阈值（毫秒）').value, '2300')
  assert.equal(f.field('启用移动运行诊断记录').checked, false); assert.equal(f.field('移动场景单位每米').value, '3.2')
  assert.equal(f.field('工位 1 X 坐标').value, '-7'); assert.equal(f.field('移动轨道基准 Y').value, '1.25')
})

test('existing mobile unit field displays inherited authored line calibration without saving or inventing movement fields on reopen', async t => {
  const movement = originalMovement(); delete movement.sceneUnitsPerMeter
  const f = await fixture(t, movement, { sceneUnitsPerMeter: .8 }), before = clone(f.saved.instance_config)
  assert.equal(f.field('移动场景单位每米').value, '0.8'); assert.equal(f.saves.length, 0)
  assert.deepEqual(f.saved.instance_config, before); assert.equal(Object.hasOwn(f.saved.instance_config.movement, 'sceneUnitsPerMeter'), false)
  await f.reopen(); assert.equal(f.field('移动场景单位每米').value, '0.8'); assert.deepEqual(f.saved.instance_config, before)
  f.field('工位编号数据含义').fire('change', 'current'); await f.save()
  assert.equal(f.saves.length, 1); assert.equal(f.saved.instance_config.movement.sceneUnitsPerMeter, .8)
  await f.reopen(); assert.equal(f.field('移动场景单位每米').value, '0.8')
})

test('current meaning accepts missing estimation distances; target cannot pretend to arrive without explicit simulation', async t => {
  const motion = { ...originalMovement(), simulationEnabled: false }
  const f = await fixture(t, motion)
  f.field('工位编号数据含义').fire('change', 'target'); await f.save()
  assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /目标工位命令不是当前到位反馈/)
  f.field('开启移动运动细节模拟').fire('change', true); await f.save()
  assert.equal(f.saves.length, 1); assert.equal(f.saved.instance_config.movement.stationInputMeaning, 'target')
  await f.reopen(); assert.equal(f.field('工位编号数据含义').value, 'target')
})

test('the existing meaning field selects last-confirmed, forbids inferred travel and reopens exact endpoint feedback settings', async t => {
  const movement = { ...originalMovement(), startActionPointId: '', simulation_enabled: true, smoothing_ms: 100 }
  movement.stations.push({ value: 2, label: '第二站', anchorDeviceId: '', position: { x: -6, y: 0, z: .5 } })
  const f = await fixture(t, movement), before = clone(f.saved.instance_config)
  const meaning = f.field('工位编号数据含义')
  assert.equal(meaning.value, '', 'Do not silently opt a historical configuration into the new meaning')
  assert.match(meaning.options.find(option => option._value === 'last-confirmed').text, /最后到位工位，运动中保持上一工位/)
  meaning.fire('change', 'last-confirmed'); await settled()
  assert.equal(f.field('开启移动运动细节模拟').checked, false); assert.equal(f.field('开启移动运动细节模拟').props.disabled, true)
  assert.equal(f.field('移动视觉平滑时间（毫秒）').value, '0'); assert.equal(f.field('移动视觉平滑时间（毫秒）').props.disabled, true)
  assert.equal(f.field('移动开始或实际移动反馈点位').value, '')
  assert.match(f.field('移动开始或实际移动反馈点位').options.find(option => option._value === '').text, /不确认当前停靠/)
  assert.equal(f.vm.motion.simulation_enabled, false); assert.equal(f.vm.motion.smoothing_ms, 0)
  assert.equal(f.elements().some(child => child.props.class === 'motion-simulation-fields'), false)
  assert.match(f.field('移动反馈显示说明').text, /最后到位工位编号不提供途中位置/)
  assert.match(f.field('移动反馈显示说明').text, /新编号到达时直接更新.*不确认当前停靠/)
  assert.equal(f.elements().some(child => child.type === 'small' && /小车加速度；最大速度.*自动估算/.test(child.text)), false,
    'Selected held-station guidance must not invite estimated travel')
  await f.save()
  assert.equal(f.saves.length, 1); const saved = f.saved.instance_config.movement
  assert.equal(saved.stationInputMeaning, 'last-confirmed'); assert.equal(saved.simulationEnabled, false); assert.equal(saved.smoothingMs, 0)
  assert.equal(saved.startActionPointId, ''); assert.deepEqual(f.saves[0].pointIds, ['PLC_POS'])
  assert.deepEqual(saved.stations.map(station => station.position), before.movement.stations.map(station => station.position), 'Only feedback endpoints exist; do not add intermediate coordinates or clamp imported endpoints')
  assert.deepEqual(f.saves[0].expected, before.movement, 'Explicit selection must not rewrite the original CAS snapshot')
  assert.deepEqual(f.saved.instance_config.animationBindings, before.animationBindings); assert.deepEqual(f.saved.instance_config.custom, before.custom)
  await f.reopen()
  assert.equal(f.field('工位编号数据含义').value, 'last-confirmed'); assert.equal(f.field('移动位置数值点位').value, 'PLC_POS')
  assert.equal(f.field('移动开始或实际移动反馈点位').value, ''); assert.equal(f.field('移动视觉平滑时间（毫秒）').value, '0')
  assert.equal(f.field('开启移动运动细节模拟').props.disabled, true); assert.equal(f.field('工位 2 X 坐标').value, '-6')
  assert.match(f.field('移动反馈显示说明').text, /最后到位工位编号不提供途中位置/)
})

const sourceChoices = () => [
  { id: 'PLC_POS', data_type: 'WORD', access_type: 'READ', device_id: 'cart' },
  { id: 'PLC_COMMAND', label: '开始命令', data_type: 'WORD', access_type: 'READ', device_id: 'cart' },
  { id: 'PLC_RUN', label: '实际移动状态反馈', data_type: 'BOOL', access_type: 'READ', device_id: 'cart' },
  { id: 'PLC_WRITE', data_type: 'BOOL', access_type: 'WRITE', device_id: 'cart' },
  { id: 'PLC_OTHER', data_type: 'BOOL', access_type: 'READ', device_id: 'another-device' }
]

test('target estimates persist a separate arrival station and typed moving feedback through the actual existing page', async t => {
  const points=[...sourceChoices(),{id:'PLC_ARRIVAL',label:'最后到位工位',device_id:'cart',data_type:'WORD',access_type:'READ'}]
  const movement={...originalMovement(),stationInputMeaning:'target',simulationEnabled:true,startActionPointId:'PLC_RUN',arrivalPositionPointId:'PLC_ARRIVAL'}
  const f=await fixture(t,movement,undefined,points)
  assert.equal(f.field('独立到位工位反馈点位').value,'PLC_ARRIVAL')
  assert.ok(!f.field('独立到位工位反馈点位').options.some(option=>option._value==='PLC_POS'))
  assert.ok(!f.field('移动开始或实际移动反馈点位').options.some(option=>option._value==='PLC_COMMAND'))
  await f.save();assert.equal(f.saves.length,1)
  assert.equal(f.saved.instance_config.movement.arrivalPositionPointId,'PLC_ARRIVAL')
  assert.deepEqual(f.saves[0].pointIds,['PLC_POS','PLC_RUN','PLC_ARRIVAL'])
  await f.reopen();assert.equal(f.field('独立到位工位反馈点位').value,'PLC_ARRIVAL')
  f.field('独立到位工位反馈点位').fire('change','');await f.save()
  assert.equal(f.saved.instance_config.movement.arrivalPositionPointId,undefined)
})

test('target estimates cannot use a numeric command to certify independent arrival',async t=>{
  const f=await fixture(t,{...originalMovement(),stationInputMeaning:'target',simulationEnabled:true,arrivalPositionPointId:'PLC_COMMAND',startActionPointId:'PLC_COMMAND'},undefined,sourceChoices())
  await f.save();assert.equal(f.saves.length,0);assert.match(f.vm.errorMessage,/实际移动 BOOL/)
})

test('last-confirmed retains an invalid WORD start command visibly until the human unbinds it, without selecting overall running', async t => {
  const f = await fixture(t, { ...originalMovement(), startActionPointId: 'PLC_COMMAND' }, undefined, sourceChoices())
  f.field('工位编号数据含义').fire('change', 'last-confirmed'); await settled()
  const signal = f.field('移动开始或实际移动反馈点位'), values = signal.options.map(option => option._value)
  assert.equal(signal.value, 'PLC_COMMAND', 'Do not reinterpret or silently clear a selected start command')
  assert.match(signal.options.find(option => option._value === 'PLC_COMMAND').text, /非本设备只读 BOOL.*解除绑定/)
  assert.ok(values.includes('PLC_RUN')); assert.ok(!values.includes('PLC_POS')); assert.ok(!values.includes('PLC_WRITE')); assert.ok(!values.includes('PLC_OTHER'))
  await f.save(); assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /本设备只读 BOOL.*解除原开始命令/)
  signal.fire('change', ''); await f.save()
  assert.equal(f.saves.length, 1); assert.equal(f.saved.instance_config.movement.startActionPointId, '')
  assert.deepEqual(f.saves[0].pointIds, ['PLC_POS'], 'A missing moving feedback cannot automatically acquire a running or command point')
  await f.reopen(); assert.equal(f.field('移动开始或实际移动反馈点位').value, '')
})

test('a human can select and reopen only this device readonly BOOL actual moving feedback through the existing signal field', async t => {
  const f = await fixture(t, { ...originalMovement(), startActionPointId: 'PLC_COMMAND' }, undefined, sourceChoices())
  f.field('工位编号数据含义').fire('change', 'last-confirmed'); await settled()
  f.field('移动开始或实际移动反馈点位').fire('change', 'PLC_RUN'); await f.save()
  assert.equal(f.saves.length, 1); assert.equal(f.saved.instance_config.movement.startActionPointId, 'PLC_RUN')
  assert.deepEqual(f.saves[0].pointIds, ['PLC_POS', 'PLC_RUN'])
  await f.reopen(); assert.equal(f.field('工位编号数据含义').value, 'last-confirmed'); assert.equal(f.field('移动开始或实际移动反馈点位').value, 'PLC_RUN')
})

test('reopening invalid imported last-confirmed estimation does not silently repair persisted values, and explicit reselection repairs the editable draft', async t => {
  const movement = { ...originalMovement(), stationInputMeaning: 'last-confirmed', simulationEnabled: false, simulation_enabled: true, smoothingMs: 0, startActionPointId: '' }
  const f = await fixture(t, movement), before = clone(f.saved.instance_config)
  assert.equal(f.saves.length, 0); assert.deepEqual(f.saved.instance_config, before)
  assert.equal(f.field('开启移动运动细节模拟').checked, true); assert.equal(f.field('开启移动运动细节模拟').props.disabled, true)
  await f.save(); assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /不支持移动估算/)
  f.field('工位编号数据含义').fire('change', 'last-confirmed'); await f.save()
  assert.equal(f.saves.length, 1); assert.equal(f.saved.instance_config.movement.simulationEnabled, false)
  assert.deepEqual(f.saves[0].expected, before.movement)
})

for (const meaning of ['', 'current', 'target']) test(`legacy ${meaning || 'unspecified'} meaning preserves its WORD gate, smoothing and estimation settings`, async t => {
  const movement = { ...originalMovement(), startActionPointId: 'PLC_COMMAND', ...(meaning ? { stationInputMeaning: meaning } : {}) }
  const f = await fixture(t, movement, undefined, sourceChoices())
  assert.equal(f.field('工位编号数据含义').value, meaning); assert.equal(f.field('移动开始或实际移动反馈点位').value, 'PLC_COMMAND')
  assert.equal(f.field('移动视觉平滑时间（毫秒）').value, '100'); assert.equal(f.field('移动视觉平滑时间（毫秒）').props.disabled, false)
  await f.save(); assert.equal(f.saves.length, 1)
  assert.equal(f.saved.instance_config.movement.stationInputMeaning || '', meaning)
  assert.equal(f.saved.instance_config.movement.smoothingMs, 100); assert.equal(f.saved.instance_config.movement.simulationEnabled, true)
  assert.equal(f.saved.instance_config.movement.startActionPointId, 'PLC_COMMAND')
  await f.reopen(); assert.equal(f.field('工位编号数据含义').value, meaning)
})

// Invoke the actual parent factory-switch callback extracted by AST, not a
// stand-in implementation. It is independent of a DOM, browser, PLC or DB.
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
  return new Function('adminApi', 'isLastConfirmedMotion', 'lastConfirmedMotionError', 'parseInstanceConfig', `return (${source.slice(handler.start, handler.end)})`)(
    api, isLastConfirmedMotion, lastConfirmedMotionError, value => typeof value === 'string' ? JSON.parse(value) : value || {})
}

test('the actual cached factory-switch saver rejects new-semantic simulation, transitions, mode and non-feedback signal bypasses atomically', async t => {
  installBrowser(t); discardFactoryDrafts(''); t.after(() => discardFactoryDrafts(''))
  const saves = [], latest = { id: 'cart', instance_config: { custom: { keep: true } }, dataPoints: sourceChoices() }
  const saveDraft = await parentMobileDraftSaver({ getDevice: async () => clone(latest), updateDeviceMovement: async (...args) => { saves.push(clone(args)); return { success: true } } })
  const valid = { ...originalMovement(), stationInputMeaning: 'last-confirmed', startActionPointId: '', smoothingMs: 0, simulationEnabled: false }
  const cases = [
    [{ simulationEnabled: true }, /不支持移动估算/], [{ simulation_enabled: true }, /不支持移动估算/],
    [{ smoothingMs: 1 }, /不支持视觉过渡/], [{ smoothing_ms: 1 }, /不支持视觉过渡/],
    [{ valueMode: 'range' }, /只适用于工位编号/], [{ startActionPointId: 'PLC_COMMAND' }, /本设备只读 BOOL/],
    [{ startActionPointId: 'PLC_WRITE' }, /本设备只读 BOOL/], [{ startActionPointId: 'PLC_OTHER' }, /本设备只读 BOOL/]
  ]
  for (const [patch, error] of cases) {
    const movement = { ...clone(valid), ...patch }
    cacheFactoryDraft('', 'mobile-motion:cart', 'mobile-motion', { deviceId: 'cart', motion: clone(movement), devicePayload: { instance_config: { movement } }, selectedPointIds: [], missingStationDistances: 99, expectedMovement: { legacy_key: 'unchanged' } })
    await assert.rejects(saveFactoryDrafts('', { 'mobile-motion': saveDraft }), error)
    assert.equal(saves.length, 0); assert.equal(listFactoryDrafts('').length, 1, 'A rejection must leave the human draft for correction')
    assert.deepEqual(latest.instance_config, { custom: { keep: true } })
  }
  const invalidPayload = { ...clone(valid), simulationEnabled: true }
  await assert.rejects(saveDraft({ deviceId: 'cart', motion: { ...valid, stationInputMeaning: 'current' }, devicePayload: { instance_config: { movement: invalidPayload } } }), /不支持移动估算/, 'A different cached display meaning cannot conceal an invalid final payload')
  const missingSources = await parentMobileDraftSaver({ getDevice: async () => ({ id: 'cart', instance_config: {} }), updateDeviceMovement: async () => { throw Error('Must not save unknown source') } })
  await assert.rejects(missingSources({ deviceId: 'cart', motion: valid, devicePayload: { instance_config: { movement: { ...valid, startActionPointId: 'PLC_RUN' } } } }), /本设备只读 BOOL/)
})

test('the actual cached factory-switch saver persists last-confirmed no-gate or BOOL feedback without requiring estimation distances, and preserves CAS', async t => {
  installBrowser(t); discardFactoryDrafts(''); t.after(() => discardFactoryDrafts(''))
  const saves = [], latest = { id: 'cart', instance_config: { custom: { keep: true } }, dataPoints: sourceChoices() }
  const saveDraft = await parentMobileDraftSaver({ getDevice: async () => clone(latest), updateDeviceMovement: async (id, movement, points, expected) => { validateMovementConfig(movement); saves.push(clone({ id, movement, points, expected })); return { success: true } } })
  for (const startActionPointId of ['', 'PLC_RUN']) {
    const movement = { ...originalMovement(), stationInputMeaning: 'last-confirmed', startActionPointId, smoothingMs: 0, simulationEnabled: false }, expected = { legacy_key: 'unchanged', stations: [{ value: 42 }] }
    const points = ['PLC_POS', startActionPointId].filter(Boolean)
    cacheFactoryDraft('', 'mobile-motion:cart', 'mobile-motion', { deviceId: 'cart', motion: clone(movement), devicePayload: { instance_config: { movement } }, selectedPointIds: points, missingStationDistances: 99, expectedMovement: expected })
    await saveFactoryDrafts('', { 'mobile-motion': saveDraft })
    const saved = saves.at(-1); assert.deepEqual(saved.movement, movement); assert.deepEqual(saved.expected, expected); assert.deepEqual(saved.points, points)
    assert.equal(listFactoryDrafts('').length, 0); assert.deepEqual(latest.instance_config, { custom: { keep: true } })
  }
  assert.equal(saves.length, 2)
})

test('a stale editor and its remounted draft retain the old CAS baseline instead of overwriting translated paths', async t => {
  const f = await fixture(t)
  f.field('工位编号数据含义').fire('change', 'current'); f.field('移动数据过期阈值（毫秒）').fire('input', '3100')
  f.externallyShift(); const external = clone(f.saved.instance_config.movement)
  await f.save(); assert.match(f.vm.errorMessage, /已更新/); assert.deepEqual(f.saved.instance_config.movement, external)
  await f.reopen(); await f.save()
  assert.equal(f.saves.length, 2); assert.match(f.vm.errorMessage, /已更新/)
  assert.equal(f.saves[1].expected.start.z, .5, 'Remount cannot silently rebase an old unsaved draft onto new geometry')
  assert.deepEqual(f.saved.instance_config.movement, external)
  f.field('放弃移动修改并重新读取配置').fire('click'); await settled()
  assert.equal(f.field('移动轨道起始 Z').value, '3.5')
  f.field('工位编号数据含义').fire('change', 'current'); await f.save()
  assert.equal(f.saves.length, 3); assert.equal(f.saves[2].expected.start.z, 3.5, 'Only an explicit reload action rebases the draft')
})

test('historical draft without a saved comparison baseline cannot silently overwrite a newly read configuration', async t => {
  const f = await fixture(t)
  const old = clone(f.vm.motion); old.staleMs = 2700
  cacheFactoryDraft('', 'mobile-motion:cart', 'mobile-motion', { deviceId: 'cart', motion: old })
  await f.vm.loadDevice('cart'); await settled(); await f.save()
  assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /旧草稿没有保存时的移动配置快照/)
  f.field('放弃移动修改并重新读取配置').fire('click'); await settled()
  assert.equal(f.field('移动数据过期阈值（毫秒）').value, '7200')
})

test('saved invalid geometry remains editable and cannot be repaired into a default track or guessed station', async t => {
  const motion = { ...originalMovement(), start: undefined, stations: [{ value: null, position: { x: -21, z: .5 } }] }
  const f = await fixture(t, motion)
  assert.equal(f.field('移动轨道起始 X').value, ''); assert.equal(f.vm.motion.stations[0].value, '')
  await f.save(); assert.equal(f.saves.length, 0); assert.match(f.vm.errorMessage, /完整填写轨道/)
  const intact = clone(f.vm.motion.stations)
  f.field('移动轨道参考终点 X').fire('input', ''); f.field('移动轨道参考终点 X').fire('change', '')
  assert.deepEqual(clone(f.vm.motion.stations), intact, 'A failed reference edit never partly reprojects the remaining stations')
})

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
