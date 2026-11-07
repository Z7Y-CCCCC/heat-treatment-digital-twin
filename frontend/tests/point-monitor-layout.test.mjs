import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileTemplate } from 'vue/compiler-sfc'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
test('point monitoring keeps only scope and latest snapshot summary cards', () => {
  const start = panel.indexOf('<div class="point-monitor-status">')
  const status = panel.slice(start, panel.indexOf('<div v-if="realtimePointError"', start))
  assert.deepEqual([...status.matchAll(/class="status-label">([^<]+)</g)].map(match => match[1]), ['监视范围', '最近数据快照'])
  assert.match(status, /pointMonitorStatusSummary/)
  assert.match(status, /realtimePointSnapshotAt/)
  assert.match(panel, /@click="loadRealtimePointValues"/)
  assert.match(panel, /v-model="pointMonitorAutoRefresh"/)
})
test('point monitoring uses the shorter description heading', () => {
  const header = panel.match(/<table class="data-table realtime-points-table">([\s\S]*?)<\/thead>/)[1]
  assert.match(header, /<th>说明<\/th>/)
  assert.doesNotMatch(header, /报警说明/)
})

test('monitor device cell displays only the short name and puts hierarchy in its native hover title', () => {
  const table = panel.match(/<table class="data-table realtime-points-table">[\s\S]*?<\/table>/)[0]
  const cell = table.match(/<td class="point-monitor-device-name"[^>]*>([\s\S]*?)<\/td>/)[0]
  assert.match(cell, /:title="deviceHierarchyLabel\(pointMonitorDevice\(point\)\)"/)
  assert.match(cell, /\{\{ pointMonitorDeviceName\(point\) \}\}/)
  assert.doesNotMatch(cell.slice(cell.indexOf('>') + 1), /deviceHierarchyLabel/)
  assert.match(panel, /\.realtime-points-table \.point-monitor-device-name \{ white-space: nowrap; \}/)
  assert.deepEqual(compileTemplate({ source: table, filename: 'AdminPanel.vue', id: 'monitor-name' }).errors, [])
})

test('short monitor names resolve mixed ID types, current names and safe runtime-name/ID fallbacks', () => {
  const devices = { value: [{ id: 7, name: '3# 多用炉', line_id: 'line_a' }] }
  const resolver = panel.match(/function pointMonitorDevice\(point = \{\}\) \{[\s\S]*?\n\}/)[0]
  const nameSource = panel.match(/function pointMonitorDeviceName\(point\) \{[\s\S]*?\n\}/)[0]
  const resolve = new Function('devices', `return (${resolver})`)(devices)
  const name = new Function('pointMonitorDevice', `return (${nameSource})`)(resolve)
  assert.equal(name({ device_id: '7', device_name: '旧名称' }), '3# 多用炉')
  assert.equal(resolve({ device_id: '7' }).line_id, 'line_a')
  devices.value[0].name = '4# 多用炉'
  assert.equal(name({ device_id: 7 }), '4# 多用炉')
  assert.equal(name({ device_id: 'missing', device_name: '运行帧设备名称' }), '运行帧设备名称')
  assert.equal(name({ device_id: 'missing' }), 'missing')
  assert.equal(name({}), '未知设备')
})
