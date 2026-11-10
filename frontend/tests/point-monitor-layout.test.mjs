import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import { formatPointDateTime } from '../src/views/admin/utils/points.js'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
test('monitor summary cards share a top row with the existing left-side filters', () => {
  const start = panel.indexOf('<div class="point-monitor-controls">')
  assert.ok(start >= 0)
  const controls = panel.slice(start, panel.indexOf('<div v-if="realtimePointError"', start))
  const compiled = compileTemplate({ source: controls, filename: 'AdminPanel.vue', id: 'monitor-controls' })
  assert.deepEqual(compiled.errors, [])
  const row = compiled.ast.children.find(node => node.tag === 'div')
  const children = row.children.filter(node => node.tag === 'div')
  const classes = children.map(node => node.props.find(prop => prop.name === 'class')?.value?.content)
  assert.deepEqual(classes, ['form-row point-monitor-toolbar', 'point-monitor-status'])
})

test('monitor summaries align right in two cards and wrap safely on narrow panels', () => {
  const { descriptor } = parse(panel)
  const styles = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), id: 'monitor-layout' })
  assert.deepEqual(styles.errors, [])
  function declarations(selector) {
    const result = {}
    styles.rawResult.root.walkRules(rule => {
      if (rule.selector === selector) rule.walkDecls(decl => { result[decl.prop] = decl.value })
    })
    return result
  }
  const controls = declarations('.point-monitor-controls')
  assert.equal(controls.display, 'flex')
  assert.equal(controls['flex-wrap'], 'wrap')
  const status = declarations('.point-monitor-status')
  assert.equal(status['margin-left'], 'auto')
  assert.equal(status['grid-template-columns'], 'repeat(2, minmax(0, 1fr))')
  assert.equal(status['max-width'], '100%')
  assert.equal(status['margin-bottom'], '0')
  assert.equal(declarations('.point-monitor-toolbar')['flex-wrap'], 'wrap')
  assert.equal(declarations('.point-monitor-toolbar')['margin-bottom'], '0')
  assert.equal(declarations('.point-monitor-toolbar select')['max-width'], '100%')
  assert.notEqual(status.position, 'absolute')
})

test('refresh actions sit at the right of a shorter search/filter row, not below the device selectors', () => {
  const start = panel.indexOf('<div class="point-monitor-controls">')
  const controls = panel.slice(start, panel.indexOf('<div class="point-monitor-search-filters">', start))
  assert.doesNotMatch(controls, /@click="loadRealtimePointValues"|v-model="pointMonitorAutoRefresh"/)
  const searchStart = panel.indexOf('<div class="point-monitor-search-filters">', start)
  const searchRow = panel.slice(searchStart, panel.indexOf('<div class="point-monitor-result-summary"', searchStart))
  const compiled = compileTemplate({ source: searchRow, filename: 'AdminPanel.vue', id: 'monitor-actions' })
  assert.deepEqual(compiled.errors, [])
  const row = compiled.ast.children.find(node => node.tag === 'div')
  const actions = row.children.filter(node => node.tag).at(-1)
  assert.equal(actions.props.find(prop => prop.name === 'class').value.content, 'point-monitor-actions')
  assert.match(searchRow, /@click="loadRealtimePointValues"/)
  assert.match(searchRow, /v-model="pointMonitorAutoRefresh"/)
  assert.match(searchRow, /@click="resetPointMonitorFilters"/)
  const { descriptor } = parse(panel)
  const styles = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), id: 'monitor-action-layout' })
  const values = selector => {
    const result = {}
    styles.rawResult.root.walkRules(rule => {
      if (rule.selector === selector) rule.walkDecls(decl => { result[decl.prop] = decl.value })
    })
    return result
  }
  assert.equal(values('.point-monitor-search-filters > .point-monitor-search')['max-width'], '400px')
  assert.equal(values('.point-monitor-actions')['margin-left'], 'auto')
  assert.equal(values('.point-monitor-actions')['flex-wrap'], 'wrap')
  assert.equal(values('.point-monitor-actions .inline-toggle')['flex-direction'], 'row')
})

test('point monitoring keeps only scope and latest snapshot summary cards', () => {
  const start = panel.indexOf('<div class="point-monitor-status">')
  const status = panel.slice(start, panel.indexOf('<div v-if="realtimePointError"', start))
  assert.deepEqual([...status.matchAll(/class="status-label">([^<]+)</g)].map(match => match[1]), ['监视范围', '最近数据快照'])
  assert.match(status, /pointMonitorStatusSummary/)
  assert.match(status, /realtimePointSnapshotAt/)
  assert.match(panel, /@click="loadRealtimePointValues"/)
  assert.match(panel, /v-model="pointMonitorAutoRefresh"/)
})
test('monitor exposes cascading hierarchy, point category, quality and search filters', () => {
  const start = panel.indexOf('<div v-if="isPointMonitorWorkspace"')
  const monitor = panel.slice(start, panel.indexOf('</DataCenterWorkspace>', start))
  for (const label of ['监视车间', '监视产线', '监视设备', '搜索实时点位', '监视点位分类', '监视数据质量']) {
    assert.ok(monitor.includes(`aria-label="${label}"`), label)
  }
  assert.match(monitor, /v-for="d in pointMonitorDevices"/)
  assert.match(monitor, /@click="resetPointMonitorFilters"/)
  assert.match(monitor, /!filteredRealtimePointRows.length/)
  assert.match(monitor, /filteredRealtimePointRows.length > 0/)
  assert.deepEqual(compileTemplate({ source: monitor, filename: 'AdminPanel.vue', id: 'monitor-filters' }).errors, [])
})
test('point monitoring uses the shorter description heading', () => {
  const header = panel.match(/<table class="data-table realtime-points-table">([\s\S]*?)<\/thead>/)[1]
  assert.match(header, /<th>说明<\/th>/)
  assert.doesNotMatch(header, /报警说明/)
})

test('recent read column displays a complete date and 24-hour time without wrapping', () => {
  const table = panel.match(/<table class="data-table realtime-points-table">[\s\S]*?<\/table>/)[0]
  assert.match(table, /<td class="point-monitor-read-time">\{\{ formatPointDateTime\(point.lastReadAt\) \}\}<\/td>/)
  assert.match(panel, /\.realtime-points-table \.point-monitor-read-time \{ white-space: nowrap;/)
  assert.match(panel, /formatPointTime\(realtimePointSnapshotAt\)/, 'snapshot summary keeps its existing format')
  assert.equal(formatPointDateTime(new Date(2026, 10, 9, 11, 28, 28).getTime()), '2026-11-09 11:28:28')
  assert.equal(formatPointDateTime(String(new Date(2026, 0, 2, 0, 3, 4).getTime())), '2026-01-02 00:03:04')
  assert.equal(formatPointDateTime(new Date(2026, 11, 31, 23, 59, 59).getTime()), '2026-12-31 23:59:59')
  for (const value of [undefined, null, '', 'invalid', NaN, Infinity, -1, 0, 9e15]) {
    assert.equal(formatPointDateTime(value), '-', String(value))
  }
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
