export const DEVICE_TOOLTIP_FIELDS = Object.freeze([
  { id: 'name', label: '设备名称' }, { id: 'id', label: '设备编号' },
  { id: 'model', label: '模型名称' }, { id: 'workshop', label: '所属车间' },
  { id: 'line', label: '所属产线' }, { id: 'status', label: '数据状态' }
])
export const validDeviceTooltipPointKey = key => typeof key === 'string' && key.length <= 128 && /^[\p{L}\p{N}_-]+\.[\p{L}\p{N}_-]+$/u.test(key)
export function normalizeDeviceTooltip(source = {}) {
  source = source && typeof source === 'object' && !Array.isArray(source) ? source : {}
  const allowed = new Set(DEVICE_TOOLTIP_FIELDS.map(field => field.id))
  return {
    enabled: source.enabled !== false,
    title: String(source.title ?? '设备信息').trim().slice(0, 80),
    description: String(source.description ?? '').trim().slice(0, 500),
    fields: Array.isArray(source.fields) ? [...new Set(source.fields.filter(id => allowed.has(id)))] : ['name', 'status', 'workshop', 'line'],
    pointKeys: Array.isArray(source.pointKeys) ? [...new Set(source.pointKeys.filter(validDeviceTooltipPointKey))].slice(0, 8) : [],
    showHint: source.showHint !== false
  }
}
export function normalizeViewTooltipMetadata(source = {}) {
  const metadata = source && typeof source === 'object' && !Array.isArray(source) ? { ...source } : {}
  if (Object.hasOwn(metadata, 'deviceTooltip')) metadata.deviceTooltip = normalizeDeviceTooltip(metadata.deviceTooltip)
  return metadata
}
