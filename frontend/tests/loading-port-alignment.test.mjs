import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {inferLoadingPort,loadingFaceOffset,measureLoadingPorts,measureLoadingFaces,alignLoadingFaces,alignLoadingHeights} from '../src/three/lineLoadingAlignment.js'
import {CAD_MOTION_PROFILES} from '../src/three/cadMotionProfiles.js'

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-6,`${actual} != ${expected}`)
const port=(position=[0,1.25,2],direction=[0,0,1],nodeName='')=>({position,direction,nodeName})
const ports=(inlet=port(),outlet=null)=>({version:1,inlet,outlet})
const overrides=(inlet=null,outlet=null)=>({version:1,inlet,outlet})
const model=(metadata={loadingPorts:ports()})=>({id:'custom',default_scale:1,file_path:'/assets/custom.glb',metadata})
const row=(id='a',extra={})=>({id,x:10,y:0,z:-4,direction:1,device:{id,model_type:'custom',pos_x:10,pos_y:0,pos_z:-4,rotation_y:0,scale:1},...extra})
async function asset(id) {
    const bytes=fs.readFileSync(new URL(`../../backend/assets/models/${id}.glb`,import.meta.url))
    const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'')
    return {root:gltf.scene,bytes}
}
function snapshot(root) {
    const result=[]
    root.traverse(node=>result.push({uuid:node.uuid,parent:node.parent?.uuid,children:node.children.map(child=>child.uuid),
        position:node.position.toArray(),quaternion:node.quaternion.toArray(),scale:node.scale.toArray(),
        matrix:node.matrix.toArray(),matrixWorld:node.matrixWorld.toArray(),userData:JSON.stringify(node.userData),
        box:node.geometry?.boundingBox?.clone()||null,
        attributes:Object.fromEntries(Object.entries(node.geometry?.attributes||{}).map(([name,attribute])=>[name,Array.from(attribute.array)]))}))
    return result
}

test('3# 多用炉 native mouth_frame is measured at its true lower refractory sill, not the whole door center',async()=>{
    const id='photo_multipurpose_furnace_v6',file=id+'_pipefix'
    const {root,bytes}=await asset(file),before=snapshot(root),hash=crypto.createHash('sha256').update(bytes).digest('hex')
    const device={id:'Furnace_03',name:'3# 多用炉',model_type:id,rotation_y:270,scale:1,pos_y:.2,pos_z:-5}
    const inferred=inferLoadingPort(root,device,{id})
    assert.equal(inferred.nodeName,'mouth_frame');assert.deepEqual(inferred.direction,[1,0,0])
    close(inferred.position[0],2.88);close(inferred.position[1],1.1825);close(inferred.position[2],0)
    const door=new T.Box3().setFromObject(root.getObjectByName('door_front_lift'))
    assert.ok(Math.abs(inferred.position[1]-door.getCenter(new T.Vector3()).y)>.5,'not a centered door AABB')
    const afterBounds=snapshot(root)
    let disposed=0
    const measured=await measureLoadingPorts([{id:device.id,device,direction:1,y:.2,z:-5}],[{id,file_path:'/assets/'+file+'.glb'}],
        {load:async()=>({scene:root}),dispose:()=>disposed++,requireRailDirection:true})
    close(measured[0].faceOffset,2.88);close(measured[0].heightOffset,1.1825)
    assert.equal(measured[0].portSource,'fallback');assert.equal(disposed,1)
    assert.deepEqual(snapshot(root),afterBounds,'measurement mutates no transforms, arrays, bounding boxes, or hierarchy')
    // setFromObject above intentionally updated matrix caches, but inference did not.
    assert.deepEqual(before.map(n=>n.attributes),afterBounds.map(n=>n.attributes))
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(new URL(`../../backend/assets/models/${file}.glb`,import.meta.url))).digest('hex'),hash)
    assert.equal(inferLoadingPort(root,device,{id},'outlet'),null,'no invented exit')
    await assert.rejects(()=>measureLoadingPorts([{device,portKind:'outlet'}],[{id,file_path:'/a.glb'}],{load:async()=>({scene:root}),dispose:()=>{}}),/出料口/)
})

test('known CAD loading height measures stainless roller crowns rather than taller bed guides or door centers',async()=>{
    const ids=['cad_tempering_furnace_091300','cad_cleaner_170700','cad_multipurpose_furnace_082000','cad_water_cooling_tank_471000','cad_fixed_load_table_112200','cad_lifting_load_table_111400','cad_transfer_cart_101300','cad_air_cooling_table_115800ht']
    for(const id of ids) {
        const {root}=await asset(id),before=snapshot(root)
        const inferred=inferLoadingPort(root,{model_type:id},{id})
        assert.ok(inferred,id);close(inferred.position[1],1.25)
        assert.deepEqual(snapshot(root),before,id+' authored scene remains unmodified')
    }
})

test('raw inference includes authored node hierarchy but ignores preview-root transforms',async()=>{
    const {root}=await asset('photo_multipurpose_furnace_v6_pipefix')
    const original=inferLoadingPort(root,{},{}),authored=root.getObjectByName('photo_multipurpose_furnace_v6_root')
    authored.position.set(4,2,-3);authored.scale.set(2,2,2)
    root.position.set(99,100,101);root.rotation.y=1;root.scale.setScalar(8)
    const before=snapshot(root),actual=inferLoadingPort(root,{},{}),expected=new T.Vector3(...original.position).multiplyScalar(2).add(new T.Vector3(4,2,-3))
    actual.position.forEach((value,i)=>close(value,expected.getComponent(i)))
    assert.deepEqual(snapshot(root),before,'even stale matrix caches are not rewritten')
})

test('explicit custom model ports win without loading geometry, and instance offsets apply in raw model units',async()=>{
    const metadata=JSON.stringify({loadingPorts:ports(port([2,1.4,3],[0,0,1],'custom-opening'))})
    const device={...row().device,rotation_y:90,scale:2,instance_config:JSON.stringify({scaleMultiplier:.5,mirrorX:true,
        loadingPortOverrides:overrides({offset:[.25,.1,-.5],yawDegrees:90})})}
    let loads=0
    const measured=await measureLoadingPorts([row('a',{device})],[{...model(),default_scale:3,metadata}],{load:async()=>{loads++;throw Error('unexpected load')},requireRailDirection:true})
    assert.equal(loads,0);close(measured[0].faceOffset,6.75);close(measured[0].heightOffset,4.5)
    close(measured[0].portPosition[0],7.5);close(measured[0].portDirection[2],1)
    assert.equal(measured[0].portSource,'instance');assert.equal(measured[0].nodeName,'custom-opening')
    assert.equal(device.pos_z,-4);assert.equal(device.pos_y,0)
})

test('native scaling, explicit false mirror alias precedence, 180 and 90 degree normal checks are consistent',async()=>{
    const root=new T.Group(),m={...model(),default_scale:3},base={...row().device,scale:2,instance_config:{scaleMultiplier:.5,mirrorX:false,mirror_x:true}}
    close(loadingFaceOffset(root,base,m,1),6)
    close(loadingFaceOffset(root,{...base,rotation_y:180},m,-1),-6)
    assert.throws(()=>loadingFaceOffset(root,{...base,rotation_y:180},m,1),/背向/)
    assert.throws(()=>loadingFaceOffset(root,{...base,rotation_y:90},m,1),/垂直/)
    const customX=model({loadingPorts:ports(port([2,1.5,0],[1,0,0]))})
    close(loadingFaceOffset(root,{...base,rotation_y:90,instance_config:{mirrorX:true}},customX,1),4)
    assert.throws(()=>loadingFaceOffset(root,{...base,rotation_y:90,instance_config:{mirrorX:false}},customX,1),/背向/)
    const heights=await measureLoadingPorts([row('a',{device:{...base,rotation_y:90},direction:-1})],[m])
    close(heights[0].heightOffset,3.75)
    assert.throws(()=>alignLoadingFaces([heights[0],{...heights[0],id:'b'}],'a'),/垂直/)
})

test('chosen front/back reference stays exact, plans are idempotent and change no height, X or authored device settings',()=>{
    const original=[row('a',{z:-7.123456789,faceOffset:1.2,heightOffset:1}),row('b',{z:-4,faceOffset:3.1,heightOffset:2})]
    const before=structuredClone(original),plan=alignLoadingFaces(original,'a')
    assert.equal(plan[0].z,original[0].z)
    close(plan[0].z+plan[0].faceOffset,plan[1].z+plan[1].faceOffset)
    for(let i=0;i<plan.length;i++)assert.deepEqual({...plan[i],z:original[i].z},original[i])
    assert.deepEqual(alignLoadingFaces(plan,'a'),plan);assert.deepEqual(original,before)
    assert.throws(()=>alignLoadingFaces(original,'missing'),/基准/)
    assert.throws(()=>alignLoadingFaces([original[0],{...original[1],direction:-1}],'a'),/同一侧/)
    assert.throws(()=>alignLoadingFaces([original[0],{...original[1],faceOffset:NaN}],'a'),/测量值/)
})

test('height reference can use cart outlet while furnaces use inlet, regardless of rail direction; only Y changes',async()=>{
    const m=model({loadingPorts:ports(port([0,1.4,2],[0,0,1]),port([1,2.1,-3],[1,0,0]))})
    const originals=[row('cart',{y:.123456789,portKind:'outlet',device:{...row('cart').device,rotation_y:90}}),
        row('furnace',{y:-.7,direction:-1}),row('other',{y:3,device:{...row('other').device,scale:2}})]
    const measured=await measureLoadingPorts(originals,[m]),before=structuredClone(measured)
    assert.deepEqual(measured.map(r=>r.portKind),['outlet','inlet','inlet'])
    const plan=alignLoadingHeights(measured,'cart')
    assert.equal(plan[0].y,originals[0].y)
    for(const current of plan)close(current.y+current.heightOffset,plan[0].y+plan[0].heightOffset)
    for(let i=0;i<plan.length;i++)assert.deepEqual({...plan[i],y:measured[i].y},measured[i])
    assert.deepEqual(alignLoadingHeights(plan,'cart'),plan);assert.deepEqual(measured,before)
    assert.throws(()=>alignLoadingHeights(measured),/基准/)
    assert.throws(()=>alignLoadingHeights([{...measured[0],heightOffset:null},measured[1]],'cart'),/配置/)
})

test('explicit null, missing inlet, invalid vectors and invalid overrides never trigger legacy fallback',async()=>{
    const id='cad_multipurpose_furnace_082000',{root}=await asset(id),device={id:'bad',model_type:id},file_path='/m.glb'
    let loads=0
    const load=async()=>{loads++;return {scene:root}}
    for(const loadingPorts of [null,ports(null),{version:1,outlet:null},ports(port([0,1,NaN])),ports(port([0,1,2],[0,1,1]))]) {
        await assert.rejects(()=>measureLoadingPorts([{device}],[{id,file_path,metadata:{loadingPorts}}],{load}),/配置|缺少字段|有限数字|水平/)
    }
    const badOverride={...device,instance_config:{loadingPortOverrides:overrides({offset:[0,Infinity,0],yawDegrees:0})}}
    await assert.rejects(()=>measureLoadingPorts([{device:badOverride}],[{id,file_path}],{load}),/有限数字/)
    assert.equal(loads,0,'validate explicit model and overrides before loading any legacy geometry')
    await assert.rejects(()=>measureLoadingPorts([{device:{id:'unknown'}}],[],{load}),/没有模型文件/)
    await assert.rejects(()=>measureLoadingPorts([{device}],[{id,file_path,metadata:'broken JSON'}],{load}),/JSON/)
})

test('a CAD panel without a reliable roller/sill node remains depth-compatible but refuses height calibration',async()=>{
    const id='cad_tempering_furnace_091300',{root}=await asset(id)
    const rollers=root.getObjectByName(CAD_MOTION_PROFILES[id].prefix+'internal_rollers_stainless')
    rollers.parent.remove(rollers)
    const device={id:'unknown-height',model_type:id},models=[{id,file_path:'/legacy.glb'}],load=async()=>({scene:root}),dispose=()=>{}
    assert.equal(inferLoadingPort(root,device,models[0]),null)
    const measured=await measureLoadingFaces([{device,direction:1}],models,{load,dispose})
    assert.ok(Number.isFinite(measured[0].faceOffset));assert.equal(measured[0].heightOffset,null)
    await assert.rejects(()=>measureLoadingPorts([{device,direction:1}],models,{load,dispose}),/高度无法可靠判定.*配置/)
})

test('fallback loading shares assets and disposes every loaded root on success, load failure, and later validation failure',async()=>{
    const id='cad_multipurpose_furnace_082000',{root}=await asset(id),device={id:'a',model_type:id}
    let loads=0,disposed=0,gpuDisposed=0
    root.traverse(node=>node.geometry?.addEventListener('dispose',()=>gpuDisposed++))
    const models=[{id,file_path:'/same.glb'}],rows=[{device,direction:1},{device:{...device,id:'b'},direction:1}]
    const load=async()=>{loads++;return {scene:root}}
    await measureLoadingPorts(rows,models,{load})
    assert.equal(loads,1);assert.ok(gpuDisposed>0,'geometry/material ownership is actually released')
    const dispose=()=>disposed++
    await assert.rejects(()=>measureLoadingPorts([...rows,{device:{id:'missing'},direction:1}],models,{load,dispose}),/模型文件/)
    assert.equal(disposed,1)
    const badModel={id:'bad',file_path:'/bad.glb',metadata:{loadingPorts:ports(null)}}
    await assert.rejects(()=>measureLoadingPorts([rows[0],{device:{id:'bad',model_type:'bad'}}],[...models,badModel],{load,dispose}),/未配置/)
    assert.equal(disposed,2)
    const failingLoad=async url=>url.endsWith('/fail.glb')?Promise.reject(Error('loader failed')):{scene:root}
    await assert.rejects(()=>measureLoadingPorts([rows[0],{device:{id:'second',model_type:'second'}}],[...models,{id:'second',file_path:'/fail.glb'}],{load:failingLoad,dispose}),/loader failed/)
    assert.equal(disposed,3)
})
