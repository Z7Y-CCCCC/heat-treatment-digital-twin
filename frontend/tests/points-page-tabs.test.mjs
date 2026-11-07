import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const page = panel.slice(panel.indexOf('data-testid="points-workspace"'), panel.indexOf('<!-- ======== 点位实时监视 ======== -->'))

test('add point is a single top-toolbar action, not a footer action', () => {
  assert.equal((page.match(/@click="addDataPoint\('normal'\)"/g) || []).length, 1)
  const add = page.indexOf('data-testid="add-data-point"')
  assert.ok(add > page.indexOf('points-filter-toolbar') && add < page.indexOf('导入点表'))
  assert.ok(add < page.indexOf('class="point-table-scroll"'))
  assert.doesNotMatch(page.slice(page.indexOf('data-testid="points-savebar"')), /添加点位/)
  assert.match(page, /data-testid="add-data-point" :disabled="pointsLoading \|\| pointsSaving \|\| !devices\.length" v-permission=/)
})

test('mapping and alarms are peer tabpanels sharing the device filter and save action', () => {
  assert.match(panel, /<DataCenterWorkspace[^>]*:active-section="dataCenterSection"/)
  assert.match(page, /<section id="points-panel-mapping"[^>]*v-show="pointsSubpage === 'mapping'"/)
  assert.match(page, /<\/section>\s*<section id="points-panel-alarms"[^>]*v-show="pointsSubpage === 'alarms'"/)
  assert.equal((page.match(/aria-label="筛选点位设备"/g) || []).length, 1)
  assert.equal((page.match(/@click="savePointsPage"/g) || []).length, 1)
  assert.match(page, /<header class="alarm-config-header">/)
  assert.doesNotMatch(panel, /isAlarmConfigOpen/)
  assert.match(panel, /pointsSubpage: pointsSubpage\.value/)
})

test('tab keyboard navigation wraps, focuses and never reloads the point draft', async () => {
  const body = panel.match(/async function pointsTabKeydown\(event\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(body)
  const tabs = [{ key: 'mapping' }, { key: 'alarms' }], state = { value: 'mapping' }, focus = []
  const keydown = new Function('visiblePointsSubpages', 'pointsSubpage', 'selectPointsSubpage', 'nextTick', 'document', `return (${body})`)(
    { value: tabs }, state, key => { state.value = key }, async () => {}, { getElementById: id => ({ focus: () => focus.push(id) }) })
  let prevented = 0
  for (const [key, target] of [['ArrowRight', 'alarms'], ['ArrowRight', 'mapping'], ['ArrowLeft', 'alarms'], ['Home', 'mapping'], ['End', 'alarms']]) {
    await keydown({ key, preventDefault() { prevented++ } })
    assert.equal(state.value, target); assert.equal(focus.at(-1), `points-tab-${target}`)
  }
  await keydown({ key: 'Enter', preventDefault() { assert.fail('unrelated keys use native button behavior') } })
  assert.equal(prevented, 5)
  const select = panel.match(/function selectPointsSubpage\(key\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(select); assert.doesNotMatch(select, /loadDataPoints|saveAllPoints|dataPoints\./)
  new Function('visiblePointsSubpages', 'pointsSubpage', `return (${select})`)({ value: tabs }, state)('invalid')
  assert.equal(state.value, 'alarms')
})
