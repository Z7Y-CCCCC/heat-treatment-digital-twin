import test from 'node:test'
import assert from 'node:assert/strict'
import { applyInspectionHover, inspectionHoverDetails, inspectionPointText } from '../src/runtime/inspectionHover.js'

test('compact hover follows cursor without replacing static part metadata or waiting for context polling', () => {
    for (const stage of ['solid', 'xray', 'exploded', 'part']) {
        const context = { viewMode:'device', sceneReady:true, inspectionEnabled:true, factoryId:'pit', deviceId:'one',
            viewId:`device_${stage}`, inspectionStage:stage, inspectionParts:[{id:'shell', anchor:{visible:false}}] }
        const parts = context.inspectionParts
        const message = { factoryId:'pit', deviceId:'one',viewId:`device_${stage}`,inspectionStage:stage,
            inspectionHoveredPartId:'shell',inspectionHoverPointer:{x:.4,y:.3,visible:true} }
        assert.equal(applyInspectionHover(context,message),true)
        const first=inspectionHoverDetails(context,{},()=>null,{width:1000,height:800})
        assert.equal(first.style.left,'416.00px')
        assert.equal(first.style.top,'256.00px')
        assert.equal(context.inspectionParts,parts)
        applyInspectionHover(context,{...message,inspectionHoverPointer:{x:.6,y:.3,visible:true}})
        assert.equal(inspectionHoverDetails(context,{},()=>null,{width:1000,height:800}).style.left,'616.00px')
        applyInspectionHover(context,{...message,inspectionHoveredPartId:'',inspectionHoverPointer:{visible:false}})
        assert.equal(inspectionHoverDetails(context,{},()=>null),null)
    }
})

test('hover ignores late packets from other factories, devices, stages or views', () => {
    const context={viewMode:'device',inspectionEnabled:true,factoryId:'pit',deviceId:'one',viewId:'device_detail',inspectionStage:'solid',inspectionParts:[{id:'shell'}]}
    const message={factoryId:'pit',deviceId:'one',viewId:'device_detail',inspectionStage:'solid',inspectionHoveredPartId:'shell'}
    for(const key of ['factoryId','deviceId','viewId','inspectionStage'])assert.equal(applyInspectionHover(context,{...message,[key]:'old'}),false)
    assert.equal(applyInspectionHover(context,{...message,inspectionHoveredPartId:'unknown'}),false)
    assert.equal(applyInspectionHover({...context,sceneReady:false},message),false)
})

test('cursor callout is clamped on the right and flips above the pointer near the bottom', () => {
    const context={viewMode:'device',inspectionEnabled:true,inspectionHoveredPartId:'p',inspectionParts:[{id:'p'}],inspectionHoverPointer:{x:.99,y:.98,visible:true}}
    const result=inspectionHoverDetails(context,{},()=>null,{width:1000,height:800})
    assert.equal(result.style.left,'748.00px')
    assert.equal(result.style.transform,'translateY(-100%)')
})

test('hover details include only the actually hovered visible part and its bound readings', () => {
    const context = {
        viewMode: 'device', deviceId: 'furnace-2', inspectionEnabled: true,
        inspectionHoveredPartId: 'pump', inspectionParts: [
            { id: 'fan', name: '风扇', anchor: { x: .3, y: .3, visible: true } },
            { id: 'pump', name: '泵组', description: '循环介质', pointIds: ['speed'], pointKeys: ['motors.speed'],
                anchor: { x: .63, y: .52, visible: true } }
        ]
    }
    const reading = { id: 'speed', name: '转速', value: 1450, unit: 'rpm' }
    const result = inspectionHoverDetails(context, { 'furnace-2:speed': reading }, () => reading)
    assert.equal(result.name, '泵组')
    assert.deepEqual(result.points, [reading])
    assert.equal(result.style.left, '65.50%')
    assert.equal(inspectionPointText(result.points[0]), '1450 rpm')
})

test('unhovered, hidden and non-device parts do not create a callout', () => {
    const base = { viewMode: 'device', inspectionEnabled: true, inspectionHoveredPartId: 'motor',
        inspectionParts: [{ id: 'motor', anchor: { x: .9, y: .1, visible: false } }] }
    assert.equal(inspectionHoverDetails(base, {}, () => null), null)
    assert.equal(inspectionHoverDetails({ ...base, viewMode: 'factory' }, {}, () => null), null)
    assert.equal(inspectionHoverDetails({ ...base, inspectionHoveredPartId: '' }, {}, () => null), null)
    const visible = inspectionHoverDetails({ ...base, inspectionParts: [{ id: 'motor', anchor: { x: .9, y: .1, visible: true } }] }, {}, () => null)
    assert.equal(visible.style.left, '72.00%')
    assert.equal(visible.style.top, '14.00%')
    assert.equal(inspectionPointText({ value: null }), '暂无实时值')
})
