import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CAD_MOTION_PROFILES} from '../src/three/cadMotionProfiles.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {LineSimulationScene} from '../src/three/LineSimulationScene.js'
import {TransferFeedScene} from '../src/three/TransferFeedScene.js'
import {measureEquipmentLoadCenters} from '../src/three/equipmentLoadCenter.js'
import {buildLineSimulation,sampleLineSimulation} from '../src/three/lineSimulation.js'

const beds={cad_cleaner_170700:'internal_rollers',cad_water_cooling_tank_471000:'basket',
    cad_multipurpose_furnace_082000:'elevator_basket',cad_tempering_furnace_091300:'internal_rollers',
    cad_lifting_load_table_111400:'roller_bed',cad_fixed_load_table_112200:'roller_bed',cad_air_cooling_table_115800ht:'roller_bed'}
const near=(actual,expected,message)=>assert.ok(actual.distanceTo(expected)<1e-6,`${message}: ${actual.toArray()} != ${expected.toArray()}`)
async function load(id){
    const b=fs.readFileSync(new URL('../../backend/assets/models/'+id+'.glb',import.meta.url))
    return (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene
}
for(const [id,suffix] of Object.entries(beds))test(`${id}: tray stays centred on the real internal bed through feed, retract, process and transformed layouts`,async()=>{
    const asset=await load(id),prefix=CAD_MOTION_PROFILES[id].prefix
    asset.updateMatrixWorld(true)
    // Independent expected bounds from the actual source mesh, before rigging.
    const support=new T.Box3().setFromObject(asset.getObjectByName(prefix+suffix+'_stainless'))
    const expected=support.getCenter(new T.Vector3());expected.y=support.max.y+.04
    const centers=measureEquipmentLoadCenters(asset,id),rig=new CadMotionRig(asset,id)
    const offset=new T.Group(),wrapper=new T.Group(),parent=new T.Group()
    offset.position.set(-.31,.07,.23);offset.add(asset);wrapper.add(offset);parent.add(wrapper)
    const station={id:'station',model_type:id},cart={id:'cart',model_type:'cad_transfer_cart_101300'}
    const plan=buildLineSimulation([cart,station],[{id,file_path:'/model.glb'},{id:cart.model_type,file_path:'/cart.glb'}])
    const entry={row:plan.stations[0],asset,rig,loadCenters:centers,offset,wrapper}
    const scene=Object.create(LineSimulationScene.prototype);scene.entries=new Map([['station',entry]])
    try{
        for(const mirror of [1,-1])for(const yaw of [0,.73,Math.PI/2]){
            parent.position.set(3,2,-7);parent.rotation.y=.31;parent.scale.set(1.2,1.4,.8)
            wrapper.position.set(-4,.2,8);wrapper.rotation.y=yaw;wrapper.scale.set(1.7*mirror,1.7,1.7)
            rig.applyLinked({door:1,level:1});parent.updateMatrixWorld(true)
            for(const kind of ['feed','retract','close']){
                const step=plan.steps.find(s=>s.kind===kind);if(!step)continue
                const frame=sampleLineSimulation(plan,kind==='feed'?step.end:step.start+step.duration/2)
                near(scene.loadPort('station',true,frame.states.station),asset.localToWorld(expected.clone()),kind+' lands on the support centre')
            }
            if(['cad_cleaner_170700','cad_water_cooling_tank_471000','cad_multipurpose_furnace_082000'].includes(id)){
                const state={basket:.65};rig.applyLinked({...state,level:1});parent.updateMatrixWorld(true)
                const lowered=expected.clone();lowered.y-=rig.basketStroke*.65
                near(scene.loadPort('station',true,state),asset.localToWorld(lowered),'lowering retains the same X/Z centre')
            }
            if(id==='cad_lifting_load_table_111400'){
                const lifted=expected.clone();lifted.y+=.24*.7
                near(scene.loadPort('station',true,{lift:.7}),asset.localToWorld(lifted),'lift retains the support centre')
            }
        }
        if(id==='cad_multipurpose_furnace_082000'){
            const hot=centers.hot.clone();hot.y+=.04
            near(scene.loadPort('station',true,{chamber:1}),asset.localToWorld(hot),'hot chamber uses its own roller centre')
        }
    }finally{rig.dispose();asset.traverse(n=>{n.geometry?.dispose();[].concat(n.material||[]).forEach(m=>m.dispose())})}
})

test('legacy cleaner and furnaces resolve their actual support instead of the doorway',async()=>{
    for(const [id,file,node] of [['ultrasonic_cleaner_cad','ultrasonic_cleaner_cad','026_棍子座'],
        ['photo_multipurpose_furnace_v6','photo_multipurpose_furnace_v6_pipefix','chamber_visible_brushed_metal']]){
        const root=await load(file);root.updateMatrixWorld(true)
        const box=new T.Box3().setFromObject(root.getObjectByName(node)),expected=box.getCenter(new T.Vector3());expected.y=box.max.y
        near(measureEquipmentLoadCenters(root,id).front,expected,id)
    }
    const root=await load('photo_tempering_furnace_v6'),point=measureEquipmentLoadCenters(root,'photo_tempering_furnace_v6').front
    assert.ok(point.z<.5,'tempering load belongs inside the chamber, beyond the external shallow tray')
    assert.ok(point.y>.9&&point.y<1.2,'tray rests on the chamber floor rather than the ceiling')
})

test('single-device preview keeps the tray on the bed when its shuttle retracts',()=>{
    const preview=Object.create(TransferFeedScene.prototype)
    Object.assign(preview,{loaded:true,dockZ:0,approachDistance:4,materialStartX:3,materialY:1.58,
        materialDestination:new T.Vector3(-.32,1.25,.014),feedDistance:2,shuttleBase:new T.Vector3(),
        cart:new T.Group(),shuttle:new T.Group(),material:new T.Group(),doors:[],rollers:[],wheels:[]})
    preview.apply({cart:1,door:1,chain:1,material:1})
    near(preview.material.position,preview.materialDestination,'completed feed')
    preview.apply({cart:1,door:1,chain:0,material:1})
    near(preview.material.position,preview.materialDestination,'tray stays at centre during retraction')
    near(preview.shuttle.position,preview.shuttleBase,'shuttle returns independently')
})
