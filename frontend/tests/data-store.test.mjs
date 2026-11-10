import test from 'node:test'
import assert from 'node:assert/strict'
import { computed } from 'vue'
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

test('realtime batches aggregate once while retaining every same-device transition in source order', t => {
    const { store, sockets } = fixture(t)
    let scans = 0
    const values = Object.values
    t.mock.method(Object, 'values', object => {
        if (object === store.deviceStatusMap) scans++
        return values(object)
    })
    const devices = Array.from({ length: 100 }, (_, index) => ({ id: `D${index}`, name: `设备 ${index}` }))
    store.syncDevices(devices)
    assert.equal(scans, 1, 'configuration bootstrap must not scan the entire station per registered device')
    const received = []
    store.setDeviceDataHandler(data => received.push([data.furnace_id, data.analog?.actual_temp]))
    store.connect(); received.length = 0; scans = 0
    const telemetry = devices.map((device, index) => ({ furnace_id: device.id, timestamp: 100000,
        analog: { actual_temp: index }, status: { running: index % 2 === 0, alarm: index % 10 === 0 },
        quality: { analog: { actual_temp: 'good' } } }))
    const batch = [telemetry[0], { ...telemetry[0], analog: { actual_temp: 1 } }, ...telemetry.slice(1)]
    sockets[0].emit('realtime_frame', { devices: batch })
    assert.equal(scans, 1, '101 telemetry records still require one aggregate, not 102 full-station scans')
    assert.deepEqual(received, batch.map(data => [data.furnace_id, data.analog.actual_temp]))
    assert.equal(store.deviceDataMap.D0.analog.actual_temp, 1)
    assert.equal(store.metrics.total_devices, 100)
    assert.equal(store.metrics.online_devices, 100)
    assert.equal(store.metrics.running_devices, 50)
    assert.equal(store.metrics.alarm_devices, 10)
    scans = 0
    sockets[0].emit('device_data', { ...telemetry[0], status: { running: false, alarm: false } })
    assert.equal(scans, 1, 'standalone telemetry must still update metrics immediately')
    assert.equal(store.metrics.running_devices, 49); assert.equal(store.metrics.alarm_devices, 9)
})

test('motion-only updates notify every transition without replacing or rescanning unrelated telemetry', t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100000 })
    const { store, sockets } = fixture(t)
    store.syncDevices([{ id: 'A', name: '设备 A' }]); store.selectDevice('A')
    const received = [], motions = []
    store.setDeviceDataHandler(data => { received.push(data); Object.freeze(data) })
    store.setMotionInputHandler(data => motions.push(data)); store.connect()
    sockets[0].emit('realtime_frame', { devices: [{ furnace_id: 'A', timestamp: 99000,
        analog: { actual_temp: 700 }, status: { running: true }, quality: { analog: { actual_temp: 'good' } } }] })
    const snapshot = store.deviceDataMap.A, status = store.deviceStatusMap.A, original = received.at(-1)
    let reads = 0, scans = 0
    const point = computed(() => { reads++; return `${store.deviceDataMap.A.analog.actual_temp}:${store.deviceDataMap.A.timestamp}` })
    assert.equal(point.value, '700:99000')
    const values = Object.values
    t.mock.method(Object, 'values', object => { if (object === store.deviceStatusMap) scans++; return values(object) })
    const updates = [0, 1, 0].map(value => ({ furnace_id: 'A', timestamp: 100000, motionInputOnly: true,
        motionInputs: { lift: { value, quality: 'good', timestamp: 98500 } } }))
    sockets[0].emit('realtime_frame', { devices: updates.slice(0, 2) })
    sockets[0].emit('device_data', updates[2])
    assert.equal(store.deviceDataMap.A, snapshot)
    assert.equal(store.deviceStatusMap.A, status)
    assert.equal(point.value, '700:99000'); assert.equal(reads, 1)
    assert.equal(scans, 0, 'a motion-only publication is not new telemetry or a metrics refresh trigger')
    assert.deepEqual(motions.map(data => data.motionInputs.lift.value), [0, 1, 0])
    assert.equal(motions.at(-1).motionInputs.lift.timestamp, 98500)
    assert.equal(store.latestDeviceDataMap.get('A').timestamp, 99000)
    assert.equal(store.selectedDeviceData.motionInputs.lift.value, 0)
    assert.equal(store.selectedDeviceData.timestamp, 99000)
    assert.equal(status.lastSeen, 100000)
    assert.equal(original.motionInputs, undefined, 'received telemetry may be frozen; motion must not mutate it')
})

test('motion-only data table frames neither invent PLC health nor erase live telemetry', t => {
    const { store, sockets } = fixture(t)
    store.syncDevices([{ id: 'A', name: '设备A' }]); store.selectDevice('A')
    const regular = [], inputs = []
    store.setDeviceDataHandler(data => regular.push(data)); store.setMotionInputHandler(data => inputs.push(data)); store.connect()
    regular.length = 0
    const motion = { furnace_id: 'A', timestamp: 2000, motionInputOnly: true, motionInputs: { lift: { value: 8, quality: 'good', timestamp: 2000 } } }
    sockets[0].emit('realtime_frame', { devices: [motion] })
    assert.equal(store.deviceStatusMap.A.online, false); assert.equal(store.deviceDataMap.A, undefined)
    assert.equal(regular.length, 0); assert.equal(inputs.length, 1)
    const telemetry = { furnace_id: 'A', timestamp: 1000, analog: { actual_temp: 700 }, quality: { analog: { actual_temp: 'good' } }, status: { running: true } }
    sockets[0].emit('realtime_frame', { devices: [telemetry] })
    const lastSeen = store.deviceStatusMap.A.lastSeen
    sockets[0].emit('realtime_frame', { devices: [motion] })
    assert.equal(store.selectedDeviceData.analog.actual_temp, 700)
    assert.equal(store.selectedDeviceData.timestamp, 1000)
    assert.equal(store.deviceStatusMap.A.lastSeen, lastSeen)
    assert.equal(regular.length, 1); assert.equal(inputs.length, 2)
    const replay = []; store.setMotionInputHandler(data => replay.push(data))
    assert.equal(replay[0].motionInputOnly, true); assert.ok(replay[0].timestamp >= 2000)
    store.syncDevices([]); store.setMotionInputHandler(data => replay.push(data)); assert.equal(replay.length, 1)
})

test('independent motion publications cannot prevent a stopped PLC from becoming stale', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    const { store, sockets } = fixture(t, { staleMs: 2000 })
    store.connect(); sockets[0].open()
    sockets[0].emit('realtime_frame', { devices: [{ furnace_id: 'A', timestamp: Date.now(), analog: { actual_temp: 700 }, quality: { analog: { actual_temp: 'good' } } }] })
    for (let i = 0; i < 6; i++) {
        t.mock.timers.tick(1000)
        sockets[0].emit('realtime_frame', { devices: [{ furnace_id: 'A', timestamp: Date.now(), motionInputOnly: true, motionInputs: {} }] })
    }
    assert.equal(store.deviceStatusMap.A.quality, 'bad')
    assert.equal(store.deviceStatusMap.A.online, false)
    assert.equal(store.selectedDeviceData.timestamp, undefined)
    assert.equal(store.deviceDataMap.A.analog.actual_temp, 700)
})

test('replaying a cached motion source keeps its read stamp and includes elapsed cache age', t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 })
    const { store, sockets } = fixture(t)
    store.connect(); sockets[0].open()
    sockets[0].emit('realtime_frame', { devices: [{ furnace_id: 'A', timestamp: 100000, motionInputOnly: true,
        motionInputs: { lift: { dataItemId: 'source', value: 1, quality: 'good', timestamp: 99000, staleMs: 5000 } } }] })
    t.mock.timers.tick(6000)
    const replay = []; store.setMotionInputHandler(data => replay.push(data))
    assert.equal(replay[0].timestamp, 106000)
    assert.equal(replay[0].motionInputs.lift.timestamp, 99000)
    assert.equal(replay[0].motionInputOnly, true)
})

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

test('reconnect requests authoritative resync once and stale sockets cannot trigger it', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const { store, sockets } = fixture(t, { sceneProjection: true })
    const messages = []
    store.setMessageHandler(message => messages.push(message))
    store.connect(); sockets[0].open()
    assert.equal(messages.length, 0)
    sockets[0].close()
    t.mock.timers.tick(5000)
    sockets[1].open()
    assert.deepEqual(messages, [{ type: 'realtime_resync_required', payload: { reason: 'websocket_reconnect' } }])
    assert.deepEqual(sockets[1].sent.map(value => JSON.parse(value).type), ['client_hello', 'scene_projection_subscribe'])
    sockets[0].open()
    assert.equal(messages.length, 1)
})

test('an unfinished websocket upgrade times out and reconnects without keeping stale callbacks', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const { store, sockets } = fixture(t)
    store.connect()
    t.mock.timers.tick(15000)
    assert.equal(sockets[0].readyState, 3)
    assert.equal(sockets[0].onclose, null)
    t.mock.timers.tick(5000)
    assert.equal(sockets.length, 2)
    sockets[1].open()
    t.mock.timers.tick(15000)
    assert.equal(sockets.length, 2)
    assert.equal(store.wsConnected.value, true)
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

test('authoritative device reload removes retired devices and rejects their late frames', async t => {
    const { store, sockets } = fixture(t)
    store.connect()
    sockets[0].emit('device_data', { furnace_id: 'old', status: { running: true } })
    store.selectDevice('old')
    store.syncDevices([{ id: 'current', name: 'Current device' }])
    sockets[0].emit('device_data', { furnace_id: 'old', status: { running: true } })
    sockets[0].emit('plc_status', { devices: [{ deviceId: 'old', status: 'connected' }] })
    assert.deepEqual(Object.keys(store.deviceStatusMap), ['current'])
    assert.equal(store.latestDeviceDataMap.has('old'), false)
    assert.equal('old' in store.deviceDataMap, false)
    assert.equal(store.selectedDeviceId.value, null)
    assert.deepEqual(Object.keys(store.selectedDeviceData), [])
    assert.equal(store.metrics.total_devices, 1)
    await settle()
})

test('repeated configuration synchronization preserves current data and bounds device state', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1700000000000 })
    const { store, sockets } = fixture(t)
    store.connect()
    const updates = []
    store.setDeviceDataHandler(data => updates.push(data))
    for (let index = 0; index < 200; index++) {
        const id = `device-${index}`
        store.syncDevices([{ id, name: id }])
        sockets[0].emit('device_data', { furnace_id: id, furnace_name: id, analog: { actual_temp: 612 }, status: { running: true } })
    }
    store.syncDevices([{ id: 'device-199', name: 'Renamed' }])
    assert.equal(store.deviceStatusMap['device-199'].running, true)
    assert.equal(store.deviceStatusMap['device-199'].name, 'Renamed')
    assert.equal(store.latestDeviceDataMap.size, 1)
    assert.equal(Object.keys(store.deviceDataMap).length, 1)
    store.syncDevices([])
    const lastUpdateCount = updates.length
    t.mock.timers.tick(20000)
    assert.equal(updates.length, lastUpdateCount)
    assert.equal(store.metrics.total_devices, 0)
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

test('event formatting preserves actual record ownership for current-device alarm filtering', async t => {
    const { store } = fixture(t)
    const rows = [
        { id: 'a', title: 'A炉警告', level: 'warning', source_id: 'A', factory_id: 'factory-a', event_type: 'alarm', quality: 'good', occurred_at: '2026-11-09T05:00:00.000Z' },
        { id: 'b', title: 'B炉报警', level: 'critical', device_id: 'B', factory_id: 'factory-a', occurred_at: '2026-11-09T05:01:00.000Z' },
        { id: 'camel', title: 'A炉事件', sourceId: 'A', factoryId: 'factory-a' }
    ]
    t.mock.method(globalThis, 'fetch', async () => json(rows))
    await store.refreshEvents(true)
    assert.equal(store.events.value[0].source_id, 'A')
    assert.equal(store.events.value[0].factory_id, 'factory-a')
    assert.equal(store.events.value[0].event_type, 'alarm')
    assert.equal(store.events.value[0].quality, 'good')
    assert.equal(store.events.value[1].device_id, 'B')
    assert.equal(store.events.value[2].sourceId, 'A')
    assert.equal(store.events.value[2].factoryId, 'factory-a')
    const active = store.events.value.filter(row => String(row.source_id || row.sourceId || row.device_id || row.deviceId) === 'A')
    assert.deepEqual(active.map(row => row.id), ['a', 'camel'])
    assert.equal(active[0].msg, 'A炉警告')
    assert.equal(active[0].occurred_at, rows[0].occurred_at)
})

test('empty event notices remain marked as presentation placeholders, not actual event records', async t => {
    const { store } = fixture(t)
    assert.equal(store.events.value[0].placeholder, true)
    await store.refreshEvents(true)
    assert.equal(store.events.value[0].id, 'empty')
    assert.equal(store.events.value[0].placeholder, true)
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
