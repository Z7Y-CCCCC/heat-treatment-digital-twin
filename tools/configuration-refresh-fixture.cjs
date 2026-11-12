'use strict';
// Literal config + read-only managed CAD assets. No DB, account or PLC access.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {createRunDirectory}=require('../backend/scripts/integration-test-utils.cjs');
const root=path.resolve(__dirname,'..'),directory=createRunDirectory('configuration-refresh');
const registry=require('../shared/motionPackages.json').models;
const ids=['cad_multipurpose_furnace_082000','cad_tempering_furnace_091300'];
const assets=new Map(),stats={configReads:0,assetReads:{},abortedResponses:0};
for(const id of ids)for(const field of ['sourcePath','rigPath','clipPath']){
 const url=registry[id][field],file=path.resolve(root,'backend','.'+url);
 if(!file.startsWith(path.join(root,'backend','assets')+path.sep))throw Error('Asset outside fixture root');
 assets.set(url,{file});
}
const models=ids.map(id=>({id,name:id,file_path:registry[id].sourcePath,default_scale:1,metadata:{sourceAsset:{sha256:registry[id].sourceSha256},optimization:{mode:'off',mergeStatic:false},inspection:{enabled:false}},motion_package:registry[id]}));
const device=(id,model,x)=>({id,name:id,line_id:'line',model_type:model,pos_x:x,pos_y:0,pos_z:0,rotation_y:0,scale:1,coordinate_space:'line_local',instance_config:{},dataPoints:[]});
let config={factoryId:'fixture',settings:{factory_name:'Fixture'},models,platform:{activeScene:{id:'fixture-scene'},document:{scene:{views:[]}}},workshops:[{id:'workshop',name:'Workshop',layout_json:{},devices:[],lines:[{id:'line',name:'Line',layout_json:{},devices:[device('a',ids[0],0),device('a2',ids[0],6),device('b',ids[1],12)]}]}]};
const changed=JSON.parse(fs.readFileSync(assets.get(registry[ids[0]].clipPath).file,'utf8'));
changed.clips[0].label+=' / isolated updated tracks';
const changedBytes=Buffer.from(JSON.stringify(changed));
const changedClip={path:'/assets/motions/configuration-fixture-updated.json',sha256:crypto.createHash('sha256').update(changedBytes).digest('hex')};
assets.set(changedClip.path,{bytes:changedBytes});
let delay=0,failures=0;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value))};
 try{
  if(req.method==='GET'&&url.pathname==='/api/config'){
   ++stats.configReads;const snapshot=JSON.stringify(config),wait=delay,fail=failures>0;if(fail)--failures;
   if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
   if(res.destroyed){++stats.abortedResponses;return}
   if(fail){res.statusCode=500;return json({error:'Isolated transient failure'})}
   res.setHeader('Content-Type','application/json');res.end(snapshot);return;
  }
  if(req.method==='GET'&&url.pathname==='/fixture/stats')return json(stats);
  if(req.method==='POST'&&['/fixture/config','/fixture/behavior'].includes(url.pathname)){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024)throw Error('Fixture payload exceeds limit')}
   const value=JSON.parse(body);
   if(url.pathname==='/fixture/config')config=value;
   else{delay=Math.max(0,Math.min(2000,Number(value.delay)||0));failures=Math.max(0,Math.min(3,Number(value.failures)||0))}
   return json({success:true});
  }
  if(req.method==='POST'&&url.pathname==='/fixture/close'){json({closed:true});server.close(()=>process.exit(0));return}
  if(req.method==='GET'&&assets.has(url.pathname)){
   stats.assetReads[url.pathname]=(stats.assetReads[url.pathname]||0)+1;
   const asset=assets.get(url.pathname),bytes=asset.bytes;
   res.setHeader('Content-Type',url.pathname.endsWith('.glb')?'model/gltf-binary':'application/json');
   res.setHeader('Content-Length',bytes?bytes.length:fs.statSync(asset.file).size);
   if(bytes)res.end(bytes);else fs.createReadStream(asset.file).pipe(res);return;
  }
  res.statusCode=403;json({error:'Not a fixture route'});
 }catch(error){res.statusCode=400;json({error:error.message})}
});
server.listen(0,'127.0.0.1',()=>{
 const info={origin:'http://127.0.0.1:'+server.address().port,directory,config,changedClip,pid:process.pid};
 const file=path.join(directory,'fixture-info.json');fs.writeFileSync(file,JSON.stringify(info,null,2));
 fs.writeFileSync(path.join(root,'output','configuration-refresh-current.txt'),file);
 console.log(JSON.stringify({file,origin:info.origin,pid:process.pid}));
});
