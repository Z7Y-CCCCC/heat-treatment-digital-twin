'use strict';
// Fresh owned SQLite + actual admin API + virtual read-only BOOL frames.
// This helper never opens the operator profile or starts a PLC collector.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const Database=require('../backend/node_modules/better-sqlite3');
const {createSmokeSandbox,createSmokeSession}=require('../desktop/scripts/smoke-sandbox.cjs');
const {findFreePort,waitForHttp,requireTestPath}=require('../backend/scripts/integration-test-utils.cjs');
(async()=>{
 const sandbox=await createSmokeSandbox('adaptive-transfer-native');
 const {createAdaptiveTransferFixture}=await import('./adaptive-transfer-fixture.mjs');const fixture=await createAdaptiveTransferFixture({kind:'dual',micro:.5});
 const db=new Database(sandbox.filename),line=db.prepare('SELECT * FROM lines LIMIT 1').get();
 db.prepare('DELETE FROM data_points').run();db.prepare('DELETE FROM devices').run();
 db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
 db.prepare('UPDATE lines SET layout_json=?,name=? WHERE id=?').run(JSON.stringify(fixture.lines[0].layout),'双侧交接 · 隔离原生验收',line.id);
 for(const m of fixture.models)db.prepare('INSERT OR REPLACE INTO models(id,name,file_path,metadata,placement_level,asset_type,default_scale) VALUES(?,?,?,?,?,?,?)').run(m.id,m.name,m.file_path,JSON.stringify(m.metadata),'device','model',m.default_scale);
 const source=fixture.devices[0],targets=fixture.devices.slice(1),points={};
 for(const d of fixture.devices){
  const config={...d.instance_config,railLineId:line.id,laneLineId:line.id,layoutPlaced:true,inspection:{enabled:false}};delete config.animationBindings;delete config.movement;
  db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled,pos_x,pos_y,pos_z,rotation_y,scale,coordinate_space,instance_config) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(d.id,d.name,line.id,d.model_type,0,d.pos_x,d.pos_y,d.pos_z,d.rotation_y,d.scale,'line_local',JSON.stringify(config));
 }
 let serial=0;function point(device,role,type,category){const n=serial++;const id=String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type,quality) VALUES(?,?,?,?,?,?,?,?,?,?)').run(device,role,'虚拟验收 · '+role,type==='BOOL'?`DB1.DBX${10+Math.floor(n/8)}.${n%8}`:`DB1.DBW${n*2}`,type,category,role,100,'READ','good').lastInsertRowid);return {id,category,role,type}}
 points[source.id]=[point(source.id,'target','WORD','analog'),point(source.id,'arrival','WORD','analog'),point(source.id,'moving','BOOL','motors'),point(source.id,'material_present','BOOL','mechanisms'),point(source.id,'cycle_start','BOOL','mechanisms'),point(source.id,'cycle_pickup','BOOL','mechanisms')];
 for(const d of targets)points[d.id]=[point(d.id,'material_present','BOOL','mechanisms'),point(d.id,'door_open','BOOL','mechanisms')];db.close();
 const origin=`http://127.0.0.1:${await findFreePort()}`;
 Object.assign(process.env,sandbox.env,{PORT:new URL(origin).port,HOST:'127.0.0.1',FRONTEND_DIST:process.env.UI_FRONTEND_DIST||path.resolve(__dirname,'../frontend/dist')});
 require('../backend/server.js');await waitForHttp(origin+'/api/health');const session=await createSmokeSession(origin,sandbox);
 const headers={'Content-Type':'application/json',Origin:origin,'X-Admin-Request':'1',Cookie:session.cookie,'X-CSRF-Token':session.csrfToken};
 async function api(route,method='GET',body){const r=await fetch(origin+route,{method,headers,...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});const value=await r.json();if(!r.ok)throw Error(route+' '+JSON.stringify(value));return value}
 const id=(device,role)=>points[device].find(p=>p.role===role).id;
 const movement={...source.instance_config.movement,railLineId:line.id,currentPositionPointId:id(source.id,'target'),arrivalPositionPointId:id(source.id,'arrival'),startActionPointId:id(source.id,'moving'),simulationEnabled:true};
 await api(`/api/devices/${source.id}/movement`,'PUT',{movement,expectedMovement:null});
 const route=`/api/devices/${source.id}/animations`,loaded=await api(route),item=(catalog,pointId)=>{const value=catalog.find(i=>String(i.binding?.pointId)===pointId);if(!value)throw Error('Missing owned data-center point '+pointId);return value.id};
 const transfer=structuredClone(source.instance_config.animationBindings.transferLink);transfer.presenceDataItemId=item(loaded.dataItems,id(source.id,'material_present'));transfer.cycle.startDataItemId=item(loaded.dataItems,id(source.id,'cycle_start'));transfer.cycle.pickupDataItemId=item(loaded.dataItems,id(source.id,'cycle_pickup'));
 transfer.cycle.stations.forEach((s,i)=>s.presencePointId=id(targets[i].id,'material_present'));
 await api(route,'PUT',{revision:loaded.revision,config:{version:1,staleMs:1000,diagnosticLogging:true,bindings:[],transferLink:transfer}});
 for(const d of targets){const r=`/api/devices/${d.id}/animations`,a=await api(r);await api(r,'PUT',{revision:a.revision,config:{version:1,staleMs:1000,bindings:[{enabled:true,actionId:'clip:door',dataItemId:item(a.dataItems,id(d.id,'door_open')),inputMin:0,inputMax:1,invert:false,speed:1,transitionSeconds:.5,trigger:{mode:'condition',operator:'eq',value:true}}]}})}
 const state={station:1,present:true,start:false,pickup:false,targets:targets.map(()=>false),doors:targets.map(()=>true),paused:false,offline:false,changedAt:Date.now()};
 const control=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{try{const body=JSON.parse(raw||'{}');for(const k of ['present','start','pickup','paused','offline']){if(body[k]!==undefined){if(typeof body[k]!=='boolean')throw Error(k+' must be BOOL');state[k]=body[k]}}if(body.station!==undefined){if(![1,2].includes(body.station))throw Error('Invalid owned station');state.station=body.station}for(const k of ['targets','doors'])if(body[k]!==undefined){if(!Array.isArray(body[k])||body[k].length!==2||body[k].some(v=>typeof v!=='boolean'))throw Error(k+' must contain two BOOLs');state[k]=body[k]}state.changedAt=Date.now();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(state))}catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}))}})});
 await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));
 setInterval(()=>{if(state.paused)return;const timestamp=Date.now(),quality=state.offline?'bad':'good';const frames=fixture.devices.map((d,i)=>{
  const values=i===0?{target:state.station,arrival:state.station,moving:false,material_present:state.present,cycle_start:state.start,cycle_pickup:state.pickup}:{material_present:state.targets[i-1],door_open:state.doors[i-1]};
  const f={furnace_id:d.id,timestamp,status:{online:!state.offline,quality},quality:{overall:quality},pointMeta:{}};
  for(const p of points[d.id]){(f[p.category]??={})[p.role]=values[p.role];(f.quality[p.category]??={})[p.role]=quality;f.pointMeta[p.category+'.'+p.role]={id:p.id,category:p.category,field_name:p.role,timestamp}}
  return f
 });global.wsServer?.broadcastDeviceData(frames)},100);
 fs.writeFileSync(requireTestPath(process.env.ADAPTIVE_NATIVE_INFO_FILE),JSON.stringify({origin,control:`http://127.0.0.1:${control.address().port}`,sourceId:source.id,targetIds:targets.map(d=>d.id),directory:sandbox.directory,database:sandbox.filename,session,env:sandbox.env,operatorWrites:0,PLCConnections:0,fixture},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
