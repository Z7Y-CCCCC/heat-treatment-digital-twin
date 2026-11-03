import test from 'node:test'
import assert from 'node:assert/strict'
import {playbackSelection,devicePoint,normalizePlayback} from '../../shared/widgetPlayback.mjs'
import {upgradeWidgetPlaybackDocument} from '../../shared/widgetPlaybackProfile.mjs'
import {DASHBOARD_CHARTS} from '../../shared/dashboardCharts.mjs'
import {extendedChartOption} from '../src/runtime/dashboardCharts.js'
import {createWidgetReadScheduler} from '../src/runtime/widgetReadScheduler.js'
import {deferred,settle} from './helpers.mjs'
const devices=[{id:'a',name:'A',lineId:'l',workshopId:'w'},{id:'b',name:'B',lineId:'l',workshopId:'w'},{id:'foreign',name:'C',lineId:'other',workshopId:'other'}]
const binding={deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000,refreshMs:1000}
test('existing device context overrides overview rotation/fixed bindings in device, xray, exploded and part views',()=>{
 assert.equal(playbackSelection(binding,{viewMode:'factory'},devices,0).device.id,'a');assert.equal(playbackSelection(binding,{viewMode:'factory'},devices,2000).device.id,'b')
 for(const viewId of ['device_detail','device_xray','device_exploded','device_part'])for(const deviceScope of ['fixed','rotation','current'])assert.equal(playbackSelection({...binding,deviceScope,deviceId:'b'},{viewId,deviceId:'a'},devices,4000).device.id,'a')
 assert.equal(playbackSelection(binding,{viewMode:'device',deviceId:'unknown'},devices,0).device,null)
 assert.equal(playbackSelection({...binding,rotationDeviceIds:['foreign']},{lineId:'l'},devices,0).device,null)
 assert.equal(normalizePlayback({refreshMs:-2,rotationIntervalMs:1}).refreshMs,1000)
})
test('same-role point reuse never falls back to another device, including ambiguous or missing roles',()=>{
 const values={template:{id:'template',device_id:'a',category:'analog',value_role:'temp',value:99},one:{id:'one',device_id:'b',category:'analog',value_role:'temp',value:0}}
 assert.equal(devicePoint({pointId:'template'},'b',values).value,0);assert.equal(devicePoint({pointId:'template'},'unknown',values),null)
 assert.equal(devicePoint({pointId:'template'},'b',{...values,two:{...values.one,id:'two'}}),null)
})
function scheduler(read){let context={viewMode:'factory'},parameters={},now=0;const values={},removed=[];const widget={id:'w',data:{mode:'dataset',...binding}}
 const reader=createWidgetReadScheduler({context:()=>context,parameters:()=>parameters,devices:()=>devices,widgets:()=>[widget],read,put:(id,v)=>{values[id]=v},remove:id=>{delete values[id];removed.push(id)}})
 return {reader,values,removed,context(value){context=value},params(value){parameters=value}}
}
test('rotation and refresh are independent; unchanged ticks do not issue reads, and detail views remain fixed',async()=>{
 const calls=[],f=scheduler(async(ids,c,p,now)=>{calls.push(now);return {values:{w:{value:now,deviceId:playbackSelection(binding,c,devices,now).device.id}}}})
 await f.reader.refresh(false,0);await f.reader.refresh(false,500);assert.deepEqual(calls,[0]);await f.reader.refresh(false,1000);await f.reader.refresh(false,2000);assert.deepEqual(calls,[0,1000,2000]);assert.equal(f.values.w.deviceId,'b')
 f.context({viewMode:'device',deviceId:'a'});await f.reader.refresh(false,2500);assert.equal(f.values.w.deviceId,'a');await f.reader.refresh(false,4000);assert.equal(f.values.w.deviceId,'a');f.reader.dispose()
})
test('late device A responses cannot overwrite B, and unmount cancels pending values',async()=>{
 const a=deferred(),b=deferred(),f=scheduler((_ids,_c,_p,now)=>now===0?a.promise:b.promise)
 const first=f.reader.refresh(false,0);const second=f.reader.refresh(false,2000);b.resolve({values:{w:{value:850,deviceId:'b'}}});await second;a.resolve({values:{w:{value:0,deviceId:'a'}}});await first;assert.equal(f.values.w.value,850)
 const c=deferred(),g=scheduler(()=>c.promise),pending=g.reader.refresh(false,0);g.reader.dispose();c.resolve({values:{w:{value:100}}});await pending;assert.equal(g.values.w,undefined)
})

test('removing an in-flight widget cannot leave the remaining reader stuck on an aborted promise',async()=>{
 const pending=deferred(),values={},calls=[]
 const kept={id:'kept',data:{mode:'dataset',deviceScope:'fixed',deviceId:'a',refreshMs:1000}},removed={id:'removed',data:{...kept.data}}
 let widgets=[kept]
 const reader=createWidgetReadScheduler({context:()=>({}),parameters:()=>({}),devices:()=>devices,widgets:()=>widgets,
  read:async(ids,_c,_p,now)=>{calls.push(ids);if(now===200)return pending.promise;return {values:Object.fromEntries(ids.map(id=>[id,{value:now,deviceId:'a'}]))}},
  put:(id,v)=>values[id]=v,remove:id=>delete values[id]})
 await reader.refresh(false,0)
 widgets=[kept,removed];const inFlight=reader.refresh(false,200)
 widgets=[kept];await reader.refresh(false,300)
 pending.resolve({values:{removed:{value:200,deviceId:'a'}}});await inFlight
 await reader.refresh(false,1000)
 assert.equal(values.kept.value,1000);assert.equal(values.removed,undefined);assert.equal(calls.length,3)
 reader.dispose()
})
test('video removal and pit profile upgrade are idempotent and preserve custom widgets and geometry metadata',()=>{
 const source={metadata:{pitStaticDisplay:1,custom:'keep'},widgets:[{id:'custom',type:'text'},{id:'pit_static_vms_cameras',data:{connectionId:'pit_demo_vms'}},{id:'pit_static_value_a_actual_temp',data:{deviceId:'a'}},{id:'pit_static_erp_orders',data:{connectionId:'erp',apiPath:'/'}}],scene:{views:[{id:'factory_overview',componentState:{show:['pit_static_vms_cameras'],hide:[]}}]}}
 const upgraded=upgradeWidgetPlaybackDocument(source);assert.deepEqual(upgradeWidgetPlaybackDocument(upgraded),upgraded);assert.ok(upgraded.widgets.some(w=>w.id==='custom'));assert.ok(!upgraded.widgets.some(w=>/vms|camera/.test(w.id)));assert.equal(source.widgets.length,4);assert.equal(upgraded.metadata.custom,'keep')
 for(const w of upgraded.widgets.filter(w=>w.id.startsWith('pit_playback_')&&w.data.mode!=='static'))assert.equal(w.data.deviceScope,'rotation')
})
test('all advanced chart families consume real fields and never invent missing zeros',()=>{
 assert.equal(DASHBOARD_CHARTS.length,20)
 const rows=[{time:'A',value:0,a:0,b:2,c:3,x:'X',y:'Y',open:1,close:2,low:0,high:3,min:0,q1:1,median:2,q3:3,max:4}]
 const series=['a','b','c'].map((id,i)=>({id,field:id,name:id,color:'#aaa',value:rows[0][id],rows:rows.map(r=>({...r,value:r[id]}))}))
 for(const type of DASHBOARD_CHARTS.map(c=>c.id).filter(id=>!['line','area','bar','stackedBar','gauge','scatter'].includes(id))){const option=extendedChartOption(type,{sourceSeries:series,content:{xField:'x',yField:'y'}});assert.ok(option,type);assert.ok(Array.isArray(option.series),type)}
 const pie=extendedChartOption('pie',{sourceSeries:[{name:'读数',value:null,rows:[{time:'未知',value:null},{time:'零',value:0}]}]});assert.deepEqual(pie.series[0].data.map(x=>x.value),[0])
 const candle=extendedChartOption('candlestick',{sourceSeries:[{rows:[{time:'missing',open:1}]}]});assert.equal(candle.series[0].data[0],null)
})
