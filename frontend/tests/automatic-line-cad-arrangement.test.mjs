import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { lineDeviceEnvelope } from '../src/three/lineDeviceFootprints.js'
import { inferLoadingPort } from '../src/three/lineLoadingAlignment.js'
import { prepareGuidedLineArrangement } from '../../shared/lineGuidedArrangement.mjs'
import { assertLineTemplateClearance } from '../../shared/linePlacementTemplate.mjs'

// Synthetic regression using repository CAD, not a copied site database or
// operator calibration. Eight stations share one lane and one original cart.
const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const fixedIds = [
  'cad_multipurpose_furnace_082000', 'cad_tempering_furnace_091300',
  'cad_multipurpose_furnace_082000', 'cad_lifting_load_table_111400',
  'cad_cleaner_170700', 'cad_fixed_load_table_112200',
  'cad_air_cooling_table_115800ht', 'cad_water_cooling_tank_471000'
]
const cartId = 'cad_transfer_cart_101300'
const assets = new Map()
for (const id of new Set([...fixedIds, cartId])) {
  const model = structuredClone(require('./services/builtinModels').getBuiltinModels().find(m => m.id === id))
  const bytes = await readFile(new URL(`../../backend${model.file_path}`, import.meta.url))
  const root = (await new Promise((yes, no) => new GLTFLoader().parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', yes, no
  ))).scene
  const port = inferLoadingPort(root, { model_type: id }, model, 'inlet')
  assert.ok(port, `Known authored CAD surface for ${id}`)
  model.metadata = { ...JSON.parse(model.metadata), loadingPorts: { version: 1, inlet: port, outlet: port } }
  assets.set(id, { model, root })
}

function fixture({ reversedInlet = false, modelRegions = false } = {}) {
  const configuredAssets = new Map([...assets].map(([id, value]) => {
    const model = structuredClone(value.model)
    if (modelRegions) for (const kind of ['inlet', 'outlet']) {
      const port = model.metadata.loadingPorts[kind], [x, , z] = port.direction, tangent = [z, 0, -x]
      const corner = (width, height) => port.position.map((v, i) => v + width * tangent[i] + (i === 1 ? height : 0))
      port.region = { version: 1, corners: [corner(-.1, 0), corner(.1, 0), corner(.1, .2), corner(-.1, .2)], surfaceNormal: [...port.direction] }
    }
    return [id, { model, root: value.root }]
  }))
  const layout = {
    sceneUnitsPerMeter: .8,
    lanes: [{ id: 'stations', name: '测试设备线', offsetZ: -6, length: 100 }],
    rails: [{ id: 'track', offsetZ: .5, length: 100 }]
  }
  const devices = fixedIds.map((model_type, i) => ({
    id: `station-${i}`, name: `测试工位 ${i + 1}`, model_type,
    pos_x: -35 + i * 10, pos_y: .1, pos_z: -6,
    rotation_y: [0, Math.PI / 2, Math.PI, -Math.PI / 2][i % 4], scale: 2,
    instance_config: {
      laneId: 'stations', laneLineId: 'test-line', mirrorX: i === 0 || i === 2,
      ...(reversedInlet && i === 5 ? {
        loadingPortOverrides: { version: 1, inlet: { offset: [0, 0, 0], yawDegrees: 180 }, outlet: null }
      } : {}),
      preserve: { plc: 'synthetic-readonly', station: i + 1 }
    }
  }))
  devices.push({
    id: 'cart', name: '测试小车', model_type: cartId,
    pos_x: -40, pos_y: .1, pos_z: .5, rotation_y: Math.PI / 2, scale: 2,
    instance_config: { railId: 'track', railLineId: 'test-line', movement: {
      enabled: true, start: { x: -40, y: .1, z: .5 }, end: { x: 40, y: .1, z: .5 }
    } }
  })
  const measure = candidates => candidates.map(d => {
    const { model, root } = configuredAssets.get(d.model_type)
    return { id: d.id, name: d.name, x: d.pos_x, y: d.pos_y, z: d.pos_z,
      ...lineDeviceEnvelope(root, d, model, { parts: true }),
      ...(d.instance_config.railId ? { railId: 'track', pathMinZ: .5, pathMaxZ: .5 } : { laneId: 'stations' }) }
  })
  const plan = (candidates = devices) => prepareGuidedLineArrangement(layout, 'single-negative', measure(candidates), {
    measure: changes => measure(candidates.map(d => ({ ...d,
      ...(changes.some(p => p.id === d.id) ? { rotation_y: changes.find(p => p.id === d.id).rotation_y } : {})
    })))
  })
  return { layout, devices, measure, plan }
}

test('eight actual CAD stations at double scale and .8 scene units all fit after measured mouth alignment', async () => {
  const f = fixture(), before = structuredClone({ layout: f.layout, devices: f.devices })
  const p = await f.plan()
  assert.equal(p.rows.length, 9)
  assert.doesNotThrow(() => assertLineTemplateClearance(p.layout, p.rows))
  assert.deepEqual({ layout: f.layout, devices: f.devices }, before)
  for (const row of p.rows) {
    const old = f.devices.find(d => d.id === row.id)
    assert.equal(row.x, old.pos_x); assert.equal(row.y, old.pos_y)
    assert.ok(row.loadingPort.direction[2] * (row.railId ? -1 : 1) > .999)
    assert.equal(row.loadingPort.source, 'model')
    assert.equal(row.loadingPort.overrideYawDegrees, 0)
  }
  assert.equal(p.rows.find(r => r.railId).transferStroke, 2.17)
  assert.equal(p.rows.find(r => r.railId).z, .5)
  assert.ok(p.deviceTransforms.every(t => Object.keys(t).every(k => ['id', 'pos_z', 'rotation_y'].includes(k))))
})

test('reversing one staging inlet normal without moving its datum blocks only that station, never all eight', async () => {
  const f = fixture({ reversedInlet: true }), before = structuredClone({ layout: f.layout, devices: f.devices })
  await assert.rejects(f.plan(), error => {
    assert.equal(error.code, 'LINE_AUTO_ALIGNMENT_REQUIRES_3D')
    assert.deepEqual(error.deviceIds, ['station-5'])
    assert.match(error.message, /测试工位 6/)
    assert.match(error.message, /进料口仍叠加本设备方向微调 180°/)
    assert.equal(error.alignmentDiagnostics.devices[0].portSource, 'instance')
    assert.equal(error.alignmentDiagnostics.devices[0].overrideYawDegrees, 180)
    for (const i of [0, 1, 2, 3, 4, 6, 7]) assert.doesNotMatch(error.message, new RegExp(`测试工位 ${i + 1}`))
    return true
  })
  assert.deepEqual({ layout: f.layout, devices: f.devices }, before)
  // Diagnostic counterfactual only: leaving the affected station out proves
  // the seven other stations fit. No partial plan is ever applied to a site.
  const seven = await f.plan(f.devices.filter(d => d.id !== 'station-5'))
  assert.equal(seven.rows.filter(r => r.laneId).length, 7)
  assert.doesNotThrow(() => assertLineTemplateClearance(seven.layout, seven.rows))
})

test('an explicitly reviewed direction-only correction preserves offsets and other station overrides, and restores all eight CAD stations', async () => {
  const f = fixture({ reversedInlet: true }), before = structuredClone(f.devices)
  const reviewed = structuredClone(f.devices)
  const inlet = reviewed.find(d => d.id === 'station-5').instance_config.loadingPortOverrides.inlet
  inlet.yawDegrees = 0
  const p = await f.plan(reviewed)
  assert.equal(p.rows.filter(r => r.laneId).length, 8)
  assert.doesNotThrow(() => assertLineTemplateClearance(p.layout, p.rows))
  assert.deepEqual(f.devices, before, 'Planning never automatically migrates saved direction overrides')
  const restored = structuredClone(reviewed)
  restored.find(d => d.id === 'station-5').instance_config.loadingPortOverrides.inlet.yawDegrees = 180
  assert.deepEqual(restored, before, 'The review changes only the selected inlet yaw, not geometry or another station')
  const measured = p.rows.find(r => r.id === 'station-5')
  assert.equal(measured.loadingPort.source, 'instance')
  assert.equal(measured.loadingPort.overrideYawDegrees, 0)
})

test('saved real regions are the actual CAD ports: an old staging offset/yaw cannot move or flip the mouth used by all eight stations', async () => {
  const f = fixture({ reversedInlet: true, modelRegions: true })
  f.devices.find(d => d.id === 'station-5').instance_config.loadingPortOverrides.inlet.offset = [.4, .3, -.2]
  const before = structuredClone({ layout: f.layout, devices: f.devices })
  const p = await f.plan()
  assert.equal(p.rows.filter(r => r.laneId).length, 8)
  assert.doesNotThrow(() => assertLineTemplateClearance(p.layout, p.rows))
  assert.deepEqual({ layout: f.layout, devices: f.devices }, before, 'Resolving the actual region never rewrites legacy data or applies the proposed layout')
  for (const row of p.rows) {
    assert.equal(row.loadingPort.source, 'model')
    assert.equal(row.loadingPort.calibration, 'region')
    assert.equal(row.loadingPort.overrideYawDegrees, 0)
    assert.ok(row.loadingPort.direction[2] * (row.railId ? -1 : 1) > .999)
  }
  assert.equal(p.rows.find(r => r.railId).transferStroke, 2.17)
})
