import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { catalogItemUsable } from '../src/runtime/dataCatalog.js'
import { bindingForDevice, legacyWorkflow, preservePlaybackBinding, workflowIssues, widgetWorkflowIssues, expandedBindingWidgets } from '../../shared/widgetBindingWorkflow.mjs'
import { playbackSelection, devicePoint } from '../../shared/widgetPlayback.mjs'
const require=createRequire(import.meta.url)
const {normalizeDocument,validateDocument}=require('../../backend/utils/dashboardDocument.js')
const devices=[{id:'a',name:'炉 A'},{id:'b',name:'炉 B'}]
const points=[{id:'pa',device_id:'a',category:'analog',value_role:'temp',plc_tag:'DB1.DBD16',access_type:'READ',unit:'℃'},
 {id:'pb',device_id:'b',category:'analog',value_role:'different_temp',plc_tag:'DB9.DBD80',access_type:'READ',unit:'℃'}]
const data=()=>({mode:'plc',bindingVersion:2,pointId:'pa',pointKey:'analog.temp',requireConfiguredPoint:true,deviceScope:'rotation',rotationIntervalMs:2000,refreshMs:1000,
 deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa',pointKey:'analog.temp',unit:'℃'}},{deviceId:'b',binding:{mode:'plc',pointId:'pb',pointKey:'analog.different_temp',unit:'℃'}}]})
const values=Object.fromEntries(points.map((point,index)=>[point.id,{...point,value:index?222:111,quality:'good'}]))

test('explicit list reads different point names/PLC addresses and follows authored order',()=>{
 const binding=data()
 for(const [now,id,value] of [[0,'a',111],[2000,'b',222],[4000,'a',111]]){
  const selected=playbackSelection(binding,{viewId:'device_detail',deviceId:'a'},devices,now)
  assert.equal(selected.device.id,id)
  assert.equal(devicePoint(binding,id,values).value,value)
 }
 binding.deviceBindings.reverse()
 assert.equal(playbackSelection(binding,{},devices,0).device.id,'b')
})
test('current means current only; fixed never changes because another device is viewed',()=>{
 const binding=data()
 assert.equal(playbackSelection({...binding,deviceScope:'current'},{},devices,0).device,null)
 assert.equal(playbackSelection({...binding,deviceScope:'current'},{deviceId:'b'},devices,0).device.id,'b')
 assert.equal(playbackSelection({...binding,deviceScope:'fixed',deviceId:'b'},{viewMode:'device',deviceId:'a'},devices,0).device.id,'b')
})
test('missing explicit point cannot fall back to a same-role point or another device',()=>{
 const binding=data();binding.deviceBindings[1].binding.pointId='deleted'
 assert.equal(devicePoint(binding,'b',{...values,other:{...values.pb,id:'other'}}),null)
 assert.equal(bindingForDevice(binding,'unknown').bindingMissing,true)
 binding.deviceBindings=[]
 assert.equal(playbackSelection(binding,{},devices,0).device,null)
})
test('partially selected explicit row sources are missing rather than reusing the top-level sample',()=>{
 const binding=data()
 for(const source of [{mode:'plc',pointId:''},{mode:'dataset',datasetId:'set',datasetField:''},{mode:'runtime',path:''}]){
  binding.deviceBindings[1].binding=source
  const resolved=bindingForDevice(binding,'b')
  assert.equal(resolved.bindingMissing,true);assert.equal(resolved.pointId,'');assert.equal(resolved.path,'')
 }
})
test('reselecting catalog data preserves device order, interval, scope, and formatting',()=>{
 const old={...data(),decimals:3,rotationDeviceIds:['b','a']}
 const next=preservePlaybackBinding(old,{mode:'plc',pointId:'pb',deviceId:'b',deviceScope:'fixed',connectionId:undefined})
 assert.equal(next.deviceScope,'rotation');assert.equal(next.rotationIntervalMs,2000);assert.equal(next.decimals,3)
 assert.deepEqual(next.deviceBindings,old.deviceBindings);assert.deepEqual(next.rotationDeviceIds,['b','a'])
})
test('frontend and backend round trips keep each explicit assignment and period',()=>{
 const doc={schemaVersion:3,widgets:[{id:'test',type:'hud_chart_dock',frame:{x:10,y:10,width:400,height:200},data:data()}]}
 const front=normalizeDashboardDocument(doc),back=normalizeDocument(front),again=normalizeDashboardDocument(back)
 assert.equal(again.widgets.find(w=>w.id==='test').data.bindingVersion,2)
 assert.deepEqual(again.widgets.find(w=>w.id==='test').data.deviceBindings,front.widgets.find(w=>w.id==='test').data.deviceBindings)
 assert.equal(again.widgets.find(w=>w.id==='test').data.rotationIntervalMs,2000)
})
test('incomplete rows, repeated devices and incompatible units block publish instead of inventing sources',()=>{
 const binding=data();binding.deviceBindings[1].binding=null
 assert.match(workflowIssues(binding).join(' '),/未选择对应数据/)
 binding.deviceBindings[1]={deviceId:'a',binding:{mode:'plc',pointId:'pa',unit:'kWh'}}
 assert.match(workflowIssues(binding).join(' '),/重复设备/);assert.match(workflowIssues(binding).join(' '),/单位不一致/)
 const doc=normalizeDocument({schemaVersion:3,widgets:[{id:'x',type:'trend',frame:{width:400,height:200},data:binding}]})
 assert.throws(()=>validateDocument(doc),/重复|单位/)
 assert.doesNotThrow(()=>validateDocument(doc,{allowIncompleteBindings:true}))
})
test('existing rotation is resolved into owned configured points without mutating its original configuration',()=>{
 const old={mode:'plc',deviceScope:'rotation',pointId:'pa',pointKey:'analog.temp',rotationDeviceIds:['a','b'],rotationIntervalMs:12000}
 const before=JSON.stringify(old),converted=legacyWorkflow(old,devices,points)
 assert.equal(converted.deviceBindings[0].binding.pointId,'pa')
 assert.equal(converted.deviceBindings[1].binding,null,'different field must be selected explicitly, never guessed')
 assert.equal(JSON.stringify(old),before)
})
test('numeric PLC items are selectable for HUD ring and metrics; textual PLC items are not',()=>{
 const item={sourceType:'plc',type:'number',binding:{mode:'plc',pointId:'pa'}}
 assert.equal(catalogItemUsable(item,{widgetType:'hud_kpi_panel'}),true)
 assert.equal(catalogItemUsable({...item,type:'string'},{widgetType:'hud_kpi_panel'}),false)
})
test('legacy alarm widgets normalize to an explicit events source without changing their frame/content',()=>{
 const widget={id:'alarms',type:'hud_alarm_panel',frame:{x:10,y:20,width:400,height:200},content:{limit:4},data:{mode:'static'}}
 for(const doc of [normalizeDashboardDocument({widgets:[widget]}),normalizeDocument({widgets:[widget]})]){
  const alarm=doc.widgets.find(w=>w.id==='alarms')
  assert.equal(alarm.data.mode,'runtime');assert.equal(alarm.data.path,'events');assert.equal(alarm.data.deviceScope,'global');assert.equal(alarm.frame.x,10);assert.equal(alarm.content.limit,4)
 }
 assert.equal(catalogItemUsable({type:'array',binding:{mode:'runtime',path:'events',deviceScope:'global'}},{widgetType:'hud_alarm_panel'}),true)
})

test('secondary metrics require an explicit source for every displayed device, but global metrics do not',()=>{
 const primary=data(),metric={mode:'plc',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:'a',binding:{mode:'plc',pointId:'pa',unit:'h'}}]}
 const widget={id:'panel',data:primary,content:{items:[{label:'运行时长',binding:metric},{label:'全厂产出',binding:{mode:'dataset',deviceScope:'global',datasetId:'global',datasetField:'total'}}]}}
 assert.match(widgetWorkflowIssues(widget).join(' '),/运行时长.*设备 b.*未选择对应数据/)
 widget.data.deviceScope='fixed';widget.data.deviceId='a';assert.deepEqual(widgetWorkflowIssues(widget),[])
 metric.deviceBindings.push({deviceId:'b',binding:null});assert.deepEqual(widgetWorkflowIssues(widget),[],'inactive preserved rows do not block a fixed-device metric')
 widget.data.deviceId='b';assert.match(widgetWorkflowIssues(widget).join(' '),/运行时长.*设备 b.*未选择对应数据/)
 widget.data.deviceScope='rotation';metric.deviceBindings[1].binding={mode:'plc',pointId:'pb',unit:'s'}
 assert.match(widgetWorkflowIssues(widget).join(' '),/运行时长.*单位不一致/)
 metric.deviceBindings[1].binding.unit='h';assert.deepEqual(widgetWorkflowIssues(widget),[])
})

test('reference expansion validates only displayed secondary rows while preserving inactive assignments',()=>{
 const primary={...data(),deviceScope:'fixed',deviceId:'a'},metric={mode:'dataset',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:'a',binding:{mode:'dataset',datasetId:'active',datasetField:'hours'}},{deviceId:'b',binding:{mode:'dataset',datasetId:'inactive',datasetField:'old'}}]}
 const widget={id:'panel',data:primary,content:{items:[{binding:metric}]}}
 assert.deepEqual(expandedBindingWidgets([widget]).map(row=>row.data.datasetId).filter(Boolean),['active'])
 assert.equal(metric.deviceBindings[1].binding.datasetId,'inactive')
 primary.deviceId='b';assert.deepEqual(expandedBindingWidgets([widget]).map(row=>row.data.datasetId).filter(Boolean),['inactive'])
 primary.deviceScope='rotation';assert.deepEqual(expandedBindingWidgets([widget]).map(row=>row.data.datasetId).filter(Boolean),['active','inactive'])
})
