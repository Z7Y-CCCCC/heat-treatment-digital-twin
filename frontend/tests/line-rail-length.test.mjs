import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {parse} from '@vue/compiler-sfc'
import {parse as parseJavaScript} from '@babel/parser'
import {isLineRailLengthAutomatic,syncLineRailLength} from '../../shared/lineRailLength.mjs'
import {normalizeLineLayout} from '../src/views/admin/utils/lineLayout.js'
import {shiftRailMovement} from '../../shared/lineRailSpacing.mjs'

const clone=structuredClone
const layout=()=>normalizeLineLayout({sceneUnitsPerMeter:.8,lanes:[{id:'a',name:'设备线 1',offsetZ:-4,length:81},{id:'b',name:'设备线 2',offsetZ:4,length:120}],rails:[{id:'r',name:'小车导轨 1',offsetZ:0,length:72.5}]})
test('single rail follows an occupied row exactly; a longer empty opposite row cannot extend it',()=>{
  const source=layout(),before=clone(source),next=syncLineRailLength(source,['a'])
  assert.equal(next.rails[0].length,81);assert.deepEqual(source,before)
  assert.deepEqual({...next,rails:source.rails},source)
  assert.deepEqual({...next.rails[0],length:source.rails[0].length},source.rails[0])
  const shorter=clone(source);shorter.lanes[0].length=42.5
  assert.equal(syncLineRailLength(shorter,['a']).rails[0].length,42.5)
})
test('two occupied sides share the longer row; removing occupancy and initially empty rows have deterministic rules',()=>{
  const source=layout()
  assert.equal(syncLineRailLength(source,['a','b']).rails[0].length,120)
  assert.equal(syncLineRailLength(source,['a','a']).rails[0].length,81)
  assert.equal(syncLineRailLength(source,[]).rails[0].length,120)
  source.lanes.pop();assert.equal(syncLineRailLength(source,[]).rails[0].length,81)
})
test('legacy multiple rails are not guessed and invalid row lengths fail without touching their source',()=>{
  const source=layout();source.rails.push({...source.rails[0],id:'other'})
  assert.equal(isLineRailLengthAutomatic(source),false);assert.equal(syncLineRailLength(source,['a']),source)
  const bad=layout();bad.lanes[0].length=NaN
  assert.throws(()=>syncLineRailLength(bad,['a']),/长度无效/);assert.ok(Number.isNaN(bad.lanes[0].length))
})

const panel=parse(await readFile(new URL('../src/views/AdminPanel.vue',import.meta.url),'utf8')).descriptor
const ast=parseJavaScript(panel.scriptSetup.content,{sourceType:'module'})
const extract=name=>{const n=ast.program.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name);return panel.scriptSetup.content.slice(n.start,n.end)}
function fixture(){
  const line={id:'L',workshop_id:'W',layout:layout()},originalDevices=[
    {id:'fixed',name:'固定工位',line_id:'L',coordinate_space:'line_local',pos_x:15,pos_z:-3.875,instance_config:'{"laneId":"a","laneLineId":"L","stationNumber":9,"preserve":{"port":"keep"}}'},
    {id:'cart',name:'现场小车',line_id:'L',coordinate_space:'line_local',pos_x:20,pos_z:0,instance_config:'{"railId":"r","railLineId":"L","role":"auxiliary","movement":{"enabled":true,"start":{"x":-50,"y":0,"z":0},"end":{"x":50,"y":0,"z":0}}}'}
  ],devices={value:originalDevices}
  const deps={getLineLayout:l=>l.layout,normalizeLineLayout,syncLineRailLength,devices,assertLineTemplateTransition(){},
    numberOrDefault:(n,d=0)=>Number.isFinite(Number(n))?Number(n):d,parseInstanceConfig:v=>typeof v==='string'?JSON.parse(v):v,
    getLineBaseZ:()=>0,shiftRailMovement,
    getDevicesBoundToLayoutItem:(type,id)=>devices.value.filter(d=>JSON.parse(d.instance_config)[type==='lane'?'laneId':'railId']===id)}
  const api=new Function(...Object.keys(deps),extract('buildDeviceLayoutBindingPatch')+';'+extract('applyLineLayoutDraft')+';return {apply:applyLineLayoutDraft}')(...Object.values(deps))
  return {line,devices,originalDevices,apply:api.apply,deps}
}
test('real length-edit draft updates the rail immediately and leaves every device, movement endpoint and PLC binding byte-identical',()=>{
  const f=fixture(),before=clone(f.devices.value),candidate=clone(f.line.layout);candidate.lanes[0].length=91.5
  f.apply(f.line,candidate)
  assert.equal(f.line.layout.lanes[0].length,91.5);assert.equal(f.line.layout.rails[0].length,91.5)
  assert.equal(f.line.layout.lanes[1].length,120)
  assert.equal(f.devices.value,f.originalDevices);assert.deepEqual(f.devices.value,before)
  assert.deepEqual(JSON.parse(f.line.layout_json),f.line.layout)
})
test('a shrink excluding an existing fixed station or the cart rejects the entire draft rather than clamping or moving them',()=>{
  for(const [length,name] of [[20,'固定工位'],[35,'现场小车']]){
    const f=fixture(),before=JSON.stringify({line:f.line,devices:f.devices}),candidate=clone(f.line.layout);candidate.lanes[0].length=length
    assert.throws(()=>f.apply(f.line,candidate),new RegExp(`${name}.*超出`))
    assert.equal(JSON.stringify({line:f.line,devices:f.devices}),before)
  }
})
test('each actual resize-pointer event synchronizes both lengths before pointer release',()=>{
  const f=fixture(),state={type:'lane',itemId:'a',mode:'resize-right',startX:0,startLength:81}
  const deps={linePreviewDragState:state,selectedLineEditor:{value:f.line},findLineLayoutItem:()=>f.line.layout.lanes[0],getLineLayout:l=>l.layout,
    previewDeltaXToUnits:x=>x/10,roundLineLayoutValue:(n,step)=>Math.round(n/step)*step,applyLineLayoutDraft:f.apply,
    finishLinePreviewDrag(){throw Error('Valid resize must not stop')},alert(){throw Error('No warning expected')}}
  const move=new Function(...Object.keys(deps),extract('handleLinePreviewDrag')+';return handleLinePreviewDrag')(...Object.values(deps))
  for(const x of [10,20,30]){move({clientX:x});assert.equal(f.line.layout.rails[0].length,f.line.layout.lanes[0].length)}
})
test('partial typing never interrupts the user; valid input synchronizes immediately and an invalid committed shrink reports once',()=>{
  const f=fixture(),warnings=[],deps={canAdminPage:()=>true,lineDeviceLayoutBusy:{value:false},findLineLayoutItem:()=>f.line.layout.lanes[0],
    getLineLayout:l=>l.layout,selectedLineEditor:{value:f.line},isLineRailLengthAutomatic,applyLineLayoutDraft:f.apply,alert:message=>warnings.push(message)}
  const change=new Function(...Object.keys(deps),extract('changeLineLayoutItem')+';return changeLineLayoutItem')(...Object.values(deps))
  change({type:'lane',id:'a',field:'length',value:'8',preview:true})
  assert.equal(warnings.length,0);assert.equal(f.line.layout.lanes[0].length,81)
  change({type:'lane',id:'a',field:'length',value:'85',preview:true})
  assert.equal(f.line.layout.rails[0].length,85)
  change({type:'lane',id:'a',field:'length',value:'8'})
  assert.equal(warnings.length,1);assert.match(warnings[0],/固定工位.*超出/);assert.equal(f.line.layout.rails[0].length,85)
})
test('canvas length field accepts metres, honors non-unit calibration, and restores the accepted length on commit',()=>{
  const requests=[],input={value:'100'},deps={lineSceneUnitsPerMeter:()=>.8,selectedLineLayout:{value:{}},changeLineLayoutItem:p=>requests.push(p),findLineLayoutItem:()=>({length:80})}
  const change=new Function(...Object.keys(deps),extract('changeLineLengthFromCanvas')+';return changeLineLengthFromCanvas')(...Object.values(deps))
  change({id:'a'},{target:input},true);assert.equal(requests[0].value,80);assert.equal(requests[0].preview,true)
  input.value='4';change({id:'a'},{target:input});assert.equal(input.value,100);assert.equal(requests[1].value,3.2)
})
test('independent rail length edits and resize handles are disabled in the one-rail editor, but equipment rows remain resizable',async()=>{
  const f=fixture(),before=JSON.stringify(f.line),deps={canAdminPage:()=>true,lineDeviceLayoutBusy:{value:false},findLineLayoutItem:()=>f.line.layout.rails[0],
    getLineLayout:l=>l.layout,selectedLineEditor:{value:f.line},isLineRailLengthAutomatic}
  const change=new Function(...Object.keys(deps),extract('changeLineLayoutItem')+';return changeLineLayoutItem')(...Object.values(deps))
  change({type:'rail',id:'r',field:'length',value:200});assert.equal(JSON.stringify(f.line),before)
  assert.match(panel.template.content,/v-if="!isLineRailLengthAutomatic\(selectedLineLayout\)"[^>]*@pointerdown.stop="startLinePreviewDrag\('rail'/)
  const toolbar=await readFile(new URL('../src/views/admin/components/LinePlannerControls.vue',import.meta.url),'utf8')
  assert.match(toolbar,/自动跟随设备线/);assert.match(toolbar,/:disabled="!canEdit \|\| busy \|\| popup === 'rail' && isLineRailLengthAutomatic\(layout\)"/)
})
test('pointer release is cleanup only and cannot retry a rejected resize or create a dirty draft on a click',()=>{
  let cleanup=0
  const deps={linePreviewDragState:{},document:{body:{classList:{remove(){cleanup++}}}},window:{removeEventListener(){cleanup++}},handleLinePreviewDrag(){},
    touchLineLayout(){throw Error('No draft reapplication on release')},selectedLineEditor:{value:{}}}
  const finish=new Function(...Object.keys(deps),extract('finishLinePreviewDrag')+';return finishLinePreviewDrag')(...Object.values(deps))
  finish();assert.equal(cleanup,2)
})
