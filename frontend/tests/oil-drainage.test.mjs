import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'

async function loadRig(id){
 const bytes=fs.readFileSync(new URL(`../../backend/assets/models/${id}.glb`,import.meta.url))
 const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
 return new CadMotionRig(gltf.scene,id)
}

test('600 furnace drains sparse glossy amber beads and thinning oil necks back into its bath',async()=>{
 const rig=await loadRig('cad_multipurpose_furnace_082000')
 try{
  assert.equal(rig.water.visible,true);assert.ok(rig.water.material.color.r>rig.water.material.color.b,'the permanent quench bath is oil, rather than blue water')
  const snapshot=time=>{
   rig.applyLinked({drip:true,time})
   return [...rig.drops.children,...rig.oilFilaments.children].map(node=>[node.visible,...node.position,...node.scale])
  }
  snapshot(0);const first=rig.drops.children.filter(drop=>drop.visible)
  assert.ok(first.length>0&&first.length<=8,'oil must not look like a dense shower')
  assert.ok(rig.dropMaterial.color.r>rig.dropMaterial.color.g&&rig.dropMaterial.color.g>rig.dropMaterial.color.b,'oil is amber/brown rather than blue')
  assert.ok(rig.dropMaterial.roughness<.35,'oil keeps a glossy surface')
  rig.drops.children[0].geometry.computeBoundingBox()
  const size=rig.drops.children[0].geometry.boundingBox.getSize(new T.Vector3());assert.ok(size.y>size.x,'oil beads have a stretched tip')
  assert.ok(rig.oilFilaments.children.some(thread=>thread.visible),'viscous necks briefly remain attached')
  const earlier=snapshot(2);snapshot(6);assert.ok(rig.drops.children.filter(drop=>drop.visible).length<first.length,'draining becomes less frequent')
  assert.deepEqual(snapshot(2),earlier,'seeking reproduces the same oil drops')
  for(const drop of rig.drops.children.filter(node=>node.visible)){
   assert.ok(Math.abs(drop.position.x)<.3)
   assert.ok(drop.position.z<-.45&&drop.position.z>-1.5,'drops fall over the actual oil bath, not Z=0')
   assert.ok(drop.position.y-.016*drop.scale.y>rig.fluid.max,'drops disappear at the bath surface')
   assert.ok(drop.position.y<1.44,'oil emerges below the basket instead of inside its roller structure')
  }
  rig.applyLinked({drip:true,time:2,basket:1});assert.equal(rig.drops.visible,false);assert.equal(rig.oilFilaments.visible,false,'submerged charge must not drip in mid-water')
  rig.apply('basket_up',4);assert.ok(rig.drops.visible);rig.reset();assert.equal(rig.drops.visible,false);assert.equal(rig.oilFilaments.visible,false)
 }finally{rig.dispose()}
})

test('water-cooling tank retains its blue water droplets and has no oil filaments',async()=>{
 const rig=await loadRig('cad_water_cooling_tank_471000')
 try{
  rig.apply('basket_up',4)
  assert.ok(rig.dropMaterial.color.b>rig.dropMaterial.color.r)
  assert.equal(rig.oilFilaments,undefined);assert.equal(rig.drops.children.filter(drop=>drop.visible).length,60)
 }finally{rig.dispose()}
})
