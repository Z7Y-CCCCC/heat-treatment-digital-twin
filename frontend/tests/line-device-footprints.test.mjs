import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import {lineDeviceFootprint,measureLineDevices} from '../src/three/lineDeviceFootprints.js'

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
