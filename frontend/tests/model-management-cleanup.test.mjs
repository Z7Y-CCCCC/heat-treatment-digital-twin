import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { adminNavPages, ADMIN_PAGES } from '../../shared/adminPages.mjs'

const panel = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
const transfer = await readFile(new URL('../src/views/admin/components/ModelAssetTransfer.vue', import.meta.url), 'utf8')

test('model management removes acceptance and delivery state but retains inspection, bindings and layout', () => {
  const steps = panel.slice(panel.indexOf('const MODEL_LIBRARY_STEPS = ['), panel.indexOf('const modelLibraryStep = ref('))
  assert.deepEqual([...steps.matchAll(/key: '([^']+)'/g)].map(m => m[1]), ['library', 'ports', 'inspection', 'bindings'])
  assert.doesNotMatch(panel, /优化与验收|交付状态|提交待验收|发布模型|modelAcceptance|makeAcceptanceSnapshot|delivery_status/)
  assert.match(panel, /MODEL_LIBRARY_STEPS.some\(step => step.key === storedAdminUiState.modelLibraryStep\)/)
  assert.match(panel, /<ModelInspectionEditor/)
  assert.match(panel, /<ManualDisassemblyLayout/)
  assert.match(panel, /modelLibraryStep === 'inspection'/)
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
