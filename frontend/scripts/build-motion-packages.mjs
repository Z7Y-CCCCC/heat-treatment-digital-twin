// Compile existing Three.js authoring rigs once, not a second hand-written Unity animation.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import * as T from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { CadMotionRig } from '../src/three/CadMotionRig.js'
import { CAD_MOTION_PROFILES } from '../src/three/cadMotionProfiles.js'
import { CleanerProcessEffects } from '../src/three/CleanerProcessEffects.js'
import { CLEANER_ACTIONS } from '../src/views/admin/utils/motionEntries.js'
import { restoreGltfNodeNames } from '../src/three/gltfNodeIdentity.js'
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),out=path.join(root,'backend/assets/motions')
fs.mkdirSync(out,{recursive:true})
globalThis.FileReader=class {readAsArrayBuffer(blob){blob.arrayBuffer().then(v=>{this.result=v;this.onloadend?.()})} readAsDataURL(blob){blob.arrayBuffer().then(v=>{this.result=`data:${blob.type};base64,${Buffer.from(v).toString('base64')}`;this.onloadend?.()})}}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),round=v=>Math.round(v*1e6)/1e6
const modes={door:'position',gate:'position',hook:'position',basket_down:'position',basket_up:'position',lift_up:'position',lift_down:'position',travel:'position',feed:'position',fill:'position',drain:'position'}
const catalog={schemaVersion:1,models:{}}
const matches=process.argv.filter(v=>v.startsWith('--model=')).map(v=>v.slice(8))
for(const id of [...Object.keys(CAD_MOTION_PROFILES),'ultrasonic_cleaner_cad'].filter(id=>!matches.length||matches.includes(id))){
 const source=fs.readFileSync(path.join(root,`backend/assets/models/${id}.glb`)),gltf=await new GLTFLoader().parseAsync(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength),'')
 restoreGltfNodeNames(gltf)
 const asset=gltf.scene,wrapper=new T.Group();wrapper.name='motion_asset_root';wrapper.add(asset)
 let rig,effects,apply,reset,actions
 if(CAD_MOTION_PROFILES[id]){
   rig=new CadMotionRig(asset,id);reset=()=>rig.reset()
   actions=CAD_MOTION_PROFILES[id].actions.map(a=>({...a,mode:modes[a.id]||'running',duration:(modes[a.id]==='position' && !['fill','drain'].includes(a.id))?a.duration/2:(modes[a.id]==='position'?a.duration:5)}))
   // Preview demos ease out and back with sin². PLC position is a measured
   // stroke, not demo elapsed time: 25% feedback must show 25% of travel.
   // Keep the authored mechanism/geometry, invert only that demo easing.
   apply=(a,t)=>rig.apply(a.id,a.mode==='position'&&!['fill','drain'].includes(a.id)
     ? CAD_MOTION_PROFILES[id].actions.find(x=>x.id===a.id).duration*Math.asin(Math.sqrt(Math.max(0,Math.min(1,t/a.duration))))/Math.PI : t)
 }else{
   effects=new CleanerProcessEffects(asset,asset);reset=()=>effects.apply(null)
   actions=CLEANER_ACTIONS.map(a=>({id:a.id,label:a.label,mode:['fill','drain'].includes(a.id)?'position':'running',duration:['fill','drain'].includes(a.id)?a.seconds:5}))
   apply=(a,t)=>effects.apply({time:t,level:a.id==='fill'?t/a.duration:a.id==='drain'?1-t/a.duration:1,wetness:1,[a.id]:true})
 }
 // GPU points / WebGL line primitives are converted to portable small meshes.
 // Their authored geometry, positions and visibility are sampled from the same rig.
 const adapters=[];const nodes=[];asset.traverse(n=>nodes.push(n))
 for(const n of nodes){
   if(n.isPoints){
     const group=new T.Group();group.name=n.name;group.position.copy(n.position);group.quaternion.copy(n.quaternion);group.scale.copy(n.scale)
     const mat=new T.MeshBasicMaterial({color:n.material.uniforms?.tint?.value||'#75dbef',transparent:true,opacity:.7,depthWrite:false})
     const geometry=new T.SphereGeometry(.008,4,3),a=n.geometry.attributes.position
     for(let i=0;i<a.count;i++)group.add(new T.Mesh(geometry,mat))
     n.parent.add(group);n.removeFromParent();adapters.push(()=>{group.visible=n.visible;for(let i=0;i<a.count;i++)group.children[i].position.fromBufferAttribute(a,i)})
   }else if(n.isLine){
     const group=new T.Group();group.name=n.name;group.position.copy(n.position);group.quaternion.copy(n.quaternion);group.scale.copy(n.scale)
     const a=n.geometry.attributes.position,mat=new T.MeshBasicMaterial({color:n.material.color,transparent:true,opacity:n.material.opacity,depthWrite:false})
     for(let i=0;i<a.count-1;i+=n.isLineSegments?2:1){const p=new T.Vector3().fromBufferAttribute(a,i),q=new T.Vector3().fromBufferAttribute(a,i+1),d=q.clone().sub(p);if(d.length()<1e-7)continue;const mesh=new T.Mesh(new T.CylinderGeometry(.002,.002,d.length(),4),mat);mesh.position.copy(p).add(q).multiplyScalar(.5);mesh.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),d.normalize());group.add(mesh)}
     n.parent.add(group);n.removeFromParent();adapters.push(()=>{group.visible=n.visible})
   }
 }
 reset();adapters.forEach(f=>f());wrapper.updateMatrixWorld(true)
 const targets=[],used=new Set()
 wrapper.traverse(n=>{const original=n.name;if(!original||used.has(original))n.name=`motion_node_${targets.length}`;used.add(n.name);targets.push(n)})
 const sample=n=>{
   const r={p:n.position.toArray().map(round),q:n.quaternion.toArray().map(round),s:n.scale.toArray().map(round),v:[n.visible?1:0]}
   if(n.isMesh){[].concat(n.material).forEach((m,i)=>{r['c'+i]=[m.color?.r??1,m.color?.g??1,m.color?.b??1,m.opacity??1].map(round);r['e'+i]=[...(m.emissive?.toArray()||[0,0,0]),m.emissiveIntensity??0].map(round)})}return r
 }
 const baseline=targets.map(sample),clips=[]
 for(const a of actions){
   const count=Math.ceil(a.duration*24)+1,frames=[]
   reset();for(let i=0;i<count;i++){apply(a,i/(count-1)*a.duration);adapters.forEach(f=>f());frames.push(targets.map(sample))}
   const tracks=[]
   targets.forEach((n,index)=>{for(const key of Object.keys(baseline[index])){const values=frames.map(frame=>frame[index][key]);if(!values.some(v=>JSON.stringify(v)!==JSON.stringify(baseline[index][key])))continue;tracks.push({node:n.name,channel:key,size:values[0].length,values:values.flat()})}})
   if(!tracks.length)throw Error(`No animation tracks: ${id}/${a.id}`)
   clips.push({id:a.id,label:a.label,mode:a.mode,duration:a.duration,count,tracks})
 }
 reset();adapters.forEach(f=>f());wrapper.updateMatrixWorld(true)
 const binary=Buffer.from(await new GLTFExporter().parseAsync(wrapper,{binary:true,onlyVisible:false,trs:true})),packageData={schemaVersion:1,modelId:id,sourceSha256:sha(source),rigSha256:sha(binary),nodes:targets.map((n,i)=>({name:n.name,...baseline[i]})),clips}
 const bytes=Buffer.from(JSON.stringify(packageData)),stem=id
 fs.writeFileSync(path.join(out,stem+'.glb'),binary);fs.writeFileSync(path.join(out,stem+'.json'),bytes)
 catalog.models[id]={sourcePath:`/assets/models/${id}.glb`,sourceSha256:sha(source),rigPath:`/assets/motions/${stem}.glb`,rigSha256:sha(binary),clipPath:`/assets/motions/${stem}.json`,clipSha256:sha(bytes),actions:clips.map(({id,label,mode,duration,tracks})=>({id,label,mode,duration,channels:tracks.map(t=>t.node+':'+t.channel)}))}
 console.log(`${id}: ${clips.length} clips, ${targets.length} nodes, ${Math.round(binary.length/1024)} KB rig, ${Math.round(bytes.length/1024)} KB tracks`)
 rig?.dispose()
}
const file=path.join(root,'shared/motionPackages.json')
if(matches.length&&fs.existsSync(file)){const previous=JSON.parse(fs.readFileSync(file));catalog.models={...previous.models,...catalog.models}}
fs.writeFileSync(file,JSON.stringify(catalog,null,2)+'\n')
