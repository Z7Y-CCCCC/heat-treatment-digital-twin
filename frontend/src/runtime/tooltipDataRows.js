import { tooltipBackgroundWidget, isTooltipMetadataPath } from '../../../shared/tooltipTemplates.mjs'
import { catalogBinding } from './dataCatalog.js'

const clone = value => JSON.parse(JSON.stringify(value))
const isBound = widget => ['runtime', 'plc', 'dataset', 'database', 'http_api', 'business'].includes(widget.data?.mode)
const isHint = widget => widget.title === '点击提示' || widget.data?.path === 'hover.part.hint'
const bodyWidget = (widget, background) => widget !== background && !isHint(widget) && widget.visible !== false && widget.type !== 'image' && widget.frame?.height > 1

/** Build an atomic basic-widget insertion. The caller commits once for undo. */
export function addTooltipDataRow(source, { item, label = '', stamp = Date.now() } = {}) {
  const binding = catalogBinding(item, { tooltip: true, kind: source?.kind })
  if (!source || !binding) throw new Error('请选择适用于当前悬停对象的数据项')
  const title = String(label || item.label || '').trim().slice(0, 128)
  if (!title) throw new Error('请输入左侧数据标题')
  if (source.widgets.length + 3 > 80) throw new Error('当前提示已达到 80 个基础组件上限，请删除不需要的行后再添加')
  const template = clone(source), background = tooltipBackgroundWidget(template)
  const textWidgets = template.widgets.filter(widget => widget.type === 'text' && widget !== background && !isHint(widget) && Number(widget.frame?.rotation || 0) === 0)
  const pairs = textWidgets.filter(widget => isBound(widget) && widget.frame.x >= template.canvas.width * .35).map(value => ({
    value, label: textWidgets.find(candidate => candidate !== value && Math.abs(candidate.frame.y - value.frame.y) <= 2
      && candidate.frame.x + candidate.frame.width <= value.frame.x + 2)
  })).filter(pair => pair.label).sort((a, b) => a.value.frame.y - b.value.frame.y)
  const previous = pairs.at(-1)
  const rowHeight = Math.max(22, previous?.value.frame.height || 22, previous?.label.frame.height || 22)
  const inferredStep = pairs.length > 1 ? previous.value.frame.y - pairs.at(-2).value.frame.y : 34
  const step = Math.max(rowHeight + 12, Math.min(96, inferredStep > 0 ? inferredStep : 34))
  const body = template.widgets.filter(widget => bodyWidget(widget, background))
  const bodyBottom = body.length ? Math.max(...body.map(widget => widget.frame.y + widget.frame.height)) : 48
  const insertTop = previous ? Math.max(previous.value.frame.y + step - 4, bodyBottom + 8) : bodyBottom + 8
  const y = insertTop + 4
  const prefix = `${template.id.slice(0, 80)}_row_${String(stamp).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24)}`
  if (template.widgets.some(widget => widget.id.startsWith(`${prefix}_`))) throw new Error('正在添加数据行，请稍后重试')
  const fallbackText = textWidgets.find(widget => widget.data?.mode === 'static') || textWidgets[0]
  const base = previous?.value || fallbackText
  if (!base) throw new Error('模板没有可复用的文字样式，请先添加一个基础文字组件')
  const make = (original, suffix) => {
    const widget = clone(original || base)
    widget.id = `${prefix}_${suffix}`; widget.groupId = `${prefix}_group`; widget.locked = false; widget.visible = true
    widget.type = 'text'; widget.events = []; widget.conditions = []; widget.frame.rotation = 0
    widget.zIndex = Math.max(0, ...template.widgets.map(item => item.zIndex || 0)) + (suffix === 'label' ? 2 : 3)
    widget.content = { ...widget.content, text: '', showTitle: false, showDeviceLabel: false, fallback: '—' }
    delete widget.content.lines; delete widget.content.valueMap; delete widget.content.value; delete widget.content.label
    delete widget.dynamicBinding; delete widget.dynamicField
    return widget
  }
  const left = make(previous?.label || fallbackText, 'label'), right = make(previous?.value || fallbackText, 'value')
  const padding = previous?.label.frame.x ?? 20
  const split = previous?.value.frame.x ?? Math.round(template.canvas.width * .45)
  const edge = previous ? previous.value.frame.x + previous.value.frame.width : template.canvas.width - padding
  Object.assign(left.frame, { x: padding, y, width: Math.max(24, split - padding), height: rowHeight })
  Object.assign(right.frame, { x: split, y, width: Math.max(24, edge - split), height: rowHeight })
  left.title = `${title}标题`; left.content.text = title; left.content.align = 'left'; left.data = { mode: 'static', readOnly: true, deviceScope: 'current' }
  right.title = `${title}数据`; right.content.text = binding.mode === 'runtime' && isTooltipMetadataPath(binding.path) ? '{value}' : '{value}{unit}'
  right.content.align = previous?.value.content.align || 'right'; right.content.datasetTextMode = 'template'; right.data = binding; right.dynamicBinding = clone(binding)
  const priorDivider = template.widgets.filter(widget => widget.type === 'container' && widget !== background && widget.frame.height <= 2 && widget.frame.y <= (previous?.value.frame.y ?? y)).sort((a, b) => b.frame.y - a.frame.y)[0]
  const divider = priorDivider ? clone(priorDivider) : { type: 'container', style: { background: '#bfcaf5', backgroundOpacity: .13, borderWidth: 0, borderRadius: 0, padding: 0 }, content: {}, data: { mode: 'static', readOnly: true }, animation: { type: 'none' }, runtimeTarget: 'overlay' }
  Object.assign(divider, { id: `${prefix}_divider`, title: `${title}分隔线`, groupId: `${prefix}_group`, locked: false, visible: true, zIndex: left.zIndex - 1, events: [], conditions: [] })
  divider.frame = { x: padding, y: insertTop, width: edge - padding, height: priorDivider?.frame.height || 1, rotation: 0 }
  const hints = template.widgets.filter(isHint).map(widget => ({ widget, originalY: widget.frame.y }))
  const footerLines = new Set(hints.flatMap(hint => template.widgets.filter(widget => widget !== background && widget.type === 'container' && widget.frame.height <= 2 && widget.frame.y >= hint.originalY - 8 && widget.frame.y < hint.originalY)))
  for (const widget of template.widgets) if (widget !== background && widget.frame.y >= insertTop) widget.frame.y += step
  // A previously enlarged/custom row can already extend below the old hint.
  // Move the footer beneath the new row even if its old Y was above insertion.
  for (const hint of hints) {
    const targetY = Math.max(hint.originalY + step, y + rowHeight + 12)
    const delta = targetY - hint.widget.frame.y
    hint.widget.frame.y = targetY
    for (const line of footerLines) if (Math.abs(line.frame.y - (hint.originalY + (hint.originalY >= insertTop ? step : 0))) <= 8) line.frame.y += delta
  }
  template.widgets.push(divider, left, right)
  const bottom = Math.max(0, ...template.widgets.filter(widget => widget !== background).map(widget => widget.frame.y + widget.frame.height))
  const height = Math.max(template.canvas.height + step, bottom + 12)
  if (height > 1080) throw new Error('新增这一行会超过提示高度上限 1080，请先精简或缩小现有行')
  template.canvas.height = Math.ceil(height)
  if (background) { template.backgroundWidgetId = background.id; Object.assign(background.frame, { x: 0, y: 0, width: template.canvas.width, height: template.canvas.height, rotation: 0 }) }
  return { template, selectedIds: [left.id, right.id, divider.id] }
}
