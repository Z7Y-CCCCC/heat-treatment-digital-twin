<script setup>
import { ref,watch,onMounted,onUnmounted } from 'vue'
import * as T from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { CadMotionScene } from '../../../three/CadMotionScene.js'
import { PortableMotionPlayer,receiveMotionSignal,stepMotionSignal } from '../../../three/PortableMotionPlayer.js'
import { restoreGltfNodeNames } from '../../../three/gltfNodeIdentity.js'
import { resolveBackendAssetUrl } from '../../../three/ModelFactory.js'
const props=defineProps({model:Object,bundle:Object,bindings:Array,points:Array,frame:Object,frameTime:Number,staleMs:Number,test:Boolean,testValue:Number,selectableNodeNames:Array})
const emit=defineEmits(['ready','node-picked'])
const viewport=ref(null),ready=ref(false),error=ref(''),cutaway=ref(false)
let scene,player,parts=[],disposed=false,lastStamp=0,baseline,materialBaseline
let pointerStart
function rememberPointer(event){pointerStart={x:event.clientX,y:event.clientY,id:event.pointerId}}
function pickNode(event){
 if(!ready.value||!props.selectableNodeNames?.length||!pointerStart||pointerStart.id!==event.pointerId||Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>5)return
 pointerStart=null
 const canvas=scene.renderer.domElement,rect=canvas.getBoundingClientRect(),ray=new T.Raycaster()
 ray.setFromCamera(new T.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),scene.camera)
 const names=new Set(props.selectableNodeNames)
 for(const hit of ray.intersectObject(scene.model,true)){let n=hit.object;while(n&&n!==scene.model){if(names.has(n.name)){emit('node-picked',n.name);return}n=n.parent}}
}
function setCutaway(){const metadata=typeof props.model?.metadata==='string'?JSON.parse(props.model.metadata||'{}'):props.model?.metadata||{},names=new Set(metadata.inspection?.shell?.node_names||[]);const suffixes=['housing','lining','hood','upper_housing','tank','tanks','cold_housing','hot_housing','refractory','vault_bricks','partition_shell','partition_lining','quench_tank','quench_liquid'];scene?.model?.traverse(n=>{if(names.has(n.name)||suffixes.some(s=>n.name.endsWith('_'+s)))n.traverse(mesh=>{if(!mesh.isMesh)return;for(const m of [].concat(mesh.material)){m.userData.linkCutaway=cutaway.value;m.userData.linkOriginalOpacity??=m.opacity;m.userData.linkOriginalTransparent??=m.transparent;m.opacity=cutaway.value?Math.min(.16,m.userData.linkOriginalOpacity):m.userData.linkOriginalOpacity;m.transparent=cutaway.value||m.userData.linkOriginalTransparent;m.depthWrite=!m.transparent;m.needsUpdate=true}})})}
function setupBindings(){
 if(!scene?.model||!ready.value)return
 if(baseline)for(const [node,p,q,s,visible] of baseline){node.position.copy(p);node.quaternion.copy(q);node.scale.copy(s);node.visible=visible}
 for(const [m,c,e,intensity] of materialBaseline||[]){m.color?.copy(c);if(e)m.emissive?.copy(e);m.emissiveIntensity=intensity}
 if(scene.packageData)player=new PortableMotionPlayer(scene.model,scene.packageData,props.bindings,props.staleMs)
 const metadata=typeof props.model?.metadata==='string'?JSON.parse(props.model.metadata||'{}'):props.model?.metadata||{}
 const paths=new Map();function visit(parent,prefix=''){parent.children.forEach((n,i)=>{const path=[prefix,`${n.name.replaceAll('/','_')}#${i}`].filter(Boolean).join('/');paths.set(path,n);visit(n,path)})}visit(scene.model)
 parts=(metadata.partBindings||[]).map((definition,i)=>{const row=props.bindings.find(b=>b.actionId===`part:${definition.id||i}`&&b.enabled),node=paths.get(definition.node_path)||scene.model.getObjectByName(definition.node_name||'');return row&&node?{binding:row,definition,node,position:node.position.clone(),rotation:node.quaternion.clone(),signal:{seconds:0},angle:0}:null}).filter(Boolean)
 receive()
}
function testFrame(){const data={status:{online:true},quality:{overall:'good'}};for(const b of props.bindings){data[b.sourceGroup]||={};data[b.sourceGroup][b.sourceKey]=b.inputMin+(b.inputMax-b.inputMin)*props.testValue}return data}
function receive(){if(!ready.value)return;const now=performance.now()/1000,data=props.test?testFrame():props.frame;if(!data)return;lastStamp=props.test?now:props.frameTime;player?.receive(data,lastStamp);for(const p of parts)receiveMotionSignal(p.signal,p.binding,data,lastStamp)}
function advance(delta){
 if(!ready.value)return
 const now=performance.now()/1000;if(props.test)receive()
 player?.advance(delta,now)
 for(const p of parts){stepMotionSignal(p.signal,p.binding,delta,now,props.staleMs);const s=p.signal,b=p.definition;if(!s.hasSample)continue;const axisName=b.axis||'y',axis=new T.Vector3(axisName==='x'?1:0,axisName==='y'?1:0,axisName==='z'?1:0),offset=(b.output_min||0)+((b.output_max??90)-(b.output_min||0))*s.position
   if(b.action==='translate')p.node.position.copy(p.position).addScaledVector(axis,offset)
   else if(b.action==='rotate_angle')p.node.quaternion.copy(p.rotation).multiply(new T.Quaternion().setFromAxisAngle(axis,T.MathUtils.degToRad(offset)))
   else if(b.action==='rotate_speed'){if(s.usable){const value=Number((props.test?testFrame():props.frame)?.[p.binding.sourceGroup]?.[p.binding.sourceKey]);p.angle+=(Number.isFinite(value)?value:0)*Number(b.speed_factor??.10472)*p.binding.speed*(p.binding.invert?-1:1)*delta}p.node.quaternion.copy(p.rotation).multiply(new T.Quaternion().setFromAxisAngle(axis,p.angle))}
   else if(s.usable&&b.action==='visibility')p.node.visible=s.position>.5
   else if(s.usable&&b.action==='color')p.node.traverse(n=>{if(n.isMesh)for(const m of [].concat(n.material))m.color?.set(s.position>.5?(b.on_color||'#00ff88'):(b.off_color||'#666666'))})
 }
}
async function load(){
 scene=new CadMotionScene(viewport.value,advance)
 scene.renderer.domElement.addEventListener('pointerdown',rememberPointer)
 scene.renderer.domElement.addEventListener('pointerup',pickNode)
 try{const url=props.bundle?.rigPath||props.model?.file_path;if(!url)throw Error('尚未选择设备模型');const gltf=await new GLTFLoader().loadAsync(resolveBackendAssetUrl(url));restoreGltfNodeNames(gltf);if(disposed){scene.release(gltf.scene);return}scene.model=gltf.scene;scene.scene.add(scene.model);scene.model.traverse(n=>{if(n.isMesh)n.material=Array.isArray(n.material)?n.material.map(m=>m.clone()):n.material.clone()})
   if(props.bundle){if(props.bundle.previewData)scene.packageData=props.bundle.previewData;else{const response=await fetch(resolveBackendAssetUrl(props.bundle.clipPath));if(!response.ok)throw Error('动作包读取失败');scene.packageData=await response.json()}if(disposed)return}
   scene.bounds=new T.Box3().setFromObject(scene.model);scene.resetCamera();materialBaseline=[];scene.model.traverse(n=>{for(const m of [].concat(n.material||[]))materialBaseline.push([m,m.color?.clone(),m.emissive?.clone(),m.emissiveIntensity])});baseline=[];scene.model.traverse(n=>baseline.push([n,n.position.clone(),n.quaternion.clone(),n.scale.clone(),n.visible]));ready.value=true;setupBindings();emit('ready',true)
 }catch(e){if(!disposed)error.value=e.message}
}
watch(()=>JSON.stringify(props.bindings),setupBindings)
watch(()=>props.staleMs,value=>{if(player)player.staleMs=value})
watch(()=>[props.frame,props.test,props.testValue],receive)
onMounted(load);onUnmounted(()=>{disposed=true;scene?.dispose()})
</script>
<template><div class="motion-link-stage"><div ref="viewport" class="viewport"></div><div v-if="!ready" class="state" role="status">{{error||'正在准备动作模型…'}}</div><div v-if="ready" class="fit"><label><input v-model="cutaway" type="checkbox" @change="setCutaway">内部透视</label><button type="button" @click="scene.resetCamera()">完整视图</button></div></div></template>
<style scoped>.motion-link-stage{position:relative;flex:1;min-height:380px}.viewport{position:absolute;inset:0}.state{position:absolute;inset:0;display:grid;place-content:center;color:#8491a5;background:#f3f6f9;font-size:calc(12px * var(--admin-font-scale, 1))}.fit{position:absolute;top:10px;right:10px;display:flex;align-items:center;gap:10px;padding:5px;border:1px solid #d5dfea;border-radius:9px;background:#fffffff0;color:#527399;font-size:calc(11px * var(--admin-font-scale, 1));box-shadow:0 2px 9px #4055740c}.fit label{display:flex;align-items:center;gap:5px;padding-left:5px;cursor:pointer}.fit input{accent-color:#3478df}.fit button{border:0;border-radius:6px;padding:7px 10px;background:#f0f5fc;color:#426995;cursor:pointer;font:inherit}.fit button:hover{background:#e5eefb}</style>
