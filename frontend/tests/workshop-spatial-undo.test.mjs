import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { computed, ref } from 'vue'
import { normalizeWorkshopLayout } from '../src/utils/spatialLayout.js'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const body = panel.slice(panel.indexOf('const workshopSpatialDirty = computed('), panel.indexOf('async function loadWorkshops()'))
function fixture() {
  const baseline = normalizeWorkshopLayout(null), selectedWorkshopEditor = ref({ id: 'a', layout: structuredClone(baseline) })
  const savedWorkshopLayoutSnapshots = ref({ a: JSON.stringify(baseline) }), workshopSavingId = ref(''), calls = []
  const deps = { computed, selectedWorkshopEditor, savedWorkshopLayoutSnapshots, workshopSavingId, normalizeWorkshopLayout,
    getWorkshopLayout: workshop => workshop.layout, restoreSavedNativeScenePreview: async () => calls.push('reset') }
  const editor = new Function(...Object.keys(deps), `${body};return { workshopSpatialDirty, resetWorkshopSpatialPreview }`)(...Object.values(deps))
  return { ...deps, ...editor, baseline, calls }
}

test('clean, unloaded and numerically unchanged workshop layouts have nothing to undo', async () => {
  const f = fixture()
  assert.equal(f.workshopSpatialDirty.value, false)
  await f.resetWorkshopSpatialPreview(); assert.deepEqual(f.calls, [])
  f.selectedWorkshopEditor.value.layout.transform.x = '0'
  assert.equal(f.workshopSpatialDirty.value, false)
  f.selectedWorkshopEditor.value = { id: 'not-loaded', layout: normalizeWorkshopLayout(null) }
  assert.equal(f.workshopSpatialDirty.value, false)
  f.selectedWorkshopEditor.value = null
  assert.equal(f.workshopSpatialDirty.value, false)
})

for (const [group, field, value] of [['transform','x',2],['transform','y',1],['transform','z',3],['transform','rotationY',25],
  ['size','width',240],['size','depth',130],['size','height',15],['boundary','enabled',false]]) test(`undo follows ${group}.${field} and restores both the form and preview`, async () => {
  const f = fixture(), other = { id: 'b', layout: normalizeWorkshopLayout({ transform: { x: 70 } }) }, otherBefore = JSON.stringify(other)
  f.selectedWorkshopEditor.value.layout[group][field] = value
  assert.equal(f.workshopSpatialDirty.value, true)
  await f.resetWorkshopSpatialPreview()
  assert.equal(f.workshopSpatialDirty.value, false)
  assert.deepEqual(f.selectedWorkshopEditor.value.layout, f.baseline)
  assert.deepEqual(JSON.parse(f.selectedWorkshopEditor.value.layout_json), f.baseline)
  assert.deepEqual(f.calls, ['reset'])
  assert.equal(JSON.stringify(other), otherBefore, 'unrelated workshop drafts must remain untouched')
  await f.resetWorkshopSpatialPreview(); assert.deepEqual(f.calls, ['reset'], 'repeated clean undo must be a no-op')
})

test('manual revert, successful save and selected-workshop changes recompute undo availability', () => {
  const f = fixture(), record = f.selectedWorkshopEditor.value
  record.layout.transform.x = 4; assert.equal(f.workshopSpatialDirty.value, true)
  record.layout.transform.x = 0; assert.equal(f.workshopSpatialDirty.value, false)
  record.layout.transform.x = 5; assert.equal(f.workshopSpatialDirty.value, true)
  f.savedWorkshopLayoutSnapshots.value.a = JSON.stringify(normalizeWorkshopLayout(record.layout))
  assert.equal(f.workshopSpatialDirty.value, false, 'successful saves establish the new clean baseline')
  f.savedWorkshopLayoutSnapshots.value.b = JSON.stringify(normalizeWorkshopLayout(null))
  f.selectedWorkshopEditor.value = { id: 'b', layout: normalizeWorkshopLayout(null) }
  assert.equal(f.workshopSpatialDirty.value, false)
  f.selectedWorkshopEditor.value = record; assert.equal(f.workshopSpatialDirty.value, false)
})

test('saving blocks programmatic undo and the actual button is disabled and grey when clean', async () => {
  const f = fixture(); f.selectedWorkshopEditor.value.layout.transform.x = 5; f.workshopSavingId.value = 'a'
  await f.resetWorkshopSpatialPreview(); assert.deepEqual(f.calls, []); assert.equal(f.workshopSpatialDirty.value, true)
  const space = panel.slice(panel.indexOf('<template v-else-if="workshopManagementStep === \'space\' && selectedWorkshopEditor">'), panel.indexOf('<template v-else-if="selectedWorkshopEditor">'))
  assert.match(space, /:disabled="!workshopSpatialDirty \|\| workshopSavingId === selectedWorkshopEditor.id" @click="resetWorkshopSpatialPreview"/)
  const css = await readFile(new URL('../src/views/admin/styles/form-controls.css', import.meta.url), 'utf8')
  assert.match(css, /\.btn:disabled\s*\{[^}]*color: #a1a1a6;[^}]*cursor: not-allowed/)
})
