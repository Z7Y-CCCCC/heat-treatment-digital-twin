<script setup>
import { computed, nextTick, useId, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { canAdminPage } from '../../../runtime/adminSession.js'
import { getFactoryScope } from '../../../runtime/factoryScope.js'
import { cacheFactoryDraft, clearFactoryDraft, readFactoryDraft } from '../../../runtime/factoryDraftCache.js'
const props = defineProps({ connections: { type: Array, default: () => [] }, permissionPage: { type: String, default: 'settings.database' }, confirm: Function })
const definitions = ref([]), draft = ref(null), busy = ref(false), failed = ref(false), message = ref(''), query = ref(''), section = ref('query'), result = ref(null)
const availableFields = ref([]), roots = ref([]), addingField = ref('')
const previewContext = ref({ deviceId: '', lineId: '', workshopId: '', partId: '', viewId: '' })
const contextOptions = [{key:'deviceId',label:'当前设备'},{key:'lineId',label:'当前产线'},{key:'workshopId',label:'当前车间'},{key:'partId',label:'当前部件'},{key:'viewId',label:'当前视角'}]
const tabs = [{key:'query',label:'读取配置'},{key:'parameters',label:'参数与匹配'},{key:'fields',label:'字段映射'},{key:'preview',label:'数据预览'}]
const prefix = `dataset-${useId()}`
async function tabKey(event,index) {
    const next={ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key]
    if(next===undefined)return
    event.preventDefault();section.value=tabs[next].key;await nextTick();document.getElementById(`${prefix}-${section.value}`)?.focus()
}
const searchRows = computed(() => definitions.value.filter(d => d.name.toLowerCase().includes(query.value.toLowerCase())))
const connection = computed(() => props.connections.find(c => c.id === draft.value?.connectionId))
const canEdit = computed(() => canAdminPage(props.permissionPage, 'edit'))
const canDelete = computed(() => canAdminPage(props.permissionPage, 'delete'))
const dirty = computed(() => draft.value && JSON.stringify(draft.value) !== savedSnapshot.value)
const savedSnapshot = ref(''), scope = getFactoryScope()
const expandedField = ref(-1), expandedParameter = ref(-1)
const requiredContext = computed(() => contextOptions.filter(c => draft.value?.match?.contextKey === c.key || draft.value?.request.parameters.some(p => p.source === 'context' && p.key === c.key)))
const sourceName = computed(() => connection.value?.name || '未选择连接')
const typeNames = { number: '数值', string: '文本', boolean: '布尔' }
let disposed = false, generation = 0
function newColumn(index = 0) { return { name: index ? `field_${index+1}` : 'value', label: index ? `字段 ${index+1}` : '数值', path: 'value', type: 'number', role: index ? '' : 'value', unit: '', scale: 1, offset: 0 } }
async function load() {
    try { const response = await adminApi.getDataSets(); if (disposed) return; definitions.value = response.datasets || [] }
    catch (error) { if (!disposed) { failed.value = true; message.value = error.message } }
}
async function choose(definition) {
    if (busy.value) return false
    if (dirty.value && props.confirm && !await props.confirm('放弃当前数据集的未保存修改？', {title:'未保存的数据集'})) return false
    availableFields.value=[];roots.value=[];addingField.value='';expandedField.value=-1;expandedParameter.value=-1
    generation++; draft.value = JSON.parse(JSON.stringify(definition)); savedSnapshot.value = JSON.stringify(draft.value); result.value = null; message.value = ''; section.value = 'query'
    return true
}
function create() {
    if (!canEdit.value || busy.value) return
    choose({ name: '新数据集', connectionId: props.connections.find(c=>!c.primary)?.id || props.connections[0]?.id || '', source: 'http', enabled: true, refreshMs: 5000,
        request: { method: 'GET', path: '/', readOnly: false, parameters: [] }, database: {schema:'',table:'',orderBy:'',orderDirection:'desc'},
        rootPath: '', match: null, columns: [newColumn()] }).then(changed => { if (changed) changeConnection() })
}
function changeConnection() {
    draft.value.source = connection.value?.sourceType === 'http_api' || connection.value?.type === 'http_api' ? 'http' : 'database'
    result.value = null; availableFields.value = []; roots.value = []
}
async function save() {
    if (!canEdit.value || busy.value || !draft.value) return
    busy.value = true; message.value = ''; failed.value = false
    try {
        const response = await adminApi.saveDataSet(draft.value)
        if (disposed) return
        draft.value = response.dataset; savedSnapshot.value = JSON.stringify(draft.value); clearFactoryDraft(scope, 'data-set-editor'); await load(); message.value = '已保存'
        window.dispatchEvent(new CustomEvent('digital-twin-data-sets-changed'))
    } catch (error) { if (!disposed) { failed.value = true; message.value = error.message } }
    finally { busy.value = false }
}
async function remove() {
    if (!canDelete.value || !draft.value?.id || busy.value) return
    if (!await props.confirm('删除此数据集？已有组件引用将失效。', {title:'删除数据集',type:'warning'})) return
    busy.value = true
    try { await adminApi.deleteDataSet(draft.value); if (disposed) return; draft.value = null; savedSnapshot.value = ''; clearFactoryDraft(scope, 'data-set-editor'); await load(); window.dispatchEvent(new CustomEvent('digital-twin-data-sets-changed')) }
    catch (error) { failed.value = true; message.value = error.message }
    finally { busy.value = false }
}
async function preview() {
    if (busy.value || !draft.value) return
    section.value = 'preview'
    busy.value = true; failed.value = false; message.value = ''; const seq = ++generation
    try {
        const payload = !dirty.value && draft.value.id ? { datasetId: draft.value.id } : { definition: draft.value }
        const response = await adminApi.previewDataSet({ ...payload, context: previewContext.value })
        if (!disposed && seq === generation) { result.value = response.result; section.value = 'preview' }
    } catch (error) { if (!disposed && seq === generation) { failed.value = true; message.value = error.message; result.value = null } }
    finally { busy.value = false }
}
function addParameter() { draft.value.request.parameters.push({ name: '', in: 'query', source: 'context', key: 'deviceId', value: '', required: true, type: 'string' }) }
async function inspect() {
    if (busy.value || !draft.value) return
    busy.value=true;failed.value=false;message.value='';const seq=++generation
    try {
        const response=await adminApi.previewDataSet({definition:draft.value,context:previewContext.value,inspect:true})
        if(disposed || seq!==generation) return
        availableFields.value=response.result.fields || [];roots.value=response.result.roots || [];section.value='fields'
    } catch(error) { if(!disposed && seq===generation){failed.value=true;message.value=error.message} }
    finally{busy.value=false}
}
function addDiscoveredField() {
    const field=availableFields.value.find(f=>f.path===addingField.value);if(!field || !canEdit.value) return
    let name=field.name.replace(/[^a-zA-Z0-9_]/g,'_').replace(/^\d/,'_') || 'field'
    if(!/[a-zA-Z]/.test(name))name='field'
    const taken=new Set(draft.value.columns.map(c=>c.name));let unique=name,index=1;while(taken.has(unique))unique=`${name}_${index++}`
    const column={...newColumn(draft.value.columns.length),name:unique,label:field.name,path:field.path,type:['number','boolean'].includes(field.kind)?field.kind:'string',role:''}
    if(draft.value.columns.length===1 && draft.value.columns[0].name==='value' && draft.value.columns[0].path==='value') draft.value.columns=[{...column,role:'value'}]
    else if(draft.value.columns.length<32)draft.value.columns.push(column)
    addingField.value=''
}
watch(draft, () => { result.value = null }, {deep:true})
watch(previewContext, () => { generation++; result.value = null }, {deep:true})
defineExpose({ create })
onMounted(async () => {
    await load(); if (disposed) return
    const cached = readFactoryDraft(scope, 'data-set-editor')
    if (cached?.value && canEdit.value) { draft.value = cached.value; savedSnapshot.value = JSON.stringify(definitions.value.find(d => d.id === draft.value.id) || {}); message.value = '已恢复未保存草稿' }
    else if (definitions.value.length) await choose(definitions.value[0])
})
onBeforeUnmount(() => { disposed = true; generation++; if (dirty.value && canEdit.value) cacheFactoryDraft(scope, 'data-set-editor', 'setting', {value:JSON.parse(JSON.stringify(draft.value))}); else clearFactoryDraft(scope, 'data-set-editor') })
</script>
<template>
  <section class="dataset-workspace" aria-label="可复用数据集">
    <div class="dataset-shell">
      <aside class="dataset-sidebar">
        <div class="list-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input v-model="query" class="input" type="search" placeholder="搜索数据集" aria-label="搜索数据集" /></div>
        <div class="list-caption">数据集 <span>{{ definitions.length }}</span></div>
        <div class="dataset-list">
          <button v-for="item in searchRows" :key="item.id" :class="{active:draft?.id===item.id}" :aria-pressed="draft?.id===item.id" :disabled="busy" @click="choose(item)">
            <span class="dataset-list-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 10h16M10 10v10"/></svg></span>
            <span class="dataset-list-copy"><strong>{{ item.name }}</strong><small>{{ connections.find(c=>c.id===item.connectionId)?.name || '连接未配置' }}</small></span>
            <i :class="{off:!item.enabled}" :aria-label="item.enabled?'启用':'停用'"></i>
          </button>
          <p v-if="!searchRows.length" class="list-empty">{{ query?'没有匹配的数据集':'暂无数据集' }}</p>
        </div>
      </aside>
      <section v-if="draft" class="dataset-editor">
        <header class="dataset-detail-heading">
          <div><h4>{{ draft.name || '新数据集' }}</h4><p><span class="source-kind">{{ draft.source==='http'?'API':'DB' }}</span>{{ sourceName }}<span class="heading-divider">/</span>{{ draft.columns.length }} 个字段</p></div>
          <span class="dataset-state" :class="{off:!draft.enabled}"><i></i>{{draft.enabled?'已启用':'已停用'}}</span>
        </header>
        <nav role="tablist" aria-label="数据集编辑分类"><button v-for="(tab,index) in tabs" :id="`${prefix}-${tab.key}`" :key="tab.key" role="tab" :tabindex="section===tab.key?0:-1" :aria-controls="`${prefix}-panel`" :aria-selected="section===tab.key" @keydown="tabKey($event,index)" @click="section=tab.key">{{tab.label}}</button></nav>
        <div :id="`${prefix}-panel`" class="dataset-body" role="tabpanel" :aria-labelledby="`${prefix}-${section}`">
          <fieldset :disabled="busy || !canEdit">
            <div v-show="section==='query'" class="dataset-grid">
              <label>数据集名称<input v-model.trim="draft.name" class="input" aria-label="数据集名称" maxlength="100" /></label>
              <label>数据源连接<select v-model="draft.connectionId" class="input" aria-label="数据集连接" @change="changeConnection"><option value="">请选择连接</option><option v-for="c in connections" :key="c.id" :value="c.id">{{c.name}}</option></select></label>
              <template v-if="draft.source==='http'">
                <label class="wide">接口路径<div class="request-line"><select v-model="draft.request.method" class="input method-select" aria-label="数据集请求方式"><option value="GET">GET</option><option v-if="!connection?.connector || connection.connector==='http'" value="POST">POST</option></select><input v-model.trim="draft.request.path" class="input path-input" aria-label="数据集请求路径" placeholder="/devices" /></div></label>
                <label v-if="draft.request.method==='POST'" class="inline wide"><input v-model="draft.request.readOnly" type="checkbox" />只读查询接口</label>
                <label>结果根节点<input v-model.trim="draft.rootPath" class="input" aria-label="结果根节点" :list="`${prefix}-roots`" placeholder="如 data.items" /><datalist :id="`${prefix}-roots`"><option v-for="path in roots" :key="path" :value="path" /></datalist></label>
              </template>
              <template v-else>
                <label>Schema<input v-model.trim="draft.database.schema" class="input" placeholder="默认" /></label><label>表 / 视图<input v-model.trim="draft.database.table" class="input" aria-label="数据集数据表" /></label>
                <label>排序字段<input v-model.trim="draft.database.orderBy" class="input" placeholder="不排序" /></label><label>排序<select v-model="draft.database.orderDirection" class="input"><option value="desc">降序</option><option value="asc">升序</option></select></label>
              </template>
              <label>刷新间隔<div class="input-suffix"><input :value="draft.refreshMs/1000" class="input" type="number" min="1" max="3600" aria-label="刷新间隔（秒）" @change="draft.refreshMs=Number($event.target.value)*1000" /><span>秒</span></div></label>
              <div class="query-bottom wide"><label class="toggle-label"><input v-model="draft.enabled" type="checkbox" role="switch" aria-label="启用数据集" /><span class="toggle-track" aria-hidden="true"></span>启用</label><button class="text-button" @click="inspect">解析字段 <span aria-hidden="true">→</span></button></div>
            </div>
            <div v-show="section==='parameters'" class="parameter-panel">
              <div class="section-heading"><strong>记录匹配</strong><label class="toggle-label"><input :checked="!!draft.match" type="checkbox" role="switch" aria-label="按当前对象匹配记录" @change="draft.match=$event.target.checked?{field:'id',contextKey:'deviceId'}:null" /><span class="toggle-track" aria-hidden="true"></span></label></div>
              <div v-if="draft.match" class="dataset-grid match-fields"><label>数据中的标识字段<input v-model.trim="draft.match.field" class="input" aria-label="记录匹配字段" placeholder="id" /></label><label>匹配对象<select v-model="draft.match.contextKey" class="input" aria-label="记录匹配对象"><option v-for="c in contextOptions" :key="c.key" :value="c.key">{{c.label}}</option></select></label></div>
              <template v-if="draft.source==='http'">
                <div class="section-heading parameter-heading"><strong>请求参数 <span>{{draft.request.parameters.length}}</span></strong><button class="text-button" :disabled="draft.request.parameters.length>=24" @click="addParameter">＋ 添加参数</button></div>
                <div v-if="draft.request.parameters.length" class="dataset-scroll editable-table"><table><thead><tr><th>参数名</th><th>位置</th><th>来源</th><th>值</th><th class="row-actions"></th></tr></thead><tbody><template v-for="(p,index) in draft.request.parameters" :key="index"><tr><td><input v-model.trim="p.name" class="input" :aria-label="`参数名 ${index+1}`" /></td><td><select v-model="p.in" class="input"><option value="query">Query</option><option value="path">路径</option><option value="body" :disabled="draft.request.method==='GET'">Body</option><option value="header">Header</option></select></td><td><select v-model="p.source" class="input"><option value="context">当前对象</option><option value="literal">固定值</option></select></td><td><select v-if="p.source==='context'" v-model="p.key" class="input"><option v-for="c in contextOptions" :key="c.key" :value="c.key">{{c.label}}</option></select><input v-else v-model="p.value" class="input" /></td><td class="row-actions"><button class="row-settings" :aria-label="`参数设置 ${index+1}`" :aria-expanded="expandedParameter===index" @click="expandedParameter=expandedParameter===index?-1:index">···</button><button class="icon-remove" aria-label="删除参数" @click="draft.request.parameters.splice(index,1)">×</button></td></tr><tr v-if="expandedParameter===index" class="expanded-row"><td colspan="5"><div class="row-options"><label>值类型<select v-model="p.type" class="input"><option value="string">文本</option><option value="number">数值</option><option value="boolean">布尔</option></select></label><label class="inline"><input v-model="p.required" type="checkbox" />必填</label></div></td></tr></template></tbody></table></div>
                <p v-else class="small-empty">暂无请求参数</p>
              </template>
            </div>
            <div v-show="section==='fields'" class="fields-panel">
              <div class="section-heading"><strong>输出字段 <span>{{ draft.columns.length }}</span></strong><button class="text-button" @click="inspect">解析字段</button></div>
              <div class="field-discovery" v-if="availableFields.length"><select v-model="addingField" class="input" aria-label="发现的来源字段"><option value="">选择来源字段</option><option v-for="field in availableFields" :key="field.path" :value="field.path">{{field.path}} · {{typeNames[field.kind] || field.kind}}</option></select><button class="btn btn-sm" :disabled="!addingField" @click="addDiscoveredField">添加到映射</button></div>
              <div class="dataset-scroll editable-table field-table"><table><thead><tr><th>名称</th><th>来源字段</th><th>类型</th><th>单位</th><th class="row-actions"></th></tr></thead><tbody><template v-for="(c,index) in draft.columns" :key="index"><tr><td><input v-model.trim="c.label" class="input" :aria-label="`字段名称 ${index+1}`" /></td><td><input v-model.trim="c.path" class="input code-input" :aria-label="`来源字段 ${index+1}`" placeholder="temperature" /></td><td><select v-model="c.type" class="input"><option value="number">数值</option><option value="string">文本</option><option value="boolean">布尔</option></select></td><td><input v-model="c.unit" class="input" :aria-label="`字段单位 ${index+1}`" placeholder="—" /></td><td class="row-actions"><button class="row-settings" :aria-label="`字段设置 ${index+1}`" :aria-expanded="expandedField===index" @click="expandedField=expandedField===index?-1:index">···</button><button class="icon-remove" aria-label="删除字段" :disabled="draft.columns.length<=1" @click="draft.columns.splice(index,1)">×</button></td></tr><tr v-if="expandedField===index" class="expanded-row"><td colspan="5"><div class="row-options"><label>字段标识<input v-model.trim="c.name" class="input" :aria-label="`字段标识 ${index+1}`" /></label><label>字段用途<select v-model="c.role" class="input"><option value="">普通字段</option><option value="value">主数值</option><option value="category">分类</option><option value="time">时间</option></select></label><label>倍率<input v-model.number="c.scale" class="input" type="number" step="any" /></label><label>偏移<input v-model.number="c.offset" class="input" type="number" step="any" /></label></div></td></tr></template></tbody></table></div>
              <button class="text-button add-field" :disabled="draft.columns.length>=32" @click="draft.columns.push(newColumn(draft.columns.length))">＋ 添加字段</button>
            </div>
          </fieldset>
          <section v-show="section==='preview'" class="preview-panel" aria-label="数据集预览结果">
            <div v-if="requiredContext.length" class="context-bar"><label v-for="c in requiredContext" :key="c.key">{{c.label}} ID<input v-model="previewContext[c.key]" class="input" :disabled="busy" :aria-label="`预览 ${c.key}`" placeholder="输入对象 ID" /></label></div>
            <template v-if="result">
              <div class="preview-caption"><span class="result-state" :class="{'bad':result.quality==='bad'}"><i></i>{{ result.quality==='good'?'读取成功':result.quality==='empty'?'暂无记录':'字段有误' }}</span><span>{{result.rows.length}} 条记录 <b>·</b> {{new Date(result.fetchedAt).toLocaleTimeString('zh-CN',{hour12:false})}}</span></div>
              <div class="dataset-scroll result-table"><table><thead><tr><th class="row-index">#</th><th v-for="c in result.columns" :key="c.name">{{c.label}}<small v-if="c.unit">{{c.unit}}</small></th></tr></thead><tbody><tr v-for="(row,index) in result.rows.slice(0,20)" :key="index"><td class="row-index">{{index+1}}</td><td v-for="c in result.columns" :key="c.name">{{row[c.name] ?? '—'}}</td></tr></tbody></table></div>
              <p v-if="result.error" class="dataset-message bad">{{result.error}}</p>
            </template>
            <div v-else class="dataset-placeholder"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10"/></svg><span>尚未读取数据</span></div>
          </section>
        </div>
        <footer>
          <span v-if="message" :class="['dataset-message',{bad:failed}]" role="status">{{message}}</span><span v-else-if="dirty" class="draft-text"><i></i>未保存</span><span v-else class="footer-note">{{draft.id?'已保存':'新建数据集'}}</span>
          <div class="footer-actions"><button v-if="draft.id" class="text-button delete-dataset" :disabled="busy || !canDelete" @click="remove">删除</button><button class="btn btn-sm" :disabled="busy || (!canEdit && !draft.id)" @click="preview">{{busy?'读取中…':'读取预览'}}</button><button class="btn btn-primary btn-sm" :disabled="busy || !canEdit" @click="save">保存数据集</button></div>
        </footer>
      </section>
      <div v-else class="dataset-placeholder blank-editor"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 10h18M9 10v10"/></svg><strong>选择或新建数据集</strong><span>将连接中的数据提供给大屏组件</span><p v-if="message" class="bad" role="status">{{message}}</p></div>
    </div>
  </section>
</template>
<style scoped src="../styles/form-controls.css"></style>
<style scoped>
* { box-sizing: border-box; }
.dataset-workspace { color: #344054; font-size: 13px; }
.dataset-shell { display: grid; grid-template-columns: 224px minmax(0,1fr); border: 1px solid #e4e7ec; border-radius: 10px; overflow: hidden; background: #fff; }
.dataset-sidebar { padding: 16px 10px 12px; border-right: 1px solid #e9edf2; background: #fafbfc; min-width: 0; }
.list-search { position: relative; padding: 0 2px; }
.list-search svg { position: absolute; left: 12px; top: 10px; width: 16px; height: 16px; fill: none; stroke: #98a2b3; stroke-width: 1.8; }
.list-search input { padding-left: 32px; background: #fff; }
.list-caption { display: flex; justify-content: space-between; margin: 21px 10px 9px; color: #667085; font-size: 11px; }
.list-caption span { color: #98a2b3; }
.dataset-list { max-height: 372px; overflow: auto; }
.dataset-list>button { display: flex; align-items: center; gap: 9px; text-align: left; width: 100%; min-height: 64px; padding: 12px 10px; border: 0; border-radius: 7px; background: transparent; color: #344054; cursor: pointer; margin-bottom: 3px; }
.dataset-list>button:hover { background: #f0f3f8; }
.dataset-list>button.active { background: #edf3ff; color: #245bd6; }
.dataset-list-icon { display: grid; place-items: center; width: 30px; height: 32px; color: #98a2b3; flex: none; }
.dataset-list-icon svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.active .dataset-list-icon { color: #4779e6; }
.dataset-list-copy { display: grid; gap: 5px; min-width: 0; flex: 1; }
.dataset-list-copy strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dataset-list-copy small { color: #8b96a8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dataset-list i,.dataset-state i,.result-state i,.draft-text i { width: 6px; height: 6px; border-radius: 50%; background: #32a977; flex: none; }
.dataset-list i.off { background: #c9cfd9; }
.list-empty { margin: 30px 10px; text-align: center; color: #98a2b3; }
.dataset-editor { display: flex; flex-direction: column; min-width: 0; }
.dataset-detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 24px 12px; }
h4 { margin: 0; color: #253248; font-size: 15px; font-weight: 600; }
.dataset-detail-heading p { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin: 7px 0 0; color: #8b96a8; font-size: 11px; }
.source-kind { font-size: 10px; color: #77869c; font-weight: 600; }
.heading-divider { color: #d0d5dd; margin: 0 2px; }
.dataset-state { display: flex; align-items: center; gap: 6px; color: #669783; font-size: 11px; white-space: nowrap; }
.dataset-state.off { color: #98a2b3; }.dataset-state.off i { background: #c9cfd9; }
nav { display: flex; gap: 24px; padding: 0 24px; border-bottom: 1px solid #eef0f4; overflow: auto; }
nav button { flex: none; padding: 11px 0 12px; background: transparent; border: 0; border-bottom: 2px solid transparent; color: #7b8697; font: inherit; font-size: 12px; cursor: pointer; }
nav button[aria-selected=true] { color: #2563eb; border-bottom-color: #2563eb; font-weight: 600; }
.dataset-body { height: clamp(240px,calc(100vh - 690px),320px); overflow: auto; padding: 21px 24px; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.dataset-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 18px 22px; }
label { display: grid; gap: 8px; color: #667085; font-size: 12px; min-width: 0; }
.input { width: 100%; min-width: 0; min-height: 36px; border: 1px solid #dce1e8; border-radius: 6px; padding: 8px 10px; font: inherit; font-size: 13px; color: #344054; background: #fff; box-shadow: 0 1px 2px #10182803; }
.input:focus { border-color: #91b2f4; box-shadow: 0 0 0 2px #2563eb0d; }
.input::placeholder { color: #a8b0bf; }
.wide { grid-column: 1/-1; }.inline { display: flex; align-items: center; gap: 7px; }
input[type=checkbox] { accent-color: #3269df; }
.request-line { display: flex; }.request-line .method-select { width: 92px; flex: none; border-radius: 6px 0 0 6px; color: #3e70cc; font-size: 12px; font-weight: 600; background: #f8faff; }
.request-line .path-input { border-left: 0; border-radius: 0 6px 6px 0; font-family: Consolas,monospace; }
.input-suffix { position: relative; }.input-suffix input { padding-right: 40px; }.input-suffix span { position: absolute; right: 26px; top: 10px; font-size: 11px; color: #98a2b3; }
.query-bottom { display: flex; align-items: center; justify-content: space-between; padding-top: 2px; }
.toggle-label { display: flex; position: relative; align-items: center; gap: 8px; width: fit-content; cursor: pointer; }
.toggle-label input { position: absolute; width: 34px; height: 20px; opacity: 0; margin: 0; cursor: pointer; }
.toggle-track { display: inline-block; width: 30px; height: 18px; border-radius: 12px; background: #dce2ea; transition: background .15s; }
.toggle-track:after { content: ''; display: block; width: 14px; height: 14px; margin: 2px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0001; transition: transform .15s; }
.toggle-label input:checked+.toggle-track { background: #3ba683; }.toggle-label input:checked+.toggle-track:after { transform: translateX(12px); }.toggle-label input:focus-visible+.toggle-track { outline: 2px solid #81a9f4; outline-offset: 3px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px; margin: 0 0 12px; }.section-heading strong { font-weight: 600; color: #475467; font-size: 12px; }.section-heading strong span { font-weight: 400; color: #98a2b3; margin-left: 5px; }
.parameter-heading { padding-top: 20px; border-top: 1px solid #f0f2f6; margin-top: 20px; }.match-fields { margin: 16px 0 0; }.small-empty { text-align: center; color: #98a2b3; padding: 20px 0; font-size: 12px; }
.text-button { border: 0; padding: 3px 0; background: none; color: #4779d5; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }.text-button:hover:not(:disabled) { color: #184fb5; }
.field-discovery { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }.field-discovery select { flex: 1; }.field-discovery button { flex: none; }
.dataset-scroll { overflow: auto; }.editable-table { border: 1px solid #e7ebf1; border-radius: 7px; }
table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12px; }
th { font-weight: 400; color: #8994a5; background: #f8fafc; padding: 10px 12px; white-space: nowrap; }
td { padding: 9px 10px; border-top: 1px solid #eef1f5; color: #475467; }td .input { padding: 7px 8px; min-height: 32px; font-size: 12px; box-shadow: none; }
.field-table th:first-child { width: 23%; }.field-table th:nth-child(2) { width: 30%; }.field-table th:nth-child(3) { width: 19%; }.field-table th:nth-child(4) { width: 14%; }
.row-actions { width: 64px; white-space: nowrap; text-align: right; padding-left: 0; padding-right: 8px; }.row-settings,.icon-remove { width: 24px; height: 28px; border: 0; padding: 0; background: none; color: #98a2b3; cursor: pointer; font-size: 18px; }.row-settings:hover,.row-settings[aria-expanded=true] { color: #2563eb; background: #edf3ff; border-radius: 4px; }.icon-remove:hover:not(:disabled) { color: #d85e65; }
.expanded-row td { background: #fafbfd; padding: 14px; }.row-options { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; }.row-options label { font-size: 11px; }.code-input { font-family: Consolas,monospace; }.add-field { margin: 13px 0 0; }
.context-bar { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 20px; }.context-bar label { min-width: 180px; max-width: 280px; flex: 1; }
.preview-caption { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 5px 0 12px; color: #98a2b3; font-size: 11px; }.preview-caption b { font-weight: 400; margin: 0 5px; }.result-state { display: flex; align-items: center; gap: 6px; color: #488b70; }.result-state.bad { color: #c15a62; }.result-state.bad i { background: #d8757d; }
.result-table { border: 1px solid #e7ebf1; border-radius: 7px; max-height: 235px; }.result-table td { padding: 13px 12px; font-variant-numeric: tabular-nums; }.result-table th small { font-size: 10px; margin-left: 8px; color: #a4adba; }.row-index { width: 48px; color: #a3acb9; text-align: center; }
.dataset-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 30px 20px; min-height: 160px; font-size: 12px; color: #98a2b3; }.dataset-placeholder svg { width: 34px; height: 34px; fill: none; stroke: #c4cdd9; stroke-width: 1; }.dataset-placeholder strong { font-size: 14px; color: #667085; font-weight: 500; }.blank-editor { min-height: 430px; }.list-empty { font-size: 12px; }
footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-top: 1px solid #eef0f4; margin-top: auto; padding: 14px 24px; background: #fff; min-height: 62px; }.footer-actions { display: flex; gap: 9px; align-items: center; margin-left: auto; flex: none; }.delete-dataset { color: #98a2b3; margin-right: 8px; }.delete-dataset:hover:not(:disabled) { color: #c25561; }.draft-text { display: flex; align-items: center; gap: 6px; color: #b79655; font-size: 11px; }.draft-text i { background: #d9bb7e; }.footer-note { color: #a0a9b8; font-size: 11px; }.dataset-message { margin: 0; font-size: 12px; color: #678c7c; line-height: 1.6; overflow-wrap: anywhere; }.bad { color: #c05a63; }
.btn { font-weight: 500; box-shadow: 0 1px 2px #10182805; background: #fff; color: #52627a; border-color: #dce2ea; border-radius: 6px; padding: 8px 13px; white-space: nowrap; }.btn:not(:disabled):hover { transform: none; background: #f8faff; border-color: #b4c9ef; box-shadow: none; color: #2563eb; }.btn-primary { background: #3269df; border-color: #3269df; color: #fff; }.btn-primary:not(:disabled):hover { background: #275bcb; color: #fff; border-color: #275bcb; }
button:disabled { opacity: .45; cursor: default; }button:focus-visible { outline: 2px solid #91b2f4; outline-offset: 2px; }
@media(max-width:1100px) { .dataset-shell { grid-template-columns: 190px minmax(0,1fr); }.dataset-detail-heading { padding: 18px 18px 10px; }nav { padding: 0 18px; gap: 18px; }.dataset-body { padding: 18px; }.dataset-grid { gap: 16px; }footer { padding: 12px 18px; }.row-options { grid-template-columns: repeat(2,minmax(0,1fr)); }.editable-table table { min-width: 520px; } }
@media(max-width:760px) { .dataset-shell { grid-template-columns: 1fr; }.dataset-sidebar { border-right: 0; border-bottom: 1px solid #e9edf2; }.list-caption { margin-top: 12px; }.dataset-list { display: flex; max-height: 90px; gap: 6px; }.dataset-list>button { min-width: 170px; width: auto; }.dataset-grid { grid-template-columns: 1fr; }.wide { grid-column: auto; }nav { gap: 16px; }.dataset-body { height: 310px; }footer { flex-wrap: wrap; }.footer-actions { gap: 6px; }.preview-caption { flex-wrap: wrap; } }
</style>
