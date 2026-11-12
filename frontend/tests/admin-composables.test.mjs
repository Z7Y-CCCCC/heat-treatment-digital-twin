import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, ref } from 'vue'
import { adminSession } from '../src/runtime/adminSession.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { adminApi } from '../src/config/factoryConfig.js'
import { useSystemSettings } from '../src/views/admin/composables/useSystemSettings.js'
import { useDataPoints } from '../src/views/admin/composables/useDataPoints.js'
import { usePointMonitor } from '../src/views/admin/composables/usePointMonitor.js'
import { useCastDevices } from '../src/views/admin/composables/useCastDevices.js'
import { summarizeDeviceConnections } from '../src/views/admin/utils/connectionStatus.js'
import { deferred, installBrowser, settle } from './helpers.mjs'

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
    const previousSession = { ...adminSession }
    Object.assign(adminSession, { authenticated: true, user: { id: 'owner', role: 'owner' }, pagePermissions: normalizePagePermissions(undefined, { owner: true }) })
    t.after(() => Object.assign(adminSession, previousSession))
    const scope = effectScope()
    t.after(() => scope.stop())
    return scope.run(factory)
}

function settingsFixture(t) {
    return scoped(t, () => useSystemSettings({ alert: async () => {}, confirm: async () => true }))
}

test('collector isolation status is separate from API connection state', t => {
    const settings = settingsFixture(t)
    assert.equal(settings.formatEngineMode('integrated_plc'), '独立进程低延迟采集')
    assert.equal(settings.formatCollectorProcessStatus('running'), '运行中')
    assert.equal(settings.formatCollectorProcessStatus('recovering'), '自动恢复中')
    assert.equal(settings.formatCollectorProcessStatus('unresponsive'), '无响应')
})

test('database backup errors preserve the known list and never report a successful mutation', async t => {
    const settings = settingsFixture(t)
    settings.databaseBackupStatus.backups = [{ filename: 'known.sql.gz', valid: true }]
    t.mock.method(adminApi, 'getDatabaseBackups', async () => ({ error: 'list unavailable' }))
    t.mock.method(adminApi, 'createDatabaseBackup', async () => ({ success: false, error: 'disk full' }))
    t.mock.method(adminApi, 'restoreDatabaseBackup', async () => ({ error: 'restore refused' }))
    let refreshes = 0
    t.mock.method(adminApi, 'getSettings', async () => { refreshes++; return {} })
    await settings.loadDatabaseBackups()
    assert.match(settings.databaseBackupMessage.value, /读取失败.*list unavailable/)
    await settings.createDatabaseBackup()
    assert.match(settings.databaseBackupMessage.value, /备份失败.*disk full/)
    await settings.restoreDatabaseBackup({ filename: 'known.sql.gz' })
    assert.match(settings.databaseBackupMessage.value, /恢复失败.*restore refused/)
    assert.deepEqual(settings.databaseBackupStatus.backups, [{ filename: 'known.sql.gz', valid: true }])
    assert.equal(refreshes, 0, 'failed restore must not reload downstream configuration')
    assert.equal(settings.databaseBackupBusy.value, false)
})

test('database backup malformed responses cannot erase the list and a valid create updates it', async t => {
    const settings = settingsFixture(t)
    settings.databaseBackupStatus.backups = [{ filename: 'known.sql.gz' }]
    t.mock.method(adminApi, 'getDatabaseBackups', async () => ({}))
    t.mock.method(adminApi, 'restoreDatabaseBackup', async () => ({ success: true, status: {} }))
    await settings.loadDatabaseBackups()
    await settings.restoreDatabaseBackup({ filename: 'known.sql.gz' })
    assert.deepEqual(settings.databaseBackupStatus.backups, [{ filename: 'known.sql.gz' }])
    assert.match(settings.databaseBackupMessage.value, /恢复失败.*响应无效/)
    t.mock.method(adminApi, 'createDatabaseBackup', async () => ({ success: true, backup: { filename: 'new.sql.gz' }, status: { backups: [{ filename: 'new.sql.gz' }] } }))
    await settings.createDatabaseBackup()
    assert.deepEqual(settings.databaseBackupStatus.backups, [{ filename: 'new.sql.gz' }])
    assert.match(settings.databaseBackupMessage.value, /备份完成.*new.sql.gz/)
})

test('runtime polling refreshes capabilities without clobbering the unsaved auto-start setting', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getRuntimeSettings', async () => runtimePayload())
    await settings.loadRuntimeSettings()
    settings.runtimeSettings.auto_start_enabled = false
    t.mock.method(adminApi, 'getRuntimeSettings', async () => runtimePayload({
        auto_start_enabled: true, auto_start_supported: false, packaged: true
    }))
    await settings.loadRuntimeSettings({ silent: true })
    assert.equal(settings.runtimeSettings.auto_start_enabled, false)
    assert.equal(settings.runtimeSettings.auto_start_supported, false)
    assert.equal(settings.runtimeSettings.packaged, true)
})

test('an older runtime poll cannot roll back a successful save', async t => {
    const settings = settingsFixture(t)
    t.mock.method(adminApi, 'getRuntimeSettings', async () => runtimePayload())
    await settings.loadRuntimeSettings()
    const old = deferred()
    t.mock.method(adminApi, 'getRuntimeSettings', () => old.promise)
    const poll = settings.loadRuntimeSettings({ silent: true })
    settings.runtimeSettings.auto_start_enabled = false
    t.mock.method(adminApi, 'saveRuntimeSettings', async () => runtimePayload({ auto_start_enabled: false }))
    await settings.saveRuntimeSettings()
    old.resolve(runtimePayload())
    await poll
    assert.equal(settings.runtimeSettings.auto_start_enabled, false)
})

test('editing during a save keeps the newer draft', async t => {
    const settings = settingsFixture(t)
    const response = deferred()
    t.mock.method(adminApi, 'saveRuntimeSettings', () => response.promise)
    settings.runtimeSettings.auto_start_enabled = false
    const save = settings.saveRuntimeSettings()
    settings.runtimeSettings.auto_start_enabled = true
    response.resolve(runtimePayload({ auto_start_enabled: false }))
    await save
    assert.equal(settings.runtimeSettings.auto_start_enabled, true)
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

test('old alarm text becomes the point display name without changing IDs/bindings or writing on load', async t => {
    const { points } = pointsFixture(t)
    const original = { id: 1, device_id: 'A', name: 'bj1', label: 'bj1', data_type: 'BOOL', plc_tag: 'DB1.DBX0.0', alarm_text: '风机故障', alarm_condition: '=1' }
    t.mock.method(adminApi, 'getDataPoints', async () => [original])
    const save = t.mock.method(adminApi, 'syncDataPoints', async () => ({ success: true, updated: 1 }))
    await points.loadDataPoints()
    assert.equal(save.mock.callCount(), 0)
    assert.equal(original.label, 'bj1')
    const row = points.dataPoints.value[0]
    assert.equal(row.label, '风机故障'); assert.equal(row.name, 'bj1'); assert.equal(row.id, 1)
    assert.equal(row.alarm_condition, '=1', 'explicit old condition is preserved')
    row.label = '风机过热'; row.alarm_condition = '!=0'; points.markPointsDirty()
    await points.saveAllPoints()
    const payload = save.mock.calls[0].arguments[1][0]
    assert.equal(payload.alarm_text, '风机过热'); assert.equal(payload.label, '风机过热')
    assert.equal(payload.id, 1); assert.equal(payload.name, 'bj1'); assert.equal(payload.value_role, 'bj1')
    assert.equal(payload.alarm_condition, '!=0')
})

test('new alarm usage defaults to nonzero and preserves numeric type; voice text follows the edited point name', t => {
    const { points } = pointsFixture(t)
    const row = points.normalizeLoadedPoint({ name: 'custom_alarm', label: '压力过高', data_type: 'WORD', alarm_condition: '=1' })
    row.__usage = 'alarm_trigger' // Native v-model changes the UI field before @change.
    points.setPointUsage(row, 'alarm_trigger')
    assert.equal(row.alarm_condition, '!=0'); assert.equal(row.data_type, 'WORD')
    row.alarm_text = 'old description'; row.label = '新报警名称'
    assert.equal(points.defaultVoiceText(row), '{设备}：新报警名称')
    assert.deepEqual(points.alarmConditionOptions.map(item => item.value), ['!=0', '=0', '=1'])
})

test('point row keys survive edits and stay out of stored point payloads', async t => {
    const { points } = pointsFixture(t)
    const point = points.normalizeLoadedPoint({ id: 5, device_id: 'A', name: 'temperature' })
    const key = points.pointRowKey(point)
    point.name = 'changed'; point.plc_tag = 'DB1.DBW2'; point.device_id = 'B'
    assert.equal(points.pointRowKey(point), key)
    assert.notEqual(points.pointRowKey(points.normalizeLoadedPoint({ name: 'changed' })), key)
    assert.doesNotMatch(JSON.stringify(point), /point-row-/)
})

test('adding a point reveals its own card on the last page after pagination renders, not an unrelated table', async t => {
    const { points } = pointsFixture(t), scrolled=[]
    points.pointsPageSize.value=10
    points.dataPoints.value=Array.from({length:20},(_,index)=>points.normalizeLoadedPoint({id:index+1,device_id:'A',name:`point_${index}`}))
    document.querySelector=()=>{assert.fail('point authoring must not scroll the first unrelated table')}
    document.getElementById=id=>({scrollIntoView(options){scrolled.push({id,options,page:points.pointsCurrentPage.value,visible:points.paginatedDataPoints.value.map(p=>points.pointRowKey(p))})}})
    points.addDataPoint()
    const added=points.dataPoints.value.at(-1), key=points.pointRowKey(added)
    assert.equal(scrolled.length,0)
    await settle()
    assert.equal(points.pointsCurrentPage.value,3)
    assert.deepEqual(scrolled,[{id:key,options:{block:'nearest',behavior:'smooth'},page:3,visible:[key]}])
    assert.equal(points.isPointsDirty.value,true)
    assert.doesNotMatch(JSON.stringify(added),/point-row-/)
})

test('full alarm save errors and concurrent name edits preserve the latest dirty draft', async t => {
    const { points } = pointsFixture(t)
    t.mock.method(adminApi, 'getDataPoints', async () => [{ id: 1, name: 'bj1', device_id: 'A', data_type: 'BOOL', plc_tag: 'DB1.DBX0.0', alarm_text: 'old' }])
    const response = deferred()
    t.mock.method(adminApi, 'syncDataPoints', () => response.promise)
    await points.loadDataPoints()
    points.dataPoints.value[0].label = 'first'; points.markPointsDirty()
    const pending = points.saveAllPoints()
    points.dataPoints.value[0].label = 'second'
    response.resolve({ success: true, updated: 1 })
    await pending
    assert.equal(points.dataPoints.value[0].label, 'second'); assert.equal(points.isPointsDirty.value, true)
    t.mock.method(adminApi, 'syncDataPoints', async () => { throw new Error('offline') })
    await points.saveAllPoints()
    assert.equal(points.isPointsDirty.value, true); assert.equal(points.dataPoints.value[0].label, 'second')
})

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
