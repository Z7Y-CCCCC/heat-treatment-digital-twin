import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import { deviceLocalToWorld } from '../src/utils/spatialLayout.js'
import { workshopWorldToLocal, workshopFrame, constrainWorkshopTransform, WorkshopTransformHistory, workshopYawFromQuaternion } from '../src/views/admin/utils/workshopTransform.js'

const device = () => ({id:'d',coordinate_space:'line_local',pos_x:8.125,pos_y:.175,pos_z:-4.035,rotation_y:.2,instance_config:{keep:'PLC/ports'}})
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`)
test('drag frames roundtrip rotated/translated workshops and lines without reflected or doubled axes',()=>{
 for(const coordinate_space of ['line_local','workshop_local','factory_world'])for(const yaw of [0,90,135,270]){
  const d={...device(),coordinate_space},w={layout:{transform:{x:100,y:2,z:-30,rotationY:yaw}}},l={layout:{transform:{x:-5,y:-1,z:20,rotationY:35}}}
  const world=deviceLocalToWorld(d,w,l),back=workshopWorldToLocal(world,d,w,l)
  for(const [axis,key] of [['x','pos_x'],['y','pos_y'],['z','pos_z']])close(back[axis],d[key])
  const frame=workshopFrame(d,w,l),origin=deviceLocalToWorld({...d,pos_x:0,pos_y:0,pos_z:0,rotation_y:0},w,l)
  close(frame.x,origin.x);close(frame.yaw,origin.rotationY)
 }
})
test('normal row drag changes only along-line X and snaps deltas without rounding calibrated Y/Z or identity fields',()=>{
 const d=device(),copy=structuredClone(d),candidate={pos_x:8.39,pos_y:5,pos_z:8,rotation_y:2}
 const p=constrainWorkshopTransform(d,candidate,{binding:{type:'lane',item:{length:60}},units:.8,step:.1})
 close(p.pos_x,8.365);assert.equal(p.pos_y,d.pos_y);assert.equal(p.pos_z,d.pos_z);assert.equal(p.rotation_y,d.rotation_y);assert.deepEqual(d,copy)
 assert.deepEqual(Object.keys(p).sort(),['pos_x','pos_y','pos_z','rotation_y'])
})
test('cart keeps its actual calibrated rail depth and height even with spatial mode enabled; X clamps at rail ends',()=>{
 const d=device(),p=constrainWorkshopTransform(d,{pos_x:100,pos_y:50,pos_z:-99},{cart:true,spatial:true,binding:{type:'rail',item:{length:60}}})
 assert.equal(p.pos_x,30);assert.equal(p.pos_y,d.pos_y);assert.equal(p.pos_z,d.pos_z)
})
test('explicit space adjustment enables height/depth while yaw tool changes no position or scale',()=>{
 const d=device(),p=constrainWorkshopTransform(d,{pos_x:d.pos_x,pos_y:d.pos_y+.22,pos_z:d.pos_z-.39},{spatial:true})
 close(p.pos_y,d.pos_y+.2);close(p.pos_z,d.pos_z-.4)
 const r=constrainWorkshopTransform(d,{rotation_y:d.rotation_y+Math.PI},{mode:'rotate'})
 close(r.rotation_y,d.rotation_y+Math.PI);assert.equal(r.pos_x,d.pos_x);assert.equal(r.pos_y,d.pos_y);assert.equal(r.pos_z,d.pos_z)
 assert.throws(()=>constrainWorkshopTransform(d,{pos_x:NaN,pos_y:0,pos_z:0}),/无效/)
})
test('yaw ring does not fold or turn the object over when passing 90/180/270 degrees in a rotated line',()=>{
 for(const parent of [0,Math.PI/2,1.2])for(const before of [0,Math.PI/2,Math.PI,Math.PI*1.5])for(const delta of [-.4,.4,Math.PI/2]){
  const angle=before+parent+delta,q={x:0,y:Math.sin(angle/2),z:0,w:Math.cos(angle/2)}
  close(workshopYawFromQuaternion(q,before,parent),before+delta)
 }
})
test('gesture undo/redo clones reactive values, one drag is one entry, and stale sources are never overwritten',()=>{
 const h=new WorkshopTransformHistory(),before=reactive({pos_x:1,ground:null}),after=reactive({pos_x:2,ground:{enabled:true}})
 h.push('a',before,before);assert.equal(h.undo.length,0)
 h.push('a',before,after);after.ground.enabled=false
 assert.equal(h.undo[0].after.ground.enabled,true)
 assert.deepEqual(h.take(false,()=>({pos_x:2,ground:{enabled:true}})),{id:'a',value:{pos_x:1,ground:null}})
 assert.deepEqual(h.take(true,()=>({pos_x:1,ground:null})),{id:'a',value:{pos_x:2,ground:{enabled:true}}})
 assert.equal(h.take(false,()=>({pos_x:99,ground:null})),null);assert.equal(h.undo.length,0);assert.equal(h.redo.length,0)
})
