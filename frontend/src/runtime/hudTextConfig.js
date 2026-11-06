// The inspector and both render targets use the same authored text defaults.
// An explicitly empty string means hidden, not "restore the built-in copy".
const fields = {
  hud_kpi_panel: [
    ['eyebrow', '副标题（小字）', 'PRODUCTION'],
    ['chartLabel', '圆环名称', '综合效率'],
    ['note', '底部文字', '']
  ],
  hud_device_status: [
    ['eyebrow', '副标题（小字）', 'EQUIPMENT'],
    ['onlineLabel', '在线数量标题', '在线'], ['alarmLabel', '报警数量标题', '报警'],
    ['runningText', '运行状态文字', '运行中'], ['idleText', '待机状态文字', '待机'],
    ['offlineText', '离线状态文字', '离线'], ['staleText', '延迟状态文字', '数据延迟'],
    ['alarmText', '报警状态文字', '报警'], ['temperatureUnit', '温度单位', '°C'],
    ['emptyText', '空列表文字', '尚未接入设备'], ['emptyHint', '空列表副文字', '接入后自动显示运行状态']
  ],
  hud_alarm_panel: [
    ['eyebrow', '副标题（小字）', 'EVENT LOG'],
    ['criticalLabel', '报警级别文字', '报警'], ['warningLabel', '警告级别文字', '警告'],
    ['infoLabel', '事件级别文字', '事件'], ['fallbackEventText', '无内容事件文字', '事件记录'],
    ['missingTimeText', '缺少时间文字', '时间未提供'],
    ['emptyText', '空列表文字', '暂无事件记录'], ['emptyHint', '空列表副文字', '新事件将在此自动更新']
  ],
  hud_chart_dock: [
    ['eyebrow', '副标题（小字）', 'PROCESS TREND'],
    ['statLabel', '读数名称', '当前温度'],
    ['rangeLabel', '区间标题', '区间最低 / 最高'], ['emptyText', '无采样文字', '等待趋势采样']
  ]
}

export function hudTextFields(type) {
  return (fields[type] || []).map(([key, label]) => ({ key, label }))
}

export function hudTextDefaults(type) {
  return Object.fromEntries((fields[type] || []).map(([key, , value]) => [key, value]))
}

export function resolveHudText(type, content = {}) {
  return Object.fromEntries((fields[type] || []).map(([key, , fallback]) =>
    [key, String(content[key] === undefined ? fallback : (content[key] ?? '')).trim()]))
}
