import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, h } from 'vue'
import { createConnectionControl, useServiceConnections, RESTART_RECEIPT_KEY } from '../src/views/admin/composables/useServiceConnections.js'
import { createServiceConnectionBridge, SERVICE_ACTIONS } from '../src/runtime/serviceConnectionBridge.js'
import { deferred, installBrowser, settle } from './helpers.mjs'

const snapshot = (extra = {}) => ({ success: true, factoryId: 'owned-a',
  services: ['unity', 'devices', 'data', 'session'].map(key => ({ key, name: key, label: '已确认', tone: 'is-online', connected: true, lastSuccessAt: 1000 })),
  unity: { state: 'ready' }, collection: { processRunning: true, lastCommunicationAt: 1100, state: 'healthy', mode: 'integrated_plc' }, ...extra })
function fixture(extra = {}) {
  const state = { services: snapshot().services, busy: '', feedback: {}, snapshot: null }, calls = []
  let time = 1000
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const options = { state, read: async (path, method) => { calls.push(['read', path, method]); return snapshot() },
    session: async () => { calls.push(['session']); return { authenticated: true } }, allow: () => true, native: true,
    bridge: { request: async action => { calls.push(['bridge', action]); return { success: true, connected: true } }, dispose: () => calls.push(['dispose']) },
    reconnect: async () => { calls.push(['reconnect']); return { success: true, channels: 1 } }, activeChannels: () => 1,
    confirm: async () => { calls.push(['confirm']); return true }, prepareRestart: async () => { calls.push(['save']); return true },
    unlock: async () => { calls.push(['unlock']); return true }, storage, now: () => time, delay: async ms => { time += ms }, ...extra }
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

test('session action invokes the injected re-unlock flow, and opening the password page is not authentication success', async () => {
  const f=fixture()
  assert.equal(f.control.actions().session.find(row=>row.id==='unlock').label,'重新解锁后台')
  assert.equal(await f.control.run({kind:'session',action:'unlock'}),true)
  assert.deepEqual(f.calls,[['unlock']]);assert.equal(f.state.feedback.session.type,'info')
  assert.match(f.state.feedback.session.message,/解锁页.*页面提示/);assert.doesNotMatch(f.state.feedback.session.message,/认证成功|登录成功/)
})

test('a refused or unconfirmed re-unlock never reports a no-op success or reads/writes configuration', async () => {
  for(const result of [false,undefined,null,{success:true}]) {
    let attempts=0
    const f=fixture({unlock:async()=>{attempts++;return result}})
    assert.equal(await f.control.run({kind:'session',action:'unlock'}),false)
    assert.equal(attempts,1);assert.deepEqual(f.calls,[]);assert.equal(f.state.feedback.session.type,'info')
    assert.match(f.state.feedback.session.message,/未进入.*保留/);assert.equal(f.state.busy,'')
  }
  const missing=fixture({unlock:undefined})
  assert.equal(missing.control.actions().session.find(row=>row.id==='unlock').disabled,true)
  assert.match(missing.control.actions().session.find(row=>row.id==='unlock').reason,/未接入/)
  assert.equal(await missing.control.run({kind:'session',action:'unlock'}),false);assert.deepEqual(missing.calls,[])
})

test('re-unlock owns the mutex while its draft guard is open, and late disposal never applies authentication feedback', async () => {
  const guard=deferred();let attempts=0
  const f=fixture({unlock:()=>{attempts++;return guard.promise}})
  const work=f.control.run({kind:'session',action:'unlock'});assert.equal(f.state.busy,'session')
  assert.equal(await f.control.run({kind:'session',action:'unlock'}),false)
  assert.equal(await f.control.run({kind:'data',action:'center'}),false);assert.equal(attempts,1)
  f.control.dispose();guard.resolve(true);assert.equal(await work,true)
  assert.equal(f.state.feedback.session,null);assert.equal(f.state.busy,'');assert.deepEqual(f.calls,[['dispose']])
})

test('the mounted service hook passes the real unlock callback rather than refreshing and showing the already-open host', async t => {
  const env=installBrowser(t),messages=[],listeners=new Set();let attempts=0,hook
  env.browser.chrome={webview:{postMessage:value=>messages.push(value),addEventListener:(_name,fn)=>listeners.add(fn),removeEventListener:(_name,fn)=>listeners.delete(fn)}}
  const renderer=createRenderer({createElement:()=>({}),createText:()=>({}),createComment:()=>({}),setText(){},setElementText(){},parentNode:()=>null,nextSibling:()=>null,patchProp(){},insert(){},remove(){}}),root={}
  const component={setup(){hook=useServiceConnections({confirm:async()=>true,prepareRestart:async()=>true,unlock:async()=>{attempts++;return true}});return()=>null}}
  renderer.render(h(component),root);env.beforeRestore(()=>renderer.render(null,root))
  assert.equal(await hook.handleConnectionAction({kind:'session',action:'unlock'}),true)
  assert.equal(attempts,1);assert.deepEqual(messages,[],'an already-open show_admin message is not a re-unlock')
  assert.equal(hook.connectionState.feedback.session.type,'info')
  renderer.render(null,root);assert.equal(listeners.size,0)
})

test('device and data monitor actions open distinct confirmed views of the same existing service', async () => {
  const requests=[],f=fixture({bridge:{request:async action=>{requests.push(action);return{success:true,opened:true,view:action==='collector_center_data'?'points':'overview'}},dispose(){}}})
  assert.equal(await f.control.run({kind:'devices',action:'center'}),true)
  assert.equal(await f.control.run({kind:'data',action:'center'}),true)
  assert.deepEqual(requests,['collector_center_data','collector_center_runtime']);assert.deepEqual(f.calls,[])
  assert.equal(f.state.feedback.devices.type,'info');assert.match(f.state.feedback.devices.message,/设备采集管理.*采集状态 \/ 点位.*不代表/)
  assert.equal(f.state.feedback.data.type,'info');assert.match(f.state.feedback.data.message,/数据服务管理.*API \/ 数据库 \/ 数据通道.*不代表/)
  assert.match(f.control.actions().devices.find(row=>row.id==='center').label,/设备采集管理/)
  assert.match(f.control.actions().data.find(row=>row.id==='center').label,/数据服务管理/)
})

test('monitor actions preserve their distinct data/runtime grants and cannot swap protocol ids to bypass permissions', async () => {
  for(const [grant,allowedKind,expectedAction,view] of [['data','devices','collector_center_data','points'],['runtime','data','collector_center_runtime','overview']]) {
    const requests=[],f=fixture({allow:kind=>kind===grant,bridge:{request:async action=>{requests.push(action);return{success:true,opened:true,view}},dispose(){}}})
    assert.equal(await f.control.run({kind:allowedKind==='devices'?'data':'devices',action:'center'}),false)
    assert.equal(await f.control.run({kind:allowedKind,action:'center'}),true);assert.deepEqual(requests,[expectedAction])
  }
})

test('a missing opened flag or mismatched view cannot masquerade as a confirmed monitor destination', async () => {
  for(const [kind,expectedView] of [['devices','points'],['data','overview']]) {
    for(const result of [null,{success:true},{success:true,opened:false,view:expectedView},{success:true,opened:'true',view:expectedView},
      {success:true,opened:true,view:expectedView==='points'?'overview':'points'},{success:false,opened:true,view:expectedView}]) {
      let requests=0
      const f=fixture({bridge:{request:async()=>{requests++;return result},dispose(){}}})
      assert.equal(await f.control.run({kind,action:'center'}),false);assert.equal(requests,1)
      assert.equal(f.state.feedback[kind].type,'error');assert.match(f.state.feedback[kind].message,/未确认打开所选页面/)
      assert.deepEqual(f.calls,[['read','/system/connections/status','GET']]);assert.equal(f.state.busy,'')
    }
  }
})

test('a late monitor receipt after unmount cannot mark the new page as opened', async () => {
  const receipt=deferred(),f=fixture({bridge:{request:()=>receipt.promise,dispose(){}}})
  const work=f.control.run({kind:'data',action:'center'});f.control.dispose();receipt.resolve({success:true,opened:true,view:'overview'})
  assert.equal(await work,false);assert.equal(f.state.feedback.data,null);assert.deepEqual(f.calls,[])
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

test('dispatch-only or malformed reconnect receipts never become new-handshake success', async () => {
  for (const kind of ['unity', 'data']) {
    for (const receipt of [null, { success: true }, { success: true, connected: false },
      { success: true, connected: 'true' }, { success: false, connected: true }]) {
      const f = fixture({ bridge: { request: async () => receipt, dispose() {} } })
      assert.equal(await f.control.run({ kind, action: 'reconnect' }), false)
      assert.equal(f.state.feedback[kind].type, 'error')
      assert.match(f.state.feedback[kind].message, /握手未确认/)
      assert.equal(f.state.busy, '')
    }
  }
  for (const receipt of [null, { success: true }, { success: true, channels: 0 },
    { success: true, channels: '1' }, { success: false, channels: 1 }]) {
    const f = fixture({ native: false, reconnect: async () => receipt })
    assert.equal(await f.control.run({ kind: 'data', action: 'reconnect' }), false)
    assert.equal(f.state.feedback.data.type, 'error')
  }
})

test('late reconnect handshake or status completion after unmount cannot report success', async () => {
  for (const stage of ['handshake', 'status']) {
    const pending = deferred(), f = fixture({
      bridge: { request: () => stage === 'handshake' ? pending.promise : Promise.resolve({ success: true, connected: true }), dispose() {} },
      read: () => stage === 'status' ? pending.promise : Promise.resolve(snapshot())
    })
    const work = f.control.run({ kind: 'unity', action: 'reconnect' })
    await settle()
    f.control.dispose()
    pending.resolve(stage === 'handshake' ? { success: true, connected: true } : snapshot())
    assert.equal(await work, false)
    assert.equal(f.state.feedback.unity, null)
    assert.equal(f.state.busy, '')
  }
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

test('Unity menu reconnect stays on its fixed action and ends the busy state on host refusal or timeout, never show_dashboard', async () => {
  for (const outcome of ['connected', 'refused', 'timeout']) {
    const native = bridgeFixture(), f = fixture({ bridge: native.bridge })
    const work = f.control.run({ kind: 'unity', action: 'reconnect' })
    assert.equal(f.state.busy, 'unity')
    assert.equal(native.sent.length, 1)
    assert.equal(native.sent[0].type, 'service_connection_action')
    assert.equal(native.sent[0].action, 'unity_reconnect')
    assert.equal(native.sent.some(message => message.type === 'host_action' || message.action === 'show_dashboard'), false)
    const requestId = native.sent[0].requestId
    if (outcome === 'timeout') [...native.timers.values()][0].callback()
    else native.receive({ type: 'service_connection_result', requestId,
      success: outcome === 'connected', connected: outcome === 'connected', code: 'SERVICE_ACTION_UNCONFIRMED' })
    assert.equal(await work, outcome === 'connected')
    assert.equal(f.state.busy, '')
    assert.equal(f.state.feedback.unity.type, outcome === 'connected' ? 'success' : 'error')
    if (outcome === 'refused') assert.match(f.state.feedback.unity.message, /宿主操作被拒绝/)
    if (outcome === 'timeout') assert.match(f.state.feedback.unity.message, /确认超时/)
    native.receive({ type: 'service_connection_result', requestId, success: true, connected: true })
    assert.equal(f.state.feedback.unity.type, outcome === 'connected' ? 'success' : 'error')
    native.bridge.dispose()
  }
})

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
  await assert.rejects(denied, error => error.code === 'SERVICE_ACTION_UNCONFIRMED')
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

test('native failure codes display only fixed local Chinese diagnostics, never host error text', async () => {
  const diagnostics = {
    BUSY: '已有服务操作正在执行',
    AUTH_REQUIRED: '当前后台会话已失效，请重新解锁后台',
    PERMISSION_DENIED: '当前账户没有此服务操作权限，请检查权限后重新检测',
    SESSION_CHECK_FAILED: '后台会话检测失败，请检查数据服务后重新检测',
    UNITY_PROCESS_UNAVAILABLE: '当前本机 Unity 进程不可用，请先启动大屏后重新检测',
    UNITY_TICKET_FAILED: 'Unity 会话票据未确认，请检查登录状态后重试',
    UNITY_PIPE_UNAVAILABLE: '无法连接当前 Unity 的本机通信通道，请检查大屏进程后重试',
    UNITY_HANDSHAKE_TIMEOUT: 'Unity 新实时通道握手超时，未确认重连成功，请重新检测',
    CENTER_VIEW_UNCONFIRMED: '运行中心尚未确认打开所选页面，请重试',
    DATA_HANDSHAKE_UNCONFIRMED: '当前大屏数据通道握手未确认，请重新检测',
    DESKTOP_CONTROL_UNCONFIRMED: '本机桌面控制通道未确认，请检查大屏运行状态',
    SERVICE_ACTION_UNCONFIRMED: '宿主操作被拒绝、已取消或未确认，请重新检测'
  }
  const f = bridgeFixture(), privateError = 'PRIVATE_HOST_ERROR Cookie=FIXTURE_COOKIE ticket=FIXTURE_TICKET'
  for (const [code, message] of Object.entries(diagnostics)) {
    const work = f.bridge.request('unity_reconnect')
    f.receive({ type: 'service_connection_result', requestId: f.sent.at(-1).requestId,
      success: false, code, error: privateError, message: privateError })
    await assert.rejects(work, error => {
      assert.equal(error.code, code)
      assert.equal(error.message, message)
      assert.doesNotMatch(error.stack, /PRIVATE_HOST_ERROR|FIXTURE_COOKIE|FIXTURE_TICKET/)
      return true
    })
    assert.equal(f.timers.size, 0)
  }
  f.bridge.dispose()
})

test('unknown or malformed native codes fall back to a sanitized message and code, including inherited object keys', async () => {
  const f = bridgeFixture()
  for (const code of [undefined, null, 123, {}, '__proto__', 'constructor', 'toString', 'PRIVATE_HOST_CODE']) {
    const work = f.bridge.request('unity_reconnect')
    f.receive({ type: 'service_connection_result', requestId: f.sent.at(-1).requestId,
      success: false, code, error: 'PRIVATE_HOST_ERROR', message: 'PRIVATE_HOST_MESSAGE' })
    await assert.rejects(work, error => {
      assert.equal(error.code, 'SERVICE_ACTION_UNCONFIRMED')
      assert.equal(error.message, '宿主操作被拒绝、已取消或未确认，请重新检测')
      assert.doesNotMatch(error.stack, /PRIVATE_HOST_ERROR|PRIVATE_HOST_MESSAGE|PRIVATE_HOST_CODE/)
      return true
    })
    assert.equal(f.timers.size, 0)
  }
  f.bridge.dispose()
})
