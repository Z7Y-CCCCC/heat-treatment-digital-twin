import test from 'node:test'
import assert from 'node:assert/strict'
import { installBrowser, json } from './helpers.mjs'

test.mock.module('../src/runtime/adminSession.js', { namedExports: { adminFetch: (...args) => globalThis.fetch(...args) } })
const { adminApi } = await import('../src/config/factoryConfig.js')

test('data records request uses encoded table ID, explicit factory scope, filters and cancellation without a write', async t => {
  const env = installBrowser(t), calls = [], controller = new AbortController()
  env.replace('fetch', async (url, options) => { calls.push({ url, options }); return json({ success: true, records: [] }) })
  const result = await adminApi.getDataTableRecords({ tableId: 'table/one', factoryId: 'factory_b', mode: 'history',
    q: '炉内温度', deviceId: 'device_b', partId: 'front_door', fieldId: 'temperature', page: 2, pageSize: 50,
    start: '2026-11-07T00:00:00Z', end: '2026-11-07T01:00:00Z', signal: controller.signal })
  assert.equal(result.success, true); assert.equal(calls.length, 1)
  const { url, options } = calls[0], parsed = new URL(url, 'http://localhost')
  assert.match(parsed.pathname, /\/data-center\/tables\/table%2Fone\/records$/)
  assert.deepEqual(Object.fromEntries(parsed.searchParams), { mode: 'history', page: '2', page_size: '50', q: '炉内温度',
    device_id: 'device_b', part_id: 'front_door', field_id: 'temperature', start: '2026-11-07T00:00:00Z', end: '2026-11-07T01:00:00Z' })
  assert.equal(options.headers['X-Factory-ID'], 'factory_b'); assert.equal(options.cache, 'no-store')
  assert.equal(options.signal, controller.signal); assert.equal(options.body, undefined)
  assert.ok(!options.method || options.method === 'GET')
})

test('records errors retain status and notice, never turn unavailable source into a successful static preview', async t => {
  const env = installBrowser(t)
  env.replace('fetch', async () => json({ success: false, error: '数据源暂不可用', notice: '请检查连接' }, 503))
  assert.deepEqual(await adminApi.getDataTableRecords({ tableId: 'dataset_1' }), {
    success: false, error: '数据源暂不可用', notice: '请检查连接', status: 503
  })
})
