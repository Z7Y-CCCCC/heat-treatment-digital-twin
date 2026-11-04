'use strict';
// Timing-only deployment for the saved local demo. No collectors or upstream connections.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const mysql=require('../backend/node_modules/mysql2/promise');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs');
const parse=v=>typeof v==='string'?JSON.parse(v):v;
const jsonText=v=>typeof v==='string'?v:JSON.stringify(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
function sameJson(a,b,message){assert.ok(JSON.stringify(canonical(parse(a)))===JSON.stringify(canonical(parse(b))),message);}
function profile(document,allowed,datasets){const copy=structuredClone(document),changes=[];
 for(const w of copy.widgets || [])if((w.data?.mode==='http_api' && allowed.has(w.data.connectionId)) || (w.data?.mode==='dataset' && datasets.has(w.data.datasetId))){
  if(w.data.refreshMs!==250){changes.push({id:w.id,from:w.data.refreshMs,to:250});w.data.refreshMs=250;}}
 return {document:copy,changes};
}
async function main(){
 const config=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'heat-treatment-digital-twin-desktop/data/database-config.json')));
 assert.equal(config.type,'mysql');assert.equal(config.host,'127.0.0.1');
 const db=await mysql.createConnection({host:config.host,port:config.port,user:config.user,password:config.password,database:config.database});
 const query=async(sql,args=[])=> (await db.query(sql,args))[0];
 try{
  await db.beginTransaction();
  const rollbackAt=process.argv.indexOf('--rollback');
  if(rollbackAt>=0){const b=parse(fs.readFileSync(process.argv[rollbackAt+1],'utf8'));
   const [scene]=await query('SELECT * FROM scenes WHERE id=? FOR UPDATE',[b.scene.id]);
   const [setting]=await query('SELECT value FROM factory_settings WHERE factory_id=? AND `key`=? FOR UPDATE',[b.factoryId,'external_dataset_config']);
   assert.equal(scene.published_release_id,b.applied.releaseId,'Another release is active; refusing rollback');
   sameJson(scene.draft_json,b.applied.draftJson,'Draft changed after deployment; refusing rollback');
   assert.equal(Number(scene.draft_revision),b.applied.draftRevision);sameJson(setting.value,b.applied.settingValue,'Dataset changed after deployment; refusing rollback');
   await query('UPDATE releases SET is_current=0 WHERE project_id=?',[b.scene.project_id]);
   for(const id of b.currentIds)await query('UPDATE releases SET is_current=1 WHERE id=?',[id]);
   await query('UPDATE scenes SET draft_json=?,draft_revision=?,published_release_id=? WHERE id=?',[jsonText(b.scene.draft_json),Number(scene.draft_revision)+1,b.scene.published_release_id,b.scene.id]);
   await query('UPDATE factory_settings SET value=? WHERE factory_id=? AND `key`=?',[jsonText(b.setting.value),b.factoryId,'external_dataset_config']);
   await db.commit();console.log(JSON.stringify({success:true,rollback:true,sceneId:scene.id,draftWidgets:parse(b.scene.draft_json).widgets.length,releaseHistoryPreserved:true}));return;
  }
  const [active]=await query("SELECT value FROM settings WHERE `key`='active_factory_id'");assert.equal(active.value,'factory_pit_furnaces_v1');
  const factoryId=active.value;
  const [scene]=await query('SELECT * FROM scenes WHERE id=? FOR UPDATE',[factoryId+'_scene']);assert.ok(scene);
  const [setting]=await query('SELECT * FROM factory_settings WHERE factory_id=? AND `key`=? FOR UPDATE',[factoryId,'external_dataset_config']);assert.ok(setting);
  const [release]=await query('SELECT * FROM releases WHERE id=? FOR UPDATE',[scene.published_release_id]);assert.ok(release);
  const currents=await query('SELECT id FROM releases WHERE project_id=? AND is_current=1 FOR UPDATE',[scene.project_id]);
  const sources=parse(fs.readFileSync(path.join(process.env.APPDATA,'heat-treatment-digital-twin-desktop/data/data-sources.'+factoryId+'.json'),'utf8'));
  // Only known local file-backed interfaces. Never force a real remote ERP into 4Hz polling.
  const allowed=new Set(sources.connections.filter(c=>c.connector==='file' && c.sourceType==='http_api' && c.enabled!==false).map(c=>c.id));
  const definitions=parse(setting.value),datasetIds=new Set(),definitionChanges=[];
  for(const d of definitions.datasets || [])if(d.source==='http' && allowed.has(d.connectionId)){datasetIds.add(d.id);if(d.refreshMs!==250){definitionChanges.push({id:d.id,from:d.refreshMs,to:250});d.refreshMs=250;d.revision=crypto.randomUUID();}}
  const draft=profile(parse(scene.draft_json),allowed,datasetIds),published=profile(parse(release.snapshot_json),allowed,datasetIds);
  const summary={success:true,factoryId,applied:false,localFileSourcesOnly:true,draftWidgets:draft.document.widgets.length,publishedWidgets:published.document.widgets.length,draftChanges:draft.changes,publishedChanges:published.changes,datasetChanges:definitionChanges};
  if(!process.argv.includes('--apply') || !draft.changes.length && !published.changes.length && !definitionChanges.length){await db.rollback();console.log(JSON.stringify(summary,null,2));return;}
  const rows=await query('SELECT version FROM releases WHERE project_id=?',[scene.project_id]);
  const versions=rows.map(r=>String(r.version).split('.').map(Number)).filter(a=>a.length===3 && a.every(Number.isFinite)).sort((a,b)=>b[0]-a[0]||b[1]-a[1]||b[2]-a[2]);const latest=versions[0] || [1,0,0],version=`${latest[0]}.${latest[1]}.${latest[2]+1}`;
  const releaseId='release_latency_'+Date.now(),draftRevision=Number(scene.draft_revision)+1;
  published.document.metadata={...published.document.metadata,version,publishedAt:new Date().toISOString(),source:'release'};
  const draftJson=JSON.stringify(draft.document),settingValue=JSON.stringify(definitions),directory=createRunDirectory('low-latency-deployment'),backupFile=path.join(directory,'rollback-backup.json');
  // Persist a rollback record BEFORE committing any write. It contains scene data, no passwords.
  fs.writeFileSync(backupFile,JSON.stringify({factoryId,scene,setting,currentIds:currents.map(r=>r.id),applied:{releaseId,draftJson,draftRevision,settingValue}},null,2));
  await query('UPDATE releases SET is_current=0 WHERE project_id=?',[scene.project_id]);
  await query('INSERT INTO releases (id,project_id,scene_id,version,snapshot_json,is_current,notes,schema_version,draft_revision) VALUES (?,?,?,?,?,1,?,?,?)',[releaseId,scene.project_id,scene.id,version,JSON.stringify(published.document),'Timing-only 250ms local interface profile; preserved published layout and independent draft.',release.schema_version,release.draft_revision]);
  await query('UPDATE scenes SET draft_json=?,draft_revision=?,published_release_id=? WHERE id=?',[draftJson,draftRevision,releaseId,scene.id]);
  await query('UPDATE factory_settings SET value=? WHERE factory_id=? AND `key`=?',[settingValue,factoryId,'external_dataset_config']);
  // Read back inside the same transaction before committing.
  const [verify]=await query('SELECT draft_json,published_release_id FROM scenes WHERE id=?',[scene.id]);sameJson(verify.draft_json,draftJson,'Draft readback mismatch');assert.equal(verify.published_release_id,releaseId);
  await db.commit();summary.applied=true;summary.releaseId=releaseId;summary.version=version;summary.backupFile=backupFile;
  fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
 }catch(error){await db.rollback();throw error;}finally{await db.end();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
