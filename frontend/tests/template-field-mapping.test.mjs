import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, ref } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { adminApi } from '../src/config/factoryConfig.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { applyTemplateFieldBindings, suggestTemplateFields, templateFieldBindings, validateTemplateFieldBinding, remapCopiedWidgetEvents } from '../src/runtime/templateFieldMapping.js'
import { deferred, settle } from './helpers.mjs'

const sourceUrl = new URL('../src/views/admin/components/TemplateFieldMapper.vue', import.meta.url)
const { descriptor, errors } = parse(await readFile(sourceUrl, 'utf8'))
assert.deepEqual(errors, [])
assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: sourceUrl.pathname, id: 'mapper' }).errors, [])
let compiled = compileScript(descriptor, { id: 'mapper' }).content
for (const match of [...compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
  compiled = compiled.replace(match[0], `from ${JSON.stringify(match[2].startsWith('.') ? new URL(match[2], sourceUrl).href : import.meta.resolve(match[2]))}`)
}
const { default: Mapper } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
Mapper.render = () => null

function documentFor(data) { return normalizeDashboardDocument({ widgets: [{ id: 'meter', type: 'value', data }] }) }
function fixture(t, document) {
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const instance = ref(null)
  const applied = []
  const app = renderer.createApp({ render: () => h(Mapper, { ref: instance, document, context: { deviceId: 'current-device' }, onApply: value => applied.push(value) }) })
  app.mount({})
  t.after(() => app.unmount())
  return { state: instance.value.$.setupState, applied }
}

test('field suggestions expose aliases and type conflicts without dropping arbitrary fields', () => {
  const candidates = suggestTemplateFields('actual_temp', [{ name: '温度', dataType: 'real' }, { name: 'actual_temp', dataType: 'varchar' }, { name: 'unusual_measurement', dataType: 'double' }], 'number')
  assert.equal(candidates[0].value, '温度')
  assert.match(candidates[0].reason, /别名/)
  assert.match(candidates.find(row => row.value === 'actual_temp').reason, /类型不同/)
  assert.equal(candidates.length, 3)
  const ambiguous = suggestTemplateFields('temperature', [{ path: 'a.temperature' }, { path: 'b.temperature' }])
  assert.equal(ambiguous[0].score, ambiguous[1].score)
  assert.ok(ambiguous.every(row => row.score < 100), 'matching leaves are only suggestions')
})

test('mapping preserves formulas, aliases and mapped filter/sort fields across serialization', () => {
  const document = documentFor({ mode: 'database', formula: 'a*2', datasets: [{ alias: 'a', connectionId: 'db', table: 'old', field: 'temperature', timeField: 'time', orderBy: 'time', contextField: 'machine', contextKey: 'deviceId' }] })
  const rows = templateFieldBindings(document)
  rows[0].target = { ...rows[0].source, table: 'measurements', field: 'reading', timeField: 'created_at', orderBy: 'created_at', contextField: 'device_id' }
  rows[0].tables = [{ name: 'measurements' }]
  rows[0].fields = ['reading', 'created_at', 'device_id'].map(name => ({ name }))
  validateTemplateFieldBinding(rows[0])
  const mapped = normalizeDashboardDocument(JSON.parse(JSON.stringify(applyTemplateFieldBindings(document, rows))))
  const data = mapped.widgets.find(row => row.id === 'meter').data
  assert.equal(data.formula, 'a*2')
  assert.equal(data.field, 'reading')
  assert.equal(data.datasets[0].contextField, 'device_id')
  assert.equal(data.datasets[0].contextKey, 'deviceId')
  assert.equal(document.widgets.find(row => row.id === 'meter').data.datasets[0].table, 'old')
  rows[0].target.contextField = ''
  assert.throws(() => validateTemplateFieldBinding(rows[0]), /映射/)
})

test('database mapper reads real schema, blocks unchecked preview, invalidates after edit, and applies selected values', async t => {
  t.mock.method(adminApi, 'getDataSourceTables', async () => ({ tables: [{ name: 'measurements', schema: '' }] }))
  t.mock.method(adminApi, 'getDataSourceColumns', async () => ({ columns: [{ name: '温度', dataType: 'real' }, { name: 'operator_custom', dataType: 'real' }] }))
  const requests = []
  t.mock.method(adminApi, 'previewDataSource', async data => { requests.push(data); return { result: { value: 42, rows: [], quality: 'good' } } })
  const { state, applied } = fixture(t, documentFor({ mode: 'database', deviceScope: 'fixed', deviceId: 'mapped-device', datasets: [{ connectionId: 'db', table: 'old', field: 'actual_temp' }] }))
  await settle()
  const row = state.rows[0]
  assert.equal(row.target.table, '')
  await state.changeTable(row, '\u0001measurements')
  assert.equal(row.target.field, '', 'alias candidates are not silently selected')
  assert.equal(state.candidates(row, 'field')[0].value, '温度')
  row.target.field = 'operator_custom'
  await state.preview(row)
  assert.equal(row.preview.value, 42)
  assert.equal(requests[0].context.deviceId, 'mapped-device')
  state.apply()
  assert.equal(applied.length, 0)
  row.confirmed = true
  state.invalidate(row)
  assert.equal(row.preview, null)
  assert.equal(row.confirmed, false)
  await state.preview(row)
  row.confirmed = true
  state.apply()
  assert.equal(applied[0].widgets.find(widget => widget.id === 'meter').data.datasets[0].field, 'operator_custom')
})

test('HTTP mapper allows undiscovered arbitrary paths but requires a successful current preview', async t => {
  t.mock.method(adminApi, 'inspectHttpDataSource', async () => ({ result: { fields: [{ path: 'payload.temperature', kind: 'number', sample: '20' }] } }))
  const pending = deferred()
  t.mock.method(adminApi, 'previewHttpDataSource', async data => data.jsonPath === 'deep.custom[2].value' ? { result: { value: 76, quality: 'good' } } : pending.promise)
  const { state, applied } = fixture(t, documentFor({ mode: 'http_api', connectionId: 'api', apiPath: '/metrics', jsonPath: 'old' }))
  await settle()
  const row = state.rows[0]
  const stale = state.preview(row)
  row.target.jsonPath = 'deep.custom[2].value'
  state.invalidate(row)
  pending.resolve({ result: { value: 999, quality: 'good' } })
  await stale
  assert.equal(row.preview, null, 'stale responses cannot authorize changed bindings')
  await state.preview(row)
  row.confirmed = true
  state.apply()
  assert.equal(applied[0].widgets.find(widget => widget.id === 'meter').data.jsonPath, 'deep.custom[2].value')
})

test('copy remaps selected internal visibility targets and retains external targets', () => {
  const copies = [{ id: 'a2', events: [{ targetType: 'widget', targetId: 'b' }, { targetType: 'widget', targetId: 'outside' }, { targetType: 'group', targetId: 'b' }] }]
  remapCopiedWidgetEvents(copies, { a: 'a2', b: 'b2' })
  assert.deepEqual(copies[0].events.map(event => event.targetId), ['b2', 'outside', 'b'])
})

test('HTTP mapper surfaces fulfilled API errors for inspection and preview', async t => {
  t.mock.method(adminApi, 'inspectHttpDataSource', async () => ({ error: 'HTTP 404: old endpoint' }))
  t.mock.method(adminApi, 'previewHttpDataSource', async () => ({ success: false, error: 'HTTP 502: upstream unavailable' }))
  const { state, applied } = fixture(t, documentFor({ mode: 'http_api', connectionId: 'api', apiPath: '/old', jsonPath: 'value' }))
  await settle()
  const row = state.rows[0]
  assert.equal(row.error, 'HTTP 404: old endpoint')
  assert.equal(row.busy, false)
  assert.equal(state.ready, false)
  await state.preview(row)
  assert.equal(row.error, 'HTTP 502: upstream unavailable')
  assert.equal(row.preview, null)
  state.apply()
  assert.equal(applied.length, 0)
})

test('database mapper distinguishes failed table and column discovery from empty schema', async t => {
  t.mock.method(adminApi, 'getDataSourceTables', async () => ({ error: 'database offline' }))
  t.mock.method(adminApi, 'getDataSourceColumns', async () => ({ success: false, error: 'column access denied' }))
  const { state } = fixture(t, documentFor({ mode: 'database', datasets: [{ connectionId: 'db', table: 'metrics', field: 'temperature' }] }))
  await settle()
  const row = state.rows[0]
  assert.equal(row.error, 'database offline')
  assert.equal(row.target.table, 'metrics', 'failed discovery must not erase the original binding')
  await state.changeTable(row, '\u0001measurements')
  assert.equal(row.error, 'column access denied')
  assert.equal(row.busy, false)
  assert.equal(state.ready, false)
})
