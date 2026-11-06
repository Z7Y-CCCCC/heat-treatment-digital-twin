import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { widgetRuntimeVisibility, widgetRuntimeVisible } from '../src/runtime/dashboardRules.js'
import { isCanvasWidget, widgetViewVisibility, widgetPresentationState, returnNavigationVisibility } from '../src/runtime/widgetPresentation.js'

const factory = { id: 'factory_overview', mode: 'factory', targetType: 'factory', componentState: { show: [], hide: [] } }
const line = { id: 'line_overview', mode: 'line', targetType: 'line', parentViewId: 'factory_overview', componentState: { show: [], hide: [] } }
const widget = { id: 'reading', type: 'text', visible: true, data: {}, visibility: {} }
const runtime = (view = factory, extra = {}) => ({ view, context: { viewId: view.id, viewMode: view.mode, sceneReady: true, ...extra } })

test('return button keeps automatic root hiding and editor reports the reason instead of changing the document', () => {
  const button = { ...widget, id: 'widget_return_button', type: 'return_button', runtimeTarget: 'unity' }
  const before = JSON.stringify(button)
  const root = widgetPresentationState(button, runtime())
  assert.equal(root.visible, false)
  assert.equal(root.code, 'root-return')
  assert.match(root.reason, /首层/)
  assert.equal(widgetPresentationState(button, runtime(line, { lineId: 'line_a' })).visible, true)
  assert.equal(JSON.stringify(button), before)
  assert.equal(button.visible, true)
})

test('native return policy retains startup, default view, inspection and target hand-off behavior', () => {
  assert.equal(returnNavigationVisibility(line, {viewId:line.id,viewMode:'line',sceneReady:false}).code, 'scene-loading')
  assert.equal(returnNavigationVisibility(line, {viewId:line.id,viewMode:'line',lineId:'a'}, line.id).code, 'root-return')
  assert.equal(returnNavigationVisibility(line, {viewId:line.id,viewMode:'line'}).code, 'no-target')
  assert.equal(returnNavigationVisibility({mode:'device',targetType:'device'}, {viewMode:'device',sceneReady:false,inspectionStage:'xray'}).visible, true)
  assert.equal(returnNavigationVisibility({mode:'device',targetType:'device',parentViewId:'line'}, {viewMode:'device',deviceId:'a',inspectionStage:'solid'}).visible, true)
  assert.equal(returnNavigationVisibility({mode:'line'}, {viewMode:'line'}).visible, true) // legacy edge fallback
})

test('all manual, view/device, data and event hides expose reasons from the same boolean rule evaluator', () => {
  const cases = [
    [{visible:false}, {}, 'manual'], [{visible:0}, {}, 'manual'],
    [{groupId:'group_a'}, {groupVisibility:{group_a:false}}, 'group-event'],
    [{}, {widgetVisibility:{reading:false}}, 'widget-event'],
    [{visibility:{viewIds:['device']}}, {}, 'view-filter'],
    [{visibility:{viewModes:['device']}}, {}, 'mode-filter'],
    [{visibility:{matchBoundDevice:true},data:{deviceScope:'current'}}, {}, 'device-context'],
    [{visibility:{matchBoundDevice:true},data:{deviceId:'b'}}, {context:{deviceId:'a'}}, 'device-filter'],
    [{visibility:{rules:[{source:'data',operator:'>',value:20}]}}, {dataValue:10}, 'rule']
  ]
  for (const [patch, context, code] of cases) {
    const value={...widget,...patch}, state=widgetRuntimeVisibility(value,context)
    assert.equal(state.code,code)
    assert.equal(state.visible,widgetRuntimeVisible(value,context))
    assert.ok(state.reason)
  }
  const any = {...widget,visibility:{ruleMode:'any',rules:[{path:'deviceId',value:'b'},{source:'data',operator:'>',value:20}]}}
  assert.equal(widgetRuntimeVisibility(any,{context:{deviceId:'a'},dataValue:30}).visible,true)
})

test('component membership shares id, system aliases and groups; hide wins over show', () => {
  const nav={id:'custom_nav',type:'navigation',groupId:'g'}
  for (const key of [nav.id,'navigation','system:navigation','group:g']) {
    const view={...factory,componentState:{show:[key],hide:[]}}
    assert.equal(widgetViewVisibility(nav,view).visible,true)
    assert.equal(widgetViewVisibility(nav,{...view,componentState:{...view.componentState,hide:[key]}}).code,'view-hidden')
  }
  assert.equal(widgetViewVisibility(nav,{...factory,componentState:{show:['other']}}).code,'not-in-view')
  assert.equal(widgetViewVisibility(nav,{id:'map_world',componentState:{show:[]}}).visible,false)
})

test('disabled/hidden views and legacy Unity-tagged navigation are handled consistently on canvas surfaces', () => {
  for (const type of ['navigation','return_button']) assert.equal(isCanvasWidget({type,runtimeTarget:'unity'}),true)
  for (const type of ['device_label','diagnostics','line_overview_cards']) assert.equal(isCanvasWidget({type}),false)
  assert.equal(isCanvasWidget({type:'text',runtimeTarget:'unity'}),false)
  assert.equal(widgetPresentationState(widget,runtime({...factory,metadata:{hierarchyHidden:true}})).code,'view-disabled')
  assert.equal(widgetPresentationState(widget,{view:{id:'map_world',componentState:{show:[widget.id]}},context:{viewId:'map_world',viewMode:'custom'},policy:{enabled:{map_world:false}}}).code,'view-disabled')
  assert.equal(widgetPresentationState(widget,runtime({...factory,metadata:{hierarchyHidden:true,runtimeHidden:false}})).visible,true) // runtime rescue prevents a blank scene
})

test('designer status, preview, maps and native HUD consume the shared evaluator, without removing root hiding', async () => {
  const source=async path=>readFile(new URL(path,import.meta.url),'utf8')
  for (const file of ['../src/views/admin/components/DashboardDesigner.vue','../src/views/DashboardOverlay.vue','../src/views/MapSurfaceWidgets.vue']) assert.match(await source(file),/widgetPresentationState\(/)
  const overlay=await source('../src/views/DashboardOverlay.vue')
  assert.match(overlay,/canNavigateToParentView = computed\(\(\) => returnNavigationVisibility/)
  assert.match(overlay,/v-if="canReturnToParentView"/)
  const designer=await source('../src/views/admin/components/DashboardDesigner.vue')
  assert.match(designer,/aria-label="组件大屏显隐"/)
  assert.match(designer,/aria-label="组件显隐范围"/)
  assert.match(designer,/data-component-id="widget.id"/)
  assert.match(designer,/!previewMode.value \|\| componentDisplayStates.value\[widget.id\].visible/)
})
