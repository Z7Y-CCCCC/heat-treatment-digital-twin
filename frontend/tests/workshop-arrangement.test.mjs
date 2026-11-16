import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { adminMainTabs, adminNavPages, ADMIN_PAGES } from '../../shared/adminPages.mjs'
import { planGuidedLineArrangement } from '../../shared/lineGuidedArrangement.mjs'
import { resolveLinePlacementTemplate } from '../../shared/linePlacementTemplate.mjs'
import { apiPermission } from '../../shared/apiPermissions.mjs'
import { allowsRequirement, normalizePagePermissions } from '../../shared/pagePermissions.mjs'

const layout = () => ({ version: 2, sceneUnitsPerMeter: 1, lanes: [{ id: 'a', offsetZ: -8, length: 20 }, { id: 'b', offsetZ: 8, length: 20 }], rails: [{ id: 'r', offsetZ: 0, length: 20 }] })
const row = (id, binding, z, bounds = {}) => ({ id, name: id, x: 0, y: 0, z, minX: -1, maxX: 1, minY: 0, maxY: 1, minZ: -1, maxZ: 1, ...binding, ...bounds })
const rows = () => [row('cart', { railId: 'r' }, 0), row('large', { laneId: 'a' }, -8, { maxZ: 3 }), row('small', { laneId: 'b' }, 8, { minZ: -.5 })]

test('one named workshop workbench replaces both old menus even with an older server catalog', () => {
  assert.ok(!adminMainTabs().some(p => p.key === 'composer'))
  assert.deepEqual(adminNavPages('factory').map(p => [p.key, p.label]), [['workshops','车间管理'],['devices','设备管理'],['composer','车间编排'],['mobile-devices','设备运动配置']])
  assert.ok(!adminNavPages('factory').some(p => p.key === 'lines'))
  const old = ADMIN_PAGES.map(p => p.key === 'lines' ? { ...p, navGroup: 'factory', label: '产线管理' } : p.key === 'composer' ? { ...p, navGroup: 'main', menuOrder: 20, label: '现场编排器', navLabel: '现场编排器' } : p)
  const snapshot = structuredClone(old)
  assert.ok(!adminMainTabs(old).some(p => p.key === 'composer'))
  assert.deepEqual(adminNavPages('factory', old).map(p => p.key), ['workshops','devices','composer','mobile-devices'])
  assert.equal(adminNavPages('factory', old).find(p => p.key === 'composer').label, '车间编排')
  assert.ok(!adminNavPages('factory', old).some(p => p.key === 'lines'))
  assert.deepEqual(old, snapshot, 'client-side navigation normalization cannot mutate service grants or catalog records')
})
test('guided dual layouts independently fit unequal sides without moving the rail or mutating input', () => {
  const l = layout(), r = rows(), original = structuredClone({ l, r }), plan = planGuidedLineArrangement(l, 'dual', r)
  assert.deepEqual({ l, r }, original)
  assert.equal(plan.layout.rails[0].offsetZ, 0)
  assert.ok(plan.layout.placementTemplate.independentSides)
  const [a, b] = plan.layout.lanes
  assert.ok(Math.abs(a.offsetZ) > Math.abs(b.offsetZ))
  assert.deepEqual(resolveLinePlacementTemplate(plan.layout), plan.layout)
  const adjusted = structuredClone(plan.layout); adjusted.lanes[0].offsetZ -= .1
  assert.equal(resolveLinePlacementTemplate(adjusted).lanes[1].offsetZ, b.offsetZ, 'the second row is no longer forced into mirrored equal distance')
})
test('automatic docking spacing never repacks manual X, resizes lines, reorders devices or alters bindings', () => {
  for (const units of [.8, 1, 2]) for (const kind of ['dual', 'single-negative', 'single-positive']) {
    const l = layout(); l.sceneUnitsPerMeter = units
    l.lanes[0].length = 60; l.rails[0].length = 72
    if (kind !== 'dual') l.lanes.pop()
    const r = rows().filter(d => kind === 'dual' || d.laneId !== 'b')
    r[1].x = -17.375
    r.push(row('second', { laneId: 'a' }, -8, { x: 6.125, stationNumber: 31, calibration: { keep: true }, rotation_y: 1.1 }))
    const original = structuredClone({ l, r }), plan = planGuidedLineArrangement(l, kind, r)
    assert.deepEqual({ l, r }, original)
    assert.deepEqual(plan.rows.map(d => [d.id, d.x]), r.map(d => [d.id, d.x]))
    assert.deepEqual(plan.layout.lanes.map(d => [d.id, d.length]), l.lanes.map(d => [d.id, d.length]))
    assert.deepEqual(plan.layout.rails.map(({length,...rail})=>rail),l.rails.map(({length,...rail})=>rail))
    assert.ok(plan.layout.rails.every(rail=>rail.length===60),'Rail length follows occupied equipment rows; its origin and spacing remain unchanged')
    for (const after of plan.rows) {
      const before = r.find(d => d.id === after.id)
      assert.deepEqual({ ...after, z: before.z }, before, 'only depth may change, not X/Y, calibration, rotation or station identity')
    }
  }
})

test('same-row overlap reports a manual-layout problem instead of silently repacking devices', () => {
  const r = rows(); r.push(row('second', { laneId: 'a' }, -8, { x: .5 }))
  const original = structuredClone(r)
  assert.throws(() => planGuidedLineArrangement(layout(), 'dual', r), /重叠.*同排设备/)
  assert.deepEqual(r, original)
})

test('unplaced pool is a visible top tray, independent of old floating positions and embedded min-heights', async () => {
  const source = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  const css = await readFile(new URL('../src/views/admin/styles/workshop-arrangement.css', import.meta.url), 'utf8')
  const toolbar = source.slice(source.indexOf('class="line-selection-toolbar"'), source.indexOf('ref="linePreviewStageRef" class="line-preview-stage"'))
  assert.match(toolbar, /未摆放设备[\s\S]*selectedLineDevicePool.length/)
  assert.match(toolbar, /id="line-unplaced-device-pool"/)
  assert.doesNotMatch(source, /lineDevicePoolDockStyle|lineDevicePoolDockX|lineDevicePoolDockY/)
  assert.match(css, /\.line-device-pool-dock\{position:relative;left:auto;bottom:auto/)
  assert.match(css, /\.line-device-pool-items\{[^}]*overflow-x:auto/)
  assert.match(css, /\.admin-container\.composer-active \.workshop-arrangement \.line-preview-stage\{min-height:0/)
  const apply = source.slice(source.indexOf('async function chooseLinePlacementTemplate('), source.indexOf('function selectLineEditor('))
  assert.doesNotMatch(apply, /pos_x\s*:/)
})

test('invalid geometry and multi-rail legacy layouts are not silently collapsed or reset', () => {
  const l = layout(), r = rows(); r[1].maxX = NaN
  assert.throws(() => planGuidedLineArrangement(l, 'dual', r), /外形无效/)
  const multiple = layout(); multiple.rails.push({ id: 'r2', offsetZ: 20, length: 20 }); const saved = structuredClone(multiple)
  assert.throws(() => planGuidedLineArrangement(multiple, 'dual', rows()), /多导轨/)
  assert.deepEqual(multiple, saved)
})
test('shared save requires every affected scope rather than granting line/ground rights through the new menu', () => {
  const grants = normalizePagePermissions({ workshops: { view: true, edit: true } })
  const batch = { lines: [], placements: [{ id: 'a' }], devices: [], grounds: [] }
  assert.equal(allowsRequirement(apiPermission('/api/workshop-arrangement', 'PUT', batch), { active: true, pagePermissions: grants }), true)
  batch.grounds.push({ id: 'w' })
  assert.equal(allowsRequirement(apiPermission('/api/workshop-arrangement', 'PUT', batch), { active: true, pagePermissions: grants }), false)
})

test('selecting another already rendered device retains its healthy canvas and transform handles', async () => {
  const source = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  const code = source.slice(source.indexOf('async function openArrangementDevice('), source.indexOf('async function setArrangementView('))
  let rebuilt = 0, focused = 0, attached = 0
  const deps = { arrangementBusy:{value:false},canAdminPage:()=>true,
    arrangementDevices:{value:[{id:'a',arrangementWorkshopId:'w',arrangementLineId:'l'}]},stageArrangementDevice(){},
    selectedWorkshopEditorId:{value:''},selectedLineEditorId:{value:''},selectedComposerLineId:{value:''},arrangementLayer:{value:'line'},
    selectedComposerDeviceId:{value:''},syncComposerDraftFromSelection(){},arrangementView:{value:'three'},composerPreviewMode:{value:'line'},
    nextTick:async()=>{},composerRuntime:{furnaces:new Map([['a',{}]]),isRenderSurfaceHealthy:()=>true},
    composerTransform:{sync(){attached++}},focusComposerPreview(){focused++},resizeComposerPreviewAfterLayout(){},scheduleComposerPreview(){rebuilt++} }
  const select = new Function(...Object.keys(deps),code+'; return openArrangementDevice')(...Object.values(deps))
  await select('a');assert.equal(rebuilt,0);assert.equal(focused,1);assert.equal(attached,1)
  deps.composerRuntime.furnaces.clear();await select('a');assert.equal(rebuilt,1,'missing models still request a real reload')
})
test('old page renders and workshop step 03 are removed, with retained in-workbench views and local drafts', async () => {
  const source = await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')
  const shell = await readFile(new URL('../src/views/admin/components/WorkshopArrangement.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /key: 'layout', number: '03'/)
  assert.doesNotMatch(source, /v-if="activeTab === 'lines'"|<h2>现场编排器<\/h2>|<h2>产线结构管理<\/h2>/)
  assert.equal((source.match(/<WorkshopArrangement\s/g) || []).length, 1)
  assert.match(shell, /grid-template-columns:214px minmax\(0,1fr\)/)
  assert.match(shell, /v-show="view === 'three'"/)
  assert.match(source, /if \(activeTab.value === 'composer'\) return \/\/ Workbench drafts stay local/)
  assert.match(source, /adminApi.saveWorkshopArrangement\(body\)/)
})
