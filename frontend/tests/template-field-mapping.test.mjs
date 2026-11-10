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

test('explicit device rows and HUD metrics map only their own dataset fields without changing playback',()=>{
 const row=(deviceId,datasetField)=>({deviceId,binding:{mode:'dataset',datasetId:'set',datasetField,datasetMode:'first'}})
 const document=documentFor({mode:'dataset',bindingVersion:2,deviceScope:'rotation',rotationIntervalMs:12000,refreshMs:1500,datasetId:'set',datasetField:'first',deviceBindings:[row('a','first'),row('b','second')]})
 const widget=document.widgets.find(widget=>widget.id==='meter')
 widget.content.items=[{label:'运行时长',binding:{mode:'dataset',bindingVersion:2,deviceScope:'current',deviceBindings:[row('a','hours_a'),row('b','hours_b')]}}]
 const original=JSON.stringify(document),rows=templateFieldBindings(document).filter(row=>row.widgetId==='meter')
 assert.equal(rows.length,4);assert.equal(new Set(rows.map(row=>row.key)).size,4)
 const primaryB=rows.find(row=>row.metricIndex===undefined&&row.deviceId==='b'),metricA=rows.find(row=>row.metricIndex===0&&row.deviceId==='a')
 primaryB.target={...primaryB.source,datasetField:'new_second'};metricA.target={...metricA.source,datasetField:'new_hours_a'}
 const mapped=applyTemplateFieldBindings(document,[primaryB,metricA]).widgets.find(widget=>widget.id==='meter')
 assert.equal(mapped.data.deviceBindings[0].binding.datasetField,'first')
 assert.equal(mapped.data.deviceBindings[1].binding.datasetField,'new_second')
 assert.equal(mapped.content.items[0].binding.deviceBindings[0].binding.datasetField,'new_hours_a')
 assert.equal(mapped.content.items[0].binding.deviceBindings[1].binding.datasetField,'hours_b')
 assert.equal(mapped.data.rotationIntervalMs,12000);assert.equal(mapped.data.refreshMs,1500)
 assert.equal(mapped.data.deviceScope,'rotation');assert.equal(JSON.stringify(document),original)
 const reordered=structuredClone(document);reordered.widgets.find(widget=>widget.id==='meter').data.deviceBindings.reverse()
 assert.throws(()=>applyTemplateFieldBindings(reordered,[primaryB]),/已改变/,'a stale row locator cannot map another device')
})

test('explicit dataset mapper previews each assigned device instead of the current navigation device',async t=>{
 const rows=[{deviceId:'a',binding:{mode:'dataset',datasetId:'set',datasetField:'reading'}},{deviceId:'b',binding:{mode:'dataset',datasetId:'set',datasetField:'reading'}}]
 const document=documentFor({mode:'dataset',bindingVersion:2,deviceScope:'rotation',datasetId:'set',datasetField:'reading',deviceBindings:rows})
 t.mock.method(adminApi,'getDataSets',async()=>({datasets:[{id:'set',columns:[{name:'reading'}]}]}))
 const requests=[];t.mock.method(adminApi,'previewDataSet',async data=>{requests.push(data);return {result:{value:42,quality:'good'}}})
 const {state}=fixture(t,document);await settle();assert.equal(state.rows.length,2)
 for(const row of state.rows)await state.preview(row)
 assert.deepEqual(requests.map(request=>request.context.deviceId),['a','b'])
})

test('tooltip field mapper previews and applies the nested template owner without main-widget lookup', async t => {
  t.mock.method(adminApi, 'getDataSets', async () => ({ datasets: [{ id:'tooltip_set',columns:[{name:'reading',label:'读数'}] }] }))
  const requests=[]
  t.mock.method(adminApi, 'previewDataSet', async data => { requests.push(data); return {result:{value:42,rows:[],quality:'good'}} })
  const document=normalizeDashboardDocument()
  const template=document.tooltipTemplates.templates[0]
  template.widgets=[{...template.widgets[1],id:'nested_only',data:{mode:'dataset',datasetId:'tooltip_set',datasetField:'reading',deviceScope:'current'}}]
  const {state,applied}=fixture(t,document)
  await settle()
  const row=state.rows[0]
  assert.equal(row.templateId,template.id)
  await state.preview(row)
  assert.equal(row.error,'')
  assert.equal(requests[0].context.deviceId,'current-device')
  row.confirmed=true
  state.apply()
  assert.equal(applied[0].tooltipTemplates.templates[0].widgets[0].data.datasetField,'reading')
  assert.ok(!applied[0].widgets.some(widget=>widget.id==='nested_only'))
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
