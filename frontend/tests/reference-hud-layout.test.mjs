import test from 'node:test'
import assert from 'node:assert/strict'
import { applyReferenceHudLayout } from '../src/runtime/referenceHudLayout.js'

function fixture() {
  const ids = ['overview_metrics','running_devices','alarm_history','gas_metrics','temperature_trend','line_monitor']
  return { canvas: { width: 1920, height: 1080 }, metadata: {}, scene: { views: [] }, widgets: ids.map((id, i) => ({
    id, type: 'container', frame: { x: i * 200, y: 100, width: 180, height: 300 },
    visibility: { viewIds: ['factory_overview'] }, style: {}, events: []
  })) }
}
test('reference presentation is idempotent and does not mutate stored configuration', () => {
  const input = fixture()
  const before = JSON.stringify(input)
  const result = applyReferenceHudLayout(input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(result.widgets.find(w => w.id === 'overview_metrics').frame.x, 1536)
  assert.equal(result.widgets.find(w => w.id === 'temperature_trend').frame.y, 822)
  assert.equal(result.widgets.filter(w => w.id === 'reference_oee_ring').length, 1)
  assert.equal(applyReferenceHudLayout(result), result)
})
test('custom dashboards and device inspection geometry remain unchanged', () => {
  const custom = { canvas: { width: 1920, height: 1080 }, widgets: [{ id: 'custom' }] }
  assert.equal(applyReferenceHudLayout(custom), custom)
  const input = fixture()
  const device = { id: 'device-temp', frame: { x: 10, y: 110, width: 80, height: 50 }, visibility: { viewIds: ['device_detail'] }, data: { pointId: 'actual-temp' }, events: [{ action: 'inspect' }] }
  input.widgets.push(device)
  assert.deepEqual(applyReferenceHudLayout(input).widgets.find(w => w.id === device.id), device)
})
