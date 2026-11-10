import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeDashboardDrafts } from '../src/runtime/dashboardDraftMerge.js'

const base = () => ({ metadata: { revision: 2, source: 'designer' }, widgets: [
  { id: 'a', content: { text: '原标题' }, frame: { x: 10 } },
  { id: 'b', content: { text: '其他组件' } }
] })

test('merges independent fields by stable widget IDs without losing either edit', () => {
  const baseline = base(), local = base(), server = base()
  local.widgets[0].content.text = '本机标题'
  server.widgets[0].frame.x = 50
  server.widgets.reverse(); server.metadata.revision = 6
  const result = mergeDashboardDrafts(baseline, local, server)
  assert.deepEqual(result.conflicts, [])
  assert.equal(result.document.widgets[1].content.text, '本机标题')
  assert.equal(result.document.widgets[1].frame.x, 50)
  assert.equal(result.document.metadata.revision, 6)
  assert.equal(baseline.widgets[0].content.text, '原标题')
})

test('different edits to one field are explicit, but unrelated server changes remain in the local-choice candidate', () => {
  const baseline = base(), local = base(), server = base()
  local.widgets[0].content.text = '本机'; server.widgets[0].content.text = '服务端'
  server.widgets[0].frame.x = 60
  const result = mergeDashboardDrafts(baseline, local, server)
  assert.deepEqual(result.conflicts, ['widgets[a].content.text'])
  assert.equal(result.document.widgets[0].content.text, '本机')
  assert.equal(result.document.widgets[0].frame.x, 60)
})

test('legacy drafts without a base never guess which real edits are newer', () => {
  const local = base(), server = base(); server.widgets[0].content.text = '服务端'
  const result = mergeDashboardDrafts(null, local, server)
  assert.equal(result.conflicts.length, 1)
  assert.deepEqual(result.document, local)
})

test('legacy drafts identical except server-managed metadata resolve without manual confirmation', () => {
  const local = base(), server = base(); server.metadata = { revision: 137, source: 'designer', updatedAt: '2026-11-09' }
  const result = mergeDashboardDrafts(null, local, server)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.document, server)
})

test('independent additions and deletions survive, while delete-versus-edit is never silently discarded', () => {
  const baseline = base(), local = base(), server = base()
  local.widgets.push({ id: 'c', content: { text: '新增' } }); server.widgets.shift()
  const result = mergeDashboardDrafts(baseline, local, server)
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.document.widgets.map(widget => widget.id), ['b', 'c'])
  local.widgets[0].content.text = '删除期间编辑'
  assert.deepEqual(mergeDashboardDrafts(baseline, local, server).conflicts, ['widgets[a]'])
})
