'use strict';
// Local, self-owned endpoint observations. No collector, PLC, or site database.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const Database = require('../backend/node_modules/better-sqlite3');
const { createSmokeSandbox, createSmokeSession } = require('../desktop/scripts/smoke-sandbox.cjs');
const { findFreePort, waitForHttp, requireTestPath } = require('../backend/scripts/integration-test-utils.cjs');
(async () => {
    const sandbox = await createSmokeSandbox('boolean-endpoints-ui'); sandbox.password = 'BooleanEndpoints-Isolated-20261106!';
    const db = new Database(sandbox.filename), line = db.prepare('SELECT id FROM lines LIMIT 1').get().id;
    db.prepare('DELETE FROM data_points').run(); db.prepare('DELETE FROM devices').run();
    db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run(); db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
    const modelId = 'cad_transfer_cart_101300', deviceId = 'endpoint_cart';
    db.prepare('INSERT OR REPLACE INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)').run(modelId,'轨道小车 · 两点联动验收','/assets/models/cad_transfer_cart_101300.glb',JSON.stringify({inspection:{enabled:false},partBindings:[],runtime:{enableGenericBindings:false},preserve:'boolean-endpoints-fixture'}),'device','model');
    db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,pos_x,pos_y,pos_z,rotation_y,scale,coordinate_space,instance_config) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(deviceId,'轨道小车 · 两点联动验收',line,modelId,0,0,0,0,0,1,'line_local',JSON.stringify({caption:'轨道小车 · 两点联动验收',inspection:{enabled:false},animationProfile:'static',layoutPlaced:true}));
    db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,pos_x,pos_y,pos_z,rotation_y,scale,coordinate_space,instance_config) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('endpoint_furnace','多用炉 · 联动示意背景',line,'photo_multipurpose_furnace_v6',0,4,0,0,90,1,'line_local',JSON.stringify({caption:'多用炉 · 联动示意背景',inspection:{enabled:false},animationProfile:'static',layoutPlaced:true}));
    const insert = db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const extendedPointId = String(insert.run(deviceId,'feed_extended','推料到位','DB1.DBX0.0','BOOL','mechanisms','feed_extended',100,'READ','good').lastInsertRowid);
    const retractedPointId = String(insert.run(deviceId,'feed_retracted','退回到位','DB1.DBX0.1','BOOL','mechanisms','feed_retracted',100,'READ','good').lastInsertRowid);
    db.close();
    const port = await findFreePort(), origin = `http://127.0.0.1:${port}`;
    Object.assign(process.env,sandbox.env,{PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:process.env.UI_FRONTEND_DIST || path.resolve(__dirname,'../frontend/dist')});
    require('../backend/server.js'); await waitForHttp(origin+'/api/health'); const session = await createSmokeSession(origin,sandbox);
    let extended = false, retracted = true, offline = false, paused = false, retractedSkewMs = 0, changedAt = Date.now();
    const control = http.createServer((req,res) => { let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{try{
        const body=JSON.parse(raw||'{}');
        for(const name of ['extended','retracted','offline','paused']) if(body[name]!==undefined && typeof body[name]!=='boolean') throw Error(name+' must be boolean');
        if(body.extended!==undefined)extended=body.extended;if(body.retracted!==undefined)retracted=body.retracted;if(body.offline!==undefined)offline=body.offline;if(body.paused!==undefined)paused=body.paused;
        if(body.retractedSkewMs!==undefined) { if(!Number.isFinite(body.retractedSkewMs)||body.retractedSkewMs<0||body.retractedSkewMs>30000)throw Error('invalid source skew');retractedSkewMs=body.retractedSkewMs; }
        changedAt=Date.now();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({extended,retracted,offline,paused,retractedSkewMs,changedAt}));
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:error.message}))}}) });
    await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
    setInterval(()=>{if(!paused){const timestamp=Date.now(),quality=offline?'bad':'good';global.wsServer?.broadcastDeviceData([{furnace_id:deviceId,timestamp,status:{online:!offline,quality},quality:{overall:quality,mechanisms:{feed_extended:quality,feed_retracted:quality}},mechanisms:{feed_extended:extended,feed_retracted:retracted},pointMeta:{'mechanisms.feed_extended':{id:extendedPointId,timestamp},'mechanisms.feed_retracted':{id:retractedPointId,timestamp:timestamp-retractedSkewMs}}}])}},100);
    const info={origin,control:`http://127.0.0.1:${control.address().port}`,modelId,deviceId,lineId:line,extendedPointId,retractedPointId,directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,session,env:sandbox.env,displayOnly:true,noCollectorOrPhysicalPlc:true};
    fs.writeFileSync(requireTestPath(process.env.BOOLEAN_ENDPOINTS_INFO_FILE),JSON.stringify(info,null,2));
})().catch(error=>{console.error(error);process.exit(1)});
