// Uses existing, authorized management APIs. No password changes or collector settings.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs');
const {resolveGround,buildGroundMesh}=require('../shared/industrialGround.mjs');
const profile=require('./model-profiles/pit-workshop-cad-layout.json');
const root=path.resolve(__dirname,'..');
async function applyPitCadLayout(origin,token,{factoryId=profile.target.factoryId,workshopId=profile.target.workshopId,lineId=profile.target.lineId}={}){
 const directory=createRunDirectory('pit-cad-layout');
 const headers={'X-Admin-Token':token,'X-Factory-ID':factoryId};
 async function api(route,method='GET',body){
  const response=await fetch(origin+'/api'+route,{method,headers:{...headers,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});
  const data=await response.json();if(!response.ok||data.error)throw new Error(`${method} ${route}: ${response.status} ${data.error||''}`);return data;
 }
 const workshops=await api('/workshops'), workshop=workshops.find(w=>w.id===workshopId);assert.ok(workshop,'target workshop not found');
 const lines=await api('/lines'),line=lines.find(l=>l.id===lineId&&l.workshop_id===workshopId);assert.ok(line,'target line not found');
 const devices=await api('/devices'),models=await api('/models');
 const laneId=line.layout.lanes[0]?.id||'cad_main_axis';
 const before={factoryId,workshop,line,devices:devices.filter(d=>d.line_id===lineId),models:models.filter(m=>m.id.startsWith('pit_cad_')),createdAt:new Date().toISOString()};
 fs.writeFileSync(path.join(directory,'before.json'),JSON.stringify(before,null,2),{mode:0o600});
 const expectedIds=new Set(profile.devices.map(d=>d.id));
 assert.ok(before.devices.every(d=>expectedIds.has(d.id)),'target contains additional devices; inspect the backup before changing its layout');
 // Retain each existing furnace ID/model, PLC connection and point bindings.
 for(const spec of profile.devices.filter(d=>d.id.startsWith('PitFurnace_'))){const old=devices.find(d=>d.id===spec.id);assert.ok(old&&old.line_id===lineId&&old.model_type===spec.model_type,`refusing to replace an unexpected model/line for ${spec.id}`)}
 for(const id of new Set(profile.devices.filter(d=>d.number>=10).map(d=>d.model_type))){
  const folder=path.join(root,'backend/assets/models/pit_workshop_aux_v1'),bytes=fs.readFileSync(path.join(folder,id+'.glb'));
  const sha256=createHash('sha256').update(bytes).digest('hex'),existing=models.find(m=>m.id===id);
  const currentMetadata=typeof existing?.metadata==='string'?JSON.parse(existing.metadata):existing?.metadata||{};
  if(currentMetadata.cadSourceSha256===sha256)continue;
  const asset=JSON.parse(fs.readFileSync(path.join(folder,id+'.json'))),form=new FormData();
  form.set('id',id);form.set('name',asset.name);form.set('placement_level','device');form.set('metadata',JSON.stringify({...asset.metadata,cadSourceSha256:sha256}));form.set('tags',JSON.stringify(['pit_cad','visual_estimate','passive_auxiliary']));form.set('modelFile',new Blob([bytes]),id+'.glb');
  await api('/models/upload','POST',form);
 }
 await api('/workshops/'+workshopId,'PUT',{layout:{...workshop.layout,size:profile.workshopSize}});
 await api('/lines/'+lineId,'PUT',{layout:{...line.layout,transform:{x:0,y:0,z:0,rotationY:0},flowDirection:'none',lanes:[{id:laneId,name:'CAD 设备排布轴线',offsetZ:0,length:60,sort_order:0}],rails:[]}});
 for(const spec of profile.devices){
  const old=devices.find(d=>d.id===spec.id);
  if(old){
   // Geometry-only narrow API preserves every unrelated instance/PLC field.
   await api('/devices/'+spec.id+'/transform','PUT',{pos_x:spec.pos_x,pos_y:spec.pos_y,pos_z:spec.pos_z,rotation_y:spec.rotation_y,scale:1,coordinate_space:'line_local',ground:spec.ground,layoutConfig:{stationNumber:spec.number,laneId,laneLineId:lineId,laneName:'CAD 设备排布轴线',layoutPlaced:true,placementPending:false}});
  }else{
   await api('/devices','POST',{...spec,line_id:lineId,sort_order:spec.number,plc_enabled:0,instance_config:{stationNumber:spec.number,laneId,laneLineId:lineId,laneName:'CAD 设备排布轴线',layoutPlaced:true,placementPending:false,ground:spec.ground,cadReference:{number:spec.number,source:profile.reference,estimated:true},...(spec.number>=10?{role:'auxiliary',workshop_id:workshopId}:{})}});
  }
 }
 const fresh=(await api('/workshops')).find(w=>w.id===workshopId);
 await api('/workshops/'+workshopId+'/ground','PUT',{expectedRevision:fresh.groundRevision,ground:profile.ground});
 const after={factoryId,workshop:(await api('/workshops')).find(w=>w.id===workshopId),line:(await api('/lines')).find(l=>l.id===lineId),devices:(await api('/devices')).filter(d=>d.line_id===lineId)};
 assert.equal(after.devices.length,17,'unexpected additional devices: inspect before removing anything');
 for(const device of after.devices){const config=typeof device.instance_config==='string'?JSON.parse(device.instance_config):device.instance_config;assert.equal(config.laneId,laneId);assert.equal(config.layoutPlaced,true);assert.equal(config.placementPending,false)}
 for(const old of before.devices){
  const saved=after.devices.find(d=>d.id===old.id);
  for(const key of Object.keys(old).filter(k=>k.startsWith('plc_')||['model_type','model_file','template_id','dataPoints'].includes(k)))assert.deepEqual(saved[key],old[key],key+' must survive');
  const a=JSON.parse(typeof old.instance_config==='string'?old.instance_config:JSON.stringify(old.instance_config||{}));
  const b=JSON.parse(typeof saved.instance_config==='string'?saved.instance_config:JSON.stringify(saved.instance_config||{}));for(const key of ['ground','stationNumber','laneId','laneLineId','laneName','layoutPlaced','placementPending']){delete a[key];delete b[key]}assert.deepEqual(b,a,'unrelated instance configuration must survive');
 }
 fs.writeFileSync(path.join(directory,'after.json'),JSON.stringify(after,null,2),{mode:0o600});
 const ground=resolveGround({...after.workshop,lines:[{...after.line,devices:after.devices}]});
 const mesh=buildGroundMesh(ground);fs.writeFileSync(path.join(directory,'ground-mesh.json'),JSON.stringify({ground,mesh}));
 const result={success:true,directory,devices:after.devices.length,groundAreas:ground.areas.length,source:profile.reference,unrelatedPlcAndPointsPreserved:true};
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));return result;
}
module.exports={applyPitCadLayout};
if(require.main===module)applyPitCadLayout(process.env.PIT_CAD_ORIGIN||'http://127.0.0.1:3001',process.env.ADMIN_API_TOKEN).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1});
