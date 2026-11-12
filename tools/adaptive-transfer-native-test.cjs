'use strict';
// Actual output-only Unity player consuming real backend WS decorations and
// admin-saved links. Controlled observations are virtual; no site PLC is used.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {requireTestPath,startLoggedProcess,waitUntil}=require('../backend/scripts/integration-test-utils.cjs');
const {authorizeSmokeUnity,stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const root=path.resolve(__dirname,'..'),directory=requireTestPath(path.resolve(process.argv[2]||'output/playwright/adaptive-transfer/final-20261111'));
let helper,unity;const report={success:false,actualPlayer:true,operatorWrites:0,PLCConnections:0,checks:[],scope:'Virtual read-only BOOL -> actual backend admin configuration + WS -> staged Unity player; not site PLC end-to-end acceptance'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));const pass=name=>{report.checks.push(name);console.log('PASS '+name)};
(async()=>{
 const exe=requireTestPath(path.join(directory,'unity-stage','HeatTreatmentDigitalTwin.exe'));assert.ok(fs.existsSync(exe));const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');report.executable=exe;report.exeSha256=hash(exe);
 const infoFile=path.join(directory,'native-server.json');if(fs.existsSync(infoFile))fs.renameSync(infoFile,path.join(directory,'native-server-previous-'+Date.now()+'.json'));
 helper=startLoggedProcess(process.execPath,[path.join(__dirname,'adaptive-transfer-native-server.cjs')],{cwd:root,env:{...process.env,ADAPTIVE_NATIVE_INFO_FILE:infoFile,UI_FRONTEND_DIST:path.join(directory,'frontend-stage')},logFile:path.join(directory,'native-backend.log')});
 await waitUntil(()=>{const log=path.join(directory,'native-backend.log');assert.equal(helper.exitCode,null,fs.existsSync(log)?fs.readFileSync(log,'utf8'):'owned backend exited');return fs.existsSync(infoFile)},60000,'isolated dual transfer backend');
 const info=JSON.parse(fs.readFileSync(infoFile,'utf8'));for(const url of [info.origin,info.control])assert.equal(new URL(url).hostname,'127.0.0.1');requireTestPath(info.database);report.database=info.database;
 const log=path.join(directory,'native-player.log');
 unity=spawn(exe,['-batchmode','-force-d3d11','-screen-fullscreen','0','-screen-width','1400','-screen-height','900','-logFile',log],{cwd:path.dirname(exe),windowsHide:true,stdio:'ignore',env:{...info.env,DIGITAL_TWIN_BACKEND_HTTP_URL:info.origin,DIGITAL_TWIN_BACKEND_WEBSOCKET_URL:info.origin.replace('http:','ws:')+'/ws',DIGITAL_TWIN_ADMIN_URL:info.origin+'/admin',DIGITAL_TWIN_APPLICATION_CHROME:'false',DIGITAL_TWIN_DISABLE_NATIVE_ADMIN_HOST:'1',DEVICE_ANIMATION_DIAGNOSTICS:'1',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',NO_PROXY:'127.0.0.1,localhost'}});
 await authorizeSmokeUnity(info.origin,unity,info.session);
 const readLog=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8'):'';
 const rows=()=>readLog().split(/\r?\n/).flatMap(line=>{const marker='[DeviceTransferCycle] ',n=line.indexOf(marker);if(n<0)return [];try{return [JSON.parse(line.slice(n+marker.length))]}catch{return []}});
 const control=async body=>{const r=await fetch(info.control,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});assert.ok(r.ok);return r.json()};
 async function observe(predicate,label,from=0,timeout=30000){let value;await waitUntil(()=>{assert.equal(unity.exitCode,null,readLog().slice(-4000));value=rows().slice(from).find(predicate);return value},timeout,label,50);return value}
 const initial=await observe(r=>r.deviceId===info.sourceId&&!r.paused&&r.arrivalConfirmed&&r.geometryUsable,'actual saved transfer initialization',0,90000);assert.equal(initial.handoffMode,'mechanism');assert.equal(initial.bridgeMeters,0);pass('compact original-stroke transfer initializes without a long display bridge in the actual GPU player');
 for(const station of [1,2])for(const pickup of [false,true]){
  let from=rows().length;await control({station,start:false,present:!pickup,pickup,targets:info.targetIds.map((_,i)=>i===station-1?pickup:false)});
  await observe(r=>r.targetDeviceId===info.targetIds[station-1]&&!r.paused&&r.sourcePresent===!pickup,'rearm owned station',from);
  from=rows().length;await control({start:true});const extending=await observe(r=>r.phase==='extend'&&!r.paused,'real player extension',from);assert.equal(extending.side,station===1?'opposite':'primary');
  const waiting=await observe(r=>r.phase==='wait'&&!r.paused,'unconfirmed mouth arrival',from);assert.equal(waiting.bothPresenceConfirmed,false);assert.equal(waiting.feed,1);
  await pause(700);const still=rows().at(-1);assert.equal(still.phase,'wait');assert.equal(still.bothPresenceConfirmed,false);
  from=rows().length;await control({present:pickup,targets:info.targetIds.map((_,i)=>i===station-1?!pickup:false)});
  const done=await observe(r=>r.phase==='done'&&!r.paused&&r.bothPresenceConfirmed,'independent BOOL completion',from);assert.equal(done.sourceMaterialVisible,pickup);assert.equal(done.feed,0);report.checks.push(`station ${station} ${pickup?'pickup':'feed'}: extension -> wait -> independent acknowledgement -> done`);
 }
 pass('both sides complete feed and pickup; elapsed time never fabricates ownership acknowledgement');
 let from=rows().length;await control({station:1,start:false,present:true,pickup:false,targets:[false,false]});await observe(r=>!r.paused&&r.targetDeviceId===info.targetIds[0]&&r.sourcePresent,'prepare disconnect',from);
 from=rows().length;await control({start:true});await observe(r=>r.phase==='extend'&&!r.paused,'extend before stale barrier',from);await control({paused:true});
 const stale=await observe(r=>r.paused,'stale observations freeze display',from);assert.notEqual(stale.phase,'done');await pause(700);const frozen=rows().at(-1);assert.equal(frozen.feed,stale.feed);assert.equal(frozen.cargoFraction,stale.cargoFraction);pass('source observation expiry freezes the active native transfer rather than completing it');
 await control({paused:false});await observe(r=>!r.paused,'fresh sources recover the frozen native transfer',rows().length);pass('fresh independent sources recover without replacing the model or restarting the app');
 assert.equal(hash(exe),report.exeSha256);assert.ok(!/NullReferenceException|MissingMethodException|Shader error|\[DeviceTransfer\].*未启用/.test(readLog()),readLog().slice(-4000));report.success=true;report.playerPID=unity.pid;
})().catch(e=>{report.error=e.stack;process.exitCode=1;console.error(e)}).finally(async()=>{await stopOwnedSmokeProcess(unity);await stopOwnedSmokeProcess(helper);fs.writeFileSync(path.join(directory,'staged-native-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({success:report.success,checks:report.checks.length,error:report.error}))});
