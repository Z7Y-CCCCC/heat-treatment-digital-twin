import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { MAP_SURFACE_VIEWS, createDashboardWidget, normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'

const source = async path => readFile(new URL(path, import.meta.url), 'utf8')

test('parent, return and mixed navigation cycles become terminating paths', () => {
  for (const views of [
    [{ id: 'a', parentViewId: 'b' }, { id: 'b', parentViewId: 'a' }],
    [{ id: 'a', returnViewId: 'b' }, { id: 'b', returnViewId: 'a' }],
    [{ id: 'a', returnViewId: 'b' }, { id: 'b', parentViewId: 'a', returnViewId: '' }]
  ]) {
    const document = normalizeDashboardDocument({ scene: { views } })
    const byId = new Map(document.scene.views.map(view => [view.id, view]))
    for (const start of document.scene.views) {
      for (const useReturn of [false, true]) {
        const visited = new Set()
        let cursor = start
        while (cursor) {
          assert.equal(visited.has(cursor.id), false, `cycle from ${start.id}`)
          visited.add(cursor.id)
          cursor = byId.get(useReturn ? cursor.returnViewId || cursor.parentViewId : cursor.parentViewId)
        }
      }
    }
    assert.deepEqual(normalizeDashboardDocument(document), document, 'repair must be stable across save/reopen')
  }
})

test('older authored dashboards gain the seven map and site canvases without changing the original default', () => {
  const document = normalizeDashboardDocument({
    scene: { defaultViewId: 'factory_overview', views: [{ id: 'factory_overview', name: '原全厂', mode: 'factory' }] },
    widgets: [createDashboardWidget('text', 0, { x: 100, y: 120 })]
  })
  assert.equal(document.scene.defaultViewId, 'factory_overview')
  assert.equal(document.scene.views.find(view => view.id === 'factory_overview').name, '原全厂')
  for (const definition of MAP_SURFACE_VIEWS) {
    const view = document.scene.views.find(item => item.id === definition.id)
    assert.ok(view, `${definition.id} missing`)
    assert.equal(view.mode, 'custom')
    assert.equal(view.parentViewId, definition.parentViewId)
    assert.deepEqual(view.componentState.show, [])
  }
  assert.equal(document.scene.views.find(view => view.id === 'site_street').name, '06 街道示意')
  assert.equal(document.scene.views.find(view => view.id === 'site_factory').name, '07 工厂建筑')
})

test('the duplicate legacy 06 label migrates without overwriting a custom factory-view name', () => {
  const legacy = normalizeDashboardDocument({scene:{views:[{id:'site_factory',name:'06 工厂建筑',mode:'custom'}]}})
  assert.equal(legacy.scene.views.find(view=>view.id==='site_factory').name,'07 工厂建筑')
  const custom = normalizeDashboardDocument({scene:{views:[{id:'site_factory',name:'我的厂区',mode:'custom'}]}})
  assert.equal(custom.scene.views.find(view=>view.id==='site_factory').name,'我的厂区')
})

test('map components retain per-level membership and geometry through normalization', () => {
  const widget = createDashboardWidget('value', 0, { x: 360, y: 260 })
  const first = normalizeDashboardDocument({ widgets: [widget] })
  first.scene.views.find(view => view.id === 'map_city').componentState.show.push(widget.id)
  first.scene.views.find(view => view.id === 'map_district').componentState.hide.push(widget.id)
  const restored = normalizeDashboardDocument(first)
  assert.deepEqual(restored.scene.views.find(view => view.id === 'map_city').componentState.show, [widget.id])
  assert.deepEqual(restored.scene.views.find(view => view.id === 'map_district').componentState.hide, [widget.id])
  assert.equal(restored.widgets.find(item => item.id === widget.id).frame.x, 360)
  assert.equal(restored.widgets.find(item => item.id === widget.id).frame.y, 260)
})

test('all 01–07 tabs use the same mounted designer and runtime surfaces render published widgets', async () => {
  const unified = await source('../src/views/admin/components/UnifiedDashboardDesigner.vue')
  const designer = await source('../src/views/admin/components/DashboardDesigner.vue')
  const map = await source('../src/views/GroupOverview.vue')
  const site = await source('../src/views/FactoryDrilldown.vue')
  const runtime = await source('../src/views/MapSurfaceWidgets.vue')
  assert.equal((unified.match(/<DashboardDesigner\b/g) || []).length, 1)
  assert.match(unified, /:initial-view-id="designerViewId"/)
  assert.match(unified, /@view-change="syncSurface"/)
  assert.match(unified, /const siteViewId = ref\('site_street'\)/)
  assert.match(designer, /@drop\.prevent="handleCanvasDrop"/)
  assert.match(designer, /MAP_SURFACE_VIEW_IDS\.has\(view\.id\)/)
  assert.match(designer, /roots = \[\.\.\.byParent\.get\(''\)\]\.sort/)
  assert.match(designer, /mapBuiltIns\.length/)
  assert.match(designer, /designer-map-built-in/)
  assert.match(unified, /@edit-map-module="editMapModule"/)
  assert.match(map, /<MapSurfaceWidgets/)
  assert.match(site, /<MapSurfaceWidgets/)
  assert.match(runtime, /const surfaceWidgets = computed/)
  assert.match(runtime, /surfaceWidgets\.value\.some\(widget => \['database', 'http_api'\]/)
})

test('the seven built-in map and site canvases do not show empty-widget prompts', async () => {
  assert.equal(MAP_SURFACE_VIEWS.length, 7)
  const designer = await source('../src/views/admin/components/DashboardDesigner.vue')
  assert.match(designer, /v-if="!currentViewIsMapSurface && !canvasWidgets\.length" class="empty-canvas-hint"/)
  assert.match(designer, /v-if="!currentViewIsMapSurface && !currentViewWidgets\.length && !mapBuiltIns\.length"/)
  assert.match(designer, /v-else-if="!currentViewIsMapSurface" class="empty-inspector"/)
})
