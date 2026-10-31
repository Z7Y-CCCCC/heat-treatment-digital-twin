import test from 'node:test'
import assert from 'node:assert/strict'
import { adminSession, canAdminPage, canOpenAdmin, canAdminApi } from '../src/runtime/adminSession.js'
import { permissionDirective } from '../src/runtime/pagePermissionUi.js'
import { normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { deviceTransformPayload } from '../../shared/deviceAuthoring.mjs'
import { installBrowser, json } from './helpers.mjs'

function fixture(t, grants, permissions = {}) {
  installBrowser(t)
  const before = { ...adminSession }
  Object.assign(adminSession, { ready: true, authenticated: true, user: { id: 'user', role: 'viewer' },
    permissions: { view: false, edit: false, ...permissions }, pagePermissions: normalizePagePermissions(grants) })
  t.after(() => Object.assign(adminSession, before))
}

test('page-only users can enter admin without legacy global edit or display permission', t => {
  fixture(t, { models: { view: true, edit: true } })
  assert.equal(canOpenAdmin(), true)
  assert.equal(canAdminPage('models', 'edit'), true)
  assert.equal(canAdminPage('devices'), false)
  assert.equal(canAdminPage('users'), false)
  assert.equal(canAdminApi('/api/models/upload', 'POST'), true)
  assert.equal(canAdminApi('/api/models/item', 'DELETE'), false)
  assert.equal(canAdminApi('/api/platform/designer'), false)
  assert.equal(canAdminApi('/api/settings', 'PUT', {}), false)
  adminSession.authenticated = false
  assert.equal(canOpenAdmin(), false)
  assert.equal(canAdminPage('models'), false)
})

test('read-only and native disabled states are enforced without disabling permitted navigation', t => {
  fixture(t, { models: { view: true } })
  const attributes = new Map()
  const element = { disabled: false, setAttribute: (k,v) => attributes.set(k,v), removeAttribute: k => attributes.delete(k) }
  const binding = { value: { page: 'models', action: 'edit' } }
  permissionDirective.mounted(element, binding, { props: {} })
  assert.equal(element.disabled, true)
  assert.equal(attributes.get('aria-disabled'), 'true')
  adminSession.pagePermissions = normalizePagePermissions({ models: { view: true, edit: true } })
  permissionDirective.updated(element, binding, { props: {} })
  assert.equal(element.disabled, false)
  permissionDirective.updated(element, binding, { props: { disabled: true } })
  assert.equal(element.disabled, true, 'permission grant must not override a busy/invalid control')
  assert.deepEqual(permissionDirective.getSSRProps({ value: { page: 'models', action: 'delete' } }), { disabled: true, 'aria-disabled': 'true' })
})

test('transform payload excludes PLC identity, model identity, movement and inspection metadata', () => {
  const payload = deviceTransformPayload({ pos_x: 5, line_id: 'line_1', model_type: 'model_secret', plc_ip: 'private',
    instance_config: { railId: 'rail_1', movement: { enabled: true }, inspection: { enabled: true } } })
  assert.equal(payload.pos_x, 5)
  assert.equal(payload.layoutConfig.railId, 'rail_1')
  for (const key of ['model_type', 'plc_ip', 'instance_config']) assert.equal(Object.hasOwn(payload, key), false)
  assert.equal(Object.hasOwn(payload.layoutConfig, 'movement'), false)
  assert.equal(Object.hasOwn(payload.layoutConfig, 'inspection'), false)
})

test('atomic group transforms require line or scene placement editing, never model editing or read-only access', t => {
  fixture(t, { lines: { view: true, edit: true } })
  assert.equal(canAdminApi('/api/devices/transforms', 'PUT'), true)
  adminSession.pagePermissions = normalizePagePermissions({ composer: { view: true, edit: true } })
  assert.equal(canAdminApi('/api/devices/transforms', 'PUT'), true)
  for (const grants of [{ lines: { view: true } }, { models: { view: true, edit: true } }]) {
    adminSession.pagePermissions = normalizePagePermissions(grants)
    assert.equal(canAdminApi('/api/devices/transforms', 'PUT'), false)
  }
})

test('moved map and loading pages retain old designer grants but respect explicit independent denials', t => {
  fixture(t, { 'platform.designer': { view: true, edit: true } })
  assert.equal(canAdminPage('platform.map', 'edit'), true)
  assert.equal(canAdminPage('platform.loading', 'edit'), true)
  adminSession.pagePermissions = normalizePagePermissions({ 'platform.designer': { view: true, edit: true }, 'platform.map': { view: false, edit: false } })
  assert.equal(canAdminPage('platform.map'), false)
  assert.equal(canAdminApi('/api/settings', 'PUT', { group_portal_config: {} }), false)
  assert.equal(canAdminApi('/api/settings', 'PUT', { loading_experience_config: {} }), true)
})

test('map and loading authors save only their own settings without obtaining designer or database editing', t => {
  fixture(t, { 'platform.map': { view: true, edit: true } })
  assert.equal(canAdminApi('/api/settings', 'PUT', { group_portal_config: {} }), true)
  assert.equal(canAdminApi('/api/data-sources'), true)
  for (const body of [{ loading_experience_config: {} }, { native_dashboard_config: {} }, { group_portal_config: {}, loading_experience_config: {} }]) assert.equal(canAdminApi('/api/settings', 'PUT', body), false)
  assert.equal(canAdminApi('/api/platform/designer/draft', 'PUT'), false)
  assert.equal(canAdminApi('/api/data-sources/connections', 'POST'), false)
  adminSession.pagePermissions = normalizePagePermissions({ 'platform.loading': { view: true, edit: true } })
  assert.equal(canAdminApi('/api/settings', 'PUT', { loading_experience_config: {} }), true)
  assert.equal(canAdminApi('/api/settings', 'PUT', { group_portal_config: {} }), false)
  assert.equal(canAdminApi('/api/platform/releases', 'POST'), false)
})

test('model layout authoring is restricted to positions and does not grant generic model editing', t => {
  fixture(t, { 'disassembly-layout': { view: true, edit: true } })
  assert.equal(canAdminApi('/api/models/type/inspection', 'GET'), true)
  assert.equal(canAdminApi('/api/models/type/inspection', 'PUT'), true)
  assert.equal(canAdminApi('/api/models/type', 'PUT'), false)
  assert.equal(canAdminApi('/api/models/upload', 'POST'), false)
  assert.equal(canAdminApi('/api/models/type', 'DELETE'), false)
})

test('motion authors can save bindings without model publishing or disassembly rights', t => {
  fixture(t, { 'model-animations': { view: true, edit: true } })
  assert.equal(canAdminPage('model-animations'), true)
  assert.equal(canAdminApi('/api/models', 'GET'), true)
  assert.equal(canAdminApi('/api/models/type/bindings', 'PUT'), true)
  for (const path of ['/api/models/type', '/api/models/type/inspection', '/api/models/type/name']) {
    assert.equal(canAdminApi(path, 'PUT'), false)
  }
  assert.equal(canAdminApi('/api/models/upload', 'POST'), false)
  adminSession.pagePermissions = normalizePagePermissions({ 'model-animations': { view: true } })
  assert.equal(canAdminApi('/api/models/type/bindings', 'PUT'), false)
})

test('page-specific settings save submits only the current authorized group', async t => {
  fixture(t, { 'settings.data': { view: true, edit: true } })
  const { effectScope } = await import('vue')
  const { useSystemSettings } = await import('../src/views/admin/composables/useSystemSettings.js')
  const { adminApi } = await import('../src/config/factoryConfig.js')
  const scope = effectScope()
  t.after(() => scope.stop())
  const calls = []
  t.mock.method(adminApi, 'saveSettings', async body => { calls.push(body); return { success: true } })
  t.mock.method(window, 'fetch', async () => json({ success: true }))
  const settings = scope.run(() => useSystemSettings({ alert: async () => {}, confirm: async () => true }))
  settings.settings.data_mode = 'simulation'
  await settings.saveSettings('settings.data')
  assert.deepEqual(calls, [{ data_mode: 'simulation' }])
})
