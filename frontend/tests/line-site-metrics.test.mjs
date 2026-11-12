import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { siteSceneUnitsPerMeter, siteWorldQuaternion, siteWorldVector, siteWorldPoint, siteParentPoint, applySitePayloadMetrics, solveSiteTransferPose } from '../src/three/siteTransferAlignment.js'

const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
const approximately = (actual, expected) => actual.toArray().forEach((value, index) => approx(value, expected.toArray()[index]))
const pose = (units = 1) => ({
  start: new T.Vector3(-10, 0, 4).multiplyScalar(units), end: new T.Vector3(10, 0, 4).multiplyScalar(units), cartPortOffset: new T.Vector3(0, 1, 0).multiplyScalar(units),
  feedDirection: new T.Vector3(0, 0, -1), stationPosition: new T.Vector3(3, 1, 3.4).multiplyScalar(units), stationDirection: new T.Vector3(0, 0, 1),
  fixedPosition: new T.Vector3(3, 0, 4).multiplyScalar(units), stroke: 1.085 * units, sceneUnitsPerMeter: units, heightToleranceMeters: .05, lateralToleranceMeters: .05
})

test('source scene-units canonical/legacy alias parsing preserves precedence and rejects invalid configured values without default substitution', () => {
  for (const value of [.8, 1.25, 2, '1.25']) {
    approx(siteSceneUnitsPerMeter({ instance_config: { movement: { sceneUnitsPerMeter: value, scene_units_per_meter: 3 } } }), Number(value))
    approx(siteSceneUnitsPerMeter({ instance_config: JSON.stringify({ movement: JSON.stringify({ scene_units_per_meter: value }) }) }), Number(value))
  }
  assert.throws(() => siteSceneUnitsPerMeter({ instance_config: { movement: { sceneUnitsPerMeter: null, scene_units_per_meter: .8 } } }), /米制比例无效/)
  assert.equal(siteSceneUnitsPerMeter({}), 1)
  for (const value of [null, 0, -1, Infinity, NaN, '', ' ', true, false, {}, 'invalid']) {
    assert.throws(() => siteSceneUnitsPerMeter({ name: '来源设备', instance_config: { movement: { sceneUnitsPerMeter: value, scene_units_per_meter: 2 } } }), /来源设备.*米制比例无效/)
    assert.throws(() => siteSceneUnitsPerMeter({ instance_config: { movement: { scene_units_per_meter: value } } }), /米制比例无效/)
  }
})

test('site source inherits the explicitly associated line and rejects conflicts without upgrading old independently calibrated layouts', () => {
  const lines = [{ id: 'L', layout: { sceneUnitsPerMeter: .8 } }]
  const fixed = { line_id: 'L', instance_config: {} }, before = JSON.stringify(fixed)
  approx(siteSceneUnitsPerMeter(fixed, lines), .8); assert.equal(JSON.stringify(fixed), before)
  approx(siteSceneUnitsPerMeter({ instance_config: { railLineId: 'L' } }, lines), .8)
  approx(siteSceneUnitsPerMeter({ instance_config: { laneLineId: 'L' } }, lines), .8)
  approx(siteSceneUnitsPerMeter({ line_id: 'L', instance_config: { movement: { scene_units_per_meter: '.8' } } }, lines), .8)
  assert.throws(() => siteSceneUnitsPerMeter({ line_id: 'L', instance_config: { movement: { sceneUnitsPerMeter: 1 } } }, lines), /不一致/)
  lines[0].layout.sceneUnitsPerMeter = 1.25; approx(siteSceneUnitsPerMeter(fixed, lines), 1.25)
  lines[0].layout.sceneUnitsPerMeter = 0; assert.throws(() => siteSceneUnitsPerMeter(fixed, lines), /米制比例无效/)
  delete lines[0].layout.sceneUnitsPerMeter
  approx(siteSceneUnitsPerMeter({ line_id: 'L', instance_config: { movement: { sceneUnitsPerMeter: .8 } } }, lines), .8)
  assert.equal(siteSceneUnitsPerMeter(fixed, lines), 1)
})

test('metre height/lateral boundaries and numerical margin scale to source world units at .8, 1.25 and 2; metre-labelled reach errors convert back', () => {
  for (const units of [.8, 1.25, 2]) {
    const input = pose(units), accepted = { ...input, stationPosition: input.stationPosition.clone().add(new T.Vector3(.05 * units, .05 * units, 0)) }
    const result = solveSiteTransferPose(accepted)
    approximately(result.position, input.fixedPosition); approx(result.extensionMeters, .6); approx(result.strokeMeters, 1.085)
    assert.throws(() => solveSiteTransferPose({ ...accepted, stationPosition: accepted.stationPosition.clone().add(new T.Vector3(.000002 * units, 0, 0)) }), /横向错位/)
    assert.throws(() => solveSiteTransferPose({ ...accepted, stationPosition: accepted.stationPosition.clone().add(new T.Vector3(0, .000002 * units, 0)) }), /送料高度/)
    assert.doesNotThrow(() => solveSiteTransferPose({ ...accepted, stationPosition: accepted.stationPosition.clone().add(new T.Vector3(.0000005 * units, .0000005 * units, 0)) }))
    assert.throws(() => solveSiteTransferPose({ ...input, stationPosition: new T.Vector3(3, 1, 4 - 1.25).multiplyScalar(units), stroke: .92 * units }), /距离 1\.25 米超出推链行程 0\.92 米.*自动排布并演示/)
  }
  for (const field of ['feedDirection', 'stationDirection']) assert.throws(() => solveSiteTransferPose({ ...pose(), [field]: new T.Vector3() }), /朝向无效/)
  for (const units of [0, -1, NaN, Infinity]) assert.throws(() => solveSiteTransferPose({ ...pose(), sceneUnitsPerMeter: units }), /米制比例无效/)
})

test('world/parent point and signed vector helpers preserve nested rotations, nonuniform scale, translations and reflection without decomposing matrices', () => {
  const parent = new T.Group(), nested = new T.Group(); parent.position.set(7, 3, -9); parent.rotation.y = .3; parent.scale.set(-2, 3, 4)
  nested.position.set(-2, 1, 5); nested.rotation.y = -.2; nested.scale.set(1, 2, 3); parent.add(nested)
  const local = new T.Vector3(-1, 2, 3); nested.updateWorldMatrix(true, false)
  approximately(siteWorldPoint(local, nested), nested.localToWorld(local.clone()))
  approximately(siteParentPoint(siteWorldPoint(local, nested), nested), local)
  const displacement = siteWorldPoint(local, nested).sub(siteWorldPoint(new T.Vector3(), nested))
  approximately(siteWorldVector(local, nested), displacement)
  const expected = parent.quaternion.clone().multiply(nested.quaternion); approx(Math.abs(siteWorldQuaternion(nested).dot(expected)), 1)
  parent.scale.y = 0
  for (const convert of [siteWorldVector, siteWorldPoint, siteParentPoint]) assert.throws(() => convert(local, nested), /退化/)
  parent.scale.y = 3; parent.position.x = NaN
  assert.throws(() => siteWorldPoint(local, nested), /退化/)
  parent.position.x = 7; nested.quaternion.set(0, 0, 0, 0)
  assert.throws(() => siteWorldQuaternion(nested), /旋转无效/)
})

test('unit payload metric compensation matches world axes/half-height under actual parent scale and X mirrors, independently of source scale', () => {
  for (const units of [.8, 1.25, 2]) for (const mirror of [1, -1]) {
    const parent = new T.Group(), payload = new T.Group(), source = new T.Group()
    parent.scale.set(mirror * 2, 3, 4); parent.position.set(8, 4, -7); parent.add(payload)
    source.rotation.y = -Math.PI / 2; source.scale.set(9, 7, 11)
    const size = [.8, .4, .6], result = applySitePayloadMetrics(payload, source, size, units)
    const worldAxes = [new T.Vector3(1, 0, 0), new T.Vector3(0, 1, 0), new T.Vector3(0, 0, 1)].map(axis => siteWorldVector(axis, payload))
    worldAxes.forEach((axis, index) => approx(axis.length(), size[index] * units)); approx(result.worldHeight, .4 * units)
    approximately(worldAxes[1].normalize(), new T.Vector3(0, 1, 0)); approximately(result.worldDimensions, new T.Vector3(...size).multiplyScalar(units))
    const port = new T.Vector3(1, 6, 2), center = port.clone().add(new T.Vector3(0, result.worldHeight / 2, 0))
    payload.position.copy(siteParentPoint(center, payload.parent)); approximately(siteWorldPoint(new T.Vector3(), payload), center)
    approx(siteWorldPoint(new T.Vector3(0, -.5, 0), payload).y, port.y)
  }
})

test('metric payload policy rejects shear, Y inversion, degenerate or tilted support and invalid sizes/units; restoration recovers current metrics', () => {
  const parent = new T.Group(), payload = new T.Group(), source = new T.Group(); parent.add(payload); source.rotation.y = -Math.PI / 2
  const apply = () => applySitePayloadMetrics(payload, source, [.8, .4, .6], 1.25)
  const cases = [
    () => { parent.scale.set(2, 3, 4); parent.rotation.y = Math.PI / 4 },
    () => parent.scale.set(2, -3, 4),
    () => parent.scale.set(0, 3, 4),
    () => { source.rotation.x = .2 },
    () => { parent.position.x = NaN }
  ]
  for (const configure of cases) {
    parent.position.set(0, 0, 0); parent.rotation.set(0, 0, 0); parent.scale.set(1, 1, 1); source.rotation.set(0, -Math.PI / 2, 0)
    assert.doesNotThrow(apply); configure(); assert.throws(apply)
    parent.position.set(0, 0, 0); parent.rotation.set(0, 0, 0); parent.scale.set(2, 3, 4); source.rotation.set(0, -Math.PI / 2, 0)
    approx(apply().worldHeight, .5)
  }
  for (const size of [[.8, 0, .6], [.8, NaN, .6], [.8, .4], ['.8', .4, .6]]) assert.throws(() => applySitePayloadMetrics(payload, source, size, 1.25), /尺寸无效/)
  for (const units of [0, -1, NaN, Infinity]) assert.throws(() => applySitePayloadMetrics(payload, source, [.8, .4, .6], units), /尺寸无效/)
})

test('source-only Y inversion, tilted/zero support cannot be disguised by a healthy independent payload parent; source X reflection, scale and yaw remain valid', () => {
  const parent = new T.Group(), payload = new T.Group(), source = new T.Group(); parent.add(payload)
  const apply = () => applySitePayloadMetrics(payload, source, [.8, .4, .6], 1.25)
  for (const x of [9, -9]) {
    source.scale.set(x, 7, 11); source.rotation.set(0, -Math.PI / 2, 0)
    assert.doesNotThrow(apply); approx(apply().worldHeight, .5)
  }
  source.scale.set(9, -7, 11)
  assert.throws(apply, /来源承料面.*倒置/)
  source.scale.set(9, 0, 11)
  assert.throws(apply, /退化/)
  source.scale.set(9, 7, 11); source.rotation.x = .2
  assert.throws(apply, /来源承料面.*倾斜/)
  source.rotation.x = 0
  assert.doesNotThrow(apply); approx(apply().worldHeight, .5)
  assert.deepEqual(parent.scale.toArray(), [1, 1, 1], 'Only source support changed; independent payload parent stayed healthy')
})
