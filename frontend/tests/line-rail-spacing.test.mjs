import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { parse } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import { ref } from 'vue'
import * as T from 'three'
import { editLineRailSpacing, resolveLineRailSpacing, lineRailSpacingDeltas, shiftRailMovement } from '../../shared/lineRailSpacing.mjs'
import { normalizeLineLayout as normalizeFrontend } from '../src/views/admin/utils/lineLayout.js'
import { siteDeviceTransform, siteLoadingDatum, siteCarrierPath, siteCarrierInitialPosition, assertSiteTransferDriver, solveSiteTransferPose } from '../src/three/siteTransferAlignment.js'
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url))
const { normalizeLineLayout: normalizeBackend } = backendRequire('./utils/spatialLayout.js')
const clone = value => JSON.parse(JSON.stringify(value))
const layout = () => ({ version: 2, coordinateSpace: 'workshop_local', transform: { x: 3, y: 0, z: 4, rotationY: 0 },
  lanes: [{ id: 'lane', name: '设备线', offsetZ: -2, length: 60, sort_order: 0 }], rails: [{ id: 'rail', name: '小车轨道', offsetZ: 2, length: 60, sort_order: 0 }], flowDirection: 'right' })
const movement = () => ({ enabled: true, currentPositionPointId: 'PLC_POSITION', startActionPointId: 'PLC_RUN', valueMode: 'station', staleMs: 7000, maxSpeed: 3,
  start: { x: -20, y: 0, z: 2.5 }, end: { x: 20, y: 0, z: 2.5 }, stations: [{ value: 1, label: '现场工位', position: { x: -10, y: 0, z: 2.5 }, anchorDeviceId: 'station' }] })

test('old line reopening preserves its independent offsets; selecting a real lane materialises a saved centre-distance setting', () => {
  const old = layout(), original = JSON.stringify(old)
  assert.ok(!normalizeFrontend(old).rails[0].spacing)
  assert.deepEqual(normalizeFrontend(old), normalizeBackend(old))
  let next = editLineRailSpacing(old, 'rail', 'laneId', 'lane')
  assert.deepEqual(next.rails[0].spacing, { laneId: 'lane', distanceMeters: 4, side: 'positive' })
  next = editLineRailSpacing(next, 'rail', 'distanceMeters', '1.25')
  assert.equal(next.rails[0].offsetZ, -.75)
  assert.deepEqual(normalizeFrontend(JSON.stringify(next)), normalizeBackend(JSON.stringify(next)))
  assert.deepEqual(lineRailSpacingDeltas(old, next), [{ railId: 'rail', deltaZ: -2.75 }])
  next = editLineRailSpacing(next, 'rail', 'side', 'negative')
  assert.equal(next.rails[0].offsetZ, -3.25)
  const removed = editLineRailSpacing(next, 'rail', 'laneId', '')
  assert.equal(removed.rails[0].offsetZ, -3.25); assert.ok(!removed.rails[0].spacing)
  assert.equal(JSON.stringify(old), original)
})

test('linked lane movement keeps the configured separation and never silently accepts invalid or missing constraints', () => {
  const linked = editLineRailSpacing(layout(), 'rail', 'laneId', 'lane')
  const moved = clone(linked); moved.lanes[0].offsetZ += 6
  assert.equal(resolveLineRailSpacing(moved).rails[0].offsetZ, 8)
  for (const value of [0, -1, 'bad', Infinity, 10001, true]) {
    const bad = clone(linked); bad.rails[0].spacing.distanceMeters = value
    assert.throws(() => normalizeBackend(bad)); assert.throws(() => normalizeFrontend(bad))
  }
  const missing = clone(linked); missing.lanes = []
  assert.throws(() => resolveLineRailSpacing(missing), /不存在/)
  const overlap = layout(); overlap.rails[0].offsetZ = overlap.lanes[0].offsetZ
  assert.throws(() => editLineRailSpacing(overlap, 'rail', 'laneId', 'lane'), /重合/)
})

test('rail translation rigidly moves enabled start/end/station geometry without changing PLC or authored calibration offsets', () => {
  const source = { movement: movement(), animationBindings: { staleMs: 5000, bindings: [{ actionId: 'feed', pointId: 'PLC_FEED', enabled: true }] }, custom: { keep: 'unchanged' } }
  const before = JSON.stringify(source), shifted = shiftRailMovement(source, 3)
  assert.equal(shifted.movement.start.z, 5.5); assert.equal(shifted.movement.end.z, 5.5); assert.equal(shifted.movement.stations[0].position.z, 5.5)
  const restored = shiftRailMovement(shifted, -3)
  assert.deepEqual(restored, source)
  assert.equal(JSON.stringify(source), before)
  assert.throws(() => shiftRailMovement(source, 2, 'factory_world'), /不是产线本地/)
  assert.equal(shifted.movement.currentPositionPointId, 'PLC_POSITION'); assert.equal(shifted.movement.startActionPointId, 'PLC_RUN')
  assert.deepEqual(shifted.animationBindings, source.animationBindings)
})

test('the real line-parent field handler applies the delta to carrier origin and its enabled movement before one save', async () => {
  const source = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
  const ast = parseJavaScript(source, { sourceType: 'module' })
  const names = ['changeLineRailSpacing', 'touchLineLayout', 'applyLineLayoutDraft', 'buildDeviceLayoutBindingPatch', 'patchBoundDevicesForLayoutItem']
  const functions = names.map(name => { const node = ast.program.body.find(n => n.type === 'FunctionDeclaration' && n.id?.name === name); assert.ok(node); return source.slice(node.start, node.end) }).join('\n')
  const line = ref({ id: 'L', workshop_id: 'W', layout: layout() }), devices = ref([{ id: 'cart', line_id: 'L', coordinate_space: 'line_local', pos_x: -20, pos_z: 2, instance_config: JSON.stringify({ role: 'transfer_cart', railLineId: 'L', railId: 'rail', workshop_id: 'W', movement: movement() }) }])
  const errors = [], dependencies = { selectedLineEditor: line, devices, canAdminPage: () => true, lineDeviceLayoutBusy: ref(false),
    getLineLayout: row => row.layout, editLineRailSpacing, lineRailSpacingDeltas, shiftRailMovement, normalizeLineLayout: normalizeFrontend,
    parseInstanceConfig: value => typeof value === 'string' ? JSON.parse(value) : value || {}, numberOrDefault: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    roundLineLayoutValue: value => value, getLineBaseZ: () => 0, getDevicesBoundToLayoutItem: () => devices.value, alert: message => errors.push(message) }
  const handler = new Function(...Object.keys(dependencies), functions + '\nreturn changeLineRailSpacing')(...Object.values(dependencies))
  handler({ railId: 'rail', field: 'laneId', value: 'lane' }); handler({ railId: 'rail', field: 'distanceMeters', value: '7' })
  assert.equal(line.value.layout.rails[0].offsetZ, 5)
  const cart = devices.value[0], config = JSON.parse(cart.instance_config)
  assert.equal(cart.pos_z, 5); assert.equal(config.movement.start.z, 5.5); assert.equal(config.movement.stations[0].position.z, 5.5)
  assert.equal(config.movement.currentPositionPointId, 'PLC_POSITION'); assert.equal(errors.length, 0)
})

test('real field/lane edits reject invalid geometry atomically even when a later linked carrier is malformed', async () => {
  const source = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')).descriptor.scriptSetup.content
  const ast = parseJavaScript(source, { sourceType: 'module' })
  const names = ['changeLineRailSpacing', 'changeLineLayoutItem', 'touchLineLayout', 'applyLineLayoutDraft', 'buildDeviceLayoutBindingPatch']
  const functions = names.map(name => { const node = ast.program.body.find(n => n.type === 'FunctionDeclaration' && n.id?.name === name); assert.ok(node); return source.slice(node.start, node.end) }).join('\n')
  let base = editLineRailSpacing(layout(), 'rail', 'laneId', 'lane')
  base.rails.push({ ...base.rails[0], id: 'later', name: '后段导轨', spacing: { laneId: 'lane', distanceMeters: 6, side: 'positive' }, offsetZ: 4 })
  const line = ref({ id: 'L', workshop_id: 'W', layout: base, layout_json: JSON.stringify(base) })
  const devices = ref(['rail', 'later'].map((id, index) => ({ id: 'cart' + index, line_id: 'L', coordinate_space: 'line_local', pos_x: -20.125, pos_z: index ? 4 : 2,
    instance_config: JSON.stringify({ railLineId: 'L', railId: id, movement: index ? { ...movement(), start: undefined } : movement() }) })))
  const errors = [], dependencies = { selectedLineEditor: line, devices, canAdminPage: () => true, lineDeviceLayoutBusy: ref(false),
    getLineLayout: row => row.layout, findLineLayoutItem: (type, id) => line.value.layout[type === 'rail' ? 'rails' : 'lanes'].find(item => item.id === id),
    editLineRailSpacing, normalizeLineLayout: normalizeFrontend, shiftRailMovement, getLineBaseZ: () => 0,
    parseInstanceConfig: value => JSON.parse(value), numberOrDefault: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    getDevicesBoundToLayoutItem: (type, id, _line, source = devices.value) => source.filter(device => JSON.parse(device.instance_config)[type === 'rail' ? 'railId' : 'laneId'] === id),
    alert: message => errors.push(message) }
  const handlers = new Function(...Object.keys(dependencies), functions + '\nreturn {' + names.join(',') + '}')(...Object.values(dependencies))
  const before = JSON.stringify({ line: line.value, devices: devices.value })
  handlers.changeLineLayoutItem({ type: 'lane', id: 'lane', field: 'offsetZ', value: 5 })
  assert.equal(JSON.stringify({ line: line.value, devices: devices.value }), before)
  assert.match(errors[0], /轨道基准|坐标无效/)
  handlers.changeLineRailSpacing({ railId: 'rail', field: 'distanceMeters', value: 0 })
  assert.equal(JSON.stringify({ line: line.value, devices: devices.value }), before)
  handlers.changeLineRailSpacing({ railId: 'rail', field: 'distanceMeters', value: 7 })
  assert.equal(devices.value[0].pos_x, -20.125, 'Spacing edits retain precise longitudinal calibration')
  assert.equal(devices.value[0].pos_z, 5); assert.equal(JSON.parse(devices.value[0].instance_config).movement.start.z, 5.5)
  const validSnapshot = JSON.stringify({ line: line.value, devices: devices.value })
  handlers.changeLineLayoutItem({ type: 'rail', id: 'rail', field: 'length', value: 10 })
  assert.equal(JSON.stringify({ line: line.value, devices: devices.value }), validSnapshot, 'Shrinking must not silently clamp calibrated devices')
})

test('real line PUT/GET roundtrip atomically saves rail spacing, carrier origin and enabled path; bad later rows roll everything back', async t => {
  const Database = backendRequire('better-sqlite3'), sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE workshops(id TEXT PRIMARY KEY,name TEXT,factory_id TEXT); CREATE TABLE lines(id TEXT PRIMARY KEY,name TEXT,workshop_id TEXT,layout_json TEXT,sort_order INTEGER); CREATE TABLE devices(id TEXT PRIMARY KEY,line_id TEXT,pos_x REAL,pos_z REAL,coordinate_space TEXT,instance_config TEXT)')
  sqlite.prepare('INSERT INTO workshops VALUES(?,?,?)').run('W', '车间', 'F')
  const old = normalizeBackend(layout())
  sqlite.prepare('INSERT INTO lines VALUES(?,?,?,?,?)').run('L', '产线', 'W', JSON.stringify(old), 0)
  const instance = { role: 'transfer_cart', railLineId: 'L', railId: 'rail', workshop_id: 'W', movement: movement(), animationBindings: { bindings: [{ pointId: 'PLC_FEED' }] } }
  sqlite.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?)').run('cart', 'L', -20, 2, 'line_local', JSON.stringify(instance))
  const db = { get: async (sql, params = []) => sqlite.prepare(sql).get(...params), all: async (sql, params = []) => sqlite.prepare(sql).all(...params), run: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    transaction: async fn => { sqlite.exec('BEGIN'); try { const result = await fn(db); sqlite.exec('COMMIT'); return result } catch (error) { sqlite.exec('ROLLBACK'); throw error } } }
  const databasePath = backendRequire.resolve('./db/database.js'), previous = backendRequire.cache[databasePath]
  backendRequire.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: { getDb: async () => db, getDbStatus: () => ({ type: 'sqlite' }) } }
  const express = backendRequire('express'), app = express()
  app.use(express.json()); app.use((req, _res, next) => { req.factoryId = req.headers['x-factory-id'] || 'F'; next() }); app.use('/api/lines', backendRequire('./routes/lines.js'))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(async () => { await new Promise(resolve => server.close(resolve)); sqlite.close(); if (previous) backendRequire.cache[databasePath] = previous; else delete backendRequire.cache[databasePath] })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (method, body, factory = 'F') => { const response = await fetch(base + '/api/lines/L', { method, headers: { 'content-type': 'application/json', 'x-factory-id': factory }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() } }
  const get = async () => { const response = await fetch(base + '/api/lines', { headers: { 'x-factory-id': 'F' } }); return (await response.json())[0] }
  let next = editLineRailSpacing(old, 'rail', 'laneId', 'lane'); next = editLineRailSpacing(next, 'rail', 'distanceMeters', 7)
  assert.equal((await call('PUT', { layout: next, expectedLayout: old, devicePositions: [{ id: 'cart', pos_x: -20, pos_z: 5, expected: { pos_x: -20, pos_z: 2 } }] })).status, 200)
  const reopened = await get(), saved = sqlite.prepare('SELECT * FROM devices WHERE id=?').get('cart')
  assert.equal(reopened.layout.rails[0].offsetZ, 5); assert.deepEqual(normalizeFrontend(reopened.layout), reopened.layout)
  const savedInstance = JSON.parse(saved.instance_config)
  assert.equal(saved.pos_z, 5); assert.equal(savedInstance.movement.start.z, 5.5); assert.equal(savedInstance.movement.end.z, 5.5); assert.equal(savedInstance.movement.stations[0].position.z, 5.5)
  assert.deepEqual(savedInstance.animationBindings, instance.animationBindings); assert.equal(savedInstance.movement.currentPositionPointId, instance.movement.currentPositionPointId)
  const snapshot = sqlite.prepare('SELECT * FROM lines').all(), deviceSnapshot = sqlite.prepare('SELECT * FROM devices').all()
  const later = editLineRailSpacing(next, 'rail', 'distanceMeters', 8)
  assert.equal((await call('PUT', { layout: later, devicePositions: [{ id: 'cart', pos_x: -20, pos_z: 6 }, { id: 'foreign', pos_x: 0, pos_z: 0 }] })).status, 400)
  assert.deepEqual(sqlite.prepare('SELECT * FROM lines').all(), snapshot); assert.deepEqual(sqlite.prepare('SELECT * FROM devices').all(), deviceSnapshot)
  assert.equal((await call('PUT', { layout: later, expectedLayout: old })).status, 409)
  assert.equal((await call('PUT', { layout: later }, 'FOREIGN')).status, 404)
  const bad = clone(later); bad.rails[0].spacing.distanceMeters = 0
  assert.equal((await call('PUT', { layout: bad })).status, 400); assert.deepEqual(sqlite.prepare('SELECT * FROM lines').all(), snapshot)
  // Factory-switch/older line clients omit devicePositions; linked-rail delta
  // must still shift the active path atomically instead of leaving it behind.
  assert.equal((await call('PUT', { layout: later, expectedLayout: next })).status, 200)
  const implicit = sqlite.prepare('SELECT * FROM devices WHERE id=?').get('cart')
  assert.equal(implicit.pos_z, 6); assert.equal(JSON.parse(implicit.instance_config).movement.start.z, 6.5)
})

test('site ports use the saved raw origin, transform and mirrors; null ports and unbound tracks fail explicitly', () => {
  const lines = [{ id: 'L', workshop_id: 'W', layout: { ...layout(), transform: { x: 0, y: 0, z: 0, rotationY: 0 } } }], workshops = [{ id: 'W', layout: { transform: { x: 0, y: 0, z: 0, rotationY: 0 } } }]
  const cart = { id: 'cart', line_id: 'L', coordinate_space: 'line_local', pos_x: 5, pos_y: 2, pos_z: 2, rotation_y: 0, scale: 2, instance_config: { railLineId: 'L', railId: 'rail', mirrorX: true, movement: movement() } }
  const model = { default_scale: 1, metadata: { loadingPorts: { version: 1, inlet: { position: [1, 1, 0], direction: [-1, 0, 0], nodeName: 'saved_datum' }, outlet: null } } }
  const transform = siteDeviceTransform(cart, model, lines, workshops), datum = siteLoadingDatum(cart, model, transform)
  assert.deepEqual(datum.position.toArray(), [-7, 4, 2]); assert.deepEqual(datum.direction.toArray(), [1, 0, 0])
  assert.equal(siteCarrierPath(cart, lines, workshops).start.z, 2.5, 'preserve the authored .5 origin-to-rail calibration')
  const shifted = { ...cart, pos_z: 5, instance_config: shiftRailMovement(cart.instance_config, 3) }
  assert.equal(siteCarrierPath(shifted, lines, workshops).start.z, 5.5)
  assert.throws(() => siteLoadingDatum(cart, { metadata: { loadingPorts: { version: 1, inlet: null, outlet: null } } }, transform), /没有已配置/)
  assert.throws(() => siteCarrierPath({ ...cart, instance_config: {} }, lines, workshops), /未绑定/)
  const legacy = { ...cart, pos_z: 0, instance_config: { ...cart.instance_config, movement: { ...movement(), start: { x: -20, y: 0, z: .5 }, end: { x: -10, y: 0, z: .5 }, stations: [-21, -7, 7, 21].map((x, index) => ({ value: index + 1, position: { x, y: 0, z: .5 } })) } } }
  const path = siteCarrierPath(legacy, lines, workshops)
  assert.deepEqual(path.stations.map(row => row.position.x), [21, 7, -7, -21], 'Explicit stations outside hidden legacy reference endpoints are not clamped')
  assert.deepEqual(siteCarrierInitialPosition(path, new T.Vector3(-5, 2, 0)).toArray(), [21, 0, .5], 'Site approach starts on the configured track, not the catalogue origin')
  assert.throws(() => siteCarrierPath({ ...legacy, instance_config: { ...legacy.instance_config, movement: { ...legacy.instance_config.movement, end: legacy.instance_config.movement.start } } }, lines, workshops), /方向无效/)
})

test('site scheme refuses to substitute another standard feed for a saved custom driver', () => {
  const asset = new T.Group(), driver = new T.Group(); driver.name = 'cad_transfer_cart_v1_feed_carriage'; asset.add(driver)
  const row = { id: 'cart', model_type: 'cad_transfer_cart_101300', instance_config: { animationBindings: { bindings: [{ actionId: 'clip:feed', enabled: true }], transferLink: { enabled: true, actionId: 'clip:feed', driveNodeName: driver.name } } } }
  assert.doesNotThrow(() => assertSiteTransferDriver(row, { node: () => driver }, asset))
  assert.throws(() => assertSiteTransferDriver({ ...row, instance_config: { animationBindings: { ...row.instance_config.animationBindings, transferLink: { ...row.instance_config.animationBindings.transferLink, actionId: 'custom:other' } } } }, { node: () => driver }, asset), /未替换/)
  const duplicate = driver.clone(); asset.add(duplicate)
  assert.throws(() => assertSiteTransferDriver(row, { node: () => driver }, asset), /未替换/)
})

test('site docking stays on the real line segment and rejects impossible distance/height/orientation instead of rotating or stretching the cart', () => {
  const input = { start: new T.Vector3(-10, 0, 4), end: new T.Vector3(10, 0, 4), cartPortOffset: new T.Vector3(0, 1, 0),
    feedDirection: new T.Vector3(0, 0, -1), stationPosition: new T.Vector3(3, 1, 3.4), stationDirection: new T.Vector3(0, 0, 1), stroke: 1.085 }
  const dock = solveSiteTransferPose(input)
  assert.deepEqual(dock.position.toArray(), [3, 0, 4]); assert.ok(Math.abs(dock.extension - .6) < 1e-9)
  assert.throws(() => solveSiteTransferPose({ ...input, stationPosition: new T.Vector3(3, 1, 1) }), /超出推链行程/)
  assert.throws(() => solveSiteTransferPose({ ...input, stationPosition: new T.Vector3(30, 1, 3.4) }), /超出配置导轨/)
  assert.throws(() => solveSiteTransferPose({ ...input, stationPosition: new T.Vector3(3, 2, 3.4) }), /送料高度/)
  assert.throws(() => solveSiteTransferPose({ ...input, stationDirection: new T.Vector3(0, 0, -1) }), /朝向不相对/)
  assert.throws(() => solveSiteTransferPose({ ...input, feedDirection: new T.Vector3(1, 0, 0) }), /朝向不相对|导轨平行/)
  for (const [field, value] of [['heightToleranceMeters', 1.01], ['lateralToleranceMeters', 1.01], ['angleToleranceDegrees', 30.01]]) assert.throws(() => solveSiteTransferPose({ ...input, [field]: value }), /公差无效/)
  assert.deepEqual(input.start.toArray(), [-10, 0, 4]); assert.deepEqual(input.end.toArray(), [10, 0, 4])
})
