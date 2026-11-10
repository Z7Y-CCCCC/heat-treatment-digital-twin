import test from 'node:test'
import assert from 'node:assert/strict'
import { applyApprovedOverviewStyle, approvedOverviewAuthority } from '../src/runtime/approvedOverviewStyle.js'
import { approvedOverviewFixture } from './fixtures/approved-overview.mjs'

test('old blue local drafts inherit the authoritative source code appearance without replacing pending edits or binding/layout', () => {
  const authority = approvedOverviewFixture(), local = structuredClone(authority)
  delete local.metadata.approvedOverviewStyle
  local.widgets.find(widget => widget.id === 'cfg_param_a_value').content.text = '未保存温度：{value} ℃'
  local.widgets.find(widget => widget.id === 'detail_trend').frame.x = 777
  const before = structuredClone(local), result = applyApprovedOverviewStyle(local, authority)
  const panel = result.widgets.find(widget => widget.id === 'detail_trend')
  const source = authority.widgets.find(widget => widget.id === 'reference_hud_factory_trend')
  for (const key of ['background', 'backgroundOpacity', 'borderRadius', 'borderColor', 'shadow']) assert.equal(panel.style[key], source.style[key])
  assert.equal(panel.style.surfaceSkin, 'glass'); assert.equal(panel.frame.x, 777)
  assert.equal(result.widgets.find(widget => widget.id === 'cfg_param_a_value').content.text, '未保存温度：{value} ℃')
  for (const widget of result.widgets) {
    const original = before.widgets.find(item => item.id === widget.id)
    for (const key of ['id','type','frame','data','visibility','conditions','events','title','zIndex','visible']) assert.deepEqual(widget[key], original[key], `${widget.id}.${key}`)
    if (widget.id.startsWith('reference_hud_factory_')) assert.deepEqual(widget, original, 'approved overview itself must never be restyled')
  }
  assert.deepEqual(local, before, 'cache input is never mutated')
})

test('source-token changes propagate through the same implementation instead of a copied palette', () => {
  const authority = approvedOverviewFixture(), local = structuredClone(authority)
  const source = authority.widgets.find(widget => widget.id === 'reference_hud_factory_trend')
  source.style.background = '#554433'; source.style.borderColor = '#abcdef'; source.content.lineColor = '#556677'
  const result = applyApprovedOverviewStyle(local, authority)
  assert.equal(result.widgets.find(widget => widget.id === 'detail_trend').style.background, '#554433')
  assert.equal(result.widgets.find(widget => widget.id === 'detail_trend').style.borderColor, '#abcdef')
  assert.equal(result.widgets.find(widget => widget.id === 'cfg_device_trend_Furnace_01').content.lineColor, '#556677')
})

test('approval is explicit, other documents are unchanged and repeated application is idempotent', () => {
  const source = approvedOverviewFixture(), unapproved = structuredClone(source)
  delete unapproved.metadata.approvedOverviewStyle
  assert.equal(applyApprovedOverviewStyle(unapproved), unapproved)
  const first = applyApprovedOverviewStyle(source)
  assert.deepEqual(applyApprovedOverviewStyle(first), first)
  assert.deepEqual(first.scene, source.scene)
  assert.deepEqual(first.tooltipTemplates, source.tooltipTemplates)
})

test('an approved running release supplies the style contract without editing the stored draft or bumping its revision', () => {
  const released = approvedOverviewFixture(), draft = structuredClone(released)
  delete draft.metadata.approvedOverviewStyle
  const before = structuredClone(draft), authority = approvedOverviewAuthority(draft, released)
  assert.equal(authority.widgets, draft.widgets, 'use the real overview source, not copied screenshot colors')
  assert.equal(authority.metadata.approvedOverviewStyle.version, 2)
  assert.deepEqual(draft, before)
  assert.equal(approvedOverviewAuthority(draft, { ...released, sceneId: 'another-scene' }), draft)
  assert.equal(approvedOverviewAuthority(draft, { ...released, projectId: 'another-factory-project' }), draft)
})
