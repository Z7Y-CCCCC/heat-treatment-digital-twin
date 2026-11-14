import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parse } from 'vue/compiler-sfc'
import { normalizeLoadingPorts, normalizeLoadingPortOverrides, resolveLoadingPort } from '../../shared/loadingPorts.mjs'
import { prepareLoadingAlignment } from '../src/views/admin/utils/loadingAlignment.js'

// No server, commissioned database, Unity client, collector or asset write is used.
const require = createRequire(import.meta.url)
const cjs = require('../../shared/loadingPorts.cjs')
const { normalizeModelMetadata, stringifyModelMetadata } = require('../../backend/services/modelAssetMetadata.js')
const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const { descriptor, errors } = parse(panel)
assert.deepEqual(errors, [])
const script = descriptor.scriptSetup.content
const stepsExpression = script.match(/const MODEL_LIBRARY_STEPS = (\[[\s\S]*?\n\])/)
assert.ok(stepsExpression, 'model workflow steps must remain discoverable')
const steps = new Function(`return (${stepsExpression[1]})`)()
const navigation = script.slice(script.indexOf('function modelLibraryStepRequiresModel('), script.indexOf('async function loadModels('))
assert.match(navigation, /^function modelLibraryStepRequiresModel\(/)

const empty = () => ({ version: 1, inlet: null, outlet: null })
const configured = () => ({ version: 1, inlet: { position: [0, 1.25, 2], direction: [0, 0, 1], nodeName: 'mouth' }, outlet: null })

function modelWorkflow({ metadata, canLeave = async () => true, editor = true } = {}) {
  const state = {
    modelNameSaving: { value: false }, modelUploading: { value: false },
    activePreviewModel: { value: { id: 'ordinary-model', metadata } },
    activePreviewIsEnvironment: { value: false },
    modelLoadingPortRef: { value: editor ? { canLeave } : null },
    modelLibraryStep: { value: 'ports' }
  }
  const calls = []
  const dependencies = {
    ...state, MODEL_LIBRARY_STEPS: steps,
    nextTick: async () => { calls.push('tick') },
    disposeModelPreview: () => { calls.push('dispose') },
    renderSelectedModelPreview: async () => { calls.push('render') }
  }
  const functions = new Function(...Object.keys(dependencies), `${navigation}; return { modelLibraryStepAvailable, selectModelLibraryStep }`)(...Object.values(dependencies))
  return { ...functions, state, calls }
}

test('null or omitted shared ports are valid empty configuration, never an invented origin', () => {
  for (const api of [{ normalizeLoadingPorts, normalizeLoadingPortOverrides, resolveLoadingPort }, cjs]) {
    for (const value of [undefined, null, empty(), JSON.stringify(empty())]) {
      assert.deepEqual(api.normalizeLoadingPorts(value), empty())
      assert.deepEqual(api.normalizeLoadingPortOverrides(value), empty())
    }
    for (const metadata of [undefined, {}, { loadingPorts: null }, { loadingPorts: empty() }]) {
      const model = { id: 'ordinary-model', metadata }
      assert.equal(api.resolveLoadingPort(model, null, 'inlet'), null)
      assert.equal(api.resolveLoadingPort(model, null, 'outlet'), null)
    }
    const oldOverride = { instance_config: { loadingPortOverrides: { ...empty(), inlet: { offset: [1, 2, 3], yawDegrees: 45 } } } }
    assert.equal(api.resolveLoadingPort({ metadata: { loadingPorts: empty() } }, oldOverride), null, 'a stale instance offset cannot create an unconfigured model port')
  }
})

test('ordinary model defaults and serialization do not require or create ports', () => {
  for (const input of [undefined, null, {}, { description: 'ordinary static machine' }, '{"description":"ordinary static machine"}']) {
    const before = input && typeof input === 'object' ? structuredClone(input) : input
    const normalized = normalizeModelMetadata(input, { name: '普通设备' })
    const serialized = JSON.parse(stringifyModelMetadata(input, { name: '普通设备' }))
    assert.equal(Object.hasOwn(normalized, 'loadingPorts'), false)
    assert.equal(Object.hasOwn(serialized, 'loadingPorts'), false)
    assert.equal(normalized.assetSpec.device_family, '普通设备')
    assert.deepEqual(input, before, 'normalization must not mutate the caller model metadata')
  }
  for (const loadingPorts of [null, empty()]) {
    const normalized = normalizeModelMetadata({ description: 'keep', loadingPorts })
    assert.deepEqual(normalized.loadingPorts, empty())
    assert.equal(normalized.description, 'keep')
  }
  assert.throws(() => stringifyModelMetadata({ loadingPorts: { version: 1, inlet: null } }), /缺少字段/, 'optional must not weaken validation of an explicitly malformed configuration')
})

test('port workflow stays optional without the removed banner or skip button', () => {
  assert.equal(steps.find(step => step.key === 'ports')?.optional, true)
  assert.doesNotMatch(panel, /loading-port-optional-step|跳过进出料口配置|仅用于进出料动画对齐；/)
  for (const metadata of [undefined, {}, { loadingPorts: null }, { loadingPorts: empty() }]) {
    const workflow = modelWorkflow({ metadata })
    for (const step of steps) assert.equal(workflow.modelLibraryStepAvailable(step.key), true, `${step.key} must not depend on configured port completion`)
    workflow.state.activePreviewModel.value = null
    assert.equal(workflow.modelLibraryStepAvailable('library'), true)
    assert.equal(workflow.modelLibraryStepAvailable('ports'), false, 'selecting a model is still a real prerequisite')
  }
})

test('skipping an untouched empty port configuration reuses the normal leave guard without saving or manufacturing a point', async () => {
  let leaves = 0
  const workflow = modelWorkflow({ metadata: {}, canLeave: async () => { leaves++; return true } })
  const before = structuredClone(workflow.state.activePreviewModel.value)
  await workflow.selectModelLibraryStep('library')
  assert.equal(leaves, 1)
  assert.equal(workflow.state.modelLibraryStep.value, 'library')
  assert.deepEqual(workflow.calls, ['tick', 'render'])
  assert.deepEqual(workflow.state.activePreviewModel.value, before)

  await workflow.selectModelLibraryStep('inspection')
  assert.equal(workflow.state.modelLibraryStep.value, 'library', 'removed structure step cannot be reopened')
  assert.equal(leaves, 1, 'removed steps do not even start navigation')

  const declined = modelWorkflow({ canLeave: async () => false })
  await declined.selectModelLibraryStep('library')
  assert.equal(declined.state.modelLibraryStep.value, 'ports', 'a dirty draft still requires explicit save/discard approval')
  assert.deepEqual(declined.calls, [])

  const ordinary = modelWorkflow({ editor: false })
  ordinary.state.modelLibraryStep.value = 'ports'
  await ordinary.selectModelLibraryStep('library')
  assert.equal(ordinary.state.modelLibraryStep.value, 'library', 'ordinary browsing must not open or save the optional editor')
})

function alignmentFixture(mode, loadingPorts, kind) {
  const layout = { version: 1, lanes: [{ id: 'lane', name: '设备线', offsetZ: -4, length: 30 }], rails: [{ id: 'rail', name: '导轨', offsetZ: 0, length: 30 }] }
  const devices = ['configured', 'unconfigured'].map((id, index) => ({
    id, name: id === 'unconfigured' ? '未配置设备' : '已配置设备', line_id: 'line',
    model_type: id, model_file: '', coordinate_space: 'line_local', pos_x: index * 5,
    pos_y: index / 10, pos_z: -4 - index, rotation_y: 0, scale: 1,
    instance_config: JSON.stringify({ laneId: 'lane', preserved: true })
  }))
  const good = configured()
  good.outlet = structuredClone(good.inlet)
  return {
    line: { id: 'line', workshop_id: 'workshop', layout_json: JSON.stringify(layout) }, layout, devices,
    models: [{ id: 'configured', file_path: '/assets/good.glb', default_scale: 1, metadata: { loadingPorts: good } },
      { id: 'unconfigured', file_path: '/assets/missing-port.glb', default_scale: 1, metadata: { loadingPorts } }],
    mode, scope: 'lane', laneId: 'lane', selectedIds: [], referenceId: 'configured', portKind: kind
  }
}

test('actively aligning an explicitly unconfigured port reports the device and never produces a position-write plan', async () => {
  let loads = 0
  for (const mode of ['faces', 'heights']) {
    for (const kind of ['inlet', 'outlet']) {
      for (const loadingPorts of [null, empty()]) {
        const input = alignmentFixture(mode, loadingPorts, kind), before = structuredClone(input)
        await assert.rejects(() => prepareLoadingAlignment(input, { load: async () => { loads++; throw Error('must not infer an explicitly empty port') } }), /「未配置设备」.*未配置.*未移动设备/)
        assert.deepEqual(input, before, 'even the previously measured configured peer and original layout remain unchanged')
      }
    }
  }
  assert.equal(loads, 0, 'explicit null does not invoke legacy geometry fallback')
})

test('existing acceptance and publishing checks do not introduce a mandatory port-calibration gate', async () => {
  const sources = await Promise.all([
    '../../backend/routes/acceptanceReport.js',
    '../../backend/services/dashboardDocuments.js',
    '../../backend/services/projectBundle.js',
    '../src/views/admin/components/AdminHelpGuide.vue'
  ].map(file => readFile(new URL(file, import.meta.url), 'utf8')))
  for (const source of sources) assert.doesNotMatch(source, /(?:require|validate|check|mandatory|必填|必须)[^\n]*(?:loadingPorts|loadingPortOverrides)/i)
  const configurationChecks = sources[0].match(/const configurationChecks = (\[[^\n]+\])/)
  assert.ok(configurationChecks)
  const checks = new Function(`return ${configurationChecks[1]}`)()
  assert.ok(checks.includes('deviceConfiguration'), 'the ordinary device-existence check remains active')
  assert.equal(checks.some(check => /loading|port|进料|出料/i.test(check)), false)
})
