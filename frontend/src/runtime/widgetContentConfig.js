// Small adapters for existing content controls. They do not acquire data,
// create bindings, or rewrite a document when an old field is absent.
const objectValue = (value, fallback = {}) => value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
const text = value => value == null ? '' : String(value)
const hasBinding = binding => binding?.mode !== 'static' && Boolean(binding?.mode || binding?.path || binding?.source || binding?.pointId || binding?.point_id)

export const DEFAULT_METRIC_ITEMS = Object.freeze([
  Object.freeze({ label: '今日产出', path: 'metrics.current_output' }),
  Object.freeze({ label: '完成进度', path: 'metrics.progress_percent', unit: '%' }),
  Object.freeze({ label: '能耗估算', path: 'metrics.energy_consumption' }),
  Object.freeze({ label: '在线设备', path: 'metrics.online_devices', suffixPath: 'metrics.total_devices', separator: '/' })
])

export function effectiveMetricItems(content = {}) {
  return Array.isArray(content.items) ? content.items : DEFAULT_METRIC_ITEMS
}

export function metricValueSource(item = {}) {
  if (item.binding) return 'binding'
  if (item.valueSource === 'fixed' || item.valueSource === 'field') return item.valueSource
  return item.path ? 'field' : 'fixed'
}

export function resolveNavigationContent(widget = {}, systemData = {}) {
  const content = objectValue(widget.content, objectValue(widget.config))
  return {
    projectLabel: content.projectLabelSource === 'factory' ? text(systemData.factoryName) : (content.projectLabel ?? ''),
    statusText: content.statusTextSource === 'collection' ? text(systemData.collectionStatus) : (content.statusText ?? '')
  }
}

export function mapListTitle(content = {}, mapData = {}) {
  return content.listTitleSource === 'fixed' ? text(content.listTitle) : text(mapData.title)
}

export function deviceListDataSource(binding = {}) {
  // Historical "static" lists have always read the factory status map.
  // Show that actual source without rewriting their data on inspection.
  return binding.mode === 'dataset' ? 'dataset' : 'runtime'
}

export function widgetChartSeriesSource(content = {}, binding = {}) {
  if (content.seriesSource === 'field' || content.seriesSource === 'binding') return content.seriesSource
  // Legacy static charts have always consumed the surface's trendPoints,
  // independently of their (often empty) primary scalar value.
  return !binding.mode || binding.mode === 'static' ? 'field' : 'binding'
}

export function widgetChartSeriesPath(content = {}, binding = {}) {
  // Read even an absent property so a reactive legacy content object tracks
  // the first user edit; hasOwnProperty alone does not establish that read.
  const path = content.seriesPath
  if (Object.prototype.hasOwnProperty.call(content, 'seriesPath')) return text(path)
  return (!binding.mode || binding.mode === 'static') && binding.source ? text(binding.source) : 'trendPoints'
}

export function editableWidgetText(content = {}) {
  return Array.isArray(content.lines) ? content.lines.join('\n') : text(content.text)
}

export function updateWidgetTextContent(content = {}, value = '') {
  const next = text(value)
  return { ...content, text: next, ...(Array.isArray(content.lines) ? { lines: next.split(/\r?\n/) } : {}) }
}

export function widgetImageSource(content = {}, binding = {}) {
  if (content.urlSource === 'fixed' || content.urlSource === 'binding') return content.urlSource
  return content.url || !hasBinding(binding) ? 'fixed' : 'binding'
}

export function widgetStatSource(content = {}, binding = {}) {
  if (['binding', 'field', 'series'].includes(content.statSource)) return content.statSource
  if (content.statPath) return 'field'
  const value = content.value
  const scalar = value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '') && Number.isFinite(Number(value))
  return binding.mode === 'static' && !scalar ? 'series' : 'binding'
}

export function resolveWidgetImageUrl(content = {}, binding = {}, boundValue, quality = 'good') {
  if (content.urlSource === 'fixed') return text(content.url)
  if (content.urlSource === 'binding') {
    return hasBinding(binding) && ['good', 'empty'].includes(quality) && typeof boundValue === 'string' ? boundValue : ''
  }
  // Preserve the old url-first behavior until the operator selects a mode.
  return content.url || (typeof boundValue === 'string' ? boundValue : '')
}
