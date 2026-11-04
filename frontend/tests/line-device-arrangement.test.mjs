import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import {arrangeLineDevices} from '../src/views/admin/utils/lineDeviceArrangement.js'
import {lineDeviceFootprint,measureLineDevices} from '../src/three/lineDeviceFootprints.js'
const target={type:'lane',item:{id:'lane',name:'设备线',length:60,offsetZ:8}}
const rows=[{id:'a',minX:-2,maxX:1},{id:'b',minX:.5,maxX:5},{id:'c',minX:-1,maxX:1}]
test('net spacing uses actual outer surfaces of different size and off-center models without mutating the source',()=>{
 const before=JSON.stringify(rows),plan=arrangeLineDevices(rows,target,{gap:1.25,anchor:'center'})
 assert.equal(plan[0].left,-plan.at(-1).right)
 for(let i=1;i<plan.length;i++)assert.ok(Math.abs(plan[i].left-plan[i-1].right-1.25)<1e-6)
 assert.ok(plan.every(p=>p.z===8&&p.binding===target));assert.equal(JSON.stringify(rows),before)
 assert.notEqual(plan[1].x-plan[0].x,plan[2].x-plan[1].x,'equal clearance need not mean equal centers')
})
test('batch append clears existing devices and does not reposition them; start is an outer edge',()=>{
 const occupied=[{id:'fixed',name:'已有炉',x:8,minX:-2,maxX:3}]
 assert.equal(arrangeLineDevices(rows,target,{occupied,gap:.5})[0].left,11.5)
 assert.equal(arrangeLineDevices(rows,target,{anchor:'start',start:-20,gap:0})[0].left,-20)
 assert.equal(occupied[0].x,8)
 assert.throws(()=>arrangeLineDevices(rows,target,{occupied:[{...occupied[0],x:0}],anchor:'center'}),/重叠/)
})
test('physical lane boundaries and center spacing prevent overlap and never squeeze the requested clearance',()=>{
 const pair=[{id:'a',minX:-2,maxX:2},{id:'b',minX:-2,maxX:2}],short={...target,item:{...target.item,length:10}}
 const exact=arrangeLineDevices(pair,short,{gap:2,anchor:'center'});assert.equal(exact[0].left,-5);assert.equal(exact[1].right,5)
 assert.throws(()=>arrangeLineDevices(pair,short,{gap:2.01,anchor:'center'}),/超出/)
 assert.throws(()=>arrangeLineDevices(pair,target,{gap:3,spacing:'center',anchor:'center'}),/重叠/)
 assert.equal(arrangeLineDevices(pair,target,{gap:6,spacing:'center',anchor:'center'})[1].x,3)
 for(const gap of [-1,NaN,Infinity,''])assert.throws(()=>arrangeLineDevices(rows,target,{gap}))
 assert.throws(()=>arrangeLineDevices([],target));assert.throws(()=>arrangeLineDevices([rows[0],rows[0]],target))
})
test('model footprints match scene scale, local rotation and mirrored handedness while retaining authored origins',()=>{
 const root=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry(2,1,4),new T.MeshBasicMaterial());mesh.position.x=3;root.add(mesh)
 const device={scale:1,rotation_y:0,instance_config:{}},model={default_scale:1}
 assert.deepEqual(lineDeviceFootprint(root,device,model),{minX:-4,maxX:-2})
 assert.deepEqual(lineDeviceFootprint(root,{...device,instance_config:{mirrorX:true}},model),{minX:2,maxX:4})
 assert.deepEqual(lineDeviceFootprint(root,{...device,scale:2,instance_config:{scaleMultiplier:3}},{default_scale:.5}),{minX:-12,maxX:-6})
 const turned=lineDeviceFootprint(root,{...device,rotation_y:Math.PI/2},model);assert.ok(Math.abs(turned.minX+2)<1e-6&&Math.abs(turned.maxX-2)<1e-6)
 assert.equal(mesh.position.x,3);assert.equal(root.parent,null)
})
test('one model load serves repeated instances and is disposed after measurement or cancellation',async()=>{
 let loaded=0,disposed=0;const root=new T.Group(),geometry=new T.BoxGeometry(2,1,4);geometry.addEventListener('dispose',()=>disposed++);root.add(new T.Mesh(geometry,new T.MeshBasicMaterial()))
 const load=async()=>{loaded++;return {scene:root}},devices=[{id:'a',model_type:'m',scale:1},{id:'b',model_type:'m',scale:2}]
 const result=await measureLineDevices(devices,[{id:'m',file_path:'/m.glb'}],{load});assert.equal(loaded,1);assert.equal(disposed,1);assert.equal(result[1].maxX-result[1].minX,4)
 await assert.rejects(()=>measureLineDevices([{id:'missing',model_type:'missing'}],[],{load}),/没有模型/)
 const controller=new AbortController();controller.abort();await assert.rejects(()=>measureLineDevices(devices,[],{signal:controller.signal,load}),/取消/)
})
