import test from 'node:test'
import assert from 'node:assert/strict'
import {playbackSelection,devicePoint,normalizePlayback,isPlaybackTimestamp} from '../../shared/widgetPlayback.mjs'
import {upgradeWidgetPlaybackDocument} from '../../shared/widgetPlaybackProfile.mjs'
import {DASHBOARD_CHARTS} from '../../shared/dashboardCharts.mjs'
import {extendedChartOption} from '../src/runtime/dashboardCharts.js'
import {createWidgetReadScheduler} from '../src/runtime/widgetReadScheduler.js'
import {deferred,settle} from './helpers.mjs'
const devices=[{id:'a',name:'A',lineId:'l',workshopId:'w'},{id:'b',name:'B',lineId:'l',workshopId:'w'},{id:'foreign',name:'C',lineId:'other',workshopId:'other'}]
const binding={deviceScope:'rotation',rotationDeviceIds:['a','b'],rotationIntervalMs:2000,refreshMs:1000}

test('paused playback timestamps can be historical but cannot be unsafe, negative or too far in the future',()=>{
 const now=180000
 for(const at of [0,2000,now-120000,now,now+60000])assert.equal(isPlaybackTimestamp(at,now),true)
 for(const at of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,now+60001])assert.equal(isPlaybackTimestamp(at,now),false)
 // Retaining an old selection time does not widen the registered view range.
 assert.equal(playbackSelection(binding,{lineId:'other'},devices,0).device,null)
 assert.equal(playbackSelection(binding,{viewMode:'device',deviceId:'b'},devices,0).device.id,'b')
})

test('global regional/ERP data does not rotate devices or change to a focused device context',()=>{
 for(const context of [{viewMode:'factory'},{viewMode:'device',deviceId:'a'},{viewId:'map_world'}]) {
  const result=playbackSelection({deviceScope:'global'},context,devices,2000)
  assert.equal(result.device,null);assert.equal(result.mode,'global');assert.equal(normalizePlayback({deviceScope:'global'}).deviceScope,'global')
 }
})
test('existing device context overrides overview rotation/fixed bindings in device, xray, exploded and part views',()=>{
 assert.equal(playbackSelection(binding,{viewMode:'factory'},devices,0).device.id,'a');assert.equal(playbackSelection(binding,{viewMode:'factory'},devices,2000).device.id,'b')
 for(const viewId of ['device_detail','device_xray','device_exploded','device_part'])for(const deviceScope of ['fixed','rotation','current'])assert.equal(playbackSelection({...binding,deviceScope,deviceId:'b'},{viewId,deviceId:'a'},devices,4000).device.id,'a')
 assert.equal(playbackSelection(binding,{viewMode:'device',deviceId:'unknown'},devices,0).device,null)
 assert.equal(playbackSelection({...binding,rotationDeviceIds:['foreign']},{lineId:'l'},devices,0).device,null)
 assert.equal(normalizePlayback({refreshMs:-2,rotationIntervalMs:1}).refreshMs,250)
})
test('same-role point reuse never falls back to another device, including ambiguous or missing roles',()=>{
 const values={template:{id:'template',device_id:'a',category:'analog',value_role:'temp',value:99},one:{id:'one',device_id:'b',category:'analog',value_role:'temp',value:0}}
 assert.equal(devicePoint({pointId:'template'},'b',values).value,0);assert.equal(devicePoint({pointId:'template'},'unknown',values),null)
 assert.equal(devicePoint({pointId:'template'},'b',{...values,two:{...values.one,id:'two'}}),null)
})
test('deleted explicit fixed points stay empty instead of silently reading a same-role replacement',()=>{
 const fixed={deviceScope:'fixed',deviceId:'a',pointId:'deleted',pointKey:'analog.temp'}
 const values={replacement:{id:'replacement',device_id:'a',category:'analog',value_role:'temp',value:999},peer:{id:'peer',device_id:'b',category:'analog',value_role:'temp',value:0}}
 assert.equal(devicePoint(fixed,'a',values),null)
 // The same overview template remains usable on another device in a focused
 // device/xray/exploded/part context; only its own fixed source is strict.
 assert.equal(devicePoint(fixed,'b',values).value,0)
 assert.equal(devicePoint({...fixed,deviceScope:'rotation'},'a',values).value,999)
 assert.equal(devicePoint({...fixed,deviceScope:'current'},'a',values).value,999)
 assert.equal(devicePoint(fixed,'a',{...values,deleted:{id:'deleted',device_id:'a',category:'analog',value_role:'temp',value:0}}).value,0)
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

test('a hovered widget keeps refreshing after a long pause while its neighboring widget continues rotating',async()=>{
 const calls=[],values={},widgets=['paused','rotating'].map(id=>({id,data:{mode:'dataset',...binding}}))
 const reader=createWidgetReadScheduler({context:()=>({viewMode:'factory'}),parameters:()=>({}),devices:()=>devices,widgets:()=>widgets,
  playbackTime:(widget,now)=>widget.id==='paused'?0:now,
  read:async(ids,context,_params,playbackAt)=>{
   calls.push({ids,playbackAt})
   return {values:Object.fromEntries(ids.map(id=>[id,{value:calls.length,deviceId:playbackSelection(binding,context,devices,playbackAt).device.id}]))}
  },put:(id,value)=>values[id]=value,remove:id=>delete values[id]})
 await reader.refresh(false,0);await reader.refresh(false,500)
 assert.equal(calls.length,1)
 await reader.refresh(false,1000)
 assert.deepEqual(calls.slice(1).map(row=>[row.ids,row.playbackAt]),[[['paused'],0],[['rotating'],1000]])
 await reader.refresh(false,2000)
 assert.equal(values.paused.deviceId,'a');assert.equal(values.rotating.deviceId,'b')
 const before=calls.length
 await reader.refresh(false,123000);await reader.refresh(false,123100)
 assert.equal(calls.length,before+2,'real-time refresh deadlines must not use the frozen selection clock')
 assert.equal(values.paused.deviceId,'a');assert.equal(values.rotating.deviceId,'b')
 assert.deepEqual(calls.slice(-2).map(row=>[row.ids,row.playbackAt]),[[['paused'],0],[['rotating'],123000]])
 reader.dispose()
})

test('three-second reads keep a hovered card live despite a two-second rotating neighbor in the same lane',async()=>{
 let now=0;const calls=[],accepted=[],values={},refreshes=[]
 const widgets=['held','moving'].map(id=>({id,data:{mode:'dataset',...binding}}))
 const reader=createWidgetReadScheduler({context:()=>({viewMode:'factory'}),parameters:()=>({}),devices:()=>devices,widgets:()=>widgets,
  playbackTime:(widget,rawNow)=>widget.id==='held'?0:rawNow,
  read:(ids,context,_params,playbackAt,signal)=>{
   const response=deferred(),at=now
   calls.push({ids,at,signal,response,done:false,payload:{values:Object.fromEntries(ids.map(id=>[id,{value:100+at/1000,deviceId:playbackSelection(binding,context,devices,playbackAt).device.id}]))}})
   return response.promise
  },put:(id,record)=>{
   const expected=playbackSelection(binding,{viewMode:'factory'},devices,id==='held'?0:now).device.id
   assert.equal(record.deviceId,expected,'a late rotating result cannot be relabelled as the newly selected device')
   values[id]=record;accepted.push({id,at:now,value:record.value})
  },remove:id=>delete values[id]})
 try {
  // Deterministic raw-clock simulation of a 3s transport and 2s rotation. Keep
  // ticking during the pending read, exactly as the shared surface clock does.
  for(now=0;now<=12000;now+=1000){
   refreshes.push(reader.refresh(false,now));await settle()
   for(const call of calls)if(!call.done && now-call.at>=3000){call.done=true;call.abortedBeforeResolve=call.signal.aborted;call.response.resolve(call.payload)}
   await settle()
   assert.ok(calls.filter(call=>!call.done && !call.signal.aborted).length<=1,'the slow lane remains sequential')
  }
  assert.deepEqual(accepted.filter(row=>row.id==='held').map(row=>row.value),[100,104,108])
  assert.deepEqual(calls.filter(call=>call.ids.includes('held')).map(call=>call.at),[0,4000,8000,12000],'refresh freshness starts from completion real time, not the old selection time')
  assert.ok(calls.filter(call=>call.ids.includes('held')).every(call=>call.done?!call.abortedBeforeResolve:!call.signal.aborted),'neighbor switches never cancel a pending held device request')
  assert.ok(calls.every(call=>call.ids.length<=20));assert.equal(values.held.deviceId,'a')
 } finally {
  reader.dispose();for(const call of calls)call.response.resolve(call.payload);await Promise.all(refreshes)
 }
})

test('context and parameter changes still cancel pending held-device reads',async()=>{
 for(const change of ['context','parameters']){
  const old=deferred(),calls=[],f=scheduler((_ids,_context,_params,at,signal)=>{
   calls.push(signal);return calls.length===1?old.promise:Promise.resolve({values:{w:{value:222,deviceId:'a'}}})
  })
  const first=f.reader.refresh(false,0)
  if(change==='context')f.context({viewMode:'device',deviceId:'a'})
  else f.params({batch:'new'})
  await f.reader.refresh(false,1000)
  assert.equal(calls[0].aborted,true);assert.equal(f.values.w.value,222)
  old.resolve({values:{w:{value:111,deviceId:'a'}}});await first
  assert.equal(f.values.w.value,222);f.reader.dispose()
 }
})

test('removing one in-flight batch member preserves its still-current held neighbor and discards the removed record',async()=>{
 const response=deferred(),values={},calls=[]
 let widgets=['held','removed'].map(id=>({id,data:{mode:'dataset',...binding}}))
 const reader=createWidgetReadScheduler({context:()=>({}),parameters:()=>({}),devices:()=>devices,widgets:()=>widgets,playbackTime:()=>0,
  read:(ids,_context,_params,_at,signal)=>{calls.push({ids,signal});return response.promise},put:(id,record)=>values[id]=record,remove:id=>delete values[id]})
 const first=reader.refresh(false,0)
 widgets=widgets.filter(widget=>widget.id==='held');const latest=reader.refresh(false,1000)
 assert.equal(calls[0].signal.aborted,false)
 response.resolve({values:{held:{value:111,deviceId:'a'},removed:{value:999,deviceId:'a'}}})
 await first;await latest
 assert.equal(values.held.value,111);assert.equal(values.removed,undefined);assert.equal(calls.length,1)
 reader.dispose()
})

test('paused readers schedule remaining cache freshness using real time and resume without stale device responses',async()=>{
 let paused=true;const values={},calls=[],pending=deferred()
 const widget={id:'w',data:{mode:'dataset',...binding}}
 const reader=createWidgetReadScheduler({context:()=>({viewMode:'factory'}),parameters:()=>({}),devices:()=>devices,widgets:()=>[widget],
  playbackTime:(_widget,now)=>paused?0:now,
  read:(ids,context,_params,playbackAt)=>{
   calls.push(playbackAt)
   return calls.length===3?pending.promise:Promise.resolve({values:{w:{value:calls.length,deviceId:playbackSelection(binding,context,devices,playbackAt).device.id,refreshAfterMs:250}}})
  },put:(id,value)=>values[id]=value,remove:id=>delete values[id]})
 await reader.refresh(false,100000);await reader.refresh(false,100200)
 assert.deepEqual(calls,[0])
 await reader.refresh(false,100300);assert.deepEqual(calls,[0,0])
 const stale=reader.refresh(false,102000)
 paused=false;await reader.refresh(false,102001)
 assert.equal(values.w.deviceId,'b')
 pending.resolve({values:{w:{value:999,deviceId:'a'}}});await stale
 assert.equal(values.w.deviceId,'b');assert.notEqual(values.w.value,999)
 reader.dispose()
})

test('different selection clocks remain separated within the twenty-widget transport limit',async()=>{
 const calls=[],values={},widgets=Array.from({length:45},(_,index)=>({id:`widget_${index}`,data:{mode:'dataset',...binding}}))
 const reader=createWidgetReadScheduler({context:()=>({viewMode:'factory'}),parameters:()=>({}),devices:()=>devices,widgets:()=>widgets,
  playbackTime:(widget,now)=>Number(widget.id.slice(7))<25?0:now,
  read:async(ids,context,_params,playbackAt)=>{
   calls.push({ids,playbackAt})
   return {values:Object.fromEntries(ids.map(id=>[id,{value:1,deviceId:playbackSelection(binding,context,devices,playbackAt).device.id}]))}
  },put:(id,value)=>values[id]=value,remove:id=>delete values[id]})
 await reader.refresh(false,2000);await reader.refresh(false,2100)
 assert.deepEqual(calls.map(row=>[row.ids.length,row.playbackAt]),[[20,0],[5,0],[20,2000]])
 assert.equal(Object.keys(values).length,45);assert.equal(values.widget_24.deviceId,'a');assert.equal(values.widget_25.deviceId,'b')
 reader.dispose()
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

test('cached response schedules at remaining freshness, not another full widget interval',async()=>{
 const calls=[],f=scheduler(async(_ids,_c,_p,now)=>{calls.push(now);return {values:{w:{value:now,deviceId:'a',refreshAfterMs:250}}}});
 f.context({viewMode:'device',deviceId:'a'});
 await f.reader.refresh(false,0);await f.reader.refresh(false,200);await f.reader.refresh(false,300);
 assert.deepEqual(calls,[0,300]);f.reader.dispose();
})


test('a stalled slow ERP read does not block the bounded fast device API lane',async()=>{
 const stalled=deferred(),values={},calls=[];
 const widgets=[{id:'fast',data:{mode:'dataset',deviceScope:'fixed',deviceId:'a',refreshMs:250}},{id:'erp',data:{mode:'http_api',deviceScope:'fixed',deviceId:'a',refreshMs:5000}}];
 const reader=createWidgetReadScheduler({context:()=>({}),parameters:()=>({}),devices:()=>devices,widgets:()=>widgets,
  read:(ids,_c,_p,now)=>{calls.push({ids,now});return ids.includes('erp')?stalled.promise:Promise.resolve({values:{fast:{value:now,deviceId:'a'}}})},put:(id,v)=>values[id]=v,remove:id=>delete values[id]});
 const first=reader.refresh(false,0);await settle();assert.equal(values.fast.value,0);
 const second=reader.refresh(false,300);await settle();assert.equal(values.fast.value,300);
 assert.equal(calls.filter(r=>r.ids.includes('erp')).length,1);stalled.resolve({values:{erp:{deviceId:'a',value:1}}});await first;await second;reader.dispose();
})
