import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'vue/compiler-sfc'
import { parse as parseTemplate } from '@vue/compiler-dom'
import { ASSET_MODULES, assetActionChoices, checkedActionChoices, updateOptionsFor, importReady, toggleAssetAction, assetUpdateSummary } from '../src/views/admin/utils/modelAssetTransfer.js'
const file = new URL('../src/views/admin/components/ModelAssetTransfer.vue', import.meta.url)
const source = await readFile(file, 'utf8'), descriptor = parse(source).descriptor, ast = parseTemplate(descriptor.template.content)
const all = node => [node, ...(node.children || []).flatMap(all)]
const attr = (node, name) => node.props?.find(prop => prop.type === 6 && prop.name === name)?.value?.content

test('four primary asset controls are icon-only with accessible names and keyboard tooltips', async () => {
  const group = all(ast).find(node => attr(node, 'data-testid') === 'model-asset-transfer')
  const buttons = group.children.filter(node => node.tag === 'button')
  assert.deepEqual(buttons.map(button => attr(button, 'aria-label')), ['导入模型资产', '导出模型资产', '补充更新模型资产', '模型资产版本'])
  for (const button of buttons) {
    assert.ok(button.props.some(prop => prop.type === 7 && prop.name === 'bind' && prop.arg?.content === 'title'))
    assert.equal(button.children.filter(node => node.tag === 'AssetTransferIcon').length, 1)
    assert.equal(button.children.filter(node => node.type === 2 && node.content.trim()).length, 0)
    assert.ok(button.props.some(prop => prop.type === 7 && prop.arg?.content === 'disabled'))
  }
  const icon = await readFile(new URL('../src/views/admin/components/AssetTransferIcon.vue', import.meta.url), 'utf8')
  assert.match(icon, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/)
})

test('standalone model files use the shared import entry without making a package request or locking the workspace', async () => {
  const body = source.slice(source.indexOf('async function choose('), source.indexOf('async function importAssets('))
  const events = [], file = { name: 'new-model.GLB' }
  const choose = new Function('blocked', 'canEdit', 'emit', `${body};return choose`)({ value: false }, { value: true }, (...args) => events.push(args))
  const event = { target: { files: [file], value: 'selected' } }
  await choose(event)
  assert.equal(event.target.value, '')
  assert.deepEqual(events, [['raw-file', file]])
  assert.match(source, /accept="\.zip,\.glb,\.gltf"/)
})

test('stable action choices deduplicate representations and tolerate absent historical data without mutating it', () => {
  const model = { motion_package: { actions: [{ id: 'door', label: '开门' }] }, metadata: { partBindings: [{ id: 'door', name: '开门绑定' }, { id: 'fan', name: '风机' }], motionAuthoring: { actions: [{ id: 'fan', label: '风机配方' }] } } }
  const before = JSON.stringify(model)
  assert.deepEqual(assetActionChoices(model).map(action => [action.id, action.label]), [['door', '开门'], ['fan', '风机']])
  assert.equal(JSON.stringify(model), before)
  assert.deepEqual(assetActionChoices({ metadata: '{bad json' }), [])
  assert.deepEqual(assetActionChoices({ metadata: 'null' }), [])
  assert.deepEqual(assetActionChoices({ metadata: { partBindings: 'bad', motionAuthoring: { actions: false } } }), [])
  assert.deepEqual(assetActionChoices({ metadata: { partBindings: [null, 4, false] } }), [])
  assert.deepEqual(checkedActionChoices({ updatePlan: { actions: [{ id: 'fan', label: '风机', kind: 'add' }] }, actions: [{ id: 'door' }] }).map(action => action.id), ['fan'])
})

test('only selected modules and actions are submitted, and toggling away from actions drops action-specific controls', () => {
  assert.deepEqual(updateOptionsFor('a', ['actions'], null, []), { targetId: 'a', modules: ['actions'] })
  assert.deepEqual(updateOptionsFor('a', ['inspection'], ['door'], ['door']), { targetId: 'a', modules: ['inspection'] })
  assert.deepEqual(updateOptionsFor('a', ['actions', 'inspection'], ['fan', 'fan'], ['door', 'door']), { targetId: 'a', modules: ['actions', 'inspection'], actionIds: ['fan'], replaceActionIds: ['door'] })
  const selected = toggleAssetAction(null, 'door', false, ['door', 'fan'])
  assert.deepEqual(selected, ['fan'])
  assert.deepEqual(toggleAssetAction(selected, 'door', true, ['door', 'fan']), ['fan', 'door'])
  assert.deepEqual(selected, ['fan'], 'toggling does not mutate prior selection')
})

test('changed options, unresolved conflicts and processed rows cannot pass import confirmation', () => {
  const options = updateOptionsFor('a', ['actions']), row = { status: 'ready', checked: { updatePlan: { canImport: true, conflicts: [] } }, inspectedOptions: JSON.stringify(options) }
  assert.equal(importReady(row, true, options), true)
  assert.equal(importReady(row, true, updateOptionsFor('a', ['inspection'])), false)
  assert.equal(importReady({ ...row, checked: { updatePlan: { canImport: false, conflicts: ['door'] } } }, true, options), false)
  assert.equal(importReady({ ...row, status: 'imported' }, true, options), false)
  assert.equal(importReady({ ...row, status: 'checking' }, true, options), false)
  assert.equal(importReady({ ...row, checked: null }, true, options), false)
  assert.equal(importReady({ checked: {}, status: 'ready' }), true, 'verified full import remains compatible')
})

test('update summary reports the actual selected difference rather than promising wholesale replacement', () => {
  assert.equal(assetUpdateSummary({ actions: [{ id: 'fan', kind: 'add' }, { id: 'door', kind: 'same' }], inspectionChanged: false }), '新增 1')
  assert.equal(assetUpdateSummary({ actions: [{ id: 'door', kind: 'replace' }], inspectionChanged: true }), '更新 1 · 更新布局')
  assert.equal(assetUpdateSummary({ actions: [], modelChanged: true }), '更新模型')
  assert.equal(assetUpdateSummary({ actions: [] }), '内容一致')
})

test('dialog lifecycle locks selection, busy dismissal is guarded, and dirty assets cannot be exported or overwritten', () => {
  assert.match(source, /emit\('busy-change', true\)/)
  assert.match(source, /emit\('busy-change', false\)/)
  assert.match(source, /function closeDialog\(\)\s*\{\s*if \(busy.value\) return/)
  assert.match(source, /busy.value \|\| props.disabled \|\| props.dirty/)
  assert.match(source, /props.dirty \? '请先保存当前修改'/)
  assert.match(source, /@cancel.prevent="closeDialog"/)
  assert.doesNotMatch(source, /@click.self|@pointerout|@mouseleave/)
  assert.match(source, /controller\?\.abort\(\)/)
  assert.match(source, /exportMode.value !== 'full' && exportIds.value.length !== 1/)
})

test('version restore requires an explicit selected version and submits a verified revision', () => {
  assert.match(source, /if \(blocked.value \|\| !canEdit.value \|\| !targetVersion.value\) return/)
  assert.match(source, /body:JSON.stringify\(\{revision:historyRevision.value\}\)/)
  assert.match(source, /aria-label="确认回退版本"/)
  assert.match(source, /恢复所选资产版本，现场绑定保持不变/)
  assert.match(source, /data-version-id="version.versionId\|\|version.id"/)
})


test('loading ports are a fourth independent portable module and the export UI exposes it',()=>{
  assert.equal(ASSET_MODULES.find(module=>module.id==='ports')?.label,'进出料口设置')
  assert.deepEqual(updateOptionsFor('asset',['ports'],['door'],['door']),{targetId:'asset',modules:['ports']})
  assert.equal(assetUpdateSummary({actions:[],portsChanged:true}),'更新进出料口设置')
  assert.match(source,/id:'ports',label:'仅进出料口设置'/)
  assert.match(source,/modules:\[exportMode.value\]/)
  assert.match(source,/\['inspection','ports','model'\].includes\(id\)/)
})
