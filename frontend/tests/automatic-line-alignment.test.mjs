import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parse } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import { lineDeviceEnvelope } from '../src/three/lineDeviceFootprints.js'
import { inferLoadingPort } from '../src/three/lineLoadingAlignment.js'
import { planLineMouthOrientations, prepareGuidedLineArrangement } from '../../shared/lineGuidedArrangement.mjs'
import { assertLineTemplateClearance } from '../../shared/linePlacementTemplate.mjs'
import { syncLineRailLength } from '../../shared/lineRailLength.mjs'

const clone=structuredClone
const model=(id,position,direction)=>({id,default_scale:1,metadata:{loadingPorts:{version:1,inlet:{position,direction,nodeName:''},outlet:{position,direction,nodeName:''}}}})
test('a new empty line can create its first rail without inventing a device pose or changing its saved source',async()=>{
  const layout={lanes:[{id:'a',offsetZ:0,length:60}],rails:[]},before=clone(layout)
  const plan=await prepareGuidedLineArrangement(layout,'single-negative',[])
  assert.deepEqual(layout,before);assert.equal(plan.layout.rails.length,1);assert.deepEqual(plan.deviceTransforms,[])
})
function fixture(){
  const root=new THREE.Group(),body=new THREE.Mesh(new THREE.BoxGeometry(2,2,2));body.position.y=1;root.add(body)
  const models=[model('fixed',[0,1,1],[0,0,1]),model('cad_transfer_cart_101300',[-1,1,0],[-1,0,0])]
  const devices=[0,Math.PI,Math.PI/2].map((yaw,i)=>({id:`fixed-${i}`,name:`工位 ${i+1}`,model_type:'fixed',pos_x:-10+i*10,pos_y:.125,pos_z:-5,rotation_y:yaw,scale:1,
    instance_config:{laneId:'a',laneLineId:'L',stationNumber:10+i,loadingPortOverrides:{version:1,inlet:null,outlet:null},preserve:{binding:'unchanged'}}}))
  devices.push({id:'cart',name:'单向小车',model_type:'cad_transfer_cart_101300',pos_x:-20,pos_y:.125,pos_z:.5,rotation_y:Math.PI/2,scale:1,
    instance_config:{railId:'r',railLineId:'L',movement:{enabled:true,start:{x:-25,y:.125,z:.5},end:{x:25,y:.125,z:.5}}}})
  const layout={sceneUnitsPerMeter:1,lanes:[{id:'a',name:'设备线',offsetZ:-5,length:60}],rails:[{id:'r',offsetZ:.5,length:60}]}
  const measure=source=>source.map(d=>({id:d.id,name:d.name,x:d.pos_x,y:d.pos_y,z:d.pos_z,...lineDeviceEnvelope(root,d,models.find(m=>m.id===d.model_type),{parts:true}),
    ...(d.instance_config.railId?{railId:'r',pathMinZ:.5,pathMaxZ:.5}:{laneId:'a'})}))
  const withRotations=rotations=>devices.map(d=>({...d,...(rotations.find(p=>p.id===d.id)?{rotation_y:rotations.find(p=>p.id===d.id).rotation_y}:{})}))
  return {root,models,devices,layout,measure,withRotations}
}

test('mixed 0/90/180 degree devices and a backwards single cart automatically face each other using actual measured port normals',async()=>{
  const f=fixture(),before=JSON.stringify({devices:f.devices,layout:f.layout,models:f.models}),rows=f.measure(f.devices)
  let remeasured=0
  const plan=await prepareGuidedLineArrangement(f.layout,'single-negative',rows,{measure:async rotations=>{remeasured++;return f.measure(f.withRotations(rotations))}})
  assert.equal(remeasured,1);assert.equal(plan.orientations.length,3)
  assert.equal(JSON.stringify({devices:f.devices,layout:f.layout,models:f.models}),before)
  for(const row of plan.rows){
    const original=rows.find(r=>r.id===row.id)
    assert.equal(row.x,original.x);assert.equal(row.y,original.y)
    assert.ok(row.loadingPort.direction[2]*(row.railId?-1:1)>.999)
    if(row.laneId)assert.ok(Math.abs(row.z+row.loadingPort.position[2]-plan.layout.lanes[0].offsetZ)<1e-6)
  }
  const cart=plan.rows.find(r=>r.railId)
  assert.equal(cart.z,.5);assert.equal(cart.transferStroke,rows.find(r=>r.railId).transferStroke)
  assert.deepEqual(plan.layout.rails,f.layout.rails)
  assert.deepEqual(plan.layout.lanes.map(l=>l.length),f.layout.lanes.map(l=>l.length))
  assert.doesNotThrow(()=>assertLineTemplateClearance(plan.layout,plan.rows))
  assert.ok(plan.deviceTransforms.every(p=>Object.keys(p).every(k=>['id','pos_z','rotation_y'].includes(k))))
})

test('confirmed auto-alignment is stable on repeat and never accumulates rotation or changes manual X, Y, ports, movement or PLC fields',async()=>{
  const f=fixture(),rows=f.measure(f.devices),plan=await prepareGuidedLineArrangement(f.layout,'single-negative',rows,{measure:async rotations=>f.measure(f.withRotations(rotations))})
  const next=f.devices.map(d=>({...d,...plan.deviceTransforms.find(p=>p.id===d.id)})),snapshot=clone(next)
  const again=await prepareGuidedLineArrangement(plan.layout,'single-negative',f.measure(next),{measure:()=>{throw Error('No rotation should be necessary')}})
  assert.equal(again.orientations.length,0)
  assert.deepEqual(next,snapshot)
  for(const p of again.deviceTransforms)assert.ok(Math.abs(p.pos_z-next.find(d=>d.id===p.id).pos_z)<1e-6)
  for(const d of next){const old=f.devices.find(p=>p.id===d.id);assert.deepEqual(d.instance_config,old.instance_config);assert.equal(d.pos_x,old.pos_x);assert.equal(d.pos_y,old.pos_y);assert.equal(d.scale,old.scale)}
})

test('mirrored and scaled models, degree-based legacy yaw and non-unit calibration use the same actual normal transform',async()=>{
  const f=fixture();f.layout.sceneUnitsPerMeter=.8
  f.devices.forEach(d=>{d.scale=2;d.instance_config.mirrorX=true})
  f.devices[1].rotation_y=180
  const rows=f.measure(f.devices),before=clone(f.devices)
  const plan=await prepareGuidedLineArrangement(f.layout,'single-negative',rows,{measure:async rotations=>f.measure(f.withRotations(rotations))})
  assert.deepEqual(f.devices,before)
  for(const row of plan.rows)assert.ok(row.loadingPort.direction[2]*(row.railId?-1:1)>.999)
  assert.doesNotThrow(()=>assertLineTemplateClearance(plan.layout,plan.rows))
  assert.equal(plan.layout.placementTemplate.mouthAligned,true)
})

test('missing calibration, unsupported drive axes and occupied opposite sides identify the specific device for 3D; no invented opposite cart mouth',()=>{
  const f=fixture(),rows=f.measure(f.devices),unchanged=clone(rows)
  const missing=clone(rows);missing[0].loadingPort=null
  assert.throws(()=>planLineMouthOrientations(f.layout,'single-negative',missing),e=>e.code==='LINE_AUTO_ALIGNMENT_REQUIRES_3D'&&e.deviceIds.includes('fixed-0')&&/工位 1.*已校准/.test(e.message))
  const unknown=clone(rows);delete unknown.at(-1).transferStroke
  assert.throws(()=>planLineMouthOrientations(f.layout,'single-negative',unknown),e=>e.deviceIds.includes('cart')&&/真实推拉行程/.test(e.message))
  const both=clone(f.layout);both.lanes.push({id:'b',name:'另一侧',offsetZ:5,length:60})
  const opposite={...clone(rows[0]),id:'opposite',laneId:'b'}
  assert.throws(()=>planLineMouthOrientations(both,'dual',[...rows,opposite]),e=>e.deviceIds.includes('cart')&&/两侧.*单向小车/.test(e.message))
  assert.deepEqual(rows,unchanged)
})

test('after automatic turning, unsafe overlaps or insufficient real stroke still fail atomically rather than repacking X or extending a mechanism',async()=>{
  const f=fixture(),duplicate=clone(f.devices[0]);duplicate.id='overlap';duplicate.name='重叠工位';f.devices.push(duplicate)
  const rows=f.measure(f.devices),before=clone(rows)
  await assert.rejects(prepareGuidedLineArrangement(f.layout,'single-negative',rows,{measure:async rotations=>f.measure(f.withRotations(rotations))}),e=>e.code==='LINE_AUTO_ALIGNMENT_REQUIRES_3D'&&/重叠/.test(e.message))
  assert.deepEqual(rows,before)
  const short=fixture(),input=short.measure(short.devices);input.at(-1).transferStroke=.01
  await assert.rejects(prepareGuidedLineArrangement(short.layout,'single-negative',input,{measure:async rotations=>{const r=short.measure(short.withRotations(rotations));r.at(-1).transferStroke=.01;return r}}),/行程.*三维/)
})

test('actual committed CAD geometry is remeasured after turning; authored model calibration remains unchanged',async()=>{
  const require=createRequire(new URL('../../backend/package.json',import.meta.url)),{getBuiltinModels}=require('./services/builtinModels')
  const ids=['cad_transfer_cart_101300','cad_multipurpose_furnace_082000','cad_cleaner_170700'],models=[],roots=new Map()
  for(const id of ids){
    const m=clone(getBuiltinModels().find(m=>m.id===id)),bytes=await readFile(new URL(`../../backend${m.file_path}`,import.meta.url))
    const root=(await new Promise((yes,no)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',yes,no))).scene
    // Simulate a user's explicit calibration of the real front surface. The
    // legacy helper intentionally does not invent a separate outlet.
    const p=inferLoadingPort(root,{model_type:id},m,'inlet')
    assert.ok(p,`Known CAD mouth for ${id}`)
    const metadata=JSON.parse(m.metadata);metadata.loadingPorts={version:1,inlet:p,outlet:p};m.metadata=JSON.stringify(metadata);models.push(m);roots.set(id,root)
  }
  const f=fixture();f.devices=f.devices.slice(0,3).map((d,i)=>({...d,model_type:ids[i],pos_x:i===0?-20:i*12-12,pos_z:i===0?.5:-5,rotation_y:i===0?Math.PI/2:i===2?Math.PI:0,
    instance_config:i===0?{railId:'r'}:{laneId:'a'}}))
  const measure=devices=>devices.map(d=>({id:d.id,name:d.name,x:d.pos_x,y:d.pos_y,z:d.pos_z,...lineDeviceEnvelope(roots.get(d.model_type),d,models.find(m=>m.id===d.model_type),{parts:true}),...(d.instance_config.railId?{railId:'r'}:{laneId:'a'})}))
  const snapshot=JSON.stringify(models),rows=measure(f.devices)
  const plan=await prepareGuidedLineArrangement(f.layout,'single-negative',rows,{measure:async changes=>measure(f.devices.map(d=>({...d,...(changes.find(p=>p.id===d.id)?{rotation_y:changes.find(p=>p.id===d.id).rotation_y}:{})})))})
  assert.ok(plan.orientations.length>0);assert.doesNotThrow(()=>assertLineTemplateClearance(plan.layout,plan.rows));assert.equal(JSON.stringify(models),snapshot)
  assert.deepEqual(plan.rows.map(r=>r.x),rows.map(r=>r.x))
})

const panel=parse(await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')).descriptor
const ast=parseJavaScript(panel.scriptSetup.content,{sourceType:'module'})
const extract=name=>{const n=ast.program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);return panel.scriptSetup.content.slice(n.start,n.end)}
test('real draft application preflights every yaw/depth patch before changing any device or line',()=>{
  const f=fixture(),line={layout:clone(f.layout)},devices={value:f.devices},old=JSON.stringify({line,devices})
  const deps={getLineLayout:l=>l.layout,normalizeLineLayout:clone,syncLineRailLength,assertLineTemplateTransition(){},devices,numberOrDefault:Number,
    getDevicesBoundToLayoutItem:(type,id)=>f.devices.filter(d=>d.instance_config[type==='lane'?'laneId':'railId']===id),
    resolveDeviceLayoutTarget:()=>({type:'lane'}),buildDeviceLayoutBindingPatch:()=>({instance_config:'{"unexpected":"must not rebind"}'})}
  const apply=new Function(...Object.keys(deps),extract('applyLineLayoutDraft')+';return applyLineLayoutDraft')(...Object.values(deps))
  assert.throws(()=>apply(line,f.layout,[{id:'fixed-0',pos_z:1,rotation_y:0},{id:'missing',pos_z:2}]),/未应用任何修改/)
  assert.equal(JSON.stringify({line,devices}),old)
  const candidate=clone(f.layout);candidate.lanes[0].offsetZ=-3
  apply(line,candidate,[{id:'fixed-0',pos_z:-2,rotation_y:Math.PI}])
  assert.equal(devices.value[0].pos_z,-2);assert.equal(devices.value[0].rotation_y,Math.PI)
  assert.equal(devices.value[0].pos_x,f.devices[0].pos_x);assert.deepEqual(devices.value[0].instance_config,f.devices[0].instance_config)
})

test('named 3D handoff waits for measuring to finish and never applies a failed recommendation',async()=>{
  const f=fixture(),line={id:'L',layout:f.layout},loading={value:false};let opened='',applied=0,prompt
  const deps={canAdminPage:()=>true,lineDeviceLayoutBusy:{value:false},lineCreating:{value:false},selectedLineEditor:{value:line},stageArrangementDevice(){},snapshotJson:JSON.stringify,
    getLineLayout:l=>l.layout,devices:{value:f.devices},models:{value:[]},getFactoryScope:()=> 'scope',lineLoadingMeasuring:loading,
    measureLineLayoutEnvelopes:async()=>[],prepareGuidedLineArrangement:async()=>{throw Object.assign(Error('「指定工位」需要调整'),{code:'LINE_AUTO_ALIGNMENT_REQUIRES_3D',deviceIds:['fixed-1']})},
    confirm:async(_message,options)=>{prompt=options;return true},alert(){throw Error('Expected actionable prompt')},applyLineLayoutDraft(){applied++},
    adminPanelDisposed:false,openArrangementDevice:async id=>{assert.equal(loading.value,false);opened=id}}
  const choose=new Function(...Object.keys(deps),extract('chooseLinePlacementTemplate')+';return chooseLinePlacementTemplate')(...Object.values(deps))
  await choose('single-negative');assert.equal(applied,0);assert.equal(opened,'fixed-1');assert.equal(prompt.confirmText,'到三维调整');assert.equal(prompt.title,'这台设备需三维调整')
})
