// Read-only packaged CAD inputs; no operator database, collector or PLC access.
import {readFile} from 'node:fs/promises'
import * as T from '../frontend/node_modules/three/build/three.module.js'
import {GLTFLoader} from '../frontend/node_modules/three/examples/jsm/loaders/GLTFLoader.js'
import {inferLoadingPort} from '../frontend/src/three/lineLoadingAlignment.js'
import {lineDeviceEnvelope} from '../frontend/src/three/lineDeviceFootprints.js'
import {measureEquipmentLoadCenters} from '../frontend/src/three/equipmentLoadCenter.js'
import {CAD_MOTION_PROFILES} from '../frontend/src/three/cadMotionProfiles.js'
import {planLinePlacementTemplate} from '../shared/linePlacementTemplate.mjs'
import {lineAdjustmentBand} from '../shared/lineAdjustmentBand.mjs'
import {defaultTransferCycle} from '../shared/transferCycleConfig.mjs'
import {defaultTransferLink} from '../shared/transferLinkConfig.mjs'
export async function loadFixtureModel(id){
 const bytes=await readFile(new URL(`../backend/assets/models/${id}.glb`,import.meta.url))
 const gltf=await new Promise((resolve,reject)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',resolve,reject))
 return {root:gltf.scene,model:{id,name:id,file_path:`/assets/models/${id}.glb`,default_scale:1,metadata:JSON.parse(await readFile(new URL(`../backend/assets/models/${id}_metadata.json`,import.meta.url),'utf8'))}}
}
export async function createAdaptiveTransferFixture({kind='single-negative',micro=0,units=1,targetModel='cad_tempering_furnace_091300'}={}){
 const cartAsset=await loadFixtureModel('cad_transfer_cart_101300'),targetAsset=await loadFixtureModel(targetModel)
 const source=inferLoadingPort(cartAsset.root,{model_type:cartAsset.model.id},cartAsset.model)
 const inlet=inferLoadingPort(targetAsset.root,{model_type:targetModel},targetAsset.model)
 if(!source||!inlet)throw Error('Packaged CAD has no reliable fixture loading datum')
 const center=measureEquipmentLoadCenters(targetAsset.root,targetModel).front,seatNode=targetAsset.root.getObjectByName(CAD_MOTION_PROFILES[targetModel].prefix+(targetModel==='cad_tempering_furnace_091300'?'internal_rollers':targetModel==='cad_cleaner_170700'?'internal_rollers':'roller_bed'))
 if(!seatNode)throw Error('Fixture needs a known actual bearing node')
 targetAsset.root.updateWorldMatrix(true,true);const seatLocal=seatNode.worldToLocal(targetAsset.root.localToWorld(center.clone())).toArray()
 cartAsset.model.metadata.loadingPorts={version:1,inlet:structuredClone(source),outlet:structuredClone(source)}
 targetAsset.model.metadata.loadingPorts={version:1,inlet:structuredClone(inlet),outlet:structuredClone(inlet)}
 for(const asset of [cartAsset,targetAsset])asset.model.default_scale=units
 const signs=kind==='dual'?[-1,1]:[kind==='single-negative'?-1:1]
 let layout={version:2,sceneUnitsPerMeter:units,transform:{x:0,y:0,z:0,rotationY:0},rails:[{id:'rail',name:'小车导轨',length:12*units,offsetZ:0}],lanes:signs.map((sign,i)=>({id:'lane'+i,name:'设备线 '+(i+1),length:12*units,offsetZ:sign*3*units}))}
 const cart={id:'fixture_cart',name:'料车 · 隔离样例',model_type:cartAsset.model.id,line_id:'fixture_line',coordinate_space:'line_local',pos_x:0,pos_y:0,pos_z:0,rotation_y:Math.PI/2,scale:1,instance_config:{railLineId:'fixture_line',railId:'rail'}}
 const targets=signs.map((sign,i)=>({id:'fixture_target_'+i,name:'回火炉 · '+(sign<0?'上排':'下排'),model_type:targetModel,line_id:'fixture_line',coordinate_space:'line_local',pos_x:(signs.length===1?0:(i?2:-2))*units,pos_y:(source.position[1]-inlet.position[1])*units,pos_z:sign*3*units,rotation_y:sign<0?0:Math.PI,scale:1,instance_config:{laneLineId:'fixture_line',laneId:'lane'+i}}))
 const devices=[cart,...targets],rows=devices.map(d=>({id:d.id,name:d.name,x:d.pos_x,y:d.pos_y,z:d.pos_z,...lineDeviceEnvelope(d===cart?cartAsset.root:targetAsset.root,d,d===cart?cartAsset.model:targetAsset.model,{parts:true}),...(d===cart?{railId:'rail',pathMinZ:0,pathMaxZ:0}:{laneId:d.instance_config.laneId})}))
 const planned=planLinePlacementTemplate(layout,kind,rows);layout=planned.layout
 if(micro){layout.lanes[0].offsetZ+=signs[0]*micro*.4*units;if(kind==='dual')layout.lanes[1].offsetZ-=signs[0]*micro*.4*units}
 targets.forEach((d,i)=>d.pos_z=layout.lanes[i].offsetZ)
 const stations=targets.map((d,i)=>{
  const side=signs[i]<0?'opposite':'primary',s=side==='opposite'?-1:1
  const sourceOffset=new T.Vector3(source.position[0]*s,source.position[1],source.position[2]*s).multiplyScalar(units).applyAxisAngle(new T.Vector3(0,1,0),cart.rotation_y)
  const targetOffset=new T.Vector3(...inlet.position).multiplyScalar(units).applyAxisAngle(new T.Vector3(0,1,0),d.rotation_y)
  return {value:i+1,targetDeviceId:d.id,side,presencePointId:String(200+i),seatNodeName:seatNode.name,seatNodeLocal:seatLocal,position:{x:d.pos_x+sourceOffset.x-targetOffset.x,y:0,z:0}}
 })
 const movement={enabled:true,valueMode:'station',stationInputMeaning:'target',currentPositionPointId:'101',arrivalPositionPointId:'103',startActionPointId:'102',sceneUnitsPerMeter:units,staleMs:60000,start:{x:-6*units,y:0,z:0},end:{x:6*units,y:0,z:0},stations:stations.map(s=>({value:s.value,position:s.position,anchorDeviceId:s.targetDeviceId}))}
 cart.pos_x=stations[0].position.x
 cart.instance_config.movement=movement
 cart.instance_config.animationBindings={version:1,staleMs:60000,bindings:[],transferLink:{...defaultTransferLink(),enabled:true,actionId:'clip:feed',driveNodeName:'cad_transfer_cart_v1_feed_carriage',targetMode:'station',presenceDataItemId:'fixture:load',materialSize:[.5,.16,.5],heightToleranceMeters:.01,lateralToleranceMeters:.01,angleToleranceDegrees:2,cycle:{...defaultTransferCycle(),enabled:true,handoffMode:'adaptive',startDataItemId:'fixture:start',pickupDataItemId:'fixture:pickup',cartHome:[.1175,source.position[1],0],extendSeconds:2,latchSeconds:.5,retractSeconds:2,conveySeconds:1.5,stations:stations.map(({position,...s})=>s)}}}
 const currentRows=planned.rows.map(r=>r.railId?r:{...r,z:targets.find(d=>d.id===r.id).pos_z})
 const band=lineAdjustmentBand(layout,currentRows)
 return {models:[cartAsset.model,targetAsset.model],devices,lines:[{id:'fixture_line',name:'一车'+(targets.length===1?'一炉':'两炉')+' · '+kind,workshop_id:'fixture_workshop',layout}],workshops:[{id:'fixture_workshop',name:'隔离动画验证',layout:{version:2,transform:{x:0,y:0,z:0,rotationY:0}}}],evidence:{virtualSignals:true,operatorWrites:0,band,datums:{source,inlet,seatLocal},kind,micro,units}}
}
