// One idempotent presentation migration shared by the live WebView and editor.
// Only the shipped heat-treatment overview is recognized; custom documents and
// device inspection views retain their geometry, events and data bindings.
export function applyReferenceHudLayout(source) {
  if (!source?.widgets || source.metadata?.referenceHud === 1) return source
  const originals = source.widgets
  const groups = {
    overview_metrics: [1536, 142, 344, 196],
    running_devices: [1536, 354, 344, 358],
    alarm_history: [1536, 728, 344, 300],
    gas_metrics: [28, 822, 400, 206],
    temperature_trend: [448, 822, 610, 206],
    line_monitor: [1078, 822, 438, 206]
  }
  if (!Object.keys(groups).every(id => originals.some(w => w.id === id && w.frame))) return source
  if (Number(source.canvas?.width) !== 1920 || Number(source.canvas?.height) !== 1080) return source
  const doc = JSON.parse(JSON.stringify(source))
  const overview = w => w.visibility?.viewIds?.includes('factory_overview')
  const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width + 2 && a.y + a.height <= b.y + b.height + 2
  for (const w of doc.widgets) {
    if (!overview(w) || !w.frame) continue
    const group = Object.keys(groups).find(id => w.id === id || inside(w.frame, originals.find(item => item.id === id).frame))
    if (!group) continue
    const old = originals.find(item => item.id === group).frame
    const [x, y, width, height] = groups[group]
    const sx = width / old.width, sy = height / old.height
    w.frame = { ...w.frame, x: x + (w.frame.x - old.x) * sx, y: y + (w.frame.y - old.y) * sy, width: w.frame.width * sx, height: w.frame.height * sy }
    w.style = { ...w.style, fontSize: Math.max(12, (Number(w.style?.fontSize) || 18) * Math.min(sx, sy)) }
  }
  const setFrame = (id, x, y, width, height) => {
    const w = doc.widgets.find(item => item.id === id)
    if (w) w.frame = { ...w.frame, x, y, width, height }
    return w
  }
  setFrame('energy_value', 1536, 60, 164, 66)
  setFrame('output_value', 1716, 60, 164, 66)
  setFrame('event_marquee', 28, 1040, 1852, 28)
  const brand = setFrame('heat_header_brand', 40, 20, 550, 72)
  if (brand) {
    brand.content = { ...brand.content, text: '热处理 · 生产运行中心\nHEAT TREATMENT / DIGITAL TWIN', showTitle: false }
    brand.style = { ...brand.style, fontSize: 24 }
    for (const view of doc.scene?.views || []) {
      if (['factory_overview', 'workshop_overview', 'line_overview'].includes(view.id) && view.componentState) {
        view.componentState.hide = (view.componentState.hide || []).filter(id => id !== brand.id)
      }
    }
  }
  // Use the existing OEE binding for a semicircular instrument, not invented data.
  const oee = setFrame('cfg_usage_oee_value', 1350, 865, 150, 110)
  if (oee) {
    oee.type = 'trend'
    oee.content = { ...oee.content, chartType: 'gauge', min: 0, max: 100, showTitle: false }
    oee.data = { ...oee.data, unit: '%' }
  }
  setFrame('cfg_usage_oee_label', 1350, 968, 150, 24)
  for (const [index, key] of ['total', 'online', 'running'].entries()) {
    setFrame(`cfg_${key}_label`, 1654, 200 + index * 38, 124, 28)
    setFrame(`cfg_${key}_value`, 1778, 200 + index * 38, 84, 28)
  }
  const metricsGroup = doc.widgets.find(w => w.id === 'overview_metrics')
  doc.widgets.push({
    ...JSON.parse(JSON.stringify(metricsGroup)), id: 'reference_oee_ring', type: 'metrics', title: '',
    frame: { x: 1546, y: 204, width: 102, height: 112, rotation: 0 }, zIndex: 6,
    content: { showTitle: false, chartPath: 'metrics.overall_oee', chartLabel: '综合效率', items: [] },
    style: { color: '#e0e4f4', padding: 0 }, events: []
  })
  for (const id of ['cfg_usage_ammonia_label','cfg_usage_ammonia_value','cfg_usage_methanol_label','cfg_usage_methanol_value']) {
    const w = doc.widgets.find(item => item.id === id)
    if (w) { w.frame.x = 1090; w.frame.width = 240; w.content.align = 'left' }
  }
  setFrame('cfg_usage_ammonia_label',1090,866,230,24)
  setFrame('cfg_usage_ammonia_value',1090,890,230,26)
  setFrame('cfg_usage_methanol_label',1090,934,230,24)
  setFrame('cfg_usage_methanol_value',1090,958,230,26)
  doc.metadata = { ...doc.metadata, referenceHud: 1 }
  return doc
}
