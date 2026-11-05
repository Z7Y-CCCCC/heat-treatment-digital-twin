import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {CART_FEED,CART_WORK_CHAIN} from '../src/three/cartFeedMechanism.js'
import {PortableMotionPlayer} from '../src/three/PortableMotionPlayer.js'
import {restoreGltfNodeNames} from '../src/three/gltfNodeIdentity.js'
const id='cad_transfer_cart_101300'
async function load(file){const b=fs.readFileSync(new URL('../../backend'+file,import.meta.url));const g=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');restoreGltfNodeNames(g);return g.scene}
function inspect(root){
 root.updateMatrixWorld(true)
 const node=name=>root.getObjectByName('preview_'+name),point=n=>root.worldToLocal(n.getWorldPosition(new T.Vector3()))
 const anchor=point(node('chain_carriage_anchor')),entry=point(node('chain_case_entry')).add(new T.Vector3(0,.018,0)),links=[]
 root.traverse(n=>{if(/^preview_working_chain_link_\d+$/.test(n.name)&&n.visible)links.push(n)})
 links.sort((a,b)=>Number(a.name.split('_').at(-1))-Number(b.name.split('_').at(-1)))
 assert.ok(links.length>=4)
 assert.ok(point(links[0]).distanceTo(anchor)<1e-6,'first chain roller stays pinned to the actual moving carriage clamp')
 const firstRoller=links[0].getObjectByName('preview_working_chain_piece_0_0'),box=new T.Box3().setFromObject(firstRoller)
 assert.ok(box.getCenter(new T.Vector3()).distanceTo(firstRoller.parent.parent.getWorldPosition(new T.Vector3()))<1e-5,'the rendered roller geometry meets its pin, not just an empty group')
 assert.ok(point(links.at(-1)).distanceTo(entry)<=CART_WORK_CHAIN.pitch+.001,'chain ends inside the rear housing entry')
 for(let i=1;i<links.length;i++){
  const d=point(links[i]).distanceTo(point(links[i-1]));assert.ok(d<=CART_WORK_CHAIN.pitch+.001&&d>CART_WORK_CHAIN.pitch*.7,'consecutive metal links form a continuous strand')
 }
 for(const link of links){const p=point(link);assert.ok(Math.abs(p.z-CART_WORK_CHAIN.z)<1e-6);if(p.x<=CART_WORK_CHAIN.entryX)assert.ok(Math.abs(p.y-CART_WORK_CHAIN.y)<1e-6,'working chain stays on its central guide')}
 return {anchor,entry,count:links.length,first:point(links[0])}
}
test('cart chain remains mechanically attached to the hook carriage throughout full feed, return and transformed coordinated travel',async()=>{
 const root=await load('/assets/models/'+id+'.glb'),rig=new CadMotionRig(root,id),initial=inspect(root)
 const guide=rig.root.getObjectByName('preview_working_chain_guide'),guidePosition=guide.position.clone()
 try{
  for(const p of [0,.1,.25,.5,.75,1,.7,.2,0]){
   rig.applyLinked({feed:p});const state=inspect(root)
   assert.ok(Math.abs(state.anchor.x-initial.anchor.x+CART_FEED.stroke*p)<1e-6)
   assert.ok(guide.position.equals(guidePosition));if(p===1)assert.ok(state.count>initial.count+20)
  }
  for(const t of [0,2,4,6,8]){rig.apply('feed',t);inspect(root)}
  const wrapper=new T.Group();wrapper.add(root);wrapper.position.set(15,2,-4);wrapper.rotation.y=.6;wrapper.scale.setScalar(1.5)
  for(const p of [0,.5,1,0]){rig.applyLinked({feed:p,feedTravel:1.2});inspect(root)}
  rig.reset();inspect(root)
 }finally{rig.dispose()}
})
test('exported PLC feeding clip drives the same visible chain and carriage pin connection',async()=>{
 const registry=JSON.parse(fs.readFileSync(new URL('../../shared/motionPackages.json',import.meta.url))),manifest=registry.models[id]
 const root=await load(manifest.rigPath),data=JSON.parse(fs.readFileSync(new URL('../../backend'+manifest.clipPath,import.meta.url)))
 const player=new PortableMotionPlayer(root,data,[{enabled:true,kind:'clip',clipId:'feed',mode:'position',sourceGroup:'mechanisms',sourceKey:'feed',inputMin:0,inputMax:1,transitionSeconds:0}])
 for(const p of [0,.125,.25,.5,.75,1,.5,0]){player.receive({mechanisms:{feed:p}},0);player.advance(0,0);inspect(root)}
})
