import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as T from 'three'
import { PortableMotionPlayer } from '../src/three/PortableMotionPlayer.js'
const require = createRequire(import.meta.url), { compile, validateActions } = require('../../backend/services/motionAuthoring.js')
function fixture(overrides = {}) {
  const rest = { name:'moving', p:[1,2,3], q:[0,0,0,1], s:[1,1,1], v:[1], c0:[.1,.2,.3,1], ...overrides }
  return { sourceSha256:'a'.repeat(64), rig:Buffer.from('owned test rig'), base:{ schemaVersion:1, modelId:'fixture', nodes:[rest], clips:[] }, nodes:[{ id:'0',label:'moving',...rest }] }
}
function recipe(operation, overrides={}) { return { id:'user_fixture',label:'新工艺动作',mode:'position',duration:2,cycle:'forward',tracks:[{nodeId:'0',operation,axis:'y',from:0,to:1,start:0,end:1,easing:'linear',pivot:[0,0,0],fromColor:'#000000',toColor:'#ffffff',...overrides}] } }
const build = (action, prepared=fixture()) => compile({id:'fixture',file_path:'/uploads/models/fixture.glb'},prepared,[action])
function sample(action, progress, prepared=fixture()) {
  const compiled=build(action,prepared),root=new T.Group(),node=new T.Mesh(new T.BoxGeometry(),new T.MeshStandardMaterial());node.name='moving';node.position.fromArray(prepared.nodes[0].p);node.quaternion.fromArray(prepared.nodes[0].q);node.scale.fromArray(prepared.nodes[0].s);root.add(node)
  const player=new PortableMotionPlayer(root,compiled.data,[{actionId:'clip:user_fixture',clipId:'user_fixture',kind:'clip',mode:'position',enabled:true,sourceGroup:'analog',sourceKey:'stroke',inputMin:0,inputMax:1,speed:1,transitionSeconds:0}])
  player.receive({analog:{stroke:progress}},0);player.advance(.001,0);return {node,compiled}
}
test('new authoring recipes compile directly to the existing portable player, preserving source pose and partial stroke',()=>{
  const {node}=sample(recipe('translate',{to:4}),.25);assert.deepEqual(node.position.toArray(),[1,3,3])
})
test('independent start/end timing and smooth interpolation hold outside the configured stroke',()=>{
  const action=recipe('translate',{to:4,start:.25,end:.75,easing:'smooth'})
  assert.equal(sample(action,0).node.position.y,2);assert.equal(sample(action,.5).node.position.y,4);assert.equal(sample(action,1).node.position.y,6)
})
test('running recipes can ping-pong without changing the portable Unity schema',()=>{
  const action={...recipe('translate',{to:2}),mode:'running',cycle:'pingpong'}
  assert.equal(sample(action,0).node.position.y,2);assert.equal(sample(action,.5).node.position.y,4);assert.equal(sample(action,1).node.position.y,2)
})
test('rotation uses sampled quaternions, including full revolutions',()=>{
  const action=recipe('rotate',{axis:'z',to:360}),{node,compiled}=sample(action,.25)
  assert.ok(node.quaternion.angleTo(new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),Math.PI/2))<1e-6)
  const values=compiled.data.clips[0].tracks[0].values;for(let i=4;i<values.length;i+=4)assert.ok(new T.Quaternion().fromArray(values,i).dot(new T.Quaternion().fromArray(values,i-4))>.99)
})
test('off-origin rotation keeps its pivot fixed, even with nonuniform source scale',()=>{
  const prepared=fixture({p:[0,1,0],s:[2,3,4]}),{node}=sample(recipe('rotate',{axis:'z',to:90,pivot:[1,0,0]}),1,prepared);node.updateMatrixWorld()
  assert.ok(node.localToWorld(new T.Vector3(1,0,0)).distanceTo(new T.Vector3(2,1,0))<1e-6)
})
test('scale, visibility and material color share the native portable channels',()=>{
  assert.deepEqual(sample(recipe('scale',{axis:'x',from:1,to:2}),1).node.scale.toArray(),[2,1,1])
  assert.equal(sample(recipe('visibility',{from:1,to:0}),1).node.visible,false)
  const {node}=sample(recipe('color'),.5);assert.ok(Math.abs(node.material.color.r-.5)<1e-6);assert.equal(node.material.opacity,1)
})
test('bad channels, missing nodes, unsafe values and conflicting tracks are rejected before publish',()=>{
  for(const change of [{nodeId:'missing'},{to:Infinity},{operation:'javascript'},{start:.8,end:.2},{pivot:[0,NaN,0]},{from:0,to:0,operation:'scale'}])assert.throws(()=>build(recipe('translate',change)))
  const action=recipe('translate');action.tracks.push({...action.tracks[0],axis:'x'});assert.throws(()=>validateActions([action],fixture()),/同一通道/)
})
test('original clips remain immutable and separately selectable',()=>{
  const prepared=fixture();prepared.base.clips=[{id:'door',label:'原有门',mode:'position',duration:1,count:2,tracks:[]}];const before=JSON.stringify(prepared)
  const result=build(recipe('translate'),prepared);assert.equal(result.bundle.actions.length,2);assert.equal(result.bundle.actions[0].id,'door');assert.equal(JSON.stringify(prepared),before)
})
