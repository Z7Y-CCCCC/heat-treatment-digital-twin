<script setup>
import {computed} from 'vue'
import {defaultTransferLink} from '../../../../../shared/transferLinkConfig.mjs'
import MotionDataPicker from './MotionDataPicker.vue'
const props=defineProps({value:Object,capabilities:{type:Object,default:()=>({})},catalog:{type:Object,default:()=>({items:[]})},disabled:Boolean})
const emit=defineEmits(['update','refresh'])
const transfer=computed(()=>({...defaultTransferLink(),...props.value}))
const actions=computed(()=>props.capabilities.actions||[])
const action=computed(()=>actions.value.find(row=>row.id===transfer.value.actionId))
const targets=computed(()=>props.capabilities.targetDevices||[])
function update(field,value){if(!props.disabled)emit('update',{...transfer.value,[field]:value})}
function chooseAction(value){if(!props.disabled)emit('update',{...transfer.value,actionId:value,driveNodeName:''})}
function number(field,value){update(field,value===''?'':Number(value))}
function size(index,value){const values=[...transfer.value.materialSize];values[index]=value===''?'':Number(value);update('materialSize',values)}
function choosePresence(item){if(props.disabled||!props.catalog.items?.some(source=>source.id===item?.id&&source.motionReady===true&&source.type==='boolean'&&['plc','dataset'].includes(source.binding?.mode)))return;update('presenceDataItemId',item.id)}
function clearPresence(){if(!props.disabled)emit('update',{...transfer.value,presenceDataItemId:'',enabled:false})}
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
  <small>在位反馈只接受本设备的真实开关量。物料随实际节点移动；交接口超出真实行程、高度或方向不匹配时不模拟交接。工位关联、轨道间距与送料口均在各自已有设置中保存。</small>
 </fieldset>
</template>
<style scoped>
.transfer-settings{display:grid;gap:14px;margin:16px 0 0;padding:0;border:0;min-width:0;font-size:calc(12px * var(--admin-font-scale,1));color:#32455b}
.transfer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.transfer-settings label{display:grid;gap:7px;min-width:0}.enable-transfer{display:flex!important;align-items:center;justify-content:space-between;font-weight:600}
.transfer-settings input:not([type=checkbox]),.transfer-settings select{box-sizing:border-box;width:100%;min-width:0;padding:9px 10px;border:1px solid #d4dce8;border-radius:7px;background:#fafbfe;color:inherit;font:inherit}
.transfer-settings small{color:#7d899b;line-height:1.6}.transfer-settings button{justify-self:start;padding:7px 10px;border:1px solid #d4dce8;border-radius:7px;background:white;color:inherit;font:inherit}
.transfer-settings:disabled{opacity:.7}@media(max-width:700px){.transfer-grid{grid-template-columns:1fr}}
</style>

