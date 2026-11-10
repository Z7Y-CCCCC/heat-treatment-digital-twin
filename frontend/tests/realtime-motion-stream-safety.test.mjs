import test from 'node:test'
import assert from 'node:assert/strict'
import {receiveMotionSignal,receiveMotionEndpointFeedback,stepMotionSignal} from '../src/three/PortableMotionPlayer.js'
import {createDashboardDataStore} from '../src/runtime/DataStore.js'
import {installBrowser} from './helpers.mjs'
const binding={actionId:'clip:feed',dataItemId:'point:feed',inputMin:0,inputMax:1,transitionSeconds:1}
const frame=(stamp=1000000)=>({furnace_id:'cart',timestamp:stamp,motionInputOnly:true,motionInputs:{'clip:feed':{dataItemId:'point:feed',value:.5,quality:'good',timestamp:stamp,staleMs:1000}}})

test('live legacy point-ID bindings require the owned point confirmation, never packaging clocks',()=>{
 const row={actionId:'clip:feed',pointId:'12',sourceGroup:'mechanisms',sourceKey:'feed',inputMin:0,inputMax:1,transitionSeconds:0},state={}
 const data={timestamp:1000000,mechanisms:{feed:.25},quality:{mechanisms:{feed:'good'}},pointMeta:{'mechanisms.feed':{id:'12',timestamp:1000000}}}
 receiveMotionSignal(state,row,data,0,1000000);assert.equal(state.usable,true);assert.equal(state.position,.25)
 for(const meta of [undefined,{}, {'mechanisms.feed':{id:'99',timestamp:1000000}}, {'mechanisms.feed':{id:'12'}}, {'mechanisms.feed':{id:'12',timestamp:1000000,quality:'bad'}}]){
  receiveMotionSignal(state,row,{...data,pointMeta:meta},.2,1000200);assert.equal(state.usable,false);assert.equal(state.position,.25)
 }
 receiveMotionSignal(state,row,{...data,timestamp:1001000},1,1001000);assert.equal(state.receivedAt,0)
 stepMotionSignal(state,row,.1,1.1,1000);assert.equal(state.usable,false,'new envelopes do not freshen an unchanged source')
 const mock={};receiveMotionSignal(mock,row,{timestamp:1000000,mechanisms:{feed:.5}},0);assert.equal(mock.usable,true,'controlled preview without live wall clock stays compatible')
})
test('independent PLC packets cannot freeze or renew a catalog actuator; an explicit empty snapshot does freeze',()=>{
 const state={seconds:0}
 receiveMotionSignal(state,binding,{analog:{other:1}},0)
 assert.equal(state.usable,false);assert.equal(state.hasSample,undefined)
 receiveMotionSignal(state,binding,frame(),0);assert.equal(state.usable,true)
 const sourceAt=state.receivedAt,target=state.target
 receiveMotionSignal(state,binding,{timestamp:1000900,analog:{other:2}},.9)
 assert.equal(state.usable,true);assert.equal(state.receivedAt,sourceAt);assert.equal(state.target,target)
 receiveMotionSignal(state,binding,{timestamp:1001000,motionInputs:{}},1)
 assert.equal(state.usable,false);assert.equal(state.position,.5)
})
test('endpoint feedback keeps the same independent-stream contract',()=>{
 const row={actionId:'clip:feed',trigger:{mode:'endpoints',extended:{dataItemId:'a'},retracted:{dataItemId:'b'}}},state={}
 const data={timestamp:1000000,motionInputs:{'clip:feed':{quality:'good',endpointFeedback:{extended:{dataItemId:'a',value:true,quality:'good',timestamp:1000000,staleMs:1000},retracted:{dataItemId:'b',value:false,quality:'good',timestamp:1000000,staleMs:1000}}}}}
 receiveMotionEndpointFeedback(state,row,data,0)
 assert.equal(state.endpointStage,'extended')
 receiveMotionEndpointFeedback(state,row,{timestamp:1000500,analog:{other:2}},.5)
 assert.equal(state.endpointStage,'extended');assert.equal(state.endpointReceivedAt.extended,0)
 receiveMotionEndpointFeedback(state,row,{timestamp:1000500,motionInputs:{}},.5)
 assert.equal(state.usable,false);assert.equal(state.endpointStage,'invalid')
})
test('Web motion includes actual transport/cache age and rejects future envelope clocks just like native',()=>{
 const state={}
 receiveMotionSignal(state,binding,frame(1000000),10,1010000);assert.equal(state.usable,false)
 receiveMotionSignal(state,binding,frame(1010000),10,1010000);assert.equal(state.usable,true)
 receiveMotionSignal(state,binding,frame(1020000),10,1010000);assert.equal(state.usable,false);assert.match(state.reason,/时间/)
 const cached={...frame(1010000),cachedAgeMs:2000}
 receiveMotionSignal(state,binding,cached,10,1010000);assert.equal(state.usable,false)
})
test('WebSocket failure immediately faults cached motion without changing PLC telemetry or its read timestamp',async t=>{
 installBrowser(t)
 t.mock.method(globalThis,'fetch',async()=>({ok:true,status:200,json:async()=>({})}))
 class Socket{static current;constructor(){Socket.current=this;this.readyState=0;}send(){}close(){this.readyState=3;}}
 const previous=globalThis.WebSocket;globalThis.WebSocket=Socket;t.after(()=>{globalThis.WebSocket=previous})
 const store=createDashboardDataStore(),motion=[]
 try{
  store.setMotionInputHandler(data=>motion.push(data));store.connect()
  const socket=Socket.current;socket.readyState=1;socket.onopen()
  const stamp=Date.now(),data={...frame(stamp),motionInputOnly:false,analog:{temperature:850},quality:{analog:{temperature:'good'}}}
  socket.onmessage({data:JSON.stringify({type:'realtime_frame',payload:{timestamp:stamp,devices:[data]}})});const before=JSON.parse(JSON.stringify(store.deviceStatusMap.cart))
  socket.onerror()
  assert.equal(store.wsConnected.value,false)
  const last=motion.at(-1);assert.equal(last.motionInputOnly,true)
  assert.equal(last.motionInputs['clip:feed'].quality,'bad');assert.equal(last.motionInputs['clip:feed'].value,null)
  assert.equal(last.motionInputs['clip:feed'].timestamp,stamp)
  assert.equal(store.deviceDataMap.cart.analog.temperature,850)
  assert.deepEqual(JSON.parse(JSON.stringify(store.deviceStatusMap.cart)),before)
  const state={};receiveMotionSignal(state,binding,last,1,Date.now());stepMotionSignal(state,binding,1,1,5000);assert.equal(state.usable,false)
  const replay=[];store.setMotionInputHandler(data=>replay.push(data))
  assert.equal(replay.at(-1).motionInputs['clip:feed'].quality,'bad')
 }finally{store.dispose()}
})

