import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {CAD_MOTION_PROFILES,cadMotionFrame} from '../src/three/cadMotionProfiles.js'
import {motionEntries} from '../src/views/admin/utils/motionEntries.js'
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
    const partsBox=new T.Box3();gltf.scene.traverse(o=>{if(o.isMesh&&!rig.effects.getObjectsByProperty('uuid',o.uuid).length){let inFx=false;for(let p=o;p;p=p.parent)if(p===rig.effects)inFx=true;if(!inFx)partsBox.union(new T.Box3().setFromObject(o))}})
    assert.ok(initial.min.distanceTo(partsBox.min)<1e-5);assert.ok(initial.max.distanceTo(partsBox.max)<1e-5)
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
    assert.equal(motionEntries([binding],false,'喷淋',b=>b.name,extras)[0].process.id,'spray')
    assert.equal(cadMotionFrame('cad_cleaner_170700','door',Infinity).complete,true)
    assert.throws(()=>cadMotionFrame('cad_cleaner_170700','unknown',1))
})
