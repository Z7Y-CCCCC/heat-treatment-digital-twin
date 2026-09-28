import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { streetEntryStatus, overviewEntryStatus } from '../src/runtime/factoryNavigationReadiness.js'

const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')

test('registered and empty factories remain on the map instead of opening an empty site', () => {
  assert.equal(streetEntryStatus({ name: '未接入厂', runtime: 'registered', workshops: 4 }).allowed, false)
  assert.match(streetEntryStatus({ name: '海外新厂', runtime: 'local', workshops: 0 }).message, /添加车间/)
  assert.equal(streetEntryStatus({ name: '已配置厂', runtime: 'local', workshops: 1 }).allowed, true)
})

test('Unity overview requires a connected workshop, line and device hierarchy', () => {
  assert.match(overviewEntryStatus([]).message, /车间/)
  assert.match(overviewEntryStatus([{ id: 'ws', lines: [] }]).message, /产线/)
  assert.match(overviewEntryStatus([{ id: 'ws', lines: [{ id: 'line', devices: [] }] }]).message, /设备/)
  assert.equal(overviewEntryStatus([{ id: 'ws', lines: [{ id: 'line', devices: [{ id: 'device' }] }] }]).allowed, true)
})

test('map, street, factory and direct overlay entrances all apply readiness checks', () => {
  const map = source('../src/views/GroupOverview.vue')
  const site = source('../src/views/FactoryDrilldown.vue')
  const overlay = source('../src/views/DashboardOverlay.vue')
  assert.match(map, /const status=streetEntryStatus\(target\)/)
  assert.match(map, /:disabled="!streetEntryStatus\(factory\)\.allowed"/)
  assert.match(site, /if\(!overviewReadiness\.value\.allowed\)/)
  assert.match(site, /if\(!Array\.isArray\(payload\.workshops\) \|\| !payload\.workshops\.length\)/)
  assert.match(overlay, /if \(!configLoadError\.value && !overviewReadiness\.allowed\)/)
})
