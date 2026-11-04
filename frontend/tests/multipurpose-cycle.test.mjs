import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'
import {MULTIPURPOSE_CYCLE_DURATION} from '../src/three/multipurposeProcess.js'
import {sampleMotionTrack} from '../src/three/PortableMotionPlayer.js'
const id='cad_multipurpose_furnace_082000'
const plan=buildLineSimulation([{id:'cart',model_type:'transfer_cart'},{id:'furnace',model_type:id}],[{id,file_path:'/furnace.glb'}])
const at=(kind,p=.5)=>{const step=plan.steps.find(s=>s.kind===kind);return sampleLineSimulation(plan,step.start+step.duration*p)}
test('multipurpose furnace loads front, processes rear, returns front, quenches, rises and drains before unloading',()=>{
 assert.equal(plan.total,MULTIPURPOSE_CYCLE_DURATION)
 assert.deepEqual(plan.steps.map(s=>s.kind),['approach','open','feed','retract','close','gate_open','hot_feed','gate_close','heat_treat','gate_open_return','hot_return','gate_close_return','lower','quench','raise','drip','open_out','pickup_extend','reclaim','close_out'])
 const s=kind=>at(kind).states.furnace
 assert.equal(s('feed').door,1);assert.equal(s('feed').gate,0);assert.equal(s('feed').chamber,0);assert.equal(s('feed').basket,0)
 assert.equal(at('retract').material.holder,'furnace');assert.equal(s('gate_open').door,0)
 assert.equal(s('hot_feed').chamber,.5);assert.equal(s('hot_feed').gate,1);assert.equal(s('hot_feed').basket,0)
 assert.equal(s('heat_treat').chamber,1);assert.equal(s('heat_treat').gate,0);assert.equal(s('heat_treat').heat,true)
 assert.equal(s('hot_return').chamber,.5);assert.equal(s('hot_return').gate,1);assert.ok(s('hot_return').conveyTime<at('hot_feed',1).states.furnace.conveyTime,'rear rollers reverse for the return journey')
 for(const kind of ['lower','quench','raise','drip']){assert.equal(s(kind).chamber,0);assert.equal(s(kind).gate,0);assert.equal(s(kind).door,0);assert.equal(at(kind).material.holder,'furnace')}
 assert.equal(s('quench').basket,1);assert.equal(s('raise').basket,.5);assert.equal(s('drip').basket,0);assert.equal(s('drip').drip,true)
 const drain=plan.steps.find(s=>s.kind==='drip'),out=plan.steps.find(s=>s.kind==='open_out');assert.ok(drain.duration>=8);assert.equal(out.start,drain.end)
 assert.equal(s('reclaim').door,1);assert.equal(at('reclaim').material.to,'cart');assert.equal(sampleLineSimulation(plan,plan.total).material.holder,'cart')
})
test('complete-cycle preview uses the same process and physically submerges the front-chamber charge before draining',async()=>{
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/'+id+'.glb',import.meta.url)),g=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''),rig=new CadMotionRig(g.scene,id)
 const sample=(kind,p=.5)=>{const step=rig.processPlan.steps.find(s=>s.kind===kind);return rig.apply('process_cycle',step.start+step.duration*p)}
 try{
  assert.match(sample('retract').stage,/前室|推链/);assert.ok(Math.abs(rig.charge.position.z+.985)<1e-6)
  sample('heat_treat');assert.ok(Math.abs(rig.charge.position.z+3.05)<1e-6);assert.equal(rig.node('intermediate_gate').position.y,0)
  sample('hot_return',1);assert.ok(Math.abs(rig.charge.position.z+.985)<1e-6)
  sample('quench');assert.ok(new T.Box3().setFromObject(rig.charge).max.y<rig.fluid.max);assert.ok(rig.charge.position.y>.14)
  sample('drip');assert.ok(rig.drops.visible);assert.ok(new T.Box3().setFromObject(rig.charge).min.y>=1.25-1e-6);assert.equal(rig.node('door').position.y,0)
  sample('reclaim',1);assert.ok(rig.charge.position.z>1)
  sample('heat_treat');const snapshot=[...rig.charge.position,...rig.node('intermediate_gate').position];sample('quench');sample('heat_treat');assert.deepEqual([...rig.charge.position,...rig.node('intermediate_gate').position],snapshot)
  rig.reset();assert.equal(rig.charge.visible,false);assert.equal(rig.cyclePallet.visible,false)
  rig.applyLinked({previewCharge:true,chamber:1});assert.equal(rig.charge.visible,true);assert.ok(Math.abs(rig.charge.position.z+3.05)<1e-6,'without a selected cart the material still appears in the correct chamber')
 }finally{rig.dispose()}
})
test('portable full-cycle animation keeps the full duration and front/rear/oil-bath positions',()=>{
 const data=JSON.parse(fs.readFileSync(new URL('../../backend/assets/motions/'+id+'.json',import.meta.url))),clip=data.clips.find(c=>c.id==='process_cycle'),track=clip.tracks.find(t=>t.node==='preview_internal_charge'&&t.channel==='p')
 assert.equal(clip.duration,plan.total);assert.equal(clip.mode,'running')
 const position=kind=>{const step=plan.steps.find(s=>s.kind===kind);return sampleMotionTrack(clip,track,step.start+step.duration/2)}
 assert.ok(Math.abs(position('heat_treat')[2]+3.05)<1e-6)
 assert.ok(Math.abs(position('quench')[2]+.985)<1e-6);assert.ok(Math.abs(position('quench')[1]-.67)<1e-6)
 assert.ok(Math.abs(position('drip')[1]-1.47)<1e-6);assert.ok(Math.abs(position('drip')[2]+.985)<1e-6)
})
