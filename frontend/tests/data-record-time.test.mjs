import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { dataTimeTitle, displayPreviewValue, formatDataTime, isDataTimeField, previewValueTitle } from '../src/views/admin/utils/dataRecordTime.js'
import { dataCenterPreview } from '../src/views/admin/utils/dataCenterCatalog.js'
import { fullRecordTime, recordTime, recordTimestamp, recordValue, recordValueTitle } from '../src/views/admin/utils/dataTableBrowser.js'

const iso = '2026-11-07T07:44:16.837Z'

test('all three data displays convert source ISO dates into full local time instead of showing raw UTC strings', () => {
  const timeUrl = new URL('../src/views/admin/utils/dataRecordTime.js', import.meta.url).href
  const browserUrl = new URL('../src/views/admin/utils/dataTableBrowser.js', import.meta.url).href
  const catalogUrl = new URL('../src/views/admin/utils/dataCenterCatalog.js', import.meta.url).href
  const code = `import {displayPreviewValue} from ${JSON.stringify(timeUrl)};
    import {recordTime,recordValue} from ${JSON.stringify(browserUrl)};
    import {dataCenterPreview} from ${JSON.stringify(catalogUrl)};
    console.log(JSON.stringify([displayPreviewValue({name:'updatedAt'},${JSON.stringify(iso)}),
      recordTime(${JSON.stringify(iso)}), recordValue(${JSON.stringify(iso)},{valueType:'datetime'}),
      dataCenterPreview({previewValue:${JSON.stringify(iso)},fieldRole:'time'})]));`
  const values = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: 'Asia/Hong_Kong' }, encoding: 'utf8' }))
  assert.deepEqual(values, Array(4).fill('2026-11-07 15:44:16'))
})

test('time metadata recognizes explicit roles, external field metadata and configured update field paths', () => {
  for (const field of [
    { role: 'time' }, { fieldRole: 'time', fieldName: '任意时间字段' }, { valueType: 'datetime' }, { type: 'datetime' },
    { name: 'updatedAt' }, { fieldName: 'updated_at' }, { binding: { datasetField: 'data.updatedAt' } },
    { label: '更新时间' }, { path: "data['updated_at']" }
  ]) assert.equal(isDataTimeField(field), true, JSON.stringify(field))
  for (const field of [null, {}, { name: 'timestamp' }, { name: 'createdAt' }, { name: 'expiry' },
    { name: 'updatedAt', role: 'label' }, { fieldName: 'updatedAt', fieldRole: 'value' }, { type: 'number', label: '订单编号' }
  ]) assert.equal(isDataTimeField(field), false, JSON.stringify(field))
})

test('ordinary values and identifiers are not guessed to be dates and preserve zero and false', () => {
  const order = { name: 'orderId', type: 'string' }
  for (const value of ['1794037456', '2026-11-07', iso, 'MES-20261107-005']) {
    assert.equal(displayPreviewValue(order, value), value)
    assert.equal(recordValue(value, order), value)
    assert.equal(dataCenterPreview({ ...order, previewValue: value }), value)
  }
  assert.equal(displayPreviewValue(order, 0), 0)
  assert.equal(displayPreviewValue(order, false), false)
  assert.equal(recordValue(0), '0')
  assert.equal(recordValue(false), '否')
  assert.equal(dataCenterPreview({ previewValue: false }), '否')
})

test('strict shared parsing handles ISO, SQL, Unix seconds/milliseconds and leap days consistently', () => {
  const milliseconds = Date.parse(iso)
  assert.equal(recordTimestamp(iso), milliseconds)
  assert.equal(recordTimestamp(milliseconds), milliseconds)
  assert.equal(recordTimestamp(String(milliseconds)), milliseconds)
  assert.equal(recordTimestamp(milliseconds / 1000), milliseconds)
  assert.equal(recordTimestamp(String(milliseconds / 1000)), milliseconds)
  assert.equal(recordTime(milliseconds), recordTime(iso))
  assert.match(formatDataTime('2024-02-29T12:00:00Z'), /^2024-02-29 /)
  assert.equal(formatDataTime('2026-11-07 15:44:16'), '2026-11-07 15:44:16')
})

test('missing or invalid source timestamps stay unknown, never replaced by the fetch time', () => {
  const field = { role: 'time' }
  for (const value of [null, undefined, '', 'invalid', true, false, {}, 0, -1,
    '2026-02-29T12:00:00Z', '2026-13-07T12:00:00Z', '2026-11-31T12:00:00Z', '2026-11-07T25:00:00Z',
    '2026-11-07T07:60:00Z', '2026-11-07T07:00:60Z']) {
    assert.equal(recordTimestamp(value), null, String(value))
    assert.equal(formatDataTime(value), '—', String(value))
    assert.equal(recordTime(value), '—', String(value))
    assert.equal(recordValue(value, field), '—', String(value))
    assert.equal(displayPreviewValue(field, value), '—', String(value))
    assert.equal(dataCenterPreview({ ...field, previewValue: value }), '—', String(value))
  }
})

test('hover titles retain original source values and identify local timezone without changing the API values', () => {
  const column = { role: 'time' }, row = { updatedAt: iso }
  assert.match(dataTimeTitle(iso), /本地时间/)
  assert.ok(dataTimeTitle(iso).includes(iso))
  assert.equal(previewValueTitle(column, iso), dataTimeTitle(iso))
  assert.equal(recordValueTitle(iso, { valueType: 'datetime' }), dataTimeTitle(iso))
  assert.ok(fullRecordTime(row.updatedAt).includes(iso))
  assert.equal(row.updatedAt, iso)
  assert.equal(fullRecordTime(null), '未提供更新时间')
  assert.match(dataTimeTitle('invalid'), /原始值：invalid（无效时间）/)
})

test('dataset preview and real browser templates use metadata-aware time display and raw-value hover titles', async () => {
  for (const name of ['DataSetWorkspace', 'DataTableBrowser']) {
    const url = new URL(`../src/views/admin/components/${name}.vue`, import.meta.url)
    const { descriptor, errors } = parse(await readFile(url, 'utf8'))
    assert.deepEqual(errors, [])
    assert.doesNotThrow(() => compileScript(descriptor, { id: name }))
    assert.deepEqual(compileTemplate({ source: descriptor.template.content, id: name, filename: url.pathname }).errors, [])
    if (name === 'DataSetWorkspace') {
      assert.match(descriptor.template.content, /:title="previewValueTitle\(c,row\[c.name\]\)"/)
      assert.match(descriptor.template.content, /displayPreviewValue\(c,row\[c.name\]\)/)
    } else {
      assert.match(descriptor.template.content, /recordValue\(row.value,row\)/)
      assert.match(descriptor.template.content, /recordValueTitle\(row.value,row\)/)
      assert.match(descriptor.template.content, /fullRecordTime\(row.updatedAt\)/)
    }
  }
})
