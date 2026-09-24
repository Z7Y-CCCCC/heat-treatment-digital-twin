import { createDashboardWidget, createDashboardWidgetPreset, deepClone } from './dashboardSchema.js'

// Presentation-only migration for the shipped heat-treatment overview. Keep
// every original widget/binding for other views and for a reversible rollback.
export function applyFactoryHudModules(source) {
  if (!source?.widgets || source.metadata?.factoryHudModules === 1) return source
  if (source.metadata?.referenceHud !== 1 || source.canvas?.width !== 1920 || source.canvas?.height !== 1080) return source
  const required = ['overview_metrics','running_devices','alarm_history','temperature_trend','cfg_overview_temp_chart']
  const byId = new Map(source.widgets.map(widget => [widget.id, widget]))
  if (!required.every(id => byId.has(id))) return source
  if (source.widgets.length > 494) return source
  const view = source.scene?.views?.find(item => item.id === 'factory_overview')
  if (!view) return source
  const modules = createDashboardWidgetPreset('factory_hud_modules', { viewIds: [view.id], baseZ: 10, groupId: 'factory_hud_modules_v1' })
  modules.forEach(widget => { widget.id = `reference_${widget.id}`; widget.groupId = '' })
  if (modules.some(widget => byId.has(widget.id))) return source
  const [production, devices, alarms, trend] = modules
  const replacements = new Map([
    [production.id, 'overview_metrics'], [devices.id, 'running_devices'],
    [alarms.id, 'alarm_history'], [trend.id, 'temperature_trend']
  ])
  for (const module of modules) {
    const original = byId.get(replacements.get(module.id))
    module.frame = deepClone(original.frame)
    module.visible = original.visible
    module.locked = original.locked
    module.zIndex = original.zIndex
    module.style.backgroundOpacity = original.style?.backgroundOpacity ?? .12
  }
  // Preserve the exact configured point, including database datasets, instead
  // of substituting a visually pleasing but unrelated example curve.
  const oldChart = byId.get('cfg_overview_temp_chart')
  trend.data = deepClone(oldChart.data || {})
  trend.content = { ...trend.content, ...deepClone(oldChart.content || {}), showTitle: true, chartType: 'area', lineColor:'#a2a7ed', lineWidth:1.4, statPath: '', statLabel: '当前值', statUnit: oldChart.data?.unit || '°C' }
  trend.title = String(byId.get('cfg_temperature_trend_title')?.content?.text || '实时温度趋势').replace(/^▸\s*/, '')
  trend.conditions = deepClone(oldChart.conditions || [])
  trend.events = deepClone(oldChart.events || [])
  // The old module was only 206px tall; the new chart uses a compact heading
  // rather than silently moving any other authored widget out of its way.
  trend.content.compact = true
  const oldRing = byId.get('reference_oee_ring')
  production.content.chartPath = oldRing?.content?.chartPath || 'metrics.overall_oee'
  production.content.chartLabel = oldRing?.content?.chartLabel || '综合效率'
  production.content.items = ['total','online','running'].map((key,index) => {
    const value = byId.get(`cfg_${key}_value`)
    const label = byId.get(`cfg_${key}_label`)
    return { ...production.content.items[index], path: value?.data?.path || production.content.items[index].path, label: label?.content?.text || production.content.items[index].label }
  })
  const deviceWidgets = source.widgets.filter(widget => widget.id.startsWith('cfg_device_') && widget.visibility?.viewIds?.includes(view.id))
  devices.content.deviceIds = deviceWidgets.map(widget => widget.id.slice('cfg_device_'.length))
  devices.content.deviceActions = Object.fromEntries(deviceWidgets.map(widget => [widget.id.slice('cfg_device_'.length), deepClone(widget.events || [])]))
  devices.content.limit = Math.max(6, deviceWidgets.length)
  alarms.content.limit = 4
  const consumed = new Set([
    ...required, 'reference_oee_ring', 'cfg_overview_metrics_title', 'cfg_running_devices_title', 'cfg_alarm_history_title', 'cfg_temperature_trend_title',
    ...['total','online','running'].flatMap(key => [`cfg_${key}_label`,`cfg_${key}_value`]),
    ...deviceWidgets.flatMap(widget => [widget.id, widget.id.replace('cfg_device_', 'cfg_alarm_')]),
    ...source.widgets.filter(widget => /^cfg_event_\d+$/.test(widget.id)).map(widget => widget.id)
  ])
  const addMetricModule = (panelId, moduleId, titleId, keys, showRing) => {
    if (!byId.has(panelId) || keys.some(key => !byId.has(`cfg_${key}_value`))) return
    const original = byId.get(panelId)
    const module = createDashboardWidget('hud_kpi_panel')
    module.id = moduleId
    if (byId.has(module.id)) return
    module.title = String(byId.get(titleId)?.content?.text || original.title || '').replace(/^▸\s*/, '')
    module.frame = deepClone(original.frame)
    module.visible = original.visible
    module.locked = original.locked
    module.zIndex = original.zIndex
    module.style.backgroundOpacity = original.style?.backgroundOpacity ?? .12
    module.visibility = { ...module.visibility, viewIds:[view.id], viewModes:['factory'] }
    module.content = { ...module.content, showRing, compact:true, eyebrow:showRing ? 'CONSUMPTION' : 'PROCESS MEDIA', chartPath:production.content.chartPath,
      items:keys.map(key => {
        const value = byId.get(`cfg_${key}_value`), label = byId.get(`cfg_${key}_label`)
        const text = String(value.content?.text || '')
        return { label:label?.content?.text || key, path:value.data?.path || '', value:value.data?.path ? undefined : text.replaceAll('{value}', String(value.content?.value ?? value.content?.fallback ?? '--')),
          unit:value.data?.path ? text.replace('{value}','').trim() : '', decimals:value.data?.decimals ?? 1 }
      }) }
    if (showRing) module.content.note = byId.get('cfg_usage_note')?.content?.text || '累计量为固定演示值，非现场积分统计'
    modules.push(module)
    replacements.set(module.id,panelId)
    consumed.add(panelId); consumed.add(titleId)
    keys.forEach(key=>{consumed.add(`cfg_${key}_label`); consumed.add(`cfg_${key}_value`)})
    if (showRing) ['cfg_usage_oee_label','cfg_usage_oee_value','cfg_usage_note'].forEach(id=>consumed.add(id))
  }
  addMetricModule('gas_metrics','reference_hud_factory_media','cfg_gas_metrics_title',['ammonia_flow','methanol_flow'],false)
  addMetricModule('line_monitor','reference_hud_factory_consumption','cfg_line_monitor_title',['usage_ammonia','usage_methanol'],true)
  const result = deepClone(source)
  const targetView = result.scene.views.find(item => item.id === view.id)
  const state = targetView.componentState || (targetView.componentState = { show: [], hide: [] })
  const originalHide = new Set(state.hide || [])
  const originalShow = new Set(state.show || [])
  for (const module of modules) {
    const originalId = replacements.get(module.id)
    if (originalHide.has(originalId) || (originalShow.size && !originalShow.has(originalId))) state.hide = [...(state.hide || []), module.id]
    else if (originalShow.size) state.show = [...(state.show || []), module.id]
  }
  state.hide = [...new Set([...(state.hide || []), ...consumed])]
  state.show = (state.show || []).filter(id => !consumed.has(id))
  result.widgets.push(...modules)
  result.metadata = { ...result.metadata, factoryHudModules: 1 }
  return result
}
