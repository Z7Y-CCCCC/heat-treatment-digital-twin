import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CAD_MOTION_PROFILES} from '../src/three/cadMotionProfiles.js'
import {connectedGeometryParts} from '../src/three/cadGeometryParts.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {TRANSFER_ALIGNMENT} from '../../shared/equipmentTransferDatum.mjs'
const rollers={cad_tempering_furnace_091300:'internal_rollers',cad_cleaner_170700:'internal_rollers',cad_multipurpose_furnace_082000:'elevator_basket',cad_water_cooling_tank_471000:'basket',cad_lifting_load_table_111400:'roller_bed',cad_fixed_load_table_112200:'roller_bed',cad_transfer_cart_101300:'roller_bed',cad_air_cooling_table_115800ht:'roller_bed'}
for(const [id,suffix] of Object.entries(rollers))test(`${id}: true roller crowns are at 1.25m, bases stay grounded and transfer mechanisms remain connected`,async()=>{
 const b=fs.readFileSync(new URL('../../backend/assets/models/'+id+'.glb',import.meta.url)),g=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),''),prefix=CAD_MOTION_PROFILES[id].prefix
 g.scene.updateMatrixWorld(true);const box=new T.Box3().setFromObject(g.scene);assert.ok(Math.abs(box.min.y)<1e-6,'base remains on the floor')
 const root=g.scene.getObjectByName(prefix+'root');assert.equal(root.userData.transferAlignment.surfaceY,1.25)
 const parts=connectedGeometryParts(g.scene.getObjectByName(prefix+suffix+'_stainless')).filter(p=>p.size.y>.05&&p.size.y<.12&&Math.abs(Math.min(p.size.x,p.size.z)-p.size.y)<1e-5)
 assert.ok(parts.length>=7);for(const part of parts)assert.ok(Math.abs(part.center.y+part.size.y/2-1.25)<1e-6,'every roller supports the same level')
 const metadata=JSON.parse(fs.readFileSync(new URL('../../backend/assets/models/'+id+'_metadata.json',import.meta.url)));assert.equal(metadata.sourceAsset.sha256,crypto.createHash('sha256').update(b).digest('hex'))
 const rig=new CadMotionRig(g.scene,id)
 try{
  assert.equal(rig.transferAlignment.loadY,1.29)
  if(id==='cad_transfer_cart_101300')assert.ok(new T.Box3().setFromObject(rig.node('pusher_steel')).max.y<=1.25,'central carriage must not intersect the tray floor')
  if(['cad_water_cooling_tank_471000','cad_multipurpose_furnace_082000'].includes(id)){
   rig.applyLinked({basket:1,level:1});const basket=rig.node(suffix),bounds=new T.Box3().setFromObject(basket)
   assert.ok(bounds.min.y>.14,'lowered frame stays above the bath floor');assert.ok(bounds.max.y<rig.fluid.max,'lowered charge frame is submerged')
   assert.equal(rig.basketStroke,TRANSFER_ALIGNMENT[id].basketStroke)
  }
  if(CAD_MOTION_PROFILES[id].actions.some(a=>a.id==='door')){
   rig.applyLinked({door:0});const closed=new T.Box3().setFromObject(rig.node('door'))
   assert.ok(closed.min.y<=1.25+1e-6&&closed.min.y>1.15,'closed door keeps its lower sealing overlap')
   rig.applyLinked({door:1});assert.ok(new T.Box3().setFromObject(rig.node('door')).min.y>1.8,'open door clears the loading path')
  }
 }finally{rig.dispose()}
})
