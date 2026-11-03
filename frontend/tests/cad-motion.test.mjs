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
