<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {playbackSelection} from '../../../../../shared/widgetPlayback.mjs'
import { adminApi } from '../../../config/factoryConfig.js'
const props = defineProps({ binding: Object, context: Object, devices: {type:Array,default:()=>[]}, disabled:Boolean, multiple:Boolean, playbackNow:Number })
const emit = defineEmits(['change','preview','invalidate'])
const datasets = ref([]), message = ref(''), busy = ref(false), result = ref(null)
const loading = ref(true)
const selected = computed(() => datasets.value.find(d=>d.id===props.binding?.datasetId))
let sequence = 0, loadSequence=0, disposed = false
async function load() {
    const request=++loadSequence;loading.value=true
    try { const response=await adminApi.getDataSets(); if (!disposed && request===loadSequence) {datasets.value=response.datasets || [];message.value=''} }
    catch(error) { if (!disposed && request===loadSequence) message.value=error.message }
    finally { if (!disposed && request===loadSequence) loading.value=false }
}
function changed(reset=false) {
    if(props.disabled)return
    sequence++; result.value=null; message.value='';emit('invalidate')
    if (reset) { const col=selected.value?.columns.find(c=>c.role==='value') || selected.value?.columns[0]; props.binding.datasetField=col?.name || ''; props.binding.unit=col?.unit || '';props.binding.datasetFields=[] }
    else props.binding.unit=selected.value?.columns.find(c=>c.name===props.binding.datasetField)?.unit || ''
    emit('change')
}
async function preview() {
    if (!selected.value || !props.binding.datasetField) { message.value='请选择数据集和字段'; return }
    const seq=++sequence, key=JSON.stringify(props.binding), context=JSON.stringify(props.context); busy.value=true; message.value=''
    try {
        const data=await adminApi.previewDataSet({datasetId:props.binding.datasetId,binding:props.binding,context:{...props.context,...(props.devices?.length?{deviceId:playbackSelection(props.binding,props.context,props.devices,props.playbackNow || Date.now()).device?.id || ''}:props.binding.deviceScope==='fixed'?{deviceId:props.binding.deviceId}: {})}})
        if (disposed || seq!==sequence || key!==JSON.stringify(props.binding) || context!==JSON.stringify(props.context)) return
        result.value=data.result; emit('preview',data.result)
    } catch(error) { if (!disposed && seq===sequence) { message.value=error.message; emit('preview',{value:null,rows:[],series:[],quality:'bad',error:error.message}) } }
    finally { if (seq===sequence) busy.value=false }
}
watch(()=>props.context,()=>{sequence++;busy.value=false;result.value=null;emit('invalidate')},{deep:true})
onMounted(()=>{load();window.addEventListener('digital-twin-data-sets-changed',load)})
onBeforeUnmount(()=>{disposed=true;sequence++;loadSequence++;window.removeEventListener('digital-twin-data-sets-changed',load)})
</script>
<template>
  <section class="dataset-binding" aria-label="组件数据集绑定">
    <div class="binding-group">
      <label class="dataset-choice"><span>数据集</span><select v-model="binding.datasetId" aria-label="组件数据集" :disabled="disabled || loading" @change="changed(true)"><option value="">选择数据集</option><option v-if="binding.datasetId && !selected" :value="binding.datasetId" disabled>{{loading?'读取中…':'数据集不可用'}}</option><option v-for="d in datasets" :key="d.id" :value="d.id">{{d.name}}{{d.enabled?'':'（已停用）'}}</option></select><button class="refresh-button" type="button" aria-label="刷新数据集列表" @click="load"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></svg></button></label>
      <label><span>字段</span><select v-model="binding.datasetField" aria-label="组件数据集字段" :disabled="disabled || !selected" @change="changed()"><option value="">选择字段</option><option v-if="binding.datasetField && !selected?.columns?.some(c=>c.name===binding.datasetField)" :value="binding.datasetField" disabled>{{binding.datasetField}}</option><option v-for="c in selected?.columns || []" :key="c.name" :value="c.name">{{c.label}}{{c.unit?' · '+c.unit:''}}</option></select></label>
    </div>
    <details v-if="multiple && selected" class="binding-more"><summary>图表数值列</summary><label v-for="column in selected.columns.filter(c=>c.type==='number')" :key="column.name"><input type="checkbox" :checked="column.name===binding.datasetField || binding.datasetFields?.includes(column.name)" :disabled="disabled || column.name===binding.datasetField" @change="binding.datasetFields=$event.target.checked?[...new Set([...(binding.datasetFields || []),column.name])].slice(0,12):(binding.datasetFields || []).filter(v=>v!==column.name);changed()" />{{column.label}}</label></details>
    <details class="binding-more" :open="binding.datasetMode && binding.datasetMode!=='first'"><summary>更多设置 <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></summary><label><span>取值</span><select v-model="binding.datasetMode" aria-label="组件数据集取值" :disabled="disabled" @change="changed()"><option value="first">第一条 / 图表序列</option><option value="count">记录数量</option><option value="sum">合计</option><option value="avg">平均值</option><option value="min">最小值</option><option value="max">最大值</option></select></label></details>
    <div class="binding-preview">
      <header><span>数据预览</span><button type="button" :disabled="busy || !selected || !binding.datasetField" @click="preview"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 10 7-10 7Z"/></svg>{{busy?'读取中…':'读取预览'}}</button></header>
      <div v-if="result" class="binding-result" :class="{bad:!['good','empty'].includes(result.quality)}"><strong>{{result.value ?? '—'}}<span>{{result.unit}}</span></strong><small><i></i>{{result.quality==='good'?'正常':result.quality==='empty'?'无记录':'异常'}}<b>·</b>{{result.rows.length}} 条</small></div>
      <div v-else class="binding-preview-empty">—</div>
      <p v-if="message" role="status">{{message}}</p>
    </div>
  </section>
</template>
<style scoped>
.dataset-binding { display:grid; gap:14px; color:#475467; font-size:12px; }
.binding-group { display:grid; gap:12px; }
label,.scope-row { display:flex; align-items:center; gap:10px; position:relative; color:#8490a2; font-size:11px; min-height:34px; }
label>span { width:36px; flex:none; }label>select,.scope-switch { flex:1; min-width:0; }
select { padding:8px 10px; height:34px; border:1px solid #dce1e8; border-radius:6px; background:#fff; color:#344054; font:inherit; font-size:12px; box-shadow:0 1px 2px #10182803; }
select:focus { outline:0; border-color:#91b2f4; box-shadow:0 0 0 2px #2563eb0d; }
.dataset-choice { gap:8px; }.dataset-choice select { width:0; }
.refresh-button { display:grid; place-items:center; flex:none; width:22px; height:28px; padding:0; border:0;  background:#fff; color:#98a2b3; cursor:pointer; border-radius:0 4px 4px 0; }
.refresh-button:hover { color:#3269df; }.refresh-button svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.6; }
.scope-row>span { width:36px; flex:none; }.scope-switch { display:flex; gap:2px; padding:3px; background:#f3f5f8; border:1px solid #edf0f4; border-radius:6px; }
.scope-switch button { flex:1; padding:6px 4px; border:0; border-radius:4px; background:none; color:#8b96a8; font:inherit; font-size:11px; cursor:pointer; white-space:nowrap; }.scope-switch button.active { color:#4775c9; background:#fff; box-shadow:0 1px 3px #182b4b0c; }
.binding-more { border-top:1px solid #edf0f4; padding-top:12px; }.binding-more summary { display:flex; justify-content:space-between; align-items:center; color:#98a2b3; font-size:11px; list-style:none; cursor:pointer; }.binding-more summary::-webkit-details-marker { display:none; }.binding-more summary svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:1.6; }.binding-more[open] summary svg { transform:rotate(90deg); }.binding-more label { margin-top:12px; }
.binding-preview { padding:12px; border:1px solid #e6ebf2; border-radius:7px; background:#fafbfd; }.binding-preview header { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#8b96a8; font-size:11px; }.binding-preview header button { display:flex; align-items:center; gap:4px; padding:0; border:0; background:none; color:#527ac2; font:inherit; font-size:11px; cursor:pointer; }.binding-preview header button svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:1.6; }
.binding-result { margin:14px 0 1px; display:flex; align-items:end; justify-content:space-between; gap:8px; }.binding-result strong { color:#344054; font-size:24px; line-height:1.2; font-weight:500; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }.binding-result strong span { color:#98a2b3; font-size:11px; margin-left:6px; }.binding-result small { display:flex; align-items:center; gap:4px; flex:none; color:#98a2b3; font-size:10px; }.binding-result small i { width:5px; height:5px; border-radius:50%; background:#47a580; }.binding-result.bad small i { background:#d2777c; }.binding-result small b { font-weight:400; margin:0 2px; }.binding-preview-empty { padding:10px 0 0; color:#c0c8d4; font-size:22px; }
.binding-preview p { color:#bb6069; font-size:11px; line-height:1.6; margin:10px 0 0; overflow-wrap:anywhere; }
button:disabled,select:disabled { opacity:.5; cursor:default; }button:focus-visible,summary:focus-visible { outline:2px solid #91b2f4; outline-offset:2px; }
</style>
