'use strict';
// Pure snapshot tests. Never instantiate/start an engine or open a PLC/socket.
const assert=require('node:assert/strict');
const DataEngine=require('../services/dataEngine');
const {normalizeDocument}=require('../utils/dashboardDocument');
const {validatePlcBindings}=require('../services/dashboardDocuments');
const {upgradeWidgetPlaybackDocument}=require('../../shared/widgetPlaybackProfile.mjs');
(async()=>{
 const point={id:1,device_id:'d',name:'temp',value_role:'actual_temp',category:'analog',sample_interval_ms:1000,access_type:'READ'};
 // Keep the real snapshot helpers without constructing or starting an engine.
 const engine=Object.assign(Object.create(DataEngine.prototype),{currentMode:'simulation',deviceSnapshots:new Map([['d',{timestamp:Date.now(),status:{online:true},analog:{actual_temp:0}}]])});
 const read=()=>DataEngine.prototype.getPointRuntimeValues.call(engine,'d',[point]);
 assert.equal(read().sourceMode,'simulation');assert.equal(read().points[0].value,0);assert.equal(read().points[0].quality,'good');
 engine.deviceSnapshots.get('d').timestamp=Date.now()-10000;assert.equal(read().points[0].quality,'stale');
 engine.deviceSnapshots.get('d').status.online=false;assert.equal(read().points[0].quality,'bad');
 assert.equal(DataEngine.prototype.getPointRuntimeValues.call(engine,'other',[point]).points[0].value,null);
 engine.plcReader={getPointRuntimeValues:()=>({points:[{...point,value:852.4,quality:'good'}]})};engine.currentMode='integrated_plc';assert.equal(read().sourceMode,'integrated_plc');assert.equal(read().points[0].value,852.4);
 const migrated=upgradeWidgetPlaybackDocument({widgets:[{id:'t',type:'hud_chart_dock',data:{mode:'runtime',path:'device.analog.actual_temp'},content:{}}]});
 assert.equal(migrated.widgets[0].data.mode,'plc');assert.equal(migrated.widgets[0].data.requireConfiguredPoint,true);
 const normalized=normalizeDocument(migrated);assert.equal(normalized.widgets[0].data.requireConfiguredPoint,true);
 await validatePlcBindings({all:async()=>[],get:async()=>null},normalized); // explicitly blank stays blank, not an invented point
 normalized.widgets[0].data.pointId='missing';await assert.rejects(validatePlcBindings({all:async()=>[],get:async()=>null},normalized),/点位不存在/);
 console.log('PASS source mode / actual snapshots / zero / stale / isolation / PLC delegation / safe legacy migration');
})().catch(error=>{console.error(error);process.exitCode=1});
