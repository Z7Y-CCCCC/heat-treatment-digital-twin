import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = async path => readFile(new URL(path, import.meta.url), 'utf8')

test('factory distribution preview is local and cannot route to the heavy group dashboard', async () => {
  const location = await source('../src/views/admin/components/FactoryLocationSettings.vue')
  const preview = await source('../src/views/admin/components/FactoryDistributionPreview.vue')
  assert.match(location, /<FactoryDistributionPreview/)
  assert.doesNotMatch(location, /RouterLink|path:\s*['"]\/group/)
  assert.match(preview, /factoryDirectorySites/)
  assert.match(preview, /china-provinces\.geojson/)
  assert.doesNotMatch(preview, /GroupOverview|SceneRuntime|three/i)
})

test('factory controls and account permissions occupy standalone admin pages', async () => {
  const panel = await source('../src/views/AdminPanel.vue')
  const security = await source('../src/views/admin/components/AdminSecuritySettings.vue')
  const users = await source('../src/views/admin/components/PlatformUsersSettings.vue')
  const factoryStart = panel.indexOf('<!-- ======== 工厂与区域管理 ======== -->')
  const platformStart = panel.indexOf('<!-- ======== 画面组件配置 ======== -->')
  const settingsStart = panel.indexOf('<!-- ======== 系统设置 ======== -->')
  assert.ok(factoryStart >= 0 && platformStart > factoryStart && settingsStart > platformStart)
  assert.match(panel.slice(factoryStart, platformStart), /<FactoryLocationSettings\s*\/>/)
  assert.match(panel.slice(factoryStart, platformStart), /<GroupPortalSettings\s*\/>/)
  assert.match(panel.slice(factoryStart, platformStart), /activeTab === 'users'.*manageUsers/s)
  assert.match(panel, /key: 'factories', label: '工厂与区域'/)
  assert.match(panel, /key: 'users', label: '用户与权限'/)
  assert.doesNotMatch(panel.slice(platformStart, settingsStart), /<FactoryLocationSettings|<GroupPortalSettings/)
  assert.doesNotMatch(security, /PlatformUsersSettings/)
  assert.match(users, /class="users-table"/)
  assert.match(users, /role="dialog" aria-modal="true"/)
  assert.doesNotMatch(users, /class="user-row"/)
})
