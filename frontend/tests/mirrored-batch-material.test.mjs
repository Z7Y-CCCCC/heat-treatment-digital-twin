import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {installBrowser} from './helpers.mjs'

// Real committed CAD asset, real loader and batch code; only labels/network
// are replaced. No browser, WebGL context, live configuration or GUI is used.
const file=new URL('../../backend/assets/models/cad_multipurpose_furnace_082000.glb',import.meta.url),bytes=fs.readFileSync(file)
assert.equal(bytes.toString('utf8',0,4),'glTF','This test requires the committed LFS asset, not a local draft')
const buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)
const asset=await new Promise((resolve,reject)=>new GLTFLoader().parse(buffer,'',resolve,reject)),source=asset.scene
const metadata={optimization:{mode:'auto',mergeStatic:false,instanceRepeated:true,contactShadow:false,materialEnhancement:'original'},partBindings:[]}
const info={id:'cad_multipurpose_furnace_082000',file_path:'/furnace.glb',default_scale:1,metadata}
test.mock.module('../src/three/ModelFactory.js',{namedExports:{loadGltf:async()=>source,resolveBackendAssetUrl:p=>p,createDeviceModel(){throw Error('Original-model fallback was not requested')}}})
test.mock.module('three/examples/jsm/renderers/CSS2DRenderer.js',{namedExports:{CSS2DObject:class extends T.Object3D{constructor(element){super();this.element=element}}}})
const {createBatchedDeviceRenderer}=await import('../src/runtime/BatchDeviceRenderer.js')
const definition=(id,mirror)=>({deviceCfg:{id,name:id,model_type:info.id,pos_x:id==='a'?-7:-21,pos_y:.1,pos_z:-1.18553943,rotation_y:.31,scale:2,instance_config:{mirrorX:mirror}},devIdx:0,wsIdx:0,gLineIdx:0})
function dom(t){
 const env=installBrowser(t),context=new Proxy({createRadialGradient:()=>({addColorStop(){}})},{get:(target,key)=>target[key]??(()=>{})})
 document.createElement=()=>({style:{setProperty(){}},querySelectorAll:()=>[],getContext:()=>context})
 return env
}
const signature=()=>{const hash=crypto.createHash('sha256');source.traverse(n=>{if(!n.isMesh)return;for(const a of Object.values(n.geometry.attributes))hash.update(Buffer.from(a.array.buffer,a.array.byteOffset,a.array.byteLength));hash.update(JSON.stringify([n.position.toArray(),n.quaternion.toArray(),n.scale.toArray(),n.material.color?.toArray(),n.material.metalness,n.material.roughness]))});return hash.digest('hex')}

test('actual mirrored multipurpose furnaces retain exact geometry/PBR while renderer-facing parity moves to the draw object',async t=>{
 dom(t);const original=signature(),definitions=[definition('a',true),definition('b',true)]
 const {batchRenderer:batch,deviceModels}=await createBatchedDeviceRenderer(info,definitions,{labelConfig:{enabled:false},showStatusLight:true})
 t.after(()=>batch.dispose());batch.flushMatrixUpdates();batch.updateMatrixWorld(true);deviceModels.forEach(model=>model.updateMatrixWorld(true))
 const originalMeshes=[];source.traverse(n=>{if(n.isMesh)originalMeshes.push(n)})
 assert.equal(batch.instancedMeshes.length,originalMeshes.length,'no full-geometry fallback or additional draw per device')
 assert.ok(originalMeshes.length>100)
 let compared=0,oldFacingErrors=0
 for(let i=0;i<batch.instancedMeshes.length;i++){
  const mesh=batch.instancedMeshes[i],raw=originalMeshes[i],geometry=mesh.geometry,position=geometry.attributes.position,normal=geometry.attributes.normal
  assert.equal(mesh.material.metalness,raw.material.metalness);assert.equal(mesh.material.roughness,raw.material.roughness)
  assert.ok(mesh.matrixWorld.determinant()<0,'WebGLRenderer must see the reflection on its draw object')
  for(let j=0;j<2;j++){
   const instance=new T.Matrix4();mesh.getMatrixAt(j,instance);assert.ok(instance.determinant()>0,'negative instance determinant causes wrong DoubleSide fragment normals')
   const actual=mesh.matrixWorld.clone().multiply(instance),expected=deviceModels[j].matrixWorld
   actual.elements.forEach((value,k)=>assert.ok(Math.abs(value-expected.elements[k])<1e-6,'device placement changed'))
   for(const vertex of [0,Math.floor(position.count/2),position.count-1]){
    const a=new T.Vector3().fromBufferAttribute(position,vertex).applyMatrix4(actual),b=new T.Vector3().fromBufferAttribute(raw.geometry.attributes.position,vertex).applyMatrix4(raw.matrixWorld).applyMatrix4(expected)
    assert.ok(a.distanceTo(b)<1e-5,'a source vertex moved to hide the shading bug');compared++
   }
   const ids=[0,1,2].map(k=>geometry.index?geometry.index.getX(k):k)
   const [a,b,c]=ids.map(k=>new T.Vector3().fromBufferAttribute(position,k).applyMatrix4(actual)),cross=b.sub(a).cross(c.sub(a)).normalize()
   const transformedNormal=new T.Vector3().fromBufferAttribute(normal,ids[0]).applyNormalMatrix(new T.Matrix3().getNormalMatrix(actual))
   const rawDot=cross.dot(transformedNormal),referenceFacing=rawDot*Math.sign(expected.determinant()),fixedFacing=rawDot*Math.sign(mesh.matrixWorld.determinant())
   assert.ok(Math.abs(fixedFacing-referenceFacing)<1e-7,'raster-facing/normal parity differs from an ordinary mirrored Mesh')
   if(Math.abs(rawDot)>.1&&Math.abs(rawDot-referenceFacing)>.1)oldFacingErrors++
  }
 }
 assert.ok(oldFacingErrors>100,'the real asset must reproduce the previous facing mismatch')
 assert.ok(compared>600)
 const lampMatrix=new T.Matrix4();batch.statusLightMesh.getMatrixAt(0,lampMatrix)
 const lamp=new T.Vector3().setFromMatrixPosition(lampMatrix),expectedLamp=new T.Vector3(0,batch.statusLightOffsets[0],0).applyMatrix4(deviceModels[0].matrixWorld)
 assert.ok(lamp.distanceTo(expectedLamp)<1e-5,'status anchors were reflected twice')
 assert.equal(signature(),original,'cached asset normals, triangles, materials and authored transforms must stay unchanged')
})

test('ordinary batches keep positive instances and reject mixed parity before allocating geometry',async t=>{
 dom(t)
 const {batchRenderer:batch}=await createBatchedDeviceRenderer(info,[definition('a',false),definition('b',false)],{labelConfig:{enabled:false}})
 t.after(()=>batch.dispose());batch.flushMatrixUpdates();batch.updateMatrixWorld(true)
 for(const mesh of batch.instancedMeshes){const matrix=new T.Matrix4();mesh.getMatrixAt(0,matrix);assert.ok(mesh.matrixWorld.determinant()>0&&matrix.determinant()>0)}
 await assert.rejects(()=>createBatchedDeviceRenderer(info,[definition('a',true),definition('b',false)]),/按镜像方向分组/)
})

test('mirrored procedural batches keep contact shadows and status markers at the authored device placement',async t=>{
 dom(t)
 const builtin={id:'transfer_cart',default_scale:1,metadata:{optimization:{contactShadow:true}}}
 const {batchRenderer:batch,deviceModels}=await createBatchedDeviceRenderer(builtin,[definition('a',true),definition('b',true)],{labelConfig:{enabled:false}})
 t.after(()=>batch.dispose());batch.flushMatrixUpdates();batch.updateMatrixWorld(true);deviceModels.forEach(m=>m.updateMatrixWorld(true))
 assert.ok(batch.contactShadowMesh)
 for(let i=0;i<deviceModels.length;i++){
  const instance=new T.Matrix4();batch.contactShadowMesh.getMatrixAt(i,instance)
  assert.ok(instance.determinant()>0)
  const actual=batch.contactShadowMesh.matrixWorld.clone().multiply(instance)
  actual.elements.forEach((v,k)=>assert.ok(Math.abs(v-deviceModels[i].matrixWorld.elements[k])<1e-6))
 }
 deviceModels[0].position.x+=3;batch.update();batch.updateMatrixWorld(true);deviceModels[0].updateMatrixWorld(true)
 const updated=new T.Matrix4();batch.instancedMeshes[0].getMatrixAt(0,updated)
 assert.equal(batch.instancedMeshes[0].matrixWorld.clone().multiply(updated).elements[12],deviceModels[0].position.x)
})

test('real mirrored furnace batches use lightweight editor solids only when the layout profile requests them',async t=>{
 dom(t);const original=signature()
 const {batchRenderer:batch}=await createBatchedDeviceRenderer(info,[definition('a',true),definition('b',true)],{renderProfile:'layout-editor',labelConfig:{enabled:false}})
 t.after(()=>batch.dispose());batch.flushMatrixUpdates();batch.updateMatrixWorld(true)
 for(const mesh of batch.instancedMeshes){
  assert.ok(mesh.material.isMeshLambertMaterial);assert.equal(mesh.material.envMap,null);assert.equal(mesh.material.metalness,undefined)
  const instance=new T.Matrix4();mesh.getMatrixAt(0,instance);assert.ok(instance.determinant()>0&&mesh.matrixWorld.determinant()<0)
 }
 assert.equal(signature(),original)
})
