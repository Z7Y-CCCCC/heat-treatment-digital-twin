<script setup>
import {computed,ref,watch,onMounted,onUnmounted,onActivated,onDeactivated} from 'vue'
import {CadMotionScene} from '../../../three/CadMotionScene.js'
import {cadMotionActions} from '../../../three/cadMotionProfiles.js'
import {resolveBackendAssetUrl} from '../../../three/ModelFactory.js'
const props=defineProps({model:{type:Object,required:true},actionId:{type:String,required:true}})
const emit=defineEmits(['close-preview'])
const viewport=ref(null),ready=ref(false),error=ref(''),playing=ref(false),elapsed=ref(0),speed=ref(1),cutaway=ref(true),showDetails=ref(false)
const action=computed(()=>cadMotionActions(props.model.id).find(a=>a.id===props.actionId))
const oilAction=computed(()=>props.model.id==='cad_multipurpose_furnace_082000'&&props.actionId==='basket_up')
let runtime,disposed=false
async function load(){
    ready.value=false;playing.value=false;error.value='';runtime?.dispose()
    const scene=new CadMotionScene(viewport.value,delta=>{if(!ready.value||!action.value)return;if(playing.value){elapsed.value=Math.min(action.value.duration,elapsed.value+delta*speed.value);if(elapsed.value>=action.value.duration)playing.value=false}scene.apply(props.actionId,elapsed.value)})
    runtime=scene
    try{await scene.load(resolveBackendAssetUrl(props.model.file_path),props.model.id);if(disposed||runtime!==scene)return;scene.setCutaway(cutaway.value);ready.value=true;previewProcessStage()}
    catch(e){if(!disposed){error.value=`动作模型加载失败：${e.message||e}`;scene.dispose()}}
}
function previewProcessStage(){elapsed.value=0;playing.value=ready.value;if(oilAction.value)runtime?.focusOilDrainage();else if(runtime?.oilView)runtime.resetCamera()}
function play(){if(elapsed.value>=action.value.duration)elapsed.value=0;playing.value=!playing.value}
watch(()=>props.actionId,previewProcessStage)
onMounted(load);onUnmounted(()=>{disposed=true;runtime?.dispose()});onActivated(()=>runtime?.setActive(true));onDeactivated(()=>{playing.value=false;runtime?.setActive(false)})
defineExpose({previewProcessStage})
</script>
<template>
 <section class="cad-motion-preview" aria-label="CAD 动作本页预览" :data-action="actionId" :data-playing="playing">
  <header><div><strong>{{ action?.label }}</strong><small>{{ model.name }}</small></div><div class="tools"><label><input v-model="cutaway" type="checkbox" @change="runtime?.setCutaway(cutaway)">内部透视</label><button type="button" :aria-pressed="showDetails" @click="showDetails=!showDetails">{{ showDetails?'隐藏说明':'显示说明' }}</button><button v-if="oilAction" type="button" @click="runtime?.focusOilDrainage()">沥油近景</button><button type="button" @click="runtime?.resetCamera()">完整视图</button></div></header>
  <div class="stage"><div ref="viewport" class="canvas"></div><div v-if="!ready" class="loading" role="status">{{ error||'正在准备可动部件…' }}<button v-if="error" type="button" @click="load">重新加载</button></div><div v-else-if="showDetails" class="hud"><button class="hud-close" type="button" aria-label="关闭动作说明" @click="showDetails=false">×</button><strong>{{ action?.label }}</strong><span>{{ action?.detail }}</span><small>模拟演示 · 未连接 PLC</small></div></div>
  <footer><div><button type="button" :disabled="!ready" @click="play">{{ playing?'暂停':elapsed>=action.duration?'重播':'播放' }}</button><button type="button" :disabled="!ready" @click="playing=false;elapsed=0">复位</button><select v-model.number="speed" aria-label="CAD 动画速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select><button type="button" @click="emit('close-preview')">停止预览</button></div><label>动作进度<input type="range" min="0" :max="action?.duration||8" step=".01" :value="elapsed" :disabled="!ready" aria-label="CAD 动作进度" @input="playing=false;elapsed=Number($event.target.value)"><span>{{ elapsed.toFixed(1) }} / {{ action?.duration }} 秒</span></label></footer>
 </section>
</template>
<style scoped>
.cad-motion-preview{display:flex;flex:1;flex-direction:column;min-width:0;min-height:0;height:100%;color:#2d455e;background:white}header{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:15px;border-bottom:1px solid #e1e9ef;flex-wrap:wrap}header strong{display:block;font-size:17px}header small{display:block;font-size:12px;color:#7c90a3;margin-top:4px}.tools,footer>div{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.tools{font-size:12px}button,select{background:#fff;border:1px solid #d6e1eb;border-radius:8px;padding:7px 10px;color:#315679;cursor:pointer}button:disabled{opacity:.45}.stage{position:relative;flex:1;min-height:380px}.canvas{position:absolute;inset:0}.loading{position:absolute;inset:0;display:grid;place-content:center;gap:15px;background:#eff4f7}.hud{position:absolute;bottom:14px;left:14px;right:14px;display:grid;gap:7px;padding:13px;background:#213c50ed;color:#fff;border-radius:10px;pointer-events:none}.hud span,.hud small{font-size:12px;color:#c1d9e8}.hud small{color:#86d4e6}footer{display:grid;gap:12px;padding:12px 15px}footer label{display:flex;align-items:center;gap:8px;font-size:12px;color:#748ba0}footer input[type=range]{min-width:60px;flex:1;accent-color:#2a86b3}footer span{white-space:nowrap;font-variant-numeric:tabular-nums}
.hud{padding-right:46px}.hud-close{position:absolute;top:8px;right:8px;display:grid;place-items:center;width:28px;height:28px;padding:0;font-size:20px;line-height:1;color:#fff;background:transparent;border-color:#ffffff55;pointer-events:auto}.hud-close:hover{background:#ffffff20}
</style>
