import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser, settle } from './helpers.mjs'
import { normalizeLineLayout, defaultLineLayout } from '../src/views/admin/utils/lineLayout.js'
import { lineSceneUnitsPerMeter, movementSceneUnitsPerMeter, assertLineMovementUnits, resolveLineRailSpacing, editLineRailSpacing, shiftRailMovement } from '../../shared/lineRailSpacing.mjs'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { normalizeLineLayout: normalizeBackend } = require('./utils/spatialLayout.js')
const clone = value => JSON.parse(JSON.stringify(value))
const approximate = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
const legacyLayout = () => ({ version: 2, coordinateSpace: 'workshop_local', transform: { x: 13, y: 2, z: -7, rotationY: 15 },
  lanes: [{ id: 'lane', name: '设备线', offsetZ: 0, length: 60 }], rails: [{ id: 'rail', name: '小车导轨', offsetZ: .6, length: 60 }] })
const movement = units => ({ enabled: true, currentPositionPointId: 'PLC_POSITION', valueMode: 'station', stationInputMeaning: 'current', smoothingMs: 100,
  start: { x: -20, y: 0, z: .7 }, end: { x: 20, y: 0, z: .7 }, stations: [{ value: 1, label: '现场工位', anchorDeviceId: 'station', position: { x: -7, y: 0, z: .7 } }],
  ...(units === undefined ? {} : { sceneUnitsPerMeter: units }) })
const carrier = (id = 'cart', units, patch = {}) => ({ id, name: '现场料车 ' + id, line_id: 'L', pos_x: -10.125, pos_z: .6, coordinate_space: 'line_local',
  instance_config: { role: 'transfer_cart', workshop_id: 'W', railLineId: 'L', railId: 'rail', movement: movement(units),
    custom: { untouched: true }, animationBindings: { bindings: [{ actionId: 'feed', pointId: 'PLC_FEED', enabled: true }] } }, ...patch })

test('line-local metre calibration is explicit, survives both normalizers, and never materialises a field or moves legacy unassociated rails on read', () => {
  const old = legacyLayout(), before = JSON.stringify(old)
  for (const normalize of [normalizeLineLayout, normalizeBackend]) {
    const loaded = normalize(old), reopened = normalize(JSON.stringify(loaded))
    assert.equal(Object.hasOwn(loaded, 'sceneUnitsPerMeter'), false); assert.equal(Object.hasOwn(reopened, 'sceneUnitsPerMeter'), false)
    assert.equal(loaded.rails[0].offsetZ, .6); assert.equal(reopened.rails[0].offsetZ, .6); assert.equal(lineSceneUnitsPerMeter(loaded), 1)
  }
  assert.equal(JSON.stringify(old), before)
  for (const units of [.8, 1.25, 2]) {
    const source = { ...legacyLayout(), sceneUnitsPerMeter: units }, withLane = editLineRailSpacing(source, 'rail', 'laneId', 'lane')
    approximate(withLane.rails[0].spacing.distanceMeters, .6 / units)
    const configured = editLineRailSpacing(withLane, 'rail', 'distanceMeters', '.6')
    approximate(configured.rails[0].offsetZ, .6 * units)
    const front = normalizeLineLayout(configured), back = normalizeBackend(JSON.stringify(configured))
    assert.deepEqual(front, back); assert.equal(front.sceneUnitsPerMeter, units); assert.equal(front.rails[0].length, 60)
    assert.deepEqual(front.transform, old.transform, 'Calibration does not scale the line origin, rotation or raw layout lengths')
  }
})

test('explicit line/movement unit fields reject every invalid canonical/alias value; missing contextual source units inherit only without database materialisation', () => {
  const invalid = [0, -1, 100001, null, undefined, NaN, Infinity, '', ' ', true, false, {}, []]
  for (const value of [...invalid, '1.25']) {
    const source = { ...legacyLayout(), sceneUnitsPerMeter: value }
    assert.throws(() => normalizeLineLayout(source), /场景单位/); assert.throws(() => normalizeBackend(source), /场景单位/)
  }
  for (const key of ['sceneUnitsPerMeter', 'scene_units_per_meter']) for (const value of invalid) {
    const source = { [key]: value, [key === 'sceneUnitsPerMeter' ? 'scene_units_per_meter' : 'sceneUnitsPerMeter']: .8 }
    assert.throws(() => movementSceneUnitsPerMeter(source), /现有移动设置中校准/)
    assert.throws(() => assertLineMovementUnits(source, { sceneUnitsPerMeter: .8 }), /现有移动设置中校准/)
  }
  assert.equal(movementSceneUnitsPerMeter({}), 1)
  assert.equal(lineSceneUnitsPerMeter({ sceneUnitsPerMeter: 100000 }), 100000); assert.equal(movementSceneUnitsPerMeter({ scene_units_per_meter: '100000' }), 100000)
  for (const units of [.8, 1.25, 2]) {
    const source = { enabled: false }, before = JSON.stringify(source)
    assert.equal(assertLineMovementUnits(source, { sceneUnitsPerMeter: units }), units); assert.equal(JSON.stringify(source), before)
    assert.equal(assertLineMovementUnits(undefined, { sceneUnitsPerMeter: units }), units)
    assert.equal(assertLineMovementUnits({ scene_units_per_meter: String(units) }, { sceneUnitsPerMeter: units }), units)
    assert.equal(assertLineMovementUnits({ sceneUnitsPerMeter: units, scene_units_per_meter: 3 }, { sceneUnitsPerMeter: units }), units)
  }
  assert.throws(() => assertLineMovementUnits({ sceneUnitsPerMeter: .8 }, {}, '现场料车'), /现场料车.*不一致.*改为 1 后保存/)
})

async function component(path, expose = '') {
  const url = new URL(path, import.meta.url)
  let source = await readFile(url, 'utf8')
  if (expose) source = source.replace('</script>', `defineExpose({ ${expose} })\n</script>`)
  source = source.replace(/import \{ canAdminPage \} from [^\n]+/, 'const canAdminPage = () => true')
    .replace(/import \{LineSimulationScene\} from [^\n]+/, 'const LineSimulationScene = class { constructor() { throw Error("No WebGL/browser belongs in unit-field tests") } }')
  let code = compileScript(parse(source).descriptor, { id: 'line-unit-fields-memory', inlineTemplate: true }).content
  code = code.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, name) => `from ${JSON.stringify(name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name))}`)
  return (await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))).default
}
const Planner = await component('../src/views/admin/components/LinePlannerControls.vue')
const Sequence = await component('../src/views/admin/components/LineEquipmentSequence.vue', 'selectedIds, draft, arrangement')
const parentSource = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
const parentAst = parseJavaScript(parentSource, { sourceType: 'module' })
const parentNames = ['getLineLayout', 'changeLineRailSpacing', 'applyLineLayoutDraft', 'buildDeviceLayoutBindingPatch', 'syncLineBoundDevicesToLayout', 'lineLayoutSavePayload', 'saveSelectedLineLayout']
const parentFunctions = parentNames.map(name => {
  const node = parentAst.program.body.find(row => row.type === 'FunctionDeclaration' && row.id?.name === name); assert.ok(node, name)
  return parentSource.slice(node.start, node.end)
}).join('\n')

// Vue's memory renderer executes the actual field handlers and Teleport. It is
// not a browser/DOM/WebGL driver; only the explicitly isolated API is reachable.
function memoryHost(t) {
  const env = installBrowser(t); env.replace('Document', class {}); env.replace('ShadowRoot', class {})
  env.replace('ResizeObserver', class { observe() {} disconnect() {} }); env.browser.innerHeight = 900; env.browser.innerWidth = 1200
  const node = (type, text = '') => { const listeners = new Map(); return { type, tagName: type.toUpperCase(), text, props: {}, children: [], parent: null, _displayValue: '', selected: false, style: {},
    get value() { return String(this.type === 'select' ? this.options.find(option => option.selected)?._value ?? this._displayValue : this._displayValue) },
    set value(value) { this._displayValue = String(value ?? ''); if (this.type === 'select') this.options.forEach(option => { option.selected = String(option._value) === String(value) }) },
    getRootNode: () => document, getBoundingClientRect: () => ({ top: 10, bottom: 46, left: 10, width: 560, height: 36 }),
    focus() { document.activeElement = this }, blur() { document.activeElement = null },
    contains(target) { return target === this || this.children.some(child => child.contains(target)) },
    querySelector() { return this.children[0] || null }, querySelectorAll() { return this.children },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter(item => item !== fn)) },
    get options() { return this.children.filter(child => child.type === 'option') },
    get selectedIndex() { return this.options.findIndex(option => option.selected) }, set selectedIndex(index) { this.options.forEach((option, i) => { option.selected = i === index }) },
    async fire(name, value) {
      if (value !== undefined) this.value = String(value)
      const event = { target: this, currentTarget: this, type: name, stopPropagation() {}, preventDefault() {} }
      for (const fn of listeners.get(name) || []) fn(event)
      const handler = this.props['on' + name[0].toUpperCase() + name.slice(1)]
      await Promise.all((Array.isArray(handler) ? handler : handler ? [handler] : []).map(fn => fn(event)))
      await nextTick()
    }
  } }
  const root = node('root'), body = node('body')
  const remove = child => { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child); child.parent = null }
  const renderer = createRenderer({ createElement: type => node(type), createText: value => node('#text', value), createComment: value => node('#comment', value),
    setText: (child, value) => { child.text = value }, setElementText: (child, value) => { child.text = value; child.children = [] },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null, remove,
    insert(child, parent, anchor) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; parent.children.splice(index < 0 ? parent.children.length : index, 0, child) },
    patchProp(child, key, _old, value) { child.props[key] = value; if (key === 'value') { child.value = String(value ?? ''); child._value = value } else if (key === 'checked') child.checked = !!value },
    querySelector: name => name === 'body' ? body : null
  })
  const all = child => [child, ...child.children.flatMap(all)], elements = () => [...all(root), ...all(body)]
  const field = label => { const result = elements().filter(child => child.props['aria-label'] === label); assert.equal(result.length, 1, label); return result[0] }
  return { root, renderer, elements, field, beforeRestore: env.beforeRestore }
}
const settled = async () => { await nextTick(); await settle(); await nextTick() }

test('ordinary preview auto-selects one cart and devices without forcing saved cycle or distant site calibration', async t => {
  const host=memoryHost(t),devices=ref([]),lines=ref([]),models=[{id:'cad_transfer_cart_101300',file_path:'/isolated.glb'},{id:'station',file_path:'/isolated.glb'}]
  let vm
  const app=host.renderer.createApp({setup:()=>()=>h(Sequence,{devices:devices.value,models,lines:lines.value,ref:value=>{vm=value}})})
  app.mount(host.root);host.beforeRestore(()=>app.unmount())
  const saved=carrier('cart',.79999999616123);saved.model_type='cad_transfer_cart_101300'
  saved.instance_config.animationBindings.transferLink={enabled:true,cycle:{enabled:true,extendSeconds:17,retractSeconds:13,stations:[]}}
  devices.value=[saved,{...saved,id:'second-cart'},{id:'station',line_id:'L',name:'炉体',model_type:'station',pos_z:100},{id:'missing',line_id:'L',model_type:'unavailable'}]
  lines.value=[{id:'L',layout:{...legacyLayout(),sceneUnitsPerMeter:.8}}];await settled()
  assert.deepEqual(vm.selectedIds,['cart','station']);assert.equal(vm.arrangement,'scheme');assert.ok(vm.draft.plan);assert.equal(vm.draft.plan.useSavedCycle,false)
  assert.equal(host.elements().find(n=>n.type==='details').props.open,undefined,'Advanced calibration is closed by default')
  assert.equal(host.elements().find(n=>n.type==='button'&&n.text==='一键演示').props.disabled,false)
  const before=JSON.stringify({devices:devices.value,lines:lines.value})
  devices.value[0].instance_config.movement.sceneUnitsPerMeter=.81;await settled()
  assert.ok(vm.draft.plan,'A real saved-site mismatch does not prevent ordinary animation demo')
  devices.value[0].instance_config.movement.sceneUnitsPerMeter=.79999999616123;await settled()
  assert.equal(JSON.stringify({devices:devices.value,lines:lines.value}),before)
})

async function apiFixture(t, { layout = legacyLayout(), devices = [carrier()], includeMovementRoute = false } = {}) {
  const Database = require('better-sqlite3'), sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE workshops(id TEXT PRIMARY KEY,name TEXT,factory_id TEXT); CREATE TABLE lines(id TEXT PRIMARY KEY,name TEXT,workshop_id TEXT,layout_json TEXT,sort_order INTEGER); CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT,line_id TEXT,pos_x REAL,pos_z REAL,coordinate_space TEXT,instance_config TEXT)')
  sqlite.prepare('INSERT INTO workshops VALUES(?,?,?)').run('W', '当前车间', 'F')
  sqlite.prepare('INSERT INTO workshops VALUES(?,?,?)').run('OTHER', '其他车间', 'FOREIGN')
  sqlite.prepare('INSERT INTO lines VALUES(?,?,?,?,?)').run('L', '现场产线', 'W', JSON.stringify(layout), 0)
  const insert = device => sqlite.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?)').run(device.id, device.name || device.id, device.line_id ?? null, device.pos_x ?? 0, device.pos_z ?? 0, device.coordinate_space || 'line_local', JSON.stringify(device.instance_config || {}))
  devices.forEach(insert)
  const db = { get: async (sql, params = []) => sqlite.prepare(sql).get(...params), all: async (sql, params = []) => sqlite.prepare(sql).all(...params), run: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    transaction: async fn => { sqlite.exec('BEGIN'); try { const result = await fn(db); sqlite.exec('COMMIT'); return result } catch (error) { sqlite.exec('ROLLBACK'); throw error } } }
  const databasePath = require.resolve('./db/database.js'), routePath = require.resolve('./routes/lines.js'), movementRoutePath = require.resolve('./routes/devices.js'), previous = require.cache[databasePath], previousRoute = require.cache[routePath], previousMovementRoute = require.cache[movementRoutePath]
  require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { getDb: async () => db, getDbStatus: () => ({ type: 'sqlite' }) } }; delete require.cache[routePath]
  const express = require('express'), app = express(); app.use(express.json()); app.use((req, _res, next) => { req.factoryId = req.headers['x-factory-id'] || 'F'; next() }); app.use('/api/lines', require('./routes/lines.js'))
  if (includeMovementRoute) { delete require.cache[movementRoutePath]; app.use('/api/devices', require('./routes/devices.js')) }
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); sqlite.close(); if (previous) require.cache[databasePath] = previous; else delete require.cache[databasePath]; if (previousRoute) require.cache[routePath] = previousRoute; else delete require.cache[routePath]; if (includeMovementRoute) { if (previousMovementRoute) require.cache[movementRoutePath] = previousMovementRoute; else delete require.cache[movementRoutePath] } })
  const base = `http://127.0.0.1:${server.address().port}`, realFetch = globalThis.fetch
  const call = async (body, factory = 'F') => { const response = await realFetch(base + '/api/lines/L', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-factory-id': factory }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  const movementCall = async body => { assert.ok(includeMovementRoute); const response = await realFetch(base + '/api/devices/cart/movement', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-factory-id': 'F' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() } }
  const get = async () => { const response = await realFetch(base + '/api/lines', { headers: { 'x-factory-id': 'F' } }); assert.equal(response.status, 200); return (await response.json())[0] }
  const rows = () => sqlite.prepare('SELECT * FROM devices ORDER BY id').all()
  return { sqlite, base, realFetch, call, movementCall, get, rows, insert, snapshot: () => ({ lines: sqlite.prepare('SELECT * FROM lines').all(), devices: rows() }) }
}

async function fieldFixture(t, options = {}) {
  const api = await apiFixture(t, options), host = memoryHost(t), line = ref(await api.get()), devices = ref(api.rows()), busy = ref(false), saving = ref(false), alerts = [], requests = []
  const savedLineLayoutSnapshots = ref({ L: JSON.stringify(line.value.layout) })
  const savedDeviceLayoutSnapshots = ref(Object.fromEntries(devices.value.map(row => [row.id, { serialized: JSON.stringify({ pos_x: row.pos_x, pos_z: row.pos_z }) }])))
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const pathname = new URL(String(url), 'http://isolated.invalid').pathname
    assert.ok(/^\/api\/lines(?:\/L)?$/.test(pathname), 'Only isolated original line API may be reached: ' + url)
    requests.push({ pathname, method: options?.method || 'GET', ...(options?.body ? { body: JSON.parse(options.body) } : {}) })
    const headers = new Headers(options?.headers); headers.set('x-factory-id', 'F')
    return api.realFetch(api.base + pathname, { ...options, headers })
  })
  const dependencies = { selectedLineEditor: line, devices, lineDeviceLayoutBusy: busy, lineLayoutSaving: saving,
    canAdminPage: () => true, normalizeLineLayout, defaultLineLayout, editLineRailSpacing, shiftRailMovement, adminApi, savedLineLayoutSnapshots, savedDeviceLayoutSnapshots,
    parseInstanceConfig: value => typeof value === 'string' ? JSON.parse(value) : value || {}, numberOrDefault: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback, getLineBaseZ: () => 0,
    getDevicesBoundToLayoutItem: (type, id, owner, source = devices.value) => source.filter(row => { const config = typeof row.instance_config === 'string' ? JSON.parse(row.instance_config) : row.instance_config; return String(config[type === 'rail' ? 'railId' : 'laneId']) === String(id) && String(config[type === 'rail' ? 'railLineId' : 'laneLineId'] || row.line_id) === String(owner.id) }),
    getLineDeviceById: id => devices.value.find(row => row.id === id), alert: (message, options) => alerts.push({ message, options }),
    loadLines: async () => { line.value = await api.get(); savedLineLayoutSnapshots.value.L = JSON.stringify(line.value.layout) },
    loadDevices: async () => { devices.value = api.rows(); savedDeviceLayoutSnapshots.value = Object.fromEntries(devices.value.map(row => [row.id, { serialized: JSON.stringify({ pos_x: row.pos_x, pos_z: row.pos_z }) }])) },
    reloadSavedNativeScenePreview: async () => true }
  const handlers = new Function(...Object.keys(dependencies), parentFunctions + '\nreturn {changeLineRailSpacing,saveSelectedLineLayout}')(...Object.values(dependencies))
  let app, pendingSave
  const mount = async () => {
    app = host.renderer.createApp({ setup: () => () => h('section', [h(Planner, { lines: [line.value], workshops: [{ id: 'W', name: '当前车间' }], selectedId: 'L', layout: line.value.layout, draft: {}, busy: busy.value || saving.value,
      layoutDirty: JSON.stringify(line.value.layout) !== savedLineLayoutSnapshots.value.L, layoutSaving: saving.value,
      savedSnapshot: savedLineLayoutSnapshots.value.L, onChangeRailSpacing: handlers.changeLineRailSpacing,
      onSaveLayout: () => { pendingSave = handlers.saveSelectedLineLayout(); return pendingSave } })]) })
    app.mount(host.root)
    if (options.openRailPopup !== false) await host.field('管理小车导轨').fire('click')
    await settled()
  }
  await mount(); host.beforeRestore(() => app.unmount())
  return { ...api, ...host, line, devices, busy, saving, alerts, requests, save: async () => { await host.field('保存设备线与轨道设置').fire('click'); await pendingSave; await settled() },
    reopen: async () => { app.unmount(); await dependencies.loadLines(); await dependencies.loadDevices(); await mount() } }
}

test('legacy unassociated rail exposes real spacing fields in the normal toolbar without opening a popup; manual fields and its actual save button persist through the original batch API and reopen', async t => {
  const f = await fieldFixture(t, { openRailPopup: false }), original = f.snapshot()
  const inMainTree = field => { let current = field; while (current && current !== f.root) current = current.parent; return current === f.root }
  const labels = ['小车导轨 关联设备线', '小车导轨 设备线与轨道中心距（米）', '小车导轨 相对设备线方向']
  for (const label of labels) assert.ok(inMainTree(f.field(label)), label + ' is in the ordinary toolbar, not Teleport')
  assert.equal(f.elements().some(node => String(node.props.class || '').includes('line-control-popup')), false)
  assert.equal(f.field(labels[0]).value, ''); assert.equal(f.field(labels[1]).value, ''); assert.equal(f.field(labels[2]).value, '')
  assert.equal(f.field(labels[1]).props.disabled, true); assert.equal(f.field(labels[2]).props.disabled, true)
  assert.equal(f.field('保存设备线与轨道设置').props.disabled, true)
  assert.equal(Object.hasOwn(f.line.value.layout.rails[0], 'spacing'), false); assert.deepEqual(f.snapshot(), original); assert.equal(f.requests.length, 0)
  const untouched = JSON.stringify({ layout: f.line.value.layout, devices: f.devices.value })
  await f.field(labels[1]).fire('change', '.25')
  assert.equal(JSON.stringify({ layout: f.line.value.layout, devices: f.devices.value }), untouched, 'Disabled unassociated distance cannot invent a lane even if an event is dispatched')
  await f.field(labels[0]).fire('change', 'lane')
  assert.equal(f.field(labels[1]).value, '0.6'); assert.equal(f.field(labels[2]).value, 'positive')
  assert.equal(f.line.value.layout.rails[0].offsetZ, .6, 'Explicit lane selection measures the actual existing gap, without moving the rail')
  await f.field(labels[1]).fire('change', '.25'); await f.field(labels[2]).fire('change', 'negative')
  assert.equal(f.line.value.layout.rails[0].offsetZ, -.25)
  assert.deepEqual(f.line.value.layout.rails[0].spacing, { laneId: 'lane', distanceMeters: .25, side: 'negative' })
  assert.equal(f.field('保存设备线与轨道设置').props.disabled, false)
  assert.ok(f.elements().some(node => node.props.role === 'status' && node.text === '有未保存修改'))
  assert.deepEqual(f.snapshot(), original, 'The visible fields update the draft and linked path, not the database before Save')
  await f.save(); assert.equal(f.alerts.at(-1).options.type, 'success', f.alerts.at(-1).message)
  const put = f.requests.find(row => row.method === 'PUT')
  assert.ok(put); assert.equal(Object.hasOwn(put.body.expectedLayout.rails[0], 'spacing'), false)
  assert.deepEqual(put.body.layout.rails[0].spacing, { laneId: 'lane', distanceMeters: .25, side: 'negative' })
  assert.deepEqual(put.body.devicePositions[0].expected, { pos_x: -10.125, pos_z: .6 })
  const saved = f.rows()[0], savedMovement = JSON.parse(saved.instance_config).movement
  assert.equal(saved.pos_z, -.25); approximate(savedMovement.start.z, -.15); approximate(savedMovement.end.z, -.15)
  approximate(savedMovement.stations[0].position.z, -.15)
  await f.reopen()
  assert.equal(f.field(labels[0]).value, 'lane'); assert.equal(f.field(labels[1]).value, '0.25'); assert.equal(f.field(labels[2]).value, 'negative')
  assert.equal(f.field('保存设备线与轨道设置').props.disabled, true)
  assert.ok(f.elements().some(node => node.props.role === 'status' && node.text === '已保存'))
  for (const label of labels) assert.ok(inMainTree(f.field(label)), 'Reopen remains directly reachable: ' + label)
  await f.field('管理小车导轨').fire('click'); await settled()
  for (const label of labels) assert.ok(inMainTree(f.field(label)), 'Opening the structural popup does not duplicate spacing fields: ' + label)
  await f.field('管理小车导轨').fire('click'); await settled()
  assert.equal(f.requests.filter(row => row.method === 'PUT').length, 1, 'Opening and closing the popup never saves or repositions anything')
})

test('normal multi-rail fields require the user-selected lane ID, apply calibrated metre spacing only to its rail and preserve another unassociated rail through save/reopen', async t => {
  const layout = { ...legacyLayout(), sceneUnitsPerMeter: 2,
    lanes: [{ id: 'lane-a', name: '设备线 A', offsetZ: -2, length: 60 }, { id: 'lane-b', name: '设备线 B', offsetZ: 6, length: 60 }],
    rails: [{ id: 'rail', name: '送料轨道', offsetZ: 10, length: 60 }, { id: 'return', name: '回程轨道', offsetZ: -4, length: 60 }] }
  const source = carrier('cart', 2, { pos_z: 10 })
  for (const position of [source.instance_config.movement.start, source.instance_config.movement.end, source.instance_config.movement.stations[0].position]) position.z = 10.1
  const f = await fieldFixture(t, { layout, devices: [source], openRailPopup: false }), original = f.snapshot()
  assert.equal(f.field('送料轨道 关联设备线').value, ''); assert.equal(f.field('回程轨道 关联设备线').value, '')
  assert.equal(f.field('送料轨道 设备线与轨道中心距（米）').value, ''); assert.equal(f.field('回程轨道 设备线与轨道中心距（米）').value, '')
  await f.reopen(); assert.deepEqual(f.snapshot(), original)
  assert.equal(f.field('送料轨道 关联设备线').value, '', 'Even multiple nearby lanes never receive a guessed association on reopen')
  await f.field('送料轨道 关联设备线').fire('change', 'lane-b')
  assert.equal(f.field('送料轨道 设备线与轨道中心距（米）').value, '2'); assert.equal(f.line.value.layout.rails[0].offsetZ, 10)
  await f.field('送料轨道 设备线与轨道中心距（米）').fire('change', '.75')
  await f.field('送料轨道 相对设备线方向').fire('change', 'negative')
  assert.equal(f.line.value.layout.rails[0].offsetZ, 4.5, 'Actual offset is lane B at 6 minus .75 metres times 2 scene units/metre')
  assert.deepEqual(f.line.value.layout.rails[0].spacing, { laneId: 'lane-b', distanceMeters: .75, side: 'negative' })
  assert.equal(f.line.value.layout.rails[1].offsetZ, -4); assert.equal(Object.hasOwn(f.line.value.layout.rails[1], 'spacing'), false)
  assert.equal(f.field('回程轨道 设备线与轨道中心距（米）').props.disabled, true)
  await f.save(); assert.equal(f.alerts.at(-1).options.type, 'success', f.alerts.at(-1).message)
  const savedMovement = JSON.parse(f.rows()[0].instance_config).movement
  assert.equal(f.rows()[0].pos_z, 4.5); approximate(savedMovement.start.z, 4.6); approximate(savedMovement.end.z, 4.6)
  await f.reopen()
  assert.equal(f.field('送料轨道 关联设备线').value, 'lane-b'); assert.equal(f.field('送料轨道 设备线与轨道中心距（米）').value, '0.75')
  assert.equal(f.field('送料轨道 相对设备线方向').value, 'negative'); assert.equal(f.field('回程轨道 关联设备线').value, '')
  assert.equal(f.field('回程轨道 设备线与轨道中心距（米）').value, '')
})

test('the visible spacing save action is disabled while busy and retains dirty draft values when the original batch API rejects a stale layout', async t => {
  const f = await fieldFixture(t, { openRailPopup: false })
  await f.field('小车导轨 关联设备线').fire('change', 'lane')
  await f.field('小车导轨 设备线与轨道中心距（米）').fire('change', '.4')
  const draft = JSON.stringify({ layout: f.line.value.layout, devices: f.devices.value })
  for (const state of [f.busy, f.saving]) {
    state.value = true; await settled()
    assert.equal(f.field('保存设备线与轨道设置').props.disabled, true)
    await f.save(); assert.equal(f.requests.filter(row => row.method === 'PUT').length, 0)
    state.value = false; await settled()
  }
  const external = { ...legacyLayout(), rails: [{ ...legacyLayout().rails[0], offsetZ: .9 }] }
  f.sqlite.prepare('UPDATE lines SET layout_json=? WHERE id=?').run(JSON.stringify(external), 'L')
  const changedElsewhere = f.snapshot()
  await f.save()
  assert.equal(f.alerts.at(-1).options.type, 'danger'); assert.match(f.alerts.at(-1).message, /产线结构已被更新/)
  assert.deepEqual(f.snapshot(), changedElsewhere, 'A stale line does not partly save its linked carrier or source paths')
  assert.equal(JSON.stringify({ layout: f.line.value.layout, devices: f.devices.value }), draft)
  assert.equal(f.field('小车导轨 设备线与轨道中心距（米）').value, '0.4')
  assert.equal(f.field('保存设备线与轨道设置').props.disabled, false)
  assert.ok(f.elements().some(node => node.props.role === 'status' && node.text === '有未保存修改'))
  assert.equal(f.saving.value, false)
})

test('uncalibrated line needs no ratio input; opening, saving another setting and reopening never invent a ratio or move devices', async t => {
  const f = await fieldFixture(t, { openRailPopup: false }), original = f.snapshot()
  const assertNoCalibration = () => {
    assert.equal(f.elements().some(node => node.props['aria-label'] === '产线场景单位每米'), false)
    assert.doesNotMatch(f.elements().map(node => node.text).join(' '), /产线场景单位|场景单位\s*\/\s*米/)
    assert.equal(Object.hasOwn(f.line.value.layout, 'sceneUnitsPerMeter'), false)
  }
  assertNoCalibration(); assert.deepEqual(f.snapshot(), original)
  await f.field('小车导轨 关联设备线').fire('change', 'lane')
  assert.equal(f.line.value.layout.rails[0].offsetZ, .6)
  await f.save(); assert.equal(f.alerts.at(-1).options.type, 'success', f.alerts.at(-1).message)
  const put = f.requests.find(row => row.method === 'PUT')
  assert.ok(put); assert.equal(Object.hasOwn(put.body.layout, 'sceneUnitsPerMeter'), false)
  assert.equal(Object.hasOwn(put.body.expectedLayout, 'sceneUnitsPerMeter'), false)
  assert.deepEqual(f.rows(), original.devices, 'Removing a field is not a coordinate rescale or movement migration')
  await f.reopen(); assertNoCalibration(); assert.deepEqual(f.rows(), original.devices)
})

for (const units of [.8, 1.25, 2]) test(`saved legacy line ${units} units/m has no calibration control; spacing save/API/reopen preserves its ratio, precise carrier/path and CAS`, async t => {
  const initial = carrier('cart', units), layout = { ...legacyLayout(), sceneUnitsPerMeter: units }, f = await fieldFixture(t, { layout, devices: [initial] }), rawBefore = f.snapshot()
  const hasCalibrationControl = () => f.elements().some(node => node.props['aria-label'] === '产线场景单位每米')
  assert.equal(hasCalibrationControl(), false); assert.equal(f.line.value.layout.sceneUnitsPerMeter, units)
  assert.deepEqual(f.snapshot(), rawBefore, 'Merely GET/reopening old controls does not write/migrate the line or source')
  await f.field('小车导轨 关联设备线').fire('change', 'lane')
  approximate(Number(f.field('小车导轨 设备线与轨道中心距（米）').value), .6 / units)
  await f.field('小车导轨 设备线与轨道中心距（米）').fire('change', '.6')
  approximate(f.line.value.layout.rails[0].offsetZ, .6 * units)
  const delta = .6 * units - .6, draftCarrier = f.devices.value.find(row => row.id === 'cart'), draftMovement = JSON.parse(draftCarrier.instance_config).movement
  approximate(draftCarrier.pos_z, .6 + delta); approximate(draftMovement.start.z, .7 + delta); assert.equal(draftCarrier.pos_x, -10.125)
  await f.save(); assert.equal(f.alerts.at(-1).options.type, 'success', f.alerts.at(-1).message)
  const put = f.requests.find(row => row.method === 'PUT'); assert.ok(put); assert.equal(put.body.layout.sceneUnitsPerMeter, units)
  assert.equal(put.body.expectedLayout.sceneUnitsPerMeter, units, 'The original calibration remains part of CAS, not a new user input')
  assert.deepEqual(put.body.devicePositions[0].expected, { pos_x: -10.125, pos_z: .6 })
  const savedLine = await f.get(), saved = f.rows()[0], savedConfig = JSON.parse(saved.instance_config)
  assert.equal(savedLine.layout.sceneUnitsPerMeter, units); approximate(savedLine.layout.rails[0].offsetZ, .6 * units)
  approximate(saved.pos_z, .6 * units); assert.equal(saved.pos_x, -10.125)
  for (const point of [savedConfig.movement.start, savedConfig.movement.end, savedConfig.movement.stations[0].position]) approximate(point.z, .7 + delta)
  assert.equal(savedConfig.movement.sceneUnitsPerMeter, units); assert.equal(savedConfig.movement.currentPositionPointId, 'PLC_POSITION')
  assert.deepEqual(savedConfig.animationBindings, initial.instance_config.animationBindings); assert.deepEqual(savedConfig.custom, initial.instance_config.custom)
  await f.reopen(); assert.equal(hasCalibrationControl(), false); assert.equal(f.line.value.layout.sceneUnitsPerMeter, units); assert.equal(f.field('小车导轨 设备线与轨道中心距（米）').value, '0.6')
  approximate(Number(f.field('小车导轨 偏移Z').value), .6 * units)
  const text = f.elements().map(node => node.text).join(' '); assert.match(text, /固定基准 \/ 约束跟随/); assert.match(text, /长度（场景坐标）/); assert.doesNotMatch(text, /偏移Z（米）/)
  assert.equal(f.field('小车导轨 偏移Z').props.disabled, true, 'The carrier rail cannot be repositioned with the arbitrary offset control')
  const before = JSON.stringify({ layout: f.line.value.layout, devices: f.devices.value })
  f.busy.value = true; await settled(); await f.field('小车导轨 设备线与轨道中心距（米）').fire('change', '99')
  assert.equal(JSON.stringify({ layout: f.line.value.layout, devices: f.devices.value }), before); assert.equal(f.field('小车导轨 设备线与轨道中心距（米）').value, '0.6')
})

test('saved contextual line units survive actual fields without exposing calibration or injecting an inherited ratio into source movement or fixed-source configuration', async t => {
  const fixed = { id: 'fixed', name: '固定送料设备', line_id: 'L', pos_x: 5, pos_z: 0, instance_config: { laneLineId: 'L', laneId: 'lane', animationBindings: { transferLink: { enabled: true } }, custom: { preserve: true } } }
  const f = await fieldFixture(t, { layout: { ...legacyLayout(), sceneUnitsPerMeter: .8 }, devices: [carrier(), fixed] })
  assert.equal(f.elements().some(node => node.props['aria-label'] === '产线场景单位每米'), false)
  await f.field('小车导轨 关联设备线').fire('change', 'lane'); await f.field('小车导轨 设备线与轨道中心距（米）').fire('change', '.6')
  await f.save(); assert.equal(f.alerts.at(-1).options.type, 'success', f.alerts.at(-1).message)
  const rows = f.rows(), mobile = JSON.parse(rows.find(row => row.id === 'cart').instance_config), stationary = JSON.parse(rows.find(row => row.id === 'fixed').instance_config)
  assert.equal(Object.hasOwn(mobile.movement, 'sceneUnitsPerMeter'), false); assert.equal(Object.hasOwn(mobile.movement, 'scene_units_per_meter'), false)
  assert.equal(assertLineMovementUnits(mobile.movement, (await f.get()).layout), .8); assert.deepEqual(stationary, fixed.instance_config)
})

test('line-save unit guard checks every owned bound active source on delta=0 and rolls an earlier carrier update back when a later alias is mismatched', async t => {
  const layout = editLineRailSpacing(editLineRailSpacing({ ...legacyLayout(), sceneUnitsPerMeter: .8 }, 'rail', 'laneId', 'lane'), 'rail', 'distanceMeters', .6)
  const first = carrier('a', .8), later = carrier('b', undefined); first.pos_z = later.pos_z = .48
  later.instance_config.movement.scene_units_per_meter = 1.25
  const f = await apiFixture(t, { layout, devices: [first, later] }), before = f.snapshot()
  const result = await f.call({ name: '不应保存', layout, devicePositions: [{ id: 'a', pos_x: first.pos_x, pos_z: .58 }] })
  assert.equal(result.status, 400); assert.match(result.body.error, /现场料车 b.*不一致.*改为 0\.8 后保存/); assert.deepEqual(f.snapshot(), before)
  const nameOnly = await f.call({ name: '仍不应保存', layout }); assert.equal(nameOnly.status, 400); assert.deepEqual(f.snapshot(), before)
})

test('actual line save API accepts screenshot Float32 tails on an active cart without migrating unrelated configuration',async t=>{
  const layout={...legacyLayout(),sceneUnitsPerMeter:.8},device=carrier('cart',.79999999616123)
  const f=await apiFixture(t,{layout,devices:[device]}),before=f.rows()
  const result=await f.call({name:'正常保存',layout});assert.equal(result.status,200,result.body.error);assert.deepEqual(f.rows(),before)
  assert.equal(JSON.parse(f.rows()[0].instance_config).movement.sceneUnitsPerMeter,.79999999616123)
})

test('zero-delta guard includes active lane-bound transfer and fallback line_id ownership, excludes foreign workshop/line rows, and does not rewrite inherited units', async t => {
  const layout = { ...legacyLayout(), sceneUnitsPerMeter: .8 }, bad = carrier('fallback', undefined)
  delete bad.instance_config.railLineId; bad.instance_config.movement.scene_units_per_meter = 2
  const foreign = carrier('foreign', 2, { line_id: null }); foreign.instance_config.workshop_id = 'OTHER'
  const fixed = { id: 'fixed', name: '固定送料设备', line_id: 'L', pos_x: 1, pos_z: 0, instance_config: { laneLineId: 'L', laneId: 'lane', movement: { enabled: false, sceneUnitsPerMeter: 1.25 }, animationBindings: { transferLink: { enabled: true } } } }
  const f = await apiFixture(t, { layout, devices: [bad, foreign, fixed] }), before = f.snapshot()
  let result = await f.call({ name: '不可保存', layout }); assert.equal(result.status, 400); assert.deepEqual(f.snapshot(), before)
  bad.instance_config.movement.scene_units_per_meter = .8
  f.sqlite.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(bad.instance_config), bad.id)
  result = await f.call({ name: '仍不可保存', layout }); assert.equal(result.status, 400); assert.match(result.body.error, /固定送料设备.*不一致/)
  delete fixed.instance_config.movement.sceneUnitsPerMeter
  f.sqlite.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(fixed.instance_config), fixed.id)
  const sourcesBefore = f.rows().map(row => [row.id, row.instance_config])
  result = await f.call({ name: '只修改名称', layout }); assert.equal(result.status, 200, result.body.error)
  assert.deepEqual(f.rows().map(row => [row.id, row.instance_config]), sourcesBefore, 'Line-save comparison has no unit-migration side effect')
  result = await f.call({ name: '越权', layout }, 'FOREIGN'); assert.equal(result.status, 404)
})

for (const workshopLevel of [false, true]) test(`active ${workshopLevel ? 'workshop-associated' : 'primary-line'} source with no rail/lane binding still rejects unit mismatch atomically but never acquires guessed coordinates`, async t => {
  const layout = { ...legacyLayout(), sceneUnitsPerMeter: .8 }, valid = carrier('a', .8), unbound = carrier('b', 1.25)
  delete unbound.instance_config.railId
  if (workshopLevel) unbound.line_id = null
  else { delete unbound.instance_config.railLineId; delete unbound.instance_config.workshop_id }
  const f = await apiFixture(t, { layout, devices: [valid, unbound] }), before = f.snapshot()
  let result = await f.call({ name: '不应保存', layout, devicePositions: [{ id: 'a', pos_x: valid.pos_x, pos_z: .7 }] })
  assert.equal(result.status, 400); assert.match(result.body.error, /现场料车 b.*不一致/); assert.deepEqual(f.snapshot(), before)
  unbound.instance_config.movement.sceneUnitsPerMeter = .8
  f.sqlite.prepare('UPDATE devices SET instance_config=? WHERE id=?').run(JSON.stringify(unbound.instance_config), unbound.id)
  const matched = f.rows().find(row => row.id === 'b')
  result = await f.call({ name: '只保存名称', layout }); assert.equal(result.status, 200, result.body.error)
  assert.deepEqual(f.rows().find(row => row.id === 'b'), matched, 'A valid unit declaration is not a rail binding or a positioning operation')
  const snapshot = f.snapshot()
  result = await f.call({ layout, devicePositions: [{ id: 'b', pos_x: unbound.pos_x, pos_z: .7 }] })
  assert.equal(result.status, 400); assert.match(result.body.error, /明确设备线或导轨绑定/); assert.deepEqual(f.snapshot(), snapshot)
})

test('unit-only line changes participate in real layout CAS, and translated source geometry rejects stale original position/movement HTTP CAS without another translation', async t => {
  const f = await apiFixture(t, { includeMovementRoute: true }), before = (await f.get()).layout, oldMovement = JSON.parse(f.rows()[0].instance_config).movement
  let next = editLineRailSpacing(before, '', 'sceneUnitsPerMeter', '.8'); next = editLineRailSpacing(next, 'rail', 'laneId', 'lane'); next = editLineRailSpacing(next, 'rail', 'distanceMeters', '.6')
  let result = await f.call({ layout: next, expectedLayout: before }); assert.equal(result.status, 200, result.body.error)
  const saved = (await f.get()).layout, source = f.rows()[0], snapshot = f.snapshot()
  result = await f.call({ layout: editLineRailSpacing(saved, '', 'sceneUnitsPerMeter', '1.25'), expectedLayout: before }); assert.equal(result.status, 409); assert.match(result.body.error, /产线结构已被更新/); assert.deepEqual(f.snapshot(), snapshot)
  result = await f.call({ layout: saved, expectedLayout: saved, devicePositions: [{ id: 'cart', pos_x: source.pos_x, pos_z: source.pos_z, expected: { pos_x: source.pos_x, pos_z: .6 } }] })
  assert.equal(result.status, 409); assert.match(result.body.error, /设备位置已被更新/); assert.deepEqual(f.snapshot(), snapshot)
  approximate(JSON.parse(source.instance_config).movement.start.z, .58)
  result = await f.movementCall({ movement: { enabled: false }, pointIds: [], expectedMovement: oldMovement })
  assert.equal(result.status, 409); assert.match(result.body.error, /移动配置或导轨间距已更新/); assert.deepEqual(f.snapshot(), snapshot)
  for (const units of [0, null, '1.25']) {
    result = await f.call({ layout: { ...saved, sceneUnitsPerMeter: units }, expectedLayout: saved }); assert.equal(result.status, 400); assert.deepEqual(f.snapshot(), snapshot)
  }
})

test('actual site-selection controls reject an explicitly mismatched source ratio but accept inherited line calibration without changing devices', async t => {
  const host = memoryHost(t), device = carrier(), devices = ref([{ ...device, model_type: 'photo_transfer_cart_v6' }, { id: 'station', name: '炉体', line_id: 'L', model_type: 'station' }])
  const lines = [{ id: 'L', name: '现场产线', layout: { ...legacyLayout(), sceneUnitsPerMeter: .8 } }], models = [{ id: 'photo_transfer_cart_v6', file_path: '/isolated.glb' }, { id: 'station', file_path: '/isolated.glb' }]
  let vm
  const app = host.renderer.createApp({ setup: () => () => h(Sequence, { devices: devices.value, models, lines, ref: value => { vm = value } }) }); app.mount(host.root); host.beforeRestore(() => app.unmount())
  vm.selectedIds = ['cart', 'station']; await host.field('联动预览排布').fire('change', 'site'); await settled()
  assert.equal(vm.arrangement, 'site'); assert.ok(vm.draft.plan); const before = JSON.stringify(devices.value)
  devices.value[0].instance_config.movement.scene_units_per_meter = 1.25; await settled()
  assert.equal(vm.draft.plan, null); assert.match(vm.draft.error, /不一致.*改为 0\.8 后保存/)
  delete devices.value[0].instance_config.movement.scene_units_per_meter; await settled()
  assert.ok(vm.draft.plan); assert.equal(JSON.stringify(devices.value), before)
})

test('pure preview retains legacy explicit source units until the user explicitly calibrates the line, observing field insertion/removal without upgrading old data', async t => {
  const host = memoryHost(t), devices = ref([{ ...carrier('cart', .8), model_type: 'photo_transfer_cart_v6' }, { id: 'station', name: '炉体', line_id: 'L', model_type: 'station' }])
  const lines = ref([{ id: 'L', name: '旧现场产线', layout: legacyLayout() }]), models = [{ id: 'photo_transfer_cart_v6', file_path: '/isolated.glb' }, { id: 'station', file_path: '/isolated.glb' }]
  let vm
  const app = host.renderer.createApp({ setup: () => () => h(Sequence, { devices: devices.value, models, lines: lines.value, ref: value => { vm = value } }) }); app.mount(host.root); host.beforeRestore(() => app.unmount())
  vm.selectedIds = ['cart', 'station']; await host.field('联动预览排布').fire('change', 'site'); await settled()
  const before = JSON.stringify({ devices: devices.value, lines: lines.value }); assert.ok(vm.draft.plan)
  assert.equal(Object.hasOwn(lines.value[0].layout, 'sceneUnitsPerMeter'), false, 'Old preview does not materialise a calibration')
  lines.value[0].layout.sceneUnitsPerMeter = 1; await settled()
  assert.equal(vm.draft.plan, null); assert.match(vm.draft.error, /不一致/)
  lines.value[0].layout.sceneUnitsPerMeter = .8; await settled(); assert.ok(vm.draft.plan)
  delete lines.value[0].layout.sceneUnitsPerMeter; await settled(); assert.ok(vm.draft.plan)
  assert.equal(JSON.stringify({ devices: devices.value, lines: lines.value }), before, 'Removing the explicit declaration restores old read semantics without changing sources/track offsets')
})

test('unit-field and preview Vue scripts/styles compile without a browser', async () => {
  for (const path of ['../src/views/admin/components/LinePlannerControls.vue', '../src/views/admin/components/LineEquipmentSequence.vue']) {
    const { descriptor, errors } = parse(await readFile(new URL(path, import.meta.url), 'utf8')); assert.deepEqual(errors, [])
    assert.doesNotThrow(() => compileScript(descriptor, { id: 'line-units-compile', inlineTemplate: true }))
    for (const style of descriptor.styles.filter(row => !row.src)) assert.deepEqual(compileStyle({ source: style.content, filename: path, id: 'line-units-compile', scoped: style.scoped }).errors, [])
  }
})

test('ordinary line spacing save receives the real page dirty/saving state and the original transactional save callback', async () => {
  const { descriptor } = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8'))
  const controls = descriptor.template.content.match(/<LinePlannerControls\b[\s\S]*?\/>/)?.[0]
  assert.ok(controls, 'Normal production line-management controls')
  assert.match(controls, /:layout-dirty="lineLayoutDirty"/)
  assert.match(controls, /:layout-saving="lineLayoutSaving"/)
  assert.match(controls, /@change-rail-spacing="changeLineRailSpacing"/)
  assert.match(controls, /@save-layout="saveSelectedLineLayout"/)
})
