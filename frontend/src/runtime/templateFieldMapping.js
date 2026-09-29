import { normalizeDashboardDocument } from './dashboardSchema.js'

const clone = value => JSON.parse(JSON.stringify(value))
export const DATABASE_FIELD_ROLES = ['field', 'timeField', 'orderBy', 'contextField']
const aliases = [
  ['temperature', 'temp', 'actual_temp', 'actual_temperature', '温度', '实际温度'],
  ['pressure', 'press', '压力'], ['time', 'timestamp', 'datetime', 'created_at', 'recorded_at', '时间', '采集时间'],
  ['device_id', 'deviceid', 'equipment_id', '设备编号'], ['value', 'reading', '数值'],
  ['quantity', 'count', 'total', '数量'], ['status', 'state', '状态']
]
const token = value => String(value || '').toLowerCase().replace(/[_\s-]/g, '')
const leaf = value => String(value || '').split('.').at(-1).replace(/\[.*?\]/g, '')
function typeFamily(type) {
  const value = String(type || '').toLowerCase()
  if (/int|float|double|decimal|numeric|real|number/.test(value)) return 'number'
  if (/date|time/.test(value)) return 'time'
  if (/bool|bit/.test(value)) return 'boolean'
  if (/char|text|string/.test(value)) return 'string'
  return value
}

// Every candidate is retained so unfamiliar business vocabulary remains manually
// selectable. Only a unique exact name may be filled without choosing a candidate.
export function suggestTemplateFields(source, fields, expectedType = '') {
  const name = typeof source === 'string' ? source : source?.name || source?.path || ''
  const expected = typeFamily(expectedType || source?.dataType || source?.kind)
  return fields.map(field => {
    const target = field.name || field.path || ''
    const targetType = typeFamily(field.dataType || field.kind)
    const compatible = !expected || !targetType || expected === targetType
    const exact = target === name
    const equivalent = token(leaf(target)) === token(leaf(name))
    const alias = aliases.some(group => group.map(token).includes(token(leaf(name))) && group.map(token).includes(token(leaf(target))))
    const score = exact ? 100 : equivalent ? 80 : alias ? 60 : expected && compatible ? 20 : 0
    return { ...field, value: target, score: compatible ? score : Math.min(score, 10), reason: !compatible ? '类型不同，请核对' : exact ? '字段名完全一致' : equivalent ? '末级名称一致' : alias ? '常用别名候选' : expected && compatible ? '类型兼容候选' : '手动选择' }
  }).sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
}

export function templateFieldBindings(document) {
  return (document.widgets || []).flatMap(widget => {
    const data = widget.data || {}
    if (data.mode === 'http_api') return [{ key: `${widget.id}:http`, widgetId: widget.id, label: widget.title || widget.id, kind: 'http', source: clone(data) }]
    if (data.mode !== 'database') return []
    return (data.datasets?.length ? data.datasets : [data]).map((source, index) => ({ key: `${widget.id}:${index}`, widgetId: widget.id, index, label: `${widget.title || widget.id} / ${source.label || source.alias || index + 1}`, kind: 'database', source: clone(source) }))
  })
}

export function applyTemplateFieldBindings(document, bindings) {
  const result = clone(document)
  for (const binding of bindings) {
    const widget = result.widgets.find(row => row.id === binding.widgetId)
    if (!widget) throw new Error('模板组件已改变，请重新载入')
    if (binding.kind === 'http') Object.assign(widget.data, binding.target)
    else {
      if (!widget.data.datasets?.length) widget.data.datasets = [clone(widget.data)]
      widget.data.datasets[binding.index] = clone(binding.target)
      // Keep the legacy single-dataset readers and canonical runtime aligned.
      if (binding.index === 0) for (const field of ['connectionId', 'schema', 'table', ...DATABASE_FIELD_ROLES]) widget.data[field] = binding.target[field] || ''
    }
  }
  return normalizeDashboardDocument(result)
}

export function validateTemplateFieldBinding(binding) {
  const target = binding.target
  if (binding.kind === 'http') {
    if (!target.apiPath || !target.jsonPath) throw new Error('请填写接口路径和字段路径')
    return
  }
  if (!target.table || !binding.tables.some(table => table.name === target.table && (table.schema || '') === (target.schema || ''))) throw new Error('请选择当前数据源中的表')
  for (const role of DATABASE_FIELD_ROLES) {
    const required = role === 'field' ? target.valueMode !== 'count' : Boolean(binding.source[role])
    if (required && !target[role]) throw new Error(`请映射 ${binding.source[role] || role}`)
    if (target[role] && !binding.fields.some(field => field.name === target[role])) throw new Error(`字段 ${target[role]} 不在当前表中`)
  }
}

export function remapCopiedWidgetEvents(copies, idMap) {
  for (const widget of copies) for (const event of widget.events || []) {
    if (event.targetType === 'widget' && Object.hasOwn(idMap, event.targetId)) event.targetId = idMap[event.targetId]
  }
  return copies
}
