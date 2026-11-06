'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { createRunDirectory, createTestDatabase } = require('./integration-test-utils.cjs');
const directory = createRunDirectory('motion-data-center');
let closeDb, httpServer, resolver;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function idle(instance) {
    for (let attempt = 0; attempt < 500; attempt++) {
        if (!instance.running && !instance.queue.size && !instance.discoveryBusy) return;
        await pause(10);
    }
    throw Error('Motion resolver did not settle');
}
(async () => {
    const databaseFile = path.join(directory, 'factory.db'); await createTestDatabase(databaseFile);
    Object.assign(process.env, { APP_DATA_DIR:directory, DB_TYPE:'sqlite', SQLITE_FILE:databaseFile, DATA_SOURCE_BACKUP_DIR:path.join(directory,'backups') });
    for (const key of ['MYSQL_HOST','MYSQL_PORT','MYSQL_USER','MYSQL_PASSWORD','MYSQL_DATABASE','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME']) delete process.env[key];
    const database = require('../db/database'); closeDb = database.closeDb;
    const db = await database.getDb(), animations = require('../services/deviceAnimations');
    const { catalogSample, MotionInputResolver } = require('../services/motionInputs');
    const sets = require('../services/dataSets'), sources = require('../services/dataSources');
    const line = await db.get('SELECT l.id FROM `lines` l JOIN workshops w ON w.id=l.workshop_id WHERE w.factory_id=? LIMIT 1', ['factory_default']);
    const modelId = 'motion_data_model';
    const partBindings = [{id:'motor',node_name:'motor',action:'rotate_speed',source_group:'motors',source_key:'run'},
        {id:'door',node_name:'door',action:'translate',source_group:'doors',source_key:'door'}];
    await db.run('INSERT INTO models (id,name,file_path,metadata,asset_type,placement_level) VALUES (?,?,?,?,?,?)', [modelId,'Motion source fixture','',JSON.stringify({partBindings}),'model','device']);
    for (const id of ['motion_data_one','motion_data_two']) await db.run('INSERT INTO devices (id,name,line_id,model_type,instance_config) VALUES (?,?,?,?,?)', [id,id,line.id,modelId,JSON.stringify({marker:'preserve'})]);
    for (const [device,type,name,group,access] of [['motion_data_one','BOOL','run','motors','READ'],['motion_data_one','REAL','door','doors','READ'],['motion_data_two','BOOL','run','motors','READ'],['motion_data_one','BOOL','write','status','WRITE']])
        await db.run('INSERT INTO data_points (device_id,name,label,plc_tag,data_type,category,value_role,access_type) VALUES (?,?,?,?,?,?,?,?)', [device,name,name,'DB1.DBX0.0',type,group,name,access]);
    let requests = 0, fail = false;
    httpServer = http.createServer((req,res) => {
        requests++;
        if (fail) { res.writeHead(503); res.end('unavailable'); return; }
        const id = new URL(req.url,'http://fixture').searchParams.get('id');
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({data:[{id,phase:'RUN',enabled:true,temperature:0}]}));
    });
    await new Promise(resolve => httpServer.listen(0,'127.0.0.1',resolve));
    const connection = sources.saveDataSource({name:'Actual local HTTP fixture',sourceType:'http_api',baseUrl:`http://127.0.0.1:${httpServer.address().port}`,enabled:true,authType:'none'},'factory_default');
    let definition = await sets.saveDataSet({name:'Actual device phase',source:'http',connectionId:connection.id,rootPath:'data',refreshMs:1000,
        request:{method:'GET',path:'/device',parameters:[{name:'id',in:'query',source:'context',key:'deviceId'}]},match:{field:'id',contextKey:'deviceId'},
        columns:[{name:'phase',path:'phase',type:'string'},{name:'enabled',path:'enabled',type:'boolean'},{name:'temperature',path:'temperature',type:'number'}]},'factory_default');
    const viewDefinition = await sets.saveDataSet({...definition,id:'motion_view_context',revision:'',name:'View-only table fixture',match:{field:'id',contextKey:'viewId'}},'factory_default');
    let loaded = await animations.loadDeviceAnimations(db,'motion_data_one','factory_default');
    const booleanItem = loaded.catalog.items.find(i => i.sourceType === 'plc' && i.pointKey === 'motors.run');
    const numericItem = loaded.catalog.items.find(i => i.sourceType === 'plc' && i.pointKey === 'doors.door');
    const datasetItem = loaded.catalog.items.find(i => i.datasetId === definition.id && i.binding.datasetField === 'phase');
    assert.ok(booleanItem && numericItem && datasetItem);
    assert.equal(loaded.catalog.items.some(i => i.deviceId === 'motion_data_two' || i.label === 'write'), false);
    const row = {actionId:'part:motor',enabled:true,pointId:'',dataItemId:booleanItem.id,trigger:{mode:'condition',operator:'eq',value:true,hysteresis:0},inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:0};
    const validate = (rows, current = loaded) => animations.validateDeviceAnimations(current,{revision:current.revision,config:{version:1,staleMs:5000,bindings:rows}});
    const config = validate([row]); assert.equal(config.bindings[0].pointId,booleanItem.binding.pointId); assert.ok(config.bindings[0].sourceFingerprint);
    assert.equal(config.bindings[0].sourceGroup,'motors'); assert.equal(config.bindings[0].sourceKey,'run');
    const publicConfig = animations.publicDeviceAnimations({...loaded,config});
    assert.equal(publicConfig.config.bindings[0].sourceFingerprint,undefined); assert.equal(publicConfig.config.bindings[0].trigger.value,true);
    assert.equal(publicConfig.dataItems.find(item=>item.id===booleanItem.id).motionReady,true);
    const viewItem = publicConfig.dataItems.find(item=>item.datasetId===viewDefinition.id);
    assert.equal(viewItem.motionReady,false); assert.match(viewItem.motionError,/参数|视角上下文/,'UI capability shares save validation and uses a readable reason');
    assert.throws(()=>validate([{...row,dataItemId:viewItem.id,trigger:{mode:'condition',operator:'eq',value:'RUN'}}]),/参数|视角上下文/);
    assert.deepEqual(animations.validateTrigger({mode:'range'},'number',true),{mode:'range'});
    assert.equal(animations.validateTrigger({mode:'condition',operator:'eq',value:''},'string',true).value,'');
    for (const trigger of [{mode:'range'},{mode:'condition',operator:'eq',value:1},{mode:'condition',operator:'gt',value:true},{mode:'condition',operator:'eq',value:true,hysteresis:1}])
        assert.throws(() => validate([{...row,trigger}]), /范围|类型|数值|回差/);
    for (const patch of [{dataItemId:'point_foreign'},{pointId:'foreign'},{path:'motors.forged'},{sourceFingerprint:'forged'}]) assert.throws(() => validate([{...row,...patch}]), /不存在|不一致|无效/);
    const numericRow = {...row,actionId:'part:door',dataItemId:numericItem.id,trigger:{mode:'condition',operator:'gte',value:30,hysteresis:5}};
    assert.equal(validate([numericRow]).bindings[0].trigger.hysteresis,5);
    assert.throws(() => validate([{...numericRow,trigger:{...numericRow.trigger,hysteresis:-1}}]), /回差/);
    assert.throws(() => validate([row,{...row,actionId:'part:door',dataItemId:'internal_part_name'}]), /不存在|部件资料/);
    const oldPoint = {...row,dataItemId:'',pointId:booleanItem.binding.pointId}; delete oldPoint.trigger;
    assert.equal(validate([oldPoint]).bindings[0].trigger,undefined,'legacy pointId rows remain unchanged');
    const nameRow = {...row,dataItemId:'internal_device_name',trigger:{mode:'condition',operator:'eq',value:'motion_data_one',hysteresis:0}};
    const nameConfig = validate([nameRow]), nameItem = loaded.catalog.items.find(i => i.id === nameRow.dataItemId);
    let now = Date.now(), frame = {furnace_id:'motion_data_one',timestamp:now,motors:{run:true},quality:{motors:{run:'good'}},pointMeta:{'motors.run':{id:booleanItem.binding.pointId,timestamp:now}}};
    let result = catalogSample(config.bindings[0],booleanItem,{...loaded,config},frame,new Map(),now,now);
    assert.equal(result.value,true); assert.equal(result.quality,'good'); assert.equal(result.timestamp,now);
    assert.equal(catalogSample(config.bindings[0],booleanItem,{...loaded,config},{...frame,pointMeta:{}},new Map(),now,now).quality,'bad','missing source timestamp never falls back to frame time');
    assert.equal(catalogSample(config.bindings[0],booleanItem,{...loaded,config},{...frame,motors:{run:1}},new Map(),now,now).quality,'bad','no boolean coercion');
    assert.equal(catalogSample(config.bindings[0],booleanItem,{...loaded,config},{...frame,timestamp:now+10000},new Map(),now+10000,now).quality,'stale','other task/new wrapper cannot refresh this point');
    const PlcReader = require('../services/plcReader'), reader = new PlcReader();
    const pointRows = await db.all('SELECT * FROM data_points WHERE device_id=?',['motion_data_one']);
    const liveRun = reader._assembleDeviceData('motion_data_one',{deviceName:'Actual read fixture',points:[{...pointRows.find(p=>p.name==='run'),tagName:'run_tag'}]},{run_tag:true});
    assert.equal(liveRun.pointMeta['motors.run'].timestamp,liveRun.timestamp,'successful read emits its confirmation timestamp');
    reader._mergeDevicePatch('motion_data_one',liveRun); await pause(5);
    const liveDoor = reader._assembleDeviceData('motion_data_one',{deviceName:'Actual read fixture',points:[{...pointRows.find(p=>p.name==='door'),tagName:'door_tag'}]},{door_tag:0});
    const merged = reader._mergeDevicePatch('motion_data_one',liveDoor);
    assert.ok(merged.timestamp >= liveRun.timestamp); assert.equal(merged.pointMeta['motors.run'].timestamp,liveRun.timestamp,'another PLC task cannot rewrite last successful read time');
    assert.equal(merged.pointMeta['doors.door'].timestamp,liveDoor.timestamp);
    result = catalogSample(nameConfig.bindings[0],{...nameItem,previewValue:'wrong sample'},{...loaded,config:nameConfig},frame,new Map(),now,now);
    assert.equal(result.value,'motion_data_one','owned DB row not previewValue');
    const statusRow = {...row,dataItemId:'internal_device_status',trigger:{mode:'condition',operator:'eq',value:'数据异常 / 未连接',hysteresis:0}};
    const statusConfig = validate([statusRow]), statusItem = loaded.catalog.items.find(i => i.id === statusRow.dataItemId);
    result = catalogSample(statusConfig.bindings[0],statusItem,{...loaded,config:statusConfig},{...frame,quality:'good'},new Map(),now,now);
    assert.equal(result.quality,'good'); assert.equal(result.value,'数据正常');
    result = catalogSample(statusConfig.bindings[0],statusItem,{...loaded,config:statusConfig},{...frame,status:{online:false}},new Map(),now,now);
    assert.equal(result.quality,'good'); assert.equal(result.value,'数据异常 / 未连接','confirmed offline status can trigger indicator');
    assert.equal(catalogSample(statusConfig.bindings[0],statusItem,{...loaded,config:statusConfig},frame,new Map(),now+10000,now).quality,'stale');
    const datasetRow = {...row,dataItemId:datasetItem.id,trigger:{mode:'condition',operator:'eq',value:'RUN',hysteresis:0}};
    const datasetConfig = validate([datasetRow]);
    await db.run('UPDATE devices SET instance_config=? WHERE id=?',[JSON.stringify({...loaded.instance,animationBindings:datasetConfig}),'motion_data_one']);
    loaded = await animations.loadDeviceAnimations(db,'motion_data_one','factory_default');
    const published = [];
    resolver = new MotionInputResolver({getDb:async()=>db,reloadMs:60000}); resolver.publish = frames => published.push(...frames); resolver.active = () => true;
    assert.deepEqual(resolver.decorate([frame])[0].motionInputs,{},'cold catalog never exposes samples as live');
    await idle(resolver);
    let live = resolver.decorate([frame])[0].motionInputs['part:motor'];
    assert.equal(live.value,'RUN'); assert.equal(live.quality,'good'); assert.equal(requests,1);
    const fetchedAt = live.timestamp;
    const actualDefinitionResult = await sets.readDefinition(definition,{deviceId:'motion_data_one'},'factory_default');
    for (const [field,expected] of [['enabled',true],['temperature',0]]) {
        const item = loaded.catalog.items.find(item=>item.datasetId===definition.id && item.binding.datasetField===field);
        const testRow = {...row,actionId:'part:door',dataItemId:item.id,trigger:typeof expected==='boolean'?{mode:'condition',operator:'eq',value:true,hysteresis:0}:{mode:'range'}};
        const testConfig = validate([testRow],loaded), actual = sets.bindingResult(actualDefinitionResult,item.binding);
        const samples = new Map([[item.id,{value:actual.value,quality:actual.quality,timestamp:Date.parse(actual.fetchedAt),fingerprint:animations.sourceFingerprint(item)}]]);
        const input = catalogSample(testConfig.bindings[0],item,{...loaded,config:testConfig},frame,samples,Date.now(),Date.now());
        assert.equal(input.value,expected); assert.equal(input.quality,'good','real typed HTTP fields retain booleans and numeric zero');
    }
    assert.ok(published.some(f => f.motionInputOnly && f.motionInputs['part:motor'].value === 'RUN'),'real external data publishes without PLC frames');
    assert.equal(resolver.decorate([{...frame,timestamp:Date.now()}])[0].motionInputs['part:motor'].timestamp,fetchedAt,'broadcasts retain actual query time');
    const cached = await sets.readDefinition(definition,{deviceId:'motion_data_one'},'factory_default'); assert.equal(Date.parse(cached.fetchedAt),fetchedAt); assert.equal(requests,1);
    resolver.entries.get('motion_data_one').datasets.get(datasetItem.id).nextReadAt = 0; fail = true;
    await pause(1050); resolver.scheduleDatasets(resolver.entries.get('motion_data_one')); await idle(resolver);
    live = resolver.decorate([frame])[0].motionInputs['part:motor']; assert.equal(live.quality,'bad'); assert.equal(live.value,null); assert.equal(live.timestamp,fetchedAt,'error does not fabricate a successful source clock');
    const before = loaded.revision;
    definition = await sets.saveDataSet({...definition,name:'Updated actual phase'},'factory_default');
    const reloaded = await animations.loadDeviceAnimations(db,'motion_data_one','factory_default'); assert.notEqual(reloaded.revision,before);
    assert.throws(() => animations.validateDeviceAnimations(reloaded,{revision:before,config:datasetConfig}), error => error.statusCode === 409);
    const changedItem = reloaded.catalog.items.find(i => i.id === datasetItem.id);
    assert.equal(catalogSample(datasetConfig.bindings[0],changedItem,reloaded,frame,new Map(),Date.now(),Date.now()).quality,'bad','changed definition cannot silently reuse an approved source fingerprint');
    sources.saveDataSource({...connection,enabled:false},'factory_default');
    const disabled = await animations.loadDeviceAnimations(db,'motion_data_one','factory_default');
    assert.throws(() => validate([datasetRow],disabled), /停用|来源/);
    await assert.rejects(() => animations.loadDeviceAnimations(db,'motion_data_one','unknown_factory'), /不属于/);
    const checks = ['prepared catalog and owned read points only','strict number/boolean/string conditions and hysteresis','range remains numeric, legacy point rows compatible',
        'point ID and source path forgery rejected','CAS includes dataset definition changes','per-point actual timestamps survive merged frames',
        'missing/expired/type-invalid readings fail closed','owned DB metadata ignores sample previews','dynamic status supports observed offline without fabricated freshness',
        'real HTTP per-device query drives motion-only frames','query cache retains timestamp and zero/string/boolean types','HTTP failure closes action without refreshing source clock',
        'disabled source and foreign factory rejected'];
    fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({success:true,checks},null,2)); console.log('PASS motion data-center '+directory);
})().catch(error => {console.error(error);process.exitCode=1;}).finally(async () => {resolver?.dispose();if (httpServer) await new Promise(resolve=>httpServer.close(resolve));await closeDb?.();});
