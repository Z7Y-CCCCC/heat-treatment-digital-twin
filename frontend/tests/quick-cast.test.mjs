import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { effectScope, ref, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { useQuickCast } from '../src/runtime/useQuickCast.js'
import { deferred, settle } from './helpers.mjs'

const device = { id: 'tv-one', name: '车间电视', address: '192.0.2.10' }
const payload = (patch = {}) => ({ success: true, devices: [device], cast: { ffmpegAvailable: true, casting: false }, ...patch })
function fixture(t, permitted = true) {
    const allowed = ref(permitted), identity = ref('owner'), calls = []
    const api = {
        getCastDevices: async () => { calls.push('read'); return payload() },
        refreshCastDevices: async () => { calls.push('search'); return payload() },
        startCast: async id => { calls.push(['start', id]); return payload({ cast: { ffmpegAvailable: true, casting: true, session: { deviceId: id, deviceName: device.name, state: 'waiting_for_tv' } } }) },
        stopCast: async () => { calls.push('stop'); return payload() }
    }
    const scope = effectScope()
    t.after(() => scope.stop())
    const view = scope.run(() => useQuickCast({ allowed, identity, api, intervalMs: 60000 }))
    return { ...view, allowed, identity, calls, api, scope }
}
test('picker reads only allowed accounts and cannot issue unauthorized commands', async t => {
    const view = fixture(t, false)
    await settle(); await view.search(); await view.stop()
    assert.deepEqual(view.calls, [])
    view.allowed.value = true
    await nextTick(); await settle()
    assert.equal(view.state.loaded, true)
})
test('selecting a TV requires explicit start; waiting for TV is not reported as playing', async t => {
    const view = fixture(t)
    await settle()
    view.selectedId.value = device.id
    assert.equal(view.state.casting, false)
    assert.equal(view.calls.length, 1)
    await view.start()
    assert.deepEqual(view.calls.at(-1), ['start', device.id])
    assert.equal(view.phase.value, '等待电视接收')
    assert.equal(view.selectedId.value, '')
    await view.stop()
    assert.equal(view.state.casting, false)
})
test('no-device entry discovers once and reports a compact empty result', async t => {
    const view = fixture(t)
    view.api.getCastDevices = async () => payload({ devices: [] })
    // Force a new account generation so the replacement applies to its initial read.
    view.identity.value = 'other'
    view.api.refreshCastDevices = async () => { view.calls.push('search'); return payload({ devices: [] }) }
    await nextTick(); await settle()
    assert.equal(view.calls.filter(call => call === 'search').length, 1)
    assert.deepEqual(view.state.devices, [])
})

test('remembered offline TV survives refresh and remains connectable by stable identity, not its old IP', async t => {
    const view = fixture(t)
    const remembered = { id: 'uuid:previous-tv', name: '车间电视', remembered: true, available: false, address: '' }
    view.api.getCastDevices = async () => payload({ devices: [remembered] })
    view.api.refreshCastDevices = async () => { view.calls.push('search'); return payload({ devices: [remembered] }) }
    view.identity.value = 'history-account'
    await nextTick(); await settle()
    assert.equal(view.calls.filter(call => call === 'search').length, 1)
    assert.equal(view.state.devices[0].remembered, true)
    view.selectedId.value = remembered.id
    assert.equal(view.selected.value.address, '')
    await view.start()
    assert.deepEqual(view.calls.at(-1), ['start', remembered.id])
})
test('duplicate start/stop/search commands coalesce and do not overwrite a pending operation', async t => {
    const view = fixture(t), pending = deferred()
    await settle()
    view.api.startCast = async () => { view.calls.push('start'); return pending.promise }
    view.selectedId.value = device.id
    const starting = view.start()
    await view.start(); await view.search(); await view.stop()
    assert.equal(view.calls.filter(call => call === 'start').length, 1)
    assert.equal(view.busy.value, 'start')
    pending.resolve(payload()); await starting
    assert.equal(view.busy.value, '')
})
test('late polling snapshots cannot erase the result of starting a cast', async t => {
    const view = fixture(t), pending = deferred()
    await settle()
    view.api.getCastDevices = () => pending.promise
    const reading = view.load()
    view.selectedId.value = device.id
    await view.start()
    pending.resolve(payload()); await reading
    assert.equal(view.state.casting, true)
})
test('switching accounts invalidates requests and never leaks previous target details', async t => {
    const view = fixture(t), pending = deferred()
    await settle()
    view.api.startCast = () => pending.promise
    view.selectedId.value = device.id
    const starting = view.start()
    view.allowed.value = false; view.identity.value = 'viewer'
    await nextTick()
    pending.resolve(payload({ cast: { casting: true, session: { deviceId: 'private' } } })); await starting
    assert.equal(view.state.session, null)
    assert.deepEqual(view.state.devices, [])
    assert.equal(view.busy.value, '')
})
test('closing picker stops polling, ignores late requests, but does not stop active television', async t => {
    const view = fixture(t), pending = deferred()
    await settle()
    view.api.getCastDevices = () => pending.promise
    const loading = view.load()
    view.scope.stop()
    pending.resolve(payload({ devices: [{ id: 'late' }] })); await loading
    assert.equal(view.state.devices[0].id, device.id)
    assert.equal(view.calls.includes('stop'), false)
})
test('start failure keeps last state and selection; encoder failure cannot initiate casting', async t => {
    const view = fixture(t)
    await settle()
    view.selectedId.value = device.id
    view.api.startCast = async () => ({ success: false, error: '电视离线' })
    await view.start()
    assert.equal(view.error.value, '电视离线')
    assert.equal(view.state.casting, false)
    assert.equal(view.selectedId.value, device.id)
    view.api.startCast = async () => ({ error: 'HTTP 连接失败' })
    await view.start()
    assert.equal(view.error.value, 'HTTP 连接失败')
    assert.equal(view.selectedId.value, device.id)
    view.state.encoderReady = false
    await view.start()
    assert.match(view.error.value, /编码器未就绪/)
})
test('connection interruption has a distinct state and retry targets the existing TV', async t => {
    const view = fixture(t)
    await settle()
    assert.equal(await view.retry(), false)
    view.api.getCastDevices = async () => payload({ cast: { casting: true, ffmpegAvailable: true, session: { deviceId: device.id, state: 'reconnect_failed' } } })
    await view.load()
    assert.equal(view.phase.value, '连接中断')
    await view.retry()
    assert.deepEqual(view.calls.at(-1), ['start', device.id])
    assert.equal(view.phase.value, '等待电视接收')
})
test('quick casting SFCs compile and use the same secured API, without admin navigation', async () => {
    for (const name of ['components/QuickCastPanel.vue', 'views/DashboardAccountDock.vue']) {
        const text = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')
        const { descriptor } = parse(text)
        compileScript(descriptor, { id: name })
        assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: name, id: name }).errors, [])
        assert.match(text, /canAdminApi\('\/api\/system\/cast', 'POST'\)/)
        if (name.includes('QuickCast')) assert.doesNotMatch(text, /router|openAdmin|window\.location/)
    }
    const css = await readFile(new URL('../src/runtime/purpleGlass.css', import.meta.url), 'utf8')
    assert.match(css, /\.account-dock \.group-account-menu\s*\{[\s\S]*?rgba\(45,39,64,\.98\)/)
    assert.match(css, /-webkit-backdrop-filter:[^;]+;backdrop-filter:/, 'standard property must survive production CSS alias minification')
    const admin = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
    assert.doesNotMatch(admin, /settings-data-workspace/, 'all system subpages retain the identical numbered-card navigation')
})
