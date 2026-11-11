import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, createSSRApp, h, nextTick, reactive, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { deferred, settle } from './helpers.mjs'

const url = new URL('../src/views/admin/components/SimulationPointValue.vue', import.meta.url)
const source = await readFile(url, 'utf8'), { descriptor } = parse(source)
assert.deepEqual(compileTemplate({ source:descriptor.template.content, filename:url.pathname, id:'sim-point' }).errors, [])
async function component(inlineTemplate = false) {
  let code = compileScript(descriptor, { id:'sim-point', inlineTemplate }).content
  for (const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) code = code.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2],url).href : import.meta.resolve(match[2]))}`)
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default
}
const Component = await component(), RenderedComponent = await component(true)
Component.render = () => null
async function fixture(t, patch = {}) {
  const props = reactive({ point:{id:1,device_id:'device',label:'最后到位工位',data_type:'WORD',sourceMode:'simulation',value:3,access_type:'READ'},currentMode:'simulation',canEdit:true,...patch }), writes=[], resets=[], saved=[]
  t.mock.method(adminApi,'setSimulationPointValue',async(...args)=>{writes.push(args);return {success:true}})
  t.mock.method(adminApi,'resetSimulationPointValue',async(...args)=>{resets.push(args);return {success:true}})
  const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
  const instance=ref(null),app=renderer.createApp({render:()=>h(Component,{...props,ref:instance,onSaved:()=>saved.push(true)})});app.mount({});t.after(()=>app.unmount());await settle()
  return {state:instance.value.$.setupState,props,writes,resets,saved}
}
test('double-click editor keeps its draft through automatic refresh and saves the entered value rather than a new generated value',async t=>{
  const f=await fixture(t);await f.state.begin();assert.equal(f.state.editing,true);assert.equal(f.state.draft,'3')
  f.state.draft='12';f.props.point.value=8;await nextTick();assert.equal(f.state.draft,'12')
  assert.equal(await f.state.apply(),true);assert.deepEqual(f.writes,[[1,'12']]);assert.equal(f.state.editing,false);assert.equal(f.saved.length,1)
  f.props.point.simulationManual=true;await nextTick();assert.equal(await f.state.apply(true),true);assert.deepEqual(f.resets,[[1]])
  assert.match(source,/@dblclick="begin"/);assert.match(source,/@keydown.enter.prevent="begin"/);assert.match(source,/恢复自动/)
})
test('real/external modes, read-only accounts and write-only points cannot open or submit the simulation editor',async t=>{
  const f=await fixture(t)
  for(const patch of [{sourceMode:'integrated_plc'},{sourceMode:'external'},{sourceMode:'simulation',access_type:'WRITE'}]){
    Object.assign(f.props.point,patch);await nextTick();await f.state.begin();assert.equal(f.state.editing,false);assert.equal(await f.state.apply(),false)
  }
  f.props.point.access_type='READ';f.props.canEdit=false;await nextTick();await f.state.begin();assert.equal(f.state.editing,false)
  assert.deepEqual(f.writes,[])
})
test('switching mode closes an open draft; boolean values and read-write points are supported',async t=>{
  const f=await fixture(t,{point:{id:2,label:'运行',value:false,data_type:'BOOL',sourceMode:'simulation',access_type:'READ_WRITE'}})
  await f.state.begin();assert.equal(f.state.isBoolean,true);assert.equal(f.state.draft,'false')
  assert.equal(await f.state.apply(),true);assert.deepEqual(f.writes,[[2,'false']])
  await f.state.begin();f.props.point.sourceMode='integrated_plc';await nextTick();assert.equal(f.state.editing,false)
})
test('server-side mode/type failures remain visible and overlapping saves cannot overwrite each other',async t=>{
  const f=await fixture(t), pending=deferred()
  t.mock.method(adminApi,'setSimulationPointValue',()=>pending.promise)
  await f.state.begin();f.state.draft='-1';const save=f.state.apply();assert.equal(f.state.busy,true);assert.equal(await f.state.apply(),false)
  pending.resolve({error:'WORD 需要范围内的整数'});assert.equal(await save,false);assert.match(f.state.error,/WORD/);assert.equal(f.state.editing,true);assert.deepEqual(f.saved,[])
})

test('non-simulation or unknown current mode hides all edit icons/actions and simulation labels even for cached simulation rows',async()=>{
  for(const currentMode of ['integrated_plc','external','',null,undefined]){
    const html=await renderToString(createSSRApp(RenderedComponent,{currentMode,canEdit:true,point:{id:1,label:'最后到位工位',data_type:'WORD',sourceMode:'simulation',simulationManual:true,value:null}}))
    assert.match(html,/simulation-point-readonly/)
    assert.doesNotMatch(html,/<svg|<button|<form|simulation-point-source|模拟 ·|恢复自动/)
  }
  const html=await renderToString(createSSRApp(RenderedComponent,{currentMode:'simulation',canEdit:true,point:{id:1,label:'最后到位工位',data_type:'WORD',sourceMode:'simulation',value:3}}))
  assert.match(html,/<svg/);assert.match(html,/模拟 · 自动/)
})

test('changing the current factory out of simulation closes an editor even before its point cache refreshes',async t=>{
  const f=await fixture(t);await f.state.begin();assert.equal(f.state.editing,true)
  f.props.currentMode='external';await nextTick()
  assert.equal(f.props.point.sourceMode,'simulation','simulate an old cached row')
  assert.equal(f.state.editing,false);assert.equal(await f.state.apply(),false);assert.deepEqual(f.writes,[])
  f.props.currentMode='simulation';await nextTick();assert.equal(f.state.editing,false)
})
