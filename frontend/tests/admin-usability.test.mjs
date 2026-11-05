import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { modelPackageActions, toggleModelSelection, runPackageQueue, MAX_PACKAGE_SELECTION } from '../src/views/admin/utils/modelPackageSelection.js'
import { ADMIN_READING_KEY, DEFAULT_TEXT_SIZE, normalizeTextSize, readTextSize, saveTextSize } from '../src/runtime/adminReadingPreferences.js'
import { normalizePagePermissions, normalizeStoredPagePermissions } from '../../shared/pagePermissions.mjs'
const source = path => readFile(new URL(path, import.meta.url), 'utf8')

test('retiring model publication preserves old stored page grants without allowing new unknown permissions', () => {
  for (const publish of [true, false]) {
    const old = { models: { view: true, edit: true, publish } }, before = structuredClone(old)
    const migrated = normalizeStoredPagePermissions(old)
    assert.deepEqual(migrated.models, { view: true, edit: true, delete: false })
    assert.deepEqual(old, before)
    assert.throws(() => normalizePagePermissions(old), /权限/)
  }
  for (const old of [{ models: { view: true, unknown: true } }, { models: { view: true, publish: 'true' } }, { users: { view: true } }]) assert.throws(() => normalizeStoredPagePermissions(old))
})

test('model options describe the same compiled and generic actions available to Unity, never invented recipe counts', () => {
  const model = { motion_package: { actions: [{ id: 'door', label: '炉门升降' }] }, metadata: JSON.stringify({ partBindings: [{ id: 'fan', name: '循环风机' }], motionAuthoring: { actions: [{ id: 'uncompiled' }] } }) }
  assert.deepEqual(modelPackageActions(model), [{ id: 'clip:door', name: '炉门升降' }, { id: 'part:fan', name: '循环风机' }])
  assert.deepEqual(modelPackageActions({ metadata: '{bad' }), [])
  assert.deepEqual(modelPackageActions({ metadata: null }), [])
  const selected = toggleModelSelection(toggleModelSelection([], 'a'), 'b')
  assert.deepEqual(selected, ['a', 'b']); assert.deepEqual(toggleModelSelection(selected, 'a'), ['b'])
  assert.throws(() => toggleModelSelection(Array.from({ length: MAX_PACKAGE_SELECTION }, (_, i) => String(i)), 'extra'), /最多/)
})

test('package batches are serial, continue after one bad file, and do not repeat successful imports', async () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }], calls = []; let active = 0, peak = 0
  const run = async row => { calls.push(row.id); peak = Math.max(peak, ++active); await new Promise(resolve => setTimeout(resolve, 1)); active--; if (row.id === 2) throw Error('bad ZIP'); row.status = 'imported'; return row.id }
  const result = await runPackageQueue(rows, run)
  assert.equal(peak, 1); assert.deepEqual(calls, [1, 2, 3]); assert.equal(result.filter(r => r.error).length, 1)
  calls.length = 0; await runPackageQueue(rows, run, { eligible: r => r.status !== 'imported' }); assert.deepEqual(calls, [2])
  calls.length = 0; await runPackageQueue(rows, run, { stopped: () => true }); assert.deepEqual(calls, [])
  const abort = Object.assign(Error('stop'), { name: 'AbortError' }); let n = 0
  await runPackageQueue(rows, async () => { n++; throw abort }); assert.equal(n, 1)
})

test('reading preferences are local, bounded and robust to unavailable/corrupted storage', () => {
  const data = new Map(), storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }
  assert.equal(readTextSize(storage), DEFAULT_TEXT_SIZE)
  assert.equal(saveTextSize(storage, 150), 150); assert.equal(readTextSize(storage), 150)
  for (const value of [-1, 0, 500, NaN, Infinity, 'bad']) assert.equal(normalizeTextSize(value), DEFAULT_TEXT_SIZE)
  assert.equal(normalizeTextSize('130'), 130); assert.equal(normalizeTextSize(127), 125)
  storage.setItem(ADMIN_READING_KEY, 'invalid'); assert.equal(readTextSize(storage), DEFAULT_TEXT_SIZE)
  const denied = { getItem() { throw Error('denied') }, setItem() { throw Error('denied') } }
  assert.equal(readTextSize(denied), DEFAULT_TEXT_SIZE); assert.equal(saveTextSize(denied, 200), 200)
})

test('removed batch arrangement leaves normal drag/multi-select/spacing and a full-width canvas with compact top configuration', async () => {
  const panel = await source('../src/views/AdminPanel.vue')
  const controls = await source('../src/views/admin/components/LinePlannerControls.vue')
  assert.doesNotMatch(panel, /LineBatchArrangement|lineBatchTargets|批量添加与排布|line-planner-steps|workshop-back-button|line-editor-float-toggle/)
  assert.match(panel, /<LinePlannerControls[\s\S]*class="line-planner-preview"/)
  assert.match(controls, /aria-label="选择编辑产线"/)
  assert.match(panel, /\.line-planner-layout\s*\{[^}]*flex-direction: column/)
  assert.match(panel, /applyLineDeviceSpacing\(true\)/); assert.match(panel, /@pointerdown="startLineDeviceDrag/)
  assert.match(panel, /key: 'space'/); assert.match(panel, /selectWorkshopManagementStep\(step.key\)/)
  await assert.rejects(access(new URL('../src/views/admin/components/LineBatchArrangement.vue', import.meta.url)))
})

test('line creation is modal, destructive actions remain permission-checked, and structure inspection never starts a drag', async () => {
  const panel = await source('../src/views/AdminPanel.vue'), controls = await source('../src/views/admin/components/LinePlannerControls.vue')
  assert.doesNotMatch(panel, /产线与轨道设置|line-configuration-panel|line-planner-editor|isLinePlannerEditorCollapsed/)
  assert.match(controls, /role="dialog" aria-modal="true"/)
  assert.doesNotMatch(controls, /@(?:mouse(?:leave|over)|click\.self)=/)
  for (const label of ['产线 ID', '产线名称', '所属车间', '管理设备线', '管理小车导轨']) assert.ok(controls.includes(label))
  assert.match(controls, /canAdminPage\('lines', 'delete'\)/)
  assert.match(controls, /aria-label="`删除产线 \$\{line.name\}`"/)
  assert.match(controls, /emit\('focus-item', \{ type, id \}\)/)
  const focus = panel.slice(panel.indexOf('async function focusLineStructure'), panel.indexOf('function toggleLineDevicePool'))
  assert.match(focus, /scrollIntoView/); assert.match(focus, /focus\(\{ preventScroll: true \}\)/)
  assert.doesNotMatch(focus, /adminApi\.|touchLineLayout|startLinePreviewDrag/)
  assert.match(panel, /'is-selected': selectedLineStructure/)
})

test('admin font scale and file-picker styling are scoped to UI and do not scale canvas coordinates or published HUD text', async () => {
  const panel = await source('../src/views/AdminPanel.vue'), reading = await source('../src/views/admin/components/AdminReadingSettings.vue'), controls = await source('../src/runtime/adminControlStyles.css')
  assert.match(panel, /<AdminReadingSettings \/>/)
  assert.match(reading, /--admin-font-scale/); assert.match(reading, /onUnmounted/); assert.match(reading, /removeProperty\('--admin-font-scale'\)/)
  assert.match(controls, /\[data-admin-workspace\] input\[type=file\]::file-selector-button/)
  assert.doesNotMatch(reading + controls, /\bzoom\s*:|transform:\s*scale/)
  const widget = await source('../src/runtime/WidgetRenderer.vue')
  assert.doesNotMatch(widget, /admin-font-scale/)
})
