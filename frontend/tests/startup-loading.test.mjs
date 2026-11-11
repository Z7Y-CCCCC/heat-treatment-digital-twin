import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createOverlayStartup,createLoadingProgressTracker,startupPhase} from '../../shared/startupLoading.mjs'

const context=(progress,sequence=1,loadId='load-a',ready=false)=>({sceneReady:ready,startupLoading:{loadId,sequence,progress,step:'设备模型',detail:'精确拾取索引 64/120'}})
const fixture=()=>{const progress=[],ready=[];return{progress,ready,startup:createOverlayStartup({requiresNative:true,onProgress:d=>progress.push(d),onReady:d=>ready.push(d)})}}

test('web setup cannot advance native loading or dismiss it before the actual scene completes',()=>{
  const f=fixture()
  for(const p of [8,31,67,100])f.startup.webProgress(p,2,'web')
  assert.equal(f.progress.length,0)
  f.startup.nativeContext(context(45));f.startup.webReady()
  assert.equal(f.progress.at(-1).progress,45);assert.equal(f.ready.length,0)
  f.startup.nativeContext(context(100,2,'load-a',true))
  assert.equal(f.ready.length,1);assert.equal(f.progress.at(-1).progress,100)
  assert.equal(f.ready[0].sceneReady,true);assert.equal(f.ready[0].webReady,true)
  f.startup.webReady();f.startup.nativeContext(context(100,3,'load-a',true));assert.equal(f.ready.length,1)
})

test('native readiness alone is held below 100 until web setup completes; legacy sceneReady fallback is not evidence',()=>{
  const f=fixture()
  f.startup.nativeContext({sceneReady:true});f.startup.nativeContext(context(100,1,'load-a',false))
  assert.equal(f.ready.length,0);assert.equal(f.progress.at(-1).progress,99)
  f.startup.nativeContext(context(100,2,'load-a',true))
  assert.equal(f.progress.at(-1).progress,99);assert.equal(f.progress.at(-1).phase,3)
  f.startup.webReady();assert.equal(f.ready.length,1)
})

test('interleaved lower progress and stale sequence cannot rewind a load; a genuine new load may reset, retired loads cannot return',()=>{
  const f=fixture()
  f.startup.nativeContext(context(72,3));f.startup.nativeContext(context(20,4))
  assert.equal(f.progress.at(-1).progress,72)
  f.startup.nativeContext(context(100,2,'load-a',true));assert.equal(f.ready.length,0)
  f.startup.nativeContext(context(5,1,'load-b'));assert.equal(f.progress.at(-1).progress,5)
  const count=f.progress.length
  f.startup.nativeContext(context(100,9,'load-a',true));assert.equal(f.progress.length,count)
  f.startup.webReady();assert.equal(f.ready.length,0)
  f.startup.nativeContext(context(100,2,'load-b',true));assert.equal(f.ready.length,1)
})

test('standalone web/empty surfaces finish on web readiness and actual native stage boundaries select the matching ring',()=>{
  const progress=[],ready=[],startup=createOverlayStartup({onProgress:d=>progress.push(d),onReady:d=>ready.push(d)})
  startup.webProgress(67,2,'同步数据');startup.webProgress(8,0,'迟到配置')
  assert.equal(progress.at(-1).progress,67);assert.equal(progress.at(-1).phase,2)
  startup.webProgress(100,3,'网页');assert.equal(progress.at(-1).progress,99);assert.equal(ready.length,0)
  startup.webReady();assert.equal(ready.length,1)
  assert.deepEqual([0,17.9,18,31.9,32,87,90,99,100].map(startupPhase),[0,0,1,1,2,2,3,3,3])
})

const native=fs.readFileSync(new URL('../../native-admin-host/DashboardLoadingExperience.cs',import.meta.url),'utf8')
const filterSource=native.slice(native.indexOf('function createLoadingProgressTracker'),native.indexOf('const requireNative =')).trim()
test('the injected cover mirrors the tracker and rejects web overwrites, premature 100 and retired native loads',()=>{
  const mirror=vm.runInNewContext('('+filterSource+')')
  for(const managed of [false,true]){
    const a=createLoadingProgressTracker(managed),b=mirror(managed)
    const events=[{progress:67,phase:2},{source:'native',loadId:'a',sequence:1,progress:45,phase:2},
      {source:'web',progress:100,phase:3},{source:'native',loadId:'a',sequence:2,progress:30,phase:0},
      {source:'native',loadId:'a',sequence:1,progress:100,phase:3},
      {source:'native',loadId:'b',sequence:1,progress:5,phase:0},
      {source:'native',loadId:'a',sequence:9,progress:100,phase:3},
      {source:'native',loadId:'b',sequence:2,progress:100,phase:3},
      {source:'native',loadId:'b',sequence:3,progress:100,phase:3,ready:true,sceneReady:true,webReady:true}]
    for(const event of events)assert.deepEqual(JSON.parse(JSON.stringify(b(event))),a(event))
  }
  const track=createLoadingProgressTracker(true)
  assert.equal(track({progress:100}),null)
  assert.equal(track({source:'native',loadId:'a',sequence:1,progress:100,phase:3}).progress,99)
})

test('native finish rejects early calls and accepts real completion before the coalesced paint (no RAF race)',()=>{
  const start=native.indexOf('let nativeReady = false;'),end=native.indexOf('// Progress comes from real',start)
  const frames=new Map(),timers=[],updates=[],window={addEventListener(){},removeEventListener(){},setTimeout:fn=>timers.push(fn)}
  let frame=0
  const sandbox={window,requireNative:true,trackProgress:createLoadingProgressTracker(true),finished:false,modelFrame:0,
    requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame},cancelAnimationFrame:id=>frames.delete(id),
    setProgress:(...args)=>updates.push(args),root:{classList:{add(){}},remove(){}},style:{remove(){}},themeChanged(){}}
  vm.runInNewContext(native.slice(start,end),sandbox)
  assert.equal(window.__DIGITAL_TWIN_FINISH_LOADING__(),false)
  window.__DIGITAL_TWIN_LOADING_PROGRESS__({source:'web',progress:100,phase:3})
  assert.equal(window.__DIGITAL_TWIN_FINISH_LOADING__(),false)
  window.__DIGITAL_TWIN_LOADING_PROGRESS__({source:'native',loadId:'a',sequence:1,progress:100,phase:3,ready:true,sceneReady:true,webReady:true})
  assert.equal(window.__DIGITAL_TWIN_FINISH_LOADING__(),true)
  assert.deepEqual(updates,[[100,3,'生产现场已就绪']]);assert.equal(frames.size,0)
  timers[0]();assert.equal(window.__DIGITAL_TWIN_FINISH_LOADING__,null)
})
