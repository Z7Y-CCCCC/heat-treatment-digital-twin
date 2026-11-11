import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createRenderer, h, nextTick } from 'vue'
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc'
import { parse as parseJavaScript } from '@babel/parser'
import * as T from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { installBrowser } from './helpers.mjs'
import { normalizeLineLayout as front } from '../src/views/admin/utils/lineLayout.js'
import { planLinePlacementTemplate, resolveLinePlacementTemplate, canMoveLineStructure, assertLineTemplateTransition, assertLineTemplateClearance } from '../../shared/linePlacementTemplate.mjs'
import { lineDeviceEnvelope } from '../src/three/lineDeviceFootprints.js'

const require = createRequire(new URL('../../backend/package.json', import.meta.url))
const { normalizeLineLayout: back } = require('./utils/spatialLayout.js')
const clone = value => JSON.parse(JSON.stringify(value))
const layout = () => front({ sceneUnitsPerMeter: .8, lanes: [{ id: 'a', name: '设备线 1', offsetZ: -1, length: 60 }, { id: 'b', name: '设备线 2', offsetZ: 1, length: 60 }], rails: [{ id: 'r', name: '小车导轨', offsetZ: 0, length: 60 }] })
const rows = () => [
  { id: 'cart', name: '料车', railId: 'r', x: 0, y: 0, z: 0, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1.5, maxZ: 1.5 },
  { id: 'furnace', name: '多用炉', laneId: 'a', x: -7, y: 0, z: -1, minX: -3, maxX: 3, minY: 0, maxY: 4, minZ: -5, maxZ: 2 },
  { id: 'cleaner', name: '清洗机', laneId: 'b', x: -7, y: 0, z: 1, minX: -3, maxX: 3, minY: 0, maxY: 4, minZ: -2, maxZ: 5 }
]

test('dual template measures full bodies and swept cart corridor, fixes the original rail, and never mutates inputs', () => {
  const old = layout(), measured = rows(), snapshot = JSON.stringify({ old, measured })
  const plan = planLinePlacementTemplate(old, 'dual', measured)
  assert.equal(JSON.stringify({ old, measured }), snapshot)
  assert.equal(plan.layout.rails[0].offsetZ, 0)
  assert.equal(plan.layout.lanes[0].offsetZ, -4)
  assert.equal(plan.layout.lanes[1].offsetZ, 4)
  assert.equal(plan.rows.find(row => row.id === 'cart').z, 0)
  assert.doesNotThrow(() => assertLineTemplateClearance(plan.layout, plan.rows))
  assert.deepEqual(front(plan.layout), back(JSON.stringify(plan.layout)))
  assert.deepEqual(front(front(plan.layout)), front(plan.layout))
  assert.equal(canMoveLineStructure(plan.layout, 'rail', 'r'), false)
  assert.equal(canMoveLineStructure(old, 'rail', 'r'), false)
  assert.equal(canMoveLineStructure(old, 'lane', 'b'), false, 'Existing second row cannot be arbitrarily dragged before choosing a template either')
  assert.equal(canMoveLineStructure(plan.layout, 'lane', 'a'), true)
  assert.equal(canMoveLineStructure(plan.layout, 'lane', 'b'), false)
  const moved = clone(plan.layout); moved.lanes[0].offsetZ = -7; moved.lanes[1].offsetZ = 100
  assert.equal(front(moved).lanes[1].offsetZ, 7, 'Second line follows opposite side rather than accepting arbitrary coordinates')
  moved.lanes[0].offsetZ = -1
  assert.throws(() => front(moved), /通道/)
  moved.lanes[0].offsetZ = 8
  assert.throws(() => back(moved), /跨越/)
})

test('all three templates are explicit; switching to single never deletes occupied lanes or guesses multi-rail ownership', () => {
  const old = layout(), empty = rows().filter(row => row.id !== 'cleaner')
  for (const [kind, sign] of [['single-negative', -1], ['single-positive', 1]]) {
    const plan = planLinePlacementTemplate(old, kind, empty)
    assert.equal(plan.layout.lanes.length, 1); assert.equal(Math.sign(plan.layout.lanes[0].offsetZ), sign)
    assert.equal(plan.layout.rails[0].offsetZ, old.rails[0].offsetZ)
    assert.deepEqual(front(plan.layout), back(plan.layout))
  }
  const created = planLinePlacementTemplate({ ...old, lanes: [old.lanes[0]] }, 'dual', empty)
  assert.equal(created.layout.lanes.length, 2); assert.notEqual(created.layout.lanes[0].id, created.layout.lanes[1].id)
  const newRail = planLinePlacementTemplate({ ...old, lanes: [old.lanes[0]], rails: [] }, 'single-negative', empty.filter(row => !row.railId))
  assert.equal(newRail.layout.rails[0].offsetZ, 0)
  assert.throws(() => planLinePlacementTemplate(old, 'single-negative', rows()), /已有设备/)
  assert.throws(() => planLinePlacementTemplate({ ...old, rails: [...old.rails, { ...old.rails[0], id: 'other' }] }, 'dual', rows()), /多导轨/)
  assert.throws(() => planLinePlacementTemplate(old, 'invalid', rows()), /模板/)
  assert.deepEqual(front(old), back(old)); assert.equal(Object.hasOwn(front(old), 'placementTemplate'), false)
})

test('missing geometry, within-row overlaps, path sweep and attempted rail/template bypass fail without partial changes', () => {
  const old = layout(), original = JSON.stringify(old), measured = rows()
  assert.throws(() => planLinePlacementTemplate(old, 'dual', [{ ...measured[0], maxZ: NaN }]), /外形无效/)
  assert.throws(() => planLinePlacementTemplate(old, 'dual', [...measured, { ...measured[1], id: 'overlap', x: -6 }]), /仍重叠/)
  const plan = planLinePlacementTemplate(old, 'dual', measured)
  const farSweep = planLinePlacementTemplate(old, 'dual', measured.map(row => row.railId ? { ...row, pathMinZ: -3, pathMaxZ: 3 } : row))
  assert.ok(farSweep.layout.placementTemplate.minimumDistance > plan.layout.placementTemplate.minimumDistance)
  const movedRail = clone(plan.layout); movedRail.rails[0].offsetZ = 2
  assert.throws(() => front(movedRail), /固定基准/)
  movedRail.placementTemplate.railOffsetZ = 2
  assert.throws(() => assertLineTemplateTransition(plan.layout, movedRail), /不能移动/)
  const bypass = clone(plan.layout); delete bypass.placementTemplate
  assert.throws(() => assertLineTemplateTransition(plan.layout, bypass), /移除模板/)
  assert.equal(JSON.stringify(old), original)
})

test('real committed furnace GLB envelopes retain scale/mirror/rotation and separate two rows without modifying geometry', async () => {
  const bytes = await readFile(new URL('../../backend/assets/models/cad_multipurpose_furnace_082000.glb', import.meta.url))
  assert.equal(bytes.toString('utf8', 0, 4), 'glTF')
  const root = (await new Promise((resolve, reject) => new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '', resolve, reject))).scene
  const signature = () => { const result = []; root.traverse(node => { if (node.isMesh) result.push([node.geometry.uuid, node.position.toArray(), node.scale.toArray(), node.material.uuid]) }); return JSON.stringify(result) }
  const original = signature(), old = layout()
  const envelope = (rotation_y, mirrorX) => lineDeviceEnvelope(root, { rotation_y, scale: 2, instance_config: { mirrorX } }, { default_scale: 1 })
  const a = envelope(0, true), b = envelope(-Math.PI, false)
  assert.ok(a.maxZ - a.minZ > 10, 'Full actual model depth, not a dot or a guessed loading-port coordinate')
  const measured = rows().map(row => row.id === 'furnace' ? { ...row, ...a } : row.id === 'cleaner' ? { ...row, ...b } : row)
  const plan = planLinePlacementTemplate(old, 'dual', measured)
  assert.doesNotThrow(() => assertLineTemplateClearance(plan.layout, plan.rows))
  assert.equal(plan.layout.rails[0].offsetZ, 0); assert.equal(signature(), original)
})

const panel = parse(await readFile(new URL('../src/views/AdminPanel.vue', import.meta.url), 'utf8')).descriptor
const panelAst = parseJavaScript(panel.scriptSetup.content, { sourceType: 'module' })
const extract = name => { const node = panelAst.program.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name); assert.ok(node, name); return panel.scriptSetup.content.slice(node.start, node.end) }

test('real parent pointer handler blocks rail and secondary-line dragging before installing listeners or touching devices', () => {
  const current = planLinePlacementTemplate(layout(), 'dual', rows()).layout
  let started = 0
  const dependencies = { lineDeviceLayoutBusy: { value: false }, lineDeviceDragState: null, canAdminPage: () => true, selectedLineEditor: { value: {} }, selectedLineLayout: { value: current },
    findLineLayoutItem: (type, id) => current[type === 'rail' ? 'rails' : 'lanes'].find(row => row.id === id), canMoveLineStructure }
  const handler = new Function(...Object.keys(dependencies), extract('startLinePreviewDrag') + ';return startLinePreviewDrag')(...Object.values(dependencies))
  const event = { button: 0, currentTarget: { closest: () => ({}) }, preventDefault() { started++ }, stopPropagation() { started++ } }
  handler('rail', 'r', 'move', event); handler('lane', 'b', 'move', event)
  assert.equal(started, 0)
  assert.match(panel.template.content, /@choose-placement-template="chooseLinePlacementTemplate"/)
  assert.doesNotMatch(panel.template.content, /@pointerdown="startLinePreviewDrag\('rail', rail.id, 'move'/)
})

test('real template parent measures and confirms before one atomic draft application; cancellation, changed drafts and busy state never write data', async () => {
  const line = { id: 'L', layout: layout() }, state = { value: line }, loading = { value: false }, devices = { value: [] }, errors = [], applied = []
  let measures = 0, confirmations = 0, choice = true, changeOnConfirm = false
  const dependencies = { canAdminPage: () => true, lineDeviceLayoutBusy: { value: false }, lineCreating: { value: false }, selectedLineEditor: state,
    snapshotJson: JSON.stringify, getLineLayout: value => value.layout, devices, models: { value: [] }, getFactoryScope: () => 'F', lineLoadingMeasuring: loading,
    measureLineLayoutEnvelopes: async () => { measures++; return rows() }, planLinePlacementTemplate, adminPanelDisposed: false, lineSceneUnitsPerMeter: () => .8,
    confirm: async () => { confirmations++; if (changeOnConfirm) devices.value.push({ id: 'changed' }); return choice },
    applyLineLayoutDraft: (_line, value) => applied.push(value), alert: message => errors.push(message) }
  const handler = new Function(...Object.keys(dependencies), extract('chooseLinePlacementTemplate') + ';return chooseLinePlacementTemplate')(...Object.values(dependencies))
  await handler('dual'); assert.equal(applied.length, 1); assert.equal(measures, 1); assert.equal(confirmations, 1); assert.equal(loading.value, false)
  choice = false; await handler('dual'); assert.equal(applied.length, 1); assert.equal(loading.value, false)
  choice = true; changeOnConfirm = true; await handler('dual'); assert.equal(applied.length, 1); assert.match(errors.at(-1), /未覆盖/)
  dependencies.lineDeviceLayoutBusy.value = true; const count = measures; await handler('dual'); assert.equal(measures, count)
  dependencies.lineDeviceLayoutBusy.value = false
  const denied = new Function(...Object.keys(dependencies), extract('chooseLinePlacementTemplate') + ';return chooseLinePlacementTemplate')(...Object.values({ ...dependencies, canAdminPage: () => false }))
  await denied('dual'); assert.equal(measures, count, 'Read-only users cannot start measuring or apply templates')
  assert.equal(Object.hasOwn(line.layout, 'placementTemplate'), false, 'The handler only hands the validated plan to the existing atomic draft function, never persists it')
})

test('actual Vue toolbar exposes three template choices, applies only emitted draft intent, and respects busy state', async t => {
  const env = installBrowser(t); env.replace('ResizeObserver', class { observe() {} disconnect() {} })
  const url = new URL('../src/views/admin/components/LinePlannerControls.vue', import.meta.url)
  const source = (await readFile(url, 'utf8')).replace(/import \{ canAdminPage \} from [^\n]+/, 'const canAdminPage = () => true')
  const descriptor = parse(source).descriptor
  let script = compileScript(descriptor, { id: 'template-memory', inlineTemplate: true }).content
  script = script.replace(/from\s+(['"])([^'"]+)\1/g, (_, _quote, name) => `from ${JSON.stringify(name.startsWith('.') ? new URL(name, url).href : import.meta.resolve(name))}`)
  for (const style of descriptor.styles.filter(style => !style.src)) assert.deepEqual(compileStyle({ source: style.content, id: 'template-memory', scoped: true }).errors, [])
  const Planner = (await import('data:text/javascript;base64,' + Buffer.from(script).toString('base64'))).default
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const root = node('root'), remove = child => { if (child?.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1) }
  const renderer = createRenderer({ createElement: node, createText: text => node('#text', text), createComment: text => node('#comment', text), setText: (child, text) => { child.text = text }, setElementText: (child, text) => { child.text = text }, parentNode: child => child.parent,
    nextSibling: () => null, remove, insert(child, parent) { remove(child); parent.children.push(child); child.parent = parent }, patchProp: (child, key, _old, value) => { child.props[key] = value }, querySelector: () => null })
  const emitted = [], old = layout(), original = JSON.stringify(old), props = { lines: [{ id: 'L', name: '产线' }], selectedId: 'L', layout: old, draft: {}, onChoosePlacementTemplate: value => emitted.push(value) }
  const walk = child => [child, ...child.children.flatMap(walk)]
  renderer.render(h(Planner, props), root); await nextTick()
  env.beforeRestore(() => renderer.render(null, root))
  let buttons = walk(root).filter(child => child.type === 'button' && child.props.class?.includes('placement-option'))
  assert.equal(buttons.length, 3); buttons.forEach(button => button.props.onClick())
  assert.deepEqual(emitted, ['single-negative', 'single-positive', 'dual'])
  assert.equal(JSON.stringify(old), original, 'Selecting a template cannot write layout/data directly from the toolbar')
  renderer.render(h(Planner, { ...props, busy: true }), root); await nextTick()
  buttons = walk(root).filter(child => child.type === 'button' && child.props.class?.includes('placement-option'))
  assert.ok(buttons.every(button => button.props.disabled))
})

test('actual save service transaction preserves template on reopen, moves both bound rows, never changes cart/PLC, and rolls back stale or bypassed saves', async () => {
  const Database = require('better-sqlite3'), sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE workshops(id TEXT PRIMARY KEY,factory_id TEXT); CREATE TABLE lines(id TEXT PRIMARY KEY,name TEXT,workshop_id TEXT,layout_json TEXT,sort_order INTEGER); CREATE TABLE devices(id TEXT PRIMARY KEY,line_id TEXT,pos_x REAL,pos_z REAL,coordinate_space TEXT,instance_config TEXT)')
  const old = layout(), measured = rows()
  sqlite.prepare('INSERT INTO workshops VALUES(?,?)').run('W', 'F')
  sqlite.prepare('INSERT INTO lines VALUES(?,?,?,?,?)').run('L', '产线', 'W', JSON.stringify(old), 0)
  for (const row of measured) sqlite.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?)').run(row.id, 'L', row.x, row.z, 'line_local', JSON.stringify({ [row.railId ? 'railId' : 'laneId']: row.railId || row.laneId, [row.railId ? 'railLineId' : 'laneLineId']: 'L', custom: { keep: true }, animationBindings: { bindings: [{ pointId: 'REAL_BOOL_ONLY' }] } }))
  const db = { get: async (sql, values) => sqlite.prepare(sql).get(...values), all: async (sql, values) => sqlite.prepare(sql).all(...values), run: async (sql, values) => sqlite.prepare(sql).run(...values) }
  const { saveLineLayout } = require('./services/lineLayoutSave.js')
  const transact = async body => { sqlite.exec('BEGIN'); try { const result = await saveLineLayout(db, 'L', 'F', body); sqlite.exec('COMMIT'); return result } catch (error) { sqlite.exec('ROLLBACK'); throw error } }
  const snapshot = () => JSON.stringify({ line: sqlite.prepare('SELECT * FROM lines').all(), devices: sqlite.prepare('SELECT * FROM devices ORDER BY id').all() })
  try {
    const cart = sqlite.prepare('SELECT * FROM devices WHERE id=?').get('cart'), plan = planLinePlacementTemplate(old, 'dual', measured)
    const result = await transact({ layout: plan.layout, expectedLayout: old })
    assert.equal(result.devices.length, 2)
    assert.equal(sqlite.prepare('SELECT pos_z FROM devices WHERE id=?').get('furnace').pos_z, -4)
    assert.equal(sqlite.prepare('SELECT pos_z FROM devices WHERE id=?').get('cleaner').pos_z, 4)
    assert.deepEqual(sqlite.prepare('SELECT * FROM devices WHERE id=?').get('cart'), cart)
    const saved = back(sqlite.prepare('SELECT layout_json FROM lines').get().layout_json)
    assert.deepEqual(saved, front(saved)); assert.equal(saved.placementTemplate.kind, 'dual')
    const before = snapshot(), bypass = clone(saved); delete bypass.placementTemplate
    await assert.rejects(transact({ layout: bypass }), /移除模板/); assert.equal(snapshot(), before)
    const shifted = clone(saved); shifted.lanes[0].offsetZ = -8
    await assert.rejects(transact({ layout: shifted, expectedLayout: old }), /已被更新/); assert.equal(snapshot(), before)
    await assert.rejects(transact({ layout: shifted, devicePositions: [{ id: 'furnace', pos_x: 0, pos_z: -8 }, { id: 'foreign', pos_x: 0, pos_z: 0 }] }), /之外/)
    assert.equal(snapshot(), before, 'Later-row failure rolls the earlier update back')
  } finally { sqlite.close() }
})
