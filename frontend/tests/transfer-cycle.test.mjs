import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {newTransferCycle,advanceTransferCycle,sampleTransferCycleAt} from '../../shared/transferCycle.mjs'
import {defaultTransferCycle,normalizeTransferCycle} from '../../shared/transferCycleConfig.mjs'
const config={extendSeconds:4,latchSeconds:.75,retractSeconds:4,conveySeconds:3,confirmTimeoutSeconds:10}
const input={valid:true,docked:true,start:true,pickup:false,sourcePresent:true,targetPresent:false,mouthFraction:.55}
test('display time cannot invent endpoint ownership or retract before both BOOL feedbacks confirm',()=>{
 const s=newTransferCycle();advanceTransferCycle(s,input,4,config);assert.equal(s.phase,'wait');assert.equal(s.confirmed,false);assert.equal(s.feed,1)
 advanceTransferCycle(s,input,100,config);assert.equal(s.phase,'wait');assert.equal(s.confirmed,false);assert.equal(s.cargo,.55)
 advanceTransferCycle(s,{...input,sourcePresent:false,targetPresent:true},.75,config);assert.equal(s.phase,'retract');assert.equal(s.confirmed,true)
 advanceTransferCycle(s,{...input,sourcePresent:false,targetPresent:true},4,config);assert.equal(s.phase,'done');assert.equal(s.feed,0);assert.equal(s.cargo,1)
})
test('invalid feedback, unknown dock or changing the requested operation freezes the same pose',()=>{
 for(const change of [{valid:false},{docked:false},{pickup:true},{mouthFraction:NaN}]){
  const s=newTransferCycle();advanceTransferCycle(s,input,2,config);const old=[s.feed,s.hook,s.cargo,s.elapsed]
  advanceTransferCycle(s,{...input,...change},5,config);assert.equal(s.paused,true);assert.deepEqual([s.feed,s.hook,s.cargo,s.elapsed],old)
 }
 const s=newTransferCycle();advanceTransferCycle(s,{...input,targetPresent:true},4,config);assert.equal(s.phase,'idle')
})
test('admin synthetic pickup and deposit run the same estimator without PLC reads',()=>{
 for(const pickup of [false,true]){
  const half=sampleTransferCycleAt(config,2,pickup,.55);assert.ok(half.feed>0&&half.feed<1);assert.equal(half.confirmed,false)
  const done=sampleTransferCycleAt(config,8.75,pickup,.55);assert.equal(done.phase,'done');assert.equal(done.cargo,pickup?0:1)
 }
})
test('enabled cycle requires owned per-station BOOL choices, explicit nodes and bounded durations',()=>{
 const c={...defaultTransferCycle(),enabled:true,startDataItemId:'a',pickupDataItemId:'b',stations:[{value:1,targetDeviceId:'furnace',side:'opposite',presencePointId:'10',seatNodeName:'basket',seatNodeLocal:[0,1.25,0]}]}
 assert.deepEqual(normalizeTransferCycle(c),c)
 for(const patch of [{pickupDataItemId:'a'},{conveySeconds:120},{stations:[]},{stations:[{...c.stations[0],side:'rotate-chassis'}]}])assert.throws(()=>normalizeTransferCycle({...c,...patch}))
})
test('checked-in native/Three traces preserve every intermediate cargo, fork and hook pose',async()=>{
 const file=JSON.parse(await readFile(new URL('../../shared/transfer-cycle-fixtures.json',import.meta.url)))
 for(const trace of file.traces){const state=newTransferCycle();for(const row of trace.steps){advanceTransferCycle(state,row.input,row.delta,trace.config);assert.deepEqual(state,row.expected)}}
})
