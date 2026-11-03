import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { moveView, setHierarchyHidden, viewTreeRows, visibleViewLink, viewDisplayName } from '../src/runtime/viewHierarchy.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
const require = createRequire(import.meta.url)
const { normalizeDocument } = require('../../backend/utils/dashboardDocument.js')
const fixture = () => [
  {id:'a',name:'工厂',parentViewId:'',returnViewId:'',metadata:{}},
  {id:'b',name:'车间',parentViewId:'a',returnViewId:'a',metadata:{custom:'keep'}},
  {id:'c',name:'产线',parentViewId:'b',returnViewId:'b',metadata:{}},
  {id:'d',name:'设备',parentViewId:'c',returnViewId:'c',metadata:{}},
  {id:'e',name:'其他车间',parentViewId:'a',returnViewId:'a',metadata:{}}
]
const rowIds = views => viewTreeRows(views).map(row => row.view.id)

test('drop in center reparents a complete subtree and synchronizes return, not only its visual order', () => {
  const before = fixture(), snapshot = structuredClone(before), moved = moveView(before,'c','e','inside')
  assert.equal(moved.find(v=>v.id==='c').parentViewId,'e')
  assert.equal(moved.find(v=>v.id==='c').returnViewId,'e')
  assert.equal(moved.find(v=>v.id==='d').parentViewId,'c')
  assert.deepEqual(rowIds(moved),['a','b','e','c','d'])
  assert.deepEqual(before,snapshot)
})
test('before/after inserts as a sibling; root drop removes the parent and return', () => {
  const before=fixture()
  assert.deepEqual(rowIds(moveView(before,'e','b','before')),['a','e','b','c','d'])
  assert.deepEqual(rowIds(moveView(before,'b','e','after')),['a','e','b','c','d'])
  const moved=moveView(before,'c','','root')
  assert.equal(moved.find(v=>v.id==='c').parentViewId,'')
  assert.equal(moved.find(v=>v.id==='c').returnViewId,'')
  assert.deepEqual(rowIds(moved),['a','b','e','c','d'])
})
test('self, descendant, unknown, hidden and return-cycle drop targets are rejected without mutations', () => {
  const before=fixture(), snapshot=structuredClone(before)
  for (const [source,target] of [['a','d'],['b','b'],['c','missing'],['missing','a']]) assert.equal(moveView(before,source,target),null)
  assert.equal(moveView(setHierarchyHidden(before,'e',true),'b','e'),null)
  const mixed=fixture();mixed.find(v=>v.id==='e').returnViewId='b'
  assert.equal(moveView(mixed,'b','e','inside'),null)
  assert.deepEqual(before,snapshot)
})
test('hiding promotes visible children and both relationship selectors bypass hidden ancestors; restoring retains original links/order', () => {
  const before=fixture(), hidden=setHierarchyHidden(setHierarchyHidden(before,'b',true),'c',true)
  const d=hidden.find(v=>v.id==='d')
  assert.equal(visibleViewLink(hidden,d),'a');assert.equal(visibleViewLink(hidden,d,'returnViewId'),'a')
  assert.deepEqual(rowIds(hidden),['a','d','e'])
  assert.equal(viewTreeRows(hidden).find(r=>r.view.id==='d').level,1)
  assert.equal(d.parentViewId,'c');assert.equal(d.returnViewId,'c')
  const restored=setHierarchyHidden(setHierarchyHidden(hidden,'b',false),'c',false)
  assert.deepEqual(rowIds(restored),rowIds(before))
  assert.equal(restored.find(v=>v.id==='b').metadata.custom,'keep')
  assert.deepEqual(before,fixture())
})
test('hidden roots promote children, collapsed branches stay collapsed, and the final visible view cannot be hidden', () => {
  assert.deepEqual(rowIds(setHierarchyHidden(fixture(),'a',true)),['b','c','d','e'])
  assert.deepEqual(viewTreeRows(fixture(),new Set(['b'])).map(r=>r.view.id),['a','b','e'])
  assert.equal(setHierarchyHidden([fixture()[0]],'a',true),null)
  assert.equal(setHierarchyHidden(fixture(),'missing',true),null)
  const doc=normalizeDashboardDocument()
  const promoted=viewTreeRows(setHierarchyHidden(doc.scene.views,'map_world',true))
  assert.equal(promoted[0].view.id,'map_country','promoted children keep the hidden root position, before the factory branch')
})
test('reordered/hidden hierarchy survives frontend and backend save/reopen normalization without touching camera/widgets', () => {
  const doc=normalizeDashboardDocument({scene:{views:fixture()}})
  doc.scene.views=moveView(doc.scene.views,'c','e','inside')
  doc.scene.views=setHierarchyHidden(doc.scene.views,'b',true)
  const reopened=normalizeDashboardDocument(normalizeDocument(doc))
  const ids=new Set(fixture().map(v=>v.id))
  assert.deepEqual(rowIds(reopened.scene.views).filter(id=>ids.has(id)),['a','e','c','d'])
  assert.equal(reopened.scene.views.find(v=>v.id==='c').returnViewId,'e')
  assert.equal(reopened.scene.views.find(v=>v.id==='b').metadata.hierarchyHidden,true)
  assert.deepEqual(reopened.widgets,doc.widgets)
  assert.deepEqual(reopened.scene.views.find(v=>v.id==='c').camera,doc.scene.views.find(v=>v.id==='c').camera)
})
test('map labels omit the old numbering without modifying user-defined names or IDs', () => {
  assert.equal(viewDisplayName({id:'map_world',name:'01 全球地图'}),'全球地图')
  assert.equal(viewDisplayName({id:'custom',name:'01# 设备'}),'01# 设备')
  const doc=normalizeDashboardDocument({scene:{views:[{id:'site_factory',name:'07 工厂建筑',mode:'custom'}]}})
  assert.equal(doc.scene.views.find(v=>v.id==='site_factory').name,'工厂建筑')
})
