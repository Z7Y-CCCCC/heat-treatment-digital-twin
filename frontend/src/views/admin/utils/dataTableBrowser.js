// Presentation only. Actual values/quality always come from the read-only
// records endpoint; preview samples are deliberately not accepted here.
import { normalizeRecordTimestamp } from '../../../../../shared/dataRecordTime.mjs'
import { dataTimeTitle, formatDataTime, isDataTimeField } from './dataRecordTime.js'

export function recordValue(value, metadata = {}) {
  if (isDataTimeField(metadata)) return formatDataTime(value)
  if (value == null) return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  if (typeof value === 'string') return value || '—'
  try { return JSON.stringify(value) ?? '—' } catch { return '—' }
}

export function recordTimestamp(value) {
  const normalized = normalizeRecordTimestamp(value)
  return normalized ? Date.parse(normalized) : null
}

export function recordTime(value) {
  return formatDataTime(value)
}

export function fullRecordTime(value) {
  return recordTimestamp(value) == null ? '未提供更新时间' : dataTimeTitle(value)
}

export function recordValueTitle(value, metadata = {}) {
  return isDataTimeField(metadata) ? dataTimeTitle(value) : recordValue(value, metadata)
}

export function localDateInput(value = Date.now()) {
  const date = new Date(value), pad = number => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function validateHistoryRange(start, end) {
  const from = new Date(start).getTime(), to = new Date(end).getTime()
  if (!start || !end || !Number.isFinite(from) || !Number.isFinite(to)) return '请选择完整的历史时间范围。'
  if (from >= to) return '结束时间必须晚于开始时间。'
  return ''
}

export function browserRequest({ tableId, factoryId, mode = 'current', q = '', deviceId = '', partId = '', fieldId = '', page = 1, pageSize = 20, start = '', end = '' }) {
  return { tableId, factoryId, mode, q: String(q).trim(), deviceId, partId, fieldId, page, pageSize,
    ...(mode === 'history' ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : {}) }
}

// Plot this page's actual samples, never a synthesized or extrapolated series.
// Invalid/bad-quality samples break the line instead of bridging an outage.
export function numericHistoryTrend(records, fieldId, width = 600, height = 140) {
  const rows = (records || []).filter(row => row.fieldId === fieldId).map(row => ({ row, time: recordTimestamp(row.updatedAt) }))
    .filter(entry => entry.time != null).sort((a, b) => a.time - b.time)
  const valid = entry => entry.row.quality === 'good' && entry.row.value !== null && entry.row.value !== ''
    && ['number', 'string'].includes(typeof entry.row.value) && Number.isFinite(Number(entry.row.value))
  const samples = rows.filter(valid)
  if (!samples.length) return null
  const values = samples.map(entry => Number(entry.row.value)), min = Math.min(...values), max = Math.max(...values)
  const start = rows[0].time, end = rows[rows.length - 1].time
  const x = stamp => end === start ? width / 2 : (stamp - start) / (end - start) * width
  const y = value => min === max ? height / 2 : height - (value - min) / (max - min) * height
  const points = [], segments = []; let segment = [], objectId = null
  for (const entry of rows) {
    if (!valid(entry)) { if (segment.length) segments.push(segment); segment = []; continue }
    if (segment.length && objectId !== entry.row.objectId) { segments.push(segment); segment = [] }
    objectId = entry.row.objectId
    const point = { x: x(entry.time), y: y(Number(entry.row.value)), value: Number(entry.row.value), time: entry.time, id: entry.row.id }
    points.push(point); segment.push(point)
  }
  if (segment.length) segments.push(segment)
  return { points, segments: segments.map(group => group.map(point => `${point.x},${point.y}`).join(' ')), min, max, start, end, width, height }
}
export function dataBrowserErrorMessage(error) {
  if (error?.name === 'AbortError') return '实际数据读取超时，请检查连接后重试。'
  if (error?.status === 404 && error.message === '接口不存在') return '当前后台尚未加载数据浏览服务。请保存编辑后完全退出并重新打开软件，单独刷新页面不会更新后台。'
  return error?.message || '实际数据读取失败，请重试。'
}
