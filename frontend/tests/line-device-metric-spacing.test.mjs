import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spaceLineDevices } from '../src/views/admin/utils/lineDeviceSelection.js'
import { lineSceneUnitsPerMeter } from '../../shared/lineRailSpacing.mjs'

const binding = { type: 'lane', item: { id: 'lane', offsetZ: 0, length: 60 } }
const rows = [-10, -3, 12].map((x, i) => ({ id: `d${i}`, x, binding }))
test('manual centre metres convert once; automatic equal spacing retains both scene-coordinate endpoints', () => {
  for (const units of [.8, 1.25, 2]) {
    const next = spaceLineDevices(rows, .6, units)
    assert.deepEqual(next.map(row => row.x), [-10, Number((-10 + .6 * units).toFixed(6)), Number((-10 + 1.2 * units).toFixed(6))])
    assert.deepEqual(spaceLineDevices(rows, undefined, units).map(row => row.x), [-10, 1, 12])
  }
  for (const units of [null, '', true, 0, -1, NaN, Infinity, 100001]) assert.throws(() => spaceLineDevices(rows, .6, units), /场景单位/)
  assert.equal(rows[1].x, -3)
  const small = spaceLineDevices(rows.map(row => ({ ...row, x: 0 })), .001, .0001)
  assert.deepEqual(small.map(row => row.x), [0, 1e-7, 2e-7])
  assert.throws(() => spaceLineDevices(rows.map(row => ({ ...row, x: 10000, binding: { ...binding, item: { ...binding.item, length: 100000 } } })), .001, 1e-12), /坐标精度/)
})

test('original admin centre-spacing handler uses the current configured line calibration before the existing batch-save chain', async () => {
  const source = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  const start = source.indexOf('async function applyLineDeviceSpacing('), end = source.indexOf('\nasync function openLineLoadingAlignment(', start)
  assert.ok(start > 0 && end > start)
  const create = new Function('scope', `with(scope) { return (${source.slice(start, end).trim()}) }`)
  for (const units of [.8, 1.25, 2]) {
    const line = { id: 'L', layout: { sceneUnitsPerMeter: units } }, saves = [], errors = []
    const run = create({ canAdminPage: () => true, lineDeviceLayoutBusy: { value: false }, cancelLineDeviceDrag: () => {},
      selectedLineDevices: { value: rows.map(row => ({ id: row.id, pos_x: row.x, pos_z: 5 })) }, selectedLineEditor: { value: line },
      numberOrDefault: (value, fallback) => value ?? fallback, getLineBaseZ: () => 5, resolveDeviceLayoutTarget: () => binding,
      spaceLineDevices, lineSceneUnitsPerMeter, getLineLayout: item => item.layout, lineDeviceGap: { value: .6 },
      saveLineDevicePlan: async (plan, id) => saves.push({ plan, id }), alert: error => errors.push(error) })
    await run(true)
    assert.deepEqual(errors, []); assert.equal(saves.length, 1); assert.equal(saves[0].id, 'L')
    assert.deepEqual(saves[0].plan.map(row => row.x), spaceLineDevices(rows, .6, units).map(row => row.x))
    assert.deepEqual(saves[0].plan.map(row => row.z), [0, 0, 0])
    await run(false); assert.deepEqual(saves[1].plan.map(row => row.x), [-10, 1, 12])
  }
})
