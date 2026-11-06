import test from 'node:test'
import assert from 'node:assert/strict'
import { designerEntryView } from '../src/runtime/designerEntryView.js'
import { GLOBAL_VIEWS } from '../../shared/viewNavigation.mjs'

const off = { enabled: Object.fromEntries(GLOBAL_VIEWS.map(view => [view.id, false])) }
const views = [...GLOBAL_VIEWS, { id: 'factory_overview' }, { id: 'workshop_overview' }, { id: 'device_view' }]
test('designer entry skips disabled maps and hidden local views without mutating authored visibility', () => {
  const source = structuredClone(views)
  source.find(view => view.id === 'factory_overview').metadata = { hierarchyHidden: true }
  const before = JSON.stringify(source)
  assert.equal(designerEntryView(source, off, ['map_world', 'factory_overview']), 'workshop_overview')
  assert.equal(designerEntryView(source, off, ['device_view']), 'device_view')
  assert.equal(JSON.stringify(source), before)
})
test('entry preserves an available previous selection and respects order when no preference remains', () => {
  assert.equal(designerEntryView(views, {}, ['map_country', 'map_world']), 'map_country')
  assert.equal(designerEntryView(views, off, ['deleted', 'map_world']), 'factory_overview')
  assert.equal(designerEntryView([{id:'a',metadata:{hierarchyOrder:2}}, {id:'b',metadata:{hierarchyOrder:1}}], off), 'b')
  assert.equal(designerEntryView([{id:'a',metadata:{runtimeHidden:true}}], off), '')
})
