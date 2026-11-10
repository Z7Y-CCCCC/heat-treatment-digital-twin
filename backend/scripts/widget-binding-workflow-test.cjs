const assert=require('node:assert/strict');
const path=require('node:path');
const {createRunDirectory,createTestDatabase}=require('./integration-test-utils.cjs');
const directory=createRunDirectory('widget-binding-workflow');
let closeDb;
(async()=>{
 const file=path.join(directory,'factory.db');await createTestDatabase(file);
 Object.assign(process.env,{APP_DATA_DIR:directory,DB_TYPE:'sqlite',SQLITE_FILE:file,DATA_SOURCE_BACKUP_DIR:path.join(directory,'backups')});
 for(const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME'])delete process.env[key];
 const database=require('../db/database');closeDb=database.closeDb;const db=await database.getDb();
 const {normalizeDocument}=require('../utils/dashboardDocument'),documents=require('../services/dashboardDocuments'),center=require('../services/dataCenter'),browse=require('../services/dataCenterBrowse');
 const devices=await db.all('SELECT d.id FROM devices d JOIN `lines` l ON l.id=d.line_id JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 2',['factory_default']);
 assert.equal(devices.length,2);
 const [a,b]=devices.map(d=>String(d.id));
 const insert=async(id,name,tag)=>(await db.run('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,unit) VALUES (?,?,?,?,?,?,?,?,?)',[id,name,name,tag,'REAL','analog',name,'READ','℃'])).lastInsertRowid;
 const pa=String(await insert(a,'explicit_a','DB1.DBD16')),pb=String(await insert(b,'explicit_b','DB9.DBD80'));
 const project=await db.get('SELECT * FROM projects WHERE factory_id=? LIMIT 1',['factory_default']),scene=await db.get('SELECT * FROM scenes WHERE project_id=? LIMIT 1',[project.id]);
 const data={mode:'plc',bindingVersion:2,deviceScope:'rotation',rotationIntervalMs:12000,pointId:pa,pointKey:'analog.explicit_a',requireConfiguredPoint:true,deviceBindings:[{deviceId:a,binding:{mode:'plc',pointId:pa,pointKey:'analog.explicit_a',unit:'℃'}},{deviceId:b,binding:{mode:'plc',pointId:pb,pointKey:'analog.explicit_b',unit:'℃'}}]};
 const document=normalizeDocument({schemaVersion:3,projectId:project.id,sceneId:scene.id,widgets:[{id:'explicit_test',type:'hud_kpi_panel',frame:{x:10,y:10,width:400,height:200},data,content:{useBoundRing:true,items:[{label:'实际采集',binding:{...data,deviceScope:'current'}}]}}]},{project,scene});
 await documents.validatePlcBindings(db,document);
 const bad=JSON.parse(JSON.stringify(document));bad.widgets[0].data.deviceBindings[1].binding.pointId=pa;
 await assert.rejects(()=>documents.validatePlcBindings(db,bad),/设备与点位不匹配/);
 const badMetric=JSON.parse(JSON.stringify(document));badMetric.widgets[0].content.items[0].binding.deviceBindings[1].binding.pointId=pa;
 await assert.rejects(()=>documents.validatePlcBindings(db,badMetric),/设备与点位不匹配/);
 await db.run('UPDATE data_points SET access_type=? WHERE id=?',['WRITE',pb]);
 await assert.rejects(()=>documents.validatePlcBindings(db,document),/READ/);
 await db.run('UPDATE data_points SET access_type=? WHERE id=?',['READ',pb]);
 const mixed=JSON.parse(JSON.stringify(document));Object.assign(mixed.widgets[0].data,{mode:'dataset',datasetId:'',datasetField:''});
 await documents.validatePlcBindings(db,mixed);
 await db.run('INSERT INTO factories (id,name) VALUES (?,?)',['workflow_other','Other factory']);
 await db.run('INSERT INTO workshops (id,name,factory_id) VALUES (?,?,?)',['workflow_other_ws','Other workshop','workflow_other']);
 await db.run('INSERT INTO `lines` (id,name,workshop_id) VALUES (?,?,?)',['workflow_other_line','Other line','workflow_other_ws']);
 await db.run('INSERT INTO devices (id,name,line_id) VALUES (?,?,?)',['workflow_foreign','Foreign device','workflow_other_line']);
 const runtimeSource={mode:'runtime',path:'deviceInfo.name'};
 const foreignRuntime=JSON.parse(JSON.stringify(document));
 foreignRuntime.widgets[0].content.items=[];
 foreignRuntime.widgets[0].data={mode:'runtime',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:'workflow_foreign',binding:runtimeSource}]};
 await assert.rejects(()=>documents.validatePlcBindings(db,foreignRuntime,{allowIncompleteBindings:true}),/不属于当前工厂/);
 const missingRuntime=JSON.parse(JSON.stringify(foreignRuntime));missingRuntime.widgets[0].data.deviceBindings[0].deviceId='workflow_removed';
 assert.ok((await documents.validatePlcBindings(db,missingRuntime,{allowIncompleteBindings:true})).some(message=>message.includes('设备不存在')));
 await assert.rejects(()=>documents.validatePlcBindings(db,missingRuntime),/设备不存在/);
 const definition=await require('../services/dataSets').saveDataSet({name:'Workflow actual source',source:'database',connectionId:'primary',database:{table:'data_points'},columns:[{name:'label',path:'label',type:'string'}]},'factory_default');
 const foreignDataset=JSON.parse(JSON.stringify(document));
 foreignDataset.widgets[0].content.items=[];
 foreignDataset.widgets[0].data={mode:'dataset',bindingVersion:2,datasetId:definition.id,datasetField:'label',deviceScope:'current',deviceBindings:[{deviceId:'workflow_foreign',binding:{mode:'dataset',datasetId:definition.id,datasetField:'label'}}]};
 await assert.rejects(()=>documents.validatePlcBindings(db,foreignDataset,{allowIncompleteBindings:true}),/不属于当前工厂/);
 const globalMetric=JSON.parse(JSON.stringify(document));
 globalMetric.widgets[0].data={mode:'runtime',path:'metrics.current_output',deviceScope:'global'};
 globalMetric.widgets[0].content.items=[{label:'Explicit fixed dataset',binding:{mode:'dataset',datasetId:definition.id,datasetField:'label',deviceScope:'fixed',deviceId:b}}];
 await documents.validatePlcBindings(db,globalMetric);
 const globalForeignMetric=JSON.parse(JSON.stringify(globalMetric));globalForeignMetric.widgets[0].content.items[0].binding.deviceId='workflow_foreign';
 await assert.rejects(()=>documents.validatePlcBindings(db,globalForeignMetric,{allowIncompleteBindings:true}),/不属于当前工厂/);
 const globalV2Metric=JSON.parse(JSON.stringify(globalMetric));globalV2Metric.widgets[0].content.items[0].binding={mode:'dataset',bindingVersion:2,deviceScope:'fixed',deviceId:b,deviceBindings:[{deviceId:b,binding:{mode:'dataset',datasetId:definition.id,datasetField:'label'}}]};
 await documents.validatePlcBindings(db,globalV2Metric);
 const globalV2ForeignMetric=JSON.parse(JSON.stringify(globalV2Metric));Object.assign(globalV2ForeignMetric.widgets[0].content.items[0].binding,{deviceId:'workflow_foreign',deviceBindings:[{deviceId:'workflow_foreign',binding:{mode:'dataset',datasetId:definition.id,datasetField:'label'}}]});
 await assert.rejects(()=>documents.validatePlcBindings(db,globalV2ForeignMetric,{allowIncompleteBindings:true}),/不属于当前工厂/);
 const invalidMetric=JSON.parse(JSON.stringify(document));
 invalidMetric.widgets[0].content.items[0].binding={mode:'dataset',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:a,binding:{mode:'dataset',datasetId:definition.id,datasetField:'invalid field'}}]};
 await assert.rejects(()=>documents.validatePlcBindings(db,invalidMetric),/数据集与字段/);
 const missingDeviceMetric=JSON.parse(JSON.stringify(document));
 missingDeviceMetric.widgets[0].content.items[0].binding.deviceBindings=missingDeviceMetric.widgets[0].content.items[0].binding.deviceBindings.slice(0,1);
 await assert.rejects(()=>documents.validatePlcBindings(db,missingDeviceMetric),/未选择对应数据/);
 await documents.validatePlcBindings(db,missingDeviceMetric,{allowIncompleteBindings:true});
 const fixedWithInactiveMetric=JSON.parse(JSON.stringify(document));Object.assign(fixedWithInactiveMetric.widgets[0].data,{deviceScope:'fixed',deviceId:a});
 fixedWithInactiveMetric.widgets[0].content.items[0].binding.deviceBindings[1].binding={mode:'dataset',datasetId:'deleted_inactive',datasetField:''};
 await documents.validatePlcBindings(db,fixedWithInactiveMetric);
 const saved=await documents.saveDraft(db,{sceneId:scene.id,document,expectedRevision:scene.draft_revision,factoryId:'factory_default'});
 const reloaded=await documents.loadDesignerState(db,scene.id,'factory_default');
 assert.equal(reloaded.document.widgets[0].data.deviceBindings[1].binding.pointId,pb);
 assert.equal(reloaded.document.widgets[0].data.rotationIntervalMs,12000);
 assert.equal(reloaded.document.widgets[0].content.items[0].binding.deviceBindings[0].binding.pointId,pa);
 const catalog=await center.buildCatalog('factory_default','',null,'',{runtimePreview:false});
 assert.equal(catalog.items.find(item=>item.id==='internal_event_records').binding.path,'events');
 await db.run('INSERT INTO event_logs (factory_id,source_id,title,message,level) VALUES (?,?,?,?,?)',['factory_default',a,'实际事件','已存储的报警内容','warning']);
 await db.run('INSERT INTO event_logs (factory_id,source_id,title,message,level) VALUES (?,?,?,?,?)',['other_factory',a,'外厂事件','不应返回','warning']);
 const events=await browse.browseTable('factory_default','internal_events',{q:'已存储的报警内容'});
 assert.equal(events.records.length,1);assert.equal(events.records[0].value,'已存储的报警内容');assert.equal(events.capabilities.history,true);
 await assert.rejects(()=>browse.browseTable('factory_default','internal_events',{device_id:a,part_id:'not_a_part'}),/不使用部件筛选/);
 for(const [title,time] of [['秒边界','2026-11-08 10:00:00'],['温度上限','2026-11-08 10:00:00.500'],['范围之外','2026-11-08 10:00:00.900']])await db.run('INSERT INTO event_logs (factory_id,source_id,title,message,level,occurred_at) VALUES (?,?,?,?,?,?)',['factory_default','collector_workflow',title,'真实内容','warning',time]);
 const exactHistory=await browse.browseTable('factory_default','internal_events',{mode:'history',start:'2026-11-08T10:00:00.250Z',end:'2026-11-08T10:00:00.700Z'});
 assert.deepEqual(exactHistory.records.map(row=>row.title),['温度上限']);
 const secondBoundary=await browse.browseTable('factory_default','internal_events',{mode:'history',start:'2026-11-08T10:00:00Z',end:'2026-11-08T10:00:00Z'});
 assert.deepEqual(secondBoundary.records.map(row=>row.title),['秒边界']);
 const eventTitleSearch=await browse.browseTable('factory_default','internal_events',{q:'温度上限'});
 assert.equal(eventTitleSearch.total,1);assert.equal(eventTitleSearch.records[0].sourceId,'collector_workflow');assert.match(eventTitleSearch.records[0].objectPath,/collector_workflow/);
 assert.equal((await browse.browseTable('factory_default','internal_events',{q:'collector_workflow'})).total,3);
 assert.equal((await browse.browseTable('factory_default','internal_events',{q:'没有实际记录的搜索'})).total,0);
 const sampleTime=Date.now();
 for(const [label,reading,status,expected] of [
   ['fresh zero',{device_id:a,lastReadAt:sampleTime},{deviceId:a,quality:'good'},'good'],
   ['missing sample time',{device_id:a},{deviceId:a,quality:'good'},'unknown'],
   ['stale sample',{device_id:a,lastReadAt:sampleTime-3600000},{deviceId:a,quality:'good'},'stale'],
   ['future sample',{device_id:a,lastReadAt:sampleTime+60000},{deviceId:a,quality:'good'},'unknown'],
   ['foreign frame',{device_id:a,lastReadAt:sampleTime},{deviceId:b,quality:'good'},'unknown'],
   ['foreign point',{device_id:b,lastReadAt:sampleTime},{deviceId:a,quality:'good'},'unknown'],
   ['disconnected',{device_id:a,lastReadAt:sampleTime},{deviceId:a,quality:'bad',online:false},'bad']
 ]){
   global.dataEngine={getPointRuntimeValues:async()=>({deviceStatus:status,points:[{id:pa,value:0,quality:'good',...reading}]})};
   const item=(await center.buildCatalog('factory_default',a)).items.find(item=>item.binding.pointId===pa);
   assert.equal(item.quality,expected,label);assert.equal(item.previewValue,expected==='good'?0:null,label);
 }
 delete global.dataEngine;
 const part={id:'workflow_door',name:'Configured door',group:'机构',nodeNames:['Door'],point_ids:[pb]};
 await db.run('INSERT INTO models (id,name,file_path,factory_id,metadata) VALUES (?,?,?,?,?)',['workflow_empty_model','No parts','/workflow_empty.glb','factory_default','{}']);
 await db.run('INSERT INTO models (id,name,file_path,factory_id,metadata) VALUES (?,?,?,?,?)',['workflow_parts_model','Actual parts','/workflow_parts.glb','factory_default',JSON.stringify({inspection:{parts:[part]}})]);
 await db.run('UPDATE devices SET model_type=?,instance_config=? WHERE id=?',['workflow_empty_model','{}',a]);
 await db.run('UPDATE devices SET model_type=?,instance_config=? WHERE id=?',['workflow_parts_model','{}',b]);
 const emptyPreview=await center.buildCatalog('factory_default','',null,a,{runtimePreview:false});
 const partPreview=await center.buildCatalog('factory_default','',null,b,{runtimePreview:false});
 assert.deepEqual(emptyPreview.items.map(item=>item.id),partPreview.items.map(item=>item.id));
 assert.deepEqual(emptyPreview.tables.map(table=>table.id),partPreview.tables.map(table=>table.id));
 assert.equal(emptyPreview.items.find(item=>item.id==='internal_part_name').previewValue,null);
 assert.equal(partPreview.items.find(item=>item.id==='internal_part_name').previewValue,'Configured door');
 for(const [owner,expected] of [[b,0],[a,null]]){
   global.dataEngine={getPointRuntimeValues:async()=>({deviceStatus:{deviceId:b,quality:'good'},points:[{id:pb,device_id:owner,value:0,quality:'good',lastReadAt:Date.now()}]})};
   const partRecords=await browse.browseTable('factory_default','internal_parts',{device_id:b,part_id:part.id,field_id:'internal_part_point_0'});
   assert.equal(partRecords.records[0].value,expected,'part parameters never use foreign owned frames');
 }
 delete global.dataEngine;
 const {readPlaybackBindings}=require('../services/widgetPlayback');
 const selected=await readPlaybackBindings([{id:'x',data:{...data,deviceBindings:data.deviceBindings.map((row,index)=>({...row,binding:{mode:'dataset',datasetId:index?'data_b':'data_a',datasetField:'value'}}))}}],{playbackDevices:[{id:a},{id:b}],playbackAt:12000},async widgets=>Object.fromEntries(widgets.map(w=>[w.id,{value:w.data.datasetId,quality:'good'}])));
 assert.equal(selected.x.value,'data_b');assert.equal(selected.x.deviceId,b);
 const metricCalls=[];
 const metricData={mode:'dataset',bindingVersion:2,deviceScope:'current',datasetId:'stale_fallback',deviceBindings:[{deviceId:a,binding:{mode:'dataset',datasetId:'metric_a',datasetField:'value'}},{deviceId:b,binding:{mode:'dataset',datasetId:'metric_b',datasetField:'value'}}]};
 const missingMetric=JSON.parse(JSON.stringify(metricData));missingMetric.deviceBindings[1].binding=null;
 const metricResults=await readPlaybackBindings([
   {id:'__binding_metric_0',data:{mode:'dataset',deviceScope:'global',datasetId:'occupied'}},
   {id:'panel',data,content:{items:[{binding:missingMetric},{binding:{mode:'dataset',datasetId:'factory_total',datasetField:'value',deviceScope:'global'}},{binding:metricData}]}}
 ],{deviceId:a,partId:'part_of_a',viewMode:'factory',playbackDevices:[{id:a},{id:b}],playbackAt:12000},async(widgets,context)=>{
   metricCalls.push({context,widgets});assert.equal(context.partId,undefined);
   return Object.fromEntries(widgets.filter(widget=>widget.data.mode==='dataset').map(widget=>[widget.id,{value:widget.data.datasetId,quality:'good',refreshAfterMs:context.deviceId?500:100}]));
 });
 assert.equal(metricResults.panel.deviceId,b);assert.equal(metricResults.panel.metrics[0].quality,'bad');assert.equal(metricResults.panel.metrics[0].value,null);
 assert.equal(metricResults.panel.metrics[1].value,'factory_total');assert.equal(metricResults.panel.metrics[1].deviceId,'');
 assert.equal(metricResults.panel.metrics[2].value,'metric_b');assert.equal(metricResults.panel.refreshAfterMs,100);
 assert.equal(metricResults.__binding_metric_0.value,'occupied');
 assert.ok(metricCalls.find(call=>call.context.deviceId==='').widgets.every(widget=>widget.data.deviceScope==='global'));
 assert.ok(metricCalls.every(call=>call.widgets.every(widget=>widget.data.datasetId!=='stale_fallback')));
 const fixedMetricCalls=[];
 const fixedMetricResults=await readPlaybackBindings([{id:'global_panel',data:{mode:'runtime',path:'metrics.current_output',deviceScope:'global'},content:{items:[
   {binding:{mode:'dataset',bindingVersion:2,deviceScope:'fixed',deviceId:b,deviceBindings:[{deviceId:b,binding:{mode:'dataset',datasetId:'fixed_b',datasetField:'value'}}]}},
   {binding:{mode:'dataset',bindingVersion:2,deviceScope:'fixed',deviceId:'workflow_foreign',deviceBindings:[{deviceId:'workflow_foreign',binding:{mode:'dataset',datasetId:'foreign_b',datasetField:'value'}}]}}
 ]}}],{deviceId:a,partId:'part_of_a',playbackDevices:[{id:a},{id:b}],playbackAt:0},async(widgets,context)=>{
   fixedMetricCalls.push({widgets,context});return Object.fromEntries(widgets.filter(widget=>widget.data.mode==='dataset').map(widget=>[widget.id,{value:widget.data.datasetId,quality:'good'}]));
 });
 assert.equal(fixedMetricResults.global_panel.deviceId,'');assert.equal(fixedMetricResults.global_panel.metrics[0].deviceId,b);assert.equal(fixedMetricResults.global_panel.metrics[0].value,'fixed_b');
 assert.equal(fixedMetricResults.global_panel.metrics[1].quality,'bad');assert.equal(fixedMetricResults.global_panel.metrics[1].value,null);
 assert.ok(fixedMetricCalls.some(call=>call.context.deviceId===b));assert.ok(fixedMetricCalls.every(call=>call.context.partId===undefined));
 assert.ok(fixedMetricCalls.every(call=>call.widgets.every(widget=>widget.data.datasetId!=='foreign_b')));
 const bulkWidgets=Array.from({length:20},(_,panel)=>({id:`bulk_panel_${panel}`,type:'hud_kpi_panel',data:{...data,deviceScope:'fixed',deviceId:a},content:{items:Array.from({length:8},(_,metric)=>({label:`Metric ${metric+1}`,binding:{mode:'dataset',bindingVersion:2,deviceScope:'current',deviceBindings:[{deviceId:a,binding:{mode:'dataset',datasetId:`bulk_${panel}_${metric}`,datasetField:'value'}}]}}))}}));
 let bulkReads=0,activeBulkReads=0,maxActiveBulkReads=0;
 const bulkValues=await readPlaybackBindings(bulkWidgets,{deviceId:a,viewMode:'factory',playbackDevices:[{id:a},{id:b}],playbackAt:0},async(widgets)=>{
   assert.ok(widgets.length<=20,'expanded metrics must not exceed lower reader target caps');
   bulkReads++;maxActiveBulkReads=Math.max(maxActiveBulkReads,++activeBulkReads);
   await new Promise(resolve=>setTimeout(resolve,1));activeBulkReads--;
   // Emulate the real low-level 100-dataset limit. All 160 metric targets must
   // survive expansion, and an individual bad record must retain its error.
   return Object.fromEntries(widgets.filter(widget=>widget.data.mode==='dataset').slice(0,100).map(widget=>[widget.id,widget.data.datasetId==='bulk_19_7'
     ? {value:null,quality:'bad',error:'单项采集异常'} : {value:widget.data.datasetId,quality:'good'}]));
 });
 assert.ok(bulkReads>=8);assert.equal(maxActiveBulkReads,1,'one device lane stays sequential');
 for(let panel=0;panel<20;panel++)for(let metric=0;metric<8;metric++){
   const value=bulkValues[`bulk_panel_${panel}`].metrics[metric];
   assert.ok(value,`bulk panel ${panel} metric ${metric} must have a result key`);
   if(panel===19 && metric===7){assert.equal(value.quality,'bad');assert.equal(value.error,'单项采集异常')}
   else{assert.equal(value.quality,'good');assert.equal(value.value,`bulk_${panel}_${metric}`)}
 }
 const missingMain=await readPlaybackBindings([{id:'missing',data:{...data,deviceBindings:[{deviceId:a,binding:null},{deviceId:b,binding:null}]}}],{viewMode:'factory',playbackDevices:[{id:a},{id:b}],playbackAt:12000},async()=>{throw new Error('missing sources must not be read')});
 assert.equal(missingMain.missing.quality,'bad');assert.equal(missingMain.missing.value,null);
 console.log(JSON.stringify({success:true,isolatedDatabase:file,checks:['explicit different point/addresses','owned READ sources only','nested panel source validation','v2 row source metadata is authoritative','all row types enforce factory ownership even in incomplete drafts','global HUD fixed metrics validate and read their explicit device only','fixed parents retain inactive metrics without invalidating publication','save/reopen mappings and timing','actual event table and factory isolation','event title/source search and exact history range','catalog freshness rejects missing/stale/foreign frames','preview changes preserve part table metadata','part parameters reject foreign owned frames','backend selects per-device external table','HUD metric missing/global scopes and collision-free read targets','20 HUDs with 160 metrics use bounded sequential reads and preserve individual errors','missing bindings never call external readers'],revision:saved.revision},null,2));
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(closeDb)await closeDb()});
