import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate, compileStyle } from 'vue/compiler-sfc'
const file = new URL('../src/views/admin/components/ModelAssetTransfer.vue', import.meta.url)
const source = await readFile(file, 'utf8')
const labelBody = source.slice(source.indexOf('function effectLabel('), source.indexOf('</script>'))
const label = new Function(`${labelBody}; return effectLabel`)()

test('compact import preview distinguishes creation, reuse and verified action updates', () => {
  assert.equal(label(null), '')
  assert.equal(label({ importDecision: { kind: 'create' } }), '新建模型')
  assert.equal(label({ importDecision: { kind: 'reuse', targetName: '炉 A' } }), '复用「炉 A」')
  assert.match(label({ importDecision: { kind: 'update_actions', targetName: '炉 A', bindingCount: 3 } }), /更新「炉 A」.*3 项/)
  assert.match(label({ importDecision: { kind: 'update_actions', targetName: '共享炉', bindingCount: 4, shared: true } }), /共享模型/)
  assert.match(source, /未选择内容与现场绑定保持不变/)
  assert.doesNotMatch(source, /导入为新模型，保留现有模型/)
})

test('legacy same-source updates enter selective merge while updating collections cannot be silently applied', () => {
  assert.match(source, /legacyUpdate = preview\.importDecision\?\.kind === 'update_actions'/)
  assert.match(source, /operation\.value = 'update'[\s\S]*updateTargetId\.value = legacyUpdate \? preview\.importDecision\.targetId/)
  assert.match(source, /updateModules\.value =[\s\S]*\['actions'\]/)
  assert.match(source, /batchGuard\.value = '已有模型请单独补充更新'/)
  assert.match(source, /readyImports = computed\(\(\) => batchGuard\.value \? \[\]/)
  assert.match(source, /form\.append\('importPlan',[\s\S]*models\.map\(item => item\.importDecision\)/)
})

test('update request sends the target plan separately from the old importer plan and rejects stale verification', async () => {
  const body = source.slice(source.indexOf('async function request('), source.indexOf('async function choose('))
  const operation = { value: 'update' }, options = { targetId: 'asset_a', modules: ['actions'], replaceActionIds: ['door'] }
  const row = { file: new Blob(['zip']), requestId: 'REQUEST_ID', checked: { inspectedSha256: 'HASH', updatePlan: { targetId: 'asset_a', revision: 'REVISION', planHash: 'PLAN' } } }
  const captured = [], scopeChecks = []
  const request = new Function('assertScope', 'controller', 'operation', 'currentOptions', 'adminFetch', 'API_BASE', 'headers', `${body};return request`)(
    () => scopeChecks.push(true), null, operation, { value: options }, async (url, init) => { captured.push({ url, init }); return { ok: true, json: async () => ({ success: true }) } }, '/api', () => ({ 'X-Factory-ID': 'factory_a' })
  )
  await request('import', row)
  const form = captured[0].init.body
  assert.deepEqual(JSON.parse(form.get('updateOptions')), options)
  assert.deepEqual(JSON.parse(form.get('updatePlan')), row.checked.updatePlan)
  assert.equal(form.get('importPlan'), null)
  assert.equal(form.get('inspectedSha256'), 'HASH')
  assert.equal(captured[0].init.headers['X-Asset-Request-ID'], row.requestId)
  assert.equal(captured[0].init.headers['X-Factory-ID'], 'factory_a')
  assert.equal(scopeChecks.length, 2, 'factory scope is verified before and after the async response')
  const stale = new Function('assertScope', 'controller', 'operation', 'currentOptions', 'adminFetch', 'API_BASE', 'headers', `${body};return request`)(
    () => {}, null, operation, { value: options }, async () => ({ ok: false, json: async () => ({ success: false, code: 'IMPORT_PLAN_STALE', error: '请重新检查' }) }), '/api', () => ({})
  )
  await assert.rejects(stale('import', row), /请重新检查/)
  assert.equal(row.checked, null)
})

test('rechecking a changed selection rotates its receipt and invalidates failed checks', () => {
  assert.match(source, /row\.inspectedOptions = ''/)
  assert.match(source, /row\.requestId = crypto\.randomUUID\(\)/)
  assert.match(source, /row\.checked = null; row\.status = 'error'/)
  assert.match(source, /@click="recheck\(row\)"/)
  assert.match(source, /row\.actionChoices = uniqueActions\(/, 'unselected actions remain available after checking a subset')
})

test('asset transfer template and its external styles compile in Vue', async () => {
  const { descriptor, errors } = parse(source, { filename: file.pathname })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'model-asset-import-plan' })
  const template = compileTemplate({ source: descriptor.template.content, filename: file.pathname, id: 'model-asset-import-plan', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  for (const style of descriptor.styles) {
    const content = style.src ? await readFile(new URL(style.src, file), 'utf8') : style.content
    assert.deepEqual(compileStyle({ source: content, id: 'model-asset-import-plan', scoped: true }).errors, [])
  }
})
