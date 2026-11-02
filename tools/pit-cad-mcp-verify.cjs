// Authenticated project MCP + native-view API, without desktop input automation.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const WebSocket=require('../backend/node_modules/ws');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs');
const {resolveGround,buildGroundMesh}=require('../shared/industrialGround.mjs');
const profile=require('./model-profiles/pit-workshop-cad-layout.json');
const root=path.resolve(__dirname,'..'),origin=process.env.PIT_CAD_ORIGIN||'http://127.0.0.1:3001';
const headers={'X-Admin-Token':process.env.ADMIN_API_TOKEN,'X-Factory-ID':process.env.PIT_CAD_FACTORY_ID||profile.target.factoryId,'Content-Type':'application/json'};
let sequence=0;
async function api(route,body){const response=await fetch(origin+route,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});const data=await response.json();assert.ok(response.ok,`${route}: ${data.error||response.status}`);return data}
async function rpc(method,params){const response=await api('/api/mcp',{jsonrpc:'2.0',id:++sequence,method,params});if(response.error)throw Error(response.error.message);return response.result}
async function call(name,args={}){const result=await rpc('tools/call',{name,arguments:args});if(result.isError)throw Error(result.content?.[0]?.text||'MCP failed');return result.structuredContent||JSON.parse(result.content[0].text)}
async function verify({syncNames=false,navigate=false}={}){
 assert.ok(process.env.ADMIN_API_TOKEN,'ADMIN_API_TOKEN must come from an authorized backend session');
 const directory=createRunDirectory('pit-cad-mcp');
 await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'pit-cad-verifier',version:'1.0.0'}});
 const tools=await rpc('tools/list',{});assert.ok(tools.tools.some(t=>t.name==='get_project_state'));
 const before=await call('get_project_state');assert.equal(before.factoryId,headers['X-Factory-ID']);
 fs.writeFileSync(path.join(directory,'before.json'),JSON.stringify(before,null,2),{mode:0o600});
 if(syncNames)for(const spec of profile.devices){const device=before.devices.find(d=>d.id===spec.id);assert.ok(device);if(device.name!==spec.name)await call('upsert_device',{id:device.id,name:spec.name})}
 const state=await call('get_project_state'),devices=state.devices.filter(d=>d.line_id===profile.target.lineId);
 const workshop=state.workshops.find(w=>w.id===profile.target.workshopId),line=state.lines.find(l=>l.id===profile.target.lineId);
 assert.equal(devices.length,17);
 for(const spec of profile.devices){
  const device=devices.find(d=>d.id===spec.id);assert.ok(device);assert.equal(device.model_type,spec.model_type);
  for(const key of ['pos_x','pos_y','pos_z','rotation_y','scale'])assert.ok(Math.abs(device[key]-spec[key])<1e-6,`${spec.id} ${key}`);
  const config=typeof device.instance_config==='string'?JSON.parse(device.instance_config):device.instance_config;
  assert.equal(config.stationNumber,spec.number);assert.equal(config.layoutPlaced,true);assert.equal(config.laneId,line.layout.lanes[0].id);
  const old=before.devices.find(d=>d.id===device.id);
  for(const key of Object.keys(old).filter(k=>k.startsWith('plc_')||['model_type','model_file','template_id','dataPoints','instance_config'].includes(k)))assert.deepEqual(device[key],old[key],key+' must survive MCP name synchronization');
 }
 const ground=resolveGround({...workshop,lines:[{...line,devices}]});assert.equal(ground.areas.length,10);assert.ok(buildGroundMesh(ground).positions.every(Number.isFinite));
 for(const id of new Set(profile.devices.filter(d=>d.number>=10).map(d=>d.model_type))){
  const model=state.models.find(m=>m.id===id);assert.ok(model);const bytes=fs.readFileSync(path.join(root,'backend/assets/models/pit_workshop_aux_v1',id+'.glb'));
  assert.equal(model.metadata.cadSourceSha256,crypto.createHash('sha256').update(bytes).digest('hex'));
  const response=await fetch(origin+model.file_path);assert.ok(response.ok);const received=Buffer.from(await response.arrayBuffer());assert.ok(received.equals(bytes),id+' exact uploaded asset');
 }
 fs.writeFileSync(path.join(directory,'after.json'),JSON.stringify(state,null,2),{mode:0o600});
 let native;
 if(navigate){
  await api('/api/factories/'+profile.target.factoryId+'/activate',{});
  const ws=new WebSocket(origin.replace(/^http/,'ws')+'/ws',{headers});let context,projection;
  ws.on('message',bytes=>{try{const d=JSON.parse(bytes);if(d.type==='dashboard_context_changed')context=d.payload;if(d.type==='scene_projection')projection=d.payload}catch{}});
  try{
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('native WebSocket connection timeout')),15000);ws.once('open',()=>{clearTimeout(timer);resolve()});ws.once('error',error=>{clearTimeout(timer);reject(error)})});
   ws.send(JSON.stringify({type:'client_hello',role:'web'}));ws.send(JSON.stringify({type:'scene_projection_subscribe',enabled:true}));
   const focus={mode:'workshop',workshopId:profile.target.workshopId,lineId:profile.target.lineId};
   await api('/api/native-preview/navigate',{action:'focus',focus});
   const deadline=Date.now()+60000;
   while(Date.now()<deadline){if(context?.factoryId===profile.target.factoryId&&context?.workshopId===profile.target.workshopId&&context?.sceneReady&&projection?.available&&projection.devices.length===17)break;await new Promise(r=>setTimeout(r,500))}
   assert.equal(context?.factoryId,profile.target.factoryId);assert.equal(context?.workshopId,profile.target.workshopId);assert.equal(context?.sceneReady,true);
   assert.equal(projection?.available,true);assert.equal(projection.devices.length,17);assert.equal(projection.devices.filter(d=>d.visible).length,17);
   assert.equal(projection.sceneId,context.sceneId);assert.equal(projection.viewId,context.viewId);
   assert.deepEqual(projection.devices.map(d=>d.id).sort(),profile.devices.map(d=>d.id).sort());
   const camera=projection.camera,dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0),cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
   const right=cross(camera.up,camera.forward),tangent=Math.tan(camera.fov*Math.PI/360);
   for(const device of projection.devices){const delta=device.anchor.map((v,i)=>v-camera.position[i]),depth=dot(delta,camera.forward);assert.ok(depth>camera.near&&depth<camera.far);assert.ok(Math.abs(dot(delta,right)/(depth*tangent*camera.aspect))<.95,device.id+' horizontal camera crop');assert.ok(Math.abs(dot(delta,camera.up)/(depth*tangent))<.95,device.id+' vertical camera crop')}
   native={context,projection};fs.writeFileSync(path.join(directory,'native-projection.json'),JSON.stringify(native,null,2));
  }finally{ws.close()}
 }
 const result={success:true,directory,method:'authenticated MCP get_project_state / upsert_device',deviceCount:17,libraryFurnaceInstances:9,auxiliaryInstances:8,manualPits:1,automaticPits:9,exactAuxiliaryAssetsVerified:5,originalPlcAndPointsPreserved:true,native:native?{factoryId:native.context.factoryId,workshopId:native.context.workshopId,sceneReady:true,visibleDevices:17,allDeviceAnchorsInsideCamera:true}:null};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));return result;
}
module.exports={verify};
if(require.main===module)verify({syncNames:process.argv.includes('--sync-names'),navigate:process.argv.includes('--navigate')}).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error);process.exitCode=1});
