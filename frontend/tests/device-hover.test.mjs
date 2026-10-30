import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDeviceTooltip, normalizeViewTooltipMetadata } from '../../shared/deviceTooltip.mjs'
import { normalizeDashboardDocument } from '../src/runtime/dashboardSchema.js'
import { tooltipDevices, applyDeviceHover, deviceHoverDetails } from '../src/runtime/deviceHover.js'
const devices = tooltipDevices([{ id:'w', name:'井式炉车间', devices:[{ id:'aux',name:'直属设备' }], lines:[{id:'l',name:'井式炉',devices:[{id:'one', name:'井式炉1',model_type:'pit',dataPoints:[{id:'p',category:'analog',value_role:'temperature',name:'温度',unit:'°C'}]}]}] }],[{id:'pit',name:'井式炉模型'}])
const context = () => ({factoryId:'xian',viewId:'workshop_overview',viewMode:'workshop',workshopId:'w',lineId:'',sceneReady:true})
const hover = {factoryId:'xian',viewId:'workshop_overview',hoveredDeviceId:'one',deviceHoverPointer:{x:.8,y:.9,visible:true}}
test('tooltip settings preserve explicit off and independent per-view display fields through schema roundtrips', () => {
    assert.equal(normalizeDeviceTooltip().enabled,true)
    assert.deepEqual(normalizeDeviceTooltip({enabled:false,fields:['name','secret','name'],pointKeys:['analog.temperature','password','analog.temperature']}).fields,['name'])
    const document=normalizeDashboardDocument({scene:{views:[{id:'a',mode:'workshop',metadata:{deviceTooltip:{enabled:false,fields:[]},other:'keep'}},{id:'b',mode:'line',metadata:{deviceTooltip:{fields:['id','line'],title:'自定义',pointKeys:['analog.temperature']}}}]}})
    const again=normalizeDashboardDocument(JSON.parse(JSON.stringify(document)))
    assert.equal(again.scene.views[0].metadata.deviceTooltip.enabled,false)
    assert.deepEqual(again.scene.views[0].metadata.deviceTooltip.fields,[])
    assert.equal(again.scene.views[0].metadata.other,'keep')
    assert.deepEqual(again.scene.views[1].metadata.deviceTooltip.fields,['id','line'])
    assert.deepEqual(normalizeViewTooltipMetadata({inspectionStage:'solid'}),{inspectionStage:'solid'})
})
test('device hover rejects stale factory, view, unknown and out of scope identities; accepts immediate leave and workshop-owned devices', () => {
    const state=context()
    for(const payload of [{...hover,factoryId:'tianjin'},{...hover,viewId:'old'},{...hover,hoveredDeviceId:'missing'},{...hover,deviceHoverPointer:{x:NaN,y:.5,visible:true}}])assert.equal(applyDeviceHover(state,payload,devices),false)
    assert.equal(applyDeviceHover({...state,lineId:'elsewhere'},hover,devices),false)
    assert.equal(applyDeviceHover({...state,viewMode:'device'},hover,devices),false)
    assert.equal(applyDeviceHover({...state,sceneReady:false},hover,devices),false)
    assert.equal(applyDeviceHover(state,hover,devices),true)
    assert.equal(state.hoveredDeviceId,'one')
    assert.equal(applyDeviceHover(state,{...hover,hoveredDeviceId:'aux'},devices),true)
    assert.equal(applyDeviceHover(state,{...hover,hoveredDeviceId:''},devices),true)
    assert.equal(state.hoveredDeviceId,'')
})
test('default card shows identity; custom fields, disabled view, scoped realtime values and small viewport placement work', () => {
    const state=context();applyDeviceHover(state,hover,devices)
    const standard=deviceHoverDetails(state,{},devices)
    assert.equal(standard.name,'井式炉1')
    assert.equal(standard.rows.find(row=>row.key==='workshop').value,'井式炉车间')
    assert.equal(deviceHoverDetails(state,{metadata:{deviceTooltip:{enabled:false}}},devices),null)
    const view={metadata:{deviceTooltip:{title:'设备',fields:['id','model'],pointKeys:['analog.temperature'],showHint:false}}}
    const custom=deviceHoverDetails(state,view,devices,{one:{quality:'stale',lastSeen:1}},{one:{analog:{temperature:876},quality:{analog:{temperature:'stale'}}},other:{analog:{temperature:999}}},{width:800,height:450})
    assert.equal(custom.name,'');assert.equal(custom.showHint,false)
    assert.equal(custom.rows[1].value,'井式炉模型')
    assert.equal(custom.rows[2].value,'876 °C');assert.equal(custom.rows[2].quality,'已过期')
    assert.ok(parseFloat(custom.style.top)<300)
    assert.equal(deviceHoverDetails(state,view,devices,{}, {other:{analog:{temperature:999}}}).rows.at(-1).value,'暂无实时值')
})
