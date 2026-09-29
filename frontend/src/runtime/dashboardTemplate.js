import { DASHBOARD_SCHEMA_VERSION, normalizeDashboardDocument } from './dashboardSchema.js'

export const DASHBOARD_TEMPLATE_FORMAT = 'dashboard-template'
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024

export function exportDashboardTemplate(document) {
  return JSON.stringify({ format: DASHBOARD_TEMPLATE_FORMAT, version: 1, document: normalizeDashboardDocument(document) }, null, 2)
}

export function importDashboardTemplate(text, targetDocument) {
  if (new TextEncoder().encode(text).length > MAX_TEMPLATE_BYTES) throw new Error('模板不能超过 5 MB')
  const envelope = JSON.parse(text)
  if (envelope?.format !== DASHBOARD_TEMPLATE_FORMAT || envelope.version !== 1) throw new Error('请选择版本 1 的大屏模板 JSON 文件')
  const source = envelope.document
  if (!source || typeof source !== 'object' || !Array.isArray(source.widgets) || !Array.isArray(source.scene?.views)) throw new Error('模板缺少组件或视角定义')
  if (source.schemaVersion > DASHBOARD_SCHEMA_VERSION) throw new Error('模板来自更新版本，请先升级程序')
  if (source.widgets.length > 500 || source.scene.views.length > 50) throw new Error('模板超过 500 个组件或 50 个视角的上限')
  for (const [label, rows] of [['组件', source.widgets], ['视角', source.scene.views]]) {
    const ids = new Set()
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !/^[a-zA-Z0-9_-]+$/.test(row.id || '') || ids.has(row.id)) throw new Error(`${label} ID 缺失、重复或包含无效字符`)
      ids.add(row.id)
    }
  }
  // Layout reuse must never redirect a save to the source project's scene.
  return normalizeDashboardDocument({ ...source, projectId: targetDocument.projectId, sceneId: targetDocument.sceneId })
}

const REFERENCE_FIELDS = { deviceId: 'devices', device_id: 'devices', pointId: 'points', point_id: 'points', connectionId: 'connections', connection_id: 'connections', workshopId: 'workshops', workshop_id: 'workshops', lineId: 'lines', line_id: 'lines' }

function visitReferences(document, visit) {
  function walk(value, path = []) {
    if (!value || typeof value !== 'object') return
    if (value.source === 'context' && REFERENCE_FIELDS[value.path] && typeof value.value === 'string' && value.value) {
      visit(value, 'value', REFERENCE_FIELDS[value.path], value.value, [...path, 'value'])
    }
    for (const [field, item] of Object.entries(value)) {
      const kind = REFERENCE_FIELDS[field]
      if (kind && typeof item === 'string' && item) visit(value, field, kind, item, [...path, field])
      else if (Array.isArray(item) && REFERENCE_FIELDS[field.replace(/Ids$/, 'Id')]) {
        const listKind = REFERENCE_FIELDS[field.replace(/Ids$/, 'Id')]
        item.forEach((id, index) => { if (typeof id === 'string' && id) visit(item, index, listKind, id, [...path, field, String(index)]) })
      }
      else if (item && typeof item === 'object') walk(item, [...path, field])
    }
  }
  walk(document.widgets, ['widgets'])
  for (const [index, view] of document.scene.views.entries()) {
    const kind = { device: 'devices', device_part: 'devices', line: 'lines', workshop: 'workshops' }[view.targetType]
    if (kind && view.targetId) visit(view, 'targetId', kind, view.targetId, ['scene', 'views', String(index), 'targetId'])
  }
}

export function dashboardTemplateReferences(document) {
  const references = new Map()
  visitReferences(document, (_owner, _field, kind, id, path) => {
    const key = `${kind}:${id}`
    if (!references.has(key)) references.set(key, { key, kind, id, uses: [] })
    references.get(key).uses.push(path.join('.'))
  })
  return [...references.values()]
}

export function rebindDashboardTemplate(document, mapping, catalog) {
  const result = JSON.parse(JSON.stringify(document))
  visitReferences(result, (owner, field, kind, id) => {
    const target = mapping[`${kind}:${id}`]
    if (!target || !(catalog[kind] || []).some(row => String(row.id) === target)) throw new Error(`请为 ${id} 选择当前工厂的有效目标`)
    owner[field] = target
  })
  for (const widget of result.widgets) {
    const data = widget.data
    const point = (catalog.points || []).find(row => String(row.id) === data.pointId)
    if (data.deviceId && data.pointId) {
      if (point?.device_id && String(point.device_id) !== data.deviceId) throw new Error(`组件“${widget.title || widget.id}”的点位不属于所选设备`)
    }
    if (data.mode === 'plc' && point) {
      const key = point.value_role || point.field_name || point.name
      data.pointKey = key ? `${point.category || point.category_resolved || 'analog'}.${key}` : ''
      data.path = data.pointKey
      data.unit = point.unit || ''
    }
    if (data.connectionId) {
      const source = (catalog.connections || []).find(row => String(row.id) === data.connectionId)
      const isHttp = source?.sourceType === 'http_api' || source?.type === 'http_api'
      if ((data.mode === 'http_api' && !isHttp) || (['database', 'business'].includes(data.mode) && isHttp)) throw new Error(`组件“${widget.title || widget.id}”的数据源类型不匹配`)
    }
    if (['database', 'business'].includes(data.mode)) {
      for (const dataset of data.datasets || []) {
        const source = (catalog.connections || []).find(row => String(row.id) === dataset.connectionId)
        if (source?.sourceType === 'http_api' || source?.type === 'http_api') throw new Error(`组件“${widget.title || widget.id}”的数据集必须绑定数据库`)
      }
    }
  }
  return normalizeDashboardDocument(result)
}
