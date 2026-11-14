import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from 'three'
import { dockingCandidates, prepareDockingCalibration, dockingPreview, dockingSavePayload } from '../src/views/admin/utils/dockingCalibration.js'

const fixture = () => {
  const line = { id: 'line', name: '产线', workshop_id: 'ws', layout_json: JSON.stringify({ version: 1, sceneUnitsPerMeter: 2, lanes: [{ id:'lane', offsetZ:-4, length:60 }], rails:[{id:'rail', offsetZ:0, length:60}] }) }
  const model = (id, position, direction) => ({id, file_path:`/${id}.glb`, default_scale:1, metadata:{loadingPorts:{version:1,inlet:{position,direction,nodeName:'mouth'},outlet:{position,direction,nodeName:'mouth'}}}})
  const device = {id:'device',name:'工位设备',model_type:'fixed',line_id:'line',coordinate_space:'line_local',pos_x:12,pos_y:.25,pos_z:-4,rotation_y:0,scale:1,instance_config:{laneId:'lane',laneLineId:'line',stationNumber:2,preserve:1}}
  const cart = {id:'cart',name:'小车',model_type:'mobile',line_id:'line',coordinate_space:'line_local',pos_x:2,pos_y:0,pos_z:0,rotation_y:0,scale:1,instance_config:{railId:'rail',railLineId:'line',role:'auxiliary',preserve:2}}
  const fixedModel=model('fixed',[1,1,1],[0,0,1]), cartModel=model('mobile',[.5,.75,-1],[0,0,-1])
  return {line,deviceResult:{success:true,device,model:fixedModel,revision:'a'.repeat(64)},cartResult:{success:true,device:cart,model:cartModel,revision:'b'.repeat(64)}}
}
const noAsset = {load:async()=>{throw Error('No asset should be loaded for explicit single ports')}}
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`)
test('candidates retain explicit same-line station/rail capability, excluding unplaced, other-line and nonmobile rail entities',()=>{
  const f=fixture(),d=f.deviceResult.device,c=f.cartResult.device
  const list=dockingCandidates([d,c,{...c,id:'rail-object',instance_config:{railId:'rail'}},{...d,id:'unplaced',coordinate_space:'workshop_local'},{...d,id:'wrong',line_id:'other'}],[f.line])
  assert.deepEqual(list.stations.map(r=>r.device.id),['device']);assert.deepEqual(list.carts.map(r=>r.device.id),['cart']);assert.match(list.stations[0].label,/工位 2/)
})
test('physical transformed mouths use native reflected X and read-only station parking; preparation never changes source',async()=>{
  const f=fixture(),before=structuredClone(f),p=await prepareDockingCalibration(f,noAsset)
  assert.deepEqual(f,before);close(p.cartPreviewX,11.5);assert.deepEqual(p.devicePort,[-11,1.25,-3]);assert.deepEqual(p.cartPort,[-11,.75,-1])
  const v=dockingPreview(p,{x:11.98,y:.27});close(v.millimeters[0],10);close(v.millimeters[1],260);close(v.millimeters[2],-1000)
  assert.equal(v.aligned,false);assert.equal(p.cartResult.device.pos_x,2)
})
test('saving only sends target X/Y, paired revisions and frozen line; no port/PLC/cart transform fields',async()=>{
  const p=await prepareDockingCalibration(fixture(),noAsset),body=dockingSavePayload(p,{x:12.1,y:.3})
  assert.deepEqual(Object.keys(body).sort(),['cartId','cartRevision','deviceId','deviceRevision','expectedLine','position'].sort())
  assert.deepEqual(body.position,{x:12.1,y:.3});assert.equal(body.cartId,'cart');assert.equal(body.expectedLine.id,'line')
  assert.throws(()=>dockingSavePayload(p,{x:'12',y:.3}),/无效/)
})
test('unknown ports, wrong-facing single cart, unsupported diagonal rail and nearest-rail mismatch fail without fabricated alignment',async()=>{
  let f=fixture();f.cartResult.model.metadata.loadingPorts.outlet=null;await assert.rejects(()=>prepareDockingCalibration(f,noAsset),/未配置/)
  f=fixture();f.cartResult.model.metadata.loadingPorts.outlet.direction=[0,0,1];await assert.rejects(()=>prepareDockingCalibration(f,noAsset),/没有相向/)
  f=fixture();f.cartResult.device.instance_config.movement={start:{x:0,y:0,z:0},end:{x:10,y:0,z:1}};await assert.rejects(()=>prepareDockingCalibration(f,noAsset),/斜向/)
  f=fixture();const l=JSON.parse(f.line.layout_json);l.rails.push({id:'far',offsetZ:30,length:60});f.line.layout_json=JSON.stringify(l);f.cartResult.device.instance_config.railId='far';await assert.rejects(()=>prepareDockingCalibration(f,noAsset),/最近导轨/)
})
test('rotating simple cart turns its physical shared mouth around platform pivot on the back-side station',async()=>{
  const f=fixture();f.cartResult.model.metadata.loadingPorts.outlet.direction=[0,0,1];f.cartResult.model.metadata.loadingPorts.outlet.position=[0,.75,1]
  f.cartResult.device.instance_config.cartTransfer={version:1,kind:'rotating',presentation:'simple',turntableNodeName:''}
  const root=new T.Group();root.add(new T.Mesh(new T.BoxGeometry(4,1,4)));let disposed=0
  const p=await prepareDockingCalibration(f,{load:async()=>({scene:root}),dispose:()=>disposed++})
  close(Math.abs(p.cartTurn.angle),Math.PI);close(p.rows[1].portPosition[2],-1);assert.deepEqual(p.rows[1].portDirection,[0,0,-1]);assert.equal(disposed,1)
})
test('custom rotating platform uses actual parent/pivot and rejects missing or tilted axes',async()=>{
  const f=fixture();f.cartResult.model.metadata.loadingPorts.outlet.direction=[0,0,1];f.cartResult.device.instance_config.cartTransfer={version:1,kind:'rotating',presentation:'model',turntableNodeName:'platform'}
  let root=new T.Group();await assert.rejects(()=>prepareDockingCalibration(f,{load:async()=>({scene:root}),dispose:()=>{}}),/节点不可用/)
  const parent=new T.Group();parent.rotation.x=Math.PI/2;const node=new T.Group();node.name='platform';parent.add(node);root.add(parent)
  await assert.rejects(()=>prepareDockingCalibration(f,{load:async()=>({scene:root}),dispose:()=>{}}),/竖直旋转轴/)
  root=new T.Group();const anchor=new T.Group();anchor.name='platform';anchor.position.set(0,.75,.2);root.add(anchor)
  const p=await prepareDockingCalibration(f,{load:async()=>({scene:root}),dispose:()=>{}});close(p.rows[1].portPosition[2],1.4)
})
test('mirrored/yaw/scale transforms remain identical to native placement',async()=>{
  const f=fixture();f.deviceResult.device.instance_config.mirrorX=true;f.deviceResult.device.scale=2;f.deviceResult.device.rotation_y=Math.PI
  f.deviceResult.model.metadata.loadingPorts.inlet.direction=[0,0,-1];const p=await prepareDockingCalibration(f,noAsset)
  close(p.devicePort[0],-10);close(p.devicePort[1],2.25);close(p.devicePort[2],-6)
})
test('nonzero JS-only shifts below native float32 precision are never submitted',async()=>{
  const f=fixture();f.deviceResult.device.pos_x=90000;const p=await prepareDockingCalibration(f,noAsset)
  assert.throws(()=>dockingSavePayload(p,{x:90000.00001,y:.25}),/Unity 无法区分/)
  assert.doesNotThrow(()=>dockingSavePayload(p,{x:90000.01,y:.25}))
})
