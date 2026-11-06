'use strict';
// Self-owned browser fixture: no installed service, physical PLC or collector.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const Database=require('../backend/node_modules/better-sqlite3');
const {createSmokeSandbox,createSmokeSession}=require('../desktop/scripts/smoke-sandbox.cjs');
const {findFreePort,waitForHttp,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
(async()=>{
 const sandbox=await createSmokeSandbox('boolean-endpoints-browser-fixture');sandbox.password='Endpoint-'+crypto.randomBytes(18).toString('hex')+'!';
 const db=new Database(sandbox.filename),line=db.prepare('SELECT l.id,l.name,w.id workshopId,w.name workshopName,w.factory_id factoryId FROM lines l JOIN workshops w ON w.id=l.workshop_id LIMIT 1').get();
 db.prepare('DELETE FROM data_points').run();db.prepare('DELETE FROM devices').run();
 db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
 const modelId='cad_transfer_cart_101300',model=require('../backend/services/builtinModels').getBuiltinModels().find(row=>row.id===modelId);
 if(!model)throw Error('Actual CAD transfer cart fixture unavailable');
 const metadata=JSON.parse(model.metadata);metadata.inspection={...metadata.inspection,enabled:false};
 db.prepare('INSERT OR REPLACE INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)').run(modelId,model.name,model.file_path,JSON.stringify(metadata),'device','model');
 const deviceId='endpoint_cart';
 for(const [id,name,x] of [[deviceId,'送料小车 · 双到位反馈验收',0],['endpoint_peer','同型号小车 · 独立实例',6]])db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,pos_x,pos_y,pos_z,scale,coordinate_space,instance_config) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,name,line.id,modelId,0,x,0,0,1,'line_local',JSON.stringify({inspection:{enabled:false},animationProfile:'static',scaleMultiplier:1,layoutPlaced:true,laneId:'lane_1',laneLineId:line.id}));
 const points={};for(const [name,label,tag] of [['extended','推料到位','DB1.DBX0.0'],['retracted','退回到位','DB1.DBX0.1']])points[name]=String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)').run(deviceId,name,label,tag,'BOOL','mechanisms',name,100,'READ','good').lastInsertRowid);
 db.close();const port=await findFreePort(),origin=`http://127.0.0.1:${port}`;
 Object.assign(process.env,sandbox.env,{PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:process.env.UI_FRONTEND_DIST||path.resolve(__dirname,'../frontend/dist')});
 require('../backend/server.js');await waitForHttp(origin+'/api/health');const session=await createSmokeSession(origin,sandbox);
 let state={extended:false,retracted:true,paused:false,bad:false,extendedAgeMs:0,retractedAgeMs:0};
 const control=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{try{Object.assign(state,JSON.parse(raw||'{}'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state))}catch{res.statusCode=400;res.end()}})});await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
 setInterval(()=>{if(state.paused)return;const timestamp=Date.now(),quality=state.bad?'bad':'good';global.wsServer?.broadcastDeviceData([{furnace_id:deviceId,factory_id:line.factoryId,timestamp,status:{online:!state.bad,quality},quality:{overall:quality,mechanisms:{extended:quality,retracted:quality}},mechanisms:{extended:state.extended,retracted:state.retracted},pointMeta:Object.fromEntries(['extended','retracted'].map(side=>[`mechanisms.${side}`,{id:points[side],timestamp:timestamp-(state[`${side}AgeMs`]||0),quality}]))}])},100).unref();
 const info={origin,control:`http://127.0.0.1:${control.address().port}`,factoryId:line.factoryId,line,modelId,deviceId,peerId:'endpoint_peer',points,node:'cad_transfer_cart_v1_feed_carriage',directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,session};
 fs.writeFileSync(requireTestPath(process.env.ENDPOINT_UI_INFO_FILE),JSON.stringify(info,null,2));
})().catch(error=>{console.error(error);process.exit(1)});
