import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const dialog = await readFile(new URL('../src/views/admin/components/LoadingAlignmentDialog.vue', import.meta.url), 'utf8')
const browser = await readFile(new URL('../src/views/admin/components/DeviceManagementBrowser.vue', import.meta.url), 'utf8')
const panelTemplate = parse(panel).descriptor.template.ast
const elements = []
function collectElements(node, parent = null) {
  if (node.type === 1) elements.push({ node, parent })
  for (const child of node.children || []) collectElements(child, node)
}
collectElements(panelTemplate)
const attribute = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content
const directive = (node, name, arg) => node.props.find(prop => prop.type === 7 && prop.name === name && (arg == null || prop.arg?.content === arg))?.exp?.content
test('model and device loading port editors are discoverable and distinct', () => {
  assert.match(panel, /key: 'ports', label: '进出料口'/)
  const selectors = elements.filter(({ node }) => node.tag === 'select' && attribute(node, 'aria-label') === '选择进出料口模型')
  assert.equal(selectors.length, 1, 'one accessible model selector must be connected to the loading-port workspace')
  const { node: selector, parent } = selectors[0]
  assert.equal(directive(selector, 'bind', 'value'), 'selectedPreviewModelId')
  assert.equal(directive(selector, 'bind', 'disabled'), 'modelLoadingPortRef?.busy')
  assert.equal(directive(selector, 'on', 'change'), 'changeLoadingPortModel')
  assert.equal(directive(parent, 'if'), "modelLibraryStep === 'ports'")
  const option = selector.children.find(node => node.type === 1 && node.tag === 'option')
  assert.equal(directive(option, 'for'), 'model in loadingPortModelOptions')
  assert.equal(directive(option, 'bind', 'value'), 'model.id')
  const modelEditors = elements.filter(({ node }) => node.tag === 'LoadingPortWorkspace' && attribute(node, 'ref') === 'modelLoadingPortRef')
  assert.equal(modelEditors.length, 1)
  assert.equal(directive(modelEditors[0].node, 'if'), "activeTab === 'models' && modelLibraryStep === 'ports' && activePreviewModel")
  assert.equal(directive(modelEditors[0].node, 'bind', 'model'), 'activePreviewModel')
  assert.match(panel, /ref="modelLoadingPortRef"/)
  assert.match(panel, /aria-label="设备进出料口微调"/)
  assert.match(panel, /ref="deviceLoadingPortRef"[^>]*:model="loadingPortDeviceModel"[^>]*:device="loadingPortDevice"/)
  assert.match(panel, /showDeviceForm\.value\) return alert\('请先保存或取消/)
})
test('model selector keeps the previous model after declined/invalid changes and uses the guarded existing preview path', async () => {
  const selectedPreviewModelId = { value: 'old' }, loadingPortModelOptions = { value: [{ id: 'old' }, { id: 'new' }] }, calls = []
  let allow = false
  const source = panel.slice(panel.indexOf('async function changeLoadingPortModel('), panel.indexOf('function applySavedLoadingPorts('))
  assert.ok(source.startsWith('async function changeLoadingPortModel('))
  const change = new Function('loadingPortModelOptions', 'previewExistingModel', 'selectedPreviewModelId', `${source};return changeLoadingPortModel`)(
    loadingPortModelOptions, async model => { calls.push(model.id); if (allow) selectedPreviewModelId.value = model.id }, selectedPreviewModelId
  )
  const event = { target: { value: 'new' } }
  await change(event); assert.equal(event.target.value, 'old'); assert.equal(selectedPreviewModelId.value, 'old')
  event.target.value = 'removed'; await change(event); assert.equal(event.target.value, 'old'); assert.deepEqual(calls, ['new'])
  allow = true; event.target.value = 'new'; await change(event)
  assert.equal(event.target.value, 'new'); assert.equal(selectedPreviewModelId.value, 'new'); assert.deepEqual(calls, ['new', 'new'])

  const previewSource = panel.slice(panel.indexOf('async function previewExistingModel('), panel.indexOf('async function openModelLoadingPorts('))
  assert.ok(previewSource.startsWith('async function previewExistingModel('))
  assert.doesNotMatch(previewSource + source, /adminApi\.|saveDeviceLoadingPorts|saveModelLoadingPorts/)
  const selected = { value: 'old' }, guards = [], status = { value: '' }, saving = { value: false }, locked = { value: false }
  const preview = new Function('modelAssetLocked', 'modelBindingSaving', 'modelNameSaving', 'modelUploading', 'modelBindingStatus', 'selectedPreviewModelId', 'modelLoadingPortRef', `${previewSource};return previewExistingModel`)(
    locked, saving, { value: false }, { value: false }, status, selected, { value: { canLeave: async () => { guards.push('leave'); return false } } }
  )
  await preview({ id: 'new' }); assert.deepEqual(guards, ['leave']); assert.equal(selected.value, 'old')
  saving.value = true; await preview({ id: 'new' }); assert.deepEqual(guards, ['leave']); assert.equal(selected.value, 'old')
  assert.match(status.value, /正在保存模型/)
  saving.value = false; locked.value = true; await preview({ id: 'new' }); assert.deepEqual(guards, ['leave']); assert.equal(selected.value, 'old')
})
test('the shared fixed/auxiliary directory table exposes only edit and delete, not repeated loading-port shortcuts', () => {
  const tables = panel.slice(panel.indexOf('<DeviceManagementBrowser'), panel.indexOf('<DeviceModelHoverPreview'))
  assert.equal((browser.match(/<table\b/g) || []).length, 1, 'fixed and auxiliary categories share one table')
  assert.match(browser, /v-for="row in selected.rows"/)
  assert.match(browser, /<slot name="row-actions" :device="row.device"/)
  assert.match(tables, /<template #row-actions="\{ device: d \}">/)
  assert.doesNotMatch(tables + browser, /进出料口|openDeviceLoadingPorts/)
  assert.equal((tables.match(/@click="openEditDevice\(d\)"/g) || []).length, 1)
  assert.equal((tables.match(/@click="deleteDevice\(d\.id\)"/g) || []).length, 1)
  assert.match(tables, /formatPlcDeviceStatus\(d\)/)
  assert.equal((panel.match(/@click="openDeviceLoadingPorts/g) || []).length, 1, 'one contextual device inspector shortcut reuses the existing editor; no repeated table/toolbar shortcuts')
  assert.match(panel, /<LoadingPortWorkspace[^>]*modelLibraryStep === 'ports'[^>]*ref="modelLoadingPortRef"[\s\S]*?:model="activePreviewModel" :devices="devices"/)
})
test('port editors guard navigation and save or discard explicitly during a factory switch', () => {
  assert.match(panel, /modelLoadingPortRef\.value && !await modelLoadingPortRef\.value\.canLeave\(\)/)
  assert.match(panel, /deviceLoadingPortRef\.value && !await deviceLoadingPortRef\.value\.canLeave\(\)/)
  assert.match(panel, /modelLoadingPortRef\.value\?\.busy \|\| deviceLoadingPortRef\.value\?\.busy/)
  assert.match(panel, /modelLoadingPortRef\.value\.savePending\(\)/)
  assert.match(panel, /deviceLoadingPortRef\.value\.savePending\(\)/)
  assert.match(panel, /modelLoadingPortRef\.value\?\.discardPending\?\.\(\)/)
  assert.match(panel, /:confirm="confirmDeviceLoadingPorts"/)
  assert.match(panel, /if \(wasOpen\) dialog\.close\(\)/)
  assert.match(panel, /dialog\.isConnected && !dialog\.open\) dialog\.showModal\(\)/)
})
test('saved instance calibration updates the saved snapshot without overwriting a local layout draft', () => {
  const body = panel.slice(panel.indexOf('function applySavedLoadingPorts('), panel.indexOf('async function openDeviceLoadingPorts('))
  const local = { id: 'd', pos_x: 20, instance_config: '{"laneId":"local-draft","other":"keep"}' }
  const savedDeviceLayoutSnapshots = { value: {} }, models = { value: [] }, calls = []
  const update = new Function('models', 'modelPreviewModel', 'getLineDeviceById', 'parseInstanceConfig', 'patchDeviceLocally', 'savedDeviceLayoutSnapshots', 'deviceLayoutSnapshot', `${body}; return applySavedLoadingPorts`)(
    models, null, () => local, value => JSON.parse(value || '{}'), (id, patch) => calls.push({ id, patch }), savedDeviceLayoutSnapshots, row => JSON.stringify(row)
  )
  const server = { id: 'd', pos_x: 3, instance_config: JSON.stringify({ laneId: 'saved-lane', loadingPortOverrides: { version: 1, inlet: { offset: [0, .2, 0], yawDegrees: 0 }, outlet: null } }) }
  update({ device: server })
  assert.deepEqual(Object.keys(calls[0].patch), ['instance_config'])
  const merged = JSON.parse(calls[0].patch.instance_config)
  assert.equal(merged.laneId, 'local-draft')
  assert.equal(merged.other, 'keep')
  assert.deepEqual(merged.loadingPortOverrides, JSON.parse(server.instance_config).loadingPortOverrides)
  assert.equal(savedDeviceLayoutSnapshots.value.d, JSON.stringify(server))
  assert.equal(local.pos_x, 20)
})
test('alignment never uses the old immediate-save button and waits for a dedicated apply event', () => {
  assert.doesNotMatch(panel, /alignLineLoadingFaces|>进料口对齐<|measureLoadingFaces/)
  assert.doesNotMatch(panel, /@click="openLineLoadingAlignment\('faces'\)"/)
  assert.doesNotMatch(panel, /@click="openLineLoadingAlignment\('heights'\)"/)
  assert.match(panel, /<LineArrangementProposal/)
  const open = panel.slice(panel.indexOf('async function openLineLoadingAlignment('), panel.indexOf('async function applyLineLoadingAlignment('))
  assert.match(open, /lineLayoutDirty\.value/)
  assert.doesNotMatch(open, /adminApi\.|saveLineDevicePlan/)
  assert.match(panel, /@apply="applyLineLoadingAlignment"/)
  assert.match(panel, /await adminApi\.applyLoadingAlignment\(payload\)/)
  assert.match(dialog, /emit\('apply', JSON\.parse\(JSON\.stringify\(plan\.value\.payload\)\)\)/)
  assert.match(dialog, /预览不会写入数据库/)
})
test('preview invalidates on inputs/source changes and safely reclaims late model loads', () => {
  assert.match(dialog, /watch\(\[scope, laneId, portKind, referencePortKind\], invalidate\)/)
  assert.match(dialog, /watch\(sourceSignature, invalidate\)/)
  assert.match(dialog, /signature !== sourceSignature\.value/)
  assert.match(dialog, /released \|\| disposed \|\| version !== generation \|\| signal\.aborted\) \{ disposeSceneObject\(loaded\.scene\); return \}/)
  assert.match(dialog, /renderer\?\.forceContextLoss\(\)/)
  assert.doesNotMatch(dialog, /root\.add\(.*marker|asset\.add\(/)
})
for (const [name, source] of [['AdminPanel.vue', panel], ['LoadingAlignmentDialog.vue', dialog]]) {
  test(`${name} script and template compile`, () => {
    const { descriptor, errors } = parse(source, { filename: name })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: 'loading-ports-integration' })
    const template = compileTemplate({ source: descriptor.template.content, filename: name, id: 'loading-ports-integration', compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
  })
}
