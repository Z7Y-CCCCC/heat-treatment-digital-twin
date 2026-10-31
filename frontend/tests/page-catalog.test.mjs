import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ADMIN_PAGES, getAdminPageCatalog, adminNavPages, adminSubpages, mergeAdminPageCatalog } from '../../shared/adminPages.mjs'
import { PAGE_PERMISSIONS, normalizePagePermissions } from '../../shared/pagePermissions.mjs'
import { adminSession, adminPageCatalog, applyAdminPageCatalog, getAdminPageCatalog as refreshCatalog, canAdminPage, canAdminApi } from '../src/runtime/adminSession.js'
import { installBrowser, json } from './helpers.mjs'

function fixture(t) {
  installBrowser(t)
  const definitions = getAdminPageCatalog(), session = { ...adminSession }
  t.after(() => {
    ADMIN_PAGES.splice(0, ADMIN_PAGES.length, ...definitions)
    adminPageCatalog.value = getAdminPageCatalog()
    Object.assign(adminSession, session)
  })
  Object.assign(adminSession, { authenticated: true, user: { role: 'viewer' }, permissions: { view: false },
    pagePermissions: normalizePagePermissions({ points: { view: true, edit: true } }) })
}
const added = () => ({ key: 'points.catalog-fixture', label: '点位映射 · 新标签', actions: ['view', 'edit'], ownerOnly: false,
  container: 'points', subpage: 'catalog-fixture', tabLabel: '新标签' })

test('one registration feeds navigation, nested tabs and the authorization matrix', async () => {
  assert.equal(PAGE_PERMISSIONS, ADMIN_PAGES)
  const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  for (const group of ['factory', 'data', 'models']) assert.match(panel, new RegExp(`adminNavPages\\('${group}', adminPageCatalog\\.value\\)`))
  for (const group of ['platform', 'settings', 'points']) assert.match(panel, new RegExp(`adminSubpages\\('${group}', adminPageCatalog\\.value\\)`))
  assert.equal(adminNavPages('models').find(p => p.key === 'disassembly-layout').label, '拆解布局')
  assert.ok(adminSubpages('points').some(p => p.permissionKey === 'points.alarms'))
  assert.equal(new Set(PAGE_PERMISSIONS.map(p => p.key)).size, PAGE_PERMISSIONS.length)
})

test('map modules and loading are separate tabs; the retired identity tab remains compatible but hidden', () => {
  assert.deepEqual(adminSubpages('platform').map(p => p.key), ['designer', 'map', 'loading', 'environment'])
  assert.equal(ADMIN_PAGES.find(p => p.key === 'platform.scene').retired, true)
  assert.equal(normalizePagePermissions({ 'platform.scene': { view: true, edit: true } })['platform.scene'].edit, true)
})

test('catalog refresh registers new tabs without granting new access or dropping existing grants', async t => {
  fixture(t)
  t.mock.method(window, 'fetch', async (url, options) => {
    assert.ok(url.endsWith('/admin-auth/page-catalog'))
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'include')
    return json({ success: true, pages: [...getAdminPageCatalog(), added()] })
  })
  await refreshCatalog()
  assert.equal(adminSubpages('points').at(-1).permissionKey, added().key)
  assert.ok(adminPageCatalog.value.some(p => p.key === added().key))
  assert.equal(canAdminPage('points', 'edit'), true)
  assert.deepEqual(adminSession.pagePermissions[added().key], { view: false, edit: false })
  assert.equal(canAdminPage(added().key), false)
  assert.equal(canAdminPage('points.alarms'), false, 'a parent grant must not silently grant a newly introduced child')
  assert.throws(() => normalizePagePermissions({ 'unknown-page': { view: true } }))
})

test('invalid catalog updates are atomic and cannot downgrade administrator-only pages', t => {
  fixture(t)
  const before = getAdminPageCatalog()
  assert.throws(() => mergeAdminPageCatalog([...before, added(), { ...added(), key: 'bad', actions: ['administrator'] }]))
  assert.deepEqual(getAdminPageCatalog(), before)
  assert.throws(() => applyAdminPageCatalog(before.map(p => p.key === 'users' ? { ...p, ownerOnly: false } : p)))
  assert.deepEqual(getAdminPageCatalog(), before)
})

test('alarm-only permission can save alarm text but cannot edit PLC definitions, delete or alter devices', t => {
  fixture(t)
  adminSession.pagePermissions = normalizePagePermissions({ 'points.alarms': { view: true, edit: true } })
  for (const path of ['/api/devices', '/api/lines', '/api/workshops', '/api/datapoints', '/api/settings']) assert.equal(canAdminApi(path), true, path)
  assert.equal(canAdminApi('/api/datapoints/alarm-texts', 'POST'), true)
  for (const [path, method] of [['/api/datapoints/sync', 'POST'], ['/api/datapoints/1', 'DELETE'], ['/api/datapoints/1', 'PUT'], ['/api/devices/A', 'PUT']]) {
    assert.equal(canAdminApi(path, method), false, `${method} ${path}`)
  }
})
