import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { loadingPortRegionSurface, loadingPortRegionFromSurfaces, loadingPortRegionSize } from '../src/three/loadingPortRegion.js'
import { normalizeLoadingPorts, normalizeLoadingPortRegion, normalizeLoadingPortOverrides, resolveLoadingPort, loadingPortRegionDatum } from '../../shared/loadingPorts.mjs'
const empty=()=>({version:1,inlet:null,outlet:null})
const surface=(position,normal=[0,0,1])=>({position,surfaceNormal:normal,nodeName:'mouth'})
const regionPort=()=>loadingPortRegionFromSurfaces(surface([2,5,3]),surface([-2,1,3]))
const close=(a,b)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-8,`${a} != ${b}`))
test('two real corners produce a vertical rectangle and lower-edge transfer datum, regardless of draw order',()=>{
  for(const points of [[[2,5,3],[-2,1,3]],[[-2,1,3],[2,5,3]]]){
    const p=loadingPortRegionFromSurfaces(...points.map(point=>surface(point)))
    assert.deepEqual(p.position,[0,1,3]);assert.deepEqual(p.direction,[0,0,1]);assert.deepEqual(loadingPortRegionDatum(p.region),p.position)
    assert.deepEqual(loadingPortRegionSize(p.region),{width:4,height:4});assert.equal(p.region.corners[0][1],1);assert.equal(p.region.corners[2][1],5)
    assert.deepEqual(normalizeLoadingPorts({...empty(),inlet:p}).inlet,p)
  }
})
test('surface normal and clicked points use full glTF hierarchy root-local coordinates, not world/device placement',()=>{
  const root=new T.Group(),node=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry());root.position.set(20,4,-30);root.rotation.y=.7;root.scale.setScalar(3);node.position.set(2,1,0);node.scale.set(2,4,1);node.rotation.y=Math.PI/2;node.add(mesh);root.add(node);root.updateMatrixWorld(true)
  const point=new T.Vector3(.5,.5,.5).applyMatrix4(mesh.matrixWorld),hit={object:mesh,point,face:{normal:new T.Vector3(0,0,1)}}
  const p=loadingPortRegionSurface(hit,root);close(p.position,[2.5,3,-1]);close(p.surfaceNormal,[1,0,0]);mesh.geometry.dispose()
})
test('top/ground, grazing view, editor overlays, foreign nodes and singular coordinates are rejected',()=>{
  const root=new T.Group(),mesh=new T.Mesh(new T.BoxGeometry());root.add(mesh);root.updateMatrixWorld(true)
  const hit={object:mesh,point:new T.Vector3(),face:{normal:new T.Vector3(0,1,0)}}
  assert.throws(()=>loadingPortRegionSurface(hit,root),/顶面/);hit.face.normal.set(0,0,1)
  assert.throws(()=>loadingPortRegionSurface(hit,root,[1,0,0]),/侧视/);mesh.userData.loadingPortEditor=true;assert.throws(()=>loadingPortRegionSurface(hit,root),/标记/);mesh.userData.loadingPortEditor=false
  assert.throws(()=>loadingPortRegionSurface(hit,new T.Group()),/不属于/);root.scale.y=0;assert.throws(()=>loadingPortRegionSurface(hit,root),/不可逆/);mesh.geometry.dispose()
})
test('different face/depth and degenerate selection cannot fabricate an opening',()=>{
  for(const second of [surface([2,4,3.1]),surface([2,4,3],[1,0,0]),surface([0,4,3]),surface([2,1,3])])assert.throws(()=>loadingPortRegionFromSurfaces(surface([0,1,3]),second),/不同面|过小/)
})
test('shared v1 rejects center datum, reversed direction, nonrectangles, sparse corners and overflow',()=>{
  const p=regionPort();assert.throws(()=>normalizeLoadingPorts({...empty(),inlet:{...p,position:[0,3,3]}}),/下沿中点/)
  assert.throws(()=>normalizeLoadingPorts({...empty(),inlet:{...p,direction:[0,0,-1]}}),/实际面法线/)
  for(const region of [{...p.region,corners:Array(4)},{...p.region,corners:p.region.corners.map((r,i)=>i===2?[0,9,3]:r)},{...p.region,corners:[[-1e308,0,3],[1e308,0,3],[1e308,1,3],[-1e308,1,3]]}])assert.throws(()=>normalizeLoadingPortRegion(region))
})
test('instance region remains relative offset/yaw when model datum changes and never changes stored documents',()=>{
  const p=regionPort(),model={metadata:{loadingPorts:{...empty(),inlet:p}}},override={offset:[1,2,4],yawDegrees:90,region:p.region},device={instance_config:{loadingPortOverrides:{...empty(),inlet:override}}},before=structuredClone({model,device})
  let actual=resolveLoadingPort(model,device);close(actual.position,[1,3,7]);close(loadingPortRegionDatum(actual.region),actual.position);close(actual.direction,[1,0,0]);close(actual.region.surfaceNormal,actual.direction)
  const next=structuredClone(model);next.metadata.loadingPorts.inlet=loadingPortRegionFromSurfaces(surface([7,6,5]),surface([3,2,5]));actual=resolveLoadingPort(next,device);close(actual.position,[6,4,9]);close(loadingPortRegionDatum(actual.region),actual.position)
  assert.deepEqual({model,device},before);assert.deepEqual(normalizeLoadingPortOverrides(device.instance_config.loadingPortOverrides).inlet,override)
})
test('legacy no-region documents and empty defaults retain the exact original contract',()=>{
  const model={metadata:{loadingPorts:{...empty(),inlet:{position:[1,2,3],direction:[0,0,1],nodeName:'legacy'}}}},device={instance_config:{loadingPortOverrides:{...empty(),inlet:{offset:[4,5,6],yawDegrees:90}}}}
  const p=resolveLoadingPort(model,device);assert.equal(Object.hasOwn(p,'region'),false);close(p.position,[5,7,9]);close(p.direction,[1,0,0]);assert.equal(resolveLoadingPort({metadata:{loadingPorts:empty()}},device),null)
})
