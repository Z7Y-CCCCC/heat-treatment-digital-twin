import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectionHoverDetails, inspectionPointText } from '../src/runtime/inspectionHover.js'

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
