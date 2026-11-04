// Remove only the detached pneumatic-pipe assembly. Preserve all other CAD
// transforms, names, materials and the original binary buffer without re-export.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const targetName='221_气动管路';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function removeDetachedPipes(bytes){
 assert.equal(bytes.toString('ascii',0,4),'glTF');assert.equal(bytes.readUInt32LE(4),2);assert.equal(bytes.readUInt32LE(8),bytes.length);
 const jsonLength=bytes.readUInt32LE(12);assert.equal(bytes.readUInt32LE(16),0x4e4f534a);
 const doc=JSON.parse(bytes.toString('utf8',20,20+jsonLength)),removed=new Set();
 const remove=index=>{if(removed.has(index))return;removed.add(index);for(const child of doc.nodes[index].children||[])remove(child)};
 doc.nodes.forEach((node,index)=>{if(node.name===targetName)remove(index)});
 if(!removed.size)return {bytes,removed:[]};
 // This supplied CAD is static. Fail rather than silently invalidate a future rig.
 assert.ok(!doc.skins?.length&&!doc.animations?.length&&!doc.extensionsUsed?.length,'Expected the original static CAD GLB');
 const names=[...removed].map(index=>doc.nodes[index].name),indices=new Map(),kept=[];
 doc.nodes.forEach((node,index)=>{if(!removed.has(index)){indices.set(index,kept.length);kept.push(node)}});
 for(const node of kept)if(node.children)node.children=node.children.filter(index=>indices.has(index)).map(index=>indices.get(index));
 for(const scene of doc.scenes)scene.nodes=scene.nodes.filter(index=>indices.has(index)).map(index=>indices.get(index));
 doc.nodes=kept;
 const meshIndices=new Map(),meshes=[];
 for(const node of kept)if(node.mesh!==undefined){if(!meshIndices.has(node.mesh)){meshIndices.set(node.mesh,meshes.length);meshes.push(doc.meshes[node.mesh])}node.mesh=meshIndices.get(node.mesh)}
 doc.meshes=meshes;
 const json=Buffer.from(JSON.stringify(doc)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,0x20);json.copy(padded);
 const tail=bytes.subarray(20+jsonLength),result=Buffer.alloc(20+padded.length+tail.length);
 bytes.copy(result,0,0,12);result.writeUInt32LE(result.length,8);result.writeUInt32LE(padded.length,12);result.writeUInt32LE(0x4e4f534a,16);padded.copy(result,20);tail.copy(result,20+padded.length);
 return {bytes:result,removed:names};
}
function main(){
 const root=path.resolve(__dirname,'..'),source=path.join(root,'backend/assets/models/ultrasonic_cleaner_cad.glb'),before=fs.readFileSync(source);
 const option=process.argv.indexOf('--uploads-dir');if(option>=0&&!process.argv[option+1])throw Error('Provide the desktop uploads/models directory');
 const directories=[path.join(root,'backend/uploads/models'),...(option>=0?[path.resolve(process.argv[option+1])]:[])];
 const legacyHash='7c426a3fa318a6f1926c7ccfe9c0d4cd8c77f16f4f5408710e3ba184088307d6';
 const copies=directories.flatMap(uploads=>fs.existsSync(uploads)?fs.readdirSync(uploads).filter(name=>/\.glb$/i.test(name)).map(name=>path.join(uploads,name)).filter(file=>[hash(before),legacyHash].includes(hash(fs.readFileSync(file)))):[]);
 const changes=[...new Set([source,...copies])].map(file=>({file,...removeDetachedPipes(fs.readFileSync(file))})).filter(change=>change.removed.length);
 if(!changes.length){console.log('Detached pipes already removed from all selected copies');return}
 const backup=path.join(root,'output','cleaner-pipe-removal-'+Date.now());fs.mkdirSync(backup,{recursive:true});
 for(const [index,change] of changes.entries()){fs.copyFileSync(change.file,path.join(backup,index+'-'+path.basename(change.file)));fs.writeFileSync(change.file,change.bytes)}
 const result={updated:changes.map(change=>({file:change.file,removed:change.removed,afterSha256:hash(change.bytes)})),backup};
 fs.writeFileSync(path.join(backup,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
if(require.main===module)main();
module.exports={removeDetachedPipes,targetName};
