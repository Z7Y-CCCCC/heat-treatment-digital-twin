import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { widgetSourceTrace, systemSourceTrace } from '../src/runtime/widgetSourceTrace.js'
import { DASHBOARD_WIDGET_LIBRARY, createDashboardWidget, SYSTEM_WIDGET_TYPES } from '../src/runtime/dashboardSchema.js'

const joined = rows => rows.map(row => [row.field, row.origin, row.source, row.path, row.updates, row.scope].join(' ')).join('\n')
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child) }
  return value
}
const options = {
  devices: [{ id: 'a', name: 'A炉' }, { id: 'b', name: 'B炉' }],
  points: [{ id: 'pa', device_id: 'a', label: '温度', plc_tag: 'DB1.DBD0', unit: '℃' },
    { id: 'pb', device_id: 'b', label: '温度', plc_tag: 'DB2.DBD0', unit: '℃' }]
}
const renderer = await readFile(new URL('../src/runtime/WidgetRenderer.vue', import.meta.url), 'utf8')
const overlay = await readFile(new URL('../src/views/DashboardOverlay.vue', import.meta.url), 'utf8')
const nativeController = await readFile(new URL('../../unity-client/Assets/Scripts/Runtime/FactoryDashboardController.cs', import.meta.url), 'utf8')
const dataStore = await readFile(new URL('../src/runtime/DataStore.js', import.meta.url), 'utf8')
const dynamicUnitExpression = renderer.match(/const dynamicUnit = ([^\r\n]+)/)?.[1]
assert.ok(dynamicUnitExpression, 'test must use the actual renderer unit selector')
const renderedMetricUnit = new Function('item', 'source', 'runtimeValue', `const dynamicUnit = ${dynamicUnitExpression}; return dynamicUnit ?? item.unit ?? ''`)
const dataSets = await readFile(new URL('../../backend/services/dataSets.js', import.meta.url), 'utf8')
const convertStart = dataSets.indexOf('function convert('), convertEnd = dataSets.indexOf('function mapRows(', convertStart)
assert.ok(convertStart >= 0 && convertEnd > convertStart)
const actualConvert = new Function(`${dataSets.slice(convertStart, convertEnd)}; return convert`)()

test('offered and retained system components all explain nonempty sources without changing frozen inputs or using a network', () => {
  const definitions = [...DASHBOARD_WIDGET_LIBRARY, ...[...SYSTEM_WIDGET_TYPES].map(type => ({ type }))]
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = () => { requests++; throw new Error('source tracing cannot request data') }
  try {
    for (const [index, definition] of definitions.entries()) {
      const widget = deepFreeze(createDashboardWidget(definition.type, index)), config = deepFreeze(structuredClone(options))
      const before = JSON.stringify([widget, config]), rows = widgetSourceTrace(widget, config)
      assert.ok(rows.length, definition.type)
      assert.ok(rows.every(row => row.origin && row.source), definition.type)
      assert.equal(new Set(rows.map(row => row.key)).size, rows.length)
      assert.equal(JSON.stringify([widget, config]), before)
    }
    assert.equal(requests, 0)
  } finally { globalThis.fetch = originalFetch }
})

test('nested event fields identify the same real event table and shared query as the event list', () => {
  for (const path of ['events', 'events.0.msg', 'events.1.time', 'events.2.occurred_at']) {
    const rows = widgetSourceTrace({ id: path, type: 'text', data: { mode: 'runtime', path }, content: { text: '{value}' } })
    const main = rows.find(row => row.field === '主数据')
    assert.equal(main.origin, '报警 / 事件记录')
    assert.equal(main.path, path)
    assert.match(main.source, /event_logs.*\/api\/platform\/events/)
    assert.match(main.updates, /共享事件窗口.*不是固定报警编号/)
  }
})

test('event provenance identifies the actual formatEvent projection and never invents access to omitted raw title/message', () => {
  const start = dataStore.indexOf('function formatEvent('), end = dataStore.indexOf('function clampNumber(', start)
  assert.ok(start >= 0 && end > start)
  const actualFormatEvent = new Function(`${dataStore.slice(start, end)}; return formatEvent`)()
  const formatted = actualFormatEvent({ id: 'fixture_event', title: 'Fixture title', message: 'Fixture message', occurred_at: '2026-11-09T09:00:00Z', source_id: 'a', placeholder: true })
  assert.equal(formatted.msg, 'Fixture title')
  assert.equal(formatted.occurred_at, '2026-11-09T09:00:00Z')
  assert.equal(formatted.source_id, 'a')
  assert.equal(formatted.title, undefined)
  assert.equal(formatted.message, undefined)
  assert.equal(formatted.placeholder, undefined)
  for (const field of ['title', 'message']) {
    const rows = widgetSourceTrace({ id: field, type: 'text', data: { mode: 'runtime', path: `events.0.${field}` }, content: {} })
    const main = rows.find(row => row.field === '主数据')
    assert.equal(main.origin, '缺少来源')
    assert.match(main.source, /DataStore\.formatEvent.*原始 title \/ message 不单独保留/)
    assert.match(main.source, /不改读数据库原列/)
  }
})

test('event provenance preserves locally generated boot and empty placeholders without claiming database records', () => {
  const refreshStart = dataStore.indexOf('async function refreshEvents(')
  const emptyStart = dataStore.indexOf('const emptyMsg = windowHours > 0', refreshStart), emptyEnd = dataStore.indexOf('} catch (e)', emptyStart)
  assert.ok(refreshStart >= 0 && emptyStart > refreshStart && emptyEnd > emptyStart)
  const actualEmptyList = new Function('rows', 'formatEvent', 'windowHours', `const events = { value: null }; ${dataStore.slice(emptyStart, emptyEnd)}; return events.value`)
  const notARecord = () => { throw new Error('empty placeholders must not be formatted from database records') }
  const [empty] = actualEmptyList([], notARecord, 24)
  assert.equal(empty.id, 'empty')
  assert.equal(empty.msg, '最近 24 小时暂无报警履历')
  assert.equal(empty.level, 'info')
  assert.equal(empty.placeholder, true)
  assert.equal(empty.occurred_at, undefined)
  assert.equal(typeof empty.time, 'string')
  assert.equal(actualEmptyList([], notARecord, 0)[0].msg, '暂无报警履历')
  assert.match(dataStore, /const events = ref\(\[\{ id: 'boot', [^\r\n]*placeholder: true/)
  for (const path of ['events', 'events.0.msg', 'events.0.time', 'events.0.placeholder']) {
    const rows = widgetSourceTrace({ id: path, type: 'text', data: { mode: 'runtime', path }, content: {} })
    const main = rows.find(row => row.field === '主数据')
    assert.equal(main.origin, path.endsWith('.placeholder') ? '本机占位标记' : '报警 / 事件记录')
    assert.match(main.source, /真实记录经 DataStore\.formatEvent/)
    assert.match(main.source, /启动等待 \/ 空窗口.*placeholder:true.*本机占位提示.*boot \/ empty/)
    assert.match(main.source, /占位提示不是 event_logs 记录/)
    assert.match(main.updates, /仅凭路径不能断定当前项是真实记录/)
    if (path.endsWith('.placeholder')) {
      assert.match(main.source, /placeholder 仅在占位项存在.*正常 formatEvent 记录不含该字段/)
      assert.doesNotMatch(main.source, /展示列表没有 placeholder 字段/)
    }
  }
})

test('data-table provenance reveals the actual database, schema, source column, conversion and post-conversion aggregation', () => {
  const column = { name: 'temperature', path: '["raw-temperature"]', label: '温度', type: 'number', scale: .1, offset: -10, unit: '℃' }
  const config = deepFreeze({ ...options, connections: [{ id: 'production', name: '生产库', type: 'postgres', defaultSchema: 'heat',
    password: 'SYNTHETIC_DB_PASSWORD', user: 'SYNTHETIC_DB_USER', token: 'SYNTHETIC_DB_TOKEN' }],
  datasets: [{ id: 'samples', name: '温度输出表', source: 'database', connectionId: 'production',
    database: { table: 'furnace_samples', orderBy: 'sample_time', orderDirection: 'asc' },
    match: { field: 'device_id', contextKey: 'deviceId' }, columns: [column] }] })
  const widget = deepFreeze({ id: 'temperature', type: 'value', data: { mode: 'dataset', datasetId: 'samples', datasetField: 'temperature', datasetMode: 'avg', deviceScope: 'global' }, content: {} })
  const before = JSON.stringify([widget, config]), rows = widgetSourceTrace(widget, config), result = joined(rows)
  assert.match(result, /生产库.*postgres.*heat\.furnace_samples/)
  assert.match(result, /sample_time 升序/)
  assert.match(result, /\["raw-temperature"\] → temperature/)
  assert.match(result, /Number\(原始字段\) × 0\.1 \+ -10/)
  assert.match(result, /有限数值之和 ÷ 有效数值数量.*数值转换先于聚合/)
  assert.match(result, /device_id = context\.deviceId/)
  assert.match(result, /输出字段单位 temperature.*℃/)
  assert.doesNotMatch(result, /SYNTHETIC_DB_(PASSWORD|USER|TOKEN)/)
  assert.equal(actualConvert('50', column), -5)
  assert.equal(JSON.stringify([widget, config]), before)
})

test('HTTP data tables expose method, sanitized base/path, root and parameter origins without literal or connection secrets', () => {
  const config = deepFreeze({ connections: [{ id: 'api', name: '生产接口', connector: 'http', baseUrl: 'https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@example.invalid/api?pwd=SYNTHETIC_BASE_SECRET',
    token: 'SYNTHETIC_CONNECTION_TOKEN', clientSecret: 'SYNTHETIC_CLIENT_SECRET' }], datasets: [{ id: 'api_rows', name: 'API数据表', source: 'http', connectionId: 'api',
    request: { method: 'POST', path: '/samples?api_key=SYNTHETIC_QUERY_SECRET#access_token=SYNTHETIC_FRAGMENT_SECRET', readOnly: true,
      parameters: [{ name: 'device', source: 'context', key: 'deviceId', in: 'query' },
        { name: 'batch', source: 'parameter', key: 'batchId', in: 'body' },
        { name: 'customer', source: 'literal', value: 'SYNTHETIC_LITERAL_SECRET', in: 'header' }] },
    rootPath: 'data.records', columns: [{ name: 'value', path: 'reading.value', type: 'number', scale: 2, offset: 1 }] }] })
  const rows = widgetSourceTrace({ id: 'api_table', type: 'value', content: {}, data: { mode: 'dataset', datasetId: 'api_rows', datasetField: 'value' } }, config)
  const result = joined(rows)
  assert.match(result, /生产接口.*基地址.*example\.invalid\/api.*POST.*\/samples/)
  assert.match(result, /data\.records/)
  assert.match(result, /reading\.value → value/)
  assert.match(result, /context\.deviceId/)
  assert.match(result, /parameters\.batchId/)
  assert.match(result, /固定参数（值不展开）/)
  assert.doesNotMatch(result, /SYNTHETIC_(?:USER|PASSWORD|BASE_SECRET|QUERY_SECRET|FRAGMENT_SECRET|CONNECTION_TOKEN|CLIENT_SECRET|LITERAL_SECRET)/)
})

test('a logical data-table label alone never invents a database, PLC or HTTP origin', () => {
  const rows = widgetSourceTrace({ id: 'unknown_table', type: 'value', content: {}, data: { mode: 'dataset', datasetId: 'logical', datasetField: 'value' } },
    { datasets: [{ id: 'logical', name: '现场数据', columns: [{ name: 'value' }] }] })
  const provenance = rows.find(row => row.field === '主数据 · 实际来源')
  assert.equal(provenance.origin, '来源元数据未提供')
  assert.match(provenance.source, /不能.*宣称来自 PLC、数据库或 HTTP/)
})

test('MQTT, Redis, WebSocket, TCP, UDP and imported file connectors are identified instead of claiming HTTP GET', () => {
  for (const [connector, address] of [['mqtt', 'mqtt://example.invalid:1883'], ['redis', 'redis://example.invalid:6379/0'],
    ['websocket', 'wss://example.invalid/live'], ['tcp', 'tcp://example.invalid:9000'], ['udp', 'udp://127.0.0.1:9001'], ['file', 'synthetic-import.csv']]) {
    const rows = widgetSourceTrace({ id: connector, type: 'value', content: {}, data: { mode: 'http_api', connectionId: connector, apiPath: '/furnace/current', jsonPath: '$.value' } },
      { connections: [{ id: connector, name: '已配置接入', connector, baseUrl: address, healthPath: 'configured-location' }] })
    const main = rows.find(row => row.field === '主数据')
    assert.notEqual(main.origin, '只读 HTTP 接口', connector)
    assert.match(main.source, new RegExp(connector === 'file' ? '导入文件' : connector, 'i'), connector)
    if (connector === 'mqtt' || connector === 'redis') assert.match(main.source, /furnace\/current/)
    if (connector === 'udp') assert.match(main.source, /不等于发送端在线/)
    assert.match(joined(rows), /不是 HTTP GET/)
  }
})

test('legacy HTTP bindings use GET while data tables may authorize POST, and expose the selected base URL and JSON field', () => {
  const rows = widgetSourceTrace({ id: 'legacy_http', type: 'value', content: {}, data: { mode: 'http_api', connectionId: 'http', method: 'POST', apiPath: '/values', jsonPath: '$.data.value' } },
    { connections: [{ id: 'http', name: '读取接口', connector: 'http', baseUrl: 'https://example.invalid/base' }] })
  assert.match(joined(rows), /读取接口.*example\.invalid\/base.*GET \/values/)
  assert.match(joined(rows), /\$\.data\.value/)
  assert.doesNotMatch(joined(rows), /POST/)
})

test('MQTT topics and Redis GETRANGE keys remain opaque exact selectors rather than gaining a URL slash', async () => {
  const selector = 'factory/telemetry%2Fcurrent'
  for (const connector of ['mqtt', 'redis']) {
    const rows = widgetSourceTrace({ id: connector, type: 'value', content: {}, data: { mode: 'http_api', connectionId: connector, apiPath: selector, jsonPath: '$.value' } },
      { connections: [{ id: connector, name: 'fixture', connector, baseUrl: `${connector}://example.invalid`, healthPath: 'old-selector' }] })
    const main = rows.find(row => row.field === '主数据')
    assert.match(main.source, /factory\/telemetry%2Fcurrent/)
    assert.doesNotMatch(main.source, /\/factory\/telemetry|old-selector/)
    if (connector === 'redis') assert.match(main.source, /GETRANGE.*0\.\.262144/)
  }
  const transports = await readFile(new URL('../../backend/services/dataSourceTransports.js', import.meta.url), 'utf8')
  assert.match(transports, /client\.getRange\(connection\.healthPath, 0, LIMIT\)/)
  assert.match(transports, /const LIMIT = 262144/)
})

test('image and API URLs hide credentials in userinfo, common secret query aliases and fragment routes', () => {
  for (const suffix of ['?pwd=SYNTHETIC_SECRET&safe=1#access_token=SYNTHETIC_FRAGMENT',
    '?passwd=SYNTHETIC_SECRET&api-key=SYNTHETIC_KEY#route?password=SYNTHETIC_FRAGMENT',
    '?auth=SYNTHETIC_SECRET&key=SYNTHETIC_KEY#password:SYNTHETIC_FRAGMENT', '?user=SYNTHETIC_SECRET&token=SYNTHETIC_KEY#opaque=SYNTHETIC_FRAGMENT',
    '#OpaqueFixtureCredential123456789']) {
    const url = `https://SYNTHETIC_USERNAME:SYNTHETIC_PASSWORD@example.invalid/values${suffix}`
    for (const widget of [{ id: 'image', type: 'image', content: { url }, data: { mode: 'static' } },
      { id: 'api', type: 'value', content: {}, data: { mode: 'http_api', apiPath: url, jsonPath: '$.value' } }]) {
      const result = joined(widgetSourceTrace(deepFreeze(widget)))
      assert.match(result, /example\.invalid\/values/)
      assert.doesNotMatch(result, /SYNTHETIC_|OpaqueFixtureCredential/)
    }
  }
  assert.match(joined(widgetSourceTrace({ type: 'image', content: { url: '/images/site.svg#safe-anchor' } })), /#safe-anchor/)
  assert.match(joined(widgetSourceTrace({ type: 'image', content: { url: '//SYNTHETIC_USER:SYNTHETIC_PASSWORD@example.invalid/site.png' } })), /\/\/example\.invalid\/site\.png/)
})

test('metric fixed units and binding units follow the actual renderer priority instead of copying point metadata', () => {
  for (const bindingUnit of ['kWh', '']) {
    const item = { label: '指标', unit: 'h', binding: { mode: 'runtime', deviceScope: 'global', path: 'metrics.current_output', unit: bindingUnit } }
    assert.equal(renderedMetricUnit(item, item.binding, () => undefined), bindingUnit)
    const rows = widgetSourceTrace({ id: 'unit', type: 'metrics', data: { mode: 'runtime', deviceScope: 'global' }, content: { layout: 'list', items: [item] } })
    const unit = rows.find(row => row.field === '指标 1 · 指标 · 单位')
    assert.match(unit.path, /binding\.unit/)
    if (bindingUnit) assert.equal(unit.source, bindingUnit)
    else assert.match(unit.updates, /不回退 item\.unit/)
    assert.equal(rows.find(row => row.field === '指标 1 · 指标 · 单位固定回退').source, 'h')
  }
  const normal = joined(widgetSourceTrace({ id: 'normal', type: 'metrics', data: { mode: 'runtime' }, content: { layout: 'list', items: [{ label: '时长', path: 'device.analog.runtime_hours', unit: 'h' }] } }))
  assert.match(normal, /单位.*固定配置.*h/)
  assert.match(joined(widgetSourceTrace({ id: 'defaults', type: 'metrics', content: { layout: 'list' } })), /完成进度 · 单位.*%/)
})

test('item unitPath overrides binding unitPath and unit, with nullish-only fallback and no invented units', () => {
  const item = { label: '温度', unit: 'fallback', unitPath: 'context.displayUnit',
    binding: { mode: 'runtime', deviceScope: 'global', path: 'metrics.current_output', unitPath: 'context.oldUnit', unit: 'old-unit' } }
  for (const [value, expected] of [['', ''], [null, 'fallback'], [undefined, 'fallback'], ['℃', '℃']]) {
    assert.equal(renderedMetricUnit(item, item.binding, path => { assert.equal(path, 'context.displayUnit'); return value }), expected)
  }
  const rows = widgetSourceTrace({ id: 'unitPath', type: 'metrics', data: { mode: 'runtime', deviceScope: 'global' }, content: { layout: 'list', items: [item] } })
  const selected = rows.find(row => row.field === '指标 1 · 温度 · 单位')
  assert.equal(selected.path, 'context.displayUnit')
  assert.match(selected.updates, /空字符串保留为空.*null \/ undefined.*回退/)
  assert.doesNotMatch(selected.source, /old-unit|context\.oldUnit/)
  assert.match(joined(rows), /存在单位路径.*不使用 binding\.unit/)
})

test('per-device metric units follow the same main-card device selection as their numeric values', () => {
  const primary = { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa' } }] }
  const item = { label: '指标', unit: 'fallback', binding: { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'b',
    deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa', unit: 'kWh' } }, { deviceId: 'b', binding: { mode: 'plc', pointId: 'pb', unit: 'h' } }] } }
  const rows = widgetSourceTrace({ id: 'main_card', type: 'metrics', data: primary, content: { layout: 'list', items: [item] } }, options)
  assert.equal(rows.find(row => row.field === '指标 1 · 指标 · 单位 · A炉').source, 'kWh')
  assert.equal(rows.some(row => row.field === '指标 1 · 指标 · 单位 · B炉'), false)
  assert.match(joined(rows), /主卡设备清单不会读取|当前主卡设备清单不会读取/)
})

test('navigation separately explains fixed preview captions, Overlay health dot, gated native sources and the existing disconnected mapping', () => {
  const rows = widgetSourceTrace(deepFreeze({ id: 'nav', type: 'navigation', runtimeTarget: 'unity', content: { projectLabel: '天津工厂', statusText: '实时数据正常' }, events: [] }))
  assert.equal(rows.find(row => row.field === '导航组件项目文案').origin, '固定配置')
  assert.equal(rows.find(row => row.field === '导航组件状态文案').source, '实时数据正常')
  assert.equal(rows.find(row => row.field === '导航预览圆点颜色').origin, '内置样式')
  assert.match(rows.find(row => row.field === '导航状态文案颜色').updates, /CSS \/ 程序版本.*不会改变/)
  assert.match(rows.find(row => row.field === '导航组件渲染面').source, /不用 runtimeTarget 判断.*没有宿主状态.*不能断言/)
  assert.match(rows.find(row => row.field === '透明 Overlay 导航圆点').source, /displayReady && hostConnected.*不等同 DataStore\.wsConnected/)
  assert.match(rows.find(row => row.field === '透明 Overlay 状态提示').path, /health\.components\.dataEngine\.fresh/)
  assert.match(rows.find(row => row.field === '原生顶部工厂名称').source, /factories\.name.*缺失 \/ 空白保留既有名称/)
  assert.match(rows.find(row => row.field === '原生后台 / PLC 状态文字').source, /payload\.status \?\? payload\.message.*不读取 health/)
  assert.match(rows.find(row => row.field === '原生状态文字 / 色条').source, /disconnected.*正常 \/ Good.*不能.*已验证健康/)
  const system = joined(systemSourceTrace())
  assert.match(system, /message \|\| status.*最后一次写入|最后一次写入.*message \|\| status/s)
  assert.match(system, /DateTime\.Now.*不是 PLC 时间/)
})

test('navigation orange colors and native retry wording are anchored to their separate real CSS/C# branches', () => {
  const rows = widgetSourceTrace({ id: 'nav_css', type: 'navigation', content: {} })
  const previewColor = renderer.match(/\.navigation-preview-status strong\{[^}]*color:([^;]+)/)?.[1]
  const overlayColor = overlay.match(/--overlay-warm:\s*(#[A-Fa-f0-9]+)/)?.[1]
  assert.ok(previewColor && overlayColor)
  assert.equal(rows.find(row => row.field === '导航状态文案颜色').source, previewColor)
  assert.equal(rows.find(row => row.field === '透明 Overlay 状态文案颜色').source, overlayColor)
  assert.notEqual(previewColor, overlayColor)
  assert.match(overlay, /\.overlay-status strong\s*\{[^}]*color:\s*var\(--overlay-warm\)/)
  const friendlyStart = nativeController.indexOf('private static string FriendlyState('), colorStart = nativeController.indexOf('private static Color StateColor(', friendlyStart)
  assert.ok(friendlyStart >= 0 && colorStart > friendlyStart)
  assert.doesNotMatch(nativeController.slice(friendlyStart, colorStart), /Contains\("retry"\)/)
  assert.match(nativeController.slice(colorStart, nativeController.indexOf('private static void WithOpacity(', colorStart)), /Contains\("retry"\)/)
  assert.match(rows.find(row => row.field === '原生状态文字 / 色条').source, /没有 retry 文案分支.*StateColor.*retry.*Warning/)
})

test('click provenance lists all configured targets, honors empty events masking legacy events and does not invent return-to-factory', () => {
  const configured = widgetSourceTrace({ id: 'nav', type: 'navigation', content: {}, events: [{ action: 'switch_view', viewId: 'line_overview' },
    { trigger: 'click', action: 'switch_view', viewId: 'device_part' }, { trigger: 'doubleClick', action: 'open_link', url: 'https://example.invalid/?pwd=SYNTHETIC_SECRET' }] })
  assert.match(joined(configured), /2 个 click.*全部匹配事件/)
  assert.match(joined(configured), /指定视角 line_overview/)
  assert.match(joined(configured), /指定视角 device_part/)
  assert.match(joined(configured), /不处理该非 click/)
  assert.doesNotMatch(joined(configured), /SYNTHETIC_SECRET/)
  const empty = widgetSourceTrace({ id: 'empty', type: 'navigation', content: {}, events: [], config: { events: [{ action: 'switch_view', viewId: 'stale_view' }] } })
  assert.match(joined(empty), /只选择.*高亮.*不自动返回工厂/)
  assert.doesNotMatch(joined(empty), /stale_view/)
  assert.match(joined(empty), /events=\[\].*遮住旧 config\.events/)
  const back = widgetSourceTrace({ id: 'back', type: 'return_button', events: [], content: {} })
  assert.match(joined(back), /deviceBackRequest.*Unity/)
  assert.match(joined(back), /没有.*当前导航历史.*不编造/)
})

test('HUD chart summary units describe statUnit nullish override or the actual main display unit', () => {
  const rows = widgetSourceTrace({ id: 'summary', type: 'hud_chart_dock', data: { mode: 'plc', pointId: 'pa', deviceId: 'a', unit: 'h' }, content: { statUnit: '' } }, options)
  assert.match(rows.find(row => row.field === '图表摘要单位').source, /statUnit=空字符串.*不加单位/)
  const fallback = widgetSourceTrace({ id: 'summary', type: 'hud_chart_dock', data: { mode: 'plc', pointId: 'pa', deviceId: 'a' }, content: {} }, options)
  assert.match(fallback.find(row => row.field === '图表摘要单位').source, /displayUnit.*点位 \/ 数据表.*元数据单位/)
})

test('v2 chart summary units describe the effective device row rather than printing a stale top-level unit', () => {
  const data = { mode: 'plc', bindingVersion: 2, deviceScope: 'fixed', deviceId: 'a', unit: 'stale-unit',
    deviceBindings: [{ deviceId: 'a', binding: { mode: 'plc', pointId: 'pa', unit: 'h' } }] }
  const rows = widgetSourceTrace({ id: 'v2_summary', type: 'hud_chart_dock', data, content: {} }, options)
  const unit = rows.find(row => row.field === '图表摘要单位')
  assert.equal(unit.path, 'content.statUnit ?? displayUnit')
  assert.match(renderer, /content\.statUnit \?\? displayUnit/)
  assert.match(unit.source, /当前设备行.*bindingForDevice.*dataBinding\.unit/)
  assert.doesNotMatch(unit.source, /stale-unit/)
  assert.equal(rows.find(row => row.field === '主数据单位 · A炉（覆盖来源单位）').source, 'h')
})
