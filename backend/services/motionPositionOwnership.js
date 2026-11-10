'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const assetRoot=path.resolve(__dirname,'../assets'),cache=new Map();
function parseTranslationRoots(bytes){
 if(bytes.length<20||bytes.readUInt32LE(0)!==0x46546c67||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a)throw Error('Invalid managed GLB');
 const length=bytes.readUInt32LE(12);if(length>bytes.length-20)throw Error('Invalid GLB JSON chunk');
 const gltf=JSON.parse(bytes.subarray(20,20+length).toString('utf8').replace(/[\u0000\s]+$/,'')),nodes=gltf.nodes||[];
 if(nodes.length>100000)throw Error('Model hierarchy is too large');
 const roots=gltf.scenes?.[gltf.scene??0]?.nodes;if(!Array.isArray(roots))throw Error('Model scene hierarchy is missing');
 const reachable=new Set(),active=new Set(),children=new Map();
 function visit(index){
  if(!Number.isInteger(index)||index<0||index>=nodes.length||active.has(index))throw Error('Invalid cyclic model hierarchy');
  if(children.has(index))return children.get(index);
  active.add(index);reachable.add(index);const meshes=new Set();
  if(Number.isInteger(nodes[index].mesh)&&nodes[index].mesh>=0)meshes.add(index);
  for(const child of nodes[index].children||[])for(const mesh of visit(child))meshes.add(mesh);
  active.delete(index);children.set(index,meshes);return meshes;
 }
 const all=new Set();for(const root of roots)for(const mesh of visit(root))all.add(mesh);
 if(!all.size)throw Error('No model mesh hierarchy');
 const names=[...reachable].filter(index=>{const meshes=children.get(index);return meshes.size===all.size&&[...all].every(mesh=>meshes.has(mesh));}).map(index=>nodes[index].name).filter(name=>typeof name==='string'&&name);
 return {verified:true,translationRootNodes:[...new Set(names)],meshNodes:all.size};
}
async function modelPositionOwnership(model){
 const manifest=model?.motion_package,asset=manifest?.rigPath||model?.file_path,expected=manifest?.rigPath?manifest.rigSha256:undefined;
 if(typeof asset!=='string'||!/^\/assets\/(?:motions|models)\/.+\.glb$/i.test(asset)||asset.includes('\\')||asset.includes('%')||asset.split('/').some(part=>part==='..'||part==='.')||/[\u0000?#]/.test(asset))return {verified:false,translationRootNodes:[]};
 const filename=path.resolve(assetRoot,asset.slice('/assets/'.length));
 if(!filename.startsWith(assetRoot+path.sep))return {verified:false,translationRootNodes:[]};
 try{
  const stat=await fs.stat(filename);if(stat.size>512*1024*1024)return {verified:false,translationRootNodes:[]};
  const key=filename+'|'+stat.mtimeMs+'|'+stat.size+'|'+(expected||''),cached=cache.get(key);if(cached)return cached;
  const bytes=await fs.readFile(filename),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  if(expected&&expected!==sha256)throw Error('Managed rig hash changed');
  const result={...parseTranslationRoots(bytes),sha256};if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
 }catch{return {verified:false,translationRootNodes:[]};}
}
function assertMotionPositionOwnership(loaded,bindings,movement=loaded.instance?.movement){
 if(movement?.enabled!==true)return;
 for(const row of bindings||[]){
  if(!row.enabled)continue;const action=loaded.actions?.find(action=>action.id===row.actionId),positionNodes=(action?.channels||[]).filter(channel=>/:p\d*$/.test(channel)).map(channel=>channel.replace(/:p\d*$/,''));
  if(!positionNodes.length)continue;
  if(loaded.positionOwnership?.verified!==true)throw Object.assign(Error('模型位移职责尚未核实，不能同时启用移动定位与位置动画，请先检查模型动作资产'),{statusCode:400,code:'MOTION_POSITION_OWNERSHIP'});
  if(positionNodes.some(node=>loaded.positionOwnership.translationRootNodes.includes(node)))throw Object.assign(Error('“'+(action.label||action.id)+'”移动整个设备，与移动设备实时位置控制冲突；请只保留一个位置来源'),{statusCode:400,code:'MOTION_POSITION_OWNERSHIP'});
 }
}
module.exports={parseTranslationRoots,modelPositionOwnership,assertMotionPositionOwnership};

