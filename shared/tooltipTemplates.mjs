import { DEVICE_TOOLTIP_FIELDS, normalizeDeviceTooltip, validDeviceTooltipPointKey } from './deviceTooltip.mjs'

export const MAX_TOOLTIP_TEMPLATES = 32
export const MAX_TOOLTIP_WIDGETS = 80
export const TOOLTIP_WIDGET_TYPES = Object.freeze(['text', 'value', 'status', 'container', 'image'])
const clone = value => JSON.parse(JSON.stringify(value))
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback
const id = (value, fallback = '') => String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
const text = (value, fallback = '', max = 128) => String(value ?? fallback).slice(0, max)
const defaultIds = { device: 'tooltip_device', part: 'tooltip_part' }
const dynamicModes = new Set(['runtime', 'plc', 'dataset', 'database', 'http_api', 'business'])
// Displayed point identities/units are metadata too, but value/text are live
// measurements and may legitimately use authored numeric/code mappings.
export function isTooltipMetadataPath(path) {
  if (typeof path !== 'string') return false
  const value = path
  return /^hover\.(device|part)\.(name|id|modelName|status|workshopName|lineName|group|description|hint)$/.test(value)
    || /^hover\.part\.points\.\d+\.(name|label|id|unit)$/.test(value)
    || /^hover\.device\.pointMap\.[^.]+\.[^.]+\.(name|label|id|unit)$/.test(value)
}
const deviceFields = { name: 'name', id_value: 'id', model_value: 'modelName', status_value: 'status', workshop_value: 'workshopName', line_value: 'lineName' }
const partFields = { name: 'name', group: 'group', description: 'description', hint: 'hint' }
const runtimeSource = path => ({ mode: 'runtime', path, deviceScope: 'current', readOnly: true })

function presetBinding(widget, template = {}) {
  if (!['text', 'value', 'status'].includes(widget?.type)) return null
  const templateId = String(template.id || ''), widgetId = String(widget.id || '')
  const kind = template.kind || (widgetId.startsWith('tooltip_device_') ? 'device' : widgetId.startsWith('tooltip_part_') ? 'part' : '')
  const prefix = templateId || (kind ? defaultIds[kind] : '')
  if (!prefix || !['device', 'part'].includes(kind)) return null
  const key = widgetId.startsWith(`${prefix}_`) ? widgetId.slice(prefix.length + 1) : ''
  const fields = kind === 'device' ? deviceFields : partFields
  if (fields[key]) return runtimeSource(`hover.${kind}.${fields[key]}`)
  const partPoint = /^point_(\d+)_(label|value)$/.exec(key)
  if (kind === 'part' && partPoint) return runtimeSource(`hover.part.points.${Number(partPoint[1])}.${partPoint[2] === 'label' ? 'name' : 'text'}`)
  // Earlier copies replaced semantic IDs with numeric positions. Recover only
  // these generated IDs with a unique original data-layer title, never by the
  // displayed sample string (a custom caption may legitimately say 数据正常).
  if (!/^(?:\d+|copy_\d+_\d+)$/.test(key) || !Array.isArray(template.widgets)) return null
  const title = String(widget.title || '')
  if (template.widgets.filter(item => item?.title === title).length !== 1) return null
  const titles = kind === 'device' ? {
    '设备名称': 'name', '设备编号数据': 'id', '模型名称数据': 'modelName', '数据状态数据': 'status',
    '所属车间数据': 'workshopName', '所属产线数据': 'lineName'
  } : { '部件名称': 'name', '部件分组': 'group', '部件说明': 'description', '点击提示': 'hint' }
  if (titles[title]) return runtimeSource(`hover.${kind}.${titles[title]}`)
  const namedPoint = kind === 'part' ? /^参数 (\d+)(标签|数据)$/.exec(title) : null
  if (namedPoint) return runtimeSource(`hover.part.points.${Math.max(0, Number(namedPoint[1]) - 1)}.${namedPoint[2] === '标签' ? 'name' : 'text'}`)
  const pointTitle = kind === 'device' ? /^(.*)(标签|数据)$/.exec(title) : null
  if (pointTitle && validDeviceTooltipPointKey(pointTitle[1])) return runtimeSource(`hover.device.pointMap.${pointTitle[1]}.${pointTitle[2] === '标签' ? 'name' : 'text'}`)
  return null
}

/** A persisted source snapshot survives conversion bugs, copy and ID remaps. */
export function tooltipDynamicBinding(widget = {}, template = {}) {
  const source = object(widget), data = object(source.data || source.binding)
  if (dynamicModes.has(data.mode)) return { ...clone(data), readOnly: true }
  const saved = object(source.dynamicBinding)
  if (dynamicModes.has(saved.mode)) return { ...clone(saved), readOnly: true }
  if (isTooltipMetadataPath(source.dynamicField)) return runtimeSource(source.dynamicField)
  if (isTooltipMetadataPath(data.path || data.source)) return { ...clone(data), ...runtimeSource(data.path || data.source) }
  return presetBinding(source, template)
}

/** Repair the binding only; authored captions, geometry and styling are kept. */
export function restoreTooltipDynamicBinding(widget = {}, template = {}) {
  const source = object(widget), binding = tooltipDynamicBinding(source, template)
  if (!binding) {
    const result = { ...source }
    delete result.dynamicBinding
    delete result.dynamicField
    return result
  }
  const data = { ...object(source.data || source.binding), ...binding, readOnly: true }
  const content = { ...object(source.content) }
  const linkedMetadata = data.mode === 'runtime' && isTooltipMetadataPath(data.path || data.source)
  if (source.type === 'text') {
    // Older freezes sometimes left a constant `lines` array which shadows
    // text. Existing formats that contain the live value are not freezes.
    const liveLines = Array.isArray(content.lines) && content.lines.join('\n').includes('{value}')
    const liveText = String(content.text || content.label || '').includes('{value}')
    if (!liveLines) {
      delete content.lines
      if (!liveText) { content.text = linkedMetadata ? '{value}' : '{value}{unit}'; delete content.value }
    }
  }
  // Metadata cannot be relabelled to invented connection states or names.
  if (linkedMetadata) delete content.valueMap
  const systemField = isTooltipMetadataPath(source.dynamicField) ? source.dynamicField : presetBinding(source, template)?.path
  const result = { ...source, data, content, dynamicBinding: clone(data) }
  // Only original preset fields own an immutable semantic role. A newly added
  // bound text must still be able to choose another actual dynamic field.
  if (isTooltipMetadataPath(systemField)) result.dynamicField = systemField
  else delete result.dynamicField
  return result
}

/** One template background follows the local canvas; ordinary areas do not. */
export function tooltipBackgroundWidget(template = {}) {
  template = object(template)
  const widgets = Array.isArray(template.widgets) ? template.widgets : []
  const containers = widgets.filter(widget => widget?.type === 'container')
  if (Object.hasOwn(template, 'backgroundWidgetId')) {
    if (!template.backgroundWidgetId) return null
    const matches = containers.filter(widget => widget.id === template.backgroundWidgetId)
    return matches.length === 1 ? matches[0] : null
  }
  // Old presets/copies had no marker. Recognize only the original upright
  // background, including the saved state after canvas size changed alone.
  const atOrigin = containers.filter(widget => Number(widget.frame?.x) === 0 && Number(widget.frame?.y) === 0 && Number(widget.frame?.rotation || 0) === 0)
  const byId = atOrigin.filter(widget => widget.id === `${template.id}_background`)
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) return null
  const byTitle = atOrigin.filter(widget => widget.title === '提示背景')
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) return null
  const lowest = widgets.reduce((value, widget) => Math.min(value, Number(widget?.zIndex || 0)), Infinity)
  const fullCanvas = atOrigin.filter(widget => Number(widget.frame?.width) === Number(template.canvas?.width)
    && Number(widget.frame?.height) === Number(template.canvas?.height) && Number(widget.zIndex || 0) === lowest
    && widget.style?.background && widget.style.background !== 'transparent')
  return fullCanvas.length === 1 ? fullCanvas[0] : null
}

export function normalizeTooltipTemplateRefs(metadata = {}) {
  const result = { ...object(metadata) }
  if (Object.hasOwn(result, 'tooltipTemplates')) {
    const refs = object(result.tooltipTemplates)
    result.tooltipTemplates = Object.fromEntries(['device', 'part'].map(kind => [kind, ['inherit', 'disabled'].includes(refs[kind]) ? refs[kind] : id(refs[kind], 'inherit')]))
    if (result.deviceTooltip) result.deviceTooltip = { ...normalizeDeviceTooltip(result.deviceTooltip), enabled: result.tooltipTemplates.device !== 'disabled' }
  }
  return result
}

// A preset is ordinary independently positioned widgets, not an opaque panel.
export function createTooltipTemplate(kind = 'device', templateId = defaultIds[kind], legacyOptions) {
  kind = kind === 'part' ? 'part' : 'device'
  const template = { id: id(templateId, defaultIds[kind]), name: kind === 'part' ? '部件提示' : '设备提示', kind,
    canvas: { width: 280, height: 230, gridSize: 4, background: 'transparent' }, widgets: [] }
  const add = (key, title, type, frame, content, style = {}, data = {}) => {
    template.widgets.push({ id: `${template.id}_${key}`, title, type, frame: { rotation: 0, ...frame }, visible: true, locked: false,
      zIndex: template.widgets.length, runtimeTarget: 'overlay', groupId: '',
      content: { showTitle: false, showDeviceLabel: false, fallback: '—', ...content },
      style: { color: '#e7eaff', fontSize: 11, padding: 0, borderRadius: 0, borderColor: 'transparent', background: 'transparent', backgroundOpacity: 0, opacity: 1, ...style },
      data: { mode: 'static', deviceScope: 'current', readOnly: true, ...data }, visibility: {}, conditions: [], events: [], animation: { type: 'none' } })
  }
  const label = (key, title, value, y, style = {}) => add(key, title, 'text', { x: 20, y, width: 240, height: 22 }, { text: value }, style)
  const bound = (key, title, path, y, frame = {}, style = {}) => { add(key, title, 'text', { x: 20, y, width: 240, height: 22, ...frame }, { text: '{value}', align: frame.x >= 100 ? 'right' : 'left' }, style, { mode: 'runtime', path }); template.widgets.at(-1).dynamicBinding = clone(template.widgets.at(-1).data); if (isTooltipMetadataPath(path)) template.widgets.at(-1).dynamicField = path }
  const divider = y => add(`line_${y}`, '分隔线', 'container', { x: 20, y, width: 240, height: 1 }, {}, { background: '#bfcaf5', backgroundOpacity: .13 })
  const row = (key, title, path, y) => { divider(y); label(`${key}_label`, `${title}标签`, title, y + 4, { color: '#abb5d1' });
    // Label and value do not overlap and remain separately selectable.
    template.widgets.at(-1).frame.width = 106
    bound(`${key}_value`, `${title}数据`, path, y + 4, { x: 126, width: 134 }, { fontWeight: 600 }) }
  add('background', '提示背景', 'container', { x: 0, y: 0, width: 280, height: 230 }, {},
    { background: '#24263a', backgroundOpacity: .82, borderColor: 'rgba(191,202,245,.24)', borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,.2)' })
  template.backgroundWidgetId = template.widgets[0].id
  if (kind === 'device') {
    const options = normalizeDeviceTooltip(legacyOptions)
    label('title', '提示标题', options.title, 12, { color: '#aeb9d4', fontSize: 9 })
    let y = 34
    if (options.fields.includes('name')) { bound('name', '设备名称', 'hover.device.name', y, {}, { fontSize: 16, fontWeight: 600 }); y += 34 }
    if (options.description) { label('description', '补充说明', options.description, y, { color: '#c4c9dc' }); template.widgets.at(-1).frame.height = 48; y += 52 }
    const paths = { id: 'id', model: 'modelName', workshop: 'workshopName', line: 'lineName', status: 'status' }
    for (const field of options.fields.filter(key => key !== 'name')) {
      row(field, DEVICE_TOOLTIP_FIELDS.find(item => item.id === field)?.label || field, `hover.device.${paths[field]}`, y); y += 34
    }
    for (const [index, pointKey] of options.pointKeys.entries()) {
      row(`point_${index}`, pointKey, `hover.device.pointMap.${pointKey}.text`, y)
      const fieldLabel = template.widgets.find(widget => widget.id === `${template.id}_point_${index}_label`)
      fieldLabel.content.text = '{value}'; fieldLabel.data = { mode: 'runtime', deviceScope: 'current', readOnly: true, path: `hover.device.pointMap.${pointKey}.name` }
      fieldLabel.dynamicBinding = clone(fieldLabel.data)
      fieldLabel.dynamicField = fieldLabel.data.path
      y += 34
    }
    if (options.showHint) { label('hint', '点击提示', '点击进入设备', y + 4, { color: '#aebaff', fontSize: 10 }); y += 30 }
    template.canvas.height = Math.max(100, y + 12)
  } else {
    label('title', '提示标题', 'COMPONENT / 部件', 12, { color: '#aeb9d4', fontSize: 9 })
    bound('name', '部件名称', 'hover.part.name', 34, {}, { fontSize: 16, fontWeight: 600 })
    bound('group', '部件分组', 'hover.part.group', 61, {}, { color: '#9ca9cb', fontSize: 10 })
    bound('description', '部件说明', 'hover.part.description', 84, { height: 42 }, { color: '#c4c9dc' })
    let y = 134
    for (let index = 0; index < 3; index++) {
      row(`point_${index}`, `参数 ${index + 1}`, `hover.part.points.${index}.text`, y)
      const fieldLabel = template.widgets.find(widget => widget.id === `${template.id}_point_${index}_label`)
      fieldLabel.content.text = '{value}'; fieldLabel.data = { mode: 'runtime', deviceScope: 'current', readOnly: true, path: `hover.part.points.${index}.name` }
      fieldLabel.dynamicBinding = clone(fieldLabel.data)
      fieldLabel.dynamicField = fieldLabel.data.path
      y += 34
    }
    bound('hint', '点击提示', 'hover.part.hint', y + 4, {}, { color: '#aebaff', fontSize: 10 })
    template.canvas.height = y + 38
  }
  template.widgets[0].frame.height = template.canvas.height
  return template
}

export function tooltipDocumentWidgets(document = {}) {
  return [...(document.widgets || []), ...(document.tooltipTemplates?.templates || []).flatMap(template => template.widgets || [])]
}

export function normalizeTooltipTemplates(source, views = [], normalizeWidget = widget => widget) {
  const input = object(source), fresh = !Array.isArray(input.templates)
  const raw = fresh ? [createTooltipTemplate('device'), createTooltipTemplate('part')] : input.templates.slice(0, MAX_TOOLTIP_TEMPLATES)
  const ids = new Set()
  const templates = raw.filter(item => item && ['device', 'part'].includes(item.kind)).map((item, index) => {
    let templateId = id(item.id, `tooltip_${item.kind}_${index + 1}`)
    while (ids.has(templateId)) templateId = `${templateId.slice(0, 116)}_${index + 1}_${ids.size}`
    ids.add(templateId)
    const canvas = { width: Math.round(number(item.canvas?.width, 280, 180, 960)), height: Math.round(number(item.canvas?.height, 230, 80, 1080)),
      gridSize: Math.round(number(item.canvas?.gridSize, 4, 1, 50)), background: text(item.canvas?.background, 'transparent', 512), safeArea: 0 }
    const rawBackground = tooltipBackgroundWidget(item)
    let backgroundWidgetId = ''
    const widgetIds = new Set()
    const widgets = (Array.isArray(item.widgets) ? item.widgets : []).filter(widget => TOOLTIP_WIDGET_TYPES.includes(widget?.type)).slice(0, MAX_TOOLTIP_WIDGETS).map((widget, widgetIndex) => {
      const repaired = restoreTooltipDynamicBinding(clone(widget), item)
      const normalized = normalizeWidget(repaired, canvas, widgetIndex)
      let widgetId = id(normalized.id, `${templateId}_widget_${widgetIndex + 1}`)
      while (widgetIds.has(widgetId)) widgetId = `${widgetId.slice(0, 116)}_${widgetIndex + 1}_${widgetIds.size}`
      widgetIds.add(widgetId)
      if (widget === rawBackground) backgroundWidgetId = widgetId
      return { ...normalized, ...(repaired.dynamicBinding ? { dynamicBinding: clone(normalized.data) } : {}), ...(repaired.dynamicField ? { dynamicField: repaired.dynamicField } : {}), id: widgetId, runtimeTarget: 'overlay', frame: { ...normalized.frame,
        x: number(normalized.frame?.x, 0, -canvas.width, canvas.width * 2), y: number(normalized.frame?.y, 0, -canvas.height, canvas.height * 2),
        width: number(normalized.frame?.width, 100, 1, canvas.width * 2), height: number(widget.frame?.height ?? normalized.frame?.height, 22, widget.type === 'container' ? 1 : 20, canvas.height * 2) },
        visibility: {}, data: { ...object(normalized.data), readOnly: true } }
    })
    const background = widgets.find(widget => widget.id === backgroundWidgetId)
    if (background) background.frame = { ...background.frame, x: 0, y: 0, width: canvas.width, height: canvas.height, rotation: 0 }
    return { id: templateId, name: text(item.name, item.kind === 'part' ? '部件提示' : '设备提示'), kind: item.kind, canvas, widgets, backgroundWidgetId }
  })
  for (const kind of ['device', 'part']) if (!templates.some(template => template.kind === kind)) {
    let missingId = defaultIds[kind]
    while (templates.some(template => template.id === missingId)) missingId += '_default'
    const preset = createTooltipTemplate(kind, missingId)
    // Reuse the same normalizer for the missing built-in template.
    const normalized = normalizeTooltipTemplates({ templates: [preset, createTooltipTemplate(kind === 'device' ? 'part' : 'device')] }, [], normalizeWidget)
    if (templates.length >= MAX_TOOLTIP_TEMPLATES) templates.pop()
    templates.push(normalized.templates.find(template => template.kind === kind))
  }
  const defaults = Object.fromEntries(['device', 'part'].map(kind => [kind, templates.find(template => template.id === input.defaults?.[kind] && template.kind === kind)?.id || templates.find(template => template.kind === kind).id]))
  for (const view of views) {
    if (!view.metadata?.deviceTooltip || view.metadata?.tooltipTemplates?.device) continue
    const options = normalizeDeviceTooltip(view.metadata.deviceTooltip)
    view.metadata = { ...view.metadata, tooltipTemplates: { ...view.metadata.tooltipTemplates, device: 'inherit', part: view.metadata.tooltipTemplates?.part || 'inherit' } }
    if (!options.enabled) view.metadata.tooltipTemplates.device = 'disabled'
    else if (JSON.stringify(options) !== JSON.stringify(normalizeDeviceTooltip()) && templates.length < MAX_TOOLTIP_TEMPLATES) {
      let legacyId = id(`tooltip_legacy_${view.id}`)
      while (templates.some(template => template.id === legacyId)) legacyId = `${legacyId.slice(0, 116)}_legacy`
      const preset = createTooltipTemplate('device', legacyId, options)
      const normalized = normalizeTooltipTemplates({ templates: [preset, createTooltipTemplate('part')] }, [], normalizeWidget).templates[0]
      normalized.name = `${view.name || view.id} · 设备提示`
      templates.push(normalized); view.metadata.tooltipTemplates.device = normalized.id
    }
  }
  for (const view of views) if (view.metadata?.tooltipTemplates) {
    view.metadata = normalizeTooltipTemplateRefs(view.metadata)
    for (const kind of ['device', 'part']) {
      const ref = view.metadata.tooltipTemplates[kind]
      if (!['inherit', 'disabled'].includes(ref) && !templates.some(template => template.id === ref && template.kind === kind)) view.metadata.tooltipTemplates[kind] = 'inherit'
    }
  }
  return { version: 1, defaults, templates }
}

export function resolveTooltipTemplate(document, view, kind = 'device') {
  const config = document?.tooltipTemplates
  if (!config?.templates) return null
  const ref = view?.metadata?.tooltipTemplates?.[kind] || 'inherit'
  if (ref === 'disabled') return null
  const target = ref === 'inherit' ? config.defaults?.[kind] : ref
  return config.templates.find(template => template.id === target && template.kind === kind) || config.templates.find(template => template.id === config.defaults?.[kind] && template.kind === kind) || null
}
