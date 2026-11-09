import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { computed, ref } from 'vue'
import { cadMotionActions } from '../src/three/cadMotionProfiles.js'
import { isRetiredMotionAction } from '../../shared/motionActionAvailability.mjs'

const source = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
// Execute the actual one-line production computed declaration with Vue and the
// real action registry. No browser, desktop input, network or live draft.
const declaration = source.split(/\r?\n/).find(line => line.startsWith('const cadPreviewActions = computed('))
assert.ok(declaration)
const createActions = new Function('computed', 'cadMotionActions', 'isRetiredMotionAction', 'selectedPreviewModelId',
  declaration + '\nreturn cadPreviewActions')
const ids = actions => actions.map(action => action.id)
const model = 'cad_multipurpose_furnace_082000'

test('the actual parts-pane action list excludes the complete cycle while retaining raw package history', () => {
  const original = JSON.stringify(cadMotionActions(model)), selected = ref(model)
  const actions = createActions(computed, cadMotionActions, isRetiredMotionAction, selected)
  assert.ok(ids(cadMotionActions(model)).includes('process_cycle'))
  assert.equal(ids(actions.value).includes('process_cycle'), false)
  assert.ok(ids(actions.value).includes('door'))
  assert.ok(ids(actions.value).includes('gate'))
  assert.equal(JSON.stringify(cadMotionActions(model)), original)
  assert.match(source, /import \{ isRetiredMotionAction \} from '\.\.\/\.\.\/\.\.\/shared\/motionActionAvailability\.mjs'/)
})

test('model switches recompute the filtered list and leave every ordinary model action available', () => {
  const selected = ref(model), actions = createActions(computed, cadMotionActions, isRetiredMotionAction, selected)
  assert.equal(ids(actions.value).includes('process_cycle'), false)
  selected.value = 'cad_tempering_furnace_091300'
  assert.deepEqual(ids(actions.value), ids(cadMotionActions(selected.value)))
  selected.value = 'unknown-fixture-model'
  assert.deepEqual(actions.value, [])
  selected.value = model
  assert.equal(ids(actions.value).includes('process_cycle'), false)
})

test('parts-pane entries, counts and direct preview guards all consume the same filtered list', () => {
  const actions = createActions(computed, cadMotionActions, isRetiredMotionAction, ref(model))
  assert.equal(actions.value.length, cadMotionActions(model).length - 1)
  assert.match(source, /motionEntries\(modelPartBindings\.value, canPreviewCleanerProcesses\.value, motionBindingSearch\.value, formatModelBindingPartName, cadPreviewActions\.value\)/)
  assert.match(source, /const motionNodeCount = computed\([^\r\n]+cadPreviewActions\.value\.length/)
  assert.match(source, /const inlineCadPreview = computed\([^\r\n]+cadPreviewActions\.value\.some/)
  assert.match(source, /const cadAction = cadPreviewActions\.value\.some\(action => action\.id === id\)/)
})
