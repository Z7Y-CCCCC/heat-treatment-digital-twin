import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { cadMotionActions, CAD_MOTION_PROFILES } from '../src/three/cadMotionProfiles.js'
import { isRetiredMotionAction } from '../../shared/motionActionAvailability.mjs'
import { CLEANER_ACTIONS, motionEntries } from '../src/views/admin/utils/motionEntries.js'
import { adminNavPages, ADMIN_PAGES } from '../../shared/adminPages.mjs'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const transfer = await readFile(new URL('../src/views/admin/components/ModelAssetTransfer.vue', import.meta.url), 'utf8')

test('model management keeps only assets and ports, with no structure editor anywhere in the panel', () => {
  const steps = panel.slice(panel.indexOf('const MODEL_LIBRARY_STEPS = ['), panel.indexOf('const modelLibraryStep = ref('))
  assert.deepEqual([...steps.matchAll(/key: '([^']+)'/g)].map(m => m[1]), ['library', 'ports'])
  assert.match(panel, /v-show="activeTab === 'model-animations' && modelLibraryStep === 'bindings'"/)
  assert.match(panel, /<ModelPartActionList/)
  assert.doesNotMatch(panel, /优化与验收|交付状态|提交待验收|发布模型|modelAcceptance|makeAcceptanceSnapshot|delivery_status/)
  assert.match(panel, /MODEL_LIBRARY_STEPS.some\(step => step.key === storedAdminUiState.modelLibraryStep\)/)
  assert.doesNotMatch(panel, /ModelInspectionEditor|部件结构|拆解部件|openModelDisassemblyLayout|async function saveModelInspection\(/)
  assert.match(panel, /<ManualDisassemblyLayout/)
  assert.doesNotMatch(panel, /modelLibraryStep === 'inspection'/)
  assert.match(panel, /MODEL_LIBRARY_STEPS.some\(step => step.key === modelLibraryStep.value\)/)
  assert.ok(adminNavPages('models').some(p => p.key === 'disassembly-layout'))
  assert.deepEqual(ADMIN_PAGES.find(p => p.key === 'models').actions, ['view', 'edit', 'delete'])
})

test('saving inspection or bindings preserves legacy render settings and history without generating acceptance state', () => {
  const body = panel.slice(panel.indexOf('function buildCurrentModelMetadata('), panel.indexOf('async function persistModelMetadata('))
  const build = new Function('parseModelMetadata', 'dedupeModelBindings', 'modelPartBindings', 'normalizeModelInspection', 'modelInspection', `${body}; return buildCurrentModelMetadata`)(
    m => structuredClone(m.metadata), rows => rows, { value: [{ id: 'new-binding' }] }, v => v, { enabled: true, parts: [] }
  )
  const legacy = { optimization: { mode: 'off' }, assetSpec: { delivery_status: 'released' },
    acceptance: { status: 'accepted', checked_at: 'old', checks: ['old'] }, release: { history: [{ id: 'old' }] },
    motionAuthoring: { version: 1 }, runtime: { enableGenericBindings: false, extra: true }, custom: 'preserve' }
  const updated = build({ metadata: legacy })
  for (const key of Object.keys(legacy)) assert.deepEqual(updated[key], legacy[key], key)
  assert.deepEqual(updated.partBindings, [{ id: 'new-binding' }])
  assert.equal(updated.inspection.enabled, true)
  const fresh = build({ metadata: {} })
  for (const key of ['assetSpec', 'acceptance', 'release']) assert.equal(Object.hasOwn(fresh, key), false)
})

test('motion package actions are right aligned beside mode tabs, not an import banner in model management', () => {
  const workspace = panel.slice(panel.indexOf('<div class="motion-workspace-toolbar">'), panel.indexOf('<template v-else>', panel.indexOf('<div class="motion-workspace-toolbar">')))
  assert.match(workspace, /<nav class="motion-workspace-modes"[\s\S]*<ModelAssetTransfer/)
  assert.equal((panel.match(/<ModelAssetTransfer /g) || []).length, 1)
  assert.doesNotMatch(transfer, /项目导入文件|安装包无预置|asset-toolbar|asset-transfer/)
  const actions = transfer.slice(transfer.indexOf('<div class="motion-package-actions"'), transfer.indexOf('<Teleport'))
  assert.equal((actions.match(/<button /g) || []).length, 2)
  assert.match(actions, />导入动作包<\/button>/)
  assert.match(actions, />导出动作包<\/button>/)
  assert.doesNotMatch(actions, /<select|<p>|<strong>/)
  assert.match(transfer, /\.motion-package-actions\s*\{[^}]*margin-left: auto/)
  assert.match(transfer, /<style scoped src="\.\.\/styles\/form-controls.css"/)
})

test('package dialogs keep explicit import confirmation, checksum validation and safe dismissal', () => {
  assert.match(transfer, /showModal\(\)/)
  assert.match(transfer, /@cancel.prevent="closeDialog"/)
  assert.doesNotMatch(transfer, /@click.self|@pointerout|@mouseleave/)
  assert.match(transfer, /function closeDialog\(\)\s*\{\s*if \(busy.value\) return/)
  assert.match(transfer, /inspectedSha256/)
  assert.match(transfer, /:disabled="busy \|\| !canAdminPage\('models', 'edit'\)"/)
  assert.match(transfer, /new Set\(exportIds.value\)/)
  assert.doesNotMatch(transfer, /const id = props.selectedId \|\| exportId.value/)
  assert.match(transfer, /onUnmounted\(\(\) => \{ disposed = true; controller\?\.abort\(\)/)
})

test('model asset table has no repeated loading-port shortcut, while its dedicated step and deletion remain', () => {
  const table = panel.slice(panel.indexOf('<table class="data-table model-table">'), panel.indexOf('</table>', panel.indexOf('<table class="data-table model-table">')))
  assert.doesNotMatch(table, /openModelLoadingPorts|>进出料口</)
  assert.match(table, /deleteModel\(m\.id\)/)
  assert.match(panel, /key: 'ports', label: '进出料口'/)
  assert.match(panel, /modelLibraryStep === 'ports' && activePreviewModel/)
})

for (const reused of [false, true]) test(`raw model upload selects the server's ${reused ? 'reused' : 'new'} identity and reports it truthfully`, async () => {
  const models = { value: [] }, previews = [], alerts = [], modelUploading = { value: false }
  const form = { id: 'new-request-id', name: '上传名称', placement_level: 'device', default_scale: 1, metadata: '{}' }
  const serverModel = { id: reused ? 'existing-id' : form.id, name: reused ? '已有模型' : form.name }
  const state = { modelUploading, canAdminPage: () => true, selectedModelFile: { value: new Blob(['fixture']) }, modelImportForm: form,
    alert: async (message, options) => alerts.push({ message, options }), adminApi: { uploadModel: async () => ({ success: true, reused, modelId: serverModel.id, model: serverModel }) },
    clearSelectedModelFile: () => { form.id = ''; form.name = '' }, loadModels: async () => { models.value = [serverModel] }, models,
    previewExistingModel: async (model, options) => previews.push({ model, options }), modelLibraryStep: { value: 'ports' },
    modelLevelFilter: { value: 'device' }, modelPreviewStatus: { value: '' } }
  const body = panel.slice(panel.indexOf('async function uploadModel()'), panel.indexOf('async function previewExistingModel('))
  const upload = new Function(...Object.keys(state), `${body}; return uploadModel`)(...Object.values(state))
  await upload()
  assert.equal(previews[0].model.id, serverModel.id); assert.equal(previews[0].options.afterUpload, true)
  assert.equal(modelUploading.value, false); assert.equal(state.modelLibraryStep.value, 'library')
  assert.match(alerts[0].message, reused ? /直接复用，不重复创建/ : /已上传/)
  assert.match(state.modelPreviewStatus.value, reused ? /已复用已有模型/ : /已上传/)
})

test('removed inspection and binding steps cannot be selected or mutate a model', async () => {
  const steps = [{ key: 'library' }, { key: 'ports' }], modelLibraryStep = { value: 'library' }
  const deps = { MODEL_LIBRARY_STEPS: steps, modelLibraryStep, modelNameSaving: { value: false }, modelUploading: { value: false },
    activePreviewModel: { value: { id: 'model-a' } }, activePreviewIsEnvironment: { value: false },
    modelLoadingPortRef: { value: { canLeave: () => { throw Error('removed steps must not start navigation') } } },
    nextTick: () => { throw Error('unexpected render') }, renderSelectedModelPreview: () => { throw Error('unexpected render') }, disposeModelPreview: () => {} }
  const body = panel.slice(panel.indexOf('function modelLibraryStepRequiresModel('), panel.indexOf('async function loadModels('))
  const select = new Function(...Object.keys(deps), `${body};return selectModelLibraryStep`)(...Object.values(deps))
  for (const step of ['inspection', 'bindings']) { await select(step); assert.equal(modelLibraryStep.value, 'library') }
})

test('model action column uses the animation list, including built-ins and excluding retired clips', () => {
  const body = panel.slice(panel.indexOf('function getModelActionCount('), panel.indexOf('function formatModelNodeOption('))
  const normalizeCalls = [], dedupeCalls = []
  const count = new Function('parseModelMetadata', 'dedupeModelBindings', 'normalizeModelBinding', 'cadMotionActions', 'isRetiredMotionAction', 'motionEntries', 'formatModelBindingPartName', `${body};return getModelActionCount`)(
    m => typeof m?.metadata === 'string' ? JSON.parse(m.metadata) : m?.metadata || {},
    rows => { dedupeCalls.push(rows); return [...new Map(rows.map(row => [row.id, row])).values()] },
    row => { normalizeCalls.push(row); return { ...row } }, cadMotionActions, isRetiredMotionAction, motionEntries, row => row.name || '')
  assert.match(panel, /<th>动作数<\/th>/)
  assert.match(panel, /getModelActionCount\(m\)/)
  assert.doesNotMatch(panel, /绑定数|getModelBindingCount/)
  for (const id of Object.keys(CAD_MOTION_PROFILES)) {
    const expected = motionEntries([], false, '', undefined, cadMotionActions(id).filter(a => !isRetiredMotionAction({ kind: 'clip', id: `clip:${a.id}` }))).length
    assert.equal(count({ id }), expected, id)
  }
  assert.equal(count({ id: 'ultrasonic_cleaner_cad' }), CLEANER_ACTIONS.length)
  assert.equal(count({ id: 'no-actions', metadata: { partBindings: 'invalid' } }), 0)
  const bindings = [{ id: 'door', name: '门' }, { id: 'door', name: '门重复' }, { id: 'fan', name: '风机' }]
  const model = { id: 'cad_transfer_cart_101300', metadata: JSON.stringify({ partBindings: bindings }) }
  const before = JSON.stringify(model)
  assert.equal(count(model), count({ id: model.id }) + 2, 'historical bindings use the same normalization and deduplication as the action page')
  assert.equal(JSON.stringify(model), before, 'counting is read-only')
  assert.ok(normalizeCalls.length >= 3 && dedupeCalls.some(rows => rows.length === 3))
})
