import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { createRequire } from 'node:module'
import { loadingPortRegionSurface, loadingPortRegionFromSurfaces, loadingPortRegionSize } from '../src/three/loadingPortRegion.js'
import { normalizeLoadingPorts, normalizeLoadingPortRegion, normalizeLoadingPortOverrides, resolveLoadingPort,
  resolveLoadingPortSource, loadingPortFromRegion, loadingPortRegionDatum } from '../../shared/loadingPorts.mjs'
const cjs = createRequire(import.meta.url)('../../shared/loadingPorts.cjs')
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
test('an explicitly saved instance rectangle is the absolute actual port, independent of old offsets and later model edits',()=>{
  const p=regionPort(),model={metadata:{loadingPorts:{...empty(),inlet:p}}}
  const selection=loadingPortRegionFromSurfaces(surface([7,6,5]),surface([3,2,5]))
  const override={offset:[1,2,4],yawDegrees:-180,region:selection.region},device={instance_config:{loadingPortOverrides:{...empty(),inlet:override}}},before=structuredClone({model,device})
  for (const api of [{resolveLoadingPort,resolveLoadingPortSource},cjs]) {
    assert.deepEqual(api.resolveLoadingPort(model,device),selection)
    assert.equal(api.resolveLoadingPortSource(model,device),'instance-region')
    const next=structuredClone(model);next.metadata.loadingPorts.inlet=loadingPortRegionFromSurfaces(surface([-1,10,9],[-1,0,0]),surface([-1,7,4],[-1,0,0]))
    assert.deepEqual(api.resolveLoadingPort(next,device),selection,'a later model calibration cannot relocate a saved device rectangle')
  }
  assert.deepEqual({model,device},before);assert.deepEqual(normalizeLoadingPortOverrides(device.instance_config.loadingPortOverrides).inlet,override)
})
test('a saved model rectangle cannot be shifted or flipped by a legacy instance correction',()=>{
  const p=loadingPortRegionFromSurfaces(surface([-1,1,2],[-1,0,0]),surface([-1,4,-2],[-1,0,0]))
  const model={metadata:{loadingPorts:{...empty(),inlet:p}}},device={instance_config:{loadingPortOverrides:{...empty(),inlet:{offset:[200,.02422951,.02012465],yawDegrees:-180}}}},before=structuredClone({model,device})
  for (const api of [{resolveLoadingPort,resolveLoadingPortSource},cjs]) {
    assert.deepEqual(api.resolveLoadingPort(model,device),p)
    assert.equal(api.resolveLoadingPortSource(model,device),'model-region')
    assert.deepEqual(api.resolveLoadingPort(model,null),p)
  }
  assert.deepEqual({model,device},before,'reading actual geometry must not reset or migrate stored legacy values')
})
test('absolute instance region also takes priority over a point-only model without changing the other port',()=>{
  const p=regionPort(),base={position:[99,88,77],direction:[1,0,0],nodeName:'legacy'}
  const model={metadata:{loadingPorts:{version:1,inlet:base,outlet:base}}},device={instance_config:{loadingPortOverrides:{version:1,inlet:{offset:[50,60,70],yawDegrees:123,region:p.region},outlet:{offset:[1,2,3],yawDegrees:90}}}}
  assert.deepEqual(resolveLoadingPort(model,device),p)
  close(resolveLoadingPort(model,device,'outlet').position,[100,90,80]);close(resolveLoadingPort(model,device,'outlet').direction,[0,0,-1])
  assert.equal(resolveLoadingPortSource(model,device,'outlet'),'instance-point')
})
test('region corners and normal are the sole geometry even when scalar model values differ within validation tolerance',()=>{
  const selection=regionPort(),slightlyDifferent={...structuredClone(selection),position:[1e-7,1,3],direction:[1e-6,0,1]}
  const model={metadata:{loadingPorts:{...empty(),inlet:slightlyDifferent}}},before=structuredClone(model)
  assert.ok(normalizeLoadingPorts(model.metadata.loadingPorts).inlet)
  for (const api of [{resolveLoadingPort},cjs]) {
    assert.deepEqual(api.resolveLoadingPort(model,null),selection,'matching tolerance must not make old scalar coordinates a second source')
  }
  assert.deepEqual(model,before)
})
test('region geometry derives the lower datum and horizontal normal and uses the actual region node name',()=>{
  const region={version:1,corners:[[-1,1,3],[1,1,3],[1,5,4],[-1,5,4]],surfaceNormal:[0,-1,4]}
  const p=loadingPortFromRegion(region,'fallback-node')
  assert.deepEqual(p.position,[0,1,3]);assert.deepEqual(p.direction,[0,0,1]);assert.equal(p.nodeName,'fallback-node')
  assert.equal(loadingPortFromRegion({...region,nodeName:'real-surface'},'fallback-node').nodeName,'real-surface')
  assert.deepEqual(cjs.loadingPortFromRegion(region,'fallback-node'),p)
})
test('an instance rectangle cannot create an explicitly absent model port and source labels respect strict validation',()=>{
  const device={instance_config:{loadingPortOverrides:{...empty(),inlet:{offset:[1,2,3],yawDegrees:90,region:regionPort().region}}}}
  for (const api of [{resolveLoadingPort,resolveLoadingPortSource},cjs]) {
    assert.equal(api.resolveLoadingPort({metadata:{loadingPorts:empty()}},device),null)
    assert.equal(api.resolveLoadingPortSource({metadata:{loadingPorts:empty()}},device),'none')
    assert.throws(()=>api.resolveLoadingPortSource({metadata:{loadingPorts:empty()}},device,'invalid'),/inlet 或 outlet/)
    const malformed=structuredClone(device);malformed.instance_config.loadingPortOverrides.inlet.yawDegrees='0'
    assert.throws(()=>api.resolveLoadingPort({metadata:{loadingPorts:{...empty(),inlet:regionPort()}}},malformed),/有限数字/,'ignored legacy fields remain strictly validated')
  }
})
test('legacy no-region documents and empty defaults retain the exact original contract',()=>{
  const model={metadata:{loadingPorts:{...empty(),inlet:{position:[1,2,3],direction:[0,0,1],nodeName:'legacy'}}}},device={instance_config:{loadingPortOverrides:{...empty(),inlet:{offset:[4,5,6],yawDegrees:90}}}}
  const p=resolveLoadingPort(model,device);assert.equal(Object.hasOwn(p,'region'),false);close(p.position,[5,7,9]);close(p.direction,[1,0,0]);assert.equal(resolveLoadingPort({metadata:{loadingPorts:empty()}},device),null)
  assert.equal(resolveLoadingPortSource(model,device),'instance-point');assert.equal(resolveLoadingPortSource(model,null),'model-point')
})
