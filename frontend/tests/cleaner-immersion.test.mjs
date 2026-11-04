import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {LineSimulationScene} from '../src/three/LineSimulationScene.js'
import {buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'

test('the actual coordinated cleaner lowers the entire load with its deck below the permanent water surface, including transformed instances',async()=>{
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/cad_cleaner_170700.glb',import.meta.url))
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
 const rig=new CadMotionRig(gltf.scene,'cad_cleaner_170700')
 const devices=[{id:'cart',model_type:'cad_transfer_cart_101300'},{id:'cleaner',model_type:'cad_cleaner_170700'}],models=devices.map(d=>({id:d.model_type,file_path:'/'+d.model_type+'.glb'}))
 const scene=Object.create(LineSimulationScene.prototype);scene.plan=buildLineSimulation(devices,models);scene.entries=new Map()
 const cart={row:scene.plan.rows[0],rig:{applyLinked(){}},wrapper:new T.Group(),offset:new T.Group(),port:new T.Vector3(.5,1.4,0),basePosition:new T.Vector3(-5,0,2),baseYaw:0,scale:1}
 const cleaner={row:scene.plan.rows[1],rig,wrapper:new T.Group(),offset:new T.Group(),port:new T.Vector3(0,1.337,1.10),normal:new T.Vector3(0,0,1),scale:1.6}
 cleaner.offset.add(gltf.scene);cleaner.wrapper.add(cleaner.offset);cleaner.wrapper.position.set(24,2,-9);cleaner.wrapper.rotation.y=.8;cleaner.wrapper.scale.setScalar(cleaner.scale);cleaner.wrapper.updateMatrixWorld(true)
 scene.entries.set('cart',cart);scene.entries.set('cleaner',cleaner)
 scene.material=new T.Group();scene.material.add(new T.Mesh(new T.BoxGeometry(.55,.08,.4)),new T.Mesh(new T.BoxGeometry(.4,.24,.25)));scene.material.children[1].position.y=.16
 scene.chain=new T.InstancedMesh(new T.BoxGeometry(.065,.025,.04),new T.MeshBasicMaterial(),160)
 const at=(kind,p=.5)=>{const step=scene.plan.steps.find(s=>s.kind===kind);scene.applyFrame(sampleLineSimulation(scene.plan,step.start+step.duration*p));scene.material.updateMatrixWorld(true)}
 const localLoadBounds=()=>{const box=new T.Box3(),point=new T.Vector3();scene.material.traverse(n=>{if(!n.isMesh)return;const a=n.geometry.attributes.position;for(let i=0;i<a.count;i++)box.expandByPoint(gltf.scene.worldToLocal(point.fromBufferAttribute(a,i).applyMatrix4(n.matrixWorld)))});return box}
 try{
  at('retract');const home=localLoadBounds();assert.ok(home.min.y>1.20)
  const water=()=>rig.bathVolumes.map(n=>[...n.position,...n.scale,n.visible]),waterPose=water()
  const deckHome=new T.Box3().setFromObject(rig.node('internal_rollers')).getCenter(new T.Vector3()).y
  at('lower',.5);const middle=localLoadBounds();assert.ok(Math.abs(home.min.y-middle.min.y-.4)<1e-6)
  at('spray');const submerged=localLoadBounds();assert.ok(submerged.max.y<1.20&&submerged.min.y>.106,'whole real load stays within the filled central tank')
  assert.ok(submerged.min.x>-.609&&submerged.max.x<.609&&submerged.min.z>-.954&&submerged.max.z<.954)
  assert.ok(Math.abs(deckHome-new T.Box3().setFromObject(rig.node('internal_rollers')).getCenter(new T.Vector3()).y-1.6*.8)<1e-6)
  assert.deepEqual(water(),waterPose);assert.equal(rig.cleanerCharge.visible,false,'line has one material load, without a duplicate preview charge')
  at('open_out');assert.ok(localLoadBounds().min.y>1.20);assert.deepEqual(water(),waterPose)
 }finally{rig.dispose()}
})
