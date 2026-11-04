<script setup>
import {ref,computed,watch,onMounted,onUnmounted} from 'vue'
import {arrangeLineDevices} from '../utils/lineDeviceArrangement.js'
import {measureLineDevices} from '../../../three/lineDeviceFootprints.js'
const props=defineProps({devices:{type:Array,required:true},models:{type:Array,required:true},targets:{type:Array,required:true},presetIds:{type:Array,default:()=>[]},saving:Boolean})
const emit=defineEmits(['close','apply'])
const key=t=>t.type+':'+t.item.id
const initialTarget=props.targets.find(t=>props.presetIds.length&&props.devices.some(d=>props.presetIds.includes(d.id)&&d.arrangementTarget===key(t)))||props.targets[0]
const targetKey=ref(initialTarget?key(initialTarget):''),scope=ref(props.presetIds.length?'all':'pool'),query=ref(''),ids=ref([]),gap=ref(1),spacing=ref('edge'),anchor=ref(props.presetIds.length?'center':'append'),start=ref(0),busy=ref(false),error=ref(''),plan=ref(null),existing=ref([])
let version=0,controller
const dialog=ref(null),previousFocus=document.activeElement
function handleKeys(event){
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!props.saving)emit('close')}
    if(event.key!=='Tab')return
    const nodes=[...dialog.value.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled)')].filter(n=>n.getClientRects().length)
    if(!nodes.length)return
    if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1).focus()}
    else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0].focus()}
}
onMounted(()=>dialog.value?.querySelector('select')?.focus())
const target=computed(()=>props.targets.find(t=>key(t)===targetKey.value))
const available=computed(()=>props.devices.filter(d=>d.arrangementType===target.value?.type&&(!d.arrangementTarget||scope.value==='all'&&d.arrangementTarget===targetKey.value)).sort((a,b)=>(a.arrangementTarget?0:1)-(b.arrangementTarget?0:1)||(Number(a.pos_x)||0)-(Number(b.pos_x)||0)))
const visible=computed(()=>available.value.filter(d=>(d.name+' '+d.model_type).toLowerCase().includes(query.value.toLowerCase())))
const selected=computed(()=>ids.value.map(id=>available.value.find(d=>d.id===id)).filter(Boolean))
function invalidate(){version++;controller?.abort();controller=null;busy.value=false;plan.value=null;existing.value=[];error.value=''}
function chooseDefaults(){const preset=available.value.filter(d=>props.presetIds.includes(d.id));ids.value=(preset.length?preset:available.value.filter(d=>!d.arrangementTarget)).map(d=>d.id)}
chooseDefaults()
watch([targetKey,scope],()=>{query.value='';chooseDefaults()})
watch(()=>JSON.stringify([props.devices,props.models,props.targets,ids.value,gap.value,spacing.value,anchor.value,start.value,targetKey.value]),invalidate)
function toggle(id){ids.value=ids.value.includes(id)?ids.value.filter(v=>v!==id):[...ids.value,id]}
function move(index,delta){const next=[...ids.value];[next[index],next[index+delta]]=[next[index+delta],next[index]];ids.value=next}
async function preview(){
    invalidate();const current=version,chosen=[...selected.value],binding=target.value
    if(!chosen.length){error.value='请至少选择一台设备';return}
    const occupied=props.devices.filter(d=>d.arrangementTarget===targetKey.value&&!ids.value.includes(d.id))
    busy.value=true;controller=new AbortController()
    try{
        const dimensions=await measureLineDevices([...chosen,...occupied],props.models,{signal:controller.signal})
        if(current!==version)return
        plan.value=arrangeLineDevices(dimensions.slice(0,chosen.length),binding,{gap:gap.value,spacing:spacing.value,anchor:anchor.value,start:start.value,occupied:dimensions.slice(chosen.length)})
        existing.value=dimensions.slice(chosen.length).map(row=>({...row,left:row.x+row.minX,right:row.x+row.maxX,existing:true}))
    }catch(e){if(current===version)error.value=e.message||'排布预览失败'}finally{if(current===version)busy.value=false}
}
const strip=computed(()=>{const length=Number(target.value?.item.length)||1;return [...existing.value,...(plan.value||[])].map(row=>({...row,left:(row.left+length/2)/length*100,width:(row.right-row.left)/length*100}))})
onUnmounted(()=>{invalidate();if(previousFocus?.isConnected)previousFocus.focus()})
</script>
<template>
 <Teleport to="body"><div class="batch-backdrop" @click.self="!saving&&emit('close')"><section ref="dialog" class="batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-title" :aria-busy="busy||saving" @keydown="handleKeys">
  <header><div><h2 id="batch-title">批量添加与排布</h2><p>选择设备和顺序，按实际模型尺寸设置间距，预览后一次保存到现场布局。</p></div><button type="button" aria-label="关闭批量排布" :disabled="saving" @click="emit('close')">×</button></header>
  <div class="batch-settings"><label>放到哪里<select v-model="targetKey" aria-label="批量排布目标" :disabled="saving"><option v-for="item in targets" :key="key(item)" :value="key(item)">{{ item.type==='rail'?'导轨':'设备线' }} · {{ item.item.name }}（{{ item.item.length }} m）</option></select></label>
   <label>选择范围<select v-model="scope" :disabled="saving" aria-label="批量设备范围"><option value="pool">待放置设备</option><option value="all">本设备线全部（含待放置）</option></select></label>
   <label>间距方式<select v-model="spacing" :disabled="saving" aria-label="批量间距方式"><option value="edge">外形净间距（推荐）</option><option value="center">设备中心间距</option></select></label>
   <label>{{ spacing==='edge'?'设备之间留空':'中心间距' }}（米）<input v-model.number="gap" type="number" min="0" step="0.1" aria-label="批量设备间距（米）" :disabled="saving"></label>
   <label>摆放位置<select v-model="anchor" :disabled="saving" aria-label="批量摆放位置"><option value="append">接在已有设备后面</option><option value="center">整组居中</option><option value="start">指定起点外沿 X</option></select></label>
   <label v-if="anchor==='start'">起点外沿 X（米）<input v-model.number="start" type="number" step="0.1" aria-label="批量起点 X（米）" :disabled="saving"></label>
  </div>
  <p class="batch-tip">净间距按设备在产线方向上的完整外形计算，包含当前缩放、朝向及镜像。排列方向为产线 X 从小到大。</p>
  <div class="batch-columns"><section><div class="batch-list-tools"><strong>可选设备 · {{ available.length }}</strong><button type="button" :disabled="saving" @click="ids=[...new Set([...ids,...visible.map(d=>d.id)])]">全选列表</button><button type="button" :disabled="saving" @click="ids=[]">清空</button></div><input v-model="query" placeholder="搜索设备名称或型号" aria-label="搜索批量设备">
   <div class="batch-list"><label v-for="device in visible" :key="device.id"><input type="checkbox" :checked="ids.includes(device.id)" :disabled="saving" :aria-label="`批量选择：${device.name||device.id}`" @change="toggle(device.id)"><span><strong>{{ device.name||device.id }}</strong><small>{{ models.find(m=>m.id===device.model_type)?.name||device.model_type }} · {{ device.arrangementTarget?'已放置':'待放置' }}</small></span></label><p v-if="!visible.length">没有可选设备；可切换为“本设备线全部”。</p></div>
  </section><section><div class="batch-list-tools"><strong>摆放顺序 · 已选 {{ selected.length }} 台</strong><span>↑↓ 调整顺序</span></div><ol class="batch-order"><li v-for="(device,index) in selected" :key="device.id"><span>{{ index+1 }}. {{ device.name||device.id }}</span><button type="button" :aria-label="`前移${device.name}`" :disabled="saving||index===0" @click="move(index,-1)">↑</button><button type="button" :aria-label="`后移${device.name}`" :disabled="saving||index===selected.length-1" @click="move(index,1)">↓</button></li></ol></section></div>
  <p v-if="error" role="alert" class="batch-error">{{ error }}</p>
  <section v-if="plan" class="batch-result" aria-label="批量排布预览"><div class="batch-strip"><div v-for="row in strip" :key="row.id" :class="{existing:row.existing}" :style="{left:row.left+'%',width:row.width+'%'}" :title="row.name">{{ row.name }}</div></div><p>蓝色为本次排布，灰色为保持原位的设备。设备线范围：{{ -Number(target.item.length)/2 }} ～ {{ Number(target.item.length)/2 }} m；本次占用：{{ plan[0].left.toFixed(2) }} ～ {{ plan.at(-1).right.toFixed(2) }} m</p><div class="batch-table"><table><thead><tr><th>设备</th><th>外形占宽(m)</th><th>保存 X(m)</th><th>与上一台净间距(m)</th></tr></thead><tbody><tr v-for="(row,index) in plan" :key="row.id"><td>{{ row.name }}</td><td>{{ (row.right-row.left).toFixed(3) }}</td><td>{{ row.x.toFixed(3) }}</td><td>{{ index?(row.left-plan[index-1].right).toFixed(3):'—' }}</td></tr></tbody></table></div></section>
  <footer><span>预览不会移动现场设备；保存后同步到现场编辑器。</span><button type="button" :disabled="saving" @click="emit('close')">取消</button><button type="button" :disabled="busy||saving||!selected.length||!target" @click="preview">{{ busy?'正在读取模型尺寸…':'生成排布预览' }}</button><button type="button" class="batch-primary" :disabled="!plan||busy||saving" @click="emit('apply',plan)">{{ saving?'正在保存…':`保存 ${plan?.length||0} 台设备排布` }}</button></footer>
 </section></div></Teleport>
</template>
<style scoped>
.batch-dialog header>button{align-self:flex-start;width:32px;height:32px;padding:0;font-size:20px}.batch-strip>div.existing{background:#c4d1dc;color:#4c6275}
.batch-backdrop{position:fixed;inset:0;background:#13233770;z-index:1800;display:grid;place-items:center;padding:24px;color:#2c4358}.batch-dialog{width:min(1080px,100%);max-height:calc(100vh - 48px);overflow:auto;background:#fff;border-radius:16px;box-shadow:0 24px 80px #14253c40;padding:22px;box-sizing:border-box}.batch-dialog header{display:flex;justify-content:space-between;gap:20px}.batch-dialog h2{margin:0;font-size:22px}.batch-dialog p{font-size:12px;color:#72869a;line-height:1.6}.batch-dialog button,.batch-dialog select,.batch-dialog input:not([type=checkbox]){font:inherit;font-size:12px;border:1px solid #d7e2ed;background:#fff;border-radius:7px;padding:8px;color:#345570;box-sizing:border-box}.batch-dialog button{cursor:pointer}.batch-dialog button:disabled{opacity:.45;cursor:default}.batch-settings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}.batch-settings label{display:grid;gap:6px;font-size:12px}.batch-columns{display:grid;grid-template-columns:1fr 1fr;gap:16px}.batch-columns>section{border:1px solid #dce6ef;padding:12px;border-radius:10px;min-width:0}.batch-list-tools{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:8px}.batch-list-tools strong{margin-right:auto}.batch-list-tools span{color:#8a9cad}.batch-columns input:not([type=checkbox]){width:100%}.batch-list,.batch-order{height:205px;overflow:auto;margin:8px 0 0;padding:0}.batch-list label{display:flex;align-items:center;gap:10px;padding:10px 3px;border-bottom:1px solid #edf1f6;font-size:13px}.batch-list label span{display:grid;gap:4px;min-width:0}.batch-list small{font-size:11px;color:#8294a5}.batch-order{list-style:none}.batch-order li{display:flex;gap:6px;align-items:center;padding:6px;border-bottom:1px solid #edf1f6;font-size:13px}.batch-order span{flex:1}.batch-order button{padding:5px 9px}.batch-dialog .batch-error{color:#b83b33;background:#fff0ec;padding:10px;border-radius:8px}.batch-result{margin-top:12px}.batch-strip{height:40px;background:#eef4f9;position:relative;overflow:hidden;border-radius:6px;margin-top:16px}.batch-strip>div{position:absolute;top:5px;bottom:5px;box-sizing:border-box;background:#5a87a8;border:1px solid white;border-radius:4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;line-height:28px;color:white;text-align:center}.batch-table{max-height:180px;overflow:auto}.batch-table table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}.batch-table th,.batch-table td{padding:7px;border-bottom:1px solid #e5edf5}.batch-dialog footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap}.batch-dialog footer span{font-size:11px;color:#8294a5;margin-right:auto}.batch-dialog .batch-primary{background:#2779e5;color:#fff;border-color:#2779e5}@media(max-width:700px){.batch-settings{grid-template-columns:1fr 1fr}.batch-columns{grid-template-columns:1fr}.batch-backdrop{padding:10px}.batch-dialog{max-height:calc(100vh - 20px);padding:15px}}
</style>
