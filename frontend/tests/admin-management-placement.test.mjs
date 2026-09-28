import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = async path => readFile(new URL(path, import.meta.url), 'utf8')

test('factory distribution preview is local and cannot route to the heavy group dashboard', async () => {
  const location = await source('../src/views/admin/components/FactoryDirectorySettings.vue')
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
  const unifiedDesigner = await source('../src/views/admin/components/UnifiedDashboardDesigner.vue')
  const factoryStart = panel.indexOf('<!-- ======== 工厂与区域管理 ======== -->')
  const platformStart = panel.indexOf('<!-- ======== 画面组件配置 ======== -->')
  const settingsStart = panel.indexOf('<!-- ======== 系统设置 ======== -->')
  assert.ok(factoryStart >= 0 && platformStart > factoryStart && settingsStart > platformStart)
  assert.match(panel.slice(factoryStart, platformStart), /<FactoryLocationSettings\s*\/>/)
  assert.doesNotMatch(panel.slice(factoryStart, platformStart), /<GroupPortalSettings\s*\/>/)
  assert.match(panel.slice(factoryStart, platformStart), /activeTab === 'users'.*manageUsers/s)
  assert.match(panel, /key: 'factories', label: '工厂与区域'/)
  assert.ok(panel.indexOf("key: 'factories', label: '工厂与区域'") < panel.indexOf("key: 'composer', label: '现场编排器'"))
  assert.doesNotMatch(panel.slice(factoryStart, platformStart), /factory-hierarchy-note/)
  assert.match(panel, /key: 'users', label: '用户与权限'/)
  assert.doesNotMatch(panel.slice(platformStart, settingsStart), /<FactoryLocationSettings/)
  assert.match(panel.slice(platformStart, settingsStart), /<UnifiedDashboardDesigner/)
  assert.doesNotMatch(panel.slice(platformStart, settingsStart), /map-design-details/)
  assert.match(unifiedDesigner, /v-for="\(level,index\) in GROUP_MAP_LEVELS"/)
  assert.match(unifiedDesigner, /<GroupPortalSettings[^>]*:active-level="activeSurface" designer-mode/)
  assert.match(unifiedDesigner, /<DashboardDesigner/)
  assert.match(unifiedDesigner, /<LoadingExperienceSettings/)
  assert.doesNotMatch(security, /PlatformUsersSettings/)
  assert.match(users, /class="users-table"/)
  assert.match(users, /role="dialog" aria-modal="true"/)
  assert.doesNotMatch(users, /class="user-row"/)
})

test('each map-level layout editor is wired to the actual dashboard components', async () => {
  const editor = await source('../src/views/admin/components/GroupPortalSettings.vue')
  const dashboard = await source('../src/views/GroupOverview.vue')
  assert.match(editor, /GROUP_MAP_LEVELS/)
  assert.match(editor, /startLayoutDrag\('brand'/)
  for (const component of ['brand', 'facts', 'panel', 'dock']) {
    assert.match(editor, new RegExp(`layoutPosition\\('${component}'\\)`))
    assert.match(dashboard, new RegExp(`:style="layoutStyle\\('${component}'\\)"`))
  }
})

test('factory hierarchy is visible in asset editors and model levels cannot be assigned as device models', async () => {
  const panel = await source('../src/views/AdminPanel.vue')
  const hierarchy = await source('../src/views/admin/components/AssetHierarchyBar.vue')
  assert.match(panel, /<AssetHierarchyBar[\s\S]*?:model-library="activeTab === 'models'"/)
  assert.match(panel, /assetHierarchyTabs = new Set\(\['platform', 'composer', 'workshops', 'lines', 'devices', 'mobile-devices', 'points', 'point-monitor', 'models', 'settings'\]\)/)
  assert.match(hierarchy, /工厂 → 车间 → 产线 → 设备/)
  assert.doesNotMatch(hierarchy, /管理工厂<\/button>/)
  assert.match(hierarchy, /accepted = await props\.requestSwitch/)
  assert.match(hierarchy, /if \(!accepted\)[\s\S]*?return[\s\S]*?setFactoryScope\(next\)[\s\S]*?window\.location\.reload\(\)/)
  assert.match(panel, /secondaryText: '不保存并切换'/)
  assert.match(panel, /confirmText: '保存并切换'/)
  assert.match(panel, /fd\.append\('placement_level', modelImportForm\.placement_level\)/)
  assert.match(panel, /\(model\.placement_level \|\| 'device'\) === 'device'/)
  assert.match(panel, /deviceHierarchyLabel\(d\)/)
})
