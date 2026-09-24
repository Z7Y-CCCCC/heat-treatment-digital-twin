import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFactoryHudModules } from '../src/runtime/factoryHudModules.js'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'

function fixture() {
  const widgets = ['overview_metrics','running_devices','alarm_history','temperature_trend'].map((id,index) => ({ id, type:'container', visible:true, frame:{ x:1400, y:100+index*220, width:400, height:200 }, style:{ backgroundOpacity:.17 } }))
  widgets.push({ id:'cfg_overview_temp_chart', type:'trend', frame:{ x:20,y:800,width:500,height:200 }, data:{ mode:'plc',deviceId:'Furnace_01',pointId:'temperature',unit:'°C',readOnly:true }, content:{ timeField:'time',valueField:'value' }, events:[] })
  widgets.push({ id:'cfg_device_Furnace_01',type:'text', visibility:{viewIds:['factory_overview','workshop_overview']},events:[{trigger:'click',action:'switch_view',viewId:'device_detail',deviceId:'Furnace_01'}] })
  return normalizeDashboardDocument({ canvas:{width:1920,height:1080}, metadata:{referenceHud:1}, widgets })
}

test('factory module migration is non-mutating, idempotent and restricted to shipped layout', () => {
  const source = fixture(), before=JSON.stringify(source)
  const result = applyFactoryHudModules(source)
  assert.equal(JSON.stringify(source),before)
  assert.equal(result.widgets.length,source.widgets.length+4)
  assert.equal(applyFactoryHudModules(result),result)
  assert.deepEqual(result.widgets.slice(0,source.widgets.length),source.widgets)
  assert.equal(applyFactoryHudModules({...source,metadata:{}}).widgets,source.widgets)
  assert.deepEqual(result.scene.views.find(v=>v.id==='workshop_overview'),source.scene.views.find(v=>v.id==='workshop_overview'))
})

test('factory module migration retains point bindings, navigation events and panel alpha', () => {
  const source=fixture(), result=applyFactoryHudModules(source)
  const trend=result.widgets.find(w=>w.type==='hud_chart_dock')
  assert.deepEqual(trend.data,source.widgets.find(w=>w.id==='cfg_overview_temp_chart').data)
  assert.equal(trend.style.backgroundOpacity,.17)
  assert.equal(trend.content.showTitle,true)
  assert.deepEqual(result.widgets.find(w=>w.type==='hud_device_status').content.deviceActions.Furnace_01,source.widgets.find(w=>w.id==='cfg_device_Furnace_01').events)
  const view=result.scene.views.find(v=>v.id==='factory_overview')
  assert.ok(view.componentState.hide.includes('cfg_overview_temp_chart'))
  assert.ok(!view.componentState.hide.includes(trend.id))
})

test('factory migration honors hidden authored panels and explicit component allowlists', () => {
  const source=fixture(), view=source.scene.views.find(v=>v.id==='factory_overview')
  view.componentState={show:['overview_metrics','running_devices'],hide:['running_devices']}
  const result=applyFactoryHudModules(source), state=result.scene.views.find(v=>v.id===view.id).componentState
  assert.ok(state.show.includes('reference_hud_factory_kpi'))
  assert.ok(state.hide.includes('reference_hud_factory_devices'))
  assert.ok(state.hide.includes('reference_hud_factory_trend'))
  assert.ok(!state.show.includes('overview_metrics'))
})

test('consumption module retains authored static examples instead of literal value placeholders', () => {
  const source=fixture()
  source.widgets.push({id:'line_monitor',type:'container',frame:{x:1078,y:822,width:438,height:206}},
    {id:'cfg_usage_ammonia_value',content:{text:'{value}',value:'126.8 Nm³'},data:{mode:'static'}},
    {id:'cfg_usage_methanol_value',content:{text:'{value}',value:'84.6 L'},data:{mode:'static'}})
  const result=applyFactoryHudModules(source)
  assert.deepEqual(result.widgets.find(w=>w.id==='reference_hud_factory_consumption').content.items.map(item=>item.value),['126.8 Nm³','84.6 L'])
})
