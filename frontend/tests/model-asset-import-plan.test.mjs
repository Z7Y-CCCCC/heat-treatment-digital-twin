import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
const file = new URL('../src/views/admin/components/ModelAssetTransfer.vue', import.meta.url)
const source = await readFile(file, 'utf8')
const labelBody = source.slice(source.indexOf('function effectLabel('), source.indexOf('</script>'))
const label = new Function(`${labelBody}; return effectLabel`)()
test('import preview explains new, reused and confirmed action updates without pretending every package creates a model', () => {
  assert.equal(label(null), '')
  assert.match(label({ importDecision: { kind: 'create' } }), /新建模型/)
  assert.match(label({ importDecision: { kind: 'reuse', targetName: '炉 A' } }), /复用「炉 A」.*不新增模型/)
  assert.match(label({ importDecision: { kind: 'update_actions', targetName: '炉 A', bindingCount: 3 } }), /更新「炉 A」.*3 项.*引用此模型的设备均生效/)
  assert.match(label({ importDecision: { kind: 'update_actions', targetName: '共享炉', bindingCount: 4, shared: true } }), /所有引用此共享模型的工厂均生效/)
  assert.doesNotMatch(source, /导入为新模型，保留现有模型/)
  assert.match(source, /动作包包含模型文件和动作/)
  assert.match(source, /保留进出料口、拆解布局、设备实例、PLC 点位和设备联动配置/)
})
test('import submits per-model confirmed plan and stale targets must be rechecked', () => {
  assert.match(source, /form\.append\('importPlan',[\s\S]*models\.map\(item => item\.importDecision\)/)
  assert.match(source, /IMPORT_PLAN_STALE[\s\S]*row\.checked = null/)
  assert.match(source, /readyImports = computed\(\(\) => rows\.value\.filter\(row => row\.checked/)
  assert.match(source, /row\.status === 'error' && !row\.checked/)
  assert.match(source, /@click="recheck\(row\)"/)
  assert.match(source, /row\.requestId = crypto\.randomUUID\(\)/)
  assert.match(source, /新建 \$\{effects[\s\S]*复用 \$\{effects[\s\S]*更新动作 \$\{effects/)
})
test('import plan component compiles in Vue', () => {
  const { descriptor, errors } = parse(source, { filename: file.pathname })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'model-asset-import-plan' })
  const template = compileTemplate({ source: descriptor.template.content, filename: file.pathname, id: 'model-asset-import-plan', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
})
