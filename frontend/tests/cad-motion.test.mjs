import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {CAD_MOTION_PROFILES,cadMotionFrame} from '../src/three/cadMotionProfiles.js'
import {motionEntries} from '../src/views/admin/utils/motionEntries.js'
import {CART_FEED} from '../src/three/cartFeedMechanism.js'
for(const [id,profile] of Object.entries(CAD_MOTION_PROFILES))test(`${id}: each action moves isolated parts, seeks deterministically and resets`,async()=>{
    const buffer=fs.readFileSync(new URL(`../../backend/assets/models/${id}.glb`,import.meta.url)),sourceHash=crypto.createHash('sha256').update(buffer).digest('hex')
    const gltf=await new GLTFLoader().parseAsync(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength),'')
    const initial=new T.Box3().setFromObject(gltf.scene),rig=new CadMotionRig(gltf.scene,id)
    const nodes=rig.baselines.map(x=>x.o),snapshot=()=>nodes.map(o=>[...o.position,...o.quaternion,...o.scale,Number(o.visible)])
    const base=snapshot()
    const outer=['structure','housing','upper_housing','fans_enamel','fans_teal','agitator_teal','pumps_blue'].map(n=>rig.node(n)).filter(Boolean)
    const still=outer.map(o=>o.position.clone())
    for(const action of profile.actions){
        rig.apply(action.id,3);const a=snapshot();assert.notDeepEqual(a,base,action.id)
        rig.apply(action.id,6);rig.apply(action.id,3);assert.deepEqual(snapshot(),a,`${action.id} seek`)
        for(let i=0;i<outer.length;i++)assert.ok(outer[i].position.equals(still[i]),`${action.id} moved fixed housing`)
        rig.reset();assert.deepEqual(snapshot(),base,`${action.id} reset`)
    }
    // Splitting material buckets must preserve all original surface bounds at rest.
    // The derived opposite-facing assembly is new geometry, not a change to
    // the original CAD surfaces. Hidden meshes also enter Box3, so exclude it
    // explicitly and still enforce the original assembly's exact bounds.
    const partsBox=new T.Box3();gltf.scene.traverse(o=>{if(o.isMesh){let added=false;for(let p=o;p;p=p.parent)if(p===rig.effects||p===rig.oppositeFeedRoot)added=true;if(!added)partsBox.union(new T.Box3().setFromObject(o))}})
    assert.ok(initial.min.distanceTo(partsBox.min)<1e-5);assert.ok(initial.max.distanceTo(partsBox.max)<1e-5)
    if(id==='cad_transfer_cart_101300'){
        const hook=rig.node('push_hook'),carriage=rig.node('feed_carriage'),latch=rig.node('hook_latch')
        assert.ok(hook&&carriage&&latch,'mounted hook and carriage are in the delivered GLB')
        const fixed=[rig.node('pusher_metal'),rig.node('pusher_stainless')]
        rig.reset();gltf.scene.updateMatrixWorld(true)
        const matrices=fixed.map(node=>node.matrixWorld.clone()),world=node=>node.getWorldPosition(new T.Vector3())
        const home=world(hook),offset=world(hook).sub(world(carriage))
        assert.equal(rig.cartChain.length,42)
        const shuttleCenter=()=>new T.Box3().setFromObject(rig.node('pusher_steel')).getCenter(new T.Vector3()).x
        assert.ok(Math.abs(shuttleCenter()-CART_FEED.rearX)<1e-6,'hook starts at the rear end of the guide')
        const chainHome=rig.cartChain[0].pivot.position.clone()
        const fixedPanel=rig.node('return_chain').children.find(node=>node.isMesh&&new T.Box3().setFromObject(node).getSize(new T.Vector3()).x>.4)
        assert.ok(fixedPanel);const panelMatrix=fixedPanel.matrixWorld.clone()
        for(const time of [0,2,4,6,8]){
            rig.apply('feed',time);gltf.scene.updateMatrixWorld(true)
            fixed.forEach((node,index)=>assert.ok(node.matrixWorld.equals(matrices[index]),'fixed chain guide must not slide with the hook'))
            assert.ok(world(hook).sub(world(carriage)).distanceTo(offset)<1e-7)
            assert.ok(fixedPanel.matrixWorld.equals(panelMatrix),'chain cover and guide races stay fixed')
        }
        rig.apply('feed',4);assert.ok(Math.abs(world(hook).x-home.x+CART_FEED.stroke)<1e-6)
        assert.ok(Math.abs(shuttleCenter()-CART_FEED.frontX)<1e-6,'hook reaches the front end of the guide')
        assert.ok(rig.cartChain[0].pivot.position.distanceTo(chainHome)>.05,'actual rear chain links circulate')
        assert.ok(Math.abs(rig.joints.feed_gear.rotation.z-CART_FEED.stroke/.135)<1e-6)
        rig.apply('feed',8);assert.ok(Math.abs(shuttleCenter()-CART_FEED.rearX)<1e-6)
        assert.ok(rig.cartChain[0].pivot.position.distanceTo(chainHome)<1e-6,'the same chain links return with the hook')
        rig.apply('hook',4);assert.ok(Math.abs(latch.rotation.z+.65)<1e-7)
        rig.applyLinked({feed:1,feedTravel:1.2,hookEngaged:true});assert.ok(Math.abs(world(hook).x-home.x+1.2)<1e-6);assert.ok(Math.abs(latch.rotation.z)<1e-7)
        rig.applyLinked({feed:.5,feedTravel:1.2,hookEngaged:false});assert.ok(Math.abs(world(hook).x-home.x+.6)<1e-6);assert.equal(latch.rotation.z,-.65)
        rig.reset();assert.ok(world(hook).distanceTo(home)<1e-7)
    }
    if(id==='cad_lifting_load_table_111400'){
        rig.reset();gltf.scene.updateMatrixWorld(true)
        const bed=rig.node('roller_bed'),world=node=>node.getWorldPosition(new T.Vector3())
        const rollerOffsets=rig.rollers.map(roller=>world(roller).sub(world(bed)))
        const assertRollersOnDeck=label=>{
            gltf.scene.updateMatrixWorld(true)
            rig.rollers.forEach((roller,index)=>assert.ok(world(roller).sub(world(bed)).distanceTo(rollerOffsets[index])<1e-7,`${label}: roller ${index} must follow the platform`))
        }
        assert.ok(rig.rollers.length>0)
        for(const action of ['lift_up','lift_down'])for(const time of [0,1,2,4,6,8]){
            rig.apply(action,time);assertRollersOnDeck(`${action} at ${time}s`)
        }
        for(const lift of [0,.25,.5,1,0]){
            rig.applyLinked({lift,runTime:1.3});assertRollersOnDeck(`linked lift ${lift}`)
        }
        rig.reset();assertRollersOnDeck('reset')
        rig.apply('lift_up',4);assert.ok(rig.node('roller_bed').position.y>.2)
        rig.apply('lift_down',4);assert.ok(rig.node('roller_bed').position.y<-.2)
        for(const {pivot} of rig.scissor)assert.ok(Math.abs(pivot.rotation.z)<.3)
    }
    if(id==='cad_cleaner_170700'){
        const deck=rig.node('internal_rollers'),fixed=['central_lower_body','tanks','housing','pumps_blue'].map(n=>rig.node(n))
        rig.reset();gltf.scene.updateMatrixWorld(true);const matrices=fixed.map(n=>n.matrixWorld.clone()),waterPose=rig.bathVolumes.map(n=>[...n.position,...n.scale,Number(n.visible)])
        const assertWater=()=>assert.deepEqual(rig.bathVolumes.map(n=>[...n.position,...n.scale,Number(n.visible)]),waterPose,'the continuous lower bath stays full')
        assert.equal(rig.bathVolumes.length,1);assert.ok(rig.bathVolumes.every(n=>n.visible))
        const waterBox=new T.Box3().setFromObject(rig.water)
        assert.ok(waterBox.min.x<-.60&&waterBox.max.x>.60&&waterBox.min.z<-.95&&waterBox.max.z>.95,'central lower chamber is filled, not just a small rear corner')
        rig.apply('basket_down',0);const home=new T.Box3().setFromObject(rig.cleanerCharge);assert.ok(home.min.y>waterBox.max.y,'load starts above the permanent water')
        for(const time of [2,4,8]){rig.apply('basket_down',time);assertWater()}
        assert.ok(new T.Box3().setFromObject(rig.cleanerCharge).max.y<waterBox.max.y-.1,'the whole charge must be submerged at the end of lowering')
        assert.ok(Math.abs(deck.position.y+.8)<1e-7);assert.ok(new T.Box3().setFromObject(deck).min.y>waterBox.min.y,'deck must not pass through the tank floor')
        rig.apply('basket_up',8);assert.ok(Math.abs(deck.position.y)<1e-7);assert.ok(new T.Box3().setFromObject(rig.cleanerCharge).min.y>waterBox.max.y)
        assert.ok(!CAD_MOTION_PROFILES[id].actions.some(a=>a.id==='blow'))
        for(const time of [0,2,4,8]){rig.apply('spray',time);assert.ok(Math.abs(deck.position.y)<1e-7);assert.ok(new T.Box3().setFromObject(rig.cleanerCharge).min.y>waterBox.max.y,'clean-water rinse stays above the alkali bath');assertWater()}
        for(const basket of [0,.5,1,0]){rig.applyLinked({basket,level:0});assertWater();assert.ok(Math.abs(deck.position.y+.8*basket)<1e-7);assert.equal(rig.cleanerCharge.visible,false)}
        gltf.scene.updateMatrixWorld(true);fixed.forEach((n,i)=>assert.ok(n.matrixWorld.equals(matrices[i]),'water tanks, shell and pump housings stay fixed'))
        rig.reset();assertWater()
    }
    if(id==='cad_multipurpose_furnace_082000'){
        assert.equal(rig.hotRollers.length,7);assert.equal(rig.multiAgitators.length,2)
        assert.equal(rig.multiCirculation.children.length,10,'eight blades, hub and shaft; the large shroud stays fixed')
        const fixed=['roof_fan','agitators_teal','door_guides','gate_gantry','quench_tank'].map(n=>rig.node(n))
        rig.reset();gltf.scene.updateMatrixWorld(true);const matrices=fixed.map(n=>n.matrixWorld.clone())
        rig.apply('agitator',2);gltf.scene.updateMatrixWorld(true);fixed.forEach((n,i)=>assert.ok(n.matrixWorld.equals(matrices[i])))
        rig.apply('heating',2);assert.ok(rig.heatMaterials.every(e=>e.material.emissiveIntensity===.9));rig.reset();assert.ok(rig.heatMaterials.every(e=>e.material.emissive.equals(e.emissive)&&e.material.emissiveIntensity===e.intensity))
    }
    if(id==='cad_tempering_furnace_091300'){
        assert.equal(rig.temperingFan.children.length,9,'eight real blades and the internal shaft')
        assert.equal(rig.temperingRollers.length,7);assert.equal(rig.temperingDriveShafts.length,2)
        const fixed=['housing','structure','circulation_fan_teal','circulation_cover','internal_rollers_metal','door_guides','door_drive','heater_terminals'].map(name=>rig.node(name))
        rig.reset();gltf.scene.updateMatrixWorld(true);const matrices=fixed.map(node=>node.matrixWorld.clone())
        for(const action of ['door','circulation','rollers','heating']){
            rig.apply(action,1.37);gltf.scene.updateMatrixWorld(true)
            fixed.forEach((node,i)=>assert.ok(node.matrixWorld.equals(matrices[i]),`${action}: ${node.name} must stay fixed`))
        }
        const doorMaterial=rig.node('door_black').material
        rig.reset();const originalDoorEmissive=doorMaterial.emissive.clone(),doorPosition=rig.node('door').position.clone()
        rig.apply('door',4);assert.ok(Math.abs(rig.node('door').position.y-doorPosition.y-.9)<1e-6)
        assert.ok(Math.abs(rig.node('door_carriages').position.y-.9)<1e-6)
        rig.applyLinked({conveyTime:1});const rollerAngle=rig.temperingRollers[0].rotation.x
        assert.ok(rollerAngle<0);assert.equal(rig.temperingFan.rotation.y,0)
        rig.applyLinked({conveyTime:1,circulationTime:2,heat:true})
        assert.equal(rig.temperingRollers[0].rotation.x,rollerAngle,'rollers hold still during heating')
        assert.notEqual(rig.temperingFan.rotation.y,0);assert.ok(rig.heatMaterials.every(entry=>entry.material.emissiveIntensity===.9))
        assert.ok(doorMaterial.emissive.equals(originalDoorEmissive),'shared black door material must not glow')
        rig.reset();assert.ok(rig.heatMaterials.every(entry=>entry.material.emissive.equals(entry.emissive)&&entry.material.emissiveIntensity===entry.intensity))
        assert.deepEqual(snapshot(),base)
    }
    assert.equal(crypto.createHash('sha256').update(buffer).digest('hex'),sourceHash)
    rig.dispose()
})
test('CAD preview actions coexist with bindings and preserve edit indices',()=>{
    const binding={name:'现场自定义',source_group:'doors',source_key:'open'}
    const extras=CAD_MOTION_PROFILES.cad_cleaner_170700.actions
    const rows=motionEntries([binding],false,'',b=>b.name,extras)
    assert.equal(rows.length,extras.length+1);assert.equal(rows.at(-1).index,0)
    assert.ok(motionEntries([binding],false,'喷清水',b=>b.name,extras).some(row=>row.process?.id==='spray'))
    assert.equal(cadMotionFrame('cad_cleaner_170700','door',Infinity).complete,true)
    assert.throws(()=>cadMotionFrame('cad_cleaner_170700','unknown',1))
})
