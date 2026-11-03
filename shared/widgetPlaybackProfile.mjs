// Reversible presentation upgrade for the previously generated pit workshop.
// Never changes geometry, PLC addresses, acquisition mode or source credentials.
export function upgradeWidgetPlaybackDocument(input) {
 if(!input || !Array.isArray(input.widgets))return input
 const isVideo=w=>/^pit_static_(vms_|camera_)/.test(w.id || '') || /(^|_)vms($|_)/i.test(w.data?.connectionId || '') || w.title==='视频监控'
 const videos=input.widgets.filter(isVideo)
 const pit=input.metadata?.pitStaticDisplay===1 && input.metadata?.devicePlaybackProfile!==1
 if(!videos.length && !pit)return input
 const doc=JSON.parse(JSON.stringify(input)),removed=new Set(videos.map(w=>w.id))
 if(pit)for(const w of doc.widgets)if(w.id.startsWith('pit_static_'))removed.add(w.id)
 const furnaceIds=[...new Set(doc.widgets.filter(w=>/^pit_static_value_.*_actual_temp$/.test(w.id)).map(w=>w.data?.deviceId).filter(Boolean))]
 const erp=doc.widgets.find(w=>w.id==='pit_static_erp_orders')
 doc.widgets=doc.widgets.filter(w=>!removed.has(w.id))
 if(pit){
  const views=['factory_overview','workshop_overview','line_overview','device_detail','device_xray','device_exploded','device_part']
  const data={mode:'runtime',deviceScope:'rotation',rotationDeviceIds:furnaceIds,rotationIntervalMs:10000,refreshMs:1000,readOnly:true}
  const add=(id,type,title,frame,content,binding={...data,path:'device.analog.actual_temp'},viewIds=views)=>{
   doc.widgets.push({id:'pit_playback_'+id,type,title,frame:{...frame,rotation:0},visible:true,locked:false,runtimeTarget:'overlay',zIndex:20,
    content,style:{backgroundOpacity:.22,color:'#e6dff4',borderColor:'#c4afe830',borderRadius:8,fontSize:16},data:binding,
    visibility:{viewIds,viewModes:[],rules:[],matchBoundDevice:false},events:[],conditions:[],animation:{type:'none'}})
  }
  add('brand','text','',{x:32,y:36,width:610,height:90},{text:'井式炉工厂 · 生产运行',showTitle:false},{mode:'static'})
  add('parameters','hud_kpi_panel','设备参数',{x:32,y:180,width:350,height:430},{showRing:false,eyebrow:'EQUIPMENT',items:[
   {label:'实际温度',path:'device.analog.actual_temp',unit:'°C',decimals:1},{label:'设定温度',path:'device.analog.setpoint_temp',unit:'°C',decimals:0},
   {label:'循环风机转速',path:'device.motors.rear_fan_speed',unit:'rpm',decimals:0}
  ]})
  add('running','status','设备运行',{x:32,y:634,width:165,height:122},{onText:'运行',offText:'待机',unknownText:'—',shape:'badge',showDeviceLabel:false},{...data,path:'device.status.running'})
  add('alarm','status','报警状态',{x:212,y:634,width:170,height:122},{onText:'报警',offText:'正常',unknownText:'—',shape:'badge',showDeviceLabel:false},{...data,path:'device.status.alarm'})
  add('fan','status','循环风机',{x:32,y:778,width:165,height:122},{onText:'运行',offText:'停止',unknownText:'—',shape:'badge',showDeviceLabel:false},{...data,path:'device.motors.rear_fan'})
  add('cover','status','炉盖状态',{x:212,y:778,width:170,height:122},{onText:'开启',offText:'关闭',unknownText:'—',shape:'badge',showDeviceLabel:false},{...data,path:'device.doors.front_door_open'})
  add('temperature','hud_chart_dock','温度趋势',{x:430,y:812,width:1040,height:230},{chartType:'smoothLine',smooth:true,showAxis:true,historyLength:120,lineColor:'#b29cdf',showLegend:false,showTitle:true}, {...data,path:'device.analog.actual_temp',unit:'°C',decimals:1})
  if(erp)add('orders','hud_alarm_panel','生产任务',{x:1536,y:180,width:350,height:365},{limit:5,eyebrow:'PRODUCTION'},{...data,mode:'http_api',connectionId:erp.data.connectionId,apiPath:erp.data.apiPath,jsonPath:'orders',contextField:'deviceId',contextKey:'deviceId',refreshMs:5000})
  add('part','hud_kpi_panel','部件信息',{x:1536,y:568,width:350,height:340},{showRing:false,usePartPoints:true,eyebrow:'COMPONENT',items:[{label:'名称',path:'selectedPart.name'},{label:'说明',path:'selectedPart.description'}]},{...data,path:'selectedPart.name'},['device_xray','device_exploded','device_part'])
  const telemetryRules=[{source:'context',path:'viewMode',operator:'!=',value:'device'},...furnaceIds.map(id=>({source:'context',path:'deviceId',operator:'==',value:id}))];
  for(const w of doc.widgets.filter(w=>w.id.startsWith('pit_playback_') && !['pit_playback_brand','pit_playback_part'].includes(w.id))){w.visibility.ruleMode='any';w.visibility.rules=telemetryRules;}
  add('facility','hud_kpi_panel','设施信息',{x:32,y:180,width:350,height:360},{showRing:false,eyebrow:'FACILITY',items:[{label:'名称',path:'deviceInfo.name'},{label:'所属车间',path:'deviceInfo.workshopName'},{label:'所属产线',path:'deviceInfo.lineName'},{label:'标高',path:'deviceInfo.posY',unit:'m'}]},{...data,path:'deviceInfo.name'},['device_detail','device_xray','device_exploded','device_part']);
  doc.widgets.find(w=>w.id==='pit_playback_facility').visibility.rules=furnaceIds.map(id=>({source:'context',path:'deviceId',operator:'!=',value:id}));
  const part=doc.widgets.find(w=>w.id==='pit_playback_part');if(part)part.visibility.rules=[{source:'context',path:'partId',operator:'truthy'}]
  doc.metadata={...doc.metadata,devicePlaybackProfile:1}
 }
 for(const view of doc.scene?.views || [])for(const key of ['show','hide'])if(Array.isArray(view.componentState?.[key])){
  const prior=view.componentState[key];view.componentState[key]=prior.filter(id=>!removed.has(id))
  if(pit && key==='show' && prior.length){for(const w of doc.widgets.filter(w=>w.id.startsWith('pit_playback_')&&w.visibility.viewIds?.includes(view.id)))view.componentState.show.push(w.id)}
 }
 for(const w of doc.widgets)if(Array.isArray(w.events))w.events=w.events.filter(e=>!removed.has(e.targetId))
 return doc
}
