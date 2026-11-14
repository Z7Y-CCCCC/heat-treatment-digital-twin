import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRenderer, h, reactive } from 'vue'
import { parse, compileScript } from 'vue/compiler-sfc'
import { routerKey, routeLocationKey } from 'vue-router'
import { deferred, installBrowser, settle } from './helpers.mjs'

const session = reactive({ ready: true, authenticated: true, displayAuthenticated: true, serviceUnavailable: false,
  accountSlotId: 'main', user: { id: 'owner' }, permissions: { view: true, launch: true }, sessionRevision: 0 })
let reconnect = async () => ({ success: true, channels: 1 })
test.mock.module('../src/runtime/adminSession.js', { namedExports: { adminSession: session,
  issueNativeSessionTicket: async () => 'owned-ticket', logoutCurrentAdminAccount: async () => {},
  refreshAdminSession: async () => {}, startAdminSessionTracking() {}, stopAdminSessionTracking() {} } })
test.mock.module('../src/runtime/DataStore.js', { namedExports: { reconnectActiveDashboardChannels: options => reconnect(options) } })
const file = new URL('../src/RootApp.vue', import.meta.url), { descriptor } = parse(await readFile(file, 'utf8'))
let source = compileScript(descriptor, { id: 'root-service-channel' }).content
for (const match of [...source.matchAll(/from\s+(['"])([^'"]+)\1/g)]) source = source.replace(match[0],
  `from ${JSON.stringify(match[2].endsWith('.vue') ? 'data:text/javascript,export default {}' : match[2].startsWith('.') ? new URL(match[2], file).href : import.meta.resolve(match[2]))}`)
const { default: Root } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`); Root.render = () => null
async function fixture(t, operation, path = '/overlay', surface = 'overlay') {
  const environment = installBrowser(t), messages = [], handlers = new Set(), calls = []
  document.documentElement = { style: { backgroundColor: '' } }; document.body = { style: { backgroundColor: '' } }
  environment.replace('innerWidth', 1280); environment.replace('innerHeight', 800)
  window.chrome = { webview: { postMessage: value => messages.push(value),
    addEventListener: (name, handler) => { assert.equal(name, 'message'); handlers.add(handler) },
    removeEventListener: (name, handler) => { assert.equal(name, 'message'); handlers.delete(handler) } } }
  Object.assign(session, { ready: true, authenticated: true, displayAuthenticated: true, serviceUnavailable: false,
    accountSlotId: 'main', user: { id: 'owner' }, permissions: { view: true, launch: true }, sessionRevision: 0 })
  reconnect = options => { calls.push(options); return operation(options) }
  const route = reactive({ path, fullPath: path + '?embedded=unity&surface=' + surface, query: { embedded: 'unity', surface } })
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null, patchProp() {}, insert() {}, remove() {} })
  const app = renderer.createApp({ render: () => h(Root) })
  app.provide(routerKey, { replace() {} }); app.provide(routeLocationKey, route); app.mount({})
  environment.beforeRestore(() => app.unmount())
  await settle()
  return { app, route, messages, handlers, calls, emit: value => Promise.all([...handlers].map(handler => handler({ data: value }))) }
}
const request = requestId => ({ type: 'service_channel_reconnect', requestId })
const results = f => f.messages.filter(value => value.type === 'service_channel_reconnect_result')

test('only the native overlay route accepts bounded correlated reconnect messages', async t => {
  const f = await fixture(t, async () => ({ success: true, channels: 2 }))
  await f.emit({ type: 'unrelated', requestId: 'safe' }); await f.emit(request('bad id')); await f.emit(request('x'.repeat(81)))
  assert.equal(f.calls.length, 0)
  await f.emit(request('owned_1'))
  assert.deepEqual(f.calls, [{ timeoutMs: 20000 }])
  assert.deepEqual(results(f), [{ type: 'service_channel_reconnect_result', requestId: 'owned_1', success: true, channels: 2 }])
  f.route.path = '/group'; await f.emit(request('not_overlay')); assert.equal(f.calls.length, 1)
  f.route.path = '/overlay'; f.route.query.surface = 'admin'; await f.emit(request('not_surface')); assert.equal(f.calls.length, 1)
})

test('busy returns an explicit refusal for a second request while the first handshake remains pending', async t => {
  const handshake = deferred(), f = await fixture(t, () => handshake.promise)
  const first = f.emit(request('first'))
  await f.emit(request('second'))
  assert.equal(f.calls.length, 1)
  assert.deepEqual(results(f), [{ type: 'service_channel_reconnect_result', requestId: 'second', success: false, code: 'BUSY' }])
  handshake.resolve({ success: true, channels: 1 }); await first
  assert.equal(results(f).at(-1).requestId, 'first'); assert.equal(results(f).at(-1).success, true)
})

test('timeout or channel failure reports a correlated failure and releases the busy guard', async t => {
  let failed = true
  const f = await fixture(t, async () => { if (failed) throw new Error('private channel error'); return { channels: 1 } })
  await f.emit(request('failed'))
  assert.deepEqual(results(f), [{ type: 'service_channel_reconnect_result', requestId: 'failed', success: false }])
  assert.doesNotMatch(JSON.stringify(results(f)), /private channel/)
  failed = false; await f.emit(request('retry'))
  assert.equal(f.calls.length, 2); assert.equal(results(f).at(-1).success, true)
})

test('an anonymous or view-restricted overlay does not start a service reconnect', async t => {
  const f = await fixture(t, async () => ({ channels: 1 }))
  session.permissions = { view: false, launch: true }
  await f.emit(request('restricted'))
  session.permissions = { view: true, launch: true }; session.displayAuthenticated = false
  await f.emit(request('anonymous'))
  assert.equal(f.calls.length, 0)
  assert.deepEqual(results(f), [])
})

test('route switch, logout and unmount suppress late handshake success', async t => {
  const first = deferred(), f = await fixture(t, () => first.promise)
  const pending = f.emit(request('route_late')); f.route.path = '/group'
  first.resolve({ channels: 1 }); await pending
  assert.equal(results(f).some(value => value.success), false)
  const second = deferred(); reconnect = () => second.promise; f.route.path = '/overlay'
  const logout = f.emit(request('logout_late')); session.displayAuthenticated = false
  second.resolve({ channels: 1 }); await logout
  assert.equal(results(f).some(value => value.success), false)
  session.displayAuthenticated = true
  const third = deferred(); reconnect = () => third.promise
  const closed = f.emit(request('closed_late')); f.app.unmount()
  assert.equal(f.handlers.size, 0)
  third.resolve({ channels: 1 }); await closed
  assert.equal(results(f).some(value => value.success), false)
})
