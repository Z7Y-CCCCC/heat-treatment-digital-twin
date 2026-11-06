import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { adminSubpages } from '../../shared/adminPages.mjs'
import { apiPermission } from '../../shared/apiPermissions.mjs'
import { summarizeDeviceConnections } from '../src/views/admin/utils/connectionStatus.js'
const require = createRequire(import.meta.url)
const { allowsRequirement, normalizePagePermissions } = require('../../shared/pagePermissions.cjs')
const source = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
test('external-interface mode is not shown as a failed PLC or silently remapped to PLC in settings', () => {
  const status = summarizeDeviceConnections({mode:'external'},[{plc_enabled:1}])
  assert.equal(status.label,'外部接口'); assert.equal(status.total,0); assert.equal(status.tone,'is-unknown')
  assert.match(source('../src/views/admin/composables/useSystemSettings.js'), /\['simulation','external','integrated_plc'\]/)
  const component=source('../src/views/admin/components/CollectorRuntimePanel.vue')
  assert.match(component, /pluginInstalled===false/); assert.match(component, /changeSource\('external'\)/)
})

test('collector health is a registered settings page; read does not grant mode writes', () => {
  const page = adminSubpages('settings').find(p => p.key === 'data')
  assert.equal(page.label, '采集状态'); assert.equal(page.permissionKey, 'settings.data')
  const viewer = { active:true,owner:false,permissions:{view:false},pagePermissions:normalizePagePermissions({'settings.data':{view:true}}) }
  assert.equal(allowsRequirement(apiPermission('/api/collector/status','GET'),viewer),true)
  assert.equal(allowsRequirement(apiPermission('/api/collector/mode','PUT'),viewer),false)
})
test('collector page replaces the old selector and duplicate engine card, without a global restart', () => {
  const panel = source('../src/views/AdminPanel.vue'), component = source('../src/views/admin/components/CollectorRuntimePanel.vue')
  assert.match(panel, /<CollectorRuntimePanel v-if="settingsSubpage === 'data'"/)
  assert.doesNotMatch(panel, /<select v-model="settings.data_mode"/)
  assert.match(panel, /!\['migration', 'database', 'data'\]\.includes\(settingsSubpage\)/)
  assert.doesNotMatch(component,/engine\/restart|\.restart\(|saveSettings\(/)
  assert.match(component,/props\.confirm\(/); assert.match(component,/expectedMode = source.value/)
})
test('collector polling is bounded, scoped, cancellable, and never treats request failure as healthy', () => {
  const component = source('../src/views/admin/components/CollectorRuntimePanel.vue')
  assert.match(component,/setInterval\(refresh, 2000\)/)
  assert.match(component,/if \(disposed \|\| loading/)
  assert.match(component,/scope !== getFactoryScope\(\)/)
  assert.match(component,/controller.abort\(\), 6000/)
  assert.match(component,/clearInterval\(timer\)/)
  assert.match(component,/error \? 'offline' : data\?\.state/)
})

const now = 100000
const catalog = [
  { id: 'a', name: '炉 A', plc_enabled: 1 },
  { id: 'b', name: '炉 B', plc_enabled: 1 },
  { id: 'c', name: '非 PLC 设备 C', plc_enabled: 0 }
]
const deviceState = (id, patch = {}) => ({ deviceId: id, deviceName: '旧设备名', status: 'connected', quality: 'good', lastReadAt: now, freshnessMs: 6000, ...patch })
const simulationStatus = rows => ({ mode: 'simulation', observedAt: now, configuredDevices: 3,
  plcStatus: { status: 'simulating', devices: rows }, collectorStatus: { status: 'connected', devices: 3, lastFrameAt: now } })
const summary = (engine, devices = catalog) => summarizeDeviceConnections(engine, devices, { now })

test('simulation header counts exact named device observations instead of PLC-enabled configuration', () => {
  const result = summary(simulationStatus(['a', 'b', 'c'].map(id => deviceState(id))))
  assert.equal(result.total, 3); assert.equal(result.online, 3); assert.equal(result.tone, 'is-online')
  assert.equal(result.modeLabel, '模拟运行')
  assert.deepEqual(result.deviceRows.map(row => [row.id, row.name, row.connected, row.tone]), [
    ['a', '炉 A', true, 'is-online'], ['b', '炉 B', true, 'is-online'], ['c', '非 PLC 设备 C', true, 'is-online']
  ])
})

test('simulation explicit failures remain visible despite a running aggregate or full snapshot count', () => {
  const mixed = summary(simulationStatus([deviceState('a'), deviceState('b', { status: 'error', quality: 'bad' }), deviceState('c')]))
  assert.equal(mixed.online, 2); assert.equal(mixed.offline, 1); assert.equal(mixed.tone, 'is-partial')
  assert.deepEqual(mixed.deviceRows.map(row => row.connected), [true, false, true])
  assert.equal(mixed.deviceRows[1].tone, 'is-offline')
  const failed = summary(simulationStatus(['a', 'b', 'c'].map(id => deviceState(id, { status: 'error', quality: 'bad' }))))
  assert.equal(failed.online, 0); assert.equal(failed.tone, 'is-offline')
})

test('a confirmed failure mixed with pending devices is yellow rather than hiding the failure as unknown', () => {
  const result = summary(simulationStatus([deviceState('a', { status: 'error', quality: 'bad' }),
    deviceState('b', { status: 'starting', quality: 'unknown', lastReadAt: null })]))
  assert.equal(result.online, 0); assert.equal(result.offline, 1); assert.equal(result.pending, 2)
  assert.equal(result.tone, 'is-partial')
  assert.deepEqual(result.deviceRows.map(row => row.tone), ['is-offline', 'is-unknown', 'is-unknown'])
})

test('simulation unknown or omitted device observations never receive an aggregate green plug', () => {
  const missing = summary(simulationStatus([deviceState('a'), deviceState('c', { status: 'starting', quality: 'unknown', lastReadAt: null })]))
  assert.equal(missing.online, 1); assert.equal(missing.tone, 'is-partial')
  assert.deepEqual(missing.deviceRows.map(row => row.tone), ['is-online', 'is-unknown', 'is-unknown'])
  const starting = summary(simulationStatus([]))
  assert.equal(starting.online, 0); assert.equal(starting.tone, 'is-unknown')
  assert.equal(starting.pending, 3)
  const noTime = summary(simulationStatus(['a', 'b', 'c'].map(id => deviceState(id, { lastReadAt: null }))))
  assert.equal(noTime.online, 0); assert.equal(noTime.tone, 'is-unknown')
  const noIdentity = summary({ mode: 'integrated_plc', configuredDevices: 3, plcStatus: { status: 'unknown' } }, [])
  assert.equal(noIdentity.online, 0); assert.equal(noIdentity.tone, 'is-unknown')
})

test('stopped or failed worker evidence overrides obsolete connected simulation rows', () => {
  for (const state of ['stopped', 'error', 'unresponsive', 'recovering']) {
    const engine = simulationStatus(['a', 'b', 'c'].map(id => deviceState(id)))
    engine.collectorStatus.status = state
    const result = summary(engine)
    assert.equal(result.online, 0, state); assert.equal(result.tone, 'is-offline', state)
    assert.ok(result.deviceRows.every(row => !row.connected), state)
  }
})

test('freshness guards reject expired frames, future clocks and expired process heartbeats', () => {
  const stale = summary(simulationStatus(['a', 'b', 'c'].map(id => deviceState(id, { lastReadAt: now - 6001 }))))
  assert.equal(stale.online, 0); assert.equal(stale.tone, 'is-offline')
  const future = summary(simulationStatus(['a', 'b', 'c'].map(id => deviceState(id, { lastReadAt: now + 5001 }))))
  assert.equal(future.online, 0)
  for (const patch of [{ observedAt: now - 15001 }, { process: { status: 'running', lastHeartbeatAt: now - 15001 } }]) {
    const result = summary({ ...simulationStatus(['a', 'b', 'c'].map(id => deviceState(id))), ...patch })
    assert.equal(result.online, 0); assert.equal(result.tone, 'is-offline'); assert.match(result.detail, /已过期/)
  }
  const slow = summary(simulationStatus(['a', 'b', 'c'].map(id => deviceState(id, { lastReadAt: now - 10000, freshnessMs: 30000 }))))
  assert.equal(slow.online, 3, 'configured slow simulator cadence remains valid inside its own threshold')
})

test('legacy aggregate simulation never guesses the identities of partially covered targets', () => {
  const engine = { mode: 'simulation', plcStatus: { status: 'simulating' }, collectorStatus: { devices: 2 } }
  const partial = summary(engine)
  assert.equal(partial.total, 3); assert.equal(partial.online, 2); assert.equal(partial.tone, 'is-partial')
  assert.ok(partial.deviceRows.every(row => !row.connected && row.tone === 'is-unknown'))
  const complete = summary({ ...engine, collectorStatus: { devices: 3 } })
  assert.ok(complete.deviceRows.every(row => row.connected)); assert.equal(complete.tone, 'is-online')
  const empty = summary({ ...engine, configuredDevices: 0 })
  assert.equal(empty.total, 0); assert.equal(empty.online, 0); assert.deepEqual(empty.deviceRows, [])
  assert.equal(empty.tone, 'is-unknown')
})

test('connection directory ignores foreign IDs, deduplicates names and prefers the latest status', () => {
  const rows = [deviceState('outside'), deviceState('a', { timestamp: now - 10 }),
    deviceState('a', { status: 'error', quality: 'bad', timestamp: now }), deviceState('b'), deviceState('c')]
  const result = summary(simulationStatus(rows), [...catalog, { ...catalog[0], name: '重复设备' }])
  assert.equal(result.total, 3); assert.equal(result.online, 2)
  assert.deepEqual(result.deviceRows.map(row => row.id), ['a', 'b', 'c'])
  assert.equal(result.deviceRows[0].name, '炉 A')
  assert.equal(result.deviceRows[0].connected, false)
  const tied = summary(simulationStatus([deviceState('a', { status: 'error', quality: 'bad' }), deviceState('a'), deviceState('b'), deviceState('c')]))
  assert.equal(tied.online, 2, 'ambiguous duplicate order cannot erase an explicit failure')
})

test('real PLC summary includes only configured collectors and ignores production alarms as communication status', () => {
  const engine = { mode: 'integrated_plc', observedAt: now, plcStatus: { status: 'connected', devices: [
    deviceState('a', { alarm: true }), deviceState('b'), deviceState('c', { status: 'disabled', quality: 'bad' })
  ] }, collectorStatus: { status: 'connected' } }
  const result = summary(engine)
  assert.equal(result.modeLabel, '现场采集'); assert.equal(result.total, 2); assert.equal(result.online, 2)
  assert.equal(result.tone, 'is-online'); assert.deepEqual(result.deviceRows.map(row => row.id), ['a', 'b'])
  const noCatalog = summary(engine, [])
  assert.equal(noCatalog.total, 2); assert.equal(noCatalog.online, 2)
  const stopped = summary({ ...engine, process: { status: 'stopped' } })
  assert.equal(stopped.online, 0); assert.equal(stopped.tone, 'is-offline')
})
