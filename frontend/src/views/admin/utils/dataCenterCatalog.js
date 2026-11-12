import { formatDataTime, isDataTimeField } from './dataRecordTime.js'

export const DATA_CENTER_SECTIONS = Object.freeze([
  { key: 'tables', label: '数据表', hint: '整理并选用数据' },
  { key: 'sources', label: '数据源', hint: '连接接口与数据库' },
  { key: 'mapping', label: '点位映射', hint: '配置设备采集点位' },
  { key: 'monitor', label: '点位监视', hint: '检查实时值与质量' }
])

export function dataCenterSourceLabel(type) {
  return ({ internal: '内部资料', metadata: '内部资料', runtime: '内部资料', plc: '设备采集', point: '设备采集', dataset: '外部数据表', external: '外部数据表', http: '外部数据表', database: '外部数据表' })[type] || '内部资料'
}

export function isAutoSyncedDataCenterTable(table) {
  // Only system-owned sources qualify; a category or a healthy reading does
  // not make a manually configured external table automatically maintained.
  return table?.sourceType === 'internal' || table?.sourceType === 'plc'
}

export function dataCenterQuality(quality) {
  return ({ good: { label: '正常', key: 'good' }, configured: { label: '已配置', key: 'configured' }, config_error: { label: '连接未配置', key: 'bad' }, bad: { label: '异常', key: 'bad' }, stale: { label: '未更新', key: 'stale' }, offline: { label: '未连接', key: 'bad' }, empty: { label: '无数据', key: 'unknown' }, disabled: { label: '已停用', key: 'unknown' } })[quality] || { label: '未读取', key: 'unknown' }
}

export function dataCenterPreview(item) {
  const value = item.previewValue
  if (isDataTimeField(item)) return formatDataTime(value)
  if (value == null || typeof value === 'object') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

export function dataCenterObjectLabel(item) {
  return item.deviceName || ({ device: '当前设备', part: '当前悬停部件', factory: '当前工厂', workshop: '当前车间', line: '当前产线', global: '全局数据' })[item.objectScope] || item.objectScope || '当前对象'
}

export function filterDataCenterItems(items, { query = '', categoryId = 'all', sourceType = 'all', tableId = '' } = {}) {
  const needle = query.trim().toLocaleLowerCase()
  return (items || []).filter(item => (!tableId || item.tableId === tableId)
    && (categoryId === 'all' || item.categoryId === categoryId)
    && (sourceType === 'all' || item.sourceType === sourceType || dataCenterSourceLabel(item.sourceType) === sourceType)
    && (!needle || [item.label, item.name, item.tableName, item.deviceName, dataCenterObjectLabel(item), item.description, item.unit].some(value => String(value || '').toLocaleLowerCase().includes(needle))))
}
