import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { buildLineSimulation, sampleLineSimulation } from '../src/three/lineSimulation.js'
import { editLineRailSpacing, shiftRailMovement } from '../../shared/lineRailSpacing.mjs'

// Execute the real scene/rig/frame code with isolated GLB objects, no browser,
// renderer, WebGL, animation loop, assets network, or live factory writes.
class MemoryScene {
  constructor() {
    this.scene = new T.Scene(); this.camera = new T.PerspectiveCamera(38, 1, .01, 100)
    this.camera.position.set(4, 6, 10)
    this.renderer = { domElement: { style: {} } }
    this.controls = { target: new T.Vector3(), mouseButtons: {}, touches: {}, update() {}, enableDamping: true }
  }
  setCutaway(value) { this.cutaway = value }
  release(root) { root.traverse(node => { node.geometry?.dispose(); [].concat(node.material || []).forEach(material => material.dispose()) }) }
  dispose() { this.disposed = true; this.scene.children.slice().forEach(child => this.release(child)) }
}
let assetFactory, loadCount = 0
mock.module('../src/three/CadMotionScene.js', { namedExports: { CadMotionScene: MemoryScene } })
mock.module('../src/runtime/ConfiguredFactoryScene.js', { namedExports: { loadConfiguredGltf: async url => { loadCount++; return { scene: assetFactory(url) } } } })
mock.module('../src/three/ModelFactory.js', { namedExports: { resolveBackendAssetUrl: path => path, createDeviceModel: async () => { throw Error('No invented fallback model in site tests') } } })
const { LineSimulationScene } = await import('../src/three/LineSimulationScene.js')
const clone = value => JSON.parse(JSON.stringify(value))
const approx = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} != ${expected}`)
const approximateVector = (actual, expected, label) => actual.toArray().forEach((value, index) => approx(value, expected.toArray()[index], `${label} ${'xyz'[index]}`))
const dimensions = payload => {
  payload.updateWorldMatrix(true, true)
  const matrix = new T.Matrix3().setFromMatrix4(payload.matrixWorld)
  return [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)].map(axis => axis.applyMatrix3(matrix).length())
}
const configuredDimensions = (payload, units, sizes = [.8, .4, .6]) => dimensions(payload).forEach((value, index) => approx(value, sizes[index] * units, `Configured world dimension ${index}`))
const feedMiddle = f => { const step = f.plan.steps.find(row => row.kind === 'feed'); return sampleLineSimulation(f.plan, step.start + step.duration / 2) }

function fixture(t, { gap = .6, driver = 'part:cart_feed_extension', signedStroke = .92 } = {}) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillText() {} }) }) } })
  t.after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document })
  const models = [
    { id: 'photo_transfer_cart_v6', file_path: '/cart-fixture.glb', metadata: { loadingPorts: { version: 1, inlet: null, outlet: { position: [0, 1, 0], direction: [Math.sign(signedStroke), 0, 0], nodeName: 'cart_datum' } },
      partBindings: [{ id: 'cart_feed_extension', node_name: 'cart_v6_node_cart_feed_shuttle', source_key: 'cart_feed_extension', action: 'translate', axis: 'x', output_min: 0, output_max: signedStroke }] } },
    { id: 'fixture_station', file_path: '/station-fixture.glb', metadata: { loadingPorts: { version: 1, inlet: { position: [0, 1, 0], direction: [0, 0, signedStroke > 0 ? -1 : 1], nodeName: 'station_datum' }, outlet: null },
      partBindings: [{ id: 'front-door', node_name: 'door', source_group: 'doors', action: 'translate', axis: 'y', output_min: 0, output_max: 1 }] } }
  ]
  const cart = { id: 'cart', name: '现场料车', model_type: models[0].id, line_id: 'L', coordinate_space: 'line_local', pos_x: -20, pos_y: 0, pos_z: 0, rotation_y: -Math.PI / 2, scale: 1,
    instance_config: { railLineId: 'L', railId: 'r', movement: { enabled: true, currentPositionPointId: 'PLC_POS', valueMode: 'station', stationInputMeaning: 'current',
      start: { x: -20, y: 0, z: .5 }, end: { x: -10, y: 0, z: .5 }, stations: [-21, -7, 7, 21].map((x, index) => ({ value: index + 1, anchorDeviceId: index === 1 ? 'station' : 'other-' + index, position: { x, y: 0, z: .5 } })) },
      animationBindings: { bindings: [{ actionId: driver, enabled: true }], transferLink: { enabled: true, actionId: driver, driveNodeName: 'cart_v6_node_cart_feed_shuttle', targetMode: 'fixed', targetDeviceId: 'station',
        sourcePort: 'outlet', targetPort: 'inlet', presenceDataItemId: 'fixture-material', materialSize: [.8, .4, .6], materialColor: '#112233', heightToleranceMeters: .05, lateralToleranceMeters: .05, angleToleranceDegrees: 5 } } } }
  const station = { id: 'station', name: '现场炉体', model_type: models[1].id, line_id: 'L', coordinate_space: 'line_local', pos_x: -7, pos_y: 0, pos_z: .5 + gap * Math.sign(signedStroke), rotation_y: 0, scale: 1 }
  const lines = [{ id: 'L', workshop_id: 'W', layout: { version: 2, transform: { x: 0, y: 0, z: 0, rotationY: 0 }, lanes: [{ id: 'lane', name: '设备线', offsetZ: -2, length: 60 }], rails: [{ id: 'r', name: '导轨', offsetZ: 0, length: 60 }] } }]
  const workshops = [{ id: 'W', layout: { transform: { x: 0, y: 0, z: 0, rotationY: 0 } } }]
  assetFactory = url => {
    const root = new T.Group(), mesh = new T.Mesh(new T.BoxGeometry(2, 2, 1), new T.MeshStandardMaterial({ color: '#888888' }))
    mesh.position.set(2, 1, 1); root.add(mesh)
    for (const name of url.includes('cart') ? ['cart_v6_node_cart_feed_shuttle', 'cart_datum'] : ['door', 'station_datum']) { const node = new T.Group(); node.name = name; root.add(node) }
    return root
  }
  loadCount = 0
  const plan = buildLineSimulation([cart, station], models, { process: false }), source = JSON.stringify({ cart, station, lines, workshops, models })
  const scene = new LineSimulationScene({}, () => {})
  t.after(() => scene.dispose())
  return { scene, plan, cart, station, lines, workshops, models, source }
}

test('real site preview preserves raw origins, authored initial rail plane and unbounded legacy stations for every approach sample', async t => {
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  assert.equal(loadCount, 2)
  const cart = f.scene.entries.get('cart'), station = f.scene.entries.get('station')
  assert.deepEqual(cart.offset.position.toArray(), [0, 0, 0]); assert.deepEqual(station.offset.position.toArray(), [0, 0, 0])
  assert.deepEqual(cart.sitePath.stations.map(row => row.position.x), [21, 7, -7, -21])
  assert.deepEqual(cart.basePosition.toArray(), [21, 0, .5], 'Native initial configured first station, not off-track stored origin')
  const approach = f.plan.steps.find(step => step.kind === 'approach')
  for (const progress of [0, .25, .5, .75, 1]) {
    f.scene.applyFrame(sampleLineSimulation(f.plan, approach.start + approach.duration * progress))
    approx(cart.wrapper.position.z, .5, 'First approach stays on calibrated track')
    approx(cart.wrapper.position.y, 0, 'First approach stays at rail height')
    approx(cart.wrapper.rotation.y, -Math.PI / 2, 'Site preview never rotates an incompatible cart to fake docking')
  }
  assert.equal(JSON.stringify({ cart: f.cart, station: f.station, lines: f.lines, workshops: f.workshops, models: f.models }), f.source)
})

test('real site feed/retract/reclaim use the bounded configured signed stroke and explicit material settings with deterministic seeking', async t => {
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const entry = f.scene.entries.get('cart'), feed = f.plan.steps.find(step => step.kind === 'feed'), reclaim = f.plan.steps.find(step => step.kind === 'reclaim')
  const middle = sampleLineSimulation(f.plan, feed.start + feed.duration / 2)
  f.scene.applyFrame(middle)
  approx(entry.rig.shuttle.position.x, .46, 'Real part binding half stroke')
  approx(f.scene.material.position.z, .96, 'Material follows feed displacement without invented long travel')
  approx(f.scene.material.position.y, 1.2, 'Metre-configured cuboid rests on source port, not through its centre')
  assert.equal(f.scene.material.children.length, 1); assert.equal(f.scene.material.children[0].material.color.getHexString(), '112233')
  assert.deepEqual(Object.values(f.scene.material.children[0].geometry.parameters).slice(0, 3), [1, 1, 1]); configuredDimensions(f.scene.material, 1)
  const snapshot = () => [...entry.wrapper.position.toArray(), ...entry.rig.shuttle.position.toArray(), ...f.scene.material.position.toArray()]
  const halfway = snapshot(); f.scene.applyFrame(sampleLineSimulation(f.plan, f.plan.total)); f.scene.applyFrame(middle); assert.deepEqual(snapshot(), halfway)
  f.scene.applyFrame(sampleLineSimulation(f.plan, reclaim.start + reclaim.duration / 2)); approx(entry.rig.shuttle.position.x, .46, 'Reclaim returns along same mechanism')
  f.scene.applyFrame(sampleLineSimulation(f.plan, f.plan.total)); approx(entry.rig.shuttle.position.x, 0, 'Hook returns home'); approx(f.scene.material.position.z, .5, 'Material returns on the cart')
})

test('negative authored photo-cart stroke feeds to the opposite side, not a hard-coded +X shuttle', async t => {
  const f = fixture(t, { signedStroke: -.92 }); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const feed = f.plan.steps.find(step => step.kind === 'feed'); f.scene.applyFrame(sampleLineSimulation(f.plan, feed.start + feed.duration / 2))
  approx(f.scene.entries.get('cart').rig.shuttle.position.x, -.46, 'Saved negative stroke')
  approx(f.scene.material.position.z, .04, 'Material follows saved negative direction')
})

test('site preview rejects impossible spacing, unsupported saved actions and missing ports without changing source data', async t => {
  for (const input of [{ gap: 3 }, { driver: 'custom:alternate' }]) {
    const f = fixture(t, input)
    await assert.rejects(() => f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site'), /超出推链行程|未替换/)
    assert.equal(JSON.stringify({ cart: f.cart, station: f.station, lines: f.lines, workshops: f.workshops, models: f.models }), f.source)
    f.scene.dispose()
  }
  const f = fixture(t); f.models[0].metadata.loadingPorts.outlet = null
  f.plan = buildLineSimulation([f.cart, f.station], f.models, { process: false })
  await assert.rejects(() => f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site'), /没有已配置/)
  const misaligned = fixture(t); misaligned.models[0].metadata.loadingPorts.outlet.direction = [-1, 0, 0]
  misaligned.plan = buildLineSimulation([misaligned.cart, misaligned.station], misaligned.models, { process: false })
  await assert.rejects(() => misaligned.scene.loadPlan(misaligned.plan, misaligned.lines, misaligned.workshops, 'site'), /朝向与实际送料驱动不一致/)
})

test('saved rail gap translation preserves initial/calibrated geometry exactly once in actual site playback', async t => {
  const f = fixture(t)
  let next = editLineRailSpacing(f.lines[0].layout, 'r', 'laneId', 'lane'); next = editLineRailSpacing(next, 'r', 'distanceMeters', 5)
  f.lines[0].layout = next; f.cart.pos_z += 3; f.cart.instance_config = shiftRailMovement(f.cart.instance_config, 3)
  f.station.pos_z += 3
  const plan = buildLineSimulation([f.cart, f.station], f.models, { process: false }); await f.scene.loadPlan(plan, f.lines, f.workshops, 'site')
  const cart = f.scene.entries.get('cart'); assert.equal(cart.basePosition.z, 3.5)
  const feed = plan.steps.find(step => step.kind === 'feed'); f.scene.applyFrame(sampleLineSimulation(plan, feed.start + feed.duration / 2))
  approx(cart.wrapper.position.z, 3.5, 'Persisted path only, no second runtime rail delta')
  approx(f.scene.material.position.z, 3.96, 'Material retains original calibrated separation')
})

test('actual site unit-cube dimensions and world half-height use source scene units while real mechanism travel is not rescaled twice', async t => {
  for (const units of [.8, 1.25, 2]) {
    const f = fixture(t); f.cart.instance_config.movement.sceneUnitsPerMeter = units
    await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
    const result = f.scene.applyFrame(feedMiddle(f)); assert.equal(result.usable, true, result.reason)
    const cart = f.scene.entries.get('cart'), dock = f.scene.dock('station')
    configuredDimensions(f.scene.material, units)
    approx(f.scene.material.position.y, 1 + .2 * units, 'Source port world Y plus metric half-height')
    approx(f.scene.material.position.z, .96, 'Actual drive displacement remains world .46, independent of units/m')
    approx(cart.rig.shuttle.position.x, .46, 'Authored local stroke remains unchanged')
    approx(dock.extensionMeters, .6 / units, 'Actual distance converted to metres'); approx(dock.strokeMeters, .92 / units, 'Actual stroke converted to metres')
  }
})

test('same-instance source units aliases, canonical precedence, size and colour update without stale dock/material state; invalid units hide and recover', async t => {
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const movement = f.cart.instance_config.movement, link = f.cart.instance_config.animationBindings.transferLink, frame = feedMiddle(f)
  for (const units of [.8, 1.25, 2]) {
    movement.scene_units_per_meter = units; delete movement.sceneUnitsPerMeter
    const before = JSON.stringify(f.cart.instance_config), result = f.scene.applyFrame(frame)
    assert.equal(result.usable, true, result.reason); configuredDimensions(f.scene.material, units)
    approx(f.scene.material.position.y, 1 + .2 * units, 'Hot alias world half-height')
    assert.equal(JSON.stringify(f.cart.instance_config), before, 'Frame does not manufacture samples or alter configuration')
  }
  movement.sceneUnitsPerMeter = .8; movement.scene_units_per_meter = 2
  link.materialSize = [.3, .5, .7]; link.materialColor = '#AABBCC'
  assert.equal(f.scene.applyFrame(frame).usable, true); configuredDimensions(f.scene.material, .8, link.materialSize)
  approx(f.scene.material.position.y, 1.2, 'Canonical units take precedence over alias'); assert.equal(f.scene.material.children[0].material.color.getHexString(), 'aabbcc')
  movement.sceneUnitsPerMeter = 0
  const invalid = f.scene.applyFrame(frame); assert.equal(invalid.usable, false); assert.match(invalid.reason, /米制比例无效/); assert.equal(f.scene.material.visible, false)
  delete movement.sceneUnitsPerMeter
  assert.equal(f.scene.applyFrame(frame).usable, true); assert.equal(f.scene.material.visible, true); configuredDimensions(f.scene.material, 2, link.materialSize)
  approx(f.scene.material.position.y, 1.5, 'Valid alias recovers current metric height'); assert.equal(f.scene.siteTransferReason, '')
  link.materialSize = [.3, 0, .7]; assert.equal(f.scene.applyFrame(frame).usable, false); assert.equal(f.scene.material.visible, false)
  link.materialSize = [.3, .5, .7]; assert.equal(f.scene.applyFrame(frame).usable, true); assert.equal(f.scene.material.visible, true)
})

test('payload parent nonuniform scales and X reflection preserve actual world dimensions and centre independently of source model scale', async t => {
  for (const sign of [1, -1]) {
    const f = fixture(t); f.cart.instance_config.movement.sceneUnitsPerMeter = 1.25
    await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
    const cart = f.scene.entries.get('cart'), station = f.scene.entries.get('station')
    cart.wrapper.scale.setScalar(2); station.wrapper.scale.setScalar(2)
    const parent = new T.Group(); parent.position.set(13, 4, -8); parent.scale.set(2 * sign, 3, 4); f.scene.scene.add(parent); parent.add(f.scene.material)
    const result = f.scene.applyFrame(feedMiddle(f)); assert.equal(result.usable, true, result.reason)
    configuredDimensions(f.scene.material, 1.25)
    approximateVector(f.scene.material.getWorldPosition(new T.Vector3()), new T.Vector3(7, 2.25, 1.42), 'Compensated payload world centre')
    approx(cart.rig.shuttle.position.x, .46, 'Model scale does not modify saved local displacement')
    const y = new T.Vector3(0, 1, 0).applyMatrix3(new T.Matrix3().setFromMatrix4(f.scene.material.matrixWorld)).normalize()
    approximateVector(y, new T.Vector3(0, 1, 0), 'X mirror does not invert support')
  }
})

test('nested scaled/rotated/X-mirrored scene parents are included once in docking and actual drive vectors; world material half-height is never parent-scaled twice', async t => {
  for (const sign of [1, -1]) {
    const f = fixture(t); f.cart.instance_config.movement.sceneUnitsPerMeter = 1.25
    await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
    const parent = new T.Group(); parent.position.set(11, 4, -9); parent.rotation.y = .3; parent.scale.set(2 * sign, 3, 4); parent.add(f.scene.scene)
    const result = f.scene.applyFrame(feedMiddle(f)); assert.equal(result.usable, true, result.reason)
    const cart = f.scene.entries.get('cart'), dock = f.scene.dock('station')
    approximateVector(cart.wrapper.position, new T.Vector3(7, 0, .5), 'Parent-local dock unchanged')
    approximateVector(dock.worldPosition, parent.localToWorld(new T.Vector3(7, 0, .5)), 'Dock uses actual parent world matrix')
    configuredDimensions(f.scene.material, 1.25)
    const expected = parent.localToWorld(new T.Vector3(7, 1, .96)); expected.y += .25
    approximateVector(f.scene.material.getWorldPosition(new T.Vector3()), expected, 'World centre follows port + real world drive + world half-height')
    approx(dock.strokeMeters, .92 * 4 / 1.25, 'Actual nested drive vector is converted to metres')
  }
})

test('actual nested drive-node parent and hot output home/stroke determine rendered displacement, not a cached scalar or recaptured animated rest', async t => {
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const cart = f.scene.entries.get('cart'), driveParent = new T.Group(); driveParent.scale.set(2, 1, 1); cart.asset.add(driveParent); driveParent.add(cart.rig.shuttle)
  const frame = feedMiddle(f), result = f.scene.applyFrame(frame); assert.equal(result.usable, true, result.reason)
  approx(f.scene.material.position.z, 1.42, 'Actual nested displacement .46 × 2 follows rendered shuttle')
  approx(f.scene.dock('station').strokeMeters, 1.84, 'Actual nested maximum drive, not cart.scale')
  const binding = cart.row.capabilities.model.metadata.partBindings[0]; binding.output_min = .2; binding.output_max = 1.12
  assert.equal(f.scene.applyFrame(frame).usable, true)
  approx(cart.rig.shuttle.position.x, .66, 'Hot configured home applies to real rig'); approx(f.scene.material.position.z, 1.42, 'Only actual displacement relative to new home is added')
  binding.output_max = .66
  assert.equal(f.scene.applyFrame(frame).usable, true); approx(cart.rig.shuttle.position.x, .43, 'Hot signed stroke applies to real node')
  approx(f.scene.material.position.z, .96, 'Material follows hot bounded stroke, not old full travel')
  driveParent.scale.x = -2
  const invalid = f.scene.applyFrame(frame); assert.equal(invalid.usable, false); assert.equal(f.scene.material.visible, false); assert.match(invalid.reason, /朝向与实际送料驱动不一致/)
  driveParent.scale.x = 2
  assert.equal(f.scene.applyFrame(frame).usable, true); assert.equal(f.scene.material.visible, true)
})

test('hot sheared, Y-inverted, degenerate and tilted payload/support transforms hide invalid material and recover on a valid later frame', async t => {
  const configurations = [
    { name: 'nonuniform yaw shear', configure: parent => { parent.scale.set(2, 3, 4); parent.rotation.y = Math.PI / 4 } },
    { name: 'Y reflection', configure: parent => parent.scale.set(2, -3, 4) },
    { name: 'zero scale', configure: parent => parent.scale.set(0, 3, 4) },
    { name: 'nonfinite transform', configure: parent => { parent.position.x = NaN } }
  ]
  for (const input of configurations) {
    const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site'); const frame = feedMiddle(f)
    const parent = new T.Group(); f.scene.scene.add(parent); parent.add(f.scene.material)
    assert.equal(f.scene.applyFrame(frame).usable, true)
    input.configure(parent); const invalid = f.scene.applyFrame(frame)
    assert.equal(invalid.usable, false, input.name); assert.ok(invalid.reason); assert.equal(f.scene.material.visible, false, input.name)
    parent.position.set(0, 0, 0); parent.rotation.set(0, 0, 0); parent.scale.set(2, 3, 4)
    const valid = f.scene.applyFrame(frame); assert.equal(valid.usable, true, valid.reason); assert.equal(f.scene.material.visible, true); configuredDimensions(f.scene.material, 1)
    approximateVector(f.scene.material.getWorldPosition(new T.Vector3()), new T.Vector3(7, 1.2, .96), 'Recovery applies current world centre')
  }
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const support = new T.Group(); support.add(f.scene.scene); support.rotation.x = .2
  const invalid = f.scene.applyFrame(feedMiddle(f)); assert.equal(invalid.usable, false); assert.equal(f.scene.material.visible, false)
  support.rotation.x = 0; assert.equal(f.scene.applyFrame(feedMiddle(f)).usable, true); assert.equal(f.scene.material.visible, true)
})

test('same-instance height/lateral acceptance boundaries follow current source metre scale and current saved tolerances', async t => {
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const cart = f.scene.entries.get('cart'), station = f.scene.entries.get('station'), movement = cart.row.instance_config.movement
  station.wrapper.position.y = .075
  movement.sceneUnitsPerMeter = 2; assert.equal(f.scene.applyFrame(feedMiddle(f)).usable, true, '0.075 world is within 0.05 m at 2 units/m')
  movement.sceneUnitsPerMeter = .8
  let invalid = f.scene.applyFrame(feedMiddle(f)); assert.equal(invalid.usable, false); assert.match(invalid.reason, /送料高度/)
  station.wrapper.position.y = 0; station.wrapper.position.x = 7.075
  invalid = f.scene.applyFrame(feedMiddle(f)); assert.equal(invalid.usable, false); assert.match(invalid.reason, /横向错位/)
  movement.sceneUnitsPerMeter = 2; assert.equal(f.scene.applyFrame(feedMiddle(f)).usable, true, 'Hot units invalidate old failed docking')
  cart.row.instance_config.animationBindings.transferLink.lateralToleranceMeters = .03
  invalid = f.scene.applyFrame(feedMiddle(f)); assert.equal(invalid.usable, false); assert.match(invalid.reason, /横向错位/)
  cart.row.instance_config.animationBindings.transferLink.lateralToleranceMeters = .05
  assert.equal(f.scene.applyFrame(feedMiddle(f)).usable, true); assert.equal(f.scene.material.visible, true)
})

test('hot source/target port changes use current saved datums and reject explicit null or wrong direction without cached docking or automatic cart rotation', async t => {
  const f = fixture(t); await f.scene.loadPlan(f.plan, f.lines, f.workshops, 'site')
  const frame = feedMiddle(f), cart = f.scene.entries.get('cart'), link = cart.row.instance_config.animationBindings.transferLink
  assert.equal(f.scene.applyFrame(frame).usable, true)
  f.models[0].metadata.loadingPorts.outlet.position = [.1, 1, 0]
  assert.equal(f.scene.applyFrame(frame).usable, true); approx(f.scene.material.position.z, 1.06, 'Current source datum plus real .46 drive')
  approx(f.scene.dock('station').extensionMeters, .5, 'New datum invalidates old .6 dock offset')
  link.sourcePort = 'inlet'
  let invalid = f.scene.applyFrame(frame); assert.equal(invalid.usable, false); assert.match(invalid.reason, /没有已配置/); assert.equal(f.scene.material.visible, false)
  link.sourcePort = 'outlet'; link.targetPort = 'outlet'
  invalid = f.scene.applyFrame(frame); assert.equal(invalid.usable, false); assert.match(invalid.reason, /没有已配置/); assert.equal(f.scene.material.visible, false)
  link.targetPort = 'inlet'; f.models[0].metadata.loadingPorts.outlet.direction = [-1, 0, 0]
  invalid = f.scene.applyFrame(frame); assert.equal(invalid.usable, false); assert.match(invalid.reason, /朝向与实际送料驱动不一致/)
  approx(cart.wrapper.rotation.y, -Math.PI / 2, 'Invalid new datum does not rotate source to fake a valid transfer')
  f.models[0].metadata.loadingPorts.outlet.direction = [1, 0, 0]
  assert.equal(f.scene.applyFrame(frame).usable, true); assert.equal(f.scene.material.visible, true); approx(f.scene.material.position.z, 1.06, 'Valid port recovery uses latest source position')
})

test('saved cycle uses its authored cart home before first feed, not the legacy hook datum', () => {
  const scene=new LineSimulationScene({},()=>{}),wrapper=new T.Group(),material=new T.Group();material.add(new T.Mesh(new T.BoxGeometry(1,1,1),new T.MeshStandardMaterial()));
  wrapper.position.set(10,2,4);wrapper.scale.set(2,2,2);wrapper.updateMatrixWorld(true);
  const cart={row:{id:'cart',capabilities:{cart:true}},wrapper,scale:2,basePosition:wrapper.position.clone(),baseYaw:0,
    port:new T.Vector3(-30,0,0),rig:{node:()=>null,applyLinked(){}},sceneUnitsPerMeter:.8,
    savedLink:{cycle:{enabled:true,cartHome:[0,1.25,0],stations:[]},materialSize:[.6,.3,.6]}};
  scene.scene.add(wrapper,material);scene.plan={cart:{id:'cart'}};scene.mode='site';scene.entries=new Map([['cart',cart]]);scene.material=material;scene.siteMaterialConfigured=true;
  scene.configureSiteCart=()=>cart.savedLink;
  const result=scene.applyFrame({cart:{from:null,to:null,progress:0,feed:0,runTime:0,segments:[]},states:{cart:{}},step:{deviceId:'cart',kind:'approach'},material:{holder:'cart',from:'',to:'',progress:0},elapsed:0});
  assert.equal(result.usable,true,result.reason);
  const expected=wrapper.localToWorld(new T.Vector3(0,1.25,0)).add(new T.Vector3(0,.3*.8/2,0));
  assert.ok(material.getWorldPosition(new T.Vector3()).distanceTo(expected)<1e-8);
})
