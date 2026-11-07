<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
const props = defineProps({ connection: { type: Object, required: true } })
const http = computed(() => props.connection.sourceType === 'http_api' || props.connection.type === 'http_api')
const kind = computed(() => props.connection.connector || 'http')
const tables = ref([]), fields = ref([]), result = ref(null), busy = ref(false), error = ref(''), loaded = ref(false)
const previewTab = ref('fields')
const query = reactive({ table: '', field: '', apiPath: ['mqtt', 'redis'].includes(kind.value) ? props.connection.healthPath : '/', jsonPath: '' })
let generation = 0, disposed = false
onBeforeUnmount(() => { disposed = true; generation++ })
function invalidate() { generation++; busy.value = false; result.value = null; error.value = '' }
watch([() => props.connection.id, () => props.connection.configRevision, () => props.connection.updatedAt], () => {
    invalidate(); tables.value = []; fields.value = []; loaded.value = false
    Object.assign(query, { table: '', field: '', apiPath: ['mqtt', 'redis'].includes(kind.value) ? props.connection.healthPath : '/', jsonPath: '' })
}, { flush: 'sync' })
watch(() => query.apiPath, () => { invalidate(); fields.value = []; query.jsonPath = ''; loaded.value = false }, { flush: 'sync' })
watch(() => [query.field, query.jsonPath], invalidate, { flush: 'sync' })
function display(value) {
    if (value === undefined || value === null) return '—'
    return (typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(0, 600)
}
async function request(work, apply) {
    invalidate(); const current = generation; busy.value = true
    try {
        const response = await work()
        if (disposed || current !== generation) return
        if (response?.error || response?.success === false) throw new Error(response.error || '读取失败')
        apply(response); loaded.value = true
    } catch (cause) { if (!disposed && current === generation) error.value = cause.message || '读取失败' }
    finally { if (!disposed && current === generation) busy.value = false }
}
function inspect() {
    previewTab.value = 'fields'
    fields.value = []; query.field = ''; query.jsonPath = ''
    if (http.value) return request(() => adminApi.inspectHttpDataSource({ connectionId: props.connection.id, apiPath: query.apiPath }), data => { fields.value = data.result?.fields || [] })
    query.table = ''
    return request(() => adminApi.getDataSourceTables(props.connection.id), data => { tables.value = data.tables || [] })
}
function chooseTable() {
    fields.value = []; query.field = ''; result.value = null
    if (!query.table) { invalidate(); return }
    const table = tables.value[Number(query.table) - 1]
    return request(() => adminApi.getDataSourceColumns(props.connection.id, table.schema, table.name), data => { fields.value = data.columns || [] })
}
function preview() {
    if (http.value) return request(() => adminApi.previewHttpDataSource({ connectionId: props.connection.id, apiPath: query.apiPath, jsonPath: query.jsonPath }), data => { result.value = data.result; previewTab.value = 'sample' })
    const table = tables.value[Number(query.table) - 1]
    if (!table || !query.field) return
    return request(() => adminApi.previewDataSource({ datasets: [{ connectionId: props.connection.id, schema: table.schema, table: table.name, field: query.field, valueMode: 'list', rowLimit: 20, alias: 'a' }] }), data => { result.value = data.result; previewTab.value = 'sample' })
}
</script>

<template>
    <section class="source-preview" aria-label="数据源只读预览">
        <div class="preview-toolbar">
            <label v-if="http && ['http', 'mqtt', 'redis'].includes(kind)">{{ kind === 'http' ? '接口路径' : kind === 'mqtt' ? '订阅主题' : 'Redis 键名' }}<input v-model="query.apiPath" class="input" :aria-label="kind === 'http' ? '接口路径' : kind === 'mqtt' ? '订阅主题' : 'Redis 键名'" /></label>
            <button type="button" class="btn btn-sm" :disabled="busy || !connection.enabled || (http && !query.apiPath)" @click="inspect">{{ http ? kind === 'http' ? '读取接口字段' : '读取数据字段' : connection.type === 'mongodb' ? '读取集合' : '读取表与视图' }}</button>
            <label v-if="!http && tables.length">{{ connection.type === 'mongodb' ? '集合' : '数据表' }}<select v-model="query.table" class="input" :aria-label="connection.type === 'mongodb' ? 'MongoDB 集合' : '数据表'" @change="chooseTable"><option value="">请选择{{ connection.type === 'mongodb' ? '集合' : '表或视图' }}</option><option v-for="(table, index) in tables" :key="index" :value="String(index + 1)">{{ table.schema ? table.schema + '.' : '' }}{{ table.name }}</option></select></label>
            <label v-if="fields.length">{{ http ? '字段路径' : '字段' }}<select v-if="http" v-model="query.jsonPath" class="input" aria-label="字段路径"><option value="">请选择字段</option><option v-for="field in fields" :key="field.path" :value="field.path">{{ field.path }}</option></select><select v-else v-model="query.field" class="input" aria-label="字段"><option value="">请选择字段</option><option v-for="field in fields" :key="field.name" :value="field.name">{{ field.name }}</option></select></label>
            <button v-if="fields.length" type="button" class="btn btn-sm" :disabled="busy || !(http ? query.jsonPath : query.field)" @click="preview">读取样例</button>
        </div>
        <p v-if="busy" role="status" class="note">正在只读查询…</p>
        <p v-if="!connection.enabled" class="note">连接已停用，请先启用并保存。</p>
        <p v-if="error" role="alert" class="preview-error">{{ error }}</p>
        <p v-if="connection.type === 'mongodb' && fields.length" class="note">字段来自前 50 条记录；空集合或未出现的字段可在数据集中手动填写。</p>
        <nav v-if="fields.length" class="preview-result-tabs" aria-label="预览内容"><button type="button" :aria-pressed="previewTab==='fields' || !result" @click="previewTab='fields'">字段 <small>{{fields.length}}</small></button><button v-if="result" type="button" :aria-pressed="previewTab==='sample'" @click="previewTab='sample'">样例</button></nav>
        <div v-if="fields.length" v-show="previewTab==='fields' || !result" class="preview-table-scroll">
            <table><thead><tr><th>{{ http ? '字段路径' : '字段名' }}</th><th>类型</th><th>{{ http ? '样例' : '属性' }}</th></tr></thead><tbody>
                <tr v-for="field in fields" :key="field.path || field.name"><td>{{ field.path || field.name }}</td><td>{{ field.kind || field.dataType || '—' }}</td><td>{{ http ? field.sample : [field.primaryKey ? '主键' : '', field.nullable ? '可空' : '非空'].filter(Boolean).join(' · ') }}</td></tr>
            </tbody></table>
        </div>
        <p v-else-if="loaded && !error && !busy && (http || query.table || !tables.length)" class="note">未发现可预览字段或数据表。</p>
        <section v-if="result" v-show="previewTab==='sample'" class="preview-result" aria-label="读取样例结果">
            <strong>当前值：{{ display(result.value) }}</strong>
            <div v-if="result.rows?.length" class="preview-table-scroll"><table><thead><tr><th>序号</th><th>值</th></tr></thead><tbody><tr v-for="(row, index) in result.rows.slice(0, 20)" :key="index"><td>{{ index + 1 }}</td><td>{{ display(http ? row : row.value) }}</td></tr></tbody></table></div>
            <small>{{ result.rows?.length || (result.value != null ? 1 : 0) }} 条 · {{ result.fetchedAt ? new Date(result.fetchedAt).toLocaleTimeString('zh-CN',{hour12:false}) : '' }}</small>
        </section>
    </section>
</template>

<style scoped src="../styles/form-controls.css"></style>
<style scoped>
* { box-sizing: border-box; }
.source-preview { min-width: 0; padding: 14px 0; font-size: calc(15px * var(--admin-font-scale, 1)); line-height:1.6; }
.note { color: #526174; line-height: 1.6; margin: 0 0 12px; }
.preview-toolbar { display: flex; gap: 12px; align-items: end; flex-wrap: wrap; }
label { font-size:calc(14px * var(--admin-font-scale,1)); display: grid; gap: 7px; min-width: 0; flex: 1 1 160px; color: #536176; }
.input { width: 100%; min-width: 0; font: inherit; font-size:calc(15px * var(--admin-font-scale,1)); }
.input::placeholder { color:#667085; }
.btn { min-height: 42px; font-size:calc(14px * var(--admin-font-scale,1)); }
.preview-table-scroll { overflow: auto; max-height: 220px; border: 1px solid #e4e9f0; border-radius: 8px; margin-top: 14px; }
table { width: 100%; border-collapse: collapse; text-align: left; font-size: calc(15px * var(--admin-font-scale, 1)); }
th, td { padding: 9px 12px; border-bottom: 1px solid #eef1f5; overflow-wrap: anywhere; }
th { position: sticky; top: 0; background: #f4f7fb; color: #61718a; }
.preview-error { color: #b42318; overflow-wrap: anywhere; }
.preview-result { display: grid; gap: 10px; margin-top: 16px; }
.preview-result strong { overflow-wrap: anywhere; color: #263c56; }
.preview-result small { color: #526174; font-size:calc(13px * var(--admin-font-scale,1)); }
.preview-result-tabs { display:flex; gap:16px; align-items:center; margin-top:16px; border-bottom:1px solid #edf0f4; }
.preview-result-tabs button { padding:8px 0; border:0; border-bottom:2px solid transparent; background:none; color:#526174; font:inherit; font-size:calc(14px * var(--admin-font-scale, 1)); cursor:pointer; }
.preview-result-tabs button[aria-pressed=true] { color:#2456a6; border-bottom-color:#2456a6; }
.preview-result-tabs small { font-size:calc(13px * var(--admin-font-scale, 1)); margin-left:3px; color:#667085; }
.input { border-color:#dce1e8; background:#fff; border-radius:6px; color:#344054; }
.btn { background:#fff; border-color:#dce2ea; border-radius:6px; color:#52627a; font-weight:500; box-shadow:none; }
.btn:not(:disabled):hover { transform:none; box-shadow:none; }
</style>
