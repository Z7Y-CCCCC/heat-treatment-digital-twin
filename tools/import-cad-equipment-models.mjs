// Copy supplied GLBs byte-for-byte; never weld, rename, rescale or simplify CAD nodes.
// node tools/import-cad-equipment-models.mjs <directory-containing-source-glbs> [catalog-model-id]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import * as T from '../frontend/node_modules/three/build/three.module.js';
const require=createRequire(import.meta.url);
const {CATALOG}=require('../backend/services/cadEquipmentModels.js');
const {normalizeModelMetadata}=require('../backend/services/modelAssetMetadata.js');
const {buildCadInspection}=require('./model-profiles/imported-cad-inspection.cjs');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv[2])throw Error('Provide the directory containing the original GLBs');
const source=path.resolve(process.argv[2]);
// Validate every file before writing any assets, avoiding a partially imported batch.
const targets=process.argv[3]?CATALOG.filter(item=>item.id===process.argv[3]):CATALOG;
if(!targets.length)throw Error('Unknown catalog model ID');
const prepared=targets.map(item=>{
    const bytes=fs.readFileSync(path.join(source,item.source));
    if(bytes.length<28||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length)throw Error(`Invalid GLB: ${item.source}`);
    const jsonLength=bytes.readUInt32LE(12);
    if(bytes.readUInt32LE(16)!==0x4e4f534a||20+jsonLength>bytes.length)throw Error(`Invalid GLB JSON: ${item.source}`);
    const gltf=JSON.parse(bytes.toString('utf8',20,20+jsonLength));
    if((gltf.buffers||[]).some(b=>b.uri&&!b.uri.startsWith('data:'))||(gltf.images||[]).some(i=>i.uri&&!i.uri.startsWith('data:')))throw Error(`External dependencies must be packaged: ${item.source}`);
    const nodes=gltf.nodes.map(n=>{const o=new T.Object3D();if(n.matrix)new T.Matrix4().fromArray(n.matrix).decompose(o.position,o.quaternion,o.scale);if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);if(n.scale)o.scale.fromArray(n.scale);return o});
    gltf.nodes.forEach((n,i)=>(n.children||[]).forEach(j=>nodes[i].add(nodes[j])));
    const scene=new T.Group();gltf.scenes[gltf.scene||0].nodes.forEach(i=>scene.add(nodes[i]));scene.updateMatrixWorld(true);
    const bounds=new T.Box3();let triangles=0;
    scene.traverse(node=>{const index=nodes.indexOf(node);if(index<0)return;for(const primitive of gltf.meshes[gltf.nodes[index].mesh]?.primitives||[]){const a=gltf.accessors[primitive.attributes.POSITION];if(a.min&&a.max)bounds.union(new T.Box3(new T.Vector3(...a.min),new T.Vector3(...a.max)).applyMatrix4(node.matrixWorld));if(primitive.mode==null||primitive.mode===4)triangles+=(primitive.indices==null?a.count:gltf.accessors[primitive.indices].count)/3;}});
    if(bounds.isEmpty()||!bounds.getSize(new T.Vector3()).toArray().every(v=>Number.isFinite(v)&&v>0))throw Error(`Empty or invalid bounds: ${item.source}`);
    const stats={nodes:gltf.nodes.length,meshes:gltf.meshes.length,triangles,materials:gltf.materials?.length||0,size:bounds.getSize(new T.Vector3()).toArray(),min:bounds.min.toArray(),max:bounds.max.toArray()};
    const metadata=normalizeModelMetadata({assetSpec:{device_family:item.family,unit:'m',delivery_status:'review',notes:`用户提供的 ${item.source} 原文件入库；保留原始节点、材质和坐标。`},optimization:{mergeStatic:false,preserveAnimated:true,materialEnhancement:'original'},runtime:{enableGenericBindings:true},inspection:{enabled:true,parts:[]},partBindings:[],sourceAsset:{filename:item.source,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),stats}});
    metadata.inspection=buildCadInspection(item.id,gltf);
    return {item,bytes,metadata};
});
for(const {item,bytes,metadata} of prepared){
    const target=path.join(root,'backend/assets/models',item.id);
    fs.writeFileSync(target+'.glb',bytes);fs.writeFileSync(target+'_metadata.json',JSON.stringify(metadata,null,2)+'\n');
    console.log(JSON.stringify({id:item.id,name:item.name,bytes:bytes.length,...metadata.sourceAsset.stats}));
}
