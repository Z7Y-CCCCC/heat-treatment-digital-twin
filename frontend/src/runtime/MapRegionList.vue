<script setup>
import { computed } from 'vue'
const props=defineProps({rows:{type:Array,default:()=>[]},content:{type:Object,default:()=>({})},title:String})
const emit=defineEmits(['action'])
const rows=computed(()=>props.rows.slice(0,Math.max(1,Math.min(1000,Number(props.content.limit)||300))))
const field=(row,key,fallback)=>row[props.content[key] || fallback]
function select(row){if(row.allowed===false)return;const kind=field(row,'kindField','kind') || 'region',id=field(row,kind==='factory'?'idField':'codeField',kind==='factory'?'id':'code');if(id!=null)emit('action',{action:kind==='factory'?'map_enter_factory':'map_select_region',id:String(id)})}
</script>
<template>
 <section class="map-record-list" aria-label="区域与工厂列表">
  <div v-if="title" class="map-record-title">{{title}}</div>
  <button v-for="(row,index) in rows" :key="field(row,'idField','id') || field(row,'codeField','code') || index" type="button" :disabled="row.allowed===false" :title="row.message || ''" class="map-record" @click.stop="select(row)" @mouseenter="emit('action',{action:'map_hover_region',id:String(field(row,'codeField','code') || '')})" @mouseleave="emit('action',{action:'map_hover_region',id:''})">
   <span><strong>{{field(row,'nameField','name') || '未命名'}}</strong><small v-if="field(row,'kindField','kind')==='factory'">{{field(row,'workshopsField','workshops') ?? '—'}} 车间 · {{field(row,'linesField','lines') ?? '—'}} 产线 · {{field(row,'devicesField','devices') ?? '—'}} 设备</small><small v-else-if="content.showMeters!==false">{{field(row,'localCountField','localCount') ?? '—'}} 已接入 · {{field(row,'registeredCountField','registeredCount') ?? '—'}} 仅登记</small></span>
   <b v-if="content.showCounts!==false">{{field(row,'countField','count') ?? '—'}}</b><i>↗</i>
  </button>
  <p v-if="!rows.length" class="map-record-empty">{{content.emptyText ?? '暂无记录'}}</p>
 </section>
</template>
<style scoped>
.map-record-list{flex:1;min-height:0;overflow:auto;color:#ddd7f0;scrollbar-width:thin;scrollbar-color:#a59ac655 transparent}.map-record-title{padding:0 0 14px;font-size:20px;font-weight:600}.map-record{display:flex;align-items:center;gap:12px;width:100%;padding:15px 4px;text-align:left;border:0;border-bottom:1px solid #c6b5e326;background:transparent;color:inherit;cursor:pointer;font:inherit}.map-record:hover,.map-record:focus-visible{background:#b9a8dc16;outline:1px solid #b9a8dc44;outline-offset:-1px;border-radius:5px}.map-record span{flex:1;min-width:0}.map-record strong,.map-record small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.map-record strong{font-size:14px}.map-record small{margin-top:7px;color:#ada5c2;font-size:11px}.map-record b{font-size:25px;font-weight:500}.map-record i{color:#b5a6de;font-style:normal}.map-record-empty{padding:20px 0;font-size:12px;color:#a69dbb}
</style>
