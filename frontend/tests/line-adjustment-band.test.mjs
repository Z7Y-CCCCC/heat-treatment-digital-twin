import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { effectScope, ref, nextTick, createRenderer, h } from 'vue'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import { lineAdjustmentBand, clampLineAdjustment, lineAdjustmentBandStyle } from '../../shared/lineAdjustmentBand.mjs'
import { planLinePlacementTemplate } from '../../shared/linePlacementTemplate.mjs'
import { useLineAdjustmentBand } from '../src/views/admin/composables/useLineAdjustmentBand.js'
import { deferred } from './helpers.mjs'
const copy = value => JSON.parse(JSON.stringify(value))
const old = () => ({ sceneUnitsPerMeter: .8, lanes: [{ id:'a',name:'设备线 1',offsetZ:-1,length:60 },{ id:'b',name:'设备线 2',offsetZ:1,length:60 }],rails:[{id:'r',offsetZ:0,length:60}] })
const rows = () => [
  {id:'cart',railId:'r',x:0,y:0,z:0,minX:-1,maxX:1,minY:0,maxY:2,minZ:-1.5,maxZ:1.5},
  {id:'furnace',laneId:'a',x:-7,y:0,z:-1,minX:-3,maxX:3,minY:0,maxY:4,minZ:-5,maxZ:2},
  {id:'cleaner',laneId:'b',x:-7,y:0,z:1,minX:-3,maxX:3,minY:0,maxY:4,minZ:-2,maxZ:5}
]
const plan = () => planLinePlacementTemplate(old(),'dual',rows())
const wait = ms => new Promise(resolve => setTimeout(resolve,ms))

test('red band has two finite edges measured from actual envelopes; no data write or automatic relocation on read',()=>{
  const p=plan(),before=JSON.stringify(p),band=lineAdjustmentBand(p.layout,p.rows)
  assert.equal(band.minZ,-4.4);assert.equal(band.maxZ,-4);assert.equal(band.currentInside,true)
  assert.equal(band.minDistanceMeters,5);assert.equal(band.maxDistanceMeters,5.5)
  assert.equal(JSON.stringify(p),before)
  const far=copy(p.layout);far.lanes[0].offsetZ=-10
  const moved=p.rows.map(row=>row.laneId==='a'?{...row,z:row.z-6}:row)
  const outside=lineAdjustmentBand(far,moved)
  assert.equal(outside.currentInside,false);assert.equal(far.lanes[0].offsetZ,-10)
  assert.equal(outside.minZ,band.minZ,'The edge is not re-anchored at each arbitrary current position')
  assert.equal(lineAdjustmentBand(old(),rows()),null,'Legacy unconfirmed layouts do not receive an invented safe band')
})

test('compact parts avoid the high hood false collision and lock a single reachable distance instead of reporting precision error',()=>{
  const layout={sceneUnitsPerMeter:1,lanes:[{id:'a',offsetZ:5,length:12}],rails:[{id:'r',offsetZ:0,length:12}]}
  const body={minX:-1,maxX:1,minY:0,maxY:2,minZ:-.8,maxZ:.8}
  const rows=[{id:'cart',railId:'r',x:0,y:0,z:0,...body,collisionBoxes:[body],transferReach:{stroke:1,positiveFaceZ:.8,negativeFaceZ:-.8}},
    {id:'furnace',laneId:'a',x:4,y:0,z:5,...body,maxY:4,minZ:-3,maxZ:3,loadingFaceZ:-.2,collisionBoxes:[body,{...body,minY:3,maxY:4,minZ:-3,maxZ:3}]}]
  const p=planLinePlacementTemplate(layout,'single-positive',rows);assert.equal(p.layout.placementTemplate.compact,true)
  assert.equal(p.layout.lanes[0].offsetZ,2,'High hood does not push the low cart to 4+ metres')
  const band=lineAdjustmentBand(p.layout,p.rows);assert.equal(band.minZ,2);assert.equal(band.maxZ,2);assert.equal(band.currentInside,true)
  assert.equal(clampLineAdjustment(100,band),2)
})

test('both single sides, non-unit calibration, opposite row and full cart path affect the band consistently',()=>{
  for(const kind of ['single-negative','single-positive']) {
    const p=planLinePlacementTemplate(old(),kind,rows().filter(row=>row.id!=='cleaner'))
    const b=lineAdjustmentBand(p.layout,p.rows)
    assert.equal(b.currentInside,true);assert.ok(b.minZ<b.maxZ)
    assert.equal(Math.sign(b.minZ),kind==='single-negative'?-1:1)
    assert.ok(Math.abs(b.maxZ-b.minZ-.4)<1e-6)
  }
  const p=plan(),base=lineAdjustmentBand(p.layout,p.rows)
  const wider=p.rows.map(row=>row.id==='cleaner'?{...row,minZ:-6}:row)
  const changed=lineAdjustmentBand(p.layout,wider)
  assert.ok(changed.maxDistanceMeters>base.maxDistanceMeters,'The opposite-row furnace may need more room too')
  assert.equal(changed.currentInside,false,'Changing a model invalidates old clearance without moving it')
  const path=p.rows.map(row=>row.railId?{...row,pathMinZ:-4,pathMaxZ:4}:row)
  assert.ok(lineAdjustmentBand(p.layout,path).minDistanceMeters>base.minDistanceMeters)
})

test('dragging clamps to the same visible range, including fractional edges after grid rounding',()=>{
  const b=lineAdjustmentBand(plan().layout,plan().rows)
  assert.equal(clampLineAdjustment(-100,b),b.minZ);assert.equal(clampLineAdjustment(100,b),b.maxZ)
  for(const z of [-10,-4.4,-4.327,-4.01,0,9])assert.ok(clampLineAdjustment(z,b)>=b.minZ&&clampLineAdjustment(z,b)<=b.maxZ)
  assert.equal(clampLineAdjustment(1,{minZ:1.013,maxZ:1.077}),1.013)
  assert.equal(clampLineAdjustment(2,{minZ:1.013,maxZ:1.077}),1.077)
  assert.throws(()=>clampLineAdjustment(NaN,b));assert.throws(()=>clampLineAdjustment(0,null))
  assert.throws(()=>lineAdjustmentBand(plan().layout,[{...rows()[0],maxZ:NaN}]),/外形未知/)
})

test('overlay coordinate projection uses the real band and includes full lane-card footprint; no click or drag surface is added',async()=>{
  const b=lineAdjustmentBand(plan().layout,plan().rows),bounds={minX:-36,maxX:36,minZ:-12,maxZ:12}
  const style=lineAdjustmentBandStyle(b,bounds,60)
  assert.equal(style.left,`calc(${(-30 - bounds.minX)/(bounds.maxX-bounds.minX)*100}% - 6px)`)
  assert.ok(Math.abs(Number(style.width.match(/[\d.]+/)[0])-60/72*100)<1e-8);assert.match(style.width,/\+ 38px/);assert.match(style.top,/- 48px/);assert.match(style.height,/\+ 96px/)
  const edge=lineAdjustmentBandStyle({...b,minZ:-100,maxZ:100},bounds,1000)
  assert.equal(edge.left,'calc(4% - 6px)');assert.equal(edge.width,'calc(92% + 38px)')
  assert.equal(edge.top,'calc(4% - 48px)');assert.equal(edge.height,'calc(92% + 96px)')
  const url=new URL('../src/views/admin/components/LineAdjustmentOverlay.vue',import.meta.url),descriptor=parse(await readFile(url,'utf8')).descriptor
  let code=compileScript(descriptor,{id:'red-band-memory',inlineTemplate:true}).content
  code=code.replace(/from\s+(['"])([^'"]+)\1/g,(_,q,name)=>`from ${JSON.stringify(name.startsWith('.')?new URL(name,url).href:import.meta.resolve(name))}`)
  for(const css of descriptor.styles)assert.deepEqual(compileStyle({source:css.content,id:'red-band-memory',scoped:true}).errors,[])
  assert.match(descriptor.styles[0].content,/border:2px dashed #d34e53/);assert.match(descriptor.styles[0].content,/pointer-events:none/)
  const Component=(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))).default
  const node=(type,text='')=>({type,text,props:{},children:[],parent:null}),root=node('root')
  const renderer=createRenderer({createElement:node,createText:t=>node('#text',t),createComment:t=>node('#comment',t),setText:(n,t)=>n.text=t,setElementText:(n,t)=>n.text=t,
    parentNode:n=>n.parent,nextSibling:()=>null,remove(){},insert(n,p){p.children.push(n);n.parent=p},patchProp:(n,k,o,v)=>n.props[k]=v})
  renderer.render(h(Component,{band:b,bounds,length:60}),root);await nextTick()
  const overlay=root.children[0];assert.equal(overlay.props['data-adjustment-lane-id'],'a');assert.equal(overlay.props.role,'note')
  assert.match(overlay.props['aria-label'],/红色虚线微调范围/);assert.deepEqual(overlay.props.style,style)
  assert.ok(!Object.keys(overlay.props).some(key=>key.startsWith('onPointer')))
  renderer.render(null,root)
})

test('model changes clear a stale band immediately on Vue flush; late measurements and deactivated pages cannot resurrect it',async()=>{
  const a=deferred(),b=deferred(),source=ref(null),scope=effectScope();let api,calls=0
  scope.run(()=>{api=useLineAdjustmentBand(()=>source.value,{delay:0})})
  const p=plan(),before=JSON.stringify(p)
  source.value={key:'model-a',layout:p.layout,measure:()=>{calls++;return a.promise}};await nextTick();await wait(5)
  assert.equal(api.pending.value,true);assert.equal(api.band.value,null)
  source.value={key:'model-b',layout:p.layout,measure:()=>{calls++;return b.promise}};await nextTick();await wait(5)
  a.resolve(p.rows);await wait(5);assert.equal(api.band.value,null)
  b.resolve(p.rows);await wait(5);assert.equal(api.band.value.laneId,'a');assert.equal(api.pending.value,false);assert.equal(calls,2)
  source.value=null;await nextTick();assert.equal(api.band.value,null);assert.equal(api.pending.value,false)
  const late=deferred();source.value={key:'late',layout:p.layout,measure:()=>late.promise};await nextTick();await wait(5)
  scope.stop();late.resolve(p.rows);await wait(5);assert.equal(api.band.value,null)
  assert.equal(JSON.stringify(p),before,'Checking never updates saved positions or layout')
})

test('same-key coordinate translation is not remeasured on every pointer update; failed geometry stays explicitly unavailable',async()=>{
  const source=ref(null),scope=effectScope();let api,calls=0
  scope.run(()=>api=useLineAdjustmentBand(()=>source.value,{delay:0}))
  const p=plan(),request={key:'stable-geometry',layout:p.layout,measure:async()=>{calls++;return p.rows}}
  source.value=request;await nextTick();await wait(5);assert.ok(api.band.value)
  for(let i=0;i<20;i++)source.value={...request,layout:{...p.layout,transient: i}}
  await nextTick();await wait(5);assert.equal(calls,1)
  source.value={key:'unknown-model',layout:p.layout,measure:async()=>{throw Error('GLB not available')}};await nextTick();await wait(5)
  assert.equal(api.band.value,null);assert.match(api.error.value,/GLB/);assert.equal(api.pending.value,false)
  scope.stop()
})

const panel=parse(await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')).descriptor
const ast=parseJavaScript(panel.scriptSetup.content,{sourceType:'module'})
const extract=name=>{const n=ast.program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);assert.ok(n,name);return panel.scriptSetup.content.slice(n.start,n.end)}
test('real parent drag clamps without jumping to pointer centre and stops when its model range is invalidated',()=>{
  const p=plan(),band=lineAdjustmentBand(p.layout,p.rows),state={type:'lane',itemId:'a',mode:'move',startY:100,startOffsetZ:-4,rect:{height:600},bounds:{minZ:-12,maxZ:12},adjustmentBand:band}
  const dependencies={linePreviewDragState:state,selectedLineEditor:{value:{layout:p.layout}},findLineLayoutItem:()=>p.layout.lanes[0],getLineLayout:l=>l.layout,
    lineAdjustmentDisplayBand:{value:band},lineAdjustmentPending:{value:false},clampLineAdjustment,lineSelectionFeedback:{value:''},
    applyLineLayoutDraft:(_line,candidate)=>updates.push(candidate),finishLinePreviewDrag:()=>stops++,alert:()=>{throw Error('No modal should interrupt clamping')}}
  const updates=[];let stops=0
  const handler=new Function(...Object.keys(dependencies),extract('handleLinePreviewDrag')+';return handleLinePreviewDrag')(...Object.values(dependencies))
  handler({clientY:100});assert.equal(updates.at(-1).lanes[0].offsetZ,-4,'Initial pointer within the card does not jump the line')
  handler({clientY:-999});assert.equal(updates.at(-1).lanes[0].offsetZ,band.minZ);assert.match(dependencies.lineSelectionFeedback.value,/边界/)
  handler({clientY:999});assert.equal(updates.at(-1).lanes[0].offsetZ,band.maxZ)
  dependencies.lineAdjustmentPending.value=true;handler({clientY:120});assert.equal(stops,1);assert.equal(updates.length,3)
  assert.match(panel.template.content,/<LineAdjustmentOverlay/);assert.match(panel.template.content,/@click="recheckLineAdjustmentBand"/)
  assert.match(extract('saveSelectedLineLayout'),/lineAdjustmentBand\(layout, rows\)\?\.currentInside/)
})

test('confirmed template reapplies the measured distance rather than retaining a far-away old placement',()=>{
  const far=old();far.lanes[0].offsetZ=-100;const measured=rows().map(row=>row.laneId==='a'?{...row,z:-100}:row)
  const p=planLinePlacementTemplate(far,'dual',measured)
  assert.equal(p.layout.lanes[0].offsetZ,-4);assert.equal(far.lanes[0].offsetZ,-100)
})

test('real parent geometry key ignores rigid lane translation but observes model revisions, scale, mirrors and rail path changes',()=>{
  const p=plan(),line={id:'L',layout:p.layout},devices={value:p.rows.map(row=>({id:row.id,line_id:'L',model_type:'model',pos_y:row.y,pos_z:row.z,scale:1,rotation_y:0,instance_config:{...(row.laneId?{laneId:row.laneId,laneLineId:'L'}:{railId:row.railId,railLineId:'L'}),mirrorX:false}}))},models={value:[{id:'model',file_path:'/model.glb',default_scale:1,updated_at:'v1'}]}
  const deps={selectedLineEditor:{value:line},getLineLayout:l=>l.layout,activeTab:{value:'lines'},devices,models,parseInstanceConfig:c=>c,getFactoryScope:()=> 'F',snapshotJson:JSON.stringify,measureLineLayoutEnvelopes:async()=>p.rows}
  const request=new Function(...Object.keys(deps),extract('lineAdjustmentRequest')+';return lineAdjustmentRequest')(...Object.values(deps))
  const original=request().key
  line.layout.lanes[0].offsetZ-=.1;devices.value.find(row=>row.id==='furnace').pos_z-=.1
  assert.equal(request().key,original,'A normal drag does not trigger GLB reloads or clear the band')
  for(const change of [()=>models.value[0].updated_at='v2',()=>devices.value[1].scale=2,()=>devices.value[1].instance_config.mirrorX=true,()=>devices.value[0].instance_config.movement={enabled:true,start:{z:0},end:{z:3}}]){
    const old=request().key;change();assert.notEqual(request().key,old)
  }
  deps.activeTab.value='devices';assert.equal(request(),null,'No measuring in unrelated admin pages')
})

test('real normal save rejects a newly unsafe model band before touching layout or calling the batch API',async()=>{
  const p=plan(),line={layout:p.layout},busy={value:false},errors=[],deps={lineDeviceLayoutBusy:{value:false},selectedLineEditor:{value:line},lineLayoutSaving:busy,
    normalizeLineLayout:value=>value,getLineLayout:l=>l.layout,measureLineLayoutEnvelopes:async()=>p.rows,assertLineTemplateClearance(){},
    lineAdjustmentBand:()=>({currentInside:false}),alert:(message)=>errors.push(message),syncLineBoundDevicesToLayout:()=>{throw Error('Must reject before collecting writes')},adminApi:{updateLine:()=>{throw Error('No API writes allowed')}}}
  const handler=new Function(...Object.keys(deps),extract('saveSelectedLineLayout')+';return saveSelectedLineLayout')(...Object.values(deps))
  const before=JSON.stringify(line);await handler();assert.equal(JSON.stringify(line),before);assert.match(errors[0],/红色虚线/);assert.equal(busy.value,false)
})
