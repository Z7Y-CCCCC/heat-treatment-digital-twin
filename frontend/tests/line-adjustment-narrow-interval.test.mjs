import test from 'node:test'
import assert from 'node:assert/strict'
import { lineAdjustmentBand, clampLineAdjustment } from '../../shared/lineAdjustmentBand.mjs'
import { planLinePlacementTemplate, lineTemplateSpacingLimits } from '../../shared/linePlacementTemplate.mjs'

function fixture(kind, units = 1, maximumMeters = 1.28) {
  const sign = kind === 'single-positive' ? 1 : -1
  const layout = { sceneUnitsPerMeter: units, lanes: [{ id: 'a', offsetZ: sign * 5 * units, length: 12 * units }], rails: [{ id: 'r', offsetZ: 0, length: 12 * units }] }
  if (kind === 'dual') layout.lanes.push({ id: 'b', offsetZ: 5 * units, length: 12 * units })
  const box = depth => ({ minX: -.4 * units, maxX: .4 * units, minY: 0, maxY: units, minZ: -depth * units, maxZ: depth * units })
  const cartBody = box(.4), fixedBody = box(.701)
  const rows = [
    { id: 'cart', railId: 'r', x: 0, y: 0, z: 0, ...cartBody, collisionBoxes: [cartBody], transferReach: { stroke: (maximumMeters - .4) * units, positiveFaceZ: .4 * units, negativeFaceZ: -.4 * units } },
    ...layout.lanes.map((lane, i) => ({ id: 'fixed-' + lane.id, laneId: lane.id, x: (i ? 3 : -3) * units, y: 0, z: lane.offsetZ, ...fixedBody, collisionBoxes: [fixedBody], loadingFaceZ: 0 }))
  ]
  return { layout, rows }
}

test('a compact mouth-aligned narrow interval remains valid in later band checks on either side and at non-unit scale', () => {
  for (const units of [1, .8, 10]) for (const kind of ['single-negative', 'single-positive', 'dual']) {
    const f = fixture(kind, units), original = structuredClone(f)
    const plan = planLinePlacementTemplate(f.layout, kind, f.rows, .15, { measuredMinimum: true })
    const before = structuredClone(plan), band = lineAdjustmentBand(plan.layout, plan.rows)
    assert.deepEqual(f, original, 'Planning must not change its source')
    assert.deepEqual(plan, before, 'Checking the band must not migrate the saved layout or devices')
    assert.equal(band.currentInside, true)
    assert.ok(band.minDistanceMeters >= 1.251 - 1e-10)
    assert.ok(band.minDistanceMeters < 1.28)
    assert.ok(band.maxDistanceMeters <= 1.28 + 1e-12, 'The band must remain inside the original mechanical reach')
    assert.ok(Math.abs(band.minDistanceMeters - plan.layout.placementTemplate.minimumDistance / units) < 1e-10)
    for (const value of [-100, band.minZ, band.maxZ, 100]) {
      const result = clampLineAdjustment(value, band)
      assert.ok(result >= band.minZ && result <= band.maxZ)
    }
  }
})

test('a compact narrow interval can lock to its sole reachable coordinate without being declared imprecise', () => {
  for (const kind of ['single-negative', 'single-positive']) {
    const f = fixture(kind, 1, 1.251)
    const plan = planLinePlacementTemplate(f.layout, kind, f.rows, .15, { measuredMinimum: true })
    const band = lineAdjustmentBand(plan.layout, plan.rows)
    assert.equal(band.currentInside, true)
    assert.ok(Math.abs(band.minDistanceMeters - 1.251) < 1e-12)
    assert.equal(band.minZ, band.maxZ)
    assert.equal(clampLineAdjustment(-100, band), band.minZ)
    assert.equal(clampLineAdjustment(100, band), band.maxZ)
  }
})

test('narrow-band coordinate rounding never crosses an exact high-precision edge', () => {
  for (const band of [{ minZ: 1.251000123, maxZ: 1.251000321 }, { minZ: -1.251000321, maxZ: -1.251000123 }]) {
    for (const value of [-100, band.minZ, band.maxZ, 100]) {
      const result = clampLineAdjustment(value, band)
      assert.ok(result >= band.minZ && result <= band.maxZ)
    }
  }
})

test('a sub-micrometre feasible interval retains its exact safe boundary when rendered and clamped', () => {
  const f = fixture('single-positive', 1, 1.25100015)
  const fixed = f.rows.find(row => row.laneId)
  fixed.minZ = fixed.collisionBoxes[0].minZ = -.701000123
  fixed.maxZ = fixed.collisionBoxes[0].maxZ = .701000123
  const plan = planLinePlacementTemplate(f.layout, 'single-positive', f.rows, .15, { measuredMinimum: true })
  const before = structuredClone(plan), band = lineAdjustmentBand(plan.layout, plan.rows)
  assert.equal(band.currentInside, true)
  assert.ok(Math.abs(band.minDistanceMeters - 1.251000123) < 1e-12)
  assert.ok(band.maxDistanceMeters <= 1.25100015)
  assert.equal(band.minZ, band.maxZ, 'An interval below renderer precision is locked at the safe coordinate')
  for (const z of [-100, 100]) assert.equal(clampLineAdjustment(z, band), band.minZ)
  assert.deepEqual(plan, before)
})

test('a newly enlarged body that truly exceeds the original reach remains rejected without moving the saved layout', () => {
  const f = fixture('single-positive')
  const plan = planLinePlacementTemplate(f.layout, 'single-positive', f.rows, .15, { measuredMinimum: true })
  const rows = structuredClone(plan.rows)
  const fixed = rows.find(row => row.laneId)
  fixed.minZ -= .1
  fixed.collisionBoxes[0].minZ -= .1
  const before = structuredClone({ layout: plan.layout, rows })
  const lane = plan.layout.lanes[0], rail = plan.layout.rails[0]
  const limits = lineTemplateSpacingLimits(plan.layout, rows, [[lane, 1]], rail, .15, { measuredMinimum: true })
  assert.ok(limits.minimum > limits.maximum)
  assert.throws(() => lineAdjustmentBand(plan.layout, rows), /距离不合适/)
  assert.deepEqual({ layout: plan.layout, rows }, before)
})
