import test from 'node:test'
import assert from 'node:assert/strict'
import { createDashboardDataStore } from '../src/runtime/DataStore.js'
import { deferred, installBrowser, installSockets, json, settle } from './helpers.mjs'

function fixture(t, options) {
    const { replace } = installBrowser(t)
    const sockets = installSockets(replace)
    t.mock.method(globalThis, 'fetch', async url => json(String(url).includes('/events') ? [] : {}))
    const store = createDashboardDataStore(options)
    t.after(() => store.dispose())
    return { store, sockets }
}

test('connect is idempotent and dispose detaches every socket callback', t => {
    const { store, sockets } = fixture(t)
    store.connect()
    store.connect()
    assert.equal(sockets.length, 1)
    sockets[0].open()
    assert.equal(store.wsConnected.value, true)
    store.dispose()
    assert.equal(store.wsConnected.value, false)
    for (const event of ['onopen', 'onmessage', 'onclose', 'onerror']) assert.equal(sockets[0][event], null)
    store.connect()
    assert.equal(sockets.length, 1)
})

test('scene projection is opt-in and does not add traffic for normal dashboards',t=>{
    const {store,sockets}=fixture(t,{sceneProjection:true})
    store.connect();sockets[0].open()
    assert.deepEqual(JSON.parse(sockets[0].sent[1]),{type:'scene_projection_subscribe',enabled:true})
    const ordinary=createDashboardDataStore()
    ordinary.connect();sockets[1].open()
    assert.equal(sockets[1].sent.length,1)
    ordinary.dispose()
})

test('new device frames replace selected data and offline devices leave live counts', async t => {
    const { store, sockets } = fixture(t)
    store.registerDevice({ id: 'A', name: 'A' })
    store.selectDevice('A')
    store.connect()
    sockets[0].emit('device_data', { furnace_id: 'A', status: { running: true, alarm: true }, oldField: 7 })
    sockets[0].emit('device_data', { furnace_id: 'A', status: { running: true, alarm: true } })
    assert.equal('oldField' in store.selectedDeviceData, false)
    assert.equal(store.metrics.running_devices, 1)
    sockets[0].emit('plc_status', { devices: [{ deviceId: 'A', status: 'offline' }] })
    assert.equal(store.metrics.online_devices, 0)
    assert.equal(store.metrics.running_devices, 0)
    assert.equal(store.metrics.alarm_devices, 0)
    await settle()
})

test('a superseded events response cannot overwrite the current filter', async t => {
    const { store } = fixture(t)
    const first = deferred(), second = deferred()
    let calls = 0
    t.mock.method(globalThis, 'fetch', () => (++calls === 1 ? first.promise : second.promise))
    const oldRequest = store.refreshEvents(true)
    store.setEventQueryOptions({ eventType: 'alarm' })
    const currentRequest = store.refreshEvents(true)
    second.resolve(json([{ id: 'new', title: 'current filter' }]))
    await currentRequest
    first.resolve(json([{ id: 'old', title: 'old filter' }]))
    await oldRequest
    assert.equal(store.events.value[0].id, 'new')
})

test('dispose aborts pending reads and suppresses late response mutation', async t => {
    const { store } = fixture(t)
    const response = deferred()
    let signal
    t.mock.method(globalThis, 'fetch', (_url, options) => { signal = options.signal; return response.promise })
    const request = store.refreshEvents(true)
    store.dispose()
    assert.equal(signal.aborted, true)
    response.resolve(json([{ id: 'late', title: 'should not display' }]))
    await request
    assert.equal(store.events.value[0].id, 'boot')
})

test('trend averages exclude missing values and bad-quality samples', async t => {
    const { store, sockets } = fixture(t)
    store.connect()
    sockets[0].emit('realtime_frame', { devices: [
        { furnace_id: 'A', analog: { actual_temp: 600 } },
        { furnace_id: 'B', analog: { actual_temp: null } },
        { furnace_id: 'C', analog: { actual_temp: ' ' } },
        { furnace_id: 'D', analog: { actual_temp: 100 }, quality: { analog: { actual_temp: 'bad' } } }
    ] })
    assert.equal(store.trendPoints.value[0].value, 600)
    await settle()
})

test('live metrics resume after startup has no realtime data', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1700000000000 })
    const { store, sockets } = fixture(t)
    t.mock.method(globalThis, 'fetch', async url => {
        if (String(url).includes('/metrics')) return json({ current_output: 42, overall_oee: 83 })
        if (String(url).includes('/events')) return json([])
        return json({ readiness: { displayReady: true }, engine: { mode: 'simulation' } })
    })
    store.registerDevice({ id: 'A', name: 'A' })
    await store.refreshMetrics(true)
    assert.equal(store.metrics.current_output, 0)
    store.connect()
    sockets[0].emit('device_data', { furnace_id: 'A', status: { running: true } })
    t.mock.timers.tick(5000)
    await settle()
    assert.equal(store.metrics.current_output, 42)
    assert.equal(store.plcStatusText.value, '模拟数据正常')
})

test('forced health refreshes coalesce while one request is outstanding', async t => {
    const { store } = fixture(t)
    const pending = deferred()
    const fetch = t.mock.method(globalThis, 'fetch', () => pending.promise)
    const first = store.refreshHealth(true)
    await store.refreshHealth(true)
    assert.equal(fetch.mock.callCount(), 1)
    pending.resolve(json({ status: 'ok' }))
    await first
})

test('explicit UTC event times render in the user time zone without reinterpreting local SQL text', async t => {
    const previousTimeZone = process.env.TZ
    process.env.TZ = 'Asia/Hong_Kong'
    t.after(() => {
        if (previousTimeZone === undefined) delete process.env.TZ
        else process.env.TZ = previousTimeZone
    })
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-10T23:03:42.000Z') })
    const { store } = fixture(t)
    t.mock.method(globalThis, 'fetch', async () => json([
        { id: 'utc', title: 'UTC event', occurred_at: '2026-09-10T23:03:41.000Z' },
        { id: 'offset', title: 'Offset event', occurred_at: '2026-09-11T07:03:41+08:00' },
        { id: 'local', title: 'Local SQL event', occurred_at: '2026-09-11 07:03:41' },
        { id: 'prior-day', title: 'Prior day UTC event', occurred_at: '2026-09-09T23:03:41.000Z' }
    ]))
    await store.refreshEvents(true)
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Hong_Kong')
    assert.equal(new Date().getHours(), 7)
    const expectedTime = new Date(2026, 8, 11, 7, 3, 41).toLocaleTimeString()
    for (const id of ['utc', 'offset', 'local']) {
        assert.equal(store.events.value.find(event => event.id === id).time, expectedTime)
    }
    assert.equal(store.events.value.find(event => event.id === 'prior-day').time, `09-10 ${expectedTime}`)
})
