import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  lineSceneUnitsPerMeter, movementSceneUnitsPerMeter, assertLineMovementUnits,
  resolveLineRailSpacing, editLineRailSpacing, lineRailSpacingDeltas, shiftRailMovement
} from '../../shared/lineRailSpacing.mjs'
import { normalizeLineLayout as frontendLayout } from '../src/views/admin/utils/lineLayout.js'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { normalizeLineLayout: backendLayout } = require('./utils/spatialLayout.js')
const clone = value => JSON.parse(JSON.stringify(value))
const layout = (units = .0001, origin = 0, distance = .001, side = 'positive') => ({
  version: 2, coordinateSpace: 'workshop_local', transform: { x: 0, y: 0, z: 0, rotationY: 0 },
  sceneUnitsPerMeter: units,
  lanes: [{ id: 'lane', name: '设备线', offsetZ: origin, length: 60 }],
  rails: [{ id: 'rail', name: '小车导轨', offsetZ: 0, length: 60,
    spacing: { laneId: 'lane', distanceMeters: distance, side } }]
})
const carrier = z => ({ marker: 'preserve', animationBindings: { bindings: [{ pointId: 'PLC_FEED' }] },
  movement: { enabled: true, valueMode: 'station', currentPositionPointId: 'PLC_POSITION', smoothingMs: 100,
    start: { x: 0, y: 0, z }, end: { x: 10, y: 0, z },
    stations: [{ value: 1, label: '现场工位', anchorDeviceId: 'furnace', position: { x: 5, y: 0, z } }] }
})
const precisionError = error => error.code === 'LINE_RAIL_SPACING_INVALID' && /精度不足/.test(error.message)

test('sub-micro scene spacing and rigid movement shifts keep significant digits through both actual normalizers and repeated reopen', () => {
  const source = carrier(0), sourceBefore = JSON.stringify(source)
  const before = { ...layout(), rails: [{ id: 'rail', name: '小车导轨', offsetZ: 0, length: 60 }] }
  for (const [distance, side, expected] of [[.001, 'positive', 1e-7], [.002, 'negative', -2e-7]]) {
    const authored = layout(.0001, 0, distance, side), resolved = resolveLineRailSpacing(authored)
    assert.equal(resolved.rails[0].offsetZ, expected)
    assert.equal(resolved.rails[0].spacing.distanceMeters, distance)
    assert.deepEqual(lineRailSpacingDeltas(before, resolved), [{ railId: 'rail', deltaZ: expected }])
    const shifted = shiftRailMovement(source, expected)
    for (const point of [shifted.movement.start, shifted.movement.end, shifted.movement.stations[0].position]) assert.equal(point.z, expected)
    assert.equal(Object.hasOwn(shifted.movement, 'sceneUnitsPerMeter'), false)
    assert.equal(Object.hasOwn(shifted.movement, 'scene_units_per_meter'), false)
    assert.equal(shifted.movement.currentPositionPointId, 'PLC_POSITION')
    assert.deepEqual(shifted.animationBindings, source.animationBindings)
    assert.deepEqual(shiftRailMovement(shifted, -expected), source)
    const front = frontendLayout(authored), back = backendLayout(authored)
    assert.deepEqual(front, back)
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(frontendLayout(JSON.stringify(front)), front)
      assert.deepEqual(backendLayout(JSON.stringify(back)), back)
    }
  }
  assert.equal(JSON.stringify(source), sourceBefore)
})

test('ordinary .8/1.25/2 metre calculations and missing legacy calibration retain their original authored values', () => {
  for (const units of [.8, 1.25, 2]) {
    const resolved = resolveLineRailSpacing(layout(units, 0, .6))
    assert.equal(resolved.rails[0].offsetZ, .6 * units)
    const previous = { rails: [{ id: 'rail', offsetZ: .6 }] }
    assert.equal(lineRailSpacingDeltas(previous, resolved)[0]?.deltaZ ?? 0, Number((.6 * units - .6).toPrecision(15)))
  }
  const old = { ...layout(), rails: [{ id: 'rail', offsetZ: .6, length: 60 }] }; delete old.sceneUnitsPerMeter
  for (const normalize of [frontendLayout, backendLayout]) {
    const reopened = normalize(old)
    assert.equal(Object.hasOwn(reopened, 'sceneUnitsPerMeter'), false)
    assert.equal(Object.hasOwn(reopened.rails[0], 'spacing'), false)
    assert.equal(reopened.rails[0].offsetZ, .6)
  }
})

test('positive distances that disappear in origin addition or significant-digit rounding are rejected instead of becoming overlap', () => {
  const rawLost = layout(1e-20, 1000, .001)
  assert.equal(1000 + .001 * 1e-20, 1000)
  const roundingLost = layout(1e-9, 1000, .0001)
  assert.notEqual(1000 + .0001 * 1e-9, 1000)
  assert.equal(Number((1000 + .0001 * 1e-9).toPrecision(15)), 1000)
  for (const source of [rawLost, roundingLost]) for (const normalize of [resolveLineRailSpacing, frontendLayout, backendLayout]) {
    const original = JSON.stringify(source)
    assert.throws(() => normalize(source), precisionError)
    assert.equal(JSON.stringify(source), original)
  }
})

test('nonzero carrier translation never loses its displacement in start/end/stations, including rounding direction reversal', () => {
  const sources = [carrier(100000), carrier(1000.0000000000004), carrier(0)]
  sources[2].movement.stations[0].position.z = 100000
  for (const source of sources) {
    const before = JSON.stringify(source)
    assert.throws(() => shiftRailMovement(source, 1e-13), precisionError)
    assert.equal(JSON.stringify(source), before)
  }
  assert.throws(() => shiftRailMovement(carrier(100000), -1e-13), precisionError)
})

test('legacy movement units accept only ECMA-trimmed decimal/exponent numeric strings and validate both saved aliases independently', () => {
  const accepted = [['.8', .8], ['+1.25', 1.25], ['1.', 1], ['1e-4', .0001], ['\u00a0\ufeff\u20281.25\u2029\u2009', 1.25], ['1e-45', 1e-45]]
  const rejected = ['0x1', '0X1', '0b1', '0B1', '0o1', '0O1', '1_000', '1,25', '1e', '.', '+', 'NaN', 'Infinity', '1\u00a025', '\u00851', '\u180e1', '\u200b1', '\0' + '1', '1e-320', '5e-324', '1e-46']
  for (const key of ['sceneUnitsPerMeter', 'scene_units_per_meter']) {
    for (const [value, expected] of accepted) {
      assert.equal(movementSceneUnitsPerMeter({ [key]: value }), expected)
      assert.equal(movementSceneUnitsPerMeter(JSON.stringify({ [key]: value })), expected)
      assert.equal(assertLineMovementUnits({ [key]: value }, { sceneUnitsPerMeter: expected }), expected)
    }
    for (const value of rejected) {
      const other = key === 'sceneUnitsPerMeter' ? 'scene_units_per_meter' : 'sceneUnitsPerMeter'
      assert.throws(() => movementSceneUnitsPerMeter({ [key]: value, [other]: 1 }), /现有移动设置中校准/)
    }
  }
  assert.equal(movementSceneUnitsPerMeter({ sceneUnitsPerMeter: '.8', scene_units_per_meter: '1.25' }), .8)
})

test('line numeric and movement numeric calibration share positive finite float representation without imposing an arbitrary minimum metre value', () => {
  for (const units of [Number.MIN_VALUE, 1e-320, 1e-50, 1e-46]) {
    assert.equal(Math.fround(units), 0)
    assert.throws(() => lineSceneUnitsPerMeter({ sceneUnitsPerMeter: units }), /场景单位/)
    assert.throws(() => movementSceneUnitsPerMeter({ sceneUnitsPerMeter: units }), /场景单位/)
  }
  for (const units of [1e-45, 1e-20, .0001, .8, 1.25, 2, 100000]) {
    assert.ok(Number.isFinite(Math.fround(units)) && Math.fround(units) > 0)
    assert.equal(lineSceneUnitsPerMeter({ sceneUnitsPerMeter: units }), units)
    assert.equal(movementSceneUnitsPerMeter({ sceneUnitsPerMeter: units }), units)
  }
  assert.throws(() => lineSceneUnitsPerMeter({ sceneUnitsPerMeter: '1.25' }), /场景单位/)
  const source = { enabled: true }, before = JSON.stringify(source)
  assert.equal(assertLineMovementUnits(source, { sceneUnitsPerMeter: .0001 }), .0001)
  assert.equal(JSON.stringify(source), before)
})

test('existing unit field edit accepts decimal/exponent input and rejects nondecimal or float-underflow strings without modifying its source', () => {
  const source = layout(.8, 0, .6), before = JSON.stringify(source)
  assert.equal(editLineRailSpacing(source, '', 'sceneUnitsPerMeter', '\ufeff1.25\u00a0').sceneUnitsPerMeter, 1.25)
  assert.equal(editLineRailSpacing(source, '', 'sceneUnitsPerMeter', '1e-4').rails[0].offsetZ, .00006)
  for (const value of ['0x1', '0b1', '0o1', '1e-50']) assert.throws(() => editLineRailSpacing(source, '', 'sceneUnitsPerMeter', value), /场景单位/)
  assert.equal(JSON.stringify(source), before)
})

test('a double-representable metre gap cannot claim successful configuration when declared Unity float32 origins and results coincide', () => {
  for (const [origin, side] of [[10, 'positive'], [10, 'negative'], [-10, 'positive'], [-10, 'negative']]) {
    const source = layout(.0001, origin, .001, side), before = JSON.stringify(source)
    const raw = origin + (side === 'positive' ? 1 : -1) * 1e-7
    assert.notEqual(raw, origin)
    assert.notEqual(Number(raw.toPrecision(15)), origin)
    assert.equal(Math.fround(raw), Math.fround(origin))
    for (const normalize of [resolveLineRailSpacing, frontendLayout, backendLayout]) assert.throws(() => normalize(source), precisionError)
    assert.equal(JSON.stringify(source), before)
  }
  assert.equal(resolveLineRailSpacing(layout(.0001, 0, .001)).rails[0].offsetZ, 1e-7)
  assert.notEqual(Math.fround(1e-7), Math.fround(0))
  assert.throws(() => resolveLineRailSpacing(layout(1e-45, 0, .001)), precisionError)
})

test('raw rail deltas require distinguishable finite float32 endpoints and displacement while retaining genuinely representable small origins', () => {
  const deltas = (before, after) => lineRailSpacingDeltas({ rails: [{ id: 'rail', offsetZ: before }] }, { rails: [{ id: 'rail', offsetZ: after }] })
  for (const [before, after] of [[10, 10 + 1e-7], [1, 1 + Number.EPSILON], [0, 1e-48], [1e40, 2e40]]) {
    assert.notEqual(before, after)
    assert.throws(() => deltas(before, after), precisionError)
  }
  assert.deepEqual(deltas(0, 1e-7), [{ railId: 'rail', deltaZ: 1e-7 }])
  assert.deepEqual(deltas(2e-8, 3e-8), [{ railId: 'rail', deltaZ: 1e-8 }])
  assert.equal(deltas(1, 1 + 3e-7).length, 1)
})

test('rigid path endpoints and station shifts reject float32-only collapse or overflow without editing any inherited settings', () => {
  const sources = [carrier(10), carrier(-10), carrier(0), carrier(1e40)]
  sources[2].movement.stations[0].position.z = 10
  for (const source of sources) {
    const before = JSON.stringify(source)
    assert.throws(() => shiftRailMovement(source, source.movement.start.z === -10 ? -1e-7 : 1e-7), precisionError)
    assert.equal(JSON.stringify(source), before)
  }
  assert.throws(() => shiftRailMovement(carrier(0), 1e-48), precisionError)
  assert.throws(() => shiftRailMovement(carrier(0), 1e40), precisionError)
  const accepted = shiftRailMovement(carrier(0), 1e-7)
  for (const point of [accepted.movement.start, accepted.movement.end, accepted.movement.stations[0].position]) assert.equal(point.z, 1e-7)
  assert.equal(Object.hasOwn(accepted.movement, 'sceneUnitsPerMeter'), false)
})
