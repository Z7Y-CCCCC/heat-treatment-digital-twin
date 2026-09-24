<script setup>
import { computed, onMounted, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { getFactoryScope, setFactoryScope } from '../../../runtime/factoryScope.js'
import FactoryGeoFields from './FactoryGeoFields.vue'

const props=defineProps({provinces:{type:Array,default:()=>[]},countries:{type:Array,default:()=>[]}})
const factories=ref([]),activeId=ref(''),scopeId=ref(''),loading=ref(true),saving=ref(false),error=ref(''),message=ref('')
const createOpen=ref(false),newName=ref(''),newLocation=ref({country:'CHN',regionCode:'',regionName:'',cityCode:'',city:'',districtCode:'',districtName:''})
const scopedFactory=computed(()=>factories.value.find(factory=>factory.id===scopeId.value))

async function load(){
  loading.value=true;error.value=''
  try{
    const result=await adminApi.listFactories()
    factories.value=result.factories || [];activeId.value=String(result.activeFactoryId || '')
    scopeId.value=getFactoryScope() || activeId.value || factories.value[0]?.id || ''
  }catch(cause){error.value=cause.message || '工厂列表读取失败'}finally{loading.value=false}
}
onMounted(load)

function selectScope(factory){
  if(!factory || factory.id===scopeId.value)return
  if(!window.confirm(`切换到“${factory.name}”的配置范围？当前后台页面将刷新；大屏运行工厂不会随之改变。`))return
  setFactoryScope(factory.id)
  window.location.reload()
}
async function activate(factory){
  if(!factory || factory.id===activeId.value || saving.value)return
  if(!window.confirm(`将“${factory.name}”设为实时大屏当前运行工厂？`))return
  saving.value=true;message.value='正在切换实时运行工厂…';error.value=''
  try{await adminApi.activateFactory(factory.id);activeId.value=factory.id;message.value=`已切换到${factory.name}；Unity 正在载入该工厂的独立配置。`}
  catch(cause){error.value=cause.message || '切换运行工厂失败'}finally{saving.value=false}
}
function openCreate(){newName.value='';newLocation.value={country:'CHN',regionCode:'',regionName:'',cityCode:'',city:'',districtCode:'',districtName:''};createOpen.value=true}
async function createFactory(){
  const name=newName.value.trim()
  if(!name){error.value='请填写工厂名称';return}
  saving.value=true;error.value='';message.value='正在创建工厂及独立场景…'
  try{
    const result=await adminApi.createFactory({name,location:newLocation.value})
    createOpen.value=false;await load();message.value=`${result.factory?.name || name}已创建。车间、产线和设备可在切换该工厂配置范围后独立维护。`
  }catch(cause){error.value=cause.message || '创建工厂失败'}finally{saving.value=false}
}
</script>

<template>
  <section class="factory-registry" aria-labelledby="factory-registry-title">
    <header class="registry-heading">
      <div><h3 id="factory-registry-title">集团工厂</h3><p>共享同一中控库；车间、产线、设备、场景和运行参数按工厂隔离。运行工厂与后台配置范围可分别切换。</p></div>
      <button type="button" class="primary-action" :disabled="loading || saving" @click="openCreate">＋ 新建工厂</button>
    </header>
    <p v-if="loading" class="registry-state">正在读取工厂…</p>
    <p v-else-if="error && !factories.length" class="registry-state error" role="alert">{{ error }}</p>
    <div v-else class="factory-table-wrap">
      <table class="factory-table">
        <thead><tr><th>工厂</th><th>区域</th><th>车间</th><th>产线</th><th>设备</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="factory in factories" :key="factory.id" :class="{selected:factory.id===scopeId}">
            <td><strong>{{ factory.name }}</strong><small>{{ factory.id }}</small></td>
            <td>{{ factory.location?.districtName || factory.location?.city || factory.location?.regionName || factory.location?.country || '待完善' }}</td>
            <td>{{ factory.workshopCount }}</td><td>{{ factory.lineCount }}</td><td>{{ factory.deviceCount }}</td>
            <td><span v-if="factory.id===activeId" class="status active">实时运行</span><span v-else-if="!factory.enabled" class="status disabled">已停用</span><span v-else class="status">已接入</span></td>
            <td class="row-actions"><button type="button" :disabled="factory.id===scopeId" @click="selectScope(factory)">{{ factory.id===scopeId?'配置中':'配置' }}</button><button type="button" :disabled="factory.id===activeId || !factory.enabled || saving" @click="activate(factory)">设为运行</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="scopedFactory" class="scope-hint">当前后台配置范围：<strong>{{ scopedFactory.name }}</strong><span> · {{ scopedFactory.id===activeId?'同时为实时运行工厂':'切换配置范围不会改变实时大屏' }}</span></p>
    <p v-if="message" class="registry-message" role="status">{{ message }}</p>
    <p v-if="error && factories.length" class="registry-message error" role="alert">{{ error }}</p>

    <Teleport to="body">
      <div v-if="createOpen" class="factory-modal-backdrop" @click.self="createOpen=false" @keydown.esc="createOpen=false">
        <section class="factory-modal" role="dialog" aria-modal="true" aria-labelledby="new-factory-title">
          <header><div><h3 id="new-factory-title">新建工厂</h3><p>将创建独立场景；层级设备配置从空白开始。</p></div><button type="button" aria-label="关闭" @click="createOpen=false">×</button></header>
          <label class="factory-name-field">工厂名称<input v-model="newName" maxlength="120" autofocus placeholder="例如：天津热处理基地" /></label>
          <FactoryGeoFields :model-value="newLocation" :provinces="props.provinces" :countries="props.countries" @update:model-value="newLocation=$event" />
          <p v-if="error" class="registry-message error" role="alert">{{ error }}</p>
          <footer><button type="button" :disabled="saving" @click="createOpen=false">取消</button><button type="button" class="primary-action" :disabled="saving" @click="createFactory">{{ saving?'创建中…':'创建工厂' }}</button></footer>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.factory-registry{padding:22px 0 8px;border-top:1px solid #e2e7ef}.registry-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.registry-heading h3{margin:0;color:#202b3e;font-size:16px}.registry-heading p{max-width:720px;margin:7px 0 16px;color:#7b879a;font-size:12px;line-height:1.7}.factory-registry button{font:inherit;font-size:11px}.primary-action{border:1px solid #3269db!important;border-radius:6px;padding:8px 12px;background:#3269db!important;color:#fff!important;cursor:pointer}.factory-registry button:disabled{opacity:.5;cursor:default}.factory-table-wrap{overflow:auto;border:1px solid #e1e6ee;border-radius:9px}.factory-table{width:100%;border-collapse:collapse;min-width:720px;text-align:left}.factory-table th{padding:9px 11px;background:#f6f8fb;color:#8590a2;font-size:10px;font-weight:600}.factory-table td{padding:10px 11px;border-top:1px solid #edf0f5;color:#4f5c70;font-size:11px;white-space:nowrap}.factory-table tbody tr.selected{background:#f4f7fd}.factory-table td:first-child strong,.factory-table td:first-child small{display:block}.factory-table td:first-child strong{color:#2d394c;font-size:12px}.factory-table td:first-child small{margin-top:3px;color:#98a1b0;font-size:9px}.row-actions{display:flex;gap:6px}.row-actions button,.factory-modal footer>button,.factory-modal header>button{border:1px solid #d8deea;border-radius:5px;padding:6px 9px;background:#fff;color:#48618f;cursor:pointer}.status{padding:4px 7px;border-radius:99px;background:#f2f4f7;color:#7c8799;font-size:9px}.status.active{background:#e7f5ef;color:#2c8768}.status.disabled{background:#fbefef;color:#a34e52}.scope-hint,.registry-message,.registry-state{margin:11px 0 0;color:#78859a;font-size:11px;line-height:1.6}.scope-hint strong{color:#425877}.scope-hint span{color:#8792a3}.registry-message.error,.registry-state.error{color:#b64250}.factory-modal-backdrop{position:fixed;z-index:3000;inset:0;display:grid;place-items:center;padding:24px;background:#17203366;backdrop-filter:blur(3px)}.factory-modal{width:min(720px,100%);max-height:min(90vh,900px);overflow:auto;padding:22px;border:1px solid #e0e5ed;border-radius:14px;background:#fff;box-shadow:0 24px 70px #17203335}.factory-modal header,.factory-modal footer{display:flex;align-items:center;justify-content:space-between;gap:12px}.factory-modal header h3{margin:0;color:#253149;font-size:17px}.factory-modal header p{margin:5px 0 18px;color:#8792a4;font-size:11px}.factory-modal header>button{font-size:19px}.factory-name-field{display:grid;gap:6px;margin-bottom:16px;color:#5d6a80;font-size:11px}.factory-name-field input{padding:10px;border:1px solid #d6deea;border-radius:6px;font:inherit}.factory-modal footer{justify-content:flex-end;margin-top:18px}.factory-modal footer>button{padding:8px 14px}.factory-modal :deep(.geo-fields){margin:0}@media(max-width:700px){.registry-heading{align-items:flex-start}.registry-heading p{max-width:480px}}
</style>
