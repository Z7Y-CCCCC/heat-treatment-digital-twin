import { normalizeDashboardDocument } from '../../src/runtime/dashboardSchema.js'

export function approvedOverviewFixture() {
  const sources = [
    ['kpi', 'hud_kpi_panel'], ['devices', 'hud_device_status'], ['alarms', 'hud_alarm_panel'],
    ['trend', 'hud_chart_dock'], ['media', 'hud_kpi_panel'], ['consumption', 'hud_kpi_panel']
  ].map(([role, type]) => ({ id: `reference_hud_factory_${role}`, type,
    visibility: { viewIds: ['factory_overview'] },
    style: { background: role === 'trend' ? '#241f2e' : 'rgba(10,18,34,.12)', backgroundOpacity: role === 'trend' ? 1 : .12,
      color: '#eef7ff', borderColor: role === 'trend' ? '#ffc45f' : 'rgba(137,149,245,.24)', borderRadius: 10, opacity: 1, shadow: 'soft' },
    content: { lineColor: '#68d5ff', areaColor: 'rgba(104,213,255,.2)', lineWidth: 1.4, areaOpacity: .2 } }))
  return normalizeDashboardDocument({ sceneId: 'approved-scene', metadata: { referenceHud: 1, factoryHudModules: 1,
    approvedOverviewStyle: { version: 2, sourceViewId: 'factory_overview' } },
    scene: { views: [{ id: 'factory_overview', mode: 'factory', componentState: { hide: ['detail_trend', 'cfg_param_a_value', 'cfg_device_trend_Furnace_01'] } },
      { id: 'device_detail', mode: 'device', parentViewId: 'factory_overview' }] },
    widgets: [...sources,
      { id: 'detail_trend', type: 'container', style: { background: '#0055ff', padding: 0 }, visibility: { viewIds: ['device_detail'] } },
      { id: 'cfg_param_a_value', type: 'text', content: { text: '{value} ℃' }, data: { mode: 'runtime', path: 'selectedDevice.temperature' }, visibility: { viewIds: ['device_detail'] }, style: { color: '#00ffff' } },
      { id: 'cfg_device_trend_Furnace_01', type: 'trend', content: { chartType: 'area', lineColor: '#00ffff' },
        data: { mode: 'plc', deviceId: 'Furnace_01', pointId: 'real-point', deviceScope: 'fixed' }, visibility: { viewIds: ['device_detail'] } }
    ] })
}
