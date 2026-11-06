import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {loadingFaceOffset,alignLoadingFaces,measureLoadingFaces} from '../src/three/lineLoadingAlignment.js'
import {planLineGroupMove,spaceLineDevices} from '../src/views/admin/utils/lineDeviceSelection.js'
import {parseInstanceConfig,numberOrDefault} from '../src/views/admin/utils/common.js'

const ids=['cad_multipurpose_furnace_082000','cad_tempering_furnace_091300','cad_cleaner_170700','cad_water_cooling_tank_471000','cad_fixed_load_table_112200','cad_lifting_load_table_111400']
async function asset(id){const b=fs.readFileSync(new URL('../../backend/assets/models/'+id+'.glb',import.meta.url));return (await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene}
test('actual CAD door panels and rotated staging beds share a loading plane without changing source geometry or heights',async()=>{
    const rows=[]
    for(const [i,id] of ids.entries()){
        const root=await asset(id),before=new T.Box3().setFromObject(root,true).clone()
        const device={id,model_type:id,pos_x:i*4,pos_z:-4,rotation_y:id.includes('table')?Math.PI/2:0,scale:1}
        rows.push({id,device,x:device.pos_x,z:device.pos_z,direction:1,faceOffset:loadingFaceOffset(root,device,{default_scale:1},1)})
        assert.ok(before.equals(new T.Box3().setFromObject(root,true)));assert.equal(root.parent,null)
    }
    assert.ok(Math.max(...rows.map(r=>r.faceOffset))-Math.min(...rows.map(r=>r.faceOffset))>.9,'reproduce mismatched authored origins')
    const plan=alignLoadingFaces(rows),front=plan[0].z+plan[0].faceOffset
    for(const [i,row] of plan.entries()){
        assert.ok(Math.abs(row.z+row.faceOffset-front)<.000001)
        assert.equal(row.x,rows[i].x)
    }
    const again=alignLoadingFaces(plan);assert.deepEqual(again.map(r=>r.z),plan.map(r=>r.z),'alignment is idempotent')
})
test('alignment respects native scale, mirrored X, and the other side of the rail; refuses sideways/backwards doors',async()=>{
    const root=await asset(ids[0]),device={id:'m',model_type:ids[0],scale:1,rotation_y:0}
    const offset=loadingFaceOffset(root,device,{},1)
    assert.ok(Math.abs(loadingFaceOffset(root,{...device,scale:2,instance_config:{mirrorX:true}},{default_scale:3},1)-offset*6)<1e-6)
    assert.ok(Math.abs(loadingFaceOffset(root,{...device,rotation_y:180},{},-1)+offset)<1e-6)
    assert.throws(()=>loadingFaceOffset(root,{...device,rotation_y:90},{},1),/垂直/)
    assert.throws(()=>loadingFaceOffset(root,{...device,rotation_y:180},{},1),/背向/)
    const plan=alignLoadingFaces([{z:5,faceOffset:-1,direction:-1},{z:5,faceOffset:-2,direction:-1}])
    assert.deepEqual(plan.map(r=>r.z),[4,5])
})
test('dragging and spacing retain corrected loading-face offsets',()=>{
    const binding={type:'lane',item:{id:'a',offsetZ:-4,length:60}},target={type:'lane',item:{id:'b',offsetZ:6,length:60}}
    const rows=[{id:'a',x:0,z:-3.035,binding},{id:'b',x:3,z:-4,binding}]
    assert.deepEqual(planLineGroupMove(rows,'a',1,binding,[binding]).map(r=>r.z),[-3.035,-4])
    assert.deepEqual(planLineGroupMove(rows,'a',1,target,[target]).map(r=>r.z),[6.965,6])
    assert.deepEqual(spaceLineDevices(rows,4).map(r=>r.z),[-3.035,-4])
})
test('measurement shares assets and disposes them on success and errors',async()=>{
    let loads=0,disposed=0
    const root=await asset(ids[0]);root.traverse(n=>n.geometry?.addEventListener('dispose',()=>disposed++))
    const load=async()=>{loads++;return {scene:root}},device={id:'a',model_type:ids[0]}
    await measureLoadingFaces([{device,direction:1},{device:{...device,id:'b'},direction:1}],[{id:ids[0],file_path:'/m.glb'}],{load})
    assert.equal(loads,1);assert.ok(disposed>0)
    const previous=disposed
    await assert.rejects(()=>measureLoadingFaces([{device,direction:-1}],[{id:ids[0],file_path:'/m.glb'}],{load}),/背向/)
    assert.ok(disposed>previous,'release the loaded asset after a measurement error')
    await assert.rejects(()=>measureLoadingFaces([{device:{id:'unknown'},direction:1}],[],{load}),/没有模型/)
})
test('saving, renaming and moving an entire lane retain its devices\' calibrated depth',()=>{
    const source=fs.readFileSync(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')
    const code=source.slice(source.indexOf('function buildDeviceLayoutBindingPatch('),source.indexOf('function patchBoundDevicesForLayoutItem('))
    const patch=new Function('parseInstanceConfig','numberOrDefault','getLineBaseZ','roundLineLayoutValue',`return (${code.trim()})`)(parseInstanceConfig,numberOrDefault,()=>0,(v,step)=>Math.round(v/step)*step)
    const device={pos_x:-8,pos_z:-3.035,instance_config:JSON.stringify({laneId:'lane',customValue:'keep'})}
    const item={id:'lane',name:'renamed',length:60,offsetZ:-4},line={id:'line',workshop_id:'workshop'}
    assert.equal(patch(device,'lane',item,line).pos_z,-3.035)
    const moved=patch(device,'lane',{...item,offsetZ:6},line,10)
    assert.equal(moved.pos_z,6.965)
    assert.equal(patch({...device,...moved},'lane',{...item,offsetZ:6},line).pos_z,6.965,'later saves must not apply the lane delta twice')
    assert.equal(JSON.parse(moved.instance_config).customValue,'keep')
})
