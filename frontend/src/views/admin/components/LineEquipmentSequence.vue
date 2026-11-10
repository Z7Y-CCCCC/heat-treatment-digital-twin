<script setup>
import {computed,nextTick,ref,watch,onUnmounted,onActivated,onDeactivated} from 'vue'
import {LineSimulationScene} from '../../../three/LineSimulationScene.js'
import {simulationLineMembers,simulationCapabilities,buildLineSimulation,sampleLineSimulation,parseSimulationConfig} from '../../../three/lineSimulation.js'
import {assertLineMovementUnits} from '../../../../../shared/lineRailSpacing.mjs'
const props=defineProps({models:{type:Array,default:()=>[]},lines:{type:Array,default:()=>[]},devices:{type:Array,default:()=>[]},workshops:{type:Array,default:()=>[]}})
const lineId=ref(''),selectedIds=ref([]),query=ref(''),equipmentPage=ref(0),stepPage=ref(0),panel=ref('setup'),arrangement=ref('scheme'),includeProcess=ref(true)
const transferTolerances=ref({heightToleranceMeters:.01,lateralToleranceMeters:.01,angleToleranceDegrees:2})
const viewport=ref(null),ready=ref(false),busy=ref(false),error=ref(''),elapsed=ref(0),playing=ref(false),speed=ref(1),cutaway=ref(true)
const navigationMode=ref('rotate'),viewDeviceId=ref('')
const members=computed(()=>simulationLineMembers(props.devices,lineId.value))
const filtered=computed(()=>members.value.filter(d=>(d.name+' '+d.id).toLowerCase().includes(query.value.toLowerCase())))
const equipmentPages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/6)))
const visibleMembers=computed(()=>filtered.value.slice(equipmentPage.value*6,equipmentPage.value*6+6))
const selected=computed(()=>selectedIds.value.map(id=>members.value.find(d=>d.id===id)).filter(Boolean))
const savedTransferLink=computed(()=>{
    const carts=selected.value.filter(device=>simulationCapabilities(device,props.models).cart)
    if(carts.length!==1)return null
    const link=parseSimulationConfig(carts[0].instance_config).animationBindings?.transferLink
    return link?.enabled===true?link:null
})
const effectiveTransferTolerances=computed(()=>savedTransferLink.value||transferTolerances.value)
function changePreviewTolerance(field,value){if(!savedTransferLink.value)transferTolerances.value={...transferTolerances.value,[field]:Number(value)}}
const draft=computed(()=>{
    try{
        const plan=buildLineSimulation(selected.value,props.models,{process:includeProcess.value})
        if(arrangement.value==='site'){
            const line=props.lines.find(row=>String(row.id)===String(lineId.value)),layout=parseSimulationConfig(line?.layout||line?.layout_json)
            // Reading an uncalibrated legacy line does not migrate its source
            // ratio. Only an explicit line-local calibration can claim parity;
            // all authoring/save paths independently require the strict contract.
            if('sceneUnitsPerMeter' in layout&&Object.prototype.hasOwnProperty.call(layout,'sceneUnitsPerMeter'))for(const row of plan.rows){
                const config=parseSimulationConfig(row.instance_config),movement=parseSimulationConfig(config.movement)
                if(movement.enabled===true||config.animationBindings?.transferLink?.enabled===true)assertLineMovementUnits(config.movement,layout,row.name||row.id)
            }
        }
        return {plan,error:''}
    }catch(e){return {plan:null,error:e.message}}
})
const plan=ref(null)
const frame=computed(()=>plan.value?sampleLineSimulation(plan.value,elapsed.value):null)
const stepPages=computed(()=>Math.max(1,Math.ceil((plan.value?.steps.length||0)/6)))
const visibleSteps=computed(()=>plan.value?.steps.slice(stepPage.value*6,stepPage.value*6+6)||[])
const lineName=computed(()=>props.lines.find(l=>String(l.id)===lineId.value)?.name||'未选择产线')
const caps=d=>simulationCapabilities(d,props.models)
let runtime,version=0,disposed=false
function invalidate(){version++;playing.value=false;ready.value=false;busy.value=false;elapsed.value=0;plan.value=null;viewDeviceId.value='';error.value='';panel.value='setup';runtime?.dispose();runtime=null}
watch(()=>props.lines.map(l=>String(l.id)),ids=>{if(!ids.includes(lineId.value))lineId.value=ids[0]||''},{immediate:true})
watch(lineId,()=>{selectedIds.value=[];query.value='';equipmentPage.value=0;panel.value='setup';invalidate()})
watch(query,()=>{equipmentPage.value=0})
watch(equipmentPages,n=>{equipmentPage.value=Math.min(equipmentPage.value,n-1)})
watch(()=>JSON.stringify({selected:selected.value.map(d=>({id:d.id,name:d.name,model:d.model_type,file:d.model_file,x:d.pos_x,y:d.pos_y,z:d.pos_z,rotation:d.rotation_y,scale:d.scale,config:d.instance_config})),models:props.models,lines:props.lines.map(l=>({id:l.id,workshop:l.workshop_id,layout:l.layout||l.layout_json})),workshops:props.workshops.map(w=>({id:w.id,layout:w.layout||w.layout_json})),arrangement:arrangement.value,process:includeProcess.value,tolerances:transferTolerances.value}),invalidate)
watch(()=>members.value.map(d=>d.id),ids=>{selectedIds.value=selectedIds.value.filter(id=>ids.includes(id))})
function toggle(id){selectedIds.value=selectedIds.value.includes(id)?selectedIds.value.filter(v=>v!==id):[...selectedIds.value,id]}
function move(id,direction){const index=selectedIds.value.indexOf(id),other=index+direction;if(index<0||other<0||other>=selectedIds.value.length)return;const next=[...selectedIds.value];[next[index],next[other]]=[next[other],next[index]];selectedIds.value=next}
async function prepare(play=false){
    if(!draft.value.plan)return
    invalidate();const current=version;busy.value=true;const nextPlan=draft.value.plan
    await nextTick();if(disposed||current!==version||!viewport.value)return
    let scene
    try{
        scene=new LineSimulationScene(viewport.value,delta=>{if(!ready.value||current!==version)return;if(playing.value){elapsed.value=Math.min(plan.value.total,elapsed.value+delta*speed.value);if(elapsed.value>=plan.value.total)playing.value=false}scene.applyFrame(frame.value)})
        runtime=scene;scene.setNavigationMode(navigationMode.value);await scene.loadPlan(nextPlan,props.lines,props.workshops,arrangement.value,{transferTolerances:effectiveTransferTolerances.value})
        if(disposed||current!==version){scene.dispose();return}
        plan.value=nextPlan;scene.setCutaway(cutaway.value);scene.applyFrame(sampleLineSimulation(nextPlan,0));ready.value=true;busy.value=false;playing.value=play;stepPage.value=0;panel.value='steps'
    }catch(e){scene?.dispose();if(current===version&&!disposed){error.value=`联动预览加载失败：${e.message||e}`;busy.value=false;runtime=null}}
}
async function play(){if(!ready.value){await prepare(true);return}if(elapsed.value>=plan.value.total)elapsed.value=0;playing.value=!playing.value}
function reset(){playing.value=false;elapsed.value=0;stepPage.value=0}
function seekStep(step){playing.value=false;elapsed.value=step.start+step.duration/2}
function focusDevice(id){if(!ready.value||!id)return;viewDeviceId.value=id;runtime?.focus(id)}
function fullView(){viewDeviceId.value='';runtime?.resetCamera()}
watch(navigationMode,mode=>runtime?.setNavigationMode(mode))
watch(()=>frame.value?.index,()=>{if(!frame.value)return;stepPage.value=Math.floor(frame.value.index/6)})
onUnmounted(()=>{disposed=true;invalidate()});onDeactivated(()=>{playing.value=false;runtime?.setActive(false)});onActivated(()=>runtime?.setActive(true))
</script>
<template>
 <section class="line-sequence" data-testid="line-equipment-sequence" :data-line-id="lineId" :data-step-kind="frame?.step.kind||''">
  <aside class="controls">
   <header><h3>产线设备联动</h3><span>模拟演示</span></header>
   <label class="field">选择产线<select v-model="lineId" aria-label="选择联动产线"><option v-if="!lines.length" value="">暂无可用产线</option><option v-for="line in lines" :key="line.id" :value="String(line.id)">{{ workshops.find(w=>w.id===line.workshop_id)?.name||'' }} · {{ line.name||line.id }}</option></select></label>
   <nav class="tabs" aria-label="产线联动配置"><button type="button" :aria-pressed="panel==='setup'" @click="panel='setup'">设备选择 · {{ selected.length }}</button><button type="button" :aria-pressed="panel==='steps'" :disabled="!plan" @click="panel='steps'">联动工步</button></nav>
   <div class="control-body"><template v-if="panel==='setup'">
    <div class="selection-tools"><input v-model="query" placeholder="搜索产线设备" aria-label="搜索联动设备"><button type="button" @click="selectedIds=members.map(d=>d.id)">全选</button><button type="button" @click="selectedIds=[]">清空</button></div>
    <p v-if="!members.length" class="hint" role="status">本产线暂无设备。请先在设备管理中将设备分配到该产线。</p>
    <p v-else class="hint">勾选参与设备；↑↓ 调整作业顺序。可选择一台产线料车负责送料和取料。</p>
    <div class="equipment-list"><article v-for="device in visibleMembers" :key="device.id" :class="{selected:selectedIds.includes(device.id)}" :data-device-id="device.id">
     <label><input type="checkbox" :checked="selectedIds.includes(device.id)" :aria-label="`参与联动：${device.name||device.id}`" @change="toggle(device.id)"><span><strong>{{ device.name||device.id }}</strong><small>{{ caps(device).model?.name||device.model_type }}</small><em>{{ caps(device).cart?'料车':caps(device).animated?'可模拟动作':'仅展示 · 未配置动作' }}</em></span></label>
     <div v-if="selectedIds.includes(device.id)" class="order"><span>{{ caps(device).cart?'配送':selectedIds.indexOf(device.id)+1 }}</span><button type="button" :aria-label="`上移${device.name||device.id}`" :disabled="selectedIds.indexOf(device.id)===0" @click="move(device.id,-1)">↑</button><button type="button" :aria-label="`下移${device.name||device.id}`" :disabled="selectedIds.indexOf(device.id)===selectedIds.length-1" @click="move(device.id,1)">↓</button></div>
    </article></div>
    <div class="pagination"><span>{{ filtered.length }} 台 · {{ equipmentPage+1 }}/{{ equipmentPages }} 页</span><button type="button" :disabled="equipmentPage===0" @click="equipmentPage--">上一页</button><button type="button" :disabled="equipmentPage>=equipmentPages-1" @click="equipmentPage++">下一页</button></div>
    <label class="field">预览排布<select v-model="arrangement" aria-label="联动预览排布"><option value="scheme">按模拟顺序排列</option><option value="site">沿用现场设备位置</option></select></label>
    <div v-if="arrangement==='site'" class="site-transfer-settings">
     <label class="field">{{savedTransferLink?'已保存联动':'模拟预览'}}高度公差（米）<input :value="effectiveTransferTolerances.heightToleranceMeters" :disabled="!!savedTransferLink" @input="changePreviewTolerance('heightToleranceMeters',$event.target.value)" type="number" min="0" max="1" step=".001" aria-label="模拟预览高度公差（米）"></label>
     <label class="field">{{savedTransferLink?'已保存联动':'模拟预览'}}横向公差（米）<input :value="effectiveTransferTolerances.lateralToleranceMeters" :disabled="!!savedTransferLink" @input="changePreviewTolerance('lateralToleranceMeters',$event.target.value)" type="number" min="0" max="1" step=".001" aria-label="模拟预览横向公差（米）"></label>
     <label class="field">{{savedTransferLink?'已保存联动':'模拟预览'}}角度公差（度）<input :value="effectiveTransferTolerances.angleToleranceDegrees" :disabled="!!savedTransferLink" @input="changePreviewTolerance('angleToleranceDegrees',$event.target.value)" type="number" min="0" max="30" step=".1" aria-label="模拟预览角度公差（度）"></label>
    </div>
    <label class="check"><input v-model="includeProcess" type="checkbox">送料后继续执行设备内置部件动作</label>
    <p class="hint">{{ arrangement==='scheme'?'仅排列本次预览，不改动现场布局。':'使用已配置的轨道、进出料口和实际模型行程；已启用实时物料联动时使用保存的联动公差。工步仍是模拟，不读写 PLC，也不作避障规划。' }}</p>
    <p v-if="draft.error&&selected.length" class="problem" role="alert">{{ draft.error }}</p>
   </template>
   <template v-else>
    <div class="step-info"><strong>{{ plan.cart?`配套料车：${plan.cart.name||plan.cart.id}`:'未选择料车 · 逐台动作演示' }}</strong><small>共 {{ plan.steps.length }} 个工步 · {{ plan.total }} 秒</small></div>
    <ol class="steps" :start="stepPage*6+1"><li v-for="step in visibleSteps" :key="step.id" :class="{active:frame?.step.id===step.id}"><button type="button" @click="seekStep(step)"><strong>{{ step.name }} · {{ step.label }}</strong><small>{{ step.duration }} 秒</small></button></li></ol>
    <div class="pagination"><span>{{ stepPage+1 }}/{{ stepPages }} 页</span><button type="button" :disabled="stepPage===0" @click="stepPage--">上一页</button><button type="button" :disabled="stepPage>=stepPages-1" @click="stepPage++">下一页</button></div>
   </template>
   </div>
   <div class="playback"><button type="button" class="primary" :disabled="busy||!draft.plan" @click="play">{{ busy?'准备模型中…':playing?'暂停':frame?.complete?'重新联动':ready?'继续联动':'开始联动' }}</button><button type="button" :disabled="!ready" @click="reset">复位</button><select v-model.number="speed" aria-label="产线联动速度"><option :value=".5">0.5×</option><option :value="1">1×</option><option :value="2">2×</option></select></div>
   <button v-if="!ready" type="button" :disabled="busy||!draft.plan" @click="prepare(false)">预览选中设备</button>
   <p class="hint">仅使用本产线选中的设备实例。工步和物料流转为模拟，不读写 PLC。</p>
  </aside>
  <div class="preview"><header><div><strong>{{ lineName }} · {{ selected.length }} 台设备</strong><small>{{ plan?.cart?'料车定位 → 开门送料 → 设备部件动作 → 取料转运':'自选产线设备 · 动作模拟' }}</small></div><div class="preview-tools"><label><input v-model="cutaway" type="checkbox" @change="runtime?.setCutaway(cutaway)">内部透视</label><button type="button" :disabled="!ready" @click="focusDevice(frame.step.deviceId)">当前设备</button><button type="button" :disabled="!ready" @click="fullView">完整视图</button></div></header>
   <div class="view-navigation" aria-label="产线视角导航">
    <div class="view-modes" role="group" aria-label="鼠标拖动方式"><button type="button" :aria-pressed="navigationMode==='rotate'" @click="navigationMode='rotate'">旋转查看</button><button type="button" :aria-pressed="navigationMode==='pan'" @click="navigationMode='pan'">平移浏览</button></div>
    <label class="device-location">定位设备<select v-model="viewDeviceId" :disabled="!ready" aria-label="定位查看设备" @change="focusDevice(viewDeviceId)"><option value="">选择要查看的设备</option><option v-for="device in plan?.rows||[]" :key="device.id" :value="device.id">{{ device.name||device.id }}</option></select></label>
    <span class="navigation-hint">{{ navigationMode==='pan'?'左键拖动平移':'左键拖动旋转' }} · 右键拖动平移 · 滚轮缩放</span>
   </div>
   <div class="stage"><div ref="viewport" class="canvas"></div><div v-if="!ready" class="empty" role="status"><strong>{{ error|| (busy?'正在加载选中设备…':selected.length?'点击“预览选中设备”或“开始联动”':'先选择产线和参与设备') }}</strong><span v-if="error">检查所选设备的模型文件后可重试。</span></div><div v-if="ready&&frame" class="hud"><strong>{{ frame.complete?'本次联动完成':frame.step.name+' · '+frame.step.label }}</strong><small>{{ plan.cart?'物料由所选料车在各作业设备间转运':'未选择料车，仅演示所选设备动作' }}</small><span>工步 {{ frame.index+1 }}/{{ plan.steps.length }} · 模拟演示</span></div></div>
   <footer><label>流程进度<input type="range" min="0" :max="plan?.total||1" step=".01" :value="elapsed" :disabled="!ready" aria-label="产线联动流程进度" @input="playing=false;elapsed=Number($event.target.value)"></label><span>{{ elapsed.toFixed(1) }} / {{ plan?.total||0 }} 秒</span></footer>
  </div>
 </section>
</template>
<style scoped>
.view-navigation{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:0 16px 12px;border-bottom:1px solid #e6edf4}.view-modes{display:flex;gap:3px;background:#eff4f9;border-radius:9px;padding:3px}.view-modes button{font-size:calc(12px * var(--admin-font-scale, 1));padding:7px 10px;border:0;background:transparent}.view-modes [aria-pressed=true]{background:#fff;color:#2675dc;box-shadow:0 1px 5px #233c5515}.device-location{display:flex;align-items:center;gap:8px;font-size:calc(12px * var(--admin-font-scale, 1));min-width:0;color:#71869b}.device-location select{width:200px;max-width:100%;padding:7px 9px;font-size:calc(12px * var(--admin-font-scale, 1))}.navigation-hint{font-size:calc(11px * var(--admin-font-scale, 1));color:#8297aa}.preview .stage{min-height:380px}.canvas :deep(canvas){touch-action:none}
.controls{overflow:hidden!important}.control-body{display:flex;flex:1;flex-direction:column;gap:12px;min-height:0;overflow-y:auto;padding-right:2px}.controls>.playback{flex-shrink:0}
.line-sequence{display:grid;flex:1;grid-template-columns:minmax(300px,.62fr) minmax(0,1.7fr);gap:16px;min-height:0;color:#2d455c}.controls,.preview{background:#fff;border:1px solid #dce6ef;border-radius:14px;min-width:0;overflow:hidden}.controls{display:flex;flex-direction:column;gap:12px;padding:16px;overflow-y:auto}.controls>header,.preview>header{display:flex;align-items:center;justify-content:space-between;gap:10px}h3{margin:0;font-size:calc(17px * var(--admin-font-scale, 1))}.controls>header span{font-size:calc(11px * var(--admin-font-scale, 1));border-radius:15px;background:#edf5fc;color:#367fba;padding:5px 9px}.field{display:grid;gap:7px;font-size:calc(12px * var(--admin-font-scale, 1));color:#71869b}button,select,input[type=text],.selection-tools input{border:1px solid #d5e0eb;border-radius:8px;padding:9px 10px;background:white;color:#365975;min-width:0}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}input[type=checkbox]{accent-color:#287de5}select{width:100%}.tabs{display:flex;gap:6px;background:#eff4f9;padding:4px;border-radius:10px}.tabs button{flex:1;border:0;background:transparent;font-weight:600}.tabs [aria-pressed=true]{background:#fff;color:#2675dc;box-shadow:0 2px 6px #233c5510}.selection-tools{display:flex;gap:6px}.selection-tools input{flex:1;width:100px}.hint{font-size:calc(11px * var(--admin-font-scale, 1));line-height:1.6;color:#8297aa;margin:0}.problem{font-size:calc(12px * var(--admin-font-scale, 1));color:#be3838}.equipment-list{display:grid;gap:7px}.equipment-list article{display:flex;align-items:center;gap:6px;border:1px solid #e0e8f0;border-radius:9px;padding:10px}.equipment-list article.selected{background:#f0f7ff;border-color:#91b9ef}.equipment-list label{display:flex;align-items:center;gap:9px;flex:1;min-width:0;cursor:pointer}.equipment-list label span{display:grid;gap:4px;min-width:0}strong{font-size:calc(13px * var(--admin-font-scale, 1))}small{font-size:calc(11px * var(--admin-font-scale, 1));color:#8b9eaf}em{font-size:calc(10px * var(--admin-font-scale, 1));font-style:normal;color:#5683a7}.order{display:flex;gap:3px;align-items:center}.order span{font-size:calc(10px * var(--admin-font-scale, 1))}.order button{padding:4px 6px}.pagination{display:flex;justify-content:end;gap:6px;align-items:center;font-size:calc(11px * var(--admin-font-scale, 1));color:#8195a8}.pagination span{margin-right:auto}.pagination button{padding:5px 8px}.check{font-size:calc(12px * var(--admin-font-scale, 1));display:flex;align-items:center;gap:7px}.playback{display:flex;gap:7px;margin-top:auto}.playback .primary{flex:1;color:white;background:#2d7be5;border:0;font-weight:600}.playback select{width:70px}.step-info{display:grid;gap:6px}.steps{list-style:none;padding:0;margin:0;display:grid;gap:8px}.steps li{border:1px solid #e0e9f1;border-radius:9px}.steps .active{background:#edf5ff;border-color:#5b9bf3}.steps button{border:0;background:transparent;text-align:left;width:100%;display:grid;gap:6px;padding:13px}.preview{display:flex;flex-direction:column}.preview>header{padding:16px;flex-wrap:wrap;gap:12px}.preview>header>div:first-child{display:grid;gap:5px}.preview>header strong{font-size:calc(17px * var(--admin-font-scale, 1))}.preview-tools{display:flex;align-items:center;gap:8px;font-size:calc(11px * var(--admin-font-scale, 1));flex-wrap:wrap}.preview-tools button{font-size:calc(11px * var(--admin-font-scale, 1));padding:7px 9px}.stage{position:relative;flex:1;min-height:450px}.canvas{position:absolute;inset:0}.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:#eff4f7;text-align:center;padding:20px;color:#728da2}.empty span{font-size:calc(12px * var(--admin-font-scale, 1))}.hud{position:absolute;left:14px;right:14px;bottom:14px;padding:13px 16px;border-radius:10px;background:#223f54ed;color:#fff;display:grid;gap:7px;pointer-events:none}.hud small,.hud span{color:#bbd5e5;font-size:calc(11px * var(--admin-font-scale, 1))}footer{padding:15px;display:flex;align-items:center;gap:12px;font-size:calc(12px * var(--admin-font-scale, 1));color:#7a92a7}footer label{display:flex;gap:9px;align-items:center;flex:1}footer input{flex:1;min-width:40px;accent-color:#3387db}footer span{font-variant-numeric:tabular-nums;white-space:nowrap}@media(max-width:1000px){.line-sequence{grid-template-columns:300px minmax(0,1fr)}.preview-tools{gap:4px}}@media(max-width:760px){.line-sequence{display:flex;flex-direction:column;overflow:auto}.controls{overflow:visible;flex-shrink:0}.preview{min-height:550px;flex-shrink:0}}
</style>
