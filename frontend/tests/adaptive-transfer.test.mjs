import test,{mock} from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import {buildAdaptiveTransferPath,sampleAdaptiveTransferPath,sameAdaptiveTransferGeometry} from '../../shared/adaptiveTransferPath.mjs'
import {defaultTransferCycle,normalizeTransferCycle} from '../../shared/transferCycleConfig.mjs'
import {createAdaptiveTransferFixture,loadFixtureModel} from '../../tools/adaptive-transfer-fixture.mjs'
import {createLinkageUsabilityFixture} from '../../tools/linkage-usability-fixture.mjs'
import {buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'
const input={home:[0,1.25,0],sourcePort:[.7,1.25,0],sourceDirection:[1,0,0],mouth:[1.7,1.25,0],targetDirection:[-1,0,0],seat:[3,1.25,0],maximumDrive:[1.085,0,0],heightToleranceMeters:.01,lateralToleranceMeters:.01,angleToleranceDegrees:2}
test('original-stroke path passes through the mouth and rejects a long-extension workaround',()=>{
 const p=buildAdaptiveTransferPath(input);assert.equal(p.mouthFraction,1.7/3);assert.equal(p.totalMeters,3);assert.equal(p.bridgeMeters,0);assert.equal(p.uncoveredMeters,0)
 assert.deepEqual(sampleAdaptiveTransferPath(p,0),input.home);assert.deepEqual(sampleAdaptiveTransferPath(p,p.mouthFraction),input.mouth);assert.deepEqual(sampleAdaptiveTransferPath(p,1),input.seat)
 for(const patch of [{mouth:[3,1.25,0]},{seat:[4,2,0]},{mouth:[1.7,1.25,.2]},{seat:[1,1.25,0]},{targetDirection:[1,0,0]},{maximumDrive:[0,0,0]},{home:[0,NaN,0]},{angleToleranceDegrees:40}])assert.throws(()=>buildAdaptiveTransferPath({...input,...patch}))
 assert.throws(()=>sampleAdaptiveTransferPath(p,NaN));assert.deepEqual(input.home,[0,1.25,0])
 const moved=Object.fromEntries(Object.entries(input).map(([k,v])=>[k,['home','sourcePort','mouth','seat'].includes(k)?v.map((n,i)=>n+(i===0?.01:0)):v]))
 const q=buildAdaptiveTransferPath(moved);assert.ok(Math.abs(q.mouthFraction-p.mouthFraction)<1e-12);assert.equal(sameAdaptiveTransferGeometry(p,q),false,'same fraction must not conceal changed world datums')
 assert.equal(sameAdaptiveTransferGeometry(p,buildAdaptiveTransferPath(input)),true)
})
test('legacy saved cycles keep missing mode missing; adaptive and invalid mode are explicit',()=>{
 const c={...defaultTransferCycle(),enabled:true,startDataItemId:'a',pickupDataItemId:'b',stations:[{value:1,targetDeviceId:'f',side:'primary',presencePointId:'2',seatNodeName:'seat',seatNodeLocal:[0,1.25,0]}]};delete c.handoffMode
 assert.deepEqual(normalizeTransferCycle(c),c);assert.deepEqual(normalizeTransferCycle({...c,handoffMode:'adaptive'}),{...c,handoffMode:'adaptive'})
 assert.throws(()=>normalizeTransferCycle({...c,handoffMode:'invent-physical-reach'}));assert.equal(defaultTransferCycle().handoffMode,'mechanism')
})
class MemoryScene {
 constructor(){this.scene=new T.Scene();this.camera=new T.PerspectiveCamera(38,1,.01,100);this.camera.position.set(4,6,10);this.renderer={domElement:{style:{}}};this.controls={target:new T.Vector3(),mouseButtons:{},touches:{},update(){}}}
 setCutaway(){} release(root){root.traverse(n=>{n.geometry?.dispose();[].concat(n.material||[]).forEach(m=>m.dispose())})}
 dispose(){this.disposed=true;this.release(this.scene)}
}
mock.module('../src/three/CadMotionScene.js',{namedExports:{CadMotionScene:MemoryScene}})
mock.module('../src/runtime/ConfiguredFactoryScene.js',{namedExports:{loadConfiguredGltf:async url=>({scene:(await loadFixtureModel(url.match(/(cad_[a-z0-9_]+)\.glb$/)[1])).root})}})
const {LineSimulationScene}=await import('../src/three/LineSimulationScene.js')

test('one-click actual eight-device demo ignores saved site calibration and completes without stretched carriage or load teleportation',{timeout:120000},async t=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({getContext:()=>({fillRect(){},fillText(){}})})};t.after(()=>globalThis.document=old)
 const f=await createLinkageUsabilityFixture(),before=JSON.stringify(f),plan=buildLineSimulation(f.devices,f.models,{useSavedCycle:false}),scene=new LineSimulationScene()
 try{
  await scene.loadPlan(plan,f.lines,f.workshops,'scheme');assert.equal(plan.rows.length,9);assert.equal(plan.steps.length,100)
  const cart=scene.entries.get(plan.cart.id),rest=cart.rig.node('feed_carriage').position.x
  assert.equal(scene.material.scale.x,cart.scale,'Load dimensions remain proportional to the original hook')
  const at=time=>{assert.equal(scene.applyFrame(sampleLineSimulation(plan,time)).usable,true);return scene.material.getWorldPosition(new T.Vector3())}
  for(const step of plan.steps){
   for(const fraction of [0,.25,.5,.75,1-1e-7]){at(step.start+step.duration*fraction);assert.ok(Math.abs(cart.rig.node('feed_carriage').position.x-rest)<=1.085+.00001)}
   if(step.end<plan.total)assert.ok(at(step.end-1e-6).distanceTo(at(step.end+1e-6))<.001,`${step.name}/${step.kind}: load teleported between phases`)
  }
  at(plan.total);assert.equal(scene.transferBridge,undefined);assert.equal(JSON.stringify(f),before)
 }finally{scene.dispose()}
})
test('actual CAD playback completes both operations at every red-band edge in all three templates, with unchanged original carriage stroke',{timeout:120000},async t=>{
 const old=globalThis.document;globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({fillRect(){},fillText(){}})})};t.after(()=>globalThis.document=old)
 for(const kind of ['single-negative','single-positive','dual'])for(const micro of [0,.25,.5]){
  const f=await createAdaptiveTransferFixture({kind,micro}),source=JSON.stringify(f);assert.equal(f.evidence.band.currentInside,true)
  const plan=buildLineSimulation(f.devices,f.models,{process:false}),scene=new LineSimulationScene();
  try{
   await scene.loadPlan(plan,f.lines,f.workshops,'site');const cart=scene.entries.get(plan.cart.id),body=cart.rig.node('root'),bodyScale=body.scale.toArray(),fixed=cart.wrapper.position.clone()
   for(const station of plan.stations){const dock=scene.dock(station.id),path=scene.adaptivePathFor(cart,scene.entries.get(station.id),dock);assert.ok(Math.abs(dock.bridgeMeters-path.bridgeMeters)<1e-6,'docking and rendered bridge dimensions must share full-span semantics');assert.ok(Math.abs(dock.uncoveredMeters-path.uncoveredMeters)<1e-6)}
   let previous=null,maxStep=0
   for(let time=0;time<=plan.total+.000001;time+=1/30){
    const frame=sampleLineSimulation(plan,time),result=scene.applyFrame(frame);assert.equal(result.usable,true,`${kind}/${micro}/${time}: ${result.reason}`)
    assert.equal(scene.material.visible,true);const position=scene.material.getWorldPosition(new T.Vector3());if(previous)maxStep=Math.max(maxStep,position.distanceTo(previous));previous=position
    assert.deepEqual(body.scale.toArray(),bodyScale)
    if(['feed','retract','pickup_extend','reclaim'].includes(frame.step.kind)){
     const dock=scene.dock(frame.step.deviceId),node=dock.feedSide<0?cart.siteOppositeDriveNode:cart.sitePrimaryDriveNode
     assert.ok(Math.abs(node.position.x-(cart.siteDriveRest.x+cart.siteDriveMaximum.x*frame.cart.feed))<1e-6,`original signed drive stroke must not be stretched: ${node.position.x}`)
    }
   }
   assert.ok(maxStep<.25,`${kind}/${micro}: discontinuous material step ${maxStep}`)
   scene.applyFrame(sampleLineSimulation(plan,plan.total));assert.equal(scene.transferBridge,undefined)
   const expected=cart.wrapper.localToWorld(new T.Vector3(...cart.savedLink.cycle.cartHome));expected.y+=cart.savedLink.materialSize[1]/2;assert.ok(scene.material.getWorldPosition(new T.Vector3()).distanceTo(expected)<1e-6)
   assert.equal(scene.scene.children.filter(n=>n===scene.material).length,1);assert.equal(JSON.stringify(f),source)
   if(kind!=='dual')assert.ok(cart.wrapper.position.distanceTo(fixed)<1e-6)
   const step=plan.steps.find(s=>s.kind==='feed'),hotFrame=sampleLineSimulation(plan,step.start+.5)
   assert.equal(scene.applyFrame(hotFrame).usable,true)
   const station=cart.savedLink.cycle.stations.find(s=>s.targetDeviceId===step.deviceId),rest=station.seatNodeLocal[2]
   station.seatNodeLocal[2]+=.005;assert.equal(scene.applyFrame(hotFrame).usable,false,'hot valid-but-changed path must not move cargo');assert.equal(scene.material.visible,false)
   station.seatNodeLocal[2]=rest;assert.equal(scene.applyFrame(hotFrame).usable,true)
   cart.savedLink.cycle.handoffMode='mechanism';assert.doesNotThrow(()=>scene.dock(plan.stations[0].id));scene.entries.get(plan.stations[0].id).wrapper.position.z*=3;assert.throws(()=>scene.dock(plan.stations[0].id),/推链行程/)
  }finally{scene.dispose()}
 }
})
