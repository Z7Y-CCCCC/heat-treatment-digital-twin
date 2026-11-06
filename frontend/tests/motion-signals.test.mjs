import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {receiveMotionSignal,stepMotionSignal,evaluateMotionCondition,motionTestValue,PortableMotionPlayer} from '../src/three/PortableMotionPlayer.js'

const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/motion-signals.json',import.meta.url),'utf8'))
function fixtureFrame(binding,event){
 const timestamp=1000000+event.now*1000
 return {timestamp,status:{online:event.online??true},motionInputs:event.missing?{}:{[binding.actionId]:{dataItemId:event.identity??binding.dataItemId,value:event.value,quality:event.quality??'good',timestamp:event.stamp??timestamp,staleMs:event.sourceStaleMs??5000}}}
}
for(const fixture of fixtures.cases)test(`signal fixture: ${fixture.name}`,()=>{
 const state={seconds:0}
 for(const event of fixture.events){
  if(event.op==='receive')receiveMotionSignal(state,fixture.binding,fixtureFrame(fixture.binding,event),event.now)
  else stepMotionSignal(state,fixture.binding,event.delta,event.now,event.staleMs??5000)
  for(const [key,value] of Object.entries(event.expect)){
   if(typeof value==='number')assert.ok(Math.abs(state[key]-value)<1e-9,`${fixture.name}: ${event.op}@${event.now} ${key}: ${state[key]} vs ${value}`)
   else assert.equal(state[key],value,`${fixture.name}: ${event.op}@${event.now} ${key}`)
  }
 }
})

test('all condition operators retain their boundary semantics and types',()=>{
 const cases=[['eq',3,3,true],['ne',3,3,false],['ne',3,4,true],['gt',3,3,false],['gte',3,3,true],['lt',3,3,false],['lte',3,3,true],['eq',false,false,true],['eq','运行','运行',true],['eq','3',3,undefined],['ne',true,1,undefined],['gt','3',2,undefined],['gt',Infinity,2,undefined]]
 for(const [operator,raw,value,expected] of cases)assert.equal(evaluateMotionCondition(raw,{operator,value}),expected,`${operator} ${String(raw)} ${String(value)}`)
 assert.equal(evaluateMotionCondition(48,{operator:'lt',value:50,hysteresis:5},false),true)
 assert.equal(evaluateMotionCondition(51,{operator:'lt',value:50,hysteresis:5},false),false)
 assert.equal(evaluateMotionCondition(44,{operator:'lt',value:50,hysteresis:5},false),true)
 assert.equal(evaluateMotionCondition(52,{operator:'lt',value:50,hysteresis:5},true),true)
 assert.equal(evaluateMotionCondition(56,{operator:'lt',value:50,hysteresis:5},true),false)
 assert.equal(evaluateMotionCondition(50,{operator:'gte',value:50,hysteresis:5},false),true)
 assert.equal(evaluateMotionCondition(51,{operator:'gte',value:50,hysteresis:5},false),true)
 assert.equal(evaluateMotionCondition(49,{operator:'gte',value:50,hysteresis:5},false),false)
})

test('preview slider generates typed true/false observations for every trigger operator',()=>{
 for(const value of [true,false,'运行',42])for(const operator of ['eq','ne']){
  const binding={trigger:{mode:'condition',operator,value,hysteresis:0}}
  for(const [progress,expected] of [[0,false],[1,true]])assert.equal(evaluateMotionCondition(motionTestValue(binding,progress),binding.trigger),expected)
 }
 for(const operator of ['gt','gte','lt','lte']){
  const binding={trigger:{mode:'condition',operator,value:42,hysteresis:5}}
  assert.equal(evaluateMotionCondition(motionTestValue(binding,0),binding.trigger),false)
  assert.equal(evaluateMotionCondition(motionTestValue(binding,1),binding.trigger),true)
 }
})

test('missing catalog data never falls through to a legacy point; motion-only broadcasts never refresh PLC lifetime',()=>{
 const binding={actionId:'clip:door',dataItemId:'point:stroke',sourceGroup:'doors',sourceKey:'open',pointId:'42',inputMin:0,inputMax:1},s={seconds:0}
 receiveMotionSignal(s,binding,{doors:{open:1},pointMeta:{'doors.open':{id:'42'}}},0)
 assert.equal(s.usable,false);assert.equal(s.hasSample,undefined)
 const legacy={...binding,dataItemId:undefined},p={seconds:0}
 receiveMotionSignal(p,legacy,{doors:{open:1}},0)
 receiveMotionSignal(p,legacy,{timestamp:1010000,motionInputs:{}},4)
 assert.equal(p.usable,true);assert.equal(p.receivedAt,0)
 receiveMotionSignal(p,legacy,{timestamp:1010000,motionInputOnly:true,motionInputs:{},doors:{open:0}},4)
 assert.equal(p.position,1);assert.equal(p.receivedAt,0)
 stepMotionSignal(p,legacy,0,6,5000);assert.equal(p.usable,false)
})

test('stale PLC read timestamp, not message delivery, controls legacy freshness',()=>{
 const binding={sourceGroup:'doors',sourceKey:'open',pointId:'42',inputMin:0,inputMax:1,transitionSeconds:0},s={seconds:0}
 const frame=now=>({timestamp:1000000+now*1000,doors:{open:1},pointMeta:{'doors.open':{id:'42',timestamp:1000000}}})
 receiveMotionSignal(s,binding,frame(0),0);receiveMotionSignal(s,binding,frame(4),4)
 assert.equal(s.receivedAt,0);stepMotionSignal(s,binding,0,6,5000);assert.equal(s.usable,false)
})

test('catalog input requires identity and real source timestamp while legacy ranges keep boolean compatibility',()=>{
 const binding={actionId:'part:stroke',dataItemId:'point:stroke',inputMin:0,inputMax:1},s={seconds:0}
 for(const bad of [{dataItemId:'point:stroke',value:1,quality:'good'},{dataItemId:'point:stroke',value:1,quality:'good',timestamp:0},{dataItemId:'point:stroke',value:1,quality:'good',timestamp:'0'},{value:1,quality:'good',timestamp:1000000}]){
  receiveMotionSignal(s,binding,{timestamp:1000000,motionInputs:{'part:stroke':bad}},0)
  assert.equal(s.usable,false);assert.equal(s.hasSample,undefined)
 }
 const legacy={sourceGroup:'doors',sourceKey:'open',inputMin:0,inputMax:1},state={seconds:0}
 receiveMotionSignal(state,legacy,{doors:{open:true}},0);assert.equal(state.position,1)
 receiveMotionSignal(state,legacy,{doors:{open:'0.25'}},1);assert.equal(state.position,.25)
})

test('running material, visibility and mechanical channels all freeze rather than reset on bad quality',()=>{
 const root=new T.Group(),node=new T.Mesh(new T.BoxGeometry(),new T.MeshStandardMaterial());node.name='part';root.add(node)
 const clip={id:'run',duration:1,count:2,tracks:[{node:'part',channel:'p',size:3,values:[0,0,0,1,0,0]},{node:'part',channel:'v',size:1,values:[1,1]},{node:'part',channel:'c0',size:4,values:[1,0,0,1,1,0,0,1]}]}
 const pkg={nodes:[{name:'part',v:[0],c0:[0,1,0,1]}],clips:[clip]},binding={enabled:true,kind:'clip',mode:'running',clipId:'run',actionId:'clip:run',dataItemId:'point:run',inputMin:0,inputMax:1,transitionSeconds:0}
 const player=new PortableMotionPlayer(root,pkg,[binding]);player.receive(fixtureFrame(binding,{now:0,value:1}),0);player.advance(.25,.25)
 const position=node.position.clone(),color=node.material.color.clone(),visible=node.visible
 player.receive(fixtureFrame(binding,{now:1,value:0,quality:'bad'}),1);player.advance(1,2)
 assert.ok(node.position.equals(position));assert.ok(node.material.color.equals(color));assert.equal(node.visible,visible)
 assert.equal(player.entries[0].signal.reason,'数据无效')
})
