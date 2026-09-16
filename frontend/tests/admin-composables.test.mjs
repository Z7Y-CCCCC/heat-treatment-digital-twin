import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { adminApi } from '../src/config/factoryConfig.js'
import { useSystemSettings } from '../src/views/admin/composables/useSystemSettings.js'
import { useDataPoints } from '../src/views/admin/composables/useDataPoints.js'
import { usePointMonitor } from '../src/views/admin/composables/usePointMonitor.js'
import { useCastDevices } from '../src/views/admin/composables/useCastDevices.js'
import { summarizeDeviceConnections } from '../src/views/admin/utils/connectionStatus.js'
import { deferred, installBrowser } from './helpers.mjs'

const runtimePayload = (patch = {}) => ({
    auto_start_enabled: true, auto_start_supported: true, packaged: false,
    lan_display_enabled: false, lan_display_port: 8787, lan_display_pin: 'old-pin',
    lan_display: { clients: 1, urls: [], pairingUrls: [] }, ...patch
})

test('simulation status is labelled separately from physical PLC connections', () => {
    const summary = summarizeDeviceConnections({
        mode: 'simulation', plcStatus: { status: 'simulating', message: '模拟运行中 (20 台设备)' }, collectorStatus: { devices: 20 }
    })
    assert.equal(summary.label, '模拟运行 · 20 台设备')
    assert.equal(summary.tone, 'is-online')
    assert.equal(summary.online, 20)
    const stopped = summarizeDeviceConnections({ mode: 'simulation', plcStatus: { status: 'stopped' } })
    assert.equal(stopped.label, '模拟已停止')
    assert.equal(stopped.online, 0)
})

function scoped(t, factory) {
    installBrowser(t)
    const scope = effectScope()
    t.after(() => scope.stop())
    return scope.run(factory)
}

function settingsFixture(t) {
    return scoped(t, () => useSystemSettings({ alert: async () => {}, confirm: async () => true }))
}

test('runtime polling refreshes status without clobbering unsaved settings', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getRuntimeSettings', async () => runtimePayload())
    await settings.loadRuntimeSettings()
    settings.runtimeSettings.lan_display_port = 9991
    settings.runtimeSettings.lan_display_pin = 'draft-pin'
    settings.runtimeSettings.lan_display_enabled = true
    t.mock.method(adminApi, 'getRuntimeSettings', async () => runtimePayload({
        auto_start_enabled: false, lan_display: { clients: 4, urls: [], pairingUrls: [] }
    }))
    await settings.loadRuntimeSettings({ silent: true })
    assert.equal(settings.runtimeSettings.lan_display_port, 9991)
    assert.equal(settings.runtimeSettings.lan_display_pin, 'draft-pin')
    assert.equal(settings.runtimeSettings.lan_display_enabled, true)
    assert.equal(settings.runtimeSettings.auto_start_enabled, false)
    assert.equal(settings.runtimeStatus.clients, 4)
})

test('an older runtime poll cannot roll back a successful save', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getRuntimeSettings', async () => runtimePayload())
    await settings.loadRuntimeSettings()
    const old = deferred()
    t.mock.method(adminApi, 'getRuntimeSettings', () => old.promise)
    const poll = settings.loadRuntimeSettings({ silent: true })
    settings.runtimeSettings.lan_display_port = 9991
    t.mock.method(adminApi, 'saveRuntimeSettings', async () => runtimePayload({ lan_display_port: 9991 }))
    await settings.saveRuntimeSettings()
    old.resolve(runtimePayload())
    await poll
    assert.equal(settings.runtimeSettings.lan_display_port, 9991)
})

test('editing during a save keeps the newer draft', async t => {
    const settings = settingsFixture(t)
    const response = deferred()
    t.mock.method(adminApi, 'saveRuntimeSettings', () => response.promise)
    settings.runtimeSettings.lan_display_port = 9991
    const save = settings.saveRuntimeSettings()
    settings.runtimeSettings.lan_display_port = 9992
    response.resolve(runtimePayload({ lan_display_port: 9991 }))
    await save
    assert.equal(settings.runtimeSettings.lan_display_port, 9992)
})

function pointsFixture(t) {
    const messages = []
    const points = scoped(t, () => useDataPoints({
        devices: ref([{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }]),
        alert: async message => { messages.push(message) }, confirm: async () => true,
        storedAdminUiState: { selectedDeviceForPoints: 'A' },
        loadEngineStatus: async () => {}, selectedDeviceForMonitor: ref('all'), loadRealtimePointValues: async () => {}
    }))
    return { points, messages }
}

test('blank PLC DB fields stay blank instead of turning into DB0.DBW0', t => {
    const { points } = pointsFixture(t)
    assert.equal(points.composePlcAddressFromParts({ db_number: null, db_byte_offset: null, data_type: 'WORD' }), '')
    assert.equal(points.composePlcAddressFromParts({ db_number: '', db_byte_offset: 0, data_type: 'WORD' }), '')
    assert.equal(points.normalizeLoadedPoint({ name: 'new', db_number: null, db_byte_offset: null }).plc_tag, '')
    assert.equal(points.composePlcAddressFromParts({ db_number: 0, db_byte_offset: 0, data_type: 'WORD' }), 'DB0.DBW0')
})

test('point loads cannot cross device selection boundaries', async t => {
    const { points } = pointsFixture(t)
    const a = deferred(), b = deferred()
    t.mock.method(adminApi, 'getDataPoints', id => id === 'A' ? a.promise : b.promise)
    const first = points.loadDataPoints()
    points.selectedDeviceForPoints.value = 'B'
    const second = points.loadDataPoints()
    b.resolve([{ id: 2, name: 'B-point', device_id: 'B' }])
    await second
    a.resolve([{ id: 1, name: 'A-point', device_id: 'A' }])
    await first
    assert.equal(points.dataPoints.value[0].name, 'B-point')
    assert.deepEqual(points.loadedPointDeviceIds.value, ['B'])
})

test('copied point rows belong to the target device and discard source ids', async t => {
    const { points } = pointsFixture(t)
    t.mock.method(adminApi, 'getDataPoints', async () => [{ id: 5, name: 'temperature', device_id: 'B' }])
    await points.copyPointsFrom('B')
    assert.equal(points.dataPoints.value[0].device_id, 'A')
    assert.equal(points.dataPoints.value[0].__originalDeviceId, 'A')
    assert.equal(points.dataPoints.value[0].id, undefined)
    assert.equal(points.isPointsDirty.value, true)
})

test('point API errors are reported without replacing a valid draft', async t => {
    const { points, messages } = pointsFixture(t)
    points.dataPoints.value = [{ name: 'draft' }]
    t.mock.method(adminApi, 'getDataPoints', async () => ({ error: 'session expired' }))
    await points.loadDataPoints()
    assert.equal(points.dataPoints.value[0].name, 'draft')
    assert.deepEqual(messages, ['session expired'])
})

test('failed device switches restore the original selection instead of targeting old rows at a new PLC', async t => {
    const { points } = pointsFixture(t)
    t.mock.method(adminApi, 'getDataPoints', async id => id === 'A'
        ? [{ id: 1, device_id: 'A', name: 'source' }] : { error: 'unavailable' })
    await points.loadDataPoints()
    points.selectedDeviceForPoints.value = 'B'
    await points.loadDataPoints()
    assert.equal(points.selectedDeviceForPoints.value, 'A')
    assert.equal(points.dataPoints.value[0].device_id, 'A')
})

test('an initial failed point read cannot be saved as an empty replacement', async t => {
    const { points, messages } = pointsFixture(t)
    const save = t.mock.method(adminApi, 'syncDataPoints', async () => ({ success: true }))
    await points.saveAllPoints()
    assert.equal(save.mock.callCount(), 0)
    assert.match(messages[0], /先成功读取/)
})

test('point saves coalesce and preserve edits made while the save is pending', async t => {
    const { points } = pointsFixture(t)
    t.mock.method(adminApi, 'getDataPoints', async () => [{
        id: 1, device_id: 'A', name: 'temperature', label: 'Temperature', plc_tag: 'DB1.DBW0', data_type: 'WORD',
        sample_interval_ms: 1000, access_type: 'READ'
    }])
    await points.loadDataPoints()
    points.isPointsDirty.value = true
    const response = deferred()
    const save = t.mock.method(adminApi, 'syncDataPoints', () => response.promise)
    const first = points.saveAllPoints()
    await points.saveAllPoints()
    assert.equal(save.mock.callCount(), 1)
    points.dataPoints.value[0].label = 'New draft while saving'
    response.resolve({ success: true, updated: 1, total: 1 })
    await first
    assert.equal(points.dataPoints.value[0].label, 'New draft while saving')
    assert.equal(points.isPointsDirty.value, true)
    assert.equal(points.pointsSaving.value, false)
})

test('stopping a point monitor invalidates an outstanding response', async t => {
    const monitor = scoped(t, () => usePointMonitor({ devices: ref([{ id: 'A' }]), storedAdminUiState: {} }))
    const response = deferred()
    t.mock.method(adminApi, 'getRealtimePointValues', () => response.promise)
    const request = monitor.loadRealtimePointValues()
    monitor.stopPointMonitor()
    response.resolve({ points: [{ id: 'late', device_id: 'A' }] })
    await request
    assert.equal(monitor.realtimePointRows.value.length, 0)
    assert.equal(monitor.realtimePointLoading.value, false)
})

test('an older point-monitor error cannot clear the newer loading state', async t => {
    const monitor = scoped(t, () => usePointMonitor({ devices: ref([{ id: 'A' }]), storedAdminUiState: {} }))
    const first = deferred(), second = deferred()
    let calls = 0
    t.mock.method(adminApi, 'getRealtimePointValues', () => (++calls === 1 ? first.promise : second.promise))
    const oldRequest = monitor.loadRealtimePointValues()
    const currentRequest = monitor.loadRealtimePointValues()
    first.reject(new Error('obsolete failure'))
    await oldRequest
    assert.equal(monitor.realtimePointLoading.value, true)
    assert.equal(monitor.realtimePointError.value, '')
    second.resolve({ points: [] })
    await currentRequest
    assert.equal(monitor.realtimePointLoading.value, false)
})

test('cast command HTTP failures are shown as failures, never success', async t => {
    const cast = scoped(t, () => useCastDevices({ confirm: async () => true }))
    t.mock.method(adminApi, 'stopCast', async () => ({ error: 'permission denied' }))
    await cast.stopCast()
    assert.match(cast.castMessage.value, /停止投屏失败.*permission denied/)
    assert.equal(cast.castState.loaded, false)
})
