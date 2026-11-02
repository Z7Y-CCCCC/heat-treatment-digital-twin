import test from 'node:test'
import assert from 'node:assert/strict'
import { CLEANER_ACTIONS, motionEntries } from '../src/views/admin/utils/motionEntries.js'

test('six process nodes share the list without changing saved binding indexes or metadata', () => {
    const bindings = Array.from({ length: 20 }, (_, i) => Object.freeze({ id: `door_${i}`, name: `door ${i}`, source_group: 'doors', source_key: 'front_door_open' }))
    const before = JSON.stringify(bindings)
    const entries = motionEntries(bindings, true)
    assert.equal(entries.length, 26)
    assert.deepEqual(entries.slice(0, 6).map(entry => entry.process.id), CLEANER_ACTIONS.map(step => step.id))
    entries.slice(6).forEach((entry, index) => {
        assert.equal(entry.index, index)
        assert.equal(entry.binding, bindings[index])
    })
    assert.equal(JSON.stringify(bindings), before)
    assert.equal(motionEntries(bindings, false).length, 20)
})

test('search finds process names, process details and original PLC bindings', () => {
    const bindings = [{ name: '炉门', source_group: 'doors', source_key: 'front_door_open' }]
    assert.equal(motionEntries(bindings, true, '喷淋')[0].process.id, 'spray')
    assert.equal(motionEntries(bindings, true, '空化')[0].process.id, 'ultrasonic')
    assert.equal(motionEntries(bindings, true, 'FRONT_DOOR_OPEN')[0].index, 0)
    assert.equal(motionEntries(bindings, false, '喷淋').length, 0)
    assert.equal(motionEntries(bindings, true, 'missing').length, 0)
})
