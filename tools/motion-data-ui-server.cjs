'use strict';
// Owned display-only fixture: no installed service, collector or physical PLC.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const Database=require('../backend/node_modules/better-sqlite3');
const {createSmokeSandbox,createSmokeSession}=require('../desktop/scripts/smoke-sandbox.cjs');
const {findFreePort,waitForHttp,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
(async()=>{
 const sandbox=await createSmokeSandbox('motion-data-ui');sandbox.password='MotionData-'+require('node:crypto').randomBytes(18).toString('hex')+'!';
 const db=new Database(sandbox.filename),line=db.prepare('SELECT l.id,l.name,w.id workshopId,w.name workshopName,w.factory_id factoryId FROM lines l JOIN workshops w ON w.id=l.workshop_id LIMIT 1').get();
 db.prepare('DELETE FROM data_points').run();db.prepare('DELETE FROM devices').run();
 db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
 db.prepare('INSERT INTO factories(id,name,collection_enabled) VALUES(?,?,?)').run('motion_other_factory','联动验收二厂',0);
 const file='/assets/models/cad_fixed_load_table_112200.glb',bin=fs.readFileSync(path.resolve(__dirname,'../backend'+file));
 const gltf=JSON.parse(bin.subarray(20,20+bin.readUInt32LE(12)).toString()),node=gltf.nodes.find(n=>n.name?.endsWith('roller_bed_metal'))?.name;if(!node)throw Error('Fixture lift node missing');
 const modelId='motion_data_fixture',metadata={inspection:{enabled:false},partBindings:[{id:'lift',name:'承料台升降',node_name:node,source_group:'analog',source_key:'stroke',action:'translate',axis:'y',input_min:0,input_max:100,output_min:0,output_max:.4,transition_duration:1}]};
 db.prepare('INSERT INTO models(id,name,file_path,metadata,placement_level,asset_type) VALUES(?,?,?,?,?,?)').run(modelId,'备料台 · 数据动作',file,JSON.stringify(metadata),'device','model');
 db.prepare('INSERT INTO workshops(id,name,factory_id) VALUES(?,?,?)').run('motion_aux_workshop','辅助车间',line.factoryId);
 db.prepare('INSERT INTO lines(id,name,workshop_id) VALUES(?,?,?)').run('motion_aux_line','辅助产线','motion_aux_workshop');
 for(const [id,name,lineId,config] of [['motion_device','备料台 · 数据验收',line.id,{}],['motion_peer','备料台 · 独立实例',line.id,{}],['motion_aux','辅助设备','motion_aux_line',{}],['motion_unassigned','车间直属小车',null,{workshop_id:'motion_aux_workshop'}]])db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,instance_config) VALUES(?,?,?,?,?,?)').run(id,name,lineId,modelId,0,JSON.stringify({inspection:{enabled:false},...config}));
 const points={};for(const [name,label,type,group] of [['stroke','行程反馈','REAL','analog'],['feeding','进料中','BOOL','mechanisms'],['phase','工序状态','STRING','status']])points[name]=String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)').run('motion_device',name,label,'DB1.DBD0',type,group,name,100,'READ','good').lastInsertRowid);
 db.close();const port=await findFreePort(),origin=`http://127.0.0.1:${port}`;
 Object.assign(process.env,sandbox.env,{PORT:String(port),HOST:'127.0.0.1',FRONTEND_DIST:process.env.UI_FRONTEND_DIST||path.resolve(__dirname,'../frontend/dist')});
 require('../backend/server.js');await waitForHttp(origin+'/api/health');const session=await createSmokeSession(origin,sandbox);
 let state={stroke:0,feeding:false,phase:'待机',offline:false,paused:false,pointBad:false,sourceAge:0};
 const control=http.createServer((req,res)=>{if(req.method==='GET'){res.setHeader('Content-Type','application/json');if(state.externalFail){res.statusCode=503;res.end('{"error":"fixture unavailable"}')}else res.end(JSON.stringify({rows:[{deviceId:'motion_device',quantity:state.externalValue??7}]}));return}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{try{Object.assign(state,JSON.parse(raw||'{}'));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state))}catch{res.statusCode=400;res.end()}})});await new Promise(r=>control.listen(0,'127.0.0.1',r));
 setInterval(()=>{if(state.paused)return;const now=Date.now(),q=state.offline||state.pointBad?'bad':'good';global.wsServer?.broadcastDeviceData([{furnace_id:'motion_device',factory_id:line.factoryId,timestamp:now,status:{online:!state.offline,quality:state.offline?'bad':'good'},quality:{overall:state.offline?'bad':'good',analog:{stroke:q},mechanisms:{feeding:q},status:{phase:q}},analog:{stroke:state.stroke},mechanisms:{feeding:state.feeding},statusValues:{phase:state.phase},pointMeta:Object.fromEntries(Object.entries(points).map(([name,id])=>[`${name==='stroke'?'analog':name==='feeding'?'mechanisms':'status'}.${name}`,{id,timestamp:now-state.sourceAge,quality:q}]))}].map(d=>({...d,status:{...d.status,phase:state.phase}})))},100).unref();
 const info={origin,control:`http://127.0.0.1:${control.address().port}`,factoryId:line.factoryId,line,modelId,deviceId:'motion_device',peerId:'motion_peer',points,node,directory:sandbox.directory,database:sandbox.filename,username:'admin',password:sandbox.password,session};
 fs.writeFileSync(requireTestPath(process.env.MOTION_DATA_INFO_FILE),JSON.stringify(info,null,2));
})().catch(error=>{console.error(error);process.exit(1)});
