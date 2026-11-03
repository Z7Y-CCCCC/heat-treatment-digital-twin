<script setup>
import {computed,ref,onMounted,onUnmounted,onActivated,onDeactivated} from 'vue'
import {WaterCoolingScene} from '../../../three/WaterCoolingScene.js'
import {WATER_COOLING_STEPS as steps,WATER_COOLING_TOTAL as total,sampleWaterCooling} from '../../../three/waterCoolingProcess.js'
import {resolveBackendAssetUrl} from '../../../three/ModelFactory.js'
const props=defineProps({model:{type:Object,required:true},compact:Boolean})
const emit=defineEmits(['close-preview'])
const viewport=ref(null),elapsed=ref(0),playing=ref(false),ready=ref(false),error=ref(''),cutaway=ref(true),speed=ref(1)
const frame=computed(()=>sampleWaterCooling(elapsed.value))
let scene,disposed=false
async function load(){error.value='';ready.value=false;playing.value=false;scene?.dispose();scene=new WaterCoolingScene(viewport.value,delta=>{if(!ready.value)return;if(playing.value){elapsed.value=Math.min(total,elapsed.value+delta*speed.value);if(elapsed.value>=total)playing.value=false}scene.apply(frame.value)})
try{await scene.load(resolveBackendAssetUrl(props.model.file_path));if(disposed)return;scene.setCutaway(cutaway.value);scene.apply(frame.value);ready.value=true}catch(e){if(!disposed)error.value=`水冷槽加载失败：${e.message}`}}
function play(){if(elapsed.value>=total)elapsed.value=0;playing.value=!playing.value}
function seekStep(index){playing.value=false;elapsed.value=steps.slice(0,index).reduce((sum,s)=>sum+s.duration,0)+steps[index].duration*.5}
onMounted(load);onUnmounted(()=>{disposed=true;scene?.dispose()});onActivated(()=>scene?.setActive(true));onDeactivated(()=>{playing.value=false;scene?.setActive(false)})
</script>
<template>
 <section class="water-sequence" :class="{compact}" aria-label="水冷槽动作联动">
  <header><div><strong>水冷槽 · 升降与搅拌联动</strong><small>47.10.00 CAD · 1050 mm 升降行程</small></div><div class="tools"><label><input v-model="cutaway" type="checkbox" @change="scene?.setCutaway(cutaway)">内部透视</label><button type="button" @click="scene?.resetCamera()">完整视图</button><button v-if="compact" type="button" @click="emit('close-preview')">返回部件</button></div></header>
  <nav aria-label="水冷工步"><button v-for="(step,index) in steps" :key="step.id" :disabled="!ready" :aria-current="frame.index===index?'step':undefined" @click="seekStep(index)">{{ index+1 }} {{ step.label }}</button></nav>
  <div class="stage"><div ref="viewport" class="canvas"></div><div v-if="!ready" class="loading" role="status">{{ error||'正在加载水冷槽模型…' }}<button v-if="error" type="button" @click="load">重试</button></div><div v-else class="hud"><strong>{{ frame.complete?'本次水冷流程完成':steps[frame.index].label }}</strong><span>{{ steps[frame.index].detail }}</span><small>下降量 {{ (frame.down*1050).toFixed(0) }} mm · 搅拌{{ frame.agitator?'运行':'停止' }}</small></div></div>
  <footer><div class="playback"><button type="button" :disabled="!ready" @click="play">{{ playing?'暂停':frame.complete?'重新播放':'播放水冷联动' }}</button><button type="button" :disabled="!ready" @click="playing=false;elapsed=0">复位</button><select v-model.number="speed" aria-label="水冷演示速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select><span>{{ elapsed.toFixed(1) }} / {{ total }} 秒</span></div><input :value="elapsed" type="range" min="0" :max="total" step=".01" aria-label="水冷联动流程进度" :disabled="!ready" @input="playing=false;elapsed=Number($event.target.value)"><small>工艺模拟 · 未连接 PLC。槽水保留供下一循环使用；注排水与阀门可在部件动作中单独预览。</small></footer>
 </section>
</template>
<style scoped>
.water-sequence{display:flex;flex:1;flex-direction:column;min-width:0;min-height:600px;background:#fff;border:1px solid #dce6ef;border-radius:14px;overflow:hidden;color:#2a4058}.water-sequence.compact{min-height:0;height:100%;border:0;border-radius:0}header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:1px solid #e2e9f0}header strong{display:block;font-size:17px}header small{display:block;color:#7a8fa2;margin-top:5px}.tools{display:flex;align-items:center;gap:10px;font-size:12px}button,select{border:1px solid #d6e1ec;border-radius:8px;padding:8px 12px;background:#fff;color:#345579;cursor:pointer}button:disabled{opacity:.5;cursor:default}nav{display:flex;gap:7px;padding:12px;flex-wrap:wrap;background:#f8fbfd}nav button{font-size:12px;flex:1;white-space:nowrap}nav [aria-current=step]{background:#e5f5fb;border-color:#69bcd5;color:#136481}.stage{position:relative;flex:1;min-height:380px}.canvas{position:absolute;inset:0}.hud{position:absolute;left:16px;bottom:16px;right:16px;display:grid;gap:6px;background:#203c4ee8;color:#fff;border-radius:10px;padding:14px;pointer-events:none}.hud span,.hud small{font-size:12px;color:#c0d8e4}.loading{position:absolute;inset:0;display:grid;place-content:center;gap:14px;background:#eff5f8}.playback{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.playback button:first-child{background:#217da0;color:white;border:0}.playback span{margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px}footer{padding:12px 16px;display:grid;gap:10px}footer input[type=range]{width:100%;accent-color:#2684a6}footer small{font-size:11px;color:#7a8fa2}.compact header{flex-wrap:wrap}.compact .stage{min-height:300px}
</style>
