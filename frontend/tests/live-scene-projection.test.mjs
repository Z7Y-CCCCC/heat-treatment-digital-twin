import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import * as THREE from 'three'
import { applyLiveDevicePoses,applyLiveCamera,createProjectionReceiver,projectionViewport } from '../src/runtime/liveSceneProjection.js'
const require=createRequire(import.meta.url)
const {normalizeSceneProjection}=require('../../backend/utils/sceneProjection.js')
const projection=()=>({version:1,streamId:'test-stream',seq:1,sceneReady:true,camera:{position:[10,12,-20],forward:[0,0,1],up:[0,1,0],target:[10,12,0],fov:38,aspect:1.9,near:.1,far:1000},devices:[{id:'cart',visible:true,anchor:[10,5,20],matrix:new THREE.Matrix4().makeTranslation(10,0,20).toArray()}]})
test('projection transport rejects invalid camera data, oversized batches and non-affine matrices',()=>{
  const raw=projection(),normalized=normalizeSceneProjection(raw,100)
  assert.equal(normalized.available,true);assert.equal(normalized.receivedAt,100)
  assert.equal(normalizeSceneProjection({...raw,camera:{...raw.camera,fov:NaN}}),null)
  assert.equal(normalizeSceneProjection({...raw,camera:{...raw.camera,far:.05}}),null)
  assert.equal(normalizeSceneProjection({...raw,devices:Array(501).fill(raw.devices[0])}),null)
  assert.equal(normalizeSceneProjection({...raw,devices:[{...raw.devices[0],matrix:Array(16).fill(0)}]}).devices.length,0)
})
test('live device poses preserve global placement under rotated/scaled authored parents',()=>{
  const root=new THREE.Group(),parent=new THREE.Group(),device=new THREE.Group()
  parent.position.set(-5,2,3);parent.rotation.y=.75;parent.scale.set(2,1,3);root.add(parent);parent.add(device)
  const anchor={id:'cart',position:new THREE.Vector3()}
  const state={root,devices:new Map([['cart',device]]),anchors:[anchor]}
  const frame=normalizeSceneProjection(projection())
  assert.equal(applyLiveDevicePoses(state,frame),1)
  const position=device.getWorldPosition(new THREE.Vector3())
  assert.ok(position.distanceTo(new THREE.Vector3(-10,0,20))<1e-8)
  assert.deepEqual(anchor.position.toArray(),[-10,5,20])
  frame.devices[0].visible=false;applyLiveDevicePoses(state,frame);assert.equal(device.visible,false);assert.equal(anchor.visible,false)
})
test('live camera handedness, target and viewport aspect match the native projection',()=>{
  const camera=new THREE.PerspectiveCamera(),controls={target:new THREE.Vector3()}
  applyLiveCamera(camera,controls,normalizeSceneProjection(projection()))
  assert.deepEqual(camera.position.toArray(),[-10,12,-20])
  assert.deepEqual(controls.target.toArray(),[-10,12,0])
  assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(0,0,1))<1e-8)
  assert.equal(camera.aspect,1.9)
  const rect=projectionViewport(2,1920,1080)
  assert.deepEqual(rect,{x:0,y:60,width:1920,height:960})
})
test('receiver rejects stale sequence numbers, expires disconnected streams and accepts restarted runtimes',()=>{
  const receiver=createProjectionReceiver(1800),frame=normalizeSceneProjection(projection(),0)
  assert.equal(receiver.accept(frame,0),true)
  assert.equal(receiver.accept(frame,10),false)
  assert.equal(receiver.current(1801),null)
  assert.equal(receiver.accept({...frame,streamId:'new-runtime',seq:0},2000),true)
  assert.ok(receiver.current(2001))
  receiver.accept({available:false},2100);assert.equal(receiver.current(2101),null)
})
