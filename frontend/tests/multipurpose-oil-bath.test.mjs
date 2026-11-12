import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {CadMotionScene} from '../src/three/CadMotionScene.js'
import {CAD_CUTAWAY_SUFFIXES,collectCutawayMaterials} from '../src/three/cadCutaway.js'

const prefix='cad_multipurpose_furnace_600_v1_'
async function load(){
 const bytes=fs.readFileSync(new URL('../../backend/assets/models/cad_multipurpose_furnace_082000.glb',import.meta.url))
 return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')).scene
}
test('one full-width oil pool contains both rotating impellers above the common bottom, with fixed motors',async()=>{
 const root=await load();root.updateMatrixWorld(true)
 assert.ok(!root.getObjectByName(prefix+'tank_baffles'),'the former internal partitions are removed from actual geometry')
 const surface=new T.Box3().setFromObject(root.getObjectByName(prefix+'quench_liquid'))
 assert.ok(surface.min.x<-1.25&&surface.max.x>1.25,'source oil surface covers the side agitators as well as the central basket')
 const rig=new CadMotionRig(root,'cad_multipurpose_furnace_082000')
 try{
  const motor=rig.node('agitators_teal');root.updateMatrixWorld(true);const motorPose=motor.matrixWorld.clone()
  const before=rig.multiAgitators.map(n=>n.quaternion.clone())
  for(const time of [0,.13,.37,.91,2.1]){
   rig.apply('agitator',time);root.updateMatrixWorld(true)
   const oil=new T.Box3().setFromObject(rig.water);let blades=0
   for(const shaft of rig.multiAgitators)for(const child of shaft.children){
    if(!child.name.includes('agitator_impellers'))continue
    const blade=new T.Box3().setFromObject(child)
    assert.ok(oil.containsBox(blade),'every rotating blade remains inside the oil at '+time)
    blades++
   }
   assert.equal(blades,6);assert.ok(motor.matrixWorld.equals(motorPose),'motor housings remain fixed')
  }
  assert.ok(rig.multiAgitators.every((n,i)=>!n.quaternion.equals(before[i])),'both submerged impellers rotate')
  assert.equal(rig.node('quench_liquid').visible,false,'an opaque duplicate oil plane must not hide the real oil volume')
  assert.ok(rig.water.material.transparent&&rig.water.material.opacity<=.3,'oil permits side-view inspection')
 }finally{rig.dispose()}
})

test('ordinary internal cutaway exposes oil from the side, front and rear without requiring oil closeup mode',async()=>{
 const root=await load(),scene=Object.create(CadMotionScene.prototype)
 const originals=new Map();root.traverse(n=>{if(n.isMesh)originals.set(n,[].concat(n.material).map(m=>m.opacity))})
 scene.shell=collectCutawayMaterials(root,CAD_CUTAWAY_SUFFIXES.map(s=>prefix+s));scene.oilDoorShell=[];scene.oilView=false
 scene.setCutaway(true)
 for(const suffix of ['quench_tank','tank_lids','agitator_lids','cold_front_hatches','cold_rear_hatches']){
  const group=root.getObjectByName(prefix+suffix);assert.ok(group,suffix)
  group.traverse(n=>{if(n.isMesh)for(const m of [].concat(n.material))assert.ok(m.transparent&&m.opacity<=.16&&!m.depthWrite,suffix+' must be transparent in ordinary action previews')})
 }
 scene.setCutaway(false)
 for(const [node,opacities] of originals)assert.deepEqual([].concat(node.material).map(m=>m.opacity),opacities,'turning off cutaway restores the authored shell')
})
