import { DATASET_WIDGETS, POINT_WIDGETS } from './widgetBindingChoices.js'

const clone = value => JSON.parse(JSON.stringify(value))
export const DATA_CATALOG_SOURCE_LABELS = Object.freeze({ internal: '内部资料', plc: '设备采集', dataset: '外部数据表', http: '接口数据表', database: '数据库表' })
export function catalogBinding(item, { tooltip = false, kind = 'device' } = {}) {
  if (!item || (tooltip && item.objectScope === 'part' && kind !== 'part')) return null
  const raw = tooltip ? item.tooltipBinding : item.binding
  if (!raw || !['runtime', 'plc', 'dataset'].includes(raw.mode)) return null
  const binding = { ...clone(raw), unit: item.unit || raw.unit || '', readOnly: true }
  if (tooltip) {
    binding.deviceId = ''; binding.deviceScope = raw.mode === 'dataset' && raw.deviceScope === 'global' ? 'global' : 'current'; binding.pointId = ''; binding.point_id = ''
    if (binding.mode === 'plc') {
      if (!binding.pointKey) return null
      binding.requireConfiguredPoint = true
      binding.unit = ''
      binding.unitPath = `hover.device.pointMap.${binding.pointKey}.unit`
    }
    if (binding.mode === 'runtime' && !String(binding.path || binding.source || '').startsWith('hover.')) return null
  }
  return binding
}
export function catalogItemUsable(item, options = {}) {
  const binding = catalogBinding(item, options)
  if (!binding || item.enabled === false) return false
  if (options.tooltip) return !options.widgetType || ['text', 'value', 'status'].includes(options.widgetType)
  if (options.mapContext && binding.mode !== 'dataset') return false
  if (!options.widgetType) return true
  if (binding.mode === 'dataset') return DATASET_WIDGETS.has(options.widgetType)
  if (!POINT_WIDGETS.has(options.widgetType)) return false
  if (['trend', 'hud_chart_dock'].includes(options.widgetType)) return binding.mode === 'plc' && item.type === 'number'
  if (!['text', 'value', 'status'].includes(options.widgetType)) return binding.mode === 'runtime' && String(binding.path || '').startsWith('metrics.')
  return true
}
export function catalogMatchesBinding(item, binding, options = {}) {
  const source = catalogBinding(item, options)
  if (!source || !binding || source.mode !== binding.mode) return false
  if (source.mode === 'dataset') return source.datasetId === binding.datasetId && source.datasetField === binding.datasetField
  if (source.mode === 'plc') return source.pointKey === binding.pointKey && (options.tooltip || !source.deviceId || String(source.deviceId) === String(binding.deviceId))
  return (source.path || source.source) === (binding.path || binding.source)
}
export function filterCatalogItems(items, { categoryId = '', tableId = '', query = '', ...options } = {}) {
  const search = String(query).trim().toLocaleLowerCase()
  return (items || []).filter(item => catalogItemUsable(item, options)
    && (!categoryId || item.categoryId === categoryId) && (!tableId || item.tableId === tableId)
    && (!search || [item.label, item.tableName, item.deviceName, item.unit, item.description].some(value => String(value || '').toLocaleLowerCase().includes(search))))
}
export function catalogPreview(item) {
  if (!item || item.quality !== 'good' || item.previewValue == null) return '—'
  return `${typeof item.previewValue === 'object' ? '结构化数据' : String(item.previewValue)}${item.unit ? ` ${item.unit}` : ''}`
}
