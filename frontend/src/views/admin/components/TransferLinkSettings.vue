<script setup>
import {computed} from 'vue'
import {defaultTransferLink} from '../../../../../shared/transferLinkConfig.mjs'
import {defaultTransferCycle} from '../../../../../shared/transferCycleConfig.mjs'
import MotionDataPicker from './MotionDataPicker.vue'
const props=defineProps({value:Object,capabilities:{type:Object,default:()=>({})},catalog:{type:Object,default:()=>({items:[]})},disabled:Boolean})
const emit=defineEmits(['update','refresh'])
const transfer=computed(()=>({...defaultTransferLink(),...props.value}))
const cycle=computed(()=>({...defaultTransferCycle(),...transfer.value.cycle}))
const actions=computed(()=>props.capabilities.actions||[])
const action=computed(()=>actions.value.find(row=>row.id===transfer.value.actionId))
const targets=computed(()=>props.capabilities.targetDevices||[])
function update(field,value){if(!props.disabled)emit('update',{...transfer.value,[field]:value})}
function chooseAction(value){if(!props.disabled)emit('update',{...transfer.value,actionId:value,driveNodeName:''})}
function number(field,value){update(field,value===''?'':Number(value))}
function size(index,value){const values=[...transfer.value.materialSize];values[index]=value===''?'':Number(value);update('materialSize',values)}
function choosePresence(item){if(props.disabled||!props.catalog.items?.some(source=>source.id===item?.id&&source.motionReady===true&&source.type==='boolean'&&['plc','dataset'].includes(source.binding?.mode)))return;update('presenceDataItemId',item.id)}
function clearPresence(){if(!props.disabled)emit('update',{...transfer.value,presenceDataItemId:'',enabled:false})}
function updateCycle(field,value){if(!props.disabled)emit('update',{...transfer.value,cycle:{...cycle.value,[field]:value}})}
function cycleSource(name,item){if(props.disabled||item?.type!=='boolean'||item.motionReady!==true)return;updateCycle(name+'DataItemId',item.id)}
function stationField(index,field,value){const stations=cycle.value.stations.map((s,i)=>i===index?{...s,[field]:value}:s);updateCycle('stations',stations)}
function stationCoordinate(index,axis,value){const p=[...cycle.value.stations[index].seatNodeLocal];p[axis]=Number(value);stationField(index,'seatNodeLocal',p)}
function importStations(){updateCycle('stations',(props.capabilities.sourceMovement?.stations||[]).map(s=>cycle.value.stations.find(c=>c.value===s.value&&c.targetDeviceId===s.anchorDeviceId)||{value:s.value,targetDeviceId:String(s.anchorDeviceId||''),side:'primary',presencePointId:'',seatNodeName:'',seatNodeLocal:[0,0,0]}))}
function homeCoordinate(axis,value){const p=[...cycle.value.cartHome];p[axis]=Number(value);updateCycle('cartHome',p)}
</script>
<template>
 <fieldset class="transfer-settings" :disabled="disabled" aria-label="实时进出料联动设置">
  <label class="enable-transfer"><span>启用实时进出料联动</span><input :checked="transfer.enabled" type="checkbox" aria-label="启用实时进出料联动" @change="update('enabled',$event.target.checked)"></label>
  <div class="transfer-grid">
   <label>送料位置动作<select :value="transfer.actionId" aria-label="联动送料动作" @change="chooseAction($event.target.value)"><option value="">请选择已配置的位置动作</option><option v-for="item in actions" :key="item.id" :value="item.id">{{item.label}}</option></select></label>
   <label>承料移动节点<select :value="transfer.driveNodeName" aria-label="联动承料节点" @change="update('driveNodeName',$event.target.value)"><option value="">请选择实际移动节点</option><option v-for="name in action?.driveNodes||[]" :key="name" :value="name">{{name}}</option></select></label>
   <label>来源送料基准<select :value="transfer.sourcePort" aria-label="联动来源进出料口" @change="update('sourcePort',$event.target.value)"><option v-for="kind in ['inlet','outlet']" :key="kind" :value="kind" :disabled="!capabilities.sourcePorts?.[kind]">{{kind==='inlet'?'进料口':'出料口'}}{{capabilities.sourcePorts?.[kind]?'':'（尚未配置）'}}</option></select></label>
   <label>目标送料基准<select :value="transfer.targetPort" aria-label="联动目标进出料口" @change="update('targetPort',$event.target.value)"><option value="inlet">进料口</option><option value="outlet">出料口</option></select></label>
   <label>目标设备来源<select :value="transfer.targetMode" aria-label="联动目标方式" @change="update('targetMode',$event.target.value)"><option value="fixed">指定固定设备</option><option value="station">当前工位关联的设备</option></select></label>
   <label v-if="transfer.targetMode==='fixed'">目标固定设备<select :value="transfer.targetDeviceId" aria-label="联动目标设备" @change="update('targetDeviceId',$event.target.value)"><option value="">请选择当前工厂固定设备</option><option v-for="target in targets" :key="target.id" :value="target.id" :disabled="!target.ports?.[transfer.targetPort]">{{target.name}}{{target.ports?.[transfer.targetPort]?'':'（送料口未配置）'}}</option></select></label>
  </div>
  <div class="presence-field">物料在位反馈<MotionDataPicker :catalog="catalog" :data-item-id="transfer.presenceDataItemId" :disabled="disabled" clear-label="解除物料在位反馈" clear-hint="同时停用联动" @select="choosePresence" @clear="clearPresence" @refresh="emit('refresh')" /></div>
  <div class="transfer-grid">
   <label>允许高度偏差（米）<input :value="transfer.heightToleranceMeters" type="number" min="0" max="1" step=".01" aria-label="联动高度允许偏差" @input="number('heightToleranceMeters',$event.target.value)"></label>
   <label>允许横向偏差（米）<input :value="transfer.lateralToleranceMeters" type="number" min="0" max="1" step=".01" aria-label="联动横向允许偏差" @input="number('lateralToleranceMeters',$event.target.value)"></label>
   <label>允许方向偏差（度）<input :value="transfer.angleToleranceDegrees" type="number" min="0" max="30" step="1" aria-label="联动方向允许偏差" @input="number('angleToleranceDegrees',$event.target.value)"></label>
   <label>物料示意颜色<input :value="transfer.materialColor" type="color" aria-label="联动物料颜色" @input="update('materialColor',$event.target.value)"></label>
   <label v-for="(axis,index) in ['宽','高','深']" :key="axis">物料{{axis}}（米）<input :value="transfer.materialSize[index]" type="number" min=".01" max="50" step=".05" :aria-label="'联动物料'+axis" @input="size(index,$event.target.value)"></label>
  </div>
  <fieldset class="cycle-settings" aria-label="双侧进出料循环">
   <label class="enable-transfer"><span>双侧送料 / 取料循环（Three.js 与 Unity 同源）</span><input type="checkbox" :checked="cycle.enabled" aria-label="启用双侧进出料循环" @change="updateCycle('enabled',$event.target.checked)"></label>
   <template v-if="cycle.enabled">
    <p>本循环统一驱动两侧送料与脱钩，启用后停用这四项的独立动作绑定。中间姿态按时长估算；物料交接必须等待车上和设备内两个 BOOL 在位反馈确认，估算完成不等于实际交接。</p>
    <div class="presence-field">循环命令 BOOL（上升沿触发）<MotionDataPicker :catalog="catalog" :data-item-id="cycle.startDataItemId" :disabled="disabled" @select="item=>cycleSource('start',item)" @clear="updateCycle('startDataItemId','')" @refresh="emit('refresh')" /></div>
    <div class="presence-field">取料 / 送料 BOOL（true 取料，false 送料）<MotionDataPicker :catalog="catalog" :data-item-id="cycle.pickupDataItemId" :disabled="disabled" @select="item=>cycleSource('pickup',item)" @clear="updateCycle('pickupDataItemId','')" @refresh="emit('refresh')" /></div>
    <div class="transfer-grid"><label v-for="[key,label] in [['extendSeconds','伸链显示时长'],['latchSeconds','脱钩 / 勾合显示时长'],['retractSeconds','退链显示时长'],['conveySeconds','设备辊道接料显示时长'],['confirmTimeoutSeconds','等待反馈超时']]" :key="key">{{label}}（秒）<input type="number" min=".1" max="120" step=".1" :aria-label="label" :value="cycle[key]" @input="updateCycle(key,Number($event.target.value))"></label></div>
    <div class="transfer-grid"><label v-for="(axis,index) in ['X','Y','Z']" :key="axis">车上承料位 {{axis}}（模型本地坐标）<input type="number" step=".001" :value="cycle.cartHome[index]" @input="homeCoordinate(index,$event.target.value)"></label></div>
    <button type="button" :disabled="disabled" @click="importStations">从已有移动配置导入工位（节点需标定）</button>
    <article v-for="(station,index) in cycle.stations" :key="station.value" class="cycle-station">
     <strong>{{station.value}} 号工位 · {{targets.find(t=>t.id===station.targetDeviceId)?.name||station.targetDeviceId}}</strong>
     <div class="transfer-grid">
      <label>送料侧<select :value="station.side" :aria-label="`${station.value}号工位送料侧`" @change="stationField(index,'side',$event.target.value)"><option value="primary">正侧（原机构 −X）</option><option value="opposite">反侧（固定反向机构 +X）</option></select></label>
      <label>设备内物料在位 BOOL<select :value="station.presencePointId" :aria-label="`${station.value}号工位物料在位反馈`" @change="stationField(index,'presencePointId',$event.target.value)"><option value="">请选择该设备的只读 BOOL</option><option v-for="p in targets.find(t=>t.id===station.targetDeviceId)?.presencePoints||[]" :key="p.id" :value="String(p.id)">{{p.label||p.name}} · {{p.id}}</option></select></label>
      <label>设备内承料节点<input :value="station.seatNodeName" :aria-label="`${station.value}号工位承料节点`" @input="stationField(index,'seatNodeName',$event.target.value)"></label>
      <label v-for="(axis,i) in ['X','Y','Z']" :key="axis">承料节点内 {{axis}}<input type="number" step=".001" :value="station.seatNodeLocal[i]" @input="stationCoordinate(index,i,$event.target.value)"></label>
     </div>
    </article>
   </template>
  </fieldset>
  <small>在位反馈只接受真实开关量。中间动作只是显示估算，不是实际行程百分比。轨道、送料口或承料高度不可达时冻结交接，不拉长推链，也不旋转整个车体。</small>
 </fieldset>
</template>
<style scoped>
.transfer-settings{display:grid;gap:14px;margin:16px 0 0;padding:0;border:0;min-width:0;font-size:calc(12px * var(--admin-font-scale,1));color:#32455b}
.transfer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.transfer-settings label{display:grid;gap:7px;min-width:0}.enable-transfer{display:flex!important;align-items:center;justify-content:space-between;font-weight:600}
.transfer-settings input:not([type=checkbox]),.transfer-settings select{box-sizing:border-box;width:100%;min-width:0;padding:9px 10px;border:1px solid #d4dce8;border-radius:7px;background:#fafbfe;color:inherit;font:inherit}
.transfer-settings small{color:#7d899b;line-height:1.6}.transfer-settings button{justify-self:start;padding:7px 10px;border:1px solid #d4dce8;border-radius:7px;background:white;color:inherit;font:inherit}
.cycle-settings{display:grid;gap:12px;min-width:0;margin:4px 0;padding:12px;border:1px solid #d4dce8;border-radius:8px}.cycle-settings p{line-height:1.6;margin:0}.cycle-station{display:grid;gap:10px;padding:10px;border-top:1px solid #d4dce8}
.transfer-settings:disabled{opacity:.7}@media(max-width:700px){.transfer-grid{grid-template-columns:1fr}}
</style>

