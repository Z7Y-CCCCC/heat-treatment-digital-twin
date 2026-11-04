import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import * as T from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PortableMotionPlayer,receiveMotionSignal,stepMotionSignal,sampleMotionTrack } from '../src/three/PortableMotionPlayer.js'
import { CAD_MOTION_PROFILES } from '../src/three/cadMotionProfiles.js'
import { restoreGltfNodeNames } from '../src/three/gltfNodeIdentity.js'
import {CART_FEED} from '../src/three/cartFeedMechanism.js'
const registry=JSON.parse(fs.readFileSync(new URL('../../shared/motionPackages.json',import.meta.url)))
const binding={enabled:true,kind:'clip',mode:'position',sourceGroup:'doors',sourceKey:'open',pointId:'42',inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:2}
const frame=(value,patch={})=>({doors:{open:value},pointMeta:{'doors.open':{id:42}},quality:{doors:{open:'good'}},...patch})

test('portable cart feeds the mounted hook and releases its latch while chain guides stay fixed',async()=>{
 const manifest=registry.models.cad_transfer_cart_101300,binary=fs.readFileSync(new URL('../../backend'+manifest.rigPath,import.meta.url)),data=JSON.parse(fs.readFileSync(new URL('../../backend'+manifest.clipPath,import.meta.url)))
 const gltf=await new GLTFLoader().parseAsync(binary.buffer.slice(binary.byteOffset,binary.byteOffset+binary.byteLength),'');restoreGltfNodeNames(gltf)
 const root=gltf.scene,node=name=>root.getObjectByName('cad_transfer_cart_v1_'+name),hook=node('push_hook'),guide=node('pusher_metal'),latch=node('hook_latch')
 assert.ok(hook&&guide&&latch);root.updateMatrixWorld(true)
 const world=object=>object.getWorldPosition(new T.Vector3()),home=world(hook),guideMatrix=guide.matrixWorld.clone()
 const player=new PortableMotionPlayer(root,data,[{...binding,transitionSeconds:0,clipId:'feed'}])
 for(const progress of [0,.25,1,.5,0]){
  player.receive(frame(progress),0);player.advance(0,0);root.updateMatrixWorld(true)
  assert.ok(Math.abs(world(hook).x-home.x+CART_FEED.stroke*progress)<1e-6);assert.ok(guide.matrixWorld.equals(guideMatrix))
 }
 const release=new PortableMotionPlayer(root,data,[{...binding,transitionSeconds:0,clipId:'hook'}])
 release.receive(frame(1),0);release.advance(0,0);assert.ok(Math.abs(latch.rotation.z+.65)<1e-6)
});

test('portable lift actions keep every roller on the deck throughout measured stroke and return',async()=>{
 const manifest=registry.models.cad_lifting_load_table_111400
 const binary=fs.readFileSync(new URL('../../backend'+manifest.rigPath,import.meta.url))
 const data=JSON.parse(fs.readFileSync(new URL('../../backend'+manifest.clipPath,import.meta.url)))
 const gltf=await new GLTFLoader().parseAsync(binary.buffer.slice(binary.byteOffset,binary.byteOffset+binary.byteLength),'');restoreGltfNodeNames(gltf)
 const root=gltf.scene,deck=root.getObjectByName('cad_lifting_staging_table_v1_roller_bed'),rollers=[]
 root.traverse(node=>{if(node.name.startsWith('preview_roller_'))rollers.push(node)})
 assert.ok(deck&&rollers.length>0);root.updateMatrixWorld(true)
 const world=node=>node.getWorldPosition(new T.Vector3()),origin=world(deck),offsets=rollers.map(roller=>world(roller).sub(origin))
 for(const clipId of ['lift_up','lift_down']){
  const player=new PortableMotionPlayer(root,data,[{...binding,transitionSeconds:0,clipId}])
  for(const progress of [0,.25,.5,.75,1,0]){
   player.receive(frame(progress),0);player.advance(0,0);root.updateMatrixWorld(true)
   assert.ok(Math.abs(world(deck).y-origin.y-(clipId==='lift_up'?.24:-.24)*progress)<1e-6)
   rollers.forEach((roller,index)=>assert.ok(world(roller).sub(world(deck)).distanceTo(offsets[index])<1e-6,`${clipId} ${progress}: exported roller ${index} must stay attached to the deck`))
  }
 }
})
test('signal mapping snaps first acquisition, reverses without restarting and freezes on stale/bad/missing data',()=>{
 const s={seconds:0};receiveMotionSignal(s,binding,frame(0),0);receiveMotionSignal(s,binding,frame(1),1);stepMotionSignal(s,binding,.5,1.5,5000);assert.equal(s.position,.25)
 receiveMotionSignal(s,binding,frame(1),1.5);stepMotionSignal(s,binding,.5,2,5000);assert.equal(s.position,.5)
 receiveMotionSignal(s,binding,frame(0),2);stepMotionSignal(s,binding,.2,2.2,5000);assert.equal(s.position,.4)
 receiveMotionSignal(s,binding,frame(1,{quality:{doors:{open:'bad'}}}),3);stepMotionSignal(s,binding,100,4,5000);assert.equal(s.position,.4)
 receiveMotionSignal(s,binding,frame(1),5);stepMotionSignal(s,binding,100,12,5000);assert.equal(s.reason,'数据超时');assert.equal(s.position,.4)
 for(const raw of [null,'',{},[],[1],'0x01',NaN,Infinity]){receiveMotionSignal(s,binding,frame(raw),13);assert.equal(s.usable,false)}
 receiveMotionSignal(s,binding,frame(1,{pointMeta:{'doors.open':{id:'other'}}}),15);assert.equal(s.usable,false)
 const fresh={seconds:0};receiveMotionSignal(fresh,binding,frame(true),0);assert.equal(fresh.position,1)
})
test('installer carries the motion registry together with backend assets (without broadening credential filters)',()=>{
 const options=JSON.parse(fs.readFileSync(new URL('../../desktop/package.json',import.meta.url))).build.extraResources
 const shared=options.find(x=>x.to==='shared'),backend=options.find(x=>x.to==='backend')
 assert.ok(shared.filter.includes('motionPackages.json'))
 assert.ok(backend.filter.includes('**/*'))
 assert.ok(!backend.filter.some(p=>p.startsWith('!assets/motions')))
})
test('measured door stroke is linear, not the eased timeline of an open/close demonstration',()=>{
 const data=JSON.parse(fs.readFileSync(new URL('../../backend/assets/motions/cad_cleaner_170700.json',import.meta.url)))
 const clip=data.clips.find(c=>c.id==='door'),track=clip.tracks.find(t=>t.channel==='p'&&t.node.endsWith('_door'))
 for(const p of [0,.25,.37,.75,1])assert.ok(Math.abs(sampleMotionTrack(clip,track,p*clip.duration)[1]-.9*p)<.00001)
})
test('portable cleaner keeps the lower bath visible and exports full downward and upward strokes',()=>{
 const data=JSON.parse(fs.readFileSync(new URL('../../backend/assets/motions/cad_cleaner_170700.json',import.meta.url)))
 assert.ok(!data.clips.some(c=>['fill','drain'].includes(c.id)))
 const volumes=data.nodes.filter(n=>n.name.startsWith('preview_cleaner_bath_'))
 assert.equal(volumes.length,3);assert.ok(volumes.every(n=>n.v[0]===1&&n.s[1]>1))
 for(const id of ['basket_down','basket_up']){
  const clip=data.clips.find(c=>c.id===id),track=clip.tracks.find(t=>t.channel==='p'&&t.node.endsWith('_internal_rollers'))
  for(const p of [0,.25,.5,.75,1])assert.ok(Math.abs(sampleMotionTrack(clip,track,p*clip.duration)[1]+.8*(id==='basket_down'?p:1-p))<.00001)
 }
 for(const clip of data.clips)assert.ok(!clip.tracks.some(t=>volumes.some(n=>n.name===t.node)),'water level never animates')
})
test('running is read-only, stops without accumulating angle, and input inversion is explicit',()=>{
 const b={...binding,mode:'running',invert:true,transitionSeconds:0,speed:2},s={seconds:0}
 receiveMotionSignal(s,b,frame(false),1);stepMotionSignal(s,b,.5,1.5,5000);assert.equal(s.seconds,1)
 receiveMotionSignal(s,b,frame(true),2);stepMotionSignal(s,b,1,3,5000);assert.equal(s.seconds,1)
})
for(const [id,manifest] of Object.entries(registry.models))test(`${id}: immutable source, portable rig identities and all native-compatible channels`,async()=>{
 const read=p=>fs.readFileSync(new URL('../../backend'+p,import.meta.url)),hash=b=>crypto.createHash('sha256').update(b).digest('hex')
 assert.equal(hash(read(manifest.sourcePath)),manifest.sourceSha256);const binary=read(manifest.rigPath),json=read(manifest.clipPath)
 assert.equal(hash(binary),manifest.rigSha256);assert.equal(hash(json),manifest.clipSha256)
 const data=JSON.parse(json),gltf=await new GLTFLoader().parseAsync(binary.buffer.slice(binary.byteOffset,binary.byteOffset+binary.byteLength),'');restoreGltfNodeNames(gltf)
 const actions=CAD_MOTION_PROFILES[id]?.actions||[{id:'fill'},{id:'heat'},{id:'spray'},{id:'ultrasonic'},{id:'drain'},{id:'blow'}]
 assert.deepEqual(data.clips.map(a=>a.id),actions.map(a=>a.id));assert.ok(data.nodes.length>50)
 for(const clip of data.clips){
   const b={...binding,clipId:clip.id,mode:clip.mode,transitionSeconds:0},player=new PortableMotionPlayer(gltf.scene,data,[b]),snapshot=()=>{gltf.scene.updateMatrixWorld(true);return [...player.nodes].map(([k,n])=>[k,...n.position,...n.quaternion,...n.scale,n.visible])}
   player.receive(frame(clip.mode==='running'?1:.37),0);player.advance(clip.mode==='running'?clip.duration*.37:0,0)
   for(const track of clip.tracks){assert.match(track.channel,/^[pqs v]$|^[ce]\d+$/);assert.equal(track.values.length,clip.count*track.size);assert.ok(track.values.every(Number.isFinite));const sample=sampleMotionTrack(clip,track,clip.duration*.37),node=player.nodes.get(track.node);assert.ok(node,track.node);if(track.channel==='p')sample.forEach((v,i)=>assert.ok(Math.abs(node.position.getComponent(i)-v)<1e-6))}
   const before=snapshot();player.advance(0,100);const mechanical=()=>snapshot().map(r=>r.slice(0,-1));const frozen=mechanical();player.advance(100,101);assert.deepEqual(mechanical(),frozen,'stale mechanical pose stays fixed');assert.ok(before.length)
 }
})
