import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnectionControl, RESTART_RECEIPT_KEY } from '../src/views/admin/composables/useServiceConnections.js'
import { createServiceConnectionBridge, SERVICE_ACTIONS } from '../src/runtime/serviceConnectionBridge.js'
import { deferred, settle } from './helpers.mjs'

const snapshot = (extra = {}) => ({ success: true, factoryId: 'owned-a',
  services: ['unity', 'devices', 'data', 'session'].map(key => ({ key, name: key, label: '已确认', tone: 'is-online', connected: true, lastSuccessAt: 1000 })),
  unity: { state: 'ready' }, collection: { processRunning: true, lastCommunicationAt: 1100, state: 'healthy', mode: 'integrated_plc' }, ...extra })
function fixture(extra = {}) {
  const state = { services: snapshot().services, busy: '', feedback: {}, snapshot: null }, calls = []
  let time = 1000
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const options = { state, read: async (path, method) => { calls.push(['read', path, method]); return snapshot() },
    session: async () => { calls.push(['session']); return { authenticated: true } }, allow: () => true, native: true,
    bridge: { request: async action => { calls.push(['bridge', action]); return { success: true } }, dispose: () => calls.push(['dispose']) },
    reconnect: async () => { calls.push(['reconnect']); return { success: true } }, activeChannels: () => 1,
    confirm: async () => { calls.push(['confirm']); return true }, prepareRestart: async () => { calls.push(['save']); return true },
    unlock: async () => calls.push(['unlock']), storage, now: () => time, delay: async ms => { time += ms }, ...extra }
  return { state, calls, values, storage, control: createConnectionControl(options), advance: ms => { time += ms } }
}

test('status checks are read-only and failed checks retain last success while dropping false green', async () => {
  const f = fixture()
  assert.equal(await f.control.run({ kind: 'data', action: 'check' }), true)
  assert.deepEqual(f.calls, [['session'], ['read', '/system/connections/status', 'GET']])
  assert.equal(f.state.feedback.data.type, 'success')
  const failed = fixture({ read: async () => { throw new Error('服务不可达') } })
  assert.equal(await failed.control.run({ kind: 'unity', action: 'check' }), false)
  assert.equal(failed.state.services.every(row => !row.connected && row.stale && row.tone === 'is-unknown' && row.lastSuccessAt === 1000), true)
  assert.equal(failed.state.feedback.unity.type, 'error')
})

test('permissions and native capabilities reject unsupported actions before dispatch', async () => {
  const f = fixture({ allow: () => false, native: false, activeChannels: () => 0 })
  for (const [kind, action] of [['unity', 'restart'], ['unity', 'reconnect'], ['devices', 'restart'], ['devices', 'center'], ['data', 'center'], ['data', 'reconnect'], ['session', 'restart'], ['unknown', 'check']]) {
    assert.equal(await f.control.run({ kind, action }), false)
  }
  assert.deepEqual(f.calls, [])
  assert.equal(f.control.actions().session.some(row => row.id === 'restart'), false)
  assert.equal(await f.control.run({ kind: 'session', action: 'unlock' }), true)
  assert.deepEqual(f.calls, [['unlock']])
})

test('restart mutex reserves before save and confirmation, and refusal never reaches a bridge', async () => {
  const save = deferred()
  const f = fixture({ prepareRestart: () => save.promise })
  const first = f.control.run({ kind: 'unity', action: 'restart' })
  assert.equal(f.state.busy, 'unity')
  assert.equal(await f.control.run({ kind: 'devices', action: 'restart' }), false)
  assert.equal(await f.control.run({ kind: 'unity', action: 'restart' }), false)
  save.resolve(false); assert.equal(await first, false)
  assert.deepEqual(f.calls, [])
  assert.equal(f.state.busy, '')
  const denied = fixture({ confirm: async () => false })
  assert.equal(await denied.control.run({ kind: 'devices', action: 'restart' }), false)
  assert.deepEqual(denied.calls, [])
})

test('permissions revoked while confirmation is open prevent the eventual restart', async () => {
  const answer = deferred()
  let allowed = true
  const f = fixture({ allow: () => allowed, confirm: () => answer.promise })
  const pending = f.control.run({ kind: 'devices', action: 'restart' })
  allowed = false; answer.resolve(true)
  assert.equal(await pending, false)
  assert.equal(f.calls.some(row => row[0] === 'bridge' || row[1] === '/engine/restart'), false)
  assert.equal(f.state.feedback.devices.type, 'error')
})

test('Unity restart accepted receipt is not recovery success; only matching later readiness completes it', async () => {
  const operationId = 'a'.repeat(32)
  const f = fixture({ bridge: { request: async action => action === 'unity_restart' ? { accepted: true, operationId } : { success: true, state: 'ready' }, dispose() {} } })
  assert.equal(await f.control.run({ kind: 'unity', action: 'restart' }), true)
  assert.equal(f.state.feedback.unity.type, 'info')
  assert.match(f.state.feedback.unity.message, /尚未确认恢复/)
  assert.deepEqual(JSON.parse(f.values.get(RESTART_RECEIPT_KEY)), { operationId, at: 1000 })
  await f.control.recoverReceipt()
  assert.equal(f.state.feedback.unity.type, 'success')
  assert.equal(f.values.has(RESTART_RECEIPT_KEY), false)
  const rejected = fixture({ bridge: { request: async () => ({ accepted: true, operationId: 'bad-id' }), dispose() {} } })
  assert.equal(await rejected.control.run({ kind: 'unity', action: 'restart' }), false)
  assert.equal(rejected.values.has(RESTART_RECEIPT_KEY), false)
})

test('collector restart waits for new valid communication and reports simulation explicitly', async () => {
  const f = fixture({ read: async (path) => path === '/engine/restart' ? { success: true } : snapshot({ collection: { processRunning: true, lastCommunicationAt: 999, state: 'healthy' } }) })
  assert.equal(await f.control.run({ kind: 'devices', action: 'restart' }), false)
  assert.equal(f.state.feedback.devices.type, 'error')
  assert.match(f.state.feedback.devices.message, /尚未确认/)
  const sim = fixture({ read: async path => path === '/engine/restart' ? { success: true } : snapshot({ collection: { processRunning: true, lastCommunicationAt: 1100, state: 'simulation', mode: 'simulation' } }) })
  assert.equal(await sim.control.run({ kind: 'devices', action: 'restart' }), true)
  assert.match(sim.state.feedback.devices.message, /模拟读数（不代表 PLC 在线）/)
})

test('reconnect really dispatches the corresponding bridge or current active channel, not a read-only check', async () => {
  const native = fixture()
  assert.equal(await native.control.run({ kind: 'unity', action: 'reconnect' }), true)
  assert.deepEqual(native.calls, [['bridge', 'unity_reconnect'], ['read', '/system/connections/status', 'GET']])
  const web = fixture({ native: false })
  assert.equal(await web.control.run({ kind: 'data', action: 'reconnect' }), true)
  assert.deepEqual(web.calls, [['reconnect'], ['read', '/system/connections/status', 'GET']])
})

test('after a new handshake, failed re-probe must not produce a blanket success state', async () => {
  const f = fixture({ read: async () => { throw new Error('状态检测失败') } })
  await f.control.run({ kind: 'data', action: 'reconnect' })
  assert.notEqual(f.state.feedback.data.type, 'success', 'unverified service recovery cannot be reported as successful')
  assert.equal(f.state.services.every(row => !row.connected), true)
})

test('malformed and expired receipt timestamps cannot trigger native status actions', async () => {
  for (const at of ['invalid', null, -200000, 2000]) {
    const f = fixture()
    f.values.set(RESTART_RECEIPT_KEY, JSON.stringify({ operationId: 'b'.repeat(32), at }))
    await f.control.recoverReceipt()
    assert.equal(f.calls.length, 0, 'invalid/expired/future receipt must not poll')
  }
})

test('receipt storage errors never become unhandled rejections or a fabricated successful restart', async () => {
  const receipt = JSON.stringify({ operationId: 'c'.repeat(32), at: 1000 })
  const f = fixture({ storage: { getItem: () => receipt, removeItem() { throw new Error('blocked storage') } },
    bridge: { request: async () => ({ success: true, state: 'ready' }), dispose() {} } })
  await f.control.recoverReceipt()
  assert.equal(f.state.busy, '')
  assert.equal(f.state.feedback.unity.type, 'success', 'verified readiness remains valid even when receipt cleanup is blocked')
  const blocked = fixture({ storage: { setItem() { throw new Error('private storage exception') } },
    bridge: { request: async () => ({ accepted: true, operationId: 'd'.repeat(32) }), dispose() {} } })
  assert.equal(await blocked.control.run({ kind: 'unity', action: 'restart' }), false)
  assert.equal(blocked.state.feedback.unity.type, 'error')
  assert.match(blocked.state.feedback.unity.message, /重启已受理，但无法保存确认回执/)
  assert.doesNotMatch(blocked.state.feedback.unity.message, /private storage exception/)
})

test('disposing suppresses late snapshot application and pending action feedback', async () => {
  const result = deferred()
  const f = fixture({ read: () => result.promise })
  const pending = f.control.refresh()
  f.control.dispose(); result.resolve(snapshot({ factoryId: 'late' }))
  assert.equal(await pending, null)
  assert.equal(f.state.snapshot, null)
  assert.equal(await f.control.run({ kind: 'data', action: 'check' }), false)
})

test('factory changes discard in-flight old rows and probe the new scope without mixing devices', async () => {
  let factoryId = 'owned-a'
  const old = deferred(), requests = []
  const f = fixture({ scope: () => factoryId, read: (path, method, options) => {
    requests.push(options.factoryId)
    return options.factoryId === 'owned-a' ? old.promise : Promise.resolve(snapshot({ factoryId: 'owned-b' }))
  } })
  const first = f.control.refresh()
  factoryId = 'owned-b'; f.control.invalidate()
  assert.equal(f.state.services.every(row => !row.connected && row.label === '等待检测'), true)
  const second = f.control.refresh()
  old.resolve(snapshot({ factoryId: 'owned-a' }))
  assert.equal(await first, null)
  assert.equal((await second).factoryId, 'owned-b')
  assert.deepEqual(requests, ['owned-a', 'owned-b'])
  assert.equal(f.state.snapshot.factoryId, 'owned-b')
})

test('scope mismatch and malformed status response cannot overwrite a valid service snapshot', async () => {
  const f = fixture({ scope: () => 'owned-a', read: async () => snapshot({ factoryId: 'owned-b' }) })
  assert.equal(await f.control.refresh(), null)
  assert.equal(f.state.snapshot, null)
  assert.equal(f.state.services.every(row => !row.connected), true)
  const bad = fixture({ read: async () => snapshot({ services: [{ key: 'unity' }] }) })
  assert.equal(await bad.control.refresh(), null)
  assert.equal(bad.state.snapshot, null)
})

function bridgeFixture() {
  const sent = [], timers = new Map()
  let listener, counter = 0, removed = false
  const bridge = createServiceConnectionBridge({ post: value => sent.push(value), listen: handler => listener = handler,
    unlisten: handler => { assert.equal(handler, listener); removed = true },
    later: (callback, delay) => { const id = ++counter; timers.set(id, { callback, delay }); return id },
    cancel: id => timers.delete(id) })
  return { bridge, sent, timers, receive: data => listener({ data }), get removed() { return removed } }
}

test('native bridge only sends fixed action identifiers and correlates results, never tokens or arbitrary URLs', async () => {
  const f = bridgeFixture()
  assert.deepEqual([...SERVICE_ACTIONS].sort(), ['collector_center_data', 'collector_center_runtime', 'data_reconnect', 'restart_status', 'unity_reconnect', 'unity_restart'].sort())
  await assert.rejects(f.bridge.request('shell'), /不支持/)
  assert.equal(f.sent.length, 0)
  const pending = f.bridge.request('unity_reconnect')
  assert.equal(f.sent.length, 1)
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['type', 'action', 'requestId', 'operationId'].sort())
  f.receive({ type: 'not_a_result', requestId: f.sent[0].requestId, success: true })
  f.receive({ type: 'service_connection_result', requestId: 'wrong', success: true })
  assert.equal(f.timers.size, 1)
  f.receive({ type: 'service_connection_result', requestId: f.sent[0].requestId, success: true, handshakeAt: 1200 })
  assert.equal((await pending).handshakeAt, 1200)
  assert.equal(f.timers.size, 0)
  f.bridge.dispose(); assert.equal(f.removed, true)
})

test('bridge refusal, timeout, post failure and disposal reject without late success', async () => {
  const f = bridgeFixture(), denied = f.bridge.request('data_reconnect')
  f.receive({ type: 'service_connection_result', requestId: f.sent[0].requestId, success: false, error: '拒绝操作', code: 'DENIED' })
  await assert.rejects(denied, error => error.code === 'DENIED')
  const timed = f.bridge.request('restart_status')
  const id = f.sent.at(-1).requestId, timer = [...f.timers.values()][0]
  assert.equal(timer.delay, 35000); timer.callback()
  await assert.rejects(timed, /超时/)
  f.receive({ type: 'service_connection_result', requestId: id, success: true })
  const disposed = f.bridge.request('unity_restart'); f.bridge.dispose()
  await assert.rejects(disposed, /已关闭/)
  await assert.rejects(f.bridge.request('data_reconnect'), /不支持/)
  const boom = createServiceConnectionBridge({ post() { throw new Error('post failed') }, listen() {}, unlisten() {} })
  await assert.rejects(boom.request('unity_reconnect'), /post failed/); boom.dispose()
  await settle()
})
