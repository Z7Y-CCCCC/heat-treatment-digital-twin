import { isSourceUpdateColumn, normalizeRecordTimestamp } from '../../../../../shared/dataRecordTime.mjs'

// Format only fields known to be time data. An order number or ordinary text
// must not turn into a date merely because Date.parse accepts it.
export function isDataTimeField(field = {}) {
  if (!field || typeof field !== 'object') return false
  if (field.valueType === 'datetime' || field.type === 'datetime') return true
  const role = field.fieldRole || field.role || ''
  if (role === 'time') return true
  return isSourceUpdateColumn({
    name: field.fieldName || field.name || field.binding?.datasetField,
    path: field.path || field.binding?.datasetField,
    label: field.label,
    role
  })
}

export function formatDataTime(value) {
  const normalized = normalizeRecordTimestamp(value)
  if (!normalized) return '—'
  const date = new Date(normalized), pad = number => String(number).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function dataTimeTitle(value) {
  if (value == null || value === '') return '未提供时间'
  const displayed = formatDataTime(value)
  if (displayed === '—') return `原始值：${String(value)}（无效时间）`
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'
  const original = value instanceof Date ? value.toISOString() : String(value)
  return `${displayed}（本地时间 · ${zone}）\n原始值：${original}`
}

export function displayPreviewValue(column, value) {
  return isDataTimeField(column) ? formatDataTime(value) : value ?? '—'
}

export function previewValueTitle(column, value) {
  return isDataTimeField(column) ? dataTimeTitle(value) : value == null ? '' : String(value)
}
