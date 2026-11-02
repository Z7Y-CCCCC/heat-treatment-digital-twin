<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { normalizeParameterDefinitions } from '../../../../../shared/dashboardParameters.mjs'
import { SOFTWARE_METHODS } from '../../../runtime/dashboardIntegration.js'
const props = defineProps({ definitions:Array, api:Object, run:Function, readonly:Boolean, views:Array, widgets:Array, devices:Array })
const emit = defineEmits(['close','apply'])
const tab = ref('parameters'), rows = ref(JSON.parse(JSON.stringify(props.definitions || [])))
const message = ref(''), method = ref('getContext'), args = ref('[]'), result = ref(''), busy = ref(false), events = ref([])
const selected = computed(()=>SOFTWARE_METHODS.find(item=>item.name === method.value))
const panelRef=ref(null), closeRef=ref(null)
let previousFocus=null, off = []
function trapTab(event) {
  const items=[...(panelRef.value?.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') || [])].filter(el=>el.offsetParent!==null)
  const first=items[0], last=items.at(-1)
  if (event.shiftKey && document.activeElement===first) {event.preventDefault();last?.focus()}
  else if (!event.shiftKey && document.activeElement===last) {event.preventDefault();first?.focus()}
}
function choose(name) {
  method.value=name
  let value=SOFTWARE_METHODS.find(item=>item.name===name)?.args || []
  if (name==='setParameters') value=[Object.fromEntries((props.definitions || []).map(row=>[row.key,row.defaultValue]))]
  if (name==='switchView') value=[props.views?.[0]?.id || 'factory_overview']
  if (name==='focusDevice') value=[props.devices?.[0]?.id || 'DEVICE_ID']
  if (name==='setVisible') value=[props.widgets?.[0]?.id || 'WIDGET_ID',true]
  args.value=JSON.stringify(value,null,2);result.value=''
}
function apply() {
  try { const normalized=normalizeParameterDefinitions(rows.value); emit('apply',normalized);message.value='已应用到草稿' } catch(error) { message.value=error.message }
}
function add() { let n=1;while(rows.value.some(row=>row.key===`param${n}`)) n++;rows.value.push({key:`param${n}`,label:'新参数',type:'string',defaultValue:''}) }
async function execute() {
  busy.value=true
  try {
    const input=JSON.parse(args.value)
    if (!Array.isArray(input) || input.length>2) throw new Error('调用参数应为 JSON 数组')
    const value=await props.run(method.value,input)
    result.value=JSON.stringify({success:true,result:value ?? null},null,2)
  } catch(error) { result.value=JSON.stringify({success:false,error:error.message},null,2) }
  finally { busy.value=false }
}
onMounted(()=>{ previousFocus=document.activeElement;closeRef.value?.focus();for(const name of ['viewChanged','deviceSelected','parametersChanged','widgetAction']) {
  try { off.push(props.api.on(name,payload=>{ events.value=[{name,payload},...events.value].slice(0,8) })) } catch { /* not ready yet */ }
} })
onUnmounted(()=>{off.forEach(unsubscribe=>unsubscribe());if(previousFocus?.isConnected)previousFocus.focus()})
</script>
<template>
  <div class="integration-mask" @pointerdown.self.prevent>
    <section ref="panelRef" class="integration-panel" role="dialog" aria-modal="true" aria-label="接口与参数" @keydown.esc.stop="emit('close')" @keydown.tab="trapTab">
      <header><div><h3>接口与参数</h3><p>参数联动 · 画面调用</p></div><button ref="closeRef" class="close" aria-label="关闭接口与参数" @click="emit('close')">×</button></header>
      <nav role="tablist" aria-label="接口设置"><button role="tab" :aria-selected="tab==='parameters'" :class="{active:tab==='parameters'}" @click="tab='parameters'">全局参数 <small>{{rows.length}}</small></button><button role="tab" :aria-selected="tab==='software'" :class="{active:tab==='software'}" @click="tab='software'">软件接口</button></nav>
      <div v-if="tab==='parameters'" class="parameter-body" role="tabpanel">
        <div class="section-head"><span>供筛选组件、数据集请求和页面事件共用</span><button :disabled="readonly || rows.length>=32" @click="add">＋ 添加参数</button></div>
        <div class="parameter-table"><table><thead><tr><th>标识</th><th>名称</th><th>类型</th><th>默认值</th><th></th></tr></thead><tbody><tr v-for="(row,index) in rows" :key="index"><td><input v-model.trim="row.key" :disabled="readonly" :aria-label="`参数标识 ${index+1}`" /></td><td><input v-model="row.label" :disabled="readonly" :aria-label="`参数名称 ${index+1}`" /></td><td><select v-model="row.type" :disabled="readonly" :aria-label="`参数类型 ${index+1}`" @change="row.defaultValue=row.type==='boolean'?false:row.type==='number'?0:''"><option value="string">文本</option><option value="number">数值</option><option value="boolean">布尔</option><option value="date">日期</option></select></td><td><select v-if="row.type==='boolean'" v-model="row.defaultValue" :disabled="readonly" :aria-label="`参数默认值 ${index+1}`"><option :value="true">是</option><option :value="false">否</option></select><input v-else v-model="row.defaultValue" :type="row.type==='number'?'number':row.type==='date'?'date':'text'" :disabled="readonly" :aria-label="`参数默认值 ${index+1}`" /></td><td><button class="delete" :disabled="readonly" :aria-label="`删除参数 ${index+1}`" @click="rows.splice(index,1)">×</button></td></tr></tbody></table><div v-if="!rows.length" class="empty">暂无全局参数</div></div>
        <footer><span role="status">{{message}}</span><button class="primary" :disabled="readonly" @click="apply">应用到草稿</button></footer>
      </div>
      <div v-else class="software-body" role="tabpanel">
        <aside><button v-for="item in SOFTWARE_METHODS" :key="item.name" :class="{selected:method===item.name}" @click="choose(item.name)"><strong>{{item.label}}</strong><code>{{item.name}}</code></button></aside>
        <div class="software-detail"><div class="section-head"><strong>{{selected.label}}</strong><span>仅操作设计器预览</span></div><pre class="example">{{selected.example}}</pre><label>调用参数（JSON）<textarea v-model="args" aria-label="软件接口调用参数" rows="4" spellcheck="false"></textarea></label><div class="run-row"><small>运行页：window.DigitalTwin · ready / on / off</small><button class="primary" :disabled="busy" @click="execute">{{busy?'执行中…':'运行预览'}}</button></div><pre v-if="result" class="result" aria-label="接口执行结果">{{result}}</pre><details v-if="events.length"><summary>联动事件 {{events.length}}</summary><pre>{{JSON.stringify(events,null,2)}}</pre></details></div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.integration-mask{position:fixed;inset:0;background:#15203944;z-index:1800;display:grid;place-items:center;padding:24px}.integration-panel{width:min(980px,100%);max-height:88vh;background:white;border:1px solid #dfe5ee;border-radius:16px;box-shadow:0 24px 90px #14203a33;display:flex;flex-direction:column;color:#27364b;overflow:hidden;font-size:13px}.integration-panel header{padding:23px 28px 16px;position:relative}.integration-panel h3{font-size:19px;margin:0}.integration-panel p{color:#8894a8;margin:6px 0 0;font-size:12px}.integration-panel button{border:1px solid #dce3ee;border-radius:8px;background:#fff;color:#4c6385;padding:8px 14px;font:inherit;cursor:pointer}.integration-panel button:disabled{opacity:.45;cursor:default}.integration-panel .close{position:absolute;right:8px;top:5px;background:transparent;border:0;font-size:22px;padding:6px 10px}.integration-panel nav{margin:0 28px 20px;padding:5px;display:flex;gap:5px;background:#f4f6fa;border:1px solid #e5e9f0;border-radius:10px}.integration-panel nav button{border:0;background:transparent;padding:9px 20px}.integration-panel nav button.active{background:#fff;color:#2464e9;box-shadow:0 2px 7px #2335530e;font-weight:600}.integration-panel small{font-size:11px;color:#8995a8;margin-left:5px}.parameter-body{padding:0 28px;min-height:260px;overflow:auto}.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.section-head>span{color:#8793a7;font-size:12px}.parameter-table{max-height:43vh;overflow:auto;border:1px solid #e4e9f1;border-radius:10px}.parameter-table table{width:100%;border-collapse:collapse;table-layout:fixed}.parameter-table th{text-align:left;padding:11px 10px;background:#f7f9fc;color:#7e8ca3;font-weight:500;font-size:12px}.parameter-table td{padding:10px;border-top:1px solid #edf0f5}.parameter-table th:nth-child(3){width:100px}.parameter-table th:last-child{width:34px}.integration-panel input,.integration-panel select,.integration-panel textarea{border:1px solid #d9e1ed;border-radius:7px;padding:8px 10px;background:#fff;color:#34435b;font:inherit;width:100%;box-sizing:border-box;min-width:0}.integration-panel input:focus,.integration-panel select:focus,.integration-panel textarea:focus{outline:2px solid #bad2ff;border-color:#5792ff}.integration-panel .delete{border:0;background:transparent;padding:2px;color:#9ca8b8;font-size:20px}.integration-panel footer{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:18px 0 23px;color:#7b8ba4;font-size:12px}.integration-panel .primary{background:#2864eb;color:#fff;border-color:#2864eb}.empty{padding:55px;text-align:center;color:#9aa6b7}.software-body{display:grid;grid-template-columns:210px minmax(0,1fr);min-height:380px;overflow:auto;max-height:62vh}.software-body aside{padding:0 15px 22px 28px;border-right:1px solid #e9edf3;display:flex;flex-direction:column;gap:5px}.software-body aside button{border-color:transparent;text-align:left;padding:10px 12px}.software-body aside button.selected{background:#eef5ff;color:#2262e8}.software-body aside code{display:block;font-size:11px;color:#8b98ab;margin-top:4px}.software-detail{padding:0 28px 24px;min-width:0}.software-detail pre{font:12px/1.7 Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto}.example{background:#f6f8fc;border:1px solid #e8edf4;border-radius:8px;padding:14px;color:#4c668f}.software-detail label{display:block;color:#708199;font-size:12px}.software-detail textarea{display:block;margin-top:8px;resize:vertical;font-family:Consolas,monospace}.run-row{display:flex;align-items:center;justify-content:space-between;margin:14px 0}.result{padding:14px;border:1px solid #e3eaf3;border-radius:8px;background:#fafbfd}.software-detail summary{cursor:pointer;color:#7c8da7;font-size:12px}@media(max-width:700px){.software-body{grid-template-columns:145px 1fr}.software-body aside{padding-left:12px}.software-detail{padding:0 14px 18px}.integration-panel nav,.integration-panel header{margin-left:0;margin-right:0;padding-left:16px}.parameter-body{padding:0 14px}.run-row{align-items:flex-start;gap:8px}.run-row small{max-width:140px}}
</style>
