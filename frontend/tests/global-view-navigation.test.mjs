import test from 'node:test'
import assert from 'node:assert/strict'
import { GLOBAL_VIEWS, normalizeGlobalViews, applyViewNavigation, runtimeViewHidden } from '../../shared/viewNavigation.mjs'
const fixture=()=>({scene:{defaultViewId:'map_world',views:[...GLOBAL_VIEWS.map(v=>({...v,metadata:{hierarchyHidden:true}})),
  {id:'factory_overview',parentViewId:'site_factory',returnViewId:'site_factory',metadata:{hierarchyOrder:8}},
  {id:'workshop_overview',parentViewId:'factory_overview',returnViewId:'factory_overview',metadata:{hierarchyOrder:9}}]},widgets:[{id:'unchanged'}]})
test('all 128 global switch combinations project the same policy across factories without deleting authoring data',()=>{
  for(let mask=0;mask<128;mask++){
    const before=fixture(),snapshot=structuredClone(before),policy=normalizeGlobalViews()
    GLOBAL_VIEWS.forEach((v,i)=>policy.enabled[v.id]=!!(mask&(1<<i)))
    const runtime=applyViewNavigation(before,policy)
    GLOBAL_VIEWS.forEach(v=>assert.equal(runtimeViewHidden(runtime.scene.views.find(x=>x.id===v.id)),!policy.enabled[v.id]))
    assert.deepEqual(before,snapshot);assert.deepEqual(runtime.widgets,before.widgets)
    assert.equal(runtime.scene.views.length,before.scene.views.length)
    assert.equal(runtimeViewHidden(runtime.scene.views.find(v=>v.id===runtime.scene.defaultViewId)),false)
  }
})
test('hidden default and intermediate local views are skipped; restoring keeps original authoring hierarchy',()=>{
  const document=fixture();document.scene.views.find(v=>v.id==='factory_overview').metadata.hierarchyHidden=true
  const policy=normalizeGlobalViews();Object.keys(policy.enabled).forEach(id=>policy.enabled[id]=false)
  const runtime=applyViewNavigation(document,policy)
  assert.equal(runtime.scene.defaultViewId,'workshop_overview')
  assert.equal(runtime.scene.views.find(v=>v.id==='workshop_overview').parentViewId,'')
  assert.equal(document.scene.views.find(v=>v.id==='workshop_overview').parentViewId,'factory_overview')
  document.scene.views.find(v=>v.id==='workshop_overview').metadata.hierarchyHidden=true
  assert.equal(applyViewNavigation(document,policy).scene.defaultViewId,'factory_overview','legacy all-hidden local documents retain a safe entry')
})
test('first visible local entry follows hierarchy order, cyclic links terminate and invalid legacy policy defaults safely',()=>{
  const document=fixture();document.scene.views.find(v=>v.id==='workshop_overview').metadata.hierarchyOrder=0
  const policy=normalizeGlobalViews();Object.keys(policy.enabled).forEach(id=>policy.enabled[id]=false)
  assert.equal(applyViewNavigation(document,policy).scene.defaultViewId,'workshop_overview')
  document.scene.views[0].parentViewId='map_world'
  assert.doesNotThrow(()=>applyViewNavigation(document,policy))
  assert.equal(Object.values(normalizeGlobalViews('bad').enabled).every(Boolean),true)
})
