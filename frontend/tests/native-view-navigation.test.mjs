import test from 'node:test'
import assert from 'node:assert/strict'
import { createNativeViewNavigator } from '../src/runtime/nativeViewNavigation.js'
const target={viewId:'device_detail',deviceId:'f1'}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
test('same-window navigation waits for Unity acknowledgement, not just message delivery',async()=>{
  const nav=createNativeViewNavigator(async()=>({success:true,sent:1}))
  let complete=false
  const promise=nav.go(target).then(()=>{complete=true})
  await tick();assert.equal(complete,false)
  nav.accept({...target,deviceId:'other',sceneReady:true});await tick();assert.equal(complete,false)
  nav.accept({...target,sceneReady:false});await tick();assert.equal(complete,false)
  nav.accept({...target,sceneReady:true});await promise;assert.equal(complete,true)
  nav.dispose()
})
test('an early matching context is retained until the HTTP delivery response arrives',async()=>{
  let deliver
  const nav=createNativeViewNavigator(()=>new Promise(resolve=>{deliver=resolve}))
  const promise=nav.go(target)
  nav.accept({...target,sceneReady:true});await tick()
  deliver({success:true,sent:1})
  assert.equal((await promise).deviceId,'f1');nav.dispose()
})
test('offline, timeout and teardown do not claim a successful scene switch',async()=>{
  const offline=createNativeViewNavigator(async()=>({success:true,sent:0}))
  await assert.rejects(offline.go(target),/未连接/)
  const delayed=createNativeViewNavigator(async()=>({success:true,sent:1}),20)
  await assert.rejects(delayed.go(target),/未确认/)
  const stopped=createNativeViewNavigator(async()=>({success:true,sent:1}))
  const promise=stopped.go(target);stopped.dispose()
  await assert.rejects(promise,/取消/)
})

test('hierarchy transitions confirm their own workshop/line target rather than any matching view',async()=>{
  const nav=createNativeViewNavigator(async()=>({success:true,sent:1}))
  let complete=false
  const promise=nav.go({viewId:'line_overview',lineId:'line_b'}).then(()=>{complete=true})
  await tick();nav.accept({viewId:'line_overview',lineId:'line_a',sceneReady:true});await tick();assert.equal(complete,false)
  nav.accept({viewId:'line_overview',lineId:'line_b',sceneReady:true});await promise;assert.equal(complete,true)
})
