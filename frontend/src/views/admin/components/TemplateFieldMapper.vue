<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { adminApi } from '../../../config/factoryConfig.js'
import { DATABASE_FIELD_ROLES, applyTemplateFieldBindings, suggestTemplateFields, templateFieldBindings, validateTemplateFieldBinding } from '../../../runtime/templateFieldMapping.js'

const props = defineProps({ document: { type: Object, required: true }, context: { type: Object, default: () => ({}) } })
const emit = defineEmits(['apply', 'cancel'])
const rows = reactive(templateFieldBindings(props.document).map(binding => ({ ...binding, target: JSON.parse(JSON.stringify(binding.source)), tables: [], fields: [], busy: false, error: '', preview: null, confirmed: false, generation: 0 })))
const error = ref('')
const roleNames = { field: '数值字段', timeField: '时间字段', orderBy: '排序字段', contextField: '上下文筛选字段' }
let disposed = false
onBeforeUnmount(() => { disposed = true })
const ready = computed(() => rows.every(row => row.confirmed && row.preview && !row.busy && !row.error))
function invalidate(row) { row.generation++; row.preview = null; row.confirmed = false; row.error = '' }
function tableKey(target) { return target.table ? `${target.schema || ''}\u0001${target.table}` : '' }
function candidates(row, role) {
  const expected = ['timeField', 'orderBy'].includes(role) ? 'time' : role === 'field' && ['sum', 'avg'].includes(row.target.valueMode) ? 'number' : ''
  return suggestTemplateFields(row.source[role] || '', row.fields, expected)
}
async function inspect(row) {
  invalidate(row)
  const generation = row.generation
  row.busy = true
  row.fields = []
  try {
    if (row.kind === 'http') {
      const response = await adminApi.inspectHttpDataSource(row.target)
      if (disposed || row.generation !== generation) return
      if (response.error || response.success === false) throw new Error(response.error || '读取接口字段失败')
      row.fields = response.result?.fields || []
      // Preserve the original HTTP path even if absent in a sparse sample; a real
      // preview is required and will reject a path absent from the actual response.
    } else {
      const response = await adminApi.getDataSourceTables(row.target.connectionId)
      if (disposed || row.generation !== generation) return
      if (response.error || response.success === false) throw new Error(response.error || '读取数据表失败')
      row.tables = response.tables || []
      const exact = row.tables.find(table => table.name === row.target.table && (table.schema || '') === (row.target.schema || ''))
      if (!exact) { row.target.table = ''; row.target.schema = ''; DATABASE_FIELD_ROLES.forEach(role => { row.target[role] = '' }); return }
      await loadColumns(row, generation)
    }
  } catch (failure) { if (!disposed && row.generation === generation) row.error = failure.message || '读取字段失败' }
  finally { if (!disposed && row.generation === generation) row.busy = false }
}
async function loadColumns(row, generation) {
  const response = await adminApi.getDataSourceColumns(row.target.connectionId, row.target.schema || '', row.target.table)
  if (disposed || row.generation !== generation) return
  if (response.error || response.success === false) throw new Error(response.error || '读取数据列失败')
  row.fields = response.columns || []
  DATABASE_FIELD_ROLES.forEach(role => {
    if (!row.source[role]) { row.target[role] = ''; return }
    const exact = candidates(row, role).filter(candidate => candidate.value === row.source[role] && candidate.score === 100)
    row.target[role] = exact.length === 1 ? exact[0].value : ''
  })
}
async function changeTable(row, value) {
  invalidate(row)
  const generation = row.generation
  const [schema = '', table = ''] = value.split('\u0001')
  Object.assign(row.target, { schema, table })
  row.fields = []
  DATABASE_FIELD_ROLES.forEach(role => { row.target[role] = '' })
  if (!table) return
  row.busy = true
  try { await loadColumns(row, generation) }
  catch (failure) { if (row.generation === generation) row.error = failure.message || '读取字段失败' }
  finally { if (row.generation === generation) row.busy = false }
}
async function preview(row) {
  invalidate(row)
  const generation = row.generation
  row.busy = true
  try {
    validateTemplateFieldBinding(row)
    const widget = props.document.widgets.find(item => item.id === row.widgetId)
    const context = { ...props.context }
    if (widget.data.deviceScope === 'fixed') context.deviceId = widget.data.deviceId
    const response = row.kind === 'http'
      ? await adminApi.previewHttpDataSource(row.target)
      : await adminApi.previewDataSource({ ...widget.data, datasets: [row.target], formula: '', context })
    if (disposed || generation !== row.generation) return
    if (response.error || response.success === false) throw new Error(response.error || '数据预览失败')
    if (!response.result || response.result.quality === 'bad' || response.result.error) throw new Error(response.result?.error || '数据预览失败')
    row.preview = response.result
  } catch (failure) { if (!disposed && generation === row.generation) row.error = failure.message || '数据预览失败' }
  finally { if (!disposed && generation === row.generation) row.busy = false }
}
function apply() {
  error.value = ''
  try {
    if (!ready.value) throw new Error('请逐项预览，并确认字段与实际数据含义一致')
    rows.forEach(validateTemplateFieldBinding)
    emit('apply', applyTemplateFieldBindings(props.document, rows))
  } catch (failure) { error.value = failure.message }
}
onMounted(async () => { for (const row of rows) { if (disposed) break; await inspect(row) } })
</script>

<template>
  <div class="field-mapper" role="dialog" aria-modal="true" aria-label="模板字段映射">
    <h3>映射目标字段并验证数据</h3>
    <p>读取目标数据源的真实字段。同名字段会预填；别名和类型只作为候选，需要你确认。可选择任意字段，接口也支持手填路径。</p>
    <section v-for="row in rows" :key="row.key">
      <h4>{{ row.label }} <small>{{ row.target.connectionId }}</small></h4>
      <fieldset :disabled="row.busy">
        <template v-if="row.kind === 'database'">
          <p>原表：{{ row.source.schema ? `${row.source.schema}.` : '' }}{{ row.source.table }}</p>
          <label>目标表<select :value="tableKey(row.target)" @change="changeTable(row, $event.target.value)"><option value="">请选择目标表</option><option v-for="table in row.tables" :key="`${table.schema}.${table.name}`" :value="`${table.schema || ''}\u0001${table.name}`">{{ table.schema ? `${table.schema}.` : '' }}{{ table.name }}</option></select></label>
          <label v-for="role in DATABASE_FIELD_ROLES" :key="role">{{ roleNames[role] }}（原：{{ row.source[role] || '未设置' }}）
            <select v-model="row.target[role]" @change="invalidate(row)"><option value="">未选择</option><option v-for="field in candidates(row, role)" :key="field.value" :value="field.value">{{ field.value }} · {{ field.dataType || '未知类型' }} · {{ field.reason }}</option></select>
          </label>
          <p v-if="row.target.contextKey">筛选上下文：{{ row.target.contextKey }}。预览使用当前设计器上下文。</p>
        </template>
        <template v-else>
          <label>目标接口 GET 路径<input v-model="row.target.apiPath" @input="invalidate(row); row.fields = []" /></label>
          <label>目标字段路径（原：{{ row.source.jsonPath }}）<input v-model="row.target.jsonPath" @input="invalidate(row)" /></label>
          <label>从实际响应选择<select :value="row.target.jsonPath" @change="row.target.jsonPath = $event.target.value; invalidate(row)"><option value="">请选择或手填字段路径</option><option v-for="field in suggestTemplateFields(row.source.jsonPath, row.fields)" :key="field.value" :value="field.value">{{ field.value }} · {{ field.kind }} · {{ field.reason }} · 示例 {{ field.sample }}</option></select></label>
        </template>
        <div class="actions"><button type="button" @click="inspect(row)">重新读取字段</button><button type="button" @click="preview(row)">预览实际数据</button></div>
        <pre v-if="row.preview">{{ JSON.stringify({ value: row.preview.value, rows: row.preview.rows?.slice(0, 3), quality: row.preview.quality }, null, 2) }}</pre>
        <label v-if="row.preview" class="confirm"><input v-model="row.confirmed" type="checkbox" />我已核对字段含义及预览结果（空值也需核对）</label>
      </fieldset>
      <p v-if="row.busy" role="status">正在读取目标数据源…</p><p v-if="row.error" class="error" role="alert">{{ row.error }}</p>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="actions"><button type="button" @click="emit('cancel')">取消导入</button><button type="button" :disabled="!ready" @click="apply">确认映射并载入草稿</button></div>
  </div>
</template>

<style scoped>
.field-mapper{box-sizing:border-box;width:min(780px,92vw);max-height:86vh;overflow:auto;padding:24px;border-radius:14px;background:#fff;color:#1d2939;text-align:left}.field-mapper p{font-size:12px;line-height:1.6}.field-mapper section{padding:12px;margin:12px 0;border:1px solid #d6dce4;border-radius:8px}.field-mapper h4{margin:0 0 8px}.field-mapper small{color:#64748b}.field-mapper fieldset{border:0;padding:0;min-width:0;display:grid;gap:10px}.field-mapper label{display:grid;gap:5px;font-size:12px}.field-mapper select,.field-mapper input:not([type=checkbox]){box-sizing:border-box;max-width:100%;width:100%;padding:8px;border:1px solid #9ab1c7;border-radius:6px;background:#fff;color:#1d2939}.field-mapper .actions{display:flex;gap:10px}.field-mapper button{padding:8px 12px;border:1px solid #9ab1c7;border-radius:6px;background:#f5f8fc;color:#1d2939;cursor:pointer}.field-mapper button:disabled{opacity:.5;cursor:not-allowed}.field-mapper pre{max-height:180px;overflow:auto;background:#f1f5f9;padding:10px;white-space:pre-wrap;word-break:break-word}.field-mapper .confirm{display:flex;align-items:center}.error{color:#b42318}
</style>
