import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as vue from 'vue'
import { parse, compileScript, compileTemplate, compileStyle } from '@vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { installBrowser, json } from './helpers.mjs'

const url = new URL('../src/views/admin/components/PointHistorySettings.vue', import.meta.url)
const source = await readFile(url, 'utf8'), descriptor = parse(source).descriptor
// Execute the actual setup and handlers in a Vue instance (real lifecycle and
// watchers), with an isolated API; browser smoke tests cover native controls.
const body = descriptor.scriptSetup.content.replace(/^import[^\n]+\n/gm, '').replace(/defineProps\([^\n]+\)/, '__props')
const setup = new Function('vue','adminApi','__props', 'const {computed,ref,watch,onUnmounted}=vue;\n' + body + '\nreturn {open,loading,busy,policy,points,selectedId,selected,loadedFactoryId,error,message,load,toggle,save}')
const clone = value => JSON.parse(JSON.stringify(value))
const policy = {version:1,recentEnabled:true,recentHours:24,metricMode:'finite',metricDays:90}
const response = (factoryId='f', id='1') => ({success:true,factoryId,policy:clone(policy),points:[{id,device_id:'a',device_name:'A',label:'温度',history_mode:'recent',history_days:30}]})
function mount(api, input={factoryId:'f',deviceId:'a',canEdit:true}) {
  const props=vue.reactive(input)
  const renderer=vue.createRenderer({createComment:()=>({}),createText:()=>({}),createElement:()=>({}),insert(){},remove(){},setText(){},setElementText(){},parentNode(){return null},nextSibling(){return null},patchProp(){}})
  let state
  const app=renderer.createApp({setup(){state=setup(vue,api,props);return()=>null}});app.mount({})
  return {props,state,close:()=>app.unmount()}
}
test('history settings compile and are wired to current factory/device and edit permission',async()=>{
  assert.doesNotThrow(()=>compileScript(descriptor,{id:'history-policy'}))
  assert.deepEqual(compileTemplate({source:descriptor.template.content,filename:url.pathname,id:'history-policy'}).errors,[])
  for(const style of descriptor.styles)assert.deepEqual(compileStyle({source:style.content,id:'history-policy',scoped:style.scoped}).errors,[])
  assert.match(source,/field[s]?et[^>]+:disabled="!canEdit \|\| busy \|\| loading"/)
  assert.match(source,/原到期时间清理/)
  const admin=await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
  assert.match(admin,/<PointHistorySettings :factory-id="dataCenterFactoryId" :device-id="selectedDeviceForPoints" :can-edit="canAdminPage\('points','edit'\)"/)
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
test('reopening refreshes saved points; separate factory/point saves submit only their own policy',async()=>{
  const reads=[],writes=[]
  const api={getHistoryPolicy:async(factoryId,deviceId)=>{reads.push({factoryId,deviceId});return response(factoryId,String(reads.length))},
    saveHistoryPolicy:async(factoryId,value)=>{writes.push({factoryId,policy:clone(value)});return {success:true,factoryId}},
    savePointHistoryPolicy:async(factoryId,pointId,value)=>{writes.push({factoryId,pointId,policy:clone(value)});return {success:true,factoryId,pointId}}}
  const f=mount(api)
  try {
    await f.state.load();f.state.policy.value.recentHours=2
    await f.state.save(false);assert.deepEqual(writes[0],{factoryId:'f',policy:{...policy,recentHours:2}})
    f.state.selected.value.history_mode='finite';f.state.selected.value.history_days=7
    await f.state.save(true);assert.deepEqual(writes[1],{factoryId:'f',pointId:'1',policy:{mode:'finite',days:7}})
    f.state.toggle({target:{open:false}});f.state.toggle({target:{open:true}});await vue.nextTick()
    assert.equal(reads.length,2);assert.equal(f.state.selected.value.id,'2','new saved points appear after reopening')
  } finally {f.close()}
})
test('no saved factory preference follows the current server factory and pins every save to it',async()=>{
  const reads=[],writes=[]
  const f=mount({getHistoryPolicy:async(factoryId,deviceId)=>{reads.push({factoryId,deviceId});return response('current-factory')},
    saveHistoryPolicy:async(factoryId,value)=>{writes.push({factoryId,value});return {success:true,factoryId}},
    savePointHistoryPolicy:async(factoryId,pointId,value)=>{writes.push({factoryId,pointId,value});return {success:true,factoryId,pointId}}},
    {factoryId:'',deviceId:'all',canEdit:true})
  try{
    await f.state.load()
    assert.deepEqual(reads,[{factoryId:'',deviceId:'all'}])
    assert.equal(f.state.error.value,'');assert.equal(f.state.loadedFactoryId.value,'current-factory')
    await f.state.save();await f.state.save(true)
    assert.equal(writes.length,2);assert.ok(writes.every(write=>write.factoryId==='current-factory'))
  }finally{f.close()}
})
test('an unconfirmed or mismatched factory never enables history writes',async()=>{
  let result=response('other-factory'),writes=0
  const f=mount({getHistoryPolicy:async()=>result,saveHistoryPolicy:async()=>{writes++}})
  try{
    await f.state.load();await f.state.save()
    assert.equal(f.state.loadedFactoryId.value,'');assert.equal(f.state.policy.value,null)
    f.props.factoryId='';await vue.nextTick();result=response('')
    await f.state.load();await f.state.save();assert.equal(writes,0)
    assert.doesNotMatch(f.state.error.value,/请选择工厂|请先选择工厂/)
  }finally{f.close()}
})
test('read-only controls never write and a failed or wrong-scope save cannot claim success',async()=>{
  let writes=0
  const api={getHistoryPolicy:async()=>response(),saveHistoryPolicy:async()=>{writes++;return {success:false,error:'隔离保存失败'}},
    savePointHistoryPolicy:async()=>{writes++;return {success:true,factoryId:'f',pointId:'OTHER'}}}
  const f=mount(api,{factoryId:'f',deviceId:'a',canEdit:false})
  try {
    await f.state.load();await f.state.save();await f.state.save(true);assert.equal(writes,0)
    f.props.canEdit=true;await f.state.save();assert.equal(f.state.message.value,'');assert.match(f.state.error.value,/保存失败/)
    await f.state.save(true);assert.equal(f.state.message.value,'');assert.match(f.state.error.value,/保存未确认/)
  }finally{f.close()}
})
test('switching scopes and unmounting discard delayed responses, not apply another device policy',async()=>{
  const calls=[]
  const f=mount({getHistoryPolicy:(factoryId,deviceId)=>new Promise(resolve=>calls.push({factoryId,deviceId,resolve}))})
  try {
    const old=f.state.load();f.state.open.value=true
    f.props.factoryId='g';f.props.deviceId='b';await vue.nextTick()
    assert.equal(calls.length,2);assert.equal(f.state.selectedId.value,'')
    calls[1].resolve(response('g','2'));await vue.nextTick()
    calls[0].resolve(response('f','1'));await old
    assert.equal(f.state.policy.value.recentHours,24);assert.equal(f.state.selected.value.id,'2')
    const pending=f.state.load();f.close();calls[2].resolve(response('g','3'));await pending
    assert.equal(f.state.policy.value,null,'unmounted panel does not adopt a late response')
  }finally{f.close()}
})
