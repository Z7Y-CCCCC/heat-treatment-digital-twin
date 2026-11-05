import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as T from 'three'
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js'
import {CadMotionRig} from '../src/three/CadMotionRig.js'
import {PortableMotionPlayer} from '../src/three/PortableMotionPlayer.js'
import {restoreGltfNodeNames} from '../src/three/gltfNodeIdentity.js'

const id='cad_lifting_load_table_111400'
async function load(file){const b=fs.readFileSync(new URL('../../backend'+file,import.meta.url));const g=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');restoreGltfNodeNames(g);return g.scene}
function geometryCenter(root,node){const box=new T.Box3();node.traverse(n=>{if(n.isMesh){const a=n.geometry.attributes.position;for(let i=0;i<a.count;i++)box.expandByPoint(root.worldToLocal(n.localToWorld(new T.Vector3().fromBufferAttribute(a,i))))}});return box.getCenter(new T.Vector3())}
function assertConnected(root){
 root.updateMatrixWorld(true)
 const node=name=>root.getObjectByName('preview_'+name),point=n=>root.worldToLocal(n.getWorldPosition(new T.Vector3()))
 const eyeMesh=node('lift_upper_eye')
 assert.ok(eyeMesh)
 const base=point(node('cylinder')),eye=geometryCenter(root,eyeMesh),cross=point(node('lift_crosshead'))
 assert.ok(eye.distanceTo(cross)<.002,'the actual upper mounting eye stays on the cross shaft')
 const centers=[];root.traverse(n=>{if(/^preview_scissor_\d+$/.test(n.name))centers.push(point(n))})
 assert.equal(centers.length,4)
 for(const p of centers){assert.ok(Math.abs(p.x-cross.x)<1e-6&&Math.abs(p.y-cross.y)<1e-6,'cross shaft joins all four scissor-arm centres');assert.ok(Math.abs(p.z)<.39)}
 const axis=eye.clone().sub(base).normalize(),distance=eye.distanceTo(base)
 const interval=mesh=>{const a=mesh.geometry.attributes.position,values=[];for(let i=0;i<a.count;i++)values.push(root.worldToLocal(mesh.localToWorld(new T.Vector3().fromBufferAttribute(a,i))).sub(base).dot(axis));return {min:Math.min(...values),max:Math.max(...values)}}
 const barrel=node('cylinder').getObjectByProperty('isMesh',true),rod=node('cylinder_rod').getObjectByProperty('isMesh',true)
 assert.ok(barrel&&rod)
 const b=interval(barrel),r=interval(rod)
 assert.ok(Math.abs(b.min)<.004,'barrel remains mounted at its base')
 assert.ok(Math.abs(r.max-distance)<.004,'rod tip remains at its upper eye')
 assert.ok(r.min<b.max-.02&&r.min>b.min,'rod always overlaps the barrel bore instead of floating above it')
 assert.ok(r.max>b.max+.01,'rod remains extended beyond the barrel end')
 for(const mesh of [barrel,rod])assert.ok(geometryCenter(root,mesh).clone().sub(base).cross(axis).length()<.002,'barrel and piston share one axis')
 return {base,barrelLength:b.max-b.min,rodLength:r.max-r.min}
}
test('lift cylinder stays pinned to the base and scissor cross shaft over both full strokes, seeking, resets and coordinated movement',async()=>{
 const root=await load('/assets/models/'+id+'.glb'),rig=new CadMotionRig(root,id),initial=assertConnected(root)
 try{
  for(const action of ['lift_up','lift_down'])for(const time of [0,1,2,3,4,5,6,7,8,4,0]){
   rig.apply(action,time);const pose=assertConnected(root)
   assert.ok(pose.base.distanceTo(initial.base)<1e-6)
   assert.ok(Math.abs(pose.barrelLength-initial.barrelLength)<1e-6&&Math.abs(pose.rodLength-initial.rodLength)<1e-6,'rigid parts retain their lengths')
  }
  for(const lift of [0,.25,.5,1,.75,0]){rig.applyLinked({lift});assertConnected(root)}
  rig.reset();assertConnected(root)
  const wrapper=new T.Group();wrapper.position.set(17,2,-5);wrapper.rotation.y=.7;wrapper.scale.set(1.5,1.5,1.5);wrapper.add(root)
  rig.apply('lift_up',4);assertConnected(root)
 }finally{rig.dispose()}
})
test('portable PLC lift clips preserve the same cylinder connections at all measured positions',async()=>{
 const registry=JSON.parse(fs.readFileSync(new URL('../../shared/motionPackages.json',import.meta.url))),manifest=registry.models[id]
 const root=await load(manifest.rigPath),data=JSON.parse(fs.readFileSync(new URL('../../backend'+manifest.clipPath,import.meta.url)))
 for(const clipId of ['lift_up','lift_down']){
  const binding={enabled:true,kind:'clip',clipId,mode:'position',sourceGroup:'mechanisms',sourceKey:'lift',inputMin:0,inputMax:1,transitionSeconds:0}
  const player=new PortableMotionPlayer(root,data,[binding])
  for(const p of [0,.125,.25,.5,.75,1,.3,0]){player.receive({mechanisms:{lift:p}},0);player.advance(0,0);assertConnected(root)}
 }
})
