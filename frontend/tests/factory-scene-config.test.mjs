import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { buildFactoryScenePlan, nativeCameraPose, nativeDeviceTransform, nativeLayoutTransform, factorySceneSignature } from '../src/runtime/factorySceneConfig.js'
import { buildConfiguredFactoryScene } from '../src/runtime/ConfiguredFactoryScene.js'

function fixture() {
  return {models:[{id:'factory_hall_lowpoly',asset_type:'environment',file_path:'/hall.glb'},{id:'furnace',default_scale:2,file_path:'/furnace.glb'}],workshops:[
    {id:'ws',layout:{transform:{x:20,y:2,z:30,rotationY:90},size:{width:200,depth:100}},lines:[
      {id:'line',layout:{transform:{x:3,y:1,z:5,rotationY:25}},devices:[{id:'f1',model_type:'furnace',pos_x:1,pos_y:2,pos_z:3,rotation_y:Math.PI/2,scale:3,instance_config:{scaleMultiplier:.5,mirrorX:true}}]},
      {id:'pending',layout:{placementPending:true},devices:[{id:'unplaced'}]}],devices:[{id:'cart',name:'辅助车',model_type:'furnace',instance_config:JSON.stringify({railLineId:'line'})}]}]}
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`)
test('scene plan uses backend hierarchy, deduplicates IDs and keeps auxiliary devices',()=>{
  const source=fixture(),before=JSON.stringify(source),plan=buildFactoryScenePlan(source)
  assert.equal(JSON.stringify(source),before)
  assert.deepEqual(plan.devices.map(d=>d.id),['f1','cart'])
  assert.equal(plan.devices[1].lineId,'line')
  assert.deepEqual(plan.workshops[0].hall.scale,[2,1,1.25])
  assert.deepEqual(plan.devices[0].transform.scale,[-3,3,3])
  assert.equal(plan.devices[0].url,'http://127.0.0.1:3001/furnace.glb')
  source.workshops[0].devices.push({...source.workshops[0].lines[0].devices[0]})
  assert.equal(buildFactoryScenePlan(source).devices.length,2)
})
test('Unity X reflection and yaw conversion compose identically through both parent levels',()=>{
  const source=fixture(),plan=buildFactoryScenePlan(source)
  const transforms=[plan.workshops[0].transform,plan.lines[0].transform,plan.devices[0].transform]
  const threeWorld=new THREE.Matrix4()
  for(const t of transforms) threeWorld.multiply(new THREE.Matrix4().compose(new THREE.Vector3(t.position.x,t.position.y,t.position.z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),t.yaw),new THREE.Vector3(...t.scale)))
  const reflection=new THREE.Matrix4().makeScale(-1,1,1),unityWorld=new THREE.Matrix4()
  for(const t of transforms) unityWorld.multiply(new THREE.Matrix4().compose(new THREE.Vector3(-t.position.x,t.position.y,t.position.z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-t.yaw),new THREE.Vector3(...t.scale)))
  const expected=reflection.clone().multiply(unityWorld).multiply(reflection)
  threeWorld.elements.forEach((n,i)=>close(n,expected.elements[i]))
})
test('device degree/radian inputs and explicit mirror false match the native rules',()=>{
  close(nativeDeviceTransform({rotation_y:90}).yaw,Math.PI/2)
  close(nativeDeviceTransform({rotation_y:1.5708}).yaw,1.5708)
  assert.deepEqual(nativeDeviceTransform({instance_config:{mirrorX:false,mirror_x:true}}).scale,[1,1,1])
  assert.equal(nativeLayoutTransform('{"transform":{"rotationY":-30}}').yaw,-Math.PI/6)
})
test('native perspective fit honors published offset and the actual .65 distance floor',()=>{
  const bounds=new THREE.Box3(new THREE.Vector3(-100,0,-50),new THREE.Vector3(100,8,50))
  const pose=nativeCameraPose(bounds,{camera:{yaw:0,pitch:30,distanceScale:.1,targetOffset:[2,3,4]}})
  close(pose.distance,Math.hypot(100,4,50)/Math.sin(19*Math.PI/180)*.65)
  assert.deepEqual(pose.target,{x:-2,y:7.5,z:4})
  close(pose.position.x,-2);close(pose.position.y,7.5+pose.distance*.5)
  assert.equal(pose.fov,38)
  assert.ok(pose.position.z<pose.target.z)
})
test('configuration signature changes for add/delete/move/model/scale, but not PLC point metadata',()=>{
  const source=fixture(),baseline=factorySceneSignature(buildFactoryScenePlan(source))
  source.workshops[0].lines[0].devices[0].dataPoints=[{id:99}]
  assert.equal(factorySceneSignature(buildFactoryScenePlan(source)),baseline)
  source.workshops[0].lines[0].devices[0].pos_x=32
  assert.notEqual(factorySceneSignature(buildFactoryScenePlan(source)),baseline)
  source.models[1].file_path='/new.glb'
  assert.ok(factorySceneSignature(buildFactoryScenePlan(source)).includes('/new.glb'))
})
test('scene builder preserves authored mesh origins and scale and projects one anchor per device',async()=>{
  const plan=buildFactoryScenePlan(fixture())
  const load=async()=>{const root=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(2,4,6),new THREE.MeshBasicMaterial());mesh.position.set(5,2,0);root.add(mesh);return {scene:root}}
  const result=await buildConfiguredFactoryScene(plan,{load})
  const device=result.devices.get('f1')
  assert.equal(device.children[0].children[0].position.x,5,'never recenter imported equipment')
  assert.deepEqual(device.scale.toArray(),[-3,3,3])
  assert.equal(result.anchors.length,2)
  const box=new THREE.Box3().setFromObject(device)
  assert.ok(result.anchors[0].position.y>box.max.y)
  assert.deepEqual(result.errors,[])
  result.dispose()
})
test('missing assets remain counted with an explicit placeholder; cancelled generations are reclaimed',async()=>{
  const source=fixture();source.workshops[0].layout.boundary={enabled:false}
  const plan=buildFactoryScenePlan(source)
  const failed=await buildConfiguredFactoryScene(plan,{load:async()=>{throw new Error('404')}})
  assert.equal(failed.devices.size,2);assert.equal(failed.errors.length,2)
  assert.ok(failed.anchors.every(a=>a.missingAsset));failed.dispose()
  const cancelled=await buildConfiguredFactoryScene(plan,{cancelled:()=>true})
  assert.equal(cancelled,null)
})
