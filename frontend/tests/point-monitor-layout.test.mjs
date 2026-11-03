import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

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
