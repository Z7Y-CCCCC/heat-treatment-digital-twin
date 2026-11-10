'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createLinkageFixture } = require('./realtime-linkage-fixture.cjs');
const { validateMovementConfig, validateMovementSources } = require('../services/movementConfig');
let fixture;
const checks = [];
const check = (name, details={}) => { checks.push({name,...details});console.log('PASS '+name); };
const clone = value => JSON.parse(JSON.stringify(value));

(async()=>{
    const heldStation={enabled:true,valueMode:'station',stationInputMeaning:'last-confirmed',currentPositionPointId:'436',startActionPointId:'',
        start:{x:0,y:0,z:0},end:{x:10,y:0,z:0},stations:[{value:1,position:{x:0,y:0,z:0}}]};
    for(const settings of [{},{simulationEnabled:false,simulation_enabled:false,smoothingMs:0,smoothing_ms:0}]) {
        const value={...heldStation,...settings},before=clone(value);
        assert.equal(validateMovementConfig(value),value);assert.deepEqual(value,before);
    }
    for(const enabled of [true,false]) for(const patch of [
        {valueMode:'range'},{valueMode:'normalized'},{valueMode:undefined},
        {simulationEnabled:true},{simulation_enabled:true},{simulationEnabled:false,simulation_enabled:true},
        {smoothingMs:1},{smoothing_ms:.5},{smoothingMs:0,smoothing_ms:1}
    ]) assert.throws(()=>validateMovementConfig({...heldStation,enabled,...patch}),error=>error.statusCode===400 && error.code==='MOVEMENT_CONFIG_INVALID');
    for(const stationInputMeaning of ['guessed',null,true,1]) assert.throws(()=>validateMovementConfig({...heldStation,stationInputMeaning}),/工位输入含义/);
    check('last-confirmed validates without coercion or mutation and rejects estimates/transitions in both field spellings');
    for(const old of [
        {...heldStation,stationInputMeaning:undefined,simulationEnabled:true,smoothingMs:500},
        {...heldStation,stationInputMeaning:'current',simulationEnabled:true,smoothingMs:500},
        {...heldStation,stationInputMeaning:'target',simulationEnabled:true,smoothingMs:500},
        {...heldStation,stationInputMeaning:'target',simulationEnabled:false,simulation_enabled:true},
        {...heldStation,stationInputMeaning:'target',enabled:false,simulationEnabled:false},
        {...heldStation,stationInputMeaning:'current',valueMode:'range',simulationEnabled:false},
        {...heldStation,stationInputMeaning:'target',valueMode:'range',simulationEnabled:false}
    ]) {const before=clone(old);assert.equal(validateMovementConfig(old),old);assert.deepEqual(clone(old),before);}
    assert.throws(()=>validateMovementConfig({...heldStation,stationInputMeaning:'target',simulationEnabled:false}),/目标工位是运动命令/);
    check('current, target and absent legacy semantics preserve their existing configuration acceptance');
    const sourceDevice={id:'isolated-cart'},sourcePoints=[{id:'436',device_id:sourceDevice.id,data_type:'WORD',access_type:'READ'},
        {id:'moving-bool',device_id:sourceDevice.id,data_type:'BOOL',access_type:'READ'},
        {id:'603',device_id:sourceDevice.id,data_type:'WORD',access_type:'READ'},
        {id:'moving-real',device_id:sourceDevice.id,data_type:'REAL',access_type:'READ'},
        {id:'moving-string',device_id:sourceDevice.id,data_type:'STRING',access_type:'READ'},
        {id:'moving-write',device_id:sourceDevice.id,data_type:'BOOL',access_type:'WRITE'},
        {id:'foreign-bool',device_id:'another-cart',data_type:'BOOL',access_type:'READ'}];
    const sourceReads=[],sourceDb={async get(query,params){assert.match(query,/^SELECT \* FROM data_points WHERE id=\? AND device_id=\?/);sourceReads.push(params[0]);return sourcePoints.find(point=>point.id===String(params[0])&&point.device_id===params[1]);},
        async all(query,params){assert.match(query,/^SELECT id,line_id,instance_config FROM devices WHERE id<>\?/);assert.deepEqual(params,[sourceDevice.id]);return [];}};
    await validateMovementSources(sourceDb,sourceDevice,heldStation,'isolated-factory',async()=>true);
    assert.deepEqual(sourceReads,['436'],'empty moving feedback must not select or invent a gate');
    await validateMovementSources(sourceDb,sourceDevice,{...heldStation,startActionPointId:'moving-bool'},'isolated-factory',async()=>true);
    for(const startActionPointId of ['603','moving-real','moving-string','moving-write','foreign-bool','missing'])
        await assert.rejects(validateMovementSources(sourceDb,sourceDevice,{...heldStation,startActionPointId},'isolated-factory',async()=>true),error=>error.statusCode===400 && error.code==='MOVEMENT_CONFIG_INVALID');
    for(const stationInputMeaning of [undefined,'current','target'])
        await validateMovementSources(sourceDb,sourceDevice,{...heldStation,stationInputMeaning,startActionPointId:'603'},'isolated-factory',async()=>true);
    check('only last-confirmed requires an optional owned read-only BOOL moving source; old WORD gates stay compatible');
    fixture = await createLinkageFixture();
    const {ok,request,cartId,targetId,foreignId,points,sql,facade,line} = fixture;
    const route = '/api/devices/'+cartId+'/animations', movementRoute='/api/devices/'+cartId+'/movement';
    let loaded = await ok(route), before = await ok('/api/devices/'+cartId);
    const feedAction = loaded.transferCapabilities.actions.find(action=>action.id==='clip:feed');
    assert.ok(feedAction?.driveNodes.length, 'the real feed clip must supply an authored position node');
    assert.equal(loaded.config.transferLink,undefined);assert.ok(!loaded.transferCapabilities.actions.some(action=>action.id==='clip:process_cycle'));
    const feedItem = loaded.dataItems.find(item=>String(item.binding?.pointId)===points.feed);
    const presenceItem = loaded.dataItems.find(item=>String(item.binding?.pointId)===points.presence);
    assert.ok(feedItem?.motionReady && presenceItem?.endpointReady);
    const binding={actionId:'clip:feed',enabled:true,pointId:'',dataItemId:feedItem.id,trigger:{mode:'range'},inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:.1};
    loaded = await ok(route,'PUT',{revision:loaded.revision,config:{version:1,staleMs:3000,bindings:[binding]}});
    assert.equal((await ok(route)).config.transferLink,undefined,'ordinary saves cannot invent a transfer link');
    check('missing transfer stays missing and retired complete cycle is not a transfer option');
    const {defaultTransferLink} = require('../../shared/transferLinkConfig.mjs');
    const transfer={...defaultTransferLink(),enabled:true,actionId:'clip:feed',driveNodeName:feedAction.driveNodes[0],targetMode:'fixed',targetDeviceId:targetId,presenceDataItemId:presenceItem.id,
        materialSize:[.7,.25,.5],materialColor:'#19ACDF',heightToleranceMeters:.04,lateralToleranceMeters:.03,angleToleranceDegrees:4};
    loaded = await ok(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:transfer,diagnosticLogging:true,diagnosticIntervalSeconds:3}});
    const reopened=await ok(route), row=await ok('/api/devices/'+cartId), instance=JSON.parse(row.instance_config);
    assert.deepEqual(reopened.config.transferLink,transfer);assert.equal(reopened.config.diagnosticLogging,true);assert.equal(reopened.config.diagnosticIntervalSeconds,3);
    assert.equal(reopened.config.transferLink.presenceSourceFingerprint,undefined);assert.match(instance.animationBindings.transferLink.presenceSourceFingerprint,/^[a-f0-9]{64}$/);
    assert.deepEqual(instance.marker,'must survive');assert.deepEqual(instance.inspection,{enabled:false});assert.deepEqual(instance.plcMarker,{address:'fixture-only'});
    for(const key of Object.keys(before))if(key!=='instance_config')assert.deepEqual(row[key],before[key]);
    check('real animation PUT/GET round-trip preserves all transfer and diagnostic fields without changing PLC/layout/inspection');
    const targetBefore=await ok('/api/devices/'+targetId);
    const moveTarget={enabled:true,currentPositionPointId:points.targetPosition,valueMode:'range',valueMin:0,valueMax:100,start:{x:1,y:0,z:0},end:{x:2,y:0,z:0}};
    const targetMoving=await request('/api/devices/'+targetId+'/movement','PUT',{movement:moveTarget,expectedMovement:null});
    assert.equal(targetMoving.status,400);assert.match(targetMoving.data.error,/固定目标/);
    assert.deepEqual(await ok('/api/devices/'+targetId),targetBefore,'rejected target role change cannot modify its layout or movement');
    assert.deepEqual((await ok(route)).config,loaded.config);
    check('a fixed handoff target cannot silently become mobile through its separate movement editor');
    for(const [name,patch] of [
        ['foreign fixed target',{targetDeviceId:foreignId}],['unknown fixed target',{targetDeviceId:'missing'}],
        ['unbound action',{actionId:'clip:travel'}],['unknown drive node',{driveNodeName:'guessed_pusher'}],
        ['foreign presence',{presenceDataItemId:'point_'+points.foreign}],['numeric presence',{presenceDataItemId:feedItem.id}],
        ['runtime presence',{presenceDataItemId:'internal_device_status'}],['write presence',{presenceDataItemId:loaded.dataItems.find(item=>String(item.binding?.pointId)===points.write)?.id || 'point_write'}],
        ['invalid size',{materialSize:[0,.2,.3]}],['invalid tolerance',{angleToleranceDegrees:31}],
        ['injected fingerprint',{presenceSourceFingerprint:'forged'}],['missing authored source port',{sourcePort:'guessed'}]
    ]){
        const response=await request(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:{...transfer,...patch}}});
        assert.equal(response.status,400,name+': '+JSON.stringify(response));assert.deepEqual((await ok(route)).config,loaded.config);
    }
    check('foreign/unknown targets, bad nodes, non-BOOL or unowned/write sources and malformed geometry fail atomically');
    assert.equal((await request(route,'PUT',{revision:'old',config:loaded.config})).status,409);
    for(const [table,id,field,change] of [['devices',targetId,'pos_x',.2],['devices',cartId,'rotation_y',15]]){
        const value=sql.prepare(`SELECT ${field} AS value FROM ${table} WHERE id=?`).get(id).value;
        sql.prepare(`UPDATE ${table} SET ${field}=? WHERE id=?`).run(value+change,id);
        const latest=await ok(route);assert.notEqual(latest.revision,loaded.revision);
        assert.equal((await request(route,'PUT',{revision:loaded.revision,config:loaded.config})).status,409);
        assert.deepEqual(latest.config,loaded.config);loaded=latest;
    }
    const oldLayout=sql.prepare('SELECT layout_json FROM `lines` WHERE id=?').get(line.id).layout_json;
    const changedLayout={...(oldLayout?JSON.parse(oldLayout):{}),transform:{x:12,y:0,z:2,rotationY:17}};
    sql.prepare('UPDATE `lines` SET layout_json=? WHERE id=?').run(JSON.stringify(changedLayout),line.id);
    const lineChanged=await ok(route);assert.notEqual(lineChanged.revision,loaded.revision);assert.equal((await request(route,'PUT',{revision:loaded.revision,config:loaded.config})).status,409);loaded=lineChanged;
    check('authoring CAS includes actual source, target and parent-line transforms, not only port names');
    const movement={enabled:true,currentPositionPointId:points.position,startActionPointId:points.start,valueMode:'range',valueMin:0,valueMax:100,smoothingMs:100,staleMs:2500,
        diagnosticLogging:true,diagnosticIntervalSeconds:2,simulationEnabled:false,speedMode:'fixed',maxSpeed:2,acceleration:1,sceneUnitsPerMeter:1.25,
        start:{x:-20,y:0,z:.5},end:{x:-10,y:0,z:.5},stations:[{value:1,position:{x:-21,y:0,z:.5},anchorDeviceId:targetId,distanceMeters:0}]};
    const calibratedLine=(await ok('/api/lines')).find(row=>row.id===line.id);
    await ok('/api/lines/'+line.id,'PUT',{name:calibratedLine.name,workshop_id:calibratedLine.workshop_id,
        layout:{...calibratedLine.layout,sceneUnitsPerMeter:movement.sceneUnitsPerMeter},expectedLayout:calibratedLine.layout});
    await ok(movementRoute,'PUT',{movement,expectedMovement:null});
    assert.deepEqual(JSON.parse((await ok('/api/devices/'+cartId)).instance_config).movement,movement);
    assert.equal((await request(movementRoute,'PUT',{movement,expectedMovement:null})).status,409);
    const current=await ok(route);
    const travel={...binding,actionId:'clip:travel'};
    const conflict=await request(route,'PUT',{revision:current.revision,config:{...current.config,transferLink:{enabled:false},bindings:[travel]}});
    assert.equal(conflict.status,400);assert.match(conflict.data.error,/整个设备|位置控制冲突/);assert.deepEqual((await ok(route)).config,current.config);
    check('saved movement calibration/health settings reopen exactly, and whole-model travel cannot double-control carrier position');
    for(const [name,patch] of [
        ['incomplete endpoint',{end:{x:0,y:0}}],['degenerate rail',{end:{...movement.start}}],['foreign position point',{currentPositionPointId:points.foreign}],
        ['BOOL position point',{currentPositionPointId:points.presence}],['write gate',{startActionPointId:points.write}],
        ['stale threshold',{staleMs:999}],['diagnostic interval',{diagnosticIntervalSeconds:61}],['bad meaning',{stationInputMeaning:'guessed'}],
        ['duplicate stations',{stations:[movement.stations[0],movement.stations[0]]}],['foreign anchor',{stations:[{...movement.stations[0],anchorDeviceId:foreignId}]}],
        ['target without estimation',{valueMode:'station',stationInputMeaning:'target',simulationEnabled:false}]
    ]){
        const response=await request(movementRoute,'PUT',{movement:{...movement,...patch},expectedMovement:movement});
        assert.equal(response.status,400,name+': '+JSON.stringify(response));assert.deepEqual(JSON.parse((await ok('/api/devices/'+cartId)).instance_config).movement,movement);
    }
    check('narrow movement API rejects invalid coordinates, rail/point/anchor identities and unavailable timing without partial writes');
    let stationMovement={...movement,valueMode:'station',stationInputMeaning:'current'};
    await ok(movementRoute,'PUT',{movement:stationMovement,expectedMovement:movement});loaded=await ok(route);
    const stationTransfer={...transfer,targetMode:'station',targetDeviceId:''};
    loaded=await ok(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:stationTransfer}});
    assert.deepEqual((await ok(route)).config.transferLink,stationTransfer);
    assert.equal((await request(movementRoute,'PUT',{movement:{...stationMovement,valueMode:'range'},expectedMovement:stationMovement})).status,400,'a movement edit cannot silently break an enabled station handoff');
    loaded=await ok(route);
    loaded=await ok(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:{...stationTransfer,enabled:false}}});
    const targetMovement={...stationMovement,stationInputMeaning:'target',simulationEnabled:true};
    await ok(movementRoute,'PUT',{movement:targetMovement,expectedMovement:stationMovement});
    assert.equal(JSON.parse((await ok('/api/devices/'+cartId)).instance_config).movement.stationInputMeaning,'target');
    check('current/target meaning and explicit station associations survive real save/reopen without guessing targets');
    const lastConfirmedMovement={...stationMovement,stationInputMeaning:'last-confirmed',startActionPointId:'',simulationEnabled:false,smoothingMs:0};
    const previousInstance=JSON.parse((await ok('/api/devices/'+cartId)).instance_config);
    await ok(movementRoute,'PUT',{movement:lastConfirmedMovement,expectedMovement:targetMovement});
    const savedHeldInstance=JSON.parse((await ok('/api/devices/'+cartId)).instance_config);
    assert.deepEqual(savedHeldInstance,{...previousInstance,movement:lastConfirmedMovement});
    assert.deepEqual(savedHeldInstance.movement.stations,targetMovement.stations);
    assert.equal(savedHeldInstance.movement.startActionPointId,'');
    assert.equal((await request(movementRoute,'PUT',{movement:lastConfirmedMovement,expectedMovement:targetMovement})).status,409);
    for(const patch of [{startActionPointId:points.start},{simulationEnabled:true},{simulation_enabled:true},{smoothingMs:1},{smoothing_ms:1}]) {
        const rejected=await request(movementRoute,'PUT',{movement:{...lastConfirmedMovement,...patch},expectedMovement:lastConfirmedMovement});
        assert.equal(rejected.status,400,JSON.stringify(rejected));
        assert.deepEqual(JSON.parse((await ok('/api/devices/'+cartId)).instance_config),savedHeldInstance);
    }
    const withBoolMoving={...lastConfirmedMovement,startActionPointId:points.presence};
    await ok(movementRoute,'PUT',{movement:withBoolMoving,expectedMovement:lastConfirmedMovement});
    assert.deepEqual(JSON.parse((await ok('/api/devices/'+cartId)).instance_config).movement,withBoolMoving);
    await ok(movementRoute,'PUT',{movement:targetMovement,expectedMovement:withBoolMoving});
    check('last-confirmed narrow PUT/GET preserves station coordinates and unrelated configuration, enforces CAS and rejects false source semantics atomically');
    // Use the real resolver against the same isolated persisted rows. Imports
    // below occur only after isolation, and all DB queries use this facade.
    Object.assign(process.env,{APP_DATA_DIR:fixture.dataDir,DB_TYPE:'sqlite',SQLITE_FILE:fixture.filename,DATA_SOURCE_BACKUP_DIR:path.join(fixture.dataDir,'backups')});
    for(const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME'])delete process.env[key];
    const animations=require('../services/deviceAnimations');
    loaded=await ok(route);loaded=await ok(route,'PUT',{revision:loaded.revision,config:{...loaded.config,transferLink:transfer}});
    const prepared=await animations.loadDeviceAnimations(facade,cartId,'factory_default',{includeTransferTargets:false});
    const {MotionInputResolver}=require('../services/motionInputs');
    const {hasCatalogBindings}=require('../services/motionInputs');
    assert.equal(hasCatalogBindings({bindings:[],transferLink:prepared.config.transferLink},true),true,'presence is discovered even when every action uses a legacy PLC point');
    let now=Date.now();const resolver=new MotionInputResolver({now:()=>now});
    const entry={id:cartId,loaded:prepared,datasets:new Map(),readAt:now};
    const item=prepared.catalog.items.find(item=>item.id===presenceItem.id),key=item.binding.pointKey,field=key.split('.').slice(1).join('.');
    const frame={furnace_id:cartId,timestamp:now,mechanisms:{[field]:true},quality:{mechanisms:{[field]:'good'}},pointMeta:{[key]:{id:points.presence,timestamp:now}},status:{online:true}};
    const sample=resolver.inputs(entry,frame).__transfer_presence;
    assert.equal(sample.value,true);assert.equal(sample.quality,'good');assert.equal(sample.timestamp,now);assert.equal(sample.staleMs,prepared.config.staleMs);
    assert.equal(resolver.inputs(entry,{...frame,mechanisms:{[field]:false}}).__transfer_presence.value,false);
    assert.equal(resolver.inputs(entry,{...frame,mechanisms:{[field]:1}}).__transfer_presence.quality,'bad');
    assert.equal(resolver.inputs(entry,{...frame,pointMeta:{}}).__transfer_presence.quality,'bad');
    assert.equal(resolver.inputs(entry,{...frame,status:{online:false}}).__transfer_presence.quality,'bad');
    now+=prepared.config.staleMs+1;assert.equal(resolver.inputs(entry,{...frame,timestamp:now}).__transfer_presence.quality,'stale');
    now-=prepared.config.staleMs+1;assert.equal(resolver.inputs(entry,{...frame,pointMeta:{[key]:{id:points.presence,timestamp:now+2000}}}).__transfer_presence.quality,'bad');
    const changed={...prepared,config:{...prepared.config,transferLink:{...prepared.config.transferLink,presenceSourceFingerprint:'changed'}}};
    assert.equal(resolver.inputs({...entry,loaded:changed},frame).__transfer_presence.quality,'bad');
    assert.equal(resolver.inputs({...entry,loaded:{...prepared,config:{...prepared.config,transferLink:{enabled:false}}}},frame).__transfer_presence,undefined);
    resolver.dispose();
    check('real presence provider retains BOOL false/true and actual read clocks, rejects stale/offline/future/missing/coerced or changed sources');
    // The opposite ordering of the ownership check is equally important.
    await ok(movementRoute,'PUT',{movement:{...targetMovement,enabled:false},expectedMovement:targetMovement});loaded=await ok(route);
    loaded=await ok(route,'PUT',{revision:loaded.revision,config:{...loaded.config,bindings:[travel],transferLink:{enabled:false}}});
    const opposite=await request(movementRoute,'PUT',{movement,expectedMovement:{...targetMovement,enabled:false}});
    assert.equal(opposite.status,400);assert.match(opposite.data.error,/整个设备|位置控制冲突/);
    check('movement enabled after whole-model travel is also rejected; both save orders enforce single position ownership');
    fs.writeFileSync(path.join(fixture.directory,'result.json'),JSON.stringify({success:true,checks,isolatedHttp:true,actualManagedModels:true,actualPresenceProvider:true,browserOperations:0,liveConfigurationWrites:0},null,2));
    console.log('PASS realtime transfer-link integration '+fixture.directory);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await fixture?.close();});
