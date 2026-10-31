import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseLineDevices, planLineGroupMove, spaceLineDevices } from '../src/views/admin/utils/lineDeviceSelection.js'

const lane = (id = 'lane1', offsetZ = 0, length = 60, type = 'lane') => ({ type, item: { id, offsetZ, length } })
const binding = lane()
const rows = [-10, -3, 12].map((x, i) => ({ id: `d${i}`, x, binding }))

test('plain selection preserves a group for dragging; additive selection toggles only its member', () => {
  assert.deepEqual(chooseLineDevices(['a', 'b'], 'a'), ['a', 'b'])
  assert.deepEqual(chooseLineDevices(['a', 'b'], 'c'), ['c'])
  assert.deepEqual(chooseLineDevices(['a', 'b'], 'c', true), ['a', 'b', 'c'])
  assert.deepEqual(chooseLineDevices(['a', 'b'], 'a', true), ['b'])
})
test('group translation preserves all gaps and clamps the whole group at either boundary', () => {
  assert.deepEqual(planLineGroupMove(rows, 'd1', 3, binding, [binding]).map(row => row.x), [-4, 3, 18])
  assert.deepEqual(planLineGroupMove(rows, 'd1', 100, binding, [binding]).map(row => row.x), [8, 15, 30])
  assert.deepEqual(planLineGroupMove(rows, 'd1', -100, binding, [binding]).map(row => row.x), [-30, -23, -8])
  assert.deepEqual(rows.map(row => row.x), [-10, -3, 12], 'planning must not mutate the draft')
})
test('moving groups across parallel lanes preserves their relative Z offsets and binding types', () => {
  const second = lane('lane2', 6), third = lane('lane3', 12), rail = lane('rail1', 4, 60, 'rail'), movedRail = lane('rail2', 10, 60, 'rail')
  const group = [{ id: 'a', x: 1, binding }, { id: 'b', x: 3, binding: second }, { id: 'cart', x: -2, binding: rail }]
  const moved = planLineGroupMove(group, 'a', 4, second, [binding, second, third, rail, movedRail])
  assert.deepEqual(moved.map(row => [row.x, row.z, row.binding.item.id]), [[4, 6, 'lane2'], [6, 12, 'lane3'], [1, 10, 'rail2']])
  assert.throws(() => planLineGroupMove(group, 'a', 4, second, [binding, second, third, rail]), /没有匹配/)
})
test('a group wider than a target lane is rejected instead of distorting distances', () => {
  const short = lane('short', 6, 10)
  assert.throws(() => planLineGroupMove(rows, 'd1', 0, short, [binding, short]), /超出/)
})
test('automatic spacing fixes both ends and orders reversed selections by center X', () => {
  const result = spaceLineDevices([...rows].reverse())
  assert.deepEqual(result.map(row => [row.id, row.x]), [['d0', -10], ['d1', 1], ['d2', 12]])
  assert.deepEqual(rows.map(row => row.x), [-10, -3, 12])
})
test('explicit center spacing supports two devices and anchors the leftmost member', () => {
  assert.deepEqual(spaceLineDevices([rows[2], rows[0]], 5.5).map(row => row.x), [-10, -4.5])
  assert.throws(() => spaceLineDevices(rows.slice(0, 2)), /三台/)
  for (const gap of [0, -1, NaN, Infinity, 'bad']) assert.throws(() => spaceLineDevices(rows, gap))
  assert.throws(() => spaceLineDevices(rows, 30), /超出/)
})
test('spacing across lanes, unbound members, empty selections and zero-span groups are rejected', () => {
  assert.throws(() => spaceLineDevices([]), /多选/)
  assert.throws(() => spaceLineDevices([{ ...rows[0], binding: null }, rows[1]], 2))
  assert.throws(() => spaceLineDevices([rows[0], { ...rows[1], binding: lane('other') }], 2), /同一/)
  assert.throws(() => spaceLineDevices(rows.map(row => ({ ...row, x: 0 }))), /大于零/)
})
