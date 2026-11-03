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
  assert.match(component,/props\.confirm\(/); assert.match(component,/expectedMode: source.value/)
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
