// Reference diagnostics are presentation-only: retain the original component,
// source IDs and layout until the user explicitly rebinds or removes it.
import { expandedBindingWidgets, widgetWorkflowIssues } from '../../../shared/widgetBindingWorkflow.mjs'
export function isMissingBindingMessage(message = '') {
  return /绑定的(?:设备|点位)不存在：/.test(message)
}

export function bindingReferenceDiagnostics(document = {}, devices = [], points = []) {
  const deviceIds = new Set(devices.map(device => String(device.id)))
  const pointIds = new Set(points.map(point => String(point.id)))
  const results = []
  const inspect = (widgets = [], prefix = '') => {
    for (const widget of widgets)results.push(...widgetWorkflowIssues(widget,`${prefix}组件 ${widget.id}`))
    for (const widget of expandedBindingWidgets(widgets)) {
      const binding = widget.data || {}
      if (binding.mode !== 'plc') continue
      const label = `${prefix}组件 ${widget.id}`
      const title = widget.title || (typeof widget.content?.title === 'string' ? widget.content.title : '')
        || ({ trend: '趋势图', hud_chart_dock: '曲线图', value: '数值', status: '状态', text: '文字' })[widget.type] || '数据组件'
      const suffix = `（${title}）；原动态绑定已保留，请重新选择数据或移除不再需要的组件。`
      if (binding.deviceScope === 'fixed' && binding.deviceId && !deviceIds.has(String(binding.deviceId))) {
        results.push(`${label} 绑定的设备不存在：${binding.deviceId}${suffix}`)
      }
      if (binding.pointId && !pointIds.has(String(binding.pointId))) {
        results.push(`${label} 绑定的点位不存在：${binding.pointId}${suffix}`)
      }
    }
  }
  inspect(document.widgets)
  for (const template of document.tooltipTemplates?.templates || []) {
    inspect(template.widgets, `悬停模板“${template.name || template.id}”：`)
  }
  return results
}

export function validationComponentId(message = '') {
  return message.match(/[”"]\s*[（(]([a-zA-Z0-9_-]+)[）)]/)?.[1]
    || message.match(/个组件\s*[（(]([a-zA-Z0-9_-]+)[）)]/)?.[1]
    || message.match(/(?:^|：)组件\s+([a-zA-Z0-9_-]+)(?=\s)/)?.[1]
    || ''
}
