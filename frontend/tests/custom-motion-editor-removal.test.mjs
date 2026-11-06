import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'

const panelUrl = new URL('../src/views/AdminPanel.vue', import.meta.url)
const panel = await readFile(panelUrl, 'utf8')
const template = panel.slice(panel.indexOf('<template>'))
const modeNav = template.match(/<nav class="motion-workspace-modes"[^>]*>([\s\S]*?)<\/nav>/)?.[1]

function workspaceFixture(initialMode = 'parts', allowLeave = true) {
  const start = panel.indexOf('async function changeMotionWorkspace(mode) {')
  const end = panel.indexOf('const modelBindingSaving = ref(', start)
  assert.ok(start >= 0 && end > start, 'workspace navigation function exists')
  const mode = { value: initialMode }
  const inlineProcess = { value: 'spray' }
  const calls = []
  const deviceLink = { value: { async canLeave() { calls.push('canLeave'); return allowLeave } } }
  const navigate = new Function(
    'motionWorkspaceMode', 'motionInlineProcess', 'deviceAnimationLinkRef',
    'disposeModelPreview', 'nextTick', 'ensureMotionModelSelection',
    `${panel.slice(start, end)}; return changeMotionWorkspace`
  )(
    mode, inlineProcess, deviceLink,
    () => calls.push('dispose'),
    async () => { calls.push('nextTick') },
    async () => { calls.push('selectModel') }
  )
  return { mode, inlineProcess, calls, navigate }
}

test('animation workspace exposes only live, part and equipment linkage modes', () => {
  assert.ok(modeNav, 'animation workspace mode navigation exists')
  const buttons = [...modeNav.matchAll(/<button\b[^>]*@click="changeMotionWorkspace\('([^']+)'\)"[^>]*>([^<]+)<\/button>/g)]
  assert.deepEqual(buttons.map(([, mode, label]) => ({ mode, label })), [
    { mode: 'live', label: '实时联动' },
    { mode: 'parts', label: '部件动作' },
    { mode: 'transfer', label: '设备联动' }
  ])
  assert.equal((modeNav.match(/<button\b/g) || []).length, 3)
  assert.doesNotMatch(modeNav, /工艺动作|authoring/)
  assert.match(template, /'配置模型部件动作。'/)
})

test('retired custom motion editor has no component dependency or navigation/save ref', async () => {
  assert.doesNotMatch(panel, /MotionActionEditor|motionActionEditorRef/)
  assert.doesNotMatch(panel, /motionWorkspaceMode(?:\.value)?\s*===?\s*['"]authoring['"]|changeMotionWorkspace\(['"]authoring['"]\)/)
  await assert.rejects(
    readFile(new URL('../src/views/admin/components/MotionActionEditor.vue', import.meta.url)),
    { code: 'ENOENT' }
  )
})

test('retired and unknown workspace modes are rejected before any state or leave-guard changes', async () => {
  for (const initialMode of ['parts', 'live', 'transfer']) {
    for (const invalidMode of ['authoring', 'unknown', '', undefined, null, 1, {}]) {
      const fixture = workspaceFixture(initialMode)
      await fixture.navigate(invalidMode)
      assert.equal(fixture.mode.value, initialMode)
      assert.equal(fixture.inlineProcess.value, 'spray')
      assert.deepEqual(fixture.calls, [])
    }
  }
})

test('allowed workspace changes still select the part model or dispose the obsolete preview', async () => {
  for (const target of ['parts', 'live', 'transfer']) {
    const fixture = workspaceFixture(target === 'parts' ? 'transfer' : 'parts')
    await fixture.navigate(target)
    assert.equal(fixture.mode.value, target)
    assert.equal(fixture.inlineProcess.value, '')
    assert.deepEqual(fixture.calls, target === 'parts' ? ['nextTick', 'selectModel'] : ['dispose'])
  }
  const denied = workspaceFixture('live', false)
  await denied.navigate('parts')
  assert.equal(denied.mode.value, 'live')
  assert.equal(denied.inlineProcess.value, 'spray')
  assert.deepEqual(denied.calls, ['canLeave'])
  const allowed = workspaceFixture('live')
  await allowed.navigate('transfer')
  assert.equal(allowed.mode.value, 'transfer')
  assert.deepEqual(allowed.calls, ['canLeave', 'dispose'])
})

test('built-in cleaner processes and CAD inline previews remain in the part-action workspace', () => {
  assert.match(panel, /import \{ CLEANER_ACTIONS, motionEntries \}/)
  assert.match(panel, /const cleanerProcessActions = CLEANER_ACTIONS/)
  assert.match(panel, /const cadPreviewActions = computed\(\(\) => cadMotionActions\(selectedPreviewModelId\.value\)\)/)
  assert.match(template, /selectedPreviewModelId === 'ultrasonic_cleaner_cad'[^>]*aria-label="清洗机工艺动作"/)
  assert.match(template, /v-for="action in cleanerProcessActions"/)
  assert.match(template, /v-for="action in cadPreviewActions"/)
  assert.match(template, /<ModelTransferSequence[^>]*:initial-stage="motionInlineProcess"[^>]*inline-preview/)
  assert.match(template, /<CadMotionPreview[^>]*:action-id="motionInlineProcess"/)
  assert.match(template, /<LineEquipmentSequence[^>]*motionWorkspaceMode === 'transfer'/)
  assert.match(template, /<DeviceAnimationLink[^>]*motionWorkspaceMode === 'live'/)
})

test('motion package transfer and persisted backend compatibility remain without custom editing requests', async () => {
  assert.match(panel, /import ModelAssetTransfer from '\.\/admin\/components\/ModelAssetTransfer\.vue'/)
  assert.equal((template.match(/<ModelAssetTransfer\b/g) || []).length, 1)
  assert.match(template, /<ModelAssetTransfer[^>]*:models="models"[^>]*@imported="loadModels"/)
  const api = await readFile(new URL('../src/config/factoryConfig.js', import.meta.url), 'utf8')
  assert.doesNotMatch(panel, /motion-authoring|getMotionActions|saveMotionActions|motion-actions/)
  assert.doesNotMatch(api, /getMotionActions|saveMotionActions|motion-actions/)
  assert.match(api, /async saveModelBindings\(/)
  const routes = await readFile(new URL('../../backend/routes/modelInspection.js', import.meta.url), 'utf8')
  assert.match(routes, /router\.get\('\/:id\/motion-actions'/)
  assert.match(routes, /router\.put\('\/:id\/motion-actions'/)
  assert.match(routes, /motion_package: compiled\.bundle/)
  const packages = await readFile(new URL('../../backend/services/builtinModels.js', import.meta.url), 'utf8')
  assert.match(packages, /function withMotionPackage\(model\)/)
  assert.match(packages, /\?\.motionAuthoring\?\.bundle/)
  assert.match(packages, /return \{ \.\.\.model, motion_package: authored \}/)
})

test('AdminPanel script and template compile without the retired editor binding', () => {
  const { descriptor, errors } = parse(panel, { filename: panelUrl.pathname })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'custom-motion-editor-removal' })
  const compiled = compileTemplate({
    source: descriptor.template.content,
    filename: panelUrl.pathname,
    id: 'custom-motion-editor-removal',
    compilerOptions: { bindingMetadata: script.bindings }
  })
  assert.deepEqual(compiled.errors, [])
  assert.doesNotMatch(script.content, /MotionActionEditor|motionActionEditorRef/)
  assert.doesNotMatch(compiled.code, /MotionActionEditor|motionActionEditorRef/)
  for (const component of ['ModelAssetTransfer', 'ModelTransferSequence', 'CadMotionPreview', 'DeviceAnimationLink', 'LineEquipmentSequence']) {
    assert.ok(Object.hasOwn(script.bindings, component), `${component} remains a compiled setup binding`)
  }
})
