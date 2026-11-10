import test from 'node:test'
import assert from 'node:assert/strict'
import { effectScope, nextTick, ref } from 'vue'
import { adminApi } from '../src/config/factoryConfig.js'
import { usePointMonitor } from '../src/views/admin/composables/usePointMonitor.js'

function fixture(t, storedAdminUiState = {}) {
    const devices = ref([
        { id: 'f1', name: '1号多用炉', line_id: 11 },
        { id: 'f2', name: '2号多用炉', line_id: '12' },
        { id: 'f3', name: '1号多用炉', line_id: 21 },
        { id: 'cart', name: '转运车', line_id: null, instance_config: '{"workshop_id":"1"}' },
        { id: 'unassigned', name: '未分配设备', instance_config: 'invalid json' },
        { id: 7, name: '清洗机', line_id: '11' }
    ])
    const workshops = ref([{ id: 1, name: '一车间' }, { id: 2, name: '二车间' }])
    const lines = ref([{ id: 11, name: 'A产线', workshop_id: 1 }, { id: 12, name: 'B产线', workshop_id: '1' }, { id: 21, name: 'A产线', workshop_id: 2 }])
    const rows = [
        { id: 1, device_id: 'f1', name: 'actual_temp', label: '实际温度', category: 'analog', quality: 'good', value: 850, plc_tag: 'DB1.DBD16', data_type: 'REAL' },
        { id: 2, device_id: 'f1', name: 'ammonia', label: '氨气流量', category: 'gas', quality: 'bad', plc_tag: 'DB1.DBD24', alarm_text: '气体流量不足' },
        { id: 3, device_id: 'f2', name: 'fan_speed', label: '风扇转速', category: 'analog', quality: 'stale', plc_tag: 'DB1.DBW32' },
        { id: 4, device_id: 'f3', name: 'actual_temp', label: '实际温度', category: 'analog', quality: 'good', plc_tag: 'DB1.DBD16' },
        { id: 5, device_id: 'cart', label: '车门状态', category: 'status', quality: 'good', plc_tag: 'DB1.DBX0.1' },
        { id: 6, device_id: 'unassigned', label: '设备状态', quality: 'bad' },
        { id: 7, device_id: '7', label: '电量', category: 'analog', quality: 'good', plc_tag: 'DB1.DBD40' },
        { id: 8, device_id: 'f2', label: '温度', category: 'analog', quality: 'good', plc_tag: 'DB1.DBD16' }
    ]
    const scope = effectScope()
    t.after(() => scope.stop())
    const monitor = scope.run(() => usePointMonitor({ devices, workshops, lines, storedAdminUiState }))
    monitor.realtimePointRows.value = structuredClone(rows)
    return { monitor, devices, rows }
}
const rowIds = monitor => monitor.filteredRealtimePointRows.value.map(point => point.id)

test('workshop and line filters cascade and include mixed numeric/string hierarchy IDs', t => {
    const { monitor: m } = fixture(t)
    m.pointMonitorFilters.workshopId = '1'
    assert.deepEqual(m.pointMonitorDevices.value.map(device => device.id), ['f1', 'f2', 'cart', 7])
    assert.ok(!m.pointMonitorLines.value.some(line => line.id === '21'))
    m.pointMonitorFilters.lineId = '11'
    assert.deepEqual(m.pointMonitorDevices.value.map(device => device.id), ['f1', 7])
    assert.deepEqual(rowIds(m), [1, 2, 7])
    m.selectedDeviceForMonitor.value = 'f1'
    m.pointMonitorFilters.workshopId = '2'
    assert.equal(m.pointMonitorFilters.lineId, 'all')
    assert.equal(m.selectedDeviceForMonitor.value, 'all')
    assert.deepEqual(rowIds(m), [4])
})

test('changing a line clears the previously selected device immediately', t => {
    const { monitor: m } = fixture(t)
    m.pointMonitorFilters.lineId = '11'
    m.selectedDeviceForMonitor.value = 'f1'
    m.pointMonitorFilters.lineId = '12'
    assert.equal(m.selectedDeviceForMonitor.value, 'all')
    assert.deepEqual(rowIds(m), [3, 8])
})

test('workshop-level equipment and unassigned devices remain reachable', t => {
    const { monitor: m } = fixture(t)
    m.pointMonitorFilters.workshopId = '1'
    m.pointMonitorFilters.lineId = m.pointMonitorLines.value.find(line => line.name.includes('无产线')).id
    assert.deepEqual(rowIds(m), [5])
    m.pointMonitorFilters.workshopId = m.pointMonitorWorkshops.value.find(workshop => workshop.name === '未分配车间').id
    assert.deepEqual(rowIds(m), [6])
})

test('category, quality, and multi-keyword name/address searches combine without mutating rows', t => {
    const { monitor: m } = fixture(t)
    const before = JSON.stringify(m.realtimePointRows.value)
    m.pointMonitorFilters.query = '  温度   db1.dbd16 '
    m.pointMonitorFilters.category = 'analog'
    m.pointMonitorFilters.quality = 'good'
    assert.deepEqual(rowIds(m), [1, 4, 8])
    m.pointMonitorFilters.workshopId = '1'
    m.pointMonitorFilters.lineId = '11'
    assert.deepEqual(rowIds(m), [1])
    m.pointMonitorFilters.query = 'does-not-exist'
    assert.deepEqual(rowIds(m), [])
    assert.equal(JSON.stringify(m.realtimePointRows.value), before)
})

test('searches include device names, workshop/line names and alarm descriptions', t => {
    const { monitor: m } = fixture(t)
    m.pointMonitorFilters.query = '二车间 1号多用炉'
    assert.deepEqual(rowIds(m), [4])
    m.pointMonitorFilters.query = '气体流量不足'
    assert.deepEqual(rowIds(m), [2])
    m.pointMonitorFilters.query = '清洗机 DBD40'
    assert.deepEqual(rowIds(m), [7])
})

test('PLC motor and mechanism groups have readable Chinese category names', t => {
    const { monitor: m } = fixture(t)
    m.realtimePointRows.value = [
        { id: 'motor', device_id: 'f1', category: 'motors', quality: 'good' },
        { id: 'door', device_id: 'f1', category: 'mechanisms', quality: 'good' }
    ]
    assert.deepEqual(m.pointMonitorCategories.value.map(category => category.name), ['电机／风扇', '机构动作'])
    m.pointMonitorFilters.query = '电机'
    assert.deepEqual(rowIds(m), ['motor'])
})

test('abnormal-only includes expired/bad points and each exact quality remains selectable', t => {
    const { monitor: m } = fixture(t)
    m.pointMonitorFilters.quality = 'abnormal'
    assert.deepEqual(rowIds(m), [2, 3, 6])
    m.pointMonitorFilters.quality = 'stale'
    assert.deepEqual(rowIds(m), [3])
    m.pointMonitorFilters.quality = 'bad'
    assert.deepEqual(rowIds(m), [2, 6])
})

test('pagination uses filtered results and resets when filters change, not for each live frame', async t => {
    const { monitor: m } = fixture(t)
    m.monitorPageSize.value = 2
    await nextTick()
    assert.equal(m.totalMonitorPages.value, 4)
    m.monitorCurrentPage.value = 3
    m.realtimePointRows.value[0].value = 851
    await nextTick()
    assert.equal(m.monitorCurrentPage.value, 3)
    m.pointMonitorFilters.query = '温度'
    await nextTick()
    assert.equal(m.monitorCurrentPage.value, 1)
    assert.equal(m.totalMonitorPages.value, 2)
    assert.deepEqual(m.paginatedRealtimePointRows.value.map(point => point.id), [1, 4])
    m.monitorPageSize.value = 0
    assert.equal(m.paginatedRealtimePointRows.value.length, 3)
})

test('reset restores all devices, clears every filter and exposes all results', t => {
    const { monitor: m } = fixture(t)
    Object.assign(m.pointMonitorFilters, { workshopId: '1', lineId: '11', category: 'gas', quality: 'bad', query: '氨气' })
    m.selectedDeviceForMonitor.value = 'f1'
    assert.equal(m.hasPointMonitorFilters.value, true)
    m.resetPointMonitorFilters()
    assert.equal(m.hasPointMonitorFilters.value, false)
    assert.equal(rowIds(m).length, 8)
})

test('connection summary reflects the selected hierarchy rather than all factory devices', t => {
    const { monitor: m } = fixture(t)
    m.realtimePointDeviceStatuses.value = [{ deviceId: 'f1', status: 'connected' }, { deviceId: '7', quality: 'bad' }, { deviceId: 'f3', status: 'connected' }]
    m.pointMonitorFilters.workshopId = '1'
    m.pointMonitorFilters.lineId = '11'
    assert.equal(m.pointMonitorStatusSummary.value.message, 'A产线：1/2 在线')
    assert.equal(m.pointMonitorStatusSummary.value.status, 'error')
})

test('filtering reads cached rows without additional requests and survives fresh real-time frames', async t => {
    const { monitor: m, rows } = fixture(t)
    const read = t.mock.method(adminApi, 'getRealtimePointValues', async () => ({ points: structuredClone(rows) }))
    await m.loadRealtimePointValues()
    const existing = m.realtimePointRows.value[0]
    m.pointMonitorFilters.query = '温度 db1.dbd16'
    m.pointMonitorFilters.category = 'analog'
    m.pointMonitorFilters.quality = 'good'
    await nextTick()
    assert.equal(read.mock.callCount(), 1)
    rows[0].value = 852
    await m.loadRealtimePointValues({ silent: true })
    assert.equal(m.realtimePointRows.value[0], existing)
    assert.equal(m.filteredRealtimePointRows.value[0].value, 852)
    assert.equal(m.pointMonitorFilters.query, '温度 db1.dbd16')
})

test('restored numeric device IDs are valid, and a late response for another device is discarded', async t => {
    const { monitor: m } = fixture(t, { selectedDeviceForMonitor: '7' })
    m.ensurePointMonitorDevice()
    assert.equal(m.selectedMonitorDevice.value.name, '清洗机')
    assert.deepEqual(rowIds(m), [7])
    let resolve
    t.mock.method(adminApi, 'getRealtimePointValues', () => new Promise(done => { resolve = done }))
    const request = m.loadRealtimePointValues()
    m.selectedDeviceForMonitor.value = 'f2'
    resolve({ points: [{ id: 'late', device_id: '7' }] })
    await request
    assert.deepEqual(rowIds(m), [3, 8])
})
