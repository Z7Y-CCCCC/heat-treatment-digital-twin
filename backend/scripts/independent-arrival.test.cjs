'use strict';
const assert=require('node:assert/strict');
const {validateMovementConfig,validateMovementSources}=require('../services/movementConfig');
const {deriveMotionSemantics}=require('../../shared/motionSemanticPolicy.cjs');
const base={enabled:true,valueMode:'station',stationInputMeaning:'target',simulationEnabled:true,currentPositionPointId:'1',arrivalPositionPointId:'2',startActionPointId:'3',start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}},{value:2,position:{x:10,y:0,z:0}}]};
let checks=0;
function bad(patch,re){assert.throws(()=>validateMovementConfig({...base,...patch}),re);checks++;}
(async()=>{
 assert.deepEqual(validateMovementConfig({...base}),base);checks++;
 bad({arrivalPositionPointId:'1'},/目标命令/);bad({startActionPointId:''},/BOOL/);bad({stationInputMeaning:'current'},/目标工位/);bad({arrivalPositionPointId:{}},/标识/);
 const points=new Map([['1',{device_id:'cart',data_type:'WORD',access_type:'READ'}],['2',{device_id:'cart',data_type:'WORD',access_type:'READ'}],['3',{device_id:'cart',data_type:'BOOL',access_type:'READ'}]]);
 const db={get:async(q,p)=>{const row=points.get(String(p[0]));return row?.device_id===p[1]?row:undefined;},all:async()=>[]};
 await validateMovementSources(db,{id:'cart'},base,'factory',()=>false);checks++;
 for(const patch of [{data_type:'BOOL'},{access_type:'WRITE'},{device_id:'other'}]){
  const old=points.get('2');points.set('2',{...old,...patch});await assert.rejects(()=>validateMovementSources(db,{id:'cart'},base,'factory',()=>false));checks++;points.set('2',old);
 }
 points.get('3').data_type='WORD';await assert.rejects(()=>validateMovementSources(db,{id:'cart'},base,'factory',()=>false),/BOOL/);checks++;
 const semantic=deriveMotionSemantics({movement:base,animationBindings:{bindings:[]}});
 assert.equal(semantic.valid,true);assert.deepEqual(semantic.bindings.map(r=>[r.key,r.kind,r.source.pointId]),[['movement:start','condition','3'],['movement:station','station','1'],['movement:arrival','station','2']]);checks++;
 const f=await require('./realtime-linkage-fixture.cjs').createLinkageFixture('independent-arrival');
 try {
  f.sql.prepare('UPDATE data_points SET data_type=? WHERE id=?').run('BOOL',f.points.start);
  const arrival=String(f.sql.prepare('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type,sample_interval_ms) VALUES (?,?,?,?,?,?,?,?,?)').run(f.cartId,'arrived','Last arrived','DB1.DBW100','WORD','mechanisms','arrived','READ',200).lastInsertRowid);
  const movement={...base,currentPositionPointId:f.points.position,arrivalPositionPointId:arrival,startActionPointId:f.points.start};
  const ids=[f.points.position,f.points.start,arrival];
  await f.ok('/api/devices/'+f.cartId+'/movement','PUT',{movement,pointIds:ids,expectedMovement:null});
  const saved=JSON.parse(f.sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(f.cartId).instance_config);
  assert.deepEqual(saved.movement,movement);assert.equal(saved.marker,'must survive');
  for(const id of ids)assert.equal(f.sql.prepare('SELECT sample_interval_ms FROM data_points WHERE id=?').get(id).sample_interval_ms,100);
  const invalid=await f.request('/api/devices/'+f.cartId+'/movement','PUT',{movement:{...movement,arrivalPositionPointId:f.points.start}});
  assert.equal(invalid.status,400);assert.deepEqual(JSON.parse(f.sql.prepare('SELECT instance_config FROM devices WHERE id=?').get(f.cartId).instance_config),saved);checks++;
 } finally {await f.close();}
 console.log('PASS independent arrival: '+checks+' checks');
})().catch(e=>{console.error(e);process.exitCode=1;});
