import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { deferred, installBrowser, settle } from './helpers.mjs'
import { browserRequest, dataBrowserErrorMessage, fullRecordTime, localDateInput, numericHistoryTrend, recordTime, recordTimestamp, recordValue, validateHistoryRange } from '../src/views/admin/utils/dataTableBrowser.js'

test('a missing backend route explains service restart, without disguising other missing tables or source errors', () => {
  assert.match(dataBrowserErrorMessage({ status: 404, message: '接口不存在' }), /后台.*数据浏览.*完全退出.*单独刷新页面不会更新后台/)
  assert.equal(dataBrowserErrorMessage({ status: 404, message: '数据表不存在' }), '数据表不存在')
  assert.equal(dataBrowserErrorMessage({ status: 503, message: '接口不存在' }), '接口不存在')
  assert.match(dataBrowserErrorMessage({ name: 'AbortError' }), /读取超时/)
})

const sourceUrl = new URL('../src/views/admin/components/DataTableBrowser.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: sourceUrl.pathname, id: 'data-table-browser' }).errors, [])
let compiled = compileScript(descriptor, { id: 'data-table-browser' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  const specifier = match[2], target = specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : import.meta.resolve(specifier)
  compiled = compiled.replace(match[0], `from ${JSON.stringify(target)}`)
}
const { default: Browser } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Browser.render = () => null
const sampleRow = (patch = {}) => ({ id: 'device_a_temperature', objectId: 'device_a', objectName: '1# 多用炉', objectPath: '工厂 / 热处理车间 / 1#线 / 1# 多用炉', fieldId: 'temperature', fieldName: '炉温', value: 0, unit: '℃', quality: 'good', updatedAt: '2026-11-07T05:00:00.000Z', ...patch })
const response = (patch = {}) => ({ success: true, table: { id: 'internal_devices', name: '设备资料', sourceType: 'internal' },
  fields: [{ id: 'temperature', label: '炉温', type: 'number', unit: '℃' }, { id: 'connected', label: '连接状态', type: 'boolean', unit: '' }],
  records: [sampleRow()], page: 1, pageSize: 20, total: 1, hasMore: false, readAt: '2026-11-07T05:01:00.000Z', capabilities: { history: false }, ...patch })

function fixture(t, options = {}) {
  const env = installBrowser(t), intervals = [], cleared = []
  env.replace('setInterval', callback => { intervals.push(callback); return intervals.length })
  env.replace('clearInterval', id => cleared.push(id))
  const props = ref({ factoryId: 'factory_a', table: { id: 'internal_devices', name: '设备资料', sourceType: 'internal' }, devices: [{ id: 'device_a', name: '1# 多用炉' }, { id: 'device_b', name: '2# 多用炉' }], ...options })
  t.mock.method(adminApi, 'getDataTableRecords', async () => response())
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null), app = renderer.createApp({ render: () => h(Browser, { ...props.value, ref: instance }) })
  app.mount({}); env.beforeRestore(() => app.unmount())
  return { state: instance.value.$.setupState, props, env, app, intervals, cleared }
}

test('actual data presentation preserves zero, false and unknown timestamps without preview fallback', () => {
  assert.equal(recordValue(0), '0'); assert.equal(recordValue(false), '否'); assert.equal(recordValue(null), '—')
  assert.equal(recordValue(NaN), '—'); assert.equal(recordValue({ value: 1 }), '{"value":1}')
  assert.equal(recordTime(null), '—'); assert.equal(recordTimestamp('invalid'), null)
  assert.equal(fullRecordTime('invalid'), '未提供更新时间')
  assert.equal(recordTimestamp('2026-11-07T05:00:00Z'), Date.parse('2026-11-07T05:00:00Z'))
  assert.equal(recordTimestamp(1794027600), 1794027600000)
  assert.match(localDateInput(Date.now()), /^\d{4}-\d\d-\d\dT\d\d:\d\d$/)
})

test('history query validates ranges and sends ISO dates only for actual history mode', () => {
  assert.match(validateHistoryRange('', ''), /完整/)
  assert.match(validateHistoryRange('2026-11-07T10:00', '2026-11-07T09:00'), /晚于/)
  assert.equal(validateHistoryRange('2026-11-07T09:00', '2026-11-07T10:00'), '')
  const current = browserRequest({ tableId: 't', factoryId: 'f', q: ' 炉温 ', partId: 'p', start: 'invalid' })
  assert.equal(current.q, '炉温'); assert.equal(current.partId, 'p'); assert.equal('start' in current, false)
  const historical = browserRequest({ tableId: 't', factoryId: 'f', mode: 'history', start: '2026-11-07T09:00', end: '2026-11-07T10:00' })
  assert.match(historical.start, /Z$/); assert.match(historical.end, /Z$/)
  assert.equal('value' in historical, false); assert.equal('previewValue' in historical, false)
})

test('history plot uses actual good values, breaks bad samples and never bridges different objects', () => {
  const rows = [sampleRow({ id: 'a', value: 10 }), sampleRow({ id: 'bad', value: 99, quality: 'bad', updatedAt: '2026-11-07T05:01:00Z' }), sampleRow({ id: 'b', value: 20, updatedAt: '2026-11-07T05:02:00Z' }), sampleRow({ id: 'other', value: 30, objectId: 'device_b', updatedAt: '2026-11-07T05:03:00Z' }), sampleRow({ id: 'blank', value: null, updatedAt: '2026-11-07T05:04:00Z' })]
  const trend = numericHistoryTrend(rows, 'temperature')
  assert.deepEqual(trend.points.map(point => point.value), [10, 20, 30])
  assert.equal(trend.segments.length, 3); assert.equal(trend.min, 10); assert.equal(trend.max, 30)
  assert.equal(numericHistoryTrend(rows, 'nonexistent'), null)
  assert.equal(numericHistoryTrend([sampleRow({ value: null })], 'temperature'), null)
  assert.equal(numericHistoryTrend([sampleRow()], 'temperature').points[0].y, 70)
})

test('browser is accessible, read-only, compact and clearly labels page-local history', () => {
  for (const label of ['浏览对象', '浏览数据项', '搜索数据记录', '历史开始时间', '历史结束时间', '自动刷新当前数据', '浏览部件']) assert.ok(descriptor.template.content.includes(`aria-label="${label}"`))
  assert.match(descriptor.template.content, /v-if="capabilities.history"/)
  assert.match(descriptor.template.content, /趋势仅对应本页记录/)
  assert.match(descriptor.template.content, /:title="row.objectPath/)
  assert.match(descriptor.styles[0].content, /table-layout:fixed/)
  assert.match(descriptor.styles[0].content, /overflow-x:hidden/)
  assert.doesNotMatch(descriptor.styles[0].content, /font-size:calc\((?:1[012]|[0-9])px/)
  assert.doesNotMatch(descriptor.scriptSetup.content, /saveData|updatePoint|setDevice|previewValue/)
})

test('value and long unit share an independent nowrap flex wrapper, immune to generic direct-cell span styles', () => {
  const valueCell = descriptor.template.content.match(/<td class="record-value">([\s\S]*?)<\/td>/)?.[1] || ''
  assert.match(valueCell, /^<div class="record-value-line" :title=/)
  assert.match(valueCell, /<span>\{\{recordValue\(row.value,row\)\}\}<\/span><small/)
  assert.doesNotMatch(valueCell, /^<span/)
  const styles = descriptor.styles[0].content
  assert.match(styles, /\.record-value-line\{[^}]*display:flex[^}]*min-width:0[^}]*white-space:nowrap/)
  assert.match(styles, /\.record-value-line>span\{[^}]*flex:1 1 0[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
  assert.match(styles, /\.record-value-line>small\{[^}]*max-width:45%[^}]*overflow:hidden[^}]*text-overflow:ellipsis[^}]*white-space:nowrap/)
  assert.doesNotMatch(styles, /\.record-value>span/)
  assert.doesNotMatch(descriptor.template.content, /已保存的现场历史记录|当前时间范围内没有已保存的记录/)
  assert.match(descriptor.template.content, /按来源记录时间筛选实际返回的数据/)
})

test('mount reads real scoped table records and never supplies a guessed object context', async t => {
  const { state } = fixture(t); await settle()
  const request = adminApi.getDataTableRecords.mock.calls[0].arguments[0]
  assert.equal(request.factoryId, 'factory_a'); assert.equal(request.tableId, 'internal_devices')
  assert.equal(request.deviceId, ''); assert.equal(request.partId, ''); assert.equal(request.mode, 'current')
  assert.equal(request.signal.aborted, false); assert.equal(state.records[0].value, 0)
  assert.equal(state.capabilities.history, false); assert.equal(state.loading, false)
})

test('field/object/search filters reset page and preserve readable prepared field choices', async t => {
  const { state } = fixture(t); await settle(); state.page = 3
  await state.changeFilter('field', 'temperature')
  assert.equal(state.page, 1); assert.equal(state.fields.length, 2)
  assert.equal(adminApi.getDataTableRecords.mock.calls.at(-1).arguments[0].fieldId, 'temperature')
  state.partId = 'door'; await state.changeFilter('device', 'device_b')
  assert.equal(state.partId, ''); assert.equal(adminApi.getDataTableRecords.mock.calls.at(-1).arguments[0].deviceId, 'device_b')
  state.query = ' 温度 '; await state.search()
  assert.equal(adminApi.getDataTableRecords.mock.calls.at(-1).arguments[0].q, '温度')
})

test('part-mapped table only receives explicitly selected device and part contexts', async t => {
  const { state } = fixture(t, { table: { id: 'part_dataset', sourceType: 'dataset', objectScope: 'part' } }); await settle()
  t.mock.method(adminApi, 'getDataTableRecords', async request => response({ records: request.partId ? [sampleRow({ objectId: request.partId })] : [], parts: request.deviceId ? [{ id: 'door', name: '炉门', deviceId: request.deviceId }] : [] }))
  await state.changeFilter('device', 'device_a'); assert.equal(state.parts[0].id, 'door'); assert.equal(state.records.length, 0)
  await state.changeFilter('part', 'door'); assert.equal(state.records[0].objectId, 'door')
  assert.equal(adminApi.getDataTableRecords.mock.calls.at(-1).arguments[0].partId, 'door')
})

test('history requires actual capability and prevents requests with an invalid time range', async t => {
  const { state } = fixture(t); await settle()
  assert.equal(await state.changeMode('history'), false)
  assert.equal(adminApi.getDataTableRecords.mock.calls.length, 1)
  t.mock.method(adminApi, 'getDataTableRecords', async () => response({ capabilities: { history: true } }))
  await state.load(); await state.changeMode('history')
  assert.equal(state.mode, 'history'); assert.equal(state.autoRefresh, false)
  assert.equal(adminApi.getDataTableRecords.mock.calls.at(-1).arguments[0].mode, 'history')
  const before = adminApi.getDataTableRecords.mock.calls.length
  state.start = ''; assert.equal(await state.queryHistory(), false); assert.match(state.failed, /完整/)
  assert.equal(adminApi.getDataTableRecords.mock.calls.length, before)
})

test('pagination uses returned counts and corrected server page', async t => {
  const { state } = fixture(t); await settle()
  t.mock.method(adminApi, 'getDataTableRecords', async request => response({ page: request.page, total: 45, hasMore: request.page < 3 }))
  await state.load(); assert.equal(state.pages, 3)
  await state.changePage(2); assert.equal(state.page, 2); assert.equal(state.rangeStart, 21)
  await state.changeFilter('size', '50'); assert.equal(state.page, 1); assert.equal(adminApi.getDataTableRecords.mock.calls.at(-1).arguments[0].pageSize, 50)
  t.mock.method(adminApi, 'getDataTableRecords', async () => response({ page: 1, total: 2 }))
  state.page = 2; await state.load(); assert.equal(state.page, 1)
})

test('older table/factory response cannot replace current context and previous request is aborted', async t => {
  const { state, props } = fixture(t); await settle()
  const old = deferred(); let signal
  t.mock.method(adminApi, 'getDataTableRecords', async request => {
    if (request.factoryId === 'factory_a') { signal = request.signal; return old.promise }
    return response({ records: [sampleRow({ objectName: '新工厂设备' })] })
  })
  const pending = state.load(); props.value = { ...props.value, factoryId: 'factory_b', table: { id: 'new_table', sourceType: 'internal' } }; await nextTick(); await settle()
  assert.equal(signal.aborted, true); assert.equal(state.records[0].objectName, '新工厂设备')
  old.resolve(response({ records: [sampleRow({ objectName: '旧工厂设备' })] })); await pending
  assert.equal(state.records[0].objectName, '新工厂设备')
})

test('refresh error retains explicitly stale previous result and never invents successful data', async t => {
  const { state } = fixture(t); await settle()
  t.mock.method(adminApi, 'getDataTableRecords', async () => ({ success: false, error: '现场连接超时' }))
  assert.equal(await state.refresh(), false); assert.equal(state.records[0].value, 0)
  assert.equal(state.failed, '现场连接超时'); assert.equal(state.loading, false)
  assert.match(descriptor.template.content, /下面保留上次成功读取的记录，并非本次最新结果/)
})

test('failed changed-scope search/filter/page requests cannot retain other scope records', async t => {
  const { state } = fixture(t); await settle()
  t.mock.method(adminApi, 'getDataTableRecords', async () => ({ success: false, error: '新筛选读取失败' }))
  assert.equal(await state.changeFilter('field', 'connected'), false)
  assert.equal(state.records.length, 0); assert.equal(state.total, 0); assert.equal(state.readAt, '')
  state.records = [sampleRow()]; state.readAt = 'old'; state.query = '无匹配项'
  await state.search(); assert.equal(state.records.length, 0); assert.equal(state.readAt, '')
  state.records = [sampleRow()]; state.total = 45
  await state.changePage(2); assert.equal(state.records.length, 0)
})

test('same-ID table metadata changes refresh actual fields and drop old record labels', async t => {
  const { state, props } = fixture(t); await settle()
  t.mock.method(adminApi, 'getDataTableRecords', async () => response({ fields: [{ id: 'temperature', label: '更新后的炉温', type: 'number', unit: '℃' }], records: [sampleRow({ fieldName: '更新后的炉温' })] }))
  const before = adminApi.getDataTableRecords.mock.calls.length
  props.value = { ...props.value, table: { ...props.value.table, name: '重命名设备资料' } }; await nextTick(); await settle()
  assert.equal(adminApi.getDataTableRecords.mock.calls.length, before + 1)
  assert.equal(state.fields[0].label, '更新后的炉温'); assert.equal(state.records[0].fieldName, '更新后的炉温')
})

test('object contexts and search hints honor source capabilities rather than inventing all-object reads', async t => {
  const { state, props } = fixture(t); await settle()
  t.mock.method(adminApi, 'getDataTableRecords', async () => response({ capabilities: { history: true, deviceRequired: true, partRequired: true, searchSupportsValue: false } }))
  await state.load()
  assert.deepEqual(state.capabilities, { history: true, deviceRequired: true, partRequired: true, searchSupportsValue: false })
  assert.match(descriptor.template.content, /capabilities.deviceRequired\?'请选择设备':'全部对象'/)
  props.value = { ...props.value, table: { id: 'factory_dataset', sourceType: 'dataset', objectScope: 'factory' } }; await nextTick(); await settle()
  assert.equal(state.objectOptions.length, 0)
})

test('auto refresh is opt-in, current-only, nonoverlapping and cleared on unmount', async t => {
  const { state, intervals, cleared, app } = fixture(t); await settle()
  const tick = intervals[0]; await tick(); assert.equal(adminApi.getDataTableRecords.mock.calls.length, 1)
  state.autoRefresh = true; tick(); await settle(); assert.equal(adminApi.getDataTableRecords.mock.calls.length, 2)
  state.loading = true; tick(); assert.equal(adminApi.getDataTableRecords.mock.calls.length, 2)
  state.loading = false; state.mode = 'history'; tick(); assert.equal(adminApi.getDataTableRecords.mock.calls.length, 2)
  app.unmount(); assert.deepEqual(cleared, [1])
})

test('unmount aborts pending request and prevents late state updates', async t => {
  const { state, app } = fixture(t); await settle(); const pending = deferred(); let signal
  t.mock.method(adminApi, 'getDataTableRecords', async request => { signal = request.signal; return pending.promise })
  const request = state.load(); app.unmount(); assert.equal(signal.aborted, true)
  pending.resolve(response({ records: [] })); await request
  assert.equal(state.records.length, 1)
})
