import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {LineSimulationScene} from '../src/three/LineSimulationScene.js'
import {buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'
import {measureEquipmentLoadCenters} from '../src/three/equipmentLoadCenter.js'
import {CAD_CUTAWAY_SUFFIXES,collectCutawayMaterials} from '../src/three/cadCutaway.js'
import {CadMotionScene} from '../src/three/CadMotionScene.js'

test('the actual coordinated cleaner lowers the entire load with its deck below the permanent water surface, including transformed instances',async()=>{
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/cad_cleaner_170700.glb',import.meta.url))
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
 const loadCenters=measureEquipmentLoadCenters(gltf.scene,'cad_cleaner_170700')
 const rig=new CadMotionRig(gltf.scene,'cad_cleaner_170700')
 const devices=[{id:'cart',model_type:'cad_transfer_cart_101300'},{id:'cleaner',model_type:'cad_cleaner_170700'}],models=devices.map(d=>({id:d.model_type,file_path:'/'+d.model_type+'.glb'}))
 const scene=Object.create(LineSimulationScene.prototype);scene.plan=buildLineSimulation(devices,models);scene.entries=new Map()
 const cart={row:scene.plan.rows[0],rig:{applyLinked(){}},wrapper:new T.Group(),offset:new T.Group(),port:new T.Vector3(.5,1.4,0),basePosition:new T.Vector3(-5,0,2),baseYaw:0,scale:1}
 const cleaner={row:scene.plan.rows[1],rig,asset:gltf.scene,loadCenters,wrapper:new T.Group(),offset:new T.Group(),port:new T.Vector3(0,1.337,1.10),normal:new T.Vector3(0,0,1),scale:1.6}
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
  at('immersion');const submerged=localLoadBounds();assert.ok(submerged.max.y<1.20&&submerged.min.y>.106,'whole real load stays within the filled central tank')
  assert.ok(submerged.min.x>-.609&&submerged.max.x<.609&&submerged.min.z>-.954&&submerged.max.z<.954)
  assert.ok(Math.abs(deckHome-new T.Box3().setFromObject(rig.node('internal_rollers')).getCenter(new T.Vector3()).y-1.6*.8)<1e-6)
  assert.deepEqual(water(),waterPose);assert.equal(rig.cleanerCharge.visible,false,'line has one material load, without a duplicate preview charge')
  at('raise',.5);assert.ok(Math.abs(localLoadBounds().min.y-home.min.y+.4)<1e-6);assert.equal(rig.drops.visible,false,'no fresh-water jets during raising')
  at('spray');assert.ok(localLoadBounds().min.y>1.20,'rinse the load only after it is fully raised');assert.ok(Math.abs(new T.Box3().setFromObject(rig.node('internal_rollers')).getCenter(new T.Vector3()).y-deckHome)<1e-6);assert.equal(rig.drops.visible,true)
  at('open_out');assert.ok(localLoadBounds().min.y>1.20);assert.deepEqual(water(),waterPose)
 }finally{rig.dispose()}
})

test('the lower cleaner bath stays connected below its normal top covers, without internal partitions or an immersion shelf',async()=>{
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/cad_cleaner_170700.glb',import.meta.url))
 const {scene:root}=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
 root.updateMatrixWorld(true)
 const shell=root.getObjectByName('cad_washing_machine_v1_central_lower_body')
 assert.ok(shell,'unified lower tank exists')
 // Cast through the former three separate compartments. Water must be able to
 // cross both former gaps, and a vertical path must reach the common bottom.
 for(const y of [.35,.7,1.05]){
  const hits=new T.Raycaster(new T.Vector3(-1.2,y,0),new T.Vector3(1,0,0),0,2.4).intersectObject(shell,true)
  assert.equal(hits.length,0,'no longitudinal walls divide the bath at '+y)
 }
 for(const x of [-1.0,-.68,0,.68,1.0]){
  const hits=new T.Raycaster(new T.Vector3(x,1.18,0),new T.Vector3(0,-1,0),0,1.2).intersectObject(shell,true)
  assert.ok(hits.length>0,'one common tank floor under '+x)
  assert.ok(hits[0].point.y<.12,'no central lid or shelf under the loading basket')
 }
 const rig=new CadMotionRig(root,'cad_cleaner_170700')
 try{
  assert.equal(rig.bathVolumes.length,1,'the water surface is a single connected volume')
  const water=new T.Box3().setFromObject(rig.bathVolumes[0])
  assert.ok(water.min.x<-1.25&&water.max.x>1.25,'water covers the full width including both former gaps')
  const before=[...rig.water.position,...rig.water.scale]
  rig.apply('basket_down',8)
  assert.deepEqual([...rig.water.position,...rig.water.scale],before,'basket immersion does not split or move the bath')
 }finally{rig.dispose()}
})

test('the actual cleaner has opaque top covers outside its chamber, and the manual cutaway includes those covers',async()=>{
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/cad_cleaner_170700.glb',import.meta.url))
 const {scene:root}=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
 root.updateMatrixWorld(true)
 const shell=root.getObjectByName('cad_washing_machine_v1_central_lower_body')
 assert.ok(shell)
 for(const x of [-1.02,-.68,.68,1.02])for(const z of [-.7,0,.7]){
  const hits=new T.Raycaster(new T.Vector3(x,2,z),new T.Vector3(0,-1,0),0,2).intersectObject(shell,true)
  assert.ok(hits.length>0,'solid cover above the exposed tank area '+x+','+z)
  assert.ok(hits[0].point.y>1.23&&hits[0].point.y<1.30,'cover is above the water, not a wall or bottom')
  const material=[].concat(hits[0].object.material)[hits[0].face.materialIndex]
  assert.equal(material.transparent,false);assert.equal(material.opacity,1)
 }
 const opening=new T.Raycaster(new T.Vector3(0,2,0),new T.Vector3(0,-1,0),0,1).intersectObject(shell,true)
 assert.equal(opening.length,0,'the central chamber must stay open internally for the immersion stroke')
 const materials=collectCutawayMaterials(root,CAD_CUTAWAY_SUFFIXES.map(s=>'cad_washing_machine_v1_'+s))
 const covers=new Set();shell.traverse(node=>{if(node.isMesh)for(const m of [].concat(node.material))covers.add(m)})
 assert.ok([...covers].every(material=>materials.includes(material)),'top cover materials respond to the existing explicit internal-view switch')
 const preview={shell:materials}
 CadMotionScene.prototype.setCutaway.call(preview,true)
 assert.ok([...covers].every(material=>material.transparent&&material.opacity<=.16),'the manual internal-view control reveals the covered tank')
 CadMotionScene.prototype.setCutaway.call(preview,false)
 assert.ok([...covers].every(material=>!material.transparent&&material.opacity===1),'turning the control off restores the original opaque covers')
 materials.forEach(material=>material.dispose())
})
