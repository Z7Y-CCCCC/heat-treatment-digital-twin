import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'

const read = file => readFile(new URL(file, import.meta.url), 'utf8')
test('point device picker compiles, has accessible wrap-capable options and bounded detached popup', async () => {
  const source = await read('../src/views/admin/components/PointDeviceSelect.vue')
  const { descriptor } = parse(source)
  compileScript(descriptor, { id: 'point-device-picker' })
  assert.deepEqual(compileTemplate({ source: descriptor.template.content, filename: 'PointDeviceSelect.vue', id: 'point-device-picker' }).errors, [])
  for (const pattern of [/role="listbox"/, /role="option"/, /:aria-selected=/, /aria-label="搜索点位设备"/, /white-space:normal/, /overflow-wrap:anywhere/, /innerWidth - width - 8/, /props\.disabled/]) assert.match(source, pattern)
  const admin = await read('../src/views/AdminPanel.vue')
  assert.match(admin, /<PointDeviceSelect\s[\s\S]*?:disabled="pointsLoading \|\| pointsSaving \|\| !canAdminPage\(controlPermissionPage, 'edit'\)"/)
  assert.match(admin, /:key="pointRowKey\(p\)" :class="\{ 'is-new-point': !p\.id \}"/)
  assert.match(admin, /\.points-table tr\.is-new-point > td[\s\S]*?#42b883/)
})
test('motion-package transfer belongs to animation authoring, never scene/lighting', async () => {
  const environment = await read('../src/views/admin/components/NativeEnvironmentSettings.vue')
  assert.doesNotMatch(environment, /ModelAssetTransfer|导入动作包|导出动作包/)
  const admin = await read('../src/views/AdminPanel.vue')
  assert.equal((admin.match(/<ModelAssetTransfer\b/g) || []).length, 1)
})
test('native part hover draws an outside-only union edge, not the old six-pixel glow', async () => {
  const inspection = await read('../../unity-client/Assets/Scripts/Runtime/FactoryDashboardInspection.cs')
  const body = inspection.slice(inspection.indexOf('private void DrawInspectionHover'), inspection.indexOf('private Material EnsureHoverOutlineMaterial'))
  assert.equal((body.match(/Surface\.DrawOutline/g) || []).length, 1)
  assert.match(body, /2f\)/); assert.doesNotMatch(body, /6f\)/)
  const shader = await read('../../unity-client/Assets/Resources/RuntimeShaders/InspectionOutline.shader')
  assert.match(shader, /Name "HoveredUnionMask"/); assert.match(shader, /Name "OutsideOnlyEdge"/)
  assert.match(shader, /clip\(\.5 - center\)/); assert.doesNotMatch(shader, /Cull Front|normalCS/)
  const renderer = await read('../../unity-client/Assets/Scripts/Rendering/InspectionOutlineRenderer.cs')
  assert.match(renderer, /RenderPassEvent\.AfterRenderingTransparents/)
  assert.match(renderer, /ConfigureInput\(ScriptableRenderPassInput\.Depth\)/)
  assert.match(renderer, /_mask\?\.Release\(\)/)
})
