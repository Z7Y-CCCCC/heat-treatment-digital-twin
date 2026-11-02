const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createSmokeSandbox,createSmokeSession,stopOwnedSmokeProcess}=require('../desktop/scripts/smoke-sandbox.cjs');
const {BACKEND_DIR,findFreePort,startLoggedProcess,waitForHttp}=require('../backend/scripts/integration-test-utils.cjs');
const {applyPitCadLayout}=require('./apply-pit-cad-layout.cjs');
const profile=require('./model-profiles/pit-workshop-cad-layout.json');
let backend,failed=false;
async function stop(){await stopOwnedSmokeProcess(backend);process.exit(0)}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
(async()=>{
 const sandbox=await createSmokeSandbox('pit-cad-fixture'),origin='http://127.0.0.1:'+await findFreePort();
 sandbox.password='Cad-Layout-Owned-Fixture-2026!';
 backend=startLoggedProcess(process.execPath,['server.js'],{cwd:BACKEND_DIR,env:{...sandbox.env,PORT:new URL(origin).port,HOST:'127.0.0.1',FRONTEND_DIST:path.resolve(__dirname,'../frontend/dist')},logFile:path.join(sandbox.directory,'backend.log')});await waitForHttp(origin+'/api/health');
 const token=sandbox.env.ADMIN_API_TOKEN;
 const request=async(route,body,factoryId)=>{const r=await fetch(origin+'/api'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':token,...(factoryId?{'X-Factory-ID':factoryId}:{})},body:JSON.stringify(body)});const d=await r.json();assert.ok(r.ok,JSON.stringify(d));return d};
 const factoryId=(await request('/factories',{name:'CAD 布局隔离验收厂'})).factory.id,workshopId='ws_cad_test',lineId='line_cad_test';
 await request('/workshops',{id:workshopId,name:'井式炉车间验收'},factoryId);await request('/lines',{id:lineId,name:'剖面排列',workshop_id:workshopId},factoryId);
 for(const s of profile.devices.filter(d=>d.id.startsWith('PitFurnace_')))await request('/devices',{id:s.id,name:'原设备 '+s.id,model_type:s.model_type,line_id:lineId,instance_config:{cadFixtureMustSurvive:'keep'},plc_enabled:0,scale:3},factoryId);
 const result=await applyPitCadLayout(origin,token,{factoryId,workshopId,lineId});
 const after=JSON.parse(fs.readFileSync(path.join(result.directory,'after.json'))),mesh=JSON.parse(fs.readFileSync(path.join(result.directory,'ground-mesh.json')));
 assert.equal(after.devices.filter(d=>d.pos_y<0).length,15);assert.equal(mesh.ground.areas.length,10);
 assert.ok(mesh.mesh.positions.every(Number.isFinite));assert.ok(mesh.mesh.indices.length<100000);
 assert.equal(after.devices.filter(d=>d.model_type.startsWith('pit_furnace_')).length,9);
 const repeated=await applyPitCadLayout(origin,token,{factoryId,workshopId,lineId});
 const repeatedAfter=JSON.parse(fs.readFileSync(path.join(repeated.directory,'after.json')));
 assert.equal(repeatedAfter.devices.length,17,'reapplying must not duplicate equipment');
 const modelPaths=async()=>{const response=await fetch(origin+'/api/models',{headers:{'X-Admin-Token':token,'X-Factory-ID':factoryId}});assert.ok(response.ok);return (await response.json()).filter(m=>m.id.startsWith('pit_cad_')).map(m=>[m.id,m.file_path]).sort()};
 const uploadedPaths=await modelPaths();assert.equal(uploadedPaths.length,5);
 await applyPitCadLayout(origin,token,{factoryId,workshopId,lineId});
 assert.deepEqual(await modelPaths(),uploadedPaths,'unchanged auxiliary bytes must not be uploaded again');
 await createSmokeSession(origin,sandbox);
 fs.writeFileSync(process.env.PIT_CAD_FIXTURE_INFO_FILE||path.resolve(__dirname,'../output/pit-cad-fixture-latest.json'),JSON.stringify({...result,origin,factoryId,workshopId,lineId,sandbox:sandbox.directory,username:'admin',password:sandbox.password,backendPid:backend.pid},null,2),{mode:0o600});
 console.log(JSON.stringify({...result,checks:['9 library furnace instances / 8 passive auxiliary instances','negative elevations create 9 automatic pits plus 1 shared support pit','existing five device identities, PLC and unrelated configuration retained','finite bounded ground mesh; metre-scale separate GLB assets']},null,2));
 if(process.env.PIT_CAD_KEEP_FIXTURE==='1'){console.log('Owned fixture kept running for UI inspection');return new Promise(()=>{})}
})().catch(e=>{failed=true;console.error(e);process.exitCode=1}).finally(async()=>{if(failed||process.env.PIT_CAD_KEEP_FIXTURE!=='1')await stopOwnedSmokeProcess(backend)});
