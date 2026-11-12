import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {LineSimulationScene} from '../src/three/LineSimulationScene.js'
import {buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'
import {restoreGltfNodeNames} from '../src/three/gltfNodeIdentity.js'

test('actual mounted hook contacts the tray edge during loading and pulling, and releases for empty return',async()=>{
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/cad_transfer_cart_101300.glb',import.meta.url))
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');restoreGltfNodeNames(gltf)
 const rig=new CadMotionRig(gltf.scene,'cad_transfer_cart_101300')
 const devices=[{id:'cart',name:'cart',model_type:'cad_transfer_cart_101300'},{id:'station',name:'station',model_type:'cad_cleaner_170700'}]
 const models=devices.map(d=>({id:d.model_type,file_path:'/'+d.model_type+'.glb'})),plan=buildLineSimulation(devices,models)
 const scene=Object.create(LineSimulationScene.prototype);scene.plan=plan;scene.entries=new Map()
 const cart={row:plan.rows.find(r=>r.id==='cart'),rig,asset:gltf.scene,wrapper:new T.Group(),offset:new T.Group(),scale:1,feedDirection:-1,port:new T.Vector3(-.685,1.405,0),basePosition:new T.Vector3(6,0,2),baseYaw:0}
 cart.offset.add(gltf.scene);cart.wrapper.add(cart.offset)
 const station={row:plan.rows.find(r=>r.id==='station'),rig:{applyLinked(){}},wrapper:new T.Group(),offset:new T.Group(),scale:1,normal:new T.Vector3(1,0,0),port:new T.Vector3(0,1.405,0)}
 scene.entries.set('cart',cart);scene.entries.set('station',station)
 scene.material=new T.Group();scene.material.add(new T.Mesh(new T.BoxGeometry(.55,.08,.4)))
 scene.chain=new T.InstancedMesh(new T.BoxGeometry(.065,.025,.04),new T.MeshBasicMaterial(),160)
 const hook=rig.node('hook_latch'),guide=rig.node('pusher_metal')
 const sample=(kind,fraction)=>{const step=plan.steps.find(s=>s.kind===kind);const frame=sampleLineSimulation(plan,step.start+step.duration*fraction);scene.applyFrame(frame);cart.wrapper.updateMatrixWorld(true);return frame}
 const snapshot=()=>[...scene.material.position,...new T.Box3().setFromObject(hook).min,...guide.matrixWorld.elements]
 try{
  let firstGuide
  for(const kind of ['feed','reclaim'])for(const fraction of [.01,.25,.5,.75,.99]){
   sample(kind,fraction)
   assert.ok(Math.abs(hook.rotation.z)<1e-7,'hook engages while pushing or pulling')
   const tip=new T.Box3().setFromObject(hook).min.x,backOfTray=scene.material.position.x+.275
   assert.ok(Math.abs(tip-backOfTray)<.00001,`${kind} ${fraction}: actual hook geometry must meet the trailing tray edge`)
   if(!firstGuide)firstGuide=guide.matrixWorld.clone()
   assert.ok(guide.matrixWorld.equals(firstGuide),'the fixed guide cannot travel with the hook')
  }
  for(const kind of ['retract','pickup_extend']){
   sample(kind,.5);assert.ok(Math.abs(hook.rotation.z+.65)<1e-7,'empty travel releases the hook')
  }
  const at=(kind,fraction)=>{sample(kind,fraction);return scene.material.position.clone()}
  for(const [a,b] of [['feed','retract'],['retract','close'],['pickup_extend','reclaim'],['reclaim','close_out']]){
   // Just before/after a phase boundary must not teleport the load.
   assert.ok(at(a,1-1e-7).distanceTo(at(b,1e-7))<.00001,`${a} -> ${b}: cargo jumps at the handoff`)
  }
  sample('feed',.4);const original=snapshot();sample('reclaim',.8);sample('feed',.4)
  snapshot().forEach((value,index)=>assert.ok(Math.abs(value-original[index])<1e-7,'seeking cannot depend on the previous frame'))
 }finally{rig.dispose()}
});
