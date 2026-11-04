'use strict';
// Owned test profile + display-only engine. No collector/PLC/customer data.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const Database=require('../backend/node_modules/better-sqlite3');
const {createSmokeSandbox,createSmokeSession}=require('../desktop/scripts/smoke-sandbox.cjs');
const {findFreePort,waitForHttp,requireTestPath,BACKEND_DIR}=require('../backend/scripts/integration-test-utils.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),sandbox=await createSmokeSandbox('trend-source-ui');sandbox.password='Trend-Source-Isolated-Only!';
 const db=new Database(sandbox.filename),line=db.prepare('SELECT id FROM lines LIMIT 1').get().id;
 db.prepare('DELETE FROM data_points').run();db.prepare('DELETE FROM devices').run();
 db.prepare("UPDATE settings SET value='external' WHERE `key`='data_mode'").run();db.prepare("UPDATE factory_settings SET value='external' WHERE `key`='data_mode'").run();
 const pointIds=[];
 for(const [id,name] of [['temp_a','一号井式炉'],['temp_b','二号井式炉'],['no_points','未配置设备']]){
  db.prepare('INSERT INTO devices(id,name,line_id,model_type,plc_enabled) VALUES(?,?,?,?,?)').run(id,name,line,'pit_furnace_1_v1',0);
  if(id!=='no_points')pointIds.push(String(db.prepare('INSERT INTO data_points(device_id,name,label,plc_tag,data_type,category,value_role,sample_interval_ms,access_type) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'actual_temp','实际炉温','DB1.DBD0','REAL','analog','actual_temp',1000,'READ').lastInsertRowid));
 }
 db.close();
 const {COLLECTOR_FILES}=require('../desktop/scripts/prepare-display-distribution.cjs');
 const serverDir=path.join(sandbox.directory,'resources/backend');fs.mkdirSync(serverDir,{recursive:true});
 for(const name of ['server.js','services','db','routes','utils','middleware'])fs.cpSync(path.join(BACKEND_DIR,name),path.join(serverDir,name),{recursive:true,filter:file=>!COLLECTOR_FILES.includes(path.basename(file))});
 fs.symlinkSync(path.join(BACKEND_DIR,'assets'),path.join(serverDir,'assets'),'junction');fs.symlinkSync(path.join(BACKEND_DIR,'node_modules'),path.join(serverDir,'node_modules'),'junction');
 fs.cpSync(path.join(root,'shared'),path.join(sandbox.directory,'resources/shared'),{recursive:true});fs.copyFileSync(path.join(root,'release-manifest.json'),path.join(sandbox.directory,'resources/release-manifest.json'));fs.writeFileSync(path.join(serverDir,'distribution.json'),'{"collector":false}');
 const origin=`http://127.0.0.1:${await findFreePort()}`;Object.assign(process.env,sandbox.env,{PORT:origin.split(':').at(-1),HOST:'127.0.0.1',FRONTEND_DIST:path.join(root,'frontend/dist')});
 require(path.join(serverDir,'server.js'));await waitForHttp(origin+'/api/health');const session=await createSmokeSession(origin,sandbox);
 let offline=false,paused=false,value=857.3,valueB=720,sequence=0;
 const control=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{try{const b=JSON.parse(raw||'{}');if('value'in b)value=Number(b.value);if('valueB'in b)valueB=Number(b.valueB);if('offline'in b)offline=!!b.offline;if('paused'in b)paused=!!b.paused;res.end(JSON.stringify({value,offline,paused}))}catch{res.statusCode=400;res.end()}})});
 await new Promise(r=>control.listen(0,'127.0.0.1',r));
 setInterval(()=>{
  if(paused)return;sequence++;const now=Date.now();
  const frames=['temp_a','temp_b'].map((id,i)=>({furnace_id:id,timestamp:now,status:{online:!offline},analog:{actual_temp:i?valueB: value},quality:{analog:{actual_temp:offline?'bad':'good'}},pointMeta:{'analog.actual_temp':{id:pointIds[i],lastReadAt:now}}}));
  for(const frame of frames)global.dataEngine.deviceSnapshots.set(frame.furnace_id,frame);
  global.wsServer?.broadcastDeviceData(frames);
 },1000);
 const info={origin,control:`http://127.0.0.1:${control.address().port}`,pointIds,directory:sandbox.directory,username:'admin',password:sandbox.password,session};
 fs.writeFileSync(requireTestPath(process.env.TREND_SOURCE_INFO_FILE),JSON.stringify(info,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
