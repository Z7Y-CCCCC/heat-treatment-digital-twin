<script setup>
import { computed } from 'vue'
import { findBoundPoint, pointKey } from '../../../runtime/pointBinding.js'
const props=defineProps({binding:Object,devices:Array,points:Array,values:Object,deviceId:String,sourceMode:String,error:String,disabled:Boolean})
const emit=defineEmits(['select-point','preview-device','refresh'])
const choices=computed(()=>(props.points || []).filter(p=>String(p.device_id)===props.deviceId && String(p.access_type || 'READ').toUpperCase()==='READ'))
const bound=computed(()=>findBoundPoint(props.binding,props.deviceId,props.points || []))
const missingDevice=computed(()=>!!props.deviceId && !(props.devices || []).some(device=>String(device.id)===String(props.deviceId)))
const missingPoint=computed(()=>!!props.binding?.pointId && !bound.value)
const pointSelection=computed(()=>bound.value ? String(bound.value.id) : missingPoint.value ? String(props.binding.pointId) : '')
const reading=computed(()=>bound.value ? props.values?.[`${props.deviceId}:${bound.value.id}`] || props.values?.[String(bound.value.id)] : null)
const mode=computed(()=>({'simulation':'内置模拟器','integrated_plc':'实时采集进程','external':'外部接口'})[props.sourceMode] || '尚未连接数据引擎')
const time=computed(()=>reading.value?.lastReadAt ? new Date(reading.value.lastReadAt).toLocaleString('zh-CN',{hour12:false}) : '尚未读取')
</script>
<template>
<section class="point-binding-editor" aria-label="设备采集点位绑定">
 <div class="source-line" :class="{simulation:sourceMode==='simulation'}"><span>当前工厂数据源</span><strong>{{mode}}</strong></div>
 <label>预览设备<select :value="deviceId" aria-label="点位预览设备" :disabled="disabled && binding.deviceScope==='fixed'" @change="emit('preview-device',$event.target.value)"><option value="">请选择设备</option><option v-if="missingDevice" :value="deviceId" disabled>已删除或不可用：{{deviceId}}</option><option v-for="device in devices" :key="device.id" :value="String(device.id)">{{device.name}}</option></select></label>
 <label>采集点位（只读）<select :value="pointSelection" aria-label="绑定采集点位" :disabled="disabled || !choices.length" @change="emit('select-point',$event.target.value)"><option value="">请选择点位</option><option v-if="missingPoint" :value="String(binding.pointId)" disabled>原绑定已删除或不可用：{{binding.pointId}}</option><option v-for="point in choices" :key="point.id" :value="String(point.id)">{{point.label || point.name}} · {{point.plc_tag || '地址未配置'}}{{point.unit ? ' · '+point.unit : ''}}</option></select></label>
 <p v-if="missingDevice" class="missing" role="status">原绑定设备已删除或当前工厂不可用。组件及原绑定已保留，请选择其他设备和点位，或删除不再需要的组件；不会自动读取其他设备。</p>
 <p v-else-if="missingPoint" class="missing" role="status">原绑定点位已删除或不可用。请选择实际采集点位；不会按同名点位自动替换固定绑定。</p>
 <p v-else-if="!choices.length" class="missing" role="status">该设备没有采集点位，请先在“点位映射”配置。未配置时不生成曲线。</p>
 <p v-else-if="!bound" class="missing" role="status">尚未绑定有效点位，不使用设备示例字段替代。</p>
 <dl v-if="bound"><dt>点位名称</dt><dd>{{bound.label || bound.name}}</dd><dt>PLC 地址</dt><dd>{{bound.plc_tag || '未配置'}}</dd><dt>当前读数</dt><dd>{{reading?.quality==='good' && reading?.value!=null ? reading.value : '—'}} {{bound.unit}}</dd><dt>质量</dt><dd>{{({good:'正常',stale:'数据过期',bad:'异常'})[reading?.quality] || '尚无数据'}}</dd><dt>采样时间</dt><dd>{{time}}</dd></dl>
 <button type="button" @click="emit('refresh')">读取后台最新值</button><small v-if="error" role="alert">{{error}}</small>
 <details v-if="bound"><summary>技术字段</summary><code>{{pointKey(bound)}} · ID {{bound.id}}</code></details>
</section>
</template>
<style scoped>
.point-binding-editor{display:grid;gap:12px;padding:12px;border:1px solid #dce5f1;border-radius:9px;background:#f8faff;color:#50657f;font-size:calc(12px * var(--admin-font-scale, 1))}.point-binding-editor label{display:grid;gap:6px}.point-binding-editor select{width:100%;padding:8px;border:1px solid #d5dfed;background:white;border-radius:6px;color:#344a66;font:inherit;min-width:0}.source-line{display:grid;gap:5px;border-bottom:1px solid #e2e8f0;padding-bottom:10px}.source-line span{font-size:calc(10px * var(--admin-font-scale, 1));color:#8b99ab}.source-line strong{color:#297359;font-size:calc(12px * var(--admin-font-scale, 1))}.source-line.simulation strong{color:#a26f15}.missing{margin:0;color:#986c2d;font-size:calc(11px * var(--admin-font-scale, 1));line-height:1.6}dl{display:grid;grid-template-columns:66px 1fr;gap:8px;margin:0;font-size:calc(11px * var(--admin-font-scale, 1))}dt{color:#8b99ab}dd{margin:0;word-break:break-all;color:#344a66}button{border:1px solid #ccdced;border-radius:7px;background:white;padding:8px;color:#3567ac;cursor:pointer;font:inherit}small{color:#b35649}details{font-size:calc(10px * var(--admin-font-scale, 1));color:#8d9cb0}summary{cursor:pointer}code{display:block;margin-top:8px;overflow-wrap:anywhere}
</style>
