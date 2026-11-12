'use strict';
// Real isolated admin HTTP persistence, projection and cross-device queue metadata.
const assert=require('node:assert/strict'),path=require('node:path');
const {createLinkageFixture}=require('./realtime-linkage-fixture.cjs');
let fixture;
(async()=>{
 fixture=await createLinkageFixture('bidirectional-transfer');
 const {sql,cartId,targetId,foreignId,line,points,ok,request,facade}=fixture;
 sql.prepare('UPDATE data_points SET data_type=? WHERE id=?').run('BOOL',points.start);
 sql.prepare('UPDATE data_points SET data_type=? WHERE id=?').run('WORD',points.position);
 function point(device,name,type='BOOL',access='READ'){return String(sql.prepare('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?,?)').run(device,name,name,'DB1.DBX512.0',type,'mechanisms',name,access,100).lastInsertRowid)}
 const arrival=point(cartId,'arrived','WORD'),start=point(cartId,'cycle_start'),pickup=point(cartId,'cycle_pickup'),present=point(targetId,'target_present');
 const movement={enabled:true,valueMode:'station',stationInputMeaning:'target',simulationEnabled:true,currentPositionPointId:points.position,startActionPointId:points.start,arrivalPositionPointId:arrival,
  speedMode:'fixed',maxSpeed:2,acceleration:1,sceneUnitsPerMeter:1,staleMs:3000,start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0},anchorDeviceId:targetId,distanceMeters:0}]};
 const l=(await ok('/api/lines')).find(r=>r.id===line.id);
 await ok('/api/lines/'+line.id,'PUT',{name:l.name,workshop_id:l.workshop_id,layout:{...l.layout,sceneUnitsPerMeter:1},expectedLayout:l.layout});
 await ok('/api/devices/'+cartId+'/movement','PUT',{movement,expectedMovement:null});
 const route='/api/devices/'+cartId+'/animations';let loaded=await ok(route);
 const item=id=>loaded.dataItems.find(i=>String(i.binding?.pointId)===id).id;
 const {defaultTransferLink}=require('../../shared/transferLinkConfig.mjs'),{defaultTransferCycle}=require('../../shared/transferCycleConfig.mjs');
 const transfer={...defaultTransferLink(),enabled:true,actionId:'clip:feed',driveNodeName:'cad_transfer_cart_v1_feed_carriage',targetMode:'station',presenceDataItemId:item(points.presence),
  cycle:{...defaultTransferCycle(),enabled:true,startDataItemId:item(start),pickupDataItemId:item(pickup),stations:[{value:1,targetDeviceId:targetId,side:'opposite',presencePointId:present,seatNodeName:'cad_multipurpose_furnace_600_v1_elevator_basket',seatNodeLocal:[0,1.25,0]}]}};
 assert.ok(loaded.transferCapabilities.targetDevices.find(t=>t.id===targetId).presencePoints.some(p=>String(p.id)===present));
 loaded=await ok(route,'PUT',{revision:loaded.revision,config:{version:1,staleMs:3000,bindings:[],transferLink:transfer}});
 assert.deepEqual(loaded.config.transferLink,transfer);assert.deepEqual((await ok(route)).config,loaded.config);
 const originalDevices=await ok('/api/devices'),originalLines=await ok('/api/lines');
 transfer.cycle.handoffMode='adaptive';
 loaded=await ok(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:transfer}});
 assert.deepEqual((await ok(route)).config.transferLink,transfer);
 const afterDevices=await ok('/api/devices');for(const before of originalDevices){const after=afterDevices.find(d=>d.id===before.id);for(const key of ['pos_x','pos_y','pos_z','rotation_y','scale','plc_enabled'])assert.deepEqual(after[key],before[key]);}
 assert.deepEqual(await ok('/api/lines'),originalLines);
 const raw=JSON.parse((await ok('/api/devices/'+cartId)).instance_config);
 for(const name of ['start','pickup'])assert.match(raw.animationBindings.transferLink.cycle[name+'SourceFingerprint'],/^[a-f0-9]{64}$/);
 assert.equal(raw.marker,'must survive');
 for(const patch of [
  {startDataItemId:item(points.feed)},{pickupDataItemId:'point_'+points.write},
  {startDataItemId:item(pickup)},{startSourceFingerprint:'forged'},
  {stations:[]},{stations:[{...transfer.cycle.stations[0],targetDeviceId:foreignId}]},
  {stations:[{...transfer.cycle.stations[0],presencePointId:points.foreign}]},
  {stations:[{...transfer.cycle.stations[0],presencePointId:points.targetPosition}]},
  {stations:[{...transfer.cycle.stations[0],side:'guessed'}]},{handoffMode:'stretch-original-chain'}
 ]){
  const r=await request(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:{...transfer,cycle:{...transfer.cycle,...patch}}}});
  assert.equal(r.status,400,JSON.stringify(r));assert.deepEqual((await ok(route)).config,loaded.config);
 }
 for(const actionId of ['clip:feed','clip:hook','clip:feed_opposite','clip:hook_opposite']){
  const r=await request(route,'PUT',{revision:loaded.revision,config:{...loaded.config,bindings:[{actionId,enabled:true,dataItemId:item(points.feed),pointId:'',trigger:{mode:'range'},inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:.1}]}});
  assert.equal(r.status,400);assert.match(r.data.error,/双侧循环/);
 }
 Object.assign(process.env,{APP_DATA_DIR:fixture.dataDir,DB_TYPE:'sqlite',SQLITE_FILE:fixture.filename,DATA_SOURCE_BACKUP_DIR:path.join(fixture.dataDir,'backups')});
 for(const k of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME'])delete process.env[k];
 const prepared=await require('../services/deviceAnimations').loadDeviceAnimations(facade,cartId,'factory_default',{includeTransferTargets:false});
 let now=Date.now();const {MotionInputResolver}=require('../services/motionInputs'),resolver=new MotionInputResolver({getDb:async()=>facade,now:()=>now});
 const frame={furnace_id:cartId,timestamp:now,mechanisms:{},quality:{mechanisms:{}},pointMeta:{},status:{online:true}};
 for(const id of [points.presence,start,pickup]){const i=prepared.catalog.items.find(i=>String(i.binding?.pointId)===id),key=i.binding.pointKey,field=key.slice(key.indexOf('.')+1);frame.mechanisms[field]=true;frame.quality.mechanisms[field]='good';frame.pointMeta[key]={id,timestamp:now}}
 const entry={id:cartId,loaded:prepared,datasets:new Map(),readAt:now};
 for(const name of ['presence','start','pickup'])assert.equal(resolver.inputs(entry,frame)['__transfer_'+name].value,true);
 const startKey=prepared.catalog.items.find(i=>i.id===transfer.cycle.startDataItemId).binding.pointKey;
 frame.mechanisms[startKey.slice(startKey.indexOf('.')+1)]=1;assert.equal(resolver.inputs(entry,frame).__transfer_start.quality,'bad');resolver.dispose();
 const {MotionSemanticResolver}=require('../services/motionSemantics'),semantics=new MotionSemanticResolver({getDb:async()=>facade,now:()=>now});
 assert.equal(await semantics.refresh(),true);
 const sourceRecord=semantics.records.get(cartId),targetRecord=semantics.records.get(targetId);
 assert.equal(sourceRecord.valid,true);assert.equal(targetRecord.valid,true);
 for(const name of ['presence','start','pickup'])assert.ok(sourceRecord.bindings.some(b=>b.key==='transfer:'+name&&b.kind==='condition'&&b.value===true));
 assert.ok(targetRecord.bindings.some(b=>b.source.pointId===present&&b.kind==='condition'&&b.value===true));
 assert.ok(!semantics.records.get(foreignId).bindings.some(b=>b.key.startsWith('transfer:target:')));semantics.dispose();
 console.log('PASS dual-side HTTP save/reopen, strict BOOL ownership, single pose owner, typed projections and cross-device causal edges');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>fixture?.close());
