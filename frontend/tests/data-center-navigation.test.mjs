import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ADMIN_PAGES, adminMainTabs, adminSubpages, adminNavPages } from '../../shared/adminPages.mjs'
const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const center = await readFile(new URL('../src/views/admin/components/DataCenterWorkspace.vue', import.meta.url), 'utf8')

test('data-center is a first-level sidebar group whose child destinations reuse existing grants', () => {
  assert.equal(adminMainTabs().find(page => page.key === 'data-center').label, '数据中心')
  const destinations = adminSubpages('data-center')
  assert.equal(destinations.find(page => page.key === 'mapping').permissionKey, 'points')
  assert.equal(destinations.find(page => page.key === 'monitor').permissionKey, 'point-monitor')
  assert.equal(destinations.find(page => page.key === 'alarms').permissionKey, 'points.alarms')
  for (const key of ['tables','sources']) assert.equal(destinations.find(page => page.key === key).permissionKey, 'settings.database')
  assert.deepEqual(adminNavPages('data'), [])
  assert.match(panel, /data-testid="data-center-nav"[\s\S]*v-for="child in visibleDataCenterSubpages"[\s\S]*@click="openDataCenterSection\(child.key\)"/)
  assert.doesNotMatch(center, /class="center-nav"|role="tablist"|data-center-tab-/)
  assert.match(panel, /dataCenterSection === 'table-editor' \? 'tables' : dataCenterSection/)
})

test('legacy-only page grants resolve the new workspace instead of a removed top-level alias', () => {
  const canSelect = grant => key => key === 'data-center' ? adminSubpages('data-center').some(page => page.permissionKey === grant || page.viewPages?.includes(grant)) : key === grant
  const candidates = [...adminMainTabs().map(page => page.key), ...ADMIN_PAGES.filter(page => page.navGroup).map(page => page.key)]
  for (const grant of ['point-monitor','points','points.alarms']) assert.equal(candidates.find(canSelect(grant)), 'data-center')
  assert.match(panel, /adminMainTabs\(adminPageCatalog.value\).map\(tab => tab.key\)/)
  assert.match(panel, /storedAdminUiState.activeTab = 'data-center'/)
  assert.match(panel, /isPointMonitorWorkspace = computed\(\(\) => activeTab.value === 'data-center'/)
})

test('submenu changes and factory switches protect metadata, source and live/cached table drafts', () => {
  assert.match(panel, /dataCenterRef.value\?\.canLeave/)
  assert.match(panel, /dataCenterSourceRef.value\?\.canLeave/)
  assert.match(panel, /dataCenterRef.value\?\.savePending/)
  assert.match(panel, /dataCenterSourceRef.value\?\.savePending/)
  assert.match(panel, /dataset: async \(\{ value \}\) =>[\s\S]*adminApi.saveDataSet\(value\)/)
  assert.match(panel, /window.removeEventListener\(FACTORY_SCOPE_CHANGE_EVENT, syncDataCenterFactory\)/)
  assert.equal((panel.match(/<DataSourceWorkspace\b/g) || []).length, 1)
  assert.doesNotMatch(panel, /database-panel-sources|label: '外部数据源'/)
})

test('the five data center subpages no longer repeat the shared title and introductory flow banner', () => {
  assert.equal(adminSubpages('data-center').length, 5)
  assert.doesNotMatch(center, /center-heading|center-title|center-symbol|center-flow|先整理好数据，再轻松搭建画面|数据使用流程/)
  assert.match(center, /aria-label="数据表"/)
  assert.match(center, /:aria-label="activeRegionLabel"/)
})
