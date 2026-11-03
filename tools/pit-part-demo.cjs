'use strict';
// Explicit local configuration operation, not a background simulator. Imported
// samples use the normal file connector/dataset/publish path, no PLC writes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs');
const factoryId='factory_pit_furnaces_v1',sceneId=factoryId+'_scene';
async function configure(root,{apply=false}={}){
 root=path.resolve(root);const data=path.join(root,'data');assert.ok(fs.existsSync(path.join(data,'database-config.json')),'Existing application configuration is required');
 Object.assign(process.env,{APP_DATA_DIR:data,UPLOADS_DIR:path.join(root,'uploads'),DB_BACKUP_DIR:path.join(data,'backups'),DB_RECOVERY_DIR:path.join(data,'recovery'),SITE_BACKUP_DIR:path.join(data,'site-backups'),SITE_IMPORT_DIR:path.join(data,'site-imports'),DATA_SOURCE_BACKUP_DIR:path.join(data,'data-source-backups')});
 const database=require('../backend/db/database');
 try{
  const db=await database.getDb(),docs=require('../backend/services/dashboardDocuments'),sets=require('../backend/services/dataSets'),sources=require('../backend/services/dataSources');
  const state=await docs.loadDesignerState(db,sceneId,factoryId);assert.equal(state.document.metadata?.pitStaticDisplay,1,'Not the generated pit acceptance scene');
  const devices=await db.all('SELECT d.* FROM devices d JOIN `lines` l ON d.line_id=l.id JOIN workshops w ON l.workshop_id=w.id WHERE w.factory_id=?',[factoryId]);assert.equal(devices.length,17);
  const models=new Map(require('../backend/services/builtinModels').getBuiltinModels().map(m=>[m.id,m]));for(const m of await db.all('SELECT * FROM models'))models.set(m.id,m);
  const targets=devices.filter(d=>/^pit_furnace_[1-5]_v1$/.test(d.model_type)).map((d,index)=>{
   const model=models.get(d.model_type),metadata=typeof model.metadata==='string'?JSON.parse(model.metadata):model.metadata,parts=metadata.inspection?.parts || [];assert.ok(parts.length,d.id+' has no inspection catalog');
   const rows=parts.map((p,n)=>({partId:p.id,name:p.name,description:p.description || '',reading:100+index*10+n,unit:'%',state:'运行',hours:80+index*5+n}));
   return {device:d,rows,id:'pit_parts_'+d.id.replace(/[^\w-]/g,'_')};
  });assert.equal(targets.length,9);
  if(!apply)return {success:true,applied:false,devices:9,parts:targets.reduce((n,t)=>n+t.rows.length,0),sceneId};
  const directory=createRunDirectory('pit-part-demo-apply'),sourceFile=path.join(data,`data-sources.${factoryId}.json`),previousSets=await sets.listDataSets(factoryId);
  fs.writeFileSync(path.join(directory,'before.json'),JSON.stringify({scene:state.document,revision:state.revision,release:state.currentRelease,datasets:previousSets},null,2));
  if(fs.existsSync(sourceFile))fs.copyFileSync(sourceFile,path.join(directory,'data-sources.before.json'));
  const document=JSON.parse(JSON.stringify(state.document));document.widgets=document.widgets.filter(w=>w.id!=='pit_playback_part'&&!w.id.startsWith('pit_part_data_'));
  const widgets=[];let count=0;
  for(const target of targets){
   const payload={demo:true,ownedDemoProfile:'pit-component-delivery-v1',deviceId:target.device.id,rows:target.rows};
   let connection=sources.listDataSources(factoryId).connections.find(c=>c.id===target.id);
   if(connection){assert.equal(connection.connector,'file','Refuse to overwrite a real connection');const prior=await sources.readHttpApiBinding({connectionId:connection.id,apiPath:'/',jsonPath:'ownedDemoProfile'},factoryId);assert.equal(prior.value,'pit-component-delivery-v1','Refuse to overwrite an unrelated file');}
   if(!connection){const imported=await require('../backend/services/dataSourceTransports').importDataFile(Buffer.from(JSON.stringify(payload)),target.id+'.json',factoryId);
    const config={id:target.id,name:target.device.name+' · 部件',sourceType:'http_api',connector:'file',baseUrl:imported.asset,healthPath:'/',authType:'none',enabled:true,responseFormat:'json',requestTimeoutMs:3000};
    const tested=await sources.testDataSource(config,factoryId);connection=sources.saveDataSource({...config,healthToken:tested.healthToken},factoryId);
   }
   const id=target.id+'_data',existing=previousSets.find(d=>d.id===id);
   const definition=await sets.saveDataSet({id,revision:existing?.revision,name:target.device.name+' · 部件参数',connectionId:connection.id,source:'http',rootPath:'rows',refreshMs:1000,request:{method:'GET',path:'/',parameters:[]},match:{field:'partId',contextKey:'partId'},columns:[{name:'reading',path:'reading',label:'反馈值',type:'number',role:'value'},...['name','description','unit','state'].map(name=>({name,path:name,label:({name:'部件',description:'说明',unit:'单位',state:'工艺状态'})[name],type:'string'})),{name:'hours',path:'hours',label:'累计时长',type:'number',unit:'h'}]},factoryId);
   const widget={id:'pit_part_data_'+target.device.id,type:'hud_kpi_panel',title:'部件参数',runtimeTarget:'overlay',visible:true,zIndex:25,frame:{x:1536,y:568,width:350,height:390,rotation:0},style:{backgroundOpacity:.22,color:'#e6dff4',borderColor:'#c4afe830',borderRadius:8,fontSize:16},content:{showRing:false,showDeviceLabel:false,eyebrow:'COMPONENT',items:[{label:'部件',path:'dataset.name'},{label:'工艺状态',path:'dataset.state'},{label:'反馈值',path:'dataset.reading',unitPath:'dataset.unit',decimals:1},{label:'累计时长',path:'dataset.hours',unit:' h',decimals:0}]},data:{mode:'dataset',datasetId:id,datasetField:'reading',deviceScope:'current',refreshMs:1000,readOnly:true},visibility:{viewIds:['device_xray','device_exploded','device_part'],viewModes:[],rules:[{source:'context',path:'deviceId',operator:'==',value:target.device.id},{source:'context',path:'partId',operator:'truthy'}],ruleMode:'all'},events:[],conditions:[],animation:{type:'none'}};widgets.push(widget);
   for(const row of target.rows){const result=await sets.readDefinition(definition,{deviceId:target.device.id,partId:row.partId},factoryId);assert.equal(result.quality,'good');assert.equal(result.rows[0].name,row.name);count++;}
  }
  document.widgets.push(...widgets);for(const view of document.scene.views){const st=view.componentState;if(!st)continue;for(const key of ['show','hide'])if(st[key])st[key]=st[key].filter(id=>id!=='pit_playback_part'&&!id.startsWith('pit_part_data_'));if(st.show?.length && ['device_xray','device_exploded','device_part'].includes(view.id))st.show.push(...widgets.map(w=>w.id));}
  document.metadata={...document.metadata,partDemoProfile:1,partDemoOrigin:'owned imported JSON samples; not commissioned PLC or live ERP',partDemoDevices:9,partDemoCount:count};
  const saved=await docs.saveDraft(db,{sceneId,factoryId,document,expectedRevision:state.revision});const released=await docs.publishDraft(db,{sceneId,factoryId,notes:'部件参数接入：沿用正式数据集与工厂隔离；自有样例导出'});
  const result={success:true,applied:true,directory,devices:9,parts:count,revision:saved.revision,releaseId:released.release.id,geometryUnchanged:true,plcUnchanged:true,transport:'owned imported JSON exports',refreshMs:1000};fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));return result;
 }finally{await database.closeDb()}
}
module.exports={configure};
if(require.main===module)configure(process.env.PIT_DEMO_DATA_ROOT || path.join(process.env.APPDATA,'heat-treatment-digital-twin-desktop'),{apply:process.argv.includes('--apply')}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1});
