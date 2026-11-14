import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { GLTFLoader as AssetLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parse as parseJs } from '@babel/parser'
import { installBrowser } from './helpers.mjs'
import { simulationCapabilities, buildLineSimulation } from '../src/three/lineSimulation.js'

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
const assetBytes = fs.readFileSync(new URL('../../backend/assets/models/cad_transfer_cart_101300.glb', import.meta.url))
const requests = []
test.mock.module('three/examples/jsm/loaders/GLTFLoader.js', { namedExports: { GLTFLoader: class {
  load(url, resolve, _progress, reject) {
    requests.push(url)
    if (url.includes('unavailable')) { reject(new Error('fixture asset unavailable')); return }
    new AssetLoader().parseAsync(assetBytes.buffer.slice(assetBytes.byteOffset, assetBytes.byteOffset + assetBytes.byteLength), '').then(resolve, reject)
  }
} } })
const { createDeviceModel } = await import('../src/three/ModelFactory.js')
const { createConfiguredDeviceModel, applyRealtimeToDeviceModel } = await import('../src/runtime/DeviceRenderer.js')
const { LineSimulationScene } = await import('../src/three/LineSimulationScene.js')

function browser(t) {
  installBrowser(t)
  class Element {
    style = { setProperty(name, value) { this[name] = value } }
    parentNode = null
    ownerDocument = { defaultView: { Element } }
    setAttribute() {}
    querySelectorAll() { return [] }
    remove() {}
  }
  document.createElement = () => new Element()
}
function meshes(root) { const rows = []; root.traverse(node => { if (node.isMesh) rows.push(node) }); return rows }
function assertDiagnosticOnly(root, id) {
  assert.equal(root.furnaceId, id)
  assert.equal(meshes(root).length, 0, 'An asset error cannot create a fake device or status-badge mesh')
  assert.equal(root.children.length, 0)
  assert.ok(root.userData.modelLoadError?.reason)
  assert.doesNotThrow(() => { root.setLabelVisible(true); root.setXRayMode(true); root.update(.1); root.dispose() })
}

test('the retired dashboard entry, procedural furnace and entry-only layout helper are absent; active surfaces remain', () => {
  for (const name of ['App.vue', 'three/FurnaceModel.js', 'runtime/LayoutConfig.js']) assert.equal(fs.existsSync(path.join(sourceRoot, name)), false, name)
  for (const name of ['RootApp.vue', 'views/AdminPanel.vue', 'views/DashboardOverlay.vue', 'views/GroupOverview.vue', 'views/FactoryHudPreview.vue', 'three/LoadingPortPreview.js', 'three/simpleRotatingCart.js']) assert.equal(fs.existsSync(path.join(sourceRoot, name)), true, name)
  assert.match(fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8'), /import RootApp from '\.\/RootApp\.vue'/)
  assert.doesNotMatch(fs.readFileSync(path.join(sourceRoot, 'views/AdminPanel.vue'), 'utf8'), /renderBuiltinModelPreview|fallbackModelOptions|内置程序化模型|内置炉子/)
})

test('Unity cannot resurrect the retired fixed-layout dashboard when its configured overlay is absent', () => {
  const runtime = new URL('../../unity-client/Assets/Scripts/Runtime/', import.meta.url)
  const files = fs.readdirSync(runtime).filter(name => /^FactoryDashboard.*\.cs$/.test(name))
  for (const name of ['FactoryDashboardController.cs', 'FactoryDashboardInspection.cs', 'FactoryDashboardDeviceHover.cs']) assert.ok(files.includes(name), name)
  for (const name of files) {
    const source = fs.readFileSync(new URL(name, runtime), 'utf8')
    assert.doesNotMatch(source, /\bOnGUI\s*\(|\bGUI(?:Utility)?\./, name)
    assert.doesNotMatch(source, /全厂设备运行总览|OVERVIEW METRICS|CLICK TO OPEN DETAIL|现场 MySQL 数据库|当前数据与管理后台完全一致/, name)
  }
  const controller = fs.readFileSync(new URL('FactoryDashboardController.cs', runtime), 'utf8')
  assert.match(controller, /public void SetWebOverlayActive\(bool active\)/)
  assert.match(controller, /_inspectionHitRects\.Any\(rect => rect\.Contains\(pointer\)\)/)
  assert.doesNotMatch(controller, /OverviewLeftRect|OverviewRightRect|DetailBackRect|DetailTrendRect/)
})

test('all current frontend local module imports resolve after deleting the legacy files', () => {
  const files = []
  function list(directory) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) list(full)
    else if (/\.(vue|js|mjs)$/.test(entry.name)) files.push(full)
  } }
  list(sourceRoot)
  function visit(node, file) {
    if (!node || typeof node !== 'object') return
    const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)
      ? node.source?.value : node.type === 'CallExpression' && node.callee?.type === 'Import' ? node.arguments[0]?.value : null
    if (typeof source === 'string' && source.startsWith('.')) assert.equal(fs.existsSync(path.resolve(path.dirname(file), source)), true, `${path.relative(sourceRoot, file)} -> ${source}`)
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => visit(child, file)); else if (value && typeof value === 'object') visit(value, file)
  }
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /\b(?:new|class)\s+(?:FurnaceModel|TransferCartModel)\b/)
    const descriptor = file.endsWith('.vue') ? parseSfc(text).descriptor : null
    const scripts = descriptor ? [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean) : [text]
    for (const script of scripts) visit(parseJs(script, { sourceType: 'module', plugins: ['importAttributes'] }), file)
  }
})

for (const type of ['builtin_furnace', 'transfer_cart', 'missing-model']) test(`${type} without an imported asset returns only a diagnostic, not an old procedural model`, async () => {
  const root = await createDeviceModel({ id: 'missing', name: 'Missing asset', model_type: type }, [])
  assertDiagnosticOnly(root, 'missing')
})

test('a real GLB failure stays explicit and retryable without constructing an old furnace', async t => {
  browser(t)
  const device = { id: 'failed', name: 'Failure fixture', model_type: 'fixture' }
  const models = [{ id: 'fixture', file_path: '/unavailable-model.glb' }], start = requests.length
  for (let i = 0; i < 2; i++) {
    const root = await createDeviceModel(device, models)
    assertDiagnosticOnly(root, device.id)
    assert.match(root.userData.modelLoadError.reason, /fixture asset unavailable/)
    assert.match(root.userData.modelLoadError.url, /unavailable-model\.glb$/)
  }
  assert.equal(requests.length - start, 2)
})

test('missing-model diagnostics preserve layout and realtime lifecycle without drawing an invented badge', async () => {
  const deviceCfg = { id: 'absent', name: 'Absent', model_type: 'missing', pos_x: 7, pos_y: 2, pos_z: -4, scale: 2, rotation_y: .4, instance_config: {} }
  const root = await createConfiguredDeviceModel({ deviceCfg, devIdx: 0, wsIdx: 0, gLineIdx: 0 }, [])
  assert.deepEqual(root.position.toArray(), [7, 2, -4]); assert.equal(root.rotation.y, .4)
  assert.deepEqual(root.scale.toArray(), [2, 2, 2])
  const frame = { furnace_id: 'absent', status: { online: true }, quality: { status: { online: 'good' } } }
  assert.doesNotThrow(() => applyRealtimeToDeviceModel(root, frame))
  assert.equal(root.lastRealtimeData, frame); assertDiagnosticOnly(root, 'absent')
})

test('the existing managed CAD still imports its real mesh hierarchy and supports preview lifecycle', async t => {
  browser(t)
  const root = await createDeviceModel({ id: 'real', name: 'Managed CAD', model_type: 'cad' }, [{ id: 'cad', file_path: '/real-managed-cart.glb', metadata: { optimization: { materialEnhancement: 'original' } } }])
  assert.ok(meshes(root).length > 20, 'The actual CAD mesh was not loaded')
  assert.equal(root.userData.modelLoadError, undefined)
  assert.ok(root.modelRoot); assert.ok(root.nodePathMap.size > 20)
  assert.doesNotThrow(() => { root.setLabelVisible(false); root.setXRayMode(false); root.updateData({ status: {} }); root.update(.1) })
  root.dispose()
})

test('line previews reject asset-less legacy models before building a presentation', async () => {
  for (const type of ['builtin_furnace', 'transfer_cart']) assert.equal(simulationCapabilities({ model_type: type }, []).usable, false)
  assert.throws(() => buildLineSimulation([{ id: 'f', model_type: 'builtin_furnace' }], []), /缺少可加载模型/)
  const scene = Object.create(LineSimulationScene.prototype)
  await assert.rejects(() => scene.loadPlan({ rows: [{ id: 'f', name: 'Missing', model_type: 'builtin_furnace', capabilities: {} }] }, [], [], 'preview'), /缺少可加载的模型资产/)
})
