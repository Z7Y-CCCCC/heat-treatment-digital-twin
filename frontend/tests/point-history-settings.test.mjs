import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser, json } from './helpers.mjs'
const url = new URL('../src/views/admin/components/PointHistorySettings.vue', import.meta.url)
const source = await readFile(url, 'utf8'), descriptor = parse(source).descriptor
const body = descriptor.scriptSetup.content.replace(/^import[^\n]+\n/gm, '').replace(/defineProps\([^\n]+\)/, '__props')
const setup = new Function('vue','adminApi','__props','showSaveFeedback', 'const {ref,watch,onUnmounted}=vue;\n' + body + '\nreturn {open,loading,busy,policy,loadedFactoryId,error,load,toggle,save}')
const clone = value => JSON.parse(JSON.stringify(value))
const policy = {version:1,recentEnabled:true,recentHours:24,metricMode:'finite',metricDays:90}
const response = (factoryId='f') => ({success:true,factoryId,policy:clone(policy),points:[]})
function mount(api, input={factoryId:'f',deviceId:'a',canEdit:true}) {
  const props=vue.reactive(input),notices=[]
  const renderer=vue.createRenderer({createComment:()=>({}),createText:()=>({}),createElement:()=>({}),insert(){},remove(){},setText(){},setElementText(){},parentNode(){return null},nextSibling(){return null},patchProp(){}})
  let state;const app=renderer.createApp({setup(){state=setup(vue,api,props,(message,type='success')=>notices.push({message,type}));return()=>null}});app.mount({})
  return {props,state,notices,close:()=>app.unmount()}
}
test('factory history settings compile, keep permissions and remove the separate point-policy form',async()=>{
  assert.doesNotThrow(()=>compileScript(descriptor,{id:'history-policy'}))
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:url.pathname,id:'history-policy'}).errors,[])
  for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,id:'history-policy',scoped:style.scoped}).errors,[])
  assert.match(source,/fieldset[^>]+:disabled="!canEdit \|\| busy \|\| loading"/)
  assert.doesNotMatch(source,/当前点位|选择已保存的点位|保存当前点位历史策略|策略只决定后续/)
  const admin=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
  assert.match(admin,/<PointHistorySettings :factory-id="dataCenterFactoryId" :device-id="selectedDeviceForPoints" :can-edit="canAdminPage\('points','edit'\)"/)
  assert.match(admin,/<SaveFeedbackToast/)
})
test('history API follows the normal factory context, omits all-device sentinel and explains outdated collectors',async t=>{
  const {browser}=installBrowser(t),requests=[]
  let reply=json(response())
  browser.fetch=async(url,options)=>{requests.push({url,headers:options.headers});return reply}
  await adminApi.getHistoryPolicy('', 'all')
  assert.equal(requests[0].headers.has('X-Factory-ID'),false)
  assert.doesNotMatch(requests[0].url,/device_id=/)
  await adminApi.getHistoryPolicy('f','a')
  assert.equal(requests[1].headers.get('X-Factory-ID'),'f');assert.match(requests[1].url,/device_id=a/)
  reply=json({error:'接口不存在'},404)
  assert.match((await adminApi.getHistoryPolicy('')).error,/更新采集服务/)
  reply=json({error:'设备不属于当前工厂'},404)
  assert.equal((await adminApi.getHistoryPolicy('f','foreign')).error,'设备不属于当前工厂')
})

test('factory save submits only factory policy, shows a success toast and reopening refreshes the policy',async()=>{
  let reads=0;const writes=[]
  const f=mount({getHistoryPolicy:async()=>{reads++;return response()},saveHistoryPolicy:async(factoryId,value)=>{writes.push({factoryId,value});return {success:true,factoryId}}})
  try {await f.state.load();f.state.policy.value.recentHours=2;await f.state.save()
    assert.deepEqual(writes,[{factoryId:'f',value:{...policy,recentHours:2}}]);assert.equal(f.notices[0].type,'success')
    f.state.toggle({target:{open:false}});f.state.toggle({target:{open:true}});await vue.nextTick();assert.equal(reads,2)
  }finally{f.close()}
})
test('unset browser factory pins writes to the confirmed current server factory',async()=>{
  const writes=[],f=mount({getHistoryPolicy:async()=>response('current'),saveHistoryPolicy:async(factoryId)=>{writes.push(factoryId);return {success:true,factoryId}}},{factoryId:'',deviceId:'all',canEdit:true})
  try{await f.state.load();await f.state.save();assert.deepEqual(writes,['current'])}finally{f.close()}
})
test('unconfirmed or mismatched factory never enables writes',async()=>{
  let value=response('wrong'),writes=0;const f=mount({getHistoryPolicy:async()=>value,saveHistoryPolicy:async()=>writes++})
  try{await f.state.load();await f.state.save();assert.equal(writes,0);assert.equal(f.state.policy.value,null)
    f.props.factoryId='';await vue.nextTick();value=response('');await f.state.load();await f.state.save();assert.equal(writes,0)
  }finally{f.close()}
})
test('read-only cannot save; API failures and mismatched confirmations show error bubbles, never success',async()=>{
  let writes=0,value={success:false,error:'隔离保存失败'}
  const f=mount({getHistoryPolicy:async()=>response(),saveHistoryPolicy:async()=>{writes++;return value}},{factoryId:'f',deviceId:'a',canEdit:false})
  try{await f.state.load();await f.state.save();assert.equal(writes,0);f.props.canEdit=true
    await f.state.save();assert.equal(f.notices.at(-1).type,'error');assert.match(f.notices.at(-1).message,/隔离保存失败/)
    value={success:true,factoryId:'other'};await f.state.save();assert.match(f.notices.at(-1).message,/保存未确认/)
    assert.ok(f.notices.every(n=>n.type==='error'))
  }finally{f.close()}
})
test('scope changes and unmounts discard delayed responses and delayed save feedback',async()=>{
  const calls=[];let finishSave
  const f=mount({getHistoryPolicy:(factoryId)=>new Promise(resolve=>calls.push({factoryId,resolve})),saveHistoryPolicy:()=>new Promise(resolve=>finishSave=resolve)})
  try{const old=f.state.load();f.state.open.value=true;f.props.factoryId='g';await vue.nextTick();assert.equal(calls.length,2)
    calls[1].resolve(response('g'));await vue.nextTick();calls[0].resolve(response('f'));await old
    assert.equal(f.state.loadedFactoryId.value,'g');const pending=f.state.save();f.close();finishSave({success:true,factoryId:'g'});await pending;assert.deepEqual(f.notices,[])
  }finally{f.close()}
})
