<script setup>
import { computed, ref, watch } from 'vue'
import DataCatalogPicker from './DataCatalogPicker.vue'
import { EVENT_BINDING, legacyWorkflow, sourceFromCatalog, workflowIssues } from '../../../../../shared/widgetBindingWorkflow.mjs'
import { effectiveMetricItems } from '../../../runtime/widgetContentConfig.js'

const props=defineProps({widget:Object,devices:{type:Array,default:()=>[]},points:{type:Array,default:()=>[]},values:Object,factoryId:String,previewDeviceId:String,disabled:Boolean})
const emit=defineEmits(['change','metric-select','metric-scope','metric-label','metric-label-source','metric-format','add-metric','remove-metric','event-filter'])
const notice=ref('')
// Live PLC samples repaint this entire template. Preserve native input text
// until the edit is committed instead of patching it back to the old model
// between input and blur/change.
const secondsDraft=ref({})
const formatDraft=ref({})
const labelModeDraft=ref({})
const catalogNames=ref({tables:{},items:{}})
watch(()=>props.factoryId,()=>{catalogNames.value={tables:{},items:{}}})
watch(()=>[props.widget.id,props.factoryId],()=>{formatDraft.value={};labelModeDraft.value={}})
const alarmType=computed(()=>['alarm_list','hud_alarm_panel','marquee'].includes(props.widget.type))
const panelType=computed(()=>['metrics','hud_kpi_panel'].includes(props.widget.type))
const metricItems=computed(()=>effectiveMetricItems(props.widget.content || {}))
const raw=computed(()=>props.widget.data || {})
// Old event widgets sometimes retain a device display mode although events
// have always been a factory-wide source. Project the actual source into the
// existing controls; inspecting it must not rewrite the saved document.
const effective=computed(()=>alarmType.value && (raw.value.mode==='static' || raw.value.mode==='runtime' && (raw.value.source || raw.value.path)==='events') ? {...raw.value,...EVENT_BINDING} : raw.value)
const draft=computed(()=>legacyWorkflow(effective.value,props.devices,props.points))
const scope=computed(()=>effective.value.deviceScope || 'current')
const rows=computed(()=>effective.value.mode==='static' ? [] : draft.value.deviceBindings || [])
const shownRows=computed(()=>scope.value==='fixed' ? rows.value.map((row,index)=>({row,index})).filter(({row})=>row.deviceId===String(effective.value.deviceId)) : rows.value.map((row,index)=>({row,index})))
const issues=computed(()=>workflowIssues(draft.value))
const availableDevices=computed(()=>props.devices.filter(d=>!rows.value.some(row=>row.deviceId===String(d.id))))
const displayModes=[
 {id:'current',label:'显示当前查看设备的数据',hint:'点击哪台设备就读哪台；未选择设备时不显示数据，不自动轮播。'},
 {id:'fixed',label:'始终显示指定设备的数据',hint:'只读取指定设备；切换视角或点击其他设备不会换来源。'},
 {id:'rotation',label:'按清单轮播数据',hint:'按下面清单顺序轮流读取，每台设备分别选择对应的数据表和数据项。'}
]
const runtimeMetricFields=[
 {path:'metrics.current_output',label:'今日产出'}, {path:'metrics.progress_percent',label:'完成进度'},
 {path:'metrics.energy_consumption',label:'能耗估算'}, {path:'metrics.online_devices',label:'在线设备'},
 {path:'metrics.total_devices',label:'设备总数'}, {path:'metrics.daily_target',label:'生产目标'},
 {path:'metrics.overall_oee',label:'综合设备效率'}, {path:'metrics.running_devices',label:'运行设备'},
 {path:'metrics.alarm_devices',label:'报警设备'}
]
function copy(){return JSON.parse(JSON.stringify(draft.value))}
function commit(value){if(props.disabled)return;notice.value='';emit('change',value)}
function mode(id){
 const value=copy();value.deviceScope=id
 if(value.mode==='static') {value.mode='plc';value.requireConfiguredPoint=true;value.pointId='';value.pointKey='';value.path='';if(raw.value.bindingVersion!==2)value.deviceBindings=[]}
 if(id==='fixed')value.deviceId=String(value.deviceId || value.deviceBindings[0]?.deviceId || props.previewDeviceId || props.devices[0]?.id || '')
 if(!value.deviceBindings.length && id!=='global')value.deviceBindings.push({deviceId:String(value.deviceId || props.previewDeviceId || props.devices[0]?.id || ''),binding:null})
 value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId)
 commit(value)
}
function fixedDevice(id){const value=copy();value.deviceId=id;if(!value.deviceBindings.some(row=>row.deviceId===id))value.deviceBindings.push({deviceId:id,binding:null});value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId);commit(value)}
function add(){if(!availableDevices.value.length)return;const value=copy();value.deviceBindings.push({deviceId:String(availableDevices.value[0].id),binding:null});value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId);commit(value)}
function remove(index){const value=copy();value.deviceBindings.splice(index,1);value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId);commit(value)}
function move(index,offset){const value=copy();const to=index+offset;if(to<0||to>=value.deviceBindings.length)return;[value.deviceBindings[index],value.deviceBindings[to]]=[value.deviceBindings[to],value.deviceBindings[index]];value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId);commit(value)}
function device(index,id){if(rows.value.some((row,i)=>i!==index&&row.deviceId===id)){notice.value='同一设备已经在清单中，请修改原行的数据。';return}const value=copy();value.deviceBindings[index]={deviceId:id,binding:null};value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId);if(scope.value==='fixed')value.deviceId=id;commit(value)}
function select(index,item){
 if(item?.binding?.deviceScope==='global'){commit({...copy(),...item.binding,bindingVersion:2,readOnly:true});return}
 const value=copy(),row=value.deviceBindings[index]
 if(!row)return
 row.binding=item ? sourceFromCatalog(item) : null
 const first=value.deviceBindings.find(row=>row.binding)?.binding
 Object.assign(value,{mode:first?.mode || 'plc',pointId:first?.pointId || '',pointKey:first?.pointKey || '',path:first?.path || '',datasetId:first?.datasetId || '',datasetField:first?.datasetField || '',unit:first?.unit || '',requireConfiguredPoint:true,readOnly:true})
 value.rotationDeviceIds=value.deviceBindings.map(row=>row.deviceId)
 commit(value)
}
function globalSource(item){if(props.disabled || !item)return;if(item.binding?.deviceScope!=='global'){notice.value='工厂范围主来源只能选择明确的工厂范围数据表。';return}commit({...copy(),...item.binding,unit:item.unit || '',bindingVersion:2,readOnly:true})}
function unbind(){const value=copy();Object.assign(value,{mode:'static',pointId:'',pointKey:'',path:'',source:'',datasetId:'',datasetField:'',connectionId:''});commit(value)}
function secondsValue(key){return secondsDraft.value[key] ?? (effective.value[key] || (key==='rotationIntervalMs'?10000:5000))/1000}
function inputSeconds(key,event){
 if(props.disabled)return
 const text=String(event.target.value);secondsDraft.value[key]=text
 const n=Number(text),minimum=key==='rotationIntervalMs'?2:.25
 if(!text.trim() || !Number.isFinite(n) || n<minimum || n>3600)return
 const value=copy();value[key]=Math.round(n*1000);commit(value)
}
function seconds(key,event){
 if(props.disabled)return
 const text=String(event.target.value);delete secondsDraft.value[key]
 const n=Number(text);if(!text.trim() || !Number.isFinite(n))return
 const value=copy();value[key]=Math.max(key==='rotationIntervalMs'?2000:250,Math.min(3600000,Math.round(n*1000)));commit(value)
}
function deviceName(id){return props.devices.find(d=>String(d.id)===String(id))?.name || `已移除的设备：${id}`}
function ownedPoint(row){return props.points.find(p=>String(p.id)===String(row.binding?.pointId) && String(p.device_id)===String(row.deviceId))}
function sourceSummary(row){const point=ownedPoint(row);return catalogNames.value.items[row.binding?.catalogItemId] || point?.label || point?.name || row.binding?.datasetField || row.binding?.path || '未选择数据'}
function rememberCatalog(catalog){for(const table of catalog.tables || [])catalogNames.value.tables[table.id]=table.name;for(const item of catalog.items || [])catalogNames.value.items[item.id]=item.label}
function sourceDetails(row){
 const binding=row.binding;if(!binding)return ''
 const table=catalogNames.value.tables[binding.catalogTableId] || ({plc:'设备采集点位',dataset:'数据表',runtime:'设备资料'})[binding.mode] || '数据表'
 if(binding.mode!=='plc')return table
 const point=ownedPoint(row),sample=props.values?.[`${row.deviceId}:${point?.id}`] || props.values?.[String(point?.id || '')]
 const reading=sample && String(sample.id)===String(point?.id) && String(sample.device_id)===String(row.deviceId) ? sample : null
 const quality=({good:'正常',stale:'过期',bad:'异常'})[reading?.quality] || '尚未读取'
 const value=reading?.quality==='good' && reading.value!=null ? `${reading.value}${point?.unit || binding.unit || ''}` : '—'
 return `${table} · ${point?.plc_tag || `点位 ${binding.pointId} 不可用`} · ${value} · ${quality}`
}
function metricBinding(item,deviceId){const source=item.binding || {mode:'runtime',path:item.path || '',deviceScope:'current',rotationDeviceIds:[deviceId],unit:item.unit || ''};const value=legacyWorkflow(source,props.devices,props.points);const selected=value.deviceScope==='global' ? value : value.deviceBindings?.find(row=>row.deviceId===deviceId)?.binding;return {...(selected || {mode:'plc',pointId:'',pointKey:'',path:'',requireConfiguredPoint:true}),deviceScope:'fixed',deviceId}}
function metricSelect(index,deviceId,item){if(!props.disabled)emit('metric-select',{index,deviceId,item})}
function metricScope(item){return item.binding?.deviceScope==='global' || !item.binding && /^metrics\./.test(item.path || '') ? 'global' : 'fixed'}
function metricDevice(item){return item.binding?.deviceScope==='fixed' ? String(item.binding.deviceId || '') : ''}
function globalMetricBinding(item){return metricScope(item)==='fixed' ? metricBinding(item,metricDevice(item)) : item.binding || {mode:'runtime',path:item.path || '',deviceScope:'global'}}
function metricScopeChange(index,value,deviceId){if(!props.disabled)emit('metric-scope',{index,scope:value,deviceId})}
function bindingIdentity(binding={},deviceId=''){return [deviceId,binding.mode,binding.pointId,binding.datasetId,binding.datasetField,binding.path].map(value=>String(value ?? '')).join(':')}
function mainFormatKey(row,key){return `main:${bindingIdentity(row?.binding || effective.value,row?.deviceId || '')}:${key}`}
function textValue(key,value){return Object.hasOwn(formatDraft.value,key) ? formatDraft.value[key] : String(value ?? '')}
function inputFormat(key,event){if(!props.disabled)formatDraft.value[key]=String(event.target.value)}
function mainFormatValue(row,key){const source=row ? row.binding : effective.value;if(!source)return '';return source[key] ?? (row ? effective.value[key] : undefined) ?? (key==='decimals'?'':'')}
function commitMainFormat(rowIndex,key,event){
 if(props.disabled)return
 const row=rowIndex===null ? null : rows.value[rowIndex]
 if(rowIndex!==null && !row?.binding)return
 const value=copy(),source=rowIndex===null ? value : value.deviceBindings?.[rowIndex]?.binding
 if(!source)return
 const rawText=String(event.target.value)
 if(key==='decimals'){
  if(rawText==='')delete source.decimals
  else {const number=Number(rawText);if(!Number.isInteger(number)||number<0||number>8)return;source.decimals=number}
 } else if(key==='unit') {source.unit=rawText;source.unitPath=''}
 else if(key==='unitPath') {source.unitPath=rawText.trim();source.unit=''}
 else return
 commit(value);delete formatDraft.value[mainFormatKey(row,key)]
}
function metricSource(item,deviceId=''){
 const binding=item.binding
 if(!binding)return null
 if(binding.bindingVersion!==2 || binding.deviceScope==='global')return binding
 const row=binding.deviceBindings?.find(row=>String(row.deviceId)===String(deviceId))
 return row?.binding ? {...binding,...row.binding} : null
}
function metricFormatKey(index,item,deviceId,key){return `metric:${index}:${bindingIdentity(metricSource(item,deviceId) || {path:item.path},deviceId)}:${key}`}
function metricFormatValue(item,deviceId,key){
 const source=metricSource(item,deviceId)
 if(key==='decimals')return item.decimals ?? ''
 if(key==='unitPath')return item.unitPath || source?.unitPath || ''
 return source?.unit ?? item.unit ?? ''
}
function staticMetricFormatDisabled(item){const id=metricDevice(item);return metricScope(item)==='fixed' && (!id || item.binding?.bindingVersion===2 && !metricSource(item,id))}
function metricLabelMode(item,index){return labelModeDraft.value[index] || (item.labelPath ? 'field' : 'fixed')}
function metricLabelSource(index,source){
 if(props.disabled || !['fixed','field'].includes(source))return
 labelModeDraft.value[index]=source
 const item=metricItems.value[index]
 if(!item)return
 emit('metric-label-source',{index,source,labelPath:source==='field' ? item.labelPath || '' : ''})
}
function commitMetricLabel(index,item,deviceId,event){
 if(props.disabled)return
 const value=String(event.target.value)
 if(metricLabelMode(item,index)==='field')emit('metric-label-source',{index,source:'field',labelPath:value.trim()})
 else emit('metric-label',{index,value})
 delete formatDraft.value[metricFormatKey(index,item,deviceId,'label')]
}
function commitMetricFormat(index,item,deviceId,key,event){
 if(props.disabled)return
 if(effective.value.mode==='static' && staticMetricFormatDisabled(item))return
 if(key!=='decimals' && item.binding?.bindingVersion===2 && item.binding.deviceScope!=='global' && !metricSource(item,deviceId))return
 if(key!=='decimals' && scope.value==='global' && metricScope(item)==='fixed' && !deviceId)return
 const rawText=String(event.target.value),payload={index,deviceId}
 if(key==='decimals'){
  if(rawText==='')payload.decimals=''
  else {const number=Number(rawText);if(!Number.isInteger(number)||number<0||number>8)return;payload.decimals=number}
 } else if(key==='unit'){payload.unit=rawText;payload.unitPath=''}
 else if(key==='unitPath'){payload.unitPath=rawText.trim();payload.unit=''}
 else return
 emit('metric-format',payload);delete formatDraft.value[metricFormatKey(index,item,deviceId,key)]
}
function runtimeMetricPath(item){return item.binding?.path || item.path || ''}
function runtimeMetricSelect(index,item,event){
 if(props.disabled)return
 const path=String(event.target.value)
 emit('metric-select',{index,deviceId:'',item:{label:item.label || `指标 ${index+1}`,unit:metricFormatValue(item,'','unit'),binding:{mode:'runtime',path,deviceScope:'global',readOnly:true}}})
}
</script>
<template>
 <section class="widget-data-workflow" aria-label="组件数据设置">
  <h4>① {{panelType?'主数据读取方式':'显示方式'}}</h4>
  <div v-if="scope!=='global' || effective.mode==='static'" class="binding-mode-options" role="group" aria-label="组件显示方式">
   <button v-for="option in displayModes" :key="option.id" type="button" :disabled="disabled" :aria-pressed="effective.mode!=='static' && scope===option.id" :class="{selected:effective.mode!=='static' && scope===option.id}" @click="mode(option.id)"><strong>{{option.label}}</strong><small>{{option.hint}}</small></button>
  </div>
  <p v-else class="binding-global-source">{{alarmType?'系统报警／事件记录':'工厂范围主数据'}}</p>
  <p v-if="effective.mode==='static' && !panelType" class="binding-note">当前只显示固定内容；选择显示方式和数据后启用数据绑定。</p>
  <details v-if="panelType && effective.mode==='static'" class="panel-metric-sources" open>
   <summary>面板指标（{{metricItems.length}}）</summary>
   <div v-for="(item,metricIndex) in metricItems" :key="metricIndex" class="panel-metric-source">
    <label>名称来源<select :value="metricLabelMode(item,metricIndex)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 名称来源`" @change="metricLabelSource(metricIndex,$event.target.value)"><option value="fixed">固定名称</option><option value="field">已有字段</option></select></label>
    <label>{{metricLabelMode(item,metricIndex)==='field'?'名称字段':'指标名称'}}<input :value="textValue(metricFormatKey(metricIndex,item,metricDevice(item),'label'),metricLabelMode(item,metricIndex)==='field'?item.labelPath:item.label)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 名称`" @input="inputFormat(metricFormatKey(metricIndex,item,metricDevice(item),'label'),$event)" @change="commitMetricLabel(metricIndex,item,metricDevice(item),$event)" /></label>
    <label>指标数据范围<select :value="metricScope(item)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 数据范围`" @change="metricScopeChange(metricIndex,$event.target.value)"><option value="global">工厂范围字段 / 数据表</option><option value="fixed">指定设备的数据</option></select></label>
    <label v-if="metricScope(item)==='fixed'">指标设备<select :value="metricDevice(item)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 指定设备`" @change="metricScopeChange(metricIndex,'fixed',$event.target.value)"><option value="">请选择指标设备</option><option v-for="d in devices" :key="d.id" :value="String(d.id)">{{d.name}}</option></select></label>
    <label v-if="metricScope(item)==='global' && (!item.binding || item.binding.mode==='runtime')">指标字段<select :value="runtimeMetricPath(item)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 数据字段`" @change="runtimeMetricSelect(metricIndex,item,$event)"><option v-if="!runtimeMetricFields.some(field=>field.path===runtimeMetricPath(item))" :value="runtimeMetricPath(item)">{{runtimeMetricPath(item) || '未配置字段'}}</option><option v-for="field in runtimeMetricFields" :key="field.path" :value="field.path">{{field.label}} · {{field.path}}</option></select></label>
    <DataCatalogPicker v-if="metricScope(item)==='fixed' && metricDevice(item) || metricScope(item)==='global' && item.binding && item.binding.mode!=='runtime'" :binding="globalMetricBinding(item)" :factory-id="factoryId" :device-id="metricDevice(item)" :device-only="metricScope(item)==='fixed'" :global-only="metricScope(item)==='global'" :immediate="true" widget-type="hud_kpi_panel" :values="values" :points="points" :disabled="disabled" @select="metricSelect(metricIndex,metricDevice(item),$event)" @catalog-loaded="rememberCatalog" />
    <div class="binding-format-fields">
     <label>单位<input :value="textValue(metricFormatKey(metricIndex,item,metricDevice(item),'unit'),metricFormatValue(item,metricDevice(item),'unit'))" maxlength="32" :disabled="disabled || staticMetricFormatDisabled(item)" :aria-label="`指标 ${metricIndex+1} 单位`" @input="inputFormat(metricFormatKey(metricIndex,item,metricDevice(item),'unit'),$event)" @change="commitMetricFormat(metricIndex,item,metricDevice(item),'unit',$event)" /></label>
     <label>小数位<select :value="metricFormatValue(item,metricDevice(item),'decimals')" :disabled="disabled || staticMetricFormatDisabled(item)" :aria-label="`指标 ${metricIndex+1} 小数位`" @change="commitMetricFormat(metricIndex,item,metricDevice(item),'decimals',$event)"><option value="">自动</option><option v-for="number in 9" :key="number" :value="number-1">{{number-1}}</option></select></label>
     <label class="format-field-wide">单位字段<input :value="textValue(metricFormatKey(metricIndex,item,metricDevice(item),'unitPath'),metricFormatValue(item,metricDevice(item),'unitPath'))" maxlength="255" :disabled="disabled || staticMetricFormatDisabled(item)" :aria-label="`指标 ${metricIndex+1} 单位字段`" @input="inputFormat(metricFormatKey(metricIndex,item,metricDevice(item),'unitPath'),$event)" @change="commitMetricFormat(metricIndex,item,metricDevice(item),'unitPath',$event)" /></label>
    </div>
    <button type="button" :disabled="disabled" @click="emit('remove-metric',metricIndex)">删除这个指标</button>
   </div>
   <button type="button" :disabled="disabled" @click="emit('add-metric')">＋ 添加指标</button>
  </details>
  <template v-if="scope==='global' && effective.mode!=='static'">
   <h4>② 选择数据表与数据项</h4>
   <DataCatalogPicker :binding="effective" :factory-id="factoryId" :global-only="true" :widget-type="widget.type" :disabled="disabled" @select="globalSource" @catalog-loaded="rememberCatalog" />
   <div v-if="!alarmType && effective.mode!=='static'" class="binding-format-fields">
    <label>单位<input :value="textValue(mainFormatKey(null,'unit'),mainFormatValue(null,'unit'))" maxlength="32" :disabled="disabled" placeholder="跟随数据项" aria-label="主数据单位" @input="inputFormat(mainFormatKey(null,'unit'),$event)" @change="commitMainFormat(null,'unit',$event)" /></label>
    <label>小数位<select :value="mainFormatValue(null,'decimals')" :disabled="disabled" aria-label="主数据小数位" @change="commitMainFormat(null,'decimals',$event)"><option value="">默认</option><option v-for="number in 9" :key="number" :value="number-1">{{number-1}}</option></select></label>
    <label class="format-field-wide">单位字段<input :value="textValue(mainFormatKey(null,'unitPath'),mainFormatValue(null,'unitPath'))" maxlength="255" :disabled="disabled" aria-label="主数据单位字段" @input="inputFormat(mainFormatKey(null,'unitPath'),$event)" @change="commitMainFormat(null,'unitPath',$event)" /></label>
   </div>
   <details v-if="panelType" class="panel-metric-sources global-panel-metrics" open>
    <summary>面板其他指标（{{metricItems.length}}）</summary>
    <p class="binding-note">工厂范围主卡没有当前设备。每个指标须选择工厂范围数据表，或明确指定一台设备；不会继承、轮播或猜测其他设备。</p>
    <div v-for="(item,metricIndex) in metricItems" :key="metricIndex" class="panel-metric-source">
     <label>名称来源<select :value="metricLabelMode(item,metricIndex)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 名称来源`" @change="metricLabelSource(metricIndex,$event.target.value)"><option value="fixed">固定名称</option><option value="field">已有字段</option></select></label>
     <label>{{metricLabelMode(item,metricIndex)==='field'?'名称字段':'指标名称'}}<input :value="textValue(metricFormatKey(metricIndex,item,metricDevice(item),'label'),metricLabelMode(item,metricIndex)==='field'?item.labelPath:item.label)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 名称`" @input="inputFormat(metricFormatKey(metricIndex,item,metricDevice(item),'label'),$event)" @change="commitMetricLabel(metricIndex,item,metricDevice(item),$event)" /></label>
     <label>指标数据范围<select :value="metricScope(item)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 数据范围`" @change="metricScopeChange(metricIndex,$event.target.value)"><option value="global">工厂范围数据表</option><option value="fixed">指定设备的数据</option></select></label>
     <template v-if="metricScope(item)==='fixed'"><label>指标设备<select :value="metricDevice(item)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 指定设备`" @change="metricScopeChange(metricIndex,'fixed',$event.target.value)"><option value="">请选择指标设备，不自动指定</option><option v-for="d in devices" :key="d.id" :value="String(d.id)">{{d.name}}</option></select></label><p v-if="!metricDevice(item)" class="binding-note" role="status">请先明确选择这个指标的设备；当前没有可读取的来源。</p></template>
     <label v-if="metricScope(item)==='global' && /^metrics\./.test(runtimeMetricPath(item))">指标字段<select :value="runtimeMetricPath(item)" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 数据字段`" @change="runtimeMetricSelect(metricIndex,item,$event)"><option v-if="!runtimeMetricFields.some(field=>field.path===runtimeMetricPath(item))" :value="runtimeMetricPath(item)">{{runtimeMetricPath(item)}}</option><option v-for="field in runtimeMetricFields" :key="field.path" :value="field.path">{{field.label}} · {{field.path}}</option></select></label>
     <DataCatalogPicker v-if="metricScope(item)==='global' || metricDevice(item)" :binding="globalMetricBinding(item)" :factory-id="factoryId" :device-id="metricDevice(item)" :device-only="metricScope(item)==='fixed'" :global-only="metricScope(item)==='global'" :immediate="true" widget-type="hud_kpi_panel" :values="values" :points="points" :disabled="disabled" @select="metricSelect(metricIndex,metricDevice(item),$event)" @catalog-loaded="rememberCatalog" />
     <div class="binding-format-fields">
      <label>单位<input :value="textValue(metricFormatKey(metricIndex,item,metricDevice(item),'unit'),metricFormatValue(item,metricDevice(item),'unit'))" maxlength="32" :disabled="disabled || metricScope(item)==='fixed' && !metricDevice(item)" :aria-label="`指标 ${metricIndex+1} 单位`" @input="inputFormat(metricFormatKey(metricIndex,item,metricDevice(item),'unit'),$event)" @change="commitMetricFormat(metricIndex,item,metricDevice(item),'unit',$event)" /></label>
      <label>小数位<select :value="metricFormatValue(item,metricDevice(item),'decimals')" :disabled="disabled" :aria-label="`指标 ${metricIndex+1} 小数位`" @change="commitMetricFormat(metricIndex,item,metricDevice(item),'decimals',$event)"><option value="">自动</option><option v-for="number in 9" :key="number" :value="number-1">{{number-1}}</option></select></label>
      <label class="format-field-wide">单位字段<input :value="textValue(metricFormatKey(metricIndex,item,metricDevice(item),'unitPath'),metricFormatValue(item,metricDevice(item),'unitPath'))" maxlength="255" :disabled="disabled || metricScope(item)==='fixed' && !metricDevice(item)" :aria-label="`指标 ${metricIndex+1} 单位字段`" @input="inputFormat(metricFormatKey(metricIndex,item,metricDevice(item),'unitPath'),$event)" @change="commitMetricFormat(metricIndex,item,metricDevice(item),'unitPath',$event)" /></label>
     </div>
     <button type="button" :disabled="disabled" @click="emit('remove-metric',metricIndex)">删除这个指标</button>
    </div>
    <button type="button" :disabled="disabled" @click="emit('add-metric')">＋ 添加指标</button>
   </details>
   <template v-if="alarmType"><p class="binding-note">读取当前工厂已接收的真实报警／事件记录，不是固定内容，也不生成示例报警。</p><label>记录范围<select :value="widget.content.eventFilters?.scope || 'factory'" :disabled="disabled" aria-label="事件记录范围" @change="emit('event-filter',{...widget.content.eventFilters,scope:$event.target.value})"><option value="factory">当前工厂全部设备</option><option value="current">仅当前查看设备（未选择设备时为空）</option></select></label><label>级别<select :value="widget.content.eventFilters?.level || ''" :disabled="disabled" aria-label="事件记录级别" @change="emit('event-filter',{...widget.content.eventFilters,level:$event.target.value})"><option value="">全部级别</option><option value="info">提示</option><option value="warning">警告</option><option value="error">错误</option><option value="critical">严重</option></select></label></template>
   <button v-if="!alarmType" type="button" :disabled="disabled" @click="mode('fixed')">改为按设备读取</button>
  </template>
  <template v-else>
   <h4>② {{scope==='rotation'?'轮播清单':'设备与对应数据'}}</h4>
   <p v-if="scope==='current' && previewDeviceId && !rows.some(row=>row.deviceId===previewDeviceId)" class="binding-note" role="status">当前预览设备“{{deviceName(previewDeviceId)}}”还没有对应数据；运行时显示缺项，不读取其他设备。可在下面添加该设备。</p>
   <label v-if="scope==='fixed'">指定设备<select :value="effective.deviceId" :disabled="disabled" aria-label="指定数据设备" @change="fixedDevice($event.target.value)"><option value="">请选择设备</option><option v-for="d in devices" :key="d.id" :value="String(d.id)">{{d.name}}</option></select></label>
   <p v-if="raw.bindingVersion!==2 && effective.mode!=='static'" class="binding-note">下方展开原配置的实际点位对应；缺失或存在多个同名候选时保留为空，必须明确选择。未修改前不改变运行配置。</p>
   <details v-for="{row,index} in shownRows" :key="row.deviceId+'-'+index" class="device-data-row" :open="shownRows.length===1 || index===0">
    <summary><b>{{scope==='rotation'?index+1+'. ':''}}{{deviceName(row.deviceId)}}</b><span>{{sourceSummary(row)}}</span><em v-if="!row.binding">缺少数据</em><small v-else class="binding-row-source">{{sourceDetails(row)}}</small></summary>
    <div class="device-data-row-body">
     <label>设备<select :value="row.deviceId" :disabled="disabled" :aria-label="`清单设备 ${index+1}`" @change="device(index,$event.target.value)"><option v-if="!devices.some(d=>String(d.id)===row.deviceId)" :value="row.deviceId" disabled>{{deviceName(row.deviceId)}}</option><option v-for="d in devices" :key="d.id" :value="String(d.id)" :disabled="rows.some((r,i)=>i!==index&&r.deviceId===String(d.id))">{{d.name}}</option></select></label>
     <DataCatalogPicker :key="row.deviceId" :binding="{...row.binding,deviceId:row.deviceId,deviceScope:'fixed'}" :factory-id="factoryId" :device-id="row.deviceId" :device-only="true" :immediate="true" :widget-type="widget.type" :values="values" :points="points" :disabled="disabled" @select="select(index,$event)" @catalog-loaded="rememberCatalog" />
     <div v-if="!alarmType" class="binding-format-fields">
      <label>单位<input :value="textValue(mainFormatKey(row,'unit'),mainFormatValue(row,'unit'))" maxlength="32" :placeholder="ownedPoint(row)?.unit || '跟随数据项'" :disabled="disabled || !row.binding" :aria-label="`设备 ${row.deviceId} 主数据单位`" @input="inputFormat(mainFormatKey(row,'unit'),$event)" @change="commitMainFormat(index,'unit',$event)" /></label>
      <label>小数位<select :value="row.binding?.decimals ?? ''" :disabled="disabled || !row.binding" :aria-label="`设备 ${row.deviceId} 主数据小数位`" @change="commitMainFormat(index,'decimals',$event)"><option value="">继承组件</option><option v-for="number in 9" :key="number" :value="number-1">{{number-1}}</option></select></label>
      <label class="format-field-wide">单位字段<input :value="textValue(mainFormatKey(row,'unitPath'),mainFormatValue(row,'unitPath'))" maxlength="255" :disabled="disabled || !row.binding" :aria-label="`设备 ${row.deviceId} 主数据单位字段`" @input="inputFormat(mainFormatKey(row,'unitPath'),$event)" @change="commitMainFormat(index,'unitPath',$event)" /></label>
     </div>
     <details v-if="panelType" class="panel-metric-sources"><summary>面板其他指标（{{metricItems.length}}）</summary>
      <div v-for="(item,metricIndex) in metricItems" :key="metricIndex" class="panel-metric-source">
       <label>名称来源<select :value="metricLabelMode(item,metricIndex)" :disabled="disabled" :aria-label="`设备 ${row.deviceId} 指标 ${metricIndex+1} 名称来源`" @change="metricLabelSource(metricIndex,$event.target.value)"><option value="fixed">固定名称</option><option value="field">已有字段</option></select></label>
       <label>{{metricLabelMode(item,metricIndex)==='field'?'名称字段':'指标名称'}}<input :value="textValue(metricFormatKey(metricIndex,item,row.deviceId,'label'),metricLabelMode(item,metricIndex)==='field'?item.labelPath:item.label)" :disabled="disabled" :aria-label="`设备 ${row.deviceId} 指标 ${metricIndex+1} 名称`" @input="inputFormat(metricFormatKey(metricIndex,item,row.deviceId,'label'),$event)" @change="commitMetricLabel(metricIndex,item,row.deviceId,$event)" /></label>
       <DataCatalogPicker :binding="metricBinding(item,row.deviceId)" :factory-id="factoryId" :device-id="row.deviceId" :device-only="true" :immediate="true" widget-type="hud_kpi_panel" :values="values" :points="points" :disabled="disabled" @select="metricSelect(metricIndex,row.deviceId,$event)" />
       <div class="binding-format-fields">
        <label>单位<input :value="textValue(metricFormatKey(metricIndex,item,row.deviceId,'unit'),metricFormatValue(item,row.deviceId,'unit'))" maxlength="32" :disabled="disabled || item.binding?.bindingVersion===2 && item.binding?.deviceScope!=='global' && !metricSource(item,row.deviceId)" :aria-label="`设备 ${row.deviceId} 指标 ${metricIndex+1} 单位`" @input="inputFormat(metricFormatKey(metricIndex,item,row.deviceId,'unit'),$event)" @change="commitMetricFormat(metricIndex,item,row.deviceId,'unit',$event)" /></label>
        <label>小数位<select :value="metricFormatValue(item,row.deviceId,'decimals')" :disabled="disabled" :aria-label="`设备 ${row.deviceId} 指标 ${metricIndex+1} 小数位`" @change="commitMetricFormat(metricIndex,item,row.deviceId,'decimals',$event)"><option value="">自动</option><option v-for="number in 9" :key="number" :value="number-1">{{number-1}}</option></select></label>
        <label class="format-field-wide">单位字段<input :value="textValue(metricFormatKey(metricIndex,item,row.deviceId,'unitPath'),metricFormatValue(item,row.deviceId,'unitPath'))" maxlength="255" :disabled="disabled || item.binding?.bindingVersion===2 && item.binding?.deviceScope!=='global' && !metricSource(item,row.deviceId)" :aria-label="`设备 ${row.deviceId} 指标 ${metricIndex+1} 单位字段`" @input="inputFormat(metricFormatKey(metricIndex,item,row.deviceId,'unitPath'),$event)" @change="commitMetricFormat(metricIndex,item,row.deviceId,'unitPath',$event)" /></label>
       </div>
       <button type="button" :disabled="disabled" @click="emit('remove-metric',metricIndex)">删除这个指标</button>
      </div>
      <button type="button" :disabled="disabled" @click="emit('add-metric')">＋ 添加指标</button>
     </details>
     <div class="binding-row-actions"><button v-if="scope==='rotation'" type="button" :disabled="disabled||index===0" @click="move(index,-1)">上移</button><button v-if="scope==='rotation'" type="button" :disabled="disabled||index===rows.length-1" @click="move(index,1)">下移</button><button type="button" :disabled="disabled" @click="remove(index)">移除设备</button></div>
    </div>
   </details>
   <button v-if="scope!=='fixed'" type="button" :disabled="disabled||!availableDevices.length||rows.length>=100" @click="add">＋ 添加设备与对应数据</button>
   <h4>③ {{scope==='rotation'?'轮播周期':'读取设置'}}</h4>
   <label v-if="scope==='rotation'">每项显示（秒）<input :value="secondsValue('rotationIntervalMs')" type="number" min="2" max="3600" :disabled="disabled" aria-label="每项显示秒数" @input="inputSeconds('rotationIntervalMs',$event)" @change="seconds('rotationIntervalMs',$event)" /></label>
   <label v-if="effective.mode==='dataset'">数据表刷新（秒）<input :value="secondsValue('refreshMs')" type="number" min="0.25" max="3600" step="0.25" :disabled="disabled" @input="inputSeconds('refreshMs',$event)" @change="seconds('refreshMs',$event)" /></label>
   <small class="binding-note">PLC 数值随实时采集帧更新，不按轮播周期生成或补造数据。没有配置对应数据时显示缺项。</small>
  </template>
  <ul v-if="issues.length && effective.mode!=='static'" class="binding-issues" aria-label="数据绑定缺项"><li v-for="issue in issues" :key="issue">{{issue}}</li></ul>
  <p v-if="notice" role="alert">{{notice}}</p>
  <button v-if="!alarmType && effective.mode!=='static'" type="button" :disabled="disabled" @click="unbind">{{panelType?'取消主数据绑定（保留指标来源）':'不绑定主数据，显示固定内容（保留设备清单）'}}</button>
 </section>
</template>
<style scoped>
.binding-format-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;min-width:0}.binding-format-fields .format-field-wide{grid-column:1/-1}
.binding-row-source{flex-basis:100%;font-size:10px;color:#657c99;line-height:1.6;overflow-wrap:anywhere}.global-panel-metrics>summary{font-weight:600;color:#415a7a}.global-panel-metrics>.binding-note{margin:8px 0}
.widget-data-workflow{display:grid;gap:12px;min-width:0;color:#41536d;font-size:12px}.widget-data-workflow h4{margin:5px 0;font-size:13px;color:#344d70}.widget-data-workflow label{display:grid;gap:6px;min-width:0}.widget-data-workflow select,.widget-data-workflow input{box-sizing:border-box;width:100%;min-width:0;border:1px solid #dce2ec;border-radius:6px;padding:8px;background:#fff;color:#40516a;font:inherit}.widget-data-workflow button{padding:8px;border:1px solid #dce2ec;border-radius:6px;color:#3565a5;background:white;font:inherit;cursor:pointer}.widget-data-workflow button:disabled{opacity:.5;cursor:default}.binding-mode-options{display:grid;gap:7px}.binding-mode-options button{text-align:left;display:grid;gap:5px}.binding-mode-options button.selected{background:#edf4ff;border-color:#80aaff}.binding-mode-options small,.binding-note{font-size:11px;color:#8291a6;line-height:1.6;margin:0}.device-data-row{min-width:0;border:1px solid #dce6f3;border-radius:8px;background:#fcfdff}.device-data-row summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px;cursor:pointer;overflow-wrap:anywhere}.device-data-row summary span{font-size:11px;color:#7c8ca4}.device-data-row em{font-style:normal;color:#b56b24;font-size:11px}.device-data-row-body{display:grid;gap:12px;padding:0 10px 12px;min-width:0}.binding-row-actions{display:flex;gap:8px;flex-wrap:wrap}.binding-issues{padding:10px 10px 10px 25px;margin:0;background:#fff7e9;color:#9c6a28;border-radius:7px;line-height:1.7;font-size:11px}.panel-metric-source{display:grid;gap:9px;margin:8px 0;padding:9px;border:1px solid #e2e8f3;border-radius:7px}.binding-global-source{padding:10px;background:#edf4ff;border-radius:6px;margin:0}.widget-data-workflow button:focus-visible{outline:2px solid #82aaff;outline-offset:2px}
</style>
