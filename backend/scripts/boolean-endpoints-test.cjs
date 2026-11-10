'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http'), WebSocket = require('ws');
const { BACKEND_DIR, createRunDirectory, createTestDatabase, findFreePort, startLoggedProcess, waitForHttp, testFetch, forceStop, waitUntil } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('boolean-endpoints');
let backend, socket, resolver, httpServer, closeDb;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
async function idle(instance) {
    for (let attempt = 0; attempt < 500; attempt++) { if (!instance.running && !instance.queue.size && !instance.discoveryBusy) return; await pause(10); }
    throw Error('Endpoint resolver did not settle');
}
(async () => {
    const file = path.join(directory,'factory.db'); await createTestDatabase(file);
    Object.assign(process.env,{APP_DATA_DIR:directory,DB_TYPE:'sqlite',SQLITE_FILE:file,DATA_SOURCE_BACKUP_DIR:path.join(directory,'backups')});
    for (const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
    const database = require('../db/database'); closeDb = database.closeDb;
    const db = await database.getDb(), animations = require('../services/deviceAnimations');
    const { endpointFeedbackSample, MotionInputResolver, hasCatalogBindings } = require('../services/motionInputs');
    const line = await db.get('SELECT l.id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1',['factory_default']);
    const modelId = 'boolean_endpoints_model', deviceId = 'boolean_endpoints_cart';
    const parts = [{id:'push',node_name:'push_rod',action:'translate',axis:'z',source_group:'mechanisms',source_key:'push',input_min:0,input_max:1,output_min:0,output_max:2,transition_duration:.2},
        {id:'motor',node_name:'motor',action:'rotate_speed',axis:'y',source_group:'motors',source_key:'run',input_min:0,input_max:1,output_min:0,output_max:1}];
    await db.run('INSERT INTO models (id,name,file_path,metadata,asset_type,placement_level) VALUES (?,?,?,?,?,?)',[modelId,'Endpoint test model','/assets/models/photo_transfer_cart_v6.glb',JSON.stringify({partBindings:parts,marker:'retain-model'}),'model','device']);
    for (const id of [deviceId,'boolean_endpoints_other']) await db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config,plc_enabled) VALUES (?,?,?,?,?,?)',[id,id,line.id,modelId,JSON.stringify({marker:'retain-instance',inspection:{enabled:false}}),0]);
    const pointIds = {};
    for (const [name,tag,type,access,device] of [['extended','DB1.DBX0.0','BOOL','READ',deviceId],['retracted','DB1.DBX0.1','BOOL','READ',deviceId],['extended_alias','DB1.DBX0.0','BOOL','READ',deviceId],['position','DB1.DBD4','REAL','READ',deviceId],['command','DB1.DBX0.2','BOOL','WRITE',deviceId],['foreign','DB1.DBX0.3','BOOL','READ','boolean_endpoints_other']]) {
        const inserted = await db.run('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type) VALUES (?,?,?,?,?,?,?,?)',[device,name,name,tag,type,'mechanisms',name,access]);
        pointIds[name] = String(inserted.lastID || inserted.lastInsertRowid);
    }
    let loaded = await animations.loadDeviceAnimations(db,deviceId,'factory_default');
    const itemFor = name => loaded.catalog.items.find(item => item.binding?.pointId === pointIds[name]);
    assert.ok(itemFor('extended') && itemFor('retracted'));
    const row = {actionId:'part:push',enabled:true,pointId:'',dataItemId:'',trigger:{mode:'endpoints',extended:{dataItemId:itemFor('extended').id},retracted:{dataItemId:itemFor('retracted').id}},inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:.2};
    const validate = (candidate,current=loaded) => animations.validateDeviceAnimations(current,{revision:current.revision,config:{version:1,staleMs:1000,bindings:[candidate]}});
    const config = validate(row), resolved = config.bindings[0];
    assert.equal(resolved.kind,'part'); assert.equal(resolved.mode,'position'); assert.equal(resolved.pointId,''); assert.equal(resolved.dataItemId,'');
    assert.equal(resolved.trigger.extended.pointId,pointIds.extended); assert.ok(resolved.trigger.extended.sourceFingerprint); assert.ok(resolved.trigger.retracted.sourceFingerprint);
    const view = animations.publicDeviceAnimations({...loaded,config});
    assert.deepEqual(view.config.bindings[0].trigger,row.trigger,'public endpoint selection contains no source path/fingerprint injection surface');
    assert.equal(view.dataItems.find(item=>item.id===itemFor('extended').id).endpointReady,true);
    assert.equal(view.dataItems.find(item=>item.id===itemFor('position').id).endpointReady,false);
    const empty = {mode:'endpoints',extended:{dataItemId:''},retracted:{dataItemId:''}};
    assert.deepEqual(validate({...row,enabled:false,trigger:empty}).bindings[0].trigger,empty);
    assert.throws(()=>validate({...row,trigger:empty}),/同时选择/);
    assert.throws(()=>validate({...row,enabled:false,trigger:{...empty,extended:row.trigger.extended}}),/同时选择/);
    assert.throws(()=>validate({...row,pointId:pointIds.extended}),/普通驱动/);
    assert.throws(()=>validate({...row,actionId:'part:motor'}),/连续运行/);
    assert.throws(()=>validate({...row,trigger:{...row.trigger,retracted:row.trigger.extended}}),/不同的数据源/);
    assert.throws(()=>validate({...row,trigger:{...row.trigger,retracted:{dataItemId:itemFor('extended_alias').id}}}),/不同的数据源/,'different point IDs on the same PLC address are not two feedbacks');
    assert.throws(()=>validate({...row,trigger:{...row.trigger,retracted:{dataItemId:itemFor('position').id}}}),/只读开关量/);
    assert.throws(()=>validate({...row,trigger:{...row.trigger,extended:{...row.trigger.extended,sourceFingerprint:'forged'}}}),/数据中心/);
    assert.throws(()=>validate({...row,trigger:{...row.trigger,value:true}}),/无效/);
    const foreignLoaded = await animations.loadDeviceAnimations(db,'boolean_endpoints_other','factory_default');
    const foreignItem = foreignLoaded.catalog.items.find(item=>item.binding?.pointId===pointIds.foreign);
    assert.throws(()=>animations.validateEndpointSource(loaded,foreignItem),/本设备/);
    assert.equal(loaded.catalog.items.some(item=>item.binding?.pointId===pointIds.command),false);

    let now = Date.now();
    const frame = (extended,retracted,stamp=now) => ({furnace_id:deviceId,timestamp:stamp,mechanisms:{extended,retracted},status:{online:true},quality:{mechanisms:{extended:'good',retracted:'good'}},pointMeta:{'mechanisms.extended':{id:pointIds.extended,timestamp:stamp},'mechanisms.retracted':{id:pointIds.retracted,timestamp:stamp}}});
    const input = source => endpointFeedbackSample(resolved,{...loaded,config},source,new Map(),now,now);
    for (const [extended,retracted,stage,value,quality] of [[false,true,'retracted',0,'good'],[false,false,'waiting',null,'good'],[true,false,'extended',1,'good'],[true,true,'conflict',null,'bad']]) {
        const result=input(frame(extended,retracted));assert.equal(result.stage,stage);assert.equal(result.value,value);assert.equal(result.quality,quality);
        assert.equal(result.endpointFeedback.extended.value,extended);assert.equal(result.endpointFeedback.retracted.value,retracted);
    }
    let source=frame(true,false);source.pointMeta['mechanisms.retracted'].timestamp=now-2000;
    let result=input(source);assert.equal(result.stage,'invalid');assert.equal(result.quality,'stale');assert.equal(result.endpointFeedback.extended.timestamp,now);assert.equal(result.endpointFeedback.retracted.timestamp,now-2000);
    source=frame(true,false);delete source.pointMeta['mechanisms.retracted'];assert.equal(input(source).quality,'bad');
    source=frame(true,0);assert.equal(input(source).quality,'bad','numeric 0 cannot stand in for confirmed Boolean false');
    source=frame(true,false);source.status.online=false;assert.equal(input(source).quality,'bad');
    source=frame(true,false);source.pointMeta['mechanisms.extended'].timestamp=now+2000;assert.equal(input(source).quality,'bad');
    source=frame(true,false);source.pointMeta['mechanisms.extended'].id=pointIds.retracted;assert.equal(input(source).quality,'bad');
    result=endpointFeedbackSample({...resolved,trigger:{...resolved.trigger,extended:{...resolved.trigger.extended,sourceFingerprint:'changed'}}},{...loaded,config},frame(true,false),new Map(),now,now);assert.equal(result.quality,'bad');
    result=endpointFeedbackSample({...resolved,enabled:false},{...loaded,config},frame(true,false),new Map(),now,now);assert.equal(result.quality,'bad');
    source=frame(false,true);now+=500;source.timestamp=now;result=input(source);assert.equal(result.timestamp,now-500,'new envelope cannot renew either feedback clock');

    await db.run('UPDATE devices SET instance_config=? WHERE id=?',[JSON.stringify({...loaded.instance,animationBindings:config}),deviceId]);
    const published=[];resolver=new MotionInputResolver({getDb:async()=>db,now:()=>now,reloadMs:60000});resolver.publish=frames=>published.push(...frames);resolver.active=()=>true;
    assert.equal(hasCatalogBindings(config,true),true,'endpoint-only rows are discovered without a top-level dataItemId');
    assert.deepEqual(resolver.decorate([source])[0].motionInputs,{});await idle(resolver);
    result=resolver.decorate([source])[0].motionInputs[row.actionId];assert.equal(result.stage,'retracted');assert.equal(result.value,0);
    assert.ok(published.some(frame=>frame.motionInputOnly&&frame.motionInputs[row.actionId]?.endpointFeedback),'endpoint-only configurations publish motion input refreshes');
    const stamps=[result.endpointFeedback.extended.timestamp,result.endpointFeedback.retracted.timestamp];now+=501;
    result=resolver.decorate([{...source,timestamp:now}])[0].motionInputs[row.actionId];assert.equal(result.quality,'stale');assert.deepEqual([result.endpointFeedback.extended.timestamp,result.endpointFeedback.retracted.timestamp],stamps);
    now=Date.now();source=frame(true,false);result=resolver.decorate([source])[0].motionInputs[row.actionId];assert.equal(result.stage,'extended','fresh confirmed endpoint recovers without a synthetic cycle');

    const sets=require('../services/dataSets'),sources=require('../services/dataSources');let requests=0;
    httpServer=http.createServer((req,res)=>{requests++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({rows:[{id:deviceId,extended:true,retracted:false}]}));});
    await new Promise(resolve=>httpServer.listen(0,'127.0.0.1',resolve));
    const connection=sources.saveDataSource({name:'Endpoint read-only local fixture',sourceType:'http_api',baseUrl:`http://127.0.0.1:${httpServer.address().port}`,enabled:true,authType:'none'},'factory_default');
    const definition=await sets.saveDataSet({name:'Current device endpoint feedbacks',source:'http',connectionId:connection.id,rootPath:'rows',refreshMs:250,request:{method:'GET',path:'/read',parameters:[{name:'id',in:'query',source:'context',key:'deviceId'}]},match:{field:'id',contextKey:'deviceId'},columns:[{name:'extended',path:'extended',type:'boolean'},{name:'retracted',path:'retracted',type:'boolean'},{name:'extended_alias',path:'extended',type:'boolean'}]},'factory_default');
    const global=await sets.saveDataSet({...definition,id:'endpoint_global',revision:'',name:'Global status',request:{method:'GET',path:'/read',parameters:[]},match:null},'factory_default');
    loaded=await animations.loadDeviceAnimations(db,deviceId,'factory_default');
    const datasetItem=name=>loaded.catalog.items.find(item=>item.datasetId===definition.id&&item.binding.datasetField===name);
    const tableRow={...row,trigger:{mode:'endpoints',extended:{dataItemId:datasetItem('extended').id},retracted:{dataItemId:datasetItem('retracted').id}}};
    const tableConfig=validate(tableRow);
    const globalItem=loaded.catalog.items.find(item=>item.datasetId===global.id&&item.binding.datasetField==='extended');
    const tablePublic=animations.publicDeviceAnimations(loaded);assert.equal(tablePublic.dataItems.find(item=>item.id===globalItem.id).motionReady,true,'general existing Boolean-table motion capability is preserved');assert.equal(tablePublic.dataItems.find(item=>item.id===globalItem.id).endpointReady,false,'global status is not this device endpoint');
    assert.throws(()=>validate({...tableRow,trigger:{...tableRow.trigger,extended:{dataItemId:globalItem.id}}}),/当前设备/);
    assert.throws(()=>validate({...tableRow,trigger:{...tableRow.trigger,retracted:{dataItemId:datasetItem('extended_alias').id}}}),/不同的数据源/,'same column path under two labels is not independent feedback');
    await db.run('UPDATE devices SET instance_config=? WHERE id=?',[JSON.stringify({...loaded.instance,animationBindings:tableConfig}),deviceId]);
    // The controlled PLC clock above tests expiry and future samples. Real HTTP
    // reads carry wall-clock fetchedAt, so this phase must use the same clock;
    // freezing it across async setup incorrectly marks good reads as future.
    resolver.now = Date.now;
    resolver.invalidate();resolver.decorate([source]);await idle(resolver);result=resolver.decorate([source])[0].motionInputs[row.actionId];
    assert.equal(result.stage,'extended');assert.equal(result.value,1);assert.equal(typeof result.endpointFeedback.retracted.value,'boolean');assert.ok(requests>=1,'nested endpoint dataset sources are queried, not replaced by catalog preview values');

    const port=await findFreePort(),origin=`http://127.0.0.1:${port}`;
    backend=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...process.env,HOST:'127.0.0.1',PORT:String(port)},logFile:path.join(directory,'backend.log')});await waitForHttp(origin+'/api/health');
    const events=[];socket=new WebSocket(origin.replace('http:','ws:')+'/ws');socket.on('message',raw=>events.push(JSON.parse(String(raw))));await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});socket.send(JSON.stringify({type:'client_hello',role:'unity'}));
    const request=async(url,method='GET',body)=>{const response=await testFetch(origin+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
    const route=`/api/devices/${deviceId}/animations`,before=await request(`/api/devices/${deviceId}`),initial=await request(route);assert.equal(initial.status,200);
    const apiRow={...row,trigger:{mode:'endpoints',extended:{dataItemId:initial.data.dataItems.find(item=>item.binding?.pointId===pointIds.extended).id},retracted:{dataItemId:initial.data.dataItems.find(item=>item.binding?.pointId===pointIds.retracted).id}}};
    const body={revision:initial.data.revision,config:{version:1,staleMs:1000,bindings:[apiRow]}},offset=events.length;
    const saved=await request(route,'PUT',body);assert.equal(saved.status,200,JSON.stringify(saved));assert.equal(saved.data.success,true);assert.deepEqual(saved.data.config.bindings[0].trigger,apiRow.trigger);
    await waitUntil(()=>events.slice(offset).find(event=>event.type==='configuration_changed'&&event.payload.resource==='device-animations'&&event.payload.reloadRequired===true),5000,'endpoint binding save immediately notifies Unity');
    await pause(250);
    const animationEvents=events.slice(offset).filter(event=>event.type==='configuration_changed');
    assert.equal(animationEvents.length,1,'one successful action save emits one committed event, not a second whole-device reload');
    assert.equal(animationEvents[0].payload.resource,'device-animations');assert.equal(animationEvents[0].payload.factoryId,'factory_default');assert.equal(animationEvents[0].payload.deviceId,deviceId);
    const rejectedOffset=events.length;
    assert.equal((await request(route,'PUT',body)).status,409,'stale endpoint save is rejected');
    await pause(250);assert.equal(events.slice(rejectedOffset).filter(event=>event.type==='configuration_changed').length,0,'rejected action binding save cannot broadcast either narrow or whole-device invalidation');
    const after=await request(`/api/devices/${deviceId}`);for(const key of Object.keys(before.data))if(key!=='instance_config')assert.deepEqual(after.data[key],before.data[key]);const instance=JSON.parse(after.data.instance_config);assert.equal(instance.marker,'retain-instance');assert.deepEqual(instance.inspection,{enabled:false});
    const fresh=await request(route);assert.equal(fresh.data.config.bindings[0].trigger.extended.sourceFingerprint,undefined);
    const added={id:'new-live-action',node_name:'new_part',action:'translate',axis:'x',source_group:'mechanisms',source_key:'new_live_action',input_min:0,input_max:1,output_min:0,output_max:.5,speed_factor:1,transition_duration:.2};
    const modelOffset=events.length,modelSaved=await request(`/api/models/${modelId}/bindings`,'PUT',{expectedBindings:parts,partBindings:[...parts,added]});assert.equal(modelSaved.status,200,JSON.stringify(modelSaved));
    await waitUntil(()=>events.slice(modelOffset).find(event=>event.type==='model_metadata_changed'&&event.payload.modelId===modelId),5000,'new component action immediately notifies the existing Unity role socket');
    const newActions=await request(route);assert.ok(newActions.data.actions.find(action=>action.id==='part:new-live-action'),'new action is in current device catalog without restarting backend or websocket');
    assert.deepEqual(newActions.data.config.bindings[0].trigger,apiRow.trigger,'adding another action keeps the existing feedback assignment');
    const checks=['only two existing feedback selections required','strict owned READ BOOL points and typed per-device Boolean tables','same physical PLC address or dataset path aliases rejected','disabled empty pair allowed; partial pair, forged fields and running action rejected','public config hides source fingerprints and preserves source identity','confirmed 0/1 endpoints, both-zero waiting and both-one conflict','bad/missing/stale/wrong-type/future feedback fails closed with independent source clocks','endpoint-only configurations are discovered and nested table sources are read','wrapper timestamps cannot refresh expired actual observations','real API save broadcasts exactly one factory/device-scoped action refresh without a whole-device reload; rejected CAS emits none','geometry, PLC, inspection and peer metadata preserved','new model component action broadcasts to the same Unity-role websocket and immediately appears in catalog'];
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks,directory,pointIds,apiSaveBroadcast:true,apiSaveEvents:animationEvents,rejectedCASBroadcasts:0,newActionBroadcast:true,noPLCWrites:true},null,2));console.log('PASS Boolean endpoints '+directory);
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{socket?.terminate();resolver?.dispose();await forceStop(backend);if(httpServer)await new Promise(resolve=>httpServer.close(resolve));await closeDb?.();});
