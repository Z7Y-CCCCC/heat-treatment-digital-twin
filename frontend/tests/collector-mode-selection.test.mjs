import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {parse,compileScript} from 'vue/compiler-sfc'
import {createRenderer,h,ref} from 'vue'
import {adminApi} from '../src/config/factoryConfig.js'
import {adminSession} from '../src/runtime/adminSession.js'
import {normalizePagePermissions} from '../../shared/pagePermissions.mjs'
import {deferred,installBrowser,settle} from './helpers.mjs'
const url=new URL('../src/views/admin/components/CollectorRuntimePanel.vue',import.meta.url)
const {descriptor}=parse(await readFile(url,'utf8'))
let code=compileScript(descriptor,{id:'collector-mode-selection'}).content
for(const match of [...code.matchAll(/from\s+(['"])([^'"]+)\1/g)]) code=code.replace(match[0],`from ${JSON.stringify(match[2].startsWith('.')?new URL(match[2],url).href:import.meta.resolve(match[2]))}`)
const {default:Panel}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));Panel.render=()=>null
const status=mode=>({factoryId:'factory_a',configuredMode:mode,counts:{},process:{},factories:[]})
async function fixture(t,{mode='external',confirm=async()=>true}={}){
  const env=installBrowser(t),previous={...adminSession};Object.assign(adminSession,{authenticated:true,user:{id:'owner',role:'owner'},pagePermissions:normalizePagePermissions(undefined,{owner:true})});t.after(()=>Object.assign(adminSession,previous))
  env.browser.localStorage={getItem:()=> 'factory_a'}
  t.mock.method(adminApi,'getCollectorStatus',async()=>status(mode))
  const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}})
  const instance=ref(null),app=renderer.createApp({render:()=>h(Panel,{ref:instance,confirm})});app.mount({});env.beforeRestore(()=>app.unmount());await settle()
  return instance.value.$.setupState
}
for(const mode of ['external','integrated_plc','simulation']) test(`new collector panel restores server-saved ${mode} without writing or guessing a default`,async t=>{
  const writes=t.mock.method(adminApi,'setCollectorMode',async()=>{throw Error('startup must not write')})
  const state=await fixture(t,{mode});assert.equal(state.source,mode);assert.equal(writes.mock.callCount(),0)
})
test('an old status response cannot roll back a just-saved source, and confirmation blocks competing switches',async t=>{
  const confirmation=deferred(),old=deferred(),state=await fixture(t,{confirm:()=>confirmation.promise})
  let reads=0,signal
  t.mock.method(adminApi,'getCollectorStatus',async currentSignal=>{if(++reads===1){signal=currentSignal;return old.promise}return status('simulation')})
  const save=t.mock.method(adminApi,'setCollectorMode',async body=>{assert.deepEqual(body,{mode:'simulation',expectedMode:'external'});return {success:true,mode:'simulation',runtimeApplied:true}})
  const previousRead=state.refresh();await settle();const switching=state.changeSource('simulation')
  assert.equal(state.busy,true);assert.equal(signal.aborted,true)
  await state.changeSource('integrated_plc');assert.equal(save.mock.callCount(),0)
  confirmation.resolve(true);await switching;assert.equal(state.source,'simulation')
  old.resolve(status('external'));await previousRead;assert.equal(state.source,'simulation');assert.equal(save.mock.callCount(),1)
})
test('cancelled or failed changes never become the next startup preference',async t=>{
  let accepted=false
  const state=await fixture(t,{confirm:async()=>accepted})
  const save=t.mock.method(adminApi,'setCollectorMode',async()=>({error:'保存失败'}))
  await state.changeSource('simulation');assert.equal(save.mock.callCount(),0);assert.equal(state.source,'external')
  accepted=true;await state.changeSource('simulation');assert.equal(state.source,'external');assert.equal(state.actionError,'保存失败');assert.equal(state.busy,false)
})
