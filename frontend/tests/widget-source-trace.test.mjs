import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileStyle, compileTemplate } from 'vue/compiler-sfc'
import { widgetSourceTrace, systemSourceTrace } from '../src/runtime/widgetSourceTrace.js'
import { DASHBOARD_WIDGET_LIBRARY, createDashboardWidget } from '../src/runtime/dashboardSchema.js'
import { extendedChartOption } from '../src/runtime/dashboardCharts.js'
import { playbackSelection, devicePoint, isDeviceBinding } from '../../shared/widgetPlayback.mjs'
import { bindingForDevice } from '../../shared/widgetBindingWorkflow.mjs'

// Execute the real pure adapter without importing its database/connection module.
const dataSetService = await readFile(new URL('../../backend/services/dataSets.js', import.meta.url), 'utf8')
const adapterStart = dataSetService.indexOf('function bindingResult('), adapterEnd = dataSetService.indexOf('async function readDataSetBindings(', adapterStart)
assert.ok(adapterStart >= 0 && adapterEnd > adapterStart)
const bindingResult = new Function('error', `${dataSetService.slice(adapterStart, adapterEnd)}; return bindingResult`)(message => new Error(message))

// This renderer selector only reads its inputs; it does not mount a UI or timer.
const rendererSource = await readFile(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), 'utf8')
const selectorStart = rendererSource.indexOf('function metricDeviceId('), selectorEnd = rendererSource.indexOf('function metricRuntimeValue(', selectorStart)
assert.ok(selectorStart >= 0 && selectorEnd > selectorStart)
const rendererMetricDeviceId = new Function('baseDataBinding', 'playbackCatalog', 'playback', `${rendererSource.slice(selectorStart, selectorEnd)}; return metricDeviceId`)

const options = {
  devices: [{ id: 'a', name: 'A炉' }, { id: 'b', name: 'B炉' }],
  points: [{ id: 'pa', device_id: 'a', label: '实际温度', plc_tag: 'DB101.DBD0', unit: '℃' },
    { id: 'pb', device_id: 'b', label: '实际温度', plc_tag: 'DB202.DBD64', unit: '℃' }],
  datasets: [{ id: 'energy', name: '工厂能耗表', enabled: true, columns: [{ name: 'value', label: '累计耗电' }] }]
}
const joined = rows => rows.map(row => [row.field, row.origin, row.source, row.path, row.updates, row.scope].join(' ')).join('\n')
const mainTableRows = rows => rows.filter(row => row.path.startsWith('datasetId='))
const chartTrace = (content, data = { mode: 'runtime', source: 'trendPoints' }, sourceOptions = {}) => widgetSourceTrace({ id: 'chart-fields', type: 'trend', data, content }, sourceOptions).find(row => row.field === '图表字段 / 当前值 / 区间值')
function metricSelection(primary, binding, context = {}, now = 0, devices = options.devices) {
  const playback = playbackSelection(primary, context, devices, now)
  const id = rendererMetricDeviceId({ value: primary }, { value: devices }, { value: playback })(binding)
  const source = bindingForDevice(binding, id)
  const unavailable = Boolean(source.bindingMissing || !id && isDeviceBinding(source))
  const pointValues = Object.fromEntries(options.points.map(point => [point.id, { ...point, value: point.device_id === 'a' ? 11 : 22, quality: 'good' }]))
  return { id, source, unavailable, point: unavailable ? null : devicePoint(binding, id, pointValues) }
}

test('every offered widget has a non-mutating source explanation, including decorative and system controls', () => {
  for (const [index, definition] of DASHBOARD_WIDGET_LIBRARY.entries()) {
    const widget = createDashboardWidget(definition.type, index), before = JSON.stringify(widget)
    const rows = widgetSourceTrace(widget, options)
    assert.ok(rows.length, definition.type)
    assert.equal(new Set(rows.map(row => row.key)).size, rows.length)
    assert.equal(JSON.stringify(widget), before, definition.type + ' source tracing cannot mutate the draft')
  }
})

test('untitled decorative containers still explain their actual layout and style without changing the draft', () => {
  const widget = { id: 'detail_devices', type: 'container', title: '', data: { mode: 'static' },
    content: { showTitle: false }, layout: { x: 20, y: 30, width: 400, height: 300 },
    style: { background: 'transparent', opacity: 1 } }
  const before = JSON.stringify(widget), rows = widgetSourceTrace(widget)
  assert.ok(rows.length, 'an untitled live container cannot leave the source inspector blank')
  assert.match(joined(rows), /布局.*外观/)
  assert.match(joined(rows), /layout.*style/)
  assert.match(joined(rows), /子组件.*各自/)
  assert.equal(JSON.stringify(widget), before)
})

test('explicit rows reveal each owned address and do not guess a missing row from a same-name point', () => {
  const widget = { id: 'x', type: 'value', content: {}, data: { mode: 'plc', bindingVersion: 2, deviceScope: 'rotation',
    deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }, { deviceId: 'b', binding: null }] } }
  const before = JSON.stringify([widget, options]), rows = widgetSourceTrace(widget, options)
  assert.match(joined(rows), /A炉.*DB101\.DBD0/)
  assert.doesNotMatch(joined(rows), /DB202/)
  const missing = rows.find(row => row.field === '主数据 · B炉')
  assert.equal(missing.origin, '缺少来源'); assert.match(missing.updates, /不读取其他设备/)
  widget.data.deviceBindings[1].binding = { mode: 'plc', pointId: 'pa' }
  assert.equal(widgetSourceTrace(widget, options).find(row => row.field === '主数据 · B炉').origin, '缺少来源')
  widget.data.deviceBindings[1].binding = null
  assert.equal(JSON.stringify([widget, options]), before)
})

test('global main values and internal per-device metrics show their own sources, not a shared main fallback', () => {
  const widget = { id: 'panel', type: 'hud_kpi_panel', data: { mode: 'dataset', deviceScope: 'global', datasetId: 'energy', datasetField: 'value' },
    content: { useBoundRing: true, items: [{ label: 'A炉温度', binding: { mode: 'plc', deviceScope: 'fixed', deviceId: 'a', bindingVersion: 2, deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }] } },
      { label: '完成率', path: 'metrics.progress_percent', unitPath: 'deviceInfo.unit' }] } }
  const rows = widgetSourceTrace(widget, options), combined = joined(rows)
  assert.match(combined, /工厂能耗表.*累计耗电/)
  assert.match(combined, /指标 1 · A炉温度 · A炉.*DB101\.DBD0/)
  assert.match(combined, /今日产出 ÷（日产目标或旧版默认值 1）× 100/)
  assert.match(combined, /圆环读数.*同一主数据/)
  assert.match(combined, /指标 2 · 完成率 · 单位/)
})

test('plain text templates and explicit units are distinguished from dynamic values and parameters', () => {
  const widget = { id: 'caption', type: 'text', data: { mode: 'runtime', path: 'deviceInfo.name', unit: '℃' },
    content: { text: '设备：{value} / {parameters.shift}', fallback: '未读取' } }
  const rows = widgetSourceTrace(widget), combined = joined(rows)
  assert.match(combined, /固定文本 \/ 格式模板.*设备：\{value\}/)
  assert.match(combined, /deviceInfo\.name/); assert.match(combined, /文本参数 shift.*parameters\.shift/)
  assert.match(combined, /主数据单位（覆盖来源单位）.*固定配置.*℃/)
  assert.equal(rows.find(row => row.field === '展示文字 · fallback').origin, '固定配置')
})

test('navigation component captions are not mislabeled as the independent live system status bar', () => {
  const rows = widgetSourceTrace({ id: 'nav', type: 'navigation', content: { projectLabel: '天津工厂', statusText: '实时采集正常' }, data: { mode: 'static' } })
  assert.equal(rows.find(row => row.field === '导航组件项目文案').origin, '固定配置')
  assert.equal(rows.find(row => row.field === '导航组件状态文案').origin, '固定配置')
  assert.equal(rows.find(row => row.field === '导航组件项目文案').path, 'content.projectLabel')
  assert.equal(rows.find(row => row.field === '导航组件状态文案').path, 'content.statusText')
  assert.match(joined(rows.filter(row => row.field === '导航组件渲染面')), /没有宿主状态.*不能断言当前/)
  assert.match(joined(rows.filter(row => row.field === '透明 Overlay 导航圆点')), /displayReady.*hostConnected/)
  const native = rows.find(row => row.field === '原生后台 / PLC 状态文字')
  assert.equal(native.path, 'BackendState / PlcState')
  assert.match(native.source, /ConnectionStateChanged.*status.*message.*status 优先/)
  assert.match(native.source, /不读取 health\.displayReady 或 engine\.mode/)
  const system = systemSourceTrace()
  assert.match(joined(system.filter(row => row.field === '系统顶部工厂名称')), /factories\.name.*settings\.factory_name/)
  assert.match(joined(system.filter(row => row.field === '系统顶部采集 \/ 连接状态')), /DataStore\.plcStatusText.*\/api\/health.*\/ws.*最后一次写入/)
  assert.match(joined(system), /5 秒/)
})

test('navigation explanations distinguish real preview CSS, saved captions and the Overlay health computation', async () => {
  const overlay = await readFile(new URL('../src/views/DashboardOverlay.vue', import.meta.url), 'utf8')
  const rows = widgetSourceTrace({ id: 'nav-colors', type: 'navigation', content: { projectLabel: '天津工厂', statusText: '实时采集正常' }, data: { mode: 'static' } })
  assert.match(rendererSource, /resolveNavigationContent\(props\.widget, props\.systemData\)/)
  assert.match(rendererSource, /navigationCopy\.projectLabel/)
  assert.match(rendererSource, /navigationCopy\.statusText/)
  assert.match(overlay, /navigationCopy\(widget\)\.projectLabel \?\? ''/)
  assert.match(overlay, /navigationCopy\(widget\)\.statusText \?\? ''/)
  assert.match(overlay, /online: dataStore\.health\.readiness\.displayReady && hostConnected/)
  const previewColor = rendererSource.match(/\.navigation-preview-dot\{[^}]*background:([^;]+)/)?.[1]
  assert.ok(previewColor)
  assert.equal(rows.find(row => row.field === '导航预览圆点颜色').source, previewColor)
  assert.match(rows.find(row => row.field === '导航预览圆点颜色').path, /navigation-preview-dot/)
})

test('real event sources, filters, and implicit live device lists remain visible even with static legacy data', () => {
  const events = widgetSourceTrace({ id: 'alarms', type: 'hud_alarm_panel', data: { mode: 'static' }, content: { eventFilters: { scope: 'current', level: 'critical' }, eventWindowHours: 48 } })
  assert.match(joined(events), /event_logs 表.*\/api\/platform\/events/)
  assert.match(joined(events), /未选设备时为空.*critical/)
  assert.match(joined(events), /共享查询.*消息滚动条/)
  assert.doesNotMatch(events.find(row => row.field === '事件筛选范围').source, /48|24/)
  const devices = widgetSourceTrace({ id: 'devices', type: 'hud_device_status', data: { mode: 'static' }, content: {} })
  assert.match(joined(devices), /deviceCatalog \/ deviceStatusMap/)
  assert.match(joined(devices), /完整源设备列表统计.*过滤之前/)
})

test('legacy database formulas retain separate source items and HTTP trace never displays credentials', () => {
  const database = widgetSourceTrace({ id: 'sql', type: 'value', content: {}, data: { mode: 'database', formula: 'a/b*100', datasets: [{ alias: 'a', connectionId: 'db1', table: 'output', field: 'total' }, { alias: 'b', connectionId: 'db2', table: 'targets', field: 'daily' }] } }, { connections: [{ id: 'db1', name: '生产库' }, { id: 'db2', name: '目标库' }] })
  assert.match(joined(database), /生产库.*output\.total/); assert.match(joined(database), /目标库.*targets\.daily/)
  assert.match(joined(database), /a\/b\*100/)
  const http = widgetSourceTrace({ id: 'http', type: 'value', content: {}, data: { mode: 'http_api', connectionId: 'configured', apiPath: 'https://user:private-password@example.invalid/values?token=private-token&key=value', jsonPath: '$.value' } })
  assert.doesNotMatch(joined(http), /private-password|private-token|user:/)
  assert.match(joined(http), /example\.invalid/); assert.match(joined(http), /\$\.value/)
})

test('per-row data tables inherit the saved refresh period, and absent fields are not claimed as configured', () => {
  const rows = widgetSourceTrace({ id: 'table', type: 'value', content: {}, data: { mode: 'dataset', bindingVersion: 2, deviceScope: 'rotation', refreshMs: 2000,
    deviceBindings: [{ deviceId: 'a', binding: { mode: 'dataset', datasetId: 'energy', datasetField: 'value' } }, { deviceId: 'b', binding: { mode: 'dataset', datasetId: 'absent', datasetField: 'no' } }] } }, options)
  assert.match(rows.find(row => row.field === '主数据 · A炉').updates, /2 秒/)
  assert.equal(rows.find(row => row.field === '主数据 · B炉').origin, '缺少来源')
})

test('factory metrics explain the existing zero-target and stale protections without claiming device-specific values', () => {
  const rows = widgetSourceTrace({ id: 'factory', type: 'metrics', content: { layout: 'list', items: [{ label: '进度', path: 'metrics.progress_percent' }, { label: '产出', path: 'metrics.current_output' }] }, data: { mode: 'runtime', deviceScope: 'fixed', deviceId: 'a', path: 'metrics.current_output' } })
  assert.equal(rows.find(row => row.field === '指标 1 · 进度').scope, '当前工厂')
  assert.match(joined(rows), /目标为 0 \/ 缺失时沿用默认分母 1/)
  assert.match(joined(rows), /质量保护清零并暂停快照读取/)
})

test('HUD, shared metrics and legacy metrics trace the same ring visibility and source branches as their renderers', () => {
  const data = { mode: 'runtime', path: 'metrics.current_output' }
  const ring = widget => widgetSourceTrace(widget).find(row => row.field === '圆环读数')
  const hud = { id: 'hud', type: 'hud_kpi_panel', data, content: { layout: 'list', useBoundRing: true } }
  assert.equal(ring(hud).origin, '主数据')
  assert.equal(ring({ ...hud, content: { ...hud.content, showRing: false } }), undefined)
  const metrics = { id: 'plain', type: 'metrics', data, content: { showRing: false, useBoundRing: true, chartPath: 'metrics.overall_oee' } }
  assert.equal(ring(metrics).path, 'metrics.overall_oee', 'legacy ECharts reads chartPath regardless of useBoundRing')
  assert.equal(ring({ ...metrics, style: { surfaceSkin: 'glass' } }).origin, '主数据')
  assert.equal(widgetSourceTrace({ ...metrics, style: { viewOverrides: { detail: { surfaceSkin: 'inline' } } } }, { viewId: 'detail' }).find(row => row.field === '圆环读数').origin, '主数据')
  assert.equal(ring({ ...metrics, content: { ...metrics.content, layout: 'list' } }), undefined)
})

test('regular chart timeField and extended categorical mappings reveal the actual fields used', () => {
  const base = { id: 'curve', type: 'trend', content: { timeField: 'sample_time', categoryField: 'named_category', valueField: 'temperature', chartType: 'line' }, data: { mode: 'runtime', path: 'device.analog.t' } }
  const chart = widget => widgetSourceTrace(widget).find(row => row.field === '图表字段 / 当前值 / 区间值')
  assert.match(chart(base).source, /sample_time → temperature/)
  assert.doesNotMatch(chart(base).source, /named_category/)
  assert.match(chart({ ...base, content: { ...base.content, chartType: 'horizontalBar' } }).source, /named_category → temperature/)
  assert.match(chart({ ...base, content: { ...base.content, chartType: 'scatter', xField: 'pressure', yField: 'temperature' } }).source, /pressure → temperature/)
})

test('component alarm filters do not pretend to add a private time window to external records', () => {
  const rows = widgetSourceTrace({ id: 'external', type: 'hud_alarm_panel', data: { mode: 'dataset', datasetId: 'events', datasetField: 'msg', deviceScope: 'global' }, content: { eventFilters: { scope: 'current', level: 'warning' }, eventWindowHours: 72 } })
  assert.match(rows.find(row => row.field === '时间范围来源').source, /所选表或接口的查询定义/)
  assert.doesNotMatch(rows.find(row => row.field === '事件筛选范围').source, /72|24/)
})

test('explicit per-device units override stale top-level units just as bindingForDevice does', () => {
  const rows = widgetSourceTrace({ id: 'unit', type: 'value', content: {}, data: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'b', unit: '℃',
    deviceBindings: [{ deviceId: 'b', binding: { mode: 'plc', pointId: 'pb', unit: 'h' } }] } }, options)
  const unit = rows.find(row => row.field === '主数据单位 · B炉（覆盖来源单位）')
  assert.equal(unit.source, 'h')
  assert.equal(rows.some(row => row.field === '主数据单位（覆盖来源单位）'), false)
})

test('a fixed main card restricts metric mappings to its device while identifying preserved inactive rows', () => {
  const rows = widgetSourceTrace({ id: 'panel', type: 'hud_kpi_panel', data: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }] },
    content: { items: [{ label: '温度', binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'current', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }, { deviceId: 'b', binding: { mode: 'plc', pointId: 'pb' } }] } }] } }, options)
  assert.ok(rows.find(row => row.field === '指标 1 · 温度 · A炉'))
  assert.equal(rows.some(row => row.field === '指标 1 · 温度 · B炉'), false)
  assert.match(rows.find(row => row.field === '指标 1 · 温度 · 保留映射').source, /B炉.*不会读取/)
})

test('every explicitly selected data-table series column has its own trace entry', () => {
  const datasets = [{ id: 'series', name: '趋势表', columns: [{ name: 'temp', label: '温度' }, { name: 'energy', label: '能耗' }] }]
  const rows = widgetSourceTrace({ id: 'multi', type: 'trend', data: { mode: 'dataset', datasetId: 'series', datasetField: 'temp', datasetFields: ['energy', 'temp'], deviceScope: 'global' }, content: { chartType: 'line' } }, { datasets })
  assert.match(rows.find(row => row.field === '主数据 · 字段 temp').source, /温度/)
  assert.match(rows.find(row => row.field === '主数据 · 字段 energy').source, /能耗/)
})

test('data-table trace uses the adapter deduplication and twelve-series limit including the main column', () => {
  const columns = Array.from({ length: 13 }, (_, index) => ({ name: `v${index}`, label: `数值 ${index}` }))
  const result = { quality: 'good', columns, rows: [Object.fromEntries(columns.map((column, index) => [column.name, index]))] }
  const data = { mode: 'dataset', deviceScope: 'global', datasetId: 'wide', datasetField: 'v0', datasetFields: ['v1', 'v0', ...columns.slice(2).map(column => column.name)] }
  const widget = { id: 'wide-chart', type: 'trend', data, content: { chartType: 'radar' } }, sourceOptions = { datasets: [{ id: 'wide', name: '多列表', columns }] }
  const before = JSON.stringify([widget, sourceOptions]), adapted = bindingResult(result, data), rows = widgetSourceTrace(widget, sourceOptions)
  assert.equal(adapted.series.length, 12)
  assert.deepEqual(mainTableRows(rows).map(row => row.path.split(' / ')[1]), adapted.series.map(series => series.field))
  assert.ok(rows.some(row => row.origin === '当前未启用配置' && /v12/.test(row.source) && /12/.test(row.source)))
  const outsideLimit = { ...data, datasetFields: [...columns.slice(1, 12).map(column => column.name), 'absent'] }
  assert.equal(bindingResult(result, outsideLimit).series.length, 12, 'invalid columns beyond the adapter cap are not read')
  const cappedRows = mainTableRows(widgetSourceTrace({ ...widget, data: outsideLimit }, sourceOptions))
  assert.equal(cappedRows.length, 12); assert.ok(cappedRows.every(row => row.origin === '数据表字段'))
  assert.equal(JSON.stringify([widget, sourceOptions]), before)
})

test('blank or unknown in-range additional table columns fail the whole read instead of being skipped', () => {
  const columns = [{ name: 'value', label: '主数值' }], result = { quality: 'good', columns, rows: [{ value: 0 }] }
  const sourceOptions = { datasets: [{ id: 'columns', name: '字段表', columns }] }
  for (const missing of ['', 'absent']) {
    const data = { mode: 'dataset', deviceScope: 'global', datasetId: 'columns', datasetField: 'value', datasetFields: [missing] }
    assert.throws(() => bindingResult(result, data), /图表数值列不存在/)
    const rows = mainTableRows(widgetSourceTrace({ id: 'invalid-series', type: 'trend', data, content: {} }, sourceOptions))
    assert.equal(rows.length, 2, 'an empty additional field remains visible as an invalid selection')
    assert.equal(rows[1].origin, '缺少来源')
    assert.equal(rows[0].origin, '读取不可用', 'a valid main column is not presented as a usable result after the series adapter fails')
    assert.ok(rows.every(row => /本次读取失败.*不生成数值或图表序列/.test(row.updates)))
  }
})

test('a missing table main field cannot fall back to the first configured or additional column', () => {
  const columns = [{ name: 'value', label: '首列' }], result = { quality: 'good', columns, rows: [{ value: 9 }] }
  const sourceOptions = { datasets: [{ id: 'main', name: '主字段表', columns }] }
  for (const datasetField of [undefined, '', 'absent']) {
    const data = { mode: 'dataset', deviceScope: 'global', datasetId: 'main', datasetField, datasetFields: ['value'] }
    assert.throws(() => bindingResult(result, data), /绑定字段不存在/)
    const rows = mainTableRows(widgetSourceTrace({ id: 'missing-main', type: 'value', data, content: {} }, sourceOptions))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].origin, '缺少来源'); assert.equal(rows[1].origin, '读取不可用')
    assert.ok(rows.every(row => /主绑定字段.*本次读取失败.*不生成数值或图表序列.*不回退首列/.test(row.updates)))
  }
})

test('a legacy fixed main card selects the matching v2 metric row rather than the metric fixed device', () => {
  const primary = { mode: 'plc', deviceScope: 'fixed', deviceId: 'b', pointId: 'pb' }
  const binding = { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }, { deviceId: 'b', binding: { mode: 'plc', pointId: 'pb' } }] }
  const selected = metricSelection(primary, binding)
  assert.equal(selected.id, 'b'); assert.equal(selected.source.pointId, 'pb'); assert.equal(selected.point.value, 22)
  const widget = { id: 'legacy-main', type: 'hud_kpi_panel', data: primary, content: { showRing: false, items: [{ label: '温度', binding }] } }, before = JSON.stringify(widget)
  const rows = widgetSourceTrace(widget, options)
  assert.match(rows.find(row => row.field === '指标 1 · 温度 · B炉').source, /DB202\.DBD64/)
  assert.match(rows.find(row => row.field === '指标 1 · 温度 · B炉').updates, /设备 \/ 检查视角.*场景所选设备/)
  assert.equal(rows.some(row => row.field === '指标 1 · 温度 · A炉'), false)
  assert.match(rows.find(row => row.field === '指标 1 · 温度 · 保留映射').source, /A炉.*不会读取/)
  const missing = { ...binding, deviceBindings: binding.deviceBindings.slice(0, 1) }
  assert.equal(metricSelection(primary, missing).unavailable, true)
  const missingRows = widgetSourceTrace({ ...widget, content: { ...widget.content, items: [{ label: '温度', binding: missing }] } }, options)
  assert.equal(missingRows.find(row => row.field === '指标 1 · 温度 · B炉').origin, '缺少来源')
  assert.equal(missingRows.some(row => row.field === '指标 1 · 温度 · A炉'), false)
  assert.equal(JSON.stringify(widget), before)
})

test('legacy scene and rotation selection stays unresolved without runtime device context or a playback phase', () => {
  const binding = { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }, { deviceId: 'b', binding: { mode: 'plc', pointId: 'pb' } }] }
  const primary = { mode: 'plc', deviceScope: 'fixed', deviceId: 'b', pointId: 'pb' }
  assert.equal(metricSelection(primary, binding, { viewId: 'device_part', deviceId: 'a' }).id, 'a', 'legacy device views override the configured main fixed device')
  const widget = { id: 'legacy-context', type: 'metrics', data: primary, content: { layout: 'list', items: [{ label: '温度', binding }] } }
  const sceneRows = widgetSourceTrace(widget, { ...options, viewId: 'device_part' }).filter(row => row.field.startsWith('指标'))
  assert.equal(sceneRows.find(row => row.field === '指标 1 · 温度').origin, '跟随主卡设备')
  assert.match(joined(sceneRows), /场景.*设备.*运行时/)
  assert.equal(sceneRows.some(row => row.path.startsWith('pointId=')), false)
  const rotation = { ...primary, deviceScope: 'rotation', rotationDeviceIds: ['a', 'b'], rotationIntervalMs: 2000 }
  assert.equal(metricSelection(rotation, binding, {}, 0).id, 'a'); assert.equal(metricSelection(rotation, binding, {}, 2000).id, 'b')
  const rotationRows = widgetSourceTrace({ ...widget, data: rotation }, options).filter(row => row.field.startsWith('指标'))
  assert.equal(rotationRows.find(row => row.field === '指标 1 · 温度').origin, '跟随主卡设备')
  assert.match(joined(rotationRows), /轮播相位.*未提供/)
  assert.equal(rotationRows.some(row => row.path.startsWith('pointId=')), false)
})

test('global main cards reject legacy device metrics without a selected device but still read factory runtime metrics', () => {
  const primary = { mode: 'runtime', deviceScope: 'global', path: 'metrics.current_output' }
  const deviceBinding = { mode: 'runtime', deviceScope: 'current', path: 'device.analog.t' }
  const factoryBinding = { mode: 'runtime', deviceScope: 'current', path: 'metrics.current_output' }
  assert.equal(metricSelection(primary, deviceBinding).unavailable, true)
  assert.equal(metricSelection(primary, factoryBinding).unavailable, false)
  const widget = { id: 'global-legacy-metric', type: 'metrics', data: primary, content: { layout: 'list', items: [{ label: '温度', binding: deviceBinding }, { label: '产出', binding: factoryBinding }] } }
  const rows = widgetSourceTrace(widget, options)
  assert.equal(rows.find(row => row.field === '指标 1 · 温度').origin, '缺少来源')
  assert.equal(rows.find(row => row.field === '指标 2 · 产出').origin, '运行指标')
  assert.equal(rows.find(row => row.field === '指标 2 · 产出').scope, '当前工厂')
  const fixed = { mode: 'plc', deviceScope: 'fixed', deviceId: 'a', pointId: 'pa' }
  assert.equal(metricSelection(primary, fixed).point.value, 11)
  const fixedRows = widgetSourceTrace({ ...widget, content: { ...widget.content, items: [{ label: '温度', binding: fixed }] } }, options)
  assert.match(fixedRows.find(row => row.field === '指标 1 · 温度').source, /DB101\.DBD0/)
  assert.equal(metricSelection(primary, fixed, {}, 0, []).unavailable, true)
  assert.equal(widgetSourceTrace({ ...widget, content: { ...widget.content, items: [{ label: '温度', binding: fixed }] } }, { ...options, devices: [] }).find(row => row.field === '指标 1 · 温度').origin, '缺少来源')
})

test('scatter and heatmap traces follow real value field precedence instead of a competing y or value column', () => {
  const row = { sample: '本次', pressure: 1, obsoleteY: 2, temperature: 3, heat: 99 }, sourceSeries = [{ id: 'temperature', name: '温度', rows: [row] }]
  const scatter = { chartType: 'scatter', xField: 'pressure', yField: 'obsoleteY', valueField: 'temperature' }
  assert.deepEqual(extendedChartOption('scatter', { sourceSeries, content: scatter }).series[0].data, [[1, 3]])
  assert.match(chartTrace(scatter).source, /pressure → temperature/); assert.doesNotMatch(chartTrace(scatter).source, /obsoleteY/)
  assert.match(chartTrace(scatter).path, /content\.xField.*content\.valueField/)
  const heatmap = { chartType: 'heatmap', xField: 'sample', yField: 'pressure', valueField: 'temperature', heatValueField: 'heat' }
  assert.deepEqual(extendedChartOption('heatmap', { sourceSeries, content: heatmap }).series[0].data, [[0, 0, 99]])
  assert.match(chartTrace(heatmap).source, /sample × pressure → heat/)
  assert.match(chartTrace(heatmap).path, /content\.heatValueField/)
  const fallback = { ...heatmap, heatValueField: '' }
  assert.deepEqual(extendedChartOption('heatmap', { sourceSeries, content: fallback }).series[0].data, [[0, 0, 3]])
  assert.match(chartTrace(fallback).source, /sample × pressure → temperature/)
})

test('candlestick and boxplot traces list the actual ordered price or quartile fields and their defaults', () => {
  const row = { sample: '本次', o: 1, c: 2, lo: 3, hi: 4, lowerQ: 5, mid: 6, upperQ: 7, unused: 99, open: 8, close: 9, low: 10, high: 11, min: 12, q1: 13, median: 14, q3: 15, max: 16 }, sourceSeries = [{ id: 'unused', rows: [row] }]
  const cases = [
    { type: 'candlestick', content: { openField: 'o', closeField: 'c', lowField: 'lo', highField: 'hi' }, keys: ['o', 'c', 'lo', 'hi'], values: [1, 2, 3, 4] },
    { type: 'boxplot', content: { lowField: 'lo', q1Field: 'lowerQ', medianField: 'mid', q3Field: 'upperQ', highField: 'hi' }, keys: ['lo', 'lowerQ', 'mid', 'upperQ', 'hi'], values: [3, 5, 6, 7, 4] },
    { type: 'candlestick', content: {}, keys: ['open', 'close', 'low', 'high'], values: [8, 9, 10, 11] },
    { type: 'boxplot', content: {}, keys: ['min', 'q1', 'median', 'q3', 'max'], values: [12, 13, 14, 15, 16] }
  ]
  for (const { type, content, keys, values } of cases) {
    const config = { ...content, chartType: type, categoryField: 'sample', valueField: 'unused' }
    const option = extendedChartOption(type, { sourceSeries, content: config }), trace = chartTrace(config)
    assert.deepEqual(option.series[0].data, [values])
    assert.deepEqual(option.xAxis.data, ['本次'])
    assert.ok(trace.source.includes(`sample → [${keys.join(', ')}]`), trace.source)
    assert.match(trace.path, type === 'candlestick' ? /content\.openField.*content\.closeField.*content\.lowField.*content\.highField/ : /content\.lowField.*content\.q1Field.*content\.medianField.*content\.q3Field.*content\.highField/)
  }
})

test('radar trace explains per-series field-or-id dimensions rather than one content value field', () => {
  const row = { category: '批次', dimensionA: 1, dimensionB: 2, dimensionC: 3, conflictingValue: 99 }
  const sourceSeries = [{ id: 'different-id', field: 'dimensionA', name: 'A', rows: [row] }, { id: 'dimensionB', name: 'B', rows: [row] }, { id: 'dimensionC', name: 'C', rows: [row] }]
  const content = { chartType: 'radar', categoryField: 'category', valueField: 'conflictingValue' }
  const option = extendedChartOption('radar', { sourceSeries, content }), trace = chartTrace(content)
  assert.deepEqual(option.series[0].data, [{ name: '批次', value: [1, 2, 3] }])
  assert.match(trace.source, /category → .*各实际序列.*field.*id/)
  assert.match(trace.source, /至少 3.*前 20/)
  assert.match(trace.path, /sourceSeries\.field.*sourceSeries\.id/)
  assert.doesNotMatch(trace.source, /category → conflictingValue/)
  assert.deepEqual(extendedChartOption('radar', { sourceSeries: sourceSeries.slice(0, 2), content }).series, [])
})

test('an explicitly empty lines array follows the renderer title fallback rather than showing obsolete text', () => {
  const rows = widgetSourceTrace({ id: 'empty-lines', type: 'text', title: '当前标题', data: { mode: 'static' }, content: { lines: [], text: '旧文本' } })
  assert.equal(rows.find(row => row.field === '固定文本 / 格式模板').source, '当前标题')
})

test('text title fallback respects nullish widget title precedence, including an explicitly blank title', () => {
  const titleExpression = rendererSource.match(/const widgetTitle = computed\(\(\) => ([^\n]+)\)/)?.[1]
  const fallbackExpression = rendererSource.slice(rendererSource.indexOf('const textLines = computed(')).match(/const fallback = ([^\n]+)/)?.[1]
  assert.ok(titleExpression); assert.ok(fallbackExpression)
  const actualTitle = new Function('props', 'content', `return ${titleExpression}`)
  const actualFallback = new Function('props', 'rawText', 'widgetTitle', `return ${fallbackExpression}`)
  for (const [title, expected] of [['', '文本组件'], [null, '旧标题'], [undefined, '旧标题'], ['当前标题', '当前标题']]) {
    const widget = { id: 'nullish-title', type: 'text', title, data: { mode: 'static' }, content: { lines: [], title: '旧标题', text: '旧文本' } }
    const props = { widget, runtimeContext: {} }, widgetTitle = actualTitle(props, { value: widget.content })
    assert.equal(actualFallback(props, '', { value: widgetTitle }), expected)
    const rows = widgetSourceTrace(widget)
    assert.equal(rows.find(row => row.field === '固定文本 / 格式模板').source, expected)
    if (title === '') assert.equal(rows.some(row => row.field === '组件标题'), false)
    if (title == null) assert.equal(rows.find(row => row.field === '组件标题').path, 'content.title')
  }
})

test('source trace template renders in a memory host without a browser, mutations, or network requests', async () => {
  const url = new URL('../src/views/admin/components/WidgetSourceTrace.vue', import.meta.url), source = await readFile(url, 'utf8'), descriptor = parse(source).descriptor
  const compiled = compileScript(descriptor, { id: 'source-trace', inlineTemplate: true }).content.replace(/from (['"])([^'"]+)\1/g, (_, _q, path) => `from ${JSON.stringify(path === 'vue' ? import.meta.resolve('vue') : new URL(path, url).href)}`)
  const Trace = (await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))).default
  const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null }), root = node('root')
  const renderer = createRenderer({ createElement: type => node(type), createText: text => node('#text', text), createComment: () => node('#comment'), setText: (node, text) => { node.text = text }, setElementText: (node, text) => { node.text = text; node.children = [] }, parentNode: node => node.parent, nextSibling: () => null, patchProp: (node, key, _old, value) => { node.props[key] = value }, insert(node, parent) { node.parent = parent; parent.children.push(node) }, remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node) } })
  const widget = { id: 'trace', type: 'value', content: {}, data: { mode: 'plc', deviceId: 'a', pointId: 'pa' } }, before = JSON.stringify(widget)
  try {
    renderer.render(h(Trace, { widget, ...options, open: true }), root); await nextTick()
    const visible = node => [node.text, ...node.children.map(visible)].join(' ')
    assert.match(visible(root), /数据与内容来源/); assert.match(visible(root), /DB101\.DBD0/)
    assert.match(visible(root), /范围：.*指定设备.*更新：/)
    assert.equal(root.children[0].props['aria-label'], '组件数据与内容来源')
    assert.equal(JSON.stringify(widget), before)
  } finally { renderer.render(null, root) }
  assert.deepEqual(compileStyle({ source: descriptor.styles[0].content, id: 'source-trace' }).errors, [])
  assert.match(descriptor.styles[0].content, /overflow-wrap:anywhere/)
  const designer = await readFile(new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(designer, /<WidgetSourceTrace\b|inspector-source-overview/)
  // The real Inspector is keyed by object instance so duplicate IDs cannot
  // reuse another component's input state. Additional attributes are valid.
  const inspectorStart = designer.indexOf('<div class="inspector-body"')
  assert.ok(inspectorStart >= 0, 'the actual existing Inspector is present')
  const inspector = designer.slice(inspectorStart)
  assert.equal((inspector.match(/<NavigationContentSettings /g) || []).length, 2, 'both existing tabs edit the actual navigation fields, not explanations')
  assert.match(inspector, /@metric-label="applyMetricLabel"/)
  assert.match(inspector, /@metric-format="applyMetricFormat"/)
})

test('both existing designer tabs use real navigation content controls without a provenance overview', async t => {
  const designerUrl = new URL('../src/views/admin/components/DashboardDesigner.vue', import.meta.url)
  const designer = await readFile(designerUrl, 'utf8')
  assert.doesNotMatch(designer, /<WidgetSourceTrace\b|inspector-source-overview/)
  const snippets = [...designer.matchAll(/<NavigationContentSettings\b[^>]+\/>/g)].map(match => match[0])
  assert.equal(snippets.length, 2)
  const actualControls = `<div v-if="inspectorTab === 'content' || inspectorTab === 'data'">${snippets[0]}</div>`
  const template = compileTemplate({ source: actualControls, filename: 'designer-content-controls.vue', id: 'designer-content-controls' })
  assert.deepEqual(template.errors, [])
  const code = template.code.replace(/from (['"])([^'"]+)\1/g, (_, _q, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
  const { render } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  const traceUrl = new URL('../src/views/admin/components/NavigationContentSettings.vue', import.meta.url)
  const descriptor = parse(await readFile(traceUrl, 'utf8')).descriptor
  const traceCode = compileScript(descriptor, { id: 'designer-source-trace', inlineTemplate: true }).content
    .replace(/from (['"])([^'"]+)\1/g, (_, _q, name) => `from ${JSON.stringify(name === 'vue' ? import.meta.resolve('vue') : new URL(name, traceUrl).href)}`)
  const Trace = (await import('data:text/javascript;base64,' + Buffer.from(traceCode).toString('base64'))).default
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Field controls only receive existing live state') })
  const navigation = { id: 'navigation', type: 'navigation', title: '场景导航与返回', data: { mode: 'static' },
    content: { projectLabel: '天津工厂', statusText: '实时采集正常' } }
  const selectedWidget = ref(navigation), inspectorTab = ref('content'), documentBefore = JSON.stringify(navigation)
  const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
  const root = node('root'), remove = child => {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child)
    child.parent = null
  }
  const renderer = createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (child, text) => { child.text = text }, setElementText: (child, text) => { child.text = text; child.children = [] },
    parentNode: child => child.parent, nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
    patchProp: (child, key, _old, value) => { child.props[key] = value },
    insert(child, parent, anchor = null) { remove(child); child.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1; if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child) },
    remove
  })
  const Overview = { components: { NavigationContentSettings: Trace }, render,
    setup: () => ({ selectedWidget, inspectorTab, designerSystemData: { factoryName: '天津工厂', collectionStatus: '采集器数据正常' }, canAdminPage: () => true, updateNavigationContent: () => {}, recordProperty: () => {} }) }
  const visible = child => [child.text, ...child.children.map(visible)].join(' ')
  const find = (child, predicate) => predicate(child) ? child : child.children.map(item => find(item, predicate)).find(Boolean)
  const app = renderer.createApp(Overview)
  try {
    app.mount(root); await nextTick()
    for (const tab of ['content', 'data']) {
      inspectorTab.value = tab; await nextTick()
      assert.equal(find(root, child => child.props['aria-label'] === '项目文字').props.value, '天津工厂')
      assert.equal(find(root, child => child.props['aria-label'] === '状态文字').props.value, '实时采集正常')
      assert.equal(find(root, child => child.props['aria-label'] === '项目文字来源').props.value, 'fixed')
      assert.equal(find(root, child => child.type === 'details'), undefined)
      assert.equal(JSON.stringify(navigation), documentBefore)
    }
    inspectorTab.value = 'style'; await nextTick()
    assert.equal(find(root, child => child.type === 'select'), undefined)
    assert.equal(requests, 0)
  } finally { app.unmount() }
})
